# Brave web-resolver swap (#139) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the permanently unavailable Google CSE provider behind the existing `WebResolver` seam with Brave Search, and rename the surrounding code provider-neutral.

**Architecture:** The #139 fallback (gate, cooldown, quota, call sites, `lookupWithFallback`) is provider-independent and does not change. Only the resolver implementation, the identifiers naming it, and the spend guard's calibration change. Brave returns the same `"<Beer> - <Brewery> - Untappd"` titles and `/b/<slug>/<bid>` URLs as CSE, so the parsing helpers transfer unchanged; Brave supplies **no ABV**, so `hydrateAbv` (already implemented, Algolia-by-name) becomes the sole ABV source.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Vitest, zod (env), Brave Search API (`api.search.brave.com`, key auth via `X-Subscription-Token`).

**Spec:** `docs/superpowers/specs/2026-07/2026-07-26-brave-websearch-swap-design.md`

**Ordering rule:** every task ends with a green build. Renames therefore update their callers in the same task. Run `npm test` (vitest) and `npm run typecheck` before each commit.

---

### Task 1: Replace `pacificDay` with `utcDay`

The Pacific day existed only because Google reset its quota at midnight PT. Brave bills monthly credits, so our day bucket is now a self-imposed spend guard and UTC is the natural key.

**Files:**
- Create: `src/domain/utc-day.ts`
- Create: `src/domain/utc-day.test.ts`
- Delete: `src/domain/pacific-day.ts`, `src/domain/pacific-day.test.ts`
- Modify: `src/domain/google-fallback.ts` (import + call site, lines 6 and 118)

- [ ] **Step 1: Write the failing test**

Create `src/domain/utc-day.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { utcDay } from './utc-day';

describe('utcDay', () => {
  it('formats a date as a UTC YYYY-MM-DD key', () => {
    expect(utcDay(new Date('2026-07-26T12:34:56Z'))).toBe('2026-07-26');
  });

  it('does not shift the day for late-evening UTC instants', () => {
    // 23:59 UTC is still the same UTC day (a Pacific-keyed formatter would
    // have reported the previous day here).
    expect(utcDay(new Date('2026-07-26T23:59:59Z'))).toBe('2026-07-26');
  });

  it('rolls over exactly at UTC midnight', () => {
    expect(utcDay(new Date('2026-07-27T00:00:00Z'))).toBe('2026-07-27');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/utc-day.test.ts`
Expected: FAIL — cannot resolve `./utc-day`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/utc-day.ts`:

```ts
// The web-search quota bucket is a self-imposed spend guard (Brave bills
// monthly credits, it does not reset a daily quota), so the day key is plain
// UTC. A daily cap bounds any rolling 31-day window, which is what protects the
// monthly credit budget regardless of when Brave's cycle resets.
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/utc-day.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Switch the single caller and delete the old module**

In `src/domain/google-fallback.ts` replace the import on line 6:

```ts
import { utcDay } from './utc-day';
```

and the call inside `runGoogleFallback` (line 118):

```ts
  if (!tryConsumeGoogleQuota(deps.db, utcDay(now), deps.cap)) return null;
```

Then delete both old files:

```bash
git rm src/domain/pacific-day.ts src/domain/pacific-day.test.ts
```

- [ ] **Step 6: Verify the whole suite is green**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (the `google-fallback` suite still passes — it injects `now`, and the quota key is an implementation detail).

- [ ] **Step 7: Commit**

```bash
git add src/domain/utc-day.ts src/domain/utc-day.test.ts src/domain/google-fallback.ts
git commit -m "refactor(#139): key the web-search quota bucket by UTC day"
```

---

### Task 2: Storage rename — migration v20, `web_search_quota`, `web_tried_at`

Both objects are **empty in production** (verified 2026-07-26: `google_quota` 0 rows, 0 beers with a non-null `google_tried_at`), so the rename moves no data.

**Files:**
- Modify: `src/storage/schema.ts` (append migration v20 after the v19 entry, around line 256)
- Create: `src/storage/web_search_quota.ts`
- Create: `src/storage/web_search_quota.test.ts`
- Delete: `src/storage/google_quota.ts`, `src/storage/google_quota.test.ts`
- Modify: `src/storage/beers.ts` (row type line 21, functions lines 282-291)
- Modify: `src/storage/schema.test.ts` (the `v19 creates google_quota …` test)
- Modify: `src/domain/google-fallback.ts` (imports lines 4-5 and their call sites)

- [ ] **Step 1: Write the failing migration test**

In `src/storage/schema.test.ts`, replace the existing `it('v19 creates google_quota and adds beers.google_tried_at', …)` test with:

```ts
  it('v20 renames the quota table and the per-beer stamp to provider-neutral names', () => {
    const db = openDb(':memory:');
    migrate(db);

    const cols = (db.prepare(`PRAGMA table_info(beers)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('web_tried_at');
    expect(cols).not.toContain('google_tried_at');

    const quotaCols = (db.prepare(`PRAGMA table_info(web_search_quota)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(quotaCols).toEqual(['day', 'count']);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).not.toContain('google_quota');

    const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(version).toBeGreaterThanOrEqual(20);
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: FAIL — `web_tried_at` missing, `PRAGMA table_info(web_search_quota)` returns `[]`.

- [ ] **Step 3: Add migration v20**

In `src/storage/schema.ts`, after the `version: 19` object (ends around line 256) and before the closing `];`:

```ts
  {
    version: 20,
    sql: `
      ALTER TABLE google_quota RENAME TO web_search_quota;
      ALTER TABLE beers RENAME COLUMN google_tried_at TO web_tried_at;
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Move the quota module**

```bash
git mv src/storage/google_quota.ts src/storage/web_search_quota.ts
git mv src/storage/google_quota.test.ts src/storage/web_search_quota.test.ts
```

Rewrite `src/storage/web_search_quota.ts` to:

```ts
import type { DB } from './db';

// Atomically consume one unit of the day's web-search budget. Returns true if a
// unit was available (and was consumed), false if the day is already at `cap`.
// The single UPSERT is atomic: a brand-new day inserts count=1; an existing day
// increments only while count < cap (so the max stored count is exactly `cap`);
// at/over cap the WHERE clause fails and no row changes.
export function tryConsumeWebSearchQuota(db: DB, day: string, cap: number): boolean {
  const info = db
    .prepare(
      `INSERT INTO web_search_quota (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?`,
    )
    .run(day, cap);
  return info.changes > 0;
}
```

In `src/storage/web_search_quota.test.ts` rename the import, the describe title, the three call sites, and the `SELECT count FROM google_quota` assertion:

```ts
import { tryConsumeWebSearchQuota } from './web_search_quota';

describe('tryConsumeWebSearchQuota', () => {
  it('allows exactly `cap` calls per day, then blocks', () => {
    const db = freshDb();
    const day = '2026-07-24';
    let ok = 0;
    for (let i = 0; i < 5; i++) if (tryConsumeWebSearchQuota(db, day, 3)) ok++;
    expect(ok).toBe(3);
    expect(
      (db.prepare('SELECT count FROM web_search_quota WHERE day = ?').get(day) as { count: number }).count,
    ).toBe(3);
    db.close();
  });

  it('tracks each day independently', () => {
    const db = freshDb();
    expect(tryConsumeWebSearchQuota(db, '2026-07-24', 1)).toBe(true);
    expect(tryConsumeWebSearchQuota(db, '2026-07-24', 1)).toBe(false);
    expect(tryConsumeWebSearchQuota(db, '2026-07-25', 1)).toBe(true);
    db.close();
  });
});
```

(Keep the file's existing `freshDb` helper and the `openDb`/`migrate` imports as they are.)

- [ ] **Step 6: Rename the per-beer stamp accessors**

In `src/storage/beers.ts`, line 21 of the row type:

```ts
  web_tried_at: string | null;
```

and lines 282-291:

```ts
export function readWebTriedAt(db: DB, beerId: number): string | null {
  const row = db
    .prepare('SELECT web_tried_at FROM beers WHERE id = ?')
    .get(beerId) as { web_tried_at: string | null } | undefined;
  return row?.web_tried_at ?? null;
}

export function stampWebTried(db: DB, beerId: number, iso: string): void {
  db.prepare('UPDATE beers SET web_tried_at = ? WHERE id = ?').run(iso, beerId);
}
```

- [ ] **Step 7: Update the domain caller**

In `src/domain/google-fallback.ts`, lines 4-5:

```ts
import { readWebTriedAt, stampWebTried } from '../storage/beers';
import { tryConsumeWebSearchQuota } from '../storage/web_search_quota';
```

and the three uses inside `runGoogleFallback`:

```ts
  const triedAt = readWebTriedAt(deps.db, input.beerId);
```

```ts
  if (!tryConsumeWebSearchQuota(deps.db, utcDay(now), deps.cap)) return null;
```

```ts
    stampWebTried(deps.db, input.beerId, now.toISOString());
```

- [ ] **Step 8: Fix any remaining references**

Run: `grep -rn "google_quota\|google_tried_at\|GoogleQuota\|GoogleTried" src/`
Expected: no output. If `src/storage/beers.test.ts` or `src/domain/google-fallback.test.ts` reference the old names, rename them there too (same mechanical substitution).

- [ ] **Step 9: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(#139): provider-neutral storage names + migration v20"
```

---

### Task 3: Brave response parser

**Files:**
- Create: `src/sources/websearch/resolver.ts`
- Create: `src/sources/websearch/resolver.test.ts`
- Create: `src/sources/websearch/__fixtures__/brave-maryensztadt.json`

The old `src/sources/google/resolver.ts` stays untouched in this task (it is still the one wired up); Task 6 deletes it. A temporarily duplicated `ResolvedBeer` type across the two files is expected and lasts one commit.

- [ ] **Step 1: Add the captured fixture**

Create `src/sources/websearch/__fixtures__/brave-maryensztadt.json` — this is real Brave output captured during the 2026-07-26 provider probe, trimmed to the fields the parser reads plus one `description` to document the shape:

```json
{
  "web": {
    "results": [
      {
        "title": "Summertime Śliwka & Pigwa - Maryensztadt - Untappd",
        "url": "https://untappd.com/b/maryensztadt-summertime-sliwka-i-pigwa/5549664",
        "description": "Summertime Śliwka &amp; Pigwa by Maryensztadt is a Sour - Fruited which has a rating of 3.7 out of 5."
      },
      {
        "title": "Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon - Maryensztadt - Untappd",
        "url": "https://untappd.com/b/maryensztadt-barrel-aged-project-ice-imperial-brett-baltic-porter-double-barrel-aged-dry-plum-and-cinnamon/5158585"
      },
      {
        "title": "Gose z mango i marakują - Trzech Kumpli - Untappd",
        "url": "https://untappd.com/b/trzech-kumpli-gose-z-mango-i-marakuja/3809861"
      },
      {
        "title": "Gose | Mango i Marakuja - Trzech Kumpli | Photos - Untappd",
        "url": "https://untappd.com/b/trzech-kumpli-gose-mango-i-marakuja/3809861/photos"
      },
      {
        "title": "Trzech Kumpli Browar Lotny Sklep - Tarnów, Województwo małopolskie - Untappd",
        "url": "https://untappd.com/v/trzech-kumpli-browar-lotny-sklep/12150762"
      },
      {
        "title": "Trzech Kumpli - Tarnów, Województwo małopolskie - Untappd",
        "url": "https://untappd.com/Trzech_Kumpli"
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `src/sources/websearch/resolver.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/sources/websearch/resolver.test.ts`
Expected: FAIL — cannot resolve `./resolver`.

- [ ] **Step 4: Write the implementation**

Create `src/sources/websearch/resolver.ts`:

```ts
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
function bidFromLink(link: unknown): number | null {
  if (typeof link !== 'string') return null;
  const m = link.match(/\/b\/[^/]+\/(\d+)\b/);
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
// ("Trzech Kumpli | Photos"). Keep the first occurrence: Brave ranks the
// canonical page above its sub-pages.
export function parseBraveResponse(json: BraveResponse): ResolvedBeer[] {
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/sources/websearch/resolver.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/sources/websearch
git commit -m "feat(#139): Brave search-response parser with bid dedup"
```

---

### Task 4: `createBraveResolver` — request shape, fail-soft, 1 req/s serialization

Brave Free allows 1 request/second and bills per request against a 1000/month credit budget. `/enrich/result` is driven by extension users and can fire concurrently, and a 429 still consumes a quota unit on our side (we consume before the call), so the resolver spaces its own outbound calls.

**Files:**
- Modify: `src/sources/websearch/resolver.ts` (append)
- Modify: `src/sources/websearch/resolver.test.ts` (append a second describe block)

- [ ] **Step 1: Write the failing tests**

Append to `src/sources/websearch/resolver.test.ts` (and add `vi` to the `vitest` import at the top):

```ts
describe('createBraveResolver', () => {
  function okResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  it('queries Brave with a site-restricted query and the subscription-token header', async () => {
    const fetchImpl = vi.fn(async () => okResponse(brave));
    const resolver = createBraveResolver({ key: 'k-123', fetchImpl: fetchImpl as unknown as typeof fetch });

    const out = await resolver.resolve('Maryensztadt', 'Suszona Śliwka i Cynamon');

    expect(out[1].bid).toBe(5158585);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toContain('https://api.search.brave.com/res/v1/web/search');
    expect(decodeURIComponent(String(url))).toContain('Maryensztadt Suszona Śliwka i Cynamon site:untappd.com');
    expect(decodeURIComponent(String(url))).toContain('count=5');
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('k-123');
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');
  });

  it('returns [] on a non-200 response (429 rate-limit, auth failure, anything)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    const resolver = createBraveResolver({ key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.resolve('Brewery', 'Beer')).resolves.toEqual([]);
  });

  it('returns [] when the network call throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const resolver = createBraveResolver({ key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.resolve('Brewery', 'Beer')).resolves.toEqual([]);
  });

  it('serializes concurrent calls at least minIntervalMs apart', async () => {
    const at: number[] = [];
    const fetchImpl = vi.fn(async () => {
      at.push(Date.now());
      return okResponse({ web: { results: [] } });
    });
    const resolver = createBraveResolver({
      key: 'k',
      minIntervalMs: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([resolver.resolve('A', 'x'), resolver.resolve('B', 'y'), resolver.resolve('C', 'z')]);

    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(55);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sources/websearch/resolver.test.ts`
Expected: FAIL — `createBraveResolver` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/sources/websearch/resolver.ts`:

```ts
export interface BraveResolverOpts {
  key: string;
  count?: number;         // results to request (default 5)
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
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set('q', `${brewery} ${name}`.trim() + ' site:untappd.com');
      url.searchParams.set('count', String(count));
      try {
        const res = await schedule(() =>
          f(url, {
            headers: { Accept: 'application/json', 'X-Subscription-Token': opts.key },
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/websearch/resolver.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/websearch
git commit -m "feat(#139): Brave resolver with fail-soft errors and 1 req/s spacing"
```

---

### Task 5: Env keys — `BRAVE_API_KEY`, `WEB_SEARCH_DAILY_CAP`

Budget: $5 monthly credits ÷ $5.00 per 1000 requests = **1000 requests/month**. A daily cap of 30 bounds any rolling 31-day window at 930, independent of Brave's reset date.

**Files:**
- Modify: `src/config/env.ts` (schema lines 24-26; `EXPECTED_PROD_KEYS` line 52)
- Modify: `src/config/env.test.ts` (append tests)
- Modify: `.env.example`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('loadEnv', …)` block in `src/config/env.test.ts`:

```ts
  it('WEB_SEARCH_DAILY_CAP defaults to 30', () => {
    const env = loadEnv(baseEnv);
    expect(env.WEB_SEARCH_DAILY_CAP).toBe(30);
  });

  it('WEB_SEARCH_DAILY_CAP parses an override', () => {
    const env = loadEnv({ ...baseEnv, WEB_SEARCH_DAILY_CAP: '10' });
    expect(env.WEB_SEARCH_DAILY_CAP).toBe(10);
  });

  it('reports BRAVE_API_KEY as an expected prod key that disables the #139 fallback', () => {
    expect(EXPECTED_PROD_KEYS.map((k) => k.key)).toContain('BRAVE_API_KEY');
    expect(EXPECTED_PROD_KEYS.map((k) => k.key)).not.toContain('GOOGLE_CSE_KEY');
    expect(missingExpectedKeys(loadEnv(baseEnv)).map((k) => k.key)).toContain('BRAVE_API_KEY');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — `WEB_SEARCH_DAILY_CAP` is `undefined`, `BRAVE_API_KEY` absent from `EXPECTED_PROD_KEYS`.

- [ ] **Step 3: Update the schema**

In `src/config/env.ts`, replace lines 24-26:

```ts
  BRAVE_API_KEY: z.string().optional(),
  WEB_SEARCH_DAILY_CAP: z.coerce.number().int().positive().default(30),
```

and replace the `GOOGLE_CSE_KEY` entry in `EXPECTED_PROD_KEYS` (line 52):

```ts
  { key: 'BRAVE_API_KEY', disables: 'Brave web fallback resolver for 0-candidate lookups (#139)' },
```

- [ ] **Step 4: Document the key**

Append to `.env.example`:

```
# Brave Search API key — enables the #139 web fallback resolver for 0-candidate
# Untappd lookups. Absent ⇒ feature disabled (zero behaviour change).
# Free tier: $5 monthly credits at $5.00/1000 requests = 1000 requests/month.
BRAVE_API_KEY=
# Self-imposed daily spend guard; 30/day bounds any 31-day window at 930.
WEB_SEARCH_DAILY_CAP=30
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS.

Note: `npm run typecheck` will now fail in `src/index.ts` (it still reads `env.GOOGLE_CSE_KEY`). Task 6 fixes that — do not chase it here.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts .env.example
git commit -m "feat(#139): BRAVE_API_KEY + WEB_SEARCH_DAILY_CAP env keys"
```

---

### Task 6: Domain rename + wiring swap + delete the dead CSE path

This is the task that flips the running system from CSE to Brave and restores a green typecheck.

**Files:**
- Rename: `src/domain/google-fallback.ts` → `src/domain/web-fallback.ts`
- Rename: `src/domain/google-fallback.test.ts` → `src/domain/web-fallback.test.ts`
- Delete: `src/sources/google/resolver.ts`, `src/sources/google/resolver.test.ts` (whole directory)
- Modify: `src/index.ts` (imports lines 48-49; wiring lines 101-119; call sites lines 245 and 320)
- Modify: `src/jobs/untappd-enrich.ts` (import line 6; deps lines 18-19; call site line 37)
- Modify: `src/api/types.ts` (line 11)
- Modify: any other file that references `googleFallback` (find with grep in Step 5)

- [ ] **Step 1: Move the domain module**

```bash
git mv src/domain/google-fallback.ts src/domain/web-fallback.ts
git mv src/domain/google-fallback.test.ts src/domain/web-fallback.test.ts
git rm -r src/sources/google
```

- [ ] **Step 2: Rename the domain exports**

In `src/domain/web-fallback.ts`:

- update the header comment to `// src/domain/web-fallback.ts`
- change the resolver type import to the new module:

```ts
import type { ResolvedBeer, WebResolver } from '../sources/websearch/resolver';
```

- rename the three exported identifiers, leaving every body unchanged:
  - `gateGoogleCandidate` → `gateWebCandidate`
  - `GoogleFallbackDeps` → `WebFallbackDeps`
  - `runGoogleFallback` → `runWebFallback`
- update the comment above `gateWebCandidate` and `runWebFallback` to say "web fallback" instead of "Google", and the `lookupWithFallback` comment's "invokes the Google fallback" → "invokes the web fallback".
- in `WebFallbackDeps`, keep the `hydrate: BeerSearch` field but update its comment to:

```ts
  hydrate: BeerSearch; // server-side Algolia — the ONLY source of candidate abv (Brave supplies none)
```

- [ ] **Step 3: Update the test file**

In `src/domain/web-fallback.test.ts`, update the import path (`./web-fallback`), the renamed symbols (`gateWebCandidate`, `runWebFallback`), and any `../sources/google/resolver` type import to `../sources/websearch/resolver`. **Do not change any assertion** — the gate logic is unchanged, and the cross-language Maryensztadt case must keep passing exactly as before.

- [ ] **Step 4: Rewire `src/index.ts`**

Replace the imports on lines 48-49:

```ts
import { createBraveResolver } from './sources/websearch/resolver';
import { runWebFallback } from './domain/web-fallback';
```

Replace the wiring block (lines 101-119):

```ts
  // Web 0-candidate fallback (#139). Enabled only when the Brave key is set;
  // otherwise null → lookupWithFallback is a passthrough (zero behaviour change).
  const webFallback: ((beerId: number) => Promise<SearchResult | null>) | null = env.BRAVE_API_KEY
    ? (beerId: number) => {
        const beer = getBeer(db, beerId);
        if (!beer) return Promise.resolve(null);
        return runWebFallback(
          {
            db,
            resolver: createBraveResolver({ key: env.BRAVE_API_KEY! }),
            hydrate: algoliaSearch,
            cap: env.WEB_SEARCH_DAILY_CAP,
            log,
          },
          { beerId, brewery: beer.brewery, name: beer.name, abv: beer.abv ?? null },
        );
      }
    : null;
```

Then update the two consumers: line 245 `db, log, search: algoliaSearch, googleFallback,` → `db, log, search: algoliaSearch, webFallback,` and line 320 `createApiApp({ db, env, log, googleFallback })` → `createApiApp({ db, env, log, webFallback })`.

**Hoisting note:** `createBraveResolver` is called inside the closure, so each fallback invocation builds a fresh resolver — and therefore a fresh 1 req/s gate. That is intentional only if calls cannot overlap. They can (`/enrich/result`), so **hoist the resolver out of the closure**:

```ts
  const braveResolver = env.BRAVE_API_KEY ? createBraveResolver({ key: env.BRAVE_API_KEY }) : null;
  const webFallback: ((beerId: number) => Promise<SearchResult | null>) | null = braveResolver
    ? (beerId: number) => {
        const beer = getBeer(db, beerId);
        if (!beer) return Promise.resolve(null);
        return runWebFallback(
          { db, resolver: braveResolver, hydrate: algoliaSearch, cap: env.WEB_SEARCH_DAILY_CAP, log },
          { beerId, brewery: beer.brewery, name: beer.name, abv: beer.abv ?? null },
        );
      }
    : null;
```

Use this hoisted form — a per-call resolver would defeat the spacing guard.

- [ ] **Step 5: Rename the `googleFallback` dependency everywhere**

Run: `grep -rln "googleFallback" src/`

For each hit, rename the property to `webFallback`:
- `src/jobs/untappd-enrich.ts` — import `lookupWithFallback` from `'../domain/web-fallback'` (line 6), the deps field + its comment (lines 18-19: `// Optional web 0-candidate fallback (null/undefined when unconfigured).`), and the call site (line 37: `deps.webFallback ?? null,`).
- `src/api/types.ts` line 11 — `webFallback?: ((beerId: number) => Promise<SearchResult | null>) | null;`
- any API route or test that destructures it.

- [ ] **Step 6: Verify no stale references remain**

Run: `grep -rn "google\|Google\|CSE\|cse" src/ --include=*.ts`
Expected: no output. (Any remaining hit is a leftover comment or import — fix it.)

- [ ] **Step 7: Verify the build and the full suite**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests pass, `tsc` emits without error.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(#139): swap the web resolver from Google CSE to Brave Search"
```

---

### Task 7: Update `spec.md`

`spec.md` is the OpenSpec source of truth and must match the implementation in the same PR (CLAUDE.md rule).

**Files:**
- Modify: `spec.md` (the `**Google-фолбек на 0 кандидатів (#139)**` section, lines ~802-819)

- [ ] **Step 1: Rewrite the section**

Replace the section heading and body (keep the surrounding sections untouched, keep the Ukrainian voice of the document):

```markdown
**Web-фолбек на 0 кандидатів (#139).** Коли Untappd/Algolia повертає **нуль** кандидатів (справжнє
занулення запиту, а не відхилення реальних кандидатів матчером) — після наявного #271 head-retry —
сервер може резолвити канонічну сторінку пива через **Brave Search API** (запит обмежений
`site:untappd.com`) і перепрогнати цього кандидата через строгий gate. Механізм суто **серверний**
(`lookupWithFallback` обгортає `lookupBeer` у двох точках: cron `enrichOneOrphan` і client-relay
`/enrich/result`), тож браузерне розширення **не змінюється**. Увімкнено лише за наявності
`BRAVE_API_KEY`; без нього — нуль змін поведінки.
- **Gate (refined B1):** strict-збіг пивоварні **обов'язковий завжди**; далі — АБО проходить звичайний
  name-gate (одномовні: переставлені/переспецифіковані назви), АБО є перекриття розрізняльних токенів
  (`hasLongSharedToken`, перевіряється в обох напрямках — fast-fuzzy напрямлений — щоб крос-мовні
  `cynamon`≈`cinnamon` корробурували) **І** ABV у толерансі. ABV сам по собі **ніколи** не достатній
  (інакше пиво тієї ж броварні з іншою назвою хибно лінкувалось би — кейс Artezan «Święty Spokój»).
- **Гідрація ABV:** Brave **не віддає ABV** у відповіді, тож єдине джерело — Algolia-by-name
  (`hydrateAbv`). Наслідок: крос-мовна гілка не спрацьовує для пив, у яких **наш** ABV невідомий.
- **Дедуплікація:** Brave повертає `/photos`-підсторінки з тим самим bid, що й канонічна сторінка →
  парсер лишає перше входження (канонічна сторінка ранжується вище).
- **Захист витрат:** денний cap (`WEB_SEARCH_DAILY_CAP`, дефолт 30) за **UTC-датою**
  (таблиця `web_search_quota(day, count)`, v20), плюс per-beer 30-денний кулдаун
  (`beers.web_tried_at`). Бюджет Brave Free — $5 кредитів на місяць за ціною $5.00/1000 запитів,
  тобто 1000 запитів/місяць; 30/добу обмежує будь-яке 31-денне вікно 930 запитами незалежно від дати
  скидання кредитів. Ліміт 1 req/s дотримується серіалізацією викликів усередині резолвера.
```

- [ ] **Step 2: Verify no stale CSE references remain**

Run: `grep -n "GOOGLE_CSE\|CSE\|google_quota\|google_tried_at" spec.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(#139): spec.md — Brave provider, UTC quota bucket, 30/day cap"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full check**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; entire suite green; build emits.

- [ ] **Step 2: Confirm the feature is inert without a key**

Run: `grep -n "BRAVE_API_KEY" src/index.ts src/config/env.ts`
Expected: the wiring is guarded by `env.BRAVE_API_KEY` and the key is `optional()` in the schema — an unset key yields a null closure and `lookupWithFallback` passes the original outcome through untouched.

- [ ] **Step 3: Confirm the dead provider is gone**

Run: `grep -rn "customsearch\|GOOGLE_CSE\|createGoogleResolver\|parseCseResponse" src/ spec.md`
Expected: no output.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(#139): swap web fallback resolver from Google CSE to Brave Search" --body "<summary + spec link + probe evidence>"
```

Do **not** merge — the user merges PRs. After opening, wait for the AI review and assess its findings critically before reporting done.

---

## Out of scope (follow-up PR, agreed during design)

Full Algolia hydration of the candidate by bid (ABV + style + canonical name), style corroboration as an ABV alternative, and the first-wins ambiguity in same-brewery series (`Risfactor` × 4 on beer 289). Expect few matches from this PR alone; the follow-up is what makes the feature productive.

## Post-merge ops (not part of the code PR)

1. Deploy: `bash deploy/deploy.sh` (migration v20 runs at startup).
2. Add `BRAVE_API_KEY` to `/etc/warsaw-beer-bot/.env`, remove the commented-out `GOOGLE_CSE_*` lines, restart, confirm the startup log no longer reports the feature as disabled.
3. Re-arm the zero-candidate orphan pool (371 rows):

```sql
UPDATE beers SET untappd_lookup_count = 0, untappd_lookup_at = NULL
WHERE untappd_id IS NULL AND id IN (
  SELECT beer_id FROM enrich_failures
  WHERE candidates_count = 0 AND outcome = 'not_found' AND retired_at IS NULL
    AND (review_class IS NULL OR review_class NOT IN ('wontfix', 'not_on_untappd'))
);
```

4. Watch the `enrich-orphans` cron (`30 */3 * * *`, LIMIT 20/run, on-tap orphans only) and the daily count in `web_search_quota` against the 30/day cap.
