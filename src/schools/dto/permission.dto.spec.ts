import { AdminAccessTier } from '@prisma/client';
import {
  hasPrincipalAccess,
  isPrincipalRole,
  isSchoolOwnerRole,
  looksLikePrincipalTitle,
  canonicalizeUniqueTitle,
  uniqueTitleDisplayName,
} from './permission.dto';

describe('principal role helpers', () => {
  it('treats spaced titles as underscores', () => {
    expect(isPrincipalRole('Head Teacher')).toBe(true);
    expect(isPrincipalRole('School Owner')).toBe(true);
    expect(isPrincipalRole('Vice Principal')).toBe(false);
    expect(isPrincipalRole('vice_principal')).toBe(false);
  });

  // isPrincipalRole normalises separators but not their absence, so these two
  // spellings of the same job read as ordinary staff. That is exactly why the
  // helper is a hint and no longer decides authority: before accessTier
  // existed, hiring a "Headteacher" silently produced a powerless principal,
  // and renaming one to "Head Teacher" silently granted total access.
  it('is only a hint: it misses principal titles spelled without a separator', () => {
    expect(isPrincipalRole('Headteacher')).toBe(false);
    expect(isPrincipalRole('Head-Teacher')).toBe(false);
    expect(isPrincipalRole('headteacher')).toBe(false);
  });

  it('nudges on the spellings the hint misses', () => {
    expect(looksLikePrincipalTitle('Headteacher')).toBe(true);
    expect(looksLikePrincipalTitle('Head-Teacher')).toBe(true);
    expect(looksLikePrincipalTitle('Head Teacher')).toBe(true);
    expect(looksLikePrincipalTitle('Bursar')).toBe(false);
  });

  it('reads authority from the tier, never from the title', () => {
    expect(hasPrincipalAccess({ accessTier: AdminAccessTier.PRINCIPAL })).toBe(true);
    expect(hasPrincipalAccess({ accessTier: AdminAccessTier.STAFF })).toBe(false);
    // A title that would have granted everything under the old string match.
    expect(
      hasPrincipalAccess({ accessTier: AdminAccessTier.STAFF, role: 'Head Teacher' } as never),
    ).toBe(false);
    // And one that would have granted nothing.
    expect(
      hasPrincipalAccess({ accessTier: AdminAccessTier.PRINCIPAL, role: 'Headteacher' } as never),
    ).toBe(true);
    // Teachers and unknown records carry no tier, so they carry no authority.
    expect(hasPrincipalAccess({ accessTier: null })).toBe(false);
    expect(hasPrincipalAccess(undefined)).toBe(false);
  });

  it('collapses school_principal into the principal seat', () => {
    expect(canonicalizeUniqueTitle('school_principal')).toBe('principal');
    expect(canonicalizeUniqueTitle('School Principal')).toBe('principal');
    expect(uniqueTitleDisplayName('school_principal')).toBe('Principal');
  });

  it('identifies the school owner only', () => {
    expect(isSchoolOwnerRole('school_owner')).toBe(true);
    expect(isSchoolOwnerRole('School Owner')).toBe(true);
    expect(isSchoolOwnerRole('principal')).toBe(false);
  });
});
