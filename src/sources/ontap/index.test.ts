import fs from 'node:fs';
import path from 'node:path';
import { parseOntapCityIndex } from './index';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/ontap/warszawa-index.html'),
  'utf8',
);

// A real, captured non-Warsaw city page (Kraków), proving the same DOM template
// is served across cities so parseOntapCityIndex generalizes (#146, spec §7).
const krakowHtml = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/ontap/krakow-index.html'),
  'utf8',
);

test('parses exactly 43 pubs with slug + name from Warsaw fixture', () => {
  const pubs = parseOntapCityIndex(html);
  expect(pubs).toHaveLength(43);
  expect(pubs[0]).toEqual({
    slug: 'taproom-wilanow',
    name: 'Bar & Pub Taproom.Wilanów',
    taps: 22,
  });
  expect(pubs[pubs.length - 1]).toEqual({
    slug: 'white-crow',
    name: 'White Crow - Craft Beer&Kitchen',
    taps: 25,
  });
});

test('every pub has a subdomain URL derivable from slug', () => {
  const pubs = parseOntapCityIndex(html);
  for (const p of pubs) expect(p.slug).not.toContain('/');
});

test('generalizes to a non-Warsaw city page (Kraków)', () => {
  const pubs = parseOntapCityIndex(krakowHtml);
  // The real captured Kraków page lists exactly 25 pubs — the same DOM template as Warsaw.
  expect(pubs).toHaveLength(25);
  expect(pubs[0]).toEqual({
    slug: 'antycafe',
    name: 'Antycafe',
    taps: 26,
  });
  expect(pubs[pubs.length - 1]).toEqual({
    slug: 'wezze-krafta',
    name: 'Weźże Krafta',
    taps: 25,
  });
});
