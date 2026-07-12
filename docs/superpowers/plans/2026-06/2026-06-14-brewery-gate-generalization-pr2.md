# Brewery-gate generalization PR2 (#138B brand-as-beer-name) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover orphan beers where the brand on the shelf is the input *brewery* but Untappd files the beer under a parent company, putting the brand inside the candidate *beer name* (e.g. `Murphy's` / `Murphy's Irish Stout` → `Heineken Ireland — Murphy's Irish Stout`).

**Architecture:** In `lookupBeer` (enrich path), add a third Stage-1 pool — `brandPool` — for candidates that fail BOTH the strict and PR1-relaxed brewery gates but whose **beer name contains the input brewery** (brand-in-name). Such candidates match only on an **exact** name-key intersection computed from the input name with the brewery NOT stripped (so the brand stays in the key); never fuzzy. Strict and relaxed pools are evaluated first and win.

**Tech Stack:** TypeScript, Node, Jest (ts-jest, isolatedModules), fast-fuzzy.

**Spec:** `docs/superpowers/specs/2026-06-14-brewery-gate-generalization-design.md` (§ "PR2 — brand-as-beer-name").

**Scope note:** PR2 ships ONLY the exact-name (Murphy's-class) case. The `Kwak` (extra token) and `Tradycynis` (single-token/inflection) examples are deliberately deferred per the spec. Builds on PR1 (#149/#120), already merged — `breweryAliasContained` exists and `lookupBeer` already has the strict/relaxed two-pool structure.

---

## File structure

- **Modify** `src/domain/untappd-lookup.ts` — extend the `tagged` classification with a `brand` flag + `brandPool`; widen the empty-pool `continue` guard; add the #138B exact-name stage after the relaxed-exact stage. Reuses the existing `breweryAliasContained`, `nameKeys`, `intersects`, `normalizeName`, `pickByAbv` (no new imports).
- **Modify** `src/domain/untappd-lookup.test.ts` — add 1 positive + 2 FP-guard synthetic tests.
- **Modify** `src/domain/untappd-lookup.fixtures.test.ts` — add the `murphys` real-page case.
- **Fixture** `tests/fixtures/untappd-search/murphys.html` — already committed with the spec refinement (cherry-pick that commit into the worktree).
- **Modify** `spec.md` — §5.2: extend the brewery-match-strength note with the #138B brand-in-name path.

---

## Task 1: #138B brand pool + exact-name stage in `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (the `tagged` block ~lines 100–111; after the relaxed-exact stage ~line 165)
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/untappd-lookup.test.ts`, add these three tests inside the existing `describe('lookupBeer', …)` block (the `htmlFor` helper is already at the top of the file):

```ts
  test('matched: brand-as-beer-name — input brewery sits in candidate beer name, exact name (#138B)', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 5932, name: "Murphy's Irish Stout", brewery: 'Heineken Ireland' },
        { bid: 2, name: "Mike Murphy's Irish Stout", brewery: 'Northville' },
        { bid: 3, name: 'Murphys Dry Irish Stout', brewery: 'Great Barn' },
      ]),
    );
    const out = await lookupBeer({ brewery: "Murphy's Brewery", name: "Murphy's Irish Stout", fetch });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5932);
  });

  test('not_found: brand in candidate name but the name differs (#138B FP guard)', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 2, name: "Mike Murphy's Irish Stout", brewery: 'Northville' }]),
    );
    const out = await lookupBeer({ brewery: "Murphy's Brewery", name: "Murphy's Irish Stout", fetch });
    expect(out.kind).toBe('not_found');
  });

  test('not_found: unrelated brewery shares the beer name but the brand is not in the name (#138B FP guard)', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 9, name: 'Atak Chmielu', brewery: 'Some Other Brewery' }]),
    );
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Atak Chmielu', fetch });
    expect(out.kind).toBe('not_found');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/domain/untappd-lookup.test --no-cache`
Expected: the first test (`matched: brand-as-beer-name …`) FAILS (currently `not_found` — the brewery gate rejects Heineken). The two `not_found:` FP-guard tests already pass and must STAY passing after the change.

- [ ] **Step 3: Add the `brand` classification + `brandPool`**

In `src/domain/untappd-lookup.ts`, replace this block:

```ts
    const tagged = results.map((r) => {
      const cand = breweryAliases(r.brewery_name);
      const strict = breweryAliasesMatch(cand, inputBreweryAliases);
      const relaxed =
        !strict &&
        (inputBreweryAliases.length === 0 ||
          breweryAliasContained(cand, inputBreweryAliases));
      return { r, strict, relaxed };
    });
    const strictPool = tagged.filter((t) => t.strict).map((t) => t.r);
    const relaxedPool = tagged.filter((t) => t.relaxed).map((t) => t.r);
    if (strictPool.length === 0 && relaxedPool.length === 0) continue;
```

with:

```ts
    const tagged = results.map((r) => {
      const cand = breweryAliases(r.brewery_name);
      const strict = breweryAliasesMatch(cand, inputBreweryAliases);
      const relaxed =
        !strict &&
        (inputBreweryAliases.length === 0 ||
          breweryAliasContained(cand, inputBreweryAliases));
      // #138B brand-as-beer-name: the brewery gate fails entirely, but the input
      // brewery (the shelf brand) appears as a token-run inside the candidate beer
      // name — Untappd files the beer under a parent company (Heineken Ireland —
      // Murphy's Irish Stout). Matched on an EXACT name only (Stage below).
      const brand =
        !strict &&
        !relaxed &&
        breweryAliasContained(inputBreweryAliases, [normalizeName(r.beer_name)]);
      return { r, strict, relaxed, brand };
    });
    const strictPool = tagged.filter((t) => t.strict).map((t) => t.r);
    const relaxedPool = tagged.filter((t) => t.relaxed).map((t) => t.r);
    const brandPool = tagged.filter((t) => t.brand).map((t) => t.r);
    if (strictPool.length === 0 && relaxedPool.length === 0 && brandPool.length === 0) continue;
```

- [ ] **Step 4: Add the #138B exact-name stage**

In `src/domain/untappd-lookup.ts`, find the relaxed-exact stage that ends with:

```ts
    if (relaxedExact.length > 0) return { kind: 'matched', result: pickByAbv(relaxedExact, abv) };

    // No name match in this search part — fall through to the next part.
```

Insert the #138B stage between that `return` line and the `// No name match …` comment, so it reads:

```ts
    if (relaxedExact.length > 0) return { kind: 'matched', result: pickByAbv(relaxedExact, abv) };

    // #138B brand-as-beer-name: exact name-key intersection using the input name with
    // the brewery NOT stripped (so the brand stays in the key), against candidates whose
    // beer name contains the input brand. Exact only, never fuzzy (principle A). Evaluated
    // after strict/relaxed, so a real brewery match always wins.
    const brandKeys = nameKeys(name, '');
    const brandHits = brandPool.filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), brandKeys),
    );
    if (brandHits.length > 0) return { kind: 'matched', result: pickByAbv(brandHits, abv) };

    // No name match in this search part — fall through to the next part.
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx jest src/domain/untappd-lookup.test --no-cache`
Expected: PASS — the three new tests green AND every pre-existing `lookupBeer` test still green (regression: `matched: brewery overlaps + name fuzzy >= 0.85`, `matched: token-prefix gate accepts official-suffix brewery`, `not_found: brewery hard-gate filters every candidate`, and the PR1 empty/contained-brewery tests). Then run `npx tsc --noEmit` and confirm it's clean.

- [ ] **Step 6: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "feat(enrich): match brand-as-beer-name when brewery is filed under a parent company (#138B)"
```

---

## Task 2: Real-page fixture (Murphy's)

**Files:**
- Test: `src/domain/untappd-lookup.fixtures.test.ts`
- Fixture: `tests/fixtures/untappd-search/murphys.html` (already committed with the spec refinement — confirm present in the worktree)

- [ ] **Step 1: Confirm the fixture is present**

Run: `wc -c tests/fixtures/untappd-search/murphys.html`
Expected: ~71394 bytes. If missing, the spec/fixture commit was not cherry-picked into the worktree — cherry-pick it before continuing (do NOT re-fetch from Untappd).

- [ ] **Step 2: Add the `murphys` case**

In `src/domain/untappd-lookup.fixtures.test.ts`, append a new line to the `cases` array (after the `st-feuillien` line):

```ts
  { slug: 'murphys',      brewery: "Murphy's Brewery",     name: "Murphy's Irish Stout",      bid: 5932 },    // #138B
```

- [ ] **Step 3: Run the fixtures test**

Run: `npx jest src/domain/untappd-lookup.fixtures --no-cache`
Expected: PASS — `murphys → bid 5932` matches (via the brand-in-name stage; the page's four other Murphy variants have different name-keys and are correctly rejected); all other fixture cases unchanged and green.

- [ ] **Step 4: Commit**

```bash
git add src/domain/untappd-lookup.fixtures.test.ts
git commit -m "test(enrich): real-page fixture for #138B (murphys → Heineken Ireland)"
```

---

## Task 3: Update `spec.md` §5.2

**Files:**
- Modify: `spec.md` (§5.2 brewery-match-strength note added in PR1)

- [ ] **Step 1: Locate the PR1 note**

Run: `grep -n "Сила збігу пивоварні" spec.md`
Expected: one match — the paragraph added in PR1 describing strict vs relaxed brewery-match strength. Read the paragraph and the line after it.

- [ ] **Step 2: Append the #138B path to that paragraph**

Immediately after the existing `Сила збігу пивоварні …` paragraph (the line ending `(\`/match\`-каталог поки не зачеплено.)`), add a new paragraph:

```markdown
**Brand-as-beer-name (#138B).** Якщо кандидат провалює і strict, і relaxed гейт пивоварні, але вхідна
пивоварня (бренд на полиці) є суцільним токен-підсписком **назви пива** кандидата (Untappd веде пиво під
материнською компанією — `Murphy's` → `Heineken Ireland — Murphy's Irish Stout`), він матчиться **лише** на
точний перетин name-keys, порахованих із вхідної назви **без зрізання пивоварні** (`nameKeys(name, '')` — бренд
лишається в ключі). Бренд-в-назві гейт обовʼязковий: без нього дві неповʼязані пивоварні зі спільною назвою
пива матчились би лише за назвою. Ніколи fuzzy; оцінюється після strict/relaxed (реальний збіг пивоварні завжди виграє).
```

If §5.2's formatting differs, adapt placement to fit but keep this wording. If you cannot find the PR1 paragraph, STOP and report NEEDS_CONTEXT.

- [ ] **Step 3: Verify build + full suite**

Run: `npx tsc --noEmit && npx jest`
Expected: typecheck clean; ALL suites pass.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document #138B brand-as-beer-name path in §5.2"
```

---

## Final verification (before opening the PR)

- [ ] `npx tsc --noEmit && npx jest` → all green.
- [ ] Open PR per the PR-review loop; let the AI review run; address findings.

## Self-review against the spec

- **Coverage:** #138B brand-in-name gate → Task 1 `brand` classification (`breweryAliasContained(inputBreweryAliases, [normalizeName(beer_name)])`); exact unstripped-name match → Task 1 `brandKeys = nameKeys(name, '')` + intersect; evaluated after strict/relaxed → Task 1 stage placement; real-page proof → Task 2 (`murphys` → 5932); spec doc → Task 3. Deferred Kwak/Tradycynis: not implemented (correct — they fail the exact name-key; no task).
- **No placeholders:** every code/edit step has full content.
- **Type consistency:** `brand` added to the `tagged` object alongside `strict`/`relaxed`; `brandPool` mirrors `strictPool`/`relaxedPool`; `brandKeys`/`brandHits` local; reuses existing `pickByAbv`, `breweryAliasContained`, `nameKeys`, `intersects`, `normalizeName` (all already imported — no new imports).
- **Verified values:** Murphy's input `Murphy's Brewery` / `Murphy's Irish Stout` → `Heineken Ireland — Murphy's Irish Stout` bid 5932; the FP control (`Pinta` / `Atak Chmielu` vs unrelated brewery, brand not in name) → not_found; the differing-name guard (`Mike Murphy's Irish Stout`) → not_found. All confirmed against the real page (`murphys.html`) on 2026-06-14.
