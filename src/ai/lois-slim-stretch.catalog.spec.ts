import { desksRequiredForMessage, selectCodedDesks } from './lois-graph/lois-routing';
import { isCapabilityIntent, needsSlim } from './lois-turn-plan';
import { isLoisSmallTalk } from './lois-small-talk';
import { emptyThreadMemory } from './lois-thread-memory';
import { ADMIN_GRAPH_WORKERS } from './lois-workers';
import { SLIM_STRETCH_CATALOG } from './lois-slim-stretch.catalog';

const allowed = [...ADMIN_GRAPH_WORKERS];

function coded(message: string) {
  return selectCodedDesks({
    allowedWorkers: allowed,
    userMessage: message,
    memory: emptyThreadMemory(),
  });
}

describe('slim stretch catalog vs coded routes', () => {
  it('every slim-path prompt misses coded desks and would call slim standalone', () => {
    const slimRows = SLIM_STRETCH_CATALOG.filter((row) => row.path === 'slim');
    expect(slimRows.length).toBeGreaterThan(10);

    const leaks: string[] = [];
    for (const row of slimRows) {
      const desks = coded(row.prompt);
      const regex = desksRequiredForMessage(row.prompt, allowed);
      if (desks.length > 0 || regex.length > 0) {
        leaks.push(`${row.id}: coded=${desks.join(',') || '—'} regex=${regex.join(',') || '—'}`);
      }
      if (isCapabilityIntent(row.prompt)) {
        leaks.push(`${row.id}: matched capability regex (should be slim paraphrase)`);
      }
      if (!needsSlim({ codedDesks: desks, userMessage: row.prompt })) {
        leaks.push(`${row.id}: needsSlim=false with empty/partial code`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('small-talk rows stay on the greeting path, not slim', () => {
    for (const row of SLIM_STRETCH_CATALOG.filter((r) => r.path === 'small-talk')) {
      expect(isLoisSmallTalk(row.prompt)).toBe(true);
      expect(coded(row.prompt)).toEqual([]);
    }
  });

  it('anaphora and slot-fill rows still miss a fresh coded desk', () => {
    for (const row of SLIM_STRETCH_CATALOG.filter((r) => r.path === 'anaphora' || r.path === 'slot-fill')) {
      expect(coded(row.prompt)).toEqual([]);
      expect(desksRequiredForMessage(row.prompt, allowed)).toEqual([]);
    }
  });
});
