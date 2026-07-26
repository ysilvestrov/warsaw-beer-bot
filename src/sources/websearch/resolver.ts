// src/sources/websearch/resolver.ts
export interface ResolvedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  abv: number | null; // always null from Brave; hydrated later via Algolia
}

export interface WebResolver {
  resolve(brewery: string, name: string): Promise<ResolvedBeer[]>;
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
}
export interface BraveResponse {
  web?: { results?: BraveResult[] };
}

// Untappd beer pages are `/b/<slug>/<digits>` — same shape parsed in search.ts.
// The bid must END the path segment (only a `?query`, `#fragment`, or end-of-
// string may follow): this excludes sub-pages like `/b/<slug>/<digits>/photos`,
// which carry the same bid but a garbled title (see parseBraveResponse below).
function bidFromLink(link: unknown): number | null {
  if (typeof link !== 'string') return null;
  const m = link.match(/\/b\/[^/]+\/(\d+)(?:[?#]|$)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Result titles are "<Beer Name> - <Brewery> - Untappd". Split from the right so
// beer names containing " - " survive: the last two segments are brewery and the
// "Untappd" suffix.
function splitTitle(title: unknown): { beer_name: string; brewery_name: string } | null {
  if (typeof title !== 'string') return null;
  const parts = title.split(' - ').map((s) => s.trim());
  if (parts.length < 3) return null;
  const suffix = parts[parts.length - 1];
  if (!/untappd/i.test(suffix)) return null;
  const brewery_name = parts[parts.length - 2];
  const beer_name = parts.slice(0, parts.length - 2).join(' - ');
  if (!beer_name || !brewery_name) return null;
  return { beer_name, brewery_name };
}

// Brave surfaces `/photos` (and similar) sub-pages as separate results carrying
// the SAME bid as the canonical page, with a garbled brewery segment
// ("Trzech Kumpli | Photos") that can never pass the downstream brewery gate
// (src/domain/web-fallback.ts). bidFromLink already excludes them by URL shape,
// so they never reach this loop — the `seen` Set below is just a belt-and-braces
// guard against Brave returning the same canonical URL twice (e.g. with
// different query strings), not the mechanism that drops sub-pages.
export function parseBraveResponse(json: BraveResponse): ResolvedBeer[] {
  if (!json || typeof json !== 'object') return [];
  const results = Array.isArray(json.web?.results) ? json.web!.results! : [];
  const out: ResolvedBeer[] = [];
  const seen = new Set<number>();
  for (const item of results) {
    const bid = bidFromLink(item.url);
    if (bid === null || seen.has(bid)) continue;
    const names = splitTitle(item.title);
    if (!names) continue;
    seen.add(bid);
    out.push({ bid, beer_name: names.beer_name, brewery_name: names.brewery_name, abv: null });
  }
  return out;
}

export interface BraveResolverOpts {
  key: string;
  count?: number; // results to request (default 5)
  minIntervalMs?: number; // spacing between outbound calls (default 1100)
  fetchImpl?: typeof fetch;
}

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export function createBraveResolver(opts: BraveResolverOpts): WebResolver {
  const f = opts.fetchImpl ?? fetch;
  const count = opts.count ?? 5;
  const minIntervalMs = opts.minIntervalMs ?? 1100;

  // Brave Free allows 1 request/second, and an over-rate 429 still costs us a
  // quota unit (consumed before the call) — so calls queue on a promise chain
  // instead of racing. The cron path is already sequential; this protects the
  // user-driven /enrich/result path, where the added latency (≤ ~1s) only ever
  // lands on the rare 0-candidate branch.
  let gate: Promise<void> = Promise.resolve();
  let last = 0;
  function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = gate.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async resolve(brewery: string, name: string): Promise<ResolvedBeer[]> {
      try {
        // Query is percent-encoded into the URL by hand (not URLSearchParams.set).
        const query = `${brewery} ${name}`.trim() + ' site:untappd.com';
        const url = new URL(`${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`);
        const res = await schedule(() =>
          f(url, {
            headers: { Accept: 'application/json', 'X-Subscription-Token': opts.key },
            // The serialization gate below means a hung request doesn't just run
            // slow — it blocks every queued caller behind it, each of whom has
            // already spent their quota unit. Bound it so a stall self-clears.
            signal: AbortSignal.timeout(8000),
          }),
        );
        if (!res.ok) return []; // 429 rate-limit / auth failure / anything → "no resolution"
        return parseBraveResponse((await res.json()) as BraveResponse);
      } catch {
        return [];
      }
    },
  };
}
