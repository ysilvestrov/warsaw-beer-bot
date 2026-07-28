import { test, expect, vi } from 'vitest';
import { verifyCauses } from './triage-verify';
import type { Verdict } from './triage-analysis';
import type { SearchResult } from '../sources/untappd/search';

const causal = (over: Partial<Verdict> = {}): Verdict => ({
  beer_id: 1, review_class: 'matcher_bug', review_note: 'alias gap',
  issue_number: 347, new_issue_key: null,
  proposed_query: 'Petrus Kriek', expected_target: 'Brouwerij De Brabandere — Petrus Kriek',
  ...over,
});

const hit: SearchResult = {
  bid: 6682946, beer_name: 'Petrus Kriek', brewery_name: 'Brouwerij De Brabandere',
  style: 'Sour - Fruited', abv: 4, global_rating: null,
};

test('a verdict whose proposed query returns the expected target is verified', async () => {
  const search = { search: vi.fn().mockResolvedValue([hit]) };
  const res = await verifyCauses({ verdicts: [causal()], search, limit: 10 });
  expect(res.get(1)).toBe(true);
  expect(search.search).toHaveBeenCalledWith('Petrus Kriek');
});

test('a verdict whose target is absent from the results is unverified', async () => {
  const search = { search: vi.fn().mockResolvedValue([{ ...hit, beer_name: 'Petrus Aged Red' }]) };
  const res = await verifyCauses({ verdicts: [causal()], search, limit: 10 });
  expect(res.get(1)).toBe(false);
});

test('matching ignores case, diacritics and separator drift', async () => {
  const search = { search: vi.fn().mockResolvedValue([hit]) };
  const res = await verifyCauses({
    verdicts: [causal({ expected_target: 'brouwerij de brabandere - PETRUS kriek' })],
    search, limit: 10,
  });
  expect(res.get(1)).toBe(true);
});

test('a causal verdict without a proposed query is unverified and costs no search', async () => {
  const search = { search: vi.fn() };
  const res = await verifyCauses({
    verdicts: [causal({ proposed_query: null })], search, limit: 10,
  });
  expect(res.get(1)).toBe(false);
  expect(search.search).not.toHaveBeenCalled();
});

test('non-causal verdicts are not verified at all', async () => {
  const search = { search: vi.fn() };
  const res = await verifyCauses({
    verdicts: [causal({ issue_number: null, new_issue_key: null })], search, limit: 10,
  });
  expect(res.size).toBe(0);
  expect(search.search).not.toHaveBeenCalled();
});

test('a throwing search leaves the verdict unverified without failing the run', async () => {
  const search = { search: vi.fn().mockRejectedValue(new Error('breaker open')) };
  const res = await verifyCauses({ verdicts: [causal()], search, limit: 10 });
  expect(res.get(1)).toBe(false);
});

test('verdicts past the search budget are unverified rather than skipped', async () => {
  const search = { search: vi.fn().mockResolvedValue([hit]) };
  const res = await verifyCauses({
    verdicts: [causal({ beer_id: 1 }), causal({ beer_id: 2 })], search, limit: 1,
  });
  expect(res.get(1)).toBe(true);
  expect(res.get(2)).toBe(false);
  expect(search.search).toHaveBeenCalledTimes(1);
});
