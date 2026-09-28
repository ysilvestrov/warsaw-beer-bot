import { czechGradesContradict, digitIdentity, digitsCompatibleAsPeers, readNameDigits, type DigitIdentity, type DigitIdentityContext } from './digit-identity';

// #636. Every pair below is a real catalog or tap name from the prod probe (spec 2026-09-16), so a rule change
// that "looks harmless" has to explain which measured beer it moves.
const identity = (input: string, candidate: string): DigitIdentity =>
  digitIdentity(readNameDigits(input), readNameDigits(candidate));

describe('readNameDigits', () => {
  test('a hash number is hard, the degree grade is kept apart', () => {
    expect(readNameDigits('Dr.Hazy #7 15°')).toEqual({
      numbers: ['7'], soft: [], grades: ['15'], versions: [], years: [], hasLetters: true,
    });
  });

  test('ABV with its mid-dot tail never becomes a number', () => {
    expect(readNameDigits('Buzdygan Rozkoszy 24°·8,5%')).toEqual({
      numbers: [], soft: [], grades: ['24'], versions: [], years: [], hasLetters: true,
    });
  });

  test('purely numeric name has no letters', () => {
    expect(readNameDigits('21').hasLetters).toBe(false);
    expect(readNameDigits('#21').hasLetters).toBe(false);
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
    // PR #662 AI review: a '#'/no./nr. marker makes even a year-shaped number a hard number …
    ['Beer #2024', 'Beer', 'different', 'number-fallback'],
    // … while a year after other words stays a year
    ['Anniversary Edition 2024', 'Anniversary Edition', 'year-fallback', 'year-fallback'],
    // … and never overrides a year conflict
    ['Abraxas 2024', 'Abraxas (Batch 7) 2025', 'different', 'different'],
    // candidate number without letters is not a fallback for lettered name (#663)
    ['LAGER 10.5°', '21', 'different', 'different'],
    ['Pils 12°', '15', 'different', 'different'],
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

describe('#665 Czech lager grade identity', () => {
  const judged = (
    input: string, candidate: string,
    inputStyle: string | null, candidateStyle: string | null,
  ): DigitIdentity => digitIdentity(readNameDigits(input), readNameDigits(candidate), {
    input: { name: input, style: inputStyle },
    candidate: { name: candidate, style: candidateStyle },
  });

  test('Konrad ten degrees is not the twelve-degree orphan', () => {
    expect(judged('KONRAD 10°', 'Konrad 12°', null, 'Svetlý Ležák')).toBe('different');
    expect(judged('Konrad 12°', 'KONRAD 10°', 'Svetlý Ležák', null)).toBe('different');
  });

  test.each<[string, string, string | null, string | null, DigitIdentity]>([
    ['CERNA HORA LEZAK 12°', 'Černa Hora 11°', null, 'Svetlý Ležák', 'different'],
    ['Beer 12°', 'Beer 11°', null, 'Pilsner - Czech / Bohemian', 'different'],
    ['Beer 10°', 'Beer 12°', 'Lager - Světlé (Czech Pale)', null, 'different'],
    ['Beer 10°', 'Beer 12°', null, 'Bohemian Pils', 'different'],
    ['Beer 10°', 'Beer 12°', null, 'Tmavy Lezak', 'different'],
    ['Beer 10°', 'Beer 12°', null, 'Světlý Ležák / Jasny Lager', 'different'],
    ['Beer 7°', 'Beer 20°', null, 'Czech Lager', 'different'],
    ['Beer 6°', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 12°', 'Beer 21°', null, 'Czech Lager', 'same'],
    ['Beer 12°', 'Beer 12,0°', null, 'Czech Lager', 'same'],
    ['Beer 12.0°', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 10*', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer 10°·4%', 'Beer 12°·5%', null, 'Czech Lager', 'different'],
    ['Beer 14,5°', 'Beer 14°', null, 'Czech Lager', 'same'],
    ['Beer 10° 10.0°', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer 10° 11°', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 11° 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 12°', null, null, 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Lager', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Pilsner', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Czech', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Ležák', 'same'],
    ['Beer 10°', 'Beer 12°', 'IPA', 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 12°', 'Pszeniczne', 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 12°', 'Czech Lager', 'Pszeniczne', 'same'],
    ['Beer Pszeniczne 10°', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer Pszeniczne 12°', 'Czech Lager', null, 'same'],
    ['Beer IPA 10°', 'Beer IPA 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer Stout 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Czech IPA', 'same'],
    ['Beer 10°', 'Beer', null, 'Czech Lager', 'same'],
    ['Beer 10%', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 10 abv', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 0,5l', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 2026', 'Beer 12°', null, 'Czech Lager', 'year-fallback'],
    ['Beer #10', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer 10', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer #3 10°', 'Beer #4 10°', null, 'Czech Lager', 'different'],
    ['Beer 10° 2024', 'Beer 10° 2025', null, 'Czech Lager', 'different'],
    ['', '', null, 'Czech Lager', 'same'],
  ])('%s / %s with styles %s / %s → %s', (a, b, sa, sb, expected) => {
    expect(judged(a, b, sa, sb)).toBe(expected);
  });

test('the contextual grade veto is symmetric with only one known style', () => {
  const a = readNameDigits('Beer 7°');
  const b = readNameDigits('Beer 20°');
  const context: DigitIdentityContext = {
    input: { name: 'Beer 7°', style: 'Czech Lager' },
    candidate: { name: 'Beer 20°' },
  };
  expect(czechGradesContradict(a, b, context)).toBe(true);
  expect(czechGradesContradict(b, a, {
    input: context.candidate, candidate: context.input,
  })).toBe(true);
});

test('absence of context preserves old identity and does not hide hard-number conflicts', () => {
  expect(digitIdentity(readNameDigits('Beer 10°'), readNameDigits('Beer 12°'))).toBe('same');
  expect(czechGradesContradict(readNameDigits('Beer #3'), readNameDigits('Beer #4'))).toBe(false);
  expect(digitIdentity(readNameDigits('Beer #3'), readNameDigits('Beer #4'))).toBe('different');
});

test.each<[string, string, string, DigitIdentity]>([
  ['Białe IPA 16°', 'Białe IPA 14°', 'IPA', 'same'],
  ['Flying Machine 19°', 'Flying Machine 20°', 'IPA - Imperial / Double New England / Hazy', 'same'],
  ['Kwas My Lemoncello 16,5°', '16° Kwas My Lemoncello Sour Ale', 'Sour', 'same'],
  ['Mini Młot 8°', 'Mini Młot 9°', 'IPA', 'same'],
  ["There's no Wi-Fi in my garden 14,5°", "There's no wi-fi in my garden 14°", 'IPA', 'same'],
  ['Sztanga 2026 12°', 'Sztanga 11°', 'Kölsch', 'year-fallback'],
  ['Lizard King 11°', 'Lizard King 9°', 'Sour - Fruited Gose', 'same'],
])('non-Czech grades remain soft: %s / %s', (a, b, style, expected) => {
  const context: DigitIdentityContext = {
    input: { name: a }, candidate: { name: b, style },
  };
  expect(czechGradesContradict(readNameDigits(a), readNameDigits(b), context)).toBe(false);
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), context)).toBe(expected);
});
});


describe('#665 contextual orphan peers', () => {
  test('known style on either peer rejects differing degrees', () => {
    expect(digitsCompatibleAsPeers('Konrad 10°', 'Konrad 12°', {
      input: { name: 'Konrad 10°' }, candidate: { name: 'Konrad 12°', style: 'Svetlý Ležák' },
    })).toBe(false);
    expect(digitsCompatibleAsPeers('Konrad 12°', 'Konrad 10°', {
      input: { name: 'Konrad 12°', style: 'Svetlý Ležák' }, candidate: { name: 'Konrad 10°' },
    })).toBe(false);
    expect(digitsCompatibleAsPeers('Konrad 10°', 'Konrad 12°')).toBe(true);
  });
});

describe('#664 hop codes', () => {
  test.each<[string, string[], string[], string[], string[]]>([
    ['DUMB FRUIT 11', [], [], ['11'], []],
    ['IPA 3/20', [], ['20', '3'], [], []],
    ['NOTHBC472', [], [], [], []],
    ['HBC472suffix', [], [], [], []],
    ['Idaho 8', [], [], ['8'], []],
    ['', [], [], [], []],
    ['PŁ167 (kegged 3/20)', ['PŁ:167'], ['20', '3'], [], []],
    ['HBC 12°', [], [], [], ['12']],
    ['HBC 7%', [], [], [], []],
    ['HBC 7 ABV', [], [], [], []],
    ['HBC 472.5', [], ['472.5'], [], []],
    ['HBC 472/630', [], ['472', '630'], [], []],
    ['EXP 3/20/2026', [], ['20', '3'], [], []],
    ['Polish Hops (3/20)', [], ['20', '3'], [], []],
    ['HBC472 x 3/20', ['HBC:472', 'PolishHops:3/20'], [], [], []],
    ['HBC472 and 3/20', ['HBC:472'], ['20', '3'], [], []],
    ['HBC472, EXP 3/20', ['HBC:472', 'PolishHops:3/20'], [], [], []],
    ['HBC472, 3/20', ['HBC:472'], ['20', '3'], [], []],
    ['7, EXP 3/20', ['PolishHops:3/20'], ['7'], [], []],
    ['2026 / 3/20', [], ['20', '3'], [], []],
    ['HBC 12° 472', [], ['472'], [], ['12']],
    ['HBC 7% 472', [], ['472'], [], []],
    ['HBC 7 ABV 472', [], ['472'], [], []],
    ['HBC 472/20%', [], ['472'], [], []],
    ['🍺 HBC472', ['HBC:472'], [], [], []],
  ])('keeps code boundaries and ordinary digits in %s', (name, hops, numbers, soft, grades) => {
    const read = readNameDigits(name);
    expect(read.hops ?? []).toEqual(hops);
    expect(read.numbers).toEqual(numbers);
    expect(read.soft).toEqual(soft);
    expect(read.grades).toEqual(grades);
  });
test('the hop token is consumed once and does not hide the series number', () => {
  const read = readNameDigits('Temporalis #0056 HBC 1183 Citra Dynaboost');
  expect(read.numbers).toEqual(['56']);
  expect(read.hops).toEqual(['HBC:1183']);
});

test.each<[string, string, DigitIdentity]>([
  ['Temporalis #0056 HBC 1183', 'Temporalis #0056', 'same'],
  ['Temporalis #0056 HBC 1183', 'Temporalis #0057', 'different'],
  ['Single Hop HBC472', 'Single Hop HBC-472', 'same'],
  ['Single Hop HBC 472', 'Single Hop HBC 630', 'different'],
  ['Hop Heats CF317', 'Hop Heats CF338', 'different'],
  ['Hop Heats CF317', 'Hop Heats HBC317', 'different'],
  ['IPA BRU-1', 'IPA BRU1', 'same'],
  ['IPA NZH-107', 'IPA NZH 107', 'same'],
  ['IPA YCR 1320', 'IPA YCR1320', 'same'],
  ['IPA PŁ-167', 'IPA PŁ167', 'same'],
  ['IPA Idaho 7', 'IPA Idaho7', 'same'],
  ['IPA HBC472 HBC472', 'IPA HBC472', 'same'],
  ['IPA HBC472 BRU1', 'IPA BRU1 HBC472', 'same'],
  ['IPA HBC472 BRU1', 'IPA HBC472', 'different'],
  ['DUMB FRUIT 11', 'DUMB FRUIT', 'same'], // 11 remains an ordinary soft number
  ['DUMB FRUIT #11', 'DUMB FRUIT', 'different'],
  ['Duvel 6.66', 'Duvel', 'different'],
  ['Duvel 6.66%', 'Duvel', 'same'],
  ['Beer 0,5l', 'Beer', 'same'],
])('%s / %s → %s', (a, b, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b))).toBe(expected);
});

test.each<[string, string, string | null, DigitIdentity]>([
  ['IPA EXP 3/20', 'IPA', null, 'same'],
  ['IPA EXP3/20', 'IPA 3/20', 'PolishHops', 'same'],
  ['Polish Hops: 3/20', 'IPA', null, 'same'],
  ['IPA 2/20', 'IPA', 'ReCraft / PolishHops Brewery', 'same'],
  ['IPA 5/39', 'IPA', 'PolishHops', 'same'],
  ['IPA PŁ167 x 3/20 x 2/20', 'IPA PŁ-167 x EXP 3/20 x EXP 2/20', null, 'same'],
  ['IPA EXP 2/20', 'IPA EXP 3/20', null, 'different'],
  ['IPA EXP 2/20', 'IPA EXP 1/10', null, 'number-fallback'],
  ['IPA 3/20', 'IPA', 'ReCraft', 'different'],
  ['Polish Hops #3/20', 'IPA', null, 'different'],
  ['Polish Hops series 3/20', 'IPA', null, 'different'],
  ['Polish Hops (kegged 3/20)', 'IPA', null, 'different'],
  ['Polish Hops 3/20/2026', 'IPA', null, 'different'],
  ['Free IPA PŁ167 x 3/20 x 2/2', 'Free IPA PŁ167 x EXP 3/20', null, 'different'],
])('%s / %s, brewery %s → %s', (a, b, brewery, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), {
    input: { name: a, brewery }, candidate: { name: b, brewery },
  })).toBe(expected);
});

test('fraction codes are not reduced to an unproven numerical equivalent', () => {
  expect(readNameDigits('IPA EXP 2/20').hops).toEqual(['PolishHops:2/20']);
  const unknown = readNameDigits('IPA EXP 1/10');
  expect(unknown.hops ?? []).toEqual([]);
  expect(unknown.numbers).toEqual(['1']);
  expect(unknown.soft).toEqual(['10']);
});

test('a spaced three-part date is not a PolishHops fraction', () => {
  expect(digitIdentity(readNameDigits('IPA 2026 / 3/20'), readNameDigits('IPA'), {
    input: { name: 'IPA 2026 / 3/20', brewery: 'PolishHops' },
    candidate: { name: 'IPA', brewery: 'PolishHops' },
  })).toBe('different');
});
});

describe('#664 brewery number spans', () => {
test('catalog evidence is required for a collaborator number', () => {
  expect(identity('Blurries / 450 North', 'Blurries')).toBe('different');
});

test.each<[string, string, string, DigitIdentity]>([
  ['Brouwerij 3 Fóntéinen Beer', 'Other', '3 Fonteinen Sp. z o.o.', 'same'],
  ['3 Fonteinen Beer', 'Other', '3 Fonteinen', 'same'],
  ['#3 Fonteinen Beer', '3 Fonteinen', '3 Fonteinen', 'different'],
  ['Batch 3 Fonteinen Beer', '3 Fonteinen', '3 Fonteinen', 'different'],
  ['3° Fonteinen Beer', '3 Fonteinen', '3 Fonteinen', 'same'],
  ['Beer 450', 'Other', 'Other', 'different'],
])('uses complete source spans in %s', (a, ab, bb, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits('Beer'), {
    input: { name: a, brewery: ab }, candidate: { name: 'Beer', brewery: bb },
    knownBreweries: ['450'],
  })).toBe(expected);
});

test('brand/catalog context preserves Czech grade evidence and leaves inputs untouched', () => {
  const input = readNameDigits('3 Fonteinen Beer #3 10°');
  const candidate = readNameDigits('Beer #3 12°');
  const context: DigitIdentityContext = {
    input: { name: '3 Fonteinen Beer #3 10°', brewery: '3 Fonteinen', style: 'Czech Lager' },
    candidate: { name: 'Beer #3 12°', brewery: '3 Fonteinen' },
    knownBreweries: ['450 North'],
  };
  expect(digitIdentity(input, candidate, context)).toBe('different');
  expect(input).toEqual({ numbers: ['3', '3'], soft: [], grades: ['10'], versions: [], years: [], hasLetters: true });
  expect(candidate).toEqual({ numbers: ['3'], soft: [], grades: ['12'], versions: [], years: [], hasLetters: true });
  expect(context).toEqual({
    input: { name: '3 Fonteinen Beer #3 10°', brewery: '3 Fonteinen', style: 'Czech Lager' },
    candidate: { name: 'Beer #3 12°', brewery: '3 Fonteinen' },
    knownBreweries: ['450 North'],
  });
});

test('numeric brewery spans cannot erase a conflicting Czech grade', () => {
  expect(digitIdentity(readNameDigits('Claim 10° Beer'), readNameDigits('Beer 12°'), {
    input: { name: 'Claim 10° Beer', brewery: 'Claim 10', style: 'Czech Lager' },
    candidate: { name: 'Beer 12°', brewery: 'Claim 10' },
  })).toBe('different');
});
test.each<[string, string, string, string, readonly string[], DigitIdentity]>([
  ['3 Fonteinen Oude Geuze', 'Oude Geuze', '3 Fonteinen', 'Brouwerij 3 Fonteinen', [], 'same'],
  ['3 Fonteinen Beer #3', 'Beer', '3 Fonteinen', '3 Fonteinen', [], 'different'],
  ['3 Fonteinen Beer #3', 'Beer #3', '3 Fonteinen', '3 Fonteinen', [], 'same'],
  ['3 Fonteinen 3 Fonteinen Beer #3', 'Beer #3', '3 Fonteinen', '3 Fonteinen', [], 'same'],
  ['Beer 450', 'Beer', 'Imprint', 'Imprint', ['450 North'], 'different'],
  ['Blurries / 450 North', 'Blurries', 'Imprint', 'Imprint', ['450 North'], 'same'],
  ['Blurries / 450 Northern', 'Blurries', 'Imprint', 'Imprint', ['450 North'], 'different'],
  ['Stuffed Schmoojee / Claim 52', 'Stuffed Schmoojee', 'Imprint', 'Imprint', ['Claim 52'], 'same'],
  ['Claim 52 Beer #52', 'Beer', 'Claim 52', 'Claim 52', [], 'different'],
  ['101 Mojito', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'same'],
  ['101 Ginger Mule', 'Ginger Mule Mocktail', 'Імпортне пиво', 'Sir James 101', [], 'same'],
  ['#101 Mojito', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'different'],
  ['Batch 101 Mojito', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'different'],
  ['Mojito 101', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'different'],
  ['101 Unknown Product', 'Unknown Product', 'Sir.James', 'Sir James 101', [], 'different'],
  ['101 Mojito', 'Mojito', 'Other', '101 Cider House', [], 'different'],
  ['Duvel 6.66', 'Duvel', 'Duvel Moortgat', 'Duvel Moortgat', [], 'different'],
])('%s / %s → %s', (a, b, ab, bb, knownBreweries, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), {
    input: { name: a, brewery: ab }, candidate: { name: b, brewery: bb }, knownBreweries,
  })).toBe(expected);
});

test('peer reversal retains the catalog and swaps brewery/style sides', () => {
  const a = 'Blurries / 450 North';
  const b = 'Blurries';
  const context: DigitIdentityContext = {
    input: { name: a, brewery: 'Imprint' },
    candidate: { name: b, brewery: 'Imprint', style: 'Sour' },
    knownBreweries: ['450 North'],
  };
  expect(digitsCompatibleAsPeers(a, b, context)).toBe(true);
  expect(digitsCompatibleAsPeers(b, a, {
    ...context, input: context.candidate, candidate: context.input,
  })).toBe(true);
});
});

describe('#664 contextual series codes', () => {
test.each<[string, string, string | null, DigitIdentity]>([
  ['NOTLAB29', 'NOTLAB30', 'Pracownia Piwa', 'same'],
  ['LAB29suffix', 'LAB30suffix', 'Pracownia Piwa', 'same'],
  ['LAB29', 'LAB30', null, 'same'],
  ['TAP04', 'TAP07', null, 'same'],
  ['LAB29.5', 'LAB30.5', 'Pracownia Piwa', 'same'],
  ['LAB 29.5', 'Porter', 'Pracownia Piwa', 'different'],
  ['LAB29/30', 'LAB29', 'Pracownia Piwa', 'different'],
  ['Beer TAP 4.5', 'Beer TAP04', 'Schneider Weisse', 'different'],
  ['Beer #4 TAP04', 'Beer TAP04', 'Schneider Weisse', 'different'],
  ['Beer #29 LAB29', 'Beer LAB29', 'Pracownia Piwa', 'different'],
  ['Beer LAB29 LAB29', 'Beer LAB29', 'Pracownia Piwa', 'different'],
  ['Beer LAB 12°', 'Beer', 'Pracownia Piwa', 'same'],
  ['Beer LAB 7%', 'Beer', 'Pracownia Piwa', 'same'],
  ['Beer LAB 12° 29', 'Beer LAB29 12°', 'Pracownia Piwa', 'different'],
  ['Beer TAP 12° 4', 'Beer TAP04 12°', 'Schneider Weisse', 'different'],
  ['Beer TAP04 TAP04', 'Beer TAP04', 'Schneider Weisse', 'same'],
  ['53M Horseshoe', 'Horseshoe', null, 'same'],
])('keeps boundaries and independent numbers in %s', (a, b, brewery, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), {
    input: { name: a, brewery }, candidate: { name: b, brewery },
    knownBreweries: ['Pracownia Piwa', 'Schneider Weisse', 'Moersleutel', 'Hop Brook'],
  })).toBe(expected);
});

test.each<[string, string, string, boolean]>([
  ['LAB29 Porter', 'Porter', 'Pracownia Piwa', false],
  ['Porter', 'LAB29 Porter', 'Pracownia Piwa', false],
  ['Aventinus TAP06', 'Aventinus', 'Schneider Weisse G. Schneider & Sohn', true],
  ['Aventinus', 'Aventinus TAP06', 'Schneider Weisse G. Schneider & Sohn', true],
  ['Original TAP04', 'Original TAP07', 'Schneider Weisse', false],
])('peers %s / %s → %s', (a, b, brewery, expected) => {
  expect(digitsCompatibleAsPeers(a, b, {
    input: { name: a, brewery }, candidate: { name: b, brewery },
  })).toBe(expected);
});

test('only an explicit full family brand qualifies compact codes', () => {
  expect(digitIdentity(readNameDigits('LAB29'), readNameDigits('LAB30'), {
    input: { name: 'LAB29', brewery: 'Other' },
    candidate: { name: 'LAB30', brewery: 'Pracownia Piwa' },
  })).toBe('different');
  expect(digitIdentity(readNameDigits('LAB29'), readNameDigits('LAB30'), {
    input: { name: 'LAB29', brewery: 'Other Pracownia Piwa' },
    candidate: { name: 'LAB30', brewery: 'Pracownia Piwarnia' },
  })).toBe('same');
});
test.each<[string, string, string, DigitIdentity, DigitIdentity]>([
  ['TAP 4 Mein Festweisse', 'Festweisse (TAP04)', 'Schneider Weisse', 'same', 'same'],
  ['Original TAP07', 'Original TAP04', 'Schneider Weisse', 'different', 'different'],
  ['Aventinus TAP06', 'Aventinus', 'Schneider Weisse', 'same', 'same'],
  ['Beer TAP 4', 'Beer TAP 5', 'Other', 'different', 'different'],
  ['Beer TAP 4', 'Beer', 'Other', 'different', 'number-fallback'],
  ['LAB29', 'LAB30', 'Pracownia Piwa', 'different', 'different'],
  ['LAB29', 'LAB 029', 'Pracownia Piwa', 'same', 'same'],
  ['LAB9', 'LAB10', 'Pracownia Piwa', 'different', 'different'],
  ['LAB29 Porter', 'Porter', 'Pracownia Piwa', 'different', 'number-fallback'],
  ['EL-1762 Pineapple', 'EL-1622 Pineapple', 'Moersleutel Craft Brewery', 'different', 'different'],
  ['EL-1762 Pineapple', 'EL1762 Pineapple', 'Moersleutel Craft Brewery', 'same', 'same'],
  ['EL-1762 Pineapple', 'Pineapple', 'Moersleutel Craft Brewery', 'different', 'number-fallback'],
  ['53 M Horseshoe', '53M Horseshoe', 'Hop Brook Brewery', 'same', 'same'],
  ['53M Horseshoe', 'Horseshoe', 'Hop Brook Brewery', 'different', 'number-fallback'],
  ['53 M Horseshoe', '53 N Horseshoe', 'Hop Brook Brewery', 'different', 'different'],
  ['Beer LAB29', 'Beer EL29', 'Pracownia Piwa / Moersleutel', 'different', 'different'],
  ['Beer #29', 'Beer LAB29', 'Pracownia Piwa', 'different', 'different'],
  ['Beer 10', 'Beer LAB29', 'Pracownia Piwa', 'different', 'different'],
  ['Beer 9.0', 'Beer LAB29', 'Pracownia Piwa', 'different', 'different'],
  ['Beer 2024', 'Beer LAB29 2025', 'Pracownia Piwa', 'different', 'different'],
  ['Beer', 'Beer LAB29 2025', 'Pracownia Piwa', 'number-fallback', 'different'],
])('%s / %s, %s → %s / %s', (a, b, brewery, forward, reverse) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), {
    input: { name: a, brewery }, candidate: { name: b, brewery },
  })).toBe(forward);
  expect(digitIdentity(readNameDigits(b), readNameDigits(a), {
    input: { name: b, brewery }, candidate: { name: a, brewery },
  })).toBe(reverse);
});
});
