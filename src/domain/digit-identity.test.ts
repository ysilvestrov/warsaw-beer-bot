import { digitIdentity, readNameDigits, type DigitIdentity } from './digit-identity';

// #636. Every pair below is a real catalog or tap name from the prod probe (spec 2026-09-16), so a rule change
// that "looks harmless" has to explain which measured beer it moves.
const identity = (a: string, b: string): DigitIdentity => digitIdentity(readNameDigits(a), readNameDigits(b));

describe('readNameDigits', () => {
  test('a hash number is hard, the degree grade is kept apart', () => {
    expect(readNameDigits('Dr.Hazy #7 15°')).toEqual({
      numbers: ['7'], soft: [], grades: ['15'], versions: [], years: [],
    });
  });

  test('ABV with its mid-dot tail never becomes a number', () => {
    expect(readNameDigits('Buzdygan Rozkoszy 24°·8,5%')).toEqual({
      numbers: [], soft: [], grades: ['24'], versions: [], years: [],
    });
  });

  test('a year range inside brackets yields both years', () => {
    expect(readNameDigits('Piece of Cake (2015-2022)').years).toEqual(['2015', '2022']);
  });

  test('a v-prefixed decimal is a version', () => {
    expect(readNameDigits('Bloody Mary v1.0').versions).toEqual(['1.0']);
  });

  test('an unmarked 19 is hard — outside the soft 8–14 range', () => {
    expect(readNameDigits('Juicy Trap 19').numbers).toEqual(['19']);
  });

  test('digits glued to a word are not read', () => {
    expect(readNameDigits('Black Celebration #3 WFP10 Edition').numbers).toEqual(['3']);
  });

  test("an apostrophe year after the number is a year, the slash pair stays numbers", () => {
    expect(readNameDigits("Hoppy Grodzisz 23' 2/20")).toMatchObject({ numbers: ['2', '20'], years: ['2023'] });
  });
});

describe('digitIdentity', () => {
  test.each<[string, string, DigitIdentity]>([
    // ABV in the apostrophe spelling is not a number
    ["Gose 4'8%", 'Gose', 'same'],
    // grades are soft: never split on their own …
    ['Pils 12°', 'Pils', 'same'],
    ['Białe IPA 16°', 'Białe IPA 14°', 'same'],
    // … but confirm a bare number on the other side …
    ['Otakar 11°', 'Otakar 11', 'same'],
    // … and a soft number that disagrees with the only grade is a different beer
    ['KONRAD 12°', 'Konrad Svetlé Výčepní 10', 'different'],
    // two-digit years
    ["Hoppiness'26", 'Hoppiness 2026', 'same'],
    ["Open Craft '26", 'Open Craft 2026 18°', 'same'],
    // years: equal sets, else different; one side only is a fallback
    ['Backwoods Bastard (2018)', 'Backwoods Bastard (2019)', 'different'],
    ['Backwoods Bastard', 'Backwoods Bastard (2018)', 'year-fallback'],
    ['Autonomia (2021/2022)', 'Autonomia (2022/2023)', 'different'],
    ['Affection (2025)', 'Affection 2025', 'same'],
    ['Echo 2026 10th Edition', 'ECHO the 10th Edition', 'year-fallback'],
    // markers and leading zeros
    ['Uwarzone z Wami #3', 'Uwarzone Z Wami vol.3: Polish Black IPA', 'same'],
    ['Barrel Aged Serie No.38', 'Barrel Aged Serie No.35', 'different'],
    ['SPECIMEN 002', 'Specimen 2', 'same'],
    ['SPECIMEN 002', 'Specimen 001', 'different'],
    // versions split only when both sides carry one
    ['SPOKO CYDR 2.0 (Zweigelt Edition)', 'Spoko Cydr Zweigelt Edition', 'same'],
    ['Ambrosia 9.0', 'Ambrosia 5.0', 'different'],
    // soft 8–14 without a marker
    ['Svijanský Máz 11', 'Svijanský Máz', 'same'],
    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', 'different'],
    ['Trappistes Rochefort 6', 'Trappistes Rochefort 10', 'different'],
    // hard numbers on one side only
    ['Paranormal Activity 2', 'Paranormal Activity', 'different'],
    ['Kronenbourg 1664', 'Kronenbourg', 'different'],
    ['Funky Monkey #2 12°', 'Funky Monkey', 'different'],
    ['Juicy Trap #19 18°', 'Juicy Trap #20', 'different'],
    // glued digits are not read (documented limit)
    ['BA23.03', 'BA23.02', 'same'],
    // documented cost: the grade does not cover the soft 10 of "10,5/10"
    ['Polska Desitka 10,5°', 'Polska Desitka 10,5/10', 'different'],
  ])('%s  ↔  %s  →  %s', (a, b, want) => {
    expect(identity(a, b)).toBe(want);
    expect(identity(b, a)).toBe(want); // the rule is symmetric
  });
});
