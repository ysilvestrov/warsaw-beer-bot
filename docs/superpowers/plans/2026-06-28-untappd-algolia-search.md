# Untappd Algolia Search (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead HTML-scraping Untappd beer search with the Algolia JSON API behind a `BeerSearch` seam, with canary health-check, key auto-refresh, proxy fallback, and enrich health in the daily status.

**Architecture:** A new `BeerSearch` interface decouples `lookupBeer`'s matching pipeline from the search transport. `createAlgoliaSearch` implements it against Untappd's Algolia index (`beer`), handling key refresh and proxy fallback internally and throwing `HttpError` only after exhausting fallbacks. The matching pipeline, backoff, breaker, and `enrich_failures` are reused unchanged. The client relay (#89) keeps working as a no-op adapter over the (now empty) HTML it relays; its real Algolia migration is Phase 2.

**Tech Stack:** Node.js, TypeScript, Vitest, undici (`ProxyAgent`), better-sqlite3, Telegraf.

**Spec:** `docs/superpowers/specs/2026-06-28-untappd-algolia-search-design.md`

**Worktree guard (every task):** Before committing, run `git rev-parse --show-toplevel && git branch --show-current` and confirm you are in the worktree for this feature, NOT the main checkout at `/home/ysi/warsaw-beer-bot`. Commit only files this task names.

---

### Task 1: Algolia hit → SearchResult mapping (pure)

**Files:**
- Create: `src/sources/untappd/algolia.ts`
- Test: `src/sources/untappd/algolia.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/sources/untappd/algolia.test.ts
import { describe, it, expect } from 'vitest';
import { parseAlgoliaResponse } from './algolia';

const HIT = {
  bid: 5469263,
  beer_name: 'After Hours: Rose Wild Ale',
  brewery_name: 'PINTA Barrel Brewing',
  type_name: 'Wild Ale - Other',
  beer_abv: 5.7,
  rating_score: 3.89,
};

describe('parseAlgoliaResponse', () => {
  it('maps hits to SearchResult fields', () => {
    const out = parseAlgoliaResponse({ hits: [HIT], nbHits: 1 });
    expect(out).toEqual([
      { bid: 5469263, beer_name: 'After Hours: Rose Wild Ale', brewery_name: 'PINTA Barrel Brewing', style: 'Wild Ale - Other', abv: 5.7, global_rating: 3.89 },
    ]);
  });

  it('returns [] for empty hits', () => {
    expect(parseAlgoliaResponse({ hits: [], nbHits: 0 })).toEqual([]);
  });

  it('coerces missing/invalid numeric fields to null', () => {
    const out = parseAlgoliaResponse({ hits: [{ bid: 1, beer_name: 'X', brewery_name: 'Y' }], nbHits: 1 });
    expect(out[0]).toEqual({ bid: 1, beer_name: 'X', brewery_name: 'Y', style: null, abv: null, global_rating: null });
  });

  it('skips hits without a numeric bid', () => {
    expect(parseAlgoliaResponse({ hits: [{ beer_name: 'X', brewery_name: 'Y' }], nbHits: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/untappd/algolia.test.ts`
Expected: FAIL — `parseAlgoliaResponse` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/sources/untappd/algolia.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/untappd/algolia.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts
git commit -m "feat(untappd): Algolia response → SearchResult mapping"
```

---

### Task 2: Algolia key extraction from search page (pure)

**Files:**
- Modify: `src/sources/untappd/algolia.ts`
- Test: `src/sources/untappd/algolia.test.ts`

- [ ] **Step 1: Write the failing test** (append to algolia.test.ts)

```ts
import { extractAlgoliaKeys } from './algolia';

describe('extractAlgoliaKeys', () => {
  it('pulls appId and searchKey from inline JS', () => {
    const html = `<script>var c={ applicationID: '9WBO4RQ3HO', apiKey: '1d347324d67ec472bb7132c66aead485' };</script>`;
    expect(extractAlgoliaKeys(html)).toEqual({ appId: '9WBO4RQ3HO', searchKey: '1d347324d67ec472bb7132c66aead485' });
  });

  it('also matches JSON-style appId/searchKey', () => {
    const html = `"appId":"9WBO4RQ3HO","searchKey":"1d347324d67ec472bb7132c66aead485"`;
    expect(extractAlgoliaKeys(html)).toEqual({ appId: '9WBO4RQ3HO', searchKey: '1d347324d67ec472bb7132c66aead485' });
  });

  it('returns null when keys are absent', () => {
    expect(extractAlgoliaKeys('<html>nothing here</html>')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/untappd/algolia.test.ts -t extractAlgoliaKeys`
Expected: FAIL — `extractAlgoliaKeys` not exported.

- [ ] **Step 3: Write minimal implementation** (append to algolia.ts)

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/untappd/algolia.test.ts -t extractAlgoliaKeys`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts
git commit -m "feat(untappd): extract Algolia keys from search page HTML"
```

---

### Task 3: `BeerSearch` interface + `createAlgoliaSearch` (direct request, classification)

**Files:**
- Modify: `src/sources/untappd/search.ts` (add `BeerSearch` interface; keep `SearchResult`, `buildSearchUrl`)
- Modify: `src/sources/untappd/algolia.ts` (add `createAlgoliaSearch`)
- Test: `src/sources/untappd/algolia.test.ts`

- [ ] **Step 1: Add the `BeerSearch` interface to search.ts**

Add near the top of `src/sources/untappd/search.ts`, after the `SearchResult` interface:

```ts
// Decouples the matching pipeline (lookupBeer) from the search transport.
// Implementations: createAlgoliaSearch (server), htmlSearch (relay adapter).
// Throws HttpError on a hard block (after exhausting retries); throws other
// errors for transient failures; resolves [] for a genuine no-result query.
export interface BeerSearch {
  search(query: string): Promise<SearchResult[]>;
}
```

- [ ] **Step 2: Write the failing test** (append to algolia.test.ts)

```ts
import { createAlgoliaSearch } from './algolia';
import { HttpError } from '../http';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createAlgoliaSearch (direct)', () => {
  it('POSTs query to the index and returns mapped hits', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ hits: [{ bid: 7, beer_name: 'B', brewery_name: 'Br' }], nbHits: 1 });
    }) as unknown as typeof fetch;
    const s = createAlgoliaSearch({ appId: 'APP', searchKey: 'KEY', fetchImpl });
    const out = await s.search('hazy ipa');
    expect(out).toEqual([{ bid: 7, beer_name: 'B', brewery_name: 'Br', style: null, abv: null, global_rating: null }]);
    expect(calls[0].url).toBe('https://APP-dsn.algolia.net/1/indexes/beer/query');
    expect((calls[0].init.headers as Record<string, string>)['X-Algolia-Application-Id']).toBe('APP');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ query: 'hazy ipa', hitsPerPage: 5 });
  });

  it('returns [] for a genuine empty result (200, nbHits 0)', async () => {
    const fetchImpl = (async () => jsonRes({ hits: [], nbHits: 0 })) as unknown as typeof fetch;
    const s = createAlgoliaSearch({ appId: 'A', searchKey: 'K', fetchImpl });
    expect(await s.search('nope')).toEqual([]);
  });

  it('throws HttpError(500) on 5xx (→ transient upstream)', async () => {
    const fetchImpl = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    const s = createAlgoliaSearch({ appId: 'A', searchKey: 'K', fetchImpl });
    await expect(s.search('x')).rejects.toBeInstanceOf(HttpError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/sources/untappd/algolia.test.ts -t "createAlgoliaSearch"`
Expected: FAIL — `createAlgoliaSearch` not exported.

- [ ] **Step 4: Write minimal implementation** (append to algolia.ts)

```ts
import { ProxyAgent } from 'undici';
import { HttpError } from '../http';
import { normalizeProxyUrl } from '../http';
import type { BeerSearch } from './search';

const ALGOLIA_HITS_PER_PAGE = 5;

export interface AlgoliaSearchOpts {
  appId: string;
  searchKey: string;
  fetchImpl?: typeof fetch;
  proxyUrl?: string;                       // Webshare fallback (Task 4)
  refreshKeys?: () => Promise<AlgoliaKeys | null>;  // Task 4
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

  return {
    async search(query: string): Promise<SearchResult[]> {
      return rawSearch(query, false);
    },
  };
}
```

Also add the `SearchResult` import at the top of algolia.ts if not present (Task 1 imported the type already).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/sources/untappd/algolia.test.ts -t "createAlgoliaSearch"`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/sources/untappd/search.ts src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts
git commit -m "feat(untappd): BeerSearch interface + Algolia direct client"
```

---

### Task 4: Algolia key auto-refresh + proxy fallback on 401/403

**Files:**
- Modify: `src/sources/untappd/algolia.ts` (`search` retry logic)
- Test: `src/sources/untappd/algolia.test.ts`

- [ ] **Step 1: Write the failing test** (append to algolia.test.ts)

```ts
describe('createAlgoliaSearch (403 handling)', () => {
  it('refreshes keys on 403 and retries direct with the new key', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)['X-Algolia-API-Key'];
      seen.push(key);
      if (key === 'OLD') return new Response('forbidden', { status: 403 });
      return jsonRes({ hits: [{ bid: 1, beer_name: 'B', brewery_name: 'Br' }], nbHits: 1 });
    }) as unknown as typeof fetch;
    const s = createAlgoliaSearch({
      appId: 'A', searchKey: 'OLD', fetchImpl,
      refreshKeys: async () => ({ appId: 'A', searchKey: 'NEW' }),
    });
    const out = await s.search('x');
    expect(out).toHaveLength(1);
    expect(seen).toEqual(['OLD', 'NEW']); // refreshed then retried
  });

  it('falls back to the proxy when the key did not change', async () => {
    let direct = 0;
    const fetchImpl = (async (_url: string, init: RequestInit & { dispatcher?: unknown }) => {
      if (!init.dispatcher) { direct++; return new Response('forbidden', { status: 403 }); }
      return jsonRes({ hits: [{ bid: 2, beer_name: 'B', brewery_name: 'Br' }], nbHits: 1 });
    }) as unknown as typeof fetch;
    const s = createAlgoliaSearch({
      appId: 'A', searchKey: 'SAME', proxyUrl: 'user:pass@host:1', fetchImpl,
      refreshKeys: async () => ({ appId: 'A', searchKey: 'SAME' }), // unchanged
    });
    const out = await s.search('x');
    expect(out).toHaveLength(1);
    expect(direct).toBe(1); // one direct 403 then proxy success
  });

  it('throws HttpError(403) when direct, refresh, and proxy all fail', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const s = createAlgoliaSearch({
      appId: 'A', searchKey: 'OLD', proxyUrl: 'user:pass@host:1', fetchImpl,
      refreshKeys: async () => ({ appId: 'A', searchKey: 'NEW' }),
    });
    await expect(s.search('x')).rejects.toMatchObject({ name: 'HttpError', status: 403 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/untappd/algolia.test.ts -t "403 handling"`
Expected: FAIL — current `search` does no refresh/proxy retry.

- [ ] **Step 3: Replace the returned `search` in createAlgoliaSearch**

Replace the `return { async search... }` block from Task 3 with:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/untappd/algolia.test.ts`
Expected: PASS (all algolia tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts
git commit -m "feat(untappd): Algolia key auto-refresh + proxy fallback on 403"
```

---

### Task 5: Refactor `lookupBeer` onto the `BeerSearch` seam

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (lines 18-92: `LookupArgs`, the fetch/parse block)
- Test: `src/domain/untappd-lookup.test.ts` (migrate fake `fetch` → fake `BeerSearch`)

- [ ] **Step 1: Inspect current tests**

Run: `sed -n '1,60p' src/domain/untappd-lookup.test.ts`
Note how each test builds `fetch` returning HTML and asserts the outcome. You will replace the HTML-returning `fetch` with a `search` that returns `SearchResult[]` keyed by query.

- [ ] **Step 2: Change the type + call site in untappd-lookup.ts**

In `LookupArgs` (around line 24) replace:
```ts
  fetch: (url: string) => Promise<string>;
```
with:
```ts
  search: BeerSearch;
```

Update imports at the top: remove `parseSearchPage` and `isBlockPage`/`buildSearchUrl` usage from this file's search path; import the interface:
```ts
import { type SearchResult, type BeerSearch } from '../sources/untappd/search';
```
(Keep `HttpError` and `isBlockStatus` imports — still used for classification.)

Replace the per-part fetch/parse block (current lines ~76-94) with:

```ts
  for (const part of parts) {
    const query = cleanSearchQuery(part, name);
    triedUrls.push(buildSearchUrl(query)); // human-readable debug URL for enrich_failures

    let results: SearchResult[];
    try {
      results = await args.search.search(query);
    } catch (error) {
      if (error instanceof HttpError && isBlockStatus(error.status)) {
        return { kind: 'blocked', searchUrl: buildSearchUrl(query) };
      }
      return { kind: 'transient', error };
    }

    seenCandidates.push(...results);
    if (results.length === 0) continue;
```

Keep `buildSearchUrl` imported (re-add to the import from search.ts). Everything from `// Stage 1` downward is unchanged.

- [ ] **Step 3: Migrate the tests**

Replace each test's `fetch` helper. Add a helper at the top of `untappd-lookup.test.ts`:

```ts
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

// Build a fake BeerSearch from a map of query→results (or a function).
function fakeSearch(fn: (q: string) => SearchResult[] | Promise<SearchResult[]>): BeerSearch {
  return { search: async (q) => fn(q) };
}
function throwingSearch(err: unknown): BeerSearch {
  return { search: async () => { throw err; } };
}
```

For each existing test: where it previously parsed an HTML fixture into candidates, supply those `SearchResult[]` directly via `fakeSearch`. For block tests, use `throwingSearch(new HttpError(403, 'u'))`; for transient, `throwingSearch(new Error('boom'))`. Pass `search: …` instead of `fetch: …` in the `lookupBeer({...})` calls.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/untappd-lookup.test.ts`
Expected: PASS. If a test depended on HTML-specific parsing quirks, assert on the mapped `SearchResult` shape instead.

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "refactor(untappd): lookupBeer searches via BeerSearch seam"
```

---

### Task 6: `htmlSearch` adapter + keep the relay endpoint compiling

**Files:**
- Modify: `src/sources/untappd/search.ts` (add `htmlSearch`)
- Modify: `src/api/routes/enrich.ts` (line 77)
- Test: `src/sources/untappd/search.test.ts`

- [ ] **Step 1: Write the failing test** (in search.test.ts)

```ts
import { htmlSearch } from './search';

describe('htmlSearch', () => {
  it('parses relayed HTML via parseSearchPage', async () => {
    const s = htmlSearch('<html></html>'); // empty Algolia shell → no .beer-item
    expect(await s.search('anything')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/untappd/search.test.ts -t htmlSearch`
Expected: FAIL — `htmlSearch` not exported.

- [ ] **Step 3: Implement `htmlSearch` in search.ts**

```ts
// Adapter so the client relay (#89) keeps flowing relayed HTML through the same
// pipeline. Phase 1: relayed search pages are the empty Algolia shell, so this
// resolves []. Phase 2 will replace the relay with Algolia JSON directly.
export function htmlSearch(html: string): BeerSearch {
  return { search: async () => parseSearchPage(html) };
}
```

(Keep `parseSearchPage` exported — it is used here.)

- [ ] **Step 4: Update enrich.ts** — replace line 77:

```ts
    const outcome = await lookupBeer({ brewery, name, abv: row.abv, search: htmlSearch(html) });
```

Add the import in enrich.ts:
```ts
import { buildSearchUrl, htmlSearch } from '../../sources/untappd/search';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/sources/untappd/search.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/sources/untappd/search.ts src/sources/untappd/search.test.ts src/api/routes/enrich.ts
git commit -m "feat(untappd): htmlSearch adapter keeps relay endpoint on BeerSearch"
```

---

### Task 7: Thread `BeerSearch` through `enrichOneOrphan`

**Files:**
- Modify: `src/jobs/untappd-enrich.ts`
- Test: `src/jobs/untappd-enrich.test.ts`

- [ ] **Step 1: Update `EnrichDeps` and the `lookupBeer` call**

In `src/jobs/untappd-enrich.ts` replace the `http: Http` field on `EnrichDeps` with `search: BeerSearch`:
```ts
import type { BeerSearch } from '../sources/untappd/search';
// ...
export interface EnrichDeps {
  db: DB;
  log: pino.Logger;
  search: BeerSearch;
  now?: () => Date;
}
```
Replace the `lookupBeer({ ..., fetch: (url) => deps.http.get(url) })` call with:
```ts
  const outcome = await lookupBeer({
    brewery: beer.brewery,
    name: beer.name,
    abv: beer.abv,
    search: deps.search,
  });
```

- [ ] **Step 2: Update the test** to inject `search` instead of `http`

Run: `sed -n '1,40p' src/jobs/untappd-enrich.test.ts` to see the current `http` fake, then replace it with a `BeerSearch` fake (`{ search: async () => [...] }`) consistent with Task 5's helper.

- [ ] **Step 3: Run tests + typecheck**

Run: `npx vitest run src/jobs/untappd-enrich.test.ts && npx tsc --noEmit`
Expected: PASS (note: `enrich-orphans.ts` and `index.ts` will not typecheck yet — that is fixed in Tasks 8 & 11; run the targeted vitest file here, defer full `tsc` to Task 11).

- [ ] **Step 4: Commit**

```bash
git add src/jobs/untappd-enrich.ts src/jobs/untappd-enrich.test.ts
git commit -m "refactor(enrich): enrichOneOrphan uses BeerSearch"
```

---

### Task 8: Canary heartbeat + admin alert in `enrich-orphans`

**Files:**
- Modify: `src/jobs/enrich-orphans.ts`
- Modify: `src/storage/job_state.ts` consumers (use existing get/setJobState — no schema change)
- Test: `src/jobs/enrich-orphans.test.ts`

**Constants & state keys (define at top of enrich-orphans.ts):**
```ts
export const CANARY_QUERY = 'Guinness Draught';
export const CANARY_STATE_KEY = 'untappd_search_canary'; // JSON {ok:boolean, at:string}
```

- [ ] **Step 1: Write the failing tests** (append to enrich-orphans.test.ts)

```ts
import { getJobState } from '../storage/job_state';

it('aborts the run and alerts when the canary returns no hits', async () => {
  const db = makeTestDb();            // reuse the suite's existing db helper
  seedOrphans(db, 3);                 // reuse existing seed helper
  const alerts: string[] = [];
  const search = { search: async (q: string) => (q === 'Guinness Draught' ? [] : [{ bid: 1, beer_name: 'x', brewery_name: 'y', style: null, abv: null, global_rating: null }]) };
  const breaker = { canAttempt: () => true, onResult: vi.fn(), state: 'closed' as const };
  const res = await enrichOrphans({ db, log: silentLog, search, breaker, notifyAdmin: async (m) => { alerts.push(m); }, sleepMs: 0 });
  expect(res.processed).toBe(0);                       // no orphans touched
  expect(breaker.onResult).toHaveBeenCalledWith(true, expect.anything());
  expect(alerts).toHaveLength(1);
  expect(JSON.parse(getJobState(db, 'untappd_search_canary')!).ok).toBe(false);
});

it('proceeds and records canary ok when the canary returns hits', async () => {
  const db = makeTestDb();
  seedOrphans(db, 2);
  const search = { search: async () => [{ bid: 1, beer_name: 'x', brewery_name: 'y', style: null, abv: null, global_rating: null }] };
  const breaker = { canAttempt: () => true, onResult: vi.fn(), state: 'closed' as const };
  const res = await enrichOrphans({ db, log: silentLog, search, breaker, sleepMs: 0 });
  expect(res.processed).toBeGreaterThan(0);
  expect(JSON.parse(getJobState(db, 'untappd_search_canary')!).ok).toBe(true);
});
```

Adapt `makeTestDb`/`seedOrphans`/`silentLog` to whatever helpers the existing test file already uses; if none exist, build a `:memory:` db via the suite's standard setup and insert orphan rows with `upsertBeer`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/enrich-orphans.test.ts -t canary`
Expected: FAIL — no canary logic; `EnrichOrphansDeps` has no `search`/`notifyAdmin`.

- [ ] **Step 3: Implement canary in enrich-orphans.ts**

Update `EnrichOrphansDeps`: replace `http: Http` with `search: BeerSearch`; add `notifyAdmin?: (msg: string) => Promise<void>`. Update the `enrichOneOrphan` call to pass `{ db, log, search: deps.search, now }`.

Insert, right after the `if (!breaker.canAttempt(...))` guard and before `listLookupCandidates`:

```ts
  // Canary: one search for a known-present beer. A systemic failure (rotated key,
  // renamed index, soft IP ban) returns 200+empty for everything and must NOT be
  // mistaken for per-beer not_found — that would corrupt orphan backoff.
  let canaryOk = false;
  try {
    const hits = await deps.search.search(CANARY_QUERY);
    canaryOk = hits.length > 0;
  } catch {
    canaryOk = false;
  }
  setJobState(deps.db, CANARY_STATE_KEY, JSON.stringify({ ok: canaryOk, at: now().toISOString() }));
  if (!canaryOk) {
    breaker.onResult(true, now());
    deps.log.error('enrich-orphans canary failed — Untappd search appears broken; aborting run');
    if (deps.notifyAdmin) await deps.notifyAdmin('⚠️ Untappd-пошук не відповідає (канарка порожня) — enrich призупинено.');
    return { ...ZERO_RESULT, blocked: 1 };
  }
```

Add imports: `import { setJobState } from '../storage/job_state';` and `import type { BeerSearch } from '../sources/untappd/search';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/enrich-orphans.test.ts`
Expected: PASS (existing tests updated to pass `search` instead of `http`; canary tests green).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/enrich-orphans.ts src/jobs/enrich-orphans.test.ts
git commit -m "feat(enrich): canary heartbeat aborts run + alerts on broken Untappd search"
```

---

### Task 9: Enrich health metrics in `collectStatus`

**Files:**
- Modify: `src/storage/stats.ts` (`StatusMetrics`, `collectStatus`)
- Test: `src/storage/stats.test.ts`

- [ ] **Step 1: Write the failing test** (in stats.test.ts, following the file's existing setup)

```ts
it('reports enrich health metrics', () => {
  const db = makeStatsDb();   // reuse the file's existing db builder
  // matched in last 24h
  db.prepare(`INSERT INTO beers (untappd_id,name,brewery,normalized_name,normalized_brewery,untappd_lookup_at) VALUES (10,'A','B','a','b',?)`).run(new Date().toISOString());
  // a fresh enrich failure
  db.prepare(`INSERT INTO enrich_failures (beer_id,brewery,name,search_url,outcome,candidates_count,candidates_summary,fail_count,last_at) VALUES (10,'B','A','u','not_found',0,'',1,?)`).run(new Date().toISOString());
  setJobState(db, 'untappd_search_canary', JSON.stringify({ ok: true, at: new Date().toISOString() }));
  const m = collectStatus(db, new Date());
  expect(m.enrichMatched24h).toBe(1);
  expect(m.enrichFailures24h).toBe(1);
  expect(m.untappdSearchHealthy).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/stats.test.ts -t "enrich health"`
Expected: FAIL — fields not on `StatusMetrics`.

- [ ] **Step 3: Implement**

Add to `StatusMetrics`:
```ts
  enrichMatched24h: number;
  enrichFailures24h: number;
  untappdSearchHealthy: boolean;
```

In `collectStatus`, with `cutoff24` already computed, add:
```ts
  const canaryRaw = getJobState(db, 'untappd_search_canary');
  const canaryOk = canaryRaw ? (JSON.parse(canaryRaw) as { ok: boolean }).ok : true;
  const circuitOpenUntil = getJobState(db, 'untappd_circuit_open_until');
  const circuitOpen = circuitOpenUntil != null && Date.parse(circuitOpenUntil) > now.getTime();
```
Add to the returned object:
```ts
    enrichMatched24h: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL AND untappd_lookup_at >= ?', [cutoff24]),
    enrichFailures24h: count('SELECT COUNT(*) AS c FROM enrich_failures WHERE last_at >= ?', [cutoff24]),
    untappdSearchHealthy: canaryOk && !circuitOpen,
```
Add `import { getJobState } from './job_state';` at the top.

(Confirm the persisted breaker key by checking `src/domain/untappd-circuit.ts` / its index.ts wiring: it is `'untappd_circuit_open_until'`. If the stored value is an epoch-ms string rather than ISO, compare with `Number(circuitOpenUntil) > now.getTime()` instead — verify the format in `createPersistentCircuitBreaker` and match it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/stats.ts src/storage/stats.test.ts
git commit -m "feat(stats): enrich health metrics (matched/failures 24h + search health)"
```

---

### Task 10: Enrich line in the daily status digest

**Files:**
- Modify: `src/jobs/daily-status.ts` (`buildStatusMessage`)
- Test: `src/jobs/daily-status.test.ts`

- [ ] **Step 1: Write the failing test** (in daily-status.test.ts)

```ts
it('renders the enrich line with health icon', () => {
  const base = { /* fill all StatusMetrics fields used by buildStatusMessage */ } as StatusMetrics;
  const m = { ...base, enrichMatched24h: 7, enrichFailures24h: 12, untappdSearchHealthy: true };
  const text = buildStatusMessage(m, '2026-06-28 10:00');
  expect(text).toContain('Enrich: +7 зматчено / 12 провалів за 24 год · пошук ✅');
});

it('shows ⚠️ when search is unhealthy', () => {
  const base = { /* ... */ } as StatusMetrics;
  const text = buildStatusMessage({ ...base, enrichMatched24h: 0, enrichFailures24h: 0, untappdSearchHealthy: false }, '2026-06-28 10:00');
  expect(text).toContain('пошук ⚠️');
});
```

(Build `base` from an existing fixture in the test file if present, to avoid listing every field.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/daily-status.test.ts -t enrich`
Expected: FAIL — line not present.

- [ ] **Step 3: Implement** — add to the array in `buildStatusMessage`, right after the `Рейтинги` line:

```ts
    `• Enrich: +${group(m.enrichMatched24h)} зматчено / ${group(m.enrichFailures24h)} провалів за 24 год · пошук ${m.untappdSearchHealthy ? '✅' : '⚠️'}`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/jobs/daily-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(status): enrich health line in daily digest"
```

---

### Task 11: Env keys + wire `createAlgoliaSearch` into the cron

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add optional env keys (with defaults applied in index.ts)**

In `src/config/env.ts` Schema add:
```ts
  UNTAPPD_ALGOLIA_APP_ID: z.string().optional(),
  UNTAPPD_ALGOLIA_SEARCH_KEY: z.string().optional(),
```
These are public client keys; no `EXPECTED_PROD_KEYS` entry needed (defaults exist in code).

- [ ] **Step 2: env test**

Add to `src/config/env.test.ts`: loading without the keys yields `undefined` for both (does not throw). Run: `npx vitest run src/config/env.test.ts` — expect PASS.

- [ ] **Step 3: Wire the Algolia search client in index.ts**

After `untappdSearchHttp` is created (line ~63), add:
```ts
  const ALGOLIA_DEFAULTS = { appId: '9WBO4RQ3HO', searchKey: '1d347324d67ec472bb7132c66aead485' };
  const algoliaSearch = createAlgoliaSearch({
    appId: env.UNTAPPD_ALGOLIA_APP_ID ?? ALGOLIA_DEFAULTS.appId,
    searchKey: env.UNTAPPD_ALGOLIA_SEARCH_KEY ?? ALGOLIA_DEFAULTS.searchKey,
    proxyUrl: env.WEBSHARE_PROXY,
    refreshKeys: async () => {
      // Pull fresh keys from the live search page (via the cookie-less proxied client).
      const html = await untappdSearchHttp.get(buildSearchUrl('beer'));
      return extractAlgoliaKeys(html);
    },
  });
```
Add imports:
```ts
import { createAlgoliaSearch, extractAlgoliaKeys } from './sources/untappd/algolia';
import { buildSearchUrl } from './sources/untappd/search';
```

Update the `enrichOrphans({...})` cron call (line ~154): replace `http: untappdSearchHttp` with `search: algoliaSearch,` and add `notifyAdmin,`:
```ts
      enrichOrphans({
        db, log, search: algoliaSearch,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        breaker: untappdBreaker,
        notifyAdmin,
      }).catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
```

Leave `refresh-tap-ratings` and `refresh-untappd` untouched — they keep `http: untappdSearchHttp`/`untappdHttp` (profile/rating HTML scrape, unaffected).

- [ ] **Step 4: Full typecheck + test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS across the suite.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts src/index.ts
git commit -m "feat(untappd): wire Algolia search into enrich-orphans cron + env keys"
```

---

### Task 12: Sync `spec.md`

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Update the relevant sections** (single source of truth, per CLAUDE.md)

Make these edits in `spec.md`:
1. Architecture tree (`search.ts` line ~92): change comment to `пошук пива через Algolia API (індекс beer)`.
2. Enrich-lookup section (~631+): state the search query (`cleanSearchQuery`) is sent to the Algolia `beer` index, not fetched as HTML; mention proxy-fallback and key auto-refresh.
3. Add a short subsection "Джерело Algolia": appId/searchKey (public client keys, env-overridable defaults), index `beer`, response classification (200+hits / 200+empty=not_found / 401-403=blocked / 5xx=transient), canary heartbeat (`Guinness Draught`) aborting the run + alert + breaker, key auto-refresh on 403.
4. `enrich_failures.search_url` (§3.13, line ~339): clarify it is now a human-readable debug URL built by `buildSearchUrl`; the actual fetch is the Algolia API.
5. Client-relay section (~702): note it relays HTML through `htmlSearch` (Phase 1 no-op since the relayed page is the empty Algolia shell); real Algolia-JSON relay is Phase 2.
6. daily-status / metrics: document the new `enrichMatched24h`/`enrichFailures24h`/`untappdSearchHealthy` and the digest "Enrich" line.

- [ ] **Step 2: Sanity check** there are no remaining references to scraping `.beer-item` for search in spec.md.

Run: `grep -n "beer-item\|parseSearchPage" spec.md` — expected: no matches tied to the search path (matcher/other mentions, if any, are fine).

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): Untappd search now via Algolia API (Phase 1)"
```

---

## Verification (after all tasks)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx vitest run` — all green.
- [ ] Manual smoke (optional, from the worktree, needs prod env): re-run the probe shape against the live Algolia API for the Pinta case and confirm `candidates > 0`.
- [ ] PR + AI review loop (per project workflow): open PR, wait for the AI review, read and assess comments, fix valid ones / push back on wrong ones. Do not consider done at green tests.
