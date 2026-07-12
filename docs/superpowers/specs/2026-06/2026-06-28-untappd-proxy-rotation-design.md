# Per-request WebShare exit-IP rotation for Untappd scrapers (#222)

**Date:** 2026-06-28
**Issue:** [#222](https://github.com/ysilvestrov/warsaw-beer-bot/issues/222) — profile scrapes still catch 403 from Untappd despite the rotating WebShare proxy (#200).

## Problem

The profile scrapers (`refresh-tap-ratings`, `refresh-untappd`) go through `WEBSHARE_PROXY`
(`p.webshare.io:80`, WebShare's rotating backbone) but periodically hit 403 (`blocked:1`),
which trips the shared Untappd circuit breaker (observed open 13:30→19:30Z, 2026-06-28).

### Root cause (measured)

`p.webshare.io` rotates the exit IP **per request only for plain HTTP**, where the proxy
sees each request. Our scrapers use **HTTPS** → the proxy serves an opaque **CONNECT
tunnel** and cannot rotate the exit IP within the tunnel's lifetime; the exit IP is pinned
to the TCP tunnel.

`createHttp()` builds **one `ProxyAgent` at process start** (`src/sources/http.ts:41`) and
reuses it forever. undici keeps the tunnel(s) alive (keep-alive pool), so all traffic egresses
from ~1–2 pinned exit IPs for the whole process lifetime. Once Untappd flags those IPs, every
request 403s until the socket is recycled → consecutive blocks → breaker opens for 6h.

Empirical probe (8 sequential HTTPS requests through `WEBSHARE_PROXY` to an IP-echo service,
`tmp/ip-rotation-probe.mjs`):

| Config | Unique exit IPs |
|---|---|
| Reuse one `ProxyAgent` (current code) | **2 / 8** |
| Fresh `ProxyAgent` per request | **8 / 8** |

A fresh `ProxyAgent` opens a new CONNECT tunnel → WebShare assigns a fresh exit IP. That is
the rotation lever.

### Why not just per-request everywhere

The cookie'd profile scraper (`untappdHttp`) sends a logged-in session
(`UNTAPPD_SESSION_COOKIE`). Rapid country-hopping of one session is a plausible
account-takeover signal for Untappd's anti-fraud (could invalidate the cookie — the code
already handles `CookieExpiredError`). So the cookie'd path stays sticky and rotates only
when actually blocked; the cookieless paths rotate every request.

## Scope

In scope — Untappd scrapers that go through the proxy via `createHttp`:

- `src/sources/proxy-rotator.ts` — **new** `RotatingDispatcher`.
- `src/sources/http.ts` — `createHttp` uses the rotator; rotate-on-block + 1 retry.
- `src/jobs/refresh-tap-ratings.ts` — `rotated` counter in the result.
- `src/jobs/refresh-untappd.ts` — `rotated` logged.
- `src/index.ts` — wire rotators with the right mode per client.

**Out of scope — `src/sources/untappd/algolia.ts`.** Algolia hits `*.algolia.net` (a CDN, not
Untappd); its proxy is a last-resort fallback and its 401/403 means an expired search key, not
an IP ban. Per-request rotation is low-value there and would entangle the existing
key-refresh/fallback logic. Left unchanged deliberately. (`untappdSearchHttp` is shared with
Algolia's `refreshKeys`, which benefits from the cookieless client's rotation for free.)

## Design

### Component: `RotatingDispatcher` (`src/sources/proxy-rotator.ts`)

Owns the `ProxyAgent` lifecycle and rotation strategy. Pure and unit-testable via an injected
agent factory.

```ts
type RotateMode = 'per-request' | 'on-block';

interface RotatingDispatcher {
  current(): Dispatcher;          // undici Dispatcher (ProxyAgent)
  rotate(reason: string): void;   // close current → next current() makes a fresh one; rotations++
  rotations(): number;            // running count, for the `rotated` metric
  close(): void;                  // shutdown cleanup
}

createRotatingDispatcher(opts: {
  proxyUrl: string;
  mode: RotateMode;
  onRotate?: (reason: string) => void;        // structured log hook
  agentFactory?: (url: string) => Dispatcher; // test seam; default: new ProxyAgent(normalize(url))
}): RotatingDispatcher;
```

- `current()`:
  - `per-request`: close the previous agent (fire-and-forget — safe because the http client's
    PQueue runs concurrency 1, so the prior request has finished) and return a **new** agent.
  - `on-block`: lazily create once, return the same agent until `rotate()`.
- `rotate(reason)`: close current, null it (next `current()` lazily recreates), `rotations++`,
  call `onRotate?.(reason)`.
- `close()`: close the current agent, if any.

### `createHttp` changes (`src/sources/http.ts`)

New opts:

```ts
interface HttpOpts {
  // ...existing...
  rotator?: RotatingDispatcher;                 // replaces ad-hoc ProxyAgent when proxied
  isBlock?: (status: number, body: string | null) => boolean;  // block predicate
}
```

`get(url)` flow inside the PQueue task:

1. `dispatcher = rotator?.current()`; fetch with it.
2. Decide block:
   - block status (e.g. 403/429) → block (no body needed);
   - `redirect:'manual'` 3xx → `CookieExpiredError` (**not** a block — no rotation);
   - other non-ok → `HttpError` (no rotation);
   - ok → read body; if `isBlock(200, body)` → block.
3. If block **and** not yet retried → `rotator.rotate(reason)`, retry once (steps 1–2 on a
   fresh tunnel).
4. If block **after** the retry → throw a block `HttpError` (status 403) so callers' existing
   `isBlockStatus` path fires `breaker.onResult(true)`. This unifies 403-status and
   200-block-page: both surface as a thrown block error after an exhausted retry, so the
   job's `isBlockPage(html)` branch becomes redundant (kept harmless, or simplified).
5. Success (incl. success after retry) returns the body normally.

`rotations` is exposed on the `Http` interface:

```ts
interface Http {
  get(url: string): Promise<string>;
  rotations?(): number;   // delegates to rotator.rotations(); absent when no proxy
}
```

When `proxyUrl`/`rotator` is absent, behaviour is exactly as today (no rotation, no retry).

### Per-client wiring (`src/index.ts`)

| Client | Cookie | Mode | `isBlock` |
|---|---|---|---|
| `untappdSearchHttp` (refresh-tap-ratings, Algolia refreshKeys) | no | `per-request` | `isBlockStatus(s) \|\| isBlockPage(body)` |
| `untappdHttp` (refresh-untappd) | yes | `on-block` | `isBlockStatus(s) \|\| isBlockPage(body)` |
| `http` (Nominatim / shops) | — | no proxy, no rotator | — |

`onRotate` is wired to a `log.warn({ reason, client }, 'untappd proxy rotate-on-block')`.

### Breaker interaction

The circuit breaker (`src/domain/untappd-circuit.ts`) is unchanged.

- A 403 absorbed by the retry → the job sees success → `breaker.onResult(false)` → consecutive
  count resets. The transient 403 never reaches the breaker.
- Two blocks in a row (original + retry, each on a different fresh IP) → block `HttpError` →
  `breaker.onResult(true)`. The breaker remains the detector of a **systemic** ban (fresh IPs
  all returning 403 = subnet/account-level block), with `UNTAPPD_BLOCK_THRESHOLD=3` consecutive.

### Observability

- Per rotation: structured `log.warn` with reason (`block-status` vs `block-page`) and client.
- `refresh-tap-ratings` result gains `rotated: number` (delta of `http.rotations?.()` around the
  run), alongside `blocked`. `blocked` now counts only blocks that survived a retry (reached the
  breaker); `rotated` counts absorbed-and-retried blocks. Together they preserve and refine the
  issue's "403 frequency in logs" metric.
- `refresh-untappd` logs the same `rotated` delta in its completion line.

## Error handling

- `CookieExpiredError` (3xx under `redirect:'manual'`) never triggers rotation — it's an
  account/session problem, handled by the existing admin alert + scrape stop.
- Non-block `HttpError` (5xx/4xx other than block statuses) never triggers rotation; surfaces as
  today (transient).
- Network errors thrown by fetch propagate unchanged (no rotation — not a 403 signal).
- Closing agents is best-effort (`.catch(() => {})`); a failed close never breaks a request.

## Testing (Vitest, TDD)

`proxy-rotator.test.ts`:
- `per-request` `current()` returns a new agent each call and closes the previous.
- `on-block` `current()` returns the same agent until `rotate()`.
- `rotate()` swaps the agent and increments `rotations()`.
- `close()` closes the current agent.

`http.test.ts` (extends existing, with a fake fetch + fake rotator):
- block status → one `rotate()` + one retry; success after retry returns body, does not throw.
- block status twice → throws block `HttpError`; `rotate()` called once.
- block-page body (200) triggers the same rotate+retry as a 403.
- 3xx under `redirect:'manual'` → `CookieExpiredError`, **no** rotation.
- non-proxy client (`rotator` absent) → no rotation, behaviour unchanged.
- `rotations()` reflects rotate calls.

Jobs:
- `refresh-tap-ratings`: `rotated` counts absorbed blocks; a block absorbed by retry does not
  increment `blocked` nor call `breaker.onResult(true)`; an unabsorbed block does both.
- `refresh-untappd`: `rotated` surfaces in the completion log; same absorb semantics.

Manual / not in CI: `tmp/ip-rotation-probe.mjs` for live exit-IP verification against WebShare
on prod (hits an IP-echo service, never Untappd).

## Spec & docs

- `spec.md` (OpenSpec source of truth): update the Untappd block-protection / proxy section to
  document per-request rotation for cookieless scrapers and sticky rotate-on-block for the
  cookie'd scraper, plus the `rotated` metric. Same PR (per CLAUDE.md).
- No `extension/**` changes → `docs/extension-install-uk.md` untouched.

## Out of scope / deferred

- Algolia proxy rotation (see Scope).
- Scraper frequency reduction (#222 task 3) — unnecessary if per-request rotation drives 403s to
  near-zero; revisit only if the `rotated`/`blocked` metrics stay high after deploy.
- Migrating to a WebShare per-request HTTP rotating product or residential gateway — current
  CONNECT-tunnel-per-request rotation already yields full per-request IP diversity.
