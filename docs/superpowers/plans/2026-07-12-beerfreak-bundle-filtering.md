# BeerFreak Bundle Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop BeerFreak tasting sets and multi-beer packs from entering matching and orphan enrichment as individual beers.

**Architecture:** Add a private, BeerFreak-specific title predicate in the existing adapter and apply it at the current early non-beer gate. Keep the shared non-beer helper unchanged so other adapters retain their current behavior.

**Tech Stack:** TypeScript, Vitest, DOMParser/jsdom, Vite browser-extension build

---

### Task 1: Reject BeerFreak bundle title shapes

**Files:**
- Modify: `extension/src/sites/beerfreak.test.ts`
- Modify: `extension/src/sites/beerfreak.ts`

- [ ] **Step 1: Write failing tests for reported and stated bundle patterns**

Add this focused test after the existing brandless-title tests in
`extension/src/sites/beerfreak.test.ts`:

```ts
it('drops BeerFreak tasting sets and multi-beer packs', () => {
  const parsed = beerfreak.parseCards(docWithProducts([
    { id: 29993, brand_title: 'FUNKY FLUID (Польща)', title: 'WORLD CUP SERIES - 5 SPECIAL BEER' },
    { id: 31072, brand_title: 'ГОНІР - HONIR BREWERY (Україна)', title: 'Дегустаціний сет від Honir Brewery' },
    { id: 31073, brand_title: 'Example Brewery', title: 'Example Brewery Mix Pack' },
    { id: 31074, brand_title: 'Example Brewery', title: 'Example Brewery Tasting Set' },
  ]));

  expect(parsed).toEqual([]);
});
```

Add a separate false-positive guard:

```ts
it('keeps legitimate BeerFreak beers with incidental set-like substrings', () => {
  const parsed = beerfreak.parseCards(docWithProducts([
    { id: 31075, brand_title: 'Sunset Brew', title: 'Sunset Brew Sunset Boulevard' },
    { id: 31076, brand_title: 'Reset Brewing', title: 'Reset Brewing Reset IPA' },
    { id: 31077, brand_title: 'Series Brewing', title: 'Series Brewing Special Beer' },
  ]));

  expect(parsed.map(({ brewery, name }) => ({ brewery, name }))).toEqual([
    { brewery: 'Sunset Brew', name: 'Sunset Boulevard' },
    { brewery: 'Reset Brewing', name: 'Reset IPA' },
    { brewery: 'Series Brewing', name: 'Special Beer' },
  ]);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run from `extension/`:

```bash
npm test -- src/sites/beerfreak.test.ts
```

Expected: the new bundle test fails because the reported products are returned as
cards; the false-positive guard passes.

- [ ] **Step 3: Implement the minimal BeerFreak-local predicate**

In `extension/src/sites/beerfreak.ts`, add boundary-aware expressions near the other
adapter constants:

```ts
const BEERFREAK_BUNDLE_RE = /(?:^|[^\p{L}\p{N}])(?:mix\s+pack|tasting\s+set|set|сет)(?=$|[^\p{L}\p{N}])/iu;
const BEERFREAK_NUMBERED_SERIES_RE = /(?:^|[^\p{L}\p{N}])series\s*[-:]?\s*\d+\s+special\s+beers?(?=$|[^\p{L}\p{N}])/iu;
```

Add the private predicate:

```ts
function isBeerfreakBundleTitle(rawTitle: string): boolean {
  return BEERFREAK_BUNDLE_RE.test(rawTitle) || BEERFREAK_NUMBERED_SERIES_RE.test(rawTitle);
}
```

Extend the existing early gate in `parseCards`:

```ts
if (isNonBeerName(rawTitle) || isBeerfreakBundleTitle(rawTitle)) continue;
```

Do not export the predicate and do not modify `extension/src/sites/non-beer.ts`.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run from `extension/`:

```bash
npm test -- src/sites/beerfreak.test.ts
```

Expected: all BeerFreak tests pass, including both new tests.

- [ ] **Step 5: Commit the parser and regression tests**

```bash
git add extension/src/sites/beerfreak.ts extension/src/sites/beerfreak.test.ts
git commit -m "fix(extension): reject BeerFreak bundle listings"
```

### Task 2: Document and verify the extension change

**Files:**
- Modify: `spec.md`
- Modify: `extension/CHANGELOG.md`

- [ ] **Step 1: Update the browser-extension specification**

In `spec.md` section 6, extend the BeerFreak adapter description so it explicitly says
that tasting sets, mix packs, and numbered multi-beer series are rejected locally.
Keep the wording within the existing BeerFreak parenthetical; do not change other
adapter descriptions.

- [ ] **Step 2: Update the extension changelog**

Under `## [0.11.0] - 2026-07-10` in `extension/CHANGELOG.md`, add:

```md
- Fixed BeerFreak filtering so tasting sets, mix packs, and numbered multi-beer series are ignored instead of being matched as individual beers.
```

- [ ] **Step 3: Run complete verification**

Run from `extension/`:

```bash
npm test
npm run typecheck
npm run build
```

Expected: the full Vitest suite passes, TypeScript reports no errors, and Vite plus the
postbuild packaging step complete successfully.

Run from the worktree root:

```bash
git diff --check
```

Expected: no output and exit status 0.

- [ ] **Step 4: Commit documentation**

```bash
git add spec.md extension/CHANGELOG.md
git commit -m "docs(extension): record BeerFreak bundle filtering"
```

- [ ] **Step 5: Inspect final scope**

Run from the worktree root:

```bash
git status --short
git diff --stat origin/main...HEAD
```

Expected: the worktree is clean and the diff contains only the approved design, this
plan, BeerFreak adapter/tests, `spec.md`, and the extension changelog.
