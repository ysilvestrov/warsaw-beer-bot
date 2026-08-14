import { describe, test, expect } from 'vitest';
import { aliasNeighbors, aliasKeys } from './brewery-aliases';

// Forms that are deliberately hubs (>1 curated partner). Everything else in every
// batch must stay a 1:1 equivalence — that is what keeps the table non-transitive.
const KNOWN_HUBS = new Set(['lobkowicz', 'jihlava', 'mad brew', 'arcyksiazecy zamkowy cieszyn']);

// KNOWN_HUBS is the single exemption authority for all three batch blocks below —
// a form added here without a matching toEqual would go silently unconstrained
// everywhere at once, so guard against a dead (no-longer-a-hub) exemption.
test.each([...KNOWN_HUBS])('%s is genuinely a hub (no dead exemption)', (h) => {
  expect(aliasNeighbors(h).length).toBeGreaterThan(1);
});

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
    expect(aliasNeighbors('st james s gate')).toContain('guinness');
    expect(aliasNeighbors('guinness')).toContain('st james s gate');
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

  test('#325 Kraftwerk <-> Remeslo (same-owner conflation)', () => {
    expect(aliasNeighbors('kraftwerk')).toEqual(['remeslo']);
    expect(aliasNeighbors('remeslo')).toEqual(['kraftwerk']);
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
  // Every form in this batch is a 1:1 equivalence EXCEPT `mad brew`, which the #347
  // batch widened into a hub over its two series names (smoothiemaker, tomatol).
  test.each(PAIRS.flat().filter((f) => !KNOWN_HUBS.has(f)))(
    'form %s has exactly one neighbour (no unintended hub)',
    (form) => {
      expect(aliasNeighbors(form)).toHaveLength(1);
    },
  );
  test('this batch still pairs mad brew with smoothiemaker', () => {
    expect(aliasNeighbors('mad brew')).toContain('smoothiemaker');
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
  // As above: `arcyksiazecy zamkowy cieszyn` became a hub in the #347 batch, which
  // added the bare-town shop label `cieszyn` as a second spoke of the same brewery.
  test.each(PAIRS.flat().filter((f) => !KNOWN_HUBS.has(f)))(
    'form %s has exactly one neighbour (no unintended hub)',
    (form) => {
      expect(aliasNeighbors(form)).toHaveLength(1);
    },
  );
  test('this batch still pairs arcyksiazecy zamkowy cieszyn with bracki zamkowy w cieszynie', () => {
    expect(aliasNeighbors('arcyksiazecy zamkowy cieszyn')).toContain('bracki zamkowy w cieszynie');
  });
});

describe('#347 gate-miss alias batch', () => {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['ksiazece', 'tyskie ksiazece'],
    ['petrus', 'de brabandere'],
    ['kacov', 'hubertus'],
    ['mazurskie', 'mazurski'],
    ['lobkowicz', 'jihlava'],
    ['lobkowicz', 'rychtar'],
    ['cieszyn', 'arcyksiazecy zamkowy cieszyn'],
    ['cidre royal', 'royal fruit garden'],
    ['tomatol', 'mad brew'],
    ['nachod', 'primator'],
  ];
  test.each(PAIRS)('resolves %s <-> %s symmetrically', (shop, untappd) => {
    expect(aliasNeighbors(shop)).toContain(untappd);
    expect(aliasNeighbors(untappd)).toContain(shop);
  });

  // Every other form in this batch stays a 1:1 equivalence — only the forms in
  // KNOWN_HUBS are allowed more than one curated partner.
  test.each(PAIRS.flat().filter((f) => !KNOWN_HUBS.has(f)))(
    'form %s has exactly one neighbour (no unintended hub)',
    (form) => {
      expect(aliasNeighbors(form)).toHaveLength(1);
    },
  );

  // Unlike #318/#329, this batch deliberately creates hubs: one shop label maps to
  // several registered brewers (a portfolio owner), and two series names share one
  // brewer. The table stays non-transitive, so spokes never become equivalent.
  test('lobkowicz is a hub over both group breweries', () => {
    expect(aliasNeighbors('lobkowicz').sort()).toEqual(['jihlava', 'rychtar']);
  });
  test('jihlava is a hub over the #202 pair and the group owner', () => {
    expect(aliasNeighbors('jihlava').sort()).toEqual(['jezek kwasnicowy', 'lobkowicz']);
  });
  test('mad brew is a hub over both of its series names', () => {
    expect(aliasNeighbors('mad brew').sort()).toEqual(['smoothiemaker', 'tomatol']);
  });
  test('the Cieszyn brewery is a hub over both of its shop labels', () => {
    expect(aliasNeighbors('arcyksiazecy zamkowy cieszyn').sort())
      .toEqual(['bracki zamkowy w cieszynie', 'cieszyn']);
  });
  test('spokes of a hub are not neighbours of each other', () => {
    expect(aliasNeighbors('jihlava')).not.toContain('rychtar');
    expect(aliasNeighbors('rychtar')).not.toContain('jihlava');
    expect(aliasNeighbors('jezek kwasnicowy')).not.toContain('lobkowicz');
    expect(aliasNeighbors('tomatol')).not.toContain('smoothiemaker');
    expect(aliasNeighbors('cieszyn')).not.toContain('bracki zamkowy w cieszynie');
  });
});
