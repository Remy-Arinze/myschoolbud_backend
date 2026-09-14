import { TEACHER_GRAPH_WORKERS, type LoisWorker } from '../../lois-workers';
import type { LangGraphModule } from '../langgraph-loader';
import { makeLoisStateAnnotation, type LoisGraphStateValues } from '../lois-state';
import { routeFromSupervisor, runSupervisorNode } from '../supervisor';
import { workerStatePatch } from './admin.graph';
import { runLoisFacingNode } from '../../lois-facing-agent';
import { withoutUserTokens } from '../lois-stream-sink';
import { runLoisWorkerLoop } from '../worker-node';

export async function compileTeacherGraph(
  lg: LangGraphModule,
  allowedWorkers: LoisWorker[],
  checkpointer: unknown,
) {
  const { StateGraph, START, END } = lg;
  const State = makeLoisStateAnnotation(lg);
  const workers = TEACHER_GRAPH_WORKERS.filter((w) => allowedWorkers.includes(w));
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
        sink: withoutUserTokens(config.configurable.sink),
      });
      return workerStatePatch(state, worker, result);
    });
  }

  graph.addNode('facing', async (state: LoisGraphStateValues, config: any) => {
    return runLoisFacingNode({
      state,
      llm: config.configurable.llm,
      sink: config.configurable.sink,
    });
  });

  const startDest: Record<string, string> = { supervisor: 'supervisor' };
  for (const w of workers) startDest[w] = w;
  graph.addConditionalEdges(START, (state: LoisGraphStateValues) => {
    if (state.activeWorker && workers.includes(state.activeWorker)) return state.activeWorker;
    return 'supervisor';
  }, startDest);

  const supervisorDest: Record<string, unknown> = { end: 'facing' };
  for (const w of workers) supervisorDest[w] = w;
  graph.addConditionalEdges('supervisor', (state: LoisGraphStateValues) => routeFromSupervisor(state), supervisorDest);

  graph.addEdge('facing', END);

  for (const w of workers) {
    graph.addEdge(w, 'supervisor');
  }

  return graph.compile({ checkpointer });
}
