# Webshare proxy for Untappd traffic — design

**Date:** 2026-06-26
**Status:** approved (brainstorming)

## Problem

Untappd/Cloudflare IP-blocks the VPS (Hetzner datacenter IP); server-side
Untappd requests get `403`/`429`. A Webshare **rotating residential** proxy
plan is purchased; credentials live in `.env` as `WEBSHARE_PROXY` (format
`user:pass@p.webshare.io:80`, the rotating endpoint — each request exits from a
fresh IP). Goal: route **only** server-side Untappd traffic through Webshare so
the block lifts, while keeping the breaker/backoff safety nets and tuning the
breaker for rotation.

## Scope

In scope — proxy **only Untappd-bound** server requests:
- Untappd **search/lookup** (enrich-orphans, refresh-tap-ratings, inline-enrich
  in refresh-ontap) — currently share the general `http`; no cookie.
- Untappd **had-list** scrape (`refreshAllUntappd`) — the cookie client.

Out of scope (stay on the **direct** connection):
- Shop scraping (`ontap.pl`) via the general `http` — not blocked, high volume,
  would waste the metered proxy plan.
- Nominatim (`geocoder`, its own client) — separate already; residential proxy
  could violate its usage policy.
- Client-relay enrich / check-in sync — already run from the user's browser IP.

## Design

### 1. Config (`src/config/env.ts`)
- `WEBSHARE_PROXY: z.string().optional()`. Present → proxy enabled; absent →
  today's direct behavior (no code path changes for unset).
- `UNTAPPD_BLOCK_THRESHOLD: z.coerce.number().int().positive().default(3)`.
- Value normalization: `WEBSHARE_PROXY` has no scheme → prefix `http://` if none
  present before handing to undici.

### 2. HTTP layer (`src/sources/http.ts`)
- New `HttpOpts.proxyUrl?: string`.
- When set, build a single undici `ProxyAgent(normalizedUrl)` in the `createHttp`
  closure and pass it as `dispatcher` on every `fetch`. No new dependency
  (undici 7.25 ships with Node 20). When unset, behave exactly as today.
- Rotating endpoint → fresh exit IP per request; no sticky session.

### 3. Composition root (`src/index.ts`)
- New `untappdSearchHttp = createHttp({ userAgent, proxyUrl: env.WEBSHARE_PROXY })`
  — no cookie. Passed to `enrichOrphans`, `refreshTapRatings`, and (new param)
  the inline-enrich path of `refreshOntap`. (`refreshOntap` keeps the direct
  `http` for shop pages.)
- Had-list `untappdHttp` (cookie client) gains `proxyUrl: env.WEBSHARE_PROXY`.
- General `http` (shop) and `geocoder` (Nominatim) unchanged — direct.

### 4. Circuit breaker tuning for rotation (`src/domain/untappd-circuit.ts`)
With rotation a single `403` is just one flagged exit IP, not a dead proxy, so
tripping a 6 h pause on one block is wrong.
- `CircuitOptions.blockThreshold?: number` (default **1** → preserves all
  existing callers/tests).
- Trip (open) only after `blockThreshold` **consecutive** blocks while `closed`.
- Any success (`onResult(false)`) **resets** the consecutive-block counter to 0
  (a success proves the path works; the prior block was an unlucky IP).
- From `half_open`, a single block re-opens immediately (the probe already
  proved it is still bad).
- `onTrip`/`onRecover` fire on the actual open/close transitions only.
- Counter is transient (in-memory); resetting on deploy is correct — a fresh
  process should re-probe. The persisted `open_until` (#198) is unchanged.
- Wiring: `blockThreshold: env.UNTAPPD_BLOCK_THRESHOLD` (applied unconditionally;
  in direct mode this costs at most 2 extra `403`s on the banned IP before a
  trip — negligible, direct is now the fallback path).

### 5. Job loops honor the threshold
Breaker-honoring jobs (`enrichOrphans`, `refreshTapRatings`, inline-enrich in
`refreshOntap`, `refreshAllUntappd`) currently `break` on the first block.
Change to: `onResult(true)`; if `breaker.state === 'open'` → `break`; else
`continue` to the next candidate (a fresh rotating IP). With `blockThreshold=1`
(direct) the breaker opens immediately → `break` → identical to today.

### 6. Safety / no silent fallback
The breaker and lookup backoff (#197/#198/#199) are unchanged second-line
defenses. A proxy error surfaces as a normal `HttpError`; **no** fallback to the
direct connection (that would re-hit the banned IP). Proxy auth/bandwidth
failures (e.g. `407`) propagate and are visible in logs.

## Testing (TDD)
- `http.test.ts`: `proxyUrl` set → `fetch` receives a `dispatcher` (ProxyAgent);
  scheme normalization (`p.webshare.io:80` → `http://…`); unset → no `dispatcher`.
- `untappd-circuit.test.ts`: trips only after `blockThreshold` consecutive
  blocks; success resets the counter; `half_open` re-opens on one block;
  `blockThreshold=1` preserves current behavior; `onTrip`/`onRecover` fire once
  per transition.
- Job-loop tests: a block below threshold continues to the next candidate;
  reaching threshold breaks. Existing job tests cover the direct (threshold 1)
  path; add threshold>1 cases.

## Verification (post-deploy)
- A live Untappd fetch through the proxy returns `200` (not `403`).
- `enrich-orphans` runs stop recording `blocked`; backlog starts draining.

## Non-goals (YAGNI)
- Proxying shop scraping / Nominatim.
- Sticky proxy sessions.
- Changing the 2 s rate gap or the 6 h cooldown (separate future knobs).
- Per-IP failure accounting beyond the consecutive-block counter.
