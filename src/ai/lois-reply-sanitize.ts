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
