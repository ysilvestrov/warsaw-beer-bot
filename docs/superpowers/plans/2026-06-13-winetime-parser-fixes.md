# winetime parser fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two `winetime` adapter parser defects so the cleaned beer name matches Untappd: strip an orphaned leading `Brewery`/`Броварня` token left after the brand prefix, and strip the `янтарне` (amber) descriptor.

**Architecture:** Both changes are local to `extension/src/sites/winetime.ts` `cleanName`. Add a local `LEADING_BREWERY_NOISE_RE` and strip one leading match at the end of `cleanName`; add `янтарне` to the existing `DESCRIPTOR_RE`. Bespoke Vitest cases mirror the existing synthetic-card pattern in `winetime.test.ts`.

**Tech Stack:** TypeScript, Vitest, jsdom (`DOMParser`), Vite. All work under `extension/`.

**Spec:** `docs/superpowers/specs/2026-06-13-winetime-parser-fixes-design.md`. Scope is extension-only (sub-bugs 2 + 3 of #136); the empty-brewery sub-bug is split to #149 and is NOT in scope here.

---

## File Structure

- Modify: `extension/src/sites/winetime.ts` — add `LEADING_BREWERY_NOISE_RE` + strip in `cleanName` (Task 1); add `янтарне` to `DESCRIPTOR_RE` (Task 2).
- Modify: `extension/src/sites/winetime.test.ts` — bespoke cases for both fixes + an FP guard.

No `spec.md` change: these are `cleanName` internals, not an adapter-contract change (spec.md §6 describes winetime at the selector/metadata level, which is unchanged).

All commands assume CWD `extension/` for npm; run `git` from the worktree root.

---

### Task 1: Strip orphaned leading `Brewery`/`Броварня` token

**Files:**
- Modify: `extension/src/sites/winetime.ts`
- Test: `extension/src/sites/winetime.test.ts`

- [ ] **Step 1: Write the failing tests**

In `extension/src/sites/winetime.test.ts`, add inside the `describe('winetime adapter', ...)` block (the file already imports `winetime`, `describe/it/expect`, and uses `DOMParser`):

```ts
  it('strips an orphaned leading Brewery token left after the brand prefix', () => {
    const doc = new DOMParser().parseFromString(
      `
        <a class="product-micro">
          <span data-productkey="201"></span>
          <div class="product-micro--title">Пиво ДІДЬКО Brewery Double Trouble</div>
          <div class="j-grow-1-xs j-size-0.75-xs">ДІДЬКО</div>
        </a>
        <script>
          window.initialData = {};
          window.initialData.category = {
            "products": [{
              "id": 201,
              "title": "Пиво ДІДЬКО Brewery Double Trouble",
              "manufacturer": { "title": "ДІДЬКО" }
            }]
          };
        </script>
      `,
      'text/html',
    );
    expect(winetime.parseCards(doc)).toContainEqual(
      expect.objectContaining({ brewery: 'ДІДЬКО', name: 'Double Trouble' }),
    );
  });

  it('strips a leading Brewery token for a Latin brand too', () => {
    const doc = new DOMParser().parseFromString(
      `
        <a class="product-micro">
          <span data-productkey="202"></span>
          <div class="product-micro--title">Пиво TEN MEN Brewery RUBIS</div>
          <div class="j-grow-1-xs j-size-0.75-xs">TEN MEN</div>
        </a>
        <script>
          window.initialData = {};
          window.initialData.category = {
            "products": [{
              "id": 202,
              "title": "Пиво TEN MEN Brewery RUBIS",
              "manufacturer": { "title": "TEN MEN" }
            }]
          };
        </script>
      `,
      'text/html',
    );
    expect(winetime.parseCards(doc)).toContainEqual(
      expect.objectContaining({ brewery: 'TEN MEN', name: 'RUBIS' }),
    );
  });

  it('does not over-strip a normal name after the brand prefix (FP guard)', () => {
    const doc = new DOMParser().parseFromString(
      `
        <a class="product-micro">
          <span data-productkey="203"></span>
          <div class="product-micro--title">Пиво Brewdog Punk IPA</div>
          <div class="j-grow-1-xs j-size-0.75-xs">Brewdog</div>
        </a>
        <script>
          window.initialData = {};
          window.initialData.category = {
            "products": [{
              "id": 203,
              "title": "Пиво Brewdog Punk IPA",
              "manufacturer": { "title": "Brewdog" }
            }]
          };
        </script>
      `,
      'text/html',
    );
    expect(winetime.parseCards(doc)).toContainEqual(
      expect.objectContaining({ brewery: 'Brewdog', name: 'Punk IPA' }),
    );
  });
```

- [ ] **Step 2: Run tests to verify the first two fail**

Run: `npm test -- src/sites/winetime.test.ts`
Expected: the two strip tests FAIL — without the fix, the names are `Brewery Double Trouble` and `Brewery RUBIS`. The FP-guard test PASSES already (`Punk IPA` is unaffected) — that's fine; it locks in no-regression.

- [ ] **Step 3: Implement the strip**

In `extension/src/sites/winetime.ts`, add the constant directly below `DESCRIPTOR_RE` (after line 7):

```ts
// A leftover leading brewery-noise token after the brand prefix is stripped (e.g. title
// "Пиво ДІДЬКО Brewery Double Trouble" with manufacturer "ДІДЬКО" → "Brewery Double Trouble").
// Requires a trailing space so it never touches a brand-like word ("Brewdog"). Extension is a
// separate package, so we keep a small local list rather than importing the server's BREWERY_NOISE.
const LEADING_BREWERY_NOISE_RE = /^(?:brewery|browary?|brewing|броварня|пивоварня)\s+/iu;
```

Then in `cleanName`, strip one leading match at the end — change the tail of the function from:

```ts
  for (const suffix of breweryPrefixes(brewery)) {
    cleaned = stripSuffix(cleaned, suffix);
  }

  return cleaned || name || original;
```

to:

```ts
  for (const suffix of breweryPrefixes(brewery)) {
    cleaned = stripSuffix(cleaned, suffix);
  }
  cleaned = cleaned.replace(LEADING_BREWERY_NOISE_RE, '').trim();

  return cleaned || name || original;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/sites/winetime.test.ts`
Expected: PASS — all winetime cases green, including the two new strip tests (`Double Trouble`, `RUBIS`) and the FP guard (`Punk IPA`). The existing fixture-wide assertions (`cards.length > 20`, `Meteor Pils`, `Underwood … Ukrainian Tomato Gose`, `Meteor IPA CAN`) confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/winetime.ts extension/src/sites/winetime.test.ts
git commit -m "fix(extension/winetime): strip orphaned leading Brewery token in cleanName"
```

---

### Task 2: Add `янтарне` descriptor

**Files:**
- Modify: `extension/src/sites/winetime.ts`
- Test: `extension/src/sites/winetime.test.ts`

- [ ] **Step 1: Write the failing test**

In `extension/src/sites/winetime.test.ts`, add inside the `describe('winetime adapter', ...)` block:

```ts
  it('strips the янтарне (amber) descriptor', () => {
    const doc = new DOMParser().parseFromString(
      `
        <a class="product-micro">
          <span data-productkey="204"></span>
          <div class="product-micro--title">Femme Fatale янтарне</div>
          <div class="j-grow-1-xs j-size-0.75-xs">De Leite</div>
        </a>
      `,
      'text/html',
    );
    expect(winetime.parseCards(doc)).toContainEqual(
      expect.objectContaining({ brewery: 'De Leite', name: 'Femme Fatale' }),
    );
  });
```

(No embedded `window.initialData.category` here, so the adapter falls back to the visible `.product-micro--title` and `visibleBrewery` — exercising the descriptor strip on the visible path.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/sites/winetime.test.ts -t "янтарне"`
Expected: FAIL — without `янтарне` in `DESCRIPTOR_RE`, the name stays `Femme Fatale янтарне`.

- [ ] **Step 3: Implement — add `янтарне` to `DESCRIPTOR_RE`**

In `extension/src/sites/winetime.ts`, change `DESCRIPTOR_RE` (lines 6–7) from:

```ts
const DESCRIPTOR_RE =
  /\s+(?:світле|темне|напівтемне|нефільтроване|фільтроване|пастеризоване|безалкогольне)$/iu;
```

to:

```ts
const DESCRIPTOR_RE =
  /\s+(?:світле|темне|напівтемне|нефільтроване|фільтроване|пастеризоване|безалкогольне|янтарне)$/iu;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/sites/winetime.test.ts`
Expected: PASS — the new `янтарне` test plus all existing winetime cases (the existing "cleans Ukrainian category descriptors conservatively" test confirms the other descriptors still behave).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/winetime.ts extension/src/sites/winetime.test.ts
git commit -m "fix(extension/winetime): strip 'янтарне' amber descriptor"
```

---

### Task 3: Full suite + build green

**Files:** none (verification only).

- [ ] **Step 1: Run the full extension suite**

Run (from `extension/`): `npm test`
Expected: PASS — all files green (winetime bespoke incl. the 4 new cases, plus the rest of the suite untouched).

- [ ] **Step 2: Build**

Run (from `extension/`): `npm run build`
Expected: succeeds, no TS errors.

- [ ] **Step 3: Confirm no out-of-scope changes**

Run (from repo root): `git diff origin/main --stat`
Expected: only `extension/src/sites/winetime.ts` and `extension/src/sites/winetime.test.ts` changed (plus the two design/plan docs already committed). No `spec.md` change is expected — these are `cleanName` internals, not an adapter-contract change.

---

## Self-review notes

- **Spec coverage:** §3.1 (leading brewery-noise strip) → Task 1; §3.2 (`янтарне`, descriptor-only kept raw) → Task 2 (descriptor-only needs no code — the existing `cleaned || name || original` fallback already keeps it); §3.3 (cleanName order: strip leading-noise last) → Task 1 Step 3 places the strip after the suffix loop; §4 (testing incl. FP guard) → Task 1 tests + Task 3.
- **Type consistency:** `LEADING_BREWERY_NOISE_RE` defined in Task 1 and used only there; `DESCRIPTOR_RE` extended in place. No cross-task signature drift.
- **FP safety:** `LEADING_BREWERY_NOISE_RE` requires a trailing `\s+`, so `Brewdog` (no following space after a noise word) is never matched; Task 1's FP-guard test locks this in.
