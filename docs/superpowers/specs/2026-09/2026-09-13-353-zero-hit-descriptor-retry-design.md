# #353 / #590 / #533 / #404 / #388 / #559 — Zero-hit retry for style descriptors and packaging tokens

**Date:** 2026-09-13  
**Status:** draft  
**Issues:** #353, #590, #533, #404, #388, #370, #559  

## Problem

Untappd beer search operates over Algolia with strict **AND-semantics** across all query tokens: any query token absent from the registered beer name zeroes the whole result set (`nbHits: 0`).

Shop catalog titles and untappd-cron tap imports routinely append:
1. **Trailing style descriptors & filtration terms:** e.g. `West Coast IPA`, `Foreign Extra Stout`, `Tomato Gose`, `niepasteryzowane`, `Pale Ale`, `Jasny lager`, `Malt Beer KVAS`, `hard seltzer`.
2. **Packaging & format tokens:** e.g. `CAN`, `BOTTLE`, `Pack`, `4-Pack`, `473ml`, `500ml`, `0.5l`.

Untappd registers these beers under their clean, core brand names without the shop's trailing style or container qualifiers:
- *Mazák — Rainbow of Death* (shop: `16° Rainbow of Death West Coast IPA`)
- *Browar Kormoran — Warmińskie Rewolucje* (shop: `Rewolucje Warmińskie niepasteryzowane 12,5°`)
- *Flasker — Dark Roast* (shop: `Dark Roast Foreign Extra Stout`)
- *Flasker — Hawaiian Curry* (shop: `Hawaiian Curry Gose`)
- *Flasker — Kim Yum Gose* (shop: `Kim-Yum Tomato Gose`)
- *Flasker — Maltdrikke* (shop: `Maltdrikke Malt Beer KVAS`)
- *Firestone Walker — Mind Haze* (shop: `Mind Haze 473ml`)
- *Liquor Zaar — O.J. Cloudy Wheat Beer / Blanche* (shop: `O.J. Blanche CAN`)
- *Omnipollo — Maz Non-Alcoholic* (shop: `Maz Non-Alcoholic Pale Ale`)

Because the primary search query retains these extraneous tokens, Algolia returns zero hits (`candidates_count: 0`). The matching pipeline and brewery gate never run, leaving the row stranded in `enrich_failures`.

### The Trap: Unconditional Stripping & Naive Retries

As proven in #353:
1. **Unconditional query stripping causes regressions:** Many Untappd beers legitimately contain style or filtration words in their registered title (e.g. *Kasztelan Niepasteryzowane*, *Piwo Składowe Jasne Niepasteryzowane*). Stripping descriptors on the primary query would over-broaden the search and degrade precision.
2. **Naive retry matches the wrong twin without guards:**
   - Input `Trzech Kumpli Pan IPAni Bezalkoholowe (0.5%)` retried without descriptors returned *Pan IPAni (6.0%)*, matching the alcoholic flagship for a non-alcoholic beer (#33783).
   - Input `Artezan Jasne Niepasteryzowane (4.6%)` retried without descriptors matched *Artezan — Jasne (5.0%)*, violating `ABV_TOLERANCE` (#33517).

Therefore, any retry must be **strictly zero-hit only** and protected by **alcohol-class and ABV compatibility guards**.

## Decision

Implement a guarded zero-hit retry rung in `lookupBeer` (`src/domain/untappd-lookup.ts`):

1. **Zero-Hit Precondition:** The primary search runs unmodified via `searchQueryLadder(part, name)` across all brewery parts. If any candidates are returned by Algolia, the retry path is completely bypassed. Existing matches and near-misses remain 100% untouched.
2. **Candidate Stripping:** When `seenCandidates.length === 0`:
   - If the name carries a comma or `#N` adjunct/edition tail (`headBeforeTail`), evaluate that existing #271 retry first.
   - If the search still yields zero candidates across all parts and `!descriptorRetried`, derive a candidate stripped name via `stripDescriptorAndPackaging(name)`.
   - If a non-empty stripped name is produced and differs from `cleanName`, retry `lookupBeer` once with `{ ...args, name: strippedName }`.
3. **Safety Guards on Retry Outcome:** When the retry returns `{ kind: 'matched', result }`:
   - **Alcohol-Class Guard:** If the input is non-alcoholic (`input.abv <= 0.7` or input name contains non-alcoholic keywords: `bezalkoholowe`, `non-alcoholic`, `alkofrei`, `alkoholfrei`, `nealko`, `0.0`, `zero`), candidate must NOT have `abv >= 2.0`. Conversely, an alcoholic input (`input.abv >= 2.0` without non-alcoholic keywords) must NOT match a non-alcoholic candidate (`cand.abv <= 0.7` with non-alcoholic style).
   - **ABV Compatibility Guard:** If both input and candidate have known ABVs, `|cand.abv - input.abv| <= ABV_TOLERANCE` (0.3%).
   - If either guard fails, the match is rejected and `lookupBeer` returns terminal `not_found` with the candidate recorded in `enrich_failures`.
4. **Single Retry Guarantee:** Guarded by `descriptorRetried = true` to guarantee exactly one retry pass.

## Claims and Evidence

| Recorded fact | Claim | Evidence required before recording |
|---|---|---|
| `beers.untappd_id = 2852216` | Orphan 35037 (`Mazák / 16° Rainbow of Death West Coast IPA`) is Pivovar Mazák — Rainbow of Death | Primary query zeroes; stripped query `Mazák Rainbow of Death` returns 1 hit; brewery matches; no alcohol-class contradiction |
| `beers.untappd_id = 750537` | Orphan 34993 (`Kormoran / Rewolucje Warmińskie niepasteryzowane 12,5°`) is Browar Kormoran — Warmińskie Rewolucje | Primary query zeroes; stripped query `Kormoran Rewolucje Warmińskie` returns 1 hit; input ABV 5.2% matches candidate ABV 5.2% |
| `beers.untappd_id = 5042332` | Orphan 25970 (`Omnipollo / Maz Non-Alcoholic Pale Ale`) is Omnipollo — Maz Non-Alcoholic (0.3%) | Primary query zeroes; stripped query `Omnipollo Maz Non-Alcoholic` returns 1 hit (bid 5042332); alcohol-class guard accepts 0.3% and rejects 5.6% twin |
| `beers.untappd_id = 5877670` | Orphan 29782 (`Flasker / Dark Roast Foreign Extra Stout`) is Flasker — Dark Roast (8%) | Primary query zeroes; stripped query `Flasker Dark Roast` returns 1 hit; input ABV 8.0% matches candidate ABV 8.0% |
| `beers.untappd_id = 6688791` | Orphan 29783 (`Flasker / Hawaiian Curry Gose`) is Flasker — Hawaiian Curry (4.5%) | Primary query zeroes; stripped query `Flasker Hawaiian Curry` returns 1 hit; brewery matches |
| `beers.untappd_id = 5899260` | Orphan 29895 (`Flasker / Kim-Yum Tomato Gose`) is Flasker — Kim Yum Gose (4.5%) | Primary query zeroes; stripped query `Flasker Kim-Yum` returns 1 hit; input ABV 4.5% matches candidate ABV 4.5% |
| `beers.untappd_id = 6484735` | Orphan 29931 (`Flasker / Maltdrikke Malt Beer KVAS`) is Flasker — Maltdrikke (0%) | Primary query zeroes; stripped query `Flasker Maltdrikke` returns 1 hit; input ABV 0% matches candidate ABV 0% |
| `beers.untappd_id = 2916237` | Orphan 26020 (`Firestone Walker / Mind Haze 473ml`) is Firestone Walker — Mind Haze (6.7%) | Primary query zeroes; stripped query `Firestone Walker Mind Haze` returns 5 hits dominated by bid 2916237 |
| `beers.untappd_id = 4624110` | Orphan 29883 (`Liquor Zaar / O.J. Blanche CAN`) is Liquor Zaar — O.J. Cloudy Wheat Beer / Blanche (5%) | Primary query zeroes; stripped query `Liquor Zaar O.J. Blanche` returns 1 hit; brewery matches |
| `enrich_failures` row cleared on match | Candidate verified and recorded | Standard `applyLookupOutcome` success transaction |

## Placement

- Helper `stripDescriptorAndPackaging(name: string): string | null` is placed in `src/domain/normalize.ts`.
- Retry orchestration, alcohol-class guard, and ABV guard are placed in `src/domain/untappd-lookup.ts`.
- Unit tests are added to `src/domain/normalize.test.ts` and `src/domain/untappd-lookup.test.ts`.
- `spec.md` updated in §3.12 (query ladder and zero-hit retry section).

## Scope

Implementation files:
- `src/domain/normalize.ts`
- `src/domain/normalize.test.ts`
- `src/domain/untappd-lookup.ts`
- `src/domain/untappd-lookup.test.ts`
- `spec.md`

No changes to database schema, extension code, public API routes, or backoff algorithms.
