import {
  matchPrepared,
  prepareBeer,
  makePreparedCatalog,
  type CatalogBeer,
  type PreparedBeer,
  type PreparedCatalog,
} from './matcher';

export interface CatalogBeerWithRating extends CatalogBeer {
  rating_global: number | null;
}

export interface MatchInput {
  brewery: string;
  name: string;
  abv?: number | null;
}

export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
}

export interface MatchListResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  user_rating: number | null;
}

// ~0.027 ms/row on the prod catalog → 2000 rows ≈ ≤60 ms of normalization per chunk.
const PREP_CHUNK = 2000;

// Hands control back to the event loop so the long-poll bot processes its updates
// between CPU bursts. setImmediate fires after pending I/O callbacks.
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// Builds PreparedBeer[] in chunks, yielding between chunks, then assembles the catalog.
async function prepareCatalogChunked(
  catalog: CatalogBeerWithRating[],
  yield_: () => Promise<void>,
): Promise<PreparedCatalog> {
  const beers: PreparedBeer[] = [];
  for (let i = 0; i < catalog.length; i += PREP_CHUNK) {
    const end = Math.min(i + PREP_CHUNK, catalog.length);
    for (let j = i; j < end; j++) beers.push(prepareBeer(catalog[j]));
    await yield_();
  }
  return makePreparedCatalog(beers);
}

export interface MatchListOptions {
  // DI seam so tests can count yields deterministically; production uses the default.
  yield?: () => Promise<void>;
}

export async function matchBeerList(
  catalog: CatalogBeerWithRating[],
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
  opts: MatchListOptions = {},
): Promise<MatchListResult[]> {
  const yield_ = opts.yield ?? yieldToEventLoop;
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const prepared = await prepareCatalogChunked(catalog, yield_);
  const out: MatchListResult[] = [];
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    const m = matchPrepared(item, prepared);
    if (!m) {
      out.push({ raw, matched_beer: null, is_drunk: false, user_rating: null });
    } else {
      const beer = byId.get(m.id)!;
      out.push({
        raw,
        matched_beer: {
          id: beer.id,
          name: beer.name,
          brewery: beer.brewery,
          rating_global: beer.rating_global,
        },
        is_drunk: drunkSet.has(m.id),
        user_rating: ratingByBeerId.get(m.id) ?? null,
      });
    }
    await yield_();
  }
  return out;
}
