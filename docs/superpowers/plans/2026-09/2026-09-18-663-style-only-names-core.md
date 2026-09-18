# #663 Style-Only Tap Names — Core (matcher + style-identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false-positive exact and fuzzy auto-links on taps whose names consist only of style words, Plato extract grades, and/or specs (`Pils 12°`, `IPA 13,5°`, `Stout`, `LAGER 10.5°`), while safely preserving legitimate links where the brewery's Untappd product is named after the style (`Zakładowy Pils`, `Trzech Kumpli Weizen`, `Zwierzyniec Pils`, `Remeslo WEIZEN`).

**Architecture:**
1. A domain module `src/domain/style-identity.ts` extracts clean style identity (`styleNameIdentity(rawName, breweryNorm)`) via `baseNormalize(stripSearchNoise(rawName))` with brewery echo stripped.
2. In `src/domain/matcher.ts`:
   - `c.nameNorm === nn` is evaluated **only when `nn !== ''`**;
   - When `nn === ''`, exact matching requires `styleNameIdentity(c.name, c.breweryNorm) === inputStyle` and ABV agreement within `ABV_TOLERANCE` (if ABV is present);
   - Fuzzy fallback is **completely blocked** when `nn === ''` (`if (isBareBrandName(input.name, input.brewery) || nn === '') return null;`).
3. In `src/domain/digit-identity.ts`:
   - `number-fallback` requires the candidate name to contain at least one letter token outside of digits, preventing purely numeric candidates like `21` from matching lettered style inputs like `LAGER 10.5°`.

**Tech Stack:** TypeScript (CommonJS, Node 24), Vitest (globals).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-18-663-style-only-names-design.md`.

---

## Global Constraints

- This plan covers the **Core stage only** (domain modules + matcher + tests + live replay verification).
- The **Periphery stage** (`ensureOrphan`, `ensureBeerRow`, `resolvableOrphan`, `untappd-lookup.ts` #465, and `spec.md`) will follow after core review.
- `normalizeName` remains **untouched** (it feeds the Algolia query ladder).
- Full gate after **every** task: `npm test && npm run typecheck`.
- Commit messages follow repo conventions and name the mechanism.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/style-identity.ts` (create) | Pure function `styleNameIdentity(rawName, breweryNorm)` |
| `src/domain/style-identity.test.ts` (create) | Unit tests verifying style token extraction and noise stripping |
| `src/domain/digit-identity.ts` (modify) | Require candidate to have letters for `number-fallback` |
| `src/domain/digit-identity.test.ts` (modify) | Test that pure-number candidates (e.g. `21`) do not yield `number-fallback` for style inputs |
| `src/domain/matcher.ts` (modify) | Exact gate on `nn !== ''`, style match on `nn === ''`, block fuzzy on `nn === ''` |
| `src/domain/matcher.test.ts` (modify) | Unit tests covering style-only taps matching / refusing |

Task sizing (CLAUDE.md / AGENTS.md):
- Tasks 1–3 touch 1–2 files plus tests, have fully defined code, and require no new architectural decisions → **small, executed inline by controller**.
- Task 4 runs live database replay and verification gate.

---

### Task 1: `src/domain/style-identity.ts` — clean style identity helper

**Files:**
- Create: `src/domain/style-identity.ts`
- Create: `src/domain/style-identity.test.ts`

- [ ] **Step 1: Write failing tests** in `src/domain/style-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { styleNameIdentity } from './style-identity';
import { normalizeBrewery } from './normalize';

describe('styleNameIdentity', () => {
  it('strips extract grades and specs while keeping the style word', () => {
    expect(styleNameIdentity('Pils 12°', 'zakladowy')).toBe('pils');
    expect(styleNameIdentity('Pils 12,0°', 'remeslo')).toBe('pils');
    expect(styleNameIdentity('WEIZEN 12°', 'kraftwerk remeslo')).toBe('weizen');
    expect(styleNameIdentity('Weizen 12,5°', 'trzech kumpli')).toBe('weizen');
    expect(styleNameIdentity('LAGER 10.5°', 'funky fluid')).toBe('lager');
    expect(styleNameIdentity('Session IPA 12°', 'nieczajna')).toBe('session ipa');
    expect(styleNameIdentity('Dry Stout 16°', 'maryensztadt')).toBe('dry stout');
    expect(styleNameIdentity('Saison 12,5°', 'palatum')).toBe('saison');
  });

  it('keeps style word from unadorned names', () => {
    expect(styleNameIdentity('Pils', 'zakladowy')).toBe('pils');
    expect(styleNameIdentity('WEIZEN', 'kraftwerk remeslo')).toBe('weizen');
    expect(styleNameIdentity('Stout', 'magic road')).toBe('stout');
    expect(styleNameIdentity('LAGER', 'magic road')).toBe('lager');
  });

  it('preserves numeric names when raw name is purely numeric', () => {
    expect(styleNameIdentity('21', 'funky fluid')).toBe('21');
    expect(styleNameIdentity('10', 'kamenice')).toBe('10');
  });

  it('strips brewery brand echo from candidate name', () => {
    expect(styleNameIdentity('Lager Trzech Kumpli', 'trzech kumpli')).toBe('lager');
    expect(styleNameIdentity('Browar Zakładowy Pils', 'zakladowy')).toBe('pils');
    expect(styleNameIdentity('Saison (MBC)', 'palatum')).toBe('saison');
  });

  it('distinguishes distinct styles and numbers', () => {
    expect(styleNameIdentity('Stout', 'magic road')).not.toBe(styleNameIdentity('LAGER', 'magic road'));
    expect(styleNameIdentity('Pils 12°', 'remeslo')).not.toBe(styleNameIdentity('WEIZEN', 'remeslo'));
    expect(styleNameIdentity('LAGER 10.5°', 'funky fluid')).not.toBe(styleNameIdentity('21', 'funky fluid'));
  });
});
```

- [ ] **Step 2: Implement `src/domain/style-identity.ts`**:

```ts
import { stripSearchNoise, baseNormalize } from './normalize';
import { stripBreweryFromName } from './matcher';

/**
 * #663 — clean style identity for names that normalize to empty (`normalizeName(name) === ''`).
 *
 * `normalizeName` removes style words, degree grades, spec labels, and numeric noise.
 * When a tap name consists only of those tokens (`Pils 12°`, `Stout`, `LAGER 10.5°`),
 * `normalizeName` collapses it to `''`.
 *
 * `styleNameIdentity` extracts the underlying style representation by:
 * 1. Stripping search noise (grades like `12°`, `10.5%`, packaging/brackets like `(MBC)`);
 * 2. Base-normalizing the remaining text (lowercase, ASCII transliteration);
 * 3. Stripping any brewery brand echo.
 */
export function styleNameIdentity(rawName: string, breweryNorm: string): string {
  const clean = baseNormalize(stripSearchNoise(rawName));
  return stripBreweryFromName(clean, breweryNorm).trim();
}
```

- [ ] **Step 3: Run unit tests**: `npx vitest run src/domain/style-identity.test.ts`.
- [ ] **Step 4: Run full gate**: `npm test && npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -m "feat(domain): add styleNameIdentity for style-only names (#663)"`.

---

### Task 2: `src/domain/digit-identity.ts` — require letters for `number-fallback`

**Files:**
- Modify: `src/domain/digit-identity.ts`
- Modify: `src/domain/digit-identity.test.ts`

- [ ] **Step 1: Write test in `src/domain/digit-identity.test.ts`**:
Add test asserting that `digitIdentity` does NOT give `number-fallback` when candidate has no letters outside digits (e.g. `LAGER 10.5°` vs candidate `21`).

- [ ] **Step 2: Implement guard in `src/domain/digit-identity.ts`**:
In `digitIdentity(input, candidate)`:
When candidate has a number that input does not have, allow `number-fallback` **only if** candidate name contains at least one letter token (`/[a-z]/i.test(candidateName)`). If candidate is purely numeric (like `21`, `15`, `87`), return `'different'`.

- [ ] **Step 3: Run unit tests**: `npx vitest run src/domain/digit-identity.test.ts`.
- [ ] **Step 4: Run full gate**: `npm test && npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -m "fix(digit-identity): require candidate letters for number-fallback (#663, #636)"`.

---

### Task 3: `src/domain/matcher.ts` — exact and fuzzy style-name gates

**Files:**
- Modify: `src/domain/matcher.ts`
- Modify: `src/domain/matcher.test.ts`

- [ ] **Step 1: Add failing test cases in `src/domain/matcher.test.ts`**:
  - `Pils 12°` matches `Zakładowy / Pils` (exact, conf=1.0)
  - `Weizen 12,5°` matches `Trzech Kumpli / Weizen` (exact, conf=1.0)
  - `Stout` refuses `Magic Road / LAGER` (returns null, stays orphan)
  - `LAGER 10.5°` refuses `Funky Fluid / 21` (returns null, stays orphan)
  - `IPA 13,5°` refuses `Brovarnia Gdańsk / Black IPA` (returns null, stays orphan)
  - `Session IPA 12°` refuses `Browar Nieczajna / Wild Imperial Stout` (returns null, stays orphan)
  - `Pils 12,0°` refuses `Remeslo / WEIZEN` (returns null, stays orphan)
  - `Pils 12°` (abv 4.8) refuses `Zakładowy / Pils` (abv 5.2) if breweries don't match or ABV mismatch

- [ ] **Step 2: Update `matchPrepared` in `src/domain/matcher.ts`**:
  1. Compute `inputStyleIdentity = nn === '' ? styleNameIdentity(input.name, inputAliases[0] ?? '') : ''`.
  2. In exact filter:
     ```typescript
     let exacts = breweryMatches
       .filter((c) => {
         if (nn !== '') {
           return c.nameNorm === nn || intersects(c.keys, inputKeys);
         }
         // When nn === '', name is style-only or numbers: require identical style identity + ABV tolerance
         const candStyle = styleNameIdentity(c.name, c.breweryNorm);
         if (candStyle === '' || candStyle !== inputStyleIdentity) return false;
         const wantAbv = input.abv ?? null;
         if (wantAbv !== null && c.abv !== null && Math.abs(c.abv - wantAbv) > ABV_TOLERANCE) {
           return false;
         }
         return true;
       })
       .sort((a, b) => b.id - a.id);
     ```
  3. In fuzzy fallback guard:
     ```typescript
     // Block fuzzy matching if name carries nothing beyond brand (#306) OR normalizes to empty (#663)
     if (isBareBrandName(input.name, input.brewery) || nn === '') return null;
     ```
  4. Ensure `nameTokensDiverge(nn, cand.nameNorm)` also returns `true` (diverges) if one name has tokens while the other is empty.

- [ ] **Step 3: Run unit tests**: `npx vitest run src/domain/matcher.test.ts`.
- [ ] **Step 4: Run full gate**: `npm test && npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -m "fix(matcher): gate exact matching and forbid fuzzy for style-only names (#663)"`.

---

### Task 4: Live Replay Verification & Probe

**Files:**
- Run probe script against `/var/lib/warsaw-beer-bot/bot.db` (read-only).

- [ ] **Step 1: Run replay on all 24 live tap links**:
Verify that all 16 bogus links are rejected (`res: null`), while legitimate links (`Zakładowy Pils`, `Trzech Kumpli Weizen`, `Zwierzyniec Pils`, `Remeslo WEIZEN`) match cleanly.
- [ ] **Step 2: Run full gate**: `npm test && npm run typecheck`.
- [ ] **Step 3: Summary and ready for whole-branch review before Periphery stage**.
