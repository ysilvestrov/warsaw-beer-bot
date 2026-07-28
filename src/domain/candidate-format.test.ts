import { test, expect } from 'vitest';
import { formatCandidate, summarizeCandidates } from './candidate-format';
import type { SearchResult } from '../sources/untappd/search';

const r = (over: Partial<SearchResult> = {}): SearchResult => ({
  bid: 1511478,
  beer_name: 'Cornelius Hazy APA',
  brewery_name: 'Browar Cornelius',
  style: 'IPA - American',
  abv: 5,
  global_rating: null,
  ...over,
});

test('formatCandidate renders brewery, name, bid, abv and style', () => {
  expect(formatCandidate(r())).toBe(
    'Browar Cornelius — Cornelius Hazy APA (bid 1511478, 5.0%, IPA - American)',
  );
});

test('formatCandidate omits missing abv and style without leaving gaps', () => {
  expect(formatCandidate(r({ abv: null, style: null }))).toBe(
    'Browar Cornelius — Cornelius Hazy APA (bid 1511478)',
  );
});

test('summarizeCandidates joins at most three candidates', () => {
  const many = [r({ bid: 1 }), r({ bid: 2 }), r({ bid: 3 }), r({ bid: 4 })];
  const out = summarizeCandidates(many);
  expect(out.split('; ')).toHaveLength(3);
  expect(out).toContain('bid 1');
  expect(out).not.toContain('bid 4');
});

test('summarizeCandidates renders an empty list as an empty string', () => {
  expect(summarizeCandidates([])).toBe('');
});
