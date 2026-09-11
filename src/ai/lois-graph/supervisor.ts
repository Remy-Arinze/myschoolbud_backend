import { AiChatPromptService } from '../ai-chat-prompt.service';
import { AiLlmClientService } from '../ai-llm-client.service';
import { parseSupervisorNext } from './lois-routing';
import type { LoisChatTurn, LoisGraphStateValues } from './lois-state';
import type { LoisStreamSink } from './lois-stream-sink';
import type { LoisWorker } from '../lois-workers';

const MAX_HOPS = 6;

export async function runSupervisorNode(params: {
  state: LoisGraphStateValues;
  llm: AiLlmClientService;
  chatPrompt: AiChatPromptService;
  sink: LoisStreamSink;
}): Promise<Partial<LoisGraphStateValues>> {
  const { state, llm, chatPrompt, sink } = params;
  if (state.hops >= MAX_HOPS) {
    return { activeWorker: null, hops: state.hops };
  }
  if (sink.abortSignal?.aborted) {
    return { activeWorker: null };
  }

  const { systemPrompt } = await chatPrompt.getChatPrompt(
    state.messages,
    state.userId,
    state.schoolId,
    state.pageFocus,
    { supervisorOnly: true, attachedToolNames: [] },
  );

  const allowed = state.allowedWorkers.join(', ') || '(none)';
  const routingHint = `Allowed workers: ${allowed}. Last worker: ${state.activeWorker || 'none'}.`;

  const openai = llm.getOpenai();
  const model = llm.getModel();
  const requestOpts = sink.abortSignal ? { signal: sink.abortSignal } : undefined;

  const response = await openai.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: `${systemPrompt}\n\n${routingHint}` },
        ...state.messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ],
      temperature: 0,
    },
    requestOpts,
  );

  if (response.usage) sink.recordUsage(response.usage);
  const raw = response.choices[0]?.message?.content || '{"next":"end"}';
  const parsed = parseSupervisorNext(raw, state.allowedWorkers);

  if (parsed.next === 'end') {
    if (!parsed.reply && !state.lastAssistant) {
      const fallback =
        (state.insightId && state.allowedWorkers.includes('academic') ? 'academic' : null) ||
        state.allowedWorkers[0] ||
        null;
      if (fallback && state.hops < MAX_HOPS) {
        return { activeWorker: fallback, hops: state.hops + 1 };
      }
    }
    let lastAssistant = state.lastAssistant;
    let messages: LoisChatTurn[] = state.messages;
    if (parsed.reply && !state.lastAssistant) {
      lastAssistant = parsed.reply;
      if (!sink.addEstimated(parsed.reply.length)) {
        sink.send('error', {
          code: 'LOIS_CREDITS',
          title: 'Credit limit',
          message:
            'This reply used the credits available for this request. Add credits or upgrade your plan to continue.',
        });
      } else {
        sink.send('token', { token: parsed.reply });
      }
      messages = [...state.messages, { role: 'assistant', content: parsed.reply }];
    }
    return { activeWorker: null, lastAssistant, messages, hops: state.hops };
  }

  return { activeWorker: parsed.next as LoisWorker, hops: state.hops + 1 };
}

export function routeFromSupervisor(state: LoisGraphStateValues): string {
  if (!state.activeWorker) return 'end';
  if (!state.allowedWorkers.includes(state.activeWorker)) return 'end';
  return state.activeWorker;
}
