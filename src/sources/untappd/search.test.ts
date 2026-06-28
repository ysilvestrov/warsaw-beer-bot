import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { buildSearchUrl, parseSearchPage, htmlSearch } from './search';

const fixturePath = path.join(__dirname, '../../../tests/fixtures/untappd/search-magic-road.html');
const html = fs.readFileSync(fixturePath, 'utf8');

describe('buildSearchUrl', () => {
  test('encodes query and includes type=beer', () => {
    const url = buildSearchUrl('Magic Road Fifty/Fifty Clementine');
    expect(url.startsWith('https://untappd.com/search?')).toBe(true);
    expect(url).toContain('type=beer');
    expect(url).toContain('Magic');
    expect(url).toContain('Road');
    expect(url).toContain('%2F'); // literal "/" must be url-encoded
  });

  test('handles empty query gracefully (still returns a valid URL)', () => {
    const url = buildSearchUrl('');
    expect(url).toMatch(/^https:\/\/untappd\.com\/search\?/);
  });
});

describe('parseSearchPage', () => {
  test('first result from the captured fixture is the Magic Road bug-trigger beer', () => {
    const items = parseSearchPage(html);
    expect(items.length).toBeGreaterThan(0);
    const first = items[0];
    expect(first.bid).toBe(6645513);
    expect(first.beer_name).toContain('Fifty Fifty');
    expect(first.beer_name).toContain('Clementine');
    expect(first.brewery_name).toBe('Magic Road');
    expect(first.style).toContain('Sour');
    expect(first.abv).toBeCloseTo(4.6);
    expect(first.global_rating).toBeCloseTo(3.984, 2);
  });

  test('caps result at first 5 items', () => {
    const $ = cheerio.load(html);
    const total = $('.beer-item').length;
    const items = parseSearchPage(html);
    expect(items.length).toBe(Math.min(total, 5));
  });

  test('synthetic: extracts bid from .name a href /b/<slug>/<digits>', () => {
    const html = `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/some-brewery-some-beer/42">Some Beer</a></p>
          <p class="brewery"><a>Some Brewery</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">5.5% ABV</p>
          <div class="rating">
            <div class="caps" data-rating="3.7"></div>
          </div>
        </div>
      </div>`;
    const out = parseSearchPage(html);
    expect(out.length).toBe(1);
    expect(out[0].bid).toBe(42);
    expect(out[0].beer_name).toBe('Some Beer');
    expect(out[0].brewery_name).toBe('Some Brewery');
    expect(out[0].abv).toBeCloseTo(5.5);
    expect(out[0].global_rating).toBeCloseTo(3.7);
  });

  test('synthetic: caps at 5 even when more items present', () => {
    const items10 = Array.from({ length: 10 }, (_, i) => `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/brew/${1000 + i}">Beer ${i}</a></p>
          <p class="brewery"><a>Brewery ${i}</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
          <div class="rating"><div class="caps" data-rating="3.5"></div></div>
        </div>
      </div>`).join('');
    const out = parseSearchPage(`<html><body>${items10}</body></html>`);
    expect(out.length).toBe(5);
  });

  test('returns empty array when page has no .beer-item', () => {
    expect(parseSearchPage('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });

  test('global_rating is null when data-rating is "N/A" or unparseable', () => {
    const html = `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/42">New Release</a></p>
          <p class="brewery"><a>Brewery</a></p>
          <p class="style">Lager</p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
          <div class="rating">
            <div class="caps" data-rating="N/A"></div>
          </div>
        </div>
      </div>`;
    const [it] = parseSearchPage(html);
    expect(it.bid).toBe(42);
    expect(it.global_rating).toBeNull();
  });

  test('abv null when text is "N/A% ABV"', () => {
    const html = `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/7">Whatever</a></p>
          <p class="brewery"><a>Anyone</a></p>
          <p class="style">Stout</p>
        </div>
        <div class="details beer">
          <p class="abv">N/A% ABV</p>
        </div>
      </div>`;
    const [it] = parseSearchPage(html);
    expect(it.abv).toBeNull();
  });

  test('skips beer-item without a parseable bid in href', () => {
    const html = `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/something-else">Bad URL</a></p>
          <p class="brewery"><a>X</a></p>
        </div>
      </div>
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/y/99">Good</a></p>
          <p class="brewery"><a>Y</a></p>
          <p class="style">Stout</p>
        </div>
        <div class="details beer">
          <p class="abv">6% ABV</p>
          <div class="rating"><div class="caps" data-rating="3.6"></div></div>
        </div>
      </div>`;
    const out = parseSearchPage(html);
    expect(out.length).toBe(1);
    expect(out[0].bid).toBe(99);
  });

  test('blank style → null', () => {
    const html = `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/7">Whatever</a></p>
          <p class="brewery"><a>Anyone</a></p>
          <p class="style"></p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
        </div>
      </div>`;
    const [it] = parseSearchPage(html);
    expect(it.style).toBeNull();
  });
});

describe('htmlSearch', () => {
  it('parses relayed HTML via parseSearchPage', async () => {
    const s = htmlSearch('<html></html>'); // empty Algolia shell → no .beer-item
    expect(await s.search('anything')).toEqual([]);
  });

  it('throws a block HttpError on a block page (so lookupBeer marks it blocked)', async () => {
    const BLOCK_PAGE_HTML = '<title>Just a moment...</title>';
    const s = htmlSearch(BLOCK_PAGE_HTML);
    await expect(s.search('x')).rejects.toMatchObject({ name: 'HttpError', status: 403 });
  });
});
