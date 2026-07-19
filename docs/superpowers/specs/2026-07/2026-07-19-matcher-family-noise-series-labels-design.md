# Matcher: `family` brewery noise + `Series:` query-label strip (#309 + #303)

**Status:** design
**Issues:** #309 (BREWERY_NOISE += `family`), #303 (strip `Series:` naming labels)
**Date:** 2026-07-19

Two small, independent matcher-query fixes in `src/domain/normalize.ts`, batched into one PR / one server deploy (both are tier-1 P0 wins from the 2026-07-19 matcher-bug review). Both are server-side and deploy independently of the extension.

## Problem

Reproduced against the current code (`cleanSearchQuery` / `normalizeBrewery`):

- **#309:** `HOPPY HOG FAMILY BREWERY` normalises to `hoppy hog family`, but `HOPPY HOG BREWERY` → `hoppy hog`. The `family` token blocks the brewery-gate match (and pollutes the search query). Complements the shipped beerfreak parser fix #305.
- **#303:** `Series:` collection labels survive into the search query and over-constrain Algolia (which ANDs terms) → zero candidates: `Crazy Lines Series: Redwood` → query `Nepomucen Crazy Lines Series: Redwood`; `Gold Series: Blast` unchanged. (Packaging parentheticals like `(puszka)` are **already** stripped by `stripSearchNoise` — verified `Ole! (puszka)` → `NEPO Ole` — so they are **out of scope**.)

## §1 — #309: `family` as brewery noise

Add `'family'` to the `BREWERY_NOISE` set in `src/domain/normalize.ts`. It is dropped by fold-comparison anywhere it appears in a brewery token list (used by both `normalizeBrewery` and `cleanSearchQuery`'s brand-token loop), so:

- `HOPPY HOG FAMILY BREWERY` → `hoppy hog` == `HOPPY HOG BREWERY` → `hoppy hog`.

**False-positive note:** `family` is effectively always a descriptor in brewery names (`X Family Brewery`), never the load-bearing brand token; dropping it is safe. Accepted, matching #309's call.

## §2 — #303: strip a `Series` label prefix

In `stripSearchNoise` (shared by query and match normalisation, so the strip helps both stages consistently), remove a leading label run that ends in the word **`series`** followed by a separator (`:`, `-`, en/em dash). Anchor regex on the `series` keyword:

```
/^.*?\bseries\b\s*[:\-–—]\s*/iu
```

Applied to the name, this yields:

- `Crazy Lines Series: Redwood` → `Redwood`
- `Gold Series: Blast` → `Blast`
- `WORLD CUP SERIES - 5 SPECIAL BEER` → `5 SPECIAL BEER`

**Scope (decided):** anchor on the `series` keyword only — **not** a generic `^<Label>:` strip. All known zero-candidate examples are `Series` labels; a blanket colon-prefix strip risks eating meaningful names (e.g. `Coup D'Etat`). The `\bseries\b` + separator guard leaves names without a series label untouched (`Time Series IPA` — no separator after `series` — is unchanged). Extend to other label words later only if prod data shows them.

**Placement:** add the rule inside `stripSearchNoise`, before the trailing-punctuation / whitespace-collapse tail, so both the search query and the shared match normalisation drop the label. This keeps the query and the name-match keys consistent (structural noise removed from the query cannot be reintroduced downstream — the existing invariant of that helper).

**Ordering caution:** place the `series` strip early enough that it runs on the raw name, but the regex is non-greedy and self-contained, so ordering among the other `stripSearchNoise` replacements does not matter for correctness.

## What this does NOT do

- Not the name-stage reconciliation for candidates that already come back (e.g. `Crazy Lines Series: White & Red` where Untappd keeps the series prefix) — that is #319.
- Not packaging-token stripping — already handled.
- No brewery-alias work (#318), no generic colon labels.

## Testing (Vitest, `src/domain/normalize.test.ts`)

- **#309:** `normalizeBrewery('HOPPY HOG FAMILY BREWERY') === normalizeBrewery('HOPPY HOG BREWERY')` (both `hoppy hog`); a `cleanSearchQuery` case confirming `family` is dropped from the brand tokens.
- **#303:** `stripSearchNoise` / `cleanSearchQuery` cases: the three `Series` examples above strip to their tails; a **negative guard** — `Time Series IPA` (no separator) is unchanged; a name with an unrelated colon is unaffected by the `series`-anchored rule.
- Full `normalize.test.ts` suite stays green (no regression to existing noise-strip cases).

## Rollout

Server-side only; ships via `deploy.sh`. After deploy, run `npm run rearm-matcher-bug-orphans` so backed-off matcher_bug orphans re-attempt against the improved normalisation. No `spec.md` schema change; no `extension/**` change → no extension-docs update.
