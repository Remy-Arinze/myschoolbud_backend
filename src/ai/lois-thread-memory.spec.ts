import { applyToolEventsToMemory, emptyThreadMemory, parseThreadMemory } from './lois-thread-memory';
import {
  codedDesksFromAnaphora,
  isBlockingClassClarify,
  selectCodedDesks,
} from './lois-graph/lois-routing';
import { isCapabilityIntent } from './lois-turn-plan';
import { ADMIN_GRAPH_WORKERS } from './lois-workers';

const allowed = ADMIN_GRAPH_WORKERS;

describe('thread memory from tools', () => {
  it('records curator lastJob from propose_timetable', () => {
    const next = applyToolEventsToMemory(emptyThreadMemory(), [
      {
        type: 'tool_result',
        toolName: 'propose_timetable',
        entityLabel: 'JSS 2 A',
        args: { classQuery: 'JSS 2 A' },
        result: { classLabel: 'JSS 2 A' },
      },
    ]);
    expect(next.lastJob).toEqual({
      desk: 'curator',
      tool: 'propose_timetable',
      artifact: 'timetable',
    });
    expect(next.classes).toContain('JSS 2 A');
  });

  it('round-trips JSON memory', () => {
    const raw = {
      lastJob: { desk: 'curator', tool: 'propose_timetable', artifact: 'timetable' },
      classes: ['JSS 2 A'],
      people: [],
      range: null,
      pendingClarify: { slot: 'class', question: 'Which class?', resumeDesks: ['curator'] },
    };
    expect(parseThreadMemory(raw).pendingClarify?.resumeDesks).toEqual(['curator']);
  });
});

describe('code anaphora', () => {
  it('binds curator on do-this-also when lastJob is propose_timetable', () => {
    const memory = emptyThreadMemory();
    memory.lastJob = { desk: 'curator', tool: 'propose_timetable', artifact: 'timetable' };
    expect(
      codedDesksFromAnaphora({
        userMessage: 'do this also for JSS 2',
        allowedWorkers: allowed,
        memory,
      }),
    ).toEqual({ desks: ['curator'], bound: true });
  });

  it('resumes pendingClarify on a class name', () => {
    const memory = emptyThreadMemory();
    memory.pendingClarify = {
      slot: 'class',
      question: 'Which class or level should I generate a timetable for?',
      resumeDesks: ['curator'],
    };
    expect(
      codedDesksFromAnaphora({
        userMessage: 'JSS 2 A',
        allowedWorkers: allowed,
        memory,
      }).bound,
    ).toBe(true);
  });

  it('does not resume pendingClarify on a new school ask', () => {
    const memory = emptyThreadMemory();
    memory.pendingClarify = {
      slot: 'class',
      question: 'Which class?',
      resumeDesks: ['curator'],
    };
    expect(
      codedDesksFromAnaphora({
        userMessage: 'Who still owes school fees?',
        allowedWorkers: allowed,
        memory,
      }).bound,
    ).toBe(false);
  });
});

describe('blocking class clarify', () => {
  it('asks when generate has no class and memory is empty', () => {
    expect(
      isBlockingClassClarify({
        userMessage: 'Can you generate me a timetable?',
        memory: emptyThreadMemory(),
      }),
    ).toBe(true);
  });

  it('does not ask when a class is named', () => {
    expect(
      isBlockingClassClarify({
        userMessage: 'generate a timetable for JSS 2 A',
        memory: emptyThreadMemory(),
      }),
    ).toBe(false);
  });
});

describe('capability intent', () => {
  it('matches take payment and hire staff', () => {
    expect(isCapabilityIntent("Take Chioma's school fees for me.")).toBe(true);
    expect(isCapabilityIntent('Can you hire a new maths teacher staff?')).toBe(true);
  });

  it('does not match who owes fees', () => {
    expect(isCapabilityIntent('Who still owes school fees?')).toBe(false);
  });
});

describe('selectCodedDesks with memory', () => {
  it('starts curator from anaphora without slim', () => {
    const memory = emptyThreadMemory();
    memory.lastJob = { desk: 'curator', tool: 'propose_timetable', artifact: 'timetable' };
    expect(
      selectCodedDesks({
        allowedWorkers: allowed,
        userMessage: 'do this also for JSS 2',
        memory,
      }),
    ).toEqual(['curator']);
  });
});
