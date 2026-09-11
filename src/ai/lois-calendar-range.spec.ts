import {
  addDaysYmd,
  extractNamedCalendarDates,
  inferCalendarPreset,
  mergeAssistantTurns,
  mondayOfWeek,
  resolveCalendarWindow,
} from './lois-calendar-range';

describe('lois-calendar-range', () => {
  it('pins this week to Monday–Sunday around 10 Sep 2026', () => {
    expect(mondayOfWeek('2026-09-10')).toBe('2026-09-07');
    const w = resolveCalendarWindow({ range: 'this_week', from: '2026-09-28', to: '2026-10-06' }, '2026-09-10');
    expect(w).toEqual({ from: '2026-09-07', to: '2026-09-13', preset: 'this_week' });
  });

  it('overrides invented from/to when the user said this week', () => {
    const w = resolveCalendarWindow(
      { from: '2026-09-28', to: '2026-10-06' },
      '2026-09-10',
      "What's happening this week?",
    );
    expect(w.from).toBe('2026-09-07');
    expect(w.to).toBe('2026-09-13');
    expect(w.preset).toBe('this_week');
  });

  it('still pins this week when Independence Day is asked in the same breath', () => {
    const msg =
      'Snapshot please: what is happening this week, and are we closed on Independence Day?';
    const w = resolveCalendarWindow({}, '2026-09-10', msg);
    expect(w).toEqual({ from: '2026-09-07', to: '2026-09-13', preset: 'this_week' });
    expect(extractNamedCalendarDates(msg, '2026-09-10')).toEqual([
      { label: 'Independence Day', date: '2026-10-01' },
    ]);
  });

  it('does not treat a named date as this week', () => {
    expect(inferCalendarPreset(undefined, 'Are we on holiday on 1 October?')).toBeNull();
    const w = resolveCalendarWindow(
      { from: '2026-10-01', to: '2026-10-01' },
      '2026-09-10',
      'Are we on holiday on 1 October?',
    );
    expect(w).toEqual({ from: '2026-10-01', to: '2026-10-01', preset: 'custom' });
  });

  it('resolves next week from today', () => {
    const w = resolveCalendarWindow({}, '2026-09-10', 'What is on next week?');
    expect(w).toEqual({ from: '2026-09-14', to: '2026-09-20', preset: 'next_week' });
  });

  it('addDaysYmd crosses month bounds', () => {
    expect(addDaysYmd('2026-09-28', 8)).toBe('2026-10-06');
  });
});

describe('mergeAssistantTurns', () => {
  it('drops an identical second refusal', () => {
    const once = "I can't add a teacher from chat. Use Staff in the dashboard.";
    expect(mergeAssistantTurns(once, once)).toBe(once);
  });
});

describe('default calendar window', () => {
  it('uses this week when from/to are omitted', () => {
    const w = resolveCalendarWindow({}, '2026-09-10');
    expect(w).toEqual({ from: '2026-09-07', to: '2026-09-13', preset: 'this_week' });
  });
});
