import { normalizeName, normalizeBrewery, stripBreweryNoise, stripLegalForm, cleanSearchQuery, stripSearchNoise } from './normalize';

test('lowercases and strips diacritics', () => {
  expect(normalizeName('Atak Chmielu — Imperial')).toBe('atak chmielu');
  expect(normalizeName('Łyso Pysk')).toBe('lyso pysk');
});

test('removes common style noise', () => {
  expect(normalizeName('Piwo IPA (session)')).toBe('piwo');
  expect(normalizeName('Double Dry Hopped NEIPA Hopinka')).toBe('hopinka');
});

test('normalizes brewery the same way, no style stripping', () => {
  expect(normalizeBrewery('Browar Stu Mostów')).toBe('stu mostow');
});

test('strips Měšťanský (burgher-brewery descriptor) so only the place remains', () => {
  expect(normalizeBrewery('Měšťanský pivovar Kutná Hora')).toBe('kutna hora');
  expect(normalizeBrewery('Měšťanský pivovar Kojetín')).toBe('kojetin');
  expect(normalizeBrewery('Měšťanský pivovar Havlíčkův Brod')).toBe('havlickuv brod');
  // A real brand token next to it is untouched.
  expect(normalizeBrewery('Měšťanský pivovar Polička Brewery')).toBe('policka');
});

test('strips numeric tokens (ABV / strength / years)', () => {
  // Real ontap-style raw string after baseNormalize splits punctuation.
  expect(normalizeName('Buzdygan Rozkoszy 24°·8,5%')).toBe('buzdygan rozkoszy');
  expect(normalizeName('NoLo – Hemperor <0,5% alc <0,5%')).toBe('nolo hemperor');
  expect(normalizeName('Light Lager 4.5% ABV 20 IBU')).toBe('light');
  // Year-only tokens — vintages of the same beer collapse to one key.
  expect(normalizeName('Buzdygan Rozkoszy 2026')).toBe('buzdygan rozkoszy');
  expect(normalizeName('Buzdygan Rozkoszy 2024')).toBe('buzdygan rozkoszy');
  // Brewery normalizer follows the same rule.
  expect(normalizeBrewery('Browar Stu 8,5%')).toBe('stu');
});

test('preserves decimal release identifiers in beer names', () => {
  expect(normalizeName('Ambrosia 9.0')).toBe('ambrosia 9.0');
  expect(normalizeName('Ambrosia 8.0')).toBe('ambrosia 8.0');
  expect(normalizeName(' Ambrosia 9,0 ')).toBe('ambrosia 9.0');
  expect(normalizeName('Ambrosia 9.0 — IPA')).toBe('ambrosia 9.0');
});

describe('normalizeName structural search noise', () => {
  test.each([
    ['Nonalco Matcha IPA (puszka)', 'nonalco matcha'],
    ['Free Pan Da (puszka)', 'free pan da'],
    ['Ole! (puszka)', 'ole'],
    ['Jubilance (Pure Bedlam Collab)', 'jubilance'],
    ['Wonders [passionfruit, banana]', 'wonders'],
    ['NoLo – Hemperor <0,5% alc <0,5%', 'nolo hemperor'],
    ['“Jubilance”.', 'jubilance'],
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizeName(raw)).toBe(expected);
  });

  test('normalizes noisy and clean names symmetrically', () => {
    expect(normalizeName('Jubilance (Pure Bedlam Collab)')).toBe(normalizeName('Jubilance'));
  });

  test('preserves internal punctuation and decimal release identifiers', () => {
    expect(normalizeName('Dynaboost: Mosaic 9.0')).toBe('dynaboost mosaic 9.0');
  });
});

test('strips every Polish diacritic', () => {
  expect(normalizeBrewery('ąćęłńóśźż')).toBe('acelnoszz');
  expect(normalizeBrewery('ĄĆĘŁŃÓŚŹŻ')).toBe('acelnoszz');
  expect(normalizeBrewery('Żywiec')).toBe('zywiec');
  expect(normalizeBrewery('Średnica')).toBe('srednica');
  expect(normalizeBrewery('Księżyc')).toBe('ksiezyc');
  expect(normalizeBrewery('Piąte')).toBe('piate');
});

describe('stripBreweryNoise', () => {
  test('drops a trailing "Brewery" suffix', () => {
    expect(stripBreweryNoise('JBW Brewery')).toBe('JBW');
  });
  test('drops "Browar" in any position', () => {
    expect(stripBreweryNoise('Browar Pinta')).toBe('Pinta');
  });
  test('preserves case and diacritics of non-noise tokens', () => {
    expect(stripBreweryNoise('Gościszewo Brewery')).toBe('Gościszewo');
  });
  test('multi-word brewery keeps all non-noise words', () => {
    expect(stripBreweryNoise('Trzech Kumpli Brewery')).toBe('Trzech Kumpli');
  });
  test('all-noise brewery collapses to empty string', () => {
    expect(stripBreweryNoise('Browar')).toBe('');
  });
  test('brewery with no noise words is unchanged', () => {
    expect(stripBreweryNoise('Magic Road')).toBe('Magic Road');
  });
});

describe('collab-aware stripBreweryNoise (#117 Omnipollo)', () => {
  test('drops the "collab" descriptor glued to a slash and joins collab parts', () => {
    expect(stripBreweryNoise('Omnipollo collab/ Trillium Brewing Company')).toBe('Omnipollo Trillium');
  });
  test('drops bare "collab"/"collaboration" tokens', () => {
    expect(stripBreweryNoise('Foo collab Bar')).toBe('Foo Bar');
    expect(stripBreweryNoise('Foo Collaboration Bar')).toBe('Foo Bar');
  });
  test('collapses x- and &-connectors to space', () => {
    expect(stripBreweryNoise('Alpha x Beta')).toBe('Alpha Beta');
    expect(stripBreweryNoise('Alpha & Beta')).toBe('Alpha Beta');
  });
  test('leaves a non-collab " - " brewery intact', () => {
    expect(stripBreweryNoise('Kykao - Handcrafted')).toBe('Kykao - Handcrafted');
  });
});

describe('multilingual brewery descriptors', () => {
  test('normalizeBrewery strips foreign brewery words', () => {
    expect(normalizeBrewery('Pivovar Černá Hora')).toBe('cerna hora');
    // 'měšťanský' ("burgher's/civic") is now a brewery-type descriptor too, so only
    // the place survives (2026-07-21).
    expect(normalizeBrewery('Měšťanský Pivovary Polička')).toBe('policka');
    expect(normalizeBrewery('Brauerei Aying')).toBe('aying');
    expect(normalizeBrewery('Brasserie Dupont')).toBe('dupont');
    expect(normalizeBrewery('Birrificio Italiano')).toBe('italiano');
    expect(normalizeBrewery('Brouwerij Bosteels')).toBe('bosteels');
    expect(normalizeBrewery('Stigbergets Bryggeri')).toBe('stigbergets');
    expect(normalizeBrewery('Nya Carnegie Bryggeriet')).toBe('nya carnegie');
    expect(normalizeBrewery('Cervecería Maier')).toBe('maier');
    expect(normalizeBrewery('Browary Regionalne')).toBe('regionalne');
  });

  test('stripBreweryNoise drops Pivovar in any position (case-insensitive)', () => {
    expect(stripBreweryNoise('Pivovar Polička')).toBe('Polička');
    expect(stripBreweryNoise('Cerna Hora Pivovar')).toBe('Cerna Hora');
  });
});

describe('compound nano-brewery noise tokens', () => {
  test('strips compound "Nanobrowar"/"Nanobryggeri" descriptors (#228)', () => {
    // "Nanobrowar" is Polish for "nano-brewery" — a single compound token that
    // normalizeBrewery must strip so the brand survives and hits its curated alias.
    expect(normalizeBrewery('Nanobrowar Starkraft Brewery')).toBe('starkraft');
    expect(normalizeBrewery('Kamfjord Nanobryggeri')).toBe('kamfjord');
  });

  test('does NOT strip bare "nano" — it can be part of a brand', () => {
    // Negative guard: bare "nano" is a separate word or brand fragment, never noise.
    expect(normalizeBrewery('Nano Cinco')).toBe('nano cinco');
    expect(normalizeBrewery('Mandrill Nano Brewing Co.')).toBe('mandrill nano');
  });
});

describe('contracts noise word', () => {
  test('drops "contracts" so official-suffix collapses to the brand', () => {
    expect(normalizeBrewery('Harpagan Contracts')).toBe('harpagan');
  });
});

describe('stripLegalForm', () => {
  test('removes Sp. z o.o. and dotted/spacing variants', () => {
    expect(stripLegalForm('Browar X Sp. z o.o.')).toBe('Browar X');
    expect(stripLegalForm('Browar X Sp.z o.o.')).toBe('Browar X');
    expect(stripLegalForm('Browar X Sp. z o. o.')).toBe('Browar X');
  });

  test('removes S.A.', () => {
    expect(stripLegalForm('Żywiec S.A.')).toBe('Żywiec');
  });

  test('leaves non-legal text untouched', () => {
    expect(stripLegalForm('Harpagan Contracts')).toBe('Harpagan Contracts');
  });
});

describe('normalizeBrewery with legal forms', () => {
  test('strips legal form before tokenizing', () => {
    expect(normalizeBrewery('Browar X Sp. z o.o.')).toBe('x'); // "browar" is noise
  });

  test('does not clobber standalone z / o tokens', () => {
    expect(normalizeBrewery('Pinta z Warszawy')).toBe('pinta z warszawy');
    expect(normalizeBrewery('Browar O Beczki')).toBe('o beczki');
  });
});

describe('cleanSearchQuery', () => {
  test('dedups brewery repeated in the name and drops noise incl. "Co." (#126 Track)', () => {
    expect(cleanSearchQuery('TRACK BREWING CO.', 'Track Brewing Company Taking Shape')).toBe(
      'TRACK Taking Shape',
    );
  });
  test('dedups a trailing brewery duplication (#155 Trzech Kumpli)', () => {
    expect(
      cleanSearchQuery('TRZECH KUMPLI Brewery', 'Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli'),
    ).toBe('TRZECH KUMPLI Porter Bałtycki Żytnio-Orkiszowy');
  });
  test('non-duplicated beer is unchanged (no regression)', () => {
    expect(cleanSearchQuery('Pinta', 'Atak Chmielu')).toBe('Pinta Atak Chmielu');
  });
  test('preserves digits and original casing in surviving tokens', () => {
    expect(cleanSearchQuery('Pinta', 'Many Hops 2023')).toBe('Pinta Many Hops 2023');
  });
  test('strips a legal-form brewery suffix (Sp. z o.o.) instead of leaking it into the query', () => {
    expect(cleanSearchQuery('Pinta Sp. z o.o.', 'Atak Chmielu')).toBe('Pinta Atak Chmielu');
  });
  test('all-noise input falls back to the raw name (never an empty query)', () => {
    expect(cleanSearchQuery('Brewing Co', 'Company')).toBe('Company');
  });
  test('collapses a collab connector so "x" does not leak into the query', () => {
    expect(cleanSearchQuery('Alpha x Beta', 'Some Beer')).toBe('Alpha Beta Some Beer');
  });
  test('strips a bracketed adjunct list from the query (#236 Magic Road 30888)', () => {
    expect(
      cleanSearchQuery('Magic Road Brewery', 'Wonders [passionfruit,banana, coconut cream]'),
    ).toBe('Magic Road Wonders');
  });
  test('drops a collab parenthetical (#236 Funky Fluid 31266/31267)', () => {
    expect(
      cleanSearchQuery('Funky Fluid', 'Dynaboost: Mosaic (collab Yakima Chief)'),
    ).toBe('Funky Fluid Dynaboost: Mosaic');
  });
  test('strips ABV/spec strings (#236 Piwne Podziemie 12082)', () => {
    expect(
      cleanSearchQuery('Piwne Podziemie Brewery', 'NoLo – Hemperor <0,5% alc <0,5%'),
    ).toBe('Piwne Podziemie NoLo Hemperor');
  });
  test('cleans a dangling/unbalanced paren without leaking the bracket char', () => {
    const q = cleanSearchQuery('Funky Fluid', 'Mosaic (collab Yakima Chief');
    expect(q).toBe('Funky Fluid Mosaic Yakima Chief');
    expect(q).not.toContain('(');
  });
  test('all-noise input never yields an empty query (fallback)', () => {
    expect(cleanSearchQuery('Brewing Co', '[only adjuncts]')).toBe('Brewing Co');
  });
  test('uses the raw name only as a last resort when all cleaned input is empty', () => {
    expect(cleanSearchQuery('', '(only)')).toBe('(only)');
  });
  test('#270 31133: mid-name tokens repeating the brewery are kept, lone leading "x" dropped', () => {
    // Was destroyed to "Magic Road Upside Down: to" — Road/Upside dropped as dup-of-brewery.
    expect(
      cleanSearchQuery('Browar Magic Road', 'x Upside Down: Road to Upside'),
    ).toBe('Magic Road Upside Down: Road to Upside');
  });
  test('#270: mid-name token duplicating the brewery is kept (not deduped away)', () => {
    // OLD global dedup dropped the second "Milk" (part of the beer name) -> "Milk Coffee Stout".
    // NEW edge-run dedup keeps the mid-name "Milk"; a repeated identical Algolia term is harmless.
    expect(cleanSearchQuery('Milk Brewery', 'Coffee x Milk Stout')).toBe('Milk Coffee Milk Stout');
  });
  test('#270 31135: leading collab "x" dropped, rest of the name intact (regression guard)', () => {
    expect(cleanSearchQuery('Nepo Brewing', 'x Uncharted: Top-Tier')).toBe(
      'Nepo Uncharted: Top-Tier',
    );
  });
});

describe('stripSearchNoise', () => {
  test('removes balanced [..] and (..) groups', () => {
    expect(stripSearchNoise('Wonders [a, b] (collab X)')).toBe('Wonders');
  });
  test('removes stray/unbalanced brackets', () => {
    expect(stripSearchNoise('Mosaic (collab X')).toBe('Mosaic collab X');
  });
  test('removes ABV/spec strings and labels', () => {
    expect(stripSearchNoise('Hemperor <0,5% alc 4.5% abv 24°')).toBe('Hemperor');
  });
  test('leaves an ordinary name untouched', () => {
    expect(stripSearchNoise('Dynaboost: Mosaic')).toBe('Dynaboost: Mosaic');
  });
  test('removes wrapping quote marks and trailing punctuation', () => {
    expect(stripSearchNoise('“Jubilance”.')).toBe('Jubilance');
    expect(stripSearchNoise('"Jubilance"?!')).toBe('Jubilance');
    expect(stripSearchNoise('„Jubilance”   ;:')).toBe('Jubilance');
  });
  test('preserves token boundaries around quote marks', () => {
    expect(stripSearchNoise('Foo"Bar')).toBe('Foo Bar');
    expect(normalizeName('Foo"Bar')).toBe('foo bar');
  });
  test('preserves internal punctuation', () => {
    expect(stripSearchNoise('Dynaboost: Mosaic')).toBe('Dynaboost: Mosaic');
  });
  test('preserves digit-bearing compact identifiers but strips letter-only groups', () => {
    expect(stripSearchNoise('Festweisse (TAP04)')).toBe('Festweisse TAP04');
    expect(normalizeName('Festweisse (TAP04)')).toBe('festweisse tap04');
    expect(stripSearchNoise('Imperial Stout (BBA)')).toBe('Imperial Stout');
    expect(normalizeName('Imperial Stout (BBA)')).toBe('');
    expect(stripSearchNoise('Nonalco Matcha IPA (puszka)')).toBe('Nonalco Matcha IPA');
  });
  test('mixed valid name + noise: drops both bracket groups whole, keeps the name', () => {
    expect(stripSearchNoise('Brewery (Special Edition) [adjuncts]')).toBe('Brewery');
  });
});

describe("'family' brewery noise (#309)", () => {
  test('family is dropped so X Family Brewery == X Brewery', () => {
    expect(normalizeBrewery('HOPPY HOG FAMILY BREWERY')).toBe('hoppy hog');
    expect(normalizeBrewery('Hoppy Hog Family Brewery')).toBe('hoppy hog');
    expect(normalizeBrewery('HOPPY HOG BREWERY')).toBe('hoppy hog');
  });
  test('family is dropped from the search query brand tokens', () => {
    expect(cleanSearchQuery('Hoppy Hog Family Brewery', 'Pale Ale')).toBe('Hoppy Hog Pale Ale');
  });
});

describe('minipivovar brewery noise (#318)', () => {
  test('minipivovar is stripped so it matches the bare brand', () => {
    expect(normalizeBrewery('Minipivovar Skřečoňský žabák')).toBe('skreconsky zabak');
    expect(normalizeBrewery('Skřečoňský žabák')).toBe('skreconsky zabak');
  });
});

describe("Series: label strip (#303)", () => {
  test('strips a leading "<label> Series:" prefix, keeping the tail', () => {
    expect(stripSearchNoise('Crazy Lines Series: Redwood')).toBe('Redwood');
    expect(stripSearchNoise('Gold Series: Blast')).toBe('Blast');
    expect(stripSearchNoise('WORLD CUP SERIES - 5 SPECIAL BEER')).toBe('5 SPECIAL BEER'); // uppercase
  });
  test('tolerates casing and whitespace around the separator', () => {
    expect(stripSearchNoise('gold series : blast')).toBe('blast'); // lowercase + space before colon
    expect(stripSearchNoise('Gold SERIES:Blast')).toBe('Blast');   // no space after colon
  });
  test('drops the Series label from the built search query', () => {
    expect(cleanSearchQuery('Nepomucen', 'Crazy Lines Series: Redwood')).toBe('Nepomucen Redwood');
  });
  test('negative guard: leaves names without a series label untouched', () => {
    expect(stripSearchNoise('Time Series IPA')).toBe('Time Series IPA');
    expect(stripSearchNoise('Double Dry Hopped Galaxy')).toBe('Double Dry Hopped Galaxy');
  });
});
