import type { LangGraphModule } from './langgraph-loader';
import type { LoisGraphStateValues, LoisHitlDecision } from './lois-state';

export function waitForApplyNode(lg: LangGraphModule) {
  return (state: LoisGraphStateValues): Partial<LoisGraphStateValues> => {
    if (!state.planId) {
      return { hitl: null };
    }
    const decision = lg.interrupt({
      planId: state.planId,
      planKind: state.planKind,
    }) as LoisHitlDecision | undefined;
    return {
      hitl: decision || null,
      planId: decision?.applied || decision?.cancelled ? null : state.planId,
      activeWorker: decision?.followUp ? 'curator' : null,
    };
  };
}

export function routeAfterWait(state: LoisGraphStateValues): string {
  if (state.hitl?.applied) return 'applied_ack';
  if (state.hitl?.followUp && state.allowedWorkers.includes('curator')) return 'curator';
  return 'end';
}

export function appliedAckNode(state: LoisGraphStateValues, send?: (event: string, data: unknown) => void) {
  const text =
    state.planKind === 'SCHEME'
      ? 'The scheme of work is applied.'
      : 'The timetable is applied.';
  send?.('token', { token: text });
  return {
    lastAssistant: text,
    messages: [...state.messages, { role: 'assistant' as const, content: text }],
    planId: null,
    planKind: null,
    hitl: null,
    activeWorker: null,
  };
}
