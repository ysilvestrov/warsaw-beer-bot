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

> A **strict** brewery match (current leading-prefix overlap) keeps full access to both name stages — exact name-keys (Stage 2a) **and** fuzzy ≥ 0.85 (Stage 2b). Any **relaxed** brewery match (empty / contained-token / brand-in-name) is only allowed to pair with an **exact** name match — either an exact **name-key intersection** (Stage 2a: ≥2 tokens, order-insensitive — FP-safe per spec §3.1) **or an exact normalized-name equality** (the candidate's normalized beer-name *equals* one of the input's name targets). An **approximate fuzzy** match (≥0.85 but <1.0) is **never** combined with a weak brewery signal.

A relaxed brewery match therefore still requires a near-certain name match, so orphan recovery does not trade away false-positive safety.

**Why exact-name equality is required in addition to name-keys (empirically verified 2026-06-14):** the real failing names routinely collapse below the name-key path, so key-only recovers *neither* live orphan:
- `KULTOWE PILS` (#120): `pils` is a style-word → name reduces to the single token `kultowe` → no ≥2-token key. It only matches via `kultowe` == `kultowe`.
- `St-Feuillien Blonde` (#149): the candidate strips its *own* embedded brewery (`Brasserie St-Feuillien` → beer-name `Blonde`) → single token → empty key, while the input keeps `{blonde feuillien st}` → no intersection. It only matches via `st feuillien blonde` == `st feuillien blonde`.

Both recover through **exact normalized-name equality** (not keys, not fuzzy). The `Reserve`/`Reserva` near-miss (fuzzy 0.955) is correctly rejected because it is not *exact*. The input's name targets are the same `fuzzyTargets(name, brewery)` values Stage 2b already computes.

## Architecture — brewery-match strength in Stage 1

Replace the single Stage-1 filter with **two pools**:

- **strictPool** — results passing the current `breweryAliasesMatch` (leading-prefix). Behaviour unchanged.
- **relaxedPool** — results passing a *relaxed* predicate but **not** strict.

Name-matching then applies principle A:

1. **Stage 2a (exact name-keys)** runs on **strict ∪ relaxed**.
2. **Stage 2b (fuzzy ≥ 0.85)** runs on **strict only**.
3. **Relaxed exact-name:** a relaxed candidate whose normalized beer-name *equals* one of the input's name targets is accepted (exact only, never approximate).
4. Strict wins ties: evaluate the strict fuzzy match first; a relaxed exact-name/key hit is used only when no strict match exists.

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
strictMatch = fuzzy(strict, targetNames) >= 0.85  →  if found: return abvTiebreak(strictMatch)

// Relaxed exact-name — EXACT normalized-name equality only (never approximate)
relaxedExact = relaxed.filter(r => targetNames.some(t => normalizeName(r.beer_name) === t.value))
if relaxedExact: return abvTiebreak(relaxedExact)
```

When `strict` and `relaxed` are both empty (and, in PR2, no brand-in-name hit), the part yields nothing and the loop falls through to `not_found`, exactly as today.

## PR1 — relaxation predicates (#149, #120)

`relaxedBreweryMatch(candidateAliases, inputAliases)` is the union of:

**#149 — empty input brewery.** If `inputAliases.length === 0`, every result is relaxed (gate bypassed).
- Verified end-to-end against the captured real page (`tests/fixtures/untappd-search/st-feuillien.html`): `brewery=''`, `St-Feuillien Blonde` → search is name-only → returns `Brasserie St-Feuillien — St-Feuillien Blonde` (bid 22540). Match is via **exact normalized-name equality** (`st feuillien blonde` == `st feuillien blonde`); the name-key path does not fire because the candidate strips its embedded brewery to a single token.
- FP guard: exact name (key or full-name equality) only — never approximate fuzzy. The page also lists `Bière Léon` (different brewery, different name) which is correctly *not* matched. Residual risk: a generic single-token input name could exact-match a different brewery's same-named beer; distinctive multi-token names (the actual winetime cases) are safe.

**#120 — contained (non-leading) brewery token-run.** Generalize the prefix test: today the shorter alias must be a *leading* prefix of the longer; the relaxed predicate accepts the shorter alias appearing as a **contiguous token-sublist anywhere** within the longer (either direction, mirroring `breweryAliasesMatch`'s symmetry).
- Verified against the real page (`staropolski.html`): input `Staropolski` is the trailing token of candidate alias `kultowy staropolski` (`browar` stripped as noise by `normalizeBrewery`) → relaxed; beer `Kultowe Pils` (bid 1673808) matches via **exact normalized-name equality** (`kultowe` == `kultowe`, after `pils` is dropped as a style-word). The other Staropolski beers on the page (`Rodowite Pils`, etc.) do not match.
- FP guard: exact name (key or full-name equality) still required, so a contained brewery-token match with a *different or merely approximate* beer name never matches — e.g. a `Reserve`/`Reserva` near-miss (fuzzy 0.955) is rejected. Noise tokens are already stripped, so the contained run is always content tokens; single-token contained matches (e.g. `staropolski`) are allowed because the exact-name requirement compensates.

**Implementation:** one new exported helper in `matcher.ts` — e.g. `breweryAliasContained(a: string[], b: string[]): boolean` (contiguous-sublist test over normalized aliases), and an empty-input check in `lookupBeer`. `breweryAliasesMatch` and `tokenPrefix` are unchanged.

## PR2 — brand-as-beer-name (#138B), designed but isolated

The brand on the shelf is the input *brewery*, but Untappd files the beer under a parent company, so the brand sits inside the candidate *beer name* (`Murphy's` / `Murphy's Irish Stout` → `Heineken Ireland — Murphy's Irish Stout`). The PR1 gates don't help — the input brewery isn't in the candidate's brewery at all.

**Mechanism (verified 2026-06-14 against the real Untappd page).** For a candidate that fails **both** the strict and PR1-relaxed brewery gates, two conditions must BOTH hold:

1. **Brand-in-name gate.** The input brewery must appear as a **contiguous token-run inside the candidate's beer name** — `breweryAliasContained(inputBreweryAliases, [normalizeName(candidate.beer_name)])`. This is essential: without it, two unrelated breweries that merely share a beer name (input brewery NOT in the name) would match on name alone — a real false positive, since the brewery gate is fully bypassed here.
2. **Exact name match.** `nameKeys(input.name, '')` (input name with the brewery **NOT** stripped, so the brand stays in the key) must intersect the candidate's `nameKeys(beer_name, brewery_name)`. Exact key only — never fuzzy (principle A).

Verified end-to-end (fixture `tests/fixtures/untappd-search/murphys.html`): input `Murphy's Brewery` / `Murphy's Irish Stout` matches `Heineken Ireland — Murphy's Irish Stout` (bid 5932) and correctly **rejects** the four other Murphy variants on the same page (`Mike Murphy's…`, `Murphys Dry…`, `Murphy's Law…`, `Murphy And Son's…` — different name-keys). FP control: `Pinta` / `Atak Chmielu` vs an unrelated brewery with the same beer name (brand not in the name) → `not_found`.

These brand-in-name hits join the exact-name stage (never fuzzy). In `lookupBeer` they form a third pool evaluated after strict-fuzzy and relaxed-exact (strict still wins).

**Deliberately deferred to a future effort (NOT solved in PR2):** both pass the brand-in-name gate but fail the exact name match, and are left as open design points rather than forced now:
- `Kwak` / `Pauwel Kwak Rouge` → `Kwak Rouge` — input carries an extra token (`Pauwel`): `{kwak pauwel rouge}` ≠ `{kwak rouge}`.
- `Tradycynis` / `Ananasowe` → `Tradycynis Ananasowy` — input name `Ananasowe` is a single token (no ≥2-token key) AND a Polish inflection (`ananasowe` ≠ `ananasowy`); exact key fails and principle A forbids fuzzy on a relaxed match.

PR2 ships only the exact-name (Murphy's-class) case so the FP-risky piece stays small and testable; we evaluate whether the safe subset suffices before reaching for anything looser.

## Out of scope

- **Search-query changes.** All three cases already return the correct candidate from Untappd; only the gate rejects it. Query hygiene (name repeats brewery, over-specified queries) is #126 / #139, not here.
- **`/match` catalog path.** Same gate, but a ~29k-row candidate pool gives a much larger FP surface. The new predicate is written reusably so `/match` can adopt it later under its own risk review.
- **#138 Part A** (STYLE_WORDS) — separate issue.

## Testing

- **Unit tests** (`untappd-lookup.test.ts`) with synthetic `SearchResult[]`:
  - Positive: Staropolski (#120), St-Feuillien empty-brewery (#149), Murphy's (#138B, PR2) now return `matched`.
  - FP guards: relaxed-brewery (empty or contained-token) + an *approximate* beer name (e.g. `Reserve` vs `Reserva`, fuzzy 0.955) → `not_found`; relaxed-brewery + a clearly *different* beer name → `not_found`. These prove a relaxed brewery is NOT reachable via approximate fuzzy — only exact name/key.
  - Regression: existing strict-path cases unchanged (strict brewery still matches via fuzzy ≥0.85).
- **One real fixture per relaxation** in `tests/fixtures/untappd-search/` (#120: existing `staropolski.html`, flip `bid: null` → 1673808; #149: new `st-feuillien.html` captured via the runbook, assert bid 22540), run through `lookupBeer` with `fetch = () => html`, asserting the previously-orphaned beer now matches.

## spec.md updates (same PR as code)

§5.2 (matching invariants): document brewery-match **strength** (strict = leading-prefix; relaxed = empty-input bypass / contained-token / brand-in-name) and the **"relaxed ⇒ exact name (key intersection OR exact normalized-name equality), never approximate fuzzy"** rule. Note the gate stays leading-prefix-strict for the fuzzy (≥0.85) path. PR2 adds the brand-in-name (full-surface) rule when it ships.

## Refs

- Code: `src/domain/untappd-lookup.ts` (Stage 1/2), `src/domain/matcher.ts` (`breweryAliasesMatch`, `tokenPrefix`, `nameKeys`, new `breweryAliasContained`), `src/domain/normalize.ts` (`normalizeBrewery`)
- Issues: #120, #149, #138 (Part B); parent lineage #117, #136
- Runbook: `docs/debug-orphan-matching.md` (repro), `spec.md` §3.1 (name-keys), §5.2 (matching invariants)
- Workflow: PR1 (#149+#120) → writing-plans → worktree; PR2 (#138B) follows.
