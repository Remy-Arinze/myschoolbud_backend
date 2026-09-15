import { coerceSlimPlan } from './lois-slim-coerce';
import { SLIM_STRETCH_CATALOG } from './lois-slim-stretch.catalog';
import { WILD_STRETCH_CATALOG } from './lois-wild-stretch.catalog';
import { slimHistoryBlock } from './lois-slim-supervisor';
import { capabilityReply, GENERIC_CAPABILITY_REPLY, offTopicReply, parseSlimPlan } from './lois-turn-plan';
import { ADMIN_GRAPH_WORKERS } from './lois-workers';

const allowed = [...ADMIN_GRAPH_WORKERS];

function prompt(id: string): string {
  const row = SLIM_STRETCH_CATALOG.find((r) => r.id === id);
  if (!row) throw new Error(`missing catalog id ${id}`);
  return row.prompt;
}

function wildPrompt(id: string): string {
  const row = WILD_STRETCH_CATALOG.find((r) => r.id === id);
  if (!row) throw new Error(`missing wild catalog id ${id}`);
  return row.prompt;
}

function fake(mode: string, desks: string[] = [], schoolPart = ''): ReturnType<typeof parseSlimPlan> {
  return parseSlimPlan(
    JSON.stringify({
      mode,
      desks,
      missing: [],
      question: mode === 'clarify' ? 'Which?' : '',
      reason: mode,
      schoolPart,
    }),
    allowed,
  );
}

function coerced(id: string, mode: string, desks: string[] = []) {
  return coerceSlimPlan({
    slim: fake(mode, desks),
    userMessage: prompt(id),
    allowedWorkers: allowed,
  });
}

function coercedWild(id: string, mode: string, desks: string[] = [], schoolPart = '') {
  return coerceSlimPlan({
    slim: fake(mode, desks, schoolPart),
    userMessage: wildPrompt(id),
    allowedWorkers: allowed,
  });
}

describe('coerceSlimPlan stretch catalog', () => {
  it('S4 children clarify becomes operations', () => {
    expect(coerced('S4-children-names', 'clarify')).toMatchObject({
      mode: 'desks',
      desks: ['operations'],
    });
  });

  it('S6 struggling clarify becomes academic', () => {
    expect(coerced('S6-struggling', 'clarify')).toMatchObject({
      mode: 'desks',
      desks: ['academic'],
    });
  });

  it('S8 revision capability becomes pedagogy', () => {
    expect(coerced('S8-revision-questions', 'capability')).toMatchObject({
      mode: 'desks',
      desks: ['pedagogy'],
    });
  });

  it('S9 Thursday board clarify becomes operations', () => {
    expect(coerced('S9-thursday-board', 'clarify')).toMatchObject({
      mode: 'desks',
      desks: ['operations'],
    });
  });

  it('S13 payroll stays capability', () => {
    expect(coerced('S13-payroll', 'capability')?.mode).toBe('capability');
  });

  it('S14 draft-not-send capability becomes operations', () => {
    expect(coerced('S14-draft-message', 'capability')).toMatchObject({
      mode: 'desks',
      desks: ['operations'],
    });
  });

  it('S16 jollof stays off_topic', () => {
    expect(coerced('S16-jollof', 'off_topic')?.mode).toBe('off_topic');
  });

  it('S18 schedule with no class stays clarify', () => {
    expect(coerced('S18-schedule-no-class', 'clarify')?.mode).toBe('clarify');
  });

  it('S21 October 1st off_topic becomes operations', () => {
    expect(coerced('S21-october-first', 'off_topic')).toMatchObject({
      mode: 'desks',
      desks: ['operations'],
    });
  });

  it('S24 recap off_topic becomes operations', () => {
    expect(coerced('S24-recap', 'off_topic')).toMatchObject({
      mode: 'desks',
      desks: ['operations'],
    });
  });
});

describe('coerceSlimPlan wild catalog', () => {
  it('W5 MCQs capability becomes pedagogy', () => {
    expect(coercedWild('W5-mcqs', 'capability')).toMatchObject({
      mode: 'desks',
      desks: ['pedagogy'],
    });
  });

  it('W7 note-I-can-copy capability becomes operations', () => {
    expect(coercedWild('W7-note-mum', 'capability')).toMatchObject({
      mode: 'desks',
      desks: ['operations'],
    });
  });

  it('W10 Christmas off_topic becomes operations', () => {
    expect(coercedWild('W10-christmas', 'off_topic')).toMatchObject({
      mode: 'desks',
      desks: ['operations'],
    });
  });

  it('W14 weather keeps the school clause and routes to a desk', () => {
    const plan = coercedWild('W14-weather-adaeze', 'off_topic', [], 'is Adaeze Okeke still with us?');
    expect(plan).toMatchObject({ mode: 'desks', desks: ['operations'] });
    expect(plan?.schoolPart).toBe('is Adaeze Okeke still with us?');
  });

  it('W11 jailbreak and W16 haiku stay off_topic', () => {
    expect(coercedWild('W11-jailbreak-eagles', 'off_topic')?.mode).toBe('off_topic');
    expect(coercedWild('W16-haiku', 'off_topic')?.mode).toBe('off_topic');
  });

  it('W13 WhatsApp broadcast stays capability', () => {
    expect(coercedWild('W13-whatsapp-teacher', 'capability')?.mode).toBe('capability');
  });

  it('an unrecognised capability paraphrase falls to a desk instead of the canned line', () => {
    expect(
      coerceSlimPlan({
        slim: fake('capability'),
        userMessage: 'Sort that thing out for me please.',
        allowedWorkers: allowed,
      }),
    ).toMatchObject({ mode: 'desks' });
  });
});

describe('capabilityReply', () => {
  it('does not treat don\'t send / just draft as a send-write', () => {
    const reply = capabilityReply(prompt('S14-draft-message'));
    expect(reply).not.toMatch(/don'?t send mail or WhatsApp/i);
    expect(reply).toBe(GENERIC_CAPABILITY_REPLY);
  });

  it('still refuses a positive send', () => {
    expect(capabilityReply('send a WhatsApp to her father')).toMatch(/don'?t send mail/i);
  });
});

describe('slimHistoryBlock', () => {
  it('drops canned off-topic and generic capability refusals, keeping the user turns', () => {
    const block = slimHistoryBlock([
      { role: 'user', content: 'write me a full jollof rice recipe with quantities' },
      { role: 'assistant', content: offTopicReply() },
      { role: 'user', content: 'are we shutting for October 1st' },
      { role: 'assistant', content: GENERIC_CAPABILITY_REPLY },
      { role: 'user', content: 'remind me the names you gave for the children in JSS 1 A' },
      { role: 'assistant', content: 'Chioma Nnamani and Kelechi Okonkwo are in JSS 1 A.' },
    ]);
    expect(block).not.toContain('refused off-topic');
    expect(block).not.toContain("I don't write recipes");
    expect(block).not.toContain(GENERIC_CAPABILITY_REPLY);
    expect(block).toContain('Chioma Nnamani and Kelechi Okonkwo');
    expect(block).toContain('are we shutting for October 1st');
  });
});
