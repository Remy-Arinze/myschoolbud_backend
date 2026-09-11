/** Collapse "JSS 2 A", "JSS 2A", "jss2a" to the same key. */
export function normalizeClassQueryKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function scoreClassQueryMatch(queryKey: string, labelKey: string, levelKey: string): number {
  if (!queryKey) return 1;
  if (labelKey === queryKey) return 100;
  if (labelKey.startsWith(queryKey) || queryKey.startsWith(labelKey)) return 80;
  if (labelKey.includes(queryKey) || queryKey.includes(labelKey)) return 60;
  if (levelKey === queryKey) return 40;
  if (levelKey.startsWith(queryKey) || queryKey.startsWith(levelKey)) return 30;
  if (levelKey.includes(queryKey)) return 20;
  return 0;
}

export type RankedClassMatch<T> = { item: T; score: number };

export function rankClassQueryMatches<T>(
  items: T[],
  query: string,
  labelOf: (item: T) => string,
  levelOf: (item: T) => string,
): RankedClassMatch<T>[] {
  const queryKey = normalizeClassQueryKey(query);
  return items
    .map((item) => ({
      item,
      score: scoreClassQueryMatch(
        queryKey,
        normalizeClassQueryKey(labelOf(item)),
        normalizeClassQueryKey(levelOf(item)),
      ),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Keep the tightest list_classes hits: an exact arm ("JSS 1B") must not also
 * return every sibling at that level.
 */
export function keepBestClassQueryMatches<T extends { score: number }>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const best = rows[0].score;
  if (best >= 100) return rows.filter((row) => row.score >= 100);
  if (best >= 80) return rows.filter((row) => row.score >= 80);
  return rows;
}

/** One unambiguous arm/class, or null if none / several equally good. */
export function pickUniqueClassQueryMatch<T>(ranked: RankedClassMatch<T>[]): T | null {
  if (ranked.length === 0) return null;
  const exact = ranked.filter((row) => row.score >= 100);
  if (exact.length === 1) return exact[0].item;
  if (exact.length > 1) return null;
  if (ranked.length === 1 && ranked[0].score >= 80) return ranked[0].item;
  if (ranked[0].score >= 80 && ranked[0].score > (ranked[1]?.score ?? 0)) {
    return ranked[0].item;
  }
  return null;
}
