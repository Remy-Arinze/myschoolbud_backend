/** Sentences that send the owner to a dashboard instead of quoting tools. */
export function isDashboardBrushOffSentence(text: string): boolean {
  const s = (text || '').trim();
  if (!s) return false;
  return (
    /don'?t have (?:access|the information)|do not have access|cannot provide (?:that|this) directly/i.test(s) ||
    /check the (?:fees|admissions|academic|curriculum|attendance|dashboard)/i.test(s) ||
    /visit the (?:fees|applications|attendance) page/i.test(s) ||
    /please refer to the attendance/i.test(s)
  );
}

export function looksLikeDashboardBrushOff(text: string): boolean {
  return isDashboardBrushOffSentence(text || '');
}

/** Drop dashboard brush-off sentences; keep tool-backed remainder. */
export function stripDashboardBrushOff(text: string): string {
  const raw = (text || '').trim();
  if (!raw) return '';
  const parts = raw.split(/(?<=[.!?])\s*/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !isDashboardBrushOffSentence(p));
  return kept.join(' ').replace(/[ \t]+\n/g, '\n').trim();
}

export function isBrushOffOnly(text: string): boolean {
  return !stripDashboardBrushOff(text);
}

/** Backend-shaped tokens that mean the copy-desk LLM should rewrite. */
export function needsFacingRewrite(text: string): boolean {
  const t = text || '';
  if (!t.trim()) return false;
  return (
    /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/.test(t) ||
    /\b[a-z]+_(?:owner|admin|teacher|role)\b/i.test(t) ||
    /\b(?:UserRole|adminRole|contextRole|userRole)\b/.test(t) ||
    /\bcmt[a-z0-9]{16,}\b/i.test(t) ||
    /\b(?:student|class|classArm|classLevel|teacher|school|user|term|scheme|plan|conversation|profile|subject|public)Ids?\b/i.test(
      t,
    ) ||
    /\b(?:list_students|list_staff|get_school_overview|list_lois_insights)\b/.test(t)
  );
}

/** Same replacements as the last-pass scrub, without trimming (safe for streamed chunks). */
export function scrubBackendWording(text: string): string {
  let out = (text || '').replace(/\u00a0/g, ' ');
  out = out.replace(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/g, (m) => m.toLowerCase().replace(/_/g, ' '));
  out = out.replace(/\b[a-z]+_(?:owner|admin|teacher|role)\b/gi, (m) => m.toLowerCase().replace(/_/g, ' '));
  out = out.replace(/\b(?:UserRole|adminRole|contextRole|userRole)\b/g, 'role');
  out = out.replace(/\bcmt[a-z0-9]{16,}\b/gi, '');
  out = out.replace(
    /\b(?:student|class|classArm|classLevel|teacher|school|user|term|scheme|plan|conversation|profile|subject|public)Ids?\b/gi,
    '',
  );
  return out;
}

/**
 * Last-pass scrub for anything backend-shaped that slipped into Lois's spoken reply.
 * The facing agent should already have rewritten; this catches leftovers.
 */
export function sanitizeUserFacingText(text: string): string {
  let out = scrubBackendWording(text);
  out = out.replace(/\s+([,.;:!?])/g, '$1');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+\n/g, '\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
