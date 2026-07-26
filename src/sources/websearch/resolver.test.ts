import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBraveResponse } from './resolver';

// Real Brave output captured during the 2026-07-26 provider probe. Loaded with
// readFileSync (not a JSON import) to match the fixture convention in
// src/sources/untappd/checkin-feed.test.ts.
const brave = JSON.parse(readFileSync(join(__dirname, '__fixtures__/brave-maryensztadt.json'), 'utf8'));

describe('parseBraveResponse', () => {
  it('extracts bid/name/brewery from /b/ results and skips venue + brewery pages', () => {
    const out = parseBraveResponse(brave);
    expect(out.map((r) => r.bid)).toEqual([5549664, 5158585, 3809861]);
    expect(out[1].beer_name).toBe(
      'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
    );
    expect(out[1].brewery_name).toBe('Maryensztadt');
  });

  it('never reports an abv — Brave carries none', () => {
    expect(parseBraveResponse(brave).every((r) => r.abv === null)).toBe(true);
  });

  it('dedupes /photos twins by bid, keeping the canonical page', () => {
    const out = parseBraveResponse(brave);
    const gose = out.filter((r) => r.bid === 3809861);
    expect(gose).toHaveLength(1);
    // The canonical result comes first in Brave's ranking, so its clean brewery
    // survives instead of the "Trzech Kumpli | Photos" garble of the twin.
    expect(gose[0].brewery_name).toBe('Trzech Kumpli');
  });

  it('returns [] for an empty or malformed payload', () => {
    expect(parseBraveResponse({})).toEqual([]);
    expect(parseBraveResponse({ web: {} })).toEqual([]);
    expect(parseBraveResponse({ web: { results: [{ title: 42, url: null }] } } as never)).toEqual([]);
  });

  it('drops results whose title is not the "<Beer> - <Brewery> - Untappd" shape', () => {
    const out = parseBraveResponse({
      web: {
        results: [
          { title: 'Some Beer | Untappd', url: 'https://untappd.com/b/x/111' },
          { title: 'Beer - Brewery - Elsewhere', url: 'https://untappd.com/b/x/222' },
        ],
      },
    });
    expect(out).toEqual([]);
  });
});
