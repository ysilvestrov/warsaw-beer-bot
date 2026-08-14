import { isLegalScope, rowSatisfiesScope, type Scope } from './triage-scope';
import type { UntriagedFailure } from '../storage/enrich_failures';

const row = (over: Partial<UntriagedFailure> = {}): UntriagedFailure => ({
  beer_id: 1, brewery: 'Mad Brew', name: 'Bulgogi', search_url: 'https://x/?q=a',
  source_url: 'https://flasker.com.ua/p/1', candidates_count: 3, candidates_summary: '',
  fail_count: 1, last_at: '2026-08-14T00:00:00.000Z', abv: 4.2, style: 'IPA', ...over,
});

test('a where-scope of review_class alone is illegal', () => {
  const scope: Scope = { beer_ids: [], where: [{ col: 'review_class', op: '=', value: 'matcher_bug' }] };
  expect(isLegalScope(scope)).toBe(false);
});

test('review_class plus one other column is legal', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [
      { col: 'review_class', op: '=', value: 'matcher_bug' },
      { col: 'candidates_count', op: '=', value: 0 },
    ],
  };
  expect(isLegalScope(scope)).toBe(true);
});

test('an enumerated cohort alone is legal', () => {
  expect(isLegalScope({ beer_ids: [34005, 11952], where: [] })).toBe(true);
});

test('an empty scope is illegal', () => {
  expect(isLegalScope({ beer_ids: [], where: [] })).toBe(false);
});

test('a row in beer_ids satisfies the scope regardless of where', () => {
  const scope: Scope = { beer_ids: [1], where: [{ col: 'candidates_count', op: '=', value: 0 }] };
  expect(rowSatisfiesScope(row({ candidates_count: 9 }), 'matcher_bug', scope)).toBe(true);
});

test('a zero-candidate row does not satisfy a candidates_count > 0 scope', () => {
  const scope: Scope = { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] };
  expect(rowSatisfiesScope(row({ candidates_count: 0 }), 'matcher_bug', scope)).toBe(false);
});

test('review_class is matched against the verdict class, not the row', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [
      { col: 'review_class', op: '=', value: 'parser_bug' },
      { col: 'source_url', op: 'contains', value: 'flasker' },
    ],
  };
  expect(rowSatisfiesScope(row(), 'parser_bug', scope)).toBe(true);
  expect(rowSatisfiesScope(row(), 'matcher_bug', scope)).toBe(false);
});

test('an empty where never satisfies vacuously', () => {
  expect(rowSatisfiesScope(row(), 'matcher_bug', { beer_ids: [2], where: [] })).toBe(false);
});

test('string and null operators', () => {
  expect(rowSatisfiesScope(row({ brewery: '' }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'brewery', op: 'empty' }] })).toBe(true);
  expect(rowSatisfiesScope(row({ abv: null }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'abv', op: 'is_null' }] })).toBe(true);
  expect(rowSatisfiesScope(row({ style: 'IPA' }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'style', op: 'is_not_null' }] })).toBe(true);
});
