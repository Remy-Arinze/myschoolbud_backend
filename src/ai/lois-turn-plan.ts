import { isLoisWorker, type LoisWorker } from './lois-workers';
import type { LoisLastJob } from './lois-thread-memory';

export const LOIS_TURN_MODES = ['desks', 'clarify', 'rag', 'capability', 'off_topic'] as const;
export type LoisTurnMode = (typeof LOIS_TURN_MODES)[number];

export type LoisTurnPlan = {
  mode: LoisTurnMode;
  desks: LoisWorker[];
  missing: string[];
  question: string | null;
  reason: string;
  /** The school clause of a mixed message, verbatim. Null when the whole message is the ask. */
  schoolPart: string | null;
};

export type LoisRouteSource =
  | 'coded'
  | 'slim'
  | 'anaphora'
  | 'clarify'
  | 'rag'
  | 'capability'
  | 'off_topic';

export const DEFAULT_CLARIFY_QUESTION =
  'Which class, or is this fees, timetable, or a student?';

export const CLASS_CLARIFY_QUESTION = 'Which class or level should I generate a timetable for?';

const ANAPHORA_RE = /\b(?:do this|the same|same again|\balso\b|\btoo\b|\bagain\b|\bthat\b)\b/i;
const CAPABILITY_RE =
  /\b(?:take|record|confirm)\b.{0,48}\b(?:payment|fees?|tuition)\b|\b(?:hire|add|recruit)\b.{0,32}\bstaff\b|\b(?:send|whatsapp|email)\b.{0,48}\b(?:parent|guardian|message)\b|\b(?:accept|decline|approve|enrol(?:l)?)\b.{0,48}\b(?:admission|applicant|application)s?\b/i;
const CLASS_OR_LEVEL_RE =
  /\b(?:jss|js|sss|ss)\s*\d|[a-z]{2,}\s*\d+\s*[a-z]\b|primary\s+\d|year\s+\d|form\s+\d|all (?:the )?(?:class )?arms|class arms in/i;

export function isLoisTurnMode(value: string): value is LoisTurnMode {
  return (LOIS_TURN_MODES as readonly string[]).includes(value);
}

export function uniqueDesks(desks: LoisWorker[]): LoisWorker[] {
  const out: LoisWorker[] = [];
  for (const d of desks) {
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

export function emptyClarifyPlan(reason: string, question?: string | null): LoisTurnPlan {
  return {
    mode: 'clarify',
    desks: [],
    missing: [],
    question: question || DEFAULT_CLARIFY_QUESTION,
    reason,
    schoolPart: null,
  };
}

export function hasClassOrLevelToken(text?: string | null): boolean {
  return !!text && CLASS_OR_LEVEL_RE.test(text);
}

export function isCapabilityIntent(text?: string | null): boolean {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return !!t && CAPABILITY_RE.test(t);
}

export function isOpenAsk(text?: string | null, codedDeskCount = 0): boolean {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (ANAPHORA_RE.test(t)) return true;
  if (isCapabilityIntent(t)) return true;
  const clauses = t
    .split(/\s+\band\b|[;?]|\n/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
  return clauses.length > Math.max(codedDeskCount, 1);
}

export function needsSlim(params: {
  interrupted?: boolean;
  codedDesks: LoisWorker[];
  userMessage?: string | null;
  anaphoraBound?: boolean;
}): boolean {
  if (params.interrupted) return false;
  if (params.anaphoraBound) return false;
  if (params.codedDesks.length === 0) return true;
  return isOpenAsk(params.userMessage, params.codedDesks.length);
}

export function looksLikeSlotFill(text?: string | null): boolean {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (hasClassOrLevelToken(t)) return true;
  if (/^(yes|yeah|yep|ok|okay|no)$/i.test(t)) return true;
  return t.length <= 80 && !/\?/.test(t) && !isCapabilityIntent(t);
}

export function isJobContinuation(text: string | null | undefined, lastJob: LoisLastJob | null): boolean {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t || !lastJob) return false;
  const cont = /\b(?:do this|the same|same again|\balso\b|\btoo\b|\banother\b|\bagain\b)\b/i.test(t);
  if (lastJob.desk === 'curator') {
    if (cont) return true;
    return hasClassOrLevelToken(t) && t.length <= 80 && !/\b(?:attendance|fees?|quiz|lesson)\b/i.test(t);
  }
  if (lastJob.desk === 'pedagogy') {
    return cont && /\b(?:quiz|lesson|flashcards?|summary|assessment)\b/i.test(t);
  }
  if (lastJob.desk === 'finance') {
    return cont || /\b(?:and in|also in|same for)\b/i.test(t);
  }
  return cont && hasClassOrLevelToken(t);
}

export const GENERIC_CAPABILITY_REPLY = "I can't do that from chat. Use the dashboard for that action.";

const NEGATED_SEND_RE = /\b(?:don't|do not|dont|never)\s+(?:actually\s+)?(?:send|whatsapp|email)\b/i;

export function capabilityReply(text?: string | null): string {
  const t = text || '';
  if (/\b(?:take|record|confirm)\b.{0,48}\b(?:payment|fees?|tuition)\b/i.test(t)) {
    return "I can't record or take a payment. Bursary isn't fully built yet.";
  }
  if (/\b(?:hire|add|recruit)\b[\s\w]{0,24}\bstaff\b/i.test(t)) {
    return "I can't add or hire staff. Use Staff on the dashboard for that.";
  }
  if (/\b(?:send|whatsapp|email)\b/i.test(t) && !NEGATED_SEND_RE.test(t)) {
    return "I can draft a parent note, but I don't send mail or WhatsApp. Use the dashboard to send.";
  }
  if (/\b(?:accept|decline|approve|enrol(?:l)?)\b/i.test(t)) {
    return "I can't accept or decline applications. Use the Applications page.";
  }
  return GENERIC_CAPABILITY_REPLY;
}

export function offTopicReply(): string {
  return "I'm here for the school — fees, classes, timetables, and students. I don't write recipes or chat about unrelated topics.";
}

function filterAllowed(desks: unknown, allowedWorkers: LoisWorker[]): LoisWorker[] {
  if (!Array.isArray(desks)) return [];
  return uniqueDesks(
    desks
      .map((d) => String(d || '').toLowerCase().trim())
      .filter((d): d is LoisWorker => isLoisWorker(d) && allowedWorkers.includes(d)),
  );
}

/** Parse slim JSON. Invalid / converse / unknown desks → clarify (never operations). */
export function parseSlimPlan(raw: string, allowedWorkers: LoisWorker[]): LoisTurnPlan {
  const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) return emptyClarifyPlan('invalid-json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return emptyClarifyPlan('invalid-json');
  }

  const legacyNext = typeof parsed.next === 'string' ? parsed.next.toLowerCase().trim() : '';
  if (legacyNext && !parsed.mode) {
    if (legacyNext === 'converse' || legacyNext === 'end') return emptyClarifyPlan('converse');
    if (isLoisWorker(legacyNext) && allowedWorkers.includes(legacyNext)) {
      return {
        mode: 'desks',
        desks: [legacyNext],
        missing: [],
        question: null,
        reason: 'legacy-next',
        schoolPart: null,
      };
    }
    return emptyClarifyPlan('unknown-desk');
  }

  const modeRaw = typeof parsed.mode === 'string' ? parsed.mode.toLowerCase().trim() : '';
  if (modeRaw === 'converse' || modeRaw === 'end' || !modeRaw) {
    return emptyClarifyPlan(modeRaw || 'empty-mode');
  }
  if (!isLoisTurnMode(modeRaw)) return emptyClarifyPlan('unknown-mode');

  const desks = filterAllowed(parsed.desks, allowedWorkers);
  const missing = Array.isArray(parsed.missing)
    ? parsed.missing.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
    : [];
  const question = typeof parsed.question === 'string' && parsed.question.trim() ? parsed.question.trim() : null;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : modeRaw;
  const schoolPart =
    typeof parsed.schoolPart === 'string' && parsed.schoolPart.trim() ? parsed.schoolPart.trim() : null;

  if (modeRaw !== 'desks') {
    return { mode: modeRaw, desks: [], missing, question, reason, schoolPart };
  }
  if (desks.length === 0) return { ...emptyClarifyPlan('empty-desks'), schoolPart };
  return { mode: 'desks', desks, missing, question, reason, schoolPart };
}

/**
 * Coded desks always win and are never removed.
 * Slim may add remaining desks, or choose a non-desk mode only when coded is empty.
 */
export function mergeTurnPlan(params: {
  codedDesks: LoisWorker[];
  slim: LoisTurnPlan | null;
  lastJob?: LoisLastJob | null;
}): LoisTurnPlan {
  const coded = uniqueDesks(params.codedDesks);
  const slim = params.slim;
  if (coded.length > 0) {
    const extra = (slim?.desks || []).filter((d) => !coded.includes(d) && d !== 'curator');
    return {
      mode: 'desks',
      desks: [...coded, ...extra],
      missing: [],
      question: null,
      reason: slim ? `${slim.reason || 'slim'}+coded` : 'coded',
      schoolPart: slim?.schoolPart || null,
    };
  }
  if (slim && slim.mode !== 'desks') {
    return { ...slim, desks: [] };
  }
  const slimDesks = slim?.desks || [];
  if (slimDesks.length > 0) {
    return {
      mode: 'desks',
      desks: slimDesks,
      missing: slim?.missing || [],
      question: slim?.question || null,
      reason: slim?.reason || 'slim',
      schoolPart: slim?.schoolPart || null,
    };
  }
  return emptyClarifyPlan(slim ? slim.reason || 'no-desks' : 'no-desks');
}

export function routeSourceForPlan(params: {
  plan: LoisTurnPlan;
  anaphoraBound?: boolean;
  slimCalled?: boolean;
}): LoisRouteSource {
  if (params.plan.mode !== 'desks') return params.plan.mode;
  if (params.anaphoraBound) return 'anaphora';
  if (params.slimCalled) return 'slim';
  return 'coded';
}

export const SLIM_TURN_PLAN_SCHEMA = {
  name: 'lois_turn_plan',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: [...LOIS_TURN_MODES],
      },
      desks: { type: 'array', items: { type: 'string' } },
      missing: { type: 'array', items: { type: 'string' } },
      question: { type: 'string' },
      reason: { type: 'string' },
      schoolPart: { type: 'string' },
    },
    required: ['mode', 'desks', 'missing', 'question', 'reason', 'schoolPart'],
    additionalProperties: false,
  },
} as const;
