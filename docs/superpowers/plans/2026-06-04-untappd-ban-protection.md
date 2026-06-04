# Untappd Ban / Session Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Untappd blocks (403/429 or captcha) on the non-cookie lookup path, alert the admin, and trip an in-memory circuit breaker that pauses `enrichOrphans`/`refreshTapRatings` — without ever mislabeling a block as `not_found`/`transient`.

**Architecture:** A typed `HttpError` exposes the status code; pure `isBlockStatus`/`isBlockPage` detectors classify blocks; a pure in-memory `createCircuitBreaker` (6h cooldown, half-open probe) holds state across the 3h job ticks. `lookupBeer`/`enrichOneOrphan` gain a `blocked` outcome that records nothing. The two lookup jobs gate on a shared breaker passed from `index.ts`, which fires Ukrainian trip/recovery admin alerts.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, cheerio, node-cron, pino, Jest. No DB changes, no env.

**Spec:** `docs/superpowers/specs/2026-06-04-untappd-ban-protection-design.md`

---

### Task 1: Typed `HttpError` in the http client

**Files:**
- Modify: `src/sources/http.ts`
- Test: `src/sources/http.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/sources/http.test.ts`:

```ts
test('throws HttpError carrying the status on a non-ok response', async () => {
  const { HttpError } = await import('./http');
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl });
  await expect(http.get('https://untappd.com/search?q=x')).rejects.toMatchObject({
    name: 'HttpError', status: 403,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sources/http.test.ts -t HttpError`
Expected: FAIL — `HttpError` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/sources/http.ts`, add the class next to `CookieExpiredError`:

```ts
export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}
```

Then replace the two generic throws in `get()`:

```ts
        if (res.status >= 300 && res.status < 400) {
          if (opts.redirect === 'manual') throw new CookieExpiredError();
          throw new HttpError(res.status, url);
        }
        if (!res.ok) throw new HttpError(res.status, url);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/sources/http.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/sources/http.ts src/sources/http.test.ts
git commit -m "feat(http): typed HttpError carrying status code"
```

---

### Task 2: Block detectors

**Files:**
- Create: `src/sources/untappd/block.ts`
- Test: `src/sources/untappd/block.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sources/untappd/block.test.ts`:

```ts
import { isBlockStatus, isBlockPage } from './block';

test('isBlockStatus: 403/429 true, others false', () => {
  expect(isBlockStatus(403)).toBe(true);
  expect(isBlockStatus(429)).toBe(true);
  expect(isBlockStatus(404)).toBe(false);
  expect(isBlockStatus(500)).toBe(false);
  expect(isBlockStatus(200)).toBe(false);
});

test('isBlockPage: cloudflare challenge markers → true', () => {
  expect(isBlockPage('<title>Just a moment...</title>')).toBe(true);
  expect(isBlockPage('<div class="cf-browser-verification">x</div>')).toBe(true);
  expect(isBlockPage('<h1>Attention Required! | Cloudflare</h1>')).toBe(true);
  expect(isBlockPage('<p>Please enable JavaScript and cookies to continue</p>')).toBe(true);
});

test('isBlockPage: normal & zero-result search pages → false', () => {
  expect(isBlockPage('<html><body><div class="beer-item" data-bid="1"></div></body></html>')).toBe(false);
  expect(isBlockPage('<html><body><p>No beers found</p></body></html>')).toBe(false);
  expect(isBlockPage('')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sources/untappd/block.test.ts`
Expected: FAIL — cannot find module `./block`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sources/untappd/block.ts`:

```ts
export function isBlockStatus(status: number): boolean {
  return status === 403 || status === 429;
}

// Narrow, Cloudflare-specific markers with near-zero overlap with normal
// Untappd content, so a genuine zero-result search page is NOT a block.
const BLOCK_MARKERS = [
  'just a moment',
  'cf-browser-verification',
  'cf-challenge',
  'attention required',
  'enable javascript and cookies to continue',
];

export function isBlockPage(html: string): boolean {
  const h = html.toLowerCase();
  return BLOCK_MARKERS.some((m) => h.includes(m));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/sources/untappd/block.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/block.ts src/sources/untappd/block.test.ts
git commit -m "feat(untappd): isBlockStatus/isBlockPage detectors"
```

---

### Task 3: Circuit breaker (pure)

**Files:**
- Create: `src/domain/untappd-circuit.ts`
- Test: `src/domain/untappd-circuit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/untappd-circuit.test.ts`:

```ts
import { createCircuitBreaker } from './untappd-circuit';

function mk() {
  const events: string[] = [];
  const cb = createCircuitBreaker({
    cooldownMs: 6 * 3600_000,
    onTrip: () => events.push('trip'),
    onRecover: () => events.push('recover'),
  });
  return { cb, events };
}
const T0 = new Date('2026-06-04T00:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);

test('trips on block: open, canAttempt false within cooldown, single onTrip', () => {
  const { cb, events } = mk();
  expect(cb.canAttempt(at(0))).toBe(true);
  cb.onResult(true, at(0));
  expect(cb.state).toBe('open');
  expect(cb.canAttempt(at(1))).toBe(false);
  expect(events).toEqual(['trip']);
});

test('promotes to half_open after cooldown and recovers on probe success', () => {
  const { cb, events } = mk();
  cb.onResult(true, at(0));
  expect(cb.canAttempt(at(6))).toBe(true);
  expect(cb.state).toBe('half_open');
  cb.onResult(false, at(6));
  expect(cb.state).toBe('closed');
  expect(events).toEqual(['trip', 'recover']);
});

test('failed probe re-opens without a second trip alert', () => {
  const { cb, events } = mk();
  cb.onResult(true, at(0));
  cb.canAttempt(at(6));        // → half_open
  cb.onResult(true, at(6));    // re-open, no trip
  expect(cb.state).toBe('open');
  expect(events).toEqual(['trip']);
  expect(cb.canAttempt(at(7))).toBe(false); // cooldown restarted at 6h
});

test('success while closed is a no-op (no recover)', () => {
  const { cb, events } = mk();
  cb.onResult(false, at(0));
  expect(cb.state).toBe('closed');
  expect(events).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/untappd-circuit.test.ts`
Expected: FAIL — cannot find module `./untappd-circuit`.

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/untappd-circuit.ts`:

```ts
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreaker {
  canAttempt(now: Date): boolean;
  onResult(blocked: boolean, now: Date): void;
  readonly state: CircuitState;
}

export interface CircuitOptions {
  cooldownMs: number;
  onTrip: () => void;
  onRecover: () => void;
}

export function createCircuitBreaker(opts: CircuitOptions): CircuitBreaker {
  let state: CircuitState = 'closed';
  let openedAt = 0;

  return {
    get state() { return state; },
    canAttempt(now: Date): boolean {
      if (state === 'open' && now.getTime() - openedAt >= opts.cooldownMs) {
        state = 'half_open';
      }
      return state !== 'open';
    },
    onResult(blocked: boolean, now: Date): void {
      if (blocked) {
        if (state === 'closed') opts.onTrip();
        state = 'open';
        openedAt = now.getTime();
      } else {
        if (state !== 'closed') opts.onRecover();
        state = 'closed';
        openedAt = 0;
      }
    },
  };
}

// No-op breaker: always attempts, never alerts. Default when a job is called
// without a breaker (existing tests / non-gated callers).
export const noopBreaker: CircuitBreaker = {
  canAttempt: () => true,
  onResult: () => {},
  state: 'closed',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/untappd-circuit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-circuit.ts src/domain/untappd-circuit.test.ts
git commit -m "feat(domain): in-memory Untappd circuit breaker"
```

---

### Task 4: `lookupBeer` blocked outcome

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Test: `src/domain/untappd-lookup.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/domain/untappd-lookup.test.ts` (inside the existing `describe('lookupBeer', …)` block, before its closing `});`):

```ts
  test('blocked: HttpError 403 → blocked (not transient)', async () => {
    const { HttpError } = await import('../sources/http');
    const fetch = jest.fn(async () => { throw new HttpError(403, 'u'); });
    const out = await lookupBeer({ brewery: 'X', name: 'Y', fetch });
    expect(out.kind).toBe('blocked');
  });

  test('blocked: captcha page → blocked (not not_found)', async () => {
    const fetch = jest.fn(async () => '<title>Just a moment...</title>');
    const out = await lookupBeer({ brewery: 'X', name: 'Y', fetch });
    expect(out.kind).toBe('blocked');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/untappd-lookup.test.ts -t blocked`
Expected: FAIL — `out.kind` is `transient` / `not_found`, not `blocked`.

- [ ] **Step 3: Write minimal implementation**

In `src/domain/untappd-lookup.ts`, add imports at the top (after the existing imports):

```ts
import { HttpError } from '../sources/http';
import { isBlockStatus, isBlockPage } from '../sources/untappd/block';
```

Extend the outcome union:

```ts
export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found' }
  | { kind: 'transient'; error: unknown }
  | { kind: 'blocked' };
```

In the `for (const part of parts)` loop, change the fetch try/catch and add the
page check before `parseSearchPage`:

```ts
    let html: string;
    try {
      html = await fetch(buildSearchUrl(`${stripBreweryNoise(part)} ${name}`.trim()));
    } catch (error) {
      if (error instanceof HttpError && isBlockStatus(error.status)) {
        return { kind: 'blocked' };
      }
      return { kind: 'transient', error };
    }

    if (isBlockPage(html)) return { kind: 'blocked' };

    const results = parseSearchPage(html);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/untappd-lookup.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "feat(lookup): classify 403/429 and captcha pages as blocked"
```

---

### Task 5: `enrichOneOrphan` propagates blocked, records nothing

**Files:**
- Modify: `src/jobs/untappd-enrich.ts`
- Test: `src/jobs/untappd-enrich.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/untappd-enrich.test.ts`:

```ts
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { HttpError, type Http } from '../sources/http';
import { enrichOneOrphan } from './untappd-enrich';

test('blocked: returns "blocked" and records nothing (no backoff mutation)', async () => {
  const db = openDb(':memory:'); migrate(db);
  const id = upsertBeer(db, {
    untappd_id: null, name: 'A', brewery: 'X', style: null, abv: null,
    rating_global: null, normalized_name: 'a', normalized_brewery: 'x',
  });
  const http: Http = { get: async () => { throw new HttpError(403, 'u'); } };
  const kind = await enrichOneOrphan(
    { db, log: pino({ level: 'silent' }), http, now: () => new Date('2026-06-04T00:00:00Z') },
    id,
  );
  expect(kind).toBe('blocked');
  const row = getBeer(db, id);
  expect(row?.untappd_lookup_count).toBe(0);
  expect(row?.untappd_lookup_at).toBeNull();
});
```

(If `untappd-enrich.test.ts` already imports some of these symbols, merge rather
than duplicate the import lines.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/untappd-enrich.test.ts -t blocked`
Expected: FAIL — type error / returns `transient` and mutates backoff.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/untappd-enrich.ts`, extend the kind union:

```ts
export type EnrichOutcomeKind = 'matched' | 'not_found' | 'transient' | 'skipped' | 'blocked';
```

In the `switch (outcome.kind)`, add a case that records nothing:

```ts
    case 'blocked':
      return 'blocked';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/jobs/untappd-enrich.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/untappd-enrich.ts src/jobs/untappd-enrich.test.ts
git commit -m "feat(enrich): propagate blocked outcome without recording state"
```

---

### Task 6: `enrichOrphans` breaker gating

**Files:**
- Modify: `src/jobs/enrich-orphans.ts`
- Test: `src/jobs/enrich-orphans.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/enrich-orphans.test.ts` (self-contained helpers; merge any
duplicate imports):

```ts
import { createCircuitBreaker } from '../domain/untappd-circuit';
import { HttpError } from '../sources/http';
import { upsertBeer } from '../storage/beers';
import { openDb as _openDb } from '../storage/db';
import { migrate as _migrate } from '../storage/schema';
import pino from 'pino';

const log = pino({ level: 'silent' });
function dbWithOrphans(n: number) {
  const db = _openDb(':memory:'); _migrate(db);
  for (let k = 0; k < n; k++) {
    upsertBeer(db, {
      untappd_id: null, name: `N${k}`, brewery: `B${k}`, style: null, abv: null,
      rating_global: null, normalized_name: `n${k}`, normalized_brewery: `b${k}`,
    });
  }
  return db;
}
const T = new Date('2026-06-04T00:00:00Z');

test('breaker open → run skipped, ZERO result', async () => {
  const db = dbWithOrphans(2);
  const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {} });
  breaker.onResult(true, T); // open
  const http = { get: jest.fn(async () => '<html></html>') };
  const res = await enrichOrphans({ db, log, http, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 3600_000) });
  expect(res.processed).toBe(0);
  expect(http.get).not.toHaveBeenCalled();
});

test('block mid-run → trips breaker and stops', async () => {
  const db = dbWithOrphans(3);
  const events: string[] = [];
  const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => events.push('trip'), onRecover: () => {} });
  const http = { get: async () => { throw new HttpError(403, 'u'); } };
  const res = await enrichOrphans({ db, log, http, breaker, sleepMs: 0, now: () => T });
  expect(res.blocked).toBe(1);
  expect(res.processed).toBe(1);
  expect(breaker.state).toBe('open');
  expect(events).toEqual(['trip']);
});

test('half-open probe success → recovers and continues', async () => {
  const db = dbWithOrphans(2);
  const events: string[] = [];
  const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => events.push('trip'), onRecover: () => events.push('recover') });
  breaker.onResult(true, T); // open
  const http = { get: async () => '<html></html>' }; // no results → not_found, NOT blocked
  const res = await enrichOrphans({ db, log, http, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 6 * 3600_000) });
  expect(breaker.state).toBe('closed');
  expect(events).toContain('recover');
  expect(res.processed).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/enrich-orphans.test.ts -t breaker`
Expected: FAIL — `breaker` not in deps / `res.blocked` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/enrich-orphans.ts`:

Add imports:

```ts
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';
```

Add `blocked` to the result interface and `ZERO_RESULT`:

```ts
export interface EnrichOrphansResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
  skipped: number;
  blocked: number;
}
```
```ts
const ZERO_RESULT: EnrichOrphansResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0, skipped: 0, blocked: 0,
};
```

Add `breaker?: CircuitBreaker;` to `EnrichOrphansDeps`. Then gate the run and
handle the blocked outcome (replace the candidate loop body):

```ts
  const breaker = deps.breaker ?? noopBreaker;
  if (!breaker.canAttempt(now())) {
    deps.log.info('enrich-orphans skipped (untappd circuit open)');
    return { ...ZERO_RESULT };
  }

  const candidates = listLookupCandidates(deps.db, limit, now());
  const result: EnrichOrphansResult = { ...ZERO_RESULT };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const kind = await enrichOneOrphan(
      { db: deps.db, log: deps.log, http: deps.http, now },
      c.id,
    );
    if (kind === 'blocked') {
      breaker.onResult(true, now());
      result.blocked++;
      result.processed++;
      break;
    }
    breaker.onResult(false, now());
    result.processed++;
    result[kind]++;

    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/jobs/enrich-orphans.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/enrich-orphans.ts src/jobs/enrich-orphans.test.ts
git commit -m "feat(enrich-orphans): gate on shared Untappd circuit breaker"
```

---

### Task 7: `refreshTapRatings` block detection + breaker gating

**Files:**
- Modify: `src/jobs/refresh-tap-ratings.ts`
- Test: `src/jobs/refresh-tap-ratings.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/refresh-tap-ratings.test.ts` (reuse the file's existing
`fresh`/`seedIdBeerOnTap`/`silentLog` helpers; add imports as needed):

```ts
import { createCircuitBreaker } from '../domain/untappd-circuit';
import { HttpError } from '../sources/http';

test('breaker open → run skipped, no HTTP', async () => {
  const db = fresh();
  seedIdBeerOnTap(db, 'Brew', 'Beer', 100);
  const T = new Date('2026-05-27T12:00:00Z');
  const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {} });
  breaker.onResult(true, T);
  let calls = 0;
  const http = { async get() { calls++; return ''; } };
  const res = await refreshTapRatings({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 3600_000) });
  expect(res.processed).toBe(0);
  expect(calls).toBe(0);
});

test('block (403) → trips breaker, does not record transient', async () => {
  const db = fresh();
  const beerId = seedIdBeerOnTap(db, 'Brew', 'Beer', 100);
  const events: string[] = [];
  const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => events.push('trip'), onRecover: () => {} });
  const http = { async get() { throw new HttpError(429, 'u'); } };
  const res = await refreshTapRatings({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date('2026-05-27T12:00:00Z') });
  expect(res.blocked).toBe(1);
  expect(res.transient).toBe(0);
  expect(breaker.state).toBe('open');
  expect(events).toEqual(['trip']);
  // backoff state untouched
  const { getBeer } = await import('../storage/beers');
  expect(getBeer(db, beerId)?.rating_refresh_count).toBe(0);
});

test('captcha page → blocked, not not_found', async () => {
  const db = fresh();
  seedIdBeerOnTap(db, 'Brew', 'Beer', 100);
  const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {} });
  const http = { async get() { return '<title>Just a moment...</title>'; } };
  const res = await refreshTapRatings({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date('2026-05-27T12:00:00Z') });
  expect(res.blocked).toBe(1);
  expect(res.not_found).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/refresh-tap-ratings.test.ts -t block`
Expected: FAIL — `breaker` not in deps / `res.blocked` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/refresh-tap-ratings.ts`:

Add imports:

```ts
import { HttpError } from '../sources/http';
import { isBlockStatus, isBlockPage } from '../sources/untappd/block';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';
```

Add `blocked` to the result interface and `ZERO_RESULT`:

```ts
export interface RefreshTapRatingsResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
  blocked: number;
}
```
```ts
const ZERO_RESULT: RefreshTapRatingsResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0, blocked: 0,
};
```

Add `breaker?: CircuitBreaker;` to `RefreshTapRatingsDeps`. Gate the run (right
after `now` is resolved, before `listRatingRefreshCandidates`):

```ts
  const breaker = deps.breaker ?? noopBreaker;
  if (!breaker.canAttempt(now())) {
    deps.log.info('refresh-tap-ratings skipped (untappd circuit open)');
    return { ...ZERO_RESULT };
  }
```

Replace the candidate loop body with block-aware handling:

```ts
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const tickNow = now();
    const nowIso = tickNow.toISOString();
    let blocked = false;
    try {
      const html = await deps.http.get(buildBeerPageUrl(c.untappd_id));
      if (isBlockPage(html)) {
        blocked = true;
      } else {
        const { global_rating } = parseBeerPage(html);
        if (global_rating !== null) {
          recordRatingSuccess(deps.db, c.id, global_rating);
          result.matched++;
        } else {
          recordRatingNotFound(deps.db, c.id, nowIso);
          result.not_found++;
        }
      }
    } catch (err) {
      if (err instanceof HttpError && isBlockStatus(err.status)) {
        blocked = true;
      } else {
        deps.log.warn({ err, beerId: c.id, untappdId: c.untappd_id },
          'rating-refresh transient failure');
        recordRatingTransient(deps.db, c.id, nowIso);
        result.transient++;
      }
    }

    if (blocked) {
      breaker.onResult(true, tickNow);
      result.blocked++;
      result.processed++;
      break;
    }
    breaker.onResult(false, tickNow);
    result.processed++;

    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/jobs/refresh-tap-ratings.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-tap-ratings.ts src/jobs/refresh-tap-ratings.test.ts
git commit -m "feat(tap-ratings): block detection + circuit breaker gating"
```

---

### Task 8: Wire one shared breaker in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the import**

After the other job imports (near `src/index.ts:28`), add:

```ts
import { createCircuitBreaker } from './domain/untappd-circuit';
```

- [ ] **Step 2: Create the shared breaker**

In `main()`, after the `notifyAdmin` definition (around line 58) and before the
`const cronJobs = [` array, add:

```ts
  const adminAlert = (msg: string) => { notifyAdmin?.(msg)?.catch(() => {}); };
  const untappdBreaker = createCircuitBreaker({
    cooldownMs: 6 * 60 * 60 * 1000,
    onTrip: () => adminAlert('⚠️ Untappd: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd: доступ відновлено, енрич продовжено.'),
  });
```

- [ ] **Step 3: Pass the breaker to both cron jobs**

In the `enrichOrphans({ … })` cron call, add `breaker: untappdBreaker,`:

```ts
      enrichOrphans({
        db, log, http,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        breaker: untappdBreaker,
      }).catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
```

In the `refreshTapRatings({ … })` cron call, add `breaker: untappdBreaker,`:

```ts
      refreshTapRatings({
        db, log, http,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        breaker: untappdBreaker,
      }).catch((e) => log.error({ err: e }, 'refresh-tap-ratings cron'));
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

(`refreshOntap`'s inline `enrichOneOrphan` is intentionally NOT gated — per spec
scope. Its outcome is only used as `!== 'skipped'`, so the new `'blocked'` kind is
handled gracefully there: it records nothing and just skips its post-lookup sleep
guard once.)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire shared Untappd circuit breaker into lookup crons"
```

---

### Task 9: Spec update — `spec.md`

**Files:**
- Modify: `spec.md` — §4 (jobs note) + §5.2 (business-invariant)

- [ ] **Step 1: Add the breaker note after the jobs table**

In `spec.md`, immediately after the "Startup-джоби" paragraph in §4, add:

```
**Untappd circuit breaker (in-memory).** `enrichOrphans` і `refreshTapRatings`
гейтяться спільним in-memory circuit breaker. Сигнали блокування на non-cookie
шляху — HTTP 403/429 **або** captcha/login-сторінка (Cloudflare-маркери). При
блокуванні breaker відкривається на 6 год (потім half-open probe); джоби в цей
час пропускають запуск. Алерти адміну лише на переходах: trip (`closed→open`) і
recovery (`open→closed`). Стан скидається на рестарті. Cookie-джоба
(`refreshAllUntappd`) не гейтиться — має власний `CookieExpiredError`-шлях.
```

- [ ] **Step 2: Add the business-invariant line in §5.2**

In `spec.md` §5.2 (бізнес-інваріанти), add a bullet:

```
- **Блок ≠ not_found.** Виявлений блок Untappd (403/429/captcha) **ніколи** не
  записується як `not_found`/`transient` і не змінює backoff-стан beer'а — він
  лише трипить circuit breaker. Інакше captcha-вікно тихо «ховає» реальні пива.
```

- [ ] **Step 3: Verify**

Run: `grep -n "circuit breaker\|Блок ≠ not_found" spec.md`
Expected: matches in §4 and §5.2.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document Untappd circuit breaker + block invariant"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx jest`
Expected: all tests pass (existing + the new circuit/block/lookup/job tests).

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to merge / open a PR.

---

## Notes for the implementer

- `Http` is `{ get(url): Promise<string> }` (`src/sources/http.ts`); the new
  `HttpError` is thrown by the real client and by test stubs to simulate 403/429.
- The breaker is **in-memory and shared**: one instance created in `index.ts`,
  passed to both cron jobs. State survives the 3h ticks (same process) and resets
  on restart — by design.
- `breaker` is an **optional** dep defaulting to `noopBreaker`, so the 450+
  existing tests and `refreshOntap`'s inline enrichment are unaffected.
- A `blocked` outcome must NEVER call `recordLookup*`/`recordRating*` — that is the
  whole point (no backoff corruption during a captcha window).
- Do not gate `refreshAllUntappd` or `refreshOntap` — out of scope per the spec.
- No DB migration, no new env. Cooldown is a hardcoded 6h const in `index.ts`.
