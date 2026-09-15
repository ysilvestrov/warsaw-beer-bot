# #650 Flasker title-brand preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the full Flasker beer title when JSON-LD supplies a brewery that was absent from the title head.

**Architecture:** Retain private provenance for a card parsed through Flasker's one-word fallback. During detail hydration, only those cards reconstruct the lost head before the canonical JSON-LD brand overwrites the brewery. The `Card` interface and direct-bid path remain unchanged.

**Tech Stack:** TypeScript, Vitest, jsdom, Vite browser extension.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-15-650-flasker-title-brand-design.md`

## Global Constraints

- Do not introduce dependencies or architectural layers.
- Preserve the existing direct-`bid` and imported-beer-placeholder paths.
- Update `extension/CHANGELOG.md` and `docs/extension-install-uk.md` with user-facing language.
- Verify focused tests, the full extension test suite, and extension typecheck.

---

### Task 1: Preserve fallback title identity during detail hydration

**Files:**
- Modify: `extension/src/sites/flasker.ts:300-342, 500-558`
- Test: `extension/src/sites/flasker.test.ts:601-930`
- Modify: `extension/CHANGELOG.md:Unreleased`
- Modify: `docs/extension-install-uk.md:Flasker support`

**Interfaces:**
- Consumes: `parseTitle(rawTitle, evidence)` and `Card { el, brewery, name }`.
- Produces: `flasker.loadCardDetails(cards)` leaves a fallback card named `Love on Tap` after a `Vibrant Pour` detail brand, while trusted parser paths keep their current names.

- [x] **Step 1: Write the failing hydration regressions**

Add two tests in the existing `#384 flasker.loadCardDetails` suite. The first must build an archive card for `Love on Tap 6% 330ml`, mock a successful product detail with `Vibrant Pour`, and expect `{ brewery: 'VibrantPour', name: 'Love on Tap' }`. The second must parse the same title with a trusted `Vibrant Pour` tag and prove detail hydration does not produce `VibrantPour Love on Tap`.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm --prefix extension test -- src/sites/flasker.test.ts`

Expected: the new title-first test fails because the current output is `VibrantPour | on Tap`.

- [x] **Step 3: Implement private fallback provenance**

Refactor only inside `flasker.ts`: let the adapter distinguish an ambiguous multi-word `splitBreweryName` result from an explicit colon title, a one-word title, and the existing `rule`, registry-tag, and registry-head results. Store fallback provenance in a `WeakSet<HTMLElement>` alongside `detailUrls`. In `loadCardDetails`, use `fallbackTitleHeads.delete(card.el)` as the reconstruction guard; when it returns true, set `card.name = `${card.brewery} ${card.name}`.trim()` before assigning `card.brewery = canonicalizeBrand(detail.brand)`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm --prefix extension test -- src/sites/flasker.test.ts`

Expected: all tests pass; the fallback card keeps `Love on Tap` and the trusted card is not duplicated.

- [x] **Step 5: Write user-facing release documentation**

Under `## [Unreleased]`, add one changelog bullet explaining that Flasker badges now identify beers whose product title begins with the beer name instead of the brewery. Add a matching concise note to the Ukrainian install guide's Flasker support text; do not expose parser or JSON-LD terminology.

- [x] **Step 6: Run full extension verification**

Run: `npm --prefix extension test && npm --prefix extension run typecheck`

Expected: exit code 0.

- [x] **Step 7: Commit the fix-owned files**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts extension/CHANGELOG.md docs/extension-install-uk.md docs/superpowers/specs/2026-09/2026-09-15-650-flasker-title-brand-design.md docs/superpowers/plans/2026-09/2026-09-15-650-flasker-title-brand.md
git commit -m "fix(extension): preserve Flasker title-first beer names"
```
