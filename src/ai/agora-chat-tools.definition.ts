/**
 * OpenAI tool definitions for Lois agentic chat.
 * School facts go through typed, permissioned tools — never model-authored SQL.
 */
export const AGORA_TOOLS: Array<{
  type: 'function';
  function: { name: string; description: string; parameters: object };
}> = [
  {
    type: 'function',
    function: {
      name: 'search_semantic',
      description:
        'Semantic search over the school knowledge base (policies, handbooks, indexed profiles). Use for qualitative questions, not counts or grade lists.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          limit: { type: 'number', description: 'Max results (default 5, max 8)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_school_stats',
      description:
        'High-level counts for this school: active enrolments, teachers, and class arms. "classes" is the number of active class arms (e.g. Primary 1 A, JSS 1 A), not an unused Class table. Use for snapshot numbers, not named student lists.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_students',
      description:
        'List enrolled students in this school (name, class). Filter by name query and/or class. Use for "who is in JSS 2A" or "find Ada". Does not return grades. If a name search finds no student, staffMatches may include teachers or admins with that name — say they are staff, not that they do not exist. If teacherClasses is present, that is the class teacher\'s roster — name those students.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name search (first or last name)' },
          classId: { type: 'string', description: 'Filter by class id' },
          classArmId: { type: 'string', description: 'Filter by class arm id' },
          classQuery: {
            type: 'string',
            description: 'Class name such as "JSS 2A" when you do not have an id. Prefer list_classes if this is ambiguous.',
          },
          limit: { type: 'number', description: 'Max rows (default 15, max 25)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_classes',
      description:
        'List or find classes in this school. Use for "what classes do we have", "how many arms in JSS 1", or to resolve "JSS 2A" into classArmId/classId before other tools.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional name such as "JSS 2A", "SS1 Gold", or a level like "JSS 1"',
          },
          limit: { type: 'number', description: 'Max rows (default 25, max 40)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_student_overview',
      description:
        'One student: class, recent published grades, and short attendance summary. Use when the user names a student or the page is focused on a student. Never invent an id.',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: 'Student profile id' },
        },
        required: ['studentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_class_performance',
      description:
        'Class-level published grade averages for the active term, plus how many students sit below the risk threshold. Use for "how is JSS 2 doing".',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Class name such as "JSS 2A" when you do not have an id' },
          thresholdPercent: { type: 'number', description: 'At-risk cutoff (default 45)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_academic_risk_summary',
      description:
        'Students whose average published grade percentage is below a threshold for the active term. School admins see the whole school; teachers only their roster.',
      parameters: {
        type: 'object',
        properties: {
          thresholdPercent: {
            type: 'number',
            description: 'Average percent below which a student is flagged (default 45)',
          },
          limit: { type: 'number', description: 'Max students (default 25, max 100)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_scheme_of_work',
      description:
        'Published scheme of work weeks: topic, per-arm delivery status, lesson-note presence. Primary/secondary schemes are stored on the class LEVEL (JSS 1), not on JSS 1A/B/C. Pass classLevelId, or pass a class-arm id as classId (it is resolved to the level). Empty weeks with count>0 means the scheme exists but that week number is not in the plan — not that the scheme is unpublished.',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classLevelId: { type: 'string' },
          subjectId: { type: 'string' },
          weekNumber: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_now_in_class',
      description:
        'What is on the timetable right now (Africa/Lagos) for a class, or the form/class teacher for primary. Use for "who is teaching this class now".',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Class name such as "JSS 2A" when you do not have an id' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_timetable',
      description:
        'Read an EXISTING full-day timetable (Africa/Lagos). Use for "what does JSS 2A have on Thursday". Do NOT use this to generate, create, or auto-fill a timetable — that is inspect_scheduling_context then propose_timetable. Empty periods mean nothing is saved yet, not that generation ran.',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Class name such as "JSS 2A"' },
          day: {
            type: 'string',
            description: 'Day of week (Monday–Sunday) or "today". Defaults to today in Africa/Lagos.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_staff',
      description:
        'List teachers and school admins (name, role, subjects). Use for "who is Adaeze Okeke" or any person lookup after list_students is empty. If teacherClasses is present, that is the class teacher\'s roster — name those students. Does not return passwords.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name search' },
          kind: {
            type: 'string',
            enum: ['teacher', 'admin', 'all'],
            description: 'Which staff to list (default all for school admins; teachers only see teachers)',
          },
          limit: { type: 'number', description: 'Max rows (default 20, max 25)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'who_teaches',
      description:
        'Who teaches a subject, optionally in a class. Also returns the form/class teacher when a class is specified. Use for "who teaches JSS 2 Mathematics" or "who is the form teacher for SS1A". If no one is assigned to that class, schoolSubjectStaff lists subject specialists at the school — do not say there is no Maths teacher in the whole school.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Subject name such as Mathematics or English' },
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Class name such as "JSS 2A"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_attendance_summary',
      description:
        'Attendance totals for a class (or school-wide rollup) over recent days: present, absent, late. If totals are all 0, daily attendance tracking is not fully in use — do not treat zeros as everyone present. Use for absence questions, not named medical details.',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Class name such as "JSS 2A"' },
          days: { type: 'number', description: 'Lookback days (default 7, max 30)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_fee_debtors',
      description:
        'Students with outstanding school fees (unpaid fee records and/or enrollment debt balance). Use for who owes fees. Does not record payments. Bursary is not fully built — do not send the owner to a Fees page.',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Class name such as "SS2"' },
          limit: { type: 'number', description: 'Max students (default 20, max 25)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_admissions',
      description:
        'Admission applications inbox: pending, accepted, or declined. Use for "how many pending applications" or recent applicants. Does not approve or reject.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['PENDING', 'ACCEPTED', 'DECLINED'],
            description: 'Filter by status. Omit for a count of each status plus recent pending.',
          },
          limit: { type: 'number', description: 'Max application rows (default 15, max 25)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar',
      description:
        'School calendar events and holidays (Africa/Lagos). For "this week" pass range=this_week and omit from/to — never invent YYYY-MM-DD. For a date the user named, pass that from/to.',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            enum: ['this_week', 'next_week', 'today'],
            description:
              'Relative window. For "what is happening this week" ALWAYS pass this_week. Do not invent from/to when using range.',
          },
          from: {
            type: 'string',
            description: 'Named start date YYYY-MM-DD only when the user gave a date. Do not invent for "this week".',
          },
          to: {
            type: 'string',
            description: 'Named end date YYYY-MM-DD only with from. Omit when using range.',
          },
          type: {
            type: 'string',
            enum: ['ACADEMIC', 'EVENT', 'EXAM', 'MEETING', 'HOLIDAY'],
            description: 'Optional event type filter',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_guardians',
      description:
        'Parent/guardian contacts for one student (name, relationship, phone, email). Does not send messages. Never invent a student id.',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: 'Student profile id' },
        },
        required: ['studentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_lois_insights',
      description:
        'Background issues Lois already flagged for this school (academic risk, performance drops, scheme-of-work gaps, attendance, overdue fees, admissions backlog). Pass insightId to load one filed report. Results are limited to what this admin is allowed to see. Use when the user asks what Lois noticed, or to explain a briefing card.',
      parameters: {
        type: 'object',
        properties: {
          insightId: { type: 'string', description: 'Load one filed report by id (from the briefing).' },
          limit: { type: 'number', description: 'Max insights (default 8, max 15)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_parent_message',
      description:
        'Draft a parent/guardian update for a student. Returns text only — it is NOT sent. Always tell the user this is a draft they must copy or send from the dashboard.',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string' },
          topic: { type: 'string', description: 'What the note is about' },
          tone: { type: 'string', enum: ['supportive', 'formal', 'urgent'] },
        },
        required: ['studentId', 'topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grade_essay',
      description:
        'Grade a student essay based on a prompt and optional rubric. Returns score, feedback, strengths, and areas for improvement.',
      parameters: {
        type: 'object',
        properties: {
          essay: { type: 'string', description: 'The full text of the student essay' },
          prompt: { type: 'string', description: 'The prompt or question the student was answering' },
          subject: { type: 'string', description: 'The subject of the essay' },
          gradeLevel: { type: 'string', description: 'The grade level of the student' },
          rubric: { type: 'string', description: 'Optional grading rubric or criteria' },
          maxScore: { type: 'number', description: 'Maximum possible score, default 100' },
        },
        required: ['essay', 'prompt', 'subject', 'gradeLevel'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_lesson_plan',
      description:
        'Generate a detailed lesson plan. Use this tool even if optional details are missing; LOIS will infer them from context.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The lesson topic' },
          subject: { type: 'string', description: 'The academic subject' },
          gradeLevel: { type: 'string', description: 'e.g., JSS 1, SS 3' },
          objectives: { type: 'array', items: { type: 'string' } },
          duration: { type: 'number', description: 'Duration in minutes' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_quiz',
      description:
        'Generate quick quiz questions. Use this tool for ALL quiz requests to ensure the interactive builder appears.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The quiz topic' },
          subject: { type: 'string', description: 'The academic subject' },
          gradeLevel: { type: 'string', description: 'e.g., JSS 1' },
          questionCount: { type: 'number' },
          questionTypes: {
            type: 'array',
            items: { type: 'string', enum: ['multiple_choice', 'true_false', 'short_answer'] },
            description: 'Types of questions to include',
          },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        },
        required: ['topic', 'subject', 'gradeLevel'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_flashcards',
      description: 'Create study flashcards for a topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          subject: { type: 'string' },
          gradeLevel: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['topic', 'subject', 'gradeLevel'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_summary',
      description: 'Generate a study summary for a topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          subject: { type: 'string' },
          gradeLevel: { type: 'string' },
        },
        required: ['topic', 'subject', 'gradeLevel'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_assessment',
      description:
        'Generate formal assessment questions. MANDATORY: ALWAYS use this tool if the user wants to create an assessment/exam so they can access the full-screen editor.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Assessment topic' },
          subject: { type: 'string', description: 'The academic subject' },
          gradeLevel: { type: 'string', description: 'e.g., SS 2' },
          questionCount: { type: 'number' },
          questionTypes: {
            type: 'array',
            items: { type: 'string', enum: ['multiple_choice', 'short_answer', 'essay'] },
            description: 'Types of questions to include',
          },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'mixed'] },
        },
        required: ['topic', 'subject', 'gradeLevel'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_scheduling_context',
      description:
        'Inspect a class timetable context: existing periods, subjects, teachers and loads, class teacher, missing teachers, scheme presence. Call this BEFORE proposing a timetable (including when the user asked to generate one). Prefer classArmId from list_classes. classQuery accepts "JSS 2 A" or "JSS2A".',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Arm name such as "JSS 2 A" or "JSS2A"' },
          termId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_curriculum_options',
      description:
        'Inspect Bud library templates vs this term’s teachable weeks, existing schemes, and whether a timetable exists. Call before proposing a scheme. If there is no timetable, tell the user and offer to create one first — do not auto-apply both.',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string' },
          classLevelId: { type: 'string' },
          termId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_timetable',
      description:
        'Generate a timetable PREVIEW for one class arm (does not save). Use when the user asks to generate, create, auto-fill, or build a timetable. Prefer classArmId from list_classes; classQuery accepts "JSS 2 A" or "JSS2A". For several arms (e.g. all JSS 2), call this once per arm. Fill-empty by default. Do not invent a term id — the server uses the school\'s active term. After proposing, if the user asks to apply, call apply_pending_plans. Never quote internal ids.',
      parameters: {
        type: 'object',
        properties: {
          classId: { type: 'string' },
          classArmId: { type: 'string' },
          classQuery: { type: 'string', description: 'Arm name such as "JSS 2 A" or "JSS2A" if ids are unknown' },
          termId: {
            type: 'string',
            description: 'Optional. Ignored if invalid — the active term is used.',
          },
          mode: { type: 'string', enum: ['FILL_EMPTY', 'REPLACE'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_scheme',
      description:
        'Propose a scheme of work (does not generate yet). Use inspect_curriculum_options first. File upload stays in the curriculum modal. After proposing, if the user asks to apply, call apply_pending_plans. Never quote internal ids.',
      parameters: {
        type: 'object',
        properties: {
          classLevelId: { type: 'string' },
          classId: { type: 'string' },
          subjectId: { type: 'string' },
          termId: { type: 'string' },
          mode: { type: 'string', enum: ['AGORA_ONLY', 'SCHOOL_ONLY', 'MERGED'] },
          agoraCurriculumId: { type: 'string' },
          schoolCurriculumDocId: { type: 'string' },
          forceOverwrite: { type: 'boolean' },
          mergeWeightAgora: { type: 'number' },
          mergeWeightSchool: { type: 'number' },
        },
        required: ['classLevelId', 'subjectId', 'termId', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_pending_plans',
      description:
        'Apply pending timetable or scheme previews from this chat. Use when the user says apply, apply all, save these, or names classes to apply. Do not pass internal ids — use scope ALL_PENDING or NAMED classQueries like "JSS 2 A". Defaults to pending timetables only. Speak class names in the reply. Never say you cannot apply.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['ALL_PENDING', 'NAMED'],
            description: 'ALL_PENDING applies every open preview of the chosen kind in this chat. NAMED applies only classQueries.',
          },
          classQueries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Class names such as "JSS 2 A" when scope is NAMED.',
          },
          kind: {
            type: 'string',
            enum: ['TIMETABLE', 'SCHEME', 'ALL'],
            description: 'Defaults to TIMETABLE so apply all after timetable cards does not start schemes.',
          },
        },
      },
    },
  },
];
