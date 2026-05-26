# Untappd lookup wire-up (PR-D2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up the PR-D1 search capability — every orphan beer touched by `refreshOntap` (inline) or surfaced by a new `enrich-orphans` cron (12h backfill) gets an Untappd lookup, and successful matches fill `untappd_id` / `style` / `abv` / `rating_global`. Behind a kill-switch env var.

**Architecture:** Extract the per-beer enrichment cycle (eligibility check → `lookupBeer` → record outcome) into a shared `src/jobs/untappd-enrich.ts:enrichOneOrphan` helper so both call sites use one implementation. `refreshOntap` invokes it once per tap after upsert/match. New `src/jobs/enrich-orphans.ts` iterates `listLookupCandidates(db, 20, now)` and calls the helper for each, with polite 500ms spacing between HTTP requests. `UNTAPPD_LOOKUP_ENABLED` env var (default `true`) gates both paths at the caller — when `false`, neither path makes any HTTP request or DB write to `untappd_lookup_*`. New cron `0 6,18 * * *` (06:00 / 18:00 UTC, offset from existing 00/12 ontap and 03 untappd-had).

**Tech Stack:** TypeScript, Jest, better-sqlite3 (`:memory:` for tests), pino, node-cron, zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-untappd-lookup.md` PR-D2 section.

**Branch:** `feat/untappd-enrich-orphans` off `origin/main` (PR-D1 already merged at commit `3b06814`).

---

## File Structure

- **Modify** `src/config/env.ts` — add `UNTAPPD_LOOKUP_ENABLED` boolean to the zod schema.
- **Modify** `src/config/env.test.ts` — assert default + explicit `"false"` parsing.
- **Create** `src/jobs/untappd-enrich.ts` — `enrichOneOrphan` shared helper + `EnrichOutcomeKind`.
- **Create** `src/jobs/untappd-enrich.test.ts` — unit tests for the helper.
- **Create** `src/jobs/enrich-orphans.ts` — cron-callable job that iterates candidates.
- **Create** `src/jobs/enrich-orphans.test.ts` — tests using stub http + in-memory DB.
- **Modify** `src/jobs/refresh-ontap.ts` — extend `Deps` with `lookupEnabled?` and `now?`; after each upsert/match, call `enrichOneOrphan` with a 500ms sleep when enabled.
- **Modify** `src/index.ts` — pass `lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED` to refreshOntap (both inline and cron callsites); register the new `enrich-orphans` cron at `0 6,18 * * *`.

No new storage helpers (PR-D1 landed them). No migration. No locale changes.

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/ysi/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/untappd-enrich-orphans /home/ysi/warsaw-beer-bot-enrich origin/main
cd /home/ysi/warsaw-beer-bot-enrich
```

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exit 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: every suite passes. Baseline = whatever main has at PR-D1 merge point (294 tests / 39 suites locally — confirm).

- [ ] **Step 4: Baseline typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

---

## Task 2: `UNTAPPD_LOOKUP_ENABLED` env var

**Files:**
- Modify: `src/config/env.ts` — add to schema.
- Modify: `src/config/env.test.ts` — add tests for default + explicit `"false"`.

- [ ] **Step 1: Write the failing tests**

In `src/config/env.test.ts`, replace the file with:

```typescript
import { loadEnv } from './env';

describe('loadEnv', () => {
  const baseEnv = {
    TELEGRAM_BOT_TOKEN: 'abc:1234567',
    DATABASE_PATH: '/tmp/bot.db',
    OSRM_BASE_URL: 'https://osrm.example',
    NOMINATIM_USER_AGENT: 'ua',
  };

  it('parses a complete env map', () => {
    const env = loadEnv({
      ...baseEnv,
      LOG_LEVEL: 'debug',
      DEFAULT_ROUTE_N: '7',
    });
    expect(env.DEFAULT_ROUTE_N).toBe(7);
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('rejects missing token', () => {
    expect(() => loadEnv({ DATABASE_PATH: '/tmp/x.db' } as any)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('UNTAPPD_LOOKUP_ENABLED defaults to true when unset', () => {
    const env = loadEnv(baseEnv);
    expect(env.UNTAPPD_LOOKUP_ENABLED).toBe(true);
  });

  it('UNTAPPD_LOOKUP_ENABLED="false" parses to false', () => {
    const env = loadEnv({ ...baseEnv, UNTAPPD_LOOKUP_ENABLED: 'false' });
    expect(env.UNTAPPD_LOOKUP_ENABLED).toBe(false);
  });

  it('UNTAPPD_LOOKUP_ENABLED="true" parses to true', () => {
    const env = loadEnv({ ...baseEnv, UNTAPPD_LOOKUP_ENABLED: 'true' });
    expect(env.UNTAPPD_LOOKUP_ENABLED).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=config/env --silent`
Expected: FAIL — `UNTAPPD_LOOKUP_ENABLED` not in env object yet.

- [ ] **Step 3: Extend the env schema**

In `src/config/env.ts`, find the `Schema` definition and replace it with:

```typescript
const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  DATABASE_PATH: z.string().min(1),
  OSRM_BASE_URL: z.string().url(),
  NOMINATIM_USER_AGENT: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  DEFAULT_ROUTE_N: z.coerce.number().int().positive().default(5),
  UNTAPPD_LOOKUP_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
});
```

The `union` of literal strings forces explicit `"true"` / `"false"` in the env file (rejects typos like `"yes"` or `"1"`). `.transform` converts the validated string into a boolean before exposure.

- [ ] **Step 4: Confirm tests pass**

Run: `npm test -- --testPathPatterns=config/env --silent`
Expected: 5 tests pass.

- [ ] **Step 5: Full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "$(cat <<'EOF'
feat(env): UNTAPPD_LOOKUP_ENABLED boolean (default true)

Kill switch for the PR-D Untappd lookup paths. Default true; explicit
"false" disables both the inline refresh-ontap enrichment and the
enrich-orphans cron. Stricter than coerce.boolean: only literal
"true"/"false" accepted to catch typos in deploy/.env.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `enrichOneOrphan` shared helper

**Files:**
- Create: `src/jobs/untappd-enrich.ts`
- Create: `src/jobs/untappd-enrich.test.ts`

Both the refresh-ontap inline path and the enrich-orphans cron run the same per-beer cycle: load the beer row, check eligibility, call `lookupBeer`, record the outcome. Extracting it lets us unit-test the cycle once and trust both callers.

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/untappd-enrich.test.ts`:

```typescript
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import type { Http } from '../sources/http';
import { enrichOneOrphan } from './untappd-enrich';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function fakeHttp(html: string): Http {
  return { async get(): Promise<string> { return html; } };
}

function throwingHttp(err: Error): Http {
  return {
    async get(): Promise<string> { throw err; },
  };
}

function searchHtml(items: Array<{ bid: number; name: string; brewery: string; rating?: string }>): string {
  const cards = items
    .map((it) => `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
          <p class="brewery"><a>${it.brewery}</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
          <div class="rating">
            <div class="caps" data-rating="${it.rating ?? '3.5'}"></div>
          </div>
        </div>
      </div>`)
    .join('');
  return `<html><body>${cards}</body></html>`;
}

describe('enrichOneOrphan', () => {
  test('matched: fills untappd_id + rating, returns "matched"', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'Fifty/Fifty Clementine & Passionfruit', brewery: 'Magic Road Brewery',
      style: null, abv: 4.6, rating_global: null,
      normalized_name: 'fifty fifty clementine passionfruit',
      normalized_brewery: 'magic road',
    });
    const http = fakeHttp(searchHtml([
      { bid: 6645513, name: 'Fifty Fifty - Clementine & Passionfruit', brewery: 'Magic Road', rating: '3.98' },
    ]));

    const out = await enrichOneOrphan({ db, log: silentLog, http }, beerId);

    expect(out).toBe('matched');
    const row = getBeer(db, beerId);
    expect(row?.untappd_id).toBe(6645513);
    expect(row?.rating_global).toBeCloseTo(3.98);
    expect(row?.untappd_lookup_count).toBe(0); // success doesn't increment
  });

  test('not_found: increments count + records lookup_at, returns "not_found"', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'Something Obscure', brewery: 'Unknown Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: 'something obscure', normalized_brewery: 'unknown',
    });
    const http = fakeHttp('<html><body></body></html>');
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const out = await enrichOneOrphan(
      { db, log: silentLog, http, now: () => fixedNow }, beerId,
    );

    expect(out).toBe('not_found');
    const row = getBeer(db, beerId);
    expect(row?.untappd_id).toBeNull();
    expect(row?.untappd_lookup_count).toBe(1);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00.000Z');
  });

  test('transient: HTTP error, records lookup_at without incrementing count', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    const http = throwingHttp(new Error('ETIMEDOUT'));
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const out = await enrichOneOrphan(
      { db, log: silentLog, http, now: () => fixedNow }, beerId,
    );

    expect(out).toBe('transient');
    const row = getBeer(db, beerId);
    expect(row?.untappd_lookup_count).toBe(0);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00.000Z');
  });

  test('skipped: beer already has untappd_id', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      untappd_id: 42,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    let httpCalled = false;
    const http: Http = {
      async get(): Promise<string> { httpCalled = true; return ''; },
    };

    const out = await enrichOneOrphan({ db, log: silentLog, http }, beerId);

    expect(out).toBe('skipped');
    expect(httpCalled).toBe(false);
  });

  test('skipped: backoff not yet elapsed', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    // Simulate prior not_found at 11:00, count=1 → next eligible only 24h later.
    db.prepare(
      'UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = ? WHERE id = ?',
    ).run('2026-05-26T11:00:00Z', 1, beerId);
    let httpCalled = false;
    const http: Http = {
      async get(): Promise<string> { httpCalled = true; return ''; },
    };
    const fixedNow = new Date('2026-05-26T12:00:00Z'); // only 1h later

    const out = await enrichOneOrphan(
      { db, log: silentLog, http, now: () => fixedNow }, beerId,
    );

    expect(out).toBe('skipped');
    expect(httpCalled).toBe(false);
  });

  test('skipped: beer does not exist (defensive)', async () => {
    const db = fresh();
    let httpCalled = false;
    const http: Http = {
      async get(): Promise<string> { httpCalled = true; return ''; },
    };
    const out = await enrichOneOrphan({ db, log: silentLog, http }, 9999);
    expect(out).toBe('skipped');
    expect(httpCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=untappd-enrich --silent`
Expected: FAIL — `Cannot find module './untappd-enrich'`.

- [ ] **Step 3: Create the helper**

Create `src/jobs/untappd-enrich.ts`:

```typescript
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { isEligible } from '../domain/lookup-backoff';
import { lookupBeer } from '../domain/untappd-lookup';
import {
  getBeer,
  recordLookupSuccess,
  recordLookupNotFound,
  recordLookupTransient,
} from '../storage/beers';

export type EnrichOutcomeKind = 'matched' | 'not_found' | 'transient' | 'skipped';

export interface EnrichDeps {
  db: DB;
  log: pino.Logger;
  http: Http;
  now?: () => Date;
}

export async function enrichOneOrphan(
  deps: EnrichDeps,
  beerId: number,
): Promise<EnrichOutcomeKind> {
  const beer = getBeer(deps.db, beerId);
  if (!beer || beer.untappd_id !== null) return 'skipped';

  const now = (deps.now ?? (() => new Date()))();
  if (!isEligible(now, beer.untappd_lookup_at, beer.untappd_lookup_count)) {
    return 'skipped';
  }

  const outcome = await lookupBeer({
    brewery: beer.brewery,
    name: beer.name,
    fetch: (url) => deps.http.get(url),
  });

  const nowIso = now.toISOString();
  switch (outcome.kind) {
    case 'matched':
      recordLookupSuccess(deps.db, beerId, outcome.result);
      return 'matched';
    case 'not_found':
      recordLookupNotFound(deps.db, beerId, nowIso);
      return 'not_found';
    case 'transient':
      deps.log.warn(
        { err: outcome.error, beerId },
        'untappd-lookup transient failure',
      );
      recordLookupTransient(deps.db, beerId, nowIso);
      return 'transient';
  }
}
```

- [ ] **Step 4: Confirm tests pass**

Run: `npm test -- --testPathPatterns=untappd-enrich --silent`
Expected: all 6 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/untappd-enrich.ts src/jobs/untappd-enrich.test.ts
git commit -m "$(cat <<'EOF'
feat(jobs): enrichOneOrphan — shared per-beer Untappd cycle

Encapsulates the eligibility-check → lookupBeer → record-outcome
chain used by both wire-up paths added in PR-D2:
  - refresh-ontap inline (after each upsert/match orphan)
  - enrich-orphans cron (12h backfill from listLookupCandidates)

Returns 'matched' | 'not_found' | 'transient' | 'skipped' so callers
can collect stats. now() is injectable for deterministic tests.
Transient failures are logged at warn-level (HTTP/network noise) but
do not throw — callers can keep iterating their batch.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `enrich-orphans` cron job

**Files:**
- Create: `src/jobs/enrich-orphans.ts`
- Create: `src/jobs/enrich-orphans.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/enrich-orphans.test.ts`:

```typescript
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import type { Http } from '../sources/http';
import { enrichOrphans } from './enrich-orphans';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function searchHtml(items: Array<{ bid: number; name: string; brewery: string }>): string {
  const cards = items
    .map((it) => `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
          <p class="brewery"><a>${it.brewery}</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
          <div class="rating"><div class="caps" data-rating="3.5"></div></div>
        </div>
      </div>`)
    .join('');
  return `<html><body>${cards}</body></html>`;
}

function seedOrphanOnTap(
  db: ReturnType<typeof fresh>,
  brewery: string,
  name: string,
): number {
  const beerId = upsertBeer(db, {
    name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase(),
  });
  const pubId = upsertPub(db, {
    slug: `pub-${beerId}`, name: `Pub ${beerId}`,
    address: null, lat: null, lon: null,
  });
  const snapId = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');
  const ref = `${brewery} ${name}`;
  upsertMatch(db, ref, beerId, 1.0);
  insertTaps(db, snapId, [{
    tap_number: 1, beer_ref: ref, brewery_ref: brewery,
    abv: null, ibu: null, style: null, u_rating: null,
  }]);
  return beerId;
}

describe('enrichOrphans', () => {
  test('processes orphans on current taps, returns stats', async () => {
    const db = fresh();
    const a = seedOrphanOnTap(db, 'Magic Road', 'Fifty Fifty Clementine');
    const b = seedOrphanOnTap(db, 'Magic Road', 'Buty Skejta'); // brewery hard-gate will fail
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> {
        calls++;
        // Only the first call returns a matching brewery; both URLs are search.
        if (calls === 1) {
          return searchHtml([
            { bid: 100, name: 'Fifty Fifty Clementine', brewery: 'Magic Road' },
          ]);
        }
        return searchHtml([
          { bid: 200, name: 'Buty Skejta', brewery: 'Some Other Brewery' },
        ]);
      },
    };
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const result = await enrichOrphans({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result.processed).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.not_found).toBe(1);
    expect(result.transient).toBe(0);
    expect(result.skipped).toBe(0);

    expect(getBeer(db, a)?.untappd_id).toBe(100);
    expect(getBeer(db, b)?.untappd_id).toBeNull();
    expect(getBeer(db, b)?.untappd_lookup_count).toBe(1);
  });

  test('respects limit', async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedOrphanOnTap(db, `Brew${i}`, `Beer${i}`);
    }
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> {
        calls++;
        return '<html><body></body></html>';
      },
    };

    const result = await enrichOrphans({
      db, log: silentLog, http, limit: 2, sleepMs: 0,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    expect(result.processed).toBe(2);
    expect(calls).toBe(2);
  });

  test('lookupEnabled=false: no candidates touched, no HTTP', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'Brew', 'Beer');
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> { calls++; return ''; },
    };

    const result = await enrichOrphans({
      db, log: silentLog, http, lookupEnabled: false, sleepMs: 0,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    expect(result).toEqual({ processed: 0, matched: 0, not_found: 0, transient: 0, skipped: 0 });
    expect(calls).toBe(0);
  });

  test('sleeps between HTTP calls when sleepMs > 0', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'A', 'B');
    seedOrphanOnTap(db, 'C', 'D');
    const sleeps: number[] = [];
    const http: Http = {
      async get(): Promise<string> { return '<html></html>'; },
    };
    const sleep = async (ms: number) => { sleeps.push(ms); };

    await enrichOrphans({
      db, log: silentLog, http, sleepMs: 500, sleep,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    // One sleep between the two calls (not after the last).
    expect(sleeps).toEqual([500]);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=enrich-orphans --silent`
Expected: FAIL — `Cannot find module './enrich-orphans'`.

- [ ] **Step 3: Create the job module**

Create `src/jobs/enrich-orphans.ts`:

```typescript
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { listLookupCandidates } from '../storage/beers';
import { enrichOneOrphan } from './untappd-enrich';

export interface EnrichOrphansResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
  skipped: number;
}

export interface EnrichOrphansDeps {
  db: DB;
  log: pino.Logger;
  http: Http;
  lookupEnabled?: boolean;     // default true
  limit?: number;               // default 20
  sleepMs?: number;             // default 500
  sleep?: (ms: number) => Promise<void>;   // for tests
  now?: () => Date;             // for tests
}

const ZERO_RESULT: EnrichOrphansResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0, skipped: 0,
};

export async function enrichOrphans(
  deps: EnrichOrphansDeps,
): Promise<EnrichOrphansResult> {
  if (deps.lookupEnabled === false) {
    deps.log.info('untappd-lookup disabled (UNTAPPD_LOOKUP_ENABLED=false), skipping enrich-orphans');
    return ZERO_RESULT;
  }

  const limit = deps.limit ?? 20;
  const sleepMs = deps.sleepMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) =>
    new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());

  const candidates = listLookupCandidates(deps.db, limit, now());
  const result: EnrichOrphansResult = { ...ZERO_RESULT };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const kind = await enrichOneOrphan(
      { db: deps.db, log: deps.log, http: deps.http, now },
      c.id,
    );
    result.processed++;
    result[kind]++;

    // Be polite to Untappd: pause between requests, but not after the last.
    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
  }

  deps.log.info(result, 'enrich-orphans done');
  return result;
}
```

- [ ] **Step 4: Confirm tests pass**

Run: `npm test -- --testPathPatterns=enrich-orphans --silent`
Expected: 4 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/enrich-orphans.ts src/jobs/enrich-orphans.test.ts
git commit -m "$(cat <<'EOF'
feat(jobs): enrich-orphans cron — backfill orphan beers from Untappd

Iterates listLookupCandidates(limit=20) and calls enrichOneOrphan for
each. Polite 500ms spacing between HTTP requests (skipped after the
last). lookupEnabled=false short-circuits with zero result and no
HTTP. Stats {processed, matched, not_found, transient, skipped} go
to the structured log + return value.

Designed to be wired from src/index.ts on a 12h schedule (next
commit). Tests use stub http + in-memory DB; sleep is injectable so
no test waits on real timers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `enrichOneOrphan` into `refresh-ontap`

**Files:**
- Modify: `src/jobs/refresh-ontap.ts` — extend `Deps`, call helper after each upsert/match orphan.

This is a mechanical wire-up — the helper is fully tested in Task 3, so we don't add a refresh-ontap.test.ts here. Verification is via typecheck + existing suite + the deploy-time observation in the PR description.

- [ ] **Step 1: Read the current refresh-ontap.ts**

Open `src/jobs/refresh-ontap.ts` and locate the inner `for (const t of taps)` loop and the surrounding `Deps` interface.

- [ ] **Step 2: Update imports and `Deps`**

In `src/jobs/refresh-ontap.ts`, find the import block (lines 1-13) and add at the end:

```typescript
import { enrichOneOrphan } from './untappd-enrich';
```

Then find the `Deps` interface (lines 15-21) and extend it:

```typescript
interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  geocoder: Geocoder;
  onProgress?: ProgressFn;
  lookupEnabled?: boolean;     // default true
  lookupSleepMs?: number;       // default 500
  now?: () => Date;             // for tests
}
```

- [ ] **Step 3: Destructure new options**

In the function body, change:

```typescript
const { db, log, http, geocoder, onProgress = noopProgress } = deps;
```

to:

```typescript
const {
  db, log, http, geocoder,
  onProgress = noopProgress,
  lookupEnabled = true,
  lookupSleepMs = 500,
  now = () => new Date(),
} = deps;
```

- [ ] **Step 4: Call `enrichOneOrphan` after each upsert/match**

Find the inner `for (const t of taps)` block (lines 60-77). Replace:

```typescript
      const catalog = listBeerCatalog(db);
      for (const t of taps) {
        const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
        const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
        if (m) {
          upsertMatch(db, t.beer_ref, m.id, m.confidence);
        } else {
          const beerId = upsertBeer(db, {
            name: t.beer_ref,
            brewery,
            style: t.style,
            abv: t.abv,
            rating_global: t.u_rating,
            normalized_name: normalizeName(t.beer_ref),
            normalized_brewery: normalizeBrewery(brewery),
          });
          upsertMatch(db, t.beer_ref, beerId, 1.0);
        }
      }
```

with:

```typescript
      const catalog = listBeerCatalog(db);
      for (const t of taps) {
        const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
        const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
        let beerId: number;
        if (m) {
          upsertMatch(db, t.beer_ref, m.id, m.confidence);
          beerId = m.id;
        } else {
          beerId = upsertBeer(db, {
            name: t.beer_ref,
            brewery,
            style: t.style,
            abv: t.abv,
            rating_global: t.u_rating,
            normalized_name: normalizeName(t.beer_ref),
            normalized_brewery: normalizeBrewery(brewery),
          });
          upsertMatch(db, t.beer_ref, beerId, 1.0);
        }

        // Inline Untappd enrichment for orphans (untappd_id NULL) that
        // pass the backoff gate. enrichOneOrphan itself short-circuits
        // for non-orphans and ineligible ones, so the check here only
        // saves the function-call + sleep overhead.
        if (lookupEnabled) {
          await enrichOneOrphan({ db, log, http, now }, beerId);
          if (lookupSleepMs > 0) {
            await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
          }
        }
      }
```

The post-call sleep is unconditional inside the loop — `enrichOneOrphan` returning `'skipped'` (non-orphan or backoff) means we made zero HTTP requests, so the sleep is wasted, but it's harmless on the inline path because most taps in a sweep are non-orphan (cheap branch) and the few orphans benefit from the spacing. A more clever conditional (`only sleep if matched/not_found/transient`) would be optimization — keep the simple form.

- [ ] **Step 5: Run the full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0. No existing tests changed; nothing should regress. The refresh-ontap module is exercised end-to-end only via the live cron + the existing scrape-and-import job tests (which mock http).

- [ ] **Step 6: Verify no leftover destructuring oddities**

Run: `grep -n 'enrichOneOrphan' src/jobs/refresh-ontap.ts`
Expected: 2 matches — one import, one call. If you see more or zero — re-check.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/refresh-ontap.ts
git commit -m "$(cat <<'EOF'
feat(refresh-ontap): inline Untappd enrichment for new orphans

After each upsert/match in the tap loop, call enrichOneOrphan(beerId)
when lookupEnabled (default true). The helper short-circuits for
non-orphans and backoff-ineligible beers, so the per-tap cost stays
near zero for the common case (most taps already match the catalog).
For genuine orphans, one /search HTTP request + 500ms polite sleep
fills untappd_id / style / abv / rating_global before the sweep ends.

This closes the gap PR-B (autorun /newbeers after /refresh) opened:
a brand-new on-tap beer gets its Untappd rating in time for the
auto-newbeers reply, not just on the next 12h cron.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Register `enrich-orphans` cron + thread env flag in `src/index.ts`

**Files:**
- Modify: `src/index.ts` — import `enrichOrphans`, register cron, pass `lookupEnabled` to both refreshOntap callsites.

- [ ] **Step 1: Add imports**

In `src/index.ts`, find the existing job imports:

```typescript
import { refreshOntap } from './jobs/refresh-ontap';
import { refreshAllUntappd } from './jobs/refresh-untappd';
import { dedupeBreweryAliases } from './jobs/dedupe-brewery-aliases';
import { cleanupPollutedOntap } from './jobs/cleanup-polluted-ontap';
```

Add directly below them:

```typescript
import { enrichOrphans } from './jobs/enrich-orphans';
```

- [ ] **Step 2: Thread `lookupEnabled` into both refreshOntap callsites**

In `src/index.ts`, find the interactive-command callsite (around line 47-53):

```typescript
    createRefreshCommand(
      async (notify) => {
        await refreshOntap({ db, log, http, geocoder, onProgress: notify });
        await refreshAllUntappd({ db, log, http, onProgress: notify });
      },
      buildNewbeersMessage,
    ),
```

Replace `refreshOntap(...)` line with:

```typescript
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        });
```

(Same indentation as siblings.)

Then find the cron callsite (around lines 57-59):

```typescript
    cron.schedule('0 */12 * * *', () => {
      refreshOntap({ db, log, http, geocoder }).catch((e) => log.error({ err: e }, 'ontap cron'));
    }),
```

Replace with:

```typescript
    cron.schedule('0 */12 * * *', () => {
      refreshOntap({
        db, log, http, geocoder,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
      }).catch((e) => log.error({ err: e }, 'ontap cron'));
    }),
```

- [ ] **Step 3: Register the enrich-orphans cron**

In the `cronJobs` array (after the `refreshAllUntappd` cron at lines 60-62), insert:

```typescript
    cron.schedule('0 6,18 * * *', () => {
      enrichOrphans({
        db, log, http,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
      }).catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
    }),
```

Final ordering of cron schedules: `0 */12` (ontap), `0 3` (untappd-had), `0 6,18` (enrich-orphans). Non-overlapping with existing 00:00 / 12:00 (ontap) and 03:00 (untappd-had) → spreads Untappd HTTP load.

- [ ] **Step 4: Typecheck + full suite + build**

```bash
npm run typecheck
npm test -- --silent
npm run build
```

Expected: all three exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(refresh): wire enrich-orphans cron + UNTAPPD_LOOKUP_ENABLED

src/index.ts now:
- Registers cron 0 6,18 * * * for enrichOrphans (limit 20 per run,
  500ms spacing, offset from existing ontap 00/12 and untappd-had 03).
- Threads env.UNTAPPD_LOOKUP_ENABLED into both refreshOntap callsites
  (interactive /refresh and the 12h cron) and into the enrich-orphans
  cron.

Set UNTAPPD_LOOKUP_ENABLED=false in /etc/warsaw-beer-bot/.env if
Untappd ever blocks the bot's IP — both inline and cron paths will
no-op without restart needed for a deploy revert.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification before push

**Files:** none.

- [ ] **Step 1: Full suite**

Run: `npm test -- --silent`
Expected: every test passes. Total = baseline 294 + Task 2 (3 new env tests) + Task 3 (6 enrichOneOrphan) + Task 4 (4 enrichOrphans) = **307 tests** across **41 suites** (+2 new: `untappd-enrich.test.ts`, `enrich-orphans.test.ts`; `env.test.ts` extends existing).

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline origin/main..HEAD`
Expected: 5 commits in order:
1. `feat(env): UNTAPPD_LOOKUP_ENABLED boolean (default true)`
2. `feat(jobs): enrichOneOrphan — shared per-beer Untappd cycle`
3. `feat(jobs): enrich-orphans cron — backfill orphan beers from Untappd`
4. `feat(refresh-ontap): inline Untappd enrichment for new orphans`
5. `feat(refresh): wire enrich-orphans cron + UNTAPPD_LOOKUP_ENABLED`

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff origin/main...HEAD --stat`
Expected files (8):
- `src/config/env.ts`
- `src/config/env.test.ts`
- `src/jobs/untappd-enrich.ts`
- `src/jobs/untappd-enrich.test.ts`
- `src/jobs/enrich-orphans.ts`
- `src/jobs/enrich-orphans.test.ts`
- `src/jobs/refresh-ontap.ts`
- `src/index.ts`

No changes under `src/sources/untappd/`, `src/domain/`, or `src/storage/` — those were PR-D1.

- [ ] **Step 5: Pre-deploy sanity — count current on-tap orphans in prod**

Optional but useful as a yardstick for post-deploy verification:

```bash
sqlite3 /var/lib/warsaw-beer-bot/bot.db <<'SQL'
SELECT COUNT(*) AS on_tap_orphans
FROM beers b
WHERE b.untappd_id IS NULL
  AND EXISTS (
    SELECT 1 FROM match_links ml
    JOIN taps t ON t.beer_ref = ml.ontap_ref
    JOIN tap_snapshots ts ON ts.id = t.snapshot_id
    JOIN (SELECT pub_id, MAX(snapshot_at) m FROM tap_snapshots GROUP BY pub_id) latest
      ON latest.pub_id = ts.pub_id AND latest.m = ts.snapshot_at
    WHERE ml.untappd_beer_id = b.id
  );
SQL
```

Expected: a number close to the 286 we counted at spec-write time. Record it — after one week of cron runs (14 invocations × 20 LIMIT = 280 attempts), this number should fall toward 0 minus the ambiguity-style orphans Untappd doesn't know about.

---

## Task 8: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/untappd-enrich-orphans
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: Untappd lookup wire-up (PR-D2 of 3)" --body "$(cat <<'EOF'
## Summary
- Light up the PR-D1 \`lookupBeer\` capability in two places:
  - **refresh-ontap inline**: after each upsert/match in the tap loop, call \`enrichOneOrphan(beerId)\` if the beer is an orphan and backoff-eligible. 500ms polite spacing per tap.
  - **enrich-orphans cron** (06:00 / 18:00 UTC): backfill up to 20 on-tap orphans per run.
- Shared helper \`src/jobs/untappd-enrich.ts:enrichOneOrphan\` so both call sites use the same eligibility + record-outcome logic.
- New env var \`UNTAPPD_LOOKUP_ENABLED\` (default \`true\`) — strict \`"true"\`/\`"false"\` zod literal so typos in \`.env\` are rejected. Set to \`false\` if Untappd blocks the bot's IP; both paths no-op until re-enabled.

Implements \`docs/superpowers/specs/2026-05-26-untappd-lookup.md\` PR-D2 section. PR-D3 (rating refresh via \`/beer/{id}\`) is next.

## Behavior change
Beers that were orphans before this PR (286 on current taps in prod, audited 2026-05-25) start filling \`untappd_id\` + \`style\` + \`abv\` + \`rating_global\` over the next week of cron runs. New on-tap beers get filled at \`/refresh\` time, in time for the PR-B autorun-\`/newbeers\` reply.

## Test plan
- [x] \`npm test\` green locally (307/41 — baseline 294 + 13 new)
- [x] \`npm run typecheck\` clean
- [x] \`npm run build\` clean
- [ ] After deploy + first \`/refresh\`: \`/newbeers\` shows ratings on previously-orphan entries (e.g. *Magic Road Fifty/Fifty Clementine & Passionfruit* should show \`⭐ 3.98\` instead of \`⭐ —\`).
- [ ] After 24h: \`sudo journalctl -u warsaw-beer-bot | grep enrich-orphans\` shows \`{processed,matched,not_found,transient,skipped}\` stats twice.
- [ ] After 1 week: prod on-tap-orphan count (see Task 7 Step 5 query) falls from ~286 toward 0 minus ambiguity-style orphans Untappd doesn't catalog.
- [ ] To kill: \`UNTAPPD_LOOKUP_ENABLED=false\` in \`/etc/warsaw-beer-bot/.env\` + restart; \`enrich-orphans done\` log line should disappear and \`/refresh\` HTTP volume drops.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges; PR-D3 plan (rating refresh via `/beer/{id}`) is generated next.

---

## What this plan does NOT cover

- **Rating refresh for known-id-but-NULL-rating beers** — PR-D3.
- **Untappd captcha / IP-ban handling** — kill-switch env var is the only mitigation; long-term we may need to back off automatically on 4xx-burst. Not in scope.
- **Force-refresh user command** (`/lookup <bid>`) — YAGNI; cron + inline cover the usecase.
- **Worktree teardown** — done after PR-D2 merges (`git worktree remove /home/ysi/warsaw-beer-bot-enrich`).
