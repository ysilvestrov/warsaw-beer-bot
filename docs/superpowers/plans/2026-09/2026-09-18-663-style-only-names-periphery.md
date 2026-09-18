# #663 Style-Only Tap Names — Periphery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the periphery integration for style-only tap names (#663, #465):
1. Differentiate style-only orphans in `ensureOrphan` and `resolvableOrphan` (`src/storage/beers.ts`).
2. Prevent mismatched style rows from being picked for shop cards in `ensureBeerRow` (`src/api/routes/enrich.ts`).
3. Guard `inputIdentityAliases` in `src/domain/untappd-lookup.ts` (#465) from admitting bare brewery brand names.
4. Update `spec.md` with the complete specification of style-name identity, exact gating, fuzzy ban, and orphan separation.

**Architecture:**
- Use `styleNameIdentity(name, normalized_brewery)` from `src/domain/style-identity.ts` wherever `normalized_name === ''`.
- Full gate after every task: `npm test && npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-18-663-style-only-names-design.md`.

---

## Tasks

### Task 1: `src/storage/beers.ts` — `ensureOrphan` & `resolvableOrphan` style identity differentiation

**Files:**
- Modify: `src/storage/beers.ts`
- Modify: `src/storage/beers.test.ts`

- [x] **Step 1: Write unit tests in `src/storage/beers.test.ts`**:
  - `ensureOrphan` creates two separate rows for `Magic Road / Stout` and `Magic Road / LAGER` even though both have `normalized_name === ''`.
  - `ensureOrphan` reuses the existing row for `Zakładowy / Pils 12°` and `Zakładowy / Pils 11°` (same style identity `"pils"`).
  - `resolvableOrphan` does NOT resolve an orphan `Stout` with a bid input for `LAGER`.
  - `resolvableOrphan` DOES resolve an orphan `Pils 12°` with a bid input for `Pils`.

- [x] **Step 2: Implement style gating in `src/storage/beers.ts`**:
  - Import `styleNameIdentity` from `../domain/style-identity`.
  - In `ensureOrphan`:
    ```ts
    const inputStyle = b.normalized_name === '' ? styleNameIdentity(b.name, b.normalized_brewery) : '';
    const existing = orphans.find((o) =>
      digitsCompatibleAsPeers(o.name, b.name) &&
      (b.normalized_name !== '' || styleNameIdentity(o.name, b.normalized_brewery) === inputStyle)
    );
    ```
  - In `resolvableOrphan`:
    ```ts
    const inputStyle = b.normalized_name === '' ? styleNameIdentity(b.name, b.normalized_brewery) : '';
    const compatible = orphans.filter((o) => {
      if (b.normalized_name === '' && styleNameIdentity(o.name, b.normalized_brewery) !== inputStyle) {
        return false;
      }
      const identity = digitIdentity(readNameDigits(o.name), bidDigits);
      return identity === 'same' || identity === 'year-fallback';
    });
    ```

- [x] **Step 3: Run unit tests**: `npx vitest run src/storage/beers.test.ts`.
- [x] **Step 4: Run full gate**: `npm test && npm run typecheck`.
- [x] **Step 5: Commit**: `git commit -m "fix(storage): differentiate style-only names in ensureOrphan and resolvableOrphan (#663)"`.

---

### Task 2: `src/api/routes/enrich.ts` — `ensureBeerRow` style gate for shop cards

**Files:**
- Modify: `src/api/routes/enrich.ts`
- Modify: `src/api/routes/enrich.test.ts`

- [x] **Step 1: Write test in `src/api/routes/enrich.test.ts`**:
  - Assert that `ensureBeerRow` with card `Pils` does not attach to an existing brewery row `WEIZEN` when both have `normalized_name === ''`.

- [x] **Step 2: Implement style filter in `ensureBeerRow`**:
  - Import `styleNameIdentity` from `../../domain/style-identity`.
  - Filter `listBeersByNormalized`:
    ```ts
    const cardStyle = normalized_name === '' ? styleNameIdentity(name, normalized_brewery) : '';
    const candidates = listBeersByNormalized(db, normalized_brewery, normalized_name).filter((r) =>
      normalized_name !== '' || styleNameIdentity(r.name, r.normalized_brewery) === cardStyle,
    );
    const existing = pickRowByDigits(name, candidates);
    ```

- [x] **Step 3: Run unit tests**: `npx vitest run src/api/routes/enrich.test.ts`.
- [x] **Step 4: Run full gate**: `npm test && npm run typecheck`.
- [x] **Step 5: Commit**: `git commit -m "fix(enrich): filter ensureBeerRow candidates by style identity when name is empty (#663)"`.

---

### Task 3: `src/domain/untappd-lookup.ts` — guard `inputIdentityAliases` against bare brewery brand (#465)

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Modify: `src/domain/untappd-lookup.test.ts`

- [x] **Step 1: Write test in `src/domain/untappd-lookup.test.ts`**:
  - Assert that when `candidateName` would be empty, bare brewery brand is not admitted into `inputIdentityAliases`, rejecting an `alias_alt` that only matches the brand.

- [x] **Step 2: Filter empty candidates in `inputIdentityAliases`**:
  - In `src/domain/untappd-lookup.ts`:
    ```ts
    const inputIdentityAliases = new Set(
      inputBreweryAliases.flatMap((alias) => {
        const strippedName = stripBreweryFromName(normalizedInputName, alias);
        return [normalizedInputName, strippedName]
          .filter((candidateName) => candidateName.trim() !== '')
          .map((candidateName) => baseNormalize(`${alias} ${candidateName}`));
      }),
    );
    ```

- [x] **Step 3: Run unit tests**: `npx vitest run src/domain/untappd-lookup.test.ts`.
- [x] **Step 4: Run full gate**: `npm test && npm run typecheck`.
- [x] **Step 5: Commit**: `git commit -m "fix(lookup): drop empty candidate name from inputIdentityAliases (#465, #663)"`.

---

### Task 4: Documentation in `spec.md`

**Files:**
- Modify: `spec.md`

- [x] **Step 1: Update `spec.md`**:
  - Document the behavior of names that normalize to empty (`normalizeName(name) === ''`):
    - `styleNameIdentity` extracts the style word from raw names;
    - Exact matching gate requires `styleNameIdentity` equality and ABV compatibility within `ABV_TOLERANCE`;
    - Fuzzy matching is forbidden when `normalizeName(name) === ''`;
    - `number-fallback` requires candidate to have letter characters outside numbers;
    - `ensureOrphan` and `resolvableOrphan` isolate style-only beers by `styleNameIdentity`.
- [x] **Step 2: Run full gate**: `npm test && npm run typecheck`.
- [x] **Step 3: Commit**: `git commit -m "docs(spec): document style-only tap name matching and orphan isolation (#663)"`.
