import { TEACHER_GRAPH_WORKERS, type LoisWorker } from '../../lois-workers';
import type { LangGraphModule } from '../langgraph-loader';
import { makeLoisStateAnnotation, type LoisGraphStateValues } from '../lois-state';
import { routeFromCodeRoute, runCodeRoute } from '../lois-routing';
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

  graph.addNode('route', async (state: LoisGraphStateValues) => runCodeRoute(state));

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
        threadMemory: state.threadMemory,
        focusAsk: state.focusAsk,
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

  const startDest: Record<string, string> = { route: 'route' };
  for (const w of workers) startDest[w] = w;
  graph.addConditionalEdges(START, (state: LoisGraphStateValues) => {
    if (state.activeWorker && workers.includes(state.activeWorker)) return state.activeWorker;
    return 'route';
  }, startDest);

  const routeDest: Record<string, unknown> = { end: 'facing' };
  for (const w of workers) routeDest[w] = w;
  graph.addConditionalEdges('route', (state: LoisGraphStateValues) => routeFromCodeRoute(state), routeDest);

  graph.addEdge('facing', END);

  for (const w of workers) {
    graph.addEdge(w, 'route');
  }

  return graph.compile({ checkpointer });
}
