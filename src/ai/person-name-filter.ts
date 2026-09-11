export function personNameTokens(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^(mr|mrs|ms|miss|dr|prof)\.?$/i.test(t));
}

/** Prisma name match: each token hits first or last name (and middle when asked). */
export function personNameWhere(
  raw: string,
  opts?: { middleName?: boolean },
): Record<string, unknown> {
  const tokens = personNameTokens(raw);
  if (tokens.length === 0) return {};
  const clause = (t: string) => {
    const OR: Record<string, unknown>[] = [
      { firstName: { contains: t, mode: 'insensitive' } },
      { lastName: { contains: t, mode: 'insensitive' } },
    ];
    if (opts?.middleName) {
      OR.push({ middleName: { contains: t, mode: 'insensitive' } });
    }
    return { OR };
  };
  if (tokens.length === 1) return clause(tokens[0]);
  return { AND: tokens.map(clause) };
}
