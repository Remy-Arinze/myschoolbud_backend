import { FACING_SYSTEM } from './lois-facing-agent';
import { needsFacingRewrite } from './lois-reply-sanitize';

describe('Lois facing agent', () => {
  it('is instructed never to quote system role keys', () => {
    expect(FACING_SYSTEM).toMatch(/SCHOOL_ADMIN/);
    expect(FACING_SYSTEM).toMatch(/school_owner/);
    expect(FACING_SYSTEM).toMatch(/ordinary phrases/i);
    expect(FACING_SYSTEM).toMatch(/Return only the reply/);
  });

  it('only rewrites drafts that still contain backend wording', () => {
    expect(needsFacingRewrite('On Thursday, JSS 1 A has Assembly at 07:00.')).toBe(false);
    expect(needsFacingRewrite('Your role is SCHOOL_ADMIN.')).toBe(true);
  });
});
