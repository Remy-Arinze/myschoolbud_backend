import {
  keepBestClassQueryMatches,
  normalizeClassQueryKey,
  pickUniqueClassQueryMatch,
  rankClassQueryMatches,
} from './class-query.util';

describe('class-query.util', () => {
  const arms = [
    { id: '1a', level: 'JSS 1', name: 'A' },
    { id: '1b', level: 'JSS 1', name: 'B' },
    { id: '2a', level: 'JSS 2', name: 'A' },
    { id: '2b', level: 'JSS 2', name: 'B' },
    { id: '2c', level: 'JSS 2', name: 'C' },
  ];
  const rank = (query: string) =>
    rankClassQueryMatches(
      arms,
      query,
      (a) => `${a.level} ${a.name}`,
      (a) => a.level,
    );

  it('normalizes spaced and compact names', () => {
    expect(normalizeClassQueryKey('JSS 2 A')).toBe('jss2a');
    expect(normalizeClassQueryKey('JSS 2A')).toBe('jss2a');
    expect(normalizeClassQueryKey('jss2a')).toBe('jss2a');
  });

  it('resolves JSS 2 A / JSS1B to a single arm', () => {
    expect(pickUniqueClassQueryMatch(rank('JSS 2 A'))?.id).toBe('2a');
    expect(pickUniqueClassQueryMatch(rank('JSS 2A'))?.id).toBe('2a');
    expect(pickUniqueClassQueryMatch(rank('JSS 1 B'))?.id).toBe('1b');
    expect(pickUniqueClassQueryMatch(rank('JSS1B'))?.id).toBe('1b');
  });

  it('keeps only exact arms when the query names one, and all arms when it names a level', () => {
    const ranked = (query: string) => rank(query);
    expect(keepBestClassQueryMatches(ranked('JSS 1B')).map((r) => r.item.id)).toEqual(['1b']);
    expect(keepBestClassQueryMatches(ranked('JSS 2')).map((r) => r.item.id).sort()).toEqual([
      '2a',
      '2b',
      '2c',
    ]);
  });

  it('does not collapse a whole level into one arm', () => {
    expect(pickUniqueClassQueryMatch(rank('JSS 2'))).toBeNull();
    expect(rank('JSS 2').map((r) => r.item.id).sort()).toEqual(['2a', '2b', '2c']);
  });
});
