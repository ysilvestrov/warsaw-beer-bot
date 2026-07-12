# Per-request WebShare exit-IP rotation for Untappd scrapers (#222) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WebShare exit-IP rotation actually fire per-request for the cookieless Untappd scraper and rotate-on-block for the cookie'd profile scraper, so a single flagged IP no longer pins all traffic and trips the circuit breaker.

**Architecture:** A new `RotatingDispatcher` owns the undici `ProxyAgent` lifecycle and a rotation strategy (`per-request` | `on-block`). `createHttp` consumes it: each request fetches through `rotator.current()`, and on a block signal (403/429 status or Cloudflare block page) it rotates to a fresh exit IP and retries exactly once before surfacing the block to the breaker. A `rotated` counter gives observability alongside the existing `blocked` count. Algolia's proxy path is deliberately untouched (different host, key-expiry failure mode).

**Tech Stack:** Node.js, TypeScript, undici (`ProxyAgent`/`Dispatcher`), Vitest.

---

## Spec

Design doc: `docs/superpowers/specs/2026-06-28-untappd-proxy-rotation-design.md`.

## File Structure

- **Create** `src/sources/proxy-rotator.ts` — `RotatingDispatcher` + `createRotatingDispatcher`; owns `ProxyAgent` lifecycle and rotation. `normalizeProxyUrl` moves here (single owner of proxy-URL/agent concerns).
- **Create** `src/sources/proxy-rotator.test.ts` — unit tests for the rotator.
- **Modify** `src/sources/http.ts` — `HttpOpts` drops `proxyUrl`, gains `rotator` + `isBlock`; `get()` does rotate-on-block + 1 retry; `Http` gains optional `rotations()`. Re-exports `normalizeProxyUrl` for back-compat.
- **Modify** `src/sources/http.test.ts` — replace `proxyUrl` wiring tests with rotator-based tests; add rotate/retry tests.
- **Modify** `src/jobs/refresh-tap-ratings.ts` — `rotated` in the result.
- **Modify** `src/jobs/refresh-tap-ratings.test.ts` — assert `rotated` (and that absorbed blocks don't bump `blocked`).
- **Modify** `src/jobs/refresh-untappd.ts` — return `{ ok, rotated }` and log it.
- **Modify** `src/jobs/refresh-untappd.test.ts` — assert returned `rotated`.
- **Modify** `src/index.ts` — wire a `RotatingDispatcher` per Untappd client with the right mode + `isBlock`.
- **Modify** `spec.md` — document the rotation behavior + `rotated` metric.

Test command throughout: `npx vitest run <path>` (single file) or `npm test` (full suite).

---

## Task 1: `RotatingDispatcher` module

**Files:**
- Create: `src/sources/proxy-rotator.ts`
- Test: `src/sources/proxy-rotator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/sources/proxy-rotator.test.ts`:

```ts
import { createRotatingDispatcher } from './proxy-rotator';

type FakeAgent = { url: string; closed: boolean; close: () => Promise<void> };

function fakeFactory() {
  const created: FakeAgent[] = [];
  const factory = (url: string) => {
    const a: FakeAgent = { url, closed: false, close: async () => { a.closed = true; } };
    created.push(a);
    return a as unknown as import('undici').Dispatcher;
  };
  return { factory, created };
}

test('per-request: current() returns a new agent each call and closes the previous', () => {
  const { factory, created } = fakeFactory();
  const rd = createRotatingDispatcher({ proxyUrl: 'u:p@h:80', mode: 'per-request', agentFactory: factory });
  const a1 = rd.current();
  const a2 = rd.current();
  expect(a1).not.toBe(a2);
  expect(created.length).toBe(2);
  expect(created[0].closed).toBe(true);
});

test('on-block: current() returns the same agent until rotate()', () => {
  const { factory, created } = fakeFactory();
  const rd = createRotatingDispatcher({ proxyUrl: 'u:p@h:80', mode: 'on-block', agentFactory: factory });
  expect(rd.current()).toBe(rd.current());
  expect(created.length).toBe(1);
  rd.rotate('block-status');
  rd.current();
  expect(created.length).toBe(2);
  expect(created[0].closed).toBe(true);
  expect(rd.rotations()).toBe(1);
});

test('rotate() increments rotations() and reports the reason via onRotate', () => {
  const { factory } = fakeFactory();
  const reasons: string[] = [];
  const rd = createRotatingDispatcher({
    proxyUrl: 'u:p@h:80', mode: 'on-block', agentFactory: factory,
    onRotate: (r) => reasons.push(r),
  });
  rd.current();
  rd.rotate('block-page');
  rd.rotate('block-status');
  expect(rd.rotations()).toBe(2);
  expect(reasons).toEqual(['block-page', 'block-status']);
});

test('close() closes the current agent', () => {
  const { factory, created } = fakeFactory();
  const rd = createRotatingDispatcher({ proxyUrl: 'u:p@h:80', mode: 'on-block', agentFactory: factory });
  rd.current();
  rd.close();
  expect(created[0].closed).toBe(true);
});

test('normalizes a scheme-less proxy url before building an agent', () => {
  const seen: string[] = [];
  const rd = createRotatingDispatcher({
    proxyUrl: 'u:p@h:80', mode: 'on-block',
    agentFactory: (url) => { seen.push(url); return {} as unknown as import('undici').Dispatcher; },
  });
  rd.current();
  expect(seen[0]).toBe('http://u:p@h:80');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sources/proxy-rotator.test.ts`
Expected: FAIL — `createRotatingDispatcher` not found / module missing.

- [ ] **Step 3: Implement the module**

Create `src/sources/proxy-rotator.ts`:

```ts
import { ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';

// Webshare creds arrive as `user:pass@host:port` (no scheme). undici's
// ProxyAgent needs an absolute URL — prefix http:// when no scheme is present.
export function normalizeProxyUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

export type RotateMode = 'per-request' | 'on-block';

export interface RotatingDispatcher {
  /** The dispatcher to use for the next request. */
  current(): Dispatcher;
  /** Drop the current exit IP and count it; the next current() opens a fresh tunnel. */
  rotate(reason: string): void;
  /** Number of rotations so far (for the `rotated` metric). */
  rotations(): number;
  /** Close the current agent (shutdown). */
  close(): void;
}

export interface RotatingDispatcherOpts {
  proxyUrl: string;
  mode: RotateMode;
  onRotate?: (reason: string) => void;
  agentFactory?: (url: string) => Dispatcher;
}

export function createRotatingDispatcher(opts: RotatingDispatcherOpts): RotatingDispatcher {
  const make = opts.agentFactory ?? ((url: string) => new ProxyAgent(url));
  const url = normalizeProxyUrl(opts.proxyUrl);
  let agent: Dispatcher | null = null;
  let count = 0;

  // Best-effort, fire-and-forget. Safe to close eagerly: callers run requests
  // serially (PQueue concurrency 1), so a replaced agent has no in-flight work.
  function closeAgent(a: Dispatcher | null): void {
    if (a) Promise.resolve(a.close()).catch(() => {});
  }

  return {
    current(): Dispatcher {
      if (opts.mode === 'per-request') {
        closeAgent(agent);
        agent = make(url);
        return agent;
      }
      if (!agent) agent = make(url);
      return agent;
    },
    rotate(reason: string): void {
      closeAgent(agent);
      agent = null;
      count++;
      opts.onRotate?.(reason);
    },
    rotations(): number {
      return count;
    },
    close(): void {
      closeAgent(agent);
      agent = null;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/sources/proxy-rotator.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/proxy-rotator.ts src/sources/proxy-rotator.test.ts
git commit -m "feat(proxy): RotatingDispatcher owning ProxyAgent lifecycle + rotation (#222)"
```

---

## Task 2: `createHttp` rotate-on-block + 1 retry

**Files:**
- Modify: `src/sources/http.ts`
- Modify: `src/sources/http.test.ts`

- [ ] **Step 1: Update the proxy-wiring tests and add rotate/retry tests**

In `src/sources/http.test.ts`:

(a) At the top, add an import for the block predicates used by the new tests:

```ts
import { isBlockStatus, isBlockPage } from './untappd/block';
```

(b) Delete the `import { ProxyAgent } from 'undici';` line and the entire
`describe('createHttp proxy wiring', ...)` block (the two `proxyUrl` tests). Keep the
`describe('normalizeProxyUrl', ...)` block — it still imports `{ normalizeProxyUrl } from './http'`,
which remains re-exported.

(c) Append these tests at the end of the file:

```ts
function fakeRotator(initialRotations = 0) {
  let n = initialRotations;
  return {
    rotations: () => n,
    current: () => ({}) as unknown as import('undici').Dispatcher,
    rotate: () => { n++; },
    close: () => {},
  };
}

const untappdBlock = (status: number, body: string | null) =>
  isBlockStatus(status) || (body !== null && isBlockPage(body));

test('rotates and retries once on a block status, returning the retry body', async () => {
  const rotator = fakeRotator();
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call++;
    return call === 1
      ? new Response('', { status: 403 })
      : new Response('ok-body', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  expect(await http.get('https://untappd.com/beer/1')).toBe('ok-body');
  expect(rotator.rotations()).toBe(1);
  expect(call).toBe(2);
});

test('a 200 Cloudflare block page rotates + retries like a 403', async () => {
  const rotator = fakeRotator();
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call++;
    return call === 1
      ? new Response('<html>Just a moment...</html>', { status: 200 })
      : new Response('real', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  expect(await http.get('https://untappd.com/beer/1')).toBe('real');
  expect(rotator.rotations()).toBe(1);
});

test('throws a block HttpError when the retry also blocks; rotates exactly once', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  await expect(http.get('https://untappd.com/beer/1')).rejects.toMatchObject({
    name: 'HttpError', status: 403,
  });
  expect(rotator.rotations()).toBe(1);
});

test('does not rotate on a 3xx under redirect:manual (cookie expiry, not an IP block)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 307 });
  const http = createHttp({
    userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock, redirect: 'manual',
  });
  await expect(http.get('https://untappd.com/user/x/beers')).rejects.toBeInstanceOf(CookieExpiredError);
  expect(rotator.rotations()).toBe(0);
});

test('does not rotate on a non-block non-ok status (e.g. 500)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 500 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  await expect(http.get('https://untappd.com/beer/1')).rejects.toMatchObject({ name: 'HttpError', status: 500 });
  expect(rotator.rotations()).toBe(0);
});

test('passes rotator.current() as the fetch dispatcher', async () => {
  const marker = { marker: true } as unknown as import('undici').Dispatcher;
  const rotator = { rotations: () => 0, current: () => marker, rotate: () => {}, close: () => {} };
  const calls: (RequestInit & { dispatcher?: unknown })[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator });
  await http.get('https://untappd.com/search?q=x');
  expect(calls[0].dispatcher).toBe(marker);
});

test('no dispatcher and no rotation when rotator is unset', async () => {
  const calls: (RequestInit & { dispatcher?: unknown })[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl });
  await http.get('https://untappd.com/search?q=x');
  expect(calls[0].dispatcher).toBeUndefined();
});

test('rotations() reflects the rotator counter', async () => {
  const rotator = fakeRotator(7);
  const fetchImpl: typeof fetch = async () => new Response('ok', { status: 200 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator });
  await http.get('https://x');
  expect(http.rotations?.()).toBe(7);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sources/http.test.ts`
Expected: FAIL — `rotator`/`isBlock`/`rotations` not part of the API yet (type errors / wrong behavior).

- [ ] **Step 3: Implement the changes in `src/sources/http.ts`**

Replace the `normalizeProxyUrl` definition with a re-export (it now lives in `proxy-rotator.ts`), update imports, replace `HttpOpts`, the `Http` interface, and `createHttp`:

```ts
import PQueue from 'p-queue';
import type { RotatingDispatcher } from './proxy-rotator';

export { normalizeProxyUrl } from './proxy-rotator';

export class CookieExpiredError extends Error {
  constructor() {
    super('Untappd session cookie expired');
    this.name = 'CookieExpiredError';
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface Http {
  get(url: string): Promise<string>;
  /** Cumulative proxy rotations (present only on proxied clients). */
  rotations?(): number;
}

export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
  cookie?: string;
  redirect?: RequestRedirect;
  rotator?: RotatingDispatcher;
  isBlock?: (status: number, body: string | null) => boolean;
}

export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 2000;
  let lastAt = 0;

  type Outcome =
    | { kind: 'ok'; body: string }
    | { kind: 'block'; reason: string; status: number };

  async function doFetch(url: string): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
    if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;
    const fetchOpts: RequestInit & { dispatcher?: unknown } = { headers };
    if (opts.redirect) fetchOpts.redirect = opts.redirect;
    const dispatcher = opts.rotator?.current();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const res = await f(url, fetchOpts);
    lastAt = Date.now();
    return res;
  }

  async function classify(url: string, res: Response): Promise<Outcome> {
    // With redirect:'manual', any 3xx means the session cookie is invalid — an
    // auth problem, never an IP block (so it must not trigger rotation).
    if (res.status >= 300 && res.status < 400) {
      if (opts.redirect === 'manual') throw new CookieExpiredError();
      throw new HttpError(res.status, url);
    }
    if (!res.ok) {
      if (opts.rotator && opts.isBlock?.(res.status, null)) {
        return { kind: 'block', reason: 'block-status', status: res.status };
      }
      throw new HttpError(res.status, url);
    }
    const body = await res.text();
    if (opts.rotator && opts.isBlock?.(res.status, body)) {
      return { kind: 'block', reason: 'block-page', status: res.status };
    }
    return { kind: 'ok', body };
  }

  return {
    rotations: () => opts.rotator?.rotations() ?? 0,
    async get(url: string): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        let outcome = await classify(url, await doFetch(url));
        if (outcome.kind === 'block') {
          // Rotate to a fresh exit IP and retry exactly once. A second block
          // (different IP) signals a systemic ban and is surfaced to the breaker.
          opts.rotator!.rotate(outcome.reason);
          outcome = await classify(url, await doFetch(url));
          if (outcome.kind === 'block') throw new HttpError(outcome.status, url);
        }
        return outcome.body;
      }) as Promise<string>;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/sources/http.test.ts`
Expected: PASS (all existing tests + the 8 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/sources/http.ts src/sources/http.test.ts
git commit -m "feat(http): rotate-on-block + single retry via RotatingDispatcher (#222)"
```

---

## Task 3: `rotated` counter in `refresh-tap-ratings`

**Files:**
- Modify: `src/jobs/refresh-tap-ratings.ts`
- Modify: `src/jobs/refresh-tap-ratings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/refresh-tap-ratings.test.ts` (inside the `describe('refreshTapRatings', ...)` block):

```ts
  test('rotated: reports the http.rotations() delta over the run', async () => {
    const db = fresh();
    seedIdBeerOnTap(db, 'Magic Road', 'Clementine', 6645513);
    seedIdBeerOnTap(db, 'Other Road', 'Tangerine', 6645514);
    let rot = 0;
    const http: Http = {
      async get(_url: string): Promise<string> {
        rot += 1; // simulate one absorbed (rotated + retried) block per request
        return beerPageHtml('3.98');
      },
      rotations: () => rot,
    };
    const fixedNow = new Date('2026-05-27T12:00:00Z');

    const result = await refreshTapRatings({ db, log: silentLog, http, sleepMs: 0, now: () => fixedNow });

    expect(result.rotated).toBe(2);
    expect(result.blocked).toBe(0); // absorbed blocks never reach the breaker
    expect(result.matched).toBe(2);
  });
```

Also update the two existing `expect(result).toEqual({...})` assertions (the `matched` and `not_found` tests) to include `rotated: 0`. For example the first test becomes:

```ts
    expect(result).toEqual({
      processed: 1, matched: 1, not_found: 0, transient: 0, blocked: 0, rotated: 0,
    });
```

Apply the same `rotated: 0` addition to every `toEqual` on a `RefreshTapRatingsResult` in this file (search for `processed:` to find them).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/jobs/refresh-tap-ratings.test.ts`
Expected: FAIL — `result.rotated` is `undefined`; `toEqual` mismatches.

- [ ] **Step 3: Implement in `src/jobs/refresh-tap-ratings.ts`**

Add `rotated` to the result interface and zero value:

```ts
export interface RefreshTapRatingsResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
  blocked: number;
  rotated: number;
}

const ZERO_RESULT: RefreshTapRatingsResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0, blocked: 0, rotated: 0,
};
```

Snapshot rotations before the loop and compute the delta after it. Immediately after
`const result: RefreshTapRatingsResult = { ...ZERO_RESULT };` add:

```ts
  const rotatedBefore = deps.http.rotations?.() ?? 0;
```

Just before the final `deps.log.info(result, 'refresh-tap-ratings done');` add:

```ts
  result.rotated = (deps.http.rotations?.() ?? 0) - rotatedBefore;
```

(The early-return-on-open-circuit path returns `{ ...ZERO_RESULT }`, which already has `rotated: 0` — leave it.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/jobs/refresh-tap-ratings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-tap-ratings.ts src/jobs/refresh-tap-ratings.test.ts
git commit -m "feat(refresh-tap-ratings): surface rotated count alongside blocked (#222)"
```

---

## Task 4: `rotated` in `refresh-untappd`

**Files:**
- Modify: `src/jobs/refresh-untappd.ts`
- Modify: `src/jobs/refresh-untappd.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/refresh-untappd.test.ts` (inside the top-level `describe` if there is one, otherwise at file end). It seeds two profiles, returns a parseable page per profile, and grows `rotations()` by one per request:

```ts
test('returns rotated as the http.rotations() delta over the run', async () => {
  const db = fresh();
  const tg1 = 111, tg2 = 222;
  ensureProfile(db, tg1);
  setUntappdUsername(db, tg1, 'alice');
  ensureProfile(db, tg2);
  setUntappdUsername(db, tg2, 'bob');

  let rot = 0;
  const http: Http = {
    async get(url: string): Promise<string> {
      rot += 1; // simulate one absorbed (rotated + retried) block per request
      const bid = url.includes('alice') ? 1 : 2;
      return `<div>${PAGE_ONE_BEER(bid, `Beer${bid}`, `Brewer${bid}`, '4.0')}</div>`;
    },
    rotations: () => rot,
  };

  const result = await refreshAllUntappd({ db, log: silentLog, http });

  expect(result.rotated).toBe(2);
  expect(result.ok).toBe(2);
});
```

If `ensureProfile`/`setUntappdUsername`/`PAGE_ONE_BEER` are already imported/defined in the file (they are, per the existing tests), reuse them as-is.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/jobs/refresh-untappd.test.ts`
Expected: FAIL — `refreshAllUntappd` returns `void`; `result` is `undefined`.

- [ ] **Step 3: Implement in `src/jobs/refresh-untappd.ts`**

Add a result type and return it. Change the signature:

```ts
export interface RefreshUntappdResult {
  ok: number;
  rotated: number;
}

export async function refreshAllUntappd(deps: Deps): Promise<RefreshUntappdResult> {
```

In the early `canAttempt` guard, return a zero result instead of bare `return`:

```ts
  if (!breaker.canAttempt(now())) {
    log.info('refresh-untappd skipped (untappd circuit open)');
    return { ok: 0, rotated: 0 };
  }
```

Snapshot rotations right after `const profiles = allProfiles(db)...` line (before the loop):

```ts
  const rotatedBefore = http.rotations?.() ?? 0;
```

Replace the final progress line block at the end of the function:

```ts
  const rotated = (http.rotations?.() ?? 0) - rotatedBefore;
  await onProgress(`👤 untappd: ✓ ${ok}/${profiles.length} профілів`, { force: true });
  log.info({ profiles: profiles.length, ok, rotated }, 'refresh-untappd done');
  return { ok, rotated };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/jobs/refresh-untappd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
git commit -m "feat(refresh-untappd): return + log rotated count (#222)"
```

---

## Task 5: Wire rotators in `src/index.ts` + update `spec.md`

**Files:**
- Modify: `src/index.ts`
- Modify: `spec.md`

No unit test (composition root); verified by the type-checker + full suite.

- [ ] **Step 1: Add imports in `src/index.ts`**

Near the existing `import { createHttp } from './sources/http';` add:

```ts
import { createRotatingDispatcher } from './sources/proxy-rotator';
import { isBlockStatus, isBlockPage } from './sources/untappd/block';
```

- [ ] **Step 2: Replace the `proxyUrl`-based client construction**

Replace the current `untappdSearchHttp` block (lines ~62-65) with:

```ts
  const untappdBlock = (status: number, body: string | null) =>
    isBlockStatus(status) || (body !== null && isBlockPage(body));

  // Cookieless search/lookup client: rotate the WebShare exit IP on EVERY
  // request (HTTPS CONNECT tunnels pin one IP per tunnel, so a fresh agent per
  // request is the only way to actually rotate). See #222.
  const untappdSearchHttp = createHttp({
    userAgent: env.NOMINATIM_USER_AGENT,
    rotator: env.WEBSHARE_PROXY
      ? createRotatingDispatcher({
          proxyUrl: env.WEBSHARE_PROXY,
          mode: 'per-request',
          onRotate: (reason) => log.warn({ reason, client: 'untappd-search' }, 'untappd proxy rotate-on-block'),
        })
      : undefined,
    isBlock: untappdBlock,
  });
```

`createAlgoliaSearch({ ... proxyUrl: env.WEBSHARE_PROXY ... })` stays exactly as-is (out of scope).

Replace the `untappdHttp` block (lines ~79-86) with a sticky, rotate-on-block client:

```ts
  const untappdHttp = env.UNTAPPD_SESSION_COOKIE
    ? createHttp({
        userAgent: env.NOMINATIM_USER_AGENT,
        cookie: env.UNTAPPD_SESSION_COOKIE,
        redirect: 'manual',
        // Cookie'd session: keep one exit IP (rapid country-hopping of a
        // logged-in session looks like account takeover) and only rotate when
        // actually blocked. See #222.
        rotator: env.WEBSHARE_PROXY
          ? createRotatingDispatcher({
              proxyUrl: env.WEBSHARE_PROXY,
              mode: 'on-block',
              onRotate: (reason) => log.warn({ reason, client: 'untappd-profile' }, 'untappd proxy rotate-on-block'),
            })
          : undefined,
        isBlock: untappdBlock,
      })
    : null;
```

- [ ] **Step 3: Type-check and run the full suite**

Run: `npm run build && npm test`
Expected: type-check passes; all tests green. (If `build` is not the tsc script, run `npx tsc --noEmit` then `npm test`.)

- [ ] **Step 4: Update `spec.md`**

Find the Untappd block-protection / WebShare proxy section (search `Webshare` / `proxy` / `circuit`). Add a short subsection documenting:

- Cookieless Untappd scraper (`refresh-tap-ratings`, search-key fetch) rotates the WebShare exit IP **per request**; the cookie'd profile scraper (`refresh-untappd`) keeps a sticky IP and rotates **only on a block**, both retrying once on a fresh IP before the block reaches the circuit breaker.
- New `rotated` metric in `refresh-tap-ratings` results and `refresh-untappd` logs counts blocks absorbed by rotation; `blocked` now counts only blocks that survived the retry (reached the breaker).
- Rationale: `p.webshare.io` cannot rotate within an HTTPS CONNECT tunnel, so a long-lived `ProxyAgent` pinned ~1–2 exit IPs for the whole process (root cause of #222).

Keep it consistent with the existing spec's terse style.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts spec.md
git commit -m "feat(untappd): wire per-request / on-block proxy rotation; spec (#222)"
```

---

## Final verification

- [ ] Run the full suite: `npm test` — all green.
- [ ] Type-check: `npx tsc --noEmit` — no errors.
- [ ] Sanity-grep that `proxyUrl` is gone from `createHttp` call sites: `grep -rn "proxyUrl" src/index.ts` should show only the `createAlgoliaSearch` call.
- [ ] (Optional, manual, prod) re-run `tmp/ip-rotation-probe.mjs` to confirm fresh-agent rotation still yields N/N unique exit IPs.

## Out of scope / deferred (do NOT implement here)

- Algolia proxy rotation (`src/sources/untappd/algolia.ts`) — different host, key-expiry failure mode.
- Scraper frequency reduction (#222 task 3) — revisit only if `rotated`/`blocked` stay high post-deploy.
- `RotatingDispatcher.close()` wiring into `createShutdown` — agents are reclaimed on process exit; not worth the plumbing now.
