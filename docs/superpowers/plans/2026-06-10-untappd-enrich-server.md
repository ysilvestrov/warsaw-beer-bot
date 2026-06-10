# Untappd Client-Enrichment — Phase 1: Server Endpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two authenticated server endpoints (`/enrich/candidates`, `/enrich/result`) that let a client register orphan beers, learn which are due for an Untappd search, and submit relayed search HTML for the server to parse and enrich — reusing the existing orphan/lookup-backoff/lookupBeer machinery.

**Architecture:** A new Hono route module `src/api/routes/enrich.ts` (mirrors `routes/match.ts`), wired under the existing Bearer auth. `/enrich/candidates` upserts orphans + computes backoff eligibility + a server-built `searchUrl`. `/enrich/result` runs the existing `lookupBeer` with the client HTML as its `fetch` result, then records success/not-found/blocked. No change to `/match`, the matcher, or drunk logic.

**Tech Stack:** TypeScript, Hono + `@hono/zod-validator`, better-sqlite3, ts-jest.

**Spec:** `docs/superpowers/specs/2026-06-10-extension-untappd-client-enrichment-design.md` (this plan is the server half; the extension half is a separate plan).

---

## File structure

| File | Change |
| --- | --- |
| `src/api/routes/enrich.ts` (create) | `enrichRoute(app, deps)` registering both POST endpoints |
| `src/api/routes/enrich.test.ts` (create) | endpoint tests (candidates eligibility, result matched/not_found) |
| `src/api/index.ts` (modify) | mount `/enrich/*` under auth + call `enrichRoute` |

Reused as-is: `storage/beers` (`upsertBeer`, `findBeerByNormalized`, `recordLookupSuccess`, `recordLookupNotFound`, `recordLookupTransient`), `domain/normalize` (`normalizeName`, `normalizeBrewery`, `stripBreweryNoise`), `domain/lookup-backoff` (`isEligible`), `domain/untappd-lookup` (`lookupBeer`), `sources/untappd/search` (`buildSearchUrl`).

---

## Task 1: `POST /enrich/candidates`

**Files:**
- Create: `src/api/routes/enrich.ts`
- Create: `src/api/routes/enrich.test.ts`
- Modify: `src/api/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/routes/enrich.test.ts`:

```ts
import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertBeer, findBeerByNormalized, getBeer } from '../../storage/beers';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { enrichRoute } from './enrich';
import type { ApiEnv } from '../types';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const log = pino({ level: 'silent' });
  const app = new Hono<ApiEnv>();
  enrichRoute(app, { db, env: {} as never, log });
  return { db, app };
}

function post(app: Hono<ApiEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /enrich/candidates', () => {
  it('registers a new beer as an orphan and marks it eligible', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0]).toMatchObject({ brewery: 'PINTA', name: 'Atak Chmielu', eligible: true });
    expect(body.candidates[0].searchUrl).toContain('untappd.com/search');

    const row = findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Atak Chmielu'));
    expect(row).not.toBeNull();
    expect(row!.untappd_id).toBeNull();
  });

  it('is not eligible when the beer already has an untappd_id', async () => {
    const { db, app } = setup();
    upsertBeer(db, {
      untappd_id: 42, name: 'Atak Chmielu', brewery: 'PINTA', style: null, abv: null, rating_global: 3.9,
      normalized_name: normalizeName('Atak Chmielu'), normalized_brewery: normalizeBrewery('PINTA'),
    });
    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }] });
    const body = await res.json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it('is not eligible when recently searched (backoff active)', async () => {
    const { db, app } = setup();
    const id = upsertBeer(db, {
      untappd_id: null, name: 'Foo', brewery: 'Bar', style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Foo'), normalized_brewery: normalizeBrewery('Bar'),
    });
    // count=1 → 24h backoff; last attempt 1h ago → not due.
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    db.prepare('UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = 1 WHERE id = ?').run(oneHourAgo, id);
    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: 'Bar', name: 'Foo' }] });
    const body = await res.json();
    expect(body.candidates[0].eligible).toBe(false);
    void getBeer; // imported for Task 2
  });

  it('400 on an empty beer list', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', { beers: [] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/api/routes/enrich.test.ts`
Expected: FAIL — `./enrich` module does not exist.

- [ ] **Step 3: Create `src/api/routes/enrich.ts`**

```ts
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { findBeerByNormalized, upsertBeer } from '../../storage/beers';
import { normalizeBrewery, normalizeName, stripBreweryNoise } from '../../domain/normalize';
import { isEligible } from '../../domain/lookup-backoff';
import { buildSearchUrl } from '../../sources/untappd/search';

const CandidatesBody = z.object({
  beers: z
    .array(z.object({ brewery: z.string(), name: z.string() }))
    .min(1)
    .max(200),
});

// Ensures an orphan row exists for (brewery, name) and returns it.
function ensureOrphan(db: ApiDeps['db'], brewery: string, name: string) {
  const normalized_brewery = normalizeBrewery(brewery);
  const normalized_name = normalizeName(name);
  let row = findBeerByNormalized(db, normalized_brewery, normalized_name);
  if (!row) {
    upsertBeer(db, {
      untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
      normalized_name, normalized_brewery,
    });
    row = findBeerByNormalized(db, normalized_brewery, normalized_name)!;
  }
  return row;
}

export function enrichRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/enrich/candidates', zValidator('json', CandidatesBody), (c) => {
    const { beers } = c.req.valid('json');
    const now = new Date();
    const candidates = beers.map((b) => {
      const row = ensureOrphan(deps.db, b.brewery, b.name);
      const eligible =
        row.untappd_id == null &&
        isEligible(now, row.untappd_lookup_at, row.untappd_lookup_count);
      return {
        brewery: b.brewery,
        name: b.name,
        eligible,
        searchUrl: buildSearchUrl(`${stripBreweryNoise(b.brewery)} ${b.name}`.trim()),
      };
    });
    return c.json({ candidates });
  });
}
```

- [ ] **Step 4: Mount the route in `src/api/index.ts`**

Add the import after the `matchRoute` import:

```ts
import { enrichRoute } from './routes/enrich';
```

and register it right after the `matchRoute(app, deps);` line:

```ts
  app.use('/enrich/*', authMiddleware(deps.db));
  enrichRoute(app, deps);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/api/routes/enrich.test.ts`
Expected: PASS (4 `/enrich/candidates` tests).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts src/api/index.ts
git commit -m "feat(api): POST /enrich/candidates — register orphans + backoff eligibility"
```

---

## Task 2: `POST /enrich/result`

**Files:**
- Modify: `src/api/routes/enrich.ts`
- Modify: `src/api/routes/enrich.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/api/routes/enrich.test.ts` (add the import line at the top with the others):

```ts
import { recordLookupSuccess } from '../../storage/beers';
```

Then append this block at the end of the file:

```ts
// Minimal Untappd search markup parseSearchPage understands (mirrors untappd-lookup.test).
function searchHtml(
  items: Array<{ bid: number; name: string; brewery: string; rating?: string }>,
): string {
  const cards = items
    .map(
      (it) => `
      <div class="beer-item"><div class="beer-details">
        <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
        <p class="brewery"><a>${it.brewery}</a></p>
        <p class="style">IPA</p>
      </div><div class="details beer">
        <p class="abv">5% ABV</p>
        <div class="rating"><div class="caps" data-rating="${it.rating ?? '3.5'}"></div></div>
      </div></div>`,
    )
    .join('');
  return `<html><body>${cards}</body></html>`;
}

describe('POST /enrich/result', () => {
  it('enriches the orphan on a matched search result', async () => {
    const { db, app } = setup();
    const html = searchHtml([
      { bid: 5001, name: 'Fifty/Fifty Clementine & Passionfruit', brewery: 'Magic Road', rating: '3.98' },
    ]);
    const res = await post(app, '/enrich/result', {
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      html,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'matched', untappd_id: 5001 });

    const row = findBeerByNormalized(
      db, normalizeBrewery('Magic Road Brewery'), normalizeName('Fifty/Fifty Clementine & Passionfruit'),
    )!;
    expect(getBeer(db, row.id)!.untappd_id).toBe(5001);
    expect(getBeer(db, row.id)!.rating_global).toBeCloseTo(3.98);
    void recordLookupSuccess; // referenced for clarity; route uses it internally
  });

  it('records not_found and bumps the backoff when nothing matches', async () => {
    const { db, app } = setup();
    const html = searchHtml([{ bid: 9000, name: 'Totally Different', brewery: 'Other Brewery' }]);
    const res = await post(app, '/enrich/result', {
      brewery: 'Magic Road Brewery', name: 'Fifty/Fifty Clementine & Passionfruit', html,
    });
    const body = await res.json();
    expect(body.status).toBe('not_found');

    const row = findBeerByNormalized(
      db, normalizeBrewery('Magic Road Brewery'), normalizeName('Fifty/Fifty Clementine & Passionfruit'),
    )!;
    expect(getBeer(db, row.id)!.untappd_lookup_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/api/routes/enrich.test.ts -t "/enrich/result"`
Expected: FAIL — the `/enrich/result` route is not registered (404, body has no `status`).

- [ ] **Step 3: Add the `/enrich/result` handler to `src/api/routes/enrich.ts`**

Add these imports to the existing import block:

```ts
import { recordLookupNotFound, recordLookupSuccess, recordLookupTransient } from '../../storage/beers';
import { lookupBeer } from '../../domain/untappd-lookup';
```

Add a second body schema next to `CandidatesBody`:

```ts
const ResultBody = z.object({
  brewery: z.string(),
  name: z.string(),
  html: z.string(),
});
```

Inside `enrichRoute`, after the `/enrich/candidates` registration, add:

```ts
  app.post('/enrich/result', zValidator('json', ResultBody), async (c) => {
    const { brewery, name, html } = c.req.valid('json');
    const row = ensureOrphan(deps.db, brewery, name);
    // Reuse the full server pick pipeline; the client already fetched, so the
    // injected fetch just returns the relayed HTML regardless of URL.
    const outcome = await lookupBeer({ brewery, name, abv: row.abv, fetch: async () => html });
    const nowIso = new Date().toISOString();

    if (outcome.kind === 'matched') {
      recordLookupSuccess(deps.db, row.id, {
        bid: outcome.result.bid,
        style: outcome.result.style,
        abv: outcome.result.abv,
        global_rating: outcome.result.global_rating,
      });
      return c.json({ status: 'matched', untappd_id: outcome.result.bid, rating_global: outcome.result.global_rating });
    }
    if (outcome.kind === 'not_found') {
      recordLookupNotFound(deps.db, row.id, nowIso);
      return c.json({ status: 'not_found' });
    }
    if (outcome.kind === 'blocked') {
      recordLookupTransient(deps.db, row.id, nowIso); // soft backoff, no count penalty
      return c.json({ status: 'blocked' });
    }
    return c.json({ status: 'transient' });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/api/routes/enrich.test.ts`
Expected: PASS (all `/enrich/candidates` + `/enrich/result` tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(api): POST /enrich/result — pick via lookupBeer + record success/not_found/blocked"
```

---

## Task 3: Spec note + verification

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document the endpoints in `spec.md`**

Run `grep -n "POST /match" spec.md` to find the API section. After the `/match` description block (it ends at the `500 { error: "internal" }` sentence), add:

```markdown
#### `POST /enrich/candidates` / `POST /enrich/result` — client-relay Untappd enrichment

Auth like `/match`. `/enrich/candidates` приймає `{beers:[{brewery,name}]}`, апсертить
кожне нове пиво як orphan (`untappd_id` NULL) і повертає `{candidates:[{brewery,name,
eligible,searchUrl}]}`, де `eligible` = backoff-due (`isEligible`) і пиво ще orphan.
`/enrich/result` приймає `{brewery,name,html}` (обрізана клієнтом сторінка Untappd-пошуку),
проганяє наявний `lookupBeer` з `fetch=()=>html` і пише результат: matched →
`recordLookupSuccess` (bid+рейтинг), not_found → `recordLookupNotFound` (backoff++),
blocked → `recordLookupTransient` (м'який backoff). Той самий orphan-пул і backoff, що й у
серверного enrich-крона — клієнт лише дозбирує видиме й due.
```

- [ ] **Step 2: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document /enrich/candidates + /enrich/result endpoints"
```

- [ ] **Step 3: Full bot suite**

Run: `npm test`
Expected: all bot/jest suites green, including the new `src/api/routes/enrich.test.ts`. `/match` and matcher suites unchanged.

- [ ] **Step 4: Build (type check)**

Run: `npm run build`
Expected: `tsc` exits 0.

---

## Self-review notes

- **Spec coverage (server half):** `/enrich/candidates` orphan upsert + eligibility + searchUrl (Task 1), `/enrich/result` lookupBeer reuse + matched/not_found/blocked records (Task 2), auth mount (Task 1 Step 4), spec note (Task 3). `/match`, matcher, drunk logic untouched. The extension half (background fetch, content queue, options toggle/permissions, ⚪/loader badge, page-cap gate) is a **separate plan** built on these endpoints.
- **Type consistency:** `ensureOrphan` returns a `BeerRow` (has `untappd_id`, `untappd_lookup_at`, `untappd_lookup_count`, `abv`, `id`); `isEligible(now, lookupAt, count)`, `lookupBeer({brewery,name,abv,fetch})`, `recordLookupSuccess(db,id,{bid,style,abv,global_rating})` match their definitions. Response shapes: candidates `{candidates:[{brewery,name,eligible,searchUrl}]}`, result `{status, untappd_id?, rating_global?}`.
- **No placeholders:** every code/command step is complete; the `searchHtml` test helper mirrors the markup `parseSearchPage` parses.
- **Execution note:** implement in a worktree (branches from `origin/main`); cherry-pick the spec commit and this plan's commit into the worktree branch, per project convention.
```
