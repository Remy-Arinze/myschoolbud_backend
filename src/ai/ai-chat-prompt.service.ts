import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AiContextRagService } from './ai-context-rag.service';
import { SystemPromptConfigService } from './system-prompt-config.service';
import { LoisSkillsService } from './lois-skills.service';
import { LoisPageContextInput } from './ai-page-context';
import { SUPERVISOR_BRIEF, toolRoutingBlock } from './lois-workers';
import { AGORA_TOOLS } from './agora-chat-tools.definition';

export type ChatPromptOptions = {
  attachedToolNames?: readonly string[];
  workerBrief?: string;
  supervisorOnly?: boolean;
};

/**
 * Builds the Lois system prompt for each chat turn.
 *
 * Identity context is role-specific:
 *   TEACHER     → assignments, timetable, form-class responsibilities
 *   SCHOOL_ADMIN → admin profile, role/type, live school stats
 *   STUDENT      → enrollment, class, active subjects, recent grade snapshot
 *
 * A per-school LoisConfig row can inject custom greeting, tone notes, and
 * restricted-topic guidance without requiring a code change.
 */
@Injectable()
export class AiChatPromptService {
  private readonly logger = new Logger(AiChatPromptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextRag: AiContextRagService,
    private readonly systemPromptConfig: SystemPromptConfigService,
    private readonly loisSkills: LoisSkillsService,
  ) {}

  async getChatPrompt(
    messages: { role: string; content: string }[],
    userId?: string,
    schoolId?: string,
    pageContext?: LoisPageContextInput | null,
    promptOptions?: ChatPromptOptions,
  ): Promise<{ systemPrompt: string; contextText: string; userRole: string; schoolName: string }> {
    let contextText = '';
    let userRole = 'USER';
    let schoolName = '';
    let directContext = '';

    // Real-time clock (WAT)
    const now = new Date();
    const formatterConfig = { timeZone: 'Africa/Lagos', hour12: false } as any;
    const currentDay = now.toLocaleString('en-US', { ...formatterConfig, weekday: 'long' }).toUpperCase();
    const currentTime = now.toLocaleString('en-US', { ...formatterConfig, hour: '2-digit', minute: '2-digit' });
    directContext += `[REAL-TIME CLOCK] Today is ${currentDay}. The current time is ${currentTime} (WAT).\n`;

    // ── Per-school LOIS configuration ─────────────────────────────────────────
    let loisConfig: { customGreeting?: string | null; toneNote?: string | null; restrictedTopics?: string | null; schoolContext?: string | null } | null = null;
    if (schoolId) {
      loisConfig = await (this.prisma as any).loisConfig?.findUnique?.({ where: { schoolId } }).catch(() => null) ?? null;
    }

    // ── Global system prompt config (super admin overrides) ───────────────────
    const sysConfig = await this.systemPromptConfig.get().catch(() => null);

    if (!schoolId || !userId) {
      return { systemPrompt: this.buildPrompt(schoolName, directContext, contextText, userRole, loisConfig, schoolId, sysConfig, [], promptOptions), contextText, userRole, schoolName };
    }

    // ── Shared queries — always needed ─────────────────────────────────────
    const [user, school] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, firstName: true, lastName: true },
      }),
      this.prisma.school.findUnique({
        where: { id: schoolId },
        select: {
          name: true, address: true, city: true, state: true,
          hasPrimary: true, hasSecondary: true, hasTertiary: true,
          academicSessions: {
            where: { status: 'ACTIVE' },
            take: 1,
            orderBy: { startDate: 'desc' },
            select: {
              name: true, startDate: true, endDate: true,
              terms: {
                where: { status: 'ACTIVE' }, take: 1,
                select: { name: true, number: true, startDate: true, endDate: true },
              },
            },
          },
        },
      }),
    ]);

    if (!user) return { systemPrompt: this.buildPrompt(schoolName, directContext, contextText, userRole, loisConfig, schoolId, sysConfig, [], promptOptions), contextText, userRole, schoolName };

    userRole = user.role;

    if (school) {
      schoolName = school.name;
      directContext += `Current School: ${schoolName}`;
      if (school.city || school.state) directContext += ` (${[school.city, school.state].filter(Boolean).join(', ')})`;
      directContext += '.\n';

      const levels = [school.hasPrimary && 'Primary', school.hasSecondary && 'Secondary', school.hasTertiary && 'Tertiary'].filter(Boolean);
      if (levels.length) directContext += `School levels offered: ${levels.join(', ')}.\n`;

      const activeSession = school.academicSessions?.[0];
      if (activeSession) {
        directContext += `Active academic session: ${activeSession.name} (${activeSession.startDate.toDateString()} – ${activeSession.endDate.toDateString()}).\n`;
        const activeTerm = activeSession.terms?.[0];
        if (activeTerm) {
          directContext += `Current term: ${activeTerm.name} (term ${activeTerm.number}, ${activeTerm.startDate.toDateString()} – ${activeTerm.endDate.toDateString()}).\n`;
        }
      }
    }

    // ── Role-specific context ────────────────────────────────────────────────
    if (userRole === 'TEACHER') {
      await this.buildTeacherContext(userId, schoolId, user, directContext).then(ctx => { directContext = ctx; });
    } else if (userRole === 'SCHOOL_ADMIN') {
      await this.buildAdminContext(userId, schoolId, user, directContext).then(ctx => { directContext = ctx; });
    } else if (userRole === 'STUDENT') {
      await this.buildStudentContext(userId, schoolId, user, directContext).then(ctx => { directContext = ctx; });
    } else {
      // SUPER_ADMIN or unknown — just name
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'User';
      directContext += `Current User: ${name} (Role: ${userRole}).\n`;
    }

    const focusBlock = await this.describeVerifiedFocus(pageContext, schoolId, userRole);
    if (focusBlock) {
      directContext += `\n${focusBlock}\n`;
    }

    // ── RAG context — scoped by role ────────────────────────────────────────
    const lastUserMessage = messages.slice().reverse().find((m) => m.role === 'user');
    if (lastUserMessage) {
      const ragResult = await this.contextRag.findRelevantContext(
        lastUserMessage.content, schoolId, userRole, 5, { userId },
      );
      contextText = ragResult.text;
    }

    this.logger.debug(`[Prompt] Role=${userRole}, School=${schoolName}`);

    // ── Active skills for this role ──────────────────────────────────────────
    const activeSkills = await this.loisSkills.getActiveForRole(userRole).catch(() => []);

    return {
      systemPrompt: this.buildPrompt(schoolName, directContext, contextText, userRole, loisConfig, schoolId, sysConfig, activeSkills, promptOptions),
      contextText,
      userRole,
      schoolName,
    };
  }

  // ── Teacher context ──────────────────────────────────────────────────────────
  private async buildTeacherContext(userId: string, schoolId: string, user: any, ctx: string): Promise<string> {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    const teacher = await this.prisma.teacher.findFirst({
      where: { userId, schoolId },
      include: {
        classTeachers: {
          include: {
            class: true,
            classArm: { include: { classLevel: true } },
            subjectRef: true,
          },
        },
        classArms: { include: { classLevel: true } },
        timetablePeriods: {
          where: { term: { status: 'ACTIVE' } },
          include: {
            class: true,
            classArm: { include: { classLevel: true } },
            subject: true,
          },
        },
      },
    });

    const displayName = teacher ? `${teacher.firstName} ${teacher.lastName}`.trim() : name || 'Teacher';
    ctx += `Current User: ${displayName} (Role: TEACHER).\n`;

    if (!teacher) {
      this.logger.warn(`No teacher record for user ${userId} in school ${schoolId}`);
      return ctx;
    }

    if (teacher.schoolType) ctx += `Teacher's Environment: ${teacher.schoolType} school level.\n`;

    const assignments: string[] = [];

    if (teacher.classTeachers?.length) {
      teacher.classTeachers.forEach(ct => {
        const subject = ct.subject || ct.subjectRef?.name || 'Subject';
        const levelName = ct.classArm?.classLevel?.name || '';
        const armName = ct.classArm?.name || '';
        const className = ct.class?.name || (levelName ? `${levelName} ${armName}`.trim() : armName) || 'Class';
        assignments.push(`- [Registry] ${subject} for ${className}${ct.isPrimary ? ' (Lead Teacher)' : ''}`);
      });
    }

    if (teacher.classArms?.length) {
      teacher.classArms.forEach(arm => {
        assignments.push(`- [Registry] Form Teacher for ${arm.classLevel?.name || 'Class'} ${arm.name}`);
      });
    }

    if (teacher.timetablePeriods?.length) {
      const map = new Map<string, Set<string>>();
      teacher.timetablePeriods.forEach(p => {
        const levelName = p.classArm?.classLevel?.name || '';
        const armName = p.classArm?.name || '';
        const cn = p.class?.name || (levelName ? `${levelName} ${armName}`.trim() : armName) || 'Unknown';
        if (!map.has(cn)) map.set(cn, new Set());
        map.get(cn)!.add(p.subject?.name || 'Subject');
      });
      map.forEach((subjects, cn) => {
        assignments.push(`- [Weekly Schedule] teaches ${[...subjects].join(', ')} for ${cn}`);
      });
    }

    const unique = [...new Set(assignments)];
    ctx += unique.length
      ? `Teacher's Active Assignments:\n${unique.join('\n')}\n`
      : `Teacher's Active Assignments: No class or subject assignments found yet.\n`;

    if (teacher.subject) ctx += `Teacher's Primary Specialisation: ${teacher.subject}\n`;

    return ctx;
  }

  // ── School admin context ─────────────────────────────────────────────────────
  private async buildAdminContext(userId: string, schoolId: string, user: any, ctx: string): Promise<string> {
    const [admin, studentCount, teacherCount, classCount] = await Promise.all([
      this.prisma.schoolAdmin.findFirst({
        where: { userId, schoolId },
        select: { firstName: true, lastName: true, role: true, schoolType: true },
      }),
      this.prisma.enrollment.count({ where: { schoolId, isActive: true } }),
      this.prisma.teacher.count({ where: { schoolId } }),
      this.prisma.class.count({ where: { schoolId } }),
    ]);

    const displayName = admin ? `${admin.firstName} ${admin.lastName}`.trim()
      : [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Administrator';

    ctx += `Current User: ${displayName} (Role: SCHOOL_ADMIN).\n`;

    if (admin) {
      const role = admin.role || 'Administrator';
      const scope = admin.schoolType ? ` — scoped to ${admin.schoolType} level` : '';
      ctx += `Admin Role: ${role}${scope}.\n`;
    }

    ctx += `School Statistics (live):\n`;
    ctx += `- Active student enrolments: ${studentCount}\n`;
    ctx += `- Teachers: ${teacherCount}\n`;
    ctx += `- Classes: ${classCount}\n`;

    return ctx;
  }

  // ── Student context ──────────────────────────────────────────────────────────
  private async buildStudentContext(userId: string, schoolId: string, user: any, ctx: string): Promise<string> {
    const student = await this.prisma.student.findFirst({
      where: { userId },
      include: {
        enrollments: {
          where: { schoolId, isActive: true },
          take: 1,
          orderBy: { enrollmentDate: 'desc' },
          include: {
            class: true,
            classArm: { include: { classLevel: true } },
            term: true,
          },
        },
      },
    });

    const displayName = student
      ? `${student.firstName} ${student.lastName}`.trim()
      : [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Student';

    ctx += `Current User: ${displayName} (Role: STUDENT).\n`;

    if (!student) return ctx;

    const enr = student.enrollments?.[0];
    if (enr) {
      const levelName = enr.classArm?.classLevel?.name || enr.classLevel || '';
      const armName = enr.classArm?.name || '';
      const className = enr.class?.name || (levelName ? `${levelName} ${armName}`.trim() : 'their class');
      ctx += `Student's Class: ${className}.\n`;
      if (enr.term) ctx += `Current Term: ${enr.term.name}.\n`;

      // Recent grade snapshot — last 5 published grades for context
      const recentGrades = await this.prisma.grade.findMany({
        where: { enrollmentId: enr.id, isPublished: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { subject: true, score: true, maxScore: true, gradeType: true },
      });

      if (recentGrades.length) {
        const gradeLines = recentGrades.map(g => {
          const pct = Number(g.maxScore) > 0 ? Math.round((Number(g.score) / Number(g.maxScore)) * 100) : 0;
          return `  - ${g.subject} (${g.gradeType}): ${Number(g.score)}/${Number(g.maxScore)} (${pct}%)`;
        });
        ctx += `Recent published grades:\n${gradeLines.join('\n')}\n`;
      }
    }

    return ctx;
  }

  /**
   * Re-loads the on-screen entity and ignores ids that do not belong to this school.
   */
  private async describeVerifiedFocus(
    pageContext: LoisPageContextInput | null | undefined,
    schoolId: string,
    userRole: string,
  ): Promise<string> {
    if (!pageContext?.type && !pageContext?.insightId) return '';
    if (pageContext.schoolId && pageContext.schoolId !== schoolId) return '';

    const briefingLine = await this.describeFiledInsight(schoolId, pageContext.insightId);
    const finish = (text: string) => [text, briefingLine].filter(Boolean).join('\n');

    try {
      if (pageContext.type === 'student' && pageContext.studentId) {
        const enrollment = await this.prisma.enrollment.findFirst({
          where: { schoolId, studentId: pageContext.studentId, isActive: true },
          select: {
            studentId: true,
            classLevel: true,
            class: { select: { id: true, name: true } },
            classArm: { select: { name: true, classLevel: { select: { name: true } } } },
            student: { select: { firstName: true, lastName: true } },
          },
        });
        if (!enrollment) return finish('');
        const name = `${enrollment.student.firstName} ${enrollment.student.lastName}`.trim();
        const className =
          enrollment.class?.name ||
          `${enrollment.classArm?.classLevel?.name || enrollment.classLevel || ''} ${enrollment.classArm?.name || ''}`.trim();
        return finish(`Current Screen Focus: Student ${name} (studentId=${enrollment.studentId}${className ? `, class=${className}` : ''}). Prefer this student unless the user asks about someone else.`);
      }

      if ((pageContext.type === 'class' || pageContext.type === 'level') && (pageContext.classId || pageContext.classArmId)) {
        if (pageContext.classId) {
          const klass = await this.prisma.class.findFirst({
            where: { id: pageContext.classId, schoolId },
            select: { id: true, name: true },
          });
          if (klass) {
            return finish(`Current Screen Focus: Class ${klass.name} (classId=${klass.id}).`);
          }
        }
        if (pageContext.classArmId) {
          const arm = await this.prisma.classArm.findFirst({
            where: { id: pageContext.classArmId, classLevel: { schoolId } },
            select: { id: true, name: true, classLevel: { select: { name: true } } },
          });
          if (arm) {
            return finish(`Current Screen Focus: ${arm.classLevel?.name || ''} ${arm.name} (classArmId=${arm.id}).`.trim());
          }
        }
      }

      if (pageContext.type === 'scheme' && pageContext.schemeId) {
        const scheme = await this.prisma.schemeOfWork.findFirst({
          where: { id: pageContext.schemeId, schoolId },
          select: { id: true, classLevel: { select: { name: true } } },
        });
        if (scheme) {
          const week = pageContext.weekNumber ? ` week ${pageContext.weekNumber}` : '';
          return finish(`Current Screen Focus: Scheme of work${scheme.classLevel?.name ? ` for ${scheme.classLevel.name}` : ''}${week} (schemeId=${scheme.id}).`);
        }
      }

      if (pageContext.type === 'timetable') {
        const bits = ['Current Screen Focus: Class timetables'];
        if (pageContext.label) bits.push(`(${pageContext.label})`);
        if (pageContext.classId) bits.push(`classId=${pageContext.classId}`);
        if (pageContext.classArmId) bits.push(`classArmId=${pageContext.classArmId}`);
        return finish(`${bits.join(' ')}. For Auto-Fill, inspect_scheduling_context first, then propose_timetable. Do not invent period rows.`);
      }

      if (pageContext.type === 'staff' && pageContext.teacherId) {
        const teacher = await this.prisma.teacher.findFirst({
          where: { id: pageContext.teacherId, schoolId },
          select: { id: true, firstName: true, lastName: true },
        });
        if (teacher) {
          return finish(`Current Screen Focus: Staff ${teacher.firstName} ${teacher.lastName} (teacherId=${teacher.id}).`);
        }
      }

      if (pageContext.type === 'school' || pageContext.type === 'overview') {
        return finish('Current Screen Focus: School overview (whole school).');
      }

      if (pageContext.label) {
        return finish(`Current Screen Focus: ${pageContext.label}${userRole === 'SCHOOL_ADMIN' ? '' : ''}.`);
      }
    } catch (err) {
      this.logger.warn(`Focus verification failed: ${err}`);
    }
    return finish('');
  }

  private async describeFiledInsight(schoolId: string, insightId?: string): Promise<string> {
    if (!insightId) return '';
    try {
      const row = await this.prisma.loisInsight.findFirst({
        where: { id: insightId, schoolId },
        select: { type: true, title: true, summary: true, evidence: true },
      });
      if (!row) {
        return `Lois briefing in focus: insightId=${insightId} was not found. Ask the user to reopen the card.`;
      }
      const evidence = JSON.stringify(row.evidence ?? {});
      const clipped = evidence.length > 2500 ? `${evidence.slice(0, 2500)}…` : evidence;
      const sowNote =
        row.type === 'SOW_GAP'
          ? 'This is a delivery gap on a PUBLISHED scheme. The week and topic already exist. OutstandingArms are the class arms still missing a delivery mark. Do not say the scheme is missing or unpublished. Use get_scheme_of_work with classLevelId from evidence (a class-arm id as classId is also fine). Use who_teaches for the outstanding arms.'
          : 'Explain this filed report. Quote only tool results when adding extra figures.';
      return [
        `FILED LOIS REPORT (insightId=${insightId}):`,
        `type=${row.type}`,
        `title=${row.title}`,
        `summary=${row.summary}`,
        `evidence=${clipped}`,
        sowNote,
      ].join('\n');
    } catch (err) {
      this.logger.warn(`Filed insight load failed: ${err}`);
      return `Lois briefing in focus: insightId=${insightId}. Use list_lois_insights with this insightId.`;
    }
  }

  // ── System prompt assembly ────────────────────────────────────────────────────
  private buildPrompt(
    schoolName: string,
    directContext: string,
    contextText: string,
    userRole: string,
    loisConfig: { customGreeting?: string | null; toneNote?: string | null; restrictedTopics?: string | null; schoolContext?: string | null } | null,
    schoolId?: string,
    sysConfig?: { identityOverride?: string | null; additionalRules?: string | null; teacherRulesOverride?: string | null; adminRulesOverride?: string | null; studentRulesOverride?: string | null } | null,
    activeSkills: { name: string; content: string; category: string }[] = [],
    promptOptions?: ChatPromptOptions,
  ): string {
    // Role-specific behavioural rules — use DB override or hardcoded default
    const roleRules = this.getRoleRules(userRole, sysConfig);

    // School-level customisations from LoisConfig (if set)
    const customisation = [
      loisConfig?.schoolContext ? `School Context: ${loisConfig.schoolContext}` : '',
      loisConfig?.toneNote ? `Tone Guidance: ${loisConfig.toneNote}` : '',
      loisConfig?.restrictedTopics ? `Restricted Topics: Do not discuss ${loisConfig.restrictedTopics}.` : '',
    ].filter(Boolean).join('\n');

    // Identity block — use DB override or default
    const identityBlock = sysConfig?.identityOverride?.trim()
      ? sysConfig.identityOverride.trim()
      : `Your identity: You are Lois, the Myschoolbud AI Assistant assigned to ${schoolName || 'the school'}.

Introduction rule:
- At the start of a new conversation, you may mention you are Lois.
- If asked your name or who you are: say "I am Lois, the AI assistant for ${schoolName || 'this school'} on Myschoolbud."
- Otherwise do NOT open every reply with a formal introduction — answer directly.`;

    // Additional rules from DB (appended after core rules)
    const extraRules = sysConfig?.additionalRules?.trim()
      ? `\n${sysConfig.additionalRules.trim()}`
      : '';

    // Skills block — skip for the tool-less supervisor so it does not pick up tool names
    const skillsBlock = !promptOptions?.supervisorOnly && activeSkills.length > 0
      ? `\nSKILLS & CAPABILITIES:\nThe following skills have been activated for your role. Follow their instructions precisely.\n\n${
          activeSkills.map((s) => `[${s.name.toUpperCase()} — ${s.category}]\n${s.content}`).join('\n\n')
        }\n`
      : '';

    const attachedNames = promptOptions?.attachedToolNames
      ?? (promptOptions?.supervisorOnly ? [] : AGORA_TOOLS.map((t) => t.function.name));
    const routingBlock = promptOptions?.supervisorOnly
      ? SUPERVISOR_BRIEF
      : toolRoutingBlock(attachedNames);
    const workerBriefBlock = promptOptions?.workerBrief ? `\n${promptOptions.workerBrief}\n` : '';

    return `
${identityBlock}

IMPORTANT: Use the following details to answer questions about the current user and school.
Current Identity Context:
${directContext || 'Basic school assistant context.'}

Relevant Knowledge Base Context (from RAG search):
${contextText || 'No specific knowledge base context found for this query.'}

User Role: ${userRole}
${customisation ? `\nSchool Customisations:\n${customisation}\n` : ''}

Core Operational Rules:
1. Always refer to yourself as Lois.
2. IDENTITY RULE: If the user asks who they are or what they teach/study, use "Current Identity Context" exactly — mention assigned classes, subjects, or grades as provided.
3. No Empty Promises: Do NOT say "Let me check that" or "I'll get back to you" unless you are making a tool call in the same turn.
4. Decisive Interaction: If a tool returns an error, inform the user and try a refined approach. Don't give up silently.
5. Use natural, conversational language — do not say "According to the context..."; state answers plainly.
6. Never reveal passwords or backend internals to the user. Do not quote internal IDs (plan, class, student, term, scheme, conversation), raw JSON, tool names, API paths, or "paste this id". Speak class and student names. After a timetable/scheme preview, do not send them to the dashboard. If they ask to apply, call apply_pending_plans.
7. Format responses with markdown for readability.
8. MEMORY: You have access to prior messages in this conversation. Reference them naturally when relevant — do not ask for information the user already gave.${extraRules}

${roleRules}
${skillsBlock}${workerBriefBlock}
${routingBlock}

SCREEN FOCUS:
If "Current Screen Focus" is set, prefer that student/class/scheme unless the user clearly asks about someone else.
When asked who is teaching a class right now, call get_now_in_class (primary returns the class teacher).
When asked who teaches a subject, or who the form teacher is, call who_teaches. If teachers[] is empty but schoolSubjectStaff is set, name those specialists and say they are not on this class timetable — do not say the school has no teacher for the subject.
If the user names a class without an id, call list_classes or pass classQuery like "JSS 2 A" / "JSS2A". After list_classes, pass classArmId into inspect and propose — never guess ids.
CALENDAR: For "this week" call get_calendar with range=this_week and omit from/to. Never invent YYYY-MM-DD. Quote events[] only as this week. namedDates[] are separate: Independence Day is this week only if that entry has inThisWeek true. If inThisWeek is false, say the date (e.g. 1 October) and that it is not this week.
PEOPLE: A name lookup is often staff. If list_students is empty, call list_staff (or use staffMatches). If teacherClasses is set, name every student in that teacher's class — do not stop at the class label. When the user asks about more than one class, call list_students once per class and name the students — do not stop at a count. Do not conclude "there is no such person" from an empty student list.
CANNOT-DO: Hiring, sending mail, and similar writes are dashboard actions — not a permission error. Point them to Staff once. Bursary / taking payments and daily attendance tracking are not fully built — never send the owner to a Fees or attendance page as if those dashboards were complete. Refuse a payment take in one short sentence. Do not repeat yourself. Do not say it is beyond your permissions. Never paste tool JSON, student ids, or raw payloads in the reply.
OFF-TOPIC: Stay a school operations assistant. For recipes or gossip, redirect in one or two sentences. Do not write a full recipe. After the redirect, actually answer any school question in the same message — do not stop at "I'll check".
    `.trim();
  }

  // ── Role-specific rule blocks ─────────────────────────────────────────────────
  private getRoleRules(
    userRole: string,
    sysConfig?: { teacherRulesOverride?: string | null; adminRulesOverride?: string | null; studentRulesOverride?: string | null } | null,
  ): string {
    switch (userRole) {
      case 'TEACHER':
        return sysConfig?.teacherRulesOverride?.trim() || `
TEACHER-SPECIFIC RULES:
- Tone: Be a helpful professional AI colleague to teachers.
- SECONDARY TEACHER GUARD: If the school type is SECONDARY, check "Teacher's Active Assignments". If a teacher asks to generate content for a subject NOT in their assignments, ask for confirmation before proceeding.
- CLASS CLARIFICATION: If the teacher teaches MULTIPLE classes and asks for class-specific content without naming the class, ask which class first. If they teach only ONE class, proceed directly.
- You can help with: lesson plans, quiz generation, essay grading, flashcards, summaries, student performance analysis, timetable queries.`;

      case 'SCHOOL_ADMIN':
        return sysConfig?.adminRulesOverride?.trim() || `
SCHOOL ADMIN-SPECIFIC RULES:
- Tone: Be a high-level strategic assistant to the school leadership.
- Tool access follows this admin's staff permissions. If a tool returns a permission error, explain they do not have access — do not invent the data.
- Missing a write tool (add teacher) is not a permission error. Point them to the Staff page once. Never say the action is beyond this owner's permissions.
- Bursary / taking payments and daily attendance tracking are not fully built. Quote unpaid fee records and attendance marks when tools return them. If those tools are empty, say the feature is not fully in use — do not invent a Fees or attendance page.
- You can help with: school statistics, classes (class arms), staff coverage, student performance, attendance marks on file, unpaid fee records, admissions, calendar, scheme of work, timetable, guardians, and the Lois insights inbox (always quote filed insights when they ask what you noticed).
- get_school_stats.classes is active class arms. Never report 0 classes when classArms is greater than 0.
- TIMETABLE / CURRICULUM WORKFLOW: When asked to generate/create/auto-fill a timetable, inspect then propose — do not call get_timetable (that only reads today's saved periods). Propose is not saved. For several arms (e.g. JSS 1B and all JSS 2 arms), propose once per arm. If they say apply or apply all, call apply_pending_plans and confirm with class names. Never refuse apply or list internal ids. If the class has no timetable, say so and offer a timetable before a scheme. If a timetable exists without schemes, list subjects and library vs calendar weeks. Never propose a timetable and a scheme in the same turn.
- For sensitive actions (e.g. suspending a student, emailing parents), you may draft text but MUST say it was not sent. They use the dashboard to send. Do not offer to take a fee payment in chat.
- Never invent student ids. Use list_students or the Current Screen Focus first. If the name is a teacher, say so.
- Never invent class ids. Use list_classes or classQuery first.`;

      case 'STUDENT':
        return sysConfig?.studentRulesOverride?.trim() || `
STUDENT-SPECIFIC RULES:
- Tone: Be encouraging, clear, and student-friendly. Avoid administrative or staffing discussions.
- You can help with: study guides, flashcards, summaries, quiz practice, subject explanations, homework help, understanding their grades.
- You CANNOT generate formal assessments, access other students' data, or perform administrative actions.
- If a student asks about another student's grades or personal details, politely decline.
- Use simple, age-appropriate language unless the student signals otherwise.`;

      default:
        return `
GENERAL RULES:
- Be helpful and professional.
- You can answer questions about the school and assist with educational content.`;
    }
  }
}
