import fs from 'node:fs';
import path from 'node:path';
import { parsePubPage } from './pub';

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
