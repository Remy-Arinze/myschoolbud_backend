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
        const res = await this.generators.generateQuiz({
          topic: args.topic || 'Quick Quiz',
          subject: args.subject || 'General',
          gradeLevel: args.gradeLevel || 'Any',
          questionCount: args.questionCount || 5,
          questionTypes: args.questionTypes || ['multiple_choice'],
          difficulty: args.difficulty || 'medium',
        });

        if (context?.schoolId && args.subject) {
          const subject = await this.prisma.subject.findFirst({
            where: {
              schoolId: context.schoolId,
              name: { contains: args.subject, mode: 'insensitive' },
              isActive: true,
            },
            select: { id: true },
          });
          if (subject) {
            (res.data as any).subjectId = subject.id;
          }
        }
        return res;
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
        const res = await this.generators.generateAssessmentQuestions({
          topic: args.topic || 'Assessment',
          subject: args.subject || 'General',
          gradeLevel: args.gradeLevel || 'Any',
          questionCount: args.questionCount || 20,
          questionTypes: args.questionTypes || ['multiple_choice', 'short_answer', 'essay'],
          difficulty: args.difficulty || 'mixed',
        });

        if (context?.schoolId && args.subject) {
          const subject = await this.prisma.subject.findFirst({
            where: {
              schoolId: context.schoolId,
              name: { contains: args.subject, mode: 'insensitive' },
              isActive: true,
            },
            select: { id: true },
          });
          if (subject) {
            (res.data as any).subjectId = subject.id;
          }
        }
        return res;
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
        return this.getSchoolStats(context?.schoolId);

      case 'list_students':
        return this.schoolQuery.listStudents(args || {}, context);

      case 'list_classes':
        return this.schoolQuery.listClasses(args || {}, context);

      case 'get_student_overview':
        return this.schoolQuery.getStudentOverview(args || {}, context);

      case 'get_class_performance':
        return this.schoolQuery.getClassPerformance(args || {}, context);

      case 'get_scheme_of_work':
        return this.schoolQuery.getSchemeOfWork(args || {}, context);

      case 'get_now_in_class':
        return this.schoolQuery.getNowInClass(args || {}, context);

      case 'get_timetable':
        return this.schoolQuery.getTimetable(args || {}, context);

      case 'list_staff':
        return this.schoolQuery.listStaff(args || {}, context);

      case 'who_teaches':
        return this.schoolQuery.whoTeaches(args || {}, context);

      case 'get_attendance_summary':
        return this.schoolQuery.getAttendanceSummary(args || {}, context);

      case 'list_fee_debtors':
        return this.schoolQuery.listFeeDebtors(args || {}, context);

      case 'list_admissions':
        return this.schoolQuery.listAdmissions(args || {}, context);

      case 'get_calendar':
        return this.schoolQuery.getCalendar(args || {}, context);

      case 'get_guardians':
        return this.schoolQuery.getGuardians(args || {}, context);

      case 'list_lois_insights':
        return this.insights.listForTool(args || {}, context);

      case 'draft_parent_message':
        return this.schoolQuery.draftParentMessage(args || {}, context);

      case 'inspect_scheduling_context':
        return this.curatorTools.inspectScheduling(args || {}, context);

      case 'inspect_curriculum_options':
        return this.curatorTools.inspectCurriculum(args || {}, context);

      case 'propose_timetable':
        return this.curatorTools.proposeTimetable(args || {}, context);

      case 'propose_scheme':
        return this.curatorTools.proposeScheme(args || {}, context);

      case 'apply_pending_plans':
        return this.curatorTools.applyPendingPlans(args || {}, context);

      case 'search_semantic':
        return this.searchSemantic(
          args.query,
          args.limit,
          context?.schoolId,
          context?.userRole,
          context?.userId,
        );

      case 'get_academic_risk_summary':
        return this.getAcademicRiskSummary(args, context);

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

  async getSchoolStats(schoolId?: string): Promise<AgentToolResult> {
    if (!schoolId) return { data: { error: 'School ID is required' }, usage: null };

    const [classCount, classArmCount, teacherCount, studentCount] = await Promise.all([
      this.prisma.class.count({ where: { schoolId } }),
      this.prisma.classArm.count({
        where: { isActive: true, classLevel: { schoolId, isActive: true } },
      }),
      this.prisma.teacher.count({ where: { schoolId } }),
      this.prisma.enrollment.count({ where: { schoolId, isActive: true } }),
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
}
