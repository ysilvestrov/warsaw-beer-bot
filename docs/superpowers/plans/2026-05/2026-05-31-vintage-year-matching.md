# Vintage Year Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `matchBeer` year-aware so that ontap beers with an explicit vintage year (e.g. "AFFECTION 2023") prefer a catalog entry with the same year, fall back to no-year entries, and never silently cross-match to a different vintage.

**Architecture:** Two pure additions to `src/domain/matcher.ts`: (1) `extractYear(name)` extracts a 4-digit year from a raw beer name; (2) the exact-match selection block is replaced with a priority chain — yearMatch → noYear fallback → null — with an ABV-mismatch escape hatch inside the yearMatch branch. No changes to storage, jobs, or bot commands. Retroactive cleanup deletes 3 confirmed wrong match_links so `/refresh` re-creates them with the corrected logic.

**Tech Stack:** TypeScript, Jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-31-vintage-year-matching.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/domain/matcher.ts` | Modify | Export `extractYear`; replace exact-match selection block (lines 71–80) with year-aware logic |
| `src/domain/matcher.test.ts` | Modify | `extractYear` unit tests + 8 new `matchBeer` vintage scenarios |

No new files. No changes to `normalize.ts`, storage, jobs, or bot.

---

## Task 1: `extractYear` — tests then implementation

**Files:**
- Modify: `src/domain/matcher.ts` (add function)
- Modify: `src/domain/matcher.test.ts` (add describe block)

- [ ] **Step 1: Write failing tests for `extractYear`**

Open `src/domain/matcher.test.ts`. After the existing `import` line, add to the import:

```ts
import { matchBeer, breweryAliases, extractYear, type CatalogBeer } from './matcher';
```

Then append a new describe block at the **end of the file** (after all existing tests):

```ts
describe('extractYear', () => {
  test('finds 4-digit year in parentheses', () => {
    expect(extractYear('Affection (2025)')).toBe(2025);
  });
  test('finds bare 4-digit year', () => {
    expect(extractYear('AFFECTION 2023')).toBe(2023);
  });
  test('returns null when no 4-digit year present', () => {
    expect(extractYear('Affection')).toBeNull();
  });
  test('ignores abbreviated 2-digit year form', () => {
    expect(extractYear("Farm to Glass '25: Citra")).toBeNull();
  });
  test('1900-range year is detected', () => {
    expect(extractYear('Vintage 1998')).toBe(1998);
  });
  test('number outside 19xx/20xx range is not a year', () => {
    expect(extractYear('Tripel 888')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest matcher.test --no-coverage 2>&1 | tail -15
```

Expected: `extractYear` not exported → compile error or 6 failing tests.

- [ ] **Step 3: Implement `extractYear` in `matcher.ts`**

Open `src/domain/matcher.ts`. After the `COLLAB_SEP` export (line 26), add:

```ts
// Extracts the first 4-digit calendar year (1900–2099) from a raw beer name.
// Called on the un-normalized name because normalizeName strips digit tokens.
export function extractYear(name: string): number | null {
  const m = name.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}
```

- [ ] **Step 4: Verify `extractYear` tests pass**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest matcher.test --no-coverage 2>&1 | tail -10
```

Expected: all `extractYear` tests pass (existing tests still green).

- [ ] **Step 5: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/domain/matcher.ts src/domain/matcher.test.ts && git commit -m "feat(matcher): extractYear — detect 4-digit vintage year in raw beer name"
```

---

## Task 2: Year-aware exact match — tests then implementation

**Files:**
- Modify: `src/domain/matcher.ts` (replace lines 71–80)
- Modify: `src/domain/matcher.test.ts` (new describe block)

- [ ] **Step 1: Write 9 failing tests**

Append a new describe block to the end of `src/domain/matcher.test.ts`:

```ts
describe('matchBeer — vintage year disambiguation', () => {
  // Helper: build a minimal CatalogBeer
  const beer = (id: number, name: string, brewery: string, abv: number | null): CatalogBeer =>
    ({ id, name, brewery, abv });

  const pinta = (id: number, name: string, abv: number | null) =>
    beer(id, name, 'PINTA Barrel Brewing', abv);

  test('year match + ABV ok → returns yearMatch candidate', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
      pinta(8,  'Affection',        7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(10);
    expect(m?.source).toBe('exact');
  });

  test('year match + ABV mismatch → noYear ABV hit wins', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),  // year matches but ABV wrong
      pinta(8,  'Affection',        7.0),  // no year, ABV matches
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(8);
  });

  test('year match + ABV mismatch + no noYear → wrongYear ABV hit wins (most recent)', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),  // year matches but ABV wrong
      pinta(9,  'Affection (2024)', 7.0),  // wrong year, ABV matches
      pinta(7,  'Affection (2022)', 7.0),  // wrong year, ABV matches (older)
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(9);  // most recent (highest id) wrongYear with ABV match
  });

  test('year match + ABV mismatch + no alternatives → accept ABV error, return yearMatch', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),  // year matches, ABV wrong, nothing else
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(10);
  });

  test('year match + no input ABV → returns yearMatch without ABV check', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),
      pinta(8,  'Affection',        7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025' }, catalog);
    expect(m?.id).toBe(10);
  });

  test('no same-year entry → noYear fallback, ABV applied', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
      pinta(8,  'Affection',        7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023', abv: 7.0 }, catalog);
    expect(m?.id).toBe(8);  // noYear with ABV match
  });

  test('no same-year entry → noYear fallback, most-recent when no ABV', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
      pinta(8,  'Affection',        7.0),
      pinta(6,  'Affection',        6.5),  // older no-year entry
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023' }, catalog);
    expect(m?.id).toBe(8);  // most recent noYear (id 8 > 6)
  });

  test('only wrong-year candidates → null (no cross-vintage match)', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023', abv: 7.0 }, catalog);
    expect(m).toBeNull();
  });

  test('no year in input → existing behavior (ABV then most-recent)', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
    ];
    // No year in input name — falls through to old logic: ABV match first
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection', abv: 6.8 }, catalog);
    expect(m?.id).toBe(9);
  });
});
```

- [ ] **Step 2: Verify tests fail**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest matcher.test --no-coverage 2>&1 | tail -20
```

Expected: 9 new tests fail (current logic ignores year entirely).

- [ ] **Step 3: Replace the exact-match selection block in `matcher.ts`**

Find this block in `src/domain/matcher.ts` (currently lines 71–80):

```ts
  if (exacts.length) {
    const wantAbv = input.abv ?? null;
    if (wantAbv !== null) {
      const abvHit = exacts.find(
        (c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE,
      );
      if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };
    }
    return { id: exacts[0].id, confidence: 1, source: 'exact' };
  }
```

Replace with:

```ts
  if (exacts.length) {
    const wantAbv = input.abv ?? null;
    const inputYear = extractYear(input.name);

    if (inputYear === null) {
      // No year in input — original behaviour: ABV first, else most-recent.
      if (wantAbv !== null) {
        const abvHit = exacts.find(
          (c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE,
        );
        if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };
      }
      return { id: exacts[0].id, confidence: 1, source: 'exact' };
    }

    // Year found in input — partition candidates by vintage relationship.
    // exacts is already sorted id DESC so each filtered array is too.
    const yearMatch = exacts.filter((c) => extractYear(c.name) === inputYear);
    const noYear    = exacts.filter((c) => extractYear(c.name) === null);
    const wrongYear = exacts.filter(
      (c) => { const y = extractYear(c.name); return y !== null && y !== inputYear; },
    );

    if (yearMatch.length > 0) {
      const candidate = yearMatch[0];
      const abvMismatch =
        wantAbv !== null &&
        candidate.abv !== null &&
        Math.abs(candidate.abv - wantAbv) > ABV_TOLERANCE;

      if (!abvMismatch) {
        return { id: candidate.id, confidence: 1, source: 'exact' };
      }

      // ABV mismatch on the year-matching row — likely an ontap data entry error.
      // Try other candidates that have a matching ABV: noYear first, then wrongYear.
      const abvHit =
        noYear.find((c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE) ??
        wrongYear.find((c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE);
      if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };

      // Nothing with a better ABV — accept the ontap ABV error, stay on year-match.
      return { id: candidate.id, confidence: 1, source: 'exact' };
    }

    // No same-year catalog entry — fall back to no-year entries if any exist.
    if (noYear.length > 0) {
      if (wantAbv !== null) {
        const abvHit = noYear.find(
          (c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE,
        );
        if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };
      }
      return { id: noYear[0].id, confidence: 1, source: 'exact' };
    }

    // Only wrong-year candidates exist — do not cross-match vintages.
    return null;
  }
```

- [ ] **Step 4: Verify all matcher tests pass**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest matcher.test --no-coverage 2>&1 | tail -10
```

Expected: all tests pass (existing 28 + 6 extractYear + 9 vintage = 43 total).

- [ ] **Step 5: Full suite**

```bash
cd /home/ysi/warsaw-beer-bot && npm test 2>&1 | tail -8
```

Expected: all suites green.

- [ ] **Step 6: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/domain/matcher.ts src/domain/matcher.test.ts && git commit -m "$(cat <<'EOF'
feat(matcher): year-aware exact match — prefer same vintage, ABV fallback

When ontap name has a 4-digit year Y, prefer catalog entries with year Y.
If the year-match has a suspicious ABV delta (>0.3, likely ontap entry error),
try no-year entries then wrong-year entries that have a matching ABV.
If no same-year entry exists, fall back to no-year entries; if only
wrong-year entries exist, return null to prevent cross-vintage matches.
EOF
)"
```

---

## Task 3: Retroactive cleanup + verification

**Files:** N/A (SQL + runtime verification)

- [ ] **Step 1: Deploy updated code to production**

```bash
cd /home/ysi/warsaw-beer-bot && ./deploy/deploy.sh 2>&1 | tail -10
```

Expected: clean build and restart, no errors.

- [ ] **Step 2: Delete the 3 confirmed wrong match_links**

```bash
sqlite3 /var/lib/warsaw-beer-bot/bot.db "
DELETE FROM match_links
WHERE ontap_ref IN (
  'AFFECTION 2023',
  'Farm To Glass 2026 : Citra',
  'Farm To Glass 2026 : Mosaic'
);
SELECT changes() AS deleted_rows;"
```

Expected: `deleted_rows = 3`.

- [ ] **Step 3: Trigger /refresh via Telegram**

Send `/refresh` in Telegram to re-run the matcher on the current tap list.

- [ ] **Step 4: Verify new match_links were created**

```bash
sqlite3 /var/lib/warsaw-beer-bot/bot.db "
SELECT ml.ontap_ref, b.name, b.id, ml.confidence
FROM match_links ml
JOIN beers b ON b.id = ml.untappd_beer_id
WHERE ml.ontap_ref IN (
  'AFFECTION 2023',
  'Farm To Glass 2026 : Citra',
  'Farm To Glass 2026 : Mosaic'
);" | column -t -s '|'
```

Expected: 3 rows. For `AFFECTION 2023`: `b.name` should be `Affection` (no-year fallback, since no 2023 entry exists in catalog). For the two Farm To Glass rows: should map to the `'25` entries (no 4-digit year detected in `'25` form → treated as no-year fallback).

---

## Self-Review

**Spec coverage:**
- `extractYear` helper → Task 1 ✓
- Year-preference (yearMatch first) → Task 2 Step 3 ✓
- ABV-mismatch fallback chain (noYear → wrongYear → accept) → Task 2 Step 3 ✓
- No-year fallback when no yearMatch → Task 2 Step 3 ✓
- null when only wrongYear → Task 2 Step 3 ✓
- No change when inputYear null → Task 2 Step 3 (inputYear === null branch) ✓
- Retroactive cleanup of 3 wrong match_links → Task 3 ✓
- All spec test scenarios covered by 9 new tests → Task 2 Step 1 ✓

**Placeholder scan:** None. All code blocks complete, all commands have expected output. ✓

**Type consistency:**
- `extractYear` exported in Task 1, used in Task 2 implementation ✓
- `extractYear` imported in test file in Task 1 Step 1 and used throughout ✓
- `yearMatch`, `noYear`, `wrongYear` defined and used within same block ✓
- `CatalogBeer` imported in test file for the `beer()` helper ✓
