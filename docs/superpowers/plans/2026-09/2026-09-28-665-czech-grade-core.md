# #665 Czech Grade Identity — Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. AGENTS.md requires sequential work in the main thread; do not dispatch subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing matcher select Konrad 10°'s correct catalog row instead of the newer Konrad 12° orphan, using the agreed Czech lager context.

**Architecture:** Add one contextual grade-conflict predicate to the existing digit-identity module. Reuse it to exclude conflicts from exact candidates and fuzzy selection, retaining the existing searchers, gates and budget. Read the existing SQL style column into the prepared catalog.

**Tech Stack:** Existing TypeScript, Vitest, better-sqlite3 and fast-fuzzy; Node.js >=24.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-28-665-czech-grade-identity-design.md` (approved 2026-09-28).

## Global Constraints

- «Нових залежностей і міграції схеми немає.»
- «Нормалізовані ключі, порядок інших рівнів цифр, правило років, ABV tolerance 0.3, brewery hard-gate, публічний формат API й правила authoritative bid не змінюються.»
- «Стиль відсутній з обох боків — новий veto не спрацьовує.»
- «Голе число 8–14, жорсткі числа та чеські словесні градуси продовжують оброблятися наявними правилами `digitIdentity` і стадією #321.»
- «Реальні записи та deployment не виконуються на етапі spec/plan.»
- Work in the existing `fix/issue-665` worktree. Preserve unrelated worktrees and branches.
- Before edits, read `spec.md`'s digit identity and style-only sections, the approved design, and current affected files. New assertions must use explicit expected values; no branching assertions or test algorithms that reproduce the predicate.
- Each implementation task ends with `npm test && npm run typecheck`, self-review and a commit with named paths. No PR, push or release as part of this core plan.
- This plan implements the core only. The alias, identity propagation into storage/API/search/web, `spec.md` amendment and data recovery belong to a separate plan written **after** the whole-core review. Completing this plan does not close #665 or make the branch ready to ship.

## Evidence and implementation decisions

Baseline at 4964f00: 3623 tests passed, one skipped; typecheck passed. These are prior baseline results, not execution receipts for future changes.

The pre-implementation replay in the approved spec proves that the existing fuzzy stage picks id 45 once id 37334 is absent. Therefore do not add a new grade-selection stage or change exact-to-fuzzy behavior for unrelated hard numbers.

`prepareBeer` already spreads the incoming row, and `CatalogBeerWithRating` extends `CatalogBeer`. Adding optional `style` to `CatalogBeer` and selecting SQL `b.style` propagates the field through the existing cache; no production edit to `catalog-cache.ts` or `match-list.ts` is needed.

`fast-fuzzy`'s installed `searchCore` (`node_modules/fast-fuzzy/lib/fuzzy.js`) returns every above-threshold result, sorted, without a top-N truncation. Filter this complete result list before reading `results[0]` or entering the top-score/tie loop. This implements selection over eligible candidates without building a per-input full-catalog index. Preserve the original brewery bucket when deciding whether a full-catalog attempt is needed; vetoing all known-brewery hits must not by itself spend the full-catalog budget or broaden the search to another brewery.

## File responsibilities

| File | Responsibility in this plan |
|---|---|
| `src/domain/digit-identity.ts` | Context type, the one shared grade veto, optional integration into `digitIdentity` |
| `src/domain/digit-identity.test.ts` | Contextual identity, boundary cases and preservation of old rules |
| `src/domain/matcher.ts` | Optional style types; one per-input eligibility closure used by both exact paths and fuzzy selection |
| `src/domain/matcher.test.ts` | Correct id selection, anchor bypass protection, lower-score eligible fuzzy candidate and unchanged budget |
| `src/storage/beers.ts` | Read `style` from the same catalog SELECT as id/name |
| `src/storage/beers.test.ts` | Existing catalog contract assertion includes style |
| `src/domain/catalog-cache.test.ts` | Real in-memory DB → cache → prepared matcher verifies delivery of style |

## Execution preflight

The worktree already exists on `fix/issue-665`; do not create another. Check `git branch --show-current` and
`git status --short` there before editing. The temporary dependency symlink used for the earlier baseline
was removed, so run `npm ci` in the worktree when execution begins. Then run `npm test && npm run typecheck`
to establish the execution baseline. If it fails, diagnose the baseline before attributing failures to U1.
These commands are instructions for execution, not work to run during plan authoring.

## Task 1 (U1): Contextual grade veto in shared digit identity

**Files:** Modify `src/domain/digit-identity.ts`; test `src/domain/digit-identity.test.ts`.

**Consumes:** Existing `NameDigits`, `readNameDigits`, `baseNormalize` from `./normalize`, and `isAleStyle` from `./czech-grade`.

**Produces:**

```ts
export interface DigitIdentityContext {
  input: { name: string; style?: string | null };
  candidate: { name: string; style?: string | null };
}

export function czechGradesContradict(
  input: NameDigits,
  candidate: NameDigits,
  context?: DigitIdentityContext,
): boolean;

export function digitIdentity(
  input: NameDigits,
  candidate: NameDigits,
  context?: DigitIdentityContext,
): DigitIdentity;
```

Raw names in context are the same texts used to read the digits; they supply the existing ale-name veto. An omitted context keeps every existing caller's behavior unchanged. Do not add fields to `NameDigits`, change `readNameDigits` or extend the peer function in this task; its caller integration is peripheral work.

- [ ] **Step 1: Add the failing regression in the existing digit-identity test file.**

Append the following tests; add `DigitIdentityContext` to the type import. Keep the existing `identity` helper and its measured tables unchanged.

```ts
describe('#665 Czech lager grade identity', () => {
  const judged = (
    input: string, candidate: string,
    inputStyle: string | null, candidateStyle: string | null,
  ): DigitIdentity => digitIdentity(readNameDigits(input), readNameDigits(candidate), {
    input: { name: input, style: inputStyle },
    candidate: { name: candidate, style: candidateStyle },
  });

  test('Konrad ten degrees is not the twelve-degree orphan', () => {
    expect(judged('KONRAD 10°', 'Konrad 12°', null, 'Svetlý Ležák')).toBe('different');
    expect(judged('Konrad 12°', 'KONRAD 10°', 'Svetlý Ležák', null)).toBe('different');
  });

  test.each<[string, string, string | null, string | null, DigitIdentity]>([
    ['CERNA HORA LEZAK 12°', 'Černa Hora 11°', null, 'Svetlý Ležák', 'different'],
    ['Beer 12°', 'Beer 11°', null, 'Pilsner - Czech / Bohemian', 'different'],
    ['Beer 10°', 'Beer 12°', 'Lager - Světlé (Czech Pale)', null, 'different'],
    ['Beer 10°', 'Beer 12°', null, 'Bohemian Pils', 'different'],
    ['Beer 10°', 'Beer 12°', null, 'Tmavy Lezak', 'different'],
    ['Beer 10°', 'Beer 12°', null, 'Světlý Ležák / Jasny Lager', 'different'],
    ['Beer 7°', 'Beer 20°', null, 'Czech Lager', 'different'],
    ['Beer 6°', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 12°', 'Beer 21°', null, 'Czech Lager', 'same'],
    ['Beer 12°', 'Beer 12,0°', null, 'Czech Lager', 'same'],
    ['Beer 12.0°', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 10*', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer 10°·4%', 'Beer 12°·5%', null, 'Czech Lager', 'different'],
    ['Beer 14,5°', 'Beer 14°', null, 'Czech Lager', 'same'],
    ['Beer 10° 10.0°', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer 10° 11°', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 11° 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 12°', null, null, 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Lager', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Pilsner', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Czech', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Ležák', 'same'],
    ['Beer 10°', 'Beer 12°', 'IPA', 'Czech Lager', 'same'],
    ['Beer IPA 10°', 'Beer IPA 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer Stout 12°', null, 'Czech Lager', 'same'],
    ['Beer 10°', 'Beer 12°', null, 'Czech IPA', 'same'],
    ['Beer 10°', 'Beer', null, 'Czech Lager', 'same'],
    ['Beer 10%', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 10 abv', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 0,5l', 'Beer 12°', null, 'Czech Lager', 'same'],
    ['Beer 2026', 'Beer 12°', null, 'Czech Lager', 'year-fallback'],
    ['Beer #10', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer 10', 'Beer 12°', null, 'Czech Lager', 'different'],
    ['Beer #3 10°', 'Beer #4 10°', null, 'Czech Lager', 'different'],
    ['Beer 10° 2024', 'Beer 10° 2025', null, 'Czech Lager', 'different'],
    ['', '', null, 'Czech Lager', 'same'],
  ])('%s / %s with styles %s / %s → %s', (a, b, sa, sb, expected) => {
    expect(judged(a, b, sa, sb)).toBe(expected);
  });

});
```

Import only the existing runtime exports in this red step; the new context type is erased by transpilation. The decisive regression must fail with received `same`, expected `different`. Do not import a missing runtime helper until Step 3 exports it.

- [ ] **Step 2: Capture red for the named reproduction.**

Run `npm test -- src/domain/digit-identity.test.ts -t 'Konrad ten degrees'`.
Vitest transpiles the new optional argument before typechecking; the intended failure is the old `same` result. If setup fails, correct setup and rerun before writing the predicate.

- [ ] **Step 3: Implement the shared predicate and optional comparator context.**

Import `baseNormalize` and `isAleStyle`; add the context interface above. Add these private helpers and exported predicate to `digit-identity.ts`:

```ts
function hasCzechLagerStyle(style: string | null | undefined): boolean {
  const words = new Set(baseNormalize(style ?? '').split(' ').filter(Boolean));
  const czech = words.has('czech') || words.has('bohemian');
  const lager = words.has('lager') || words.has('pils') || words.has('pilsner');
  const colour = ['svetly', 'svetle', 'tmavy', 'polotmave'].some((word) => words.has(word));
  return (czech && lager) || (words.has('lezak') && colour);
}

function singleIntegerGrade(grades: readonly string[]): number | null {
  const values = [...new Set(grades.map(Number))];
  if (values.length !== 1) return null;
  const value = values[0];
  return Number.isInteger(value) && value >= 7 && value <= 20 ? value : null;
}

export function czechGradesContradict(
  input: NameDigits,
  candidate: NameDigits,
  context?: DigitIdentityContext,
): boolean {
  if (!context) return false;
  const a = singleIntegerGrade(input.grades);
  const b = singleIntegerGrade(candidate.grades);
  if (a === null || b === null || a === b) return false;
  if (!hasCzechLagerStyle(context.input.style) && !hasCzechLagerStyle(context.candidate.style)) return false;
  if (isAleStyle(context.input.name, context.input.style ?? null)
    || isAleStyle(context.candidate.name, context.candidate.style ?? null)) return false;
  return true;
}
```

Extend `digitIdentity`'s signature with `context?: DigitIdentityContext`, and insert this as its first guard:

```ts
if (czechGradesContradict(input, candidate, context)) return 'different';
```

Keep every existing guard below it intact. Amend the grade comment to describe the optional Czech context while retaining the default extract semantics. Do not call `extractGrade`: its bare-integer/first-hit behavior is a different contract.

- [ ] **Step 4: Verify both directions explicitly and direct helper behavior.**

Add `czechGradesContradict` to the import and the following tests to the same describe block (the named test already checks both directions of the real reproduction). These pin input-only context, candidate-only context and a false-helper/old-rule distinction without deriving expectations from another function:

```ts
test('the contextual grade veto is symmetric with only one known style', () => {
  const a = readNameDigits('Beer 7°');
  const b = readNameDigits('Beer 20°');
  const context: DigitIdentityContext = {
    input: { name: 'Beer 7°', style: 'Czech Lager' },
    candidate: { name: 'Beer 20°' },
  };
  expect(czechGradesContradict(a, b, context)).toBe(true);
  expect(czechGradesContradict(b, a, {
    input: context.candidate, candidate: context.input,
  })).toBe(true);
});

test('absence of context preserves old identity and does not hide hard-number conflicts', () => {
  expect(digitIdentity(readNameDigits('Beer 10°'), readNameDigits('Beer 12°'))).toBe('same');
  expect(czechGradesContradict(readNameDigits('Beer #3'), readNameDigits('Beer #4'))).toBe(false);
  expect(digitIdentity(readNameDigits('Beer #3'), readNameDigits('Beer #4'))).toBe('different');
});

test.each<[string, string, string, DigitIdentity]>([
  ['Białe IPA 16°', 'Białe IPA 14°', 'IPA', 'same'],
  ['Flying Machine 19°', 'Flying Machine 20°', 'IPA - Imperial / Double New England / Hazy', 'same'],
  ['Kwas My Lemoncello 16,5°', '16° Kwas My Lemoncello Sour Ale', 'Sour', 'same'],
  ['Mini Młot 8°', 'Mini Młot 9°', 'IPA', 'same'],
  ["There's no Wi-Fi in my garden 14,5°", "There's no wi-fi in my garden 14°", 'IPA', 'same'],
  ['Sztanga 2026 12°', 'Sztanga 11°', 'Kölsch', 'year-fallback'],
  ['Lizard King 11°', 'Lizard King 9°', 'Sour - Fruited Gose', 'same'],
])('non-Czech grades remain soft: %s / %s', (a, b, style, expected) => {
  const context: DigitIdentityContext = {
    input: { name: a }, candidate: { name: b, style },
  };
  expect(czechGradesContradict(readNameDigits(a), readNameDigits(b), context)).toBe(false);
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), context)).toBe(expected);
});
```

Run `npm test -- src/domain/digit-identity.test.ts`. All old measured tables and new cases must pass. The helper is not a replacement for all numeric identity: tests of hard numbers and years must remain intact.

- [ ] **Step 5: Run the full gate, review and commit U1.**

Run `npm test && npm run typecheck`. Review the two-file diff for parser changes and accidental default-rule changes. Stage only `src/domain/digit-identity.ts` and `src/domain/digit-identity.test.ts`; commit subject: `fix(identity): reject conflicting Czech lager grades with explicit style context (#665)`.

## Task 2 (U2): Deliver catalog style and exclude conflicts before matcher selection

**Files:** Modify `src/domain/matcher.ts`, `src/storage/beers.ts`; test `src/domain/matcher.test.ts`, `src/storage/beers.test.ts`, `src/domain/catalog-cache.test.ts`.

**Consumes:** U1's `DigitIdentityContext`, `czechGradesContradict`, `digitIdentity(input, candidate, context?)`; existing real DB/cache helpers and `prepareCatalog` searcher injection seam.

**Produces:** `CatalogBeer.style?: string | null`; `CatalogRow.style: string | null`; optional style on both public matcher input signatures. SQL-loaded styles reach `PreparedBeer` and `CatalogBeerWithRating` by their existing inheritance/spread. Public API JSON stays unchanged.

- [ ] **Step 1: Add matcher regression tests before implementation.**

Use the existing `c` helper (it will accept style after the optional field is added). Append:

```ts
describe('#665 Czech grade conflicts cannot preempt an eligible row', () => {
  const ten = c({ id: 45, brewery: 'Pivovar Konrad Brewery',
    name: 'Konrad Svetlé Výčepní 10', style: 'Lager - Světlé (Czech Pale)', abv: 4 });
  const twelve = c({ id: 37334, brewery: 'KONRAD Brewery',
    name: 'Konrad 12°', style: 'Svetlý Ležák', abv: 5.2 });

  test.each([[ten, twelve], [twelve, ten]])('the ten-degree input selects id 45 for order %#', (a, b) => {
    expect(matchBeer({ brewery: 'KONRAD Brewery', name: 'KONRAD 10°' }, [a, b]))
      .toEqual({ id: 45, confidence: 1, source: 'fuzzy' });
  });

  test('the only known-brewery row has the wrong grade: miss without a full-catalog attempt', () => {
    const prepared = prepareCatalog([twelve]);
    const budget = createFallbackBudget(1);
    expect(matchPrepared({ brewery: 'KONRAD Brewery', name: 'KONRAD 10°' }, prepared, budget)).toBeNull();
    expect(budget).toEqual({ remaining: 1, attempts: 0, hits: 0, budgetSkipped: 0 });
  });

  test('matching twelve-degree input retains the existing exact selection', () => {
    expect(matchBeer({ brewery: 'KONRAD Brewery', name: 'KONRAD 12°' }, [ten, twelve]))
      .toEqual({ id: 37334, confidence: 1, source: 'exact' });
  });

  test('the split-invariant anchor cannot restore the rejected twelve-degree row', () => {
    const row = c({ id: 37334, brewery: 'Konrad Liberec', name: 'Konrad 12°',
      style: 'Czech Lager' });
    const prepared = prepareCatalog([row]);
    expect(prepared.breweryCandidates(breweryAliases(''))).toEqual([]);
    expect(prepared.candidatesByFirstToken('konrad').map((beer) => beer.id)).toEqual([37334]);
    expect(matchPrepared({ brewery: '', name: 'Konrad Liberec Konrad 10°' }, prepared)).toBeNull();
  });

  test('full search removes a higher-scoring conflicting grade before picking a lower score', () => {
    const bad = prepareBeer(c({ id: 12, brewery: 'Czech Brew', name: 'Alpha 12°', style: 'Czech Lager' }));
    const good = prepareBeer(c({ id: 10, brewery: 'Czech Brew', name: 'Alpha 10°', style: 'Czech Lager' }));
    const build = vi.fn(() => ({ search: () => [
      { item: bad, score: 0.95 }, { item: good, score: 0.9 },
    ] }) as never);
    const prepared = prepareCatalog([bad, good], build);
    const budget = createFallbackBudget(2);
    const input = { brewery: 'Unknown', name: 'Alpha 10°' };
    expect(matchPrepared(input, prepared, budget)).toEqual({ id: 10, confidence: 0.9, source: 'fuzzy' });
    expect(matchPrepared(input, prepared, budget)).toEqual({ id: 10, confidence: 0.9, source: 'fuzzy' });
    expect(build.mock.calls.length).toBe(1);
    expect(budget).toEqual({ remaining: 0, attempts: 2, hits: 2, budgetSkipped: 0 });
  });

  test('input-only Czech style supplies context when a catalog row has no style', () => {
    expect(matchBeer({ brewery: 'KONRAD Brewery', name: 'KONRAD 10°', style: 'Czech Lager' }, [
      c({ id: 37334, brewery: 'KONRAD Brewery', name: 'Konrad 12°', style: null }),
    ])).toBeNull();
  });

  test('existing style-only and hard-number guards remain in effect', () => {
    expect(matchBeer({ brewery: 'KONRAD Brewery', name: 'LAGER 10°' }, [ten])).toBeNull();
    expect(matchBeer({ brewery: 'KONRAD Brewery', name: 'Konrad #4' }, [
      c({ id: 3, brewery: 'KONRAD Brewery', name: 'Konrad #3' }),
    ])).toBeNull();
  });
});
```

The injected full-search scores test ordering and memoization; it is not evidence for a new cross-brewery production match. The real Konrad tests use the real fast-fuzzy searcher.

- [ ] **Step 2: Capture the right red failure.**

Run `npm test -- src/domain/matcher.test.ts -t 'the ten-degree input selects id 45'`.
Expected: received id 37334/exact rather than id 45/fuzzy. Do not accept a test setup/type import failure as the receipt.

- [ ] **Step 3: Add the cache delivery regression and amend the existing SQL contract test.**

In `src/storage/beers.test.ts`'s existing `describe('loadCatalog')`, rename the test to include style and replace its assertion with:

```ts
expect(cat).toEqual([{
  id, brewery: 'Trzech Kumpli', name: 'Pan IPAni', style: 'IPA',
  abv: 6.0, rating_global: 3.85, untappd_id: 9001,
}]);
db.close();
```

Its fresh DB contains exactly that one beer; this assertion owns the shape of that row, not a global catalog size.

Add `matchPrepared` to the imports in `src/domain/catalog-cache.test.ts` and append:

```ts
describe('#665 catalog style reaches the matcher from SQL', () => {
  it('a cached twelve-degree orphan does not capture a ten-degree tap', async () => {
    const db = openDb(':memory:');
    migrate(db);
    try {
      const tenId = seedBeer(db, {
        untappd_id: 227734, brewery: 'Pivovar Konrad Brewery', name: 'Konrad Svetlé Výčepní 10',
        style: 'Lager - Světlé (Czech Pale)', abv: 4,
        normalized_brewery: 'konrad', normalized_name: normalizeName('Konrad Svetlé Výčepní 10'),
      });
      const twelveId = seedBeer(db, {
        brewery: 'KONRAD Brewery', name: 'Konrad 12°', style: 'Svetlý Ležák', abv: 5.2,
        normalized_brewery: 'konrad', normalized_name: normalizeName('Konrad 12°'),
      });
      const { prepared, byId } = await createCatalogCache(db).get();
      expect(byId.get(twelveId)?.style).toBe('Svetlý Ležák');
      expect(prepared.beers.find((beer) => beer.id === twelveId)?.style).toBe('Svetlý Ležák');
      expect(matchPrepared({ brewery: 'KONRAD Brewery', name: 'KONRAD 10°' }, prepared))
        .toEqual({ id: tenId, confidence: 1, source: 'fuzzy' });
    } finally {
      db.close();
    }
  });
});
```

Run `npm test -- src/storage/beers.test.ts src/domain/catalog-cache.test.ts -t 'loadCatalog|catalog style'`.
Expected: current SELECT omits `style`; the new exact style assertion fails. This test reads the real default SQL loader and real cache, not an injected style-bearing array. The two seed names have different normalized names, so `seedBeer` does not collapse them into one row.

- [ ] **Step 4: Deliver style and wire the one shared eligibility predicate into all matcher paths.**

In `src/storage/beers.ts`, add `style: string | null` to `CatalogRow` and change only the catalog projection:

```ts
SELECT b.id, b.brewery, b.name, b.style, b.abv, b.rating_global, b.untappd_id
```

In `src/domain/matcher.ts`, import `czechGradesContradict` and type `DigitIdentityContext`. Add `style?: string | null` to `CatalogBeer` and the input object types of **both** `matchPrepared` and `matchBeer`.

At the start of `matchPrepared`, before constructing exact candidates, add:

```ts
const inputDigits = readNameDigits(input.name);
const contextFor = (candidate: PreparedBeer): DigitIdentityContext => ({
  input: { name: input.name, style: input.style },
  candidate: { name: candidate.name, style: candidate.style },
});
const gradeAllows = (candidate: PreparedBeer) => inputDigits.grades.length === 0
  || !czechGradesContradict(inputDigits, readNameDigits(candidate.name), contextFor(candidate));
```

The short-circuit avoids rereading every candidate's digits for the common input with no explicit grade.

Keep `breweryMatches = prepared.breweryCandidates(inputAliases)` unchanged. Filter both exact-entry points using the same closure:

```ts
// The normal exact candidates:
let exacts = breweryMatches.filter(gradeAllows)
  .filter((c) => {
    if (nn !== '') {
      return c.nameNorm === nn || intersects(c.keys, inputKeys);
    }
    const candStyle = styleNameIdentity(c.name, c.breweryNorm);
    if (candStyle === '' || candStyle !== inputStyleIdentity) return false;
    if (wantAbv !== null && c.abv !== null && Math.abs(c.abv - wantAbv) > ABV_TOLERANCE) {
      return false;
    }
    return true;
  })
  .sort((a, b) => b.id - a.id);

// The split-invariant anchor candidates:
const anchored = prepared.candidatesByFirstToken(firstToken)
  .filter(gradeAllows)
  .filter((cand) =>
    cand.aliases.some((alias) => {
      if (!leadingRun(combined, alias)) return false;
      const remainder = stripBreweryFromName(combined, alias);
      const canonName = stripBreweryFromName(cand.nameNorm, cand.breweryNorm);
      return remainder !== '' && sortedTokens(remainder) === sortedTokens(canonName);
    }),
  );
```

The existing filter bodies above stay intact, including their explanatory comments in the source; the only added filtering step is `.filter(gradeAllows)`.

Remove the two inner `const inputDigits = readNameDigits(input.name)` declarations in the exact and fuzzy branches: both now share the outer declaration. Extend the exact and fuzzy comparator calls respectively:

```ts
const identity = digitIdentity(inputDigits, readNameDigits(c.name), contextFor(c));
const identity = digitIdentity(inputDigits, readNameDigits(r.item.name), contextFor(r.item));
```

Keep the current fuzzy searcher setup and budget logic unchanged. Replace only the assignment of its complete result list:

```ts
const results = searcher.search(`${seedBrewery} ${nn}`)
  .filter((result) => gradeAllows(result.item));
```

The empty-list guard and the existing numeric-tier top-score loop now see eligible results. Filtering preserves the surviving scores/order and permits a lower-scoring row once the higher one is vetoed. The shared full searcher remains memoized, and a nonempty original brewery bucket still uses the brewery searcher even when every resulting hit is vetoed.

- [ ] **Step 5: Verify focused regressions and mutation sensitivity.**

Run `npm test -- src/domain/digit-identity.test.ts src/domain/matcher.test.ts src/storage/beers.test.ts src/domain/catalog-cache.test.ts`.

When temporarily omitting a filter, only remove that insertion; preserve contextual comparator calls so the
test measures early exclusion rather than removal of the entire rule. Restore by reversing that exact edit,
not by reverting the whole implementation file or discarding unrelated work.

Perform these one-at-a-time temporary mutations, rerun the named tests, restore each change before the next, and record the expected failures:

| Temporary omission | Command | Required failure |
|---|---|---|
| Normal exact `.filter(gradeAllows)` | `npm test -- src/domain/matcher.test.ts -t 'the ten-degree input selects id 45'` | Late identity veto returns `null` instead of 45/fuzzy |
| Anchor `.filter(gradeAllows)` | `npm test -- src/domain/matcher.test.ts -t 'vetoed anchor proceeds'` | The route assertion below fails when the rejected row enters the exact digit stage |
| Fuzzy result `.filter(...)` | `npm test -- src/domain/matcher.test.ts -t 'full search removes'` | Top-score numeric guard leaves no eligible hit at that score; result becomes `null` |
| SQL `b.style` projection | `npm test -- src/domain/catalog-cache.test.ts -t 'catalog style reaches'` | Exact style or correct-id assertion fails |

For the anchor mutation, a final `null` alone is insufficient: a late comparator guard can hide a missing early filter. Strengthen the anchor test with the existing `prepareCatalog(..., build)` seam so the route is visible. Add this test alongside the anchor test from Step 1:

```ts
test('a vetoed anchor proceeds to the existing full fuzzy path', () => {
  const bad = c({ id: 12, brewery: 'Konrad Liberec', name: 'Konrad 12°', style: 'Czech Lager' });
  const good = prepareBeer(c({ id: 10, brewery: 'Other Czech Brewery', name: 'Konrad 10°', style: 'Czech Lager' }));
  const build = vi.fn(() => ({ search: () => [{ item: good, score: 0.9 }] }) as never);
  const prepared = prepareCatalog([bad, good], build);
  const budget = createFallbackBudget(1);
  expect(matchPrepared({ brewery: '', name: 'Konrad Liberec Konrad 10°' }, prepared, budget))
    .toEqual({ id: 10, confidence: 0.9, source: 'fuzzy' });
  expect(build.mock.calls.length).toBe(1);
  expect(budget).toEqual({ remaining: 0, attempts: 1, hits: 1, budgetSkipped: 0 });
});
```

The injected search result tests the route, not a factual cross-brewery beer link: both candidates belong to the actual prepared catalog, and the different brewery keeps the eligible result out of the anchor bucket. The real anchor test covers the final miss, and the real Konrad test covers correct selection. Under the anchor omission mutation, the existing early exact refusal prevents the full search, so this test fails. Add it before mutation verification, verify green, and include it in the same matcher test file.

- [ ] **Step 6: Run the full gate, review and commit U2.**

Restore all mutations. Run `npm test && npm run typecheck` and `git diff --check`. Review the SQL projection, input type parity, unchanged default-budget behavior, both exact-entry filters and full-search memoization. Do not amend unrelated old assertions.

Stage only the five files listed for U2; commit subject: `fix(matcher): exclude conflicting Czech grades before exact and fuzzy selection (#665)`.

## Whole-core review checkpoint

- [ ] Review the entire diff from 4964f00, including U1 implemented inline and U2. Apply the code-review workflow sequentially in the main thread as AGENTS.md requires. Include correctness, API type compatibility, data-integrity and performance lenses; this is a rule shared by data writes even though those callers are not wired yet.
- [ ] The review package must include the approved spec, this plan, named red/green receipts, mutation outcomes, full-gate results and the original Konrad reproduction. Specifically challenge whether a style-less caller still behaves as before and whether the searcher returns all above-threshold candidates.
- [ ] Fix valid core findings, repeat the affected tests and full gate after changes, and record the review receipt. Do not call #665 fixed, push a release or close the issue at this checkpoint.
- [ ] Only after this review, write the separate peripheral implementation plan against the actual core signatures. It must cover all identity-recording rows in the spec's evidence table, the verified Konrad alias, `spec.md`, one-snapshot old/new catalog replay and row-by-row recovery before merging 37334. No task code for that work is prewritten here.

## Coverage check and handoff

| Approved requirement | Coverage |
|---|---|
| Positive style, explicit integer grades 7–20, equal/decimal/ambiguous grade cases, ale veto | U1 predicate and explicit tables |
| Optional context preserves old digits/years/soft-number rules | U1 unchanged measured tables and context-free controls |
| Non-Czech real grade differences remain allowed | U1 real-name helper table; existing matcher regressions |
| Correct Konrad ten-degree row wins over newer orphan, independent of order | U2 real-search permutation test |
| Normal exact, anchored exact and full fuzzy share the same veto | U2 tests and individual omission mutations |
| SQL/cache style is from the same row; no new enrichment fetch | U2 real DB/cache test and SQL contract assertion |
| Full-search index and budget remain intact | U2 memoization/budget tests; original brewery-bucket setup retained |
| Alias, all persistent writes, web/search callers, canonical twelve-degree recovery | Separate plan after core review, explicitly outside this core's completion claim |

Self-review before execution: all task interfaces above are defined by U1; U2 adds optional `style` before full typecheck; the cache uses real DB loading; no production file has yet been modified by planning. Run test commands only during execution, not to validate this document.

Execution is sequential in the existing worktree using `superpowers:executing-plans`. First task starts with its named red regression; the whole-core review is the boundary before peripheral planning.
