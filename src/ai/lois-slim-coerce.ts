import { isCuratorApplyIntent, isCuratorWriteIntent } from './lois-graph/lois-routing';
import type { LoisThreadMemory } from './lois-thread-memory';
import {
  emptyClarifyPlan,
  hasClassOrLevelToken,
  isCapabilityIntent,
  uniqueDesks,
  type LoisTurnPlan,
} from './lois-turn-plan';
import { isLoisWorker, type LoisWorker } from './lois-workers';

const STAFF_WRITE_RE =
  /\b(?:payroll|on the payroll|hire|recruit|put [\s\w]{0,48} on (?:the )?(?:staff|payroll))\b/i;
const PEDAGOGY_PARAPHRASE_RE =
  /\b(?:revision questions?|practice questions?|quiz(?:zes)?|mcqs?|multiple[- ]choice|exercises?|drills?|flashcards?|lesson plans?|worksheet)\b/i;
const DRAFT_NOT_SEND_RE =
  /\b(?:just draft|draft(?: it)?|(?:a )?note i can copy|(?:don't|do not|dont|never)\s+(?:actually\s+)?(?:send|fire it off|fire|blast it|shoot it))\b/i;
const GENERATE_SCHEDULE_RE =
  /\b(?:spin up|weekly schedule|weekly grid)\b/i;
const SCHOOL_ASK_RE =
  /\b(?:october|holiday|closed|shutting|independence|remind me|recap|children|pupils|kids|the names|names you gave|debt|fees?|owing|paid|timetable|on the board|thursday|schedule)\b/i;
/**
 * School vocabulary is unbounded, so off_topic is gated on the subjects Lois declines
 * instead. Anything that matches nothing here is treated as a school ask.
 */
const OFF_TOPIC_DOMAIN_RE =
  /\b(?:recipe|recipes|cook(?:ing)?|jollof|egusi|football|soccer|chelsea|arsenal|man(?:chester)? (?:u|utd|united|city)|premier league|starting xi|super eagles|osimhen|world cup|poem|poetry|haiku|sonnet|song|lyrics|joke|weather|forecast|celebrity|musician|actor|movie|film|netflix|horoscope|politics|election)\b/i;
const ACADEMIC_PARAPHRASE_RE = /\b(?:struggling|falling behind|behind in (?:class|jss|primary))\b/i;
const OPERATIONS_PARAPHRASE_RE =
  /\b(?:children|pupils|names?|on the board|thursday|holiday|closed|shutting|october|independence|remind me|recap|calendar)\b/i;
const FINANCE_PARAPHRASE_RE = /\b(?:debt|fees?|owing|payments?|paid|bill)\b/i;

function normalize(text?: string | null): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

export function isStaffWriteParaphrase(text?: string | null): boolean {
  const t = normalize(text);
  return !!t && (STAFF_WRITE_RE.test(t) || isCapabilityIntent(t));
}

export function isPedagogyParaphrase(text?: string | null): boolean {
  return !!normalize(text) && PEDAGOGY_PARAPHRASE_RE.test(normalize(text));
}

export function isDraftNotSend(text?: string | null): boolean {
  return !!normalize(text) && DRAFT_NOT_SEND_RE.test(normalize(text));
}

export function isSchoolAsk(text?: string | null): boolean {
  const t = normalize(text);
  if (!t) return false;
  return hasClassOrLevelToken(t) || SCHOOL_ASK_RE.test(t);
}

/** Off-topic only survives when it names a domain Lois declines and asks nothing about the school. */
export function isPureOffTopic(text?: string | null): boolean {
  const t = normalize(text);
  if (!t) return false;
  return OFF_TOPIC_DOMAIN_RE.test(t) && !isSchoolAsk(t);
}

function hasNamedClass(text?: string | null, memory?: LoisThreadMemory | null): boolean {
  if (hasClassOrLevelToken(text)) return true;
  return !!(memory?.classes && memory.classes.length > 0);
}

function looksLikeGenerateWithoutClass(text?: string | null, memory?: LoisThreadMemory | null): boolean {
  const t = normalize(text);
  if (!t || hasNamedClass(t, memory)) return false;
  return GENERATE_SCHEDULE_RE.test(t) || isCuratorWriteIntent(t) || isCuratorApplyIntent(t);
}

/** A positive send is a write Lois cannot do; "don't send" is caught by isDraftNotSend first. */
const SEND_WRITE_RE = /\b(?:whatsapp|broadcast|sms|text (?:her|him|them)|email|e-mail|mail)\b/i;

function isTrueCapability(text?: string | null): boolean {
  const t = normalize(text);
  if (!t || isDraftNotSend(t) || isPedagogyParaphrase(t)) return false;
  return isStaffWriteParaphrase(t) || SEND_WRITE_RE.test(t);
}

/** Desks inferred from paraphrases that miss coded regex. Never used by selectCodedDesks. */
export function guessDesksFromParaphrase(
  text?: string | null,
  allowedWorkers: LoisWorker[] = [],
): LoisWorker[] {
  const t = normalize(text);
  if (!t) return [];
  const allow = new Set(allowedWorkers);
  const hits: LoisWorker[] = [];
  const add = (desk: LoisWorker) => {
    if (allow.has(desk) && !hits.includes(desk)) hits.push(desk);
  };
  if (ACADEMIC_PARAPHRASE_RE.test(t)) add('academic');
  if (FINANCE_PARAPHRASE_RE.test(t)) add('finance');
  if (PEDAGOGY_PARAPHRASE_RE.test(t)) add('pedagogy');
  if (OPERATIONS_PARAPHRASE_RE.test(t)) add('operations');
  return hits;
}

function desksPlan(
  desks: LoisWorker[],
  allowedWorkers: LoisWorker[],
  reason: string,
  schoolPart: string | null = null,
): LoisTurnPlan {
  const filtered = uniqueDesks(desks.filter((d) => isLoisWorker(d) && allowedWorkers.includes(d)));
  if (filtered.length === 0) {
    const fallback = allowedWorkers.includes('operations')
      ? 'operations'
      : allowedWorkers[0];
    if (!fallback) return emptyClarifyPlan(reason);
    return { mode: 'desks', desks: [fallback], missing: [], question: null, reason, schoolPart };
  }
  return { mode: 'desks', desks: filtered, missing: [], question: null, reason, schoolPart };
}

/**
 * Trust slim desks. Rewrite clarify / capability / off_topic when the latest
 * message is clearly a school read, pedagogy generate, or draft-not-send.
 */
export function coerceSlimPlan(params: {
  slim: LoisTurnPlan | null;
  userMessage?: string | null;
  allowedWorkers: LoisWorker[];
  memory?: LoisThreadMemory | null;
}): LoisTurnPlan | null {
  const slim = params.slim;
  if (!slim) return null;
  const allowed = params.allowedWorkers;
  const message = params.userMessage;
  const guessed = guessDesksFromParaphrase(message, allowed);

  if (slim.mode === 'desks' || slim.mode === 'rag') return slim;

  if (slim.mode === 'clarify' && looksLikeGenerateWithoutClass(message, params.memory)) return slim;

  // A real write still refuses. Everything else slim called capability is a paraphrase the
  // coded write-detector already declined, so it goes to a desk rather than a canned line.
  if (slim.mode === 'capability') {
    if (isTrueCapability(message)) return slim;
    if (isPedagogyParaphrase(message)) {
      return desksPlan(['pedagogy'], allowed, `${slim.reason || 'capability'}→pedagogy`);
    }
    if (isDraftNotSend(message)) {
      return desksPlan(['operations'], allowed, `${slim.reason || 'capability'}→draft`);
    }
    return desksPlan(guessed, allowed, `${slim.reason || 'capability'}→desk`);
  }

  // Off-topic must name a bounded domain and leave no school clause behind.
  if (slim.mode === 'off_topic') {
    const schoolPart = normalize(slim.schoolPart);
    if (!schoolPart && isPureOffTopic(message)) return slim;
    const ask = schoolPart || message;
    return desksPlan(
      guessDesksFromParaphrase(ask, allowed),
      allowed,
      `${slim.reason || 'off_topic'}→school`,
      schoolPart || null,
    );
  }

  if (slim.mode === 'clarify') {
    const curatorWrite = isCuratorWriteIntent(message) || isCuratorApplyIntent(message);
    if (curatorWrite && hasNamedClass(message, params.memory)) {
      return desksPlan(['curator'], allowed, `${slim.reason || 'clarify'}→curator`);
    }
    if (hasNamedClass(message, params.memory) && !curatorWrite) {
      return desksPlan(guessed, allowed, `${slim.reason || 'clarify'}→desks`);
    }
  }

  return slim;
}
