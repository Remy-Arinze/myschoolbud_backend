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
import { codedDesksFromAnaphora, defaultSpeaker, isBlockingClassClarify, selectCodedDesks } from './lois-routing';
import { createLoisStreamSink, dedupeSources, withoutUserTokens, type LoisStreamSink } from './lois-stream-sink';
import type { LoisChatTurn, LoisGraphStateValues, LoisHitlDecision } from './lois-state';
import { compileAdminGraph, type LoisNodeConfig } from './graphs/admin.graph';
import { compileTeacherGraph } from './graphs/teacher.graph';
import { runLoisWorkerLoop } from './worker-node';
import { runLoisFacingNode } from '../lois-facing-agent';
import { sanitizeUserFacingText } from '../lois-reply-sanitize';
import { isLoisSmallTalk, smallTalkReply } from '../lois-small-talk';
import { coerceSlimPlan } from '../lois-slim-coerce';
import { classifyDeskSlim } from '../lois-slim-supervisor';
import {
  CLASS_CLARIFY_QUESTION,
  DEFAULT_CLARIFY_QUESTION,
  capabilityReply,
  emptyClarifyPlan,
  isCapabilityIntent,
  mergeTurnPlan,
  needsSlim,
  offTopicReply,
  routeSourceForPlan,
  type LoisTurnPlan,
} from '../lois-turn-plan';
import {
  applyToolEventsToMemory,
  emptyThreadMemory,
  parseThreadMemory,
  type LoisThreadMemory,
} from '../lois-thread-memory';

function isGraphInterruptError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; interrupts?: unknown };
  if (Array.isArray(e.interrupts) && e.interrupts.length > 0) return true;
  return /interrupt/i.test(`${e.name || ''} ${e.message || ''}`);
}

/** After Lois has spoken, do not hold the SSE open if the graph stalls (HITL interrupt, hung supervisor). */
const SPOKEN_STABLE_MS = 8_000;

async function drainGraphStream(params: {
  run: () => Promise<void>;
  sink: LoisStreamSink;
  onUnexpectedError?: (err: unknown) => void;
}): Promise<void> {
  let finished = false;
  const runP = params
    .run()
    .catch((err: unknown) => {
      if (!isGraphInterruptError(err)) params.onUnexpectedError?.(err);
    })
    .finally(() => {
      finished = true;
    });

  const watchP = (async () => {
    let last = '';
    let stableSince = 0;
    while (!finished) {
      if (params.sink.abortSignal?.aborted) return;
      const text = params.sink.assistantText;
      if (text && text === last) {
        if (stableSince && Date.now() - stableSince >= SPOKEN_STABLE_MS) return;
        if (!stableSince) stableSince = Date.now();
      } else {
        last = text;
        stableSince = text ? Date.now() : 0;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();

  await Promise.race([runP, watchP]);
}

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
      const lastUserMessage =
        [...messages].reverse().find((m) => m.role === 'user' && m.content)?.content ?? null;

      let threadMemory = await this.loadThreadMemory(conversationId);

      const interrupted = await this.isConversationInterrupted(
        userRole,
        params.userId,
        params.schoolId,
        conversationId,
        sink,
      );

      if (!interrupted && isLoisSmallTalk(lastUserMessage)) {
        threadMemory = { ...threadMemory, pendingClarify: null };
        fullAssistant = await this.speakSmallTalk(sink, lastUserMessage, params.userId, params.schoolId);
      } else {
        this.llm.ensureConfigured();
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
            sink: withoutUserTokens(sink),
            threadMemory,
          });
          const spoken = await runLoisFacingNode({
            state: { messages, lastAssistant: result.assistantText, planId: null },
            llm: this.llm,
            sink,
          });
          fullAssistant = spoken.lastAssistant || result.assistantText;
        } else {
          const turn = await this.runGraphTurn({
            sink,
            messages,
            userId: params.userId || '',
            schoolId: params.schoolId || '',
            userRole,
            conversationId: conversationId || '',
            pageContext,
            memory: threadMemory,
          });
          fullAssistant = turn.text;
          threadMemory = turn.memory;
        }
      }

      await this.persistTurn({
        userId: params.userId,
        conversationId,
        incomingWasNew: !existingConversationId,
        messages,
        assistantContent: sanitizeUserFacingText(fullAssistant),
        sink,
        aborted: !!params.abortSignal?.aborted,
        memory: threadMemory,
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
      const text = sanitizeUserFacingText(values?.lastAssistant || '').trim();
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
    memory: LoisThreadMemory;
  }): Promise<{ text: string; memory: LoisThreadMemory }> {
    const allowedWorkers = await this.staffPermissions.resolveAllowedWorkers({
      userRole: params.userRole,
      userId: params.userId,
      schoolId: params.schoolId,
    });
    const insightId = params.pageContext?.insightId || null;
    const lastUserMessage =
      [...params.messages].reverse().find((m) => m.role === 'user')?.content ?? null;
    let memory = params.memory;

    const graph = await this.getGraph(params.userRole, allowedWorkers);
    const config = graph ? this.graphConfig(params.conversationId, params.sink) : null;
    const interrupted = graph && config ? await this.isInterrupted(graph, config) : false;

    if (interrupted) {
      const codedDesks = selectCodedDesks({
        allowedWorkers,
        pageContext: params.pageContext,
        insightId,
        userMessage: lastUserMessage,
        memory,
      });
      this.recordRoute('coded', codedDesks);
      const text = await this.runDesksGraph({
        ...params,
        allowedWorkers,
        insightId,
        startWorker: codedDesks[0] || defaultSpeaker({ userRole: params.userRole, allowedWorkers }),
        plannedWorkers: codedDesks,
        memory,
        graph: graph!,
        config: config!,
        interrupted: true,
      });
      return { text, memory: { ...memory, pendingClarify: null } };
    }

    if (isCapabilityIntent(lastUserMessage)) {
      this.recordRoute('capability', []);
      const text = await this.speakDraft(params.sink, params.messages, capabilityReply(lastUserMessage));
      return { text, memory: { ...memory, pendingClarify: null } };
    }

    if (isBlockingClassClarify({ userMessage: lastUserMessage, memory })) {
      this.recordRoute('clarify', []);
      const text = await this.speakDraft(params.sink, params.messages, CLASS_CLARIFY_QUESTION);
      return {
        text,
        memory: {
          ...memory,
          pendingClarify: {
            slot: 'class',
            question: CLASS_CLARIFY_QUESTION,
            resumeDesks: allowedWorkers.includes('curator') ? ['curator'] : [],
          },
        },
      };
    }

    const anaphora = codedDesksFromAnaphora({
      userMessage: lastUserMessage,
      allowedWorkers,
      memory,
    });
    const codedDesks = selectCodedDesks({
      allowedWorkers,
      pageContext: params.pageContext,
      insightId,
      userMessage: lastUserMessage,
      memory,
    });

    let slim: LoisTurnPlan | null = null;
    const slimCalled = needsSlim({
      interrupted: false,
      codedDesks,
      userMessage: lastUserMessage,
      anaphoraBound: anaphora.bound,
    });
    if (slimCalled) {
      slim = await classifyDeskSlim({
        llm: this.llm,
        sink: withoutUserTokens(params.sink),
        messages: params.messages,
        allowedWorkers,
        pageContext: params.pageContext,
        codedDesks,
        memory,
      });
      slim = coerceSlimPlan({
        slim,
        userMessage: lastUserMessage,
        allowedWorkers,
        memory,
      });
    }

    const plan = mergeTurnPlan({ codedDesks, slim, lastJob: memory.lastJob });
    const source = routeSourceForPlan({ plan, anaphoraBound: anaphora.bound, slimCalled });
    this.recordRoute(source, plan.desks);

    if (plan.mode === 'clarify') {
      const question = plan.question || DEFAULT_CLARIFY_QUESTION;
      const text = await this.speakDraft(params.sink, params.messages, question);
      return {
        text,
        memory: {
          ...memory,
          pendingClarify: {
            slot: plan.missing[0] || 'unknown',
            question,
            resumeDesks: codedDesks.length ? codedDesks : allowedWorkers.slice(0, 1),
          },
        },
      };
    }
    if (plan.mode === 'capability') {
      const text = await this.speakDraft(params.sink, params.messages, capabilityReply(lastUserMessage));
      return { text, memory: { ...memory, pendingClarify: null } };
    }
    if (plan.mode === 'off_topic') {
      const text = await this.speakDraft(params.sink, params.messages, offTopicReply());
      return { text, memory: { ...memory, pendingClarify: null } };
    }
    if (plan.mode === 'rag') {
      const text = await this.runRagTurn({
        ...params,
        memory,
        insightId,
      });
      return { text, memory: { ...memory, pendingClarify: null } };
    }

    memory = { ...memory, pendingClarify: null };
    const startWorker = plan.desks[0] || null;
    if (!startWorker) {
      const fallback = emptyClarifyPlan('no-start-desk');
      const text = await this.speakDraft(params.sink, params.messages, fallback.question || '');
      return { text, memory: { ...memory, pendingClarify: { slot: 'unknown', question: fallback.question || '', resumeDesks: [] } } };
    }

    if (!graph || !config) {
      const text = await this.runWorkerThenFace({
        ...params,
        worker: allowedWorkers.includes(startWorker) ? startWorker : allowedWorkers[0] || 'operations',
        insightId,
        memory,
        focusAsk: plan.schoolPart,
      });
      return { text, memory };
    }

    const text = await this.runDesksGraph({
      ...params,
      allowedWorkers,
      insightId,
      startWorker,
      plannedWorkers: plan.desks,
      memory,
      graph,
      config,
      interrupted: false,
      focusAsk: plan.schoolPart,
    });
    return { text, memory };
  }

  private recordRoute(source: string, desks: LoisWorker[]): void {
    try {
      this.metricsService.loisRouteTotal.inc({ source });
      for (const desk of desks) {
        this.metricsService.loisDesksRunTotal.inc({ desk });
      }
    } catch {
      // metrics optional in unit tests
    }
  }

  private async speakDraft(
    sink: LoisStreamSink,
    messages: LoisChatTurn[],
    draft: string,
  ): Promise<string> {
    const spoken = await runLoisFacingNode({
      state: { messages, lastAssistant: draft, planId: null },
      llm: this.llm,
      sink,
    });
    return spoken.lastAssistant || draft;
  }

  private async runRagTurn(params: {
    sink: LoisStreamSink;
    messages: LoisChatTurn[];
    userId: string;
    schoolId: string;
    userRole: string;
    conversationId: string;
    pageContext?: LoisPageContextInput | null;
    insightId: string | null;
    memory: LoisThreadMemory;
  }): Promise<string> {
    const result = await runLoisWorkerLoop({
      worker: 'operations',
      toolNames: ['search_semantic'],
      workerBriefOverride:
        'JOB: Search uploaded school policies and handbooks only. Call search_semantic. Do not look up rosters, fees, grades, or generate a timetable.',
      llm: this.llm,
      chatPrompt: this.chatPrompt,
      agentTools: this.agentTools,
      messages: params.messages,
      userId: params.userId,
      schoolId: params.schoolId,
      userRole: params.userRole,
      conversationId: params.conversationId,
      pageContext: params.pageContext,
      insightId: params.insightId,
      sink: withoutUserTokens(params.sink),
      threadMemory: params.memory,
    });
    const spoken = await runLoisFacingNode({
      state: { messages: params.messages, lastAssistant: result.assistantText, planId: null },
      llm: this.llm,
      sink: params.sink,
    });
    return spoken.lastAssistant || result.assistantText;
  }

  private async runWorkerThenFace(params: {
    sink: LoisStreamSink;
    messages: LoisChatTurn[];
    userId: string;
    schoolId: string;
    userRole: string;
    conversationId: string;
    pageContext?: LoisPageContextInput | null;
    insightId: string | null;
    worker: LoisWorker;
    memory: LoisThreadMemory;
    focusAsk?: string | null;
  }): Promise<string> {
    const result = await runLoisWorkerLoop({
      worker: params.worker,
      llm: this.llm,
      chatPrompt: this.chatPrompt,
      agentTools: this.agentTools,
      messages: params.messages,
      userId: params.userId,
      schoolId: params.schoolId,
      userRole: params.userRole,
      conversationId: params.conversationId,
      pageContext: params.pageContext,
      insightId: params.insightId,
      sink: withoutUserTokens(params.sink),
      threadMemory: params.memory,
      focusAsk: params.focusAsk ?? null,
    });
    const spoken = await runLoisFacingNode({
      state: { messages: params.messages, lastAssistant: result.assistantText, planId: null },
      llm: this.llm,
      sink: params.sink,
    });
    return spoken.lastAssistant || result.assistantText;
  }

  private async runDesksGraph(params: {
    sink: LoisStreamSink;
    messages: LoisChatTurn[];
    userId: string;
    schoolId: string;
    userRole: string;
    conversationId: string;
    pageContext?: LoisPageContextInput | null;
    allowedWorkers: LoisWorker[];
    insightId: string | null;
    startWorker: LoisWorker | null;
    plannedWorkers: LoisWorker[];
    memory: LoisThreadMemory;
    graph: {
      stream: (input: unknown, config: unknown) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
    };
    config: LoisNodeConfig;
    interrupted: boolean;
    focusAsk?: string | null;
  }): Promise<string> {
    const lg = await loadLangGraph();
    const inputState: Partial<LoisGraphStateValues> = {
      messages: params.messages,
      schoolId: params.schoolId,
      userId: params.userId,
      role: params.userRole,
      pageFocus: params.pageContext || null,
      allowedWorkers: params.allowedWorkers,
      activeWorker: params.startWorker,
      insightId: params.insightId,
      planId: null,
      planKind: null,
      lastAssistant: '',
      visitedWorkers: [],
      plannedWorkers: params.plannedWorkers,
      threadMemory: params.memory,
      focusAsk: params.focusAsk ?? null,
      hops: 0,
      hitl: null,
    };

    let streamInput: unknown = inputState;
    if (params.interrupted) {
      const Command = (lg as { Command?: new (args: { resume: unknown; update?: unknown }) => unknown }).Command;
      streamInput = Command
        ? new Command({ resume: { followUp: true }, update: inputState })
        : inputState;
    }

    try {
      await drainGraphStream({
        sink: params.sink,
        onUnexpectedError: (err) => {
          this.logger.warn(`Lois graph stream failed, falling back to worker: ${err}`);
        },
        run: async () => {
          const iterable = await params.graph.stream(streamInput, { ...params.config, recursionLimit: 16 });
          for await (const _chunk of iterable) {
            if (params.sink.abortSignal?.aborted) break;
          }
        },
      });
    } catch (err: unknown) {
      this.logger.warn(`Lois graph stream failed, falling back to worker: ${err}`);
    }

    if (params.sink.abortSignal?.aborted) return params.sink.assistantText.trim();

    const fromGraph =
      params.sink.assistantText.trim() ||
      (await this.readLastAssistant(params.graph as CompiledGraph, params.config)).trim();
    if (fromGraph) return fromGraph;

    const fallbackWorker = (params.startWorker ||
      defaultSpeaker({ userRole: params.userRole, allowedWorkers: params.allowedWorkers }) ||
      'operations') as LoisWorker;
    this.logger.warn(`Lois graph produced no reply; running ${fallbackWorker} worker`);
    const text = await this.runWorkerThenFace({
      sink: params.sink,
      messages: params.messages,
      userId: params.userId,
      schoolId: params.schoolId,
      userRole: params.userRole,
      conversationId: params.conversationId,
      pageContext: params.pageContext,
      insightId: params.insightId,
      worker: params.allowedWorkers.includes(fallbackWorker)
        ? fallbackWorker
        : params.allowedWorkers[0] || 'operations',
      memory: params.memory,
    });
    if (text.trim()) return text;

    const closing = "I couldn't finish that reply. Send the question again and I'll try.";
    params.sink.send('token', { token: closing });
    return closing;
  }

  private async isConversationInterrupted(
    userRole: string,
    userId: string | undefined,
    schoolId: string | undefined,
    conversationId: string | undefined,
    sink: LoisStreamSink,
  ): Promise<boolean> {
    if (!conversationId || userRole === 'STUDENT') return false;
    try {
      const allowedWorkers = await this.staffPermissions.resolveAllowedWorkers({
        userRole,
        userId,
        schoolId,
      });
      const graph = await this.getGraph(userRole, allowedWorkers);
      if (!graph) return false;
      return this.isInterrupted(graph, this.graphConfig(conversationId, sink));
    } catch {
      return false;
    }
  }

  private async speakSmallTalk(
    sink: LoisStreamSink,
    userMessage: string | null,
    userId?: string,
    schoolId?: string,
  ): Promise<string> {
    let firstName: string | null = null;
    let schoolName: string | null = null;
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true },
      });
      firstName = user?.firstName || null;
    }
    if (schoolId) {
      const school = await this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true },
      });
      schoolName = school?.name || null;
    }
    const reply = smallTalkReply({ firstName, schoolName, userMessage });
    if (sink.addEstimated(reply.length)) {
      sink.send('token', { token: reply });
    }
    return reply;
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
    memory?: LoisThreadMemory;
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

    const nextMemory = applyToolEventsToMemory(params.memory || emptyThreadMemory(), sink.toolEvents);
    await this.saveThreadMemory(conversationId, nextMemory);
  }

  private async loadThreadMemory(conversationId?: string): Promise<LoisThreadMemory> {
    if (!conversationId) return emptyThreadMemory();
    try {
      const row = await this.prisma.chatConversation.findUnique({
        where: { id: conversationId },
        select: { loisMemory: true },
      });
      return parseThreadMemory(row?.loisMemory);
    } catch (err) {
      this.logger.warn(`Lois memory load skipped: ${err}`);
      return emptyThreadMemory();
    }
  }

  private async saveThreadMemory(conversationId: string, memory: LoisThreadMemory): Promise<void> {
    try {
      await this.prisma.chatConversation.update({
        where: { id: conversationId },
        data: { loisMemory: memory as object },
      });
    } catch (err) {
      this.logger.warn(`Lois memory save skipped: ${err}`);
    }
  }
}
