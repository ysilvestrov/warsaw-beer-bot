# #653 — Leading Article Normalization in Beer Names: Design

**Date:** 2026-10-08  
**Status:** accepted  
**Issue:** #653  

## Problem

Orphan issue #653 tracks matcher attribution failures where an input from a pub or shop and an Untappd candidate belong to the identical brewery, but divergence on a leading grammatical article (`The `) prevents reconciliation during name matching.

### Affected Rows and Live Reach

- **Row 37244: `Brooklyn Brewery / Brooklyn Stonewall Inn IPA 10,6°` @ 4.6% ABV**
  - **Live Tap Presence:** On tap in Warsaw pubs (*Antycafe*, *Kicia Kocia*) as of 2026-10-08 (`taps` snapshot 12:01 UTC).
  - **Untappd Candidate 1:** `Brooklyn Brewery — The Stonewall Inn IPA` (bid `2885563`, 4.0% ABV, 122,449 ratings).
  - **Untappd Candidate 2:** `Brooklyn Brewery — The Stonewall Inn IPA Session IPA` (bid `6992173`, 4.6% ABV, 50 ratings, European export variant).
  - **Rejection Mechanism:**
    - The shop name after brewery stripping has tokens: `['stonewall', 'inn']`.
    - Both Untappd candidates retain the leading article `the`, producing tokens: `['the', 'stonewall', 'inn']`.
    - **Stage 2a (`nameKeys`):** The input key set `{'inn stonewall'}` and candidate key set `{'inn stonewall the'}` have zero intersection.
    - **Stage 2a.5 (`nearMatches`):** Both candidates match near-name scoring, but `dominantCandidate` selects leader bid `2885563` (4.0% ABV) and vetoes it against the input's 4.6% ABV because `|4.0 - 4.6| = 0.6 > 0.3` (`ABV_TOLERANCE`). Candidate `6992173` (4.6% ABV) has few ratings and does not dominate, resulting in a terminal `not_found`.

---

## Catalog Analysis & Evidence

An exhaustive query of the full production catalog (`35,641` beers in `bot.db`) revealed:
- **1,322 beers** contain `the`.
- **845 beers** contain `the` in the middle of a title phrase (*"Eye of the Tiger"*, *"Seasons in the abyss"*, *"Todd - The Axe Man"*). In mid-title phrases, `the` is grammatical and almost never dropped by shops.
- **503 beers** begin with leading `The `.
  - **1 beer** has 1 token after `STYLE_WORDS` filtering (`The IPA`).
  - **278 beers** have 2 tokens (`The Alchemist`, `The Abyss`, `The End`). Retaining `the` preserves 2-token identity and produces valid `nameKeys`.
  - **224 beers** have $\ge 3$ tokens (`The Stonewall Inn IPA`, `The Good Cider Pear`, `The Real Hr. Frederiksen`). Stripping `the` leaves $\ge 2$ strong tokens.
- **Zero collisions:** In the entire database, there is not a single instance of a brewery producing two distinct products named `The X` and `X`.
  ```sql
  SELECT count(*) FROM beers WHERE name LIKE 'The %'; -- 503
  ```
  Verified via token analysis script against `bot.db`: 0 conflicting distinct beer pairs under the same brewery.

---

## Decisions

### 1. Leading Article Stripping in `stripBreweryFromName` ([src/domain/style-identity.ts](file:///home/ysi/warsaw-agy-bb/src/domain/style-identity.ts))

Following cross-review analysis, article stripping is housed in `stripBreweryFromName` rather than globally in `normalizeName`:
1. **Preserves DB keys:** `beers.normalized_name` in SQLite is untouched, ensuring `ensureOrphan`, `resolvableOrphan`, and `listBeersByNormalized` remain consistent without migrations.
2. **Protects "The" Breweries:** Over 50 breweries begin with `The` (*The Bruery*, *The Alchemist*, *The Kernel*). In `stripBreweryFromName`, the brewery's tokens (`bt`) are stripped *first*, preventing false removal of `the` from `the bruery barrel pie`.
3. **Empty brewery handling:** When `breweryNorm` is empty, leading `the` is still stripped when remainder has $\ge 2$ tokens.

```ts
export function stripBreweryFromName(nameNorm: string, breweryNorm: string): string {
  const nt = nameNorm.split(' ').filter(Boolean);
  if (breweryNorm) {
    const bt = breweryNorm.split(' ').filter(Boolean);
    if (bt.length) {
      for (let i = 0; i + bt.length <= nt.length; ) {
        if (nt.length - bt.length >= 1 && bt.every((t, j) => nt[i + j] === t)) {
          nt.splice(i, bt.length);
        } else {
          i++;
        }
      }
      while (nt.length > 1 && BREWERY_NOISE.has(nt[0])) nt.shift();
      while (nt.length > 1 && BREWERY_NOISE.has(nt[nt.length - 1])) nt.pop();
    }
  }
  if (nt.length >= 3 && nt[0] === 'the') nt.shift();
  return nt.join(' ');
}
```

#### Invariants:
1. **Safety for 2-token names:** Short names such as `The Alchemist` or `The End` retain `the` so their `nameKeys` remain 2 tokens.
2. **Safety for style-only tails:** `The IPA` has 1 token after `STYLE_WORDS` filtering (`['the']`); `nt.length < 3` prevents stripping `the`.
3. **Mid-title safety:** Titles like `Son Of The Son` or `Eye of the Tiger` start with `son`/`eye` and are untouched.
4. **Symmetric effect:** `nameKeys` and `nameIdentity` both invoke `stripBreweryFromName`:
   - Input `Stonewall Inn IPA` $\to$ `stonewall inn`
   - Candidate `The Stonewall Inn IPA` $\to$ `stonewall inn`
   - Both generate `nameKeys: {'inn stonewall'}` and match in Stage 2a (`keyHits`).
   - In Stage 2a, `pickByAbv` matches candidate `6992173` (4.6% ABV) with exact ABV agreement, or falls back to canonical `2885563` when ABV is null/within tolerance.

### 2. Specification Update ([spec.md](file:///home/ysi/warsaw-agy-bb/spec.md))

Documented under §3.1 that leading grammatical article `the` is normalized out in `stripBreweryFromName` when the remainder retains $\ge 2$ tokens.

---

## Claims and Their Evidence

| Claim | What records it as fact | Evidence proving it |
| :--- | :--- | :--- |
| Row 37244 is an active Warsaw orphan for *Brooklyn Brewery — The Stonewall Inn IPA* | `enrich_failures` row 37244 | Live `taps` snapshots (2026-10-08 12:01) in *Antycafe* & *Kicia Kocia* @ 4.6% ABV; Untappd Algolia candidates bid `2885563` & bid `6992173`. |
| No brewery produces distinct beers conflicting on `The X` vs `X` | Domain matching safety | SQL scan of all 35,641 rows in `bot.db`: 0 conflicting distinct beer pairs under the same brewery. |
| Stripping leading `The` with $\ge 2$ remainder tokens never collapses names to weak/empty keys | `stripBreweryFromName` invariant | Catalog scan: 0 beers collapse to empty; 278 beers with 2 tokens keep `The`; 224 beers with $\ge 3$ tokens normalize safely. |
| The fix rescues row 37244 in Stage 2a | Adjudication replay | Probed live with `npm run adjudicate -- --issue 653`: row 37244 marked `rescued` with bid `6992173` @ 4.6% ABV (verdict file: `/tmp/adjudicate-653-1791490720357.json`). |

---

## Verification Plan

1. **Unit tests in `src/domain/matcher.test.ts`:**
   - Verify `stripBreweryFromName('brooklyn the stonewall inn', 'brooklyn')` equals `'stonewall inn'`.
   - Verify `stripBreweryFromName('the stonewall inn', '')` equals `'stonewall inn'`.
   - Verify `stripBreweryFromName('the alchemist', '')` remains `'the alchemist'` (length < 3).
   - Verify `stripBreweryFromName('eye of the tiger', '')` remains `'eye of the tiger'`.
   - Verify `stripBreweryFromName('the bruery barrel pie', 'the bruery')` equals `'barrel pie'`.
2. **Integration tests in `src/domain/untappd-lookup.test.ts`:**
   - Test lookup for `Brooklyn Brewery` / `Brooklyn Stonewall Inn IPA 10,6°` matches `The Stonewall Inn IPA Session IPA` (bid `6992173`) @ 4.6% ABV.
   - Test canonical US variant (bid `2885563`) matched when input ABV is 4.0% or null.
   - Test short name `The End` does not collapse onto `End`.
   - Test `The Bruery` beer matches candidate properly without prefix corruption.
3. **Full test gate:**
   - `npm test && npm run typecheck`.
4. **Live adjudication probe:**
   - `DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db DOTENV_CONFIG_PATH=/home/ysi/warsaw-agy-bb/.env npm run adjudicate -- --issue 653` confirms row 37244 is `rescued`.
