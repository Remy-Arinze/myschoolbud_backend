import { LoisPageContextInput } from '../ai-page-context';
import { type LoisWorker } from '../lois-workers';
import type { LoisGraphStateValues } from './lois-state';
import type { LoisThreadMemory } from '../lois-thread-memory';
import {
  hasClassOrLevelToken,
  isCapabilityIntent,
  isJobContinuation,
  looksLikeSlotFill,
  uniqueDesks,
} from '../lois-turn-plan';

const CURATOR_WRITE_VERB =
  /\b(generate|generating|create|creating|auto[- ]?fill(?:ing)?|build|building|make|making|draft|drafting|propose|proposing|fill|filling)\b/i;
const CURATOR_WRITE_ARTIFACT =
  /\b(time[ -]?tables?|schemes? of work|curricul(?:um|a))\b/i;
const CURATOR_APPLY_VERB = /\b(apply|save|confirm)\b/i;
const CURATOR_APPLY_TARGET =
  /\b(time[ -]?tables?|schemes?(?:\s+of\s+work)?|plans?|previews?|all|them|these|those)\b/i;

function normalizeIntentText(text?: string | null): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

const FINANCE_RE =
  /\b(?:who (?:still )?owes|outstanding (?:school )?fees?|fee debtors?|unpaid fees?|school fees?|bursar|tuition)\b/i;
const ADMISSIONS_RE =
  /\b(?:pending (?:admission )?applications?|admissions? inbox|how many applicants|admission applications?)\b/i;
const INSIGHTS_RE =
  /\b(?:what (?:have you|did you) (?:already )?noticed|any insights?\b|lois noticed|filed (?:report|insight|briefing)|insights i should)\b/i;
const ACADEMIC_READ_RE =
  /\b(?:at[- ]risk|academically|class averages?|how is .{0,60}performing|scheme of work|attendance)\b/i;
const OPERATIONS_PEOPLE_RE =
  /\b(?:who(?:'s| is| are) in|students in|in [^.?]{0,80}'s class|class (?:list|roster|roll)|list(?: the)? students|who teaches|who(?:'s| is) (?:the )?(?:class )?teacher)\b/i;
const PEDAGOGY_RE =
  /\b(?:lesson plans?|flashcards?|practice quiz|grade (?:this |an |the )?essay|(?:generate|make|create|draft|build)\b[\s\w]{0,24}\b(?:quiz|quizzes|flashcards?|summar(?:y|ies)|assessments?|lesson plans?))\b/i;

const MAX_ROUTE_HOPS = 8;

function firstMatchIndex(text: string, re: RegExp): number {
  const match = text.match(re);
  return match?.index ?? -1;
}

export function isFinanceIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  return !!t && FINANCE_RE.test(t);
}

export function isAdmissionsIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  return !!t && ADMISSIONS_RE.test(t);
}

export function isInsightsIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  return !!t && INSIGHTS_RE.test(t);
}

export function isOperationsPeopleIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  return !!t && OPERATIONS_PEOPLE_RE.test(t);
}

export function isAcademicReadIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (isCuratorWriteIntent(t) || isCuratorApplyIntent(t)) return false;
  return ACADEMIC_READ_RE.test(t);
}

export function isPedagogyIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (isCuratorWriteIntent(t) || isCuratorApplyIntent(t)) return false;
  return PEDAGOGY_RE.test(t);
}

/** Desks the latest user message still needs, in the order they appear in the ask. */
export function desksRequiredForMessage(
  text?: string | null,
  allowedWorkers: LoisWorker[] = [],
): LoisWorker[] {
  const t = normalizeIntentText(text);
  if (!t) return [];
  const allow = new Set(allowedWorkers);
  const hits: { worker: LoisWorker; index: number }[] = [];
  const consider = (worker: LoisWorker, index: number) => {
    if (!allow.has(worker) || index < 0) return;
    hits.push({ worker, index });
  };
  consider('finance', firstMatchIndex(t, FINANCE_RE));
  consider('admissions', firstMatchIndex(t, ADMISSIONS_RE));
  consider('academic', firstMatchIndex(t, INSIGHTS_RE));
  if (isAcademicReadIntent(t)) consider('academic', firstMatchIndex(t, ACADEMIC_READ_RE));
  consider('operations', firstMatchIndex(t, OPERATIONS_PEOPLE_RE));
  if (isPedagogyIntent(t)) consider('pedagogy', firstMatchIndex(t, PEDAGOGY_RE));
  if (isCuratorWriteIntent(t) || isCuratorApplyIntent(t)) {
    const writeIdx = firstMatchIndex(t, CURATOR_WRITE_VERB);
    const applyIdx = firstMatchIndex(t, CURATOR_APPLY_VERB);
    consider('curator', writeIdx >= 0 ? writeIdx : applyIdx);
  }
  hits.sort((a, b) => a.index - b.index);
  const ordered: LoisWorker[] = [];
  for (const hit of hits) {
    if (!ordered.includes(hit.worker)) ordered.push(hit.worker);
  }
  return ordered;
}

export function nextUnvisitedDesk(params: {
  userMessage?: string | null;
  allowedWorkers: LoisWorker[];
  visitedWorkers?: LoisWorker[] | null;
  plannedWorkers?: LoisWorker[] | null;
}): LoisWorker | null {
  const visited = new Set(params.visitedWorkers || []);
  const allow = params.allowedWorkers;
  const ordered = uniqueDesks([
    ...desksRequiredForMessage(params.userMessage, allow),
    ...(params.plannedWorkers || []).filter((w) => allow.includes(w)),
  ]);
  return ordered.find((w) => !visited.has(w)) ?? null;
}

/**
 * True when the user asked to generate/create a timetable or scheme — not merely look one up.
 */
export function isCuratorWriteIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (/\b(?:do not|don't|dont|never)\s+(?:generate|creating|create|make|build|draft|propose|auto[- ]?fill)/i.test(t)) {
    return false;
  }
  return CURATOR_WRITE_VERB.test(t) && CURATOR_WRITE_ARTIFACT.test(t);
}

/**
 * True when the user asked to apply or save pending timetable/scheme previews.
 */
export function isCuratorApplyIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return CURATOR_APPLY_VERB.test(t) && CURATOR_APPLY_TARGET.test(t);
}

/** Anaphora / pending-clarify desks from thread memory. Empty if this is a new job. */
export function codedDesksFromAnaphora(params: {
  userMessage?: string | null;
  allowedWorkers: LoisWorker[];
  memory?: LoisThreadMemory | null;
}): { desks: LoisWorker[]; bound: boolean } {
  const allow = params.allowedWorkers;
  const message = params.userMessage;
  const memory = params.memory;
  if (!message || !memory) return { desks: [], bound: false };

  const regexDesks = desksRequiredForMessage(message, allow);
  if (regexDesks.length > 0 && !isJobContinuation(message, memory.lastJob)) {
    return { desks: [], bound: false };
  }

  if (memory.pendingClarify && looksLikeSlotFill(message) && regexDesks.length === 0 && !isCapabilityIntent(message)) {
    const desks = memory.pendingClarify.resumeDesks.filter((d) => allow.includes(d));
    return { desks, bound: desks.length > 0 };
  }

  if (isJobContinuation(message, memory.lastJob) && memory.lastJob && allow.includes(memory.lastJob.desk)) {
    return { desks: [memory.lastJob.desk], bound: true };
  }

  return { desks: [], bound: false };
}

/**
 * All desks code can prove from this message (and optional insight / anaphora).
 * Page focus is prompt context only — it must not start a desk.
 */
export function selectCodedDesks(params: {
  allowedWorkers: LoisWorker[];
  pageContext?: LoisPageContextInput | null;
  insightId?: string | null;
  userMessage?: string | null;
  memory?: LoisThreadMemory | null;
}): LoisWorker[] {
  const allowed = params.allowedWorkers;
  const allowSet = new Set(allowed);
  if (isCapabilityIntent(params.userMessage)) return [];

  const anaphora = codedDesksFromAnaphora({
    userMessage: params.userMessage,
    allowedWorkers: allowed,
    memory: params.memory,
  });

  const required = desksRequiredForMessage(params.userMessage, allowed);
  const insightId = params.insightId || params.pageContext?.insightId || null;
  const curatorWrite =
    isCuratorWriteIntent(params.userMessage) || isCuratorApplyIntent(params.userMessage);

  let desks = [...required];
  if (insightId && allowSet.has('academic') && !curatorWrite && !desks.includes('academic')) {
    desks = ['academic', ...desks];
  }
  if (anaphora.bound) {
    desks = uniqueDesks([...anaphora.desks, ...desks]);
  }
  return desks.filter((d) => allowSet.has(d));
}

/**
 * Code-selects the first worker. The model does not pick the start node.
 */
export function selectStartWorker(params: {
  allowedWorkers: LoisWorker[];
  pageContext?: LoisPageContextInput | null;
  insightId?: string | null;
  userMessage?: string | null;
  memory?: LoisThreadMemory | null;
}): LoisWorker | null {
  return selectCodedDesks(params)[0] ?? null;
}

/** Curator generate with no class named and none in memory — ask, do not guess. */
export function isBlockingClassClarify(params: {
  userMessage?: string | null;
  memory?: LoisThreadMemory | null;
}): boolean {
  if (!isCuratorWriteIntent(params.userMessage)) return false;
  if (hasClassOrLevelToken(params.userMessage)) return false;
  return !(params.memory?.classes && params.memory.classes.length > 0);
}

/** Default speaking desk when the message matches no specialised intent. */
export function defaultSpeaker(params: {
  userRole?: string;
  allowedWorkers: LoisWorker[];
}): LoisWorker | null {
  const preferred: LoisWorker = params.userRole === 'TEACHER' ? 'classroom' : 'operations';
  if (params.allowedWorkers.includes(preferred)) return preferred;
  return params.allowedWorkers[0] ?? null;
}

/**
 * Code-only graph router: next unvisited required or planned desk, else facing.
 * Unknown asks are handled outside the graph (clarify / rag / capability / off_topic).
 */
export function runCodeRoute(state: LoisGraphStateValues): Partial<LoisGraphStateValues> {
  if (state.hops >= MAX_ROUTE_HOPS) {
    return { activeWorker: null, hops: state.hops };
  }
  const lastUser =
    [...state.messages].reverse().find((m) => m.role === 'user' && m.content)?.content ?? null;
  const visited = state.visitedWorkers || [];
  const next = nextUnvisitedDesk({
    userMessage: lastUser,
    allowedWorkers: state.allowedWorkers,
    visitedWorkers: visited,
    plannedWorkers: state.plannedWorkers,
  });
  if (next) {
    return { activeWorker: next, hops: state.hops + 1 };
  }
  return { activeWorker: null, hops: state.hops };
}

export function routeFromCodeRoute(state: LoisGraphStateValues): string {
  if (!state.activeWorker) return 'end';
  if (!state.allowedWorkers.includes(state.activeWorker)) return 'end';
  return state.activeWorker;
}

export function adminGraphNodeNames(allowedWorkers: LoisWorker[]): string[] {
  const workers = allowedWorkers.filter((w) =>
    ['operations', 'academic', 'finance', 'admissions', 'curator', 'pedagogy'].includes(w),
  );
  const nodes = ['route', ...workers, 'facing'];
  if (workers.includes('curator')) nodes.push('wait_for_apply', 'applied_ack');
  return nodes;
}

export function teacherGraphNodeNames(allowedWorkers: LoisWorker[]): string[] {
  const workers = allowedWorkers.filter((w) => w === 'classroom' || w === 'pedagogy');
  return ['route', ...workers, 'facing'];
}
