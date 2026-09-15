import { emptyThreadMemory } from './lois-thread-memory';
import {
  codedDesksFromAnaphora,
  desksRequiredForMessage,
  isBlockingClassClarify,
  isCuratorApplyIntent,
  selectCodedDesks,
} from './lois-graph/lois-routing';
import {
  isCapabilityIntent,
  mergeTurnPlan,
  needsSlim,
  parseSlimPlan,
  type LoisTurnPlan,
} from './lois-turn-plan';
import { ADMIN_GRAPH_WORKERS } from './lois-workers';

const allowed = [...ADMIN_GRAPH_WORKERS];

function coded(message: string, memory = emptyThreadMemory()) {
  return selectCodedDesks({ allowedWorkers: allowed, userMessage: message, memory });
}

function merged(
  message: string,
  slim: LoisTurnPlan | null,
  memory = emptyThreadMemory(),
): { coded: string[]; mergedMode: string; desks: string[] } {
  const codedDesks = coded(message, memory);
  const anaphora = codedDesksFromAnaphora({
    userMessage: message,
    allowedWorkers: allowed,
    memory,
  });
  const plan = mergeTurnPlan({ codedDesks, slim, lastJob: memory.lastJob });
  return { coded: codedDesks, mergedMode: plan.mode, desks: plan.desks };
}

describe('unknown-ask catalog', () => {
  it('paraphrase debt is not coded finance (slim remainder)', () => {
    const message = 'how many people are in debt in JSS 1';
    expect(desksRequiredForMessage(message, allowed)).toEqual([]);
    const slim = parseSlimPlan(
      '{"mode":"desks","desks":["finance"],"missing":[],"question":"","reason":"debt"}',
      allowed,
    );
    expect(merged(message, slim)).toEqual({
      coded: [],
      mergedMode: 'desks',
      desks: ['finance'],
    });
  });

  it('coded attendance + paraphrase debt remainder', () => {
    const message =
      'What does attendance look like in JSS 1 A over the last two weeks, and how many people are in debt in that class?';
    expect(coded(message)).toEqual(['academic']);
    expect(needsSlim({ codedDesks: ['academic'], userMessage: message })).toBe(true);
    const slim = parseSlimPlan(
      '{"mode":"desks","desks":["finance"],"missing":[],"question":"","reason":"debt"}',
      allowed,
    );
    expect(merged(message, slim).desks).toEqual(['academic', 'finance']);
  });

  it('do this also for JSS 2 with lastJob curator is coded curator without slim', () => {
    const memory = emptyThreadMemory();
    memory.lastJob = { desk: 'curator', tool: 'propose_timetable', artifact: 'timetable' };
    const message = 'do this also for JSS 2';
    expect(
      codedDesksFromAnaphora({ userMessage: message, allowedWorkers: allowed, memory }).bound,
    ).toBe(true);
    expect(coded(message, memory)).toEqual(['curator']);
    expect(
      needsSlim({
        codedDesks: ['curator'],
        userMessage: message,
        anaphoraBound: true,
      }),
    ).toBe(false);
    expect(merged(message, null, memory)).toEqual({
      coded: ['curator'],
      mergedMode: 'desks',
      desks: ['curator'],
    });
  });

  it('take Chioma payment is capability with empty desks', () => {
    const message = "Take Chioma's school fees for me.";
    expect(isCapabilityIntent(message)).toBe(true);
    expect(coded(message)).toEqual([]);
  });

  it('late-coming policy is slim rag', () => {
    const slim = parseSlimPlan(
      '{"mode":"rag","desks":[],"missing":[],"question":"","reason":"policy"}',
      allowed,
    );
    expect(merged("what's our late-coming policy?", slim).mergedMode).toBe('rag');
  });

  it('recipe only is off_topic', () => {
    const slim = parseSlimPlan(
      '{"mode":"off_topic","desks":[],"missing":[],"question":"","reason":"jollof"}',
      allowed,
    );
    expect(merged('write me a full jollof rice recipe with quantities', slim).mergedMode).toBe(
      'off_topic',
    );
  });

  it('generate a timetable with empty memory is blocking clarify', () => {
    const message = 'Can you generate me a timetable?';
    expect(isBlockingClassClarify({ userMessage: message, memory: emptyThreadMemory() })).toBe(true);
    expect(coded(message)).toEqual(['curator']);
  });

  it('apply all is still curator', () => {
    expect(isCuratorApplyIntent('apply all')).toBe(true);
    expect(coded('apply all')).toEqual(['curator']);
  });
});
