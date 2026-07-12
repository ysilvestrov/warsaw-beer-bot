# Brewery-in-name stripping — design (#126 + #155)

**Date:** 2026-06-14
**Issues:** #126 (enrich search query not deduped when name repeats brewery), #155 (brewery token duplicated inside the beer name blocks the match)
**Root cause (shared):** the brewery name is embedded in the beer *name*. The same phenomenon bites at two pipeline stages — the **search query** (#126 → 0 candidates) and the **name match** (#155 → candidates returned but rejected). One helper fixes both.

## Problem

| # | Stage | Mechanism | Example |
|---|-------|-----------|---------|
| #126 | **Query build** (`enrich.ts:58`, `lookupBeer` search URL) | query = `stripBreweryNoise(brewery) + " " + name`; when `name` repeats the brewery the query doubles it → Untappd term-AND search returns **0 results** | brewery `Track Brewing Co.`, name `Track Brewing Company Taking Shape` → query `Track Track Brewing Company Taking Shape` → 0 hits (real beer findable as `Track Taking Shape`) |
| #155 | **Name match** (`nameKeys`, `fuzzyTargets`) | `stripLeadingBrewery` strips only a **full leading** brewery prefix, so a trailing duplication survives and breaks the name-key intersection / divergence guard | `Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli` / brewery `Trzech Kumpli` (trailing, **recovered**); `Primator Weizen` / `Primator` (leading, already handled) |

Both stem from the same root: **the brewery name is embedded in the beer name.** They are fixed by two small, related functions (sharing `BREWERY_NOISE` + a token-fold), not literally one helper — verification showed the query side needs a denoise+dedup pass, while the match side needs a targeted brewery-run removal.

**Verified against real Untappd pages 2026-06-14** (the discipline that caught PR1/PR2 surprises):
- Track #126: OLD query → **0 items**, cleaned query `TRACK Taking Shape` → **1 item** (`Track Brewing Company — Taking Shape`, bid 6645521).
- Trzech Kumpli #155: brewery-run strip → matches `Porter Bałtycki Żytnio-Orkiszowy` (bid 6568809).
- **Chyliczki is NOT recovered** (deferred): name `Cydr Chyliczki - Stary Sad 2023` carries a fuller brewery phrase (`Cydr Chyliczki`) than the shop `Chyliczki` field; stripping `chyliczki` leaves `cydr` (not `BREWERY_NOISE`) → still no key intersection. Same partial-prefix class as `Hoppy Hog`.

## Scope decisions (agreed)

- **Aggressiveness (A):** strip the **exact input-brewery token-run wherever it appears** (leading/trailing/mid), then trim leftover **leading/trailing `BREWERY_NOISE`** tokens (catches a stranded trailing `Brewery` *after* the run, e.g. `… Trzech Kumpli Brewery`). FP-safe — only the actual brewery name is removed. The partial-prefix case (`Hoppy Hog` vs name `Hoppy Hog Family Brewery …`) is **deferred**: stripping `Hoppy Hog` leaves `Family Brewery …` (the leftover `Family`/mid `Brewery` are not edge noise), like `Kwak` in PR2.
- **Match-side scope (A — global):** the strip lands in the shared `stripLeadingBrewery`/`nameKeys` primitive, so #155 is fixed in **both** the enrich path (`lookupBeer`) and the `/match` catalog path (`matchPrepared`). The strip is FP-safe and symmetric, so the wider blast radius is acceptable; a `/match` no-regression check is required (below).

## Core helper — `stripBreweryFromName` (replaces `stripLeadingBrewery`)

Generalize `matcher.ts` `stripLeadingBrewery(nameNorm, breweryNorm)` into `stripBreweryFromName(nameNorm, breweryNorm)`:

1. If `breweryNorm` is empty → return `nameNorm` unchanged (passthrough; this is what keeps the #138B brand path — which calls `nameKeys(name, '')` — untouched).
2. Find a **contiguous token-run** in `nameNorm` equal to the brewery's tokens (the `tokenSublist` notion from PR1) — at **any** position. Remove it **only if ≥1 token survives** (never strip a name to empty; if the name *is* the brewery, keep it raw). Remove all non-overlapping occurrences.
3. Trim leftover **leading and trailing `BREWERY_NOISE`** tokens from the result (`brewery`, `browar`, `brewing`, `company`, `co`, `pivovar`, … — already defined in `normalize.ts`; export the set or add a `trimBreweryNoise` helper there).

Leading-prefix is just "run at index 0", so this is a strict superset of today's behavior. It is a drop-in at both existing call sites — `nameKeys` (`matcher.ts:211`) and `fuzzyTargets` (`untappd-lookup.ts:46`) — which gives #155 globally. Rename the function (the old name now lies); update both call sites in the same change.

**FP character unchanged:** only the brewery name is ever removed, and the downstream "<2-token side → no key → fall to fuzzy" rule still guards weak results.

## Consumer — #126 query builder (`cleanSearchQuery`)

Two sites build `stripBreweryNoise(brewery) + " " + name`: `enrich.ts:58` (extension preview `searchUrl`) and `lookupBeer`'s per-part search-URL builder. Replace both with a single new `cleanSearchQuery(brewery, name)` (in `normalize.ts`, next to `stripBreweryNoise`).

`cleanSearchQuery` cleans the **combined** `brewery + " " + name` string in one pass:
1. tokenize on whitespace;
2. **fold** each token = lowercase + strip diacritics + strip non-alphanumerics (so `Co.` → `co`, `Bałtycki` → `baltycki`);
3. drop tokens whose fold is in `BREWERY_NOISE`;
4. **dedup** — drop a token whose fold already appeared;
5. keep the surviving tokens in their **original raw form** (preserve `2023`, flavour words, casing) and join.

**Why combined + fold (verified — the spec's earlier "strip brewery from name" was wrong):** the naive `stripBreweryNoise(brewery) + strippedName` yields `TRACK CO. Taking Shape` because `stripBreweryNoise` leaves `CO.` (the `.` defeats its plain-token `co` check) — and `TRACK CO. Taking Shape` returns **0 items** on Untappd. The fold strips the `.` so `co` is dropped as noise, and dedup removes the second `Track`/`Brewing`/`Company`, giving `TRACK Taking Shape` → **1 item**. Worked: `cleanSearchQuery("TRACK BREWING CO.", "Track Brewing Company Taking Shape")` = `"TRACK Taking Shape"`; `cleanSearchQuery("TRZECH KUMPLI Brewery", "Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli")` = `"TRZECH KUMPLI Porter Bałtycki Żytnio-Orkiszowy"` (dedups the trailing `Trzech Kumpli`).

For non-duplicated beers this is equivalent to today's query (no noise/dups beyond what `stripBreweryNoise` already removed), so it is not a regression for the common case. Query behavior can't be CI-tested (search is mocked in fixtures), so the plan unit-tests `cleanSearchQuery`'s output and **verifies the cleaned query against the captured real Track page** end-to-end.

## #138B interaction (safe by construction)

The PR2 brand path computes `nameKeys(name, '')` (empty brewery) → `stripBreweryFromName` passthrough → brand stays in the key, exactly as #138B needs. The stronger strip only affects `nameKeys(name, brewery)` (Stage 2a), used against breweries that *matched* — where removing the redundant brewery is correct. A brand-in-name case (Murphy's) never reaches Stage 2a with its parent-company candidate (it's in `brandPool`), so there is no conflict.

## Edge cases

- Strip would empty the name → keep it raw (≥1-token guard). The query never goes empty (it still carries the brewery field).
- Strip leaves a single token → existing "<2-token side → no key → fuzzy" path, unchanged.
- Per-`COLLAB_SEP`-side application preserved (helper slots into the same place).
- **Hoppy Hog & Chyliczki deferred** — partial-prefix cases where the name carries a fuller brewery phrase than the brewery field; the strip leaves a non-noise leftover (`Family`, `cydr`) → won't fully match; documented out of scope.

## Testing

- **Unit** (`matcher.test.ts`): `stripBreweryFromName` — leading / trailing run, leftover-noise trim, empty-guard (name == brewery), no-brewery passthrough, multi-occurrence; and the deferred-by-design Chyliczki shape (`Cydr Chyliczki - Stary Sad`, brewery `Chyliczki` → still contains `cydr`, asserting the documented partial behavior).
- **Unit** (`normalize.test.ts`): `cleanSearchQuery` — `("TRACK BREWING CO.", "Track Brewing Company Taking Shape") === "TRACK Taking Shape"`; `("TRZECH KUMPLI Brewery", "Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli")` drops the trailing dup; a non-duplicated beer (`Pinta`, `Atak Chmielu`) → `"Pinta Atak Chmielu"` (no change).
- **#155 real fixture** (`tests/fixtures/untappd-search/trzech.html`): `lookupBeer("TRZECH KUMPLI Brewery", "Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli")` → matched **bid 6568809** (was `not_found`).
- **#126 real fixture** (`tests/fixtures/untappd-search/track-clean.html`, the cleaned-query page): `lookupBeer("TRACK BREWING CO.", "Track Brewing Company Taking Shape")` → matched **bid 6645521**. (The fixtures harness mocks `fetch`, so this proves the *match* works once candidates appear; the *query* cleaning is proven by the `cleanSearchQuery` unit test above.)
- **`/match` no-regression (scope-A blast-radius check):** full `npx jest` green **plus** `scripts/bench-match.ts /var/lib/warsaw-beer-bot/bot.db tmp/beerrepublic.json` showing the matched count is unchanged from before the change — `nameKeys` changed globally.
- FP guard: confirm `stripBreweryFromName` does not over-strip when a beer name legitimately repeats a brewery-like token (rely on the ≥2-token-key + exact-set-equality safety; the unit suite covers the empty-guard and no-passthrough cases).

## spec.md updates (same PR)

§3.1 (name-keys): note the strip now removes the brewery token-run **anywhere** in the name (not just leading) + trims leftover `BREWERY_NOISE`, applied on both the input and (unchanged) candidate sides; shared by `/match` and enrich. Enrich query note: the search query strips the embedded brewery from the name so it isn't doubled (#126).

## Packaging

One PR (the core helper is the bulk; both consumers are small and share it). Split into two only if the diff grows unwieldy — decide in the plan.

## Refs

- Code: `src/domain/matcher.ts` (`stripLeadingBrewery`→`stripBreweryFromName`, `nameKeys`, `tokenSublist`), `src/domain/untappd-lookup.ts` (`fuzzyTargets`, search-URL builder), `src/api/routes/enrich.ts:58` (preview `searchUrl`), `src/domain/normalize.ts` (`BREWERY_NOISE`, `stripBreweryNoise`)
- Issues: #126 (parent #124), #155 (orphan triage 2026-06-14); related #138B (PR2, opposite direction — keep brand when brewery gate fails), #139 (0-candidate retry, different cause)
- Runbook: `docs/debug-orphan-matching.md`; spec.md §3.1 (name-keys), §POST /match
- Workflow: brainstorming → spec → plan → worktree → PR → review → merge → deploy
