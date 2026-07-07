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

test('strips numeric tokens (ABV / strength / years)', () => {
  // Real ontap-style raw string after baseNormalize splits punctuation.
  expect(normalizeName('Buzdygan Rozkoszy 24°·8,5%')).toBe('buzdygan rozkoszy');
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
    expect(normalizeBrewery('Měšťanský Pivovary Polička')).toBe('mestansky policka');
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
});
