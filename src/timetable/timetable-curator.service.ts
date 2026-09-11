import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SchoolRepository } from '../schools/domain/repositories/school.repository';
import { SchoolSettingsService } from '../school-settings/school-settings.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { DEFAULT_WORKING_DAYS, WorkingDay } from '../common/utils/instructional-day.util';
import { LOIS_AUTOFILL_PRO_MESSAGE } from './timetable-curator.constants';
import { analyzeTimetableGeneration, solveTimetable } from './timetable-curator.solver';
import { scheduleFromBellTemplates } from './timetable-schedule.util';
import type {
  CuratorAnalysis,
  CuratorApplyMode,
  CuratorDay,
  CuratorGeneratedPeriod,
  CuratorSchoolType,
  CuratorSubject,
  CuratorTeacher,
} from './timetable-curator.types';
import { TimetableService } from './timetable.service';
import { DayOfWeek, PeriodType } from './dto/create-timetable-period.dto';
import {
  resolveSchoolSubjectStream,
  streamFromClassLevel,
  subjectOfferedInStream,
} from '../common/utils/subject-level-stream.util';
import {
  pickUniqueClassQueryMatch,
  rankClassQueryMatches,
} from '../common/utils/class-query.util';

export type CuratePreviewResult = {
  classLabel: string;
  schoolType: CuratorSchoolType;
  classId?: string;
  classArmId?: string;
  classLevelId?: string;
  termId: string;
  hasExistingTimetable: boolean;
  periodCount: number;
  primaryClassTeacher: { id: string; name: string } | null;
  subjects: Array<{ id: string; name: string; teacherCount: number }>;
  subjectsWithoutTeachers: Array<{ id: string; name: string }>;
  periods: CuratorGeneratedPeriod[];
  analysis: CuratorAnalysis;
};

@Injectable()
export class TimetableCuratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly schoolSettings: SchoolSettingsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly timetableService: TimetableService,
  ) {}

  async assertAgoraAiAccess(schoolId: string): Promise<void> {
    const access = await this.subscriptions.checkToolAccess(schoolId, 'agora-ai');
    if (!access.hasAccess) {
      throw new ForbiddenException(LOIS_AUTOFILL_PRO_MESSAGE);
    }
  }

  async preview(
    schoolId: string,
    dto: { termId: string; classId?: string; classArmId?: string; mode?: CuratorApplyMode },
  ): Promise<CuratePreviewResult> {
    await this.assertAgoraAiAccess(schoolId);
    const ctx = await this.loadContext(schoolId, dto);
    const existing = dto.mode === 'REPLACE' ? [] : ctx.existingPeriods;
    const periods = solveTimetable({
      schoolType: ctx.schoolType,
      subjects: ctx.subjects,
      existingPeriods: existing,
      schedule: ctx.schedule,
      workingDays: ctx.workingDays,
      maxPeriodsPerTeacherPerDay: ctx.maxPeriodsPerTeacherPerDay,
      primaryClassTeacher: ctx.primaryClassTeacher,
    });
    const analysis = analyzeTimetableGeneration(periods, {
      requiresTeacherAssignment: ctx.schoolType === 'SECONDARY',
      subjects: ctx.subjects,
    });
    return {
      classLabel: ctx.label,
      schoolType: ctx.schoolType,
      classId: ctx.classId,
      classArmId: ctx.classArmId,
      classLevelId: ctx.classLevelId,
      termId: dto.termId,
      hasExistingTimetable: ctx.existingPeriods.length > 0,
      periodCount: ctx.existingPeriods.length,
      primaryClassTeacher: ctx.primaryClassTeacher
        ? {
            id: ctx.primaryClassTeacher.id,
            name: `${ctx.primaryClassTeacher.firstName} ${ctx.primaryClassTeacher.lastName}`.trim(),
          }
        : null,
      subjects: ctx.subjects.map((s) => ({
        id: s.id,
        name: s.name,
        teacherCount: s.teachers?.length || 0,
      })),
      subjectsWithoutTeachers: ctx.subjects
        .filter((s) => ctx.schoolType === 'SECONDARY' && (!s.teachers || s.teachers.length === 0))
        .map((s) => ({ id: s.id, name: s.name })),
      periods,
      analysis,
    };
  }

  async apply(
    schoolId: string,
    dto: {
      termId: string;
      classId?: string;
      classArmId?: string;
      mode?: CuratorApplyMode;
      periods?: Array<{
        dayOfWeek: string;
        startTime: string;
        endTime: string;
        type?: string;
        subjectId?: string;
        courseId?: string;
        teacherId?: string;
      }>;
    },
  ): Promise<{ replaced: number; preview: CuratePreviewResult }> {
    await this.assertAgoraAiAccess(schoolId);
    const preview = dto.periods?.length
      ? await this.previewFromProvided(schoolId, dto)
      : await this.preview(schoolId, dto);

    const periods = (dto.periods?.length ? dto.periods : preview.periods).map((p) => ({
      dayOfWeek: p.dayOfWeek as DayOfWeek,
      startTime: p.startTime,
      endTime: p.endTime,
      type: ((p.type as PeriodType) || PeriodType.LESSON) as PeriodType,
      subjectId: p.subjectId,
      courseId: p.courseId,
      teacherId: p.teacherId,
    }));

    const replaced = await this.timetableService.replaceTimetable(schoolId, {
      termId: dto.termId,
      classId: preview.classId,
      classArmId: preview.classArmId,
      periods,
    });

    return { replaced: replaced.replaced, preview };
  }

  async inspect(
    schoolId: string,
    dto: { termId?: string; classId?: string; classArmId?: string; classQuery?: string },
  ) {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) throw new BadRequestException('School not found');

    const term = await this.resolveTermId(schoolId, dto.termId);
    if ('error' in term) return term;
    const termId = term.termId;

    const resolved = await this.resolveClass(schoolId, dto);
    if ('error' in resolved) return resolved;

    const ctx = await this.loadContext(schoolId, { termId, classId: resolved.classId, classArmId: resolved.classArmId });
    const schemeCounts = await this.schemePresence(schoolId, ctx.classLevelId, termId, ctx.subjects.map((s) => s.id));

    return {
      classLabel: ctx.label,
      schoolType: ctx.schoolType,
      classId: ctx.classId,
      classArmId: ctx.classArmId,
      classLevelId: ctx.classLevelId,
      termId,
      hasExistingTimetable: ctx.existingPeriods.length > 0,
      periodCount: ctx.existingPeriods.filter((p) => p.subjectId || p.courseId).length,
      workingDays: ctx.workingDays,
      lessonSlotsPerDay: ctx.schedule.filter((p) => p.type === 'LESSON').length,
      primaryClassTeacher: ctx.primaryClassTeacher
        ? {
            id: ctx.primaryClassTeacher.id,
            name: `${ctx.primaryClassTeacher.firstName} ${ctx.primaryClassTeacher.lastName}`.trim(),
          }
        : null,
      subjects: ctx.subjects.map((s) => ({
        id: s.id,
        name: s.name,
        teacherCount: s.teachers?.length || 0,
        teachers: (s.teachers || []).map((t) => ({
          id: t.id,
          name: `${t.firstName} ${t.lastName}`.trim(),
          periodCount: t.periodCount || 0,
        })),
        hasScheme: schemeCounts.has(s.id),
      })),
      subjectsOnGrid: [
        ...new Map(
          ctx.existingPeriods
            .filter((p) => p.subjectId)
            .map((p) => [p.subjectId!, { id: p.subjectId!, name: p.subjectName || p.subjectId! }]),
        ).values(),
      ],
      subjectsWithoutTeachers: ctx.subjects
        .filter((s) => ctx.schoolType === 'SECONDARY' && (!s.teachers || s.teachers.length === 0))
        .map((s) => ({ id: s.id, name: s.name })),
      note:
        ctx.existingPeriods.length > 0
          ? 'A timetable already exists. Propose will fill empty slots only unless mode is REPLACE.'
          : 'No timetable for this class this term.',
    };
  }

  private async previewFromProvided(
    schoolId: string,
    dto: {
      termId: string;
      classId?: string;
      classArmId?: string;
      periods?: Array<{
        dayOfWeek: string;
        startTime: string;
        endTime: string;
        type?: string;
        subjectId?: string;
        courseId?: string;
        teacherId?: string;
      }>;
    },
  ): Promise<CuratePreviewResult> {
    const preview = await this.preview(schoolId, dto);
    if (dto.periods?.length) {
      preview.periods = dto.periods.map((p) => ({
        dayOfWeek: p.dayOfWeek as CuratorDay,
        startTime: p.startTime,
        endTime: p.endTime,
        type: (p.type as CuratorGeneratedPeriod['type']) || 'LESSON',
        subjectId: p.subjectId,
        courseId: p.courseId,
        teacherId: p.teacherId,
      }));
      preview.analysis = analyzeTimetableGeneration(preview.periods, {
        requiresTeacherAssignment: preview.schoolType === 'SECONDARY',
        subjects: (await this.loadContext(schoolId, dto)).subjects,
      });
    }
    return preview;
  }

  private async schemePresence(
    schoolId: string,
    classLevelId: string | undefined,
    termId: string,
    subjectIds: string[],
  ): Promise<Set<string>> {
    if (!classLevelId || subjectIds.length === 0) return new Set();
    const rows = await (this.prisma as any).schemeOfWork.findMany({
      where: {
        schoolId,
        classLevelId,
        termId,
        subjectId: { in: subjectIds },
        status: { in: ['DRAFT', 'APPROVED', 'PUBLISHED', 'GENERATING', 'QUEUED'] },
      },
      select: { subjectId: true },
    });
    return new Set(rows.map((r: { subjectId: string }) => r.subjectId));
  }

  private async resolveClass(
    schoolId: string,
    dto: { classId?: string; classArmId?: string; classQuery?: string },
  ): Promise<
    | { classId?: string; classArmId?: string; classLevelId?: string; label: string; type: CuratorSchoolType }
    | { error: string; matches?: Array<{ label: string; classId?: string; classArmId?: string }> }
  > {
    if (dto.classArmId) {
      const arm = await this.prisma.classArm.findFirst({
        where: { id: dto.classArmId, classLevel: { schoolId } },
        select: { id: true, name: true, classLevel: { select: { id: true, name: true, type: true } } },
      });
      if (!arm) return { error: 'Class arm not found in this school.' };
      return {
        classArmId: arm.id,
        classLevelId: arm.classLevel.id,
        label: `${arm.classLevel.name} ${arm.name}`.trim(),
        type: arm.classLevel.type as CuratorSchoolType,
      };
    }
    if (dto.classId) {
      const arm = await this.prisma.classArm.findFirst({
        where: { id: dto.classId, classLevel: { schoolId } },
        select: { id: true, name: true, classLevel: { select: { id: true, name: true, type: true } } },
      });
      if (arm) {
        return {
          classArmId: arm.id,
          classLevelId: arm.classLevel.id,
          label: `${arm.classLevel.name} ${arm.name}`.trim(),
          type: arm.classLevel.type as CuratorSchoolType,
        };
      }
      const klass = await this.prisma.class.findFirst({
        where: { id: dto.classId, schoolId },
        select: { id: true, name: true, type: true, classLevel: true },
      });
      if (!klass) return { error: 'Class not found in this school.' };
      const level = klass.classLevel
        ? await this.prisma.classLevel.findFirst({
            where: { schoolId, name: { equals: klass.classLevel, mode: 'insensitive' } },
            select: { id: true },
          })
        : null;
      return {
        classId: klass.id,
        classLevelId: level?.id,
        label: klass.name,
        type: (klass.type as CuratorSchoolType) || 'SECONDARY',
      };
    }
    const query = dto.classQuery?.trim();
    if (!query) return { error: 'classId, classArmId, or classQuery is required.' };

    const arms = await this.prisma.classArm.findMany({
      where: { isActive: true, classLevel: { schoolId, isActive: true } },
      take: 80,
      select: { id: true, name: true, classLevel: { select: { id: true, name: true, type: true } } },
    });
    const rankedArms = rankClassQueryMatches(
      arms,
      query,
      (arm) => `${arm.classLevel.name} ${arm.name}`.trim(),
      (arm) => arm.classLevel.name,
    );
    const uniqueArm = pickUniqueClassQueryMatch(rankedArms);
    if (uniqueArm) {
      return {
        classArmId: uniqueArm.id,
        classLevelId: uniqueArm.classLevel.id,
        label: `${uniqueArm.classLevel.name} ${uniqueArm.name}`.trim(),
        type: uniqueArm.classLevel.type as CuratorSchoolType,
      };
    }
    if (rankedArms.length > 1) {
      return {
        error: `Several classes matched "${query}". Pass classArmId from list_classes.`,
        matches: rankedArms.slice(0, 8).map((row) => ({
          label: `${row.item.classLevel.name} ${row.item.name}`.trim(),
          classArmId: row.item.id,
        })),
      };
    }

    const classes = await this.prisma.class.findMany({
      where: { schoolId, isActive: true },
      take: 40,
      select: { id: true, name: true, type: true, classLevel: true },
    });
    const rankedClasses = rankClassQueryMatches(
      classes,
      query,
      (c) => c.name,
      (c) => c.classLevel || c.name,
    );
    const uniqueClass = pickUniqueClassQueryMatch(rankedClasses);
    if (uniqueClass) {
      return {
        classId: uniqueClass.id,
        label: uniqueClass.name,
        type: (uniqueClass.type as CuratorSchoolType) || 'SECONDARY',
      };
    }
    if (rankedClasses.length > 1) {
      return {
        error: `Several classes matched "${query}".`,
        matches: rankedClasses.slice(0, 8).map((row) => ({
          label: row.item.name,
          classId: row.item.id,
        })),
      };
    }
    return { error: `No class matched "${query}".` };
  }

  private async loadContext(
    schoolId: string,
    dto: { termId: string; classId?: string; classArmId?: string },
  ): Promise<{
    label: string;
    schoolType: CuratorSchoolType;
    classId?: string;
    classArmId?: string;
    classLevelId?: string;
    workingDays: CuratorDay[];
    schedule: ReturnType<typeof scheduleFromBellTemplates>;
    maxPeriodsPerTeacherPerDay: number;
    subjects: CuratorSubject[];
    existingPeriods: CuratorGeneratedPeriod[];
    primaryClassTeacher: CuratorTeacher | null;
  }> {
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) throw new BadRequestException('School not found');

    const term = await this.prisma.term.findUnique({
      where: { id: dto.termId },
      include: { academicSession: true },
    });
    if (!term || term.academicSession.schoolId !== school.id) {
      throw new NotFoundException('Term not found');
    }

    const resolved = await this.resolveClass(schoolId, dto);
    if ('error' in resolved) {
      throw new BadRequestException(resolved.error);
    }

    const settings = await this.schoolSettings.getAllSettings(schoolId);
    const workingDays = (
      settings.workingDays?.length ? settings.workingDays : DEFAULT_WORKING_DAYS
    ) as WorkingDay[];
    const schoolType = resolved.type;
    const schedule = scheduleFromBellTemplates(
      schoolType,
      settings.bellScheduleTemplates as Array<{ schoolType: string; periods: unknown; isDefault?: boolean }>,
    );
    const maxPeriodsPerTeacherPerDay = settings.timetablePolicy?.maxPeriodsPerTeacherPerDay ?? 6;

    const subjects = await this.loadSubjects(schoolId, schoolType, resolved.classLevelId, dto.termId);
    if (subjects.length === 0) {
      throw new BadRequestException(
        'No subjects are available for this class. Add subjects before Auto-Fill.',
      );
    }

    const existingWhere: any = { termId: dto.termId };
    if (resolved.classArmId) existingWhere.classArmId = resolved.classArmId;
    else existingWhere.classId = resolved.classId;

    const existingRows = await this.prisma.timetablePeriod.findMany({
      where: existingWhere,
      include: {
        subject: { select: { id: true, name: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    const existingPeriods: CuratorGeneratedPeriod[] = existingRows.map((p) => ({
      dayOfWeek: p.dayOfWeek as CuratorDay,
      startTime: p.startTime,
      endTime: p.endTime,
      type: (p.type as CuratorGeneratedPeriod['type']) || 'LESSON',
      subjectId: p.subjectId || undefined,
      subjectName: p.subject?.name || undefined,
      courseId: p.courseId || undefined,
      teacherId: p.teacherId || undefined,
      teacherName: p.teacher ? `${p.teacher.firstName} ${p.teacher.lastName}`.trim() : undefined,
    }));

    let primaryClassTeacher: CuratorTeacher | null = null;
    if (schoolType === 'PRIMARY') {
      if (resolved.classArmId) {
        const arm = await this.prisma.classArm.findUnique({
          where: { id: resolved.classArmId },
          select: { classTeacher: { select: { id: true, firstName: true, lastName: true } } },
        });
        if (arm?.classTeacher) {
          primaryClassTeacher = arm.classTeacher;
        }
      }
      if (!primaryClassTeacher) {
        const ct = await this.prisma.classTeacher.findFirst({
          where: {
            teacher: { schoolId },
            ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
            ...(resolved.classId ? { classId: resolved.classId } : {}),
            OR: [{ isPrimary: true }, { isFormTeacher: true }],
          },
          orderBy: { isPrimary: 'desc' },
          select: { teacher: { select: { id: true, firstName: true, lastName: true } } },
        });
        if (ct?.teacher) {
          primaryClassTeacher = {
            id: ct.teacher.id,
            firstName: ct.teacher.firstName,
            lastName: ct.teacher.lastName,
          };
        }
      }
    }

    return {
      label: resolved.label,
      schoolType,
      classId: resolved.classId,
      classArmId: resolved.classArmId,
      classLevelId: resolved.classLevelId,
      workingDays: workingDays as CuratorDay[],
      schedule,
      maxPeriodsPerTeacherPerDay,
      subjects,
      existingPeriods,
      primaryClassTeacher,
    };
  }

  private async loadSubjects(
    schoolId: string,
    schoolType: CuratorSchoolType,
    classLevelId: string | undefined,
    termId: string,
  ): Promise<CuratorSubject[]> {
    const where: any = {
      schoolId,
      isActive: true,
      OR: [{ schoolType }, { schoolType: null }],
    };
    if (classLevelId) {
      where.AND = [{ OR: [{ classLevelId }, { classLevelId: null }] }];
    }
    const rows = await this.prisma.subject.findMany({
      where,
      include: {
        classLevel: { select: { code: true, name: true } },
        agoraSubject: { select: { levelStreams: true } },
        subjectTeachers: {
          include: { teacher: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    let filtered = rows;
    if (classLevelId && schoolType === 'SECONDARY') {
      const classLevel = await this.prisma.classLevel.findUnique({
        where: { id: classLevelId },
        select: { code: true, name: true },
      });
      const targetStream = streamFromClassLevel({
        code: classLevel?.code,
        name: classLevel?.name,
      });
      if (targetStream) {
        filtered = rows.filter((s) => {
          const inferred = resolveSchoolSubjectStream({
            agoraLevelStreams: s.agoraSubject?.levelStreams,
            levelStream: s.levelStream,
            classLevelCode: s.classLevel?.code,
            classLevelName: s.classLevel?.name,
            code: s.code,
          });
          return subjectOfferedInStream(inferred, targetStream);
        });
      }
    }

    const teacherIds = [
      ...new Set(filtered.flatMap((s) => s.subjectTeachers.map((st) => st.teacher.id))),
    ];
    const periodCountMap = new Map<string, number>();
    if (teacherIds.length > 0 && schoolType === 'SECONDARY') {
      const counts = await this.prisma.timetablePeriod.groupBy({
        by: ['teacherId'],
        where: { termId, teacherId: { in: teacherIds } },
        _count: { id: true },
      });
      counts.forEach((c) => {
        if (c.teacherId) periodCountMap.set(c.teacherId, c._count.id);
      });
    }

    const weekCounts = new Map<string, number>();
    if (classLevelId) {
      const schemes = await (this.prisma as any).schemeOfWork.findMany({
        where: {
          schoolId,
          classLevelId,
          termId,
          subjectId: { in: filtered.map((s) => s.id) },
          status: { in: ['DRAFT', 'APPROVED', 'PUBLISHED', 'GENERATING'] },
        },
        select: { subjectId: true, _count: { select: { weeks: true } } },
      });
      schemes.forEach((s: { subjectId: string; _count: { weeks: number } }) => {
        weekCounts.set(s.subjectId, s._count.weeks);
      });
    }

    return filtered.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code || undefined,
      weight: weekCounts.get(s.id) ? Math.max(2, weekCounts.get(s.id)!) : undefined,
      teachers: s.subjectTeachers.map((st) => ({
        id: st.teacher.id,
        firstName: st.teacher.firstName,
        lastName: st.teacher.lastName,
        periodCount: periodCountMap.get(st.teacher.id) || 0,
      })),
    }));
  }

  /**
   * Use a requested term only if it belongs to this school; otherwise the active term.
   * Invented or stale ids from the model must not fail generate.
   */
  async resolveTermId(
    schoolId: string,
    requested?: string,
  ): Promise<{ termId: string } | { error: string }> {
    if (requested) {
      const match = await this.prisma.term.findFirst({
        where: { id: requested, academicSession: { schoolId } },
        select: { id: true },
      });
      if (match) return { termId: match.id };
    }
    const session = await this.prisma.academicSession.findFirst({
      where: { schoolId, status: 'ACTIVE' },
      orderBy: { startDate: 'desc' },
      select: { terms: { where: { status: 'ACTIVE' }, take: 1, select: { id: true } } },
    });
    const termId = session?.terms[0]?.id;
    if (!termId) {
      return { error: 'No active term. Create a session and term first.' };
    }
    return { termId };
  }
}
