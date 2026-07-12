# Brewery-gate generalization PR1 (#149 + #120) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover orphan beers the enrich brewery hard-gate wrongly rejects, for two cases — empty input brewery (#149) and a brewery label that is a non-leading token of the real Untappd brewery (#120) — without introducing false positives.

**Architecture:** In `lookupBeer` (enrich path only), replace the single Stage-1 brewery filter with two pools: **strict** (current leading-prefix match → keeps full name path incl. fuzzy ≥0.85) and **relaxed** (empty-input bypass or contained-token brewery → may match only on an **exact** name: exact name-key intersection OR exact normalized-name equality, **never** approximate fuzzy). A new `breweryAliasContained` helper in `matcher.ts` implements the contained-token test; `breweryAliasesMatch`/`tokenPrefix` are unchanged.

**Tech Stack:** TypeScript, Node, Jest (`ts-jest`, `isolatedModules`), `fast-fuzzy`, `better-sqlite3` (not touched here).

**Spec:** `docs/superpowers/specs/2026-06-14-brewery-gate-generalization-design.md`

**Scope note:** This plan is PR1 only (#149 + #120). #138B (brand-as-beer-name) is a separate later PR per the spec.

---

## File structure

- **Modify** `src/domain/matcher.ts` — add exported `breweryAliasContained(a, b)` + module-private `tokenSublist(a, b)`, next to `tokenPrefix`/`breweryAliasesMatch`. Nothing existing changes.
- **Modify** `src/domain/matcher.test.ts` — add a `describe('breweryAliasContained')` block.
- **Modify** `src/domain/untappd-lookup.ts` — two-pool Stage 1 + relaxed exact-name branch + a module-private `pickByAbv` helper; add `breweryAliasContained` to the `./matcher` import.
- **Modify** `src/domain/untappd-lookup.test.ts` — add 2 positive + 2 FP-guard synthetic tests.
- **Modify** `src/domain/untappd-lookup.fixtures.test.ts` — flip `staropolski` to its real bid; add the `st-feuillien` case.
- **Fixture** `tests/fixtures/untappd-search/st-feuillien.html` — real captured page (already committed alongside this plan; cherry-pick that commit into the worktree).
- **Modify** `spec.md` — §5.2 matching invariants: document brewery-match strength + the relaxed-exact rule.

---

## Task 1: `breweryAliasContained` helper in `matcher.ts`

**Files:**
- Modify: `src/domain/matcher.ts` (add after `breweryAliasesMatch`, ~line 125)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/domain/matcher.test.ts`, add `breweryAliasContained` to the existing import from `'./matcher'` (top of file), then add this block after the `breweryAliasesMatch` tests:

```ts
describe('breweryAliasContained', () => {
  test('trailing token matches (#120 Staropolski)', () => {
    expect(breweryAliasContained(['kultowy staropolski'], ['staropolski'])).toBe(true);
  });
  test('leading prefix also counts as contained', () => {
    expect(breweryAliasContained(['harpagan craft'], ['harpagan'])).toBe(true);
  });
  test('contiguous middle run matches', () => {
    expect(breweryAliasContained(['pure project park brewing'], ['project park'])).toBe(true);
  });
  test('non-contiguous tokens do not match', () => {
    expect(breweryAliasContained(['pure project park'], ['pure park'])).toBe(false);
  });
  test('unrelated breweries do not match', () => {
    expect(breweryAliasContained(['stu mostow'], ['pinta'])).toBe(false);
  });
  test('empty alias never matches', () => {
    expect(breweryAliasContained(['kultowy staropolski'], [''])).toBe(false);
    expect(breweryAliasContained([], ['staropolski'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/matcher --no-cache -t breweryAliasContained`
Expected: FAIL — `breweryAliasContained is not a function` (or import error).

- [ ] **Step 3: Write the implementation**

In `src/domain/matcher.ts`, immediately after the `breweryAliasesMatch` function (after line ~125), add:

```ts
// True if the shorter token list appears as a CONTIGUOUS run anywhere within the
// longer. Generalizes tokenPrefix (which requires a *leading* run) to any position.
function tokenSublist(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => t === long[i + j])) return true;
  }
  return false;
}

// True if any alias from one side is a contiguous token-sublist of any alias from
// the other (either direction). Looser than breweryAliasesMatch (leading-prefix):
// the RELAXED brewery gate for #120, used only when paired with an exact name match.
// breweryAliasesMatch / tokenPrefix are unchanged.
export function breweryAliasContained(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => tokenSublist(x, y)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/matcher --no-cache`
Expected: PASS — all matcher tests green (existing + new `breweryAliasContained` block).

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): add breweryAliasContained (contiguous token-sublist) for relaxed brewery gate (#120)"
```

---

## Task 2: Two-pool Stage 1 + relaxed exact-name in `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (import line 2; Stage 1–2b block, lines ~84–135; add module helper)
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/untappd-lookup.test.ts`, add these four tests inside the existing `describe('lookupBeer', …)` block (the `htmlFor` helper at the top of the file is already present):

```ts
  test('matched: empty input brewery → exact name bypasses gate (#149)', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 22540, name: 'St-Feuillien Blonde', brewery: 'Brasserie St-Feuillien' },
        { bid: 999, name: 'Bière Léon', brewery: 'Chez Léon 1893' },
      ]),
    );
    const out = await lookupBeer({ brewery: '', name: 'St-Feuillien Blonde', fetch });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(22540);
  });

  test('matched: contained (trailing) brewery token + exact name (#120)', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 1673808, name: 'Kultowe Pils', brewery: 'Kultowy Browar Staropolski' },
        { bid: 2, name: 'Rodowite Pils', brewery: 'Kultowy Browar Staropolski' },
      ]),
    );
    const out = await lookupBeer({ brewery: 'Staropolski', name: 'KULTOWE PILS', fetch });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1673808);
  });

  test('not_found: relaxed brewery + approximate (not exact) name is NOT fuzzy-matched (#120 FP guard)', async () => {
    // fuzzy('imperial stout reserve','imperial stout reserva') = 0.955, but the brewery
    // only matches via the relaxed contained-token path, so an EXACT name is required.
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 77, name: 'Imperial Stout Reserva', brewery: 'Kultowy Browar Staropolski' },
      ]),
    );
    const out = await lookupBeer({ brewery: 'Staropolski', name: 'Imperial Stout Reserve', fetch });
    expect(out.kind).toBe('not_found');
  });

  test('not_found: empty brewery + different name → no match (#149 FP guard)', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 5, name: 'Completely Different Beer', brewery: 'Some Brewery' }]),
    );
    const out = await lookupBeer({ brewery: '', name: 'St-Feuillien Blonde', fetch });
    expect(out.kind).toBe('not_found');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/domain/untappd-lookup.test --no-cache`
Expected: the two new `matched:` tests FAIL (currently `not_found` — gate rejects empty/contained brewery). The two `not_found:` FP-guard tests already pass (today the gate rejects them too); they must STAY green after the change.

- [ ] **Step 3: Update the import**

In `src/domain/untappd-lookup.ts`, line 2, add `breweryAliasContained` to the `./matcher` import:

```ts
import { breweryAliases, breweryAliasesMatch, breweryAliasContained, ABV_TOLERANCE, COLLAB_SEP, nameKeys, intersects, stripLeadingBrewery } from './matcher';
```

- [ ] **Step 4: Add the `pickByAbv` module helper**

In `src/domain/untappd-lookup.ts`, add this just above `export async function lookupBeer` (after the `LookupArgs` interface, ~line 30):

```ts
// Among equally-valid name matches, prefer one whose ABV is within tolerance of the
// input's; otherwise the first (results are latest-first from the search page).
function pickByAbv(results: SearchResult[], abv: number | null): SearchResult {
  if (abv != null) {
    const hit = results.find((r) => r.abv != null && Math.abs(r.abv - abv) <= ABV_TOLERANCE);
    if (hit) return hit;
  }
  return results[0];
}
```

- [ ] **Step 5: Replace the Stage 1–2b block**

In `src/domain/untappd-lookup.ts`, replace the entire block from `// Stage 1: brewery hard-gate` through the final `return { kind: 'matched', result: matches[0].item };` (lines ~84–135) with:

```ts
    // Stage 1: brewery-match strength. Each result is `strict` (leading-prefix
    // overlap — full name path incl. fuzzy) or `relaxed` (#149 empty-input bypass /
    // #120 contained non-leading brewery token — EXACT name only, never approximate
    // fuzzy). breweryAliasesMatch is recomputed once per result here.
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

    // Stage 2a: exact name-key intersection (order-insensitive, collab/bilingual
    // aware) on strict ∪ relaxed.
    const inputKeys = nameKeys(name, brewery);
    const keyHits = [...strictPool, ...relaxedPool].filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), inputKeys),
    );
    if (keyHits.length > 0) return { kind: 'matched', result: pickByAbv(keyHits, abv) };

    // Stage 2b: name fuzzy >= 0.85 — STRICT pool only (a relaxed brewery never
    // matches via approximate fuzzy).
    if (strictPool.length > 0) {
      const searcher = new Searcher(strictPool, {
        keySelector: (r) => normalizeName(r.beer_name),
        threshold: NAME_FUZZY_THRESHOLD,
        returnMatchData: true,
      });
      const matches = targetNames
        .flatMap((targetName) =>
          searcher
            .search(targetName.value)
            .filter(
              (m) => !targetName.exactOnly || normalizeName(m.item.beer_name) === targetName.value,
            ),
        )
        .sort((a, b) => b.score - a.score);
      if (matches.length > 0) {
        // ABV tiebreak: normalizeName strips vintage years, so different-year /
        // different-strength variants collapse to identical names and tie at the top
        // score. ABV is the only separating signal among the equally-scored top matches.
        const topScore = matches[0].score;
        if (abv != null) {
          const abvHit = matches.find(
            (m) =>
              m.score === topScore &&
              m.item.abv != null &&
              Math.abs(m.item.abv - abv) <= ABV_TOLERANCE,
          );
          if (abvHit) return { kind: 'matched', result: abvHit.item };
        }
        return { kind: 'matched', result: matches[0].item };
      }
    }

    // Relaxed pool: EXACT normalized-name equality only (never approximate fuzzy).
    // Recovers names that collapse below the key path — e.g. `KULTOWE PILS` → `kultowe`
    // (style-word dropped), `St-Feuillien Blonde` (candidate strips its embedded brewery).
    const relaxedExact = relaxedPool.filter((r) =>
      targetNames.some((t) => normalizeName(r.beer_name) === t.value),
    );
    if (relaxedExact.length > 0) return { kind: 'matched', result: pickByAbv(relaxedExact, abv) };

    // No name match in this search part — fall through to the next part.
```

(The `for (const part of parts)` loop continues to its end and ultimately returns `{ kind: 'not_found', … }` as before.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/domain/untappd-lookup.test --no-cache`
Expected: PASS — all four new tests green AND every pre-existing `lookupBeer` test still green (strict-path regression check: `matched: brewery overlaps + name fuzzy >= 0.85`, `matched: token-prefix gate accepts official-suffix brewery`, `not_found: brewery hard-gate filters every candidate`, etc.).

- [ ] **Step 7: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "feat(enrich): relax brewery gate for empty (#149) + contained-token (#120) breweries, exact-name only"
```

---

## Task 3: Real-page fixtures (flip Staropolski, add St-Feuillien)

**Files:**
- Test: `src/domain/untappd-lookup.fixtures.test.ts`
- Fixture: `tests/fixtures/untappd-search/st-feuillien.html` (already committed with this plan — confirm it is present in the worktree)

- [ ] **Step 1: Confirm the fixture is present**

Run: `wc -c tests/fixtures/untappd-search/st-feuillien.html`
Expected: ~71153 bytes. If missing, the plan/fixture commit was not cherry-picked into the worktree — cherry-pick it before continuing (do NOT re-fetch from Untappd).

- [ ] **Step 2: Update the fixtures test (this is both the "failing test" edit and its data)**

In `src/domain/untappd-lookup.fixtures.test.ts`, change the `staropolski` row and add a `st-feuillien` row in the `cases` array:

```ts
  { slug: 'staropolski',  brewery: 'Staropolski',         name: 'KULTOWE PILS',              bid: 1673808 }, // #120 fixed
  { slug: 'st-feuillien', brewery: '',                    name: 'St-Feuillien Blonde',       bid: 22540 },   // #149
```

(Replace the existing `{ slug: 'staropolski', …, bid: null }, // deferred #120` line; append the `st-feuillien` line.)

- [ ] **Step 3: Run the fixtures test**

Run: `npx jest src/domain/untappd-lookup.fixtures --no-cache`
Expected: PASS — `staropolski → bid 1673808` and `st-feuillien → bid 22540` both match; all other fixture cases unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/domain/untappd-lookup.fixtures.test.ts
git commit -m "test(enrich): real-page fixtures for #120 (staropolski) + #149 (st-feuillien)"
```

---

## Task 4: Update `spec.md` §5.2

**Files:**
- Modify: `spec.md` (§5.2 matching invariants — brewery hard-gate description)

- [ ] **Step 1: Locate the brewery hard-gate invariant**

Run: `grep -n "brewery hard-gate\|breweryAliasesMatch\|Гейтинг\|leading-prefix\|провідний префікс" spec.md`
Expected: lines around §5.2 / the matching-invariants appendix that describe the leading-prefix-only brewery gate (e.g. the #120 gotcha note).

- [ ] **Step 2: Add the brewery-match-strength note**

In the §5.2 region, after the existing description of the strict leading-prefix gate, add a paragraph (match the file's Ukrainian style):

```markdown
**Сила збігу пивоварні (enrich, `lookupBeer`).** Stage-1 розрізняє **strict** (провідний-префікс
`breweryAliasesMatch` — повний шлях назви, включно з fuzzy ≥0.85) та **relaxed** збіг пивоварні:
порожня вхідна пивоварня (#149, гейт оминається) або вхідний аліас як **непровідний** суцільний
токен-підсписок аліаса кандидата (#120, `breweryAliasContained`). Relaxed-збіг матчиться **лише на
точну назву** — перетин name-keys АБО точна рівність нормалізованих назв — і **ніколи** на
наближений fuzzy (≥0.85, але <1.0). Strict-шлях незмінний. (`/match`-каталог поки не зачеплено.)
```

- [ ] **Step 3: Verify build + full suite still green**

Run: `npx tsc --noEmit && npx jest`
Expected: typecheck clean; all suites pass.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document relaxed brewery-match strength in §5.2 (#149/#120)"
```

---

## Final verification (before opening the PR)

- [ ] Run the whole suite + typecheck: `npx tsc --noEmit && npx jest` → all green.
- [ ] Sanity bench against prod (read-only), optional: re-run the orphan repro for these two beers per `docs/debug-orphan-matching.md` step 3 if a live check is wanted.
- [ ] Open PR per the PR-review loop; let the AI review run; address findings.

## Self-review against the spec

- **Coverage:** #149 (empty brewery) → Task 2 empty-input bypass + Task 2/3 tests; #120 (contained token) → Task 1 helper + Task 2 wiring + Task 3 fixture; FP-safety "relaxed ⇒ exact name, never approximate fuzzy" → Task 2 control flow + the `Reserve/Reserva` guard test; spec.md update → Task 4. #138B explicitly out of PR1 (separate plan).
- **No placeholders:** every code/edit step contains the full content.
- **Type consistency:** `breweryAliasContained(a: string[], b: string[]): boolean` defined Task 1, imported + called Task 2; `pickByAbv(results: SearchResult[], abv: number | null): SearchResult` defined and used Task 2; `tokenSublist` is module-private to `matcher.ts`. `SearchResult` is already imported in `untappd-lookup.ts`.
- **Verified values:** Staropolski `Kultowe Pils` = bid 1673808; St-Feuillien `St-Feuillien Blonde` = bid 22540; `fuzzy('imperial stout reserve','imperial stout reserva')` = 0.955 (FP guard relies on it being <1.0, i.e. not exact). All confirmed against the real pages on 2026-06-14.
