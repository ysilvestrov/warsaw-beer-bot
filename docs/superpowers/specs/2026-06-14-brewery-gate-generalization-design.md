# Brewery-gate generalization — design

**Date:** 2026-06-14
**Issues:** #120 (trailing-token brewery), #149 (empty input brewery), #138 Part B (brand-as-beer-name)
**Scope:** enrich path (`lookupBeer`) only. The `/match` catalog path (`matchPrepared`) is explicitly out of scope for this cluster.
**Shipping:** PR1 = #149 + #120 (one PR); PR2 = #138B (separate PR). #138 Part A (STYLE_WORDS) is a different issue, not part of this cluster.

## Problem

The enrich brewery hard-gate (`untappd-lookup.ts` Stage 1) drops any Untappd search result whose brewery does not pass `breweryAliasesMatch` — a **leading-prefix-only**, token-boundary overlap of the normalized brewery aliases. This is intentionally strict to avoid false positives, but it rejects correct candidates in three recurring shapes seen across `enrich_failures` (prod, 2026-06-12/14):

| # | Shape | Example (input → returned candidate, gated out) |
|---|-------|--------------------------------------------------|
| #149 | **Empty input brewery** — `breweryAliases('') = []`, so `breweryAliasesMatch(x, [])` is always false → *every* candidate rejected | `brewery=''`, `St-Feuillien Blonde` → `Brasserie St-Feuillien — St-Feuillien Blonde` |
| #120 | **Trailing/contained-token brewery** — shop label is a non-leading token of the real Untappd brewery | `Staropolski` / `Kultowe Pils` → `Kultowy Browar Staropolski — Kultowe Pils` |
| #138B | **Brand-as-beer-name** — the input brewery token lives in the candidate *beer name*, not its brewery (Untappd files the beer under a parent company) | `Murphy's` / `Murphy's Irish Stout` → `Heineken Ireland — Murphy's Irish Stout` |

All three are the *same* gate being too strict in different directions, so they share one FP-safety rule and are designed together. Fixing them piecemeal would compound false positives in the same gate unpredictably.

## FP-safety spine (principle A)

> A **strict** brewery match (current leading-prefix overlap) keeps full access to both name stages — exact name-keys (Stage 2a) **and** fuzzy ≥ 0.85 (Stage 2b). Any **relaxed** brewery match (empty / contained-token / brand-in-name) is only allowed to pair with an **exact name-key intersection** (Stage 2a: ≥2 tokens, order-insensitive — already FP-safe per spec §3.1). Fuzzy is never combined with a weak brewery signal.

A relaxed brewery match therefore still requires a near-certain name match, so orphan recovery does not trade away false-positive safety.

## Architecture — brewery-match strength in Stage 1

Replace the single Stage-1 filter with **two pools**:

- **strictPool** — results passing the current `breweryAliasesMatch` (leading-prefix). Behaviour unchanged.
- **relaxedPool** — results passing a *relaxed* predicate but **not** strict.

Name-matching then applies principle A:

1. **Stage 2a (exact name-keys)** runs on **strict ∪ relaxed**.
2. **Stage 2b (fuzzy ≥ 0.85)** runs on **strict only**.
3. Strict wins ties: evaluate strict candidates first; a relaxed exact-key hit is used only when no strict match exists.

The existing strict path is otherwise untouched, bounding the blast radius. `breweryAliasesMatch` / `tokenPrefix` are **not** modified — the relaxation lives in a new predicate applied alongside them.

### Control flow (revised `lookupBeer` per search part)

```
results = parseSearchPage(html)
strict  = results.filter(strictBreweryMatch)
relaxed = results.filter(r => !strictBreweryMatch(r) && relaxedBreweryMatch(r))   // PR1
// PR2 adds brand-in-name candidates into a third set (see below)

// Stage 2a — exact name-keys on strict ∪ relaxed
keyHits = (strict ∪ relaxed).filter(r => intersects(nameKeys(r.beer_name, r.brewery_name), inputKeys))
if keyHits: return abvTiebreak(keyHits)

// Stage 2b — fuzzy ≥0.85 on strict ONLY  (unchanged from today, but pool = strict, not breweryPassed)
... existing fuzzy logic over `strict` ...
```

When `strict` and `relaxed` are both empty (and, in PR2, no brand-in-name hit), the part yields nothing and the loop falls through to `not_found`, exactly as today.

## PR1 — relaxation predicates (#149, #120)

`relaxedBreweryMatch(candidateAliases, inputAliases)` is the union of:

**#149 — empty input brewery.** If `inputAliases.length === 0`, every result is relaxed (gate bypassed).
- Verified end-to-end: `brewery=''`, `St-Feuillien Blonde` → search is name-only → returns `Brasserie St-Feuillien — St-Feuillien Blonde`; input name-key `{blonde feuillien st}` exactly intersects the candidate's key → match.
- FP guard: exact ≥2-token key only. A name collapsing to <2 tokens (single token, or all style-words stripped) yields no key → no match, as today.

**#120 — contained (non-leading) brewery token-run.** Generalize the prefix test: today the shorter alias must be a *leading* prefix of the longer; the relaxed predicate accepts the shorter alias appearing as a **contiguous token-sublist anywhere** within the longer (either direction, mirroring `breweryAliasesMatch`'s symmetry).
- `staropolski` is the trailing token of candidate alias `kultowy staropolski` (`browar` already stripped as noise by `normalizeBrewery`) → relaxed; beer name `Kultowe Pils` exact-key matches → match.
- FP guard: exact name-key still required, so a contained brewery-token match with a different beer name never matches. Noise tokens are already stripped, so the contained run is always content tokens. Single-token contained matches (e.g. `staropolski`) are allowed *because* the exact-name-key requirement compensates.

**Implementation:** one new exported helper in `matcher.ts` — e.g. `breweryAliasContained(a: string[], b: string[]): boolean` (contiguous-sublist test over normalized aliases), and an empty-input check in `lookupBeer`. `breweryAliasesMatch` and `tokenPrefix` are unchanged.

## PR2 — brand-as-beer-name (#138B), designed but isolated

For candidates failing **both** strict and PR1-relaxed gates, compute an extra key from the input's **brewery + name surface treated as a single name** (do *not* strip the brewery) and intersect it with the candidate's beer-name keys.

- Murphy's: input surface keys `{irish murphy s stout}` == candidate `Murphy's Irish Stout` keys → match. This is exact full-surface equality — naturally satisfies principle A and is very FP-safe.

These brand-in-name hits join the exact-name-key stage (never fuzzy).

**Deliberately deferred to a future effort (NOT solved in PR2):** two of the issue's own examples need looser matching than exact full-surface equality and are left as open design points rather than forced now:
- `Kwak` / `Pauwel Kwak Rouge` → `Kwak Rouge` — input carries an extra token (`Pauwel`); not an exact set match.
- `Tradycynis` / `Ananasowe` → `Tradycynis Ananasowy` — Polish inflection (`ananasowe` ≠ `ananasowy`); exact key fails and principle A forbids fuzzy on a relaxed match.

PR2 ships only the exact full-surface (Murphy's-class) case so the FP-risky piece stays small and testable; we evaluate whether the safe subset suffices before reaching for anything looser.

## Out of scope

- **Search-query changes.** All three cases already return the correct candidate from Untappd; only the gate rejects it. Query hygiene (name repeats brewery, over-specified queries) is #126 / #139, not here.
- **`/match` catalog path.** Same gate, but a ~29k-row candidate pool gives a much larger FP surface. The new predicate is written reusably so `/match` can adopt it later under its own risk review.
- **#138 Part A** (STYLE_WORDS) — separate issue.

## Testing

- **Unit tests** (`untappd-lookup.test.ts`) with synthetic `SearchResult[]`:
  - Positive: Staropolski (#120), St-Feuillien empty-brewery (#149), Murphy's (#138B, PR2) now return `matched`.
  - FP guards: relaxed-brewery (empty or contained-token) + a *different* beer name → `not_found`; empty-brewery + sub-2-token name → `not_found`; a relaxed brewery match must NOT be reachable via fuzzy (only exact key).
  - Regression: existing strict-path cases unchanged (strict brewery still matches via fuzzy).
- **One real fixture per relaxation** in `tests/fixtures/untappd-search/`, captured via the runbook (`docs/debug-orphan-matching.md` step 3) download of the failing `search_url`, run through `lookupBeer` with `fetch = () => html`, asserting the previously-orphaned beer now matches.

## spec.md updates (same PR as code)

§5.2 (matching invariants): document brewery-match **strength** (strict = leading-prefix; relaxed = empty-input bypass / contained-token / brand-in-name) and the **"relaxed ⇒ exact-name-key only, never fuzzy"** rule. Note the gate stays leading-prefix-strict for the fuzzy path. PR2 adds the brand-in-name (full-surface) rule when it ships.

## Refs

- Code: `src/domain/untappd-lookup.ts` (Stage 1/2), `src/domain/matcher.ts` (`breweryAliasesMatch`, `tokenPrefix`, `nameKeys`, new `breweryAliasContained`), `src/domain/normalize.ts` (`normalizeBrewery`)
- Issues: #120, #149, #138 (Part B); parent lineage #117, #136
- Runbook: `docs/debug-orphan-matching.md` (repro), `spec.md` §3.1 (name-keys), §5.2 (matching invariants)
- Workflow: PR1 (#149+#120) → writing-plans → worktree; PR2 (#138B) follows.
