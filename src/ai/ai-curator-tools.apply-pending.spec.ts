import { ForbiddenException } from '@nestjs/common';
import { AiCuratorToolsService } from './ai-curator-tools.service';

describe('AiCuratorToolsService.applyPendingPlans', () => {
  const plans = {
    listActive: jest.fn(),
    matchByClassQueries: jest.fn(),
    getActive: jest.fn(),
    markApplied: jest.fn(),
  };
  const curator = {
    apply: jest.fn(),
    assertAgoraAiAccess: jest.fn(),
  };
  const staffPermissions = {
    assertLoisPlanWrite: jest.fn(),
  };
  const prisma = {
    user: { findUnique: jest.fn() },
    classLevel: { findFirst: jest.fn() },
    subject: { findFirst: jest.fn() },
  };

  const service = new AiCuratorToolsService(
    prisma as any,
    curator as any,
    plans as any,
    staffPermissions as any,
    { get: jest.fn() } as any,
  );

  const context = {
    schoolId: 'school-1',
    userId: 'user-1',
    userRole: 'SCHOOL_ADMIN',
    conversationId: 'conv-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    staffPermissions.assertLoisPlanWrite.mockResolvedValue(undefined);
  });

  it('applies all pending timetables in the conversation and returns class names only', async () => {
    plans.listActive.mockResolvedValue([
      { id: 'p1', kind: 'TIMETABLE', payload: { classLabel: 'JSS 2 A', termId: 't1' } },
      { id: 'p2', kind: 'TIMETABLE', payload: { classLabel: 'JSS 2 B', termId: 't1' } },
    ]);
    const applySpy = jest.spyOn(service, 'applyPlan').mockImplementation(async (_id, _ctx) => ({
      kind: 'TIMETABLE',
      classLabel: _id === 'p1' ? 'JSS 2 A' : 'JSS 2 B',
      message: `Saved 32 periods for ${_id === 'p1' ? 'JSS 2 A' : 'JSS 2 B'}.`,
    }));

    const result = await service.applyPendingPlans({ scope: 'ALL_PENDING' }, context);

    expect(plans.listActive).toHaveBeenCalledWith({
      userId: 'user-1',
      schoolId: 'school-1',
      conversationId: 'conv-1',
      kind: 'TIMETABLE',
    });
    expect(result.data.applied).toEqual([
      { classLabel: 'JSS 2 A', message: 'Saved 32 periods for JSS 2 A.' },
      { classLabel: 'JSS 2 B', message: 'Saved 32 periods for JSS 2 B.' },
    ]);
    expect(JSON.stringify(result.data)).not.toMatch(/p1|p2|planId/);
    expect(result.data.message).toBe('Saved JSS 2 A, JSS 2 B.');
    applySpy.mockRestore();
  });

  it('defaults to timetables and does not list schemes', async () => {
    plans.listActive.mockResolvedValue([]);
    const result = await service.applyPendingPlans({}, context);
    expect(plans.listActive).toHaveBeenCalledWith(expect.objectContaining({ kind: 'TIMETABLE' }));
    expect(result.data.message).toContain('no pending timetables');
  });

  it('reports permission failures by class name', async () => {
    plans.listActive.mockResolvedValue([
      { id: 'p1', kind: 'TIMETABLE', payload: { classLabel: 'JSS 2 A' } },
    ]);
    staffPermissions.assertLoisPlanWrite.mockRejectedValue(
      new ForbiddenException('You need Timetables (write) access to apply this timetable.'),
    );

    const result = await service.applyPendingPlans({ scope: 'ALL_PENDING' }, context);

    expect(result.data.applied).toEqual([]);
    expect(result.data.failed[0].classLabel).toBe('JSS 2 A');
    expect(result.data.failed[0].error).toContain('Timetables (write)');
    expect(JSON.stringify(result.data)).not.toContain('p1');
  });
});

describe('AiCuratorToolsService.proposeTimetable term resolution', () => {
  const plans = { create: jest.fn() };
  const curator = {
    resolveTermId: jest.fn(),
    inspect: jest.fn(),
    preview: jest.fn(),
  };
  const service = new AiCuratorToolsService(
    { user: { findUnique: jest.fn() } } as any,
    curator as any,
    plans as any,
    { assertLoisPlanWrite: jest.fn() } as any,
    { get: jest.fn() } as any,
  );
  const context = { schoolId: 'school-1', userId: 'user-1', conversationId: 'conv-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    curator.resolveTermId.mockResolvedValue({ termId: 'active-term' });
    curator.preview.mockResolvedValue({
      termId: 'active-term',
      classId: 'cls-1',
      classArmId: 'arm-1',
      classLabel: 'JSS 2 A',
      hasExistingTimetable: false,
      analysis: { totalPeriods: 32, freePeriods: 4, warnings: [] },
      subjectsWithoutTeachers: [],
      primaryClassTeacher: null,
      periods: [{}, {}],
    });
    plans.create.mockResolvedValue({ id: 'plan-1', expiresAt: new Date() });
  });

  it('ignores an invented termId and previews with the school active term', async () => {
    const result = await service.proposeTimetable(
      { classArmId: 'arm-1', termId: 'invented-cuid' },
      context,
    );

    expect(curator.resolveTermId).toHaveBeenCalledWith('school-1', 'invented-cuid');
    expect(curator.preview).toHaveBeenCalledWith(
      'school-1',
      expect.objectContaining({ termId: 'active-term', classArmId: 'arm-1' }),
    );
    expect(result.data.classLabel).toBe('JSS 2 A');
    expect(result.data.error).toBeUndefined();
  });

  it('retries with the active term when preview says term not found', async () => {
    curator.preview
      .mockRejectedValueOnce(new Error('Term not found'))
      .mockResolvedValueOnce({
        termId: 'active-term',
        classArmId: 'arm-1',
        classLabel: 'JSS 1 B',
        hasExistingTimetable: false,
        analysis: { totalPeriods: 30, freePeriods: 2, warnings: [] },
        subjectsWithoutTeachers: [],
        primaryClassTeacher: null,
        periods: [{}],
      });

    const result = await service.proposeTimetable({ classArmId: 'arm-1', termId: 'stale' }, context);

    expect(curator.resolveTermId).toHaveBeenCalledWith('school-1');
    expect(result.data.classLabel).toBe('JSS 1 B');
    expect(JSON.stringify(result.data)).not.toMatch(/Term not found/i);
  });
});
