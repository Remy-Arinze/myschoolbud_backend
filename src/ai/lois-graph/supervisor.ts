import { nextUnvisitedDesk } from './lois-routing';
import type { LoisGraphStateValues } from './lois-state';

/**
 * @deprecated LLM supervisor is retired. Graphs use runCodeRoute.
 * Kept so existing imports of routeFromSupervisor still compile during the swap.
 */
export function routeFromSupervisor(state: LoisGraphStateValues): string {
  if (!state.activeWorker) return 'end';
  if (!state.allowedWorkers.includes(state.activeWorker)) return 'end';
  return state.activeWorker;
}

export function runSupervisorNode(params: {
  state: LoisGraphStateValues;
}): Partial<LoisGraphStateValues> {
  const lastUser =
    [...params.state.messages].reverse().find((m) => m.role === 'user' && m.content)?.content ?? null;
  const next = nextUnvisitedDesk({
    userMessage: lastUser,
    allowedWorkers: params.state.allowedWorkers,
    visitedWorkers: params.state.visitedWorkers,
  });
  return { activeWorker: next, hops: params.state.hops };
}
