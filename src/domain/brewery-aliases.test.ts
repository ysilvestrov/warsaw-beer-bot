import { describe, test, expect } from 'vitest';
import { aliasNeighbors } from './brewery-aliases';

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
});
