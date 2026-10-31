import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { parseCheckinFeedPage } from '../../../src/shared/untappd/checkin-feed';

// #924: local mode parses untappd.com pages with the server's own parser, bundled with
// cheerio/slim (shared-core.config.ts). Its output must equal the server's (full cheerio) on
// the server's fixtures; the .parsed.json files are that output, written by
// scripts/untappd/gen-feed-parity-fixtures.ts.
const FIXTURES = join(__dirname, '../../../src/sources/untappd/__fixtures__');

describe('feed parser parity with the server', () => {
  it.each([
    'checkin-feed-page.html',
    'venue-activity-dom.html',
    'venue-more-feed-raw.html',
    'venue-menu.html',
  ])('%s parses to the same result as on the server', (name) => {
    const html = readFileSync(join(FIXTURES, name), 'utf8');
    const expected = JSON.parse(readFileSync(join(FIXTURES, name.replace(/\.html$/, '.parsed.json')), 'utf8'));
    expect(JSON.parse(JSON.stringify(parseCheckinFeedPage(html)))).toEqual(expected);
  });

  it('runs on the slim build (htmlparser2), not the full cheerio (parse5)', () => {
    // parse5 follows the HTML spec and inserts the implied <tbody>; htmlparser2 does not.
    expect(cheerio.load('<table><tr><td>x</td></tr></table>')('tbody').length).toBe(0);
  });
});
