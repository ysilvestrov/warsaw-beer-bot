# BeerFreak brand/title divergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop BeerFreak duplicating the brewery into the beer name when `brand_title` renders differently than the title's leading brewery form (issue #305).

**Architecture:** In `cleanName` (`extension/src/sites/beerfreak.ts`), keep the existing exact-prefix fast path untouched (it handles matching brands and slash collaborators); add a token-run fallback for the divergent case that strips leading title tokens which are brand-core tokens or brewery-descriptor words, leaving the beer name.

**Tech Stack:** TypeScript (ESM), Vitest. Run commands from `extension/`.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-18-beerfreak-brand-title-divergence-design.md`

---

## Context for the implementer

- All paths are under `extension/`. `npm test` = `vitest run`; run a subset with `npm test -- <path>`.
- The bug: `cleanName(rawTitle, brewery)` strips the brewery from the title by an **exact case-insensitive prefix match** of `brand_title`. When the title's leading brewery form differs (e.g. brand `HOPPY HOG BREWERY` vs title `Hoppy Hog Family Brewery …`), the check fails and the whole title becomes the name.
- Existing helpers in the file you will reuse (do NOT reimplement): `normalizedToken(token)` — lowercases and strips `( ) ,`; `stripLeadingCollaborator`, `BREWERY_NOISE_PREFIX_RE` (used only by the fast path).
- Tests drive the public `beerfreak.parseCards` via the existing helper `docWithProducts([{ id, brand_title, title }])`. `cleanName` and the new helper are module-private — test them through `parseCards`.
- Only two brands in the fixture actually diverge: `HOPPY HOG BREWERY` (title inserts `Family`) and `BROKREACJA BREWERY` (title localizes to `Browar Brokreacja`). Brands whose cleaned brand is a title prefix (Volta, Rebrew, SHO, PINTA) already work via the fast path and must not change.

---

## Task 1: Token-run fallback for divergent brand_title

**Files:**
- Modify: `extension/src/sites/beerfreak.ts`
- Test: `extension/src/sites/beerfreak.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside the `describe('beerfreak adapter', …)` block in `extension/src/sites/beerfreak.test.ts`:

```ts
  it('strips the leading brewery run when brand_title diverges from the title form', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 20001, brand_title: 'HOPPY HOG BREWERY (Україна)', title: 'Hoppy Hog Family Brewery Tropical Veil NEIPA' },
      { id: 20002, brand_title: 'BROKREACJA BREWERY (Польща)', title: 'Browar Brokreacja NAFCIARZ 19' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'HOPPY HOG BREWERY',
      name: 'Tropical Veil NEIPA',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'BROKREACJA BREWERY',
      name: 'NAFCIARZ 19',
    }));
  });

  it('does not over-strip when the title tokens do not include a brand-core token', () => {
    // brand-core "zzz" never appears in the title → no strip, full title kept as name
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 20003, brand_title: 'ZZZ BREWERY (Nowhere)', title: 'Family Reunion Imperial Stout' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'ZZZ BREWERY',
      name: 'Family Reunion Imperial Stout',
    }));
  });

  it('leaves exact-prefix brands and the SHO paren-alias case unchanged (regression)', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 20004, brand_title: 'VOLTA BREWERY (Україна)', title: 'Volta Brewery MODERN PILSNER' },
      { id: 20005, brand_title: 'SHO BREWERY (Україна)', title: 'SHO Brewery (IIIO) Narcissus' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'VOLTA BREWERY',
      name: 'MODERN PILSNER',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'SHO BREWERY',
      name: '(IIIO) Narcissus',
    }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/sites/beerfreak.test.ts -t "brewery run"`
Expected: FAIL — the HOPPY HOG / BROKREACJA names still contain the duplicated brewery (e.g. `Hoppy Hog Family Brewery Tropical Veil NEIPA`). (The over-strip and regression tests may already pass; that is fine — the divergence test must fail.)

- [ ] **Step 3: Add the descriptor set**

In `extension/src/sites/beerfreak.ts`, add this constant next to the existing brewery-word sets (right after the `COLLABORATOR_TERMINAL_WORDS` declaration, around line 18):

```ts
// Words that appear as brewery descriptors in a title's leading brewery form
// (structural forms + "family" for "<X> Family Brewery"). Lowercased; compared
// with normalizedToken (which strips ( ) , ).
const BREWERY_DESCRIPTORS = new Set([
  'brewery', 'brewing', 'browar', 'brasserie', 'brouwerij', 'brauerei',
  'pivovar', 'birrificio', 'company', 'co', 'co.', 'family',
]);
```

- [ ] **Step 4: Add the token-run helper**

In `extension/src/sites/beerfreak.ts`, add this function immediately **before** `cleanName`:

```ts
// Divergent brand_title: strip the leading brewery *run* from the title. Consume
// leading tokens that are brand-core tokens (from brand_title, minus descriptors)
// or brewery-descriptor words; the remainder is the beer name. Returns '' when no
// brand token was matched (so a name that merely starts with a descriptor is not
// eaten) or when nothing remains, letting the caller fall back to the full title.
function stripLeadingBreweryRun(rawTitle: string, brewery: string): string {
  const brandCore = new Set(
    brewery.toLowerCase().split(/\s+/).filter((t) => t && !BREWERY_DESCRIPTORS.has(t)),
  );
  if (brandCore.size === 0) return '';

  const tokens = rawTitle.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let i = 0;
  let matchedBrand = false;
  while (i < tokens.length) {
    const t = normalizedToken(tokens[i]);
    if (brandCore.has(t)) { matchedBrand = true; i += 1; continue; }
    if (BREWERY_DESCRIPTORS.has(t)) { i += 1; continue; }
    break;
  }
  if (!matchedBrand) return '';
  return tokens.slice(i).join(' ').trim();
}
```

- [ ] **Step 5: Wire the fallback into `cleanName`**

Replace the existing `cleanName` function body in `extension/src/sites/beerfreak.ts`:

```ts
function cleanName(rawTitle: string, brewery: string): string {
  const b = brewery.trim();
  if (!b) return rawTitle.trim();

  const prefix = rawTitle.slice(0, b.length);
  if (prefix.toLowerCase() !== b.toLowerCase()) return rawTitle.trim();

  return stripLeadingCollaborator(rawTitle.slice(b.length))
    .replace(BREWERY_NOISE_PREFIX_RE, '')
    .trim() || rawTitle.trim();
}
```

with:

```ts
function cleanName(rawTitle: string, brewery: string): string {
  const b = brewery.trim();
  if (!b) return rawTitle.trim();

  const prefix = rawTitle.slice(0, b.length);
  if (prefix.toLowerCase() === b.toLowerCase()) {
    // exact-prefix path (also handles leading slash collaborators)
    return stripLeadingCollaborator(rawTitle.slice(b.length))
      .replace(BREWERY_NOISE_PREFIX_RE, '')
      .trim() || rawTitle.trim();
  }
  // divergent brand_title → token-run strip of the leading brewery form
  return stripLeadingBreweryRun(rawTitle, b) || rawTitle.trim();
}
```

- [ ] **Step 6: Run the new tests + full file to verify pass and no regressions**

Run: `npm test -- src/sites/beerfreak.test.ts`
Expected: PASS — the three new tests plus all pre-existing beerfreak tests. If a pre-existing test fails, STOP and report it (the fast path and brandless/collab paths must be byte-for-byte unchanged; investigate rather than editing other tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/sites/beerfreak.ts src/sites/beerfreak.test.ts
git commit -m "fix(beerfreak): strip leading brewery run on brand_title/title divergence (#305)"
```

---

## Task 2: Full suite, docs/spec gate, finalize

**Files:** none (verification only)

- [ ] **Step 1: Full extension test suite**

Run: `npm test`
Expected: PASS — all files, no regressions.

- [ ] **Step 2: Docs gate (CLAUDE.md extension rule)**

This change is parser-internal — no new store, popup, checkbox, badge, or install/update flow. So `docs/extension-install-uk.md` does **not** need an update. Confirm this still holds; if any user-visible behavior changed, update that doc in this PR.

- [ ] **Step 3: Spec sync check (CLAUDE.md OpenSpec rule)**

Run `grep -in beerfreak spec.md`. The BeerFreak entry describes brand/slug metadata + slash-collaborator handling; confirm the new token-run fallback does not contradict it. If `spec.md` states the brewery/name derivation in a way this change makes stale, update that sentence in this PR; otherwise no change.

- [ ] **Step 4: Final commit if any doc/spec update was needed**

```bash
git add -A && git commit -m "docs(beerfreak): sync spec for brand/title divergence fix (#305)"
```

(Skip if Steps 2-3 required no changes.)

---

## Self-review checklist (completed by plan author)

- **Spec coverage:** exact-prefix fast path preserved (Step 5), token-run fallback with brand-core ∪ descriptor consumption + matched-brand guard + full-title fallback (Steps 3-5), divergent cases fixed + fast-path/over-strip regression covered (Step 1), out-of-scope brewery emission untouched, docs/spec gate (Task 2). ✓
- **Placeholder scan:** all code is complete literals; no TBD/TODO. ✓
- **Type consistency:** `BREWERY_DESCRIPTORS` and `stripLeadingBreweryRun(rawTitle, brewery)` named identically across Steps 3-5; `normalizedToken` is the existing helper. ✓
```
