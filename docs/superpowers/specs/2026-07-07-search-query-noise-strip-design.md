# Design: safe search-query noise stripping (gh #236)

**Date:** 2026-07-07
**Issue:** #236 — Matcher: normalise query (adjunct lists, spec strings, collab parens, stripped tokens)
**Class:** `enrich_failures.review_class = 'matcher_bug'`

## Problem (re-framed from the issue, verified against prod + live Algolia)

The Untappd enrich search runs through Algolia, which **ANDs every term** in the query.
Any noise term that is not textually present in the target beer record drops the whole
query to zero hits. `cleanSearchQuery(brewery, name)` keeps tokens in raw form (to preserve
case/diacritics) and never runs `baseNormalize`, so structural punctuation and spec strings
leak straight into `?q=` and over-constrain the search.

Verified against the real `enrich_failures` rows and reproduced against live Algolia
(`9WBO4RQ3HO` / public search key):

| beer_id | input name | leaner query → hits | root cause |
|---|---|---|---|
| 30888 | `Wonders [passionfruit,banana, coconut cream]` | `Magic Road Wonders` → **23** | bracketed adjunct list |
| 31266/67 | `Dynaboost: Mosaic (collab Yakima Chief)` | `Funky Fluid Dynaboost: Mosaic` → **1** | collab parenthetical |
| 12082 | `NoLo – Hemperor <0,5% alc <0,5%` | `Piwne Podziemie NoLo Hemperor` → **1** | ABV/spec string |
| 31170 | `Owocowa Fantazja #1 - Pastry Sour z Guavą, Mango…` | `Zakładowy Owocowa Fantazja` → **5** (real match present) | bare `#N - …,…` tail (no brackets) |
| 30875 | `Red Sour` | brewery found (`NOWY GDAŃSKI` → 29 hits); **no "Red Sour" exists** | beer not on Untappd |

**Two corrections to the issue's framing:**
- «browar» is a red herring: `NOWY GDAŃSKI` already returns 29 hits; the brewery is found
  fine with or without the token. `BREWERY_NOISE` stripping is not the cause.
- Cleaning punctuation alone is **not enough**: keeping the adjunct words as bare terms
  (`… Wonders passionfruit banana coconut cream`) still returns **0**, because the input's
  descriptors don't textually match the catalog (`passionfruit`≠`Pineapple`, `Guavą`≠`Guawa`,
  `Yakima Chief` absent from the beer name). The descriptive tail must be **dropped**, not
  cleaned — leaving brewery + core name. Downstream fuzzy matching (which uses the raw name
  with adjuncts, separately) then disambiguates variants; the existing `nameTokensDiverge`
  guard protects against inheriting the wrong variant.

## Scope

**Safe fix only** (user decision): strip structural bracket groups and ABV/spec strings.
Fixes 30888, 31266, 31267, 12082. Explicitly **out of scope** (deferred, tracked in #236):
- 31170 — bare comma / `#N` adjunct tail without brackets. A heuristic here risks truncating
  legitimate names (`X - Imperial Edition`). Left as a deferred follow-up note on #236.
- 30875 — not a query bug; reclassify to `not_on_untappd`.

## Change: `cleanSearchQuery` (`src/domain/normalize.ts`)

Add a `stripSearchNoise(raw: string): string` helper and apply it to the combined
`stripLegalForm(brewery) + ' ' + name` string **before** the existing tokenize/dedup loop.
Everything else (`BREWERY_NOISE` drop, dedup-by-fold, fold-empty-drop of pure-punctuation
tokens, fallback) is unchanged.

`stripSearchNoise` removes, in order:
1. Balanced bracket groups `[...]` and `(...)` → space (adjunct lists, `(collab …)`,
   `(batch/2023)` vintage notes).
2. Any leftover stray bracket characters `[](){}` → space (dangling/unbalanced brackets).
3. ABV/spec: percentages `[<>]?\s*N[.,]?N?\s*%` (`<0,5%`, `4.5%`, `0,5 %`), degree readings
   `N°`, and standalone spec labels `\b(alc|abv|ibu)\b` (case-insensitive).
4. Collapse runs of whitespace, trim.

Rationale for dropping whole `(...)`/`[...]` groups: for search these carry adjuncts, collab
notes, and batch/vintage decorations — never the core beer name. Low FP risk, matches the
"safe" intent. The colon in `Dynaboost:` is left intact (verified: Algolia tokenizes it).

**Fallback fix:** when the strip+clean+dedup pass empties the query, fall back to the
**noise-stripped** name (then brewery) instead of the raw name, so brackets/spec are never
re-injected into `?q=`.

## Testing (TDD, extend `src/domain/normalize.test.ts`)

New `cleanSearchQuery` cases (exact expected output), plus the existing 7 stay green:
- `('Magic Road Brewery', 'Wonders [passionfruit,banana, coconut cream]')` → `'Magic Road Wonders'`
- `('Funky Fluid', 'Dynaboost: Mosaic (collab Yakima Chief)')` → `'Funky Fluid Dynaboost: Mosaic'`
- `('Piwne Podziemie Brewery', 'NoLo – Hemperor <0,5% alc <0,5%')` → `'Piwne Podziemie NoLo Hemperor'`
- dangling/unbalanced paren, e.g. `('Funky Fluid', 'Mosaic (collab Yakima Chief')` → no stray `(`
- bracket-only name (all-noise) → non-empty fallback (brewery), never empty `?q=`

## Operational tail (same PR / deploy)

1. **spec.md** — extend §734 (`cleanSearchQuery` dedup) with the noise-stripping behavior;
   reconcile the wording at ~§1111 / ~§1296. Required by CLAUDE.md (spec = source of truth).
2. **Reclassify 30875** — set `review_class='not_on_untappd'` in prod `enrich_failures` via
   the sudo helper (script staged under `./tmp/`), so triage stops re-surfacing it.
3. **Issue #236** — comment + edit body: drop the «browar»/stripped-token framing and the
   30875 example; record that the PR fixes 30888/31266/31267/12082 and 31170 is deferred.
4. **Re-arm (critical — else the fix is invisible):** the affected orphans were freshly
   backed-off today, so enrich won't retry them until backoff expires. After deploy, re-arm
   them (run the compiled matcher as `warsaw-beer-bot`, per the prod-run quirk) and verify via
   the read-only prod DB that they clear from `enrich_failures`.

## Non-goals

- No change to Algolia transport, downstream matcher stages, `fuzzyTargets`, or backoff logic.
- No change to `BREWERY_NOISE` / `normalizeBrewery` (the «browar» token is deliberately untouched).
