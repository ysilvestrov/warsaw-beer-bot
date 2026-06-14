# Brewery-in-name stripping — design (#126 + #155)

**Date:** 2026-06-14
**Issues:** #126 (enrich search query not deduped when name repeats brewery), #155 (brewery token duplicated inside the beer name blocks the match)
**Root cause (shared):** the brewery name is embedded in the beer *name*. The same phenomenon bites at two pipeline stages — the **search query** (#126 → 0 candidates) and the **name match** (#155 → candidates returned but rejected). One helper fixes both.

## Problem

| # | Stage | Mechanism | Example |
|---|-------|-----------|---------|
| #126 | **Query build** (`enrich.ts:58`, `lookupBeer` search URL) | query = `stripBreweryNoise(brewery) + " " + name`; when `name` repeats the brewery the query doubles it → Untappd term-AND search returns **0 results** | brewery `Track Brewing Co.`, name `Track Brewing Company Taking Shape` → query `Track Track Brewing Company Taking Shape` → 0 hits (real beer findable as `Track Taking Shape`) |
| #155 | **Name match** (`nameKeys`, `fuzzyTargets`) | `stripLeadingBrewery` strips only a **full leading** brewery prefix, so trailing / mid / partial duplications survive and break the name-key intersection and divergence guard | `Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli` / brewery `Trzech Kumpli` (trailing); `Cydr Chyliczki - Stary Sad 2023` / `Chyliczki` (mid); `Primator Weizen` / `Primator` (leading, already handled) |

Both want the same capability: **strip the brewery from the beer name wherever it appears.** Today only the leading-full-prefix case is handled, in one place (`stripLeadingBrewery`).

## Scope decisions (agreed)

- **Aggressiveness (A):** strip the **exact input-brewery token-run wherever it appears** (leading/trailing/mid), then trim leftover **leading/trailing `BREWERY_NOISE`** tokens. FP-safe — only the actual brewery name is removed. The partial-prefix case (`Hoppy Hog` vs name `Hoppy Hog Family Brewery …`) is improved (loses trailing `Brewery`) but **deferred** where it still doesn't fully resolve (the `Family` token survives), like `Kwak` in PR2.
- **Match-side scope (A — global):** the strip lands in the shared `stripLeadingBrewery`/`nameKeys` primitive, so #155 is fixed in **both** the enrich path (`lookupBeer`) and the `/match` catalog path (`matchPrepared`). The strip is FP-safe and symmetric, so the wider blast radius is acceptable; a `/match` no-regression check is required (below).

## Core helper — `stripBreweryFromName` (replaces `stripLeadingBrewery`)

Generalize `matcher.ts` `stripLeadingBrewery(nameNorm, breweryNorm)` into `stripBreweryFromName(nameNorm, breweryNorm)`:

1. If `breweryNorm` is empty → return `nameNorm` unchanged (passthrough; this is what keeps the #138B brand path — which calls `nameKeys(name, '')` — untouched).
2. Find a **contiguous token-run** in `nameNorm` equal to the brewery's tokens (the `tokenSublist` notion from PR1) — at **any** position. Remove it **only if ≥1 token survives** (never strip a name to empty; if the name *is* the brewery, keep it raw). Remove all non-overlapping occurrences.
3. Trim leftover **leading and trailing `BREWERY_NOISE`** tokens from the result (`brewery`, `browar`, `brewing`, `company`, `co`, `pivovar`, … — already defined in `normalize.ts`; export the set or add a `trimBreweryNoise` helper there).

Leading-prefix is just "run at index 0", so this is a strict superset of today's behavior. It is a drop-in at both existing call sites — `nameKeys` (`matcher.ts:211`) and `fuzzyTargets` (`untappd-lookup.ts:46`) — which gives #155 globally. Rename the function (the old name now lies); update both call sites in the same change.

**FP character unchanged:** only the brewery name is ever removed, and the downstream "<2-token side → no key → fall to fuzzy" rule still guards weak results.

## Consumer — #126 query builders

Two sites build `stripBreweryNoise(brewery) + " " + name`: `enrich.ts:58` (extension preview `searchUrl`) and `lookupBeer`'s search-URL builder. Both strip the brewery run from `name` before appending.

The query must run on the **raw** name (preserve surviving tokens like `2023`, flavour words, original casing — `normalizeName` strips digits/style words we want for search), comparing tokens case- and diacritic-folded against the brewery. So it is the **same core token operation** (remove brewery run + trim edge noise) with a **raw comparator** wrapper instead of the normalized path.

Worked example — `Track`: `stripBreweryNoise("Track Brewing Co.") = "Track"`; raw name `Track Brewing Company Taking Shape` → remove the leading `track` run → `Brewing Company Taking Shape` → trim leading `BREWERY_NOISE` (`Brewing`, `Company`) → `Taking Shape` → query `Track Taking Shape` (finds `Track Brewing Co. — Taking Shape`). The leftover-noise trim is load-bearing here (`brewing`/`company` ∈ `BREWERY_NOISE`, verified).

Query behavior is hard to reason about abstractly, so the plan will **capture the real Track Untappd page and verify the cleaned query returns the candidate** before committing (the discipline that caught the PR1/PR2 surprises).

## #138B interaction (safe by construction)

The PR2 brand path computes `nameKeys(name, '')` (empty brewery) → `stripBreweryFromName` passthrough → brand stays in the key, exactly as #138B needs. The stronger strip only affects `nameKeys(name, brewery)` (Stage 2a), used against breweries that *matched* — where removing the redundant brewery is correct. A brand-in-name case (Murphy's) never reaches Stage 2a with its parent-company candidate (it's in `brandPool`), so there is no conflict.

## Edge cases

- Strip would empty the name → keep it raw (≥1-token guard). The query never goes empty (it still carries the brewery field).
- Strip leaves a single token → existing "<2-token side → no key → fuzzy" path, unchanged.
- Per-`COLLAB_SEP`-side application preserved (helper slots into the same place).
- **Hoppy Hog deferred** — strip removes trailing `Brewery` but `Family` survives → won't fully match; documented out of scope.

## Testing

- **Unit** (`matcher.test.ts`): `stripBreweryFromName` — leading / trailing / mid run, leftover-noise trim, empty-guard (name == brewery), no-brewery passthrough, multi-occurrence.
- **#155 real fixtures** (`tests/fixtures/untappd-search/`): Trzech Kumpli + Chyliczki captured pages → `lookupBeer` now matches (previously `not_found`).
- **#126 real fixture:** the captured Track page — assert (a) the cleaned query string drops the duplication and (b) `lookupBeer` end-to-end now matches. Plus a unit test on the raw query-cleaner output.
- **`/match` no-regression (scope-A blast-radius check):** full `npx jest` green **plus** `scripts/bench-match.ts` on the prod payload (`tmp/beerrepublic.json` or similar) showing the matched count is unchanged — `nameKeys` changed globally.
- FP guard: a beer whose name legitimately contains a brewery-like single token is not over-stripped into a wrong match (pick a real example during planning; rely on the ≥2-token-key + exact-set-equality safety).

## spec.md updates (same PR)

§3.1 (name-keys): note the strip now removes the brewery token-run **anywhere** in the name (not just leading) + trims leftover `BREWERY_NOISE`, applied on both the input and (unchanged) candidate sides; shared by `/match` and enrich. Enrich query note: the search query strips the embedded brewery from the name so it isn't doubled (#126).

## Packaging

One PR (the core helper is the bulk; both consumers are small and share it). Split into two only if the diff grows unwieldy — decide in the plan.

## Refs

- Code: `src/domain/matcher.ts` (`stripLeadingBrewery`→`stripBreweryFromName`, `nameKeys`, `tokenSublist`), `src/domain/untappd-lookup.ts` (`fuzzyTargets`, search-URL builder), `src/api/routes/enrich.ts:58` (preview `searchUrl`), `src/domain/normalize.ts` (`BREWERY_NOISE`, `stripBreweryNoise`)
- Issues: #126 (parent #124), #155 (orphan triage 2026-06-14); related #138B (PR2, opposite direction — keep brand when brewery gate fails), #139 (0-candidate retry, different cause)
- Runbook: `docs/debug-orphan-matching.md`; spec.md §3.1 (name-keys), §POST /match
- Workflow: brainstorming → spec → plan → worktree → PR → review → merge → deploy
