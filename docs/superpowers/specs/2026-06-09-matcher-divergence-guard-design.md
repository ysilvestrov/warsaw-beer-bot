# Matcher divergence guard + exact-only personal claims — design

**Date:** 2026-06-09
**Status:** approved (brainstorming)
**Builds on:** [extension ⭐ global-rating badge + Untappd link](2026-06-09-extension-global-rating-untappd-link-design.md)

## Problem

A shop beer with no catalog entry gets a **false fuzzy match** to a different flavour
variant of the same base beer, and that wrong match then carries a strong personal claim.

Reproduced on prod: input `Magnify — Double Vanilla Mind Over Matter` (not in the
catalog) fuzzy-matched `6203 "S'mores Mind Over Matter"` at confidence **0.78125**
(threshold 0.75). The user has a check-in for 6203, so the result came back
`is_drunk: true` — telling the user they drank a beer they did not.

Root cause: `fast-fuzzy` scores `"magnify vanilla mind over matter"` vs
`"magnify s mores mind over matter"` above threshold because the shared tail
(`magnify … mind over matter`) dominates and the distinguishing tokens (`vanilla` vs
`s mores`) are a minority of the string. `is_drunk` = `triedBeerIds.has(matched.id)`
(union of check-ins + had-list), so a wrong match inherits the matched beer's drunk
status. This is pre-existing matcher behaviour, surfaced by the new overlay badges; the
`untappd_id` change did not cause it.

## Goal

Two independent, server-only changes (the `/match` response shape does **not** change, so
the extension needs no edit):

- **A — divergence guard:** stop the fuzzy matcher from accepting a candidate that
  diverges from the input on content tokens (different flavour variant).
- **B — exact-only personal claims:** only assert `is_drunk` / personal rating for
  **exact** matches; a fuzzy match still yields `matched_beer` (so the overlay shows the
  ⭐ global rating) but never claims the beer was drunk or personally rated.

Cost asymmetry behind both: a missed match (no badge) is far cheaper than a false
"✅ you drank this". The matcher errs toward false-negatives; strong personal claims
require certainty.

## A. Divergence guard (`src/domain/matcher.ts`)

New pure, unit-testable helper:

```
nameTokensDiverge(a: string, b: string): boolean
```

- Both inputs are already-normalized names (`normalizeName` output — style words,
  brewery noise, and pure-digit tokens already stripped).
- Tokenize on spaces; ignore fragments shorter than 2 chars (drops the apostrophe-junk
  `s` from `s'mores` → `s mores`).
- Let `I` = input token set, `C` = candidate token set. Return `true` (diverge) iff
  **both** `I \ C ≠ ∅` **and** `C \ I ≠ ∅` — each side has a content token the other
  lacks.

In `matchPrepared`, the fuzzy branch computes `best = results[0]` as today, then:

```
if (nameTokensDiverge(nn, best.item.nameNorm)) return null;
```

- Only the **top** fuzzy candidate is checked — if the best fuzzy match diverges, lower
  ones are even less similar; and when an exact-normalized candidate exists it is
  returned by the exact branch before fuzzy runs.
- Exact matches are unaffected (their tokens are equal, so divergence is impossible).

Behaviour table:

| input name | candidate name | I\C, C\I | result |
| --- | --- | --- | --- |
| vanilla mind over matter | s mores mind over matter | {vanilla}, {mores} | **reject** |
| clementine passionfruit | clementine | {passionfruit}, {} | allow (subset) |
| vanilla mind over matter | mind over matter | {vanilla}, {} | allow (base beer) |

This is shared by the bot's ontap→catalog matching too. The rule is conservative (rejects
only genuine two-sided divergence, tolerates abbreviation/addition), so the added
false-negative risk for ontap matching is small and acceptable.

## B. Exact-only personal claims (`src/domain/match-list.ts`)

`matchPrepared` already returns `source: 'exact' | 'fuzzy'`; `matchBeerList` currently
discards it. Thread it into the per-result gating (in the matched branch):

```
const isExact = m.source === 'exact';
// ...
is_drunk: isExact && drunkSet.has(m.id),
user_rating: isExact ? (ratingByBeerId.get(m.id) ?? null) : null,
```

`matched_beer` (id, name, brewery, rating_global, untappd_id) is still built for both
exact and fuzzy matches, so a fuzzy match shows the ⭐ global rating; it just never
claims drunk/personal. `/match` is extension-only, so this does not affect the bot's
ontap rating display.

## Data flow / surface

No change to the `/match` response shape, `MatchedBeer` types (server or extension),
the badge, or the extension cache. Both changes live in `src/domain/`.

## Error handling / edge cases

- Empty normalized name on either side → token set is empty → at most one-sided
  difference → never diverges (guard is a no-op); the fuzzy score already gates these.
- A fuzzy match to a genuinely-drunk beer now shows ⭐ (global) instead of ✅ — an
  intentional conservative trade-off.
- Subset names (one side's tokens ⊆ the other) are allowed, preserving
  abbreviation/addition tolerance the ontap matcher relies on.

## Testing

- **`src/domain/matcher.test.ts`** — `nameTokensDiverge`: diverge (vanilla vs s'mores),
  subset both directions → false, equal → false, sub-2-char fragments ignored.
  Integration: a catalog containing only `S'mores Mind Over Matter` + input
  `Double Vanilla Mind Over Matter` → `matchBeer` returns `null`; a subset input still
  matches.
- **`src/domain/match-list.test.ts`** — a fuzzy match whose id is in the drunk set →
  `is_drunk: false`, `user_rating: null`; an exact match in the drunk set →
  `is_drunk: true` with its personal rating.
- All existing `matcher` / `match-list` / `conformance` / `match` suites stay green (the
  guard must not break known-good fuzzy matches).

## Spec

`spec.md` matching section — add: the fuzzy matcher rejects candidates that diverge from
the input on content tokens; `is_drunk`/personal rating are asserted only for exact
matches (fuzzy yields the global rating only).

## Out of scope

- Raising `FUZZY_THRESHOLD` (chose the targeted divergence guard instead).
- Scanning lower-ranked fuzzy candidates when the top one diverges.
- Exposing `confidence`/`source` in the `/match` response (B is enforced server-side).
- Changing the badge, extension types, or cache.
