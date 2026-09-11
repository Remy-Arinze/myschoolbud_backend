import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from '../../common/metrics/metrics.service';
import { PrismaService } from '../../database/prisma.service';
import { AiAgentToolsService } from '../ai-agent-tools.service';
import { AiChatPromptService } from '../ai-chat-prompt.service';
import { AiLlmClientService } from '../ai-llm-client.service';
import { LoisPageContextInput } from '../ai-page-context';
import { AiStaffPermissionCheckerService } from '../ai-staff-permission-checker.service';
import { toLoisStreamErrorPayload } from '../ai-stream-errors';
import { type LoisWorker } from '../lois-workers';
import { loadLangGraph } from './langgraph-loader';
import { LoisCheckpointerService } from './lois-checkpointer.service';
import { selectStartWorker } from './lois-routing';
import { createLoisStreamSink, dedupeSources, type LoisStreamSink } from './lois-stream-sink';
import type { LoisChatTurn, LoisGraphStateValues, LoisHitlDecision } from './lois-state';
import { compileAdminGraph, type LoisNodeConfig } from './graphs/admin.graph';
import { compileTeacherGraph } from './graphs/teacher.graph';
import { runLoisWorkerLoop } from './worker-node';

type CompiledGraph = {
  stream: (input: unknown, config: unknown) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  invoke: (input: unknown, config: unknown) => Promise<LoisGraphStateValues>;
  getState: (config: unknown) => Promise<{
    next?: string[];
    tasks?: Array<{ interrupts?: unknown[] }>;
    values?: LoisGraphStateValues;
  }>;
};

@Injectable()
export class LoisRuntimeService {
  private readonly logger = new Logger(LoisRuntimeService.name);
  private readonly graphCache = new Map<string, CompiledGraph>();

  constructor(
    private readonly llm: AiLlmClientService,
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly chatPrompt: AiChatPromptService,
    private readonly agentTools: AiAgentToolsService,
    private readonly staffPermissions: AiStaffPermissionCheckerService,
    private readonly checkpointer: LoisCheckpointerService,
  ) {}

  async run(params: {
    res: Response;
    messages: LoisChatTurn[];
    userId?: string;
    conversationId?: string;
    schoolId?: string;
    remainingTokens?: number;
    abortSignal?: AbortSignal;
    pageContext?: LoisPageContextInput | null;
  }): Promise<{ total_tokens: number }> {
    const startTime = Date.now();
    this.llm.ensureConfigured();
    const sink = createLoisStreamSink(
      params.res,
      params.remainingTokens ?? Infinity,
      params.abortSignal,
    );

    let conversationId = params.conversationId;
    let messages = [...params.messages];
    let fullAssistant = '';

    try {
      if (conversationId && params.userId) {
        const merged = await this.mergeHistory(conversationId, params.userId, params.schoolId, messages);
        messages = merged.messages;
        conversationId = merged.conversationId;
      }

      const existingConversationId = conversationId;
      conversationId = await this.ensureConversation(
        sink,
        messages,
        params.userId,
        conversationId,
        params.schoolId,
      );

      const userRole = await this.resolveRole(params.userId);
      const pageContext = this.withInsight(params.pageContext, params.pageContext?.insightId);

      if (userRole === 'STUDENT') {
        const result = await runLoisWorkerLoop({
          worker: 'student',
          llm: this.llm,
          chatPrompt: this.chatPrompt,
          agentTools: this.agentTools,
          messages,
          userId: params.userId,
          schoolId: params.schoolId,
          userRole,
          conversationId: conversationId || null,
          pageContext,
          sink,
        });
        fullAssistant = result.assistantText;
      } else {
        fullAssistant = await this.runGraphTurn({
          sink,
          messages,
          userId: params.userId || '',
          schoolId: params.schoolId || '',
          userRole,
          conversationId: conversationId || '',
          pageContext,
        });
      }

      await this.persistTurn({
        userId: params.userId,
        conversationId,
        incomingWasNew: !existingConversationId,
        messages,
        assistantContent: fullAssistant,
        sink,
        aborted: !!params.abortSignal?.aborted,
      });

      if (!params.abortSignal?.aborted) {
        sink.send('done', {
          conversationId: conversationId ?? '',
          sources: dedupeSources(sink.sources),
        });
        const durationMs = Date.now() - startTime;
        this.metricsService.recordLoisDuration(durationMs, { operation: 'chat_stream' });
        this.metricsService.loisApiCallsTotal.inc({ operation: 'chat_stream', status: 'success' });
        if (sink.usage) {
          this.metricsService.loisTokensConsumedTotal.inc({ direction: 'input' }, sink.usage.prompt_tokens || 0);
          this.metricsService.loisTokensConsumedTotal.inc(
            { direction: 'output' },
            sink.usage.completion_tokens || 0,
          );
        }
      }

      return { total_tokens: (sink.usage?.total_tokens || 0) + sink.estimatedTokens };
    } catch (error: any) {
      this.metricsService.loisApiCallsTotal.inc({ operation: 'chat_stream', status: 'failed' });
      this.metricsService.loisErrorsTotal.inc({ error_type: error?.name || 'unknown' });
      if (error?.name === 'AbortError') {
        this.logger.log('LoisRuntime: request aborted');
      } else {
        this.logger.error(`LoisRuntime failed: ${error}`);
        sink.send('error', toLoisStreamErrorPayload(error));
      }
      return { total_tokens: (sink.usage?.total_tokens || 0) + sink.estimatedTokens };
    }
  }

  async resumeAfterHitl(params: {
    conversationId?: string | null;
    userId: string;
    schoolId: string;
    userRole?: string;
    decision: LoisHitlDecision;
  }): Promise<void> {
    const conversationId = params.conversationId;
    if (!conversationId) return;
    try {
      const userRole = params.userRole || (await this.resolveRole(params.userId));
      const allowedWorkers = await this.staffPermissions.resolveAllowedWorkers({
        userRole,
        userId: params.userId,
        schoolId: params.schoolId,
      });
      const graph = await this.getGraph(userRole, allowedWorkers);
      if (!graph) return;
      const lg = await loadLangGraph();
      const sink = createLoisStreamSink(null, Infinity);
      const config = this.graphConfig(conversationId, sink);
      const Command = (lg as { Command?: new (args: { resume: unknown }) => unknown }).Command;
      const input = Command ? new Command({ resume: params.decision }) : params.decision;
      const values = await graph.invoke(input, config);
      const text = values?.lastAssistant?.trim();
      if (params.decision.applied && text) {
        await this.prisma.chatMessage.create({
          data: {
            conversationId,
            role: 'assistant',
            content: text,
          },
        });
      }
    } catch (err) {
      this.logger.warn(`HITL resume skipped for ${conversationId}: ${err}`);
    }
  }

  private async runGraphTurn(params: {
    sink: LoisStreamSink;
    messages: LoisChatTurn[];
    userId: string;
    schoolId: string;
    userRole: string;
    conversationId: string;
    pageContext?: LoisPageContextInput | null;
  }): Promise<string> {
    const allowedWorkers = await this.staffPermissions.resolveAllowedWorkers({
      userRole: params.userRole,
      userId: params.userId,
      schoolId: params.schoolId,
    });
    const insightId = params.pageContext?.insightId || null;
    const lastUserMessage =
      [...params.messages].reverse().find((m) => m.role === 'user')?.content ?? null;
    const startWorker = selectStartWorker({
      allowedWorkers,
      pageContext: params.pageContext,
      insightId,
      userMessage: lastUserMessage,
    });

    const graph = await this.getGraph(params.userRole, allowedWorkers);
    if (!graph) {
      const worker = (startWorker || allowedWorkers[0] || 'operations') as LoisWorker;
      const result = await runLoisWorkerLoop({
        worker: allowedWorkers.includes(worker) ? worker : (allowedWorkers[0] as LoisWorker) || 'operations',
        llm: this.llm,
        chatPrompt: this.chatPrompt,
        agentTools: this.agentTools,
        messages: params.messages,
        userId: params.userId,
        schoolId: params.schoolId,
        userRole: params.userRole,
        conversationId: params.conversationId,
        pageContext: params.pageContext,
        insightId,
        sink: params.sink,
      });
      return result.assistantText;
    }

    const lg = await loadLangGraph();
    const config = this.graphConfig(params.conversationId, params.sink);
    const interrupted = await this.isInterrupted(graph, config);
    const inputState: Partial<LoisGraphStateValues> = {
      messages: params.messages,
      schoolId: params.schoolId,
      userId: params.userId,
      role: params.userRole,
      pageFocus: params.pageContext || null,
      allowedWorkers,
      activeWorker: startWorker,
      insightId,
      planId: null,
      planKind: null,
      lastAssistant: '',
      hops: 0,
      hitl: null,
    };

    let streamInput: unknown = inputState;
    if (interrupted) {
      const Command = (lg as { Command?: new (args: { resume: unknown; update?: unknown }) => unknown }).Command;
      streamInput = Command
        ? new Command({ resume: { followUp: true }, update: inputState })
        : inputState;
    }

    try {
      const values = await graph.invoke(streamInput, { ...config, recursionLimit: 12 });
      const fromGraph =
        (values?.lastAssistant || '').trim() ||
        params.sink.assistantText.trim() ||
        (await this.readLastAssistant(graph, config));
      if (fromGraph) return fromGraph;
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name || '';
      if (name.includes('Interrupt') || name.includes('GraphInterrupt')) {
        const interruptedText =
          params.sink.assistantText.trim() || (await this.readLastAssistant(graph, config)).trim();
        if (interruptedText) return interruptedText;
      } else {
        this.logger.warn(`Lois graph invoke failed, falling back to worker: ${err}`);
      }
    }

    if (params.sink.abortSignal?.aborted) return params.sink.assistantText.trim();
    if (params.sink.assistantText.trim()) return params.sink.assistantText;

    const fallbackWorker = (startWorker ||
      (insightId && allowedWorkers.includes('academic') ? 'academic' : allowedWorkers[0]) ||
      'operations') as LoisWorker;
    this.logger.warn(`Lois graph produced no reply; running ${fallbackWorker} worker`);
    const result = await runLoisWorkerLoop({
      worker: allowedWorkers.includes(fallbackWorker) ? fallbackWorker : allowedWorkers[0] || 'operations',
      llm: this.llm,
      chatPrompt: this.chatPrompt,
      agentTools: this.agentTools,
      messages: params.messages,
      userId: params.userId,
      schoolId: params.schoolId,
      userRole: params.userRole,
      conversationId: params.conversationId,
      pageContext: params.pageContext,
      insightId,
      sink: params.sink,
    });
    if (result.assistantText.trim()) return result.assistantText;

    const closing = "I couldn't finish that reply. Send the question again and I'll try.";
    params.sink.send('token', { token: closing });
    return closing;
  }

  private graphConfig(conversationId: string, sink: LoisStreamSink): LoisNodeConfig {
    return {
      configurable: {
        thread_id: conversationId,
        sink,
        llm: this.llm,
        chatPrompt: this.chatPrompt,
        agentTools: this.agentTools,
        conversationId,
      },
    };
  }

  private async getGraph(userRole: string, allowedWorkers: LoisWorker[]): Promise<CompiledGraph | null> {
    const kind = userRole === 'TEACHER' ? 'teacher' : 'admin';
    const key = `${kind}:${allowedWorkers.slice().sort().join(',')}`;
    const cached = this.graphCache.get(key);
    if (cached) return cached;
    try {
      const lg = await loadLangGraph();
      const checkpointer = await this.checkpointer.getCheckpointer();
      const compiled =
        kind === 'teacher'
          ? await compileTeacherGraph(lg, allowedWorkers, checkpointer)
          : await compileAdminGraph(lg, allowedWorkers, checkpointer);
      this.graphCache.set(key, compiled as unknown as CompiledGraph);
      return compiled as unknown as CompiledGraph;
    } catch (err) {
      this.logger.warn(`LangGraph compile failed, worker loop fallback: ${err}`);
      return null;
    }
  }

  private async isInterrupted(graph: CompiledGraph, config: unknown): Promise<boolean> {
    try {
      const snap = await graph.getState(config);
      if (snap.tasks?.some((t) => (t.interrupts || []).length > 0)) return true;
      return (snap.next || []).includes('wait_for_apply');
    } catch {
      return false;
    }
  }

  private async readLastAssistant(graph: CompiledGraph, config: unknown): Promise<string> {
    try {
      const snap = await graph.getState(config);
      return snap.values?.lastAssistant || '';
    } catch {
      return '';
    }
  }

  private withInsight(
    pageContext: LoisPageContextInput | null | undefined,
    insightId?: string | null,
  ): LoisPageContextInput | null {
    if (!pageContext && !insightId) return null;
    return { ...(pageContext || {}), insightId: insightId || pageContext?.insightId };
  }

  private async resolveRole(userId?: string): Promise<string> {
    if (!userId) return 'USER';
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role || 'USER';
  }

  private async mergeHistory(
    conversationId: string,
    userId: string,
    schoolId: string | undefined,
    messages: LoisChatTurn[],
  ): Promise<{ messages: LoisChatTurn[]; conversationId?: string }> {
    try {
      const owned = await this.prisma.chatConversation.findFirst({
        where: { id: conversationId, userId, ...(schoolId ? { schoolId } : {}) },
        select: { id: true },
      });
      if (!owned) return { messages, conversationId: undefined };
      const history = await this.prisma.chatMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 30,
        select: { role: true, content: true },
      });
      if (history.length === 0) return { messages, conversationId };
      const incomingUserContent = messages.find((m) => m.role === 'user')?.content;
      const filteredHistory = incomingUserContent
        ? history.filter(
            (_, i) =>
              !(
                i === history.length - 1 &&
                history[i].role === 'user' &&
                history[i].content === incomingUserContent
              ),
          )
        : history;
      return {
        conversationId,
        messages: [
          ...filteredHistory.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          ...messages,
        ],
      };
    } catch (err) {
      this.logger.warn(`Failed to load conversation history for ${conversationId}: ${err}`);
      return { messages, conversationId };
    }
  }

  private async ensureConversation(
    sink: LoisStreamSink,
    messages: LoisChatTurn[],
    userId?: string,
    conversationId?: string,
    schoolId?: string,
  ): Promise<string | undefined> {
    if (!userId || conversationId) {
      return conversationId;
    }
    try {
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
      const title = lastUserMessage?.content
        ? lastUserMessage.content.substring(0, 40) + (lastUserMessage.content.length > 40 ? '...' : '')
        : 'New Chat';
      const conversation = await this.prisma.chatConversation.create({
        data: {
          userId,
          schoolId,
          title,
          messages: {
            create: messages
              .filter((m) => m.role.toLowerCase() !== 'system')
              .map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
              })),
          },
        },
      });
      sink.send('conversation_id', { conversationId: conversation.id });
      return conversation.id;
    } catch (err) {
      this.logger.error(`Failed to pre-create conversation: ${err}`);
      return conversationId;
    }
  }

  private async persistTurn(params: {
    userId?: string;
    conversationId?: string;
    incomingWasNew: boolean;
    messages: LoisChatTurn[];
    assistantContent: string;
    sink: LoisStreamSink;
    aborted: boolean;
  }): Promise<void> {
    const { userId, conversationId, incomingWasNew, messages, assistantContent, sink, aborted } = params;
    if (!userId || !conversationId || aborted) return;

    if (!incomingWasNew) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === 'user') {
        await this.prisma.chatMessage.create({
          data: {
            conversationId,
            role: 'user',
            content: lastMessage.content,
          },
        });
      }
    }

    const collected = dedupeSources(sink.sources);
    await this.prisma.chatMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: assistantContent || 'No response generated.',
        toolEvents:
          sink.toolEvents.length > 0 || collected.length > 0
            ? ([
                ...sink.toolEvents,
                ...(collected.length ? [{ type: 'sources', sources: collected }] : []),
              ] as object[])
            : undefined,
      },
    });
  }
}
