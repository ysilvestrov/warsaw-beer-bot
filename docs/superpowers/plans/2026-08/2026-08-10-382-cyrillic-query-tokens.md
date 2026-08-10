# #382 Cyrillic query tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Untappd search query from silently deleting Cyrillic tokens, and stop mixed-script homoglyph tokens from blocking name matches, without regressing any beer that matches today.

**Architecture:** Two independent units in `src/domain/normalize.ts` — a guarded homoglyph repair applied to every normalization and query, and a two-rung query ladder whose narrow rung preserves Cyrillic. `lookupBeer` walks the rungs and widens **only** when a rung returns zero results, which is what makes the change provably non-regressive (design §4).

**Tech Stack:** TypeScript (CommonJS, `tsc`), Vitest, better-sqlite3, live Untappd Algolia for the verification replay.

**Design doc:** `docs/superpowers/specs/2026-08/2026-08-10-382-cyrillic-query-tokens-design.md` — read §2 before starting; the issue's own proposed fix was measured and refuted.

**Out of scope:** the relay path (`/enrich/candidates`), filed as #391. Do not touch `src/api/routes/enrich.ts`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/domain/normalize.ts` | homoglyph repair + both query rungs | modify (Tasks 1, 2, 4) |
| `src/domain/normalize.test.ts` | census corpus + ladder tests | modify (Tasks 1, 2, 4) |
| `src/domain/untappd-lookup.ts` | rung iteration in `lookupBeer` | modify (Tasks 3, 5) |
| `src/domain/untappd-lookup.test.ts` | rung call-count tests | modify (Task 5) |
| `spec.md` | query-construction contract | modify (Task 6) |

Task 3 is a pure refactor with no behaviour change; it exists so Task 5's control-flow change is a three-line diff instead of a restructure of a 130-line loop body.

---

### Task 1: `repairHomoglyphs` in normalize.ts

**Files:**
- Modify: `src/domain/normalize.ts` (insert after `stripDiacritics`, which ends at line 63)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/normalize.test.ts`. The three corpora below are the complete census of mixed-script tokens in the production catalogue (31942 `beers` rows) — the untouched list is the negative guard and is not optional.

```ts
describe('repairHomoglyphs', () => {
  test.each([
    ['Companу', 'Company'],
    ['Сherry', 'Cherry'],
    ['Сider', 'Cider'],
    ['Coоkies', 'Cookies'],
    ['СOMMA', 'COMMA'],
    ['Soаked', 'Soaked'],
    ['TOMATO+Сhipotle', 'TOMATO+Chipotle'],
    ['СINNAMON', 'CINNAMON'],
    ['СOCORITA', 'COCORITA'],
    ['СITRA+CITRA', 'CITRA+CITRA'],
    ['Сhristmas', 'Christmas'],
    ['NEІРА', 'NEIPA'],
  ])('repairs %s toward Latin', (input, expected) => {
    expect(repairHomoglyphs(input)).toBe(expected);
  });

  test.each([
    ['Свiтле)', 'Світле)'],
    ['Проскурiвське', 'Проскурівське'],
    ['ИмбирьOK', 'ИмбирьОК'],
    ['(Зiберт', '(Зіберт'],
    ['Aваддон', 'Аваддон'],
    ['Вiд', 'Від'],
    ['Класiчнае)', 'Класічнае)'],
    ['Премiум)', 'Преміум)'],
    ['(Львiвське', '(Львівське'],
    ['Бiлий', 'Білий'],
    ["Рiздв'яний", "Різдв'яний"],
  ])('repairs %s toward Cyrillic', (input, expected) => {
    expect(repairHomoglyphs(input)).toBe(expected);
  });

  test.each([
    'BeerЛога', 'Hellь', 'CowКава', 'Mozaїка', 'Enкel',
    'ZЁZЯ', 'ЭльFan', 'NEЗагравай', 'миcola', 'Trymaysя!',
  ])('leaves genuinely mixed token %s untouched', (input) => {
    expect(repairHomoglyphs(input)).toBe(input);
  });

  test('single-script strings pass through unchanged', () => {
    expect(repairHomoglyphs('Pinta Atak Chmielu')).toBe('Pinta Atak Chmielu');
    expect(repairHomoglyphs('Ципа Блонда')).toBe('Ципа Блонда');
  });

  test('repairs per token, preserving the original spacing', () => {
    expect(repairHomoglyphs('Malle  Belgian Сhristmas Ale'))
      .toBe('Malle  Belgian Christmas Ale');
  });

  test('a token mixing scripts across a word boundary is judged per token', () => {
    // "Ципа" is pure Cyrillic and "PERRY" pure Latin: neither token is mixed,
    // so nothing is repaired even though the string carries both scripts.
    expect(repairHomoglyphs('Ципа Сидр Грушевий PERRY')).toBe('Ципа Сидр Грушевий PERRY');
  });
});
```

Add `repairHomoglyphs` to the existing import at `src/domain/normalize.test.ts:1`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/normalize.test.ts -t repairHomoglyphs`
Expected: FAIL — `repairHomoglyphs is not a function` (or a TS build error that the export does not exist).

- [ ] **Step 3: Write the implementation**

Insert into `src/domain/normalize.ts` immediately after the `stripDiacritics` function (line 63):

```ts
// Cyrillic ↔ Latin homoglyph pairs: characters that render identically in the fonts
// shops and Untappd use. Both sides of the pipeline carry tokens typed in the wrong
// script — `NEІРА` is `NEIPA` with Cyrillic І/Р/А, `Свiтле` is a Cyrillic word carrying
// a Latin `i` (#382). Such a token is doubly harmful: it sends query characters no index
// entry contains, and it blocks a name match Algolia already found, because
// `Belgian Сhristmas Ale` can never normalize onto `Belgian Christmas Ale`.
//
// The map is restricted to visually identical pairs. Lowercase к/м/т/в/н are deliberately
// absent: they are not reliably confusable with k/m/t/b/h. Excluding them costs exactly one
// legitimate repair in the whole catalogue (`Enкel`) and prevents a false one — adding в→b
// would corrupt `CowКава` into `CowKaba`.
const CYRILLIC_TO_LATIN = new Map<string, string>(Object.entries({
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
  'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i',
  'ј': 'j', 'ѕ': 's',
}));
const LATIN_TO_CYRILLIC = new Map<string, string>(
  [...CYRILLIC_TO_LATIN].map(([cyrillic, latin]) => [latin, cyrillic]),
);

const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;
const HAS_LATIN = /[A-Za-z]/;

function repairToken(tok: string): string {
  const chars = [...tok];
  const cyrillic = chars.filter((c) => HAS_CYRILLIC.test(c));
  const latin = chars.filter((c) => HAS_LATIN.test(c));
  if (cyrillic.length === 0 || latin.length === 0) return tok;
  // Latin is tried FIRST and this ordering is load-bearing, not a tie-break: `NEІРА`
  // is Cyrillic-majority (3 vs 2) yet wants Latin, so a majority rule yields `НЕІРА`.
  if (cyrillic.every((c) => CYRILLIC_TO_LATIN.has(c))) {
    return chars.map((c) => CYRILLIC_TO_LATIN.get(c) ?? c).join('');
  }
  if (latin.every((c) => LATIN_TO_CYRILLIC.has(c))) {
    return chars.map((c) => LATIN_TO_CYRILLIC.get(c) ?? c).join('');
  }
  return tok;
}

// Repair mixed-script tokens. Only tokens containing BOTH scripts are touched; a token
// written wholly in one script is never transliterated (that is #320, a different job).
export function repairHomoglyphs(s: string): string {
  // Fast path. normalizeName runs on every candidate inside the fuzzy loop and the
  // catalogue is overwhelmingly single-script, so the common case must cost two regex
  // tests and no allocation.
  if (!HAS_CYRILLIC.test(s) || !HAS_LATIN.test(s)) return s;
  return s
    .split(/(\s+)/)
    .map((part) => (/^\s*$/.test(part) ? part : repairToken(part)))
    .join('');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/normalize.test.ts -t repairHomoglyphs`
Expected: PASS, 36 tests.

- [ ] **Step 5: Verify nothing else broke**

Run: `npm test && npm run typecheck`
Expected: the whole suite passes. `repairHomoglyphs` is not wired anywhere yet, so nothing may change.

- [ ] **Step 6: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "feat(#382): repair mixed-script homoglyph tokens"
```

---

### Task 2: Wire the repair into `baseNormalize`

This is what fixes the *matching* half of the bug: Algolia already returns `Belgian Christmas Ale` for `Malle / Belgian Сhristmas Ale`, and the matcher throws it away.

**Files:**
- Modify: `src/domain/normalize.ts:76-82` (`baseNormalize`)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('#382 homoglyph repair reaches name matching', () => {
  test('a Cyrillic С in a Latin word no longer blocks the match', () => {
    expect(normalizeName('Belgian Сhristmas Ale')).toBe(normalizeName('Belgian Christmas Ale'));
  });

  test('a Latin i in a Cyrillic word no longer blocks the match', () => {
    expect(normalizeName('Львiвське Бiле')).toBe(normalizeName('Львівське Біле'));
  });

  test('brewery normalization gets the same repair', () => {
    expect(normalizeBrewery('Проскурiвське')).toBe(normalizeBrewery('Проскурівське'));
  });

  test('a genuinely mixed name is still not equated with either script', () => {
    expect(normalizeName('BeerЛога')).not.toBe(normalizeName('BeerLoga'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/normalize.test.ts -t "homoglyph repair reaches"`
Expected: FAIL — the first test reports `'belgian сhristmas ale'` vs `'belgian christmas ale'`.

- [ ] **Step 3: Write the implementation**

In `src/domain/normalize.ts`, change the first line of `baseNormalize` (line 77) from:

```ts
  return stripDiacritics(s).toLowerCase()
```

to:

```ts
  return stripDiacritics(repairHomoglyphs(s)).toLowerCase()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/normalize.test.ts -t "homoglyph repair reaches"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: green. `baseNormalize` feeds `normalizeName`, `normalizeBrewery`, the name keys and the fuzzy targets; if any existing test changes, STOP and report it rather than editing the expectation — an unexpected diff here means the repair is firing on a single-script string.

- [ ] **Step 6: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(#382): apply homoglyph repair in baseNormalize so the matcher sees one script"
```

---

### Task 3: Refactor — extract the match stages out of the search loop

**Pure refactor. No behaviour change, no new test, and the existing suite must stay green without edits.**

`lookupBeer`'s `for (const part of parts)` body is ~130 lines and uses `continue` to mean "give up on this brewery part". Task 5 nests a rung loop inside it, at which point every `continue` silently changes meaning. Extracting the stages first makes that impossible.

**Files:**
- Modify: `src/domain/untappd-lookup.ts:177-354`

- [ ] **Step 1: Extract the closure**

Inside `lookupBeer`, after the `const seenCandidates: SearchResult[] = [];` declaration (line 182) and before the `for (const part of parts)` loop, add:

```ts
  // One search attempt's candidate list run through every match stage. Returns a matched
  // outcome, or null when this list yields nothing. Extracted from the search loop so the
  // query ladder (#382) can iterate rungs without duplicating 130 lines of staging — and
  // so "no match" is a return value rather than a `continue` whose meaning depends on how
  // many loops happen to enclose it.
  function matchAgainst(results: SearchResult[]): LookupOutcome | null {
```

Move the entire existing loop body **from** the line `// Stage 1: brewery-match strength.` **through** the closing of the Czech-grade block (ending at the comment `// No name match in this search part — fall through to the next part.`) into this function, then close it with:

```ts
    return null;
  }
```

Two edits inside the moved body — these are the whole point of the task:

1. `if (strictPool.length === 0 && relaxedPool.length === 0 && brandPool.length === 0) continue;`
   becomes
   `if (strictPool.length === 0 && relaxedPool.length === 0 && brandPool.length === 0) return null;`
2. The trailing comment `// No name match in this search part — fall through to the next part.` is replaced by the `return null;` above.

Every `return { kind: 'matched', … }` inside the moved body stays exactly as written — the return type widens to `LookupOutcome | null`, which those satisfy.

- [ ] **Step 2: Rewire the loop to call it**

The loop body becomes:

```ts
  for (const part of parts) {
    const query = cleanSearchQuery(part, name);
    triedUrls.push(buildSearchUrl(query)); // human-readable debug URL for enrich_failures

    let results: SearchResult[];
    try {
      results = await args.search.search(query);
    } catch (error) {
      if (error instanceof HttpError && isBlockStatus(error.status)) {
        return { kind: 'blocked', searchUrl: buildSearchUrl(query) };
      }
      return { kind: 'transient', error };
    }

    seenCandidates.push(...results);
    if (results.length === 0) continue;

    const outcome = matchAgainst(results);
    if (outcome) return outcome;
  }
```

- [ ] **Step 3: Verify the refactor changed nothing**

Run: `npm test && npm run typecheck`
Expected: green, with **zero** test files edited. `git diff --stat` must show `src/domain/untappd-lookup.ts` and nothing else.

- [ ] **Step 4: Prove the extraction is faithful**

Run: `git diff -w --stat src/domain/untappd-lookup.ts`
The moved block should show as an indentation-only change apart from the two `continue` → `return null` edits and the new wrapper lines. If the whitespace-ignoring diff shows unexpected content changes, something was dropped in the move — fix it before committing.

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.ts
git commit -m "refactor(#382): extract lookupBeer match stages into matchAgainst"
```

---

### Task 4: `searchQueryLadder` in normalize.ts

**Files:**
- Modify: `src/domain/normalize.ts:198-238` (`MIN_QUERY_TOKEN_LENGTH` and `cleanSearchQuery`)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('searchQueryLadder', () => {
  test('all-Latin input yields a single rung — no ladder, no extra request', () => {
    expect(searchQueryLadder('Pinta', 'Atak Chmielu')).toEqual(['Pinta Atak Chmielu']);
  });

  test('the last rung always equals cleanSearchQuery', () => {
    const rungs = searchQueryLadder('Ципа', 'Сидр Грушевий PERRY');
    expect(rungs[rungs.length - 1]).toBe(cleanSearchQuery('Ципа', 'Сидр Грушевий PERRY'));
  });

  test('the narrow rung keeps Cyrillic the ASCII fold deletes', () => {
    // Today's query is the bare style word `PERRY`, which matches thousands of
    // unrelated beers; the narrow rung carries the identity tokens.
    expect(searchQueryLadder('Ципа', 'Сидр Грушевий PERRY')).toEqual([
      'Ципа Сидр Грушевий PERRY',
      'PERRY',
    ]);
  });

  test('the narrow rung still drops one-character tokens (#350 is script-aware, not disabled)', () => {
    expect(searchQueryLadder('Pinta Brewery', 'Rock n Roll')).toEqual(['Pinta Rock Roll']);
    // `Шо` folds to two characters under the unicode fold and is therefore kept.
    expect(searchQueryLadder('SHO Brewery', 'Шо Забіяка')).toEqual(['SHO Шо Забіяка', 'SHO']);
  });

  test('the echo strip is no longer blind on Cyrillic', () => {
    // Both tokens fold to '' under the ASCII fold, so the reduced rung cannot tell
    // that the name restates the brewery; the narrow rung strips the leading echo.
    expect(searchQueryLadder('Ципа', 'Ципа Блонда')[0]).toBe('Ципа Блонда');
  });

  test('homoglyph repair reaches both rungs', () => {
    expect(searchQueryLadder('Malle', 'Belgian Сhristmas Ale'))
      .toEqual(['Malle Belgian Christmas Ale']);
  });
});
```

Add `searchQueryLadder` to the import at `src/domain/normalize.test.ts:1`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/normalize.test.ts -t searchQueryLadder`
Expected: FAIL — `searchQueryLadder is not a function`.

- [ ] **Step 3: Write the implementation**

Replace the body of `cleanSearchQuery` (`src/domain/normalize.ts:200-238`) with a fold-parameterized builder plus two entry points. The pipeline itself is untouched — only the fold used for retention, dedup and the echo strip becomes a parameter, and the raw inputs pass through `repairHomoglyphs`:

```ts
// Retention fold for the narrow rung. Identical to foldToken except that it keeps every
// Unicode letter and digit instead of `[a-z0-9]`, so a Cyrillic token measures its real
// length instead of collapsing to ''. MIN_QUERY_TOKEN_LENGTH still applies — #350's
// finding (Algolia does not match a one-character token) is script-independent; the gate
// simply stops mistaking "not written in Latin" for "one character" (#382).
function unicodeFoldToken(tok: string): string {
  return stripDiacritics(tok).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function buildSearchQuery(
  breweryRaw: string,
  nameRaw: string,
  fold: (tok: string) => string,
): string {
  const brewery = repairHomoglyphs(breweryRaw);
  const name = repairHomoglyphs(nameRaw);
  const cleanBrewery = stripQueryTokenNoise(stripSearchNoise(stripLegalForm(canonicalizeBreweryBrand(brewery))));
  const cleanName = stripQueryTokenNoise(stripSearchNoise(name));

  const brandTokens: string[] = [];
  const brandFolds = new Set<string>();
  for (const tok of cleanBrewery.split(COLLAB_SEP).join(' ').split(/\s+/)) {
    const f = fold(tok);
    if (!f || f.length < MIN_QUERY_TOKEN_LENGTH || BREWERY_NOISE.has(f) || brandFolds.has(f)) continue;
    brandFolds.add(f);
    brandTokens.push(tok);
  }

  const nameTokens: string[] = [];
  for (const tok of cleanName.replace(/\//g, ' ').split(/\s+/)) {
    const f = fold(tok);
    if (!f || f.length < MIN_QUERY_TOKEN_LENGTH || BREWERY_NOISE.has(f)) continue;
    nameTokens.push(tok);
  }

  let start = 0;
  let end = nameTokens.length;
  while (start < end && brandFolds.has(fold(nameTokens[start]))) start++;
  while (end > start && brandFolds.has(fold(nameTokens[end - 1]))) end--;

  const out = [...brandTokens, ...nameTokens.slice(start, end)];
  // Last resort: never emit an empty query.
  return out.length ? out.join(' ') : (cleanName || cleanBrewery || name.trim());
}

export function cleanSearchQuery(brewery: string, name: string): string {
  return buildSearchQuery(brewery, name, foldToken);
}

// The rungs of the #382 query ladder, narrowest first. The narrow rung's term set is a
// superset of the wide rung's, so its result set is a subset: a caller that widens ONLY on
// a zero result can never see fewer candidates than it sees today. Rungs collapse to one
// entry whenever the folds agree, which is every all-Latin input — the Latin majority of
// the catalogue therefore pays nothing.
export function searchQueryLadder(brewery: string, name: string): string[] {
  const narrow = buildSearchQuery(brewery, name, unicodeFoldToken);
  const wide = cleanSearchQuery(brewery, name);
  return narrow === wide ? [narrow] : [narrow, wide];
}
```

Keep the existing doc comment above `cleanSearchQuery` (lines 139-152) where it is; it documents the pipeline, which now lives in `buildSearchQuery`. Move it to sit above `buildSearchQuery`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: PASS, including all 30 pre-existing `cleanSearchQuery` tests. Those are all-Latin, so `buildSearchQuery` with `foldToken` must reproduce them byte-for-byte. A failure there means the pipeline was altered, not parameterized.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "feat(#382): add the two-rung search query ladder"
```

---

### Task 5: Walk the ladder in `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (the `for (const part of parts)` loop from Task 3; and the import on line 3)
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/untappd-lookup.test.ts`. Note the harness already has `fakeSearch`; these tests additionally record the queries so the call *count* is asserted, not just the outcome.

```ts
describe('#382 query ladder', () => {
  function recordingSearch(fn: (q: string) => SearchResult[]) {
    const queries: string[] = [];
    return {
      queries,
      search: { search: async (q: string) => { queries.push(q); return fn(q); } } as BeerSearch,
    };
  }

  test('widens to the reduced rung when the narrow rung returns nothing', async () => {
    const { queries, search } = recordingSearch((q) =>
      q === 'Ципа Сидр Грушевий PERRY'
        ? []
        : [{ bid: 7001, beer_name: 'Сидр Грушевий PERRY', brewery_name: 'Ципа', style: 'Cider', abv: 5, global_rating: 3.5 }],
    );
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(queries).toEqual(['Ципа Сидр Грушевий PERRY', 'PERRY']);
    expect(out.kind).toBe('matched');
  });

  test('never widens when the narrow rung returned candidates, even if none match', async () => {
    // The wide rung's extra candidates are a superset the narrow rung already excluded;
    // re-searching would only re-offer rows the same stages just rejected.
    const { queries, search } = recordingSearch((q) =>
      q === 'Ципа Сидр Грушевий PERRY'
        ? [{ bid: 7002, beer_name: 'Something Else', brewery_name: 'Other Brewery', style: 'IPA', abv: 5, global_rating: 3.5 }]
        : [{ bid: 7003, beer_name: 'Сидр Грушевий PERRY', brewery_name: 'Ципа', style: 'Cider', abv: 5, global_rating: 3.5 }],
    );
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(queries).toEqual(['Ципа Сидр Грушевий PERRY']);
    expect(out.kind).toBe('not_found');
  });

  test('all-Latin input issues exactly one query per brewery part', async () => {
    const { queries, search } = recordingSearch(() => []);
    await lookupBeer({ brewery: 'Pinta', name: 'Atak Chmielu', search });
    expect(queries).toEqual(['Pinta Atak Chmielu']);
  });

  test('every attempted rung is reported in searchUrls', async () => {
    const { search } = recordingSearch(() => []);
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(out.kind).toBe('not_found');
    if (out.kind !== 'not_found') return;
    expect(out.searchUrls).toHaveLength(2);
    expect(decodeURIComponent(out.searchUrls[0])).toContain('Ципа Сидр Грушевий PERRY');
    expect(decodeURIComponent(out.searchUrls[1])).toContain('PERRY');
  });

  test('a block on the narrow rung returns blocked without trying the wide rung', async () => {
    const { queries, search } = recordingSearch(() => { throw new HttpError(403, 'https://untappd.com'); });
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(out.kind).toBe('blocked');
    expect(queries).toEqual(['Ципа Сидр Грушевий PERRY']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "query ladder"`
Expected: FAIL — the first test reports `queries` as `['PERRY']`; the ladder is not wired yet.

- [ ] **Step 3: Write the implementation**

In `src/domain/untappd-lookup.ts` line 3, change the import:

```ts
import { normalizeBrewery, normalizeName, searchQueryLadder } from './normalize';
```

Only if `cleanSearchQuery` is no longer referenced elsewhere in the file — check with `grep -n cleanSearchQuery src/domain/untappd-lookup.ts` and keep it in the import list if it is.

Replace the loop from Task 3 with:

```ts
  for (const part of parts) {
    for (const query of searchQueryLadder(part, name)) {
      triedUrls.push(buildSearchUrl(query)); // human-readable debug URL for enrich_failures

      let results: SearchResult[];
      try {
        results = await args.search.search(query);
      } catch (error) {
        if (error instanceof HttpError && isBlockStatus(error.status)) {
          return { kind: 'blocked', searchUrl: buildSearchUrl(query) };
        }
        return { kind: 'transient', error };
      }

      seenCandidates.push(...results);
      // Zero results → widen to the next rung. A rung that DID return candidates is never
      // abandoned: its results are a subset of the wider rung's, so widening after a matcher
      // rejection could only re-offer rows the same stages just rejected (#382 §3.3).
      if (results.length === 0) continue;

      const outcome = matchAgainst(results);
      if (outcome) return outcome;
      break;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/untappd-lookup.test.ts`
Expected: PASS, including every pre-existing `lookupBeer` test.

- [ ] **Step 5: Check the #271 head-retry interaction**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "head"`
Expected: PASS. The head-retry fires on `seenCandidates.length === 0`, and `seenCandidates` now accumulates across rungs — which is correct: if every rung of every part came back empty, the query really was zeroed. Confirm a test covers it; if none does, add:

```ts
test('#271 head-retry still fires when every rung of every part is empty', async () => {
  const queries: string[] = [];
  const search: BeerSearch = { search: async (q) => { queries.push(q); return []; } };
  const out = await lookupBeer({ brewery: 'Ципа', name: 'Орєнтал, Лохина, Чорна Смородина', search });
  expect(out.kind).toBe('not_found');
  // the head-only retry ran in addition to the ladder rungs
  expect(queries.length).toBeGreaterThan(2);
});
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(#382): walk the query ladder in lookupBeer, widening only on zero results"
```

---

### Task 6: Update `spec.md`

**Files:**
- Modify: `spec.md` — the block ending at the `#350` paragraph (around line 971-981)

- [ ] **Step 1: Amend the #350 paragraph**

Find the paragraph beginning `**Односимвольні токени в запиті (#350).**` and append this sentence to its end:

```
Від #382 цей гейт **script-aware** на вузькому щаблі драбини (нижче): довжину рахує
unicode-згортка (`\p{L}\p{N}`), тож кириличний токен вимірює свою справжню довжину,
а не нуль.
```

- [ ] **Step 2: Add the new contract section**

Insert immediately after that paragraph:

```
**Ремонт гомогліфів (#382).** `repairHomoglyphs()` перед будь-якою нормалізацією
лагодить токени, у яких намішані **обидва** скрипти — латиниця й кирилиця. Два
правила з пріоритетом латиниці: якщо всі кириличні символи токена мають латинський
гомогліф — мапимо в латиницю (`NEІРА` → `NEIPA`, `Сhristmas` → `Christmas`,
`Companу` → `Company`); інакше, якщо всі латинські мають кириличний — мапимо в
кирилицю (`Свiтле` → `Світле`, `Проскурiвське`); інакше токен недоторканий
(`BeerЛога`, `Hellь`, `Mozaїка`). Латиниця йде першою не як tie-break: `NEІРА` має
кириличну більшість (3 проти 2), тож правило більшості дало б `НЕІРА`. Мапа тримає
лише візуально тотожні пари; малі `к м т в н` свідомо виключені — інакше `CowКава`
зіпсувалася б у `CowKaba`. Односкриптовий токен НІКОЛИ не транслітерується — це
окрема задача (#320). Ремонт застосовано у `baseNormalize` (тобто в `normalizeName`,
`normalizeBrewery`, ключах назви, fuzzy-цілях і брewery-гейті) і в будівнику запиту,
причому симетрично до входу й до кандидата. Без нього Algolia знаходить правильне
пиво, а матчер його відкидає: `Belgian Сhristmas Ale` ніколи не дорівнює
`Belgian Christmas Ale`.

**Драбина пошукового запиту (#382).** `searchQueryLadder(brewery, name)` повертає
щаблі від вузького до широкого. Обидва проходять той самий конвеєр
(`buildSearchQuery`) і різняться лише згорткою для утримання/дедупу/echo-strip:
вузький щабель бере unicode-згортку (`\p{L}\p{N}`) і тому **зберігає кириличні
токени**, широкий — це рівно `cleanSearchQuery` з ASCII-згорткою. Коли згортки
збігаються (будь-який суто латинський вхід), щабель один — латинська більшість
каталогу не платить нічого. `lookupBeer` іде щаблями і **розширюється лише при нулі
результатів**: щабель, що повернув кандидатів, ніколи не покидається. Це і є
гарантія відсутності регресій — множина термінів вузького щабля є надмножиною
широкого, отже його результати є підмножиною; при нулі ми бачимо рівно те, що
бачили б без драбини. Причина: ASCII-згортка `foldToken` перетворює будь-який
нелатинський токен на `''`, і гейт #350 його викидав, лишаючи
голе стильове слово (`Ципа / Сидр Грушевий PERRY` → `PERRY`). Вузький щабель заодно
лікує сліпоту `brandFolds` на кирилиці (дедуп і echo-strip #126/#155).
Relay-шлях (`/enrich/candidates`) драбини НЕ має — там сервер віддає один готовий
запит; винесено в #391.
```

- [ ] **Step 3: Verify**

Run: `grep -n "#382" spec.md`
Expected: at least three hits — the amended #350 paragraph and the two new sections.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(#382): spec the homoglyph repair and the query ladder"
```

---

### Task 7: Live verification replay

The unit tests prove the mechanism. This proves the *measurement* the design promised (acceptance criterion 5) and is the gate on opening the PR.

**Files:**
- Create: `tmp/verify-382.ts` (scratch — `./tmp/` is gitignored and must be emptied when the task is done)

- [ ] **Step 1: Write the verification script**

```ts
import Database from 'better-sqlite3';
import { cleanSearchQuery, searchQueryLadder } from '../src/domain/normalize';

const APP = '9WBO4RQ3HO', KEY = '1d347324d67ec472bb7132c66aead485';
let last = 0;
async function algolia(query: string) {
  const wait = Math.max(0, last + 330 - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(`https://${APP}-dsn.algolia.net/1/indexes/beer/query`, {
    method: 'POST',
    headers: { 'X-Algolia-Application-Id': APP, 'X-Algolia-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, hitsPerPage: 5 }),
  });
  last = Date.now();
  if (!r.ok) throw new Error('http ' + r.status);
  const j: any = await r.json();
  return { n: j.nbHits as number, names: (j.hits ?? []).map((h: any) => h.beer_name) };
}

async function main() {
  const db = new Database('/var/lib/warsaw-beer-bot/bot.db', { readonly: true });
  const rows = db.prepare(`SELECT beer_id, brewery, name FROM enrich_failures
    WHERE retired_at IS NULL
      AND (brewery GLOB '*[А-Яа-яЁёІіЇїЄєҐґ]*' OR name GLOB '*[А-Яа-яЁёІіЇїЄєҐґ]*')`).all() as any[];
  let narrowed = 0, regressed = 0, unchanged = 0;
  for (const r of rows) {
    const rungs = searchQueryLadder(r.brewery, r.name);
    if (rungs.length === 1) { unchanged++; continue; }
    const narrow = await algolia(rungs[0]);
    if (narrow.n === 0) { unchanged++; continue; }          // falls back to today's query
    const wide = await algolia(rungs[1]);
    if (narrow.n < wide.n) { narrowed++; console.log(`NARROWED [${r.beer_id}] ${rungs[0]} — ${wide.n} -> ${narrow.n}: ${narrow.names[0]}`); }
    else if (narrow.n > wide.n) { regressed++; console.log(`REGRESSED [${r.beer_id}] ${rungs[0]}`); }
    else unchanged++;
  }
  console.log(`\nrows=${rows.length} narrowed=${narrowed} regressed=${regressed} unchanged/fallback=${unchanged}`);
}
main();
```

- [ ] **Step 2: Run it**

Run: `npx tsx tmp/verify-382.ts`
Expected: `narrowed` ≥ 16, `regressed` = 0. The named winners must include `Томатка`, `ЗАБІЯКА`, `Золотко` and `Сарана в Томаті`.

If `regressed` > 0, STOP and report — do not open the PR. A regression means the narrow rung is returning a *larger* pool than the wide rung, which contradicts the subset argument in design §4 and invalidates the whole approach.

- [ ] **Step 3: Record the numbers**

Paste the summary line into the PR description alongside the design doc's predicted figures, so a reviewer can see prediction vs outcome side by side.

---

## Definition of done

- [ ] `npm test` and `npm run typecheck` green
- [ ] Task 7 replay reports `regressed=0` and `narrowed >= 16`
- [ ] `spec.md` updated in the same PR (CLAUDE.md requirement)
- [ ] `extension/**` untouched — so `docs/extension-install-uk.md` needs no change; confirm with `git diff --name-only main | grep extension` returning nothing
- [ ] PR opened, AI review polled, findings assessed (never merged by the agent — the user merges)
- [ ] `./tmp/` emptied

## Post-merge operations (NOT part of the PR — see design §6)

1. Deploy, then re-arm the affected orphans so the backlog is actually re-queried.
2. Reclassify beer_id **30682** (`Дідько Brewery / Cute Cute Cute`) and **30001** (`SHO Brewery / Шо Золотко`): both are filed `not_on_untappd` and both are in fact on Untappd.
3. Comment on #381 that a crippled query produces a wrong triage *class*, with those two rows as the evidence.
4. Note on #383/the 0.14 backlog that 22 of the 55 flasker `parser_bug` rows should clear once re-armed.
