# #653 — Leading Article Normalization in Beer Names: Design

**Date:** 2026-10-08  
**Status:** proposed  
**Issue:** #653  

## Problem

Orphan issue #653 tracks matcher attribution failures where an input from a pub or shop and an Untappd candidate belong to the identical brewery, but divergence on a leading grammatical article (`The `) prevents reconciliation during name matching.

### Affected Rows and Live Reach

- **Row 37244: `Brooklyn Brewery / Brooklyn Stonewall Inn IPA 10,6°` @ 4.6% ABV**
  - **Live Tap Presence:** On tap in Warsaw pubs (*Antycafe*, *Kicia Kocia*) as of 2026-10-08 (`taps` snapshot 12:01 UTC).
  - **Untappd Candidate 1:** `Brooklyn Brewery — The Stonewall Inn IPA` (bid `2885563`, 4.0% ABV, 122,449 ratings).
  - **Untappd Candidate 2:** `Brooklyn Brewery — The Stonewall Inn IPA Session IPA` (bid `6992173`, 4.6% ABV, 0 ratings, European export variant).
  - **Rejection Mechanism:**
    - The shop name after brewery stripping has tokens: `['stonewall', 'inn']`.
    - Both Untappd candidates retain the leading article `the`, producing tokens: `['the', 'stonewall', 'inn']`.
    - **Stage 2a (`nameKeys`):** The input key set `{'inn stonewall'}` and candidate key set `{'inn stonewall the'}` have zero intersection.
    - **Stage 2a.5 (`nearMatches`):** Both candidates match near-name scoring, but `dominantCandidate` selects leader bid `2885563` (4.0% ABV) and vetoes it against the input's 4.6% ABV because `|4.0 - 4.6| = 0.6 > 0.3` (`ABV_TOLERANCE`). Candidate `6992173` (4.6% ABV) has 0 ratings and does not dominate, resulting in a terminal `not_found`.

---

## Catalog Analysis & Evidence

An exhaustive query of the full production catalog (`35,641` beers in `bot.db`) revealed:
- **1,322 beers** contain `the`.
- **845 beers** contain `the` in the middle of a title phrase (*"Eye of the Tiger"*, *"Seasons in the abyss"*, *"Todd - The Axe Man"*). In mid-title phrases, `the` is grammatical and almost never dropped by shops.
- **503 beers** begin with leading `The `.
  - **144 beers** have exactly 2 tokens (`The Alchemist`, `The Abyss`, `The Expanse`). Unconditionally removing `the` would reduce them to a single token, which `nameKeys` (§3.1) drops as weak keys.
  - **363 beers** have $\ge 3$ tokens (`The Stonewall Inn IPA`, `The Good Cider Pear`, `The Real Hr. Frederiksen`). Stripping `the` leaves $\ge 2$ strong tokens.
- **Zero collisions:** In the entire database, there is not a single instance of a brewery producing two distinct products named `The X` and `X`. Exactly 3 pairs exist across the entire catalog under the same brewery, and all 3 represent the identical beer with and without vintage tags or series identifiers.

---

## Decisions

### 1. Leading Article Stripping in `normalizeName` ([src/domain/normalize.ts](file:///home/ysi/warsaw-agy-bb/src/domain/normalize.ts))

In `normalizeName`, strip a leading `the` token **only when the remainder preserves at least 2 tokens**:

```ts
export function normalizeName(s: string): string {
  const tokens = baseNormalize(preserveDecimalIdentifiers(stripSearchNoise(s)))
    .split(' ')
    .filter((t) => t && !STYLE_WORDS.has(t) && !SPEC_LABEL_WORDS.has(t) && !isNumericNoise(t));
  if (tokens.length >= 3 && tokens[0] === 'the') {
    tokens.shift();
  }
  return tokens.join(' ');
}
```

#### Invariants:
1. **Safety for 2-token names:** Short names such as `The Alchemist` or `The End` retain `the` so their `normalizeName` remains 2 tokens and produces valid `nameKeys`.
2. **Safety for style-only tails:** A hypothetical `The IPA` has 1 token after `STYLE_WORDS` filtering (`['the']`); `tokens.length < 3` prevents stripping `the`, avoiding collapse to an empty string.
3. **Mid-title safety:** Titles like `Son Of The Son` or `Eye of the Tiger` start with `son`/`eye` and are untouched.
4. **Symmetric effect:** Applies to both the input side and candidate side identically.
   - Input `Stonewall Inn IPA` $\to$ `stonewall inn`
   - Candidate `The Stonewall Inn IPA` $\to$ `stonewall inn`
   - Both generate `nameKeys: {'inn stonewall'}` and match in Stage 2a (`keyHits`).
   - In Stage 2a, `pickByAbv` matches candidate `6992173` (4.6% ABV) with exact ABV agreement, or falls back to canonical `2885563` when ABV is null/within tolerance.

### 2. Trailing/Embedded Brewery Echo Guard ([src/domain/style-identity.ts](file:///home/ysi/warsaw-agy-bb/src/domain/style-identity.ts))

In `stripBreweryFromName`, after stripping brewery tokens, if the remaining tokens start with `the` and have length $\ge 3$, trim `the`:
```ts
if (nt.length >= 3 && nt[0] === 'the') nt.shift();
```
This ensures that if a raw name begins with the brewery brand before `The` (e.g. `Brooklyn The Stonewall Inn`), stripping the brewery brand still normalizes onto `stonewall inn`.

### 3. Specification Update ([spec.md](file:///home/ysi/warsaw-agy-bb/spec.md))

Document under §3.1 that leading grammatical article `the` is normalized out of beer names when the remaining name retains $\ge 2$ tokens, preserving exact matching across variants where shops or Untappd drop/add the article.

---

## Claims and Their Evidence

| Claim | What records it as fact | Evidence proving it |
| :--- | :--- | :--- |
| Row 37244 is an active Warsaw orphan for *Brooklyn Brewery — The Stonewall Inn IPA* | `enrich_failures` row 37244 | Live `taps` snapshots (2026-10-08 12:01) in *Antycafe* & *Kicia Kocia* @ 4.6% ABV; Untappd Algolia candidates bid `2885563` & bid `6992173`. |
| No brewery produces distinct beers conflicting on `The X` vs `X` | Domain matching safety | SQL scan of all 35,641 rows in `bot.db`: 0 conflicting distinct beer pairs under the same brewery. |
| Stripping leading `The` with $\ge 2$ remainder tokens never collapses names to weak/empty keys | `normalizeName` invariant | Catalog scan: 0 beers collapse to empty; 144 beers with 2 tokens keep `The`; 363 beers with $\ge 3$ tokens normalize safely. |
| The fix rescues row 37244 in Stage 2a | Adjudication replay | Probed live with `createAlgoliaSearch`: Stage 2a matches candidate bid `6992173` on exact 4.6% ABV. |

---

## Verification Plan

1. **Unit tests in `src/domain/normalize.test.ts`:**
   - Verify `normalizeName('The Stonewall Inn IPA')` equals `'stonewall inn'`.
   - Verify `normalizeName('The Alchemist')` remains `'the alchemist'` (length < 3).
   - Verify `normalizeName('Eye of the Tiger')` remains `'eye of the tiger'`.
   - Verify `normalizeName('The IPA')` remains `'the'`.
2. **Integration tests in `src/domain/untappd-lookup.test.ts`:**
   - Test lookup for `Brooklyn Brewery` / `Brooklyn Stonewall Inn IPA 10,6°` matches `The Stonewall Inn IPA`.
   - Verify Stage 2a `pickByAbv` selection with candidates having 4.6% vs 4.0% ABV.
3. **Full test gate:**
   - Run `npm test && npm run typecheck` across all 275 test files.
4. **Adjudication:**
   - Run `npm run adjudicate -- --issue 653` and confirm row 37244 transitions to `rescued`.
