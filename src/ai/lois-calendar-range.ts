/** Africa/Lagos calendar windows for Lois get_calendar. Dates are YYYY-MM-DD. */

import { isBrushOffOnly, stripDashboardBrushOff } from './lois-reply-sanitize';

export type CalendarPreset = 'this_week' | 'next_week' | 'today';
export type NamedCalendarDate = { label: string; date: string };

const MONTH = /jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?/i;

const MONTH_NUM: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

/** Named holidays / spoken dates in the user message (Africa/Lagos year of todayYmd). */
export function extractNamedCalendarDates(
  userMessage: string | null | undefined,
  todayYmd: string,
): NamedCalendarDate[] {
  const year = todayYmd.slice(0, 4);
  const t = (userMessage || '').replace(/\s+/g, ' ');
  const out: NamedCalendarDate[] = [];
  const push = (label: string, date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (out.some((x) => x.date === date && x.label === label)) return;
    out.push({ label, date });
  };
  if (/\bindependence(?:\s+day)?\b/i.test(t)) push('Independence Day', `${year}-10-01`);
  if (/\bdemocracy day\b/i.test(t)) push('Democracy Day', `${year}-06-12`);
  if (/\bworkers'? day\b|\blabour day\b|\bmay day\b/i.test(t)) push("Workers' Day", `${year}-05-01`);
  if (/\bchristmas\b/i.test(t)) push('Christmas', `${year}-12-25`);
  if (/\bboxing day\b/i.test(t)) push('Boxing Day', `${year}-12-26`);
  if (/\bnew year'?s?(?:\s+day)?\b/i.test(t)) push("New Year's Day", `${year}-01-01`);

  const spoken = new RegExp(
    String.raw`\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH.source})|(${MONTH.source})\s+(\d{1,2})(?:st|nd|rd|th)?)\b`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = spoken.exec(t))) {
    const day = m[1] || m[4];
    const mon = (m[2] || m[3] || '').toLowerCase();
    const mm = MONTH_NUM[mon];
    if (!day || !mm) continue;
    push(`${Number(day)} ${mon[0].toUpperCase()}${mon.slice(1)}`, `${year}-${mm}-${String(Number(day)).padStart(2, '0')}`);
  }
  return out;
}

export function isYmd(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Monday of the week that contains `ymd` (ISO-style week, Monday start). */
export function mondayOfWeek(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay(); // 0 Sun … 6 Sat
  const back = day === 0 ? 6 : day - 1;
  return addDaysYmd(ymd, -back);
}

export function inferCalendarPreset(
  range?: string | null,
  userMessage?: string | null,
): CalendarPreset | null {
  const r = (range || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (r === 'this_week' || r === 'next_week' || r === 'today') return r as CalendarPreset;

  const t = (userMessage || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/\bnext week\b/i.test(t)) return 'next_week';
  if (/\bthis week\b/i.test(t)) return 'this_week';
  const namedDate =
    /\b\d{4}-\d{2}-\d{2}\b/.test(t) ||
    new RegExp(String.raw`\b\d{1,2}\s+(?:${MONTH.source})\b`, 'i').test(t) ||
    new RegExp(String.raw`\b(?:${MONTH.source})\s+\d{1,2}\b`, 'i').test(t);
  if (namedDate) return null;
  if (/\bwhat'?s happening\b|\bare we on holiday\b/i.test(t)) return 'this_week';
  if (/\btoday\b|\btonight\b/i.test(t)) return 'today';
  return null;
}

export function resolveCalendarWindow(
  args: { range?: string; from?: string; to?: string },
  todayYmd: string,
  userMessage?: string | null,
): { from: string; to: string; preset: CalendarPreset | 'custom' } {
  const preset = inferCalendarPreset(args.range, userMessage);
  if (preset === 'today') {
    return { from: todayYmd, to: todayYmd, preset };
  }
  if (preset === 'this_week' || (!preset && !isYmd(args.from) && !isYmd(args.to))) {
    const mon = mondayOfWeek(todayYmd);
    return { from: mon, to: addDaysYmd(mon, 6), preset: preset || 'this_week' };
  }
  if (preset === 'next_week') {
    const mon = addDaysYmd(mondayOfWeek(todayYmd), 7);
    return { from: mon, to: addDaysYmd(mon, 6), preset };
  }
  const from = isYmd(args.from) ? args.from : todayYmd;
  const to = isYmd(args.to) ? args.to : addDaysYmd(from, 7);
  return { from, to, preset: 'custom' };
}

/** Merge streamed worker turns so the same refusal is not shown twice. */
export function mergeAssistantTurns(previous: string, incoming: string): string {
  const prev = previous.trim();
  const next = incoming.trim();
  if (!next) return previous;
  if (!prev) return incoming;
  if (isBrushOffOnly(next) && !isBrushOffOnly(prev)) return previous;
  if (isBrushOffOnly(prev) && !isBrushOffOnly(next)) return incoming;
  if (next === prev) return previous;
  if (next.startsWith(prev)) return incoming;
  if (prev.startsWith(next)) return previous;
  if (prev.includes(next) || next.includes(prev)) {
    return next.length >= prev.length ? incoming : previous;
  }
  const prevClean = stripDashboardBrushOff(prev);
  const nextClean = stripDashboardBrushOff(next);
  if (nextClean && prevClean !== prev) {
    return nextClean === next ? incoming : `${prevClean}\n${incoming}`.trim();
  }
  return `${previous.trim()}\n${incoming}`;
}

/** Drop identical paragraphs if the model repeats a refusal in one reply. */
export function collapseRepeatedParagraphs(text: string): string {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  for (const p of paras) {
    const t = p.trim();
    if (!t) continue;
    if (out.some((q) => q.trim() === t)) continue;
    out.push(p);
  }
  return out.join('\n\n');
}
