import { matchBeer } from './matcher';

const catalog = [
  { id: 1, brewery: 'Pinta', name: 'Atak Chmielu' },
  { id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta' },
  { id: 3, brewery: 'Piwne Podziemie', name: 'Hopinka' },
];

test('exact normalized match is confidence 1', () => {
  const m = matchBeer({ brewery: 'PINTA', name: 'Atak Chmielu IPA' }, catalog);
  expect(m).toEqual({ id: 1, confidence: 1, source: 'exact' });
});

test('fuzzy match above threshold returns 0.85..1 confidence', () => {
  const m = matchBeer({ brewery: 'Stu Mostow', name: 'Buty Skejty' }, catalog);
  expect(m?.id).toBe(2);
  expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
  expect(m!.confidence).toBeLessThan(1);
});

test('no match below threshold returns null', () => {
  expect(matchBeer({ brewery: 'Random', name: 'Xyz' }, catalog)).toBeNull();
});
