import { BadRequestException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SchemeGenerationMode, SchemeOfWorkStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { agoraGradeLevelCandidates } from '../schools/curriculum/dto/nerdc-curriculum.dto';
import {
  computeCalendarCoverage,
  coverageFromStoredWeeks,
} from '../schools/curriculum/scheme-calendar-packer.util';
import type { CurriculumService } from '../schools/curriculum/curriculum.service';
import type { SchemeSpineService } from '../schools/curriculum/scheme-spine.service';
import { UserWithContext } from '../auth/types/user-with-context.type';
import { TimetableCuratorService } from '../timetable/timetable-curator.service';
import { DEFAULT_LIBRARY_TERM_WEEKS } from '../timetable/timetable-curator.constants';
import { AgentToolContext, AgentToolResult, toolSource } from './ai-lois-source';
import { AiStaffPermissionCheckerService } from './ai-staff-permission-checker.service';
import { LoisPendingPlanService, type PendingPlanApplyKind } from './lois-pending-plan.service';
import { payloadClassLabel } from './lois-plan-facing';

@Injectable()
export class AiCuratorToolsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TimetableCuratorService))
    private readonly curator: TimetableCuratorService,
    private readonly plans: LoisPendingPlanService,
    private readonly staffPermissions: AiStaffPermissionCheckerService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Lazy: CurriculumModule imports AiModule, so these must not be static constructor deps. */
  private getSchemeSpine(): SchemeSpineService {
    const { SchemeSpineService: Ctor } = require('../schools/curriculum/scheme-spine.service') as typeof import('../schools/curriculum/scheme-spine.service');
    return this.moduleRef.get(Ctor, { strict: false });
  }

  private getCurriculum(): CurriculumService {
    const { CurriculumService: Ctor } = require('../schools/curriculum/curriculum.service') as typeof import('../schools/curriculum/curriculum.service');
    return this.moduleRef.get(Ctor, { strict: false });
  }

  async inspectScheduling(args: any, context?: AgentToolContext): Promise<AgentToolResult> {
    const schoolId = context?.schoolId;
    if (!schoolId) return { data: { error: 'School context is required.' }, usage: null };
    const data = await this.curator.inspect(schoolId, {
      termId: args.termId,
      classId: args.classId,
      classArmId: args.classArmId,
      classQuery: args.classQuery,
    });
    if (data && typeof data === 'object' && 'error' in data && (data as any).error) {
      return { data, usage: null };
    }
    const snapshot = data as any;
    const nextHint = !snapshot.hasExistingTimetable
      ? 'No timetable yet. Call propose_timetable after confirming the class. Do not claim it is saved.'
      : 'A timetable already exists. Propose will fill empty slots only unless the user asks to replace it.';
    const missingTeachers = snapshot.subjectsWithoutTeachers || [];
    const curriculumHint =
      Array.isArray(snapshot.subjects) && snapshot.subjects.some((s: any) => !s.hasScheme)
        ? 'Some timetable subjects have no scheme of work yet. Offer to inspect curriculum options after the timetable exists.'
        : undefined;
    return {
      data: { ...snapshot, nextHint, missingTeachersNote: missingTeachers.length
        ? `${missingTeachers.map((s: any) => s.name).join(', ')} have no teachers. Slots can still be created unassigned.`
        : undefined, curriculumHint },
      usage: null,
      sources: [toolSource('inspect_scheduling_context', snapshot.classLabel || 'Scheduling', '/dashboard/school/timetables')],
    };
  }

  async inspectCurriculum(args: any, context?: AgentToolContext): Promise<AgentToolResult> {
    const schoolId = context?.schoolId;
    if (!schoolId) return { data: { error: 'School context is required.' }, usage: null };

    const scheduling = await this.curator.inspect(schoolId, {
      termId: args.termId,
      classId: args.classId,
      classArmId: args.classArmId,
      classQuery: args.classQuery,
    });
    if (scheduling && typeof scheduling === 'object' && 'error' in scheduling && (scheduling as any).error) {
      return { data: scheduling, usage: null };
    }
    const snap = scheduling as any;
    if (!snap.classLevelId) {
      return {
        data: {
          ...snap,
          timetableExists: snap.hasExistingTimetable,
          nextHint: 'Resolve a class level (e.g. Primary 1) before proposing a curriculum.',
        },
        usage: null,
      };
    }

    let instructionalWeeks = 0;
    try {
      const { ranges } = await this.getSchemeSpine().buildWeekRanges(schoolId, snap.termId);
      instructionalWeeks = ranges.length;
    } catch {
      instructionalWeeks = 0;
    }

    const classLevel = await this.prisma.classLevel.findFirst({
      where: { id: snap.classLevelId, schoolId },
      select: { name: true },
    });
    const gradeName = classLevel?.name || snap.classLabel;

    const subjects = await this.prisma.subject.findMany({
      where: { schoolId, isActive: true, OR: [{ schoolType: snap.schoolType }, { schoolType: null }] },
      select: { id: true, name: true, agoraSubjectId: true, code: true },
      take: 40,
    });

    const schemes = await (this.prisma as any).schemeOfWork.findMany({
      where: {
        schoolId,
        classLevelId: snap.classLevelId,
        termId: snap.termId,
        status: { not: SchemeOfWorkStatus.ARCHIVED },
      },
      include: { weeks: { select: { assessmentType: true, calendarStartDate: true } } },
    });
    const schemeBySubject = new Map(schemes.map((s: any) => [s.subjectId, s]));

    const gradeLevels = agoraGradeLevelCandidates(gradeName);
    const agoraIds = [...new Set(subjects.map((s) => s.agoraSubjectId).filter(Boolean))] as string[];
    const curricula = agoraIds.length
      ? await (this.prisma as any).agoraCurriculum.findMany({
          where: {
            subjectId: { in: agoraIds },
            gradeLevel: { in: gradeLevels },
            status: 'PUBLISHED',
          },
          select: {
            id: true,
            subjectId: true,
            gradeLevel: true,
            version: true,
            topics: { select: { id: true, term: true } },
            subject: { select: { name: true } },
          },
        })
      : [];

    const library = curricula.map((c: any) => {
      const planWeeks = c.topics?.length || DEFAULT_LIBRARY_TERM_WEEKS;
      const coverage = computeCalendarCoverage({
        instructionalWeeks,
        planWeeks,
        unscheduledWeeks: Math.max(0, planWeeks - instructionalWeeks),
        bufferWeeks: Math.max(0, instructionalWeeks - planWeeks),
      });
      return {
        agoraCurriculumId: c.id,
        subject: c.subject?.name,
        agoraSubjectId: c.subjectId,
        gradeLevel: c.gradeLevel,
        version: c.version,
        planWeeks,
        instructionalWeeks,
        coverage: coverage.mismatch,
        unscheduledWeeks: coverage.unscheduledWeeks,
        bufferWeeks: coverage.bufferWeeks,
      };
    });

    const subjectStatus = subjects.map((s) => {
      const scheme: any = schemeBySubject.get(s.id);
      const coverage = scheme
        ? coverageFromStoredWeeks(scheme.weeks || [], instructionalWeeks)
        : null;
      const libraryMatch = library.filter(
        (l: any) => l.agoraSubjectId === s.agoraSubjectId || l.subject === s.name,
      );
      return {
        subjectId: s.id,
        name: s.name,
        schemeStatus: scheme?.status || 'NOT_SET_UP',
        schemeId: scheme?.id || null,
        planWeeks: coverage?.planWeeks ?? 0,
        instructionalWeeks,
        calendarMismatch: coverage?.mismatch ?? null,
        library: libraryMatch,
      };
    });

    const onGridIds = new Set(
      ((snap.subjectsOnGrid || []) as Array<{ id: string }>).map((s) => s.id),
    );
    const subjectsOnTimetableWithoutScheme = subjectStatus.filter(
      (s) => onGridIds.has(s.subjectId) && s.schemeStatus === 'NOT_SET_UP',
    );
    const schemesWithoutTimetablePeriods = subjectStatus.filter(
      (s) => s.schemeStatus !== 'NOT_SET_UP' && onGridIds.size > 0 && !onGridIds.has(s.subjectId),
    );

    let nextHint: string;
    if (!snap.hasExistingTimetable) {
      nextHint =
        'This class has no timetable yet. Suggest creating a timetable first so subjects and periods are known. Do not auto-apply both. Never propose a timetable and a scheme in the same reply.';
    } else if (subjectStatus.every((s) => s.schemeStatus === 'NOT_SET_UP')) {
      nextHint =
        'Timetable exists but no schemes. Show Bud library week counts vs teachable weeks, then propose_scheme after the user picks a subject and mode. Do not also apply a timetable in this turn.';
    } else {
      nextHint =
        'Timetable and some schemes exist. Report gaps: subjects on the grid without a scheme, or schemes with no matching timetable periods. Never apply two domains in one turn.';
    }

    return {
      data: {
        classLabel: snap.classLabel,
        classLevelId: snap.classLevelId,
        classId: snap.classId,
        classArmId: snap.classArmId,
        termId: snap.termId,
        instructionalWeeks,
        timetableExists: !!snap.hasExistingTimetable,
        subjects: subjectStatus,
        libraryPreview: library.slice(0, 12),
        gaps: {
          subjectsOnTimetableWithoutScheme: subjectsOnTimetableWithoutScheme.map((s) => ({
            subjectId: s.subjectId,
            name: s.name,
          })),
          schemesWithoutTimetablePeriods: schemesWithoutTimetablePeriods.map((s) => ({
            subjectId: s.subjectId,
            name: s.name,
            schemeStatus: s.schemeStatus,
          })),
        },
        nextHint,
      },
      usage: null,
      sources: [
        toolSource('inspect_curriculum_options', gradeName, '/dashboard/school/curriculum'),
      ],
    };
  }

  async proposeTimetable(args: any, context?: AgentToolContext): Promise<AgentToolResult> {
    const schoolId = context?.schoolId;
    const userId = context?.userId;
    if (!schoolId || !userId) return { data: { error: 'School and user context are required.' }, usage: null };

    const term = await this.curator.resolveTermId(schoolId, args.termId);
    if ('error' in term) {
      return { data: { error: term.error }, usage: null };
    }

    let classId = args.classId;
    let classArmId = args.classArmId;
    if (!classId && !classArmId) {
      const snap = await this.curator.inspect(schoolId, {
        termId: term.termId,
        classQuery: args.classQuery,
      });
      if (snap && typeof snap === 'object' && 'error' in snap && (snap as any).error) {
        return { data: snap, usage: null };
      }
      classId = (snap as any).classId;
      classArmId = (snap as any).classArmId;
    }

    const mode = args.mode === 'REPLACE' ? 'REPLACE' : 'FILL_EMPTY';
    let preview;
    try {
      preview = await this.curator.preview(schoolId, {
        termId: term.termId,
        classId,
        classArmId,
        mode,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (/term not found/i.test(message)) {
        const fallback = await this.curator.resolveTermId(schoolId);
        if ('error' in fallback) {
          return { data: { error: fallback.error }, usage: null };
        }
        try {
          preview = await this.curator.preview(schoolId, {
            termId: fallback.termId,
            classId,
            classArmId,
            mode,
          });
        } catch (retryErr: unknown) {
          return {
            data: {
              error:
                retryErr instanceof Error && /term not found/i.test(retryErr.message)
                  ? 'No active term. Create a session and term first.'
                  : retryErr instanceof Error
                    ? retryErr.message
                    : 'Could not generate this timetable.',
            },
            usage: null,
          };
        }
      } else {
        return {
          data: {
            error: err instanceof Error ? err.message : 'Could not generate this timetable.',
          },
          usage: null,
        };
      }
    }

    const summary = [
      `Proposed timetable for ${preview.classLabel}.`,
      `${preview.analysis.totalPeriods} taught periods, ${preview.analysis.freePeriods} free.`,
      preview.analysis.warnings[0] || 'No workload warnings.',
      'Not saved yet. Say apply all, or use Apply on the cards.',
    ].join(' ');

    const plan = await this.plans.create({
      userId,
      schoolId,
      conversationId: context.conversationId,
      kind: 'TIMETABLE',
      payload: {
        termId: preview.termId,
        classId: preview.classId,
        classArmId: preview.classArmId,
        classLabel: preview.classLabel,
        mode,
        periods: preview.periods,
      },
      summary,
    });

    return {
      data: {
        planId: plan.id,
        expiresAt: plan.expiresAt,
        kind: 'TIMETABLE',
        mode,
        classLabel: preview.classLabel,
        hasExistingTimetable: preview.hasExistingTimetable,
        analysis: preview.analysis,
        subjectsWithoutTeachers: preview.subjectsWithoutTeachers,
        primaryClassTeacher: preview.primaryClassTeacher,
        periodCount: preview.periods.length,
        saved: false,
        message: summary,
        warnings: [
          ...(preview.analysis.warnings || []),
          mode === 'REPLACE'
            ? 'Replace mode: applying this will overwrite the existing timetable.'
            : 'Fill-empty: existing subjects and teachers stay.',
        ],
      },
      usage: null,
      sources: [toolSource('propose_timetable', preview.classLabel, '/dashboard/school/timetables')],
    };
  }

  async proposeScheme(args: any, context?: AgentToolContext): Promise<AgentToolResult> {
    const schoolId = context?.schoolId;
    const userId = context?.userId;
    if (!schoolId || !userId) return { data: { error: 'School and user context are required.' }, usage: null };
    if (!args.classLevelId || !args.subjectId) {
      return {
        data: { error: 'classLevelId and subjectId are required. Use inspect_curriculum_options first.' },
        usage: null,
      };
    }

    const mode = (args.mode as SchemeGenerationMode) || SchemeGenerationMode.AGORA_ONLY;
    if (mode === SchemeGenerationMode.AGORA_ONLY && !args.agoraCurriculumId) {
      return {
        data: { error: 'agoraCurriculumId is required for library mode. Pick one from inspect_curriculum_options.' },
        usage: null,
      };
    }
    if ((mode === SchemeGenerationMode.SCHOOL_ONLY || mode === SchemeGenerationMode.MERGED) && !args.schoolCurriculumDocId) {
      return {
        data: {
          error:
            'School document id is required for custom/merge mode. Ask the admin to upload in the curriculum modal, then continue.',
        },
        usage: null,
      };
    }

    const classLabel = await this.schemeClassLabel(schoolId, args.classLevelId, args.subjectId);
    const payload = {
      classLevelId: args.classLevelId,
      classId: args.classId,
      subjectId: args.subjectId,
      termId: args.termId,
      mode,
      agoraCurriculumId: args.agoraCurriculumId,
      schoolCurriculumDocId: args.schoolCurriculumDocId,
      forceOverwrite: !!args.forceOverwrite,
      mergeWeightAgora: args.mergeWeightAgora,
      mergeWeightSchool: args.mergeWeightSchool,
      classLabel,
    };

    const summary = `Proposed ${mode} scheme for ${classLabel}. Not generated yet. Say apply, or use Apply on the card.`;
    const plan = await this.plans.create({
      userId,
      schoolId,
      conversationId: context.conversationId,
      kind: 'SCHEME',
      payload,
      summary,
    });

    return {
      data: {
        planId: plan.id,
        expiresAt: plan.expiresAt,
        kind: 'SCHEME',
        saved: false,
        ...payload,
        message: summary,
        warnings:
          mode === SchemeGenerationMode.SCHOOL_ONLY || mode === SchemeGenerationMode.MERGED
            ? ['Generating from a school document uses AI credits when you Apply.']
            : ['Library snapshot does not spend extra solver credits. Apply to create the draft.'],
      },
      usage: null,
      sources: [toolSource('propose_scheme', 'Scheme proposal', '/dashboard/school/curriculum')],
    };
  }

  async applyPlan(
    planId: string,
    context: { schoolId: string; userId: string; user?: UserWithContext; conversationId?: string | null },
  ) {
    const plan = await this.plans.getActive(planId, context.userId, context.schoolId, context.conversationId);
    if (plan.kind === 'TIMETABLE') {
      const payload = plan.payload as any;
      const result = await this.curator.apply(context.schoolId, {
        termId: payload.termId,
        classId: payload.classId,
        classArmId: payload.classArmId,
        mode: payload.mode,
        periods: payload.periods,
      });
      await this.plans.markApplied(planId);
      return {
        kind: 'TIMETABLE',
        replaced: result.replaced,
        classLabel: result.preview.classLabel,
        warnings: result.preview.analysis.warnings,
        message: `Saved ${result.replaced} periods for ${result.preview.classLabel}.`,
      };
    }

    if (plan.kind === 'SCHEME') {
      await this.curator.assertAgoraAiAccess(context.schoolId);
      const payload = plan.payload as any;
      const user = context.user;
      if (!user) throw new BadRequestException('User context is required to generate a scheme.');
      const scheme = await this.getCurriculum().setupSchemeOfWork(context.schoolId, payload, user);
      await this.plans.markApplied(planId);
      return {
        kind: 'SCHEME',
        schemeId: scheme?.id,
        status: scheme?.status,
        classLabel: payload.classLabel,
        message: payload.classLabel
          ? `Scheme generation started for ${payload.classLabel}. It will appear as a draft when Lois finishes.`
          : 'Scheme generation started. It will appear as a draft when Lois finishes.',
      };
    }

    throw new BadRequestException('Unknown plan kind.');
  }

  async applyPendingPlans(args: any, context?: AgentToolContext): Promise<AgentToolResult> {
    const schoolId = context?.schoolId;
    const userId = context?.userId;
    if (!schoolId || !userId) {
      return { data: { error: 'School and user context are required.' }, usage: null };
    }

    const scope = args.scope === 'NAMED' ? 'NAMED' : 'ALL_PENDING';
    const kind: PendingPlanApplyKind =
      args.kind === 'SCHEME' || args.kind === 'ALL' ? args.kind : 'TIMETABLE';
    const classQueries = Array.isArray(args.classQueries)
      ? args.classQueries.filter((q: unknown) => typeof q === 'string')
      : [];

    const listed = await this.plans.listActive({
      userId,
      schoolId,
      conversationId: context.conversationId,
      kind,
    });

    let selected = listed;
    const unmatchedQueries: string[] = [];
    if (scope === 'NAMED') {
      if (classQueries.length === 0) {
        return {
          data: {
            applied: [],
            failed: [{ classLabel: 'those classes', error: 'Name the class to apply, or say apply all.' }],
          },
          usage: null,
        };
      }
      const matched = this.plans.matchByClassQueries(listed, classQueries);
      selected = matched.matched;
      unmatchedQueries.push(...matched.unmatchedQueries);
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const applyContext = {
      schoolId,
      userId,
      user: user ? ({ ...user, currentSchoolId: schoolId } as UserWithContext) : undefined,
      conversationId: context.conversationId,
    };

    const applied: Array<{ classLabel: string; message: string }> = [];
    const failed: Array<{ classLabel: string; error: string }> = [];

    for (const query of unmatchedQueries) {
      failed.push({ classLabel: query, error: 'No pending plan matches that class in this chat.' });
    }

    for (const plan of selected) {
      const classLabel =
        payloadClassLabel(plan.payload) ||
        (plan.kind === 'SCHEME' ? 'this scheme' : 'this class');
      try {
        await this.staffPermissions.assertLoisPlanWrite({
          kind: plan.kind,
          userRole: context.userRole,
          userId,
          schoolId,
        });
        const result = await this.applyPlan(plan.id, applyContext);
        applied.push({
          classLabel: result.classLabel || classLabel,
          message: result.message,
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Could not apply this plan. Ask Lois to propose again.';
        failed.push({ classLabel, error: message });
      }
    }

    if (applied.length === 0 && failed.length === 0) {
      const noun = kind === 'SCHEME' ? 'schemes' : kind === 'ALL' ? 'plans' : 'timetables';
      return {
        data: {
          applied: [],
          failed: [],
          message: `There are no pending ${noun} to apply in this chat.`,
        },
        usage: null,
      };
    }

    const savedLabels = applied.map((row) => row.classLabel).filter(Boolean);
    const message =
      applied.length > 0
        ? `Saved ${savedLabels.join(', ')}.`
        : 'Nothing was saved.';

    return {
      data: { applied, failed, message, saved: applied.length > 0 },
      usage: null,
      sources: [toolSource('apply_pending_plans', message, '/dashboard/school/timetables')],
    };
  }

  private async schemeClassLabel(
    schoolId: string,
    classLevelId?: string,
    subjectId?: string,
  ): Promise<string> {
    const [level, subject] = await Promise.all([
      classLevelId
        ? this.prisma.classLevel.findFirst({
            where: { id: classLevelId, schoolId },
            select: { name: true },
          })
        : null,
      subjectId
        ? this.prisma.subject.findFirst({
            where: { id: subjectId, schoolId },
            select: { name: true },
          })
        : null,
    ]);
    const bits = [level?.name, subject?.name].filter(Boolean);
    return bits.length ? bits.join(' · ') : 'this subject';
  }
}
