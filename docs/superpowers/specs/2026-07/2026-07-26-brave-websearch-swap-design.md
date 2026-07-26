# Design: swap the web resolver from Google CSE to Brave Search (#139)

**Date:** 2026-07-26
**Issue:** #139 — *enrich: retry Untappd search with a simplified query when 0 candidates*
**Supersedes provider choice in:** `2026-07-24-google-fallback-resolver-design.md`
**Status:** design approved, ready for planning

## Problem

The #139 fallback shipped (PR #346, merged `a675193`, deployed 2026-07-25) but is
**disabled in production**: Google closed the Custom Search JSON API to new customers in
early 2026. Every live call returns
`403 "This project does not have the access to Custom Search JSON API"`. Grandfathering
follows *prior usage*, not project age — the user's 2012 Google project also 403s. No
Google project we can create or own will work. The CSE path is permanently dead.

Everything else built for #139 is provider-independent and stays: the `WebResolver`
seam, the refined-B1 gate, the per-beer cooldown, the quota guard, the two call sites,
and the `lookupWithFallback` wrapper. This design swaps **only** the provider behind the
seam — which is what the seam was built for.

## Provider validation (live, per project policy)

Project policy requires proving an external API with a real authenticated call before
writing integration code. Probe run 2026-07-26 with a real Brave key, 31 requests total.

**API behaviour — confirmed:**

- 21/21 requests → HTTP 200. Key auth via `X-Subscription-Token`, no IP dependency
  (same ban-free property CSE had).
- The `site:untappd.com` operator is honoured.
- Result titles carry the **identical** `"<Beer> - <Brewery> - Untappd"` shape as CSE,
  so the existing `splitTitle` parser transfers unchanged. URLs are the same
  `/b/<slug>/<bid>` form, so `bidFromLink` transfers unchanged.
- **No ABV anywhere in the payload.** `description` gives style + rating
  (`"… is a Stout - Imperial / Double which has a rating of 4.1 …"`), `extra_snippets`
  gives check-in prose. The CSE `pagemap.metatags` ABV source is gone for good.
- New wrinkle absent from CSE: `/photos` sub-pages appear as separate results carrying
  the **same bid** as the canonical page → the parser must dedupe by bid.

**Index recall — not the bottleneck.** Of 20 real zero-candidate orphans (plus the
flagship Maryensztadt case), only ~12 are genuinely resolvable beers; the rest are
parser noise (40% vodka, wine, cider, a gift certificate, a bundle SKU). Brave surfaced
the correct Untappd page inside the top 5 for ~9–10 of those 12, **including the
flagship cross-language case** `Suszona Śliwka i Cynamon` → bid `5158585` at rank 1 —
the exact case that motivated #139.

**Gate outcome — the real bottleneck, and it is ours, not Brave's.** Running the actual
`gateGoogleCandidate` against real production inputs:

| outcome | count | note |
| --- | --- | --- |
| accepted | 2 | 11903 `Gose z mango i marakują`, 12065 `PanIPAni` |
| correct candidate present, blocked only by null ABV | 5 | 289, 30071, 30077, 31198, 31435 |
| no usable candidate | 14 | mostly non-beers / brewery divergence |

The cross-language branch is `sharedLongToken AND abv-corroborates`. With Brave supplying
no ABV, the candidate side depends entirely on Algolia hydration; and on the input side
only **207 of 371** zero-candidate orphans (56%) have an ABV at all — the flagship 29404
is one of the 44% without one, so it cannot resolve even though Brave ranks it first.

This is a **gate** limitation, not a provider limitation, and it is deliberately **out of
scope here** (see Non-goals).

## Scope

Swap the provider and make the surrounding code provider-neutral. Gate semantics,
trigger condition (`not_found` + exactly 0 candidates), call sites, 30-day per-beer
cooldown, and fail-soft behaviour are **unchanged**. The browser extension is untouched,
so `docs/extension-install-uk.md` needs no change.

### Non-goals (deliberately deferred to the follow-up PR)

- Full candidate hydration from Algolia by bid (ABV + style + canonical name).
- Style corroboration as an alternative to ABV.
- The first-wins ambiguity problem: on `#289 Risfactor`, four same-brewery variants
  (Vanilla & Cinnamon, Vanilla & Coconut, Coffee & Vanilla, Cinnamon & Cocoa Nibs) all
  clear the token branch and would all corroborate at ~10% ABV. Correctness currently
  rests on Brave ranking the right one first. Same family as #334.

Consequence to accept knowingly: immediately after this PR the feature produces **few**
matches. The follow-up PR is what makes it productive.

## Budget

Brave Free bills $5.00 per 1000 requests against $5 of monthly credits → **1000 requests
per month** before real charges begin. Rate limit: 1 request/second.

`WEB_SEARCH_DAILY_CAP` default **30**. A daily bucket bounds *any* rolling 31-day window
at 930 < 1000, so it holds regardless of when Brave resets credits (subscription date,
not calendar month) — a calendar-month counter would not. The day key moves from Pacific
to **UTC**: the Pacific day existed solely because Google reset quota at midnight PT;
our bucket is now purely a self-imposed spend guard.

## Architecture

### 1. Resolver — `src/sources/websearch/resolver.ts`

Moved from `src/sources/google/resolver.ts`. `WebResolver` and `ResolvedBeer` interfaces
unchanged. `createGoogleResolver` and `parseCseResponse` are **deleted** — CSE is
unreachable, so keeping it would be dead code.

```ts
export function createBraveResolver(opts: {
  key: string;
  count?: number;        // default 5
  fetchImpl?: typeof fetch;
  minIntervalMs?: number; // default 1100
}): WebResolver;

export function parseBraveResponse(json: BraveResponse): ResolvedBeer[];
```

- Request: `GET https://api.search.brave.com/res/v1/web/search`
  with `q = "<brewery> <name> site:untappd.com"` and `count`, headers
  `Accept: application/json` and `X-Subscription-Token: <key>`.
- Non-200 or thrown error → `[]` ("no resolution"), same fail-soft contract as before.
- `parseBraveResponse` walks `web.results[]`: `url` → bid, `title` → `splitTitle`
  (unchanged), `abv` always `null`, **deduped by bid, first occurrence wins** (drops the
  `/photos` twin).
- `count` is 5, up from CSE's 3: in the probe the correct candidate sat at rank 2–5 in
  three cases, and a larger `count` costs the same single request.

### 2. Rate-limit serialization

Both call sites can run concurrently in principle — the cron path is sequential, but
`/enrich/result` is driven by extension users and can fire in parallel. Exceeding
1 req/s returns 429 → `[]`, and the quota unit is **already consumed** (we consume before
the call), which now costs real money rather than nothing.

The resolver therefore serializes its own calls through a promise chain enforcing
`minIntervalMs` (default 1100 ms) between outbound Brave requests. Worst case this adds
~1 s of latency on the `/enrich/result` zero-candidate path, which is rare by
construction. The guard lives in the resolver, not the domain layer, because it is a
property of the provider.

### 3. Domain — `src/domain/web-fallback.ts`

Renamed from `google-fallback.ts`; **logic identical**. Renames only:
`runGoogleFallback` → `runWebFallback`, `gateGoogleCandidate` → `gateWebCandidate`,
`GoogleFallbackDeps` → `WebFallbackDeps`. `hydrateAbv` is unchanged but becomes the sole
source of candidate ABV.

`src/domain/pacific-day.ts` is replaced by `utcDay(date)` (`toISOString().slice(0, 10)`);
`pacificDay` had exactly one caller.

### 4. Storage — migration v20

```sql
ALTER TABLE google_quota RENAME TO web_search_quota;
ALTER TABLE beers RENAME COLUMN google_tried_at TO web_tried_at;
```

Verified on production 2026-07-26: `google_quota` has 0 rows and 0 beers have a non-null
`google_tried_at` (both were reset after the CSE incident), so the rename moves no data
and carries no risk. Modules: `src/storage/web_search_quota.ts`
(`tryConsumeWebSearchQuota`), and `readWebTriedAt` / `stampWebTried` in
`src/storage/beers.ts`.

### 5. Config — `src/config/env.ts`

Remove `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`, `GOOGLE_CSE_DAILY_CAP`. Add:

- `BRAVE_API_KEY` — optional string.
- `WEB_SEARCH_DAILY_CAP` — positive int, default 30.

`EXPECTED_PROD_KEYS` swaps its Google entry for `BRAVE_API_KEY` (so an absent key still
logs the "feature disabled" line at startup). In `src/index.ts` the wiring condition
simplifies from a key+cx pair to a single key; absent key → null closure → zero
behaviour change, exactly as today.

### 6. `spec.md`

Update the #139 section to name Brave, the new identifiers, the UTC day bucket, the
30/day cap, and the absence of provider-supplied ABV.

## Error handling

Unchanged from the shipped design, restated because the provider changed:

- Non-200 (including 429 rate-limit and any auth failure) → `[]`, never throws into the
  matcher; the orphan keeps its original `not_found` outcome.
- Quota is consumed **before** the network call; a wasted call is bounded by the cap.
- `web_tried_at` is stamped in a `finally`, so a spent call marks the beer whatever the
  outcome — no retry storms on a beer that keeps failing.
- Absent `BRAVE_API_KEY` → the fallback closure is null → `lookupWithFallback` returns
  the original outcome untouched.

## Testing

- `src/sources/websearch/resolver.test.ts` — rewritten against a **real captured Brave
  payload** (trimmed from the probe output), not a hand-written fixture: bid + title
  parsing, `abv` always null, `/photos` bid dedup, non-200 → `[]`, malformed JSON → `[]`,
  and serialization (two concurrent `resolve` calls are ≥ `minIntervalMs` apart with an
  injected clock/`fetchImpl`).
- `src/domain/web-fallback.test.ts` — the existing gate suite carried over under new
  names, including the cross-language Maryensztadt case; unchanged assertions, since the
  logic is unchanged.
- `src/storage/web_search_quota.test.ts` — carried over; plus a migration test asserting
  a v19 database upgrades to v20 with the renamed table and column present and the old
  names gone.
- `src/config/env.test.ts` — `BRAVE_API_KEY` absent → feature disabled; cap default 30.

## Rollout

1. Merge and deploy (`bash deploy/deploy.sh`) — migration v20 runs on start.
2. Add `BRAVE_API_KEY` to `/etc/warsaw-beer-bot/.env`, delete the commented-out
   `GOOGLE_CSE_*` lines, restart, confirm the startup log no longer says *disabled*.
3. Re-arm the zero-candidate orphan pool (371 rows) with the standard reset:
   `untappd_lookup_count=0, untappd_lookup_at=NULL` for orphans whose `enrich_failures`
   row has `candidates_count=0`, `outcome='not_found'`, `retired_at IS NULL`, and
   `review_class` not in (`wontfix`, `not_on_untappd`).
4. Watch the `enrich-orphans` cron (`30 */3 * * *`, LIMIT 20/run, on-tap orphans only)
   and the daily spend against the 30/day cap.
5. Expect few matches until the follow-up hydration PR lands.
