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

test('parses at least 20 pubs with slug + name', () => {
  const pubs = parseOntapCityIndex(html);
  expect(pubs.length).toBeGreaterThanOrEqual(20);
  const first = pubs[0];
  expect(first.slug).toMatch(/^[a-z0-9-]+$/);
  expect(first.name.length).toBeGreaterThan(0);
});

test('every pub has a subdomain URL derivable from slug', () => {
  const pubs = parseOntapCityIndex(html);
  for (const p of pubs) expect(p.slug).not.toContain('/');
});

test('generalizes to a non-Warsaw city page (Kraków)', () => {
  const pubs = parseOntapCityIndex(krakowHtml);
  // The real captured Kraków page lists ~25 pubs — the same DOM template as Warsaw.
  expect(pubs.length).toBeGreaterThanOrEqual(10);
  const first = pubs[0];
  expect(first.slug).toMatch(/^[a-z0-9-]+$/);
  expect(first.slug).not.toContain('/');
  expect(first.name.length).toBeGreaterThan(0);
});
