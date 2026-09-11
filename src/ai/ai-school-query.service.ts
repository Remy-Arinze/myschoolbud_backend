import { ForbiddenException, Injectable } from '@nestjs/common';
import { AdmissionStatus, DayOfWeek, EventType, Prisma, SchemeOfWorkStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AgentToolContext, AgentToolResult, toolSource } from './ai-lois-source';
import {
  keepBestClassQueryMatches,
  normalizeClassQueryKey,
  scoreClassQueryMatch,
} from '../common/utils/class-query.util';
import { AiSchoolInsightsService, TeacherRagAccess } from './ai-school-insights.service';
import { extractNamedCalendarDates, resolveCalendarWindow } from './lois-calendar-range';
import { personNameWhere } from './person-name-filter';

const MAX_LIST = 25;

/**
 * Permissioned, typed school reads for Lois. Replaces model-authored SQL.
 */
@Injectable()
export class AiSchoolQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolInsights: AiSchoolInsightsService,
  ) {}

  async listStudents(
    args: { query?: string; classId?: string; classArmId?: string; classQuery?: string; limit?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const limit = this.clamp(args.limit ?? 15, 1, MAX_LIST);
    const access = await this.teacherAccess(context, schoolId);

    const resolved = await this.resolveClassArgs(schoolId, args, { required: false });
    if (resolved.error) return resolved.error;

    const name = args.query?.trim();
    const nameWhere = name ? personNameWhere(name, { middleName: true }) : {};
    const where: Prisma.EnrollmentWhereInput = {
      schoolId,
      isActive: true,
      ...(resolved.classId ? { classId: resolved.classId } : {}),
      ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
      ...(resolved.classLevelId && !resolved.classArmId && !resolved.classId
        ? { classArm: { classLevelId: resolved.classLevelId } }
        : {}),
      ...(access ? { studentId: { in: [...access.studentIds] } } : {}),
      ...(name ? { student: nameWhere as Prisma.StudentWhereInput } : {}),
    };

    if (access && access.studentIds.size === 0) {
      return {
        data: { students: [], count: 0, message: 'No students in your assigned classes.' },
        usage: null,
        sources: [toolSource('list_students', 'Your class roster')],
      };
    }

    const rows = await this.prisma.enrollment.findMany({
      where,
      take: limit,
      orderBy: { student: { lastName: 'asc' } },
      select: {
        studentId: true,
        classLevel: true,
        class: { select: { id: true, name: true } },
        classArm: { select: { id: true, name: true, classLevel: { select: { name: true } } } },
        student: { select: { firstName: true, lastName: true, uid: true } },
      },
    });

    const students = rows.map((e) => ({
      studentId: e.studentId,
      name: `${e.student.firstName} ${e.student.lastName}`.trim(),
      admissionNumber: e.student.uid,
      className: this.classLabel(e),
    }));

    const personLookup =
      Boolean(name) && !args.classId && !args.classArmId && !args.classQuery && !resolved.classLevelId;
    let staffMatches: {
      kind: 'teacher' | 'admin';
      id: string;
      name: string;
      role?: string;
      subjects?: string[];
      assignments?: {
        className: string;
        formTeacher: boolean;
        classId?: string | null;
        classArmId?: string | null;
      }[];
    }[] = [];
    if (name && personLookup && students.length === 0) {
      const staffWhere = personNameWhere(name) as Prisma.TeacherWhereInput;
      const adminWhere = personNameWhere(name) as Prisma.SchoolAdminWhereInput;
      const isAdmin = context?.userRole === 'SCHOOL_ADMIN' || context?.userRole === 'SUPER_ADMIN';
      const [teachers, admins] = await Promise.all([
        this.prisma.teacher.findMany({
          where: { schoolId, ...staffWhere },
          take: 8,
          orderBy: { lastName: 'asc' },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            subject: true,
            subjectTeachers: { select: { subject: { select: { name: true } } }, take: 6 },
            classTeachers: {
              take: 8,
              select: {
                isPrimary: true,
                isFormTeacher: true,
                classId: true,
                classArmId: true,
                class: { select: { name: true } },
                classArm: { select: { name: true, classLevel: { select: { name: true } } } },
              },
            },
          },
        }),
        isAdmin
          ? this.prisma.schoolAdmin.findMany({
              where: { schoolId, ...adminWhere },
              take: 5,
              orderBy: { lastName: 'asc' },
              select: { id: true, firstName: true, lastName: true, role: true },
            })
          : Promise.resolve([]),
      ]);
      staffMatches = [
        ...teachers.map((t) => ({
          kind: 'teacher' as const,
          id: t.id,
          name: `${t.firstName} ${t.lastName}`.trim(),
          subjects: [
            ...new Set(
              [t.subject, ...t.subjectTeachers.map((s) => s.subject.name)].filter(Boolean) as string[],
            ),
          ],
          assignments: t.classTeachers.map((ct) => ({
            className: ct.class?.name || this.classLabel({ classArm: ct.classArm }),
            formTeacher: ct.isPrimary || ct.isFormTeacher,
            classId: ct.classId,
            classArmId: ct.classArmId,
          })),
        })),
        ...admins.map((a) => ({
          kind: 'admin' as const,
          id: a.id,
          name: `${a.firstName} ${a.lastName}`.trim(),
          role: a.role,
        })),
      ];
    }

    const teacherClasses = await this.loadTeacherClassRosters(
      schoolId,
      staffMatches
        .filter((s) => s.kind === 'teacher')
        .map((s) => ({ id: s.id, name: s.name, assignments: s.assignments })),
      access,
      limit,
    );

    const message =
      students.length === 0 && staffMatches.length > 0
        ? teacherClasses.some((c) => c.students.length > 0)
          ? 'No enrolled student matched that name. staffMatches is the teacher; teacherClasses lists the students in their class — name those students.'
          : 'No enrolled student matched that name. These staff members matched — they are not students.'
        : students.length === 0 && name
          ? 'No enrolled student matched that name. If this might be a teacher or admin, call list_staff with the same query.'
          : undefined;

    const namedRosterCount = teacherClasses.reduce((n, c) => n + c.students.length, 0);

    return {
      data: {
        count: students.length,
        students,
        ...(staffMatches.length ? { staffMatches } : {}),
        ...(teacherClasses.length ? { teacherClasses } : {}),
        message,
      },
      usage: null,
      sources: [
        toolSource(
          'list_students',
          namedRosterCount
            ? `${staffMatches.length} staff; ${namedRosterCount} student${namedRosterCount === 1 ? '' : 's'} in their class`
            : staffMatches.length
              ? `No student; ${staffMatches.length} staff match${staffMatches.length === 1 ? '' : 'es'}`
              : `${students.length} enrolled student${students.length === 1 ? '' : 's'}`,
          staffMatches.length ? '/dashboard/school/staff' : '/dashboard/school/students',
        ),
      ],
    };
  }

  async getStudentOverview(
    args: { studentId?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    if (!args.studentId) {
      return { data: { error: 'studentId is required.' }, usage: null };
    }

    const enrollment = await this.prisma.enrollment.findFirst({
      where: { schoolId, studentId: args.studentId, isActive: true },
      orderBy: { enrollmentDate: 'desc' },
      select: {
        id: true,
        studentId: true,
        classId: true,
        classArmId: true,
        classLevel: true,
        class: { select: { id: true, name: true } },
        classArm: { select: { id: true, name: true, classLevel: { select: { name: true } } } },
        student: { select: { firstName: true, lastName: true, uid: true } },
      },
    });

    if (!enrollment) {
      return { data: { error: 'Student not found in this school, or not actively enrolled.' }, usage: null };
    }

    await this.assertStudentVisible(enrollment.studentId, context, schoolId);

    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    const since = new Date();
    since.setDate(since.getDate() - 14);

    const [grades, attendance] = await Promise.all([
      this.prisma.grade.findMany({
        where: {
          enrollmentId: enrollment.id,
          isPublished: true,
          ...(termId ? { termId } : {}),
        },
        orderBy: { signedAt: 'desc' },
        take: 8,
        select: {
          subject: true,
          gradeType: true,
          score: true,
          maxScore: true,
          assessmentName: true,
          signedAt: true,
        },
      }),
      this.prisma.attendance.groupBy({
        by: ['status'],
        where: { enrollmentId: enrollment.id, date: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const name = `${enrollment.student.firstName} ${enrollment.student.lastName}`.trim();
    const recentGrades = grades.map((g) => {
      const max = Number(g.maxScore) || 0;
      const score = Number(g.score) || 0;
      const pct = max > 0 ? Math.round((score / max) * 1000) / 10 : 0;
      return {
        subject: g.subject,
        type: g.gradeType,
        assessment: g.assessmentName,
        score,
        maxScore: max,
        percent: pct,
        date: g.signedAt.toISOString().slice(0, 10),
      };
    });

    const att: Record<string, number> = {};
    for (const row of attendance) {
      att[row.status] = row._count._all;
    }

    const href = `/dashboard/school/students/${enrollment.studentId}`;
    return {
      data: {
        studentId: enrollment.studentId,
        name,
        admissionNumber: enrollment.student.uid,
        className: this.classLabel(enrollment),
        recentPublishedGrades: recentGrades,
        attendanceLast14Days: {
          present: att.PRESENT ?? 0,
          absent: att.ABSENT ?? 0,
          late: att.LATE ?? 0,
        },
      },
      usage: null,
      sources: [toolSource('get_student_overview', `${name} · published grades`, href)],
    };
  }

  async getClassPerformance(
    args: { classId?: string; classArmId?: string; classQuery?: string; thresholdPercent?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const resolved = await this.resolveClassArgs(schoolId, args, { required: true });
    if (resolved.error) return resolved.error;

    await this.assertClassVisible(resolved.classId, resolved.classArmId, context, schoolId);

    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    const threshold = args.thresholdPercent ?? 45;
    const access = await this.teacherAccess(context, schoolId);

    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        schoolId,
        isActive: true,
        ...(resolved.classId ? { classId: resolved.classId } : {}),
        ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
        ...(resolved.classLevelId && !resolved.classArmId && !resolved.classId
          ? { classArm: { classLevelId: resolved.classLevelId } }
          : {}),
        ...(access ? { studentId: { in: [...access.studentIds] } } : {}),
      },
      select: { studentId: true },
    });
    const studentIds = enrollments.map((e) => e.studentId);
    if (studentIds.length === 0) {
      return { data: { studentCount: 0, averages: [], belowThreshold: 0 }, usage: null };
    }

    const students = await this.schoolInsights.findAtRiskStudents(schoolId, {
      termId,
      thresholdPercent: threshold,
      limit: 50,
      studentIdFilter: new Set(studentIds),
      useActiveTermWhenMissing: false,
    });

    const avgRows = await this.prisma.$queryRaw<
      { subject: string; avgPercent: number; gradeCount: number }[]
    >`
      SELECT
        g.subject AS subject,
        (AVG((g."score"::numeric / NULLIF(g."maxScore", 0)::numeric) * 100))::float AS "avgPercent",
        COUNT(g."id")::int AS "gradeCount"
      FROM "Grade" g
      INNER JOIN "Enrollment" e ON e."id" = g."enrollmentId"
      WHERE e."schoolId" = ${schoolId}
        AND e."isActive" = true
        AND g."isPublished" = true
        AND COALESCE(g."maxScore", 0) > 0
        ${termId ? Prisma.sql`AND g."termId" = ${termId}` : Prisma.empty}
        ${resolved.classId ? Prisma.sql`AND e."classId" = ${resolved.classId}` : Prisma.empty}
        ${resolved.classArmId ? Prisma.sql`AND e."classArmId" = ${resolved.classArmId}` : Prisma.empty}
        ${
          resolved.classLevelId && !resolved.classArmId && !resolved.classId
            ? Prisma.sql`AND e."classArmId" IN (SELECT ca."id" FROM "ClassArm" ca WHERE ca."classLevelId" = ${resolved.classLevelId})`
            : Prisma.empty
        }
      GROUP BY g.subject
      ORDER BY "avgPercent" ASC
      LIMIT 20
    `;

    const label = resolved.label || (resolved.classArmId ? 'Class arm performance' : 'Class performance');
    return {
      data: {
        className: label,
        termId,
        studentCount: studentIds.length,
        thresholdPercent: threshold,
        belowThreshold: students.length,
        atRiskPreview: students.slice(0, 8).map((s) => ({
          studentId: s.studentId,
          name: `${s.firstName} ${s.lastName}`.trim(),
          avgPercent: Math.round(s.avgPercent * 10) / 10,
        })),
        subjectAverages: avgRows.map((r) => ({
          subject: r.subject,
          avgPercent: Math.round(r.avgPercent * 10) / 10,
          gradeCount: r.gradeCount,
        })),
        message:
          avgRows.length === 0
            ? 'No published grades this term for this class. Quote the enrolment count; do not send them to an academic dashboard as if averages were hiding there.'
            : undefined,
      },
      usage: null,
      sources: [toolSource('get_class_performance', label, '/dashboard/school/students')],
    };
  }

  async getSchemeOfWork(
    args: { classId?: string; classLevelId?: string; subjectId?: string; weekNumber?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const termId = await this.schoolInsights.getActiveTermId(schoolId);

    let classLevelId = args.classLevelId;
    let classId = args.classId;
    let focusArmId: string | undefined;
    if (args.classId) {
      const arm = await this.prisma.classArm.findFirst({
        where: { id: args.classId, classLevel: { schoolId } },
        select: { id: true, classLevelId: true },
      });
      if (arm) {
        focusArmId = arm.id;
        classLevelId = classLevelId || arm.classLevelId;
        classId = undefined;
      }
    }

    const schemes = await this.prisma.schemeOfWork.findMany({
      where: {
        schoolId,
        status: SchemeOfWorkStatus.PUBLISHED,
        ...(termId ? { termId } : {}),
        ...(classId ? { classId } : {}),
        ...(classLevelId ? { classLevelId } : {}),
        ...(args.subjectId ? { subjectId: args.subjectId } : {}),
      },
      take: 8,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        subjectId: true,
        classLevelId: true,
        classId: true,
        classLevel: { select: { name: true } },
        weeks: {
          where: args.weekNumber ? { weekNumber: args.weekNumber } : undefined,
          orderBy: { weekNumber: 'asc' },
          take: 16,
          select: {
            weekNumber: true,
            topic: true,
            learningOutcomes: true,
            studentFriendlyOutcomes: true,
            isDelivered: true,
            deliveredAt: true,
            lessonNoteUrl: true,
            calendarStartDate: true,
            calendarEndDate: true,
            topics: { select: { stableKey: true, agoraTopicId: true } },
            deliveries: {
              select: {
                classArmId: true,
                status: true,
                lessonNoteUrl: true,
                classArm: { select: { name: true, classLevel: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });

    const subjectIds = [...new Set(schemes.map((s) => s.subjectId))];
    const subjects = subjectIds.length
      ? await this.prisma.subject.findMany({
          where: { id: { in: subjectIds } },
          select: { id: true, name: true },
        })
      : [];
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));

    const payload = schemes.map((s) => ({
      schemeId: s.id,
      subject: subjectName.get(s.subjectId) || 'Subject',
      classLevel: s.classLevel?.name || null,
      classLevelId: s.classLevelId,
      weeks: s.weeks.map((w) => {
        const arms = w.deliveries.map((d) => ({
          classArmId: d.classArmId,
          label: d.classArm ? `${d.classArm.classLevel.name} ${d.classArm.name}`.trim() : null,
          status: d.status,
          hasLessonNote: Boolean(d.lessonNoteUrl),
        }));
        const focus = focusArmId ? arms.find((a) => a.classArmId === focusArmId) : undefined;
        return {
          weekNumber: w.weekNumber,
          topic: w.topic,
          stableKeys: w.topics.map((t) => t.stableKey),
          learningOutcomes: w.learningOutcomes,
          studentFriendlyOutcomes: w.studentFriendlyOutcomes,
          isDelivered: focus ? focus.status === 'DELIVERED' : w.isDelivered,
          hasLessonNote: Boolean(w.lessonNoteUrl),
          calendarStart: w.calendarStartDate?.toISOString().slice(0, 10) ?? null,
          calendarEnd: w.calendarEndDate?.toISOString().slice(0, 10) ?? null,
          arms,
        };
      }),
    }));

    const emptyWeekFilter =
      payload.length > 0 && args.weekNumber != null && payload.every((s) => s.weeks.length === 0);

    return {
      data: {
        termId,
        count: payload.length,
        schemes: payload,
        message:
          payload.length === 0
            ? 'No published scheme of work matched those filters. Primary/secondary schemes live on the class level — pass classLevelId, or a class-arm id as classId.'
            : emptyWeekFilter
              ? `Published scheme(s) found, but none include week ${args.weekNumber}. That is not the same as an unpublished scheme.`
              : undefined,
      },
      usage: null,
      sources: [toolSource('get_scheme_of_work', 'Published scheme of work', '/dashboard/school/overview')],
    };
  }

  async getNowInClass(
    args: { classId?: string; classArmId?: string; classQuery?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const resolved = await this.resolveClassArgs(schoolId, args, { required: true, singleClass: true });
    if (resolved.error) return resolved.error;

    await this.assertClassVisible(resolved.classId, resolved.classArmId, context, schoolId);

    const klass = resolved.classId
      ? await this.prisma.class.findFirst({
          where: { id: resolved.classId, schoolId },
          select: { id: true, name: true, type: true },
        })
      : null;

    const { dayOfWeek, currentTime } = this.watClock();
    const schoolType = resolved.type || klass?.type;

    if (schoolType === 'PRIMARY') {
      const form = await this.prisma.classTeacher.findFirst({
        where: {
          ...(resolved.classId ? { classId: resolved.classId } : {}),
          ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
          teacher: { schoolId },
        },
        orderBy: { isPrimary: 'desc' },
        select: {
          isPrimary: true,
          teacher: { select: { firstName: true, lastName: true } },
          subjectRef: { select: { name: true } },
          subject: true,
        },
      });
      const teacherName = form
        ? `${form.teacher.firstName} ${form.teacher.lastName}`.trim()
        : null;
      return {
        data: {
          schoolType: 'PRIMARY',
          className: resolved.label || klass?.name || null,
          dayOfWeek,
          currentTime,
          formTeacher: teacherName,
          note: 'Primary classes are led by the class teacher rather than a rotating subject timetable.',
        },
        usage: null,
        sources: [toolSource('get_now_in_class', `Now in ${resolved.label || klass?.name || 'class'}`)],
      };
    }

    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    const period = termId
      ? await this.prisma.timetablePeriod.findFirst({
          where: {
            termId,
            dayOfWeek,
            startTime: { lte: currentTime },
            endTime: { gt: currentTime },
            ...(resolved.classId ? { classId: resolved.classId } : {}),
            ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
          },
          select: {
            startTime: true,
            endTime: true,
            type: true,
            subject: { select: { name: true } },
            teacher: { select: { firstName: true, lastName: true } },
            class: { select: { name: true } },
            classArm: { select: { name: true, classLevel: { select: { name: true } } } },
          },
        })
      : null;

    if (!period) {
      return {
        data: {
          dayOfWeek,
          currentTime,
          className: resolved.label || klass?.name || null,
          status: 'free_period',
          message: 'No timetable period matches the current time.',
        },
        usage: null,
        sources: [toolSource('get_now_in_class', 'Current timetable')],
      };
    }

    const teacherName = period.teacher
      ? `${period.teacher.firstName} ${period.teacher.lastName}`.trim()
      : null;
    return {
      data: {
        dayOfWeek,
        currentTime,
        className: resolved.label || klass?.name || null,
        status: 'in_session',
        type: period.type,
        subject: period.subject?.name ?? null,
        teacher: teacherName,
        startTime: period.startTime,
        endTime: period.endTime,
      },
      usage: null,
      sources: [toolSource('get_now_in_class', period.subject?.name || 'Current period')],
    };
  }

  async getAttendanceSummary(
    args: { classId?: string; classArmId?: string; classQuery?: string; days?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const days = this.clamp(args.days ?? 7, 1, 30);
    const resolved = await this.resolveClassArgs(schoolId, args, { required: false });
    if (resolved.error) return resolved.error;
    if (resolved.classId || resolved.classArmId) {
      await this.assertClassVisible(resolved.classId, resolved.classArmId, context, schoolId);
    }

    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const access = await this.teacherAccess(context, schoolId);
    const enrollmentWhere: Prisma.EnrollmentWhereInput = {
      schoolId,
      isActive: true,
      ...(resolved.classId ? { classId: resolved.classId } : {}),
      ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
      ...(resolved.classLevelId && !resolved.classArmId && !resolved.classId
        ? { classArm: { classLevelId: resolved.classLevelId } }
        : {}),
      ...(access ? { studentId: { in: [...access.studentIds] } } : {}),
    };

    const grouped = await this.prisma.attendance.groupBy({
      by: ['status'],
      where: {
        date: { gte: since },
        enrollment: enrollmentWhere,
      },
      _count: { _all: true },
    });

    const counts: Record<string, number> = { PRESENT: 0, ABSENT: 0, LATE: 0 };
    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    const topAbsent = await this.prisma.attendance.groupBy({
      by: ['enrollmentId'],
      where: {
        date: { gte: since },
        status: 'ABSENT',
        enrollment: enrollmentWhere,
      },
      _count: { _all: true },
      orderBy: { _count: { enrollmentId: 'desc' } },
      take: 8,
    });

    const enrollmentIds = topAbsent.map((r) => r.enrollmentId);
    const enrollments = enrollmentIds.length
      ? await this.prisma.enrollment.findMany({
          where: { id: { in: enrollmentIds } },
          select: {
            id: true,
            studentId: true,
            student: { select: { firstName: true, lastName: true } },
          },
        })
      : [];
    const byEnr = new Map(enrollments.map((e) => [e.id, e]));
    const marked = (counts.PRESENT || 0) + (counts.ABSENT || 0) + (counts.LATE || 0);

    return {
      data: {
        days,
        since: since.toISOString().slice(0, 10),
        totals: counts,
        mostAbsent: topAbsent.map((r) => {
          const e = byEnr.get(r.enrollmentId);
          return {
            studentId: e?.studentId,
            name: e ? `${e.student.firstName} ${e.student.lastName}`.trim() : 'Student',
            absentDays: r._count._all,
          };
        }),
        productStatus: marked === 0 ? 'barebones' : 'records',
        message:
          marked === 0
            ? 'No attendance marks in this window. Daily attendance tracking is not fully in use yet — zeros mean no records were taken, not that everyone was present, and not that there is an attendance dashboard to check.'
            : undefined,
      },
      usage: null,
      sources: [toolSource('get_attendance_summary', `Attendance · last ${days} days`)],
    };
  }

  async draftParentMessage(
    args: { studentId?: string; topic?: string; tone?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    if (!args.studentId || !args.topic) {
      return { data: { error: 'studentId and topic are required.' }, usage: null };
    }

    const enrollment = await this.prisma.enrollment.findFirst({
      where: { schoolId, studentId: args.studentId, isActive: true },
      select: {
        studentId: true,
        classLevel: true,
        class: { select: { name: true } },
        student: { select: { firstName: true, lastName: true } },
      },
    });
    if (!enrollment) {
      return { data: { error: 'Student not found in this school.' }, usage: null };
    }
    await this.assertStudentVisible(enrollment.studentId, context, schoolId);

    const name = `${enrollment.student.firstName} ${enrollment.student.lastName}`.trim();
    const className = enrollment.class?.name || enrollment.classLevel || 'their class';
    const tone = (args.tone || 'supportive').toLowerCase();
    const opener =
      tone === 'urgent'
        ? `I need to raise a timely concern about ${enrollment.student.firstName}.`
        : tone === 'formal'
          ? `I am writing regarding ${name} in ${className}.`
          : `I wanted to share an update on ${enrollment.student.firstName} in ${className}.`;

    const draft = `Dear Parent/Guardian of ${name},

${opener}

${args.topic.trim()}

Please contact the school if you would like to discuss this further.

Kind regards
${className} — School administration

---
This is a draft only. Lois has not sent this message. Copy it or send it from the dashboard after you review it.`;

    return {
      data: {
        sent: false,
        studentId: enrollment.studentId,
        studentName: name,
        draft,
        disclaimer: 'Draft only. Not sent to parents.',
      },
      usage: null,
      sources: [
        toolSource(
          'draft_parent_message',
          `Draft for ${name}`,
          `/dashboard/school/students/${enrollment.studentId}`,
        ),
      ],
    };
  }

  async listClasses(
    args: { query?: string; limit?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const limit = this.clamp(args.limit ?? 25, 1, 40);
    const access = await this.teacherAccess(context, schoolId);
    const rows = await this.searchClassDirectory(schoolId, args.query, limit, access);

    return {
      data: {
        count: rows.length,
        query: args.query?.trim() || null,
        classes: rows.map((row) => ({
          classId: row.classId,
          classArmId: row.classArmId,
          classLevelId: row.classLevelId,
          label: row.label,
          type: row.type,
          enrollmentCount: row.enrollmentCount,
          capacity: row.capacity,
          formTeacher: row.formTeacher,
        })),
        message:
          rows.length === 0
            ? args.query
              ? `No class matched "${args.query}".`
              : 'No active classes found.'
            : undefined,
      },
      usage: null,
      sources: [toolSource('list_classes', `${rows.length} class${rows.length === 1 ? '' : 'es'}`, '/dashboard/school/levels')],
    };
  }

  async getTimetable(
    args: { classId?: string; classArmId?: string; classQuery?: string; day?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const resolved = await this.resolveClassArgs(schoolId, args, { required: true, singleClass: true });
    if (resolved.error) return resolved.error;
    await this.assertClassVisible(resolved.classId, resolved.classArmId, context, schoolId);

    const dayOfWeek = this.parseDayOfWeek(args.day);
    if (!dayOfWeek) {
      return { data: { error: 'Unrecognised day. Use Monday–Sunday or "today".' }, usage: null };
    }

    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    if (!termId) {
      return {
        data: { dayOfWeek, className: resolved.label, periods: [], message: 'No active term.' },
        usage: null,
      };
    }

    const periods = await this.prisma.timetablePeriod.findMany({
      where: {
        termId,
        dayOfWeek,
        ...(resolved.classId ? { classId: resolved.classId } : {}),
        ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
      },
      orderBy: { startTime: 'asc' },
      take: 20,
      select: {
        startTime: true,
        endTime: true,
        type: true,
        subject: { select: { name: true } },
        teacher: { select: { firstName: true, lastName: true } },
        room: { select: { name: true } },
      },
    });

    const formTeacher = await this.findFormTeacher(schoolId, resolved.classId, resolved.classArmId);

    return {
      data: {
        dayOfWeek,
        className: resolved.label,
        formTeacher,
        periodCount: periods.length,
        periods: periods.map((p) => ({
          startTime: p.startTime,
          endTime: p.endTime,
          type: p.type,
          subject: p.subject?.name ?? null,
          teacher: p.teacher ? `${p.teacher.firstName} ${p.teacher.lastName}`.trim() : null,
          room: p.room?.name ?? null,
        })),
        message: periods.length === 0 ? `No timetable periods on ${dayOfWeek}.` : undefined,
        nextHint:
          periods.length === 0
            ? 'This is a lookup of saved periods, not a generated timetable. If the user asked to generate or auto-fill one, call inspect_scheduling_context then propose_timetable.'
            : undefined,
      },
      usage: null,
      sources: [
        toolSource('get_timetable', `${resolved.label} · ${dayOfWeek}`, '/dashboard/school/timetables'),
      ],
    };
  }

  async listStaff(
    args: { query?: string; kind?: string; limit?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const limit = this.clamp(args.limit ?? 20, 1, MAX_LIST);
    const name = args.query?.trim();
    const isAdmin = context?.userRole === 'SCHOOL_ADMIN' || context?.userRole === 'SUPER_ADMIN';
    const kind = (args.kind || (isAdmin ? 'all' : 'teacher')).toLowerCase();
    const includeAdmins = isAdmin && (kind === 'admin' || kind === 'all');
    const includeTeachers = kind !== 'admin';

    const teacherNameFilter = (name ? personNameWhere(name) : {}) as Prisma.TeacherWhereInput;
    const adminNameFilter = (name ? personNameWhere(name) : {}) as Prisma.SchoolAdminWhereInput;

    const [teachers, admins] = await Promise.all([
      includeTeachers
        ? this.prisma.teacher.findMany({
            where: { schoolId, ...teacherNameFilter },
            take: limit,
            orderBy: { lastName: 'asc' },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              subject: true,
              schoolType: true,
              billingSuspended: true,
              phone: true,
              email: true,
              subjectTeachers: { select: { subject: { select: { name: true } } }, take: 6 },
              classTeachers: {
                take: 8,
                select: {
                  isPrimary: true,
                  isFormTeacher: true,
                  classId: true,
                  classArmId: true,
                  class: { select: { name: true } },
                  classArm: { select: { name: true, classLevel: { select: { name: true } } } },
                },
              },
            },
          })
        : Promise.resolve([]),
      includeAdmins
        ? this.prisma.schoolAdmin.findMany({
            where: { schoolId, ...adminNameFilter },
            take: limit,
            orderBy: { lastName: 'asc' },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              role: true,
              phone: true,
              email: true,
              billingSuspended: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const mappedTeachers = teachers.map((t) => ({
      teacherId: t.id,
      name: `${t.firstName} ${t.lastName}`.trim(),
      subjects: [
        ...new Set(
          [t.subject, ...t.subjectTeachers.map((s) => s.subject.name)].filter(Boolean) as string[],
        ),
      ],
      schoolType: t.schoolType,
      assignments: t.classTeachers.map((ct) => ({
        className: ct.class?.name || this.classLabel({ classArm: ct.classArm }),
        formTeacher: ct.isPrimary || ct.isFormTeacher,
        classId: ct.classId,
        classArmId: ct.classArmId,
      })),
      ...(isAdmin
        ? { phone: t.phone, email: t.email, billingSuspended: t.billingSuspended }
        : {}),
    }));

    const access = await this.teacherAccess(context, schoolId);
    const teacherClasses = name
      ? await this.loadTeacherClassRosters(
          schoolId,
          mappedTeachers.map((t) => ({
            id: t.teacherId,
            name: t.name,
            assignments: t.assignments,
          })),
          access,
          limit,
        )
      : [];

    return {
      data: {
        teachers: mappedTeachers,
        admins: admins.map((a) => ({
          adminId: a.id,
          name: `${a.firstName} ${a.lastName}`.trim(),
          role: a.role,
          ...(isAdmin
            ? { phone: a.phone, email: a.email, billingSuspended: a.billingSuspended }
            : {}),
        })),
        ...(teacherClasses.length ? { teacherClasses } : {}),
        message: teacherClasses.some((c) => c.students.length > 0)
          ? 'teacherClasses lists the students in this teacher\'s class — name those students.'
          : undefined,
      },
      usage: null,
      sources: [
        toolSource(
          'list_staff',
          teacherClasses.some((c) => c.students.length > 0)
            ? `${name} · class roster`
            : 'Staff directory',
          '/dashboard/school/staff',
        ),
      ],
    };
  }

  async whoTeaches(
    args: { subject?: string; classId?: string; classArmId?: string; classQuery?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const wantsClass = Boolean(args.classId || args.classArmId || args.classQuery);
    const resolved = wantsClass
      ? await this.resolveClassArgs(schoolId, args, { required: true })
      : { classId: undefined, classArmId: undefined, classLevelId: undefined, label: undefined, type: undefined, error: undefined };
    if (resolved.error) return resolved.error;
    if (wantsClass) {
      await this.assertClassVisible(resolved.classId, resolved.classArmId, context, schoolId);
    }

    const subjectQuery = args.subject?.trim();
    const subjectRows = subjectQuery
      ? await this.prisma.subject.findMany({
          where: {
            schoolId,
            isActive: true,
            name: { contains: subjectQuery, mode: 'insensitive' },
          },
          select: { id: true, name: true },
          take: 8,
        })
      : [];
    const subjectIds = subjectRows.map((s) => s.id);

    const assignmentWhere: Prisma.ClassTeacherWhereInput = {
      teacher: { schoolId },
      ...(resolved.classId ? { classId: resolved.classId } : {}),
      ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
      ...(resolved.classLevelId && !resolved.classArmId && !resolved.classId
        ? { classArm: { classLevelId: resolved.classLevelId } }
        : {}),
      ...(subjectQuery
        ? {
            OR: [
              ...(subjectIds.length ? [{ subjectId: { in: subjectIds } }] : []),
              { subject: { contains: subjectQuery, mode: 'insensitive' } },
              { subjectRef: { name: { contains: subjectQuery, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const assignments = await this.prisma.classTeacher.findMany({
      where: assignmentWhere,
      take: 20,
      select: {
        isPrimary: true,
        isFormTeacher: true,
        subject: true,
        subjectRef: { select: { name: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
        class: { select: { name: true } },
        classArm: { select: { name: true, classLevel: { select: { name: true } } } },
      },
    });

    const formTeacher = wantsClass
      ? await this.findFormTeacher(schoolId, resolved.classId, resolved.classArmId)
      : null;

    const teachers = assignments.map((a) => ({
      teacherId: a.teacher.id,
      name: `${a.teacher.firstName} ${a.teacher.lastName}`.trim(),
      subject: a.subjectRef?.name || a.subject || null,
      className: a.class?.name || this.classLabel({ classArm: a.classArm }),
      formTeacher: a.isPrimary || a.isFormTeacher,
    }));

    let schoolSubjectStaff: {
      teacherId: string;
      name: string;
      subjects: string[];
    }[] = [];
    if (subjectQuery && teachers.length === 0) {
      const specialists = await this.prisma.teacher.findMany({
        where: {
          schoolId,
          OR: [
            { subject: { contains: subjectQuery, mode: 'insensitive' } },
            {
              subjectTeachers: {
                some: { subject: { name: { contains: subjectQuery, mode: 'insensitive' } } },
              },
            },
          ],
        },
        take: 12,
        orderBy: { lastName: 'asc' },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          subject: true,
          subjectTeachers: { select: { subject: { select: { name: true } } }, take: 6 },
        },
      });
      schoolSubjectStaff = specialists.map((t) => ({
        teacherId: t.id,
        name: `${t.firstName} ${t.lastName}`.trim(),
        subjects: [
          ...new Set(
            [t.subject, ...t.subjectTeachers.map((s) => s.subject.name)].filter(Boolean) as string[],
          ),
        ],
      }));
    }

    const classLabel = resolved.label ?? null;
    const message =
      teachers.length === 0 && !formTeacher
        ? schoolSubjectStaff.length
          ? `No teacher is assigned to ${classLabel || 'this class'} for ${subjectQuery} on the timetable. These staff are listed as ${subjectQuery} teachers at the school.`
          : 'No teacher assignment matched those filters.'
        : undefined;

    return {
      data: {
        className: classLabel,
        formTeacher,
        matchedSubjects: subjectRows.map((s) => s.name),
        teachers,
        ...(schoolSubjectStaff.length ? { schoolSubjectStaff } : {}),
        message,
      },
      usage: null,
      sources: [toolSource('who_teaches', resolved.label || subjectQuery || 'Teacher assignments', '/dashboard/school/staff')],
    };
  }

  async listFeeDebtors(
    args: { classId?: string; classArmId?: string; classQuery?: string; limit?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const limit = this.clamp(args.limit ?? 20, 1, MAX_LIST);
    const resolved = await this.resolveClassArgs(schoolId, args, { required: false });
    if (resolved.error) return resolved.error;

    const classFilter: Prisma.EnrollmentWhereInput = {
      ...(resolved.classId ? { classId: resolved.classId } : {}),
      ...(resolved.classArmId ? { classArmId: resolved.classArmId } : {}),
      ...(resolved.classLevelId && !resolved.classArmId && !resolved.classId
        ? { classArm: { classLevelId: resolved.classLevelId } }
        : {}),
    };

    const unpaidFees = await this.prisma.fee.findMany({
      where: {
        schoolId,
        paidDate: null,
        status: { notIn: ['PAID', 'WAIVED', 'CANCELLED'] },
        enrollment: { schoolId, isActive: true, ...classFilter },
      },
      select: {
        amount: true,
        description: true,
        dueDate: true,
        status: true,
        enrollment: {
          select: {
            studentId: true,
            debtBalance: true,
            class: { select: { name: true } },
            classLevel: true,
            classArm: { select: { name: true, classLevel: { select: { name: true } } } },
            student: { select: { firstName: true, lastName: true } },
          },
        },
      },
      take: 200,
    });

    const byStudent = new Map<
      string,
      {
        studentId: string;
        name: string;
        className: string;
        debtBalance: number;
        unpaidCount: number;
        unpaidAmount: number;
      }
    >();

    for (const fee of unpaidFees) {
      const e = fee.enrollment;
      const id = e.studentId;
      const amount = this.money(fee.amount);
      const existing = byStudent.get(id);
      if (existing) {
        existing.unpaidCount += 1;
        existing.unpaidAmount += amount;
      } else {
        byStudent.set(id, {
          studentId: id,
          name: `${e.student.firstName} ${e.student.lastName}`.trim(),
          className: this.classLabel(e),
          debtBalance: this.money(e.debtBalance),
          unpaidCount: 1,
          unpaidAmount: amount,
        });
      }
    }

    const extraDebt = await this.prisma.enrollment.findMany({
      where: {
        schoolId,
        isActive: true,
        debtBalance: { gt: 0 },
        ...classFilter,
        studentId: { notIn: [...byStudent.keys()] },
      },
      take: limit,
      select: {
        studentId: true,
        debtBalance: true,
        class: { select: { name: true } },
        classLevel: true,
        classArm: { select: { name: true, classLevel: { select: { name: true } } } },
        student: { select: { firstName: true, lastName: true } },
      },
    });

    for (const e of extraDebt) {
      byStudent.set(e.studentId, {
        studentId: e.studentId,
        name: `${e.student.firstName} ${e.student.lastName}`.trim(),
        className: this.classLabel(e),
        debtBalance: this.money(e.debtBalance),
        unpaidCount: 0,
        unpaidAmount: 0,
      });
    }

    const debtors = [...byStudent.values()]
      .sort((a, b) => b.unpaidAmount + b.debtBalance - (a.unpaidAmount + a.debtBalance))
      .slice(0, limit);

    const outstanding = debtors.reduce((sum, d) => sum + d.unpaidAmount + d.debtBalance, 0);

    return {
      data: {
        count: debtors.length,
        className: resolved.label ?? null,
        totalOutstanding: Math.round(outstanding * 100) / 100,
        debtors: debtors.map((d) => ({
          ...d,
          unpaidAmount: Math.round(d.unpaidAmount * 100) / 100,
        })),
        message:
          debtors.length === 0
            ? 'No unpaid fee records on file. Fee collection / bursary is not fully in use yet — this is not a complete fees dashboard, and zeros do not mean a bursar checked every family.'
            : undefined,
        note: 'Lois cannot record a payment. Bursary and taking payments are not fully built — do not send the owner to a Fees page as if it were complete.',
        productStatus: 'barebones',
      },
      usage: null,
      sources: [toolSource('list_fee_debtors', `${debtors.length} with outstanding fees`, '/dashboard/school/students')],
    };
  }

  async listAdmissions(
    args: { status?: string; limit?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const limit = this.clamp(args.limit ?? 15, 1, MAX_LIST);
    const statusRaw = args.status?.trim().toUpperCase();
    const status =
      statusRaw && (Object.values(AdmissionStatus) as string[]).includes(statusRaw)
        ? (statusRaw as AdmissionStatus)
        : undefined;
    if (statusRaw && !status) {
      return { data: { error: 'status must be PENDING, ACCEPTED, or DECLINED.' }, usage: null };
    }

    const [counts, rows] = await Promise.all([
      this.prisma.admissionApplication.groupBy({
        by: ['status'],
        where: { schoolId },
        _count: { _all: true },
      }),
      this.prisma.admissionApplication.findMany({
        where: { schoolId, ...(status ? { status } : { status: AdmissionStatus.PENDING }) },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          classLevel: true,
          academicYear: true,
          status: true,
          parentName: true,
          parentPhone: true,
          createdAt: true,
        },
      }),
    ]);

    const byStatus: Record<string, number> = { PENDING: 0, ACCEPTED: 0, DECLINED: 0 };
    for (const row of counts) {
      byStatus[row.status] = row._count._all;
    }

    return {
      data: {
        counts: byStatus,
        filter: status ?? 'PENDING',
        applications: rows.map((a) => ({
          applicationId: a.id,
          name: `${a.firstName} ${a.lastName}`.trim(),
          classLevel: a.classLevel,
          academicYear: a.academicYear,
          status: a.status,
          parentName: a.parentName,
          parentPhone: a.parentPhone,
          submittedAt: a.createdAt.toISOString().slice(0, 10),
        })),
        note: 'Lois cannot approve or decline applications. Use the Applications page.',
      },
      usage: null,
      sources: [toolSource('list_admissions', 'Admission applications', '/dashboard/school/applications')],
    };
  }

  async getCalendar(
    args: { from?: string; to?: string; type?: string; range?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    const { ymd } = this.watClock();
    const window = resolveCalendarWindow(
      { range: args.range, from: args.from?.trim(), to: args.to?.trim() },
      ymd,
      context?.userMessage,
    );
    const fromStr = window.from;
    const from = this.parseIsoDate(fromStr, false);
    if (!from) {
      return { data: { error: 'from must be YYYY-MM-DD.' }, usage: null };
    }
    const toStr = window.to;
    const to = this.parseIsoDate(toStr, true);
    if (!to) {
      return { data: { error: 'to must be YYYY-MM-DD.' }, usage: null };
    }
    if (to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
      return { data: { error: 'Date range cannot exceed 31 days.' }, usage: null };
    }

    const typeRaw = args.type?.trim().toUpperCase();
    const eventType =
      typeRaw && (Object.values(EventType) as string[]).includes(typeRaw)
        ? (typeRaw as EventType)
        : undefined;
    if (typeRaw && !eventType) {
      return { data: { error: 'type must be ACADEMIC, EVENT, EXAM, MEETING, or HOLIDAY.' }, usage: null };
    }

    const events = await this.prisma.event.findMany({
      where: {
        schoolId,
        ...(eventType ? { type: eventType } : {}),
        OR: [
          { startDate: { gte: from, lte: to } },
          { endDate: { gte: from, lte: to } },
          { AND: [{ startDate: { lte: from } }, { endDate: { gte: to } }] },
        ],
      },
      orderBy: { startDate: 'asc' },
      take: 30,
      select: {
        title: true,
        type: true,
        startDate: true,
        endDate: true,
        location: true,
        isAllDay: true,
        schoolType: true,
      },
    });

    const mapEvent = (e: (typeof events)[number]) => ({
      title: e.title,
      type: e.type,
      start: e.startDate.toISOString(),
      end: e.endDate.toISOString(),
      allDay: e.isAllDay,
      location: e.location,
      schoolType: e.schoolType,
    });

    const named = extractNamedCalendarDates(context?.userMessage, ymd);
    const namedDates: Array<{
      label: string;
      date: string;
      inThisWeek: boolean;
      count: number;
      events: ReturnType<typeof mapEvent>[];
      message?: string;
    }> = [];
    for (const item of named) {
      const inThisWeek = item.date >= fromStr && item.date <= toStr;
      const dayStart = this.parseIsoDate(item.date, false);
      const dayEnd = this.parseIsoDate(item.date, true);
      let namedEvents: ReturnType<typeof mapEvent>[] = [];
      if (dayStart && dayEnd) {
        if (inThisWeek) {
          namedEvents = events.filter((e) => e.startDate <= dayEnd && e.endDate >= dayStart).map(mapEvent);
        } else {
          const extra = await this.prisma.event.findMany({
            where: {
              schoolId,
              ...(eventType ? { type: eventType } : {}),
              OR: [
                { startDate: { gte: dayStart, lte: dayEnd } },
                { endDate: { gte: dayStart, lte: dayEnd } },
                { AND: [{ startDate: { lte: dayStart } }, { endDate: { gte: dayEnd } }] },
              ],
            },
            orderBy: { startDate: 'asc' },
            take: 10,
            select: {
              title: true,
              type: true,
              startDate: true,
              endDate: true,
              location: true,
              isAllDay: true,
              schoolType: true,
            },
          });
          namedEvents = extra.map(mapEvent);
        }
      }
      namedDates.push({
        label: item.label,
        date: item.date,
        inThisWeek,
        count: namedEvents.length,
        events: namedEvents,
        message: namedEvents.length
          ? undefined
          : inThisWeek
            ? `No school calendar event on ${item.label} (${item.date}).`
            : `${item.label} is ${item.date}, which is not this week (${fromStr}–${toStr}). No school calendar event on that date.`,
      });
    }

    return {
      data: {
        today: ymd,
        from: fromStr,
        to: toStr,
        range: window.preset,
        count: events.length,
        events: events.map(mapEvent),
        ...(namedDates.length ? { namedDates } : {}),
        message: events.length === 0
          ? window.preset === 'this_week'
            ? 'No calendar events this week.'
            : 'No calendar events in that range.'
          : undefined,
        note: namedDates.some((n) => !n.inThisWeek)
          ? 'namedDates outside this week are NOT this week. Do not say Independence Day is this week unless inThisWeek is true.'
          : undefined,
      },
      usage: null,
      sources: [toolSource('get_calendar', `Calendar ${fromStr}–${toStr}`, '/dashboard/school/calendar')],
    };
  }

  async getGuardians(
    args: { studentId?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = this.requireSchool(context);
    if (!args.studentId) {
      return { data: { error: 'studentId is required.' }, usage: null };
    }

    const enrollment = await this.prisma.enrollment.findFirst({
      where: { schoolId, studentId: args.studentId, isActive: true },
      select: {
        studentId: true,
        class: { select: { name: true } },
        classLevel: true,
        classArm: { select: { name: true, classLevel: { select: { name: true } } } },
        student: { select: { firstName: true, lastName: true } },
      },
    });
    if (!enrollment) {
      return { data: { error: 'Student not found in this school, or not actively enrolled.' }, usage: null };
    }
    await this.assertStudentVisible(enrollment.studentId, context, schoolId);

    const links = await this.prisma.studentGuardian.findMany({
      where: { studentId: enrollment.studentId },
      select: {
        relationship: true,
        isPrimary: true,
        parent: { select: { firstName: true, lastName: true, phone: true, email: true } },
      },
    });

    const name = `${enrollment.student.firstName} ${enrollment.student.lastName}`.trim();
    return {
      data: {
        studentId: enrollment.studentId,
        studentName: name,
        className: this.classLabel(enrollment),
        guardians: links.map((g) => ({
          name: `${g.parent.firstName} ${g.parent.lastName}`.trim(),
          relationship: g.relationship,
          isPrimary: g.isPrimary,
          phone: g.parent.phone,
          email: g.parent.email,
        })),
        message: links.length === 0 ? 'No guardians are linked to this student.' : undefined,
        note: 'Lois does not send messages. Use draft_parent_message for a preview, then send from the dashboard.',
      },
      usage: null,
      sources: [
        toolSource('get_guardians', `Guardians of ${name}`, `/dashboard/school/students/${enrollment.studentId}`),
      ],
    };
  }

  private requireSchool(context?: AgentToolContext): string {
    if (!context?.schoolId) {
      throw new ForbiddenException('School context is required.');
    }
    return context.schoolId;
  }

  private clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
  }

  private classLabel(e: {
    classLevel?: string | null;
    class?: { name: string } | null;
    classArm?: { name: string; classLevel?: { name: string } | null } | null;
  }): string {
    if (e.class?.name) return e.class.name;
    const level = e.classArm?.classLevel?.name || e.classLevel || '';
    const arm = e.classArm?.name || '';
    return `${level} ${arm}`.trim() || 'Class';
  }

  /** Homeroom roster for a named teacher (ClassTeacher rows and ClassArm.classTeacherId). */
  private async loadTeacherClassRosters(
    schoolId: string,
    teachers: {
      id: string;
      name: string;
      assignments?: {
        className: string;
        formTeacher: boolean;
        classId?: string | null;
        classArmId?: string | null;
      }[];
    }[],
    access: TeacherRagAccess | null,
    limit: number,
  ): Promise<
    { teacherName: string; className: string; students: { name: string; admissionNumber: string }[] }[]
  > {
    const refs: {
      teacherName: string;
      className: string;
      classId?: string | null;
      classArmId?: string | null;
    }[] = [];
    const seen = new Set<string>();
    const remember = (ref: (typeof refs)[number]) => {
      const key = `${ref.classArmId || ''}:${ref.classId || ''}:${ref.teacherName}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(ref);
    };

    for (const t of teachers) {
      for (const a of t.assignments || []) {
        if (!(a.formTeacher && (a.classArmId || a.classId))) continue;
        remember({
          teacherName: t.name,
          className: a.className,
          classId: a.classId,
          classArmId: a.classArmId,
        });
      }
    }

    const ids = teachers.map((t) => t.id).filter(Boolean);
    if (ids.length > 0) {
      const arms = await this.prisma.classArm.findMany({
        where: { classTeacherId: { in: ids }, classLevel: { schoolId } },
        select: {
          id: true,
          name: true,
          classTeacherId: true,
          classLevel: { select: { name: true } },
        },
      });
      for (const arm of arms) {
        const t = teachers.find((x) => x.id === arm.classTeacherId);
        if (!t) continue;
        remember({
          teacherName: t.name,
          className: this.classLabel({ classArm: arm }),
          classArmId: arm.id,
        });
      }
    }

    if (refs.length === 0) return [];

    return Promise.all(
      refs.map(async (ref) => {
        const roster = await this.prisma.enrollment.findMany({
          where: {
            schoolId,
            isActive: true,
            ...(ref.classArmId ? { classArmId: ref.classArmId } : { classId: ref.classId || undefined }),
            ...(access ? { studentId: { in: [...access.studentIds] } } : {}),
          },
          take: limit,
          orderBy: { student: { lastName: 'asc' } },
          select: { student: { select: { firstName: true, lastName: true, uid: true } } },
        });
        return {
          teacherName: ref.teacherName,
          className: ref.className,
          students: roster.map((e) => ({
            name: `${e.student.firstName} ${e.student.lastName}`.trim(),
            admissionNumber: e.student.uid,
          })),
        };
      }),
    );
  }

  private async teacherAccess(
    context: AgentToolContext | undefined,
    schoolId: string,
  ): Promise<TeacherRagAccess | null> {
    if (context?.userRole !== 'TEACHER' || !context.userId) return null;
    return this.schoolInsights.resolveTeacherRagAccess(context.userId, schoolId);
  }

  private async assertStudentVisible(
    studentId: string,
    context: AgentToolContext | undefined,
    schoolId: string,
  ): Promise<void> {
    if (context?.userRole === 'STUDENT') {
      const self = await this.prisma.student.findFirst({
        where: { userId: context.userId, id: studentId },
        select: { id: true },
      });
      if (!self) throw new ForbiddenException('You can only view your own student record.');
      return;
    }
    const access = await this.teacherAccess(context, schoolId);
    if (access && !access.studentIds.has(studentId)) {
      throw new ForbiddenException('This student is not in your assigned classes.');
    }
  }

  private async assertClassVisible(
    classId: string | undefined,
    classArmId: string | undefined,
    context: AgentToolContext | undefined,
    schoolId: string,
  ): Promise<void> {
    const access = await this.teacherAccess(context, schoolId);
    if (!access) return;
    if (classId && !access.classIds.has(classId)) {
      throw new ForbiddenException('You do not have access to this class.');
    }
    if (classArmId && !access.classArmIds.has(classArmId)) {
      throw new ForbiddenException('You do not have access to this class arm.');
    }
  }

  private money(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  private watClock(): { dayOfWeek: DayOfWeek; currentTime: string; ymd: string } {
    const wat = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
    const dayNames: DayOfWeek[] = [
      'SUNDAY',
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
    ];
    const hh = String(wat.getHours()).padStart(2, '0');
    const mm = String(wat.getMinutes()).padStart(2, '0');
    const ymd = `${wat.getFullYear()}-${String(wat.getMonth() + 1).padStart(2, '0')}-${String(wat.getDate()).padStart(2, '0')}`;
    return { dayOfWeek: dayNames[wat.getDay()], currentTime: `${hh}:${mm}`, ymd };
  }

  private parseDayOfWeek(day?: string): DayOfWeek | null {
    if (!day || /^today$/i.test(day.trim())) return this.watClock().dayOfWeek;
    const key = day.trim().toUpperCase();
    const map: Record<string, DayOfWeek> = {
      SUNDAY: 'SUNDAY',
      SUN: 'SUNDAY',
      MONDAY: 'MONDAY',
      MON: 'MONDAY',
      TUESDAY: 'TUESDAY',
      TUE: 'TUESDAY',
      TUES: 'TUESDAY',
      WEDNESDAY: 'WEDNESDAY',
      WED: 'WEDNESDAY',
      THURSDAY: 'THURSDAY',
      THU: 'THURSDAY',
      THUR: 'THURSDAY',
      THURS: 'THURSDAY',
      FRIDAY: 'FRIDAY',
      FRI: 'FRIDAY',
      SATURDAY: 'SATURDAY',
      SAT: 'SATURDAY',
    };
    return map[key] ?? null;
  }

  private parseIsoDate(ymd: string, endOfDay: boolean): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
    const date = new Date(`${ymd}T${endOfDay ? '23:59:59' : '00:00:00'}+01:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private addDaysYmd(ymd: string, days: number): string {
    const date = this.parseIsoDate(ymd, false);
    if (!date) return ymd;
    date.setDate(date.getDate() + days);
    const wat = new Date(date.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
    return `${wat.getFullYear()}-${String(wat.getMonth() + 1).padStart(2, '0')}-${String(wat.getDate()).padStart(2, '0')}`;
  }

  private async searchClassDirectory(
    schoolId: string,
    query: string | undefined,
    limit: number,
    access: TeacherRagAccess | null,
  ): Promise<
    {
      classId: string | null;
      classArmId: string | null;
      classLevelId: string | null;
      label: string;
      type: string;
      enrollmentCount: number;
      capacity: number | null;
      formTeacher: string | null;
      score: number;
    }[]
  > {
    const [arms, classes, armCounts, classCounts] = await Promise.all([
      this.prisma.classArm.findMany({
        where: { isActive: true, classLevel: { schoolId, isActive: true } },
        take: 80,
        orderBy: [{ classLevel: { level: 'asc' } }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          capacity: true,
          classLevelId: true,
          classLevel: { select: { id: true, name: true, type: true } },
          classTeacher: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.class.findMany({
        where: { schoolId, isActive: true },
        take: 40,
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, type: true, classLevel: true },
      }),
      this.prisma.enrollment.groupBy({
        by: ['classArmId'],
        where: { schoolId, isActive: true, classArmId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.enrollment.groupBy({
        by: ['classId'],
        where: { schoolId, isActive: true, classId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const armCountMap = new Map(armCounts.map((r) => [r.classArmId, r._count._all]));
    const classCountMap = new Map(classCounts.map((r) => [r.classId, r._count._all]));
    const queryKey = query ? normalizeClassQueryKey(query) : '';

    const rows: {
      classId: string | null;
      classArmId: string | null;
      classLevelId: string | null;
      label: string;
      type: string;
      enrollmentCount: number;
      capacity: number | null;
      formTeacher: string | null;
      score: number;
    }[] = [];

    for (const arm of arms) {
      if (access && !access.classArmIds.has(arm.id)) continue;
      const label = `${arm.classLevel.name} ${arm.name}`.trim();
      const score = scoreClassQueryMatch(
        queryKey,
        normalizeClassQueryKey(label),
        normalizeClassQueryKey(arm.classLevel.name),
      );
      if (queryKey && score === 0) continue;
      rows.push({
        classId: null,
        classArmId: arm.id,
        classLevelId: arm.classLevelId,
        label,
        type: arm.classLevel.type,
        enrollmentCount: armCountMap.get(arm.id) ?? 0,
        capacity: arm.capacity,
        formTeacher: arm.classTeacher
          ? `${arm.classTeacher.firstName} ${arm.classTeacher.lastName}`.trim()
          : null,
        score,
      });
    }

    for (const klass of classes) {
      if (access && klass.id && !access.classIds.has(klass.id)) continue;
      const label = klass.code ? `${klass.name} (${klass.code})` : klass.name;
      const score = scoreClassQueryMatch(
        queryKey,
        normalizeClassQueryKey(`${klass.name}${klass.code || ''}${klass.classLevel || ''}`),
        normalizeClassQueryKey(klass.classLevel || klass.name),
      );
      if (queryKey && score === 0) continue;
      rows.push({
        classId: klass.id,
        classArmId: null,
        classLevelId: null,
        label,
        type: klass.type,
        enrollmentCount: classCountMap.get(klass.id) ?? 0,
        capacity: null,
        formTeacher: null,
        score,
      });
    }

    rows.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    const narrowed = queryKey ? keepBestClassQueryMatches(rows) : rows;
    return narrowed.slice(0, limit);
  }

  private async resolveClassArgs(
    schoolId: string,
    args: { classId?: string; classArmId?: string; classQuery?: string },
    options: { required: boolean; singleClass?: boolean },
  ): Promise<{
    classId?: string;
    classArmId?: string;
    classLevelId?: string;
    label?: string;
    type?: string;
    error?: AgentToolResult;
  }> {
    if (args.classId || args.classArmId) {
      if (args.classArmId) {
        const arm = await this.prisma.classArm.findFirst({
          where: { id: args.classArmId, classLevel: { schoolId } },
          select: {
            id: true,
            name: true,
            classLevel: { select: { id: true, name: true, type: true } },
          },
        });
        if (!arm) {
          return { error: { data: { error: 'Class arm not found in this school.' }, usage: null } };
        }
        return {
          classId: args.classId,
          classArmId: arm.id,
          classLevelId: arm.classLevel.id,
          label: `${arm.classLevel.name} ${arm.name}`.trim(),
          type: arm.classLevel.type,
        };
      }
      const klass = await this.prisma.class.findFirst({
        where: { id: args.classId, schoolId },
        select: { id: true, name: true, type: true },
      });
      if (!klass) {
        return { error: { data: { error: 'Class not found in this school.' }, usage: null } };
      }
      return { classId: klass.id, label: klass.name, type: klass.type };
    }

    const query = args.classQuery?.trim();
    if (!query) {
      if (options.required) {
        return {
          error: {
            data: { error: 'classId, classArmId, or classQuery is required. Use list_classes to resolve a name like "JSS 2A".' },
            usage: null,
          },
        };
      }
      return {};
    }

    const matches = await this.searchClassDirectory(schoolId, query, 12, null);
    if (matches.length === 0) {
      return { error: { data: { error: `No class matched "${query}".`, matches: [] }, usage: null } };
    }
    const queryKey = normalizeClassQueryKey(query);
    const exact = matches.filter((m) => normalizeClassQueryKey(m.label) === queryKey);
    const unique = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
    if (unique) {
      return {
        classId: unique.classId ?? undefined,
        classArmId: unique.classArmId ?? undefined,
        classLevelId: unique.classLevelId ?? undefined,
        label: unique.label,
        type: unique.type,
      };
    }

    const levelIds = new Set(matches.map((m) => m.classLevelId).filter(Boolean));
    if (!options.singleClass && levelIds.size === 1) {
      const first = matches[0];
      return {
        classLevelId: first.classLevelId ?? undefined,
        label: first.classLevelId
          ? matches.find((m) => m.classLevelId)?.label.replace(/\s+\S+$/, '') || query
          : query,
        type: first.type,
      };
    }

    return {
      error: {
        data: {
          error: `Several classes matched "${query}". Pass classArmId or classId from this list.`,
          matches: matches.map((m) => ({
            classId: m.classId,
            classArmId: m.classArmId,
            classLevelId: m.classLevelId,
            label: m.label,
            type: m.type,
          })),
        },
        usage: null,
      },
    };
  }

  private async findFormTeacher(
    schoolId: string,
    classId?: string,
    classArmId?: string,
  ): Promise<string | null> {
    if (!classId && !classArmId) return null;
    if (classArmId) {
      const arm = await this.prisma.classArm.findFirst({
        where: { id: classArmId, classLevel: { schoolId } },
        select: { classTeacher: { select: { firstName: true, lastName: true } } },
      });
      if (arm?.classTeacher) {
        return `${arm.classTeacher.firstName} ${arm.classTeacher.lastName}`.trim();
      }
    }
    const row = await this.prisma.classTeacher.findFirst({
      where: {
        teacher: { schoolId },
        ...(classId ? { classId } : {}),
        ...(classArmId ? { classArmId } : {}),
        OR: [{ isPrimary: true }, { isFormTeacher: true }],
      },
      orderBy: { isPrimary: 'desc' },
      select: { teacher: { select: { firstName: true, lastName: true } } },
    });
    return row ? `${row.teacher.firstName} ${row.teacher.lastName}`.trim() : null;
  }
}
