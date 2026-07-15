# Untappd Cloudflare-challenge Retry Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the proxy-rotator retry budget from a hardcoded single retry to a configurable budget (default 6) so Untappd HTML scrapes (`/b`, `/user`) retry through the Cloudflare Managed Challenge lottery (~33% pass per attempt) until one exit IP passes.

**Architecture:** Replace the hardcoded single rotate+retry in `src/sources/http.ts` `get()` with a loop bounded by a new `maxBlockRetries` option (default 1, preserving current behavior). Add an `UNTAPPD_BLOCK_RETRIES` env var (default 6) and wire it into both Untappd HTTP clients in `src/index.ts`. Reuses the existing `RotatingDispatcher`; no breaker/rotator changes.

**Tech Stack:** TypeScript, Vitest, undici (ProxyAgent via RotatingDispatcher), zod (env).

**Spec:** `docs/superpowers/specs/2026-07/2026-07-15-untappd-challenge-retry-budget-design.md` · Issue #298

---

### Task 1: Retry-budget loop in http.ts

**Files:**
- Modify: `src/sources/http.ts` (`HttpOpts` interface ~26-34; `get()` retry block ~85-98)
- Test: `src/sources/http.test.ts` (append two tests after the existing rotator tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/sources/http.test.ts` (the file already defines `fakeRotator`, `untappdBlock`, and imports `createHttp`, `HttpError`):

```typescript
test('retries up to maxBlockRetries and returns the body on a later success', async () => {
  const rotator = fakeRotator();
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call++;
    return call <= 3
      ? new Response('', { status: 403 })
      : new Response('ok-body', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock, maxBlockRetries: 6 });
  expect(await http.get('https://untappd.com/beer/1')).toBe('ok-body');
  expect(rotator.rotations()).toBe(3);
  expect(call).toBe(4);
});

test('exhausts maxBlockRetries then throws a block HttpError (rotates exactly budget times)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock, maxBlockRetries: 3 });
  await expect(http.get('https://untappd.com/beer/1')).rejects.toMatchObject({ name: 'HttpError', status: 403 });
  expect(rotator.rotations()).toBe(3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sources/http.test.ts`
Expected: the two new tests FAIL. Current code retries exactly once, so the first test throws instead of returning `ok-body`, and the second rotates only 1 time (expected 3). `maxBlockRetries` is also not yet a valid option (TS error is acceptable as a failure signal).

- [ ] **Step 3: Add the `maxBlockRetries` option to `HttpOpts`**

In `src/sources/http.ts`, add the field to the `HttpOpts` interface (after `isBlock`):

```typescript
export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
  cookie?: string;
  redirect?: RequestRedirect;
  rotator?: RotatingDispatcher;
  isBlock?: (status: number, body: string | null) => boolean;
  /** Max rotate+retry attempts on a block before surfacing to the breaker. Default 1. */
  maxBlockRetries?: number;
}
```

- [ ] **Step 4: Replace the single-retry block with a budget loop**

In `src/sources/http.ts` `get()`, replace this block:

```typescript
        let outcome = await classify(url, await doFetch(url));
        if (outcome.kind === 'block') {
          // Rotate to a fresh exit IP and retry exactly once. A second block
          // (different IP) signals a systemic ban and is surfaced to the breaker.
          // safe: classify() only returns 'block' when opts.rotator is truthy. Retry uses a fresh IP, so no extra throttle gap is applied.
          opts.rotator!.rotate(outcome.reason);
          outcome = await classify(url, await doFetch(url));
          if (outcome.kind === 'block') {
            // Surface a status the jobs' isBlockStatus() recognises (403/429) so a
            // systemic block — including a 200 Cloudflare challenge page — reaches
            // the circuit breaker. outcome.status may be 200 for a block page.
            throw new HttpError(outcome.status === 429 ? 429 : 403, url);
          }
        }
        return outcome.body;
```

with:

```typescript
        let outcome = await classify(url, await doFetch(url));
        // Rotate to a fresh exit IP and retry, up to maxBlockRetries (default 1).
        // Untappd HTML pages sit behind a Cloudflare Managed Challenge that ~1/3 of
        // residential exit IPs pass, so retrying through fresh IPs beats the lottery.
        // safe: classify() only returns 'block' when opts.rotator is truthy. Retries
        // use a fresh IP each time, so no extra throttle gap is applied.
        const budget = opts.maxBlockRetries ?? 1;
        let retries = 0;
        while (outcome.kind === 'block') {
          if (retries >= budget) {
            // Surface a status the jobs' isBlockStatus() recognises (403/429) so a
            // systemic block — including a 200 Cloudflare challenge page — reaches
            // the circuit breaker. outcome.status may be 200 for a block page.
            throw new HttpError(outcome.status === 429 ? 429 : 403, url);
          }
          opts.rotator!.rotate(outcome.reason);
          retries++;
          outcome = await classify(url, await doFetch(url));
        }
        return outcome.body;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/sources/http.test.ts`
Expected: PASS — all tests, including the two new ones AND the existing `rotates and retries once…` / `throws a block HttpError when the retry also blocks; rotates exactly once` (which use the default budget of 1, so their behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/sources/http.ts src/sources/http.test.ts
git commit -m "feat(http): configurable rotate-retry budget for Cloudflare challenge (#298)"
```

---

### Task 2: `UNTAPPD_BLOCK_RETRIES` env var

**Files:**
- Modify: `src/config/env.ts` (schema, after `UNTAPPD_BLOCK_THRESHOLD` ~line 18)
- Test: `src/config/env.test.ts` (after the `UNTAPPD_BLOCK_THRESHOLD` test ~line 71)

- [ ] **Step 1: Write the failing test**

In `src/config/env.test.ts`, add this test immediately after the `UNTAPPD_BLOCK_THRESHOLD defaults to 3 and coerces` test (in the same `describe` block, which defines `base`):

```typescript
  test('UNTAPPD_BLOCK_RETRIES defaults to 6 and coerces', () => {
    expect(loadEnv({ ...base } as never).UNTAPPD_BLOCK_RETRIES).toBe(6);
    expect(
      loadEnv({ ...base, UNTAPPD_BLOCK_RETRIES: '8' } as never).UNTAPPD_BLOCK_RETRIES,
    ).toBe(8);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — `UNTAPPD_BLOCK_RETRIES` is `undefined` (not in schema), so `.toBe(6)` fails.

- [ ] **Step 3: Add the env field**

In `src/config/env.ts`, add this line immediately after the `UNTAPPD_BLOCK_THRESHOLD` line (line 18):

```typescript
  UNTAPPD_BLOCK_RETRIES: z.coerce.number().int().min(1).default(6),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(env): add UNTAPPD_BLOCK_RETRIES (default 6) (#298)"
```

---

### Task 3: Wire the budget into both Untappd clients + docs

**Files:**
- Modify: `src/index.ts` (`untappdSearchHttp` createHttp ~75-85; `untappdHttp` createHttp ~98-114)
- Modify: `spec.md` (§ #222 rotation strategy, ~line 1128)
- Modify: `.env.example` (~line 15, after `UNTAPPD_BLOCK_THRESHOLD=3`)

- [ ] **Step 1: Wire the budget into the cookieless search client**

In `src/index.ts`, in the `untappdSearchHttp = createHttp({ … })` call, add the `maxBlockRetries` line right after `isBlock: untappdBlock,`:

```typescript
    isBlock: untappdBlock,
    maxBlockRetries: env.UNTAPPD_BLOCK_RETRIES,
```

- [ ] **Step 2: Wire the budget into the cookie'd profile client**

In `src/index.ts`, in the `untappdHttp = env.UNTAPPD_SESSION_COOKIE ? createHttp({ … })` call, add the `maxBlockRetries` line right after its `isBlock: untappdBlock,`:

```typescript
        isBlock: untappdBlock,
        maxBlockRetries: env.UNTAPPD_BLOCK_RETRIES,
```

(Note the deeper indentation — this createHttp is inside a ternary. Match the surrounding lines.)

- [ ] **Step 3: Verify both sites wired**

Run: `grep -n "maxBlockRetries: env.UNTAPPD_BLOCK_RETRIES" src/index.ts`
Expected: exactly TWO lines.

- [ ] **Step 4: Update spec.md**

In `spec.md`, replace this sentence (in the § #222 rotation-strategy bullet, ~line 1128):

```
  того, як блок досягне circuit breaker. Метрика `rotated` в результаті джоба
```

Locate the full sentence it belongs to:

```
  Обидва клієнти виконують **один ретрай на свіжому IP** до
  того, як блок досягне circuit breaker.
```

Replace `**один ретрай на свіжому IP**` with `**до `UNTAPPD_BLOCK_RETRIES` ротацій на свіжих IP** (дефолт 6, б'є Cloudflare Managed Challenge на `/b`/`/user`)`, so the sentence reads:

```
  Обидва клієнти виконують **до `UNTAPPD_BLOCK_RETRIES` ротацій на свіжих IP** (дефолт 6, б'є Cloudflare Managed Challenge на `/b`/`/user`) до
  того, як блок досягне circuit breaker.
```

- [ ] **Step 5: Update .env.example**

In `.env.example`, add this line immediately after `UNTAPPD_BLOCK_THRESHOLD=3` (line 15):

```
# Optional: rotate+retry attempts on a Cloudflare block before surfacing to the breaker (default 6)
UNTAPPD_BLOCK_RETRIES=6
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 7: Full test suite**

Run: `npm test`
Expected: PASS (all existing + the new http/env tests).

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts spec.md .env.example
git commit -m "feat(scrape): apply UNTAPPD_BLOCK_RETRIES to both Untappd clients + docs (#298)"
```

---

## Self-Review

**Spec coverage:**
- `maxBlockRetries` in `HttpOpts` (default 1) + loop → Task 1 Steps 3-4. ✅
- `budget=1` identical to old behavior → Task 1 Step 5 (existing tests stay green). ✅
- `UNTAPPD_BLOCK_RETRIES` (default 6) → Task 2. ✅
- Wired into both clients → Task 3 Steps 1-3. ✅
- `CookieExpiredError` not retried → unchanged (`classify()` throws it before the loop; no task needed, no code path touches it). ✅
- Tests: success-after-N, exhaustion, default-1 unchanged, env default → Task 1 Step 1 + Task 2 Step 1 + existing tests. ✅
- `spec.md` + `.env.example` → Task 3 Steps 4-5. ✅

**Placeholder scan:** No TBD/TODO; all code shown in full; all commands have expected output.

**Type consistency:** `maxBlockRetries` (number) is the only new type surface; `budget`/`retries` are locals. `UNTAPPD_BLOCK_RETRIES` name matches across env schema, env test, and both index.ts sites. Loop preserves the exact `HttpError(outcome.status === 429 ? 429 : 403, url)` throw from the original.

## Out of scope

- Challenge solver (FlareSolverr/headless).
- `/user` cookie-expiry fix.
- Circuit breaker / `proxy-rotator.ts` changes.
