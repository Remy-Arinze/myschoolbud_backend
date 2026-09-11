import OpenAI from 'openai';
import { AiAgentToolsService } from '../ai-agent-tools.service';
import { AiChatPromptService } from '../ai-chat-prompt.service';
import { AiLlmClientService } from '../ai-llm-client.service';
import { LoisPageContextInput } from '../ai-page-context';
import { WORKER_BRIEFS, toolsForNames, toolsForWorkers, type LoisWorker } from '../lois-workers';
import { STUDENT_TOOL_NAMES } from '../lois-workers';
import { collapseRepeatedParagraphs, mergeAssistantTurns } from '../lois-calendar-range';
import { stripDashboardBrushOff } from '../lois-reply-sanitize';
import { executeWrappedTool, planFromToolResult, truncateToolPayload, wrapAgoraTools } from './lois-tools';
import type { LoisChatTurn } from './lois-state';
import type { LoisStreamSink } from './lois-stream-sink';

const MAX_TURNS = 14;

export type WorkerLoopResult = {
  assistantText: string;
  planId: string | null;
  planKind: 'TIMETABLE' | 'SCHEME' | null;
  appliedPending: boolean;
};

export async function runLoisWorkerLoop(params: {
  worker: LoisWorker | 'student';
  llm: AiLlmClientService;
  chatPrompt: AiChatPromptService;
  agentTools: AiAgentToolsService;
  messages: LoisChatTurn[];
  userId?: string;
  schoolId?: string;
  userRole: string;
  conversationId: string | null;
  pageContext?: LoisPageContextInput | null;
  insightId?: string | null;
  sink: LoisStreamSink;
}): Promise<WorkerLoopResult> {
  const {
    worker,
    llm,
    chatPrompt,
    agentTools,
    messages,
    userId,
    schoolId,
    userRole,
    conversationId,
    pageContext,
    insightId,
    sink,
  } = params;

  const toolDefs =
    worker === 'student' ? toolsForNames(STUDENT_TOOL_NAMES) : toolsForWorkers([worker]);
  const attachedToolNames = toolDefs.map((t) => t.function.name);
  const workerBrief =
    worker === 'student'
      ? WORKER_BRIEFS.pedagogy
      : `${WORKER_BRIEFS[worker]}${
          insightId ? ` The user asked about briefing insightId=${insightId}.` : ''
        }`;

  const { systemPrompt } = await chatPrompt.getChatPrompt(messages, userId, schoolId, pageContext, {
    attachedToolNames,
    workerBrief,
  });

  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === 'user' && m.content)?.content ?? null;
  const toolContext = {
    schoolId,
    userRole,
    userId,
    conversationId,
    userMessage: lastUserMessage,
  };

  // Register LangChain wrappers (execute path is executeWrappedTool below).
  wrapAgoraTools(toolDefs, agentTools, sink, toolContext);

  const openai = llm.getOpenai();
  const model = llm.getModel();
  const requestOpts = sink.abortSignal ? { signal: sink.abortSignal } : undefined;
  const currentMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  let assistantText = '';
  let planId: string | null = null;
  let planKind: 'TIMETABLE' | 'SCHEME' | null = null;
  let appliedPending = false;
  let turn = 0;

  while (turn < MAX_TURNS) {
    if (sink.abortSignal?.aborted) break;
    turn += 1;

    const stream = await openai.chat.completions.create(
      {
        model,
        messages: currentMessages,
        tools: toolDefs as OpenAI.Chat.Completions.ChatCompletionTool[],
        tool_choice: 'auto',
        temperature: 0.7,
        stream: true,
        stream_options: { include_usage: true },
      },
      requestOpts,
    );

    let content = '';
    const toolAcc: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason: string | undefined;

    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      if (sink.abortSignal?.aborted) {
        try {
          (stream as { controller?: { abort: () => void } }).controller?.abort();
        } catch {
          // ignore
        }
        break;
      }
      if (chunk.usage) sink.recordUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (delta?.content) {
        content += delta.content;
        if (!sink.addEstimated(delta.content.length)) {
          try {
            (stream as { controller?: { abort: () => void } }).controller?.abort();
          } catch {
            // ignore
          }
          sink.send('error', {
            code: 'LOIS_CREDITS',
            title: 'Credit limit',
            message:
              'This reply used the credits available for this request. Add credits or upgrade your plan to continue.',
          });
          break;
        }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolAcc[idx]) toolAcc[idx] = { id: '', name: '', arguments: '' };
          if (tc.id) toolAcc[idx].id = tc.id;
          if (tc.function?.name) toolAcc[idx].name += tc.function.name;
          if (tc.function?.arguments) toolAcc[idx].arguments += tc.function.arguments;
        }
      }
    }

    const toolCalls = Object.values(toolAcc)
      .filter((t) => t.name)
      .map((tc, i) => ({
        ...tc,
        id: tc.id || `tool_${tc.name}_${i}`,
      }));

    if (toolCalls.length === 0) {
      const cleaned = stripDashboardBrushOff(content);
      if (cleaned) {
        const prevShown = assistantText;
        assistantText = collapseRepeatedParagraphs(mergeAssistantTurns(prevShown, cleaned));
        const toSend =
          !prevShown
            ? assistantText
            : assistantText.startsWith(prevShown)
              ? assistantText.slice(prevShown.length).replace(/^\n+/, '')
              : assistantText;
        if (toSend) sink.send('token', { token: toSend });
      }
      break;
    }

    currentMessages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments || '{}' },
      })),
    });

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const wrapped = await executeWrappedTool(
        tc.name,
        args,
        agentTools,
        sink,
        toolContext,
        tc.id,
      );
      const planned = planFromToolResult(tc.name, wrapped.data);
      if (planned) {
        planId = planned.planId;
        planKind = planned.planKind;
      }
      if (tc.name === 'apply_pending_plans') {
        const rec = wrapped.data as { applied?: unknown[]; error?: string } | null;
        if (rec && !rec.error && Array.isArray(rec.applied) && rec.applied.length > 0) {
          appliedPending = true;
          planId = null;
          planKind = null;
        }
      }
      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: truncateToolPayload(JSON.stringify(wrapped.modelData)),
      });
    }

    if (finishReason === 'stop' && toolCalls.length === 0) break;
  }

  if (!assistantText && !sink.abortSignal?.aborted && planId) {
    const note =
      'The previews are ready. Say apply all, or use Apply on the cards.';
    assistantText = note;
    sink.send('token', { token: note });
  }

  return { assistantText, planId, planKind, appliedPending };
}
