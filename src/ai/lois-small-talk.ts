import { desksRequiredForMessage, isCuratorApplyIntent, isCuratorWriteIntent } from './lois-graph/lois-routing';
import { isCapabilityIntent } from './lois-turn-plan';
import { LOIS_WORKERS } from './lois-workers';

const MAX_SMALL_TALK_CHARS = 80;

const RESERVED_WHOLE = new Set([
  'ok',
  'okay',
  'yes',
  'yeah',
  'yep',
  'apply',
  'go ahead',
  'do it',
  'save',
  'please',
]);

const SMALL_TALK_PHRASES = [
  'hi',
  'hello',
  'hey',
  'hey there',
  'hi there',
  'hiya',
  'yo',
  'good morning',
  'good afternoon',
  'good evening',
  'thanks',
  'thank you',
  'thank you so much',
  'thanks a lot',
  'thanks so much',
  'how are you',
  'how are you doing',
  'who are you',
  'what can you do',
  'what do you do',
];

export function normalizeSmallTalk(text?: string | null): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesSmallTalkPhrase(normalized: string): boolean {
  if (SMALL_TALK_PHRASES.includes(normalized)) return true;
  for (const phrase of SMALL_TALK_PHRASES) {
    if (!normalized.startsWith(`${phrase} `)) continue;
    const rest = normalized.slice(phrase.length).trim();
    if (/^[a-z][a-z'-]{0,40}$/.test(rest)) return true;
  }
  return false;
}

/**
 * Conservative whole-message small-talk detector.
 * False negatives (full school path) are preferred over skipping a real ask.
 */
export function isLoisSmallTalk(
  text?: string | null,
  opts?: { interrupted?: boolean },
): boolean {
  if (opts?.interrupted) return false;
  const raw = (text || '').trim();
  if (!raw || raw.length > MAX_SMALL_TALK_CHARS) return false;

  const normalized = normalizeSmallTalk(raw);
  if (!normalized) return false;
  if (RESERVED_WHOLE.has(normalized)) return false;
  if (isCuratorWriteIntent(raw) || isCuratorApplyIntent(raw)) return false;
  if (isCapabilityIntent(raw)) return false;
  if (desksRequiredForMessage(raw, [...LOIS_WORKERS]).length > 0) return false;
  return matchesSmallTalkPhrase(normalized);
}

export function smallTalkReply(params: {
  firstName?: string | null;
  schoolName?: string | null;
  userMessage?: string | null;
}): string {
  const name = (params.firstName || '').trim();
  const school = (params.schoolName || '').trim();
  const normalized = normalizeSmallTalk(params.userMessage);
  const atSchool = school ? ` at ${school}` : '';

  if (normalized.startsWith('thank')) {
    return name
      ? `You're welcome, ${name}. I'm here if you need anything${atSchool}.`
      : `You're welcome. I'm here if you need anything${atSchool}.`;
  }

  if (normalized.startsWith('who are you') || normalized.startsWith('what can you do') || normalized.startsWith('what do you do')) {
    const who = school
      ? `I am Lois, the AI assistant for ${school} on Myschoolbud.`
      : 'I am Lois, your Myschoolbud AI assistant.';
    return `${who} Ask me about the school, and I'll look it up.`;
  }

  const hi = name ? `Hi ${name}!` : 'Hi!';
  const who = school ? ` I'm Lois, the assistant for ${school}.` : ` I'm Lois.`;
  return `${hi}${who} How can I help today?`;
}
