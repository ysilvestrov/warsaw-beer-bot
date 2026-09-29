# #659 Moved-Letter Rescue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lookupBeer` accepts a same-brewery candidate whose name differs from the input by one relocated letter in one token (`UTH`↔`UHT`, `Slik`↔`Silk.`, `Tounge`↔`Tongue`), with agreeing ABV and a unique bid — and only where lookup would otherwise end without a match.

**Architecture:** A pure predicate module (`moved-letter.ts`) decides token/name equivalence. `lookupBeer` gets a closure `movedLetterRescue(pool)` applied at its two refusal points: a `not_found` returned by `matchAgainst`, and the final `return notFound()` after every search attempt yielded nothing. The rescue reads only the digit-filtered **strict** brewery pool that `matchAgainst` computed, so every existing gate still applies.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-29-659-moved-letter-rescue-design.md`

## Global Constraints

- The rescue never changes a match any existing stage accepts; it only converts a refusal.
- Unchanged: `normalizeName`, `nameKeys`, `nameIdentity`, `NAME_FUZZY_THRESHOLD`, `NEAR_TOKEN_SIM`, `pickScoredCandidate`, `dominantCandidate`, `ABV_TOLERANCE` (0.3), the strict brewery gate, `BREWERY_NOISE`, curated aliases, the #636 digit filter, catalogue `matchBeer`.
- ABV must be known on both sides with `|Δ| ≤ ABV_TOLERANCE`; exactly one distinct bid must qualify.
- Neither identity may be `restored` (#505); `exactOnly` targets are skipped.
- Differing tokens: equal length ≥ 3, no digits, not a valid Roman numeral.
- Tests: no conditional logic (`if (out.kind !== 'matched') return;` is forbidden — assert with `toMatchObject`), no weak asserts, every test mutation-proven.
- Full gate after every task: `npm test && npm run typecheck`.
- No schema, API or extension change; no changelog/install-guide entry.

---

### Task 1: `moved-letter` predicate

**Files:**
- Create: `src/domain/moved-letter.ts`
- Test: `src/domain/moved-letter.test.ts`

**Interfaces:**
- Produces: `isMovedLetter(a: string, b: string): boolean` — true iff `b` is `a` with exactly one letter relocated. `isMovedLetterName(target: string, candidate: string): boolean` — both are space-separated normalized identity values; true iff same token count, exactly one position differs, and that pair satisfies `isMovedLetter`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/moved-letter.test.ts
import { isMovedLetter, isMovedLetterName } from './moved-letter';

describe('#659 isMovedLetter', () => {
  test.each([
    ['uth', 'uht'],        // adjacent swap, 37582
    ['slik', 'silk'],      // adjacent swap, 37911
    ['tounge', 'tongue'],  // one letter moved two places, 38383
    ['mild', 'mlid'],      // letters that look Roman but do not form a numeral
  ])('%s ↔ %s is one moved letter', (a, b) => {
    expect(isMovedLetter(a, b)).toBe(true);
    expect(isMovedLetter(b, a)).toBe(true);
  });

  test.each([
    ['slik', 'slice', 'different length (the Slice. trap)'],
    ['kizzy', 'lizzy', 'one substitution'],
    ['snake', 'snakes', 'one insertion'],
    ['palma', 'lampa', 'anagram needing two moves'],
    ['riot', 'riot', 'identical'],
    ['ab', 'ba', 'shorter than 3'],
    ['v14', 'v41', 'contains digits'],
    ['xxiv', 'xxvi', 'Roman numeral (Firestone/Moksa anniversaries)'],
    ['mix', 'mxi', 'one side is a valid Roman numeral'],
  ])('%s ↔ %s is rejected: %s', (a, b) => {
    expect(isMovedLetter(a, b)).toBe(false);
  });
});

describe('#659 isMovedLetterName', () => {
  test('one differing token, rest identical', () => {
    expect(isMovedLetterName('tounge tingle', 'tongue tingle')).toBe(true);
  });

  test('two differing tokens are rejected', () => {
    expect(isMovedLetterName('tounge tnigle', 'tongue tingle')).toBe(false);
  });

  test('token count mismatch is rejected', () => {
    expect(isMovedLetterName('slik', 'silk wheat')).toBe(false);
  });

  test('tokens compare by position, not as a set', () => {
    expect(isMovedLetterName('tingle tounge', 'tongue tingle')).toBe(false);
  });

  test('identical names are rejected (nothing to rescue)', () => {
    expect(isMovedLetterName('silk', 'silk')).toBe(false);
  });

  test('empty target is rejected', () => {
    expect(isMovedLetterName('', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/moved-letter.test.ts`
Expected: FAIL — cannot resolve `./moved-letter`.

- [ ] **Step 3: Implement**

```ts
// src/domain/moved-letter.ts
/**
 * #659 — a shop typo that relocates ONE letter inside one token (`UTH`↔`UHT`, `Tounge`↔`Tongue`).
 *
 * `fast-fuzzy` cannot carry these: its score is length-normalized (one swap in a 3-letter token is
 * 0.667, under NEAR_TOKEN_SIM) and substring-based (`slik` scores the same 0.75 against `Silk.` and
 * `Slice.`). Measured on 34 342 catalogue beers: pairs of DIFFERENT same-brewery beers one relocated
 * letter apart — 3, none with agreeing ABV; one arbitrary edit — 304, 163 with agreeing ABV. That
 * is why this is a relocation, never an edit distance.
 */
const MIN_TOKEN_LENGTH = 3;
const DIGIT = /\d/;
// A valid numeral, not "letters from ivxlcdm": that would also exclude `mild`, `lid`, `dim`.
const ROMAN_NUMERAL = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

function isNumbering(token: string): boolean {
  return DIGIT.test(token) || ROMAN_NUMERAL.test(token);
}

export function isMovedLetter(a: string, b: string): boolean {
  if (a === b || a.length !== b.length || a.length < MIN_TOKEN_LENGTH) return false;
  if (isNumbering(a) || isNumbering(b)) return false;
  for (let from = 0; from < a.length; from += 1) {
    const rest = a.slice(0, from) + a.slice(from + 1);
    for (let to = 0; to <= rest.length; to += 1) {
      if (rest.slice(0, to) + a[from] + rest.slice(to) === b) return true;
    }
  }
  return false;
}

export function isMovedLetterName(target: string, candidate: string): boolean {
  const targetTokens = target.split(' ').filter(Boolean);
  const candidateTokens = candidate.split(' ').filter(Boolean);
  if (targetTokens.length === 0 || targetTokens.length !== candidateTokens.length) return false;
  const differing = targetTokens.flatMap((token, index) => (token === candidateTokens[index] ? [] : [index]));
  return differing.length === 1 && isMovedLetter(targetTokens[differing[0]], candidateTokens[differing[0]]);
}
```

Note: the empty string is itself a match of `ROMAN_NUMERAL`, but `isMovedLetter` rejects length < 3 before reaching it.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/moved-letter.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-prove**

Each mutation below must make at least one named test fail; revert after each:
- delete the `isNumbering` line → `xxiv ↔ xxvi`, `v14 ↔ v41`, `mix ↔ mxi` fail;
- replace `ROMAN_NUMERAL` with `/^[ivxlcdm]+$/` → `mild ↔ mlid` fails;
- change `differing.length === 1` to `>= 1` → "two differing tokens" fails;
- delete `a.length < MIN_TOKEN_LENGTH` → `ab ↔ ba` fails.

- [ ] **Step 6: Full gate and commit**

Run: `npm test && npm run typecheck` — expected: all green.

```bash
git add src/domain/moved-letter.ts src/domain/moved-letter.test.ts
git commit -m "feat(domain): isMovedLetter — one relocated letter, numbering excluded (#659)"
```

---

### Task 2: moved-letter rescue in `lookupBeer` + `spec.md`

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (imports; `lookupBeer` body — the `notFound` helper near line 552, top of `matchAgainst` near line 563, `strictPool` near line 655, the main search loop near line 976, the #664 series loop near line 1000, the final `return notFound()` at the end)
- Create: `src/domain/untappd-lookup.moved-letter.test.ts`
- Modify: `spec.md` (one paragraph, after the #613 collab-token boundary rescue paragraph that ends «…не змінює `normalizeName`, `nameKeys`, fuzzy-пороги чи popularity-resolver.»)

**Interfaces:**
- Consumes: `isMovedLetterName(target, candidate)` from Task 1.
- Produces: no new exports; behaviour of `lookupBeer` only.

The code beats this brief: if a line number or a quoted snippet does not match the file, locate the construct by its content and report the discrepancy.

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/untappd-lookup.moved-letter.test.ts
import { lookupBeer } from './untappd-lookup';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

function fakeSearch(results: SearchResult[]): BeerSearch {
  return { search: async () => results };
}
const r = (bid: number, brewery_name: string, beer_name: string, abv: number | null, rating_count = 100): SearchResult =>
  ({ bid, brewery_name, beer_name, abv, style: null, global_rating: 3.5, rating_count });

const ARTEZAN = [
  r(6843957, 'Browar Artezan', 'UHT', 6.5, 52),
  r(5474194, 'Browar Artezan', 'And the Planets Are Going Crazy', 6.3, 283),
  r(5462826, 'Browar Artezan', 'Lost in the Woods', 5.5, 186),
];
const MOON_LARK = [
  r(5322744, 'Moon Lark Brewery', 'Silk.', 5, 1715),
  r(6307352, 'Moon Lark Brewery', 'Slice.', 6, 822),
];

describe('#659 moved-letter rescue', () => {
  // Live rows 2026-09-29, candidates as the replay returned them.
  test('37582 UTH → UHT (no approximate stage sees it: the null refusal point)', async () => {
    const out = await lookupBeer({ brewery: 'Artezan Brewery', name: 'UTH 15°', abv: 6.5, search: fakeSearch(ARTEZAN) });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 6843957 } });
  });

  test('37911 Slik → Silk. beside Slice. (near-name tie: the not_found refusal point)', async () => {
    const out = await lookupBeer({ brewery: 'MOON LARK Brewery', name: 'Moon Lark Slik 12.0°', abv: 5, search: fakeSearch(MOON_LARK) });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 5322744 } });
  });

  test('38383 Tounge Tingle → Tongue Tingle (letter moved two places)', async () => {
    const out = await lookupBeer({
      brewery: 'Monsters Brewery', name: 'Tounge Tingle', abv: 6,
      search: fakeSearch([r(6849257, 'Browar Monsters', 'Tongue Tingle', 6, 101)]),
    });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 6849257 } });
  });

  test('ABV outside tolerance → not_found', async () => {
    const out = await lookupBeer({ brewery: 'Artezan Brewery', name: 'UTH 15°', abv: 7.0, search: fakeSearch(ARTEZAN) });
    expect(out.kind).toBe('not_found');
  });

  test('input ABV unknown → not_found', async () => {
    const out = await lookupBeer({ brewery: 'Artezan Brewery', name: 'UTH 15°', search: fakeSearch(ARTEZAN) });
    expect(out.kind).toBe('not_found');
  });

  test('candidate ABV unknown → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'Artezan Brewery', name: 'UTH 15°', abv: 6.5,
      search: fakeSearch([r(6843957, 'Browar Artezan', 'UHT', null, 52)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('two qualifying bids (Silk and Lisk, both 5%) → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'MOON LARK Brewery', name: 'Moon Lark Slik 12.0°', abv: 5,
      search: fakeSearch([r(5322744, 'Moon Lark Brewery', 'Silk.', 5, 1715), r(1, 'Moon Lark Brewery', 'Lisk', 5, 1715)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('restored candidate identity (bare style word Pils) → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'Browar Testowy', name: 'Pisl', abv: 5,
      search: fakeSearch([r(2, 'Browar Testowy', 'Pils', 5)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('relaxed brewery pool (empty input brewery) never rescues', async () => {
    const out = await lookupBeer({ brewery: '', name: 'UTH', abv: 6.5, search: fakeSearch(ARTEZAN) });
    expect(out.kind).toBe('not_found');
  });

  test('a match an existing stage accepts is unchanged by a moved-letter neighbour', async () => {
    const out = await lookupBeer({
      brewery: 'Monsters Brewery', name: 'Tounge Tingle', abv: 6,
      search: fakeSearch([
        r(3, 'Browar Monsters', 'Tounge Tingle Reserve', 6, 50),
        r(6849257, 'Browar Monsters', 'Tongue Tingle', 6, 101),
      ]),
    });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 3 } });
  });
});
```

- [ ] **Step 2: Run to verify the right tests fail**

Run: `npx vitest run src/domain/untappd-lookup.moved-letter.test.ts`
Expected: the three live-row tests FAIL (`not_found`); the seven guard tests PASS already. If any guard test FAILS here, or the last test does not return bid 3, STOP and report: the fixture does not exercise the path the plan assumes.

- [ ] **Step 3: Implement the rescue**

3a. Import:

```ts
import { isMovedLetterName } from './moved-letter';
```

3b. Directly after the `notFound` helper (`const notFound = (): LookupOutcome => ({ ... });`), add:

```ts
  // #659: the digit-filtered STRICT pool of the latest matchAgainst call, and every such pool this lookup
  // refused. The moved-letter rescue reads only these, so the brewery gate and #636 still apply.
  let lastStrictPool: SearchResult[] = [];
  const refusedStrictPools: SearchResult[] = [];
  const movedLetterRescue = (pool: SearchResult[]): SearchResult | null => {
    if (abv == null) return null;
    const targets = targetNames.filter((target) => !target.exactOnly && !target.restored);
    const hits = new Map<number, SearchResult>();
    for (const result of pool) {
      if (result.abv == null || Math.abs(result.abv - abv) > ABV_TOLERANCE) continue;
      const cand = candIdent(result);
      if (cand.restored) continue;
      if (targets.some((target) => isMovedLetterName(target.value, cand.value))) hits.set(result.bid, result);
    }
    return hits.size === 1 ? [...hits.values()][0] : null;
  };
  // Refinement of a refusal only: a matched outcome passes through untouched.
  const judge = (results: SearchResult[]): LookupOutcome | null => {
    const outcome = matchAgainst(results);
    if (outcome?.kind === 'matched') return outcome;
    refusedStrictPools.push(...lastStrictPool);
    if (outcome?.kind !== 'not_found') return outcome;
    const rescued = movedLetterRescue(lastStrictPool);
    return rescued ? { kind: 'matched', result: rescued } : outcome;
  };
```

`matchAgainst` is a function declaration, so calling it from `judge` before its textual position is fine.

3c. First statement inside `function matchAgainst(unfiltered: SearchResult[]): LookupOutcome | null {`:

```ts
    lastStrictPool = [];
```

3d. Directly after `const strictPool = tagged.filter((t) => t.strict).map((t) => t.r);` add:

```ts
    lastStrictPool = strictPool;
```

3e. In the main search loop replace `const outcome = matchAgainst(results);` with `const outcome = judge(results);`. Do the same in the #664 series loop (the second `const outcome = matchAgainst(results);`). There must be no remaining direct call of `matchAgainst` outside `judge`: `grep -n "matchAgainst(results)" src/domain/untappd-lookup.ts` prints only the line inside `judge`.

3f. Replace the final `return notFound();` of `lookupBeer` (the last statement of the function, after the #353 block) with:

```ts
  // #659: every search attempt ended without a match (matchAgainst returned null). Same refinement
  // as in judge(), over all strict pools this lookup refused.
  const rescued = movedLetterRescue(refusedStrictPools);
  return rescued ? { kind: 'matched', result: rescued } : notFound();
```

Do not touch the other `notFound()` calls — they are inside `matchAgainst` and reach the rescue through `judge`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/untappd-lookup.moved-letter.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Mutation-prove**

Each mutation must fail at least the named test; revert after each:
- in `judge`, replace the rescue with `return outcome;` after the `not_found` check → `37911 Slik → Silk.` fails;
- in 3f, restore plain `return notFound();` → `37582 UTH → UHT` and `38383` fail;
- delete the whole `if (result.abv == null || ...) continue;` line → `ABV outside tolerance` and `candidate ABV unknown` fail;
- NOT a listed mutation: deleting `if (abv == null) return null;` survives by construction — vitest does not typecheck, and `Math.abs(x - null)` is `x`, which the tolerance line already rejects. The guard stays for type narrowing and so the null case does not rest on coercion; `input ABV unknown` pins the behaviour, not that line.
- change `hits.size === 1` to `hits.size >= 1` → `two qualifying bids` fails;
- delete `if (cand.restored) continue;` → `restored candidate identity` fails;
- change 3d to `lastStrictPool = results;` (the whole filtered list, all pools) → `relaxed brewery pool` fails;
- call `movedLetterRescue(lastStrictPool)` at the very top of `judge` and return it when non-null → `a match an existing stage accepts is unchanged` fails.

If a mutation survives, the test for it is vacuous: fix the fixture, not the mutation list.

- [ ] **Step 6: `spec.md`**

Insert after the paragraph ending «…тож не змінює жоден збіг, який уже прийняла чинна стадія, і не змінює `normalizeName`, `nameKeys`, fuzzy-пороги чи popularity-resolver.»:

```markdown
Коли `lookupBeer` за чинними стадіями завершився б без збігу, він має strict moved-letter rescue (#659)
для одруківки, що переставляє одну літеру в одному токені назви (`UTH` ↔ `UHT`, `Slik` ↔ `Silk.`,
`Tounge Tingle` ↔ `Tongue Tingle`). `fast-fuzzy` таких пар не бачить: оцінка нормується за довжиною, а
пошук підрядка дає `Slice.` ту саму оцінку, що й `Silk.`. Rescue читає лише строгий brewery pool після
фільтра цифр (#636); ідентичності обох боків не restored (#505) і мають однакову кількість токенів, рівно
один токен за позицією відрізняється, і один отримується з іншого переміщенням однієї літери (довжина ≥ 3,
без цифр, не римське число). ABV відомий з обох боків у межах `ABV_TOLERANCE`, умовам відповідає рівно один
distinct `bid`; інакше результат лишається `not_found`. Загальна відстань редагування свідомо не
використовується: на каталозі 163 пари різних пив однієї броварні з однаковим ABV відрізняються однією
будь-якою правкою (`Kwas Chi` / `Kwas Phi`), і жодна — переміщенням літери. Rescue не змінює жоден збіг,
прийнятий чинною стадією.
```

- [ ] **Step 7: Full gate and commit**

Run: `npm test && npm run typecheck` — expected: all green (existing lookup suites included: the rescue must not change any of their outcomes).

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.moved-letter.test.ts spec.md
git commit -m "feat(lookup): moved-letter rescue at lookupBeer's refusal points (#659)"
```

---

## After the plan (controller, not a task)

1. End-to-end review of both tasks.
2. Live replay with the spike's read-only script against the branch: 37582, 37911, 38383 → `matched` on the bids above; 29509 → `not_found`.
3. Rebase on `origin/main`, full gate, cross-review in background, PR.
4. After merge and deploy (user merges): `npm run adjudicate -- --issue 659`, then `--apply` the verdict file.
