// #924: writes the server parser's output for each Untappd HTML fixture next to it, as
// <name>.parsed.json. The extension's parser-parity test compares its own run (cheerio/slim,
// browser build) against these. Run from the repo root with the full cheerio:
//   npx tsx scripts/untappd/gen-feed-parity-fixtures.ts
// Re-run only when a fixture or the parser changes on purpose; the diff is the review.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCheckinFeedPage } from '../../src/shared/untappd/checkin-feed';

export const PARITY_FIXTURES = [
  'checkin-feed-page.html',
  'venue-activity-dom.html',
  'venue-more-feed-raw.html',
  'venue-menu.html',
];

const dir = join(__dirname, '../../src/sources/untappd/__fixtures__');
for (const name of PARITY_FIXTURES) {
  const parsed = parseCheckinFeedPage(readFileSync(join(dir, name), 'utf8'));
  writeFileSync(join(dir, name.replace(/\.html$/, '.parsed.json')), `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`${name}: ${parsed.checkins.length} check-ins, profileTotal ${parsed.profileTotal}, nextMaxId ${parsed.nextMaxId}`);
}
