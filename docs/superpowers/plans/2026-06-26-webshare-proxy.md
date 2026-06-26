# Webshare Proxy for Untappd Traffic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route only server-side Untappd traffic through a Webshare rotating residential proxy to escape the datacenter-IP block, and make the circuit breaker rotation-aware (trip only after N consecutive blocks).

**Architecture:** Add an optional `proxyUrl` to the `createHttp` factory (undici `ProxyAgent` as `dispatcher`). In the composition root, build dedicated proxied Untappd clients (search + had-list) while shop scraping and Nominatim stay direct. Add a `blockThreshold` to the circuit breaker and have breaker-honoring job loops retry the next candidate (a fresh proxy IP) until the breaker actually opens.

**Tech Stack:** TypeScript, Node 20, undici 7.25 (`ProxyAgent`), Vitest, better-sqlite3, Telegraf.

**Spec:** `docs/superpowers/specs/2026-06-26-webshare-proxy-design.md`

---

## File Structure

- `package.json` — add `undici` as a direct dependency (currently transitive via cheerio).
- `src/config/env.ts` — new `WEBSHARE_PROXY`, `UNTAPPD_BLOCK_THRESHOLD`.
- `src/sources/http.ts` — `proxyUrl` option + `normalizeProxyUrl` helper + `ProxyAgent` dispatcher.
- `src/domain/untappd-circuit.ts` — `blockThreshold` in both breaker factories.
- `src/jobs/enrich-orphans.ts` — loop continues past a block until the breaker opens.
- `src/jobs/refresh-tap-ratings.ts` — same loop change.
- `src/jobs/refresh-ontap.ts` — new `untappdHttp` dep for inline-enrich + threshold-aware stop.
- `src/jobs/refresh-untappd.ts` — same loop change (had-list).
- `src/index.ts` — wire proxied clients + `blockThreshold` from env.
- Test files alongside each.

---

## Task 1: Add undici as a direct dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install undici pinned to the bundled version**

Run: `npm install undici@^7.25.0`
Expected: `package.json` `dependencies` gains `"undici": "^7.25.0"`; `package-lock.json` updated; no version change to the resolved 7.25.0 already on disk.

- [ ] **Step 2: Verify it resolves and ProxyAgent exists**

Run: `node -e "const {ProxyAgent}=require('undici'); console.log(typeof ProxyAgent)"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add undici as a direct dependency (ProxyAgent)"
```

---

## Task 2: Env config — WEBSHARE_PROXY + UNTAPPD_BLOCK_THRESHOLD

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Check whether `src/config/env.test.ts` exists. If not, create it with:

```typescript
import { loadEnv } from './env';

const base = {
  TELEGRAM_BOT_TOKEN: 'x'.repeat(12),
  DATABASE_PATH: '/tmp/x.db',
  OSRM_BASE_URL: 'https://osrm.example.com',
  NOMINATIM_USER_AGENT: 'test-agent',
};

describe('env: proxy + block threshold', () => {
  test('WEBSHARE_PROXY is optional and passes through', () => {
    expect(loadEnv({ ...base } as never).WEBSHARE_PROXY).toBeUndefined();
    expect(
      loadEnv({ ...base, WEBSHARE_PROXY: 'u:p@p.webshare.io:80' } as never).WEBSHARE_PROXY,
    ).toBe('u:p@p.webshare.io:80');
  });

  test('UNTAPPD_BLOCK_THRESHOLD defaults to 3 and coerces', () => {
    expect(loadEnv({ ...base } as never).UNTAPPD_BLOCK_THRESHOLD).toBe(3);
    expect(
      loadEnv({ ...base, UNTAPPD_BLOCK_THRESHOLD: '5' } as never).UNTAPPD_BLOCK_THRESHOLD,
    ).toBe(5);
  });
});
```

If the file already exists, append the `describe` block above (reuse its existing `base` if present).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — `WEBSHARE_PROXY`/`UNTAPPD_BLOCK_THRESHOLD` undefined on the parsed type / default not 3.

- [ ] **Step 3: Add the fields to the schema**

In `src/config/env.ts`, inside the `z.object({ ... })`, after `UNTAPPD_SESSION_COOKIE`:

```typescript
  UNTAPPD_SESSION_COOKIE: z.string().optional(),
  WEBSHARE_PROXY: z.string().optional(),
  UNTAPPD_BLOCK_THRESHOLD: z.coerce.number().int().positive().default(3),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(env): add WEBSHARE_PROXY + UNTAPPD_BLOCK_THRESHOLD"
```

---

## Task 3: HTTP layer — proxyUrl normalization + ProxyAgent dispatcher

**Files:**
- Modify: `src/sources/http.ts`
- Test: `src/sources/http.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test for `normalizeProxyUrl`**

Create/append `src/sources/http.test.ts`:

```typescript
import { ProxyAgent } from 'undici';
import { createHttp, normalizeProxyUrl } from './http';

describe('normalizeProxyUrl', () => {
  test('prepends http:// when no scheme', () => {
    expect(normalizeProxyUrl('u:p@p.webshare.io:80')).toBe('http://u:p@p.webshare.io:80');
  });
  test('leaves an explicit scheme untouched', () => {
    expect(normalizeProxyUrl('http://u:p@host:80')).toBe('http://u:p@host:80');
  });
});

describe('createHttp proxy wiring', () => {
  function capturingFetch() {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '<html>ok</html>' } as Response;
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  test('passes a ProxyAgent dispatcher when proxyUrl is set', async () => {
    const { f, calls } = capturingFetch();
    const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl: f, proxyUrl: 'u:p@p.webshare.io:80' });
    await http.get('https://untappd.com/search?q=x');
    expect(calls[0].init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  test('no dispatcher when proxyUrl is unset', async () => {
    const { f, calls } = capturingFetch();
    const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl: f });
    await http.get('https://untappd.com/search?q=x');
    expect(calls[0].init.dispatcher).toBeUndefined();
  });
});
```

Note: `RequestInit.dispatcher` is an undici extension not in the DOM lib types; cast as needed (`(calls[0].init as { dispatcher?: unknown }).dispatcher`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/http.test.ts`
Expected: FAIL — `normalizeProxyUrl` is not exported / `dispatcher` undefined when proxyUrl set.

- [ ] **Step 3: Implement in `src/sources/http.ts`**

Add the import at the top:

```typescript
import PQueue from 'p-queue';
import { ProxyAgent } from 'undici';
```

Add the exported helper (above `createHttp`):

```typescript
// Webshare creds arrive as `user:pass@host:port` (no scheme). undici's
// ProxyAgent needs an absolute URL — prefix http:// when no scheme is present.
export function normalizeProxyUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}
```

Add `proxyUrl` to `HttpOpts`:

```typescript
export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
  cookie?: string;
  redirect?: RequestRedirect;
  proxyUrl?: string;
}
```

In `createHttp`, build the agent once and attach it per request. Replace the body up to the `fetchOpts` construction:

```typescript
export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 2000;
  const dispatcher = opts.proxyUrl
    ? new ProxyAgent(normalizeProxyUrl(opts.proxyUrl))
    : undefined;
  let lastAt = 0;

  return {
    async get(url: string): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
        if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;

        const fetchOpts: RequestInit & { dispatcher?: unknown } = { headers };
        if (opts.redirect) fetchOpts.redirect = opts.redirect;
        if (dispatcher) fetchOpts.dispatcher = dispatcher;

        const res = await f(url, fetchOpts);
        lastAt = Date.now();
        // ...unchanged status handling below...
```

Keep the rest of the method (status/redirect/`res.text()`) exactly as it is.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/http.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sources/http.ts src/sources/http.test.ts
git commit -m "feat(http): optional proxyUrl via undici ProxyAgent dispatcher"
```

---

## Task 4: Circuit breaker — blockThreshold (both factories)

**Files:**
- Modify: `src/domain/untappd-circuit.ts`
- Test: `src/domain/untappd-circuit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/untappd-circuit.test.ts`:

```typescript
import { createCircuitBreaker } from './untappd-circuit';

describe('blockThreshold', () => {
  const now = new Date('2026-06-26T00:00:00Z');
  function make(threshold: number, onTrip = () => {}) {
    return createCircuitBreaker({ cooldownMs: 3600_000, onTrip, onRecover: () => {}, blockThreshold: threshold });
  }

  test('default threshold 1 trips on the first block', () => {
    const b = createCircuitBreaker({ cooldownMs: 3600_000, onTrip: () => {}, onRecover: () => {} });
    b.onResult(true, now);
    expect(b.state).toBe('open');
  });

  test('threshold 3 stays closed for the first two blocks, opens on the third', () => {
    const b = make(3);
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('open');
  });

  test('a success resets the consecutive-block counter', () => {
    const b = make(3);
    b.onResult(true, now);
    b.onResult(true, now);
    b.onResult(false, now);   // reset
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('open');
  });

  test('onTrip fires once, only on the closed→open transition', () => {
    let trips = 0;
    const b = make(2, () => { trips++; });
    b.onResult(true, now);
    b.onResult(true, now);   // opens here
    expect(trips).toBe(1);
  });

  test('half_open re-opens on a single block regardless of threshold', () => {
    const b = make(3);
    b.onResult(true, now); b.onResult(true, now); b.onResult(true, now); // open
    const later = new Date(now.getTime() + 3600_000);
    expect(b.canAttempt(later)).toBe(true); // half_open
    b.onResult(true, later);
    expect(b.state).toBe('open');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/untappd-circuit.test.ts`
Expected: FAIL — threshold-3 case opens on the first block (no `blockThreshold` support yet).

- [ ] **Step 3: Add `blockThreshold` to options and both factories**

In `src/domain/untappd-circuit.ts`, extend `CircuitOptions`:

```typescript
export interface CircuitOptions {
  cooldownMs: number;
  onTrip: () => void;
  onRecover: () => void;
  blockThreshold?: number; // consecutive blocks before tripping; default 1
}
```

In `createCircuitBreaker`, add the counter and gate the open transition:

```typescript
export function createCircuitBreaker(opts: CircuitOptions): CircuitBreaker {
  const threshold = opts.blockThreshold ?? 1;
  let state: CircuitState = 'closed';
  let openedAt = 0;
  let consecutiveBlocks = 0;

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
        consecutiveBlocks++;
        if (state === 'half_open' || consecutiveBlocks >= threshold) {
          if (state === 'closed') opts.onTrip();
          state = 'open';
          openedAt = now.getTime();
        }
      } else {
        if (state !== 'closed') opts.onRecover();
        state = 'closed';
        openedAt = 0;
        consecutiveBlocks = 0;
      }
    },
  };
}
```

In `createPersistentCircuitBreaker`, mirror the same counter logic in `onResult` (leave `canAttempt` unchanged):

```typescript
export function createPersistentCircuitBreaker(opts: PersistentCircuitOptions): CircuitBreaker {
  const threshold = opts.blockThreshold ?? 1;
  let state: CircuitState = 'closed';
  let openedAt = 0;
  let consecutiveBlocks = 0;

  return {
    get state() { return state; },
    canAttempt(now: Date): boolean {
      /* ...unchanged... */
    },
    onResult(blocked: boolean, now: Date): void {
      if (blocked) {
        consecutiveBlocks++;
        if (state === 'half_open' || consecutiveBlocks >= threshold) {
          if (state === 'closed') opts.onTrip();
          state = 'open';
          openedAt = now.getTime();
          setJobState(opts.db, opts.key, new Date(now.getTime() + opts.cooldownMs).toISOString());
        }
      } else {
        if (state !== 'closed') opts.onRecover();
        state = 'closed';
        openedAt = 0;
        consecutiveBlocks = 0;
        deleteJobState(opts.db, opts.key);
      }
    },
  };
}
```

(`PersistentCircuitOptions extends CircuitOptions`, so it inherits `blockThreshold` — no separate field.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/untappd-circuit.test.ts`
Expected: PASS (existing persistent-breaker tests still green — they use the default threshold 1).

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-circuit.ts src/domain/untappd-circuit.test.ts
git commit -m "feat(circuit): blockThreshold — trip only after N consecutive blocks"
```

---

## Task 5: enrich-orphans loop — continue past a block until the breaker opens

**Files:**
- Modify: `src/jobs/enrich-orphans.ts`
- Test: `src/jobs/enrich-orphans.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/enrich-orphans.test.ts` (reuses the file's existing `fresh`, `seedOrphanOnTap`, `silentLog`, `HttpError`, `createCircuitBreaker` imports). This is the canonical pattern for the job-loop tests in Tasks 6 and 8:

```typescript
test('blockThreshold > 1: a single block does not stop the run', async () => {
  const db = fresh();
  seedOrphanOnTap(db, 'Brew A', 'Beer A');
  seedOrphanOnTap(db, 'Brew B', 'Beer B');
  seedOrphanOnTap(db, 'Brew C', 'Beer C');
  let calls = 0;
  const http: Http = {
    async get(): Promise<string> {
      calls++;
      if (calls === 1) throw new HttpError(403, 'u'); // first lookup blocked
      return '<html></html>';                          // rest: no results → not_found
    },
  };
  const breaker = createCircuitBreaker({
    cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {}, blockThreshold: 2,
  });
  const T = new Date('2026-05-26T12:00:00Z');
  const res = await enrichOrphans({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => T });
  expect(res.blocked).toBe(1);
  expect(res.processed).toBe(3);        // loop continued past the first block
  expect(res.not_found).toBe(2);
  expect(breaker.state).toBe('closed'); // the two successes reset the counter
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/enrich-orphans.test.ts`
Expected: FAIL — current code `break`s on the first block, so `processed === 1`.

- [ ] **Step 3: Change the loop**

In `src/jobs/enrich-orphans.ts`, replace the blocked branch:

```typescript
    if (kind === 'blocked') {
      breaker.onResult(true, now());
      result.blocked++;
      result.processed++;
      if (breaker.state === 'open') break;
      if (sleepMs > 0 && i < candidates.length - 1) await sleep(sleepMs);
      continue;
    }
    breaker.onResult(false, now());
    result.processed++;
    result[kind]++;

    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/enrich-orphans.test.ts`
Expected: PASS (the existing default-threshold block test still passes — with threshold 1 the breaker opens on the first block and the loop breaks as before).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/enrich-orphans.ts src/jobs/enrich-orphans.test.ts
git commit -m "feat(enrich-orphans): retry next candidate until breaker opens"
```

---

## Task 6: refresh-tap-ratings loop — same change

**Files:**
- Modify: `src/jobs/refresh-tap-ratings.ts`
- Test: `src/jobs/refresh-tap-ratings.test.ts`

- [ ] **Step 1: Write the failing test**

Append a test mirroring Task 5 to `src/jobs/refresh-tap-ratings.test.ts`: seed ≥2 rating-refresh candidates, stub `http` so the first returns a block page, pass `createCircuitBreaker({ cooldownMs: 1, onTrip(){}, onRecover(){}, blockThreshold: 2 })`, assert `result.processed > 1` and `result.blocked === 1`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/refresh-tap-ratings.test.ts`
Expected: FAIL — `break` on first block → `processed === 1`.

- [ ] **Step 3: Change the loop**

In `src/jobs/refresh-tap-ratings.ts`, replace the blocked branch:

```typescript
    if (blocked) {
      breaker.onResult(true, tickNow);
      result.blocked++;
      result.processed++;
      if (breaker.state === 'open') break;
      if (sleepMs > 0 && i < candidates.length - 1) await sleep(sleepMs);
      continue;
    }
    breaker.onResult(false, tickNow);
```

(Leave the success-path `processed++`/sleep that follows unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/refresh-tap-ratings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-tap-ratings.ts src/jobs/refresh-tap-ratings.test.ts
git commit -m "feat(refresh-tap-ratings): retry next candidate until breaker opens"
```

---

## Task 7: refresh-ontap inline-enrich — dedicated untappdHttp + threshold-aware stop

**Files:**
- Modify: `src/jobs/refresh-ontap.ts`
- Test: `src/jobs/refresh-ontap.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/refresh-ontap.test.ts`: assert that when an `untappdHttp` dep is provided, inline-enrich uses it (not the shop `http`). Concretely: pass distinct stub clients — `http` returns ontap index/pub HTML, `untappdHttp` returns an Untappd search page — seed a fresh orphan, run with `lookupEnabled: true`, and assert the `untappdHttp` stub received the Untappd search call (and `http` did not). Reuse the file's existing ontap-stubbing harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: FAIL — inline-enrich currently calls `enrichOneOrphan({ ..., http })`, so `untappdHttp` is never used (and the dep doesn't exist yet).

- [ ] **Step 3: Add the dep and use it**

In `src/jobs/refresh-ontap.ts` `Deps`:

```typescript
  http: Http;
  untappdHttp?: Http;          // proxied client for inline Untappd enrich; default: http
  geocoder: Geocoder;
```

In the destructuring block, add (defaulting to the shop `http` so existing callers/tests are unchanged):

```typescript
  const {
    db, log, http, geocoder,
    untappdHttp = http,
    onProgress = noopProgress,
    /* ...rest unchanged... */
  } = deps;
```

Change the inline-enrich call + blocked handling:

```typescript
            const outcome = await enrichOneOrphan({ db, log, http: untappdHttp, now }, beerId);
            if (outcome === 'blocked') {
              breaker.onResult(true, now());
              enrichBudget--;
              if (breaker.state === 'open') inlineEnrichStopped = true;
            } else if (outcome !== 'skipped') {
              breaker.onResult(false, now());
              enrichBudget--;
              if (lookupSleepMs > 0) {
                await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
              }
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "feat(refresh-ontap): inline-enrich via dedicated untappdHttp + threshold-aware stop"
```

---

## Task 8: refresh-untappd (had-list) loop — same change

**Files:**
- Modify: `src/jobs/refresh-untappd.ts`
- Test: `src/jobs/refresh-untappd.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/refresh-untappd.test.ts`: seed ≥2 profiles, stub `http` so the first profile fetch returns a block page (`isBlockPage` true) and the second succeeds, pass `createCircuitBreaker({ cooldownMs: 1, onTrip(){}, onRecover(){}, blockThreshold: 2 })`, and assert the second profile WAS still fetched (loop continued) — e.g. the success path ran for profile 2. Reuse the file's existing profile-seeding + stub harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/refresh-untappd.test.ts`
Expected: FAIL — current code `break`s on the first block page; profile 2 never fetched.

- [ ] **Step 3: Change both block branches**

In `src/jobs/refresh-untappd.ts`, the `isBlockPage` branch inside `try`:

```typescript
      if (isBlockPage(html)) {
        breaker.onResult(true, tickNow);
        log.warn({ user: p.untappd_username }, 'untappd scrape blocked');
        if (breaker.state === 'open') break;
        await onProgress(`👤 untappd: ${i}/${profiles.length} — ${p.untappd_username}`);
        continue;
      }
```

And the `isBlockStatus` branch inside `catch`:

```typescript
      if (e instanceof HttpError && isBlockStatus(e.status)) {
        breaker.onResult(true, now());
        log.warn({ err: e, user: p.untappd_username }, 'untappd scrape blocked');
        if (breaker.state === 'open') break;
        continue;
      }
```

(The `continue` in the catch falls through to the loop's tail `onProgress`; the explicit `onProgress` in the try branch keeps progress output consistent before its `continue`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/refresh-untappd.test.ts`
Expected: PASS (default-threshold test: with threshold 1 the breaker opens on the first block → `break`, unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
git commit -m "feat(refresh-untappd): continue to next profile until breaker opens"
```

---

## Task 9: Wire proxied clients + blockThreshold in the composition root

**Files:**
- Modify: `src/index.ts`

This is composition-root wiring (no unit test; verified by `tsc` + the post-deploy check).

- [ ] **Step 1: Build the proxied Untappd-search client**

In `src/index.ts`, after the `const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });` line, add:

```typescript
  // Untappd search/lookup goes through the Webshare proxy (when configured) on a
  // dedicated, cookie-less client; shop scraping keeps the direct `http`.
  const untappdSearchHttp = createHttp({
    userAgent: env.NOMINATIM_USER_AGENT,
    proxyUrl: env.WEBSHARE_PROXY,
  });
```

- [ ] **Step 2: Proxy the had-list cookie client**

Update the `untappdHttp` factory:

```typescript
  const untappdHttp = env.UNTAPPD_SESSION_COOKIE
    ? createHttp({
        userAgent: env.NOMINATIM_USER_AGENT,
        cookie: env.UNTAPPD_SESSION_COOKIE,
        redirect: 'manual',
        proxyUrl: env.WEBSHARE_PROXY,
      })
    : null;
```

- [ ] **Step 3: Pass blockThreshold to the breaker**

In the `createPersistentCircuitBreaker({ ... })` call, add:

```typescript
    cooldownMs: 6 * 60 * 60 * 1000,
    blockThreshold: env.UNTAPPD_BLOCK_THRESHOLD,
```

- [ ] **Step 4: Route the Untappd-search client into the jobs**

- In the `createRefreshCommand` handler's `refreshOntap({ ... })` call, add `untappdHttp: untappdSearchHttp` to the deps.
- In the cron `refreshOntap({ ... })` call (the `'0 */12 * * *'` job), add `untappdHttp: untappdSearchHttp`.
- In the `enrichOrphans({ db, log, http, ... })` cron call, change `http` → `http: untappdSearchHttp`.
- In the `refreshTapRatings({ db, log, http, ... })` cron call, change `http` → `http: untappdSearchHttp`.
- Leave both `refreshAllUntappd({ ..., http: untappdHttp, ... })` calls as-is (that client is now proxied via Step 2).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: `tsc` clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): route Untappd traffic through Webshare proxy + wire block threshold"
```

---

## Task 10: Spec doc — reflect proxy + breaker threshold

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Update §5.8 (politeness) and the config/env section**

In `spec.md §5.8`, after the backoff bullet, add a bullet:

```markdown
- Серверний Untappd-трафік (search + had-list) йде через **Webshare rotating
  residential proxy** (`WEBSHARE_PROXY`, undici `ProxyAgent`); скрейп магазинів і
  Nominatim — напряму. Circuit breaker тригериться лише після
  `UNTAPPD_BLOCK_THRESHOLD` (default 3) **послідовних** блоків (rotation: один 403
  = один флагнутий exit-IP); будь-який успіх скидає лічильник.
```

Add `WEBSHARE_PROXY` and `UNTAPPD_BLOCK_THRESHOLD` to the env-vars list wherever env vars are documented in `spec.md` (search for `UNTAPPD_SESSION_COOKIE`).

- [ ] **Step 2: Commit**

```bash
git add spec.md
git commit -m "docs(spec): Webshare proxy + rotation-aware block threshold"
```

---

## Task 11: Post-deploy verification (manual)

Not a code task — run after merge + `deploy.sh`.

- [ ] **Step 1: Confirm a live Untappd fetch exits via the proxy and returns 200**

Put a one-off script in `./tmp/proxy-check.ts` that loads `WEBSHARE_PROXY` from `.env`, does a single `createHttp({ userAgent, proxyUrl }).get('https://untappd.com/search?q=test')`, and prints the status / first 200 chars. Run it on the host. Expected: HTML (not a Cloudflare block page), no `403`.

- [ ] **Step 2: Watch the next enrich-orphans run**

Run: `journalctl -u warsaw-beer-bot --since "<deploy time>" | grep enrich-orphans`
Expected: `blocked: 0`; `matched`/`not_found` climbing; backlog drains.

- [ ] **Step 3: Clean up** `./tmp/` per CLAUDE.md.

---

## Notes for the implementer
- DRY/YAGNI/TDD, commit per task.
- The `dispatcher` property on `RequestInit` is an undici extension; cast locally to avoid DOM-lib type errors.
- Default `blockThreshold` is 1 everywhere except the composition root (env default 3) — this preserves every existing breaker test and direct-mode behavior.
- Job tests: the existing block tests run at threshold 1 (open on first block → `break`), so they must stay green; the new tests exercise threshold > 1.
