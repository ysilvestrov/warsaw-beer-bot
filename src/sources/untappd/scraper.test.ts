import fs from 'node:fs';
import path from 'node:path';
import { parseUserBeerPage } from './scraper';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/untappd/user-beer.html'),
  'utf8',
);

test('extracts at most 25 checkins with name + brewery + date', () => {
  const items = parseUserBeerPage(html);
  expect(items.length).toBeGreaterThan(0);
  expect(items.length).toBeLessThanOrEqual(25);
  for (const c of items) {
    expect(c.beer_name.length).toBeGreaterThan(0);
    expect(c.brewery_name.length).toBeGreaterThan(0);
    expect(c.checkin_id.length).toBeGreaterThan(0);
  }
});
