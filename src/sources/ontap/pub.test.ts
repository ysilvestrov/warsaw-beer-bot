import fs from 'node:fs';
import path from 'node:path';
import { parsePubPage, isOntapEmptyTapRef } from './pub';

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

test('beer_ref is clean — no ABV tail, no spec join (the °Plato grade stays)', () => {
  const { taps } = parsePubPage(html);
  for (const t of taps) {
    // #306: a trailing "12°" is the °Plato grade and part of the identity
    // ("Konrad 10°" ≠ "Konrad 12°"), so it is deliberately preserved. What must never
    // survive is a trailing ABV "%" or the mid-dot that joins spec atoms.
    expect(t.beer_ref).not.toMatch(/%\s*$/u);
    expect(t.beer_ref).not.toMatch(/[·•∙]/u);
  }
  expect(taps.some((t) => /\d\s*°\s*$/u.test(t.beer_ref))).toBe(true);
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
