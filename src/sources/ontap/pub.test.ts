import fs from 'node:fs';
import path from 'node:path';
import { parsePubPage, extractBeerName, isOntapEmptyTapRef, normalizeOntapTapIdentity } from './pub';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/ontap/beer-bones.html'),
  'utf8',
);

test('parses pub metadata', () => {
  const result = parsePubPage(html);
  expect(result.pub.name).toMatch(/beer.*bones/i);
  expect(result.pub.address).toMatch(/Żurawia/);
  expect(result.pub.lat).toBeCloseTo(52.228, 2);
  expect(result.pub.lon).toBeCloseTo(21.013, 2);
});

test('parses taps with beer_ref and abv', () => {
  const { taps } = parsePubPage(html);
  expect(taps.length).toBeGreaterThanOrEqual(10);
  const withAbv = taps.filter((t) => t.abv !== null);
  expect(withAbv.length).toBeGreaterThan(0);
  for (const t of taps) expect(t.beer_ref.length).toBeGreaterThan(0);
});

test('beer_ref is clean — no ABV / strength tokens', () => {
  const { taps } = parsePubPage(html);
  for (const t of taps) {
    expect(t.beer_ref).not.toMatch(/\d+\s*[°%]/);
  }
});

test('style is populated when subtitle exists', () => {
  const { taps } = parsePubPage(html);
  // At least some taps in a real ontap page have a style subtitle.
  const withStyle = taps.filter((t) => t.style && t.style.length > 0);
  expect(withStyle.length).toBeGreaterThan(0);
});

test('recognizes only the exact case-insensitive N/A empty-tap sentinel', () => {
  expect(isOntapEmptyTapRef(' N/A ')).toBe(true);
  expect(isOntapEmptyTapRef('n/a')).toBe(true);
  expect(isOntapEmptyTapRef('N/A Lager')).toBe(false);
  expect(isOntapEmptyTapRef('')).toBe(false);
});

describe('tap_number parsing', () => {
  // ontap.pl labels hand-pump / cask taps "N Pompa" instead of a bare "N";
  // regular taps are just "N". Both must yield the integer N.
  const panel = (label: string, h4: string) =>
    `<div class="panel panel-default" onclick="location.href='https://x.ontap.pl/beer?mode=view'">` +
    `<h5><span class="label label-primary">${label}</span></h5>` +
    `<h4>${h4}</h4></div>`;

  test('extracts the leading integer from "N Pompa" pump-tap labels', () => {
    const html =
      panel('1 Pompa', 'Monsters Brewery Bonfire Boy 6,5%') +
      panel('2 Pompa', 'Kufle i Kapsle Brewery KRAN W SERWISIE') +
      panel('3', 'Monsters Brewery Cheek Squieeze 5%');
    const { taps } = parsePubPage(html);
    expect(taps.map((t) => t.tap_number)).toEqual([1, 2, 3]);
  });

  test('non-numeric labels still yield null tap_number', () => {
    const { taps } = parsePubPage(panel('Pompa', 'Some Brewery Some Beer 5%'));
    expect(taps[0].tap_number).toBeNull();
  });
});

describe('extractBeerName', () => {
  test('truncates at first ABV-like token', () => {
    expect(extractBeerName('Buzdygan Rozkoszy 24°·8,5%', null)).toBe('Buzdygan Rozkoszy');
    expect(extractBeerName('Pan IPAni 16,5°·6%', null)).toBe('Pan IPAni');
    expect(extractBeerName('Salamander 6%', null)).toBe('Salamander');
  });

  test('keeps anniversary degree marks that are part of the beer name', () => {
    expect(extractBeerName('Birra Menabrea Brewery La 150° Bionda 4,8%', 'Birra Menabrea Brewery'))
      .toBe('La 150° Bionda');
  });

  test('strips brewery prefix when present', () => {
    expect(extractBeerName('Harpagan Brewery Buzdygan Rozkoszy 24°·8,5%', 'Harpagan Brewery'))
      .toBe('Buzdygan Rozkoszy');
    expect(extractBeerName('Stu Mostów WRCLW Salamander 6%', 'Stu Mostów'))
      .toBe('WRCLW Salamander');
  });

  test('case-insensitive brewery match', () => {
    expect(extractBeerName('PINTA Atak Chmielu 6%', 'Pinta'))
      .toBe('Atak Chmielu');
  });

  test('returns full text when no ABV pattern is found', () => {
    expect(extractBeerName('Aperitivo Spritz', null)).toBe('Aperitivo Spritz');
  });

  test('returns empty string when only brewery is present', () => {
    expect(extractBeerName('Pinta', 'Pinta')).toBe('');
  });
});

describe('normalizeOntapTapIdentity', () => {
  test('drops blank tap names before catalog writes', () => {
    expect(normalizeOntapTapIdentity('Some Brewery', '')).toBeNull();
    expect(normalizeOntapTapIdentity('Some Brewery', '   ')).toBeNull();
  });

  test('strips cider category and duplicate brewery prefix from Chyliczki names', () => {
    expect(normalizeOntapTapIdentity('Chyliczki', 'Cydr Chyliczki - Japoński Sad'))
      .toEqual({ brewery: 'Chyliczki', name: 'Japoński Sad' });
  });

  test('maps Cydr Dzik generic rows to the real cidery and product name', () => {
    expect(normalizeOntapTapIdentity('CYDR DZIK', 'polski cydr'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik' });
  });

  test('maps Cydr Dzik fruit rows to the real cidery and product name', () => {
    expect(normalizeOntapTapIdentity('CYDR DZIK Brewery', 'Cydr Jabłko'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik Jabłko' });
    expect(normalizeOntapTapIdentity('CYDR DZIK Brewery', 'Jabłko'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik Jabłko' });
    expect(normalizeOntapTapIdentity('CYDR DZIK', 'Cydr Gruszka'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik Gruszka' });
  });

  test('does not invent a Cydr Dzik product name from a bare cider label', () => {
    expect(normalizeOntapTapIdentity('CYDR DZIK Brewery', 'Cydr'))
      .toEqual({ brewery: 'CYDR DZIK Brewery', name: 'Cydr' });
  });

  test('maps Cydr Flirt Tradycynis rows to Kauno Alus product names', () => {
    expect(normalizeOntapTapIdentity('Cydr Flirt Tradycynis', 'Cydr malina i skórka pomarańczowa'))
      .toEqual({ brewery: 'Kauno Alus', name: 'Tradycynis Cydr Flirt malina i skórka pomarańczowa' });
  });

  test('drops brewery-only rows and known location/category brewery pollution', () => {
    expect(normalizeOntapTapIdentity('Przetwórnia Chmielu Brewery', 'Przetwórnia Chmielu')).toBeNull();
    expect(normalizeOntapTapIdentity('Frankies Brewery', 'Frankies')).toBeNull();
    expect(normalizeOntapTapIdentity('W Brzesku Brewery', 'Žatecký Nealko')).toBeNull();
    expect(normalizeOntapTapIdentity('vaisiu sultys', 'Cydr Gruszkowy')).toBeNull();
  });

  test('keeps unknown brewery/name shapes unchanged', () => {
    expect(normalizeOntapTapIdentity('Unknown Brewery', 'Some New Beer'))
      .toEqual({ brewery: 'Unknown Brewery', name: 'Some New Beer' });
  });
});
