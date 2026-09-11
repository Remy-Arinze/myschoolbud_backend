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
  isCuratorApplyIntent,
  isCuratorWriteIntent,
  selectStartWorker,
} from './lois-graph/lois-routing';

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

  it('starts Curator on timetable/scheme page focus when allowed', () => {
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        pageContext: { type: 'timetable', path: '/dashboard/school/timetables' },
      }),
    ).toBe('curator');
    expect(
      selectStartWorker({
        allowedWorkers: ['operations', 'curator'],
        pageContext: { type: 'scheme', path: '/dashboard/school/courses/abc' },
      }),
    ).toBe('curator');
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
    expect(nodes).toContain('supervisor');
    expect(nodes).toContain('finance');
    expect(nodes).not.toContain('curator');
    expect(nodes).not.toContain('wait_for_apply');
  });

  it('includes wait_for_apply only when curator is compiled', () => {
    const nodes = adminGraphNodeNames(['operations', 'curator']);
    expect(nodes).toContain('curator');
    expect(nodes).toContain('wait_for_apply');
    expect(nodes).toContain('applied_ack');
  });
});
