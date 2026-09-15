import { ADMIN_GRAPH_WORKERS } from './lois-workers';
import { parseSlimPlan, mergeTurnPlan, needsSlim, emptyClarifyPlan } from './lois-turn-plan';

const allowed = ADMIN_GRAPH_WORKERS;

describe('parseSlimPlan', () => {
  it('accepts allowed specialist desks', () => {
    expect(
      parseSlimPlan(
        '{"mode":"desks","desks":["finance"],"missing":[],"question":"","reason":"debt"}',
        allowed,
      ),
    ).toEqual({
      mode: 'desks',
      desks: ['finance'],
      missing: [],
      question: null,
      reason: 'debt',
      schoolPart: null,
    });
  });

  it('accepts several desks', () => {
    expect(
      parseSlimPlan(
        '{"mode":"desks","desks":["academic","finance"],"missing":[],"question":"","reason":"mixed"}',
        allowed,
      ).desks,
    ).toEqual(['academic', 'finance']);
  });

  it('maps converse and end to clarify', () => {
    expect(parseSlimPlan('{"next":"converse"}', allowed).mode).toBe('clarify');
    expect(parseSlimPlan('{"mode":"end","desks":[],"missing":[],"question":"","reason":""}', allowed).mode).toBe(
      'clarify',
    );
  });

  it('maps unknown names and empty JSON to clarify', () => {
    expect(parseSlimPlan('{"next":"supervisor"}', allowed).mode).toBe('clarify');
    expect(parseSlimPlan('{}', allowed).mode).toBe('clarify');
    expect(parseSlimPlan('', allowed).mode).toBe('clarify');
  });

  it('ignores desks the caller is not allowed to use', () => {
    const plan = parseSlimPlan(
      '{"mode":"desks","desks":["finance"],"missing":[],"question":"","reason":"x"}',
      ['operations', 'curator'],
    );
    expect(plan.mode).toBe('clarify');
    expect(plan.desks).toEqual([]);
  });

  it('keeps non-desk modes', () => {
    expect(
      parseSlimPlan(
        '{"mode":"off_topic","desks":[],"missing":[],"question":"","reason":"recipe"}',
        allowed,
      ).mode,
    ).toBe('off_topic');
    expect(
      parseSlimPlan(
        '{"mode":"capability","desks":["finance"],"missing":[],"question":"","reason":"pay"}',
        allowed,
      ),
    ).toMatchObject({ mode: 'capability', desks: [] });
  });

  it('accepts legacy next desk', () => {
    expect(parseSlimPlan('{"next":"curator"}', allowed)).toMatchObject({
      mode: 'desks',
      desks: ['curator'],
    });
  });
});

describe('mergeTurnPlan', () => {
  it('keeps the coded desk and may add slim remainder', () => {
    expect(
      mergeTurnPlan({
        codedDesks: ['academic'],
        slim: {
          mode: 'desks',
          desks: ['finance', 'academic'],
          missing: [],
          question: null,
          reason: 'debt',
        },
      }).desks,
    ).toEqual(['academic', 'finance']);
  });

  it('ignores slim curator when code already picked a non-curator desk', () => {
    expect(
      mergeTurnPlan({
        codedDesks: ['operations'],
        slim: { mode: 'desks', desks: ['curator'], missing: [], question: null, reason: 'page' },
      }).desks,
    ).toEqual(['operations']);
  });

  it('ignores slim non-desk modes when code found a desk', () => {
    expect(
      mergeTurnPlan({
        codedDesks: ['operations'],
        slim: { mode: 'off_topic', desks: [], missing: [], question: null, reason: 'recipe' },
      }),
    ).toMatchObject({ mode: 'desks', desks: ['operations'] });
  });

  it('uses the slim desk when code found none', () => {
    expect(
      mergeTurnPlan({
        codedDesks: [],
        slim: { mode: 'desks', desks: ['curator'], missing: [], question: null, reason: 'generate' },
      }).desks,
    ).toEqual(['curator']);
  });

  it('keeps slim off_topic / capability / clarify when code is empty', () => {
    expect(
      mergeTurnPlan({
        codedDesks: [],
        slim: { mode: 'off_topic', desks: [], missing: [], question: null, reason: 'jollof' },
      }).mode,
    ).toBe('off_topic');
  });

  it('clarifies when slim is converse/empty and code found none', () => {
    expect(mergeTurnPlan({ codedDesks: [], slim: emptyClarifyPlan('converse') }).mode).toBe('clarify');
    expect(mergeTurnPlan({ codedDesks: [], slim: null }).mode).toBe('clarify');
  });
});

describe('needsSlim', () => {
  it('skips a clean single-desk regex hit', () => {
    expect(
      needsSlim({
        codedDesks: ['finance'],
        userMessage: 'Who still owes school fees?',
      }),
    ).toBe(false);
  });

  it('runs when code found nothing', () => {
    expect(needsSlim({ codedDesks: [], userMessage: 'how many people are in debt in JSS 1' })).toBe(true);
  });

  it('runs on a second clause the regex may have missed', () => {
    expect(
      needsSlim({
        codedDesks: ['academic'],
        userMessage:
          'What does attendance look like in JSS 1 A over the last two weeks, and how many people are in debt in that class?',
      }),
    ).toBe(true);
  });

  it('skips when anaphora already bound or the graph is interrupted', () => {
    expect(
      needsSlim({
        codedDesks: ['curator'],
        userMessage: 'do this also for JSS 2',
        anaphoraBound: true,
      }),
    ).toBe(false);
    expect(needsSlim({ interrupted: true, codedDesks: [], userMessage: 'hello' })).toBe(false);
  });
});
