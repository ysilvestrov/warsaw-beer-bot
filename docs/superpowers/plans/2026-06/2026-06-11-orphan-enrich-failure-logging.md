# Orphan enrich-failure logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every `not_found`/`blocked` enrichment failure (both channels) into a queryable `enrich_failures` table — input + `searchUrl` + candidate summary — so matching bugs are debuggable without manually reproducing/attaching Untappd HTML.

**Architecture:** A v10 SQLite table keyed by `beer_id` (one row per failing beer, upserted, CASCADE-deleted with the beer). `lookupBeer` returns diagnostics (URLs tried + parsed candidates) on `not_found`/`blocked`; the shared `applyLookupOutcome` hook upserts the failure row (and clears it on `matched`), so the server cron and client-relay log identically.

**Tech Stack:** Node 20, TypeScript (strict), better-sqlite3, Jest.

**Spec:** `docs/superpowers/specs/2026-06-11-orphan-enrich-failure-logging-design.md`. Read it first.

**File structure:**
- `src/storage/schema.ts` — add migration v10.
- `src/storage/enrich_failures.ts` (new) — `recordEnrichFailure` (upsert), `clearEnrichFailure`.
- `src/domain/untappd-lookup.ts` — extend `LookupOutcome`, return diagnostics.
- `src/domain/lookup-outcome.ts` — `summarizeCandidates`, write/clear failures, new `input` param.
- `src/api/routes/enrich.ts` + `src/jobs/untappd-enrich.ts` — pass `input` to `applyLookupOutcome`.
- `spec.md` — §3 table + §3.15 + §4 note.

---

## Task 1: Migration v10 — `enrich_failures` table

**Files:**
- Modify: `src/storage/schema.ts` (MIGRATIONS array, after the v9 entry ~line 162)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/storage/schema.test.ts` (inside the top-level `describe('schema migrations', …)` block, before its closing `});`):

```typescript
  test('migration v10 creates enrich_failures table with beer_id PK', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(enrich_failures)').all() as { name: string; pk: number }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'beer_id', 'brewery', 'name', 'search_url', 'outcome',
        'candidates_count', 'candidates_summary', 'fail_count', 'last_at',
      ]),
    );
    expect(cols.find((c) => c.name === 'beer_id')?.pk).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/schema.test.ts -t "v10"`
Expected: FAIL — `PRAGMA table_info(enrich_failures)` returns `[]`, so `beer_id` pk is undefined.

- [ ] **Step 3: Add the v10 migration**

In `src/storage/schema.ts`, add this object to the `MIGRATIONS` array immediately after the v9 entry (the `extension_releases` block), before the array's closing `]`:

```typescript
  {
    version: 10,
    sql: `
      CREATE TABLE enrich_failures (
        beer_id            INTEGER NOT NULL PRIMARY KEY
                           REFERENCES beers(id) ON DELETE CASCADE,
        brewery            TEXT NOT NULL,
        name               TEXT NOT NULL,
        search_url         TEXT NOT NULL,
        outcome            TEXT NOT NULL CHECK (outcome IN ('not_found','blocked')),
        candidates_count   INTEGER NOT NULL,
        candidates_summary TEXT NOT NULL,
        fail_count         INTEGER NOT NULL DEFAULT 1,
        last_at            TEXT NOT NULL
      );
    `,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/storage/schema.test.ts`
Expected: PASS (new v10 test + idempotency test).

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(db): migration v10 — enrich_failures table (#orphan-logging)"
```

---

## Task 2: `storage/enrich_failures.ts` — record + clear

**Files:**
- Create: `src/storage/enrich_failures.ts`
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/storage/enrich_failures.test.ts`:

```typescript
import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import { recordEnrichFailure, clearEnrichFailure, type EnrichFailureRow } from './enrich_failures';

function freshDbWithBeer() {
  const db = openDb(':memory:');
  migrate(db);
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  return { db, id };
}

const row = (over: Partial<EnrichFailureRow> & { beer_id: number }): EnrichFailureRow => ({
  brewery: 'Track', name: 'Taking Shape', search_url: 'https://untappd.com/search?q=Track+Taking+Shape&type=beer',
  outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: '2026-06-11T00:00:00Z', ...over,
});

describe('enrich_failures', () => {
  test('record inserts a row', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got).toMatchObject({ beer_id: id, outcome: 'not_found', candidates_count: 0, fail_count: 1 });
  });

  test('record upserts: bumps fail_count and refreshes fields', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, last_at: '2026-06-11T00:00:00Z' }));
    recordEnrichFailure(db, row({ beer_id: id, outcome: 'blocked', candidates_count: 0, last_at: '2026-06-11T01:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.fail_count).toBe(2);
    expect(got.outcome).toBe('blocked');
    expect(got.last_at).toBe('2026-06-11T01:00:00Z');
  });

  test('clear deletes the row', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    clearEnrichFailure(db, id);
    expect(db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id)).toBeUndefined();
  });

  test('deleting the beer cascades to enrich_failures', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    db.prepare('DELETE FROM beers WHERE id = ?').run(id);
    expect(db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/enrich_failures.test.ts`
Expected: FAIL — cannot find module `./enrich_failures`.

- [ ] **Step 3: Implement the module**

Create `src/storage/enrich_failures.ts`:

```typescript
import type { DB } from './db';

export interface EnrichFailureRow {
  beer_id: number;
  brewery: string;
  name: string;
  search_url: string;
  outcome: 'not_found' | 'blocked';
  candidates_count: number;
  candidates_summary: string;
  at: string; // ISO timestamp of this failure
}

// One row per failing beer. Upsert on beer_id: a repeat failure refreshes the
// diagnostic fields and bumps fail_count. The row is cleared (clearEnrichFailure)
// when the beer eventually matches, and CASCADE-deleted if the beer row is removed.
export function recordEnrichFailure(db: DB, r: EnrichFailureRow): void {
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary, fail_count, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(beer_id) DO UPDATE SET
       brewery            = excluded.brewery,
       name               = excluded.name,
       search_url         = excluded.search_url,
       outcome            = excluded.outcome,
       candidates_count   = excluded.candidates_count,
       candidates_summary = excluded.candidates_summary,
       fail_count         = enrich_failures.fail_count + 1,
       last_at            = excluded.last_at`,
  ).run(
    r.beer_id, r.brewery, r.name, r.search_url, r.outcome,
    r.candidates_count, r.candidates_summary, r.at,
  );
}

export function clearEnrichFailure(db: DB, beerId: number): void {
  db.prepare('DELETE FROM enrich_failures WHERE beer_id = ?').run(beerId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/storage/enrich_failures.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(db): enrich_failures storage — upsert record + clear"
```

---

## Task 3: `lookupBeer` returns diagnostics on not_found / blocked

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/untappd-lookup.test.ts` (before the file's final closing `});` of the top `describe('lookupBeer', …)`):

```typescript
  describe('diagnostics (orphan logging)', () => {
    test('not_found returns the tried search URL(s) and parsed candidates', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 1, name: 'Atak Chmielu', brewery: 'Magic Road' }]),
      );
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'Totally Different Beer', fetch });
      expect(out.kind).toBe('not_found');
      if (out.kind !== 'not_found') return;
      expect(out.searchUrls[0]).toContain('Magic%20Road');
      expect(out.candidates.map((c) => c.beer_name)).toContain('Atak Chmielu');
    });

    test('not_found with zero results returns empty candidates', async () => {
      const fetch = jest.fn(async () => '<html><body></body></html>');
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'Whatever', fetch });
      expect(out.kind).toBe('not_found');
      if (out.kind !== 'not_found') return;
      expect(out.candidates).toEqual([]);
      expect(out.searchUrls.length).toBeGreaterThan(0);
    });

    test('blocked returns the search URL that tripped the block', async () => {
      const fetch = jest.fn(async () => '<title>Just a moment...</title>');
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'X', fetch });
      expect(out.kind).toBe('blocked');
      if (out.kind !== 'blocked') return;
      expect(out.searchUrl).toContain('Magic%20Road');
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/domain/untappd-lookup.test.ts -t "diagnostics"`
Expected: FAIL — `out.searchUrls` / `out.candidates` / `out.searchUrl` are `undefined` (type error at compile or assertion fail).

- [ ] **Step 3: Extend `LookupOutcome` and capture diagnostics**

In `src/domain/untappd-lookup.ts`, change the `LookupOutcome` type:

```typescript
export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found'; searchUrls: string[]; candidates: SearchResult[] }
  | { kind: 'transient'; error: unknown }
  | { kind: 'blocked'; searchUrl: string };
```

Then rework the `lookupBeer` loop body to build the URL up front, accumulate tried URLs + parsed candidates, and return them. Replace the existing loop (from `for (const part of parts) {` through the final `return { kind: 'not_found' };`) with:

```typescript
  const triedUrls: string[] = [];
  const seenCandidates: SearchResult[] = [];

  for (const part of parts) {
    const url = buildSearchUrl(`${stripBreweryNoise(part)} ${name}`.trim());
    triedUrls.push(url);

    let html: string;
    try {
      html = await fetch(url);
    } catch (error) {
      if (error instanceof HttpError && isBlockStatus(error.status)) {
        return { kind: 'blocked', searchUrl: url };
      }
      return { kind: 'transient', error };
    }

    if (isBlockPage(html)) return { kind: 'blocked', searchUrl: url };

    const results = parseSearchPage(html);
    seenCandidates.push(...results);
    if (results.length === 0) continue;

    // Stage 1: brewery hard-gate — token-boundary prefix overlap.
    const breweryPassed = results.filter((r) =>
      breweryAliasesMatch(breweryAliases(r.brewery_name), inputBreweryAliases),
    );
    if (breweryPassed.length === 0) continue;

    // Stage 2a: name-keys exact intersection (order-insensitive, collab/bilingual aware).
    const inputKeys = nameKeys(name, brewery);
    const keyHits = breweryPassed.filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), inputKeys),
    );
    if (keyHits.length > 0) {
      if (abv != null) {
        const abvHit = keyHits.find(
          (r) => r.abv != null && Math.abs(r.abv - abv) <= ABV_TOLERANCE,
        );
        if (abvHit) return { kind: 'matched', result: abvHit };
      }
      return { kind: 'matched', result: keyHits[0] };
    }

    // Stage 2b: name fuzzy >= 0.85.
    const searcher = new Searcher(breweryPassed, {
      keySelector: (r) => normalizeName(r.beer_name),
      threshold: NAME_FUZZY_THRESHOLD,
      returnMatchData: true,
    });
    const matches = searcher.search(targetName);
    if (matches.length === 0) continue;

    const topScore = matches[0].score;
    if (abv != null) {
      const abvHit = matches.find(
        (m) =>
          m.score === topScore &&
          m.item.abv != null &&
          Math.abs(m.item.abv - abv) <= ABV_TOLERANCE,
      );
      if (abvHit) return { kind: 'matched', result: abvHit.item };
    }

    return { kind: 'matched', result: matches[0].item };
  }

  return { kind: 'not_found', searchUrls: triedUrls, candidates: seenCandidates };
```

> Note: this preserves the existing Stage 1 / 2a / 2b logic verbatim; the only additions are `triedUrls`/`seenCandidates` accumulation, the `searchUrl` on the two `blocked` returns, and the fields on the final `not_found`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/domain/untappd-lookup.test.ts`
Expected: PASS (new diagnostics tests + all pre-existing lookup tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "feat(enrich): lookupBeer returns searchUrls+candidates (not_found) / searchUrl (blocked)"
```

---

## Task 4: Log failures in `applyLookupOutcome` (both channels)

**Files:**
- Modify: `src/domain/lookup-outcome.ts`
- Modify: `src/api/routes/enrich.ts:76`
- Modify: `src/jobs/untappd-enrich.ts:39`
- Test: `src/domain/lookup-outcome.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/domain/lookup-outcome.test.ts`:

```typescript
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { normalizeName, normalizeBrewery } from './normalize';
import { applyLookupOutcome } from './lookup-outcome';
import type { LookupOutcome } from './untappd-lookup';
import type { SearchResult } from '../sources/untappd/search';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  return { db, id, log: pino({ level: 'silent' }) };
}
const input = { brewery: 'Track', name: 'Taking Shape' };
const cand = (over: Partial<SearchResult>): SearchResult => ({
  bid: 1, beer_name: 'Some Beer', brewery_name: 'Some Brewery', style: null, abv: null, global_rating: null, ...over,
});
const failRow = (db: any, id: number) =>
  db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id);

describe('applyLookupOutcome failure logging', () => {
  test('not_found records a failure row with candidate summary', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = {
      kind: 'not_found',
      searchUrls: ['https://untappd.com/search?q=Track+Taking+Shape&type=beer'],
      candidates: [cand({ brewery_name: 'Track Brewing', beer_name: 'Taking Shape XPA' })],
    };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    const row = failRow(db, id);
    expect(row).toMatchObject({ outcome: 'not_found', candidates_count: 1, fail_count: 1 });
    expect(row.candidates_summary).toContain('Track Brewing — Taking Shape XPA');
    expect(row.search_url).toContain('Track+Taking+Shape');
  });

  test('blocked records a failure row with zero candidates', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'https://untappd.com/search?q=Track&type=beer' };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toMatchObject({ outcome: 'blocked', candidates_count: 0 });
  });

  test('matched clears any prior failure row', () => {
    const { db, id, log } = fresh();
    applyLookupOutcome({ db, log }, id,
      { kind: 'not_found', searchUrls: ['u'], candidates: [] }, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toBeDefined();
    applyLookupOutcome({ db, log }, id,
      { kind: 'matched', result: cand({ bid: 999 }) }, '2026-06-11T01:00:00Z', input);
    expect(failRow(db, id)).toBeUndefined();
    expect(getBeer(db, id)?.untappd_id).toBe(999);
  });

  test('transient does not record a failure', () => {
    const { db, id, log } = fresh();
    applyLookupOutcome({ db, log }, id,
      { kind: 'transient', error: new Error('x') }, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/domain/lookup-outcome.test.ts`
Expected: FAIL — `applyLookupOutcome` takes 4 args (no `input`) and does not touch `enrich_failures`.

- [ ] **Step 3: Implement the logging + summary helper**

In `src/domain/lookup-outcome.ts`, update imports (add the failure store + `SearchResult`):

```typescript
import {
  mergeIntoCanonical,
  recordLookupNotFound,
  recordLookupSuccess,
  recordLookupTransient,
} from '../storage/beers';
import { recordEnrichFailure, clearEnrichFailure } from '../storage/enrich_failures';
import type { LookupOutcome } from './untappd-lookup';
import type { SearchResult } from '../sources/untappd/search';
```

Add the summary helper above `applyLookupOutcome`:

```typescript
// Compact, human-readable summary of what the Untappd search returned — top 3
// "<brewery> — <name>". Empty string when the search returned nothing (a noisy query).
function summarizeCandidates(candidates: SearchResult[]): string {
  return candidates.slice(0, 3).map((r) => `${r.brewery_name} — ${r.beer_name}`).join('; ');
}
```

Change the signature to accept the raw input and rewrite the body so `not_found`/`blocked` upsert a failure row and `matched` clears it:

```typescript
export function applyLookupOutcome(
  deps: { db: DB; log: pino.Logger },
  beerId: number,
  outcome: LookupOutcome,
  nowIso: string,
  input: { brewery: string; name: string },
): EnrichOutcomeKind {
  switch (outcome.kind) {
    case 'matched':
      try {
        recordLookupSuccess(deps.db, beerId, outcome.result);
        clearEnrichFailure(deps.db, beerId);
        return 'matched';
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
        const canonical = deps.db
          .prepare('SELECT id FROM beers WHERE untappd_id = ?')
          .get(outcome.result.bid) as { id: number } | undefined;
        if (canonical) {
          // mergeIntoCanonical deletes the orphan row → its enrich_failures row
          // is CASCADE-removed; this is a success, not a failure.
          mergeIntoCanonical(deps.db, beerId, canonical.id);
          deps.log.warn(
            { beerId, canonicalId: canonical.id, bid: outcome.result.bid },
            'enrich: merged duplicate orphan into canonical',
          );
        }
        return 'not_found';
      }
    case 'not_found':
      recordEnrichFailure(deps.db, {
        beer_id: beerId,
        brewery: input.brewery,
        name: input.name,
        search_url: outcome.searchUrls[0] ?? '',
        outcome: 'not_found',
        candidates_count: outcome.candidates.length,
        candidates_summary: summarizeCandidates(outcome.candidates),
        at: nowIso,
      });
      recordLookupNotFound(deps.db, beerId, nowIso);
      return 'not_found';
    case 'transient':
      deps.log.warn({ err: outcome.error, beerId }, 'untappd-lookup transient failure');
      recordLookupTransient(deps.db, beerId, nowIso);
      return 'transient';
    case 'blocked':
      recordEnrichFailure(deps.db, {
        beer_id: beerId,
        brewery: input.brewery,
        name: input.name,
        search_url: outcome.searchUrl,
        outcome: 'blocked',
        candidates_count: 0,
        candidates_summary: '',
        at: nowIso,
      });
      return 'blocked';
  }
}
```

- [ ] **Step 4: Update the two callers**

In `src/api/routes/enrich.ts`, change the `applyLookupOutcome` call (~line 76) to pass the request input:

```typescript
    const kind = applyLookupOutcome({ db: deps.db, log: deps.log }, row.id, outcome, nowIso, { brewery, name });
```

In `src/jobs/untappd-enrich.ts`, change the final call (~line 39):

```typescript
  return applyLookupOutcome(deps, beerId, outcome, nowIso, { brewery: beer.brewery, name: beer.name });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/domain/lookup-outcome.test.ts src/api/routes/enrich.test.ts src/jobs`
Expected: PASS (new logging tests + existing enrich/cron tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts src/api/routes/enrich.ts src/jobs/untappd-enrich.ts
git commit -m "feat(enrich): log not_found/blocked to enrich_failures, clear on match (both channels)"
```

---

## Task 5: Spec sync + full suite

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Update `spec.md`**

- §3: add a `3.x enrich_failures` table subsection (columns per the design doc: `beer_id` PK→beers CASCADE, `brewery`, `name`, `search_url`, `outcome` CHECK in (`not_found`,`blocked`), `candidates_count`, `candidates_summary`, `fail_count`, `last_at`); add a v10 row to the §3.15 migration-history table: `| 10 | enrich_failures (orphan enrich-failure logging) |`.
- §4 (`/enrich/*` + background jobs): note that `not_found`/`blocked` outcomes upsert an `enrich_failures` row (one per beer, both channels via `applyLookupOutcome`), carrying input + `search_url` + candidate summary, self-cleared on `matched`. Untappd search is cookieless-reproducible, so the `search_url` suffices to debug.
- §5.2: clarify the "block never mutates backoff" invariant still holds — logging a `blocked` failure row does not touch `untappd_lookup_*`.

- [ ] **Step 2: Run the full suite + typecheck**

Run: `npx jest && npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document enrich_failures table (v10) + orphan-failure logging"
```

---

## Done criteria
- All Jest suites green; typecheck clean.
- `not_found`/`blocked` from either channel produce/refresh an `enrich_failures` row; `matched` clears it; `transient` does not log.
- Migration v10 idempotent; `enrich_failures` CASCADE-deletes with its beer.

## Out of scope / follow-ups
- `/orphans` bot command over the table (trivial add later).
- Logging `matched`/`transient`; storing HTML.
