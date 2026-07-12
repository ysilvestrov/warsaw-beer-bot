# Match Perf: Per-Request Catalog Preparation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /match` return a 48-beer batch in ~1 s (down from ~10 s) with byte-for-byte identical match results, by preparing the catalog (normalizations + fuzzy index) once per request instead of once per input beer.

**Architecture:** Split the expensive, input-independent catalog work out of the per-beer matcher. `prepareCatalog(catalog)` precomputes each row's normalized name/brewery/aliases and exposes a lazily-built, memoized full-catalog `Searcher`. `matchPrepared(input, prepared)` runs the existing matching logic verbatim against the prepared data. `matchBeer(input, catalog)` stays as a back-compat wrapper (`matchPrepared(input, prepareCatalog(catalog))`). `matchBeerList` and the two background jobs prepare once and loop `matchPrepared`.

**Tech Stack:** TypeScript, `fast-fuzzy` (`Searcher`), Jest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-06-08-match-perf-prepare-catalog-design.md`

---

### Task 1: Add `prepareCatalog` + `matchPrepared` to `matcher.ts`, make `matchBeer` a wrapper

This is a behavior-preserving refactor. The existing `matcher.test.ts` suite is the regression guard — it must stay green unchanged. We move the per-beer normalization and Searcher construction into a per-catalog preparation step.

**Files:**
- Modify: `src/domain/matcher.ts`
- Test: `src/domain/matcher.test.ts` (existing suite must still pass; new cases added in Task 2/3)

- [ ] **Step 1: Add prepared types + builder helper above `matchBeer`**

Insert after the `MatchResult` interface / constants block (around `src/domain/matcher.ts:18`), before `matchBeer`:

```ts
// A catalog row with its normalizations precomputed once, so a batch of input
// beers does not re-normalize the whole catalog per beer.
export interface PreparedBeer extends CatalogBeer {
  nameNorm: string;     // normalizeName(name)
  breweryNorm: string;  // normalizeBrewery(brewery)
  aliases: string[];    // breweryAliases(brewery)
}

function defaultBuildSearcher(rows: PreparedBeer[]) {
  return new Searcher(rows, {
    keySelector: (c) => `${c.breweryNorm} ${c.nameNorm}`,
    threshold: FUZZY_THRESHOLD,
    returnMatchData: true,
  });
}

type PreparedSearcher = ReturnType<typeof defaultBuildSearcher>;

// Build-once-per-request prepared catalog. `fullSearcher()` is memoized and built
// lazily — only the first empty-pool fuzzy fallback in a batch constructs the
// 20k-row index; if no beer falls through, it is never built.
export interface PreparedCatalog {
  beers: PreparedBeer[];
  searcherFor(rows: PreparedBeer[]): PreparedSearcher;
  fullSearcher(): PreparedSearcher;
}

// `build` is injectable purely so tests can observe Searcher construction; the
// default is the production builder.
export function prepareCatalog(
  catalog: CatalogBeer[],
  build: (rows: PreparedBeer[]) => PreparedSearcher = defaultBuildSearcher,
): PreparedCatalog {
  const beers: PreparedBeer[] = catalog.map((c) => ({
    ...c,
    nameNorm: normalizeName(c.name),
    breweryNorm: normalizeBrewery(c.brewery),
    aliases: breweryAliases(c.brewery),
  }));
  let full: PreparedSearcher | undefined;
  return {
    beers,
    searcherFor: build,
    fullSearcher: () => (full ??= build(beers)),
  };
}
```

- [ ] **Step 2: Add `matchPrepared` (the current `matchBeer` body, reading prepared fields)**

Replace the entire existing `matchBeer` function (`src/domain/matcher.ts:72-167`) with `matchPrepared` plus a thin `matchBeer` wrapper. The matching logic is copied verbatim; only the catalog-field accesses change (`c.nameNorm`/`c.aliases` instead of `normalizeName(c.name)`/`breweryAliases(c.brewery)`), and Searcher construction uses the prepared builder.

```ts
export function matchPrepared(
  input: { brewery: string; name: string; abv?: number | null },
  prepared: PreparedCatalog,
): MatchResult | null {
  const inputAliases = breweryAliases(input.brewery);
  const nn = normalizeName(input.name);
  const catalog = prepared.beers;

  // Exact-normalized hits — multiple rows are common when Untappd has
  // several vintages of the same beer. Latest id first.
  const exacts = catalog
    .filter(
      (c) =>
        breweryAliasesMatch(c.aliases, inputAliases) &&
        c.nameNorm === nn,
    )
    .sort((a, b) => b.id - a.id);

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
    // exacts is already sorted id DESC so each filtered array preserves that order.
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

      const abvHit =
        noYear.find((c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE) ??
        wrongYear.find((c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE);
      if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };

      return { id: candidate.id, confidence: 1, source: 'exact' };
    }

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

  // Fuzzy fallback: prefer rows whose brewery aliases overlap the input's,
  // otherwise the full catalog (shared, lazily-built Searcher).
  const pool = catalog.filter((c) => breweryAliasesMatch(c.aliases, inputAliases));
  const searcher = pool.length ? prepared.searcherFor(pool) : prepared.fullSearcher();
  const seedBrewery = inputAliases[0] ?? '';
  const results = searcher.search(`${seedBrewery} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}

// Back-compat single-beer entry point. Prepares the catalog per call, so callers
// that match many beers should call prepareCatalog once and loop matchPrepared.
export function matchBeer(
  input: { brewery: string; name: string; abv?: number | null },
  catalog: CatalogBeer[],
): MatchResult | null {
  return matchPrepared(input, prepareCatalog(catalog));
}
```

- [ ] **Step 3: Run the existing matcher suite — must stay green unchanged**

Run: `npx jest src/domain/matcher.test.ts`
Expected: PASS, same number of tests as before (the refactor preserves behavior). If any case fails, the copy was not verbatim — diff against git HEAD and fix.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts
git commit -m "refactor(matcher): split prepareCatalog/matchPrepared from per-beer matchBeer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `matchBeerList` prepares once + equivalence regression test

Proves the per-request optimization moves no match: a beer matched inside a batch returns the same result as matching it alone.

**Files:**
- Modify: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts`

- [ ] **Step 1: Write the failing equivalence test**

Append to `src/domain/match-list.test.ts`:

```ts
import { matchBeer } from './matcher';

describe('matchBeerList — prepare-once equivalence', () => {
  const bigCatalog: CatalogBeerWithRating[] = [
    { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
    { id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0, rating_global: 3.5 },
    { id: 3, brewery: 'Piwne Podziemie', name: 'Hopinka', abv: 6.0, rating_global: 3.6 },
    { id: 4, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85 },
    { id: 5, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.5, rating_global: 3.7 },
  ];

  const inputs = [
    { brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 },   // exact + abv
    { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },          // exact, no abv
    { brewery: 'Piwne Podziemie Brewery', name: 'Hopinka' },  // noise-word brewery
    { brewery: 'Stu Mostow', name: 'Buty Skejt' },            // fuzzy
    { brewery: 'Nowhere', name: 'Totally Unknown Stout' },    // no match
  ];

  it('per-batch result equals matching each beer alone', () => {
    const batch = matchBeerList(bigCatalog, new Set(), new Map(), inputs);
    inputs.forEach((input, i) => {
      const solo = matchBeer(input, bigCatalog);
      expect(batch[i].matched_beer?.id ?? null).toBe(solo?.id ?? null);
    });
  });
});
```

- [ ] **Step 2: Run it — expect PASS (characterization)**

Run: `npx jest src/domain/match-list.test.ts -t "prepare-once"`
Expected: PASS. This is a characterization test: at this point `matchBeerList` still loops `matchBeer`, so it trivially equals matching each beer alone. It locks the behavior we must preserve when we switch the implementation in Step 3.

- [ ] **Step 3: Switch `matchBeerList` to prepare once**

In `src/domain/match-list.ts`, change the import and the body:

```ts
import { matchPrepared, prepareCatalog, type CatalogBeer } from './matcher';
```

Inside `matchBeerList`, before the `items.map`, add the prepared catalog and use `matchPrepared`:

```ts
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const prepared = prepareCatalog(catalog);
  return items.map((item) => {
    const raw = { brewery: item.brewery, name: item.name };
    const m = matchPrepared(item, prepared);
```

(Leave the rest of the `.map` body unchanged. The unused `matchBeer` import is removed.)

- [ ] **Step 4: Run the equivalence + existing match-list tests — expect PASS**

Run: `npx jest src/domain/match-list.test.ts`
Expected: PASS (all existing cases + new equivalence).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (expect no errors), then:

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "perf(match): matchBeerList prepares catalog once per request

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Lazy + memoized `fullSearcher` test

Confirms the 20k-row full-catalog index is built only when an empty-pool fallback needs it, and at most once per request.

**Files:**
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/matcher.test.ts` (the file already imports from `./matcher`; add `prepareCatalog`, `matchPrepared` to that import):

```ts
import { prepareCatalog, matchPrepared } from './matcher';

describe('prepareCatalog — lazy/memoized fullSearcher', () => {
  const cat: CatalogBeer[] = [
    c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 }),
    c({ id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0 }),
  ];

  it('does not build any Searcher when every beer matches exactly', () => {
    const build = jest.fn((rows) => prepareCatalog(rows).searcherFor(rows));
    const prepared = prepareCatalog(cat, build);
    matchPrepared({ brewery: 'Pinta', name: 'Atak Chmielu' }, prepared);
    expect(build).not.toHaveBeenCalled();
  });

  it('builds the full-catalog Searcher at most once across empty-pool fallbacks', () => {
    const build = jest.fn((rows) => prepareCatalog(rows).searcherFor(rows));
    const prepared = prepareCatalog(cat, build);
    // Two unknown breweries → empty pool → full-catalog fallback, twice.
    matchPrepared({ brewery: 'Nowhere', name: 'Mystery One' }, prepared);
    matchPrepared({ brewery: 'Elsewhere', name: 'Mystery Two' }, prepared);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
```

Note: the `jest.fn` wrapper calls `prepareCatalog(rows).searcherFor(rows)` to get a real Searcher from the default builder without importing internals.

- [ ] **Step 2: Run it — expect PASS**

Run: `npx jest src/domain/matcher.test.ts -t "lazy/memoized"`
Expected: PASS (implemented in Task 1). If the first case fails (build called on exact match) the exact path is wrongly constructing a Searcher — revisit Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add src/domain/matcher.test.ts
git commit -m "test(matcher): fullSearcher is lazy and memoized per request

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Migrate background jobs to prepare-once

Same per-beer rebuild bug in the two job loops. Hoist `prepareCatalog` out of the loop; switch the loop body to `matchPrepared`. Behavior-preserving.

**Files:**
- Modify: `src/jobs/refresh-ontap.ts:70-73`
- Modify: `src/jobs/cleanup-polluted-ontap.ts:47-59`

- [ ] **Step 1: refresh-ontap — prepare once before the taps loop**

In `src/jobs/refresh-ontap.ts`, change the import on line 11 from `matchBeer` to `matchPrepared, prepareCatalog`:

```ts
import { matchPrepared, prepareCatalog } from '../domain/matcher';
```

Replace lines 70-73:

```ts
      const catalog = listBeerCatalog(db);
      const prepared = prepareCatalog(catalog);
      for (const t of taps) {
        const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
        const m = matchPrepared({ brewery, name: t.beer_ref, abv: t.abv }, prepared);
```

(`normalizeName`/`normalizeBrewery` are still imported and used later in the orphan-insert branch — leave those imports.)

- [ ] **Step 2: cleanup-polluted-ontap — prepare the clean pool once before the loop**

In `src/jobs/cleanup-polluted-ontap.ts`, change the import on line 4 from `matchBeer, type CatalogBeer` to:

```ts
import { matchPrepared, prepareCatalog, type CatalogBeer } from '../domain/matcher';
```

After the `pool` is computed (line 50) and before the `for (const p of polluted)` loop, add:

```ts
  const pool = cleanPool.filter((c) => !pollutedIds.has(c.id));
  const preparedPool = prepareCatalog(pool);
```

Replace line 59:

```ts
    const match = matchPrepared({ brewery: p.brewery, name: cleaned, abv: p.abv }, preparedPool);
```

- [ ] **Step 3: Run the job tests + typecheck**

Run: `npx jest src/jobs && npx tsc --noEmit`
Expected: PASS, no type errors. (If there are no job tests for these files, the typecheck + full suite in Task 6 is the guard.)

- [ ] **Step 4: Commit**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/cleanup-polluted-ontap.ts
git commit -m "perf(jobs): prepare catalog once per run in refresh/cleanup ontap loops

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Benchmark script (manual, not CI)

A measurement harness to confirm ~10 s → ~1 s against the real prod DB, read-only.

**Files:**
- Create: `scripts/bench-match.ts`

- [ ] **Step 1: Write the script**

```ts
// Manual benchmark — NOT part of CI. Measures matchBeerList over a real payload
// against the prod DB (read-only). Run:
//   npx tsx scripts/bench-match.ts /var/lib/warsaw-beer-bot/bot.db /home/ysi/warsaw-beer-bot/input.json
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/storage/beers';
import { matchBeerList } from '../src/domain/match-list';

const [dbPath, jsonPath] = process.argv.slice(2);
if (!dbPath || !jsonPath) {
  console.error('usage: bench-match.ts <db-path> <input.json>');
  process.exit(1);
}

// input.json has a stray trailing `1` after the JSON — slice to the last `}`.
const raw = readFileSync(jsonPath, 'utf8');
const json = raw.slice(0, raw.lastIndexOf('}') + 1);
const parsed = JSON.parse(json);
const beers: { brewery: string; name: string; abv?: number }[] =
  Array.isArray(parsed) ? parsed : parsed.beers;

const db = new Database(dbPath, { readonly: true });
const catalog = loadCatalog(db);

const t0 = performance.now();
const results = matchBeerList(catalog, new Set(), new Map(), beers);
const ms = performance.now() - t0;

const matched = results.filter((r) => r.matched_beer !== null).length;
console.log(`catalog=${catalog.length} beers=${beers.length}`);
console.log(`total=${ms.toFixed(0)}ms  perBeer=${(ms / beers.length).toFixed(1)}ms  matched=${matched}/${beers.length}`);
db.close();
```

- [ ] **Step 2: Typecheck the script is included in the project tsconfig (or skip if scripts/ is excluded)**

Run: `npx tsc --noEmit`
Expected: no errors. If `scripts/` is excluded from `tsconfig.json`, that is fine — the script runs via `tsx`.

- [ ] **Step 3: (Optional, manual) Run against prod DB read-only and record numbers**

Run: `npx tsx scripts/bench-match.ts /var/lib/warsaw-beer-bot/bot.db /home/ysi/warsaw-beer-bot/input.json`
Expected: `total` ≈ 1000 ms (was ~10,176 ms), `matched` unchanged from the pre-refactor count (29/48). If `matched` differs, STOP — correctness regressed.

- [ ] **Step 4: Commit**

```bash
git add scripts/bench-match.ts
git commit -m "chore(bench): scripts/bench-match.ts — measure /match matcher over prod DB

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full suite, spec.md review, finish

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all green (the 52 existing + 2 new tests).

- [ ] **Step 2: Review `spec.md` for any /match performance/behavior note**

Run: `grep -n "match\|Searcher\|performance\|prepareCatalog" spec.md`
The public `/match` contract and results are unchanged, so no edit is expected. If `spec.md` documents matcher internals or a perf characteristic that this changes, update that section in this PR (per CLAUDE.md). If nothing relevant, note "no spec change needed" in the PR description.

- [ ] **Step 3: Final typecheck + lint**

Run: `npx tsc --noEmit` and the project's lint command if one exists (`npm run lint`).
Expected: clean.

- [ ] **Step 4: Commit any spec.md change (if made)**

```bash
git add spec.md
git commit -m "docs(spec): note /match per-request catalog preparation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Cardinal rule:** match correctness must not change. A false "ти це пив" is the worst bug. The existing `matcher.test.ts` suite + the Task 2 equivalence test are the guards — never weaken them to make a refactor pass.
- The matching logic in `matchPrepared` is copied verbatim from the old `matchBeer`; only field access (`c.nameNorm`/`c.aliases`) and Searcher construction change. If tempted to "improve" the logic, don't — that is a separate change.
- `prepareCatalog`'s `build` parameter exists only as a test seam; production always uses the default builder.
- Non-blocking `/match` (worker thread / async-yield) is explicitly out of scope — queued as a separate follow-up.
