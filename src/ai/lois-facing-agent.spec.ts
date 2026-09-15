import { FACING_SYSTEM, stitchWorkerDrafts } from './lois-facing-agent';
import { needsFacingRewrite } from './lois-reply-sanitize';

describe('Lois facing agent', () => {
  it('is instructed never to quote system role keys', () => {
    expect(FACING_SYSTEM).toMatch(/SCHOOL_ADMIN/);
    expect(FACING_SYSTEM).toMatch(/school_owner/);
    expect(FACING_SYSTEM).toMatch(/ordinary phrases/i);
    expect(FACING_SYSTEM).toMatch(/Return only the reply/);
    expect(FACING_SYSTEM).toMatch(/keep every section/i);
  });

  it('only rewrites drafts that still contain backend wording', () => {
    expect(needsFacingRewrite('On Thursday, JSS 1 A has Assembly at 07:00.')).toBe(false);
    expect(needsFacingRewrite('Your role is SCHOOL_ADMIN.')).toBe(true);
  });

  it('stitches every desk draft after the last user turn', () => {
    const stitched = stitchWorkerDrafts(
      [
        { role: 'user', content: 'older question' },
        { role: 'assistant', content: 'older answer' },
        {
          role: 'user',
          content:
            "attendance in JSS 1 A, who is in Adaeze's class, and who owes fees?",
        },
        { role: 'assistant', content: 'No attendance marks in JSS 1 A this fortnight.' },
        {
          role: 'assistant',
          content: 'Adaeze teaches Primary 1 A: Chiamaka Okafor and Ibrahim Musa.',
        },
      ],
      'Nobody has unpaid school fees on file.',
    );
    expect(stitched).toMatch(/No attendance marks/);
    expect(stitched).toMatch(/Chiamaka Okafor/);
    expect(stitched).toMatch(/unpaid school fees/);
    expect(stitched).not.toMatch(/older answer/);
  });
});
