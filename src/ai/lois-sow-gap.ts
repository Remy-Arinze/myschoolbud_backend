/** One SOW_GAP card per published scheme-week; arms listed in evidence, not as extra cards. */

export type SowGapArm = {
  classArmId?: string | null;
  classId?: string | null;
  label: string;
  status?: string | null;
};

const SETTLED = new Set(['DELIVERED', 'SKIPPED', 'COMBINED']);

export function formatArmList(labels: string[]): string {
  const unique = labels.map((l) => l.trim()).filter(Boolean);
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

export function isGenericSowHref(href?: string | null): boolean {
  const value = (href || '').trim();
  if (!value || value === '/dashboard/school/overview' || value === '/dashboard/school/courses') {
    return true;
  }
  if (!value.startsWith('/dashboard/school/courses')) return false;
  return !value.includes('scheme=');
}

export function sowGapHref(evidence: {
  classArmId?: string | null;
  classId?: string | null;
  outstandingArms?: SowGapArm[];
  schemeId?: string | null;
  weekNumber?: number | null;
}): string | null {
  const courseId =
    evidence.outstandingArms?.find((a) => a.classArmId)?.classArmId ||
    evidence.outstandingArms?.find((a) => a.classId)?.classId ||
    evidence.classArmId ||
    evidence.classId ||
    null;
  if (!courseId) return null;
  const params = new URLSearchParams({ tab: 'curriculum' });
  if (evidence.schemeId) params.set('scheme', evidence.schemeId);
  if (typeof evidence.weekNumber === 'number' && evidence.weekNumber > 0) {
    params.set('week', String(evidence.weekNumber));
  }
  return `/dashboard/school/courses/${courseId}?${params.toString()}`;
}

export function sowGapAskPrompt(input: {
  classLevel: string;
  subject: string;
  weekNumber: number;
  topic: string;
  outstandingLabels: string[];
  deliveredLabels: string[];
}): string {
  const outstanding = formatArmList(input.outstandingLabels) || input.classLevel;
  const delivered =
    input.deliveredLabels.length > 0
      ? ` Already marked delivered: ${formatArmList(input.deliveredLabels)}.`
      : '';
  return (
    `The published scheme of work for ${input.classLevel} ${input.subject} already includes week ${input.weekNumber} (${input.topic}). ` +
    `That week has passed on the calendar. Delivery is still outstanding in ${outstanding} (no delivery mark or lesson note).` +
    delivered +
    ` This is not a missing scheme — do not say the scheme is unpublished. What is outstanding and which teachers should follow up?`
  );
}

export function sowGapTitle(input: {
  classLevel: string;
  subject: string;
  weekNumber: number;
  outstandingLabels: string[];
}): string {
  const scope =
    input.outstandingLabels.length === 1 ? input.outstandingLabels[0] : input.classLevel;
  return `${scope} ${input.subject} · week ${input.weekNumber} not delivered`;
}

export function sowGapSummary(input: {
  weekNumber: number;
  topic: string;
  outstandingLabels: string[];
  deliveredLabels: string[];
}): string {
  const outstanding = formatArmList(input.outstandingLabels);
  const delivered = formatArmList(input.deliveredLabels);
  const who = outstanding
    ? `Outstanding in ${outstanding} — no delivery mark or lesson note.`
    : 'No delivery mark or lesson note.';
  const done = delivered ? ` Marked delivered: ${delivered}.` : '';
  return `Week ${input.weekNumber} (${input.topic}) has passed on the calendar. ${who}${done}`;
}

export function partitionArmsForWeek(input: {
  arms: SowGapArm[];
  deliveries: Array<{ classArmId?: string | null; classId?: string | null; status: string }>;
  weekIsDelivered: boolean;
}): { outstanding: SowGapArm[]; delivered: SowGapArm[] } {
  const { arms, deliveries, weekIsDelivered } = input;
  if (arms.length === 0) {
    return weekIsDelivered
      ? { outstanding: [], delivered: [] }
      : { outstanding: [], delivered: [] };
  }

  const byArm = new Map(
    deliveries.filter((d) => d.classArmId).map((d) => [d.classArmId as string, d]),
  );
  if (byArm.size === 0 && weekIsDelivered) {
    return { outstanding: [], delivered: arms };
  }

  const outstanding: SowGapArm[] = [];
  const delivered: SowGapArm[] = [];
  for (const arm of arms) {
    const row = arm.classArmId ? byArm.get(arm.classArmId) : undefined;
    if (row && SETTLED.has(row.status)) {
      delivered.push({ ...arm, status: row.status });
    } else {
      outstanding.push({ ...arm, status: row?.status || 'PENDING' });
    }
  }
  return { outstanding, delivered };
}
