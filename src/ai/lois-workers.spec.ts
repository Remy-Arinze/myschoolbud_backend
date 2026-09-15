import { AGORA_TOOLS } from './agora-chat-tools.definition';
import {
  STUDENT_TOOL_NAMES,
  WORKER_BRIEFS,
  WORKER_TOOL_NAMES,
  toolsForWorkers,
  toolRoutingBlock,
} from './lois-workers';
import {
  adminGraphNodeNames,
  desksRequiredForMessage,
  defaultSpeaker,
  isCuratorApplyIntent,
  isCuratorWriteIntent,
  nextUnvisitedDesk,
  runCodeRoute,
  selectStartWorker,
} from './lois-graph/lois-routing';
import { emptyThreadMemory } from './lois-thread-memory';

describe('Lois worker allowlists', () => {
  it('covers every AGORA_TOOLS name except banned apply_* names', () => {
    const names = AGORA_TOOLS.map((t) => t.function.name);
    expect(names).toContain('apply_pending_plans');
    expect(names).not.toEqual(expect.arrayContaining(['apply_timetable', 'apply_scheme', 'apply_plan']));
    const workerNames = new Set(Object.values(WORKER_TOOL_NAMES).flat());
    for (const extra of ['apply_timetable', 'apply_scheme', 'apply_plan']) {
      expect(workerNames.has(extra)).toBe(false);
    }
    expect(workerNames.has('apply_pending_plans')).toBe(true);
  });

  it('toolsForWorkers unions unique tools for the given desks', () => {
    const tools = toolsForWorkers(['finance', 'admissions']);
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['list_fee_debtors', 'list_students', 'list_admissions']));
    expect(names).not.toContain('propose_timetable');
    expect(names).not.toContain('generate_quiz');
  });

  it('curator has inspect + propose + apply_pending_plans', () => {
    const names = [...WORKER_TOOL_NAMES.curator];
    expect(names).toEqual(
      expect.arrayContaining([
        'inspect_scheduling_context',
        'inspect_curriculum_options',
        'propose_timetable',
        'propose_scheme',
        'apply_pending_plans',
      ]),
    );
    expect(names).not.toContain('apply_timetable');
    expect(names).not.toContain('apply_scheme');
    expect(names).not.toContain('apply_plan');
  });

  it('academic brief quotes filed insights and does not fake a fees page', () => {
    expect(WORKER_BRIEFS.academic).toMatch(/list_lois_insights FIRST/i);
    expect(WORKER_BRIEFS.finance).toMatch(/not fully built/i);
    expect(WORKER_BRIEFS.finance.toLowerCase()).not.toContain('point them to fees');
    expect(WORKER_BRIEFS.operations).toMatch(/named teacher's class/i);
    expect(WORKER_BRIEFS.operations).toMatch(/teacherClasses/i);
  });

  it('academic can load a briefing and name who teaches outstanding arms', () => {
    const names = new Set(WORKER_TOOL_NAMES.academic);
    expect(names.has('list_lois_insights')).toBe(true);
    expect(names.has('get_scheme_of_work')).toBe(true);
    expect(names.has('who_teaches')).toBe(true);
    expect(names.has('list_classes')).toBe(true);
    expect(names.has('propose_scheme')).toBe(false);
  });

  it('classroom has no insights, fees, admissions, or propose', () => {
    const names = new Set(WORKER_TOOL_NAMES.classroom);
    expect(names.has('list_lois_insights')).toBe(false);
    expect(names.has('list_fee_debtors')).toBe(false);
    expect(names.has('list_admissions')).toBe(false);
    expect(names.has('propose_timetable')).toBe(false);
    expect(names.has('propose_scheme')).toBe(false);
  });

  it('slices prompt routing to attached tools only', () => {
    const block = toolRoutingBlock(['list_fee_debtors']);
    expect(block).toContain('list_fee_debtors');
    expect(block).not.toContain('propose_timetable');
    expect(block).not.toContain('list_admissions');
  });

  it('tells curator not to answer generate with get_timetable', () => {
    const block = toolRoutingBlock(['propose_timetable', 'get_timetable']);
    expect(block).toContain('Never answer that with get_timetable');
    expect(block).toContain('propose_timetable once per arm');
    expect(block).toContain('Never call propose_timetable and propose_scheme');
    expect(block.toLowerCase()).not.toContain('plan id');
    expect(block.toLowerCase()).not.toContain('call apply via plan id');
  });

  it('student study tools exclude school admin actions', () => {
    expect([...STUDENT_TOOL_NAMES]).not.toContain('list_students');
    expect([...STUDENT_TOOL_NAMES]).not.toContain('propose_timetable');
    expect([...STUDENT_TOOL_NAMES]).not.toContain('generate_assessment');
  });
});

describe('Lois start-node routing', () => {
  it('starts Finance on who owes fees', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'finance', 'academic'],
        userMessage: 'Who still owes school fees? Name the students and what they owe if you have it.',
      }),
    ).toBe('finance');
  });

  it('starts Admissions on pending applications', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'admissions'],
        userMessage: 'Do we have pending admission applications? How many, and who are they?',
      }),
    ).toBe('admissions');
  });

  it('starts Academic on what Lois noticed', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'academic'],
        userMessage: 'What have you already noticed about this school? Any insights I should look at?',
      }),
    ).toBe('academic');
  });

  it('starts Academic on at-risk, attendance, and published scheme reads', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'academic', 'curator'],
        userMessage: 'Which students are academically at risk right now?',
      }),
    ).toBe('academic');
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'academic'],
        userMessage: 'What does attendance look like in JSS 1 A over the last two weeks?',
      }),
    ).toBe('academic');
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'academic', 'curator'],
        userMessage: 'Do we have a published scheme of work for JSS 1 Mathematics?',
      }),
    ).toBe('academic');
  });

  it('does not start Academic for a calendar this-week ask', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'academic'],
        userMessage: "What's happening this week, and are we closed on Independence Day?",
      }),
    ).toBeNull();
  });

  it('does not start Curator from timetable/scheme page focus alone', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        pageContext: { type: 'timetable', path: '/dashboard/school/timetables' },
      }),
    ).toBeNull();
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        pageContext: { type: 'scheme', path: '/dashboard/school/courses/abc' },
      }),
    ).toBeNull();
  });

  it('does not start Curator when the admin is not allowed that desk', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['finance'],
        pageContext: { type: 'timetable' },
      }),
    ).toBeNull();
  });

  it('starts Curator when the user asks to apply all pending timetables', () => {
    expect(isCuratorApplyIntent('apply all')).toBe(true);
    expect(isCuratorApplyIntent('apply these timetables')).toBe(true);
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        userMessage: 'apply all',
      }),
    ).toBe('curator');
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        userMessage: 'apply these timetables',
      }),
    ).toBe('curator');
  });

  it('starts Curator when the user asks to generate a timetable, even off the timetable page', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        userMessage:
          'can you also generate me a timetable for jss1b and all the classarms in jss2',
      }),
    ).toBe('curator');
  });

  it('does not treat a timetable lookup as a generate request', () => {
    expect(
      isCuratorWriteIntent('what does JSS 1B have on Thursday'),
    ).toBe(false);
    expect(
      isCuratorWriteIntent(
        'What does JSS 1 A already have on Thursday? Do not generate a new timetable — just read what is saved.',
      ),
    ).toBe(false);
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        userMessage: 'what does JSS 1B have on Thursday',
      }),
    ).toBeNull();
  });

  it('prefers Curator generate intent over a briefing insightId', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'academic', 'curator'],
        insightId: 'ins-1',
        userMessage: 'generate a timetable for JSS 2 A',
      }),
    ).toBe('curator');
  });

  it('omits wait_for_apply when bursar graph has no curator node', () => {
    const nodes = adminGraphNodeNames(['finance']);
    expect(nodes).toContain('route');
    expect(nodes).toContain('facing');
    expect(nodes).toContain('finance');
    expect(nodes).not.toContain('curator');
    expect(nodes).not.toContain('wait_for_apply');
  });

  it('includes wait_for_apply only when curator is compiled', () => {
    const nodes = adminGraphNodeNames(['operations', 'curator']);
    expect(nodes).toContain('curator');
    expect(nodes).toContain('facing');
    expect(nodes).toContain('wait_for_apply');
    expect(nodes).toContain('applied_ack');
  });

  it('starts Academic first on a mixed attendance + roster + fees ask', () => {
    const ask =
      "In one reply: what does attendance look like in JSS 1 A over the last two weeks, who is in Adaeze Okeke's class, and does anyone owe school fees?";
    const allowed = ['operations', 'academic', 'finance'] as const;
    expect(desksRequiredForMessage(ask, [...allowed])).toEqual([
      'academic',
      'operations',
      'finance',
    ]);
    expect(
      selectStartWorker({
        allowedWorkers: [...allowed],
        userMessage: ask,
      }),
    ).toBe('academic');
    expect(
      nextUnvisitedDesk({
        userMessage: ask,
        allowedWorkers: [...allowed],
        visitedWorkers: ['academic'],
      }),
    ).toBe('operations');
    expect(
      nextUnvisitedDesk({
        userMessage: ask,
        allowedWorkers: [...allowed],
        visitedWorkers: ['academic', 'operations'],
      }),
    ).toBe('finance');
    expect(
      nextUnvisitedDesk({
        userMessage: ask,
        allowedWorkers: [...allowed],
        visitedWorkers: ['academic', 'operations', 'finance'],
      }),
    ).toBeNull();
  });

  it('starts Operations on a named teacher roster ask', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'academic', 'finance'],
        userMessage: "Who is in Adaeze Okeke's class?",
      }),
    ).toBe('operations');
  });

  it('starts Pedagogy on quiz / lesson-plan asks', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'pedagogy'],
        userMessage: 'Make me a quiz for JSS 1 Mathematics',
      }),
    ).toBe('pedagogy');
    expect(
      desksRequiredForMessage('generate a lesson plan for English', ['pedagogy', 'operations']),
    ).toEqual(['pedagogy']);
  });

  it('defaults admin to operations and teacher to classroom', () => {
    expect(defaultSpeaker({ userRole: 'SCHOOL_ADMIN', allowedWorkers: ['operations', 'finance'] })).toBe(
      'operations',
    );
    expect(defaultSpeaker({ userRole: 'TEACHER', allowedWorkers: ['classroom', 'pedagogy'] })).toBe(
      'classroom',
    );
  });

  it('code route uses plannedWorkers when regex is empty, then facing', () => {
    const base = {
      messages: [{ role: 'user' as const, content: "What's happening this week?" }],
      schoolId: 's1',
      userId: 'u1',
      role: 'SCHOOL_ADMIN',
      pageFocus: null,
      allowedWorkers: ['operations', 'finance'] as const,
      insightId: null,
      planId: null,
      planKind: null,
      lastAssistant: '',
      hops: 0,
      hitl: null,
      threadMemory: emptyThreadMemory(),
    };
    const first = runCodeRoute({
      ...base,
      activeWorker: null,
      visitedWorkers: [],
      plannedWorkers: ['operations'],
      allowedWorkers: ['operations', 'finance'],
    });
    expect(first.activeWorker).toBe('operations');

    const after = runCodeRoute({
      ...base,
      activeWorker: 'operations',
      visitedWorkers: ['operations'],
      plannedWorkers: ['operations'],
      lastAssistant: 'Here is this week.',
      hops: 1,
      allowedWorkers: ['operations', 'finance'],
    });
    expect(after.activeWorker).toBeNull();
  });

  it('code route does not default-speaker when nothing is planned', () => {
    const none = runCodeRoute({
      messages: [{ role: 'user' as const, content: "What's happening this week?" }],
      schoolId: 's1',
      userId: 'u1',
      role: 'SCHOOL_ADMIN',
      pageFocus: null,
      allowedWorkers: ['operations', 'finance'],
      insightId: null,
      planId: null,
      planKind: null,
      lastAssistant: '',
      hops: 0,
      hitl: null,
      activeWorker: null,
      visitedWorkers: [],
      plannedWorkers: [],
      threadMemory: emptyThreadMemory(),
    });
    expect(none.activeWorker).toBeNull();
  });

  it('hops coded academic then planned finance remainder', () => {
    const ask =
      'What does attendance look like in JSS 1 A over the last two weeks, and how many people are in debt in that class?';
    const allowed = ['operations', 'academic', 'finance'] as const;
    expect(
      nextUnvisitedDesk({
        userMessage: ask,
        allowedWorkers: [...allowed],
        visitedWorkers: ['academic'],
        plannedWorkers: ['academic', 'finance'],
      }),
    ).toBe('finance');
  });
});
