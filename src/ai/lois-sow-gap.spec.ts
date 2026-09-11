import {
  formatArmList,
  isGenericSowHref,
  partitionArmsForWeek,
  sowGapAskPrompt,
  sowGapHref,
  sowGapSummary,
  sowGapTitle,
} from './lois-sow-gap';

describe('lois-sow-gap', () => {
  it('keeps one title at the level unless a single arm is outstanding', () => {
    expect(
      sowGapTitle({
        classLevel: 'JSS 1',
        subject: 'Agricultural Science',
        weekNumber: 1,
        outstandingLabels: ['JSS 1 A', 'JSS 1 B', 'JSS 1 C'],
      }),
    ).toBe('JSS 1 Agricultural Science · week 1 not delivered');

    expect(
      sowGapTitle({
        classLevel: 'JSS 1',
        subject: 'Agricultural Science',
        weekNumber: 1,
        outstandingLabels: ['JSS 1 B'],
      }),
    ).toBe('JSS 1 B Agricultural Science · week 1 not delivered');
  });

  it('does not call the week a missing scheme', () => {
    const prompt = sowGapAskPrompt({
      classLevel: 'JSS 1',
      subject: 'Agricultural Science',
      weekNumber: 1,
      topic: 'Meaning of agriculture',
      outstandingLabels: ['JSS 1 B', 'JSS 1 C'],
      deliveredLabels: ['JSS 1 A'],
    });
    expect(prompt).toContain('published scheme of work');
    expect(prompt).toContain('JSS 1 B and JSS 1 C');
    expect(prompt).toContain('Already marked delivered: JSS 1 A');
    expect(prompt.toLowerCase()).not.toContain('is missing week');
  });

  it('lists outstanding arms in the summary', () => {
    expect(
      sowGapSummary({
        weekNumber: 1,
        topic: 'Meaning of agriculture',
        outstandingLabels: ['JSS 1 B', 'JSS 1 C'],
        deliveredLabels: ['JSS 1 A'],
      }),
    ).toBe(
      'Week 1 (Meaning of agriculture) has passed on the calendar. Outstanding in JSS 1 B and JSS 1 C — no delivery mark or lesson note. Marked delivered: JSS 1 A.',
    );
  });

  it('does not hide remaining arms when one arm delivered after a shared week flag', () => {
    const split = partitionArmsForWeek({
      arms: [
        { classArmId: 'a', label: 'JSS 1 A' },
        { classArmId: 'b', label: 'JSS 1 B' },
        { classArmId: 'c', label: 'JSS 1 C' },
      ],
      deliveries: [{ classArmId: 'a', status: 'DELIVERED' }],
      weekIsDelivered: true,
    });
    expect(split.delivered.map((a) => a.label)).toEqual(['JSS 1 A']);
    expect(split.outstanding.map((a) => a.label)).toEqual(['JSS 1 B', 'JSS 1 C']);
  });

  it('treats a level-wide mark with no arm rows as delivered for every arm', () => {
    const split = partitionArmsForWeek({
      arms: [
        { classArmId: 'a', label: 'JSS 1 A' },
        { classArmId: 'b', label: 'JSS 1 B' },
      ],
      deliveries: [],
      weekIsDelivered: true,
    });
    expect(split.outstanding).toHaveLength(0);
    expect(split.delivered).toHaveLength(2);
  });

  it('builds a scheme-week href on the first outstanding arm', () => {
    expect(
      sowGapHref({
        schemeId: 'sch-1',
        weekNumber: 1,
        outstandingArms: [{ classArmId: 'arm-b', label: 'JSS 1 B' }],
      }),
    ).toBe('/dashboard/school/courses/arm-b?tab=curriculum&scheme=sch-1&week=1');
  });

  it('treats the classes index as a generic SOW href', () => {
    expect(isGenericSowHref('/dashboard/school/courses')).toBe(true);
    expect(isGenericSowHref('/dashboard/school/courses/abc?tab=curriculum')).toBe(true);
    expect(isGenericSowHref('/dashboard/school/courses/abc?tab=curriculum&scheme=sch-1&week=1')).toBe(
      false,
    );
    expect(formatArmList(['JSS 1 A', 'JSS 1 B', 'JSS 1 C'])).toBe('JSS 1 A, JSS 1 B, and JSS 1 C');
  });
});
