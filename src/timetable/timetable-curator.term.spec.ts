import { TimetableCuratorService } from './timetable-curator.service';

describe('TimetableCuratorService.resolveTermId', () => {
  const prisma = {
    term: { findFirst: jest.fn() },
    academicSession: { findFirst: jest.fn() },
  };
  const service = new TimetableCuratorService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps a requested term that belongs to the school', async () => {
    prisma.term.findFirst.mockResolvedValue({ id: 'term-ok' });
    await expect(service.resolveTermId('school-1', 'term-ok')).resolves.toEqual({ termId: 'term-ok' });
    expect(prisma.academicSession.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to the active term when the requested id is unknown', async () => {
    prisma.term.findFirst.mockResolvedValue(null);
    prisma.academicSession.findFirst.mockResolvedValue({ terms: [{ id: 'active-term' }] });
    await expect(service.resolveTermId('school-1', 'invented-cuid')).resolves.toEqual({
      termId: 'active-term',
    });
  });

  it('returns a human error when there is no active term', async () => {
    prisma.term.findFirst.mockResolvedValue(null);
    prisma.academicSession.findFirst.mockResolvedValue(null);
    await expect(service.resolveTermId('school-1', 'stale')).resolves.toEqual({
      error: 'No active term. Create a session and term first.',
    });
  });
});
