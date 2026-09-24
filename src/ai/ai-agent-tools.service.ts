import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AiContentGeneratorsService } from './ai-content-generators.service';
import { AiContextRagService } from './ai-context-rag.service';
import { AiInsightsService } from './ai-insights.service';
import { AgentToolContext, AgentToolResult, toolSource } from './ai-lois-source';
import { AiSchoolInsightsService } from './ai-school-insights.service';
import { AiSchoolQueryService } from './ai-school-query.service';
import { AiStaffPermissionCheckerService } from './ai-staff-permission-checker.service';
import { AiCuratorToolsService } from './ai-curator-tools.service';
import {
  PermissionResource,
  PermissionType,
  hasPrincipalAccess,
} from '../schools/dto/permission.dto';

export type { AgentToolContext };

/**
 * Lois agent tool execution: typed school queries, semantic search, and content generators.
 */
@Injectable()
export class AiAgentToolsService {
  private readonly logger = new Logger(AiAgentToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generators: AiContentGeneratorsService,
    private readonly contextRag: AiContextRagService,
    private readonly schoolInsights: AiSchoolInsightsService,
    private readonly schoolQuery: AiSchoolQueryService,
    private readonly insights: AiInsightsService,
    private readonly staffPermissionChecker: AiStaffPermissionCheckerService,
    private readonly curatorTools: AiCuratorToolsService,
  ) {}

  getToolDisplayName(toolName: string): string {
    const names: Record<string, string> = {
      generate_lesson_plan: 'Lesson plan',
      generate_quiz: 'Quiz generator',
      generate_flashcards: 'Flashcards',
      generate_summary: 'Study summary',
      generate_assessment: 'Assessment builder',
      grade_essay: 'Essay grader',
      search_semantic: 'Knowledge base',
      get_school_stats: 'School snapshot',
      get_academic_risk_summary: 'Academic risk',
      list_students: 'Student list',
      list_classes: 'Classes',
      get_student_overview: 'Student overview',
      get_class_performance: 'Class performance',
      get_scheme_of_work: 'Scheme of work',
      get_now_in_class: 'Current period',
      get_timetable: 'Class timetable',
      list_staff: 'Staff directory',
      who_teaches: 'Who teaches',
      get_attendance_summary: 'Attendance',
      list_fee_debtors: 'Fee debtors',
      list_admissions: 'Admissions',
      get_calendar: 'School calendar',
      get_guardians: 'Guardians',
      list_lois_insights: 'Lois insights',
      draft_parent_message: 'Parent message draft',
      inspect_scheduling_context: 'Scheduling inspect',
      inspect_curriculum_options: 'Curriculum inspect',
      propose_timetable: 'Timetable proposal',
      propose_scheme: 'Scheme proposal',
      apply_pending_plans: 'Apply previews',
    };
    return names[toolName] || toolName.replace(/_/g, ' ');
  }

  getToolThinkingMessage(toolName: string): string {
    const messages: Record<string, string> = {
      generate_lesson_plan: "I'll craft a detailed lesson plan for you...",
      generate_quiz: 'Let me generate some quiz questions...',
      generate_flashcards: 'Creating study flashcards for you...',
      generate_summary: 'Let me prepare a comprehensive study summary...',
      generate_assessment: 'Building formal assessment questions...',
      grade_essay: 'Analyzing the essay for grading...',
      search_semantic: "Checking the school's knowledge base...",
      get_school_stats: 'Gathering the latest school statistics...',
      get_academic_risk_summary: 'Reviewing published grades below the performance threshold...',
      list_students: 'Looking up enrolled students...',
      list_classes: 'Looking up classes...',
      get_student_overview: 'Loading this student record...',
      get_class_performance: 'Summarising class grades...',
      get_scheme_of_work: 'Checking the published scheme of work...',
      get_now_in_class: 'Checking the timetable for right now...',
      get_timetable: 'Loading the class timetable...',
      list_staff: 'Looking up staff...',
      who_teaches: 'Checking who teaches that class...',
      get_attendance_summary: 'Reviewing recent attendance...',
      list_fee_debtors: 'Checking outstanding fees...',
      list_admissions: 'Opening admission applications...',
      get_calendar: 'Checking the school calendar...',
      get_guardians: 'Looking up parent contacts...',
      list_lois_insights: 'Opening what Lois already noticed...',
      draft_parent_message: 'Drafting a parent update (will not send)...',
      inspect_scheduling_context: 'Checking this class timetable, subjects, and teachers...',
      inspect_curriculum_options: 'Checking Bud library weeks against your term calendar...',
      propose_timetable: 'Drafting a timetable preview (not saved yet)...',
      propose_scheme: 'Drafting a scheme proposal (not generated yet)...',
      apply_pending_plans: 'Saving the previews you asked to apply...',
    };
    return messages[toolName] || 'Processing your request...';
  }

  async executeAgentTool(
    toolName: string,
    args: any,
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    await this.staffPermissionChecker.assertLoisToolAllowed({
      toolName,
      userRole: context?.userRole,
      userId: context?.userId,
      schoolId: context?.schoolId,
    });

    const scopedContext = await this.withAdminScope(context);

    switch (toolName) {
      case 'generate_lesson_plan':
        return this.generators.generateLessonPlan({
          topic: args.topic || 'General Topic',
          subject: args.subject || 'General Studies',
          gradeLevel: args.gradeLevel || 'Any',
          objectives: args.objectives || ['Understand key concepts', 'Apply knowledge practically'],
          duration: args.duration || 40,
        });

      case 'generate_quiz': {
        const prepared = await this.prepareSchemeAssessment(args, context, 'QUIZ');
        if (prepared.halted === true) return prepared.halt;
        const topicLine = prepared.weeks.map((week) => `Week ${week.weekNumber}: ${week.topic}`).join('; ');
        const res = await this.generators.generateQuiz({
          topic: topicLine || args.topic || 'Quick Quiz',
          subject: prepared.subjectName,
          gradeLevel: prepared.className || args.gradeLevel || 'Any',
          questionCount: args.questionCount || 5,
          questionTypes: args.questionTypes || ['multiple_choice'],
          difficulty: args.difficulty || 'medium',
        });
        return {
          data: {
            questions: res.data,
            title: args.topic || 'Quiz',
            subject: prepared.subjectName,
            subjectId: prepared.subjectId,
            classId: prepared.classId,
            className: prepared.className,
            type: 'QUIZ',
            gradeLevel: prepared.className,
          },
          usage: res.usage,
        };
      }

      case 'generate_flashcards':
        return this.generators.generateFlashcards({
          topic: args.topic || 'General Revision',
          subject: args.subject || 'General',
          gradeLevel: args.gradeLevel || 'Any',
          count: args.count || 10,
        });

      case 'generate_summary':
        return this.generators.generateSummary({
          topic: args.topic || 'Content Summary',
          subject: args.subject || 'General',
          gradeLevel: args.gradeLevel || 'Any',
        });

      case 'generate_assessment': {
        const kind = String(args.assessmentType || '').toUpperCase() === 'EXAM' ? 'EXAM' : 'ASSIGNMENT';
        const prepared = await this.prepareSchemeAssessment(args, context, kind);
        if (prepared.halted === true) return prepared.halt;
        const res = await this.generators.generateAssessmentQuestions({
          topic: args.topic || kind,
          subject: prepared.subjectName,
          gradeLevel: prepared.className || args.gradeLevel || 'Any',
          questionCount: args.questionCount || 5,
          questionTypes: args.questionTypes || ['multiple_choice', 'short_answer'],
          difficulty: args.difficulty || 'mixed',
          gradeType: kind,
          weeks: prepared.weeks,
        });
        const questions = Array.isArray(res.data) ? res.data : [];
        return {
          data: {
            questions,
            title: args.topic || kind,
            subject: prepared.subjectName,
            gradeLevel: prepared.className || args.gradeLevel || '',
            subjectId: prepared.subjectId,
            classId: prepared.classId,
            className: prepared.className,
            type: kind,
            dueDate: prepared.examDate,
          },
          usage: res.usage,
        };
      }

      case 'grade_essay':
        return this.generators.gradeEssay({
          essay: args.essay,
          prompt: args.prompt,
          subject: args.subject,
          gradeLevel: args.gradeLevel,
          rubric: args.rubric,
          maxScore: args.maxScore || 100,
        });

      case 'get_school_stats':
        return this.getSchoolStats(scopedContext?.schoolId, scopedContext?.schoolType);

      case 'list_students':
        return this.schoolQuery.listStudents(args || {}, scopedContext);

      case 'list_classes':
        return this.redactListClasses(
          await this.schoolQuery.listClasses(args || {}, scopedContext),
          scopedContext,
        );

      case 'get_student_overview':
        return this.schoolQuery.getStudentOverview(args || {}, scopedContext);

      case 'get_class_performance':
        return this.schoolQuery.getClassPerformance(args || {}, scopedContext);

      case 'get_scheme_of_work':
        return this.schoolQuery.getSchemeOfWork(args || {}, scopedContext);

      case 'get_now_in_class':
        return this.schoolQuery.getNowInClass(args || {}, scopedContext);

      case 'get_timetable':
        return this.schoolQuery.getTimetable(args || {}, scopedContext);

      case 'list_staff':
        return this.schoolQuery.listStaff(args || {}, scopedContext);

      case 'who_teaches':
        return this.schoolQuery.whoTeaches(args || {}, scopedContext);

      case 'get_attendance_summary':
        return this.schoolQuery.getAttendanceSummary(args || {}, scopedContext);

      case 'list_fee_debtors':
        return this.schoolQuery.listFeeDebtors(args || {}, scopedContext);

      case 'list_admissions':
        return this.schoolQuery.listAdmissions(args || {}, scopedContext);

      case 'get_calendar':
        return this.schoolQuery.getCalendar(args || {}, scopedContext);

      case 'get_guardians':
        return this.schoolQuery.getGuardians(args || {}, scopedContext);

      case 'list_lois_insights':
        return this.insights.listForTool(args || {}, scopedContext);

      case 'draft_parent_message':
        return this.schoolQuery.draftParentMessage(args || {}, scopedContext);

      case 'inspect_scheduling_context':
        return this.curatorTools.inspectScheduling(args || {}, scopedContext);

      case 'inspect_curriculum_options':
        return this.curatorTools.inspectCurriculum(args || {}, scopedContext);

      case 'propose_timetable':
        return this.curatorTools.proposeTimetable(args || {}, scopedContext);

      case 'propose_scheme':
        return this.curatorTools.proposeScheme(args || {}, scopedContext);

      case 'apply_pending_plans':
        return this.curatorTools.applyPendingPlans(args || {}, scopedContext);

      case 'search_semantic':
        return this.searchSemantic(
          args.query,
          args.limit,
          scopedContext?.schoolId,
          scopedContext?.userRole,
          scopedContext?.userId,
        );

      case 'get_academic_risk_summary':
        return this.getAcademicRiskSummary(args, scopedContext);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async getAcademicRiskSummary(
    args: { thresholdPercent?: number; limit?: number },
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const schoolId = context?.schoolId;
    if (!schoolId) {
      return { data: { error: 'School context is required.' }, usage: null };
    }

    const role = context?.userRole;
    const canSchoolWide = role === 'SCHOOL_ADMIN' || role === 'SUPER_ADMIN';
    const isTeacher = role === 'TEACHER';

    if (!canSchoolWide && !isTeacher) {
      return {
        data: { error: 'Only school administrators and teachers can view academic risk summaries.' },
        usage: null,
      };
    }

    let studentFilter: Set<string> | null = null;
    if (isTeacher) {
      if (!context?.userId) {
        return { data: { error: 'User context is required for teacher risk views.' }, usage: null };
      }
      const access = await this.schoolInsights.resolveTeacherRagAccess(context.userId, schoolId);
      if (!access || access.studentIds.size === 0) {
        return {
          data: {
            termId: await this.schoolInsights.getActiveTermId(schoolId),
            thresholdPercent: args.thresholdPercent ?? 45,
            students: [],
            message: 'No enrolled students found for your assignments, or no roster access.',
          },
          usage: null,
        };
      }
      studentFilter = access.studentIds;
    }

    const threshold = args.thresholdPercent ?? 45;
    const limit = args.limit ?? 25;
    const termId = await this.schoolInsights.getActiveTermId(schoolId);
    const students = await this.schoolInsights.findAtRiskStudents(schoolId, {
      termId,
      thresholdPercent: threshold,
      limit,
      studentIdFilter: studentFilter,
      useActiveTermWhenMissing: false,
    });

    return {
      data: {
        termId,
        thresholdPercent: threshold,
        scope: canSchoolWide ? 'school' : 'my_students',
        count: students.length,
        students: students.map((s) => ({
          studentId: s.studentId,
          name: `${s.firstName} ${s.lastName}`.trim(),
          avgPercent: Math.round(s.avgPercent * 10) / 10,
          gradeCount: s.gradeCount,
        })),
        message:
          students.length === 0
            ? 'No students are below the published-grade threshold. If the gradebook is empty this term, say that — do not claim everyone is thriving, and do not send them to an academic dashboard.'
            : undefined,
      },
      usage: null,
      sources: [
        toolSource(
          'get_academic_risk_summary',
          `${students.length} student${students.length === 1 ? '' : 's'} below ${threshold}%`,
          '/dashboard/school/students',
        ),
      ],
    };
  }

  async searchSemantic(query: string, limit?: number, schoolId?: string, role?: string, userId?: string) {
    const effectiveLimit = Math.min(limit ?? 5, 8);
    if (schoolId && role) {
      const { text, sources } = await this.contextRag.findRelevantContext(query, schoolId, role, effectiveLimit, {
        userId,
      });
      return {
        data: text
          ? { text, sources }
          : { text: 'No relevant knowledge base results found for this query.', sources: [] },
        usage: null,
        sources: (sources || []).map((s) => ({
          kind: 'rag' as const,
          type: s.type,
          label: s.type.replace(/_/g, ' '),
          relevance: s.relevance,
        })),
      };
    }
    return {
      data: {
        text: 'Semantic search requires school context. Please ensure you are in a school scope.',
        sources: [],
      },
      usage: null,
    };
  }

  async filterLoisToolNames(
    toolNames: readonly string[],
    context?: AgentToolContext,
  ): Promise<string[]> {
    return this.staffPermissionChecker.filterAllowedToolNames({
      toolNames,
      userRole: context?.userRole,
      userId: context?.userId,
      schoolId: context?.schoolId,
    });
  }

  private async withAdminScope(context?: AgentToolContext): Promise<AgentToolContext | undefined> {
    if (!context || context.userRole !== 'SCHOOL_ADMIN') return context;
    const scope = await this.staffPermissionChecker.getSchoolAdminScope(context.userId, context.schoolId);
    if (!scope) return context;
    return {
      ...context,
      schoolType: scope.schoolType,
      adminRole: scope.role,
      adminAccessTier: scope.accessTier,
      adminId: scope.adminId,
    };
  }

  private async redactListClasses(
    result: AgentToolResult,
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    const classes = (result.data as { classes?: Array<Record<string, unknown>> } | undefined)?.classes;
    if (!Array.isArray(classes) || context?.userRole !== 'SCHOOL_ADMIN' || !context.adminId) {
      return result;
    }
    if (hasPrincipalAccess({ accessTier: context.adminAccessTier })) {
      return result;
    }

    const [canSeeStudents, canSeeStaff] = await Promise.all([
      this.staffPermissionChecker.schoolAdminHasPermission(
        context.adminId,
        PermissionResource.STUDENTS,
        PermissionType.READ,
      ),
      this.staffPermissionChecker.schoolAdminHasPermission(
        context.adminId,
        PermissionResource.STAFF,
        PermissionType.READ,
      ),
    ]);

    return {
      ...result,
      data: {
        ...result.data,
        classes: classes.map((row) => ({
          ...row,
          enrollmentCount: canSeeStudents ? row.enrollmentCount : undefined,
          formTeacher: canSeeStudents || canSeeStaff ? row.formTeacher : undefined,
        })),
      },
    };
  }

  async getSchoolStats(schoolId?: string, schoolType?: string | null): Promise<AgentToolResult> {
    if (!schoolId) return { data: { error: 'School ID is required' }, usage: null };

    const [classCount, classArmCount, teacherCount, studentCount] = await Promise.all([
      this.prisma.class.count({
        where: { schoolId, ...(schoolType ? { type: schoolType } : {}) },
      }),
      this.prisma.classArm.count({
        where: {
          isActive: true,
          classLevel: { schoolId, isActive: true, ...(schoolType ? { type: schoolType } : {}) },
        },
      }),
      this.prisma.teacher.count({
        where: { schoolId, ...(schoolType ? { OR: [{ schoolType }, { schoolType: null }] } : {}) },
      }),
      this.prisma.enrollment.count({
        where: {
          schoolId,
          isActive: true,
          ...(schoolType
            ? {
                OR: [
                  { classArm: { classLevel: { type: schoolType } } },
                  { class: { type: schoolType } },
                ],
              }
            : {}),
        },
      }),
    ]);

    return {
      data: {
        classes: classArmCount,
        classArms: classArmCount,
        teachers: teacherCount,
        students: studentCount,
        totalPopulation: studentCount + teacherCount,
        note:
          classCount === 0 && classArmCount > 0
            ? 'classes/classArms is the number of active class arms. Do not say there are 0 classes.'
            : undefined,
      },
      usage: null,
      sources: [toolSource('get_school_stats', 'Live school counts', '/dashboard/school/overview')],
    };
  }

  /**
   * Scheme and exam-timetable gate. No questions until the teacher picks a scope,
   * and none at all when the scheme or the exam slot is missing.
   */
  private async prepareSchemeAssessment(
    args: any,
    context: AgentToolContext | undefined,
    kind: 'QUIZ' | 'ASSIGNMENT' | 'EXAM',
  ): Promise<
    | { halted: true; halt: { data: Record<string, unknown>; usage: null } }
    | {
        halted: false;
        classId: string;
        className: string;
        subjectId: string;
        subjectName: string;
        weeks: Array<{ weekNumber: number; topic: string; learningOutcomes: string[]; assessmentType?: string }>;
        examDate?: string;
      }
  > {
    const halt = (message: string, extra: Record<string, unknown> = {}) => ({
      halted: true as const,
      halt: { data: { blocked: true, message, ...extra }, usage: null as null },
    });

    if (!context?.schoolId) return halt('This assessment needs a school.');

    const matched = await this.matchTeacherClass(context, args.className || args.gradeLevel);
    if (!matched) {
      return halt('Name the class arm, for example JSS 2 A, before I write questions.');
    }

    const wantedSubject = String(args.subject || '').trim();
    const subject =
      (await this.prisma.subject.findFirst({
        where: {
          schoolId: context.schoolId,
          isActive: true,
          name: { equals: wantedSubject, mode: 'insensitive' },
        },
        select: { id: true, name: true },
      })) ||
      (await this.prisma.subject.findFirst({
        where: {
          schoolId: context.schoolId,
          isActive: true,
          name: { contains: wantedSubject, mode: 'insensitive' },
        },
        select: { id: true, name: true },
      }));
    if (!subject) return halt('That subject is not on this school.');

    const arm = await this.prisma.classArm.findFirst({
      where: { id: matched.id, classLevel: { schoolId: context.schoolId } },
      select: { id: true, classLevelId: true, classLevel: { select: { type: true } } },
    });
    if (!arm) return halt('That class is not on this school.');

    const session = await this.prisma.academicSession.findFirst({
      where: {
        schoolId: context.schoolId,
        status: 'ACTIVE',
        schoolType: arm.classLevel.type,
      },
      include: { terms: { where: { status: 'ACTIVE' }, take: 1 } },
    });
    const term = session?.terms[0];
    if (!term) return halt('There is no active term for this class.');

    let examDate: string | undefined;
    if (kind === 'EXAM') {
      const slot = term.examTimetablePublishedAt
        ? await this.prisma.examTimetableSlot.findFirst({
            where: { termId: term.id, subjectId: subject.id, classArmId: arm.id },
            orderBy: { examDate: 'asc' },
          })
        : null;
      if (!slot) {
        return halt('The exam timetable is not published for this class and subject.');
      }
      examDate = slot.examDate.toISOString().slice(0, 10);
    }

    const schemes = await this.prisma.schemeOfWork.findMany({
      where: {
        schoolId: context.schoolId,
        termId: term.id,
        subjectId: subject.id,
        status: 'PUBLISHED',
        OR: [
          { classArmId: arm.id },
          ...(arm.classLevelId ? [{ classLevelId: arm.classLevelId, classArmId: null }] : []),
        ],
      },
      include: { weeks: { orderBy: { weekNumber: 'asc' as const } } },
      orderBy: { updatedAt: 'desc' },
    });
    const scheme = schemes.find((row) => row.classArmId === arm.id) || schemes[0];
    if (!scheme || scheme.weeks.length === 0) {
      const teacher = context.userRole === 'TEACHER';
      return halt(
        `The scheme of work is not published for ${matched.name} ${subject.name}, so I can't write this from the scheme. Use manual assessment creation instead. Open this class's assessments from the link on the card.`,
        {
          reason: 'scheme_unpublished',
          className: matched.name,
          subjectName: subject.name,
          ...(teacher
            ? {
                assessmentsPath: `/dashboard/teacher/classes/${matched.id}?tab=assessments`,
                manualPath: `/dashboard/teacher/assessments/new?source=manual&classId=${matched.id}`,
              }
            : {}),
        },
      );
    }

    const deliveredIds = new Set(
      (
        await this.prisma.schemeOfWorkWeekDelivery.findMany({
          where: {
            classArmId: arm.id,
            status: 'DELIVERED',
            weekId: { in: scheme.weeks.map((week) => week.id) },
          },
          select: { weekId: true },
        })
      ).map((row) => row.weekId),
    );
    const taught = scheme.weeks.filter((week) => week.isDelivered || deliveredIds.has(week.id));
    const scope = String(args.scope || '').toLowerCase();
    if (scope !== 'delivered' && scope !== 'all') {
      return halt('Use the weeks already taught, or the whole scheme? I will write the questions after you choose.', {
        needsScope: true,
        deliveredWeeks: taught.map((week) => week.weekNumber),
        schemeWeeks: scheme.weeks.map((week) => week.weekNumber),
      });
    }

    const chosen = scope === 'delivered' ? taught : scheme.weeks;
    if (chosen.length === 0) {
      return halt('No weeks have been marked taught yet. Say if I should use the whole scheme.');
    }

    return {
      halted: false,
      classId: matched.id,
      className: matched.name,
      subjectId: subject.id,
      subjectName: subject.name,
      examDate,
      weeks: chosen.map((week) => ({
        weekNumber: week.weekNumber,
        topic: week.topic,
        learningOutcomes: week.learningOutcomes,
        assessmentType: week.assessmentType || undefined,
      })),
    };
  }

  /** Match a named arm ("JSS 2 A") to one of this teacher's classes. Several matches stay unresolved. */
  private async matchTeacherClass(
    context: AgentToolContext | undefined,
    label?: string,
  ): Promise<{ id: string; name: string } | null> {
    const query = (label || '').trim();
    if (!query || !context?.schoolId || !context.userId) return null;

    const teacher = await this.prisma.teacher.findFirst({
      where: { userId: context.userId, schoolId: context.schoolId },
      select: { id: true },
    });
    if (!teacher) return null;

    const [assignments, periods] = await Promise.all([
      this.prisma.classTeacher.findMany({
        where: { teacherId: teacher.id, classArmId: { not: null } },
        select: {
          classArm: { select: { id: true, name: true, classLevel: { select: { name: true } } } },
        },
      }),
      this.prisma.timetablePeriod.findMany({
        where: { teacherId: teacher.id, classArmId: { not: null } },
        select: {
          classArmId: true,
          classArm: { select: { id: true, name: true, classLevel: { select: { name: true } } } },
        },
        distinct: ['classArmId'],
      }),
    ]);

    const classes = new Map<string, { id: string; name: string }>();
    for (const row of [...assignments, ...periods]) {
      const arm = row.classArm;
      if (!arm) continue;
      classes.set(arm.id, { id: arm.id, name: `${arm.classLevel.name} ${arm.name}`.trim() });
    }

    const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const needle = compact(query);
    if (!needle) return null;
    const list = [...classes.values()];
    const exact = list.filter((c) => compact(c.name) === needle);
    if (exact.length === 1) return exact[0];
    const partial = list.filter((c) => compact(c.name).includes(needle) || needle.includes(compact(c.name)));
    return partial.length === 1 ? partial[0] : null;
  }
}
