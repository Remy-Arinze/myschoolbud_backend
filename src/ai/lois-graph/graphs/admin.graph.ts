import { ADMIN_GRAPH_WORKERS, type LoisWorker } from '../../lois-workers';
import type { LangGraphModule } from '../langgraph-loader';
import { makeLoisStateAnnotation, type LoisGraphStateValues } from '../lois-state';
import { routeFromSupervisor, runSupervisorNode } from '../supervisor';
import { appliedAckNode, routeAfterWait, waitForApplyNode } from '../wait-for-apply';
import type { LoisStreamSink } from '../lois-stream-sink';
import { runLoisWorkerLoop, type WorkerLoopResult } from '../worker-node';
import { AiAgentToolsService } from '../../ai-agent-tools.service';
import { AiChatPromptService } from '../../ai-chat-prompt.service';
import { AiLlmClientService } from '../../ai-llm-client.service';

export type LoisNodeConfig = {
  configurable: {
    thread_id: string;
    sink: LoisStreamSink;
    llm: AiLlmClientService;
    chatPrompt: AiChatPromptService;
    agentTools: AiAgentToolsService;
    conversationId: string | null;
  };
};

export function workerStatePatch(
  state: LoisGraphStateValues,
  worker: LoisWorker,
  result: WorkerLoopResult,
): Partial<LoisGraphStateValues> {
  const assistantText = result.assistantText || state.lastAssistant;
  const messages = result.assistantText
    ? [...state.messages, { role: 'assistant' as const, content: result.assistantText }]
    : state.messages;
  return {
    lastAssistant: assistantText,
    messages,
    activeWorker: worker,
    planId: result.appliedPending ? null : result.planId ?? state.planId,
    planKind: result.appliedPending ? null : result.planKind ?? state.planKind,
    hops: state.hops + 1,
  };
}

export async function compileAdminGraph(
  lg: LangGraphModule,
  allowedWorkers: LoisWorker[],
  checkpointer: unknown,
) {
  const { StateGraph, START, END } = lg;
  const State = makeLoisStateAnnotation(lg);
  const workers = ADMIN_GRAPH_WORKERS.filter((w) => allowedWorkers.includes(w));
  const graph: any = new StateGraph(State);

  graph.addNode('supervisor', async (state: LoisGraphStateValues, config: any) => {
    return runSupervisorNode({
      state,
      llm: config.configurable.llm,
      chatPrompt: config.configurable.chatPrompt,
      sink: config.configurable.sink,
    });
  });

  for (const worker of workers) {
    graph.addNode(worker, async (state: LoisGraphStateValues, config: any) => {
      const result = await runLoisWorkerLoop({
        worker,
        llm: config.configurable.llm,
        chatPrompt: config.configurable.chatPrompt,
        agentTools: config.configurable.agentTools,
        messages: state.messages,
        userId: state.userId,
        schoolId: state.schoolId,
        userRole: state.role,
        conversationId: config.configurable.conversationId,
        pageContext: state.pageFocus,
        insightId: state.insightId,
        sink: config.configurable.sink,
      });
      return workerStatePatch(state, worker, result);
    });
  }

  const startDest: Record<string, string> = { supervisor: 'supervisor' };
  for (const w of workers) startDest[w] = w;

  graph.addConditionalEdges(START, (state: LoisGraphStateValues) => {
    if (state.activeWorker && workers.includes(state.activeWorker)) return state.activeWorker;
    return 'supervisor';
  }, startDest);

  const supervisorDest: Record<string, unknown> = { end: END };
  for (const w of workers) supervisorDest[w] = w;
  graph.addConditionalEdges('supervisor', (state: LoisGraphStateValues) => routeFromSupervisor(state), supervisorDest);

  if (workers.includes('curator')) {
    graph.addNode('wait_for_apply', waitForApplyNode(lg));
    graph.addNode('applied_ack', (state: LoisGraphStateValues, config: any) =>
      appliedAckNode(state, config.configurable.sink.send.bind(config.configurable.sink)),
    );
    graph.addConditionalEdges('curator', (state: LoisGraphStateValues) => {
      return state.planId ? 'wait_for_apply' : 'supervisor';
    }, {
      wait_for_apply: 'wait_for_apply',
      supervisor: 'supervisor',
    });
    graph.addConditionalEdges('wait_for_apply', (state: LoisGraphStateValues) => routeAfterWait(state), {
      applied_ack: 'applied_ack',
      curator: 'curator',
      end: END,
    });
    graph.addEdge('applied_ack', END);
  }

  for (const w of workers) {
    if (w === 'curator') continue;
    graph.addEdge(w, 'supervisor');
  }

  return graph.compile({ checkpointer });
}
