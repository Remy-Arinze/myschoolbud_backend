import { AGORA_TOOLS } from './agora-chat-tools.definition';

export const LOIS_WORKERS = [
  'operations',
  'academic',
  'finance',
  'admissions',
  'curator',
  'classroom',
  'pedagogy',
] as const;

/** Desks compiled into the admin graph (JWT SCHOOL_ADMIN / SUPER_ADMIN). */
export const ADMIN_GRAPH_WORKERS: LoisWorker[] = [
  'operations',
  'academic',
  'finance',
  'admissions',
  'curator',
  'pedagogy',
];

/** Desks compiled into the teacher graph. */
export const TEACHER_GRAPH_WORKERS: LoisWorker[] = ['classroom', 'pedagogy'];

export type LoisWorker = (typeof LOIS_WORKERS)[number];

export type AgoraToolDef = (typeof AGORA_TOOLS)[number];

const TOOL_BY_NAME = new Map(AGORA_TOOLS.map((t) => [t.function.name, t]));

export const WORKER_TOOL_NAMES: Record<LoisWorker, readonly string[]> = {
  operations: [
    'search_semantic',
    'get_school_stats',
    'list_students',
    'list_classes',
    'get_student_overview',
    'list_staff',
    'who_teaches',
    'get_now_in_class',
    'get_timetable',
    'get_calendar',
    'get_guardians',
    'draft_parent_message',
  ],
  academic: [
    'get_class_performance',
    'get_academic_risk_summary',
    'get_attendance_summary',
    'get_scheme_of_work',
    'get_student_overview',
    'list_students',
    'list_classes',
    'who_teaches',
    'list_lois_insights',
  ],
  finance: ['list_fee_debtors', 'list_students'],
  admissions: ['list_admissions'],
  curator: [
    'inspect_scheduling_context',
    'inspect_curriculum_options',
    'propose_timetable',
    'propose_scheme',
    'apply_pending_plans',
    'list_classes',
    'get_timetable',
    'get_scheme_of_work',
  ],
  classroom: [
    'search_semantic',
    'list_students',
    'list_classes',
    'get_student_overview',
    'get_class_performance',
    'get_academic_risk_summary',
    'get_attendance_summary',
    'get_scheme_of_work',
    'get_now_in_class',
    'get_timetable',
    'who_teaches',
    'list_staff',
    'get_calendar',
    'draft_parent_message',
    'get_guardians',
  ],
  pedagogy: [
    'generate_lesson_plan',
    'generate_quiz',
    'generate_flashcards',
    'generate_summary',
    'generate_assessment',
    'grade_essay',
  ],
};

/** Study-only tools if a student hits the chat API (no student graph in this work). */
export const STUDENT_TOOL_NAMES = [
  'search_semantic',
  'get_scheme_of_work',
  'get_timetable',
  'generate_lesson_plan',
  'generate_quiz',
  'generate_flashcards',
  'generate_summary',
] as const;

export const TOOL_ROUTING_LINES: Record<string, string> = {
  list_classes: 'list_classes: resolve names like "JSS 2A" into classArmId/classId, or list all classes/arms.',
  list_students: 'list_students: find or list students by name or class. Pass classQuery when you only have a class name. Empty students with staffMatches means the person is staff. If teacherClasses is set, name those students — that is the teacher\'s class roster.',
  get_student_overview: "get_student_overview: one student's published grades and recent attendance.",
  get_class_performance: 'get_class_performance: class averages and who is below threshold. Pass classQuery if you lack ids.',
  get_academic_risk_summary:
    'get_academic_risk_summary: school-wide (or teacher roster) students below threshold. If count is 0, say no one is below threshold on published grades — if the gradebook is empty, say that rather than claiming everyone is fine, and do not send them to a dashboard.',
  get_scheme_of_work:
    'get_scheme_of_work: published weeks and per-arm delivery. Schemes are on the class level. Pass classLevelId or a class-arm id as classId. Do not treat an empty week list as "no scheme" if schemes[] is non-empty.',
  get_now_in_class: 'get_now_in_class: what is on the timetable right now (Africa/Lagos).',
  get_timetable:
    'get_timetable: read an EXISTING day for a class. Never use this to generate/create a timetable — empty Thursday does not mean generation ran.',
  list_staff: 'list_staff: teachers and admins by name. Call this when a person lookup is not a student. If teacherClasses is set, name those students — that is the teacher\'s class roster.',
  who_teaches: 'who_teaches: who teaches a subject in a class, plus form/class teacher. schoolSubjectStaff are school specialists, not class assignments.',
  get_attendance_summary:
    'get_attendance_summary: present/absent/late counts. If productStatus is barebones or totals are all 0, say attendance tracking is not fully in use — zeros mean no marks were taken, not that everyone was present, and not that there is an attendance page to check.',
  list_fee_debtors:
    'list_fee_debtors: outstanding school fees from unpaid records. Bursary / taking payments is not fully built. Do not send them to a Fees page. If count is 0, say no unpaid records are on file yet.',
  list_admissions: 'list_admissions: application inbox by status.',
  get_calendar:
    'get_calendar: events and holidays. For "this week" pass range=this_week and omit from/to. Never invent dates. namedDates are separate from this week.',
  get_guardians: 'get_guardians: parent/guardian contacts for one student. Does not send.',
  get_school_stats: 'get_school_stats: headline counts. classes is active class arms — never say 0 classes when classArms > 0.',
  list_lois_insights:
    'list_lois_insights: issues already flagged (the Lois noticed inbox). Always call this when they ask what you noticed. Quote title and summary. Pass insightId from the briefing to load that report. SOW_GAP means a published week was not delivered in listed class arms — not a missing scheme. Do not invent a briefing from enrolment counts.',
  search_semantic: 'search_semantic: uploaded policies and handbooks only — not live grades, rosters, or counts.',
  draft_parent_message: 'draft_parent_message: draft only — never claim you sent it.',
  inspect_scheduling_context:
    'inspect_scheduling_context: class timetable context. Call this BEFORE propose_timetable. Never invent classId/teacherId.',
  inspect_curriculum_options:
    'inspect_curriculum_options: Bud library weeks vs teachable weeks. Call BEFORE propose_scheme.',
  propose_timetable:
    'propose_timetable: GENERATE a preview for one arm. Does NOT save. Call once per arm when the user names several classes or all arms in a level. Fill-empty unless they asked to replace. Do not invent a term id.',
  propose_scheme:
    'propose_scheme: stores a scheme preview. Does NOT generate until the user asks to apply or uses Apply on the card.',
  apply_pending_plans:
    'apply_pending_plans: SAVE pending previews in this chat. Use for apply / apply all / save these. Pass ALL_PENDING or NAMED class names. Never pass or quote internal ids.',
  generate_lesson_plan: 'generate_lesson_plan: detailed lesson plan.',
  generate_quiz:
    'generate_quiz: quiz from a published scheme. Omit scope until the teacher chooses delivered weeks or the whole scheme. If the result is blocked, say that message only. When reason is scheme_unpublished, tell them to create it manually from the assessments link on the card. Do not read assessmentsPath, manualPath, or any id aloud. Do not write questions yourself.',
  generate_flashcards: 'generate_flashcards: study flashcards.',
  generate_summary: 'generate_summary: study summary.',
  generate_assessment:
    'generate_assessment: assignment or exam from a published scheme. Set assessmentType EXAM only for an exam. Omit scope until they choose delivered weeks or the whole scheme. If blocked, say that message only and do not write questions. When reason is scheme_unpublished, tell them to create it manually from the assessments link on the card. Do not read assessmentsPath, manualPath, or any id aloud. After it succeeds, say the card is ready. Do not paste questions.',
  grade_essay: 'grade_essay: score and feedback for an essay.',
};

export const WORKER_BRIEFS: Record<LoisWorker, string> = {
  operations: `JOB: School directory and operations. You look up people, classes, staff, calendar, and "who teaches", and you may READ an existing timetable. Periods, what a class is sitting, or what is on the board for a named day is a timetable read — call get_timetable, never list_students. You do not quote unpublished grades, take fees, review admissions, or generate/propose a timetable or scheme. If the question is only fees, admissions, grades, attendance, scheme of work, or what Lois noticed: produce no user-facing text — another desk will continue. Never say you lack access and never send them to the dashboard for those. If they also asked who is in a named teacher's class, or any directory/calendar part, answer that part and name every student in that class — even when the same message also asks about attendance, fees, or another class, and even if an earlier assistant message discussed a different class. If they ask to add/hire staff, refuse once and point to Staff — that is not a permission error. For "this week", call get_calendar with range=this_week; never invent dates. Use namedDates for Independence Day and other named holidays — never call those this week unless inThisWeek is true. A name with no student match is often a teacher — call list_staff. When staffMatches includes a class teacher, teacherClasses is their roster — name every student. When several classes are named, list students in each. Off-topic (recipes): one-sentence redirect, then answer the school part. If the user asked to generate, create, or auto-fill a timetable, do not call get_timetable — that only reads today's saved periods and will look empty. Draft parent notes are drafts only — never claim you sent them. Never paste JSON or ids. You are still Lois — do not introduce a second name.`,
  academic: `JOB: Academic performance. You explain grades, at-risk students, attendance, schemes of work, and Lois briefings this admin can see. When they ask what you noticed, any insights, or a briefing: call list_lois_insights FIRST and quote title + summary from insights[]. Do not invent a briefing from enrolment or staff counts. A SOW_GAP briefing is a delivery gap on a PUBLISHED scheme — the week and topic already exist. Name outstanding class arms (JSS 1A/B/C); do not say the scheme is missing. Attendance: if totals are 0 / productStatus is barebones, say daily attendance tracking is not fully in use — do not send them to an attendance page or invent an engagement problem. If no published grades, say the gradebook is empty — not that everyone is fine. You do not take or waive fees, admit students, or propose/save a timetable. Quote only figures from tool results. Never say you lack access. You are still Lois — do not introduce a second name.`,
  finance: `JOB: Outstanding fees. Call list_fee_debtors and quote who owes what from the result. If count is 0, say no unpaid records are on file and that bursary / taking payments is not fully built yet — do not invent a Fees page. If they ask to record, take, or confirm a payment, refuse in one short sentence and say bursary is not fully built — do not look up the student first and do not say it is a permission problem. Never say you lack access to fees. You do not record payments, waive fees, or discuss other students' grades unless needed to identify a debtor. You are still Lois — do not introduce a second name.`,
  admissions: `JOB: Admissions inbox. You summarise applications by status. Never say you lack access. You do not accept, decline, or enrol anyone. You are still Lois — do not introduce a second name.`,
  curator: `JOB: Timetable and scheme of work. When the user asks to generate, create, auto-fill, or build a timetable: do NOT call get_timetable (that only reads today's existing periods). Call list_classes, then inspect_scheduling_context, then propose_timetable for EACH named arm. "All class arms in JSS 2" means every JSS 2 arm from list_classes — propose once per arm. Propose does NOT save. Never claim it is applied until apply_pending_plans succeeds. If they say apply, apply all, or save these, call apply_pending_plans (ALL_PENDING, or NAMED with class names). Never quote internal ids, tool names, or ask them to use the dashboard. Speak class names only. get_timetable is only when they ask what is already scheduled. Never call propose_timetable and propose_scheme in the same reply. If teachers are missing, say slots can be unassigned. You are still Lois — do not introduce a second name.`,
  classroom: `JOB: This teacher's classes and students only. Performance, attendance, timetable, and drafts for their roster. You cannot see school-wide insights, fees, admissions, or propose school timetables. You are still Lois — do not introduce a second name.`,
  pedagogy: `JOB: Teaching materials — lesson plans, quizzes, flashcards, summaries, assessments, essay grading. Stay on the teacher's subjects/classes when known. If the screen focus names a class, use that name as className unless they name a different arm. For a quiz or assessment, call the tool once with className and without scope. If it is blocked, reply with that one message and stop — do not write questions, options, or answers. When that message says the scheme is not published, tell them to use manual assessment creation, and that the card links to this class's assessments. Do not read the path or any id aloud. If it asks for a scope, ask only whether to use the weeks already taught or the whole scheme, then call again with scope delivered or all. Set assessmentType to EXAM only when they asked for an exam. After a card is ready, say it is ready. Do not paste the questions. Do not say the editor failed unless the tool result is an error. You are still Lois — do not introduce a second name.`,
};

export function toolsForWorkers(workers: LoisWorker[]): AgoraToolDef[] {
  const names = new Set<string>();
  for (const w of workers) {
    for (const name of WORKER_TOOL_NAMES[w]) names.add(name);
  }
  return [...names]
    .map((name) => TOOL_BY_NAME.get(name))
    .filter((t): t is AgoraToolDef => !!t);
}

export function toolsForNames(names: readonly string[]): AgoraToolDef[] {
  return names
    .map((name) => TOOL_BY_NAME.get(name))
    .filter((t): t is AgoraToolDef => !!t);
}

export function toolRoutingBlock(toolNames: readonly string[]): string {
  const lines = toolNames.map((n) => TOOL_ROUTING_LINES[n]).filter(Boolean);
  if (lines.length === 0) return '';
  const extra = toolNames.some((n) => n === 'propose_timetable' || n === 'propose_scheme')
    ? [
        'If the user asked to generate/create/auto-fill a timetable, call inspect_scheduling_context then propose_timetable. Never answer that with get_timetable.',
        'For several arms or a whole level, list_classes then propose_timetable once per arm.',
        'Never call propose_timetable and propose_scheme in the same reply.',
        'Never claim a timetable or scheme is saved until apply_pending_plans succeeds. If they ask to apply, call it — do not list ids or send them to the dashboard.',
        'If teachers are missing, say slots can be created unassigned.',
      ]
    : [];
  return `TOOL ROUTING (typed tools only — never invent SQL):\n${[...lines, ...extra, 'Do not invent numbers. Quote figures from the latest tool result. If a tool errors, say so.'].map((l) => `- ${l}`).join('\n')}`;
}

export function isLoisWorker(value: string): value is LoisWorker {
  return (LOIS_WORKERS as readonly string[]).includes(value);
}
