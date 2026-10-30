import { saveCatalogBeer, findCatalogBeer, type CatalogBeer } from '../db/indexed-db';

export interface UntappdSearchResult {
  bid: number;
  beerName: string;
  breweryName: string;
  abv?: number;
  style?: string;
  ratingGlobal: number | null;
  ratingCount?: number;
}

// Untappd Algolia App credentials used across their public web search
export const UNTAPPD_ALGOLIA_APP_ID = '9WBP99JLWJ';
export const UNTAPPD_ALGOLIA_SEARCH_KEY = '165f9bf67839600a9448e89f64bf35fb';

/**
 * Searches for a beer on Untappd via Algolia or HTML search and caches it locally.
 */
export async function searchUntappdBeer(brewery: string, name: string): Promise<UntappdSearchResult | null> {
  // 1. Check local catalog first
  const cached = await findCatalogBeer(brewery, name);
  if (cached) {
    return {
      bid: cached.bid,
      beerName: cached.name,
      breweryName: cached.brewery,
      abv: cached.abv,
      style: cached.style,
      ratingGlobal: cached.ratingGlobal,
    };
  }

  // 2. Perform Algolia search directly (official Untappd search backend)
  const query = `${brewery} ${name}`.trim();
  try {
    const algoliaRes = await fetch(`https://${UNTAPPD_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/beer/query`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': UNTAPPD_ALGOLIA_APP_ID,
        'X-Algolia-API-Key': UNTAPPD_ALGOLIA_SEARCH_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, hitsPerPage: 5 }),
    });

    if (algoliaRes.ok) {
      const data = await algoliaRes.json() as { hits?: Record<string, unknown>[] };
      const hits = data.hits || [];
      if (hits.length > 0) {
        const top = hits[0];
        const bid = Number(top.bid || top.beer_id || top.objectID);
        const beerName = String(top.beer_name || top.name || name);
        const breweryName = String(top.brewery_name || top.brewery || brewery);
        const abv = typeof top.beer_abv === 'number' ? top.beer_abv : (typeof top.abv === 'number' ? top.abv : undefined);
        const style = typeof top.beer_style === 'string' ? top.beer_style : (typeof top.style === 'string' ? top.style : undefined);
        const ratingGlobal = typeof top.rating_score === 'number' ? top.rating_score : null;

        if (Number.isFinite(bid) && bid > 0) {
          const result: UntappdSearchResult = {
            bid,
            beerName,
            breweryName,
            abv,
            style,
            ratingGlobal,
          };

          // Cache in local database permanently
          await saveCatalogBeer({
            bid: result.bid,
            name: result.beerName,
            brewery: result.breweryName,
            abv: result.abv,
            style: result.style,
            ratingGlobal: result.ratingGlobal,
          });

          return result;
        }
      }
    }
  } catch {
    // Algolia network/cors issue, fall back to untappd.com web search
  }

  // 3. Fallback to untappd.com search page
  try {
    const searchUrl = `https://untappd.com/search?q=${encodeURIComponent(query)}`;
    const webRes = await fetch(searchUrl, {
      credentials: 'include',
    });

    if (webRes.ok) {
      const html = await webRes.text();
      // Look for beer item in search results: <a href="/b/name/12345">
      const match = html.match(/href=["']\/b\/[^/]+\/(\d+)["'][^>]*>([^<]+)<\/a>/i);
      if (match) {
        const bid = parseInt(match[1], 10);
        const beerName = match[2].trim();

        // Extract rating if present
        const ratingMatch = html.match(/class=["'][^"']*rating\s+rating-(\d+)[^"']*["']/i);
        const ratingGlobal = ratingMatch ? parseInt(ratingMatch[1], 10) / 100 : null;

        const result: UntappdSearchResult = {
          bid,
          beerName,
          breweryName: brewery,
          ratingGlobal,
        };

        await saveCatalogBeer({
          bid: result.bid,
          name: result.beerName,
          brewery: result.breweryName,
          ratingGlobal: result.ratingGlobal,
        });

        return result;
      }
    }
  } catch {
    // Failed search
  }

  return null;
}
