# #369 Relay-Path ABV Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry ABV (and style) from the browser extension through `/enrich/candidates` and `/enrich/result` into `beers`, so `lookupBeer` stops matching relay-sourced beers blind — and parse the ABV/style that `onemorebeer` publishes in its hidden technical panel.

**Architecture:** Three independent seams. (1) The `onemorebeer` adapter resolves each tile to its sibling `.one-product-technical-data` panel via `closest('.one-product-list-view')` and reads `Moc (%)` / `Styl`. (2) `content/index.ts` stops dropping `card.abv`, and `abv`/`style` travel through `OrphanBeer` → background messages → `api/client.ts` → both enrich endpoints. (3) `ensureBeerRow` persists them, filling NULL columns on existing orphan rows only, and re-arms the backoff when a row gains an ABV it did not have.

**Tech Stack:** Node.js, TypeScript, Hono + zod (server), better-sqlite3, Vitest (both packages), jsdom (extension tests), Chrome MV3 extension.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-31-369-relay-abv-channel-design.md`

---

## Critical invariant: `0.0%` is a real value

`AleBrowar / Kwas Chlebowy` is ambiguous between `Bright` (0.0%) and `Light` (0.5%); the shop publishes `Moc 0.0%`, which picks `Bright` (bid 5489374) outright. **Any `if (abv)` truthiness check on this path silently discards the value and defeats the entire feature.** Every check must be `!== undefined` or `!= null`. Reviewers: grep the diff for truthiness tests on `abv` before approving.

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `src/storage/beers.ts` | `sanitizeAbv`, `fillOrphanFacts` | modify |
| `src/api/routes/enrich.ts` | zod fields, `ensureBeerRow` facts, wiring | modify |
| `src/api/routes/enrich.test.ts` | server route tests | modify |
| `src/storage/beers.test.ts` | storage unit tests | modify or create |
| `src/domain/untappd-lookup.test.ts` | #322 end-to-end regression | modify |
| `extension/src/sites/types.ts` | `Card.style` | modify |
| `extension/src/sites/onemorebeer.ts` | technical-panel parsing | modify |
| `extension/src/sites/onemorebeer.test.ts` | adapter tests | modify |
| `extension/src/content/index.ts` | stop dropping `abv`, add `style` | modify |
| `extension/src/content/enrich.ts` | `OrphanBeer`, `EnrichDeps` | modify |
| `extension/src/content/main.ts` | orphan → message wiring | modify |
| `extension/src/background/index.ts` | message types, pass-through | modify |
| `extension/src/api/client.ts` | request bodies | modify |
| `extension/package.json`, `extension/CHANGELOG.md` | 0.13.0 release | modify |
| `extension/tests/fixtures/onemorebeer.abv.html` | 0.0% fixture | create (blocked, see Task 10) |

## Commands

- Server tests: `npm test` (repo root) — Vitest.
- Server typecheck: `npm run typecheck`.
- Extension tests: `cd extension && npm test`.
- Single server test: `npx vitest run src/api/routes/enrich.test.ts -t 'name'`.

---

### Task 1: `sanitizeAbv` — the shared bounds rule

**Files:**
- Modify: `src/storage/beers.ts`
- Test: `src/storage/beers.test.ts`

Per spec: the zod shape stays permissive so one rogue card cannot 400 a 200-beer batch; the sanity bound lives in exactly one function.

- [ ] **Step 1: Write the failing test**

Append to `src/storage/beers.test.ts` (create the file with the imports below if it does not exist):

```ts
import { sanitizeAbv } from './beers';

describe('sanitizeAbv', () => {
  it('keeps 0 — 0.0% is a real, load-bearing ABV (#322 Kwas Chlebowy Bright)', () => {
    expect(sanitizeAbv(0)).toBe(0);
  });

  it('keeps ordinary and high-but-real values', () => {
    expect(sanitizeAbv(4.8)).toBe(4.8);
    expect(sanitizeAbv(67.5)).toBe(67.5); // freeze-distilled beers exist
  });

  it('drops undefined, non-finite and out-of-range values', () => {
    expect(sanitizeAbv(undefined)).toBeUndefined();
    expect(sanitizeAbv(NaN)).toBeUndefined();
    expect(sanitizeAbv(Infinity)).toBeUndefined();
    expect(sanitizeAbv(-1)).toBeUndefined();
    expect(sanitizeAbv(101)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/beers.test.ts -t 'sanitizeAbv'`
Expected: FAIL — `sanitizeAbv is not a function` (or a TS resolution error).

- [ ] **Step 3: Write the minimal implementation**

Add to `src/storage/beers.ts`:

```ts
// #369: one place decides whether a relayed ABV is usable. Kept permissive on
// purpose — 0 is a real value (a 0.0% beer), and the upper bound is a garbage
// filter, not a domain limit (freeze-distilled beers reach ~67%).
export function sanitizeAbv(abv: number | undefined): number | undefined {
  if (abv === undefined) return undefined;
  if (!Number.isFinite(abv)) return undefined;
  if (abv < 0 || abv > 100) return undefined;
  return abv;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/beers.test.ts -t 'sanitizeAbv'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#369): sanitizeAbv bounds rule for relayed ABV"
```

---

### Task 2: `fillOrphanFacts` — the NULL-only fill and the re-arm signal

**Files:**
- Modify: `src/storage/beers.ts`
- Test: `src/storage/beers.test.ts`

Spec rules: fill only columns currently NULL, only on orphan rows (`untappd_id IS NULL`), never overwrite; report whether an ABV was newly gained so the caller can re-arm; bump the catalog version when something was written.

- [ ] **Step 1: Write the failing test**

Append to `src/storage/beers.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer, getBeer, fillOrphanFacts } from './beers';
import { catalogVersion } from './catalog-version';

function orphan(db: ReturnType<typeof openDb>, over: Partial<{ abv: number | null; style: string | null }> = {}) {
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Kwas Chlebowy Jasny', brewery: 'AleBrowar',
    style: over.style ?? null, abv: over.abv ?? null, rating_global: null,
    normalized_name: 'kwas chlebowy jasny', normalized_brewery: 'alebrowar',
  });
  return id;
}

describe('fillOrphanFacts', () => {
  it('fills NULL abv and style on an orphan and reports the ABV gain', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = orphan(db);
    const res = fillOrphanFacts(db, id, { abv: 0, style: 'Kwas Chlebowy' });
    expect(res).toEqual({ abvGained: true, changed: true });
    const row = getBeer(db, id)!;
    expect(row.abv).toBe(0);           // 0, not null — the #322 case
    expect(row.style).toBe('Kwas Chlebowy');
  });

  it('never overwrites a value that is already set', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = orphan(db, { abv: 5.5, style: 'IPA' });
    const res = fillOrphanFacts(db, id, { abv: 0, style: 'Kwas Chlebowy' });
    expect(res).toEqual({ abvGained: false, changed: false });
    const row = getBeer(db, id)!;
    expect(row.abv).toBe(5.5);
    expect(row.style).toBe('IPA');
  });

  it('leaves matched rows untouched', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = upsertBeer(db, {
      untappd_id: 5489374, name: 'Kwas Chlebowy Bright', brewery: 'AleBrowar',
      style: null, abv: null, rating_global: null,
      normalized_name: 'kwas chlebowy bright', normalized_brewery: 'alebrowar',
    });
    const res = fillOrphanFacts(db, id, { abv: 0, style: 'Kwas Chlebowy' });
    expect(res).toEqual({ abvGained: false, changed: false });
    const row = getBeer(db, id)!;
    expect(row.abv).toBeNull();
    expect(row.style).toBeNull();
  });

  it('reports a style-only fill as changed but NOT an ABV gain', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = orphan(db, { abv: 4.8 });
    const res = fillOrphanFacts(db, id, { style: 'IPA' });
    expect(res).toEqual({ abvGained: false, changed: true });
    expect(getBeer(db, id)!.style).toBe('IPA');
  });

  it('bumps the catalog version when it writes and not when it does not', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = orphan(db);
    const before = catalogVersion();
    fillOrphanFacts(db, id, { abv: 4.8 });
    const afterWrite = catalogVersion();
    expect(afterWrite).toBeGreaterThan(before);
    fillOrphanFacts(db, id, { abv: 4.8 }); // already set → no-op
    expect(catalogVersion()).toBe(afterWrite);
  });

  it('does nothing when there are no facts to apply', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = orphan(db);
    expect(fillOrphanFacts(db, id, {})).toEqual({ abvGained: false, changed: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/beers.test.ts -t 'fillOrphanFacts'`
Expected: FAIL — `fillOrphanFacts is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/storage/beers.ts` (below `upsertBeer`):

```ts
export interface OrphanFacts {
  abv?: number;
  style?: string;
}

export interface FillResult {
  /** An orphan row gained an ABV it did not have — the caller should re-arm its backoff. */
  abvGained: boolean;
  /** Any column was written. */
  changed: boolean;
}

// #369: shop-published facts for a beer that arrived over the extension relay.
// Fills ONLY columns that are currently NULL, and ONLY on orphan rows: a matched
// row's abv/style belong to Untappd, matching is already done, and a shop value
// could only introduce drift. Never overwrites.
export function fillOrphanFacts(db: DB, beerId: number, facts: OrphanFacts): FillResult {
  const none: FillResult = { abvGained: false, changed: false };
  const abv = sanitizeAbv(facts.abv);
  const style = facts.style;
  if (abv === undefined && style === undefined) return none;

  const row = db
    .prepare('SELECT untappd_id, abv, style FROM beers WHERE id = ?')
    .get(beerId) as { untappd_id: number | null; abv: number | null; style: string | null } | undefined;
  if (!row || row.untappd_id != null) return none;

  const abvGained = row.abv == null && abv !== undefined;
  const styleGained = row.style == null && style !== undefined;
  if (!abvGained && !styleGained) return none;

  db.prepare('UPDATE beers SET abv = COALESCE(abv, ?), style = COALESCE(style, ?) WHERE id = ?')
    .run(abvGained ? abv : null, styleGained ? style : null, beerId);
  bumpCatalogVersion();
  return { abvGained, changed: true };
}

// #369: a row that just gained an ABV deserves an immediate retry — the previous
// lookup ran blind, which is the whole bug. Resets the backoff so isEligible()
// returns true at once. isWontfix still gates eligibility separately.
export function rearmLookup(db: DB, beerId: number): void {
  db.prepare('UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0 WHERE id = ?')
    .run(beerId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: PASS (all `sanitizeAbv` + `fillOrphanFacts` tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#369): fillOrphanFacts NULL-only fill + rearmLookup"
```

---

### Task 3: `/enrich/candidates` accepts and persists `abv`/`style`

**Files:**
- Modify: `src/api/routes/enrich.ts`
- Test: `src/api/routes/enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe('POST /enrich/candidates', ...)` block in `src/api/routes/enrich.test.ts`:

```ts
  it('persists a relayed abv and style on a newly created orphan', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'AleBrowar', name: 'KWAS CHLEBOWY JASNY', abv: 0, style: 'Kwas Chlebowy' }],
    });
    expect(res.status).toBe(200);
    const row = findBeerByNormalized(db, normalizeBrewery('AleBrowar'), normalizeName('KWAS CHLEBOWY JASNY'))!;
    expect(row.abv).toBe(0); // 0.0% must survive — it is the #322 disambiguator
    expect(row.style).toBe('Kwas Chlebowy');
  });

  it('backfills an existing orphan that had no abv, and re-arms its backoff', async () => {
    const { db, app } = setup();
    await post(app, '/enrich/candidates', { beers: [{ brewery: 'AleBrowar', name: 'KWAS CHLEBOWY JASNY' }] });
    const before = findBeerByNormalized(db, normalizeBrewery('AleBrowar'), normalizeName('KWAS CHLEBOWY JASNY'))!;
    db.prepare('UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = 3 WHERE id = ?')
      .run(new Date().toISOString(), before.id);

    await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'AleBrowar', name: 'KWAS CHLEBOWY JASNY', abv: 0 }],
    });

    const after = getBeer(db, before.id)!;
    expect(after.abv).toBe(0);
    expect(after.untappd_lookup_count).toBe(0);
    expect(after.untappd_lookup_at).toBeNull();
  });

  it('does not re-arm on a style-only gain', async () => {
    const { db, app } = setup();
    await post(app, '/enrich/candidates', { beers: [{ brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1 }] });
    const before = findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Atak Chmielu'))!;
    db.prepare('UPDATE beers SET untappd_lookup_count = 2 WHERE id = ?').run(before.id);

    await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, style: 'IPA' }],
    });

    const after = getBeer(db, before.id)!;
    expect(after.style).toBe('IPA');
    expect(after.untappd_lookup_count).toBe(2);
  });

  it('drops an out-of-range abv instead of rejecting the whole batch', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [
        { brewery: 'PINTA', name: 'Bad Abv', abv: 9999 },
        { brewery: 'PINTA', name: 'Good Abv', abv: 5.2 },
      ],
    });
    expect(res.status).toBe(200);
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Bad Abv'))!.abv).toBeNull();
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Good Abv'))!.abv).toBe(5.2);
  });

  it('still accepts an old-shape body with no abv or style', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }] });
    expect(res.status).toBe(200);
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Atak Chmielu'))!.abv).toBeNull();
  });

  it('rejects a style over the per-field character limit', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu', style: 's'.repeat(BEER_TEXT_LIMIT_CHARS + 1) }],
    });
    expect(res.status).toBe(413);
  });

  it('keeps a 200-beer payload with abv and style inside the route byte limit', () => {
    const beers = Array.from({ length: 200 }, (_, i) => ({
      brewery: 'Browar Stu Mostow Wroclaw',
      name: `Salamander Imperial Baltic Porter Batch ${i}`,
      abv: 12.5,
      style: 'Baltic Porter - Imperial',
    }));
    const bytes = Buffer.byteLength(JSON.stringify({ beers }), 'utf8');
    expect(bytes).toBeLessThan(ENRICH_CANDIDATES_BODY_LIMIT_BYTES);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/api/routes/enrich.test.ts -t 'persists a relayed abv'`
Expected: FAIL — `row.abv` is `null` because the field is stripped by zod and ignored by `ensureBeerRow`.

- [ ] **Step 3: Write the implementation**

In `src/api/routes/enrich.ts`:

Extend the imports from storage:

```ts
import {
  findBeerByNormalized,
  getBeer,
  upsertBeer,
  fillOrphanFacts,
  rearmLookup,
  sanitizeAbv,
  type OrphanFacts,
} from '../../storage/beers';
```

Widen `CandidatesBody`:

```ts
const CandidatesBody = z.object({
  beers: z
    .array(z.object({
      brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
      name: z.string().max(BEER_TEXT_LIMIT_CHARS),
      // #369: deliberately unbounded here — sanitizeAbv applies the sanity range.
      // A strict .min/.max would 413 the entire 200-beer batch over one rogue card.
      abv: z.number().optional(),
      style: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
    }))
    .min(1)
    .max(200),
});
```

Replace `ensureBeerRow`:

```ts
// Ensures a beer row exists for (brewery, name) and returns it.
// May return a pre-existing matched row, not only a freshly created orphan.
// #369: `facts` are shop-published abv/style relayed by the extension. On insert
// they seed the row; on an existing orphan they fill NULL columns only. A newly
// gained ABV re-arms the lookup backoff, because the previous attempt ran blind.
function ensureBeerRow(db: ApiDeps['db'], brewery: string, name: string, facts: OrphanFacts = {}) {
  const normalized_brewery = normalizeBrewery(brewery);
  const normalized_name = normalizeName(name);
  const existing = findBeerByNormalized(db, normalized_brewery, normalized_name);
  if (existing) {
    const { abvGained } = fillOrphanFacts(db, existing.id, facts);
    if (abvGained) rearmLookup(db, existing.id);
    return abvGained || facts.style !== undefined ? getBeer(db, existing.id)! : existing;
  }
  const id = upsertBeer(db, {
    untappd_id: null, name, brewery,
    style: facts.style ?? null, abv: sanitizeAbv(facts.abv) ?? null,
    rating_global: null, normalized_name, normalized_brewery,
  });
  return getBeer(db, id)!;
}
```

In the `/enrich/candidates` handler, pass the facts through:

```ts
        const row = ensureBeerRow(deps.db, b.brewery, b.name, { abv: b.abv, style: b.style });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: PASS — new tests plus all pre-existing ones in the file.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(#369): /enrich/candidates carries and persists abv + style"
```

---

### Task 4: `/enrich/result` accepts `abv`/`style` and looks up with them

**Files:**
- Modify: `src/api/routes/enrich.ts`
- Test: `src/api/routes/enrich.test.ts`

`/enrich/result` calls `ensureBeerRow` again and then `lookupBeer({..., abv: row.abv})`. Carrying the fields here keeps the endpoint correct on its own instead of depending on `/enrich/candidates` having run first.

- [ ] **Step 1: Write the failing test**

Append to the `describe('POST /enrich/result', ...)` block in `src/api/routes/enrich.test.ts`:

```ts
  it('passes a relayed abv of 0 into the lookup rather than NULL', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/result', {
      brewery: 'AleBrowar',
      name: 'KWAS CHLEBOWY JASNY',
      abv: 0,
      style: 'Kwas Chlebowy',
      algolia: { hits: [], nbHits: 0 },
    });
    expect(res.status).toBe(200);
    const row = findBeerByNormalized(db, normalizeBrewery('AleBrowar'), normalizeName('KWAS CHLEBOWY JASNY'))!;
    expect(row.abv).toBe(0);
    expect(row.style).toBe('Kwas Chlebowy');
  });

  it('still accepts an old-shape result body with no abv or style', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/result', {
      brewery: 'PINTA', name: 'Atak Chmielu', algolia: { hits: [], nbHits: 0 },
    });
    expect(res.status).toBe(200);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/api/routes/enrich.test.ts -t 'passes a relayed abv of 0'`
Expected: FAIL — `row.abv` is `null`.

- [ ] **Step 3: Write the implementation**

In `src/api/routes/enrich.ts`, widen `ResultBody`:

```ts
const ResultBody = z.object({
  brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
  name: z.string().max(BEER_TEXT_LIMIT_CHARS),
  abv: z.number().optional(),
  style: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
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

In the `/enrich/result` handler, destructure and pass the facts:

```ts
    const { brewery, name, abv, style, html, algolia, pageUrl } = c.req.valid('json');
    const row = ensureBeerRow(deps.db, brewery, name, { abv, style });
```

The `lookupBeer({ brewery, name, abv: row.abv, search })` call is **unchanged** — `row.abv` is now populated.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(#369): /enrich/result carries abv + style into the lookup"
```

---

### Task 5: The #322 end-to-end regression test

**Files:**
- Modify: `src/domain/untappd-lookup.test.ts`

This is the motivating bug: with `abv: 0` the matcher must pick `Bright`, not `Light`. Read the top of `src/domain/untappd-lookup.test.ts` first and reuse that file's existing helper for building a fake `BeerSearch` and `SearchResult[]` rather than inventing a new one — match the surrounding style.

- [ ] **Step 1: Write the failing test**

Append to `src/domain/untappd-lookup.test.ts`, adapting the fake-search helper to the one already used in that file:

```ts
describe('#369/#322 — a relayed 0.0% ABV disambiguates same-brewery twins', () => {
  const twins = [
    { bid: 5489374, beer_name: 'Kwas Chlebowy Bright', brewery_name: 'AleBrowar', abv: 0, style: 'Kwas Chlebowy', global_rating: 3.4 },
    { bid: 5489375, beer_name: 'Kwas Chlebowy Light', brewery_name: 'AleBrowar', abv: 0.5, style: 'Kwas Chlebowy', global_rating: 3.3 },
  ];

  it('picks Bright when abv is 0', async () => {
    const outcome = await lookupBeer({
      brewery: 'AleBrowar',
      name: 'Kwas Chlebowy',
      abv: 0,
      search: { search: async () => twins },
    });
    expect(outcome.kind).toBe('matched');
    expect(outcome.kind === 'matched' && outcome.result.bid).toBe(5489374);
  });

  it('picks Light when abv is 0.5', async () => {
    const outcome = await lookupBeer({
      brewery: 'AleBrowar',
      name: 'Kwas Chlebowy',
      abv: 0.5,
      search: { search: async () => twins },
    });
    expect(outcome.kind).toBe('matched');
    expect(outcome.kind === 'matched' && outcome.result.bid).toBe(5489375);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t '#369/#322'`

Expected: both PASS. `pickByAbv` already uses `abv != null`, so `0` should flow correctly — **this test documents and locks the behaviour rather than driving new code.** If either fails, stop: it means a truthiness check is eating `0` somewhere in `untappd-lookup.ts`, which is exactly the bug this task exists to catch. Fix that, then continue.

Adjust the `SearchResult` literal shape if the compiler reports missing fields — mirror whatever the neighbouring tests in the file construct.

- [ ] **Step 3: Commit**

```bash
git add src/domain/untappd-lookup.test.ts
git commit -m "test(#369): lock the #322 0.0% twin disambiguation"
```

---

### Task 6: Server-side full run

- [ ] **Step 1: Run the whole server suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "chore(#369): server suite green"
```

Skip the commit if there is nothing to fix.

---

### Task 7: `onemorebeer` parses `Moc (%)` and `Styl`

**Files:**
- Modify: `extension/src/sites/types.ts`
- Modify: `extension/src/sites/onemorebeer.ts`
- Test: `extension/src/sites/onemorebeer.test.ts`

The panel is **not** inside the tile. It is a hidden sibling under the shared `.one-product-list-view` wrapper. Verified against the existing fixture: `closest('.one-product-list-view')` → `.one-product-technical-data` resolves for 7/7 tiles.

Fixture ground truth (`extension/tests/fixtures/onemorebeer.html`):

| product | `Moc (%)` | `Styl` |
| --- | --- | --- |
| PINTA TAPROOM PL WEST COAST IPA | *(absent)* | West Coast IPA |
| PINTA BARREL BREWING PATIENCE 2026 | *(absent)* | Imperial Stout |
| PINTA BARREL BREWING LIBERTY 2026 | *(absent)* | Imperial Stout |
| PINTA BARREL BREWING AFFECTION 2026 | *(absent)* | Imperial Stout |
| DZIKI WSCHÓD UKRYKA WIOSKA C.E.O | 4.5% | Wheat beer |
| DZIKI WSCHÓD OWOCE OGRODOWE | 5.5% | Fruit Ale |
| DZIKI WSCHÓD NEXUS 2.0 | 5.5% | West Coast IPA |

The PINTA products publish Plato (`15,0°`, `30,0°`) in the title and have no `Moc` row. Plato is **not** ABV and must never be sent as one.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/sites/onemorebeer.test.ts`, reusing the file's existing fixture-loading helper (read the top of the file first; if it loads the fixture into a `Document`, reuse that exact helper name rather than the placeholder below):

```ts
describe('onemorebeer technical panel (#369)', () => {
  it('reads Moc (%) and Styl from the hidden sibling panel', () => {
    const doc = loadFixture('onemorebeer'); // reuse this file's existing helper
    const cards = onemorebeer.parseCards(doc);
    const dziki = cards.find((c) => c.name.includes('UKRYKA'))!;
    expect(dziki.abv).toBe(4.5);
    expect(dziki.style).toBe('Wheat beer');
  });

  it('leaves abv undefined when the product has no Moc row, and never uses Plato', () => {
    const doc = loadFixture('onemorebeer');
    const cards = onemorebeer.parseCards(doc);
    const pinta = cards.find((c) => c.name.includes('WEST COAST IPA'))!;
    expect(pinta.abv).toBeUndefined(); // title says 15,0° — that is Plato, not ABV
    expect(pinta.style).toBe('West Coast IPA');
  });

  it('parses a 0.0% product as 0, not undefined', () => {
    const html = `
      <div class="one-product-list-view">
        <div class="one-product-list-view__tile">
          <a class="product__title"><h2>ALEBROWAR KWAS CHLEBOWY JASNY BUT. 0,5 L</h2></a>
          <div data-information-type="brand-name">
            <strong class="one-product-tile-information__row__value">AleBrowar</strong>
          </div>
        </div>
        <div class="collapse" style="display:none;">
          <div class="row one-product-technical-data">
            <div><span>Pojemność</span><span class="ml-1"> 0,5l</span></div>
            <div><span>Moc (%)</span><span class="ml-1"> 0.0%</span></div>
            <div><span>Styl</span><span class="ml-1"> Kwas Chlebowy</span></div>
          </div>
        </div>
      </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = onemorebeer.parseCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].abv).toBe(0); // MUST be 0 — a falsy check here breaks #322
    expect(cards[0].style).toBe('Kwas Chlebowy');
  });

  it('ignores an unparseable Moc value without throwing', () => {
    const html = `
      <div class="one-product-list-view">
        <div class="one-product-list-view__tile">
          <a class="product__title"><h2>PINTA MYSTERY BUT. 0,5 L</h2></a>
          <div data-information-type="brand-name">
            <strong class="one-product-tile-information__row__value">PINTA</strong>
          </div>
        </div>
        <div class="collapse" style="display:none;">
          <div class="row one-product-technical-data">
            <div><span>Moc (%)</span><span class="ml-1"> n/d</span></div>
          </div>
        </div>
      </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = onemorebeer.parseCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].abv).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run src/sites/onemorebeer.test.ts -t 'technical panel'`
Expected: FAIL — `dziki.abv` is `undefined`; `style` is not a property of `Card`.

- [ ] **Step 3: Add `style` to `Card`**

In `extension/src/sites/types.ts`:

```ts
export interface Card {
  el: HTMLElement;
  brewery: string;
  name: string;
  abv?: number;
  /** Shop-published style, relayed to /enrich/* for orphan rows (#369). Not sent to /match. */
  style?: string;
  skip?: boolean;
}
```

- [ ] **Step 4: Write the implementation**

In `extension/src/sites/onemorebeer.ts`, add the selectors next to the existing ones:

```ts
const WRAPPER_SELECTOR = '.one-product-list-view';
const TECH_PANEL_SELECTOR = '.one-product-technical-data';
```

Add the parsing helpers below `cleanName`:

```ts
// #369: the shop publishes ABV and style in a "Dane techniczne" accordion that is
// already in the DOM but collapsed. The panel is NOT inside the tile — it is a
// hidden sibling under the shared .one-product-list-view wrapper, so no fetch and
// no synthetic click are needed. Deliberately no fallback selector: if this breaks,
// the conformance tests should fail loudly rather than silently degrade.
function technicalFacts(tile: HTMLElement): { abv?: number; style?: string } {
  const panel = tile.closest(WRAPPER_SELECTOR)?.querySelector(TECH_PANEL_SELECTOR);
  if (!panel) return {};
  const facts: { abv?: number; style?: string } = {};
  for (const row of Array.from(panel.children)) {
    const spans = row.querySelectorAll('span');
    const label = text(spans[0]);
    const value = text(spans[1]);
    if (label.startsWith('Moc')) {
      const abv = parseAbv(value);
      if (abv !== undefined) facts.abv = abv;
    } else if (label === 'Styl' && value) {
      facts.style = value;
    }
  }
  return facts;
}

// "4.5%", " 0.0%", "4,5 %" → number. Anything else ("n/d", "-", "") → undefined.
// 0 is a legitimate result and must not be conflated with "missing".
function parseAbv(value: string): number | undefined {
  const m = value.replace(',', '.').match(/(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return undefined;
  const abv = Number(m[1]);
  return Number.isFinite(abv) ? abv : undefined;
}
```

In `parseCards`, replace the `cards.push` line:

```ts
      cards.push({ el, brewery, name, ...technicalFacts(el) });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npx vitest run src/sites/onemorebeer.test.ts`
Expected: PASS, including the pre-existing tests in the file.

- [ ] **Step 6: Commit**

```bash
git add extension/src/sites/types.ts extension/src/sites/onemorebeer.ts extension/src/sites/onemorebeer.test.ts
git commit -m "feat(#369): parse onemorebeer Moc (%) and Styl from the technical panel"
```

---

### Task 8: Carry `abv`/`style` through the extension transport

**Files:**
- Modify: `extension/src/content/index.ts`
- Modify: `extension/src/content/enrich.ts`
- Modify: `extension/src/content/main.ts`
- Modify: `extension/src/background/index.ts`
- Modify: `extension/src/api/client.ts`
- Test: `extension/src/content/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/content/index.test.ts`, reusing the file's existing fake-adapter / `sendMatch` helpers (read the top of the file first and match its style):

```ts
it('#369: relays abv and style on the orphan payload, keeping 0 as a value', async () => {
  const doc = new DOMParser().parseFromString(
    '<div id="a"></div><div id="b"></div>', 'text/html',
  );
  const elA = doc.getElementById('a') as HTMLElement;
  const elB = doc.getElementById('b') as HTMLElement;
  const adapter = {
    id: 'test',
    hostMatch: () => true,
    parseCards: () => [
      { el: elA, brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny', abv: 0, style: 'Kwas Chlebowy' },
      { el: elB, brewery: 'PINTA', name: 'Mystery' },
    ],
  } as unknown as SiteAdapter;

  const orphans: { key: string; brewery: string; name: string; abv?: number; style?: string }[] = [];
  await runOverlay(
    doc,
    adapter,
    async (cards) => cards.map((raw) => ({
      raw: { brewery: raw.brewery, name: raw.name },
      matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null,
    })),
    (os) => { orphans.push(...os.map((o) => ({ key: o.key, brewery: o.brewery, name: o.name, abv: o.abv, style: o.style }))); },
  );

  expect(orphans[0].abv).toBe(0); // present, not dropped as falsy
  expect(orphans[0].style).toBe('Kwas Chlebowy');
  expect(orphans[1].abv).toBeUndefined();
  expect(orphans[1].style).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run src/content/index.test.ts -t '#369'`
Expected: FAIL — `orphans[0].abv` is `undefined`; `style` is not on the orphan type.

- [ ] **Step 3: Widen the content-script types and payload**

In `extension/src/content/index.ts`, widen `EnrichOrphans`:

```ts
export type EnrichOrphans = (
  orphans: {
    key: string;
    el: HTMLElement;
    brewery: string;
    name: string;
    abv?: number;
    style?: string;
  }[],
) => void;
```

`rawMisses` currently loses `card.style` (it only builds a `RawBeer`), so keep the card alongside it. Change the `rawMisses` construction to retain the card:

```ts
    const rawMisses: { el: HTMLElement; key: string; raw: RawBeer; card: Card }[] = misses
      .filter(({ card }) => !card.skip)
      .map(({ el, card }) => ({
        el,
        key: normalizeKey(card.brewery, card.name),
        raw: card.abv !== undefined
          ? { brewery: card.brewery, name: card.name, abv: card.abv }
          : { brewery: card.brewery, name: card.name },
        card,
      }));
```

and change the orphan mapping to carry both fields (note `!== undefined`, never truthiness):

```ts
        .map((x) => ({
          key: x.miss!.key,
          el: x.miss!.el,
          brewery: x.miss!.raw.brewery,
          name: x.miss!.raw.name,
          ...(x.miss!.card.abv !== undefined ? { abv: x.miss!.card.abv } : {}),
          ...(x.miss!.card.style !== undefined ? { style: x.miss!.card.style } : {}),
        }));
```

- [ ] **Step 4: Widen `OrphanBeer` and the enrich deps**

In `extension/src/content/enrich.ts`:

```ts
export interface OrphanBeer {
  key: string;
  brewery: string;
  name: string;
  abv?: number;
  style?: string;
}

export interface EnrichDeps {
  getCandidates: (
    beers: { brewery: string; name: string; abv?: number; style?: string }[],
  ) => Promise<{ brewery: string; name: string; eligible: boolean; algolia: AlgoliaQuery }[]>;
  fetchSearch: (algolia: AlgoliaQuery) => Promise<AlgoliaResponse | null>;
  submitResult: (
    brewery: string,
    name: string,
    algolia: AlgoliaResponse,
    facts?: { abv?: number; style?: string },
  ) => Promise<EnrichResult>;
  setSearching: (key: string) => void;
  setEnriched: (key: string, untappdId: number, ratingGlobal: number | null) => void;
  setOrphan: (key: string, brewery: string, name: string) => void;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
```

In `runEnrichment`, pass the whole beer through to `getCandidates` and forward the facts on submit:

```ts
  const candidates = await deps.getCandidates(
    orphans.map((o) => ({
      brewery: o.brewery,
      name: o.name,
      ...(o.abv !== undefined ? { abv: o.abv } : {}),
      ...(o.style !== undefined ? { style: o.style } : {}),
    })),
  );
```

```ts
      const res = algolia
        ? await deps.submitResult(cand.brewery, cand.name, algolia, {
            ...(beer.abv !== undefined ? { abv: beer.abv } : {}),
            ...(beer.style !== undefined ? { style: beer.style } : {}),
          })
        : null;
```

- [ ] **Step 5: Wire the messages in `main.ts`**

In `extension/src/content/main.ts`, keep the facts on the `OrphanBeer` list and forward them:

```ts
    const beers: OrphanBeer[] = orphans.map((o) => ({
      key: o.key,
      brewery: o.brewery,
      name: o.name,
      ...(o.abv !== undefined ? { abv: o.abv } : {}),
      ...(o.style !== undefined ? { style: o.style } : {}),
    }));
```

```ts
      submitResult: async (brewery, name, algolia, facts) =>
        (await sendBg<{ result: EnrichResult | null }>({
          type: 'enrich:result', brewery, name, algolia,
          ...(facts?.abv !== undefined ? { abv: facts.abv } : {}),
          ...(facts?.style !== undefined ? { style: facts.style } : {}),
          pageUrl: window.location.href,
        }))?.result ?? { status: 'transient' },
```

- [ ] **Step 6: Widen the background message types**

In `extension/src/background/index.ts`:

```ts
export interface EnrichCandidatesMessage {
  type: 'enrich:candidates';
  beers: { brewery: string; name: string; abv?: number; style?: string }[];
}
export interface EnrichResultMessage {
  type: 'enrich:result';
  brewery: string;
  name: string;
  algolia: AlgoliaResponse;
  abv?: number;
  style?: string;
  pageUrl?: string;
}
```

and forward them in `handleEnrichResult`:

```ts
    const result = await postEnrichResult(baseUrl, token, {
      brewery: msg.brewery, name: msg.name, algolia: msg.algolia,
      ...(msg.abv !== undefined ? { abv: msg.abv } : {}),
      ...(msg.style !== undefined ? { style: msg.style } : {}),
      pageUrl: msg.pageUrl,
    });
```

`handleEnrichCandidates` already passes `msg.beers` straight through — no change beyond the type.

- [ ] **Step 7: Widen the API client signatures**

In `extension/src/api/client.ts`:

```ts
export async function postEnrichCandidates(
  baseUrl: string,
  token: string,
  beers: { brewery: string; name: string; abv?: number; style?: string }[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnrichCandidate[]> {
```

```ts
export async function postEnrichResult(
  baseUrl: string,
  token: string,
  payload: {
    brewery: string;
    name: string;
    algolia: AlgoliaResponse;
    abv?: number;
    style?: string;
    pageUrl?: string;
  },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnrichResult> {
```

Both bodies already serialize their argument wholesale (`JSON.stringify({ beers })` and `JSON.stringify(payload)`), so no body changes are needed.

- [ ] **Step 8: Run the extension suite**

Run: `cd extension && npm test`
Expected: PASS, including the new `#369` test and every pre-existing test.

- [ ] **Step 9: Commit**

```bash
git add extension/src
git commit -m "feat(#369): carry abv + style through the extension enrich transport"
```

---

### Task 9: Extension release 0.13.0

**Files:**
- Modify: `extension/package.json`
- Modify: `extension/CHANGELOG.md`

`release-notes.ts` **throws** without a `## [x.y.z]` section matching the package version, so both must change together.

- [ ] **Step 1: Bump the version**

In `extension/package.json`, change `"version": "0.12.0"` to `"version": "0.13.0"`.

- [ ] **Step 2: Add the CHANGELOG section**

Insert directly below the `# Changelog` heading in `extension/CHANGELOG.md`, matching the existing user-facing tone (describe the effect, not the internals):

```markdown
## [0.13.0] - 2026-07-31

- Missing beers are now matched using the alcohol strength the shop publishes, instead of ignoring it. This tells apart releases that share a brewery, a style and a name and differ only in strength — for example AleBrowar's alcohol-free Kwas Chlebowy versus its 0.5% version — so more ⚪ beers become ⭐ instead of staying unmatched.
- Added OneMoreBeer alcohol strength and style parsing: the shop's "Dane techniczne" panel is now read for every product, so its beers get the same strength-aware matching as the other supported shops.
```

- [ ] **Step 3: Verify the version and section agree**

Run: `cd extension && node -p "require('./package.json').version" && grep -n '## \[0.13.0\]' CHANGELOG.md`
Expected: `0.13.0` and a matching line number.

- [ ] **Step 4: Commit**

```bash
git add extension/package.json extension/CHANGELOG.md
git commit -m "release(extension): cut 0.13.0 (relay ABV channel + OneMoreBeer technical panel)"
```

---

### Task 10: The 0.0% fixture — BLOCKED on a capture

**Files:**
- Create: `extension/tests/fixtures/onemorebeer.abv.html`
- Modify: `extension/src/sites/onemorebeer.test.ts`

**Status: blocked.** The first capture (`tmp/Inne.html`) is unusable: 5 wrappers and 5 technical panels (all correctly showing `Moc (%) 0.0%`, `Styl Kwas Chlebowy`) but **0 tiles** — no `.one-product-list-view__tile`, no `a.product__title`. It was captured while the tile list had unmounted, so `parseCards` returns 0 cards from it. Do **not** splice a synthetic tile into it: that would disguise a fabricated fixture as a real capture.

Task 7 already pins the 0.0% adapter behaviour with an inline synthetic tile, which is the spec's documented fallback, so **this task is not on the critical path** — the feature is complete and correct without it. It upgrades that one boundary test from synthetic to real markup.

- [ ] **Step 1: Obtain a valid capture**

Ask the user to re-run `tmp/capture-onemorebeer.js` in the DevTools console on `https://onemorebeer.pl/bezalkoholowe/inne` with products visible on screen. The script prints `tiles: N` and warns when no 0.0% product is present, so a bad capture is obvious before it is saved.

- [ ] **Step 2: Verify the capture before adding it**

Save it to `extension/tests/fixtures/onemorebeer.abv.html`, then confirm it parses:

```bash
cd extension && npx vitest run src/sites/onemorebeer.test.ts
```

The capture is only usable if `.one-product-list-view__tile` count is > 0 and at least one product has `Moc (%) 0.0%`.

- [ ] **Step 3: Replace the synthetic 0.0% test with the real fixture**

Swap the inline-HTML `parses a 0.0% product as 0` test from Task 7 to load `onemorebeer.abv.html` through the file's existing fixture helper, asserting the same `expect(card.abv).toBe(0)`. Keep the assertion identical — only the source of the DOM changes.

`conformance.test.ts` keys strictly on `<id>.html`, so the extra fixture is picked up only by this adapter's own tests and cannot disturb the contract suite (precedent: `flasker.table.html`, `flasker.block.html`).

- [ ] **Step 4: Commit**

```bash
git add extension/tests/fixtures/onemorebeer.abv.html extension/src/sites/onemorebeer.test.ts
git commit -m "test(#369): pin the 0.0% guard to a real onemorebeer capture"
```

---

### Task 11: Full verification and PR

- [ ] **Step 1: Run everything**

```bash
npm test && npm run typecheck && cd extension && npm test && cd ..
```

Expected: all green. Do not proceed on a failure — fix it first.

- [ ] **Step 2: Grep the diff for the truthiness hazard**

```bash
git diff main --unified=0 | grep -nE '^\+.*(if\s*\(\s*!?\w*[Aa]bv|\|\|\s*.*abv|abv\s*\?\s)' || echo "no truthiness checks on abv"
```

Expected: `no truthiness checks on abv`. Any hit must be reviewed by hand — `if (abv)`, `abv ||`, and `abv ? :` all silently discard `0` and would defeat #322.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "fix(#369): ABV reaches the matcher on the extension relay path" --body "$(cat <<'EOF'
Closes #369.

Relay-sourced beers were matched blind: `enrich_failures` shows cron-sourced rows carry ABV 369/413 (89%) while relay-sourced rows carry it 1/237 (0.4%).

Two stacked defects, in the order that actually matters:

- **Protocol (66% of relay failures).** `content/index.ts` dropped `card.abv`, `OrphanBeer` had no field for it, and `/enrich/*` had no channel — so flasker (108 failures), beerfreak (32) and funkyshop (16) already parsed an ABV that was thrown away in transit. Both endpoints now carry optional `abv`/`style`, `ensureBeerRow` persists them, and `lookupBeer` finally receives a value.
- **onemorebeer adapter (13%).** The shop publishes `Moc (%)` and `Styl` in a collapsed `Dane techniczne` accordion. The panel is not inside the tile — it is a hidden sibling under the shared `.one-product-list-view` wrapper, already in the DOM, so it needs no fetch and no synthetic click.

The other four ABV-less adapters were audited and left alone: `beerrepublic`'s ABV appears only in the filter sidebar, and `winetime`/`bierloods22`/`piwnemosty` publish none on the listing page. Reaching it there needs per-product detail fetches — filed separately.

**Persistence.** Fills only columns that are currently NULL, and only on orphan rows; matched rows (including #343 pins) are never touched. A row that gains an ABV it did not have gets its lookup backoff re-armed, because the previous attempt ran blind. No blind mass re-arm: re-arming a row that still has no ABV just re-spends the lookup that already failed.

**`0.0%` is load-bearing.** #322's `KWAS CHLEBOWY JASNY` is ambiguous between `Bright` (0.0%) and `Light` (0.5%); the shop publishes `Moc 0.0%`, which picks `Bright` (bid 5489374) outright. Any truthiness check on `abv` would silently discard that, so the guard is pinned at all four boundaries — adapter, transport, persistence, and an end-to-end regression on the twins themselves.

Spec: `docs/superpowers/specs/2026-07/2026-07-31-369-relay-abv-channel-design.md`
Plan: `docs/superpowers/plans/2026-07/2026-07-31-369-relay-abv-channel.md`

**Rollout:** server first (fields are optional in both directions, no lockstep), then extension 0.13.0. Re-arming happens organically as users browse — no prod DB surgery.

**Checkpoint:** relay-sourced `enrich_failures` carrying ABV, today 1/237 (0.4%), measured a few days after the extension release. flasker + beerfreak + funkyshop alone should move it to roughly two thirds; if it does not, the protocol change did not land.

No `docs/extension-install-uk.md` update: no new shop, option, popup button or badge behaviour — the only user-visible effect is more ⚪ becoming ⭐. The CHANGELOG entry covers it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_018rQqgyW4diwt5ttVPdNaAH
EOF
)"
```

- [ ] **Step 4: Poll for the AI review and act on it**

Per project policy the PR is **not done at green tests**. Wait for the AI reviewer, read every comment, verify each claim against the code, push back on the wrong ones and fix the valid ones. Never merge — the user merges.

---

## Self-review

**Spec coverage:** adapter parsing → Task 7; transport → Task 8; server protocol → Tasks 3–4; `sanitizeAbv` → Task 1; fill rule + re-arm + catalog bump → Task 2; 0.0% guard at all four boundaries → Tasks 1, 2 (persistence), 5 (end-to-end), 7 (adapter), 8 (transport); payload budget → Task 3; back-compat → Tasks 3–4; release → Task 9; real fixture → Task 10; rollout and checkpoint → Task 11's PR body.

**Non-goals honoured:** no detail fetches for the four ABV-less adapters, no style wiring into the matcher, no blind mass re-arm, no `docs/extension-install-uk.md` change.

**Known deviations from the spec:** the spec's "bump the catalog version at most once per request" rule was dropped — `bumpCatalogVersion()` is an in-memory `version++` and the cache collapses any number of bumps between two reads into one rebuild, so the optimization solved a cost problem that does not exist. The spec was corrected to match.
