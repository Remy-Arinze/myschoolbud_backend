import {
  isBrushOffOnly,
  stripDashboardBrushOff,
} from './lois-reply-sanitize';
import { mergeAssistantTurns } from './lois-calendar-range';

describe('lois-reply-sanitize', () => {
  const brush =
    "I don't have access to details about outstanding school fees. You can check the Fees page on the dashboard for a list of students who owe fees.";
  const real = 'There are currently no students with outstanding school fees at Beulah High School.';

  it('strips dashboard brush-off and keeps the tool sentence', () => {
    expect(stripDashboardBrushOff(`${brush}${real}`)).toMatch(/no students with outstanding/i);
    expect(stripDashboardBrushOff(`${brush}${real}`)).not.toMatch(/don'?t have access/i);
  });

  it('treats brush-off-only text as empty for the user', () => {
    expect(isBrushOffOnly(brush)).toBe(true);
    expect(isBrushOffOnly(real)).toBe(false);
  });

  it('drops a prior brush-off when the next turn has a real answer', () => {
    expect(mergeAssistantTurns(brush, real)).toBe(real);
  });

  it('keeps a real answer if a later turn is only brush-off', () => {
    expect(mergeAssistantTurns(real, brush)).toBe(real);
  });
});
