/** Class-label matching and model-facing redaction for Lois curator plans. */

const INTERNAL_KEYS = new Set([
  'planId',
  'id',
  'expiresAt',
  'classId',
  'classArmId',
  'classLevelId',
  'subjectId',
  'termId',
  'agoraCurriculumId',
  'schoolCurriculumDocId',
  'schemeId',
  'studentId',
  'teacherId',
  'userId',
  'schoolId',
  'conversationId',
]);

export function tokenizeClassLabel(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function classLabelMatches(label: string | undefined | null, query: string | undefined | null): boolean {
  if (!label || !query) return false;
  const labelTokens = tokenizeClassLabel(label);
  const queryTokens = tokenizeClassLabel(query);
  if (labelTokens.length === 0 || queryTokens.length === 0) return false;
  if (labelTokens.join(' ') === queryTokens.join(' ')) return true;
  return (
    queryTokens.length <= labelTokens.length &&
    queryTokens.every((token, index) => labelTokens[index] === token)
  );
}

export function payloadClassLabel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const rec = payload as { classLabel?: unknown; subjectLabel?: unknown };
  if (typeof rec.classLabel === 'string' && rec.classLabel.trim()) return rec.classLabel.trim();
  if (typeof rec.subjectLabel === 'string' && rec.subjectLabel.trim()) return rec.subjectLabel.trim();
  return undefined;
}

const CLIENT_STRIP = new Set(
  [...INTERNAL_KEYS].filter((key) => key !== 'planId'),
);

/** Strip internal ids from the payload streamed to the chat UI. Keep planId for Apply. */
export function toClientFacingToolData(data: unknown): unknown {
  return stripKeys(data, CLIENT_STRIP);
}

export function toClientFacingToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const next = stripKeys(args, CLIENT_STRIP);
  return next && typeof next === 'object' && !Array.isArray(next)
    ? (next as Record<string, unknown>)
    : {};
}

function stripKeys(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => stripKeys(item, keys));
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key)) continue;
    next[key] = stripKeys(nested, keys);
  }
  return next;
}

const FACING_TOOLS = new Set(['propose_timetable', 'propose_scheme', 'apply_pending_plans']);

export function toModelFacingToolData(toolName: string, data: unknown): unknown {
  if (!FACING_TOOLS.has(toolName)) return data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const src = data as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (INTERNAL_KEYS.has(key)) continue;
    next[key] = value;
  }
  if (toolName === 'propose_timetable' || toolName === 'propose_scheme') {
    next.pending = src.error ? false : true;
    if (typeof src.saved !== 'boolean') next.saved = false;
  }
  return next;
}
