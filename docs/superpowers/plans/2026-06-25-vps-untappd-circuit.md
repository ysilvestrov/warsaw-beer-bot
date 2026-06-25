# VPS-wide Untappd Circuit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure one Untappd block from the VPS pauses every VPS-originated Untappd caller for the existing circuit cooldown.

**Architecture:** Reuse the existing in-memory `CircuitBreaker` and pass the same instance to every server-side Untappd caller. `refreshOntap` keeps scraping ontap.pl while disabling inline Untappd enrich after a block; `refreshAllUntappd` becomes circuit-aware and stops its user loop on block. Extension/browser relay paths remain outside this circuit.

**Tech Stack:** Node.js 20, TypeScript, Vitest, better-sqlite3, pino.

---

## Source Spec

- Design: `docs/superpowers/specs/2026-06-25-vps-untappd-circuit-design.md`
- Master behavior: `spec.md` §5.10

## Execution Setup

Before implementation, use `superpowers:using-git-worktrees` and do the work in an isolated worktree, as required by `AGENTS.md`.

## File Structure

- Modify `src/jobs/refresh-ontap.ts`
  - Accept `breaker?: CircuitBreaker`.
  - Gate inline enrich with `breaker.canAttempt`.
  - Trip breaker and stop only inline enrich on `blocked`.
- Modify `src/jobs/refresh-ontap.test.ts`
  - Add regression tests for inline block and open-circuit skip.
- Modify `src/jobs/refresh-untappd.ts`
  - Accept `breaker?: CircuitBreaker` and optional `now?: () => Date`.
  - Skip whole job while breaker is open.
  - Trip breaker on `HttpError` 403/429 or block-page HTML.
  - Keep `CookieExpiredError` separate from IP-ban circuit.
- Modify `src/jobs/refresh-untappd.test.ts`
  - Add regression tests for open-circuit skip, 403 trip, captcha trip, and cookie expiry separation.
- Modify `src/index.ts`
  - Pass the existing `untappdBreaker` to `refreshOntap` and `refreshAllUntappd` in `/refresh` and cron callsites.
- No schema change.
- No extension/API route change.

---

### Task 1: Make `refreshOntap` Inline Enrich Circuit-Aware

**Files:**
- Modify: `src/jobs/refresh-ontap.test.ts`
- Modify: `src/jobs/refresh-ontap.ts`

- [ ] **Step 1: Add test imports**

In `src/jobs/refresh-ontap.test.ts`, replace:

```ts
import type { Http } from '../sources/http';
```

with:

```ts
import { HttpError, type Http } from '../sources/http';
import { createCircuitBreaker } from '../domain/untappd-circuit';
```

- [ ] **Step 2: Add failing test for inline block stopping later inline Untappd calls**

Append this test inside `describe('refreshOntap multi-city', () => { ... })`, after the existing `inlineEnrichBudget caps enrichment across the run` test:

```ts
  test('inline enrich block trips breaker and disables later inline enrich while ontap continues', async () => {
    const db = openDb(':memory:'); migrate(db);
    const calls: string[] = [];
    const http: Http = {
      async get(url: string): Promise<string> {
        calls.push(url);
        if (url === 'https://ontap.pl/warszawa') return cityIndex('warszawa');
        if (url === 'https://warszawapub.ontap.pl/') {
          return `<html><head><meta property="og:title" content="Budget Pub / ontap.pl"></head>
            <body>
              ${panel(1, 'Foo Brewery', 'Foo Hazy 6%', 'IPA')}
              ${panel(2, 'Bar Brewery', 'Bar Pils 5%', 'Pilsner')}
            </body></html>`;
        }
        if (url.startsWith('https://untappd.com/search')) {
          throw new HttpError(403, url);
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    };
    const events: string[] = [];
    const T = new Date('2026-06-25T12:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });

    await refreshOntap({
      db, log: silentLog, http, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 20, lookupSleepMs: 0,
      breaker, now: () => T,
    });

    expect(beerCount(db)).toBe(2);
    expect(calls.filter((url) => url.startsWith('https://untappd.com/search'))).toHaveLength(1);
    expect(events).toEqual(['trip']);
    expect(breaker.state).toBe('open');
    expect(enrichedCount(db)).toBe(0);
  });
```

- [ ] **Step 3: Add failing test for open breaker skipping inline enrich**

Append this test immediately after the previous one:

```ts
  test('open breaker skips inline enrich without failing ontap refresh', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http, calls } = budgetHttp();
    const T = new Date('2026-06-25T12:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => {},
      onRecover: () => {},
    });
    breaker.onResult(true, T);

    await refreshOntap({
      db, log: silentLog, http, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 20, lookupSleepMs: 0,
      breaker, now: () => new Date(T.getTime() + 3600_000),
    });

    expect(beerCount(db)).toBe(2);
    expect(calls.filter((url) => url.startsWith('https://untappd.com/search'))).toHaveLength(0);
    expect(enrichedCount(db)).toBe(0);
    expect(breaker.state).toBe('open');
  });
```

- [ ] **Step 4: Run the new tests and verify they fail**

Run:

```bash
npx vitest run src/jobs/refresh-ontap.test.ts -t "inline enrich block|open breaker skips"
```

Expected: TypeScript/test failure because `refreshOntap` does not yet accept `breaker`.

- [ ] **Step 5: Import circuit types in `refresh-ontap.ts`**

In `src/jobs/refresh-ontap.ts`, add:

```ts
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';
```

- [ ] **Step 6: Add breaker to `Deps`**

In `src/jobs/refresh-ontap.ts`, update the `Deps` interface:

```ts
  inlineEnrichBudget?: number;  // default 20 — total inline Untappd enriches per run
  breaker?: CircuitBreaker;     // default noopBreaker
```

- [ ] **Step 7: Destructure the breaker**

In `refreshOntap`, update the dependency destructuring:

```ts
    inlineEnrichBudget = 20,
    breaker = noopBreaker,
  } = deps;
```

- [ ] **Step 8: Track whether inline enrich is disabled for this run**

Immediately after:

```ts
  let enrichBudget = inlineEnrichBudget;
```

add:

```ts
  let inlineEnrichStopped = false;
```

- [ ] **Step 9: Replace the inline enrich block**

Replace the current inline enrich block:

```ts
          if (lookupEnabled && isFreshOrphan && enrichBudget > 0) {
            const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
            if (outcome !== 'skipped') {
              enrichBudget--;
              if (lookupSleepMs > 0) {
                await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
              }
            }
          }
```

with:

```ts
          if (
            lookupEnabled &&
            isFreshOrphan &&
            enrichBudget > 0 &&
            !inlineEnrichStopped &&
            breaker.canAttempt(now())
          ) {
            const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
            if (outcome === 'blocked') {
              breaker.onResult(true, now());
              inlineEnrichStopped = true;
              enrichBudget--;
            } else if (outcome !== 'skipped') {
              breaker.onResult(false, now());
              enrichBudget--;
              if (lookupSleepMs > 0) {
                await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
              }
            }
          }
```

This keeps ontap ingest running while stopping further Untappd inline enrich attempts after the first block.

- [ ] **Step 10: Run focused tests**

Run:

```bash
npx vitest run src/jobs/refresh-ontap.test.ts -t "inline enrich block|open breaker skips|inlineEnrichBudget"
```

Expected: all selected tests pass.

- [ ] **Step 11: Commit Task 1**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "fix(untappd): gate ontap inline enrich with circuit"
```

---

### Task 2: Make `refreshAllUntappd` Circuit-Aware

**Files:**
- Modify: `src/jobs/refresh-untappd.test.ts`
- Modify: `src/jobs/refresh-untappd.ts`

- [ ] **Step 1: Add test imports**

In `src/jobs/refresh-untappd.test.ts`, replace:

```ts
import type { Http } from '../sources/http';
```

with:

```ts
import { HttpError, type Http } from '../sources/http';
import { createCircuitBreaker } from '../domain/untappd-circuit';
```

- [ ] **Step 2: Add failing test for open-circuit skip**

Append inside `describe('refreshAllUntappd', () => { ... })`, after `skips profiles with no untappd_username`:

```ts
  test('breaker open: skips the whole profile scrape without HTTP', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    const T = new Date('2026-06-25T03:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => {},
      onRecover: () => {},
    });
    breaker.onResult(true, T);
    const http: Http = { get: vi.fn(async () => PAGE_ONE_BEER(1, 'No Call', 'No Brew', '3.1')) };

    await refreshAllUntappd({
      db, log: silentLog, http, breaker,
      now: () => new Date(T.getTime() + 3600_000),
    });

    expect(http.get).not.toHaveBeenCalled();
    expect(breaker.state).toBe('open');
  });
```

- [ ] **Step 3: Add failing test for 403/429 block tripping breaker and stopping remaining users**

Append after the previous test:

```ts
  test('profile scrape 403 trips breaker and stops remaining users', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'bob');
    const events: string[] = [];
    const T = new Date('2026-06-25T03:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });
    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        throw new HttpError(403, url);
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http, breaker, now: () => T });

    expect(seenUrls).toEqual(['https://untappd.com/user/alice/beers']);
    expect(events).toEqual(['trip']);
    expect(breaker.state).toBe('open');
  });
```

- [ ] **Step 4: Add failing test for block-page HTML tripping breaker**

Append after the previous test:

```ts
  test('profile scrape captcha page trips breaker', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    const events: string[] = [];
    const T = new Date('2026-06-25T03:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });
    const http: Http = {
      async get() {
        return '<html><title>Just a moment...</title><body>cf-challenge</body></html>';
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http, breaker, now: () => T });

    expect(events).toEqual(['trip']);
    expect(breaker.state).toBe('open');
    expect(findBeerByNormalized(db, 'anything', 'anything')).toBeNull();
  });
```

- [ ] **Step 5: Add failing test that cookie expiry does not trip VPS circuit**

Append after the existing `CookieExpiredError: calls notifyAdmin once and stops processing further users` test:

```ts
  test('CookieExpiredError does not trip the VPS circuit by itself', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    const events: string[] = [];
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });
    const { CookieExpiredError: E } = await import('../sources/http');
    const http: Http = { async get() { throw new E(); } };

    await refreshAllUntappd({ db, log: silentLog, http, breaker });

    expect(events).toEqual([]);
    expect(breaker.state).toBe('closed');
  });
```

- [ ] **Step 6: Run the new tests and verify they fail**

Run:

```bash
npx vitest run src/jobs/refresh-untappd.test.ts -t "breaker open|403 trips|captcha page trips|CookieExpiredError does not trip"
```

Expected: TypeScript/test failure because `refreshAllUntappd` does not yet accept `breaker` or `now`.

- [ ] **Step 7: Add imports in `refresh-untappd.ts`**

In `src/jobs/refresh-untappd.ts`, replace:

```ts
import { CookieExpiredError } from '../sources/http';
```

with:

```ts
import { CookieExpiredError, HttpError } from '../sources/http';
import { isBlockPage, isBlockStatus } from '../sources/untappd/block';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';
```

- [ ] **Step 8: Extend `Deps`**

Update the `Deps` interface:

```ts
interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  onProgress?: ProgressFn;
  notifyAdmin?: (msg: string) => Promise<void>;
  breaker?: CircuitBreaker;
  now?: () => Date;
}
```

- [ ] **Step 9: Destructure breaker and now**

Replace:

```ts
  const { db, log, http, onProgress = noopProgress, notifyAdmin } = deps;
```

with:

```ts
  const {
    db,
    log,
    http,
    onProgress = noopProgress,
    notifyAdmin,
    breaker = noopBreaker,
    now = () => new Date(),
  } = deps;
```

- [ ] **Step 10: Add open-circuit skip at job start**

Immediately after the destructuring, add:

```ts
  if (!breaker.canAttempt(now())) {
    log.info('refresh-untappd skipped (untappd circuit open)');
    return;
  }
```

- [ ] **Step 11: Add block handling in the profile loop**

Inside the `for (const p of profiles)` loop, replace the fetch/parse start:

```ts
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beers`);
      const items = parseUserBeersPage(html);
```

with:

```ts
      const tickNow = now();
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beers`);
      if (isBlockPage(html)) {
        breaker.onResult(true, tickNow);
        log.warn({ user: p.untappd_username }, 'untappd scrape blocked');
        break;
      }
      const items = parseUserBeersPage(html);
```

Then, immediately after `ok++;`, add:

```ts
      breaker.onResult(false, tickNow);
```

- [ ] **Step 12: Add block handling in catch**

Inside the `catch (e)` block, after the `CookieExpiredError` branch and before the existing warning, add:

```ts
      if (e instanceof HttpError && isBlockStatus(e.status)) {
        breaker.onResult(true, now());
        log.warn({ err: e, user: p.untappd_username }, 'untappd scrape blocked');
        break;
      }
```

The final catch block must keep this order:

```ts
    } catch (e) {
      if (e instanceof CookieExpiredError) {
        log.warn('untappd cookie expired — stopping scrape');
        await notifyAdmin?.(
          '⚠️ Untappd cookie expired. Run: ./deploy/refresh-cookie.sh <new-value>',
        );
        break;
      }
      if (e instanceof HttpError && isBlockStatus(e.status)) {
        breaker.onResult(true, now());
        log.warn({ err: e, user: p.untappd_username }, 'untappd scrape blocked');
        break;
      }
      log.warn({ err: e, user: p.untappd_username }, 'untappd scrape failed');
    }
```

- [ ] **Step 13: Run focused refresh-untappd tests**

Run:

```bash
npx vitest run src/jobs/refresh-untappd.test.ts
```

Expected: all `refreshAllUntappd` tests pass.

- [ ] **Step 14: Commit Task 2**

```bash
git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
git commit -m "fix(untappd): gate profile scrape with circuit"
```

---

### Task 3: Wire the Shared Breaker Through `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Pass breaker to `/refresh` ontap call**

In `src/index.ts`, update the `/refresh` `refreshOntap` call from:

```ts
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
          pubSlugs: opts?.pubSlugs,
        });
```

to:

```ts
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
          pubSlugs: opts?.pubSlugs,
          breaker: untappdBreaker,
        });
```

- [ ] **Step 2: Pass breaker to `/refresh` profile scrape call**

In the same `/refresh` callback, update:

```ts
          await refreshAllUntappd({ db, log, http: untappdHttp, onProgress: notify, notifyAdmin });
```

to:

```ts
          await refreshAllUntappd({
            db, log, http: untappdHttp, onProgress: notify, notifyAdmin,
            breaker: untappdBreaker,
          });
```

- [ ] **Step 3: Pass breaker to scheduled `refreshOntap`**

Update the `cron.schedule('0 */12 * * *', ...)` call from:

```ts
      refreshOntap({
        db, log, http, geocoder,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
      }).catch((e) => log.error({ err: e }, 'ontap cron'));
```

to:

```ts
      refreshOntap({
        db, log, http, geocoder,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        breaker: untappdBreaker,
      }).catch((e) => log.error({ err: e }, 'ontap cron'));
```

- [ ] **Step 4: Pass breaker to scheduled `refreshAllUntappd`**

Update the `cronJobs.push(cron.schedule('0 3 * * *', ...))` call from:

```ts
      refreshAllUntappd({ db, log, http: untappdHttp, notifyAdmin })
        .catch((e) => log.error({ err: e }, 'untappd cron'));
```

to:

```ts
      refreshAllUntappd({
        db, log, http: untappdHttp, notifyAdmin,
        breaker: untappdBreaker,
      }).catch((e) => log.error({ err: e }, 'untappd cron'));
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/index.ts
git commit -m "fix(untappd): share circuit across VPS callers"
```

---

### Task 4: Full Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused job tests**

Run:

```bash
npx vitest run src/jobs/refresh-ontap.test.ts src/jobs/refresh-untappd.test.ts src/jobs/enrich-orphans.test.ts src/jobs/refresh-tap-ratings.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: Vitest exits 0.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: `tsc` exits 0 and `dist/` updates if generated output is tracked by the local workflow. Do not commit unrelated generated churn unless the repo already expects `dist/` updates for this change.

- [ ] **Step 5: Check whitespace and final diff**

Run:

```bash
git diff --check
git status --short
git diff -- src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts src/index.ts
```

Expected: no whitespace errors; only intended files modified.

- [ ] **Step 6: Final commit if build verification changed tracked output**

Normally this step is not needed. If `git status --short` shows tracked generated build output under `dist/`, commit that output:

```bash
git add dist
git commit -m "chore: update generated build output"
```

If `git status --short` shows no tracked generated output after verification, do not create an empty commit.

---

## Post-Deploy Check

After deploy, verify logs with:

```bash
journalctl -u warsaw-beer-bot --since today --no-pager |
  rg "refresh-untappd skipped \\(untappd circuit open\\)|enrich-orphans skipped \\(untappd circuit open\\)|refresh-tap-ratings skipped \\(untappd circuit open\\)|untappd scrape blocked|blocked|HTTP 403|HTTP 429"
```

Expected after a VPS block: all VPS-originated Untappd jobs either skip or avoid Untappd HTTP until the 6h cooldown allows a half-open probe. Extension/browser relay behavior is unchanged.
