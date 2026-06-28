import type { SearchResult } from './search';

interface AlgoliaHit {
  bid?: unknown;
  beer_name?: unknown;
  brewery_name?: unknown;
  type_name?: unknown;
  beer_abv?: unknown;
  rating_score?: unknown;
}
export interface AlgoliaResponse { hits?: AlgoliaHit[]; nbHits?: number }

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
}

export function parseAlgoliaResponse(json: AlgoliaResponse): SearchResult[] {
  const hits = Array.isArray(json.hits) ? json.hits : [];
  const out: SearchResult[] = [];
  for (const h of hits) {
    const bid = num(h.bid);
    if (bid === null) continue;
    const style = str(h.type_name);
    out.push({
      bid,
      beer_name: str(h.beer_name),
      brewery_name: str(h.brewery_name),
      style: style.length > 0 ? style : null,
      abv: num(h.beer_abv),
      global_rating: num(h.rating_score),
    });
  }
  return out;
}

export interface AlgoliaKeys { appId: string; searchKey: string }

// Untappd embeds Algolia creds in inline page JS, either as
// `applicationID: '...'` / `apiKey: '...'` or JSON `"appId":"..."` / `"searchKey":"..."`.
export function extractAlgoliaKeys(html: string): AlgoliaKeys | null {
  const appId =
    html.match(/applicationID["'\s:=]+([A-Z0-9]{8,})/)?.[1] ??
    html.match(/"appId"\s*:\s*"([A-Z0-9]{8,})"/)?.[1];
  const searchKey =
    html.match(/apiKey["'\s:=]+([a-f0-9]{16,})/)?.[1] ??
    html.match(/"searchKey"\s*:\s*"([a-f0-9]{16,})"/)?.[1];
  return appId && searchKey ? { appId, searchKey } : null;
}
