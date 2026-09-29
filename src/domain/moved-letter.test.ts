import { isMovedLetter, isMovedLetterName } from './moved-letter';

describe('#659 isMovedLetter', () => {
  test.each([
    ['uth', 'uht'],        // adjacent swap, 37582
    ['slik', 'silk'],      // adjacent swap, 37911
    ['tounge', 'tongue'],  // one letter moved two places, 38383
    ['mild', 'mlid'],      // letters that look Roman but do not form a numeral
  ])('%s ↔ %s is one moved letter', (a, b) => {
    expect(isMovedLetter(a, b)).toBe(true);
    expect(isMovedLetter(b, a)).toBe(true);
  });

  test.each([
    ['slik', 'slice', 'different length (the Slice. trap)'],
    ['kizzy', 'lizzy', 'one substitution'],
    ['snake', 'snakes', 'one insertion'],
    ['palma', 'lampa', 'anagram needing two moves'],
    ['riot', 'riot', 'identical'],
    ['ab', 'ba', 'shorter than 3'],
    ['v14', 'v41', 'contains digits'],
    ['xxiv', 'xxvi', 'Roman numeral (Firestone/Moksa anniversaries)'],
    ['mix', 'mxi', 'both sides are valid Roman numerals'],
    ['xii', 'ixi', 'only the first side is a valid Roman numeral'],
  ])('%s ↔ %s is rejected in both directions: %s', (a, b) => {
    expect(isMovedLetter(a, b)).toBe(false);
    expect(isMovedLetter(b, a)).toBe(false);
  });
});

describe('#659 isMovedLetterName', () => {
  test('one differing token, rest identical', () => {
    expect(isMovedLetterName('tounge tingle', 'tongue tingle')).toBe(true);
  });

  test('two differing tokens are rejected', () => {
    expect(isMovedLetterName('tounge tnigle', 'tongue tingle')).toBe(false);
  });

  test('token count mismatch is rejected', () => {
    expect(isMovedLetterName('slik', 'silk wheat')).toBe(false);
  });

  test('tokens compare by position, not as a set', () => {
    expect(isMovedLetterName('tingle tounge', 'tongue tingle')).toBe(false);
  });

  test('identical names are rejected (nothing to rescue)', () => {
    expect(isMovedLetterName('silk', 'silk')).toBe(false);
  });

  test('empty target is rejected', () => {
    expect(isMovedLetterName('', '')).toBe(false);
  });
});
