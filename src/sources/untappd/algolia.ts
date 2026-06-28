import { ProxyAgent } from 'undici';
import { HttpError, normalizeProxyUrl } from '../http';
import type { BeerSearch, SearchResult } from './search';

interface AlgoliaHit {
  bid?: unknown;
  beer_name?: unknown;
  brewery_name?: unknown;
  type_name?: unknown;
  beer_abv?: unknown;
  rating_score?: unknown;
}
export interface AlgoliaResponse { hits?: AlgoliaHit[]; nbHits?: number }
export interface AlgoliaQuery {
  appId: string;
  searchKey: string;
  indexName: 'beer';
  query: string;
  hitsPerPage: number;
}

export const ALGOLIA_DEFAULTS = {
  appId: '9WBO4RQ3HO',
  searchKey: '1d347324d67ec472bb7132c66aead485',
} as const;
export const ALGOLIA_INDEX_NAME = 'beer';
export const ALGOLIA_HITS_PER_PAGE = 5;

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

export interface AlgoliaSearchOpts {
  appId: string;
  searchKey: string;
  fetchImpl?: typeof fetch;
  proxyUrl?: string;                                 // Webshare fallback (Task 4)
  refreshKeys?: () => Promise<AlgoliaKeys | null>;   // Task 4
  minGapMs?: number;
}

function endpoint(appId: string): string {
  return `https://${appId}-dsn.algolia.net/1/indexes/beer/query`;
}

export function createAlgoliaSearch(opts: AlgoliaSearchOpts): BeerSearch {
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 250;
  const proxy = opts.proxyUrl ? new ProxyAgent(normalizeProxyUrl(opts.proxyUrl)) : undefined;
  let keys: AlgoliaKeys = { appId: opts.appId, searchKey: opts.searchKey };
  let lastAt = 0;

  async function rawSearch(query: string, useProxy: boolean): Promise<SearchResult[]> {
    const wait = Math.max(0, lastAt + gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const init: RequestInit & { dispatcher?: unknown } = {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': keys.appId,
        'X-Algolia-API-Key': keys.searchKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, hitsPerPage: ALGOLIA_HITS_PER_PAGE }),
    };
    if (useProxy && proxy) init.dispatcher = proxy;
    const res = await f(endpoint(keys.appId), init);
    lastAt = Date.now();
    if (!res.ok) throw new HttpError(res.status, endpoint(keys.appId));
    return parseAlgoliaResponse((await res.json()) as AlgoliaResponse);
  }

  function isAuthBlock(e: unknown): e is HttpError {
    return e instanceof HttpError && (e.status === 401 || e.status === 403);
  }

  return {
    async search(query: string): Promise<SearchResult[]> {
      try {
        return await rawSearch(query, false);
      } catch (e1) {
        if (!isAuthBlock(e1)) throw e1; // 5xx/network → transient upstream
        // 1) try refreshing keys, retry direct if they actually changed
        if (opts.refreshKeys) {
          const fresh = await opts.refreshKeys().catch(() => null);
          if (fresh && fresh.searchKey !== keys.searchKey) {
            keys = fresh;
            try { return await rawSearch(query, false); } catch (e2) { if (!isAuthBlock(e2)) throw e2; }
          }
        }
        // 2) fall back to the proxy (possible IP ban)
        if (proxy) return await rawSearch(query, true);
        throw e1;
      }
    },
  };
}
