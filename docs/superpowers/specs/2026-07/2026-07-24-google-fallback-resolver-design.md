# Design: Google fallback resolver for 0-candidate lookups (#139)

**Date:** 2026-07-24
**Issue:** #139 — *enrich: retry Untappd search with a simplified query when 0 candidates*
**Status:** design approved, ready for planning

## Problem

Over-specified, reordered, or **cross-language** beer names hit Untappd/Algolia's
term-AND search and return **0 candidates** (`candidates_count=0`, `not_found`), so the
beer never enriches — even when it exists on Untappd under a shorter or translated
canonical name.

The #271 head-retry (comma / `#N` flavour-list tail) already covers a narrow slice.
This design adds a **deeper fallback tier** for the general 0-candidate case.

### Why not the "simplified query" approach from the issue title

Dropping tokens (`STYLE_WORDS`, first-N tokens, `brewery + 2 name tokens`) is a
heuristic that cannot cross a **language boundary**. Live evidence:

- Shelf: `Maryensztadt — …ICE BRETT PORTER DOUBLE BA - SUSZONA ŚLIWKA I CYNAMON` (Polish)
- Untappd canonical: `Barrel Aged Project: Ice Imperial Brett Baltic Porter Double
  Barrel Aged Dry Plum & Cinnamon` (English), bid `5158585`

Algolia returns 0 because the indexed name is English; no token-dropping recovers it.
**Google's ranking is translation- and reorder-aware and returns the exact page as the
#1 result.** Google therefore acts as a **canonical-name resolver**, not a match
authority — its candidate still passes through the existing strict matcher gate.

## Key architectural facts (why this is server-side only)

1. The **cron path** (`untappd-enrich.ts`) is fully server-side; `search` is a live
   `createAlgoliaSearch`.
2. The **client path** (#89, `enrich.ts`) relays a search payload from the user's
   browser; the server wraps it in `search: async () => parseAlgoliaResponse(relayed)`
   — the adapter **ignores the query** and always returns the relayed result. (Side
   effect: the #271 head-retry is a no-op on the client path, since re-running
   `args.search` returns the identical relayed payload.)
3. The original #139 "must stay client-side" constraint existed because **Untappd bans
   the server IP**. **Google Custom Search JSON API is authenticated by key, not by IP** —
   a low-volume server call does not reintroduce the ban risk. This dissolves the
   constraint for the Google approach.

**Consequence:** a single server-side fallback, invoked inside `lookupBeer`'s
0-candidate branch, automatically covers **both** paths and requires **no extension
change** (so `docs/extension-install-uk.md` is untouched).

## Architecture

### New seam: `WebResolver` (mirrors `BeerSearch`)

```ts
// src/sources/google/resolver.ts
export interface ResolvedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  abv: number | null;   // best-effort from CSE pagemap; null if absent
}
export interface WebResolver {
  resolve(brewery: string, name: string): Promise<ResolvedBeer[]>;
}
export function createGoogleResolver(opts: GoogleResolverOpts): WebResolver;
```

- **Query:** raw `${brewery} ${name}` — deliberately **not** run through
  `cleanSearchQuery`; Google's value is tolerating the noise/translation/reordering we
  otherwise strip.
- **Endpoint:** `GET https://www.googleapis.com/customsearch/v1?key=…&cx=…&q=…&num=3`.
  The CSE engine is configured to search `untappd.com` only (no `site:` needed).
- **Parse:** bid from `items[].link` via the existing
  `/\/b\/[^/]+\/(\d+)/` regex; `beer_name`/`brewery_name` from `items[].title`
  (`<Beer> - <Brewery> - Untappd`); `abv` best-effort from `items[].pagemap` metatags,
  else `null`.
- **Error handling:** on HTTP 429 (quota exhausted upstream) or any non-200, resolve to
  `[]` (treated as "no resolution" → normal `not_found`); never throw into the matcher.

### Integration point

`lookupBeer` gains an **optional** `resolve?: WebResolver` on `LookupArgs`, invoked in
the `seenCandidates.length === 0` branch **after** the #271 head-retry. When no keys are
configured, the resolver is not injected → `lookupBeer` behaves exactly as today
(feature-flagged by key presence).

Both callers wire it: `untappd-enrich.ts` (cron) and `enrich.ts` (client `/enrich/result`).

## Gate: refined B1

Google supplies candidates; acceptance is decided by the matcher, not by Google's rank.
The refined rule (a false-positive hole in raw "brewery + ABV" was found in live
validation — see below):

```
brewery-strict alias match  (ALWAYS required; reject otherwise)
  AND (
        existing name-gate passes            // exact name-key OR fuzzy ≥ 0.85
     OR ( partial distinctive-token overlap  // hasLongSharedToken(input, candidate)
          AND input ABV present
          AND |candidate.abv − input.abv| ≤ ABV_TOLERANCE )
  )
```

- **Never accept on ABV alone.** The name-mismatch branch additionally requires ≥1
  shared long distinctive token (via the existing `hasLongSharedToken`, which is
  edit-distance tolerant, so `cynamon ≈ cinnamon` and shared `brett/porter/double`
  corroborate across languages).
- ABV hydration for the name-mismatch branch: **pagemap → Algolia-by-name fallback.**
  If `ResolvedBeer.abv` is null, hydrate by issuing one server-side Algolia query on the
  resolved canonical `beer_name` and taking the matching bid's ABV. (The server holds the
  Algolia keys; on the client path this is the one server-issued Algolia call the design
  introduces, gated behind the rare name-mismatch branch and the quota/`google_tried_at`
  guards, so volume stays negligible.)
- A pure translation with **zero** token overlap is deliberately **rejected**
  (conservative). All rejections are logged to `enrich_failures`; if the false-negative
  rate is high we revisit (per owner: "if many failures, we'll come back").

### Live validation (2026-07-24)

| Case | Google top hit | Brewery | Name | Refined B1 | Correct? |
|---|---|---|---|---|---|
| Maryensztadt (cross-lang +) | `5158585` Maryensztadt — "…Dry Plum & Cinnamon" | ✅ | ❌ | shared `brett/porter/double` + ABV → **accept** | ✅ |
| Trzech Kumpli PanIPAni (+) | `1000186` Trzech Kumpli — "Pan IPAni" | ✅ | ✅ (`panipani`) | name-gate → **accept** | ✅ |
| Artezan Święty Spokój (reject) | Browar Artezan — "Te Czasy Się Skończyły" | ✅ | ❌ | zero token overlap → **reject** | ✅ |

The Artezan case is why raw "brewery + ABV" is unsafe: Google returned a **same-brewery,
wrong-name** beer; ABV alone (~6% is common) could have mislinked it. The correct
outcome there is reject (the real beer is under a different brewery, which #139 says to
keep rejecting).

## Quota counter (hard requirement)

Google CSE free tier = **100 queries/day**, resetting at **midnight Pacific Time**.

- **Table** `google_quota(day TEXT PRIMARY KEY, count INTEGER NOT NULL)`, `day` = the
  **Pacific-Time** calendar date (a new `pacificDay()` helper; UTC/Warsaw days would
  reset the counter at the wrong instant).
- **Before each call:** in one transaction, read the current PT-day count; if
  `>= GOOGLE_CSE_DAILY_CAP` (default **90**, leaving headroom under 100), **skip** Google
  and return a normal `not_found`; otherwise increment and proceed.
- **Second line of defence:** recommend the owner **not enable billing** on the CSE
  project — a bug then costs nothing (Google returns 429 at 101), and our cap at 90 is an
  independent guard. Two independent guarantees.
- **Only actual API calls are counted** (the skip path and the pagemap-hit path that
  needs no Algolia call still count the one CSE call that was made).

## Re-Google guard (quota protection against dormant orphans)

The cron retries the same unmatched orphans every eligible backoff cycle. Without a
guard, hundreds of dormant orphans would exhaust 90/day re-Googling names that will never
resolve.

- New column `beers.google_tried_at TEXT` (nullable ISO timestamp).
- Before invoking the resolver for a beer, skip if `google_tried_at` is within the last
  **30 days**. Stamp it whenever a Google call is spent (accept or reject).
- This bounds Google spend to roughly (new eligible orphans) per 30-day window, well
  under the daily cap.

## Config

- `.env`: `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`, optional `GOOGLE_CSE_DAILY_CAP` (default 90).
- Keys absent → resolver disabled → zero behavioural change.

## Testing (Vitest)

- **Resolver parse:** bid/title/abv extraction, including a cross-language Maryensztadt
  CSE fixture; malformed/empty `items` → `[]`; non-200/429 → `[]`.
- **Gate (refined B1):** brewery-fail → reject; name-hit → accept; cross-lang with token
  overlap + ABV → accept; same-brewery wrong-name (Artezan) → reject; token overlap but
  ABV out of tolerance → reject; zero-overlap translation → reject.
- **ABV hydration:** pagemap present → no Algolia call; pagemap absent → Algolia-by-name
  fallback used.
- **Quota:** cap blocks at threshold; PT-day rollover resets; increment is atomic.
- **Re-Google guard:** `google_tried_at` within 30 days → resolver skipped and no quota
  spent.
- **Feature-flag off:** no keys → `lookupBeer` output identical to today.

## Scope boundaries (YAGNI)

- No extension changes; no new client endpoint.
- No general "simplified query" heuristic (Google supersedes it for this tier; #271
  head-retry stays as the free first fallback).
- No multi-provider abstraction (Brave/others) now — `WebResolver` is the seam if ever
  needed.

## Spec / docs

- `spec.md` — add the Google fallback tier as a new lookup source (same PR).
- `docs/extension-install-uk.md` — **unchanged** (no user-facing extension change).

## Migrations

- `google_quota` table (new).
- `beers.google_tried_at` column (new, nullable) — next schema version bump.
