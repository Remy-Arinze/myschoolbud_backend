import { LoisPendingPlanService } from './lois-pending-plan.service';
import { classLabelMatches, toClientFacingToolData, toModelFacingToolData } from './lois-plan-facing';

describe('classLabelMatches', () => {
  it('matches spaced and compact class names', () => {
    expect(classLabelMatches('JSS 2 A', 'JSS2A')).toBe(true);
    expect(classLabelMatches('JSS 2 A', 'jss 2 a')).toBe(true);
  });

  it('treats a shorter query as a prefix of the label', () => {
    expect(classLabelMatches('JSS 2 A', 'JSS 2')).toBe(true);
    expect(classLabelMatches('JSS 2 A', 'JSS 1')).toBe(false);
  });

  it('does not treat JSS 1 as JSS 10', () => {
    expect(classLabelMatches('JSS 10 A', 'JSS 1')).toBe(false);
    expect(classLabelMatches('JSS 1 B', 'JSS 10')).toBe(false);
  });
});

describe('toModelFacingToolData', () => {
  it('strips planId and other internals from propose_timetable', () => {
    const facing = toModelFacingToolData('propose_timetable', {
      planId: 'cmtvoggw60054j4lbrek0qkzv',
      classId: 'cls-1',
      classArmId: 'arm-1',
      termId: 'term-1',
      classLabel: 'JSS 2 A',
      periodCount: 32,
      saved: false,
      message: 'Proposed timetable for JSS 2 A.',
    }) as Record<string, unknown>;

    expect(facing.planId).toBeUndefined();
    expect(facing.classId).toBeUndefined();
    expect(facing.classArmId).toBeUndefined();
    expect(facing.termId).toBeUndefined();
    expect(facing.classLabel).toBe('JSS 2 A');
    expect(facing.periodCount).toBe(32);
    expect(facing.pending).toBe(true);
    expect(JSON.stringify(facing)).not.toContain('cmtvoggw60054j4lbrek0qkzv');
  });

  it('strips internals from apply_pending_plans if present', () => {
    const facing = toModelFacingToolData('apply_pending_plans', {
      planId: 'should-not-leak',
      applied: [{ classLabel: 'JSS 2 A', message: 'Saved 32 periods for JSS 2 A.' }],
      failed: [],
      message: 'Saved JSS 2 A.',
    }) as Record<string, unknown>;

    expect(facing.planId).toBeUndefined();
    expect(facing.message).toBe('Saved JSS 2 A.');
  });

  it('leaves other tools untouched', () => {
    const data = { classId: 'cls-1', classLabel: 'JSS 2 A' };
    expect(toModelFacingToolData('list_classes', data)).toBe(data);
  });
});

describe('toClientFacingToolData', () => {
  it('strips studentId from guardian payloads but keeps names', () => {
    const facing = toClientFacingToolData({
      studentId: 'cmtl11zov003012kxcdcauwqt',
      studentName: 'Chioma Nnamani',
      className: 'JSS 1 A',
      guardians: [{ name: 'Obinna Nnamani', relationship: 'Father' }],
    }) as Record<string, unknown>;
    expect(facing.studentId).toBeUndefined();
    expect(facing.studentName).toBe('Chioma Nnamani');
    expect(JSON.stringify(facing)).not.toContain('cmtl11zov003012kxcdcauwqt');
  });

  it('keeps planId so Apply still works', () => {
    const facing = toClientFacingToolData({
      planId: 'keep-me',
      classId: 'drop-me',
      classLabel: 'JSS 1 A',
    }) as Record<string, unknown>;
    expect(facing.planId).toBe('keep-me');
    expect(facing.classId).toBeUndefined();
  });
});

describe('LoisPendingPlanService.matchByClassQueries', () => {
  const service = new LoisPendingPlanService({} as any);

  it('matches named class labels on the payload', () => {
    const plans = [
      { payload: { classLabel: 'JSS 2 A' } },
      { payload: { classLabel: 'JSS 2 B' } },
      { payload: { classLabel: 'JSS 1 B' } },
    ];
    const { matched, unmatchedQueries } = service.matchByClassQueries(plans, ['JSS 2 A', 'JSS 2 C']);
    expect(matched.map((p) => (p.payload as { classLabel: string }).classLabel)).toEqual(['JSS 2 A']);
    expect(unmatchedQueries).toEqual(['JSS 2 C']);
  });
});
