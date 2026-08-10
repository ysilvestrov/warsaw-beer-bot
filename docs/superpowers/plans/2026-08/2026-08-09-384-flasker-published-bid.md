# #384 — Flasker-published Untappd bid as identity: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the Untappd bid that flasker publishes on its product pages as beer identity, so the matcher stops guessing (and sometimes guessing wrong).

**Architecture:** The extension fetches each uncached product's detail page and relays two new optional fields — the JSON-LD brand and the published `bid`/`slug`. The server resolves the bid against its own catalog first (falling back to a batched Algolia hydrate), applies a brewery-agreement guard, and emits a normal `matched` outcome so the existing `applyLookupOutcome` write path does the rest. A `beers.untappd_id_source` column records provenance so a published bid may override a machine-derived link but never a curated or check-in-sourced one.

**Tech Stack:** TypeScript, Node, better-sqlite3, Hono + zod (server); Chrome MV3 content script, JSDOM (extension); Vitest throughout.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-09-384-flasker-published-bid-design.md`

---

## Facts verified live before planning (do not re-derive)

- `objectID === bid`. `POST https://<appId>-dsn.algolia.net/1/indexes/*/objects` with
  `{"requests":[{"indexName":"beer","objectID":"6648348"}]}` returns the full record.
- A batch returns **positionally aligned** `results`, with `null` for unknown or
  malformed objectIDs. Status is 200; nothing throws. No partial-failure handling needed.
- SQLite 3.45 accepts `ALTER TABLE … ADD COLUMN … CHECK (…)` and enforces the CHECK on
  subsequent writes.
- Prod is on `schema_version = 21`.
- Bid coverage 37/45 flasker product pages; JSON-LD brand 45/45; zero duplicate bids.

## File structure

| File | Responsibility |
|---|---|
| `src/storage/schema.ts` | **modify** — migration v22: add column + backfill |
| `src/storage/beers.ts` | **modify** — `getBeerByUntappdId`, provenance on `upsertBeer`/`recordLookupSuccess` |
| `src/domain/pin-match.ts` | **modify** — stamp `'curated'` |
| `src/api/routes/checkins.ts` | **modify** — stamp `'checkin'` |
| `src/sources/untappd/algolia.ts` | **modify** — `hydrateByBid` |
| `src/domain/bid-identity.ts` | **create** — `resolveByBid` + the guard. The whole trust decision lives here |
| `src/api/routes/enrich.ts` | **modify** — accept `bid`/`bidSlug`, relax the early return, consult `resolveByBid` first |
| `extension/src/sites/types.ts` | **modify** — `Card.bid`, `Card.bidSlug` |
| `extension/src/sites/flasker.ts` | **modify** — `loadCardDetails`, brand + bid parsing |
| `extension/src/content/enrich.ts`, `extension/src/api/client.ts`, `extension/src/api/types.ts` | **modify** — relay the fields |
| `extension/scripts/capture-flasker-product.ts` | **create** — single-product fixture capture |
| `spec.md` | **modify** — document the channel |

---

### Task 1: Migration v22 — provenance column and pin backfill

**Files:**
- Modify: `src/storage/schema.ts:265-270` (append after the v21 entry)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/storage/schema.test.ts`:

```ts
describe('migration v22 — untappd_id_source', () => {
  it('adds the column, enforces the CHECK, and backfills exactly the pinned rows', () => {
    const db = new Database(':memory:');
    migrate(db);

    // Two beers: one pinned via match_links, one not.
    db.prepare(
      `INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
       VALUES (1, 111, 'Pinned', 'B', 'pinned', 'b'), (2, 222, 'Plain', 'B', 'plain', 'b')`,
    ).run();
    db.prepare(
      `INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user)
       VALUES ('ref-1', 1, 1.0, 1), ('ref-2', 2, 0.9, 0)`,
    ).run();

    // Re-run the backfill statement the migration ships, to prove it selects the pin set.
    db.prepare(
      `UPDATE beers SET untappd_id_source = 'curated'
        WHERE id IN (SELECT untappd_beer_id FROM match_links WHERE reviewed_by_user = 1)`,
    ).run();

    const rows = db.prepare('SELECT id, untappd_id_source FROM beers ORDER BY id').all();
    expect(rows).toEqual([
      { id: 1, untappd_id_source: 'curated' },
      { id: 2, untappd_id_source: null },
    ]);

    expect(() =>
      db.prepare('UPDATE beers SET untappd_id_source = ? WHERE id = 2').run('bogus'),
    ).toThrow(/CHECK constraint failed/);
  });

  it('reaches version 22', () => {
    const db = new Database(':memory:');
    migrate(db);
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(22);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run src/storage/schema.test.ts -t 'untappd_id_source'`
Expected: FAIL — `no such column: untappd_id_source`, and the version assertion reports 21.

- [ ] **Step 3: Add the migration**

In `src/storage/schema.ts`, append to `MIGRATIONS` after the `version: 21` entry:

```ts
  {
    version: 22,
    // #384: provenance for beers.untappd_id, so a shop-published bid may override a
    // machine-derived link but never a curated or check-in-sourced one.
    // The backfill is load-bearing, not cosmetic: without it every existing pin
    // reads as NULL = machine-derived = overridable, silently undoing #343.
    // match_links.untappd_beer_id is a LOCAL beers.id, not an Untappd bid.
    sql: `
      ALTER TABLE beers ADD COLUMN untappd_id_source TEXT
        CHECK (untappd_id_source IN ('search','bid','curated','checkin'));
      UPDATE beers SET untappd_id_source = 'curated'
       WHERE id IN (SELECT untappd_beer_id FROM match_links WHERE reviewed_by_user = 1);
    `,
  },
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(#384): migration v22 — beers.untappd_id_source with pin backfill"
```

---

### Task 2: Provenance writers

**Files:**
- Modify: `src/storage/beers.ts:24` (`upsertBeer`), `src/storage/beers.ts:149` (`recordLookupSuccess`)
- Modify: `src/domain/pin-match.ts:38`
- Modify: `src/api/routes/checkins.ts:61`
- Test: `src/storage/beers.test.ts`, `src/domain/pin-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/beers.test.ts`. That file's existing helper is `fresh()`, and it
imports from `vitest` per-symbol — add `describe`/`expect` to its import if absent, and add
`recordLookupSuccess` to the `./beers` import:

```ts
describe('#384 provenance', () => {
  it('recordLookupSuccess stamps search', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: null, name: 'N', brewery: 'B',
      normalized_name: 'n', normalized_brewery: 'b',
    });
    recordLookupSuccess(db, id, { bid: 900, style: null, abv: null, global_rating: null }, '2026-08-09T00:00:00Z');
    const row = db.prepare('SELECT untappd_id, untappd_id_source FROM beers WHERE id = ?').get(id);
    expect(row).toEqual({ untappd_id: 900, untappd_id_source: 'search' });
  });

  it('upsertBeer records the source it is given', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 901, name: 'N', brewery: 'B',
      normalized_name: 'n', normalized_brewery: 'b',
      untappd_id_source: 'checkin',
    });
    const row = db.prepare('SELECT untappd_id_source FROM beers WHERE id = ?').get(id);
    expect(row).toEqual({ untappd_id_source: 'checkin' });
  });

  it('upsertBeer leaves the source alone when not given one', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 902, name: 'N', brewery: 'B',
      normalized_name: 'n', normalized_brewery: 'b',
      untappd_id_source: 'checkin',
    });
    upsertBeer(db, {
      untappd_id: 902, name: 'N2', brewery: 'B',
      normalized_name: 'n2', normalized_brewery: 'b',
    });
    const row = db.prepare('SELECT untappd_id_source FROM beers WHERE id = ?').get(id);
    expect(row).toEqual({ untappd_id_source: 'checkin' });
  });
});
```

Append to `src/domain/pin-match.test.ts`. That file's helper is `newDb()`:

```ts
test('#384: a pin stamps curated so a published bid can never override it', () => {
  const db = newDb();
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Urodzinowe', brewery: 'Recraft',
    normalized_name: 'urodzinowe', normalized_brewery: 'recraft',
  });
  pinMatch(db, id, 6614460, '2026-08-09T00:00:00Z');
  const row = db.prepare('SELECT untappd_id, untappd_id_source FROM beers WHERE id = ?').get(id);
  expect(row).toEqual({ untappd_id: 6614460, untappd_id_source: 'curated' });
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npx vitest run src/storage/beers.test.ts src/domain/pin-match.test.ts -t '384'`
Expected: FAIL — `untappd_id_source` is `null` everywhere; `upsertBeer` rejects the unknown property at compile time.

- [ ] **Step 3: Implement**

In `src/storage/beers.ts`, add to `BeerInput`:

```ts
export type UntappdIdSource = 'search' | 'bid' | 'curated' | 'checkin';

export interface BeerInput {
  untappd_id?: number | null;
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
  /** #384: provenance of untappd_id. Omitted leaves any existing value untouched. */
  untappd_id_source?: UntappdIdSource;
}
```

In `upsertBeer`, change the UPDATE and INSERT to carry it. `COALESCE(?, untappd_id_source)`
is what makes "omitted leaves it alone" true:

```ts
  if (existing) {
    db.prepare(
      `UPDATE beers SET untappd_id = COALESCE(?, untappd_id), name = ?, brewery = ?,
         style = ?, abv = ?, rating_global = ?,
         normalized_name = ?, normalized_brewery = ?,
         untappd_id_source = COALESCE(?, untappd_id_source) WHERE id = ?`,
    ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null,
          b.abv ?? null, b.rating_global ?? null,
          b.normalized_name, b.normalized_brewery,
          b.untappd_id_source ?? null, existing.id);
    bumpCatalogVersion();
    return existing.id;
  }

  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery, untappd_id_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null, b.abv ?? null,
        b.rating_global ?? null, b.normalized_name, b.normalized_brewery,
        b.untappd_id_source ?? null);
```

In `recordLookupSuccess`, add the column to the UPDATE:

```ts
  db.prepare(
    `UPDATE beers SET
       untappd_id = ?,
       untappd_id_source = 'search',
       style = COALESCE(?, style),
       abv = COALESCE(?, abv),
       rating_global = COALESCE(?, rating_global),
       untappd_lookup_at = ?
     WHERE id = ?`,
  ).run(r.bid, r.style, r.abv, r.global_rating, at, beerId);
```

In `src/domain/pin-match.ts`, in the SET branch:

```ts
    db.prepare(`UPDATE beers SET untappd_id = ?, untappd_id_source = 'curated', untappd_lookup_at = ? WHERE id = ?`)
      .run(untappdId, at, beerId);
```

In `src/api/routes/checkins.ts`, add one property to the `upsertBeer` call:

```ts
          normalized_brewery: normalizeBrewery(ci.brewery_name),
          untappd_id_source: 'checkin',
```

- [ ] **Step 4: Run the full server suite**

Run: `npx vitest run`
Expected: PASS, all files. (`recordLookupSuccess` is widely used; a failure here means a
test asserted the exact UPDATE shape and needs its expectation widened, not the code reverted.)

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/domain/pin-match.ts src/domain/pin-match.test.ts src/api/routes/checkins.ts
git commit -m "feat(#384): stamp untappd_id provenance at every writer"
```

---

### Task 3: `hydrateByBid` on the Algolia client

**Files:**
- Modify: `src/sources/untappd/algolia.ts`
- Test: `src/sources/untappd/algolia.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/sources/untappd/algolia.test.ts`:

```ts
describe('hydrateByBid (#384)', () => {
  it('sends one batched objectID request and maps results positionally', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        results: [
          { bid: 6648348, beer_name: 'Tomatøl:BULDAK BULGOGI', brewery_name: 'Mad Brew',
            brewery_alias: ['madbrew'], beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
            type_name: 'Gose', beer_abv: 4.2, rating_score: 4.06 },
          null,
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const search = createAlgoliaSearch({ appId: 'APP', searchKey: 'KEY', fetchImpl, minGapMs: 0 });
    const out = await search.hydrateByBid([6648348, 999999999]);

    expect(captured!.url).toContain('/1/indexes/*/objects');
    expect(captured!.body).toEqual({
      requests: [
        { indexName: 'beer', objectID: '6648348' },
        { indexName: 'beer', objectID: '999999999' },
      ],
    });
    expect(out.get(6648348)).toEqual({
      bid: 6648348,
      beer_name: 'Tomatøl:BULDAK BULGOGI',
      brewery_name: 'Mad Brew',
      brewery_alias: ['madbrew'],
      beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
      style: 'Gose',
      abv: 4.2,
      global_rating: 4.06,
    });
    expect(out.has(999999999)).toBe(false);
  });

  it('returns an empty map for an empty input without calling the network', async () => {
    const fetchImpl = (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch;
    const search = createAlgoliaSearch({ appId: 'APP', searchKey: 'KEY', fetchImpl, minGapMs: 0 });
    expect((await search.hydrateByBid([])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run src/sources/untappd/algolia.test.ts -t 'hydrateByBid'`
Expected: FAIL — `search.hydrateByBid is not a function`.

- [ ] **Step 3: Implement**

In `src/sources/untappd/search.ts`, extend the seam. A hydrated record is a
`SearchResult` plus the two fields only the by-bid path provides:

```ts
export interface HydratedBeer extends SearchResult {
  beer_slug: string | null;
  brewery_alias: string[];
}

export interface BeerSearch {
  search(query: string): Promise<SearchResult[]>;
  /** #384: fetch full records by bid (objectID === bid). Missing bids are absent from the map. */
  hydrateByBid?(bids: number[]): Promise<Map<number, HydratedBeer>>;
}
```

In `src/sources/untappd/algolia.ts`, add the parser and the method:

```ts
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
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
  };
}
```

There is **no** existing recovery wrapper — the key-refresh and proxy-fallback logic is
inlined inside `search()` at `algolia.ts:113-131`. Extract it first so both callers share
one copy. Replace the whole `return { async search … }` block with:

```ts
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
  };
```

Add `rawHydrate` alongside `rawSearch`:

```ts
  async function rawHydrate(bids: number[], useProxy: boolean): Promise<Map<number, HydratedBeer>> {
    const wait = Math.max(0, lastAt + gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const init: RequestInit & { dispatcher?: unknown } = {
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
    const url = `https://${keys.appId}-dsn.algolia.net/1/indexes/*/objects`;
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/sources/untappd/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts src/sources/untappd/search.ts
git commit -m "feat(#384): batched Algolia hydrate-by-bid (objectID === bid)"
```

---

### Task 4: `bid-identity.ts` — resolve and guard

This is where the whole trust decision lives. Keep it pure and dependency-light so the
truth table is cheap to test.

**Files:**
- Create: `src/domain/bid-identity.ts`
- Test: `src/domain/bid-identity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/bid-identity.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { resolveByBid } from './bid-identity';
import type { HydratedBeer } from '../sources/untappd/search';

const BULGOGI: HydratedBeer = {
  bid: 6648348,
  beer_name: 'Tomatøl:BULDAK BULGOGI',
  brewery_name: 'Mad Brew',
  brewery_alias: ['mad brewlads', 'madbrew'],
  beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
  style: 'Sour - Tomato / Vegetable Gose',
  abv: 4.2,
  global_rating: 4.06,
};

function freshDb() {
  const db = openDb(':memory:');   // same helper the other storage tests use
  migrate(db);
  return db;
}
const hydrateWith = (r: HydratedBeer | null) =>
  vi.fn(async (bids: number[]) => new Map(r ? [[r.bid, r]] : []));

describe('resolveByBid', () => {
  it('accepts a bid whose brewery agrees with the shop brand', async () => {
    const hydrate = hydrateWith(BULGOGI);
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348,
      bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew', hydrate,
    });
    expect(out.kind).toBe('accepted');
    if (out.kind !== 'accepted') throw new Error('unreachable');
    expect(out.result.bid).toBe(6648348);
  });

  // The two negative assertions that matter most: both of these divergences are
  // REAL for this product, and vetoing on either would reject the feature's own
  // motivating case. Do not "fix" these into vetoes.
  it('does NOT veto when the shop name diverges from the record name', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'Mad Brew', shopName: 'Tomatol Bulgogi', hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('does NOT veto when the shop ABV diverges from the record ABV', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'Mad Brew', shopAbv: 3.8, hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('does NOT veto on slug divergence (logged only)', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'something-else', brand: 'Mad Brew',
      hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('vetoes when the brand names a different brewery', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'Browar Stu Mostów', hydrate: hydrateWith(BULGOGI),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'brewery-mismatch' });
  });

  it('accepts on a brewery ALIAS match', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'MadBrew', hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('skips the guard when the shop publishes no brand', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      hydrate: hydrateWith(BULGOGI),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'no-brand-to-verify' });
  });

  it('rejects when the bid hydrates to nothing', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 999999999, brand: 'Mad Brew', hydrate: hydrateWith(null),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'not-hydrated' });
  });

  it('rejects rather than throwing when hydration fails', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, brand: 'Mad Brew',
      hydrate: vi.fn(async () => { throw new Error('blocked'); }),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'hydrate-failed' });
  });

  it('resolves from the local catalog without calling Algolia', async () => {
    const db = freshDb();
    upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatøl:BULDAK BULGOGI', brewery: 'Mad Brew',
      style: 'Gose', abv: 4.2, rating_global: 4.06,
      normalized_name: 'tomatol buldak bulgogi', normalized_brewery: 'mad brew',
    });
    const hydrate = vi.fn(async () => new Map());
    const out = await resolveByBid({
      db, bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew', hydrate,
    });
    expect(out.kind).toBe('accepted');
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('still applies the brewery veto on the local path', async () => {
    const db = freshDb();
    upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatøl:BULDAK BULGOGI', brewery: 'Mad Brew',
      normalized_name: 'tomatol buldak bulgogi', normalized_brewery: 'mad brew',
    });
    const out = await resolveByBid({
      db, bid: 6648348, brand: 'Browar Stu Mostów', hydrate: vi.fn(async () => new Map()),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'brewery-mismatch' });
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run src/domain/bid-identity.test.ts`
Expected: FAIL — cannot resolve `./bid-identity`.

- [ ] **Step 3: Implement**

Create `src/domain/bid-identity.ts`:

```ts
import type { DB } from '../storage/db';
import type { HydratedBeer, SearchResult } from '../sources/untappd/search';
import { breweryAliases, breweryAliasesMatch } from './matcher';

export type BidResolution =
  | { kind: 'accepted'; result: SearchResult; source: 'local' | 'hydrated'; notes: string[] }
  | { kind: 'rejected'; reason: BidRejection };

export type BidRejection =
  | 'not-hydrated'
  | 'hydrate-failed'
  | 'brewery-mismatch'
  | 'no-brand-to-verify';

export interface ResolveByBidArgs {
  db: DB;
  bid: number;
  /** Slug the shop published next to the bid. Logged on divergence, never a veto. */
  bidSlug?: string;
  /** JSON-LD brand from the product page. Absent ⇒ nothing to verify against ⇒ reject. */
  brand?: string;
  /** Shop-published name/abv. Divergence is recorded in `notes`, never a veto. */
  shopName?: string;
  shopAbv?: number | null;
  /** Absent when no Algolia client is wired — the local-catalog path still works. */
  hydrate?: (bids: number[]) => Promise<Map<number, HydratedBeer>>;
}

interface Candidate {
  result: SearchResult;
  slug: string | null;
  aliases: string[];
  source: 'local' | 'hydrated';
}

function fromLocal(db: DB, bid: number): Candidate | null {
  const row = db
    .prepare(
      `SELECT untappd_id, name, brewery, style, abv, rating_global
         FROM beers WHERE untappd_id = ?`,
    )
    .get(bid) as
    | { untappd_id: number; name: string; brewery: string; style: string | null; abv: number | null; rating_global: number | null }
    | undefined;
  if (!row) return null;
  return {
    result: {
      bid: row.untappd_id,
      beer_name: row.name,
      brewery_name: row.brewery,
      style: row.style,
      abv: row.abv,
      global_rating: row.rating_global,
    },
    // beer_slug is not stored locally — this is why slug divergence is logged, not vetoed.
    slug: null,
    aliases: [],
    source: 'local',
  };
}

// The ONLY veto. The shop can link someone else's beer; it cannot plausibly link a
// beer by a different brewery than the one it names on the same page.
function breweryAgrees(brand: string, c: Candidate): boolean {
  const shop = breweryAliases(brand);
  const record = [
    ...breweryAliases(c.result.brewery_name),
    ...c.aliases.flatMap((a) => breweryAliases(a)),
  ];
  return breweryAliasesMatch(shop, record);
}

export async function resolveByBid(args: ResolveByBidArgs): Promise<BidResolution> {
  const { db, bid, bidSlug, brand, shopName, shopAbv } = args;

  // 1. Local catalog first: ~34k rows, UNIQUE-indexed, and it keeps working while
  //    Untappd is blocking us.
  let candidate = fromLocal(db, bid);

  // 2. Miss → hydrate. Never throw: a hydrate failure must fall through to the
  //    normal lookup path, not fail the request.
  if (!candidate) {
    if (!args.hydrate) return { kind: 'rejected', reason: 'not-hydrated' };
    let hydrated: HydratedBeer | undefined;
    try {
      hydrated = (await args.hydrate([bid])).get(bid);
    } catch {
      return { kind: 'rejected', reason: 'hydrate-failed' };
    }
    if (!hydrated) return { kind: 'rejected', reason: 'not-hydrated' };
    candidate = {
      result: {
        bid: hydrated.bid,
        beer_name: hydrated.beer_name,
        brewery_name: hydrated.brewery_name,
        style: hydrated.style,
        abv: hydrated.abv,
        global_rating: hydrated.global_rating,
      },
      slug: hydrated.beer_slug,
      aliases: hydrated.brewery_alias,
      source: 'hydrated',
    };
  }

  // 3. Guard.
  if (!brand) return { kind: 'rejected', reason: 'no-brand-to-verify' };
  if (!breweryAgrees(brand, candidate)) return { kind: 'rejected', reason: 'brewery-mismatch' };

  // Divergences worth seeing in logs, deliberately NOT vetoes — every one of these is
  // real for Tomatol Bulgogi, the case this feature exists to fix.
  const notes: string[] = [];
  if (bidSlug && candidate.slug && bidSlug !== candidate.slug) notes.push('slug-divergence');
  if (shopName && shopName !== candidate.result.beer_name) notes.push('name-divergence');
  if (shopAbv != null && candidate.result.abv != null && shopAbv !== candidate.result.abv) {
    notes.push('abv-divergence');
  }

  return { kind: 'accepted', result: candidate.result, source: candidate.source, notes };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/domain/bid-identity.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/bid-identity.ts src/domain/bid-identity.test.ts
git commit -m "feat(#384): resolveByBid — local-first identity with a brewery-only veto"
```

---

### Task 5: Wire the bid into `/enrich/result`

`ApiDeps` currently has **no** Algolia client — only `db`, `env`, `log`, `webFallback`
(`src/api/types.ts:6-12`). The relayed `algolia` payload is what feeds the normal path.
So this task also wires a server-side hydrate function into `ApiDeps`.

**Files:**
- Modify: `src/api/types.ts` — add `hydrateByBid` to `ApiDeps`
- Modify: `src/index.ts:322` — pass it from the existing `algoliaSearch`
- Modify: `src/api/routes/enrich.ts` — `ResultBody` (~line 55), the early return (line 144), the lookup call (line 152)
- Test: `src/api/routes/enrich.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/api/routes/enrich.test.ts`. That file already provides `setup(depsOverride?)`
and `post(app, path, body)` — use them; there is no auth middleware in the test app, so no
Authorization header is needed.

```ts
const HYDRATE_BULGOGI = async () => new Map([[6648348, {
  bid: 6648348, beer_name: 'Tomatøl:BULDAK BULGOGI', brewery_name: 'Mad Brew',
  brewery_alias: ['madbrew'], beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
  style: 'Gose', abv: 4.2, global_rating: 4.06,
}]]);

describe('#384 published bid', () => {
  it('overrides a machine-derived link and merges into the canonical row', async () => {
    const { app, db } = setup({ hydrateByBid: HYDRATE_BULGOGI });
    // The canonical row, as created by the check-ins sync.
    const canonical = upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatøl:BULDAK BULGOGI', brewery: 'Mad Brew',
      normalized_name: 'tomatol buldak bulgogi', normalized_brewery: 'mad brew',
    });
    // The shop-identity row, wrongly matched by search.
    const shopRow = upsertBeer(db, {
      untappd_id: 6708599, name: 'Tomatol Bulgogi', brewery: 'Mad Brew',
      normalized_name: 'tomatol bulgogi', normalized_brewery: 'mad brew',
      untappd_id_source: 'search',
    });

    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi', abv: 3.8,
      bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew',
      algolia: { hits: [] },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6648348 });
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(shopRow)).toBeUndefined();
    expect(db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(canonical))
      .toEqual({ untappd_id: 6648348 });
  });

  it.each(['curated', 'checkin'] as const)('refuses to override a %s link', async (source) => {
    const { app, db } = setup({ hydrateByBid: HYDRATE_BULGOGI });
    const protectedRow = upsertBeer(db, {
      untappd_id: 6708599, name: 'Tomatol Bulgogi', brewery: 'Mad Brew',
      normalized_name: 'tomatol bulgogi', normalized_brewery: 'mad brew',
      untappd_id_source: source,
    });
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Mad Brew', algolia: { hits: [] },
    });
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6708599 });
    expect(db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(protectedRow))
      .toEqual({ untappd_id: 6708599 });
  });

  // Regression guard for the relaxed early return.
  it('is unchanged for a client that sends no bid', async () => {
    const { app, db } = setup({ hydrateByBid: HYDRATE_BULGOGI });
    const row = upsertBeer(db, {
      untappd_id: 6708599, name: 'Tomatol Bulgogi', brewery: 'Mad Brew',
      normalized_name: 'tomatol bulgogi', normalized_brewery: 'mad brew',
      untappd_id_source: 'search',
    });
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi', algolia: { hits: [] },
    });
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6708599 });
    expect(db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(row))
      .toEqual({ untappd_id: 6708599 });
  });

  // The spec claims search cannot clobber a bid-sourced link "by construction",
  // because the early return fires for any request that carries no bid. Assert it
  // rather than trusting the prose.
  it('a later search cannot clobber a bid-sourced link', async () => {
    const { app, db } = setup({ hydrateByBid: HYDRATE_BULGOGI });
    const row = upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatol Bulgogi', brewery: 'Mad Brew',
      normalized_name: 'tomatol bulgogi', normalized_brewery: 'mad brew',
      untappd_id_source: 'bid',
    });
    // A relay carrying search candidates but no bid — the pre-0.14 shape.
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      algolia: { hits: [{ bid: 6708599, beer_name: 'Tomatol: Bulgogi Sriracha', brewery_name: 'Mad Brew' }] },
    });
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6648348 });
    expect(db.prepare('SELECT untappd_id, untappd_id_source FROM beers WHERE id = ?').get(row))
      .toEqual({ untappd_id: 6648348, untappd_id_source: 'bid' });
  });

  it('falls through to the normal pipeline when the guard vetoes', async () => {
    const { app, db } = setup({ hydrateByBid: HYDRATE_BULGOGI });
    const orphan = upsertBeer(db, {
      untappd_id: null, name: 'Tomatol Bulgogi', brewery: 'Browar Stu Mostów',
      normalized_name: 'tomatol bulgogi', normalized_brewery: 'stu mostow',
    });
    const res = await post(app, '/enrich/result', {
      brewery: 'Browar Stu Mostów', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Browar Stu Mostów', algolia: { hits: [] },
    });
    // Guard vetoes on brewery, normal pipeline finds nothing → orphan, not a wrong link.
    expect(await res.json()).toMatchObject({ status: 'not_found' });
    expect(db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(orphan))
      .toEqual({ untappd_id: null });
  });
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npx vitest run src/api/routes/enrich.test.ts -t '384'`
Expected: FAIL — the override test returns `untappd_id: 6708599`, because the early return
fires before any bid handling, and `setup` rejects the unknown `hydrateByBid` dep at compile
time. The "no bid" and "curated/checkin" cases already pass; keep them, they are the
regression guards proving this change is inert for pre-0.14 clients.

- [ ] **Step 3: Implement**

Extend `ResultBody` in `src/api/routes/enrich.ts`:

```ts
const ResultBody = z.object({
  brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
  name: z.string().max(BEER_TEXT_LIMIT_CHARS),
  abv: z.number().nullable().optional(),
  style: z.string().max(BEER_TEXT_LIMIT_CHARS).nullable().optional(),
  // #384: shop-published Untappd identity. Optional — absent from every client < 0.14.
  bid: z.number().int().positive().optional(),
  bidSlug: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
  brand: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
  html: z.string().max(ENRICH_HTML_LIMIT_CHARS).optional(),
  algolia: z.object({
    hits: z.array(z.record(z.string(), z.unknown())).optional(),
    nbHits: z.number().optional(),
  }).optional(),
  pageUrl: z.string().max(PAGE_URL_LIMIT_CHARS).optional(),
}).refine((v) => typeof v.html === 'string' || v.algolia !== undefined, {
  message: 'html or algolia is required',
});
```

Add the helper above `enrichRoute`:

```ts
// #384: a stored link may be replaced by a shop-published bid only when we put it
// there by guessing. 'curated' is a human decision; 'checkin' is Untappd's own record.
const REFUSES_OVERRIDE = new Set(['curated', 'checkin']);
```

Replace the early return at `enrich.ts:144`:

```ts
    const { brewery, name, abv, style, html, algolia, pageUrl, bid, bidSlug, brand } =
      c.req.valid('json');
    const row = ensureBeerRow(deps.db, brewery, name, {
      abv: abv ?? undefined, style: style ?? undefined,
    });

    // Only orphans need enrichment — EXCEPT when the shop publishes a bid that
    // disagrees with a link we derived ourselves (#384). Without this exception the
    // wrong link is unreachable and can never be repaired.
    const stored = row.untappd_id;
    const mayOverride =
      bid !== undefined &&
      stored !== bid &&
      !REFUSES_OVERRIDE.has(row.untappd_id_source ?? '');
    if (stored != null && !mayOverride) {
      return c.json({ status: 'matched', untappd_id: stored, rating_global: row.rating_global });
    }
```

Then, immediately before building `search`, try the bid:

```ts
    const nowIso = new Date().toISOString();

    if (bid !== undefined) {
      const resolved = await resolveByBid({
        db: deps.db, bid, bidSlug, brand,
        shopName: name, shopAbv: abv ?? null,
        hydrate: deps.hydrateByBid,
      });
      if (resolved.kind === 'accepted') {
        deps.log.info(
          { beerId: row.id, bid, source: resolved.source, notes: resolved.notes, replaced: stored },
          'enrich: identity from shop-published bid',
        );
        const kind = applyLookupOutcome(
          { db: deps.db, log: deps.log }, row.id,
          { kind: 'matched', result: resolved.result }, nowIso,
          { brewery, name, sourceUrl: pageUrl },
        );
        deps.db.prepare(`UPDATE beers SET untappd_id_source = 'bid' WHERE untappd_id = ?`).run(bid);
        if (kind === 'matched' || kind === 'merged') {
          return c.json({
            status: 'matched',
            untappd_id: resolved.result.bid,
            rating_global: resolved.result.global_rating,
          });
        }
      } else {
        deps.log.info({ beerId: row.id, bid, reason: resolved.reason }, 'enrich: bid rejected');
      }
      // Any rejection falls through to the normal pipeline below — never worse than today.
    }
```

Leave the existing `search` / `lookupWithFallback` block untouched below this, but reuse
the `nowIso` now declared above it rather than re-declaring it.

Add the import:

```ts
import { resolveByBid } from '../../domain/bid-identity';
```

Wire the dependency. In `src/api/types.ts`:

```ts
import type { HydratedBeer, SearchResult } from '../sources/untappd/search';

export interface ApiDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
  webFallback?: ((beerId: number) => Promise<SearchResult | null>) | null;
  /** #384: server-side Algolia hydrate-by-bid. Absent ⇒ bid resolution is local-only. */
  hydrateByBid?: (bids: number[]) => Promise<Map<number, HydratedBeer>>;
}
```

In `src/index.ts:322`, pass it from the `algoliaSearch` already constructed at line 90:

```ts
  const apiApp = createApiApp({
    db, env, log, webFallback,
    hydrateByBid: (bids) => algoliaSearch.hydrateByBid!(bids),
  });
```

And in the route, use `deps.hydrateByBid` (optional — `resolveByBid` handles its absence
by staying local-only), not a non-null assertion:

```ts
        hydrate: deps.hydrateByBid,
```

`ensureBeerRow` must now return `untappd_id_source`; add it to the `SELECT` behind
`getBeer` in `src/storage/beers.ts` if it is not already `SELECT *`, and add the field to
`BeerRow`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/api/routes/enrich.test.ts && npx vitest run`
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts src/storage/beers.ts
git commit -m "feat(#384): consult the published bid before the search pipeline"
```

---

### Task 6: Capture a flasker product-page fixture

The registry-driven `npm run capture` models listing pages only. Single-product captures
have their own precedent (`capture-omb-abv-fixture.ts`).

**Files:**
- Create: `extension/scripts/capture-flasker-product.ts`
- Create: `extension/tests/fixtures/flasker.product.html` (generated)

- [ ] **Step 1: Write the capture script**

Create `extension/scripts/capture-flasker-product.ts`:

```ts
// Captures ONE flasker product page as a fixture for the #384 detail-fetch tests.
// Usage: npx tsx scripts/capture-flasker-product.ts <slug> [outfile]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const slug = process.argv[2] ?? 'tomatol-bulgogi-3-8-330мл';
const out = process.argv[3] ?? 'tests/fixtures/flasker.product.html';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`https://flasker.com.ua/product/${encodeURIComponent(slug)}/`, {
    waitUntil: 'domcontentloaded',
  });
  const html = await page.content();
  await browser.close();

  // Same spirit as the block-page guard in capture-fixture.ts: refuse to write a
  // Cloudflare challenge over a good fixture.
  if (!/untappd\.com\/b\//.test(html) && !/"@type":"Brand"/.test(html)) {
    throw new Error(`capture looks wrong (${html.length} bytes, no bid and no brand) — refusing to write`);
  }
  writeFileSync(out, html);
  console.log(`wrote ${out} (${html.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `cd extension && npx tsx scripts/capture-flasker-product.ts`
Expected: `wrote tests/fixtures/flasker.product.html (~150000 bytes)`

- [ ] **Step 3: Verify the fixture carries both signals**

Run: `grep -c 'untappd.com/b/mad-brew-tomatol-buldak-bulgogi/6648348' tests/fixtures/flasker.product.html && grep -c '"@type":"Brand"' tests/fixtures/flasker.product.html`
Expected: both `1` or greater.

- [ ] **Step 4: Commit**

```bash
git add extension/scripts/capture-flasker-product.ts extension/tests/fixtures/flasker.product.html
git commit -m "test(#384): capture a flasker product page fixture"
```

---

### Task 7: `loadCardDetails` on the flasker adapter

**Files:**
- Modify: `extension/src/sites/types.ts` (`Card`)
- Modify: `extension/src/sites/flasker.ts`
- Test: `extension/src/sites/flasker.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/sites/flasker.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { parseProductDetail } from './flasker';

describe('#384 product-detail parsing', () => {
  const html = readFileSync(new URL('../../tests/fixtures/flasker.product.html', import.meta.url), 'utf8');

  it('reads the published bid, its slug, and the JSON-LD brand', () => {
    expect(parseProductDetail(html)).toEqual({
      bid: 6648348,
      bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'Mad Brew',
    });
  });

  it('returns the brand alone when the page publishes no Untappd link', () => {
    expect(parseProductDetail('<script type="application/ld+json">{"brand":{"@type":"Brand","name":"Vibrant Pour"}}</script>'))
      .toEqual({ brand: 'Vibrant Pour' });
  });

  it('returns an empty object for a page with neither signal', () => {
    expect(parseProductDetail('<html><body>nope</body></html>')).toEqual({});
  });

  it('ignores an Untappd link that is not a beer URL', () => {
    expect(parseProductDetail('<a href="https://untappd.com/user/someone">u</a>')).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd extension && npx vitest run src/sites/flasker.test.ts -t '384'`
Expected: FAIL — `parseProductDetail` is not exported.

- [ ] **Step 3: Implement**

In `extension/src/sites/types.ts`, extend `Card`:

```ts
export interface Card {
  el: HTMLElement;
  brewery: string;
  name: string;
  abv?: number;
  style?: string;
  /** #384: Untappd beer id the shop publishes on its product page. */
  bid?: number;
  /** #384: the slug published alongside `bid`; server-side integrity signal. */
  bidSlug?: string;
  skip?: boolean;
}
```

In `extension/src/sites/flasker.ts`, add near the top:

```ts
const MAX_DETAIL_FETCHES_PER_PASS = 20;
const detailUrls = new WeakMap<HTMLElement, string>();
const detailByUrl = new Map<string, Promise<ProductDetail>>();

export interface ProductDetail {
  bid?: number;
  bidSlug?: string;
  brand?: string;
}

const UNTAPPD_BEER_RE = /untappd\.com\/b\/([a-z0-9-]+)\/(\d+)/i;
const LD_BRAND_RE = /"brand"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]{1,80})"/;

// Pure string parsing so it is testable against a captured fixture without a DOM.
export function parseProductDetail(html: string): ProductDetail {
  const out: ProductDetail = {};
  const link = html.match(UNTAPPD_BEER_RE);
  if (link) {
    const bid = parseInt(link[2], 10);
    if (Number.isFinite(bid) && bid > 0) {
      out.bid = bid;
      out.bidSlug = link[1].toLowerCase();
    }
  }
  const brand = html.match(LD_BRAND_RE);
  // WooCommerce emits JSON-LD with \uXXXX escapes for Cyrillic brands.
  if (brand) out.brand = JSON.parse(`"${brand[1]}"`);
  return out;
}

async function loadDetail(url: string): Promise<ProductDetail> {
  const cached = detailByUrl.get(url);
  if (cached) return cached;
  const p = (async () => {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return {};
      return parseProductDetail(await res.text());
    } catch {
      return {};  // a failed detail fetch must never be worse than not fetching
    }
  })();
  detailByUrl.set(url, p);
  return p;
}
```

Record the URL for each card in `parseCards`, just before `cards.push`:

```ts
      if (e.productUrl) detailUrls.set(e.el, e.productUrl);
      cards.push({ el: e.el, ...parsed });
```

Add the hook to the adapter object, after `parseCards`:

```ts
  async loadCardDetails(cards) {
    const limited = cards
      .filter((card) => detailUrls.has(card.el))
      .slice(0, MAX_DETAIL_FETCHES_PER_PASS);

    await Promise.all(limited.map(async (card) => {
      const url = detailUrls.get(card.el);
      if (!url) return;
      const detail = await loadDetail(url);
      // The JSON-LD brand has 100% coverage and beats every heuristic in this file.
      if (detail.brand) card.brewery = detail.brand;
      if (detail.bid !== undefined) {
        card.bid = detail.bid;
        card.bidSlug = detail.bidSlug;
      }
    }));
  },
```

- [ ] **Step 4: Run the tests**

Run: `cd extension && npx vitest run`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts extension/src/sites/types.ts
git commit -m "feat(#384): flasker detail fetch — JSON-LD brand and published bid"
```

---

### Task 8: Relay the bid through the enrich payload

**Files:**
- Modify: `extension/src/api/types.ts`, `extension/src/api/client.ts:73-98`, `extension/src/content/enrich.ts`
- Test: `extension/src/api/client.test.ts`, `extension/src/content/enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/api/client.test.ts`:

```ts
it('#384: forwards bid, bidSlug and brand on /enrich/result', async () => {
  let body: unknown;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ status: 'matched', untappd_id: 6648348 }), { status: 200 });
  }) as unknown as typeof fetch;

  await postEnrichResult('https://api', 'tok', {
    brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
    algolia: { hits: [] },
    bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew',
  });

  expect(body).toMatchObject({
    bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew',
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd extension && npx vitest run src/api/client.test.ts -t '384'`
Expected: FAIL — TypeScript rejects the unknown properties on the payload type.

- [ ] **Step 3: Implement**

In `extension/src/api/client.ts`, widen the `postEnrichResult` payload type:

```ts
  payload: {
    brewery: string;
    name: string;
    algolia: AlgoliaResponse;
    abv?: number;
    style?: string;
    pageUrl?: string;
    /** #384: shop-published Untappd identity. */
    bid?: number;
    bidSlug?: string;
    brand?: string;
  },
```

In `extension/src/content/enrich.ts`, carry the fields on `OrphanFacts` and through
`orphanFacts` so they reach `submitResult`:

```ts
export interface OrphanFacts {
  abv?: number;
  style?: string;
  bid?: number;
  bidSlug?: string;
  brand?: string;
}
```

```ts
function orphanFacts(o: { abv?: number; style?: string; bid?: number; bidSlug?: string; brewery: string }): OrphanFacts {
  const abv = usableAbv(o.abv);
  return {
    ...(abv !== undefined ? { abv } : {}),
    ...(o.style !== undefined ? { style: o.style } : {}),
    ...(o.bid !== undefined ? { bid: o.bid, bidSlug: o.bidSlug } : {}),
    // The brewery on the card is already the JSON-LD brand when the detail fetch ran.
    ...(o.bid !== undefined ? { brand: o.brewery } : {}),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd extension && npx vitest run && npx tsc --noEmit`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add extension/src/api/client.ts extension/src/api/types.ts extension/src/api/client.test.ts extension/src/content/enrich.ts extension/src/content/enrich.test.ts
git commit -m "feat(#384): relay the published bid to /enrich/result"
```

---

### Task 9: Documentation

**Files:**
- Modify: `spec.md` (flasker adapter paragraph ~line 1635; enrichment section)

- [ ] **Step 1: Update `spec.md`**

In the flasker adapter paragraph, after the family-slug sentence, add:

```
  detail-fetch (#384): для кожної uncached картки адаптер тягне сторінку товару
  (ліміт 20 на прохід, дедуп за URL) і читає два сигнали — JSON-LD `brand`
  (покриття 45/45, перекриває будь-яку евристику броварні вище) та опублікований
  `untappd.com/b/<slug>/<bid>` (покриття 37/45), який їде на `/enrich/result` як
  `bid`/`bidSlug`/`brand`;
```

In the enrichment section, document the channel:

```
Опублікований bid (#384): якщо магазин сам публікує Untappd-ідентичність,
`/enrich/result` розв'язує її ДО пошукового пайплайну — спершу локальний каталог
(`beers.untappd_id`, UNIQUE-індекс, без звернень до Algolia), інакше батчевий
Algolia-hydrate за objectID. Єдине вето — збіг броварні (brand ⟷
`brewery_name`/`brewery_alias`); розбіжність назви, ABV чи slug лише логується,
бо для Tomatol Bulgogi всі три розбігаються, а bid при цьому правильний.
Провенанс лінка живе в `beers.untappd_id_source` (v22): опублікований bid
перекриває `search`/NULL, але ніколи `curated` чи `checkin`.
```

- [ ] **Step 2: Commit**

```bash
git add spec.md
git commit -m "docs(#384): document the published-bid identity channel"
```

---

### Task 10: Rollout (ops — run in the primary checkout on `main`, after merge)

Not code. Do not run any of this before the PR is merged.

- [ ] **Step 1: Back up prod before the migration**

`migrate()` runs on service start and `deploy.sh` has no backup hook, so the snapshot must
be taken first. Litestream replicates to R2 continuously, but restoring needs R2 access
plus a restore step.

```bash
sudo -u warsaw-beer-bot bash -lc "sqlite3 /var/lib/warsaw-beer-bot/bot.db \"VACUUM INTO '/var/lib/warsaw-beer-bot/bot.db.pre-v22'\""
sudo -u warsaw-beer-bot bash -lc "sqlite3 /var/lib/warsaw-beer-bot/bot.db.pre-v22 'PRAGMA integrity_check;'"
ls -la /var/lib/warsaw-beer-bot/bot.db.pre-v22
```

Expected: `ok`, and a file within a few MB of the live DB.

- [ ] **Step 2: Record the pin count the backfill must reproduce**

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT COUNT(DISTINCT untappd_beer_id) FROM match_links WHERE reviewed_by_user = 1;"
```

- [ ] **Step 3: Deploy**

```bash
./deploy/deploy.sh
```

Requires `dangerouslyDisableSandbox`. The server half is a no-op in production until a
client sends a bid, and no released client does.

- [ ] **Step 4: Verify the migration and the backfill**

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' "SELECT MAX(version) FROM schema_version;"
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT untappd_id_source, COUNT(*) FROM beers GROUP BY untappd_id_source;"
```

Expected: `22`, and the `curated` count equals Step 2's number.

- [ ] **Step 5: Verify the acceptance test by direct POST**

Do not wait for the store release.

Hit the local listener directly (`API_PORT` defaults to 3000; confirm with
`grep API_PORT /etc/warsaw-beer-bot/.env`) so the tunnel is not in the picture. The token
is `ADMIN_API_TOKEN` from the same file — read it as the bot user rather than pasting it:

```bash
sudo -u warsaw-beer-bot bash -lc '
  set -a; . /etc/warsaw-beer-bot/.env; set +a
  curl -sS -X POST "http://127.0.0.1:${API_PORT:-3000}/enrich/result" \
    -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
    -d "{\"brewery\":\"Mad Brew\",\"name\":\"Tomatol Bulgogi\",\"abv\":3.8,
         \"bid\":6648348,\"bidSlug\":\"mad-brew-tomatol-buldak-bulgogi\",
         \"brand\":\"Mad Brew\",\"algolia\":{\"hits\":[]}}"
'
```

Expected: `{"status":"matched","untappd_id":6648348,…}`.

Then confirm the wrong row is gone and did not regenerate:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT id, brewery, name, untappd_id, untappd_id_source FROM beers WHERE untappd_id IN (6648348, 6708599);"
```

Expected: `6648348` present; **no row carries `6708599`** for `Tomatol Bulgogi`.

- [ ] **Step 6: Remove the backup once satisfied**

Only after Step 5 passes.

```bash
sudo -u warsaw-beer-bot bash -lc "rm -f /var/lib/warsaw-beer-bot/bot.db.pre-v22"
```

---

## Notes for the implementer

- **Do not turn the logged divergences into vetoes.** Name, ABV and slug all diverge for
  Tomatol Bulgogi, and the bid is still correct. That is the entire point of the feature.
  Task 4's tests assert this; if one starts failing, the test is right and the change is wrong.
- **A fresh listing capture breaks other tests.** Shops rotate stock. Task 6 captures a
  *product* page to a new fixture and touches no listing fixture — keep it that way.
- **`match_links.untappd_beer_id` is a local `beers.id`**, not an Untappd bid. The Task 1
  backfill depends on this.
- **`/match` is out of scope.** The corrected badge appears on the next page view.
- Users see nothing until 0.14 is cut and passes store review.
