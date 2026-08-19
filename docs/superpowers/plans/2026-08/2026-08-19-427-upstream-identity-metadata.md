# Issue 427 Upstream Identity Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every #427 example by safely matching eight verified identities, marking Gui/Guinnes `wontfix`, and transferring typo and ambiguous cases to their existing trackers.

**Architecture:** Preserve Algolia's optional identity metadata on `SearchResult`, then evaluate complete beer aliases, candidate-native brewery aliases, and exact brand remainders as separate evidence pools with decline-on-ambiguity semantics. Keep the existing canonical/curated match path unchanged, add only the verified Stern spelling pair, and narrowly remove Unicode superscript footnote markers from brewery labels.

**Tech Stack:** TypeScript, Vitest, Untappd Algolia adapter, existing matcher/normalization utilities, GitHub CLI for issue bookkeeping.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-19-427-upstream-identity-metadata-design.md`

## Global Constraints

- Do not add a global `Magic Road` ↔ `Sadyba` brewery alias.
- Native metadata may not choose an arbitrary rank-1 result when several candidates remain plausible.
- A bare beer alias may not bypass the brewery gate.
- Exact brand remainder matching is exact after normalization, never fuzzy.
- Search results without metadata and the legacy HTML path retain existing behavior.
- Do not implement general brewery typo correction, query widening, or #334 disambiguation.
- Do not change browser-extension code.

---

### Task 1: Preserve Algolia identity metadata

**Files:**
- Modify: `src/sources/untappd/search.ts`
- Modify: `src/sources/untappd/algolia.ts`
- Test: `src/sources/untappd/algolia.test.ts`

**Interfaces:**
- Produces: optional `SearchResult.brewery_alias?: string[]` and `SearchResult.alias_alt?: string[]`.
- Preserves: existing required search-result fields and `HydratedBeer.brewery_alias`.

- [ ] **Step 1: Write the failing parser test**

Extend `HIT` with mixed valid/invalid alias arrays and expect only trimmed, non-empty strings:

```ts
brewery_alias: [' Carlsberg Polska ', 17, ''],
alias_alt: [' Magic Road Dżemer ', null],
```

The expected result must include:

```ts
brewery_alias: ['Carlsberg Polska'],
alias_alt: ['Magic Road Dżemer'],
```

Also assert that a hit without either field produces empty arrays, keeping output shape deterministic.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/sources/untappd/algolia.test.ts`

Expected: FAIL because `AlgoliaHit` and `parseAlgoliaResponse` discard both fields.

- [ ] **Step 3: Implement the minimal metadata contract**

Add to `SearchResult`:

```ts
brewery_alias?: string[];
alias_alt?: string[];
```

Add both unknown fields to `AlgoliaHit`. Change `strList` to normalize strings with the existing `str()` helper and remove empty values, then include both arrays in `parseAlgoliaResponse`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/sources/untappd/algolia.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/search.ts src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts
git commit -m "fix(untappd): preserve Algolia identity aliases (#427)" -- src/sources/untappd/search.ts src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts
```

### Task 2: Normalize the Forest footnote and add the Stern spelling

**Files:**
- Modify: `src/domain/normalize.ts`
- Modify: `src/domain/normalize.test.ts`
- Modify: `src/domain/brewery-aliases.ts`
- Modify: `src/domain/matcher.test.ts`

**Interfaces:**
- Produces: `normalizeBrewery('Nepomucen⁸ Brewery') === 'nepomucen'`.
- Produces: direct curated relationship `stern scheubel` ↔ `stern brau gunter scheubel`.

- [ ] **Step 1: Write failing focused tests**

Add normalization assertions:

```ts
expect(normalizeBrewery('Nepomucen⁸ Brewery')).toBe('nepomucen');
expect(normalizeBrewery('Studio54 Brewery')).toBe('studio54');
```

Add matcher assertions that `breweryAliasesMatch` accepts Stern Scheubel against Stern-Bräu Günter Scheubel while an unrelated Scheubel name remains rejected.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/domain/normalize.test.ts src/domain/matcher.test.ts`

Expected: FAIL on the superscript and Stern expectations.

- [ ] **Step 3: Implement the narrow changes**

Before `baseNormalize` tokenization in `normalizeBrewery`, remove only Unicode superscript digit runs at a token boundary:

```ts
const SUPERSCRIPT_FOOTNOTE = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?=\s|$)/gu;
```

Add the verified normalized pair to `ALIAS_PAIRS`:

```ts
['stern scheubel', 'stern brau gunter scheubel'],
```

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/domain/normalize.test.ts src/domain/matcher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts src/domain/brewery-aliases.ts src/domain/matcher.test.ts
git commit -m "fix(matcher): normalize verified brewery labels (#427)" -- src/domain/normalize.ts src/domain/normalize.test.ts src/domain/brewery-aliases.ts src/domain/matcher.test.ts
```

### Task 3: Admit complete identity and candidate-native brewery evidence

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Test: `src/domain/untappd-lookup.test.ts`

**Interfaces:**
- Consumes: optional `SearchResult.alias_alt` and `SearchResult.brewery_alias` from Task 1.
- Produces: internal unique corroborated selection that returns one candidate, or `null` on unresolved multiplicity.

- [ ] **Step 1: Write failing complete-identity tests**

Add a Dżemer test whose canonical brewery is `Sadyba`, with:

```ts
alias_alt: ['Sadyba Dżemer', 'Magic Road Dżemer']
```

Expect `Magic Road Brewery / Dżemer` to match its bid. Add a negative test where `alias_alt: ['Dżemer']` is the only evidence and expect `not_found`.

- [ ] **Step 2: Verify the identity tests RED**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "identity alias"`

Expected: the complete collaboration identity is `not_found`; the negative guard already stays rejected.

- [ ] **Step 3: Implement complete-identity admission**

Build normalized full identities from each `inputBreweryAliases` entry plus the complete input beer name. A candidate belongs to the identity pool only when one complete normalized `alias_alt` equals one of those identities. Evaluate this pool before the ordinary brewery pools. Return its sole result; with multiple results and supplied ABV, return only when exactly one result is within `ABV_TOLERANCE`; otherwise decline.

- [ ] **Step 4: Verify identity GREEN**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "identity alias"`

Expected: PASS.

- [ ] **Step 5: Write failing native-brewery tests**

Add focused cases for:

```ts
// unique match
{ beer_name: 'Okocim Jasne Pełne', brewery_name: 'Browar Okocim', brewery_alias: ['Carlsberg Polska'] }
{ beer_name: 'WRCLW Schöps', brewery_name: 'WRCLW', brewery_alias: ['Browar Stu Mostów', 'Stu Mostów'] }

// ambiguous: two alias-supported 4.6% products
{ beer_name: 'Platan Jedenáctka', brewery_name: 'Platan', brewery_alias: ['Pivovary Lobkowicz'], abv: 4.6 }
{ beer_name: 'Platan Granát', brewery_name: 'Platan', brewery_alias: ['Pivovary Lobkowicz'], abv: 4.6 }
```

Expect Okocim and WRCLW to match and PLATAN to remain `not_found`, even if the ambiguous candidate order is reversed.

- [ ] **Step 6: Verify native-brewery RED**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "native brewery alias"`

Expected: Okocim and WRCLW fail the gate.

- [ ] **Step 7: Implement the separate native alias pool**

For each candidate, normalize every `brewery_alias` through existing `breweryAliases()` and compare it with `inputBreweryAliases`. Do not add these values to `ALIAS_PAIRS` and do not merge the pool into `strictPool`.

Apply exact name-key and reviewed near-name scoring to this pool, but select only with the unique-corroboration helper. For scored matches, restrict selection to candidates tied at the top score before applying uniqueness/ABV. A single candidate may win; multiple candidates require exactly one within ABV tolerance; otherwise return no native match and continue without admitting them to fuzzy stages.

- [ ] **Step 8: Verify native-brewery GREEN and all lookup regressions**

Run: `npx vitest run src/domain/untappd-lookup.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(matcher): use bounded upstream identity evidence (#427)" -- src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
```

### Task 4: Match exact brand remainders

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Test: `src/domain/untappd-lookup.test.ts`

**Interfaces:**
- Consumes: existing `brandPool`, normalized input brewery aliases, and `normalizeName`.
- Produces: exact leading-brand remainder matches with the same unique selection rule as native aliases.

- [ ] **Step 1: Write failing positive and negative tests**

Add positive cases for:

- `Leffe / Ruby` → `Abbaye de Leffe / Leffe Ruby`;
- `Leffe / Blonde` → `Abbaye de Leffe / Leffe Blonde`;
- `CRAFT / STAR Double Stout` → `Mad Brew / Craft Star - Double Stout`.

Add guards proving that a fuzzy remainder (`Ruby` vs `Ruby Cherry`) does not match and that two exact same-remainder candidates without a unique ABV candidate remain unresolved.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "brand remainder"`

Expected: the positive cases are `not_found` under the current multi-token `nameKeys` path.

- [ ] **Step 3: Implement exact remainder matching**

For each `brandPool` candidate and each normalized input brewery alias, require the candidate normalized beer name to begin with the complete alias token run plus at least one remaining token. Compare the remaining tokens to the complete normalized input name for exact equality. Select with the same unique/ABV helper; do not call fuzzy search from this path.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/domain/untappd-lookup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(matcher): accept exact brand-name remainders (#427)" -- src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
```

### Task 5: Update the normative specification and verify the complete cohort

**Files:**
- Modify: `spec.md`
- Verify: all files changed by Tasks 1–4

**Interfaces:**
- Documents: optional upstream identity metadata, full-identity restriction, ambiguity decline, exact brand remainder, and superscript footnote normalization.

- [ ] **Step 1: Update `spec.md`**

In the Untappd matching section, document:

- Algolia `brewery_alias` and `alias_alt` preservation;
- complete-label-only `alias_alt` gate bypass;
- separate native brewery-alias pool with unique/ABV corroboration;
- exact leading-brand remainder matching;
- no global aliases between collaboration partners;
- Unicode superscript brewery-footnote cleanup.

- [ ] **Step 2: Run focused verification**

```bash
npx vitest run src/sources/untappd/algolia.test.ts src/domain/normalize.test.ts src/domain/matcher.test.ts src/domain/untappd-lookup.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

```bash
npm test
npm run typecheck
git diff --check
```

Expected: all commands pass.

- [ ] **Step 4: Commit specification**

```bash
git add spec.md
git commit -m "docs: specify bounded upstream identity matching (#427)" -- spec.md
```

### Task 6: Complete issue bookkeeping after verified implementation

**Files:**
- No repository files.
- GitHub issues: #427, #334, #407.

**Interfaces:**
- Consumes: verified test output and the transfer comments already posted to #334 and #407.
- Produces: a #427 disposition comment accounting for all 15 examples.

- [ ] **Step 1: Verify transfer comments exist**

Check #334 contains 29709, 30059, 30149, 34642, and the ambiguity half of 29556; check #407 contains 31166 and the typo half of 29556.

- [ ] **Step 2: Record Gui/Guinnes as `wontfix` in #427**

State that beer 30101 is intentionally not rescued because the stored identity is too corrupted and the actual search does not retrieve Guinness. Do not add it to #406: this is an explicit terminal disposition, not deferred retrieval work.

- [ ] **Step 3: Post the final #427 matrix**

List the eight fixed IDs, the one `wontfix` ID, and the six transferred IDs with links to #334/#407. Close #427 only after the implementation is merged or otherwise present on the target branch.

---

## Plan self-review

- **Spec coverage:** Tasks 1–5 cover both metadata fields, all three bounded evidence paths, Forest/Stern label handling, legacy compatibility, negative guards, and normative documentation. Task 6 accounts for every issue example.
- **Placeholder scan:** no placeholder markers or unspecified implementation steps remain.
- **Type consistency:** `brewery_alias` and `alias_alt` are optional `string[]` fields on `SearchResult`; every later task consumes those exact names. Unique selection consistently returns `SearchResult | null`.
- **Scope:** no typo rescue, retrieval widening, broad alias relationship, extension change, or ambiguity selection is included.
