import { test, expect, vi } from 'vitest';
import { absenceProvedBy, collectTriageProbes, PROBE_SEARCHES_PER_ORPHAN } from './triage-probes';
import type { UntriagedFailure } from '../storage/enrich_failures';
import type { SearchResult } from '../sources/untappd/search';

const orphan = (over: Partial<UntriagedFailure> = {}): UntriagedFailure => ({
  beer_id: 1, brewery: 'Artezan Brewery', name: 'Jasne Niepasteryzowane',
  search_url: 'https://untappd.com/search?q=Artezan', source_url: '',
  candidates_count: 0, candidates_summary: '', fail_count: 1,
  last_at: '2026-07-28T00:00:00.000Z', abv: 4.6, style: 'Lager',
  ...over,
});

const hit = (name: string): SearchResult => ({
  bid: 6666784, beer_name: name, brewery_name: 'Browar Artezan',
  style: 'Lager - Pale', abv: 5, global_rating: null,
});

test('probes brewery-only and name-only for a zero-candidate orphan', async () => {
  const search = { search: vi.fn().mockResolvedValue([hit('Jasne')]) };
  const probes = await collectTriageProbes({ orphans: [orphan()], search, limit: 10 });

  expect(search.search).toHaveBeenCalledTimes(PROBE_SEARCHES_PER_ORPHAN);
  expect(search.search).toHaveBeenCalledWith('Artezan');
  expect(search.search).toHaveBeenCalledWith('Jasne Niepasteryzowane');
  expect(probes.get(1)).toEqual({
    brewery: 'Browar Artezan — Jasne (bid 6666784, 5.0%, Lager - Pale)',
    name: 'Browar Artezan — Jasne (bid 6666784, 5.0%, Lager - Pale)',
  });
});

test('skips orphans that already have candidates', async () => {
  const search = { search: vi.fn().mockResolvedValue([]) };
  const probes = await collectTriageProbes({
    orphans: [orphan({ candidates_count: 2, candidates_summary: 'X — Y (bid 1)' })],
    search, limit: 10,
  });

  expect(search.search).not.toHaveBeenCalled();
  expect(probes.size).toBe(0);
});

test('stops probing once the per-run limit is exhausted', async () => {
  const search = { search: vi.fn().mockResolvedValue([]) };
  const orphans = [orphan({ beer_id: 1 }), orphan({ beer_id: 2 }), orphan({ beer_id: 3 })];
  await collectTriageProbes({ orphans, search, limit: PROBE_SEARCHES_PER_ORPHAN * 2 });

  expect(search.search).toHaveBeenCalledTimes(PROBE_SEARCHES_PER_ORPHAN * 2);
});

test('a failing probe is swallowed and leaves the other probe intact', async () => {
  const search = {
    search: vi.fn()
      .mockRejectedValueOnce(new Error('breaker open'))
      .mockResolvedValueOnce([hit('Jasne')]),
  };
  const probes = await collectTriageProbes({ orphans: [orphan()], search, limit: 10 });

  expect(probes.get(1)?.brewery).toBeUndefined();
  expect(probes.get(1)?.name).toContain('Browar Artezan');
});

// absenceProvedBy is the single answer to "may this row be called absent?", shared by
// the routing guard and the write chokepoint. Replacing the `=== ''` comparisons with
// `probe !== undefined` turns every case below red except the first.
test('absence is proved only by a probe that ran and came back empty', () => {
  expect(absenceProvedBy(undefined)).toBe(false);                        // never ran
  expect(absenceProvedBy({})).toBe(false);                               // ran neither side
  expect(absenceProvedBy({ brewery: 'Mad Elf, MadTree' })).toBe(false);  // ran, found things
  expect(absenceProvedBy({ brewery: '' })).toBe(true);                   // ran, empty
  expect(absenceProvedBy({ name: '' })).toBe(true);
  expect(absenceProvedBy({ brewery: 'Mad Elf', name: '' })).toBe(true);  // either side suffices
});
