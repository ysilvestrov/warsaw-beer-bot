import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { HttpError, normalizeProxyUrl } from '../http';
import type { FetchInitLike, FetchLike } from '../fetch-like';
import type { BeerSearch, SearchResult, HydratedBeer } from './search';

interface AlgoliaHit {
  bid?: unknown;
  beer_name?: unknown;
  brewery_name?: unknown;
  type_name?: unknown;
  beer_abv?: unknown;
  rating_score?: unknown;
  brewery_alias?: unknown;
  alias_alt?: unknown;
  rating_count?: unknown;
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

// #487: only a finite number counts. An absent or malformed value stays absent,
// so a candidate without evidence can never be dominated into a flagship decision.
function ratingCount(v: unknown): number | undefined {
  const n = num(v);
  return n === null ? undefined : n;
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
      brewery_alias: strList(h.brewery_alias),
      alias_alt: strList(h.alias_alt),
      rating_count: ratingCount(h.rating_count),
    });
  }
  return out;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter((x) => x.length > 0);
}

export function parseHydratedBeer(h: Record<string, unknown> | null): HydratedBeer | null {
  if (!h) return null;
  const bid = num(h.bid);
  if (bid === null) return null;
  const style = str(h.type_name);
  const slug = str(h.beer_slug);
  return {
    bid,
    beer_name: str(h.beer_name),
    brewery_name: str(h.brewery_name),
    style: style.length > 0 ? style : null,
    abv: num(h.beer_abv),
    global_rating: num(h.rating_score),
    beer_slug: slug.length > 0 ? slug : null,
    brewery_alias: strList(h.brewery_alias),
    rating_count: ratingCount(h.rating_count),
  };
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
  fetchImpl?: FetchLike;
  proxyUrl?: string;                                 // Webshare fallback (Task 4)
  refreshKeys?: () => Promise<AlgoliaKeys | null>;   // Task 4
  minGapMs?: number;
  /** #581: база ендпойнта. Дефолт — реальний Algolia; підмінюється лише тестом, щоб
   *  проксований шлях можна було перевірити на 127.0.0.1, без зовнішньої мережі. */
  endpointBase?: string;
}

// #581 (AI-рев'ю PR #585): база могла приїхати зі слешем на кінці, і конкатенація дала б
// `//1/indexes/…`. Сервер, у якого роут зареєстрований на `/1/indexes/…`, такого шляху просто
// не впізнає — і відповідь була б не та, яку тест думає, що перевіряє. Заразом це єдине місце,
// де живе дефолтний хост: раніше він був виписаний двічі й міг розійтися сам із собою.
function baseUrl(appId: string, base?: string): string {
  return (base ?? `https://${appId}-dsn.algolia.net`).replace(/\/+$/, '');
}

function endpoint(appId: string, base?: string): string {
  return `${baseUrl(appId, base)}/1/indexes/beer/query`;
}

export function createAlgoliaSearch(opts: AlgoliaSearchOpts) {
  // #581: глобальний `fetch` не приймає `dispatcher` з npm-undici.
  const f = opts.fetchImpl ?? undiciFetch;
  const gap = opts.minGapMs ?? 250;
  const proxy = opts.proxyUrl ? new ProxyAgent(normalizeProxyUrl(opts.proxyUrl)) : undefined;
  let keys: AlgoliaKeys = { appId: opts.appId, searchKey: opts.searchKey };
  let lastAt = 0;

  async function rawSearch(query: string, useProxy: boolean): Promise<SearchResult[]> {
    const wait = Math.max(0, lastAt + gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const init: FetchInitLike = {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': keys.appId,
        'X-Algolia-API-Key': keys.searchKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, hitsPerPage: ALGOLIA_HITS_PER_PAGE }),
    };
    if (useProxy && proxy) init.dispatcher = proxy;
    const res = await f(endpoint(keys.appId, opts.endpointBase), init);
    lastAt = Date.now();
    if (!res.ok) throw new HttpError(res.status, endpoint(keys.appId, opts.endpointBase));
    return parseAlgoliaResponse((await res.json()) as AlgoliaResponse);
  }

  async function rawHydrate(bids: number[], useProxy: boolean): Promise<Map<number, HydratedBeer>> {
    const wait = Math.max(0, lastAt + gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const init: FetchInitLike = {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': keys.appId,
        'X-Algolia-API-Key': keys.searchKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: bids.map((b) => ({ indexName: ALGOLIA_INDEX_NAME, objectID: String(b) })),
      }),
    };
    if (useProxy && proxy) init.dispatcher = proxy;
    const url = `${baseUrl(keys.appId, opts.endpointBase)}/1/indexes/*/objects`;
    const res = await f(url, init);
    lastAt = Date.now();
    if (!res.ok) throw new HttpError(res.status, url);
    // Results are positionally aligned with the requests; unknown objectIDs come back null.
    const json = (await res.json()) as { results?: (Record<string, unknown> | null)[] };
    const out = new Map<number, HydratedBeer>();
    for (const raw of json.results ?? []) {
      const parsed = parseHydratedBeer(raw);
      if (parsed) out.set(parsed.bid, parsed);
    }
    return out;
  }

  function isAuthBlock(e: unknown): e is HttpError {
    return e instanceof HttpError && (e.status === 401 || e.status === 403);
  }

  // Shared recovery: refresh a stale key, then fall back to the proxy on an IP ban.
  // Extracted from search() so hydrateByBid gets identical handling (#384).
  async function withRecovery<T>(run: (useProxy: boolean) => Promise<T>): Promise<T> {
    try {
      return await run(false);
    } catch (e1) {
      if (!isAuthBlock(e1)) throw e1; // 5xx/network → transient upstream
      if (opts.refreshKeys) {
        const fresh = await opts.refreshKeys().catch(() => null);
        if (fresh && fresh.searchKey !== keys.searchKey) {
          keys = fresh;
          try { return await run(false); } catch (e2) { if (!isAuthBlock(e2)) throw e2; }
        }
      }
      if (proxy) return await run(true);
      throw e1;
    }
  }

  return {
    search: (query: string) => withRecovery((useProxy) => rawSearch(query, useProxy)),
    async hydrateByBid(bids: number[]) {
      if (bids.length === 0) return new Map<number, HydratedBeer>();
      return withRecovery((useProxy) => rawHydrate(bids, useProxy));
    },
  } satisfies BeerSearch;
}
