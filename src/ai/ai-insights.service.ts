import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AdmissionStatus, Prisma, SchemeOfWorkStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { AiSchoolInsightsService } from './ai-school-insights.service';
import { AgentToolContext, AgentToolResult, toolSource } from './ai-lois-source';
import { AiStaffPermissionCheckerService } from './ai-staff-permission-checker.service';
import { LOIS_INSIGHT_TYPES, isLoisInsightType, type LoisInsightType } from './lois-insight-access';
import {
  isGenericSowHref,
  partitionArmsForWeek,
  sowGapAskPrompt,
  sowGapHref,
  sowGapSummary,
  sowGapTitle,
  type SowGapArm,
} from './lois-sow-gap';

export { LOIS_INSIGHT_TYPES, type LoisInsightType } from './lois-insight-access';

const MAX_DAILY_NOTIFICATIONS = 8;

type InsightInput = {
  type: LoisInsightType;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  studentIds?: string[];
  classIds?: string[];
  teacherIds?: string[];
  href?: string | null;
  askPrompt?: string | null;
  fingerprint: string;
};

type CreatedInsight = {
  id: string;
  type: LoisInsightType;
  title: string;
  summary: string;
  askPrompt: string | null;
};

export type LoisInsightDto = {
  id: string;
  type: string;
  severity: string;
  title: string;
  summary: string;
  evidence: unknown;
  href: string | null;
  askPrompt: string | null;
  createdAt: Date;
  unread: boolean;
};

function weekStartYmd(d = new Date()): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() - (day - 1));
  return x.toISOString().slice(0, 10);
}

function todayYmd(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function insightDeepLink(id: string): string {
  return `/dashboard/school/overview?loisInsight=${encodeURIComponent(id)}`;
}

const UNREAD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function isRecentInsight(createdAt: Date, now = Date.now()): boolean {
  return now - createdAt.getTime() <= UNREAD_WINDOW_MS;
}

/**
 * Persistent Lois insights (background loops) + query for the Overview inbox.
 * Recipients and list results are scoped to staff permissions for each type.
 */
@Injectable()
export class AiInsightsService {
  private readonly logger = new Logger(AiInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolInsights: AiSchoolInsightsService,
    private readonly notifications: NotificationService,
    private readonly permissionChecker: AiStaffPermissionCheckerService,
  ) {}

  async listForSchool(
    schoolId: string,
    limit = 8,
    types?: string[],
    userId?: string,
  ): Promise<LoisInsightDto[]> {
    if (types && types.length === 0) return [];

    const rows = await this.prisma.loisInsight.findMany({
      where: {
        schoolId,
        ...(types ? { type: { in: types } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 15),
    });
    const unreadIds = await this.unreadIdSet(
      userId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => this.toDto(r, unreadIds.has(r.id)));
  }

  async getById(
    schoolId: string,
    insightId: string,
    allowedTypes: string[],
    userId?: string,
  ): Promise<LoisInsightDto> {
    const row = await this.prisma.loisInsight.findFirst({
      where: { id: insightId, schoolId },
    });
    if (!row) {
      throw new NotFoundException('Insight not found.');
    }
    if (!allowedTypes.includes(row.type)) {
      throw new ForbiddenException('You do not have access to this insight.');
    }
    const unreadIds = await this.unreadIdSet(userId, [row.id]);
    return this.toDto(row, unreadIds.has(row.id));
  }

  async markRead(
    schoolId: string,
    insightId: string,
    userId: string,
    allowedTypes: string[],
  ): Promise<LoisInsightDto> {
    const insight = await this.getById(schoolId, insightId, allowedTypes, userId);
    await this.upsertReadReceipt(insightId, userId);
    await this.markMatchingInboxRead(userId, schoolId, insightId);
    return { ...insight, unread: false };
  }

  async listForTool(
    args: { limit?: number; insightId?: string },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = context?.schoolId;
    if (!schoolId) {
      return { data: { error: 'School context is required.' }, usage: null };
    }
    const types = await this.permissionChecker.allowedInsightTypes(
      context?.userId,
      schoolId,
      context?.userRole,
    );
    if (args.insightId) {
      try {
        const insight = await this.getById(schoolId, args.insightId, types, context?.userId);
        return {
          data: { count: 1, insights: [insight] },
          usage: null,
          sources: [toolSource('list_lois_insights', insight.title, insight.href ?? undefined)],
        };
      } catch {
        return {
          data: { count: 0, insights: [], message: 'That filed report was not found or is not in your access.' },
          usage: null,
        };
      }
    }
    const insights = await this.listForSchool(schoolId, args.limit ?? 8, types, context?.userId);
    return {
      data: { count: insights.length, insights },
      usage: null,
      sources: [
        toolSource(
          'list_lois_insights',
          insights.length ? `${insights.length} Lois insight${insights.length === 1 ? '' : 's'}` : 'No open insights',
          '/dashboard/school/overview',
        ),
      ],
    };
  }

  async upsertInsight(schoolId: string, input: InsightInput): Promise<{ created: boolean; id: string }> {
    const existing = await this.prisma.loisInsight.findUnique({
      where: { schoolId_fingerprint: { schoolId, fingerprint: input.fingerprint } },
      select: { id: true },
    });

    const row = await this.prisma.loisInsight.upsert({
      where: { schoolId_fingerprint: { schoolId, fingerprint: input.fingerprint } },
      create: {
        schoolId,
        type: input.type,
        severity: input.severity,
        title: input.title,
        summary: input.summary,
        evidence: input.evidence as Prisma.InputJsonValue,
        studentIds: input.studentIds ?? [],
        classIds: input.classIds ?? [],
        teacherIds: input.teacherIds ?? [],
        href: input.href ?? null,
        askPrompt: input.askPrompt ?? null,
        fingerprint: input.fingerprint,
      },
      update: {
        severity: input.severity,
        title: input.title,
        summary: input.summary,
        evidence: input.evidence as Prisma.InputJsonValue,
        studentIds: input.studentIds ?? [],
        classIds: input.classIds ?? [],
        teacherIds: input.teacherIds ?? [],
        href: input.href ?? null,
        askPrompt: input.askPrompt ?? null,
      },
      select: { id: true },
    });

    return { created: !existing, id: row.id };
  }

  async runDailyForSchool(schoolId: string, schoolName: string): Promise<void> {
    const created: CreatedInsight[] = [];

    const risk = await this.captureAcademicRisk(schoolId, schoolName);
    if (risk) created.push(risk);

    created.push(...(await this.captureStudentDrops(schoolId)));
    created.push(...(await this.captureSowGaps(schoolId)));
    created.push(...(await this.captureAttendanceRisk(schoolId)));
    created.push(...(await this.captureFeeArrears(schoolId)));
    created.push(...(await this.captureAdmissionsBacklog(schoolId)));

    await this.notifyCreated(schoolId, created);
  }

  private async notifyCreated(schoolId: string, created: CreatedInsight[]): Promise<void> {
    for (const item of created.slice(0, MAX_DAILY_NOTIFICATIONS)) {
      if (!isLoisInsightType(item.type)) continue;
      try {
        const userIds = await this.permissionChecker.getAdminUserIdsForInsightType(schoolId, item.type);
        if (userIds.length === 0) continue;
        await this.notifications.notifyUsers(userIds, {
          schoolId,
          role: 'SCHOOL_ADMIN',
          type: 'LOIS_INSIGHT',
          title: item.title,
          body: item.summary.slice(0, 240),
          link: insightDeepLink(item.id),
          metadata: {
            insightId: item.id,
            type: item.type,
            askPrompt: item.askPrompt,
          },
        });
      } catch (err) {
        this.logger.warn(`Failed to notify for insight ${item.id}: ${err}`);
      }
    }
  }

  private async unreadIdSet(userId: string | undefined, insightIds: string[]): Promise<Set<string>> {
    if (!userId || insightIds.length === 0) return new Set(insightIds);
    try {
      const reads = await this.prisma.$queryRaw<{ insightId: string }[]>`
        SELECT "insightId" FROM "LoisInsightRead"
        WHERE "userId" = ${userId}
        AND "insightId" IN (${Prisma.join(insightIds)})
      `;
      const readIds = new Set(reads.map((r) => r.insightId));
      return new Set(insightIds.filter((id) => !readIds.has(id)));
    } catch (err) {
      this.logger.warn(`LoisInsightRead lookup failed: ${err}`);
      return new Set(insightIds);
    }
  }

  private async upsertReadReceipt(insightId: string, userId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "LoisInsightRead" (id, "insightId", "userId", "readAt")
        VALUES (${randomUUID()}, ${insightId}, ${userId}, NOW())
        ON CONFLICT ("insightId", "userId") DO UPDATE SET "readAt" = NOW()
      `;
    } catch (err) {
      this.logger.warn(`LoisInsightRead upsert failed: ${err}`);
    }
  }

  private async markMatchingInboxRead(userId: string, schoolId: string, insightId: string): Promise<void> {
    try {
      const rows = await this.prisma.inAppNotification.findMany({
        where: {
          userId,
          schoolId,
          type: 'LOIS_INSIGHT',
          readAt: null,
        },
        select: { id: true, metadata: true },
      });
      const ids = rows
        .filter((row) => {
          const meta = row.metadata;
          return !!meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as { insightId?: unknown }).insightId === insightId;
        })
        .map((row) => row.id);
      if (ids.length === 0) return;
      await this.prisma.inAppNotification.updateMany({
        where: { id: { in: ids } },
        data: { readAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`Failed to mark matching inbox rows for insight ${insightId}: ${err}`);
    }
  }

  private toDto(
    r: {
      id: string;
      type: string;
      severity: string;
      title: string;
      summary: string;
      evidence: unknown;
      href: string | null;
      askPrompt: string | null;
      createdAt: Date;
    },
    unread: boolean,
  ): LoisInsightDto {
    return {
      id: r.id,
      type: r.type,
      severity: r.severity,
      title: r.title,
      summary: r.summary,
      evidence: r.evidence,
      href: this.listHrefForInsight(r.type, r.evidence, r.href),
      askPrompt: this.askPromptForInsight(r.type, r.evidence, r.askPrompt),
      createdAt: r.createdAt,
      unread: unread && isRecentInsight(r.createdAt),
    };
  }

  private listHrefForInsight(type: string, evidence: unknown, stored: string | null): string | null {
    const href = stored?.trim() || '';
    const e = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : null;
    if (type === 'SOW_GAP') {
      const fromEvidence = sowGapHref({
        classArmId: typeof e?.classArmId === 'string' ? e.classArmId : null,
        classId: typeof e?.classId === 'string' ? e.classId : null,
        schemeId: typeof e?.schemeId === 'string' ? e.schemeId : null,
        weekNumber: typeof e?.weekNumber === 'number' ? e.weekNumber : null,
        outstandingArms: Array.isArray(e?.outstandingArms) ? (e.outstandingArms as SowGapArm[]) : [],
      });
      if (fromEvidence) return fromEvidence;
      if (href && !isGenericSowHref(href)) return href;
      return '/dashboard/school/courses';
    }
    if (href && href !== '/dashboard/school/overview') return href;
    if (type === 'ACADEMIC_RISK' || type === 'ATTENDANCE_RISK' || type === 'FEE_ARREARS') {
      return '/dashboard/school/students';
    }
    if (type === 'STUDENT_DROP') {
      return typeof e?.studentId === 'string' ? `/dashboard/school/students/${e.studentId}` : '/dashboard/school/students';
    }
    if (type === 'ADMISSIONS_BACKLOG') return '/dashboard/school/applications';
    return href || null;
  }

  private askPromptForInsight(type: string, evidence: unknown, stored: string | null): string | null {
    if (type !== 'SOW_GAP') return stored;
    const e = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : null;
    const classLevel = typeof e?.classLevel === 'string' ? e.classLevel : 'this class';
    const subject = typeof e?.subject === 'string' ? e.subject : 'this subject';
    const weekNumber = typeof e?.weekNumber === 'number' ? e.weekNumber : 0;
    const topic = typeof e?.topic === 'string' ? e.topic : 'this topic';
    if (!weekNumber) return stored;
    const labels = (rows: unknown): string[] =>
      Array.isArray(rows)
        ? rows
            .map((row) =>
              row && typeof row === 'object' && !Array.isArray(row) && typeof (row as { label?: unknown }).label === 'string'
                ? (row as { label: string }).label
                : null,
            )
            .filter((label): label is string => !!label)
        : [];
    const outstandingLabels = labels(e?.outstandingArms);
    const deliveredLabels = labels(e?.deliveredArms);
    return sowGapAskPrompt({
      classLevel,
      subject,
      weekNumber,
      topic,
      outstandingLabels: outstandingLabels.length ? outstandingLabels : [classLevel],
      deliveredLabels,
    });
  }

  private async ifCreated(
    schoolId: string,
    input: InsightInput,
  ): Promise<CreatedInsight | null> {
    const { created, id } = await this.upsertInsight(schoolId, input);
    if (!created) return null;
    return {
      id,
      type: input.type,
      title: input.title,
      summary: input.summary,
      askPrompt: input.askPrompt ?? null,
    };
  }

  private async captureAcademicRisk(
    schoolId: string,
    _schoolName: string,
  ): Promise<CreatedInsight | null> {
    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    const students = await this.schoolInsights.findAtRiskStudents(schoolId, {
      termId,
      thresholdPercent: 45,
      limit: 20,
      useActiveTermWhenMissing: false,
    });
    if (students.length === 0) return null;

    const preview = students.slice(0, 8).map((s) => ({
      studentId: s.studentId,
      studentName: `${s.firstName} ${s.lastName}`.trim(),
      avgPercent: Math.round(s.avgPercent * 10) / 10,
    }));

    const day = todayYmd();
    return this.ifCreated(schoolId, {
      type: LOIS_INSIGHT_TYPES.ACADEMIC_RISK,
      severity: students.length >= 10 ? 'critical' : 'warning',
      title: `${students.length} student${students.length === 1 ? '' : 's'} below 45% this term`,
      summary: preview.map((p) => `${p.studentName} (${p.avgPercent}%)`).join(', '),
      evidence: { termId, thresholdPercent: 45, students: preview },
      studentIds: students.map((s) => s.studentId),
      href: '/dashboard/school/students',
      askPrompt: 'Explain the academic risk digest for today and what we should do this week.',
      fingerprint: `ACADEMIC_RISK:${termId || 'none'}:${day}`,
    });
  }

  private async captureStudentDrops(schoolId: string): Promise<CreatedInsight[]> {
    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    if (!termId) return [];

    const grades = await this.prisma.grade.findMany({
      where: {
        isPublished: true,
        termId,
        enrollment: { schoolId, isActive: true },
      },
      orderBy: { signedAt: 'asc' },
      take: 4000,
      select: {
        subject: true,
        score: true,
        maxScore: true,
        signedAt: true,
        enrollment: {
          select: {
            studentId: true,
            classId: true,
            student: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    type Bucket = { percents: number[]; studentId: string; name: string; classId: string | null };
    const buckets = new Map<string, Bucket>();
    for (const g of grades) {
      const max = Number(g.maxScore) || 0;
      if (max <= 0) continue;
      const pct = (Number(g.score) / max) * 100;
      const studentId = g.enrollment.studentId;
      const key = `${studentId}::${g.subject}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          percents: [],
          studentId,
          name: `${g.enrollment.student.firstName} ${g.enrollment.student.lastName}`.trim(),
          classId: g.enrollment.classId,
        };
        buckets.set(key, b);
      }
      b.percents.push(pct);
    }

    const created: CreatedInsight[] = [];
    for (const [key, b] of buckets) {
      if (created.length >= 15) break;
      if (b.percents.length < 3) continue;
      const last = b.percents[b.percents.length - 1];
      const prior = b.percents.slice(0, -1);
      const priorAvg = prior.reduce((a, n) => a + n, 0) / prior.length;
      const drop = priorAvg - last;
      if (drop < 15) continue;

      const subject = key.split('::')[1] || 'Subject';
      const title = `${b.name} dropped ${Math.round(drop)} pts in ${subject}`;
      const row = await this.ifCreated(schoolId, {
        type: LOIS_INSIGHT_TYPES.STUDENT_DROP,
        severity: drop >= 25 ? 'critical' : 'warning',
        title,
        summary: `${b.name}: ${subject} fell from an average of ${Math.round(priorAvg)}% to ${Math.round(last)}% on the latest published score.`,
        evidence: {
          studentId: b.studentId,
          subject,
          priorAvg: Math.round(priorAvg * 10) / 10,
          latest: Math.round(last * 10) / 10,
          drop: Math.round(drop * 10) / 10,
          samples: b.percents.length,
        },
        studentIds: [b.studentId],
        classIds: b.classId ? [b.classId] : [],
        href: `/dashboard/school/students/${b.studentId}`,
        askPrompt: `Why did ${b.name}'s ${subject} performance drop, and what should we do?`,
        fingerprint: `STUDENT_DROP:${b.studentId}:${subject}:${termId}`,
      });
      if (row) created.push(row);
    }
    return created;
  }

  private async captureSowGaps(schoolId: string): Promise<CreatedInsight[]> {
    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    if (!termId) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const schemes = await this.prisma.schemeOfWork.findMany({
      where: { schoolId, termId, status: SchemeOfWorkStatus.PUBLISHED },
      take: 40,
      select: {
        id: true,
        subjectId: true,
        classId: true,
        classLevelId: true,
        classLevel: { select: { id: true, name: true } },
        weeks: {
          where: { calendarEndDate: { lt: today } },
          orderBy: { weekNumber: 'asc' },
          select: {
            weekNumber: true,
            topic: true,
            calendarEndDate: true,
            lessonNoteUrl: true,
            isDelivered: true,
            deliveries: {
              select: { classArmId: true, classId: true, status: true, lessonNoteUrl: true },
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

    const levelIds = [...new Set(schemes.map((s) => s.classLevelId).filter((id): id is string => !!id))];
    const arms = levelIds.length
      ? await this.prisma.classArm.findMany({
          where: { classLevelId: { in: levelIds }, isActive: true },
          select: { id: true, name: true, classLevelId: true },
          orderBy: { name: 'asc' },
        })
      : [];
    const armsByLevel = new Map<string, SowGapArm[]>();
    for (const arm of arms) {
      const level = schemes.find((s) => s.classLevelId === arm.classLevelId)?.classLevel?.name || '';
      const list = armsByLevel.get(arm.classLevelId) || [];
      list.push({
        classArmId: arm.id,
        label: `${level} ${arm.name}`.trim(),
      });
      armsByLevel.set(arm.classLevelId, list);
    }

    const created: CreatedInsight[] = [];
    for (const scheme of schemes) {
      const subject = subjectName.get(scheme.subjectId) || 'Subject';
      const classLabel = scheme.classLevel?.name || 'class';
      const levelArms = scheme.classLevelId ? armsByLevel.get(scheme.classLevelId) || [] : [];

      for (const week of scheme.weeks) {
        if (created.length >= 15) return created;

        let outstanding: SowGapArm[] = [];
        let delivered: SowGapArm[] = [];
        if (levelArms.length > 0) {
          const split = partitionArmsForWeek({
            arms: levelArms,
            deliveries: week.deliveries,
            weekIsDelivered: week.isDelivered,
          });
          outstanding = split.outstanding;
          delivered = split.delivered;
        } else if (!week.isDelivered) {
          outstanding = [
            {
              classId: scheme.classId,
              label: classLabel,
            },
          ];
        }

        if (outstanding.length === 0) continue;

        const outstandingLabels = outstanding.map((a) => a.label);
        const deliveredLabels = delivered.map((a) => a.label);
        const firstId = outstanding.find((a) => a.classArmId)?.classArmId || outstanding.find((a) => a.classId)?.classId || scheme.classId || null;
        const evidence = {
          schemeId: scheme.id,
          weekNumber: week.weekNumber,
          topic: week.topic,
          subject,
          classLevel: classLabel,
          classLevelId: scheme.classLevelId,
          classId: firstId,
          classArmId: outstanding.find((a) => a.classArmId)?.classArmId || null,
          outstandingArms: outstanding,
          deliveredArms: delivered,
          calendarEnd: week.calendarEndDate?.toISOString().slice(0, 10) ?? null,
        };
        const href = sowGapHref(evidence) || '/dashboard/school/courses';
        const row = await this.ifCreated(schoolId, {
          type: LOIS_INSIGHT_TYPES.SOW_GAP,
          severity: 'warning',
          title: sowGapTitle({
            classLevel: classLabel,
            subject,
            weekNumber: week.weekNumber,
            outstandingLabels,
          }),
          summary: sowGapSummary({
            weekNumber: week.weekNumber,
            topic: week.topic,
            outstandingLabels,
            deliveredLabels,
          }),
          evidence,
          classIds: outstanding
            .map((a) => a.classArmId || a.classId)
            .filter((id): id is string => !!id),
          href,
          askPrompt: sowGapAskPrompt({
            classLevel: classLabel,
            subject,
            weekNumber: week.weekNumber,
            topic: week.topic,
            outstandingLabels,
            deliveredLabels,
          }),
          fingerprint: `SOW_GAP:${scheme.id}:${week.weekNumber}`,
        });
        if (row) created.push(row);
      }
    }
    return created;
  }

  private async captureAttendanceRisk(schoolId: string): Promise<CreatedInsight[]> {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 14);
    since.setUTCHours(0, 0, 0, 0);
    const week = weekStartYmd();

    const grouped = await this.prisma.attendance.groupBy({
      by: ['enrollmentId'],
      where: {
        date: { gte: since },
        status: 'ABSENT',
        enrollment: { schoolId, isActive: true },
      },
      _count: { _all: true },
      orderBy: { _count: { enrollmentId: 'desc' } },
      take: 25,
    });

    const atRisk = grouped.filter((r) => r._count._all >= 4);
    if (atRisk.length === 0) return [];

    const enrollmentIds = atRisk.map((r) => r.enrollmentId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: { id: { in: enrollmentIds } },
      select: {
        id: true,
        studentId: true,
        classId: true,
        student: { select: { firstName: true, lastName: true } },
      },
    });
    const byEnr = new Map(enrollments.map((e) => [e.id, e]));

    const preview = atRisk.slice(0, 8).map((r) => {
      const e = byEnr.get(r.enrollmentId);
      return {
        studentId: e?.studentId,
        studentName: e ? `${e.student.firstName} ${e.student.lastName}`.trim() : 'Student',
        absentDays: r._count._all,
      };
    });

    const created: CreatedInsight[] = [];
    if (atRisk.length >= 3) {
      const digest = await this.ifCreated(schoolId, {
        type: LOIS_INSIGHT_TYPES.ATTENDANCE_RISK,
        severity: atRisk.length >= 8 ? 'critical' : 'warning',
        title: `${atRisk.length} students with 4+ absences in 14 days`,
        summary: preview.map((p) => `${p.studentName} (${p.absentDays} days)`).join(', '),
        evidence: { since: since.toISOString().slice(0, 10), thresholdDays: 4, students: preview },
        studentIds: preview.map((p) => p.studentId).filter((id): id is string => !!id),
        href: '/dashboard/school/students',
        askPrompt:
          'Which students have concerning attendance in the last two weeks, and what should we do?',
        fingerprint: `ATTENDANCE_RISK:DIGEST:${week}`,
      });
      if (digest) created.push(digest);
    }

    for (const row of atRisk.slice(0, 5)) {
      const e = byEnr.get(row.enrollmentId);
      if (!e) continue;
      const name = `${e.student.firstName} ${e.student.lastName}`.trim();
      const item = await this.ifCreated(schoolId, {
        type: LOIS_INSIGHT_TYPES.ATTENDANCE_RISK,
        severity: row._count._all >= 7 ? 'critical' : 'warning',
        title: `${name} missed ${row._count._all} days in 14 days`,
        summary: `${name} has ${row._count._all} recorded absences in the last two weeks.`,
        evidence: {
          studentId: e.studentId,
          absentDays: row._count._all,
          since: since.toISOString().slice(0, 10),
        },
        studentIds: [e.studentId],
        classIds: e.classId ? [e.classId] : [],
        href: `/dashboard/school/students/${e.studentId}`,
        askPrompt: `Why is ${name}'s attendance a concern, and what should we do?`,
        fingerprint: `ATTENDANCE_RISK:${e.studentId}:${week}`,
      });
      if (item) created.push(item);
    }

    return created;
  }

  private async captureFeeArrears(schoolId: string): Promise<CreatedInsight[]> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const week = weekStartYmd();

    const overdue = await this.prisma.fee.findMany({
      where: {
        schoolId,
        paidDate: null,
        dueDate: { lt: today },
        status: { notIn: ['PAID', 'WAIVED', 'CANCELLED'] },
        enrollment: { schoolId, isActive: true },
      },
      take: 80,
      select: {
        amount: true,
        description: true,
        dueDate: true,
        enrollment: {
          select: {
            studentId: true,
            student: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    if (overdue.length === 0) return [];

    let total = 0;
    const byStudent = new Map<string, { studentId: string; name: string; count: number; amount: number }>();
    for (const fee of overdue) {
      const amount = Number(fee.amount) || 0;
      total += amount;
      const id = fee.enrollment.studentId;
      const existing = byStudent.get(id);
      if (existing) {
        existing.count += 1;
        existing.amount += amount;
      } else {
        byStudent.set(id, {
          studentId: id,
          name: `${fee.enrollment.student.firstName} ${fee.enrollment.student.lastName}`.trim(),
          count: 1,
          amount,
        });
      }
    }

    const families = [...byStudent.values()].sort((a, b) => b.amount - a.amount);
    const preview = families.slice(0, 8).map((f) => ({
      studentId: f.studentId,
      studentName: f.name,
      unpaidCount: f.count,
      unpaidAmount: Math.round(f.amount * 100) / 100,
    }));

    const roundedTotal = Math.round(total * 100) / 100;
    const row = await this.ifCreated(schoolId, {
      type: LOIS_INSIGHT_TYPES.FEE_ARREARS,
      severity: families.length >= 10 ? 'critical' : 'warning',
      title: `${families.length} student${families.length === 1 ? '' : 's'} with overdue fees`,
      summary: `${overdue.length} overdue invoice${overdue.length === 1 ? '' : 's'} totalling ${roundedTotal}. ${preview
        .slice(0, 5)
        .map((p) => p.studentName)
        .join(', ')}`,
      evidence: {
        overdueCount: overdue.length,
        studentCount: families.length,
        totalAmount: roundedTotal,
        students: preview,
      },
      studentIds: preview.map((p) => p.studentId),
      href: '/dashboard/school/students',
      askPrompt: 'Who has overdue school fees, and what should we follow up on this week?',
      fingerprint: `FEE_ARREARS:${week}`,
    });

    return row ? [row] : [];
  }

  private async captureAdmissionsBacklog(schoolId: string): Promise<CreatedInsight[]> {
    const week = weekStartYmd();
    const staleSince = new Date();
    staleSince.setUTCDate(staleSince.getUTCDate() - 7);
    staleSince.setUTCHours(0, 0, 0, 0);

    const [pendingTotal, staleRows] = await Promise.all([
      this.prisma.admissionApplication.count({
        where: { schoolId, status: AdmissionStatus.PENDING },
      }),
      this.prisma.admissionApplication.findMany({
        where: {
          schoolId,
          status: AdmissionStatus.PENDING,
          createdAt: { lt: staleSince },
        },
        orderBy: { createdAt: 'asc' },
        take: 12,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          classLevel: true,
          createdAt: true,
        },
      }),
    ]);

    if (staleRows.length < 3 && pendingTotal < 8) return [];

    const preview = staleRows.map((a) => ({
      applicationId: a.id,
      name: `${a.firstName} ${a.lastName}`.trim(),
      classLevel: a.classLevel,
      submittedAt: a.createdAt.toISOString().slice(0, 10),
    }));

    const title =
      staleRows.length >= 3
        ? `${staleRows.length}+ admission applications waiting over a week`
        : `${pendingTotal} pending admission applications`;

    const row = await this.ifCreated(schoolId, {
      type: LOIS_INSIGHT_TYPES.ADMISSIONS_BACKLOG,
      severity: staleRows.length >= 8 ? 'critical' : 'warning',
      title,
      summary: preview.length
        ? preview.map((p) => `${p.name} (${p.submittedAt})`).join(', ')
        : `${pendingTotal} applications still pending review.`,
      evidence: {
        pendingTotal,
        staleCount: staleRows.length,
        staleSince: staleSince.toISOString().slice(0, 10),
        applications: preview,
      },
      href: '/dashboard/school/applications',
      askPrompt: 'What is outstanding in the admissions inbox, and who should we review first?',
      fingerprint: `ADMISSIONS_BACKLOG:${week}`,
    });

    return row ? [row] : [];
  }
}
