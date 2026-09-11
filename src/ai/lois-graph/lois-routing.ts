import { LoisPageContextInput } from '../ai-page-context';
import { isLoisWorker, type LoisWorker } from '../lois-workers';

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

export function isFinanceIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return /\b(?:who (?:still )?owes|outstanding (?:school )?fees?|fee debtors?|unpaid fees?|school fees?|bursar|tuition)\b/i.test(
    t,
  );
}

export function isAdmissionsIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return /\b(?:pending (?:admission )?applications?|admissions? inbox|how many applicants|admission applications?)\b/i.test(
    t,
  );
}

export function isInsightsIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return /\b(?:what (?:have you|did you) (?:already )?noticed|any insights?\b|lois noticed|filed (?:report|insight|briefing)|insights i should)\b/i.test(
    t,
  );
}

export function isAcademicReadIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (isCuratorWriteIntent(t) || isCuratorApplyIntent(t)) return false;
  return /\b(?:at[- ]risk|academically|class averages?|how is .{0,60}performing|scheme of work|attendance)\b/i.test(
    t,
  );
}

/**
 * True when the user asked to generate/create a timetable or scheme — not merely look one up.
 */
export function isCuratorWriteIntent(text?: string | null): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
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

/**
 * Code-selects the first worker. The model does not pick the start node.
 */
export function selectStartWorker(params: {
  allowedWorkers: LoisWorker[];
  pageContext?: LoisPageContextInput | null;
  insightId?: string | null;
  userMessage?: string | null;
}): LoisWorker | null {
  const allowed = new Set(params.allowedWorkers);
  if (
    (isCuratorWriteIntent(params.userMessage) || isCuratorApplyIntent(params.userMessage)) &&
    allowed.has('curator')
  ) {
    return 'curator';
  }

  const insightId = params.insightId || params.pageContext?.insightId || null;
  if (insightId && allowed.has('academic')) return 'academic';

  if (isFinanceIntent(params.userMessage) && allowed.has('finance')) return 'finance';
  if (isAdmissionsIntent(params.userMessage) && allowed.has('admissions')) return 'admissions';
  if (isInsightsIntent(params.userMessage) && allowed.has('academic')) return 'academic';
  if (isAcademicReadIntent(params.userMessage) && allowed.has('academic')) return 'academic';

  const type = (params.pageContext?.type || '').toLowerCase();
  const path = (params.pageContext?.path || '').toLowerCase();
  const curatorFocus =
    type === 'timetable' ||
    type === 'scheme' ||
    path.includes('timetable') ||
    path.includes('scheme-of-work') ||
    path.includes('/curriculum');
  if (curatorFocus && allowed.has('curator')) return 'curator';

  if (type === 'assessment' && allowed.has('pedagogy')) return 'pedagogy';
  return null;
}

export function parseSupervisorNext(raw: string, allowedWorkers: LoisWorker[]): {
  next: LoisWorker | 'end';
  reply: string;
} {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  let next: string = 'end';
  let reply = '';
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { next?: string; reply?: string };
      if (parsed.next) next = String(parsed.next).toLowerCase().trim();
      if (parsed.reply) reply = String(parsed.reply).trim();
    } catch {
      next = 'end';
    }
  }
  if (next === 'end') return { next: 'end', reply };
  if (isLoisWorker(next) && allowedWorkers.includes(next)) {
    return { next, reply: '' };
  }
  return { next: 'end', reply };
}

export function adminGraphNodeNames(allowedWorkers: LoisWorker[]): string[] {
  const workers = allowedWorkers.filter((w) =>
    ['operations', 'academic', 'finance', 'admissions', 'curator', 'pedagogy'].includes(w),
  );
  const nodes = ['supervisor', ...workers];
  if (workers.includes('curator')) nodes.push('wait_for_apply', 'applied_ack');
  return nodes;
}

export function teacherGraphNodeNames(allowedWorkers: LoisWorker[]): string[] {
  const workers = allowedWorkers.filter((w) => w === 'classroom' || w === 'pedagogy');
  return ['supervisor', ...workers];
}
