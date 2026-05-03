import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { parseUserBeersPage } from './scraper';

const fixturePath = path.join(__dirname, '../../../tests/fixtures/untappd/user-beers.html');
const html = fs.readFileSync(fixturePath, 'utf8');

describe('parseUserBeersPage', () => {
  test('parses every .beer-item in the fixture', () => {
    const $ = cheerio.load(html);
    const expected = $('.beer-item[data-bid]').length;
    const items = parseUserBeersPage(html);
    expect(items.length).toBe(Math.min(expected, 25));
    expect(items.length).toBeGreaterThan(0);
  });

  test('first item has bid, name, brewery, style, both ratings populated', () => {
    const items = parseUserBeersPage(html);
    const first = items[0];
    expect(typeof first.bid).toBe('number');
    expect(Number.isFinite(first.bid)).toBe(true);
    expect(first.beer_name.length).toBeGreaterThan(0);
    expect(first.brewery_name.length).toBeGreaterThan(0);
    expect(first).toHaveProperty('style');
    if (first.global_rating !== null) {
      expect(typeof first.global_rating).toBe('number');
      expect(first.global_rating).toBeGreaterThan(0);
      expect(first.global_rating).toBeLessThanOrEqual(5);
    }
    if (first.their_rating !== null) {
      expect(typeof first.their_rating).toBe('number');
      expect(first.their_rating).toBeGreaterThanOrEqual(0);
      expect(first.their_rating).toBeLessThanOrEqual(5);
    }
  });

  test('caps result at first 25 items', () => {
    const items30 = Array.from({ length: 30 }, (_, i) => `
      <div class="beer-item" data-bid="${1000 + i}">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${1000 + i}">Beer ${i}</a></p>
          <p class="brewery"><a href="/x">Brewery ${i}</a></p>
          <p class="style">IPA</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (4)</p>
              <div class="caps" data-rating="4"></div>
            </div>
            <div class="you">
              <p>Global Rating (3.5)</p>
              <div class="caps" data-rating="3.5"></div>
            </div>
          </div>
        </div>
      </div>`).join('');
    const out = parseUserBeersPage(`<html><body>${items30}</body></html>`);
    expect(out.length).toBe(25);
  });

  test('returns empty array when page has no .beer-item', () => {
    expect(parseUserBeersPage('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });

  test('global_rating is null when data-rating is "N/A"', () => {
    const html = `
      <div class="beer-item" data-bid="42">
        <div class="beer-details">
          <p class="name"><a href="/b/x/42">New Release</a></p>
          <p class="brewery"><a href="/x">Some Brewery</a></p>
          <p class="style">Lager</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (4.5)</p>
              <div class="caps" data-rating="4.5"></div>
            </div>
            <div class="you">
              <p>Global Rating (N/A)</p>
              <div class="caps" data-rating="N/A"></div>
            </div>
          </div>
        </div>
      </div>`;
    const [it] = parseUserBeersPage(html);
    expect(it.bid).toBe(42);
    expect(it.global_rating).toBeNull();
    expect(it.their_rating).toBe(4.5);
  });

  test('skips item with non-numeric data-bid; keeps siblings', () => {
    const html = `
      <div class="beer-item" data-bid="abc">
        <div class="beer-details">
          <p class="name"><a>Bad</a></p>
          <p class="brewery"><a>X</a></p>
        </div>
      </div>
      <div class="beer-item" data-bid="99">
        <div class="beer-details">
          <p class="name"><a>Good</a></p>
          <p class="brewery"><a>Y</a></p>
          <p class="style">Stout</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (3)</p>
              <div class="caps" data-rating="3"></div>
            </div>
            <div class="you">
              <p>Global Rating (3.6)</p>
              <div class="caps" data-rating="3.6"></div>
            </div>
          </div>
        </div>
      </div>`;
    const out = parseUserBeersPage(html);
    expect(out.length).toBe(1);
    expect(out[0].bid).toBe(99);
  });

  test('blank style → null', () => {
    const html = `
      <div class="beer-item" data-bid="7">
        <div class="beer-details">
          <p class="name"><a>Whatever</a></p>
          <p class="brewery"><a>Anyone</a></p>
          <p class="style"></p>
          <div class="ratings"></div>
        </div>
      </div>`;
    const [it] = parseUserBeersPage(html);
    expect(it.style).toBeNull();
  });
});
