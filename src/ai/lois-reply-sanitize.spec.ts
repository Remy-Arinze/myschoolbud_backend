import {
  isBrushOffOnly,
  needsFacingRewrite,
  sanitizeUserFacingText,
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

describe('sanitizeUserFacingText', () => {
  it('turns system role labels into ordinary words', () => {
    const raw =
      'You, Arinze Obasi, are the school owner of Beulah High School. You hold the role of SCHOOL_ADMIN with the admin role of school_owner.';
    const clean = sanitizeUserFacingText(raw);
    expect(clean).not.toMatch(/SCHOOL_ADMIN/);
    expect(clean).not.toMatch(/school_owner/);
    expect(clean).toMatch(/school admin/i);
    expect(clean).toMatch(/school owner/i);
  });

  it('strips internal ids', () => {
    const clean = sanitizeUserFacingText('Student cmtjyqd0c0006ampdqq4ce7qy is in JSS 1 A.');
    expect(clean).not.toMatch(/cmtjyqd0c0006ampdqq4ce7qy/);
    expect(clean).toMatch(/JSS 1 A/);
  });
});

describe('needsFacingRewrite', () => {
  it('skips a clean school-facing draft', () => {
    expect(
      needsFacingRewrite(
        'The school owner is Arinze Obasi. There are 26 students and 86 teachers at Beulah High School.',
      ),
    ).toBe(false);
  });

  it('runs the copy desk when role enums leak', () => {
    expect(
      needsFacingRewrite(
        'You hold the role of SCHOOL_ADMIN with the admin role of school_owner.',
      ),
    ).toBe(true);
  });
});
