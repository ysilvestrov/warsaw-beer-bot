import { digitIdentity, digitsCompatibleAsPeers, readNameDigits, type DigitIdentity } from './digit-identity';

// #636. Every pair below is a real catalog or tap name from the prod probe (spec 2026-09-16), so a rule change
// that "looks harmless" has to explain which measured beer it moves.
const identity = (input: string, candidate: string): DigitIdentity =>
  digitIdentity(readNameDigits(input), readNameDigits(candidate));

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

describe('digitIdentity(input, candidate)', () => {
  // [input, candidate, input→candidate, candidate→input]. A hard number only the candidate carries is a fallback;
  // only the input carrying it names another beer — so the two directions differ exactly there.
  test.each<[string, string, DigitIdentity, DigitIdentity]>([
    // ABV in the apostrophe spelling, or labelled without %, is not a number
    ["Gose 4'8%", 'Gose', 'same', 'same'],
    ['Stout 5.3 abv', 'Stout', 'same', 'same'],
    // a volume glued to its unit is not a number
    ['Lager 0,5l', 'Lager', 'same', 'same'],
    ['Hazy 1.5L', 'Hazy', 'same', 'same'],
    // grades are soft: never split on their own …
    ['Pils 12°', 'Pils', 'same', 'same'],
    ['Białe IPA 16°', 'Białe IPA 14°', 'same', 'same'],
    // … a soft number equal to the grade is the same beer …
    ['Otakar 11°', 'Otakar 11', 'same', 'same'],
    // … a grade covers a hard number on the other side (17 is outside the soft range) …
    ['Brutus 17°', 'Brutus 17', 'same', 'same'],
    ['Kamenice 10', 'Kamenice 10 12°', 'same', 'same'],
    // … whatever the grade spelling: `*`, a mid-dot ABV tail, a decimal comma
    ['Pils 12*', 'Pils 11°', 'same', 'same'],
    ['Pils 12,5°·4', 'Pils', 'same', 'same'],
    ['Kolaż 15,5°', 'Kolaż 15.5', 'same', 'same'],
    // … and a soft number that disagrees with the only grade is a different beer
    ['KONRAD 12°', 'Konrad Svetlé Výčepní 10', 'different', 'different'],
    // two-digit years
    ["Hoppiness'26", 'Hoppiness 2026', 'same', 'same'],
    ["Open Craft '26", 'Open Craft 2026 18°', 'same', 'same'],
    // years: equal sets, else different; one side only is a fallback
    ['Backwoods Bastard (2018)', 'Backwoods Bastard (2019)', 'different', 'different'],
    ['Backwoods Bastard', 'Backwoods Bastard (2018)', 'year-fallback', 'year-fallback'],
    ['Autonomia (2021/2022)', 'Autonomia (2022/2023)', 'different', 'different'],
    ['Affection (2025)', 'Affection 2025', 'same', 'same'],
    ['Echo 2026 10th Edition', 'ECHO the 10th Edition', 'year-fallback', 'year-fallback'],
    // markers make a number hard even inside the soft range: #, v, leading zero
    ['Dr.Hazy #12', 'Dr. Hazy', 'different', 'number-fallback'],
    ['SPECIMEN 010', 'Specimen', 'different', 'number-fallback'],
    ['Porter v10', 'Porter', 'different', 'number-fallback'],
    // a marked number is still covered by the same soft number on the other side
    ['Juicy Trap #12', 'Juicy Trap 12', 'same', 'same'],
    // ordinals are numbers
    ['Echo 16th Anniversary', 'Echo Anniversary', 'different', 'number-fallback'],
    // markers and leading zeros
    ['Uwarzone z Wami #3', 'Uwarzone Z Wami vol.3: Polish Black IPA', 'same', 'same'],
    ['Barrel Aged Serie No.38', 'Barrel Aged Serie No.35', 'different', 'different'],
    ['SPECIMEN 002', 'Specimen 2', 'same', 'same'],
    ['SPECIMEN 002', 'Specimen 001', 'different', 'different'],
    // versions split only when both sides carry one
    ['SPOKO CYDR 2.0 (Zweigelt Edition)', 'Spoko Cydr Zweigelt Edition', 'same', 'same'],
    ['Ambrosia 9.0', 'Ambrosia 5.0', 'different', 'different'],
    // soft 8–14 without a marker
    ['Svijanský Máz 11', 'Svijanský Máz', 'same', 'same'],
    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', 'different', 'different'],
    ['Trappistes Rochefort 6', 'Trappistes Rochefort 10', 'different', 'different'],
    // hard numbers on one side only: the input's is decisive, the candidate's is a fallback
    ['Paranormal Activity 2', 'Paranormal Activity', 'different', 'number-fallback'],
    ['Kronenbourg 1664', 'Kronenbourg', 'different', 'number-fallback'],
    ['Funky Monkey #2 12°', 'Funky Monkey', 'different', 'number-fallback'],
    ['Juicy Trap #19 18°', 'Juicy Trap #20', 'different', 'different'],
    // glued digits are not read (documented limit)
    ['BA23.03', 'BA23.02', 'same', 'same'],
    // documented cost: the grade does not cover the soft 10 of "10,5/10"
    ['Polska Desitka 10,5°', 'Polska Desitka 10,5/10', 'different', 'different'],
    // Untappd appends numbers shops leave out (measured on search-linked rows and the Few More Beer tap)
    ['Cucumber Gose', '10th Anniversary #6: Cucumber Gose', 'number-fallback', 'different'],
    ['Few More Beers 19°', 'Few More Beer 004/108', 'number-fallback', 'different'],
    // a candidate-only number outranks a one-sided year: it is the weaker fallback
    ['Life After Death Star', 'Life After Death Star (Batch 7) 2025', 'number-fallback', 'different'],
    // … unless the input carries its own number the candidate lacks: a soft number or a version
    ['Trappistes Rochefort 10', 'Trappistes Rochefort 6', 'different', 'different'],
    ['Potion #2.0', 'Potion #18', 'different', 'different'],
    // … and the input's soft number counts as matched when the candidate carries it in any bucket
    ['10TH ANNIVERSARY 11°', '10th Anniversary no.5', 'number-fallback', 'different'], // candidate soft (live tap link)
    ['Trappistes Rochefort 10', 'Trappistes Rochefort #10 (Batch 3)', 'number-fallback', 'different'], // candidate number
    ['Svijanský Máz 11', 'Svijanský Máz 11° #2', 'number-fallback', 'different'], // candidate grade
    // a year the input carries is not part of that guard (documented limit): a one-sided year stays a fallback
    ['Abraxas 2025', 'Abraxas #3', 'number-fallback', 'different'],
    // … and never overrides a year conflict
    ['Abraxas 2024', 'Abraxas (Batch 7) 2025', 'different', 'different'],
  ])('%s  →  %s  :  %s / reverse %s', (input, candidate, forward, reverse) => {
    expect(identity(input, candidate)).toBe(forward);
    expect(identity(candidate, input)).toBe(reverse);
  });
});

describe('digitsCompatibleAsPeers — ensureOrphan (the #617 numericTokensCompatible table, carried over)', () => {
  test.each<[string, string, boolean]>([
    // measured wrong pairs — must stay apart
    ['Juicy Trap #19 18°', 'Juicy Trap #20', false],
    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', false],
    ['Grodziskie Piwobraniowe 2024', 'Piwobranie 2026: Suska sechlońska i cascara', false],
    ['Trappistes Rochefort 10 (2015)', 'Trappistes Rochefort 10 (2017)', false],
    ['Kronenbourg 1664', 'Kronenbourg', false],
    ['Vintage 2015 2016', 'Vintage 2016', false],
    ['Piwobranie 2024', 'Piwobranie 2025', false],
    ['O Tiole Mio! 2026 15°', 'O tiole mio! 2025', false],
    // the same beer — must stay together
    ['Kronenbourg 1664 Blanc 12,5°', '1664 Blanc', true],
    ['AMBROSIA 10.0 18°', 'Ambrosia 10.0', true],
    ['Juicy Trap #20 18°', 'Juicy Trap #20', true],
    ['Krzyż Południa 13°', 'Krzyż Południa (2026)', true],
    ['ROTATION 12°', 'Rotation (2026)', true],
    ['La Chouffe 16°', 'La Chouffe 0.4%', true],
    ['Beer 12 x 3', 'Beer 3 x 12', true],
    ['Vintage (2016) 2015', 'Vintage 2015 2016', true],
    ['Anniversary 2000', 'Anniversary', true],
    ['Łan', 'Łan 12°', true],
    // #636 changes against #617, both from the spec: a bare 8–14 is soft (was apart) …
    ['Svijanský Máz 11', 'Svijanský Máz', true],
    // … and digits inside a non-compact bracket are read now (was a documented blind spot: together)
    ['Imperial Stout (Batch 12)', 'Imperial Stout (Batch 13)', false],
    // a number only one peer carries is another orphan, whichever side it is on
    ['Cucumber Gose', '10th Anniversary #6: Cucumber Gose', false],
  ])('%s  ↔  %s  →  %s', (a, b, expected) => {
    expect(digitsCompatibleAsPeers(a, b)).toBe(expected);
    expect(digitsCompatibleAsPeers(b, a)).toBe(expected);
  });
});
