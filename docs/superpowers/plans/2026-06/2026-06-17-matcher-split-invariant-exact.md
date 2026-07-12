# Split-invariant exact match (catalog-anchored second try) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the existing exact-match path finds nothing, run a catalog-anchored second try that re-derives the brewery/name boundary from the catalog, so a beer like `Pastry Mastery — SCHWARZBROT PORTER` matches **exact** regardless of where the adapter cut brewery vs name (issue #169).

**Architecture:** Purely additive change to `src/domain/matcher.ts`. The current exact logic runs first and untouched; a new block runs **only when `exacts.length === 0`**. It forms the combined normalized title, enumerates catalog candidates by the title's leading token, and accepts a candidate as exact when its full brewery is a leading token-run of the title AND the remainder (after stripping that brewery) equals the candidate's canonical name. Anchored hits flow through the existing ABV/year disambiguation and return `source: 'exact'`.

**Tech Stack:** TypeScript, Vitest. Test command: `npx vitest run src/domain/matcher.test.ts`.

**Spec:** `docs/superpowers/specs/2026-06-17-matcher-split-invariant-exact-design.md`

---

### Task 1: `leadingRun` helper

A one-directional token-boundary prefix test: is `prefixNorm` the leading run of `haystackNorm`? Unlike the existing `tokenPrefix` (bidirectional), the candidate brewery must appear **in full at the front** of the title.

**Files:**
- Modify: `src/domain/matcher.ts` (add exported `leadingRun` near `tokenPrefix`, ~line 162)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/matcher.test.ts`. First add `leadingRun` to the existing import line at the top of the file (the `import { ... } from './matcher';` line):

```ts
describe('leadingRun', () => {
  test('full brewery at front of title is a leading run', () => {
    expect(leadingRun('pastry mastery schwarzbrot', 'pastry mastery')).toBe(true);
  });
  test('whole-string equality is a leading run', () => {
    expect(leadingRun('pastry mastery', 'pastry mastery')).toBe(true);
  });
  test('non-leading occurrence is not a run', () => {
    expect(leadingRun('pastry mastery schwarzbrot', 'mastery')).toBe(false);
  });
  test('partial token never matches (boundary)', () => {
    expect(leadingRun('pastry mastery', 'past')).toBe(false);
  });
  test('prefix longer than haystack is false', () => {
    expect(leadingRun('pastry mastery', 'pastry mastery schwarzbrot')).toBe(false);
  });
  test('empty operands are false', () => {
    expect(leadingRun('schwarzbrot', '')).toBe(false);
    expect(leadingRun('', 'schwarzbrot')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/matcher.test.ts -t leadingRun`
Expected: FAIL — `leadingRun is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `src/domain/matcher.ts`, immediately after the `tokenPrefix` function (ends ~line 162), add:

```ts
// True if `prefixNorm`'s tokens are a leading, token-boundary prefix of `haystackNorm`.
// One-directional (unlike tokenPrefix): the candidate brewery must appear in full at the
// front of the combined title. Empty operands never match.
export function leadingRun(haystackNorm: string, prefixNorm: string): boolean {
  if (haystackNorm === '' || prefixNorm === '') return false;
  const h = haystackNorm.split(' ');
  const p = prefixNorm.split(' ');
  if (p.length > h.length) return false;
  return p.every((t, i) => t === h[i]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/matcher.test.ts -t leadingRun`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): add leadingRun token-boundary prefix helper (#169)"
```

---

### Task 2: `candidatesByFirstToken` accessor on `PreparedCatalog`

Expose the existing `byFirstToken` bucket so the anchored try can enumerate candidates by the combined title's leading token (needed to find candidates when the input brewery field is empty or mis-split).

**Files:**
- Modify: `src/domain/matcher.ts` — interface `PreparedCatalog` (~line 44-52) and `makePreparedCatalog` return object (~line 96-115)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/matcher.test.ts` (inside or after the existing `describe('prepareCatalog — breweryCandidates index', ...)` block):

```ts
describe('candidatesByFirstToken', () => {
  const cat: CatalogBeer[] = [
    c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu' }),
    c({ id: 2, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter' }),
  ];
  test('returns rows whose brewery-alias first token equals the key', () => {
    const ids = prepareCatalog(cat).candidatesByFirstToken('pastry').map((b) => b.id);
    expect(ids).toEqual([2]);
  });
  test('unknown token returns empty array', () => {
    expect(prepareCatalog(cat).candidatesByFirstToken('zzz')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/matcher.test.ts -t candidatesByFirstToken`
Expected: FAIL — `candidatesByFirstToken is not a function`.

- [ ] **Step 3: Add to the interface**

In `src/domain/matcher.ts`, in the `PreparedCatalog` interface, add the method below `breweryCandidates`:

```ts
  breweryCandidates(inputAliases: string[]): PreparedBeer[];
  // Catalog rows bucketed under `token` as the first token of one of their brewery
  // aliases. Raw bucket access for the split-invariant second try (#169).
  candidatesByFirstToken(token: string): PreparedBeer[];
```

- [ ] **Step 4: Implement in `makePreparedCatalog`**

In the returned object of `makePreparedCatalog` (the one that already has `breweryCandidates`, `searcherFor`, `fullSearcher`), add:

```ts
    candidatesByFirstToken: (token) => byFirstToken.get(token) ?? [],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/domain/matcher.test.ts -t candidatesByFirstToken`
Expected: PASS (2 assertions).

- [ ] **Step 6: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): expose candidatesByFirstToken accessor (#169)"
```

---

### Task 3: Catalog-anchored second try in `matchPrepared`

The core change. When the existing exact path yields zero rows, attempt the split-invariant match and, on success, feed the anchored rows into the existing disambiguation.

**Files:**
- Modify: `src/domain/matcher.ts` — add `sortedTokens` helper (near `nameKeys`), change `const exacts` to `let exacts` (~line 273), insert the anchored block before the `if (exacts.length)` block (~line 277)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `src/domain/matcher.test.ts`:

```ts
describe('split-invariant anchored second try (#169)', () => {
  const cat: CatalogBeer[] = [
    c({ id: 12544, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter', abv: 8.0 }),
    c({ id: 300, brewery: 'Mad Brew', name: 'Galaxy Juice', abv: 6.0 }),
    c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 }),
  ];

  test('all three brewery/name splits resolve to the same exact id', () => {
    const inputs = [
      { brewery: '', name: 'Pastry Mastery Schwarzbrot Porter' },
      { brewery: 'Pastry', name: 'Mastery Schwarzbrot Porter' },
      { brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter' },
    ];
    for (const input of inputs) {
      expect(matchBeer(input, cat)).toEqual({ id: 12544, confidence: 1, source: 'exact' });
    }
  });

  test('two-word brewery split mid-title (Mad Brew) → exact', () => {
    expect(matchBeer({ brewery: 'Mad', name: 'Brew Galaxy Juice' }, cat))
      .toEqual({ id: 300, confidence: 1, source: 'exact' });
  });

  test('brewery genuinely absent does NOT anchor onto Pastry Mastery', () => {
    // No brewery tokens in the title → the leading-token bucket has no candidate.
    expect(matchBeer({ brewery: '', name: 'Schwarzbrot Porter' }, cat)?.source)
      .not.toBe('exact');
  });

  test('same brewery, different name remainder → no false exact', () => {
    expect(matchBeer({ brewery: 'Pastry', name: 'Mastery Hazelnut Stout' }, cat)?.source)
      .not.toBe('exact');
  });

  test('anchored hit still respects ABV disambiguation across vintages', () => {
    const vintages: CatalogBeer[] = [
      c({ id: 200, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter', abv: 8.0 }),
      c({ id: 201, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter', abv: 5.0 }),
    ];
    // Mis-split input with abv 5.0 must pick the matching-abv row, not just newest id.
    expect(matchBeer({ brewery: 'Pastry', name: 'Mastery Schwarzbrot Porter', abv: 5.0 }, vintages))
      .toEqual({ id: 201, confidence: 1, source: 'exact' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/matcher.test.ts -t "anchored second try"`
Expected: FAIL — the mis-split / empty-brewery cases return `source: 'fuzzy'` or `null` instead of the exact id (the correct-split case at id 12544 may already pass; the others must fail).

- [ ] **Step 3: Add the `sortedTokens` helper**

In `src/domain/matcher.ts`, just above `export function nameKeys` (~line 216), add:

```ts
// Order-insensitive canonical form of a normalized string: tokens sorted, re-joined.
function sortedTokens(norm: string): string {
  return norm.split(' ').filter(Boolean).sort().join(' ');
}
```

- [ ] **Step 4: Make `exacts` reassignable**

In `matchPrepared`, change the `exacts` declaration (~line 273) from `const` to `let`:

```ts
  let exacts = breweryMatches
    .filter((c) => c.nameNorm === nn || intersects(c.keys, inputKeys))
    .sort((a, b) => b.id - a.id);
```

- [ ] **Step 5: Insert the anchored second try**

In `matchPrepared`, immediately **before** the existing `if (exacts.length) {` block (~line 277), insert:

```ts
  // Split-invariant second try (#169): only when the boundary-trusting exact path found
  // nothing. Re-derive the brewery/name cut from the catalog instead of trusting the
  // adapter's split — a candidate matches when its FULL brewery is a leading token-run of
  // the combined title and the remainder equals the candidate's canonical name. Strictly
  // stronger than the normal gate, so accepting single-token names here is FP-safe.
  if (exacts.length === 0) {
    const combined = normalizeName(`${input.brewery} ${input.name}`);
    const firstToken = combined.split(' ')[0] ?? '';
    if (firstToken) {
      const anchored = prepared.candidatesByFirstToken(firstToken).filter((cand) =>
        cand.aliases.some((alias) => {
          if (!leadingRun(combined, alias)) return false;
          const remainder = stripBreweryFromName(combined, alias);
          const canonName = stripBreweryFromName(cand.nameNorm, cand.breweryNorm);
          return remainder !== '' && sortedTokens(remainder) === sortedTokens(canonName);
        }),
      );
      if (anchored.length) exacts = anchored.slice().sort((a, b) => b.id - a.id);
    }
  }
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `npx vitest run src/domain/matcher.test.ts -t "anchored second try"`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the full matcher suite (regression guard)**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected: PASS — every pre-existing test still green (proves the second try never perturbs cases that already exact-match, since it only fires on `exacts.length === 0`).

- [ ] **Step 8: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): catalog-anchored split-invariant exact second try (#169)"
```

---

### Task 4: Update `spec.md`

Document the split-invariant second try in the matching section (required by CLAUDE.md — `spec.md` is the single source of truth).

**Files:**
- Modify: `spec.md` — after the `stripBreweryFromName` paragraph that ends with `…лишаються незматченими (deferred).` (~line 586)

- [ ] **Step 1: Insert the spec paragraph**

In `spec.md`, immediately after the paragraph ending `…(`Cydr Chyliczki`, `Hoppy Hog Family Brewery`) лишаються незматченими (deferred).` (~line 586), add a new paragraph:

```markdown
**Split-invariant exact-друга-спроба (#169).** Коли звичайна exact-стадія `matchPrepared`
не дала кандидатів (`exacts.length === 0`), запускається друга спроба, що **не довіряє**
межі brewery/name з адаптера: будується об'єднаний нормалізований заголовок
`normalizeName(brewery + ' ' + name)`, кандидати беруться з first-token індексу за **провідним
токеном** заголовка (`candidatesByFirstToken`), і кандидат приймається як **exact**, коли
якийсь його alias пивоварні є **провідним токен-раном** заголовка (`leadingRun`) **і** залишок
після зрізу цієї пивоварні (`stripBreweryFromName`, сортовані токени) дорівнює канонічній назві
кандидата. Це робить exact-матч стійким до того, де адаптер розрізав пивоварню й назву (усі
розбиття `Pastry Mastery / SCHWARZBROT`, включно з порожнім полем пивоварні, сходяться в один
збіг). Гейт сильніший за звичайний (повна пивоварня присутня + рівність назви), тож тут безпечно
приймати **однотокенні** назви (`schwarzbrot`), які звичайний `nameKeys` відкидає. Спрацьовує
лише на промах — exact-кейси, що працюють зараз, не змінюються; заголовки без токенів пивоварні
взагалі (bare-name крамниці) лишаються fuzzy (окремо, #108). Анкорені рядки проходять ту саму
ABV/vintage-дизамбіґуацію й повертають `source: 'exact'`.
```

- [ ] **Step 2: Sanity-check the surrounding markdown**

Run: `npx vitest run` (full suite) to confirm nothing else broke, then visually confirm the new paragraph sits between the `stripBreweryFromName` paragraph and the `**Гейтинг сильних заяв.**` paragraph.
Expected: full suite PASS.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): split-invariant exact second try in matching section (#169)"
```

---

## Notes for the implementer

- **No `extension/**` change.** This is server-side (`src/domain/**`); `docs/extension-install-uk.md` is intentionally **not** touched (no new badge/option/shop). Do not add it.
- **Why the second try is safe:** it is gated on `exacts.length === 0`, so any input that already exact-matches today skips it entirely. Task 3 Step 7 (full matcher suite green) is the regression proof — do not skip it.
- **`stripBreweryFromName` never returns empty**, so a brewery-only title (combined == alias) leaves the brewery un-stripped and fails the name-equality check — correctly producing no false match. The `remainder !== ''` guard is belt-and-suspenders.
