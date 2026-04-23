import fs from 'node:fs';
import path from 'node:path';
import { parseWarsawIndex } from './index';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/ontap/warszawa-index.html'),
  'utf8',
);

test('parses at least 20 pubs with slug + name', () => {
  const pubs = parseWarsawIndex(html);
  expect(pubs.length).toBeGreaterThanOrEqual(20);
  const first = pubs[0];
  expect(first.slug).toMatch(/^[a-z0-9-]+$/);
  expect(first.name.length).toBeGreaterThan(0);
});

test('every pub has a subdomain URL derivable from slug', () => {
  const pubs = parseWarsawIndex(html);
  for (const p of pubs) expect(p.slug).not.toContain('/');
});
