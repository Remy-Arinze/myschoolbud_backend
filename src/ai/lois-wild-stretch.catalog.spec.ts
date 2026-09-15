import { desksRequiredForMessage, selectCodedDesks } from './lois-graph/lois-routing';
import { isCapabilityIntent, needsSlim } from './lois-turn-plan';
import { emptyThreadMemory } from './lois-thread-memory';
import { ADMIN_GRAPH_WORKERS } from './lois-workers';
import { WILD_STRETCH_CATALOG } from './lois-wild-stretch.catalog';

const allowed = [...ADMIN_GRAPH_WORKERS];

function coded(message: string) {
  return selectCodedDesks({
    allowedWorkers: allowed,
    userMessage: message,
    memory: emptyThreadMemory(),
  });
}

describe('wild stretch catalog vs coded routes', () => {
  it('every prompt misses coded desks and would call slim standalone', () => {
    const leaks: string[] = [];
    for (const row of WILD_STRETCH_CATALOG) {
      const desks = coded(row.prompt);
      const regex = desksRequiredForMessage(row.prompt, allowed);
      if (desks.length > 0 || regex.length > 0) {
        leaks.push(`${row.id}: coded=${desks.join(',') || '—'} regex=${regex.join(',') || '—'}`);
      }
      if (isCapabilityIntent(row.prompt)) {
        leaks.push(`${row.id}: matched capability regex`);
      }
      if (!needsSlim({ codedDesks: desks, userMessage: row.prompt })) {
        leaks.push(`${row.id}: needsSlim=false`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
