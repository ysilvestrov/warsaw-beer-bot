import { describe, test, expect } from 'vitest';
import { aliasNeighbors, aliasKeys } from './brewery-aliases';

describe('aliasNeighbors', () => {
  test('returns direct partners symmetrically', () => {
    expect(aliasNeighbors('nepomucen')).toContain('nepo');
    expect(aliasNeighbors('nepo')).toContain('nepomucen');
    expect(aliasNeighbors('hopbrook')).toContain('hop brook');
    expect(aliasNeighbors('hop brook')).toContain('hopbrook');
    expect(aliasNeighbors('starkaft')).toContain('starkraft');
    expect(aliasNeighbors('starkraft')).toContain('starkaft');
    expect(aliasNeighbors('weihenstephaner')).toContain('bayerische staatsbrauerei weihenstephan');
    expect(aliasNeighbors('bayerische staatsbrauerei weihenstephan')).toContain('weihenstephaner');
    expect(aliasNeighbors('umanpivo')).toContain('уманьпиво');
    expect(aliasNeighbors('уманьпиво')).toContain('umanpivo');
    expect(aliasNeighbors('grimbergen')).toContain('alken maes');
    expect(aliasNeighbors('alken maes')).toContain('grimbergen');
    expect(aliasNeighbors('wroclove')).toContain('witnica');
    expect(aliasNeighbors('witnica')).toContain('wroclove');
    expect(aliasNeighbors('poutnik')).toContain('pelhrimov');
    expect(aliasNeighbors('pelhrimov')).toContain('poutnik');
    expect(aliasNeighbors('jezek kwasnicowy')).toContain('jihlava');
    expect(aliasNeighbors('jihlava')).toContain('jezek kwasnicowy');
  });

  test('kasteel vanhonsebrouck pairs with both van honsebrouck and bacchus', () => {
    expect(aliasNeighbors('kasteel vanhonsebrouck').sort()).toEqual(
      ['bacchus', 'van honsebrouck'],
    );
    expect(aliasNeighbors('van honsebrouck')).toEqual(['kasteel vanhonsebrouck']);
    expect(aliasNeighbors('bacchus')).toEqual(['kasteel vanhonsebrouck']);
  });

  test('is non-transitive: van honsebrouck and bacchus are not neighbors', () => {
    expect(aliasNeighbors('van honsebrouck')).not.toContain('bacchus');
    expect(aliasNeighbors('bacchus')).not.toContain('van honsebrouck');
  });

  test('unknown form returns empty array', () => {
    expect(aliasNeighbors('pinta')).toEqual([]);
    expect(aliasNeighbors('')).toEqual([]);
  });

  test('Polička locative declension pairs policka <-> v policce', () => {
    expect(aliasNeighbors('policka')).toContain('v policce');
    expect(aliasNeighbors('v policce')).toContain('policka');
  });
});

test('aliasKeys contains both sides of every curated pair, excludes non-aliases', () => {
  const keys = aliasKeys();
  expect(keys.has('nepomucen')).toBe(true);
  expect(keys.has('nepo')).toBe(true);
  expect(keys.has('napomucen')).toBe(true);
  expect(keys.has('starkraft')).toBe(true);
  expect(keys.has('starkaft')).toBe(true);
  expect(keys.has('уманпиво')).toBe(false);
  expect(keys.has('уманьпиво')).toBe(true);
  expect(keys.has('pinta')).toBe(false);
});

describe('#318 gate-miss alias batch', () => {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['aecht schlenkerla', 'schlenkerla'],
    ['lausitzer', 'privatbrauerei eibau'],
    ['grybow pilsvar', 'pilsvar'],
    ['cydr dobronski', 'jnt group'],
    ['prerov', 'zubr'],
    ['bakalar', 'tradicni v rakovniku'],
    ['dzik', 'cydrownia'],
    ['panipani', 'trzech kumpli'],
    ['vibrant pour', 'vibrantpour'],
    ['smoothiemaker', 'mad brew'],
    ['drofa', 'дрофа'],
  ];
  test.each(PAIRS)('resolves %s <-> %s symmetrically', (shop, untappd) => {
    expect(aliasNeighbors(shop)).toContain(untappd);
    expect(aliasNeighbors(untappd)).toContain(shop);
  });
  // The batch must not create a hub (a form shared by >1 partner) — each new
  // form is a 1:1 equivalence, so every form in the batch has exactly one neighbour.
  test.each(PAIRS.flat())('form %s has exactly one neighbour (no new hub)', (form) => {
    expect(aliasNeighbors(form)).toHaveLength(1);
  });
});

describe('#329 gate-miss alias batch', () => {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['ziemia obiacana', 'ziemia obiecana'],
    ['bergqell', 'bergquell lobau'],
    ['bracki zamkowy w cieszynie', 'arcyksiazecy zamkowy cieszyn'],
    ['tank busters', 'tankbusters'],
  ];
  test.each(PAIRS)('resolves %s <-> %s symmetrically', (shop, untappd) => {
    expect(aliasNeighbors(shop)).toContain(untappd);
    expect(aliasNeighbors(untappd)).toContain(shop);
  });
  // Each new form is a 1:1 equivalence — no shared form, so no new alias hub.
  test.each(PAIRS.flat())('form %s has exactly one neighbour (no new hub)', (form) => {
    expect(aliasNeighbors(form)).toHaveLength(1);
  });
});
