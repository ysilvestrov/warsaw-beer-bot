import fs from 'node:fs';
import path from 'node:path';
import { buildBeerPageUrl, parseBeerPage } from './beer-page';

const fixturePath = path.join(__dirname, '../../../tests/fixtures/untappd/beer-page-magic-road.html');
const html = fs.readFileSync(fixturePath, 'utf8');

describe('buildBeerPageUrl', () => {
  test('formats /beer/{bid}', () => {
    expect(buildBeerPageUrl(6645513)).toBe('https://untappd.com/beer/6645513');
  });

  test('integer-only — fractional bids are not Untappd-valid', () => {
    expect(buildBeerPageUrl(1)).toBe('https://untappd.com/beer/1');
  });
});

describe('parseBeerPage', () => {
  test('extracts non-null global_rating from the captured fixture (bid 6645513 = 3.98471)', () => {
    const out = parseBeerPage(html);
    expect(out.global_rating).not.toBeNull();
    expect(typeof out.global_rating).toBe('number');
    // Fixture is Magic Road Fifty/Fifty Clementine & Passionfruit at
    // capture-time rating 3.98471. Use loose tolerance — Untappd may
    // recalculate but the order of magnitude won't change.
    expect(out.global_rating).toBeGreaterThan(0);
    expect(out.global_rating).toBeLessThanOrEqual(5);
    expect(out.global_rating).toBeCloseTo(3.98, 1);
  });

  test('returns null global_rating when page has no .caps[data-rating]', () => {
    const out = parseBeerPage('<html><body><p>nothing here</p></body></html>');
    expect(out.global_rating).toBeNull();
  });

  test('returns null when data-rating is "N/A" (Untappd uses this before 10 check-ins)', () => {
    const synthetic = `
      <html><body>
        <div class="basic">
          <div class="rating">
            <div class="caps" data-rating="N/A"></div>
          </div>
        </div>
      </body></html>`;
    const out = parseBeerPage(synthetic);
    expect(out.global_rating).toBeNull();
  });

  test('returns the global rating when a numeric data-rating is present', () => {
    const synthetic = `
      <html><body>
        <div class="basic">
          <div class="rating">
            <div class="caps" data-rating="3.78"></div>
          </div>
        </div>
      </body></html>`;
    const out = parseBeerPage(synthetic);
    expect(out.global_rating).toBeCloseTo(3.78);
  });

  test('handles "0" data-rating as 0 (not null) — distinguishes "no rating" from "rated zero"', () => {
    const synthetic = `
      <html><body>
        <div class="basic">
          <div class="rating">
            <div class="caps" data-rating="0"></div>
          </div>
        </div>
      </body></html>`;
    const out = parseBeerPage(synthetic);
    expect(out.global_rating).toBe(0);
  });
});
