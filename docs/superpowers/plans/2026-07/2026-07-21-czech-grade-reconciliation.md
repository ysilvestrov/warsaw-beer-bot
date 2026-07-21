# Czech Grade (°Plato) Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match Czech beers named by °Plato grade (bare `8/10/11/12` or spelled `desítka`/`dvanáctka`/…) to their same-grade pale-lager candidate on Untappd, which the current pipeline drops because it strips the grade as noise on both sides.

**Architecture:** A new isolated, unit-tested module `src/domain/czech-grade.ts` provides grade extraction and style/dark predicates. A new **last-resort matching stage** in `lookupBeer` (`untappd-lookup.ts`), gated to the **strict brewery pool**, selects a same-grade candidate that is not an ale style (and not dark unless the input is), preferring the fewest-extra-descriptor-token candidate, tie-broken by ABV.

**Tech Stack:** Node.js, TypeScript, Vitest. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-07/2026-07-21-czech-grade-reconciliation-design.md`

---

## File Structure

- **Create** `src/domain/czech-grade.ts` — grade word map, range constants, style/dark keyword sets, and the pure helpers `extractGrade`, `isAleStyle`, `isDark`, `extraDescriptorCount`. One responsibility: Czech-grade reasoning. No I/O.
- **Create** `src/domain/czech-grade.test.ts` — unit tests for the helpers.
- **Modify** `src/domain/untappd-lookup.ts` — import the helpers; insert the grade-reconciliation stage inside the per-part loop, after the brand stage and before the "fall through to next part" comment (currently around line 323–325).
- **Modify** `src/domain/untappd-lookup.test.ts` — add lookup tests driven by the 5 real orphan fixtures.

`baseNormalize` (already exported from `src/domain/normalize.ts`) is the tokenizer for the new module — it lowercases, strips diacritics, and **keeps** digits (unlike `normalizeName`, which strips them).

---

### Task 1: `czech-grade.ts` module + unit tests

**Files:**
- Create: `src/domain/czech-grade.ts`
- Test: `src/domain/czech-grade.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/czech-grade.test.ts`:

```typescript
import { extractGrade, isAleStyle, isDark, extraDescriptorCount } from './czech-grade';

describe('extractGrade', () => {
  test('spelled Czech grade words → number (diacritic-stripped input)', () => {
    expect(extractGrade('Desitka')).toBe(10);
    expect(extractGrade('Desítka')).toBe(10);
    expect(extractGrade('Dvanactka')).toBe(12);
    expect(extractGrade('Dvanáctka')).toBe(12);
    expect(extractGrade('Dvanastka')).toBe(12); // observed shop misspelling (beer_id 29429)
    expect(extractGrade('Osmicka')).toBe(8);
  });

  test('bare integer inside the Plato range', () => {
    expect(extractGrade('Trutnov 11')).toBe(11);
    expect(extractGrade('Kamenická 10')).toBe(10);
    expect(extractGrade('Ležák 11%')).toBe(11);
  });

  test('numbers outside 7–20 are not grades', () => {
    expect(extractGrade('Pinta 555')).toBeNull();
    expect(extractGrade('6')).toBeNull();
    expect(extractGrade('21')).toBeNull();
    expect(extractGrade('Buzdygan Rozkoszy 2026')).toBeNull();
  });

  test('names with no grade signal → null', () => {
    expect(extractGrade('Premium pszenica')).toBeNull();
    expect(extractGrade('Hopinka')).toBeNull();
  });
});

describe('isAleStyle', () => {
  test('true for ale style via the Untappd style label', () => {
    expect(isAleStyle('Góséčko mango+calamansi 11%', 'Gose')).toBe(true);
    expect(isAleStyle('Session IPA 11%', 'IPA - Session')).toBe(true);
  });

  test('true for ale style found in the beer name when style is null', () => {
    expect(isAleStyle('Nazwa Stout 11', null)).toBe(true);
  });

  test('false for a pale lager', () => {
    expect(isAleStyle('Ležák 11%', 'Czech Pale Lager')).toBe(false);
    expect(isAleStyle('Kamenická 10', null)).toBe(false);
  });
});

describe('isDark', () => {
  test('true for dark styles/names', () => {
    expect(isDark('Tmavý ležák 10°', 'Czech Dark Lager')).toBe(true);
    expect(isDark('Kamenická 12', 'Dark Lager')).toBe(true);
  });

  test('false for pale', () => {
    expect(isDark('Světlý ležák 11°', 'Czech Pale Lager')).toBe(false);
  });
});

describe('extraDescriptorCount', () => {
  test('plain lager has zero extra descriptors; seasonals have more', () => {
    expect(extraDescriptorCount('Světlý ležák 11°', 'krakonos', 11)).toBe(0);
    expect(extraDescriptorCount('Vánoční světlý ležák 11°', 'krakonos', 11)).toBe(1);
  });

  test('flavour tail counts as descriptors; grade + brand + lager words do not', () => {
    expect(extraDescriptorCount('Ležák 11%', 'nachmelena opice', 11)).toBe(0);
    expect(extraDescriptorCount('Góséčko mango calamansi 11%', 'nachmelena opice', 11)).toBe(3);
    expect(extraDescriptorCount('Kamenická 12', 'kamenice nad lipou', 12)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/czech-grade.test.ts`
Expected: FAIL — cannot resolve `./czech-grade` (module does not exist yet).

- [ ] **Step 3: Write the module**

Create `src/domain/czech-grade.ts`:

```typescript
import { baseNormalize } from './normalize';

// Plato range for the bare-integer grade path. Below 7 / above 20 is not a Czech grade
// (excludes vintage years like 2026 and numeric beer names like "Pinta 555").
const GRADE_MIN = 7;
const GRADE_MAX = 20;

// Spelled-out Czech grade words → grade number. Keys are already diacritic-stripped and
// lowercased to match baseNormalize output. Grow this as new shop spellings appear.
export const CZECH_GRADE_WORDS: ReadonlyMap<string, number> = new Map([
  ['osmicka', 8],
  ['devitka', 9],
  ['desitka', 10],
  ['jedenactka', 11],
  ['dvanactka', 12],
  ['dvanastka', 12], // observed shop misspelling (beer_id 29429 "Dvanastka")
  ['trinactka', 13],
  ['ctrnactka', 14],
]);

// A Czech grade denotes a pale lager, never these. Matched against both the Untappd style
// label and the beer-name tokens.
const ALE_STYLE_WORDS: ReadonlySet<string> = new Set([
  'ipa', 'apa', 'neipa', 'dipa', 'tipa', 'aipa',
  'gose', 'stout', 'porter', 'sour', 'saison',
  'lambic', 'weizen', 'wheat', 'witbier', 'barleywine',
]);

// Dark-beer markers (Czech pale is the default). A plain grade must not grab a dark variant.
const DARK_WORDS: ReadonlySet<string> = new Set([
  'tmavy', 'tmava', 'tmave', 'cerny', 'cerne', 'dark',
]);

// Lager/colour tokens that are NOT distinctive descriptors when ranking candidates.
const LAGER_KEYWORDS: ReadonlySet<string> = new Set([
  'lezak', 'vycepni', 'svetly', 'svetle', 'svetla', 'lager', 'pilsner', 'pils',
]);

function tokens(s: string): string[] {
  return baseNormalize(s).split(' ').filter(Boolean);
}

function isGradeToken(token: string, grade: number): boolean {
  if (CZECH_GRADE_WORDS.get(token) === grade) return true;
  return /^\d+$/.test(token) && Number(token) === grade;
}

// Grade from a spelled Czech word or a bare integer in the Plato range. First hit wins;
// null when the name carries no grade signal.
export function extractGrade(name: string): number | null {
  for (const t of tokens(name)) {
    const word = CZECH_GRADE_WORDS.get(t);
    if (word != null) return word;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n >= GRADE_MIN && n <= GRADE_MAX) return n;
    }
  }
  return null;
}

function matchesAny(beerName: string, style: string | null, words: ReadonlySet<string>): boolean {
  const toks = tokens(beerName);
  if (style) toks.push(...tokens(style));
  return toks.some((t) => words.has(t));
}

export function isAleStyle(beerName: string, style: string | null): boolean {
  return matchesAny(beerName, style, ALE_STYLE_WORDS);
}

export function isDark(beerName: string, style: string | null): boolean {
  return matchesAny(beerName, style, DARK_WORDS);
}

// Count of descriptor tokens in the beer name beyond brand, grade, and lager/colour keywords.
// Lower = more generic: a plain "Světlý ležák 11°" (0) beats a seasonal "Vánoční …" (1).
export function extraDescriptorCount(beerName: string, breweryNorm: string, grade: number): number {
  const brandToks = new Set(breweryNorm.split(' ').filter(Boolean));
  let count = 0;
  for (const t of tokens(beerName)) {
    if (brandToks.has(t)) continue;
    if (LAGER_KEYWORDS.has(t)) continue;
    if (isGradeToken(t, grade)) continue;
    count++;
  }
  return count;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/czech-grade.test.ts`
Expected: PASS (all describe blocks green).

Note: `extraDescriptorCount('Kamenická 12', 'kamenice nad lipou', 12)` = 1 — `kamenicka` is not a brewery token (brewery normalizes to `kamenice nad lipou`), so it counts. This is expected and matches the design's `Dvanastka` tiebreak analysis.

- [ ] **Step 5: Commit**

```bash
git add src/domain/czech-grade.ts src/domain/czech-grade.test.ts
git commit -m "feat(matcher): #321 Czech grade extraction + style/dark helpers"
```

---

### Task 2: Wire the grade-reconciliation stage into `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (import line 3-ish; new stage before the "No name match in this search part" comment, ~line 323)
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these tests inside the existing top-level `describe('lookupBeer', …)` block in `src/domain/untappd-lookup.test.ts` (before its closing `});`):

```typescript
  test('#321 grade: single same-grade lager candidate (Desitka → Kamenická 10)', async () => {
    const search = fakeSearch(() => [
      { bid: 12141, beer_name: 'Kamenická 10', brewery_name: 'Pivovar Kamenice nad Lipou', style: 'Czech Pale Lager', abv: 4.2, global_rating: 3.3 },
    ]);
    const out = await lookupBeer({ brewery: 'Kamenice nad Lipou Brewery', name: 'Desitka', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(12141);
  });

  test('#321 grade: bare number excludes ale styles (11 → Ležák, not Gose/IPA)', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Ležák 11%', brewery_name: 'Nachmelená Opice', style: 'Czech Pale Lager', abv: 4.6, global_rating: 3.5 },
      { bid: 2, beer_name: 'Góséčko mango+calamansi 11%', brewery_name: 'Nachmelená Opice', style: 'Gose', abv: 4.6, global_rating: 3.5 },
      { bid: 3, beer_name: 'Session IPA 11%', brewery_name: 'Nachmelená Opice', style: 'IPA - Session', abv: 4.6, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Nachmelená Opice Brewery', name: '11', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1);
  });

  test('#321 grade: fewest-descriptor lager wins over seasonals (Trutnov 11 → plain)', async () => {
    const search = fakeSearch(() => [
      { bid: 30, beer_name: 'Vánoční světlý ležák 11°', brewery_name: 'Krakonoš', style: 'Czech Pale Lager', abv: 4.8, global_rating: 3.5 },
      { bid: 31, beer_name: 'Světlý ležák 11°', brewery_name: 'Krakonoš', style: 'Czech Pale Lager', abv: 4.8, global_rating: 3.6 },
      { bid: 32, beer_name: 'Velikonoční světlý ležák 11°', brewery_name: 'Krakonoš', style: 'Czech Pale Lager', abv: 4.8, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Pivovar Krakonoš Brewery', name: 'Trutnov 11', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(31);
  });

  test('#321 grade: spelled word matches same-grade candidates (Dvanastka → 12°)', async () => {
    const search = fakeSearch(() => [
      { bid: 40, beer_name: 'Kamenická 12', brewery_name: 'Pivovar Kamenice nad Lipou', style: 'Czech Amber Lager', abv: 5, global_rating: 3.5 },
      { bid: 41, beer_name: 'Spílková Dvanáctka', brewery_name: 'Pivovar Kamenice nad Lipou', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Kamenica Brewery', name: 'Dvanastka', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect([40, 41]).toContain(out.result.bid);
  });

  test('#321 grade: no same-grade non-ale candidate → not_found (does not force a match)', async () => {
    const search = fakeSearch(() => [
      { bid: 50, beer_name: 'Hazy IPA 11%', brewery_name: 'Nachmelená Opice', style: 'IPA', abv: 6.5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Nachmelená Opice Brewery', name: '11', search });
    expect(out.kind).toBe('not_found');
  });

  test('#321 grade: dark candidate excluded for a plain (pale-default) grade', async () => {
    const search = fakeSearch(() => [
      { bid: 60, beer_name: 'Tmavá desítka', brewery_name: 'Nachmelená Opice', style: 'Czech Dark Lager', abv: 4.2, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Nachmelená Opice Brewery', name: 'Desitka', search });
    expect(out.kind).toBe('not_found');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t '#321'`
Expected: FAIL — the grade cases return `not_found` (no stage exists yet); e.g. the `Desitka → Kamenická 10` test fails on `expect(out.kind).toBe('matched')`.

- [ ] **Step 3: Add the import**

In `src/domain/untappd-lookup.ts`, add after the existing `./matcher` / `./normalize` imports (top of file, around line 3):

```typescript
import { extractGrade, isAleStyle, isDark, extraDescriptorCount } from './czech-grade';
```

- [ ] **Step 4: Insert the grade-reconciliation stage**

In `src/domain/untappd-lookup.ts`, find this existing block near the end of the `for (const part of parts)` loop (currently ~line 319-325):

```typescript
    const brandKeys = nameKeys(name, '');
    const brandHits = brandPool.filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), brandKeys),
    );
    if (brandHits.length > 0) return { kind: 'matched', result: pickByAbv(brandHits, abv) };

    // No name match in this search part — fall through to the next part.
  }
```

Insert the new stage **between** the `brandHits` return and the `// No name match` comment:

```typescript
    const brandKeys = nameKeys(name, '');
    const brandHits = brandPool.filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), brandKeys),
    );
    if (brandHits.length > 0) return { kind: 'matched', result: pickByAbv(brandHits, abv) };

    // Stage 3 (#321): Czech °Plato grade reconciliation. STRICT pool only, last resort (every
    // name stage above has missed). A shop name that is a Czech grade (bare 8/10/11/12 or spelled
    // desítka/dvanáctka/…) denotes a PALE LAGER — never an ale style. Reconcile it to a same-grade
    // candidate, excluding ale styles (and dark variants unless the input is itself dark), then
    // prefer the fewest-extra-descriptor candidate (plain lager over a seasonal), ABV-tiebroken.
    const inputGrade = extractGrade(name);
    if (strictPool.length > 0 && inputGrade != null) {
      const inputDark = isDark(name, null);
      const graded = strictPool.filter(
        (r) =>
          extractGrade(r.beer_name) === inputGrade &&
          !isAleStyle(r.beer_name, r.style) &&
          (inputDark || !isDark(r.beer_name, r.style)),
      );
      if (graded.length > 0) {
        const ranked = graded
          .map((r) => ({
            r,
            extra: extraDescriptorCount(r.beer_name, normalizeBrewery(r.brewery_name), inputGrade),
          }))
          .sort((a, b) => a.extra - b.extra);
        const bestExtra = ranked[0].extra;
        const tied = ranked.filter((x) => x.extra === bestExtra).map((x) => x.r);
        return { kind: 'matched', result: pickByAbv(tied, abv) };
      }
    }

    // No name match in this search part — fall through to the next part.
  }
```

- [ ] **Step 5: Run the #321 tests to verify they pass**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t '#321'`
Expected: PASS (all six #321 tests green).

- [ ] **Step 6: Run the full domain suite to check for regressions**

Run: `npx vitest run src/domain`
Expected: PASS — no existing test regresses. (If a pre-existing test that used a 7–20 number now matches via Stage 3, investigate; per the design Stage 3 only fires as a last resort on the strict pool, so a genuine earlier match is unaffected.)

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "feat(matcher): #321 Czech grade reconciliation lookup stage"
```

---

### Task 3: Full verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`
Expected: PASS (whole suite).

- [ ] **Step 2: Push branch and open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(matcher): #321 Czech grade (°Plato) reconciliation" \
  --body "$(cat <<'EOF'
Closes #321.

Adds a last-resort enrichment matching stage that reconciles Czech °Plato grade naming.
A shop name that is a Czech grade (bare 8/10/11/12 or spelled desítka/dvanáctka/…) denotes a
pale lager; it matches a same-grade candidate on the strict brewery pool, excluding ale styles
(and dark variants unless the input is dark), preferring the fewest-extra-descriptor candidate.

- New isolated, unit-tested module `src/domain/czech-grade.ts`.
- New stage in `lookupBeer`, strict-pool-only, runs after all name stages miss.
- Resolves the 5 real orphans (Desitka→Kamenická 10, 11→Ležák, Trutnov 11→plain lager, Dvanastka→12°).

Spec: docs/superpowers/specs/2026-07/2026-07-21-czech-grade-reconciliation-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Poll AI review** (per project `feedback_pr_review_loop`): wait for the AI PR review, read + critically assess each comment, fix valid ones, push back on wrong ones. Not done at green tests.

---

## Post-merge (deploy — not part of the branch)

After merge + deploy (`bash deploy/deploy.sh`), the 5 affected orphans are backed-off and will not
retry on their own. Re-arm them (reset `fail_count`/backoff) via the compiled `dist` rearm path run
as the `warsaw-beer-bot` user, then confirm they clear on the next enrichment cycle. See memory
`reference_enrich_failures_triage_columns` / `reference_orphan_failure_log` for the re-arm gotcha and
`project_matcher_bug_review_2026_07` for the post-deploy `rearm-matcher-bug-orphans` step.

---

## Self-Review notes

- **Spec coverage:** module (grade map, range, ale/dark sets, extractGrade) → Task 1; strict-pool last-resort stage with same-grade filter, ale/dark exclusion, fewest-token + ABV tiebreak → Task 2; 5-orphan fixtures + FP-guard tests → Task 2; re-arm → Post-merge. All spec sections covered.
- **Type consistency:** `extractGrade`, `isAleStyle(beerName, style)`, `isDark(beerName, style)`, `extraDescriptorCount(beerName, breweryNorm, grade)` are defined identically in Task 1 and called identically in Task 2. `SearchResult.style` is `string | null` — matches the `style: string | null` params.
- **No placeholders:** every code + test block is complete and runnable.
