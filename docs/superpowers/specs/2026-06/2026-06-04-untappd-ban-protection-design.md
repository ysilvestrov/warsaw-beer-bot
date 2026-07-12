# Untappd Ban / Session Protection — Design

**Date:** 2026-06-04
**Status:** Approved (brainstorming)
**Slug:** untappd-ban-protection

## Problem

Untappd is aggressive against scrapers. The bot hits Untappd on two paths:

- **Cookie path** (`refreshAllUntappd`, daily): uses the cookie http client with
  `redirect:'manual'`. Cookie expiry is **already handled** — a login redirect
  throws `CookieExpiredError`, the job alerts the admin and `break`s.
- **Non-cookie lookup path** (`enrichOrphans` + `refreshTapRatings`, every 3h):
  hits Untappd *search* / *beer* pages via the plain `http` client. **This path
  has no block handling.** Two failure modes today:
  - **Hard block (403/429 IP ban):** `http.get` throws → `lookupBeer` returns
    `transient` → the job logs it and keeps hammering all ~20 candidates. No
    alert, no pause.
  - **Soft block (200 + captcha / login wall):** `parseSearchPage` finds no
    results → indistinguishable from a genuine "not found" → the beer is recorded
    `not_found` and **backed off**. A captcha window silently corrupts lookup
    state for real beers, with no error and no alert.

Goal: on the non-cookie path, **detect a block, alert the admin, and trip an
in-memory circuit breaker** that pauses `enrichOrphans`/`refreshTapRatings` — and
trip *before* a block is ever mislabeled as `not_found`/`transient`.

## Decisions

- **Two-signal detection** (no consecutive-failure heuristic):
  1. **Hard HTTP status:** 403 or 429.
  2. **Captcha / login-wall markers** in the returned HTML (positive content
     check). Deliberately narrow so a genuine zero-result page is **not** a block.
- **In-memory circuit breaker**, shared by the two lookup jobs. State resets on
  bot restart (a restart is a natural moment to re-probe). **No DB table/field.**
- **6h cooldown with a half-open probe.** When tripped the breaker opens for 6h;
  the next allowed run sends a single probe; success closes it, another block
  re-arms the 6h.
- **Scope: only the two non-cookie lookup jobs** (`enrichOrphans`,
  `refreshTapRatings`). The daily cookie scrape keeps its existing cookie-expiry
  handling and is **not** gated.
- **Transition-only alerts:** one alert on `closed→open` (trip), one on
  recovery (`open|half_open → closed`). A failed probe (`half_open→open`) is
  silent. No per-tick spam.

## Components

### 1. `src/sources/http.ts` — typed status error

Replace the generic `throw new Error('HTTP N for …')` with a typed error:

```ts
export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}
```

`CookieExpiredError` and all other behavior unchanged. Callers that only log the
error are unaffected; the lookup layer can now inspect `err.status`. The breaker
is only consulted on the Untappd lookup path, so a 403 from nominatim/ontap never
reaches it.

### 2. `src/sources/untappd/block.ts` — pure detectors

```ts
export function isBlockStatus(status: number): boolean; // 403 || 429
export function isBlockPage(html: string): boolean;     // captcha / login-wall markers
```

`isBlockPage` matches a narrow set of case-insensitive markers seen on Cloudflare
challenge / Untappd login pages (e.g. `just a moment`, `cf-challenge`,
`cf-browser-verification`, `attention required`, a login-form marker). It returns
**false** for a normal search page and for a zero-result search page, so genuine
`not_found` never trips the breaker.

### 3. `src/domain/untappd-circuit.ts` — circuit breaker (pure)

```ts
export interface CircuitBreaker {
  canAttempt(now: Date): boolean;
  onResult(blocked: boolean, now: Date): void;
  readonly state: 'closed' | 'open' | 'half_open';
}
export function createCircuitBreaker(opts: {
  cooldownMs: number;          // 6 * 3600_000
  onTrip: () => void;
  onRecover: () => void;
}): CircuitBreaker;
```

State machine (start `closed`, `openedAt: number | null`):

```
canAttempt(now):
  if state === 'open' && now − openedAt >= cooldownMs:
      state = 'half_open'          // promote: allow exactly one probe
  return state !== 'open'          // closed | half_open → may attempt

onResult(blocked, now):
  if blocked:
      if state === 'closed': onTrip()    // FIRST block only → trip alert
      state = 'open'; openedAt = now      // (re)start the cooldown
  else:
      if state !== 'closed': onRecover()  // half_open|open → closed → recovery alert
      state = 'closed'; openedAt = null
```

### 4. `src/domain/untappd-lookup.ts` — `blocked` outcome

Add to `LookupOutcome`: `{ kind: 'blocked' }`.
- fetch throws and `err instanceof HttpError && isBlockStatus(err.status)` → `blocked`
  (otherwise `transient`, as today).
- after a successful fetch, `isBlockPage(html)` → `blocked` (checked before the
  zero-result `continue`, so a captcha page is never treated as `not_found`).

### 5. `src/jobs/untappd-enrich.ts` — propagate `blocked`, record nothing

`EnrichOutcomeKind` gains `'blocked'`. When `lookupBeer` returns `blocked`,
`enrichOneOrphan` returns `'blocked'` and calls **none** of
`recordLookupSuccess/NotFound/Transient` — a block must never mutate backoff
state.

### 6. `src/jobs/enrich-orphans.ts` & `src/jobs/refresh-tap-ratings.ts` — breaker-gated

Both accept the shared `breaker` as a dep and follow the same shape:

```
if (!breaker.canAttempt(now())) { log 'skipped (circuit open)'; return ZERO_RESULT; }
for each candidate:
    const outcome = <lookup>;                 // may be 'blocked'
    if (outcome === 'blocked') { breaker.onResult(true, now()); break; }
    breaker.onResult(false, now());           // success → closes a half_open probe
    ...record / sleep as today
```

The first candidate after a cooldown is implicitly the half-open probe; no
separate probe path. `EnrichOrphansResult` gains a `blocked: number` counter; the
analogous tap-ratings result gains the same. For `refreshTapRatings`, the same
detection applies to its beer-page fetch (403/429 or `isBlockPage` → `blocked`,
instead of `transient`/`not_found`).

### 7. `src/index.ts` — one shared breaker

Create a single breaker before the cron array and pass it to both jobs:

```ts
const untappdBreaker = createCircuitBreaker({
  cooldownMs: 6 * 60 * 60 * 1000,
  onTrip: () => { void notifyAdmin?.('⚠️ Untappd: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.').catch(() => {}); },
  onRecover: () => { void notifyAdmin?.('✅ Untappd: доступ відновлено, енрич продовжено.').catch(() => {}); },
});
```

Each callback swallows its own send errors so a failed Telegram alert never
crashes a job. Passed to both the cron-scheduled and the `/refresh`-driven
invocations of these jobs.

## Data flow

`enrich/tap-ratings tick` → `breaker.canAttempt` (skip if open) → per candidate
`lookupBeer`/beer-fetch → `isBlockStatus(err.status)` or `isBlockPage(html)` →
`blocked` outcome → `breaker.onResult(true)` (trip alert on first) + break.
Half-open probe success → `breaker.onResult(false)` → recovery alert + resume.

## Error handling

- Block detection is a returned outcome, never a throw into the loop.
- Breaker `onTrip`/`onRecover` callbacks self-contain their errors.
- Cookie path (`refreshAllUntappd` + `CookieExpiredError`) untouched.

## Testing (Jest, per CLAUDE.md)

- **circuit** (`untappd-circuit.test.ts`, pure, injected `now`): trip → open;
  `canAttempt` false while open; promote to half_open after cooldown;
  probe-success → closed + `onRecover`; probe-fail → open, **no** second
  `onTrip`; `onTrip` fires once per `closed→open` only.
- **block** (`block.test.ts`): captcha & login fixtures → `isBlockPage` true;
  normal search & zero-result pages → false; `isBlockStatus` 403/429 true,
  404/500 false.
- **http** (`http.test.ts`, extend): 403 response → throws `HttpError` with
  `status === 403`.
- **lookupBeer** (`untappd-lookup.test.ts`, extend): 403 → `blocked`; captcha
  html → `blocked`; zero results → `not_found`; hit → `matched`.
- **enrichOneOrphan**: `blocked` → returns `'blocked'`, asserts
  `recordLookupNotFound`/`recordLookupTransient` **not** called.
- **enrichOrphans / refreshTapRatings**: open breaker → skip (ZERO_RESULT, no
  HTTP); blocked mid-run → `onResult(true)` + break; half-open success →
  continues + `onRecover`.

## Spec update (same PR)

`spec.md` (OpenSpec single source of truth):
- §4 "Фонові джоби": note that `enrichOrphans`/`refreshTapRatings` are gated by an
  in-memory Untappd circuit breaker (6h cooldown, half-open probe; trip/recovery
  admin alerts).
- §5 business-invariants: add a line — **a detected block (403/429/captcha) is
  never recorded as `not_found`/`transient`; it trips the breaker instead.**

No schema migration — no DDL change.

## Out of scope (YAGNI)

- Persisting breaker state across restarts (new table/field).
- A consecutive-failure heuristic trigger.
- Gating the daily cookie scrape (`refreshAllUntappd`) on the IP-ban breaker.
- Env-configurable cooldown (hardcoded 6h const).
- A manual reset/`/unblock` command.
- Proxy / IP-rotation evasion.
