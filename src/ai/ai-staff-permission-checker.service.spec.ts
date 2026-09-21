import { AGORA_TOOLS } from './agora-chat-tools.definition';
import { AiStaffPermissionCheckerService } from './ai-staff-permission-checker.service';
import { ForbiddenException } from '@nestjs/common';
import { PermissionResource } from '../schools/dto/permission.dto';

describe('Lois typed tools', () => {
  it('does not expose execute_sql', () => {
    const names = AGORA_TOOLS.map((t) => t.function.name);
    expect(names).not.toContain('execute_sql');
    expect(names).not.toContain('create_period');
    expect(names).toEqual(
      expect.arrayContaining([
        'list_students',
        'list_classes',
        'get_student_overview',
        'get_class_performance',
        'get_scheme_of_work',
        'get_now_in_class',
        'get_timetable',
        'list_staff',
        'who_teaches',
        'get_attendance_summary',
        'list_fee_debtors',
        'list_admissions',
        'get_calendar',
        'get_guardians',
        'list_lois_insights',
        'draft_parent_message',
        'get_academic_risk_summary',
        'inspect_scheduling_context',
        'inspect_curriculum_options',
        'propose_timetable',
        'propose_scheme',
        'apply_pending_plans',
      ]),
    );
  });
});

describe('AiStaffPermissionCheckerService', () => {
  const prisma = {
    schoolAdmin: { findFirst: jest.fn() },
    staffPermission: { findFirst: jest.fn() },
  };

  const checker = new AiStaffPermissionCheckerService(prisma as any);

  // Authority is the tier, not the title. The role string is kept alongside it
  // only to show that it is now inert: Lois would refuse this admin on every
  // tool if it were still matching on "principal".
  const PRINCIPAL_ADMIN = { id: 'a1', role: 'principal', accessTier: 'PRINCIPAL' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks students from school data tools', async () => {
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'list_students',
        userRole: 'STUDENT',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows principals all tools without staff-permission rows', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue(PRINCIPAL_ADMIN);
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'get_student_overview',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).resolves.toBeUndefined();
    expect(prisma.staffPermission.findFirst).not.toHaveBeenCalled();
  });

  it('requires Students read for bursar-like admins on student lookup', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'bursar' });
    prisma.staffPermission.findFirst.mockResolvedValue(null);
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'get_student_overview',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows bursar-like admins with Students READ', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'bursar' });
    prisma.staffPermission.findFirst
      .mockResolvedValueOnce(null) // ADMIN on resource
      .mockResolvedValueOnce({ id: 'p1' }); // READ/WRITE hit
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'list_students',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).resolves.toBeUndefined();
    expect(prisma.staffPermission.findFirst).toHaveBeenCalled();
    void PermissionResource.STUDENTS;
  });

  it('blocks teachers from applying pending plans', async () => {
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'apply_pending_plans',
        userRole: 'TEACHER',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks teachers from proposing timetables', async () => {
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'propose_timetable',
        userRole: 'TEACHER',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks teachers from fee debtors and admissions', async () => {
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'list_fee_debtors',
        userRole: 'TEACHER',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'list_admissions',
        userRole: 'TEACHER',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows school admins to list insights (results are filtered separately)', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'bursar' });
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'list_lois_insights',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).resolves.toBeUndefined();
    expect(prisma.staffPermission.findFirst).not.toHaveBeenCalled();
  });

  it('gives principals every insight type', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue(PRINCIPAL_ADMIN);
    const types = await checker.allowedInsightTypes('u1', 's1', 'SCHOOL_ADMIN');
    expect(types).toEqual(
      expect.arrayContaining(['ACADEMIC_RISK', 'STUDENT_DROP', 'SOW_GAP', 'ATTENDANCE_RISK', 'FEE_ARREARS', 'ADMISSIONS_BACKLOG']),
    );
    expect(prisma.staffPermission.findFirst).not.toHaveBeenCalled();
  });

  it('requires Admissions read for bursar-like admins', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'bursar' });
    prisma.staffPermission.findFirst.mockResolvedValue(null);
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'list_admissions',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('teachers get classroom and pedagogy workers only', async () => {
    const workers = await checker.resolveAllowedWorkers({
      userRole: 'TEACHER',
      userId: 'u1',
      schoolId: 's1',
    });
    expect(workers).toEqual(['classroom', 'pedagogy']);
  });

  it('omits curator (and other desks) for a bursar who can only list fee debtors', async () => {
    const spy = jest.spyOn(checker, 'assertLoisToolAllowed').mockImplementation(async ({ toolName }) => {
      if (toolName === 'list_fee_debtors') return;
      throw new ForbiddenException('no');
    });
    const workers = await checker.resolveAllowedWorkers({
      userRole: 'SCHOOL_ADMIN',
      userId: 'u1',
      schoolId: 's1',
    });
    expect(workers).toEqual(['finance']);
    expect(workers).not.toContain('curator');
    expect(workers).not.toContain('admissions');
    expect(workers).not.toContain('pedagogy');
    spy.mockRestore();
  });

  it('gives principals every admin worker including curator', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue(PRINCIPAL_ADMIN);
    const workers = await checker.resolveAllowedWorkers({
      userRole: 'SCHOOL_ADMIN',
      userId: 'u1',
      schoolId: 's1',
    });
    expect(workers).toEqual(
      expect.arrayContaining(['operations', 'academic', 'finance', 'admissions', 'curator', 'pedagogy']),
    );
  });

  it('requires Timetables/Curriculum write to apply pending plans', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'bursar' });
    prisma.staffPermission.findFirst.mockResolvedValue(null);
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'apply_pending_plans',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not compile academic or curator for an admin with no staff permissions', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'administrator' });
    prisma.staffPermission.findFirst.mockResolvedValue(null);
    const workers = await checker.resolveAllowedWorkers({
      userRole: 'SCHOOL_ADMIN',
      userId: 'u1',
      schoolId: 's1',
    });
    expect(workers).toEqual([]);
  });

  it('denies unknown tools for school admins', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'bursar' });
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'not_a_real_tool',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // The defect the tier exists to close: Lois used to grant everything to
  // anyone whose title happened to normalise to a principal seat.
  it('refuses a staff-tier admin even when their title reads as Principal', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({
      id: 'a1',
      role: 'Head Teacher',
      accessTier: 'STAFF',
    });
    prisma.staffPermission.findFirst.mockResolvedValue(null);
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'get_student_overview',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // And the mirror: a title the old string match missed entirely.
  it('allows a principal-tier admin whose title the old matcher missed', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({
      id: 'a1',
      role: 'Headteacher',
      accessTier: 'PRINCIPAL',
    });
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'get_student_overview',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).resolves.toBeUndefined();
    expect(prisma.staffPermission.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the principal bypass for every named tool', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue(PRINCIPAL_ADMIN);
    await expect(
      checker.assertLoisToolAllowed({
        toolName: 'propose_timetable',
        userRole: 'SCHOOL_ADMIN',
        userId: 'u1',
        schoolId: 's1',
      }),
    ).resolves.toBeUndefined();
    expect(prisma.staffPermission.findFirst).not.toHaveBeenCalled();
  });

  it('attaches only tools that pass the table for a classes-read VP', async () => {
    prisma.schoolAdmin.findFirst.mockResolvedValue({ id: 'a1', role: 'vice_principal' });
    prisma.staffPermission.findFirst.mockImplementation(async ({ where }: { where?: any }) => {
      const resource = where?.permission?.resource;
      const typeFilter = where?.permission?.type;
      const types = typeFilter?.in || (typeFilter ? [typeFilter] : []);
      if (resource === PermissionResource.CLASSES && types.includes('READ')) {
        return { id: 'p1' };
      }
      return null;
    });

    const names = await checker.filterAllowedToolNames({
      toolNames: ['list_classes', 'propose_timetable', 'apply_pending_plans', 'generate_quiz'],
      userRole: 'SCHOOL_ADMIN',
      userId: 'u1',
      schoolId: 's1',
    });
    expect(names).toEqual(['list_classes']);
  });
});
