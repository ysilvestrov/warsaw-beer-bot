# #487 — Flagship Dominance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ABV from choosing between different products, and let a dominant flagship match a name that carries nothing beyond the brewery brand.

**Architecture:** Four changes in dependency order. (1) `rating_count` is carried through the search seam as an optional field, so "no popularity" is distinguishable from "zero ratings". (2) A new pure module `src/domain/rating-dominance.ts` answers one question — does one candidate dominate this list, and does ABV allow it. (3) The native near-name pick site, the one place a *multi*-candidate decision is made on approximate name evidence, asks that question instead of asking ABV. (4) A terminal stage, reached only after every existing stage has missed, applies the same question to a bare-brand target.

**Tech Stack:** TypeScript (CommonJS, `tsc`), Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-25-487-flagship-dominance-design.md`

## Global Constraints

- **Stage 2a is not touched.** `pickByAbv` and its call sites (`untappd-lookup.ts:406`, `:481`, `:537`, `:562`) keep ABV as their selector. Measured: 32 of 32 ABV-picks-among-many in a 400-beer replay happen there, and they are vintages of one beer (`Zwanze 2026`, `Geuze Mariage Parfait (2020)`, `May Hill 2024`). Applying dominance there orphans 19 of them. If `git diff` shows `pickByAbv` changed, that is a defect.
- **The three exact-key `pickUniqueByAbv` call sites are not touched** — identity aliases (`:486`), native name keys (`:495`), brand remainder (`:525`). Only the near-name site (`:510`) changes. Same reason as above: those pools are built from exact keys.
- **`rating_count` is optional, and absent never means zero.** `htmlSearch` (legacy relay) and `web-fallback.ts:98` produce results without it. A missing count must make a candidate *ineligible* to be a flagship, never a candidate with 0 ratings that some other candidate trivially dominates.
- **The ABV veto never promotes the runner-up.** If the leader's ABV contradicts the input, the answer is "no flagship", not "the next one". Promoting the runner-up would rebuild the very defect this issue is about.
- **Both constants stay named and in one place:** `DOMINANCE_RATIO = 5`, `FLAGSHIP_MIN_RATINGS = 1000`. Do not inline them, do not tune them to make a test pass.
- **`ABV_TOLERANCE` is imported from `./matcher`, never re-declared.** The comparison is `Math.abs(diff) > ABV_TOLERANCE` (strictly greater), matching every existing ABV check — `Breznak` depends on it: 5.1 vs 4.8 is exactly `0.3` and must NOT be a contradiction.
- **The new terminal stage must stay terminal.** It sits after the Czech-grade stage and before the final `return typoRescue()`. It is what makes "cannot change an existing match" true by construction. Do not hoist it.
- **Every new test is mutation-proven:** revert the production line it defends, watch the test go red, restore it. Each task names the exact line.
- **`spec.md` IS touched** (Task 5) — CLAUDE.md requires it in the same PR. `extension/**` is NOT touched, so `docs/extension-install-uk.md` needs no change.
- Full suite: `npm test`. Type check: `npm run typecheck`. One file: `npx vitest run <path>`.
- **Commit location guard.** Before the first commit in any task, run `git rev-parse --show-toplevel && git branch --show-current` and confirm the toplevel is this feature's worktree, not `/home/ysi/warsaw-beer-bot`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/sources/untappd/search.ts` | `SearchResult` / `HydratedBeer` shape — the transport-agnostic candidate record. | 1 |
| `src/sources/untappd/algolia.ts` | Algolia record → `SearchResult`. The only place `rating_count` enters the system. | 1 |
| `src/sources/untappd/algolia.test.ts` | Parser tests. | 1 |
| `src/domain/rating-dominance.ts` | **New.** The dominance question and its two constants. Pure, no I/O, no knowledge of stages. | 2 |
| `src/domain/rating-dominance.test.ts` | **New.** Unit tests for the above. | 2 |
| `src/domain/untappd-lookup.ts` | The match stages. Two edits: the near-name pick (Task 3), the terminal flagship stage (Task 4). | 3, 4 |
| `src/domain/untappd-lookup.flagship.test.ts` | **New.** Row-level tests built from live Algolia candidate lists captured 2026-08-25. | 3, 4 |
| `spec.md` | Ships with the behaviour change. | 5 |

## Shared test fixtures

Tasks 3 and 4 use one fixture file. **Create it in full in Task 3, Step 1** — Task 4 adds tests to the same file but does not re-create it. Every list below is a real Algolia response captured on 2026-08-25, trimmed to nothing; the current code's behaviour on each has been verified offline (stated per task as "Expected: FAIL …").

---

### Task 1: Carry `rating_count` through the search seam

Nothing changes behaviour here. This task exists so Tasks 2-4 have a signal to read, and so the relay path gets it for free (`enrich.ts:282` shares this parser).

**Files:**
- Modify: `src/sources/untappd/search.ts:5-19` (`SearchResult`, `HydratedBeer`)
- Modify: `src/sources/untappd/algolia.ts:5-14` (`AlgoliaHit`), `:39-56` (`parseAlgoliaResponse`), `:64-78` (`parseHydratedBeer`)
- Test: `src/sources/untappd/algolia.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SearchResult.rating_count?: number` — how many Untappd users have rated the beer. Absent when the transport does not supply it.

- [ ] **Step 1: Write the failing test**

Append to `src/sources/untappd/algolia.test.ts`:

```ts
describe('rating_count (#487)', () => {
  test('parseAlgoliaResponse carries rating_count from the hit', () => {
    const out = parseAlgoliaResponse({
      hits: [
        { bid: 4473, beer_name: 'Guinness Draught', brewery_name: 'Guinness', type_name: 'Stout - Irish Dry', beer_abv: 4.2, rating_score: 3.77, rating_count: 992660 },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].rating_count).toBe(992660);
  });

  test('parseAlgoliaResponse leaves rating_count undefined when the hit has none', () => {
    const out = parseAlgoliaResponse({
      hits: [{ bid: 1, beer_name: 'X', brewery_name: 'Y', type_name: 'IPA', beer_abv: 5, rating_score: 3 }],
    });
    // Absent must stay absent: a 0 here would make every other candidate
    // trivially "dominant" over this one.
    expect(out[0].rating_count).toBeUndefined();
  });

  test('parseAlgoliaResponse ignores a non-numeric rating_count', () => {
    const out = parseAlgoliaResponse({
      hits: [{ bid: 1, beer_name: 'X', brewery_name: 'Y', type_name: 'IPA', beer_abv: 5, rating_score: 3, rating_count: 'lots' }],
    });
    expect(out[0].rating_count).toBeUndefined();
  });

  test('parseHydratedBeer carries rating_count', () => {
    const out = parseHydratedBeer({
      bid: 4473, beer_name: 'Guinness Draught', brewery_name: 'Guinness', type_name: 'Stout - Irish Dry',
      beer_abv: 4.2, rating_score: 3.77, rating_count: 992660, beer_slug: 'guinness-guinness-draught', brewery_alias: [],
    });
    expect(out?.rating_count).toBe(992660);
  });
});
```

If `parseHydratedBeer` is not already imported at the top of the test file, add it to the existing import from `'./algolia'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/untappd/algolia.test.ts`
Expected: FAIL — the two "carries" tests report `undefined` instead of `992660`. (The two "absent"/"non-numeric" tests already pass; they are regression pins, not drivers.)

- [ ] **Step 3: Write minimal implementation**

In `src/sources/untappd/search.ts`, add the field to `SearchResult` (it is inherited by `HydratedBeer`):

```ts
export interface SearchResult {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  abv: number | null;
  global_rating: number | null;
  brewery_alias?: string[];
  alias_alt?: string[];
  /** #487: how many users rated the beer. Optional — the legacy HTML relay has no such
   *  field, and absent must never be read as zero. */
  rating_count?: number;
}
```

In `src/sources/untappd/algolia.ts`, add `rating_count?: unknown;` to the `AlgoliaHit` interface, then a helper and its use:

```ts
// #487: only a finite number counts. An absent or malformed value stays absent,
// so a candidate without evidence can never be dominated into a flagship decision.
function ratingCount(v: unknown): number | undefined {
  const n = num(v);
  return n === null ? undefined : n;
}
```

In `parseAlgoliaResponse`, inside the `out.push({ … })` literal add:

```ts
      rating_count: ratingCount(h.rating_count),
```

In `parseHydratedBeer`, inside the returned literal add the same line. `h` there is `Record<string, unknown>`, so `h.rating_count` needs no cast.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/untappd/algolia.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Mutation-prove the "absent stays absent" pin**

Temporarily change `ratingCount` to `return n === null ? 0 : n;`. Run the file again: the "leaves rating_count undefined" and "ignores a non-numeric" tests must go RED. Restore the original line and confirm green. This is the constraint the whole design leans on; a test that cannot see it break is not defending it.

- [ ] **Step 6: Type check and commit**

```bash
npm run typecheck
git add src/sources/untappd/search.ts src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts
git commit -m "feat(#487): carry rating_count through the search seam"
```

---

### Task 2: The dominance question, as a pure module

**Files:**
- Create: `src/domain/rating-dominance.ts`
- Test: `src/domain/rating-dominance.test.ts`

**Interfaces:**
- Consumes: `SearchResult.rating_count?: number` (Task 1); `ABV_TOLERANCE` from `./matcher`.
- Produces:
  - `export const DOMINANCE_RATIO = 5`
  - `export const FLAGSHIP_MIN_RATINGS = 1000`
  - `export function dominantCandidate(results: SearchResult[], abv: number | null): SearchResult | null`

- [ ] **Step 1: Write the failing test**

Create `src/domain/rating-dominance.test.ts`:

```ts
import { dominantCandidate, DOMINANCE_RATIO, FLAGSHIP_MIN_RATINGS } from './rating-dominance';
import type { SearchResult } from '../sources/untappd/search';

function beer(bid: number, rating_count: number | undefined, abv: number | null = 5): SearchResult {
  return { bid, beer_name: `b${bid}`, brewery_name: 'Brewery', style: null, abv, global_rating: null, rating_count };
}

describe('dominantCandidate', () => {
  test('returns the leader when it out-rates the runner-up by the ratio', () => {
    const hit = dominantCandidate([beer(1, 10000), beer(2, 1000)], null);
    expect(hit?.bid).toBe(1);
  });

  test('returns null when the lead is thinner than the ratio', () => {
    // Row 196: 1664 (292835) vs 1664 Blanc (269076) — 1.09x is not evidence.
    expect(dominantCandidate([beer(1, 292835), beer(2, 269076)], null)).toBeNull();
  });

  test('ranks by rating_count, not by input order', () => {
    const hit = dominantCandidate([beer(2, 1000), beer(1, 10000)], null);
    expect(hit?.bid).toBe(1);
  });

  test('deduplicates by bid before ranking', () => {
    // The same beer arriving twice must not become its own runner-up.
    const hit = dominantCandidate([beer(1, 10000), beer(1, 10000)], null);
    expect(hit?.bid).toBe(1);
  });

  test('a lone candidate above the floor is dominant', () => {
    expect(dominantCandidate([beer(1, FLAGSHIP_MIN_RATINGS)], null)?.bid).toBe(1);
  });

  test('a lone candidate below the floor is not a flagship', () => {
    // 73 ratings is the only hit, not the beer everyone means.
    expect(dominantCandidate([beer(1, 73)], null)).toBeNull();
  });

  test('a leader with no rating_count is never a flagship', () => {
    expect(dominantCandidate([beer(1, undefined), beer(2, 10)], null)).toBeNull();
  });

  test('a runner-up with no rating_count does not count as zero', () => {
    // Absent evidence must not manufacture an infinite ratio.
    expect(dominantCandidate([beer(1, 5000), beer(2, undefined)], null)?.bid).toBe(1);
    expect(dominantCandidate([beer(1, 5000), beer(2, 4000)], null)).toBeNull();
  });

  test('a contradicting ABV vetoes the flagship and does not promote the runner-up', () => {
    const results = [beer(1, 100000, 9), beer(2, 1000, 7)];
    expect(dominantCandidate(results, 7)).toBeNull();
  });

  test('an ABV difference exactly at the tolerance is not a contradiction', () => {
    // Breznak: shop 4.8, Untappd 5.1.
    expect(dominantCandidate([beer(1, 57139, 5.1), beer(2, 7601, 3.8)], 4.8)?.bid).toBe(1);
  });

  test('an unknown ABV on either side cannot veto', () => {
    expect(dominantCandidate([beer(1, 100000, null), beer(2, 1000, 5)], 7)?.bid).toBe(1);
    expect(dominantCandidate([beer(1, 100000, 9), beer(2, 1000, 5)], null)?.bid).toBe(1);
  });

  test('an empty list has no flagship', () => {
    expect(dominantCandidate([], 5)).toBeNull();
  });

  test('the constants are the reviewed values', () => {
    expect(DOMINANCE_RATIO).toBe(5);
    expect(FLAGSHIP_MIN_RATINGS).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/rating-dominance.test.ts`
Expected: FAIL — `Cannot find module './rating-dominance'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/rating-dominance.ts`:

```ts
import { ABV_TOLERANCE } from './matcher';
import type { SearchResult } from '../sources/untappd/search';

// #487: asked for "a Guinness", nobody means Guinness Bitter — they mean the beer with
// ~992k ratings. Popularity is identity evidence when ONE candidate dominates, and no
// evidence at all when two siblings are neck and neck (1664 vs 1664 Blanc: 1.09x).
// Measured 2026-08-25 across every bare-brand orphan row: the correct flagships sit at
// 5.89x-326x and the coin flips at 1.09x-2.45x. Nothing lies in between.
export const DOMINANCE_RATIO = 5;

// A lone candidate has infinite dominance by arithmetic, which is not the same as being
// the beer people mean. The correct flagships carry 36k-625k ratings; the rejected noise
// carries 73-1448.
export const FLAGSHIP_MIN_RATINGS = 1000;

// True popularity or nothing: a transport that does not report ratings (the legacy HTML
// relay) must leave the candidate ineligible, never look like a beer with zero ratings.
function ratingCount(result: SearchResult): number | undefined {
  return typeof result.rating_count === 'number' ? result.rating_count : undefined;
}

/**
 * The single candidate this list is *about*, or null when the list does not say.
 * ABV is a veto here, never a selector: a contradicting leader means "no flagship",
 * not "take the next one" — promoting the runner-up would rebuild #487.
 */
export function dominantCandidate(results: SearchResult[], abv: number | null): SearchResult | null {
  const unique = Array.from(new Map(results.map((r) => [r.bid, r])).values());
  if (unique.length === 0) return null;

  const ranked = [...unique].sort((a, b) => (ratingCount(b) ?? -1) - (ratingCount(a) ?? -1));
  const leader = ranked[0];
  const leaderCount = ratingCount(leader);
  if (leaderCount === undefined || leaderCount < FLAGSHIP_MIN_RATINGS) return null;

  const runnerUpCount = ranked.length > 1 ? ratingCount(ranked[1]) : undefined;
  if (runnerUpCount !== undefined && runnerUpCount > 0 && leaderCount / runnerUpCount < DOMINANCE_RATIO) {
    return null;
  }

  if (abv != null && leader.abv != null && Math.abs(leader.abv - abv) > ABV_TOLERANCE) return null;

  return leader;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/rating-dominance.test.ts`
Expected: PASS, all thirteen.

- [ ] **Step 5: Mutation-prove three lines**

One at a time — break it, run the file, confirm the named test goes RED, restore:

1. `leaderCount < FLAGSHIP_MIN_RATINGS` → `leaderCount < 0` : "a lone candidate below the floor is not a flagship" must fail.
2. `< DOMINANCE_RATIO` → `< 1` : "returns null when the lead is thinner than the ratio" must fail.
3. `if (abv != null && leader.abv != null …) return null;` → delete the line : "a contradicting ABV vetoes the flagship" must fail.

- [ ] **Step 6: Type check and commit**

```bash
npm run typecheck
git add src/domain/rating-dominance.ts src/domain/rating-dominance.test.ts
git commit -m "feat(#487): dominance as a question a candidate list can answer"
```

---

### Task 3: The near-name pick asks dominance instead of ABV

The one site where a decision among **several** candidates rests on **approximate** name evidence. Everything else keeps ABV.

**Files:**
- Modify: `src/domain/untappd-lookup.ts:508-517` (the `nativeNearMatches` block)
- Create: `src/domain/untappd-lookup.flagship.test.ts`

**Interfaces:**
- Consumes: `dominantCandidate` (Task 2), `SearchResult.rating_count` (Task 1).
- Produces: nothing new for later tasks; Task 4 appends tests to the file created here.

- [ ] **Step 1: Create the fixture file with the Task 3 tests**

Create `src/domain/untappd-lookup.flagship.test.ts`. The candidate lists are real Algolia responses captured 2026-08-25:

```ts
import { lookupBeer } from './untappd-lookup';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

function fakeSearch(rows: SearchResult[]): BeerSearch {
  return { search: async () => rows };
}

// beer_id 196 — the row #487 was filed for. `1664` normalizes to the empty string, so the
// target collapses to the brand `kronenbourg`, which BOTH siblings carry in alias_alt and
// therefore both score 1.0. 292835 vs 269076 is 1.09x — no flagship exists here.
const KRONENBOURG: SearchResult[] = [
  { bid: 5939, beer_name: '1664', brewery_name: 'Brasseries Kronenbourg', style: 'Lager - Pale', abv: 5.5, global_rating: 3.13, rating_count: 292835,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['kronenbourg 1664 45', 'kronenbourg', '1664 blonde'] },
  { bid: 5999, beer_name: '1664 Blanc', brewery_name: 'Brasseries Kronenbourg', style: 'Wheat Beer - Witbier / Blanche', abv: 5, global_rating: 3.48, rating_count: 269076,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['weizen', '1664 blanc 45', 'kronenbourg', 'kronenbourg 1664 blanc', 'blanc'] },
  { bid: 769282, beer_name: '1664 Blanc 0.0%', brewery_name: 'Brasseries Kronenbourg', style: 'Non-Alcoholic - Wheat', abv: 0, global_rating: 2.76, rating_count: 20420,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['1664 blanc alcohol free'] },
  { bid: 420671, beer_name: '1664 Rosé', brewery_name: 'Brasseries Kronenbourg', style: 'Wheat Beer - Fruited', abv: 4.5, global_rating: 2.9, rating_count: 22720,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: [] },
  { bid: 1034341, beer_name: '1664 Blanc Fruits Rouges', brewery_name: 'Brasseries Kronenbourg', style: 'Wheat Beer - Fruited', abv: 4.5, global_rating: 3.01, rating_count: 18035,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['1664 blanc fruits rouges'] },
];

// beer_id 29799 — native-alias pool. The two top-scored candidates stand at 22.05x and the
// leader's 5.1% is exactly ABV_TOLERANCE from the shop's 4.8%, so the veto must not fire.
const BREZNAK: SearchResult[] = [
  { bid: 56797, beer_name: 'Březňák Světlý ležák / Original Böhmisch Pils', brewery_name: 'Velké Březno', style: 'Pilsner - Czech / Bohemian', abv: 5.1, global_rating: 3.04, rating_count: 57139,
    brewery_alias: ['březňák', 'breznak'], alias_alt: ['breznak lager', '12'] },
  { bid: 101155, beer_name: 'Březňák Tmavé výčepní / Schwarzbier', brewery_name: 'Velké Březno', style: 'Lager - Tmavé (Czech Dark)', abv: 3.8, global_rating: 2.98, rating_count: 7601,
    brewery_alias: ['březňák', 'breznak'], alias_alt: [] },
  { bid: 317366, beer_name: 'Březňák Světlé výčepní', brewery_name: 'Velké Březno', style: 'Lager - Světlé (Czech Pale)', abv: 4, global_rating: 2.94, rating_count: 3208,
    brewery_alias: ['březňák', 'breznak'], alias_alt: ['10'] },
  { bid: 1398602, beer_name: 'Březňák 11', brewery_name: 'Velké Březno', style: 'Pilsner - Czech / Bohemian', abv: 4.6, global_rating: 3.09, rating_count: 2592,
    brewery_alias: ['březňák', 'breznak'], alias_alt: [] },
  { bid: 154534, beer_name: 'Starobrno Zelené pivo 13° / Green beer', brewery_name: 'Starobrno', style: 'Spiced / Herbed Beer', abv: 5.8, global_rating: 3, rating_count: 1682,
    brewery_alias: ['pivovar', 'starbrno', 'starobrno brewery'], alias_alt: ['starobrno easter beer', 'breznak zelene 13'] },
];

// beer_id 32117 — reaches the same site but with ONE candidate at the top score, so it
// takes the unchanged single-candidate path. Pinned as a documented limitation, not a win.
const MENABREA: SearchResult[] = [
  { bid: 537752, beer_name: 'La 150° Bionda', brewery_name: 'G. Menabrea & Figli', style: 'Lager - Pale', abv: 4.8, global_rating: 3.25, rating_count: 140299,
    brewery_alias: ['birra menabrea', 'birra menabrea spa', 'g menabrea e filli'], alias_alt: ['Chiara', 'La 150'] },
  { bid: 7482, beer_name: 'Original', brewery_name: 'G. Menabrea & Figli', style: 'Lager - Pale', abv: 4.5, global_rating: 3.16, rating_count: 62820,
    brewery_alias: ['birra menabrea', 'birra menabrea spa', 'g menabrea e filli'], alias_alt: ['pilsner', 'menabrea birra', 'menabrea 1846 lager'] },
  { bid: 46113, beer_name: 'La 150° Ambrata', brewery_name: 'G. Menabrea & Figli', style: 'Lager - Amber / Red', abv: 5, global_rating: 3.35, rating_count: 47919,
    brewery_alias: ['birra menabrea', 'birra menabrea spa', 'g menabrea e filli'], alias_alt: ['amber', 'menabrea ambrata'] },
];

describe('#487 near-name pick: dominance decides, ABV vetoes', () => {
  test('row 196 no longer links Kronenbourg 1664 to 1664 Blanc', async () => {
    const out = await lookupBeer({
      brewery: 'Kronenbourg Brewery', name: 'Kronenbourg 1664', abv: 5.0, search: fakeSearch(KRONENBOURG),
    });
    expect(out.kind).toBe('not_found');
  });

  test('row 196 does not silently flip to the other sibling either', async () => {
    // The honest outcome is an orphan. Matching 1664 here would be luck, not evidence:
    // restoring that identity is the separate digit-identity issue.
    const out = await lookupBeer({
      brewery: 'Kronenbourg Brewery', name: 'Kronenbourg 1664', abv: 5.5, search: fakeSearch(KRONENBOURG),
    });
    expect(out.kind).toBe('not_found');
  });

  test('a dominant native near-name candidate is matched', async () => {
    const out = await lookupBeer({
      brewery: 'Breznak Brewery', name: 'Breznak', abv: 4.8, search: fakeSearch(BREZNAK),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(56797);
  });

  test('the single-candidate path at the same site is unchanged', async () => {
    const out = await lookupBeer({
      brewery: 'Birra Menabrea Brewery', name: 'Menabrea', abv: 4.8, search: fakeSearch(MENABREA),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(7482);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/untappd-lookup.flagship.test.ts`
Expected: FAIL on the first three.
- "no longer links … to 1664 Blanc" — receives `matched` bid `5999` (today's wrong link).
- "does not silently flip" — receives `matched` bid `5939`.
- "a dominant native near-name candidate is matched" — receives `not_found`.
The Menabrea test already passes; it is a regression pin.

- [ ] **Step 3: Write minimal implementation**

In `src/domain/untappd-lookup.ts`, add to the imports at the top:

```ts
import { dominantCandidate } from './rating-dominance';
```

Then replace the pick inside the `if (nativeNearMatches.length > 0) {` block (currently `untappd-lookup.ts:510-514`):

```ts
      const topScored = nativeNearMatches
        .filter((match) => match.score === topScore)
        .map((match) => match.result);
      const uniqueTop = Array.from(new Map(topScored.map((r) => [r.bid, r])).values());
      // #487: this pool is scored APPROXIMATELY, so a tie here is not an equivalence class —
      // it is an absence of evidence, and ABV must not select across it. (A single candidate
      // still takes the old path: there is nothing to select between.)
      const nativeHit = uniqueTop.length === 1
        ? pickUniqueByAbv(uniqueTop, abv, true)
        : dominantCandidate(uniqueTop, abv);
```

Leave the `return nativeHit ? … : typoRescue();` line that follows exactly as it is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/untappd-lookup.flagship.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Confirm nothing else moved**

Run: `npx vitest run src/domain/untappd-lookup.test.ts src/domain/untappd-lookup.fixtures.test.ts src/domain/untappd-lookup.brewery-typo.test.ts`
Expected: PASS. These are the existing lookup suites; a failure here means the edit reached further than the near-name site.

- [ ] **Step 6: Mutation-prove the new branch**

Change `uniqueTop.length === 1` to `uniqueTop.length >= 1`. The Kronenbourg tests must go RED (the old ABV path returns). Restore and confirm green.

- [ ] **Step 7: Type check and commit**

```bash
npm run typecheck
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.flagship.test.ts
git commit -m "fix(#487): the approximate pool stops letting ABV choose the product"
```

---

### Task 4: A terminal flagship stage for bare-brand targets

Reached only when every existing stage has missed. Because it is last, it cannot change a match that exists today — it can only turn an orphan into a match.

**Files:**
- Modify: `src/domain/untappd-lookup.ts` — insert immediately before the final `return typoRescue();` of `matchAgainst` (currently `:566`)
- Modify: `src/domain/untappd-lookup.flagship.test.ts` (created in Task 3)

**Interfaces:**
- Consumes: `dominantCandidate` (Task 2, already imported in Task 3); the pool variables `strictPool`, `relaxedPool`, `nativePool`, `brandPool`, `targetNames`, `inputBreweryAliases` already in scope inside `matchAgainst`.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/untappd-lookup.flagship.test.ts`:

```ts
// beer_id 1 — Untappd files it under `Plzeňský Prazdroj`, so only the brand pool survives.
const PILSNER_URQUELL: SearchResult[] = [
  { bid: 37936, beer_name: 'Pilsner Urquell', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 4.4, global_rating: 3.38, rating_count: 458401,
    brewery_alias: ['pivovar'], alias_alt: ['pilsener urquell', 'pu 1842', 'the original pilsner'] },
  { bid: 481334, beer_name: 'Pilsner Urquell Nefiltrovaný / Unfiltered', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 4.4, global_rating: 3.71, rating_count: 22704,
    brewery_alias: ['pivovar'], alias_alt: ['pilsner urquell unfiltered unpasteurized'] },
  { bid: 88241, beer_name: 'Pilsner Urquell Nepasterizovaný / Tank Beer', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 4.4, global_rating: 3.73, rating_count: 13569,
    brewery_alias: ['pivovar'], alias_alt: ['tankova', 'unpasteurized'] },
  { bid: 122973, beer_name: 'Pilsner Urquell 3.5%', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 3.5, global_rating: 2.9, rating_count: 3345,
    brewery_alias: ['pivovar'], alias_alt: [] },
];

// beer_id 11933 — strict pool. The flagship's name shares nothing with the brand, which is
// exactly why a "flagship name must resemble the brewery" rule would have been wrong.
const BLUE_MOON: SearchResult[] = [
  { bid: 3839, beer_name: 'Belgian White', brewery_name: 'Blue Moon Brewing Company', style: 'Wheat Beer - Witbier / Blanche', abv: 5.4, global_rating: 3.5, rating_count: 625400,
    brewery_alias: ['bluemoon'], alias_alt: ['blue moon belgian style white', 'belgian white ale', 'blue moon'] },
  { bid: 3837, beer_name: 'Harvest Pumpkin Ale', brewery_name: 'Blue Moon Brewing Company', style: 'Pumpkin / Yam Beer', abv: 5.7, global_rating: 3.32, rating_count: 106143,
    brewery_alias: ['bluemoon'], alias_alt: ['harvest moon'] },
  { bid: 39740, beer_name: 'Summer Honey Wheat', brewery_name: 'Blue Moon Brewing Company', style: 'Wheat Beer - American Pale Wheat', abv: 5.2, global_rating: 3.32, rating_count: 81325,
    brewery_alias: ['bluemoon'], alias_alt: ['honeymoon summer ale'] },
  { bid: 1695486, beer_name: 'Mango Wheat', brewery_name: 'Blue Moon Brewing Company', style: 'Wheat Beer - Fruited', abv: 5.4, global_rating: 3.54, rating_count: 84491,
    brewery_alias: ['bluemoon'], alias_alt: [] },
];

// beer_ids 32 and 73 — the style word `Weizen` is stripped by normalizeName, so the target
// collapses to the brand even though the shop named the product.
const PRIMATOR: SearchResult[] = [
  { bid: 30947, beer_name: 'Weizen', brewery_name: 'Primátor', style: 'Wheat Beer - Hefeweizen', abv: 4.8, global_rating: 3.48, rating_count: 36240,
    brewery_alias: ['pivovar nachod'], alias_alt: ['premium hefeweissbier', 'hefeweizen', 'Weizenbier'] },
  { bid: 552690, beer_name: 'Hron Weizen', brewery_name: 'Primátor', style: 'Wheat Beer - Hefeweizen', abv: 5, global_rating: 3.31, rating_count: 111,
    brewery_alias: ['pivovar nachod'], alias_alt: [] },
  { bid: 642221, beer_name: 'Diver Hefe', brewery_name: 'Primátor', style: 'Wheat Beer - Hefeweizen', abv: 4.8, global_rating: 3.29, rating_count: 41,
    brewery_alias: ['pivovar nachod'], alias_alt: ['Weizenbier'] },
];

// beer_id 1391 — a bare-brand TARGET that already matches on its own at the near-name stage.
// The terminal stage must never get the chance to second-guess it. (Brewmen Stout, beer_id
// 23207, is the same shape with 19 ratings — far below the floor — so if the terminal stage
// were ever reached for it, it would answer null and the match would be lost.)
const GOOSE: SearchResult[] = [
  { bid: 1353, beer_name: 'Goose IPA', brewery_name: 'Goose Island Beer Co.', style: 'IPA - American', abv: 5.9, global_rating: 3.51, rating_count: 664549,
    brewery_alias: ['goose island brewery', 'goose island brewing co'], alias_alt: ['goose island ipa'] },
  { bid: 12943, beer_name: 'Green Line Pale Ale', brewery_name: 'Goose Island Beer Co.', style: 'Pale Ale - American', abv: 5.4, global_rating: 3.48, rating_count: 129062,
    brewery_alias: ['goose island brewery', 'goose island brewing co'], alias_alt: ['greenline'] },
  { bid: 2036410, beer_name: 'Midway IPA', brewery_name: 'Goose Island Beer Co.', style: 'IPA - Session', abv: 4.1, global_rating: 3.43, rating_count: 110235,
    brewery_alias: ['goose island brewery', 'goose island brewing co'], alias_alt: ['midway session ipa'] },
];

const BREWMEN: SearchResult[] = [
  { bid: 2697316, beer_name: 'Oatmeal Stout', brewery_name: 'Brewmen', style: 'Stout - Oatmeal', abv: 6.2, global_rating: 3.84, rating_count: 25,
    brewery_alias: ['bryumen'], alias_alt: [] },
  { bid: 4472578, beer_name: 'Brewmen Stout', brewery_name: 'Brewmen', style: 'Stout - Coffee', abv: 5.5, global_rating: 3.57, rating_count: 19,
    brewery_alias: [], alias_alt: [] },
  { bid: 5336905, beer_name: 'Karjalan Milk Stout', brewery_name: 'Brewmen', style: 'Stout - Milk / Sweet', abv: 6.5, global_rating: 3.6, rating_count: 24,
    brewery_alias: ['bryumen'], alias_alt: [] },
];

// A brewery whose products are evenly popular has no flagship, whatever the shop typed.
const NO_FLAGSHIP: SearchResult[] = [
  { bid: 900, beer_name: 'Erlkönig Hell', brewery_name: 'Erl-Bräu', style: 'Lager - Helles', abv: 5, global_rating: 3.4, rating_count: 18744, brewery_alias: [], alias_alt: [] },
  { bid: 901, beer_name: 'Erl Hell', brewery_name: 'Erl-Bräu', style: 'Lager - Helles', abv: 5, global_rating: 3.3, rating_count: 16157, brewery_alias: [], alias_alt: [] },
];

describe('#487 terminal flagship stage', () => {
  test('a bare-brand target matches its flagship from the brand pool', async () => {
    const out = await lookupBeer({
      brewery: 'Pilsner Urquell Brewery', name: 'Pilsner Urquell', abv: 4.4, search: fakeSearch(PILSNER_URQUELL),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(37936);
  });

  test('a flagship whose name shares nothing with the brand still wins', async () => {
    const out = await lookupBeer({
      brewery: 'Blue Moon Brewery', name: 'Blue Moon', abv: 5.4, search: fakeSearch(BLUE_MOON),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(3839);
  });

  test('a target left bare by style-word stripping reaches its flagship', async () => {
    const out = await lookupBeer({
      brewery: 'Primator Brewery', name: 'Primator Weizen', abv: 4.8, search: fakeSearch(PRIMATOR),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(30947);
  });

  test('an evenly popular brewery yields no flagship', async () => {
    const out = await lookupBeer({
      brewery: 'Erl Brau Brewery', name: 'Erl Brau', abv: 5, search: fakeSearch(NO_FLAGSHIP),
    });
    expect(out.kind).toBe('not_found');
  });

  test('a stage that already matches is never reconsidered', async () => {
    const out = await lookupBeer({
      brewery: 'Goose Island Beer Co.', name: 'Goose IPA', abv: 5.9, search: fakeSearch(GOOSE),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1353);
  });

  test('a small brewery keeps its near-name match despite a tiny rating count', async () => {
    const out = await lookupBeer({
      brewery: 'Brewmen', name: 'Brewmen Stout', abv: 5.5, search: fakeSearch(BREWMEN),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(4472578);
  });

  test('a distinguishing token in the target keeps the stage out of it', async () => {
    // `Mango Wheat` is not bare-brand, so the flagship stage must not fire and hand back
    // `Belgian White` just because it is the most popular beer of the brewery.
    const out = await lookupBeer({
      brewery: 'Blue Moon Brewery', name: 'Blue Moon Mango Wheat', abv: 5.4, search: fakeSearch(BLUE_MOON),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1695486);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/untappd-lookup.flagship.test.ts`
Expected: FAIL on the first three ("matches its flagship", "shares nothing with the brand", "left bare by style-word stripping") — each receives `not_found` today. The other four already pass and are regression pins.

- [ ] **Step 3: Write minimal implementation**

In `src/domain/untappd-lookup.ts`, inside `matchAgainst`, immediately **before** the final `return typoRescue();`, insert:

```ts
    // #487 flagship stage. Terminal on purpose: every name stage above has missed, so this
    // can only turn an orphan into a match and never revisit one. It fires when the target
    // carries nothing beyond the brewery brand — the condition is on the target the stages
    // actually compare, because the raw-name form (#306's isBareBrandName) does not even
    // describe this case: for `Kronenbourg 1664` the digits survive baseNormalize.
    const brandTokens = new Set(inputBreweryAliases.flatMap((a) => a.split(' ')).filter(Boolean));
    const bareBrandTarget =
      brandTokens.size > 0 &&
      targetNames.length > 0 &&
      targetNames.every((target) => {
        const tokens = target.value.split(' ').filter(Boolean);
        return tokens.length > 0 && tokens.every((token) => brandTokens.has(token));
      });
    if (bareBrandTarget) {
      // Strongest evidence only, never mixed: a weak brand hit must not compete with a
      // strict one for the same brewery.
      const flagshipPool =
        strictPool.length ? strictPool :
        relaxedPool.length ? relaxedPool :
        nativePool.length ? nativePool : brandPool;
      const flagship = flagshipPool.length > 0 ? dominantCandidate(flagshipPool, abv) : null;
      if (flagship) return { kind: 'matched', result: flagship };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/untappd-lookup.flagship.test.ts`
Expected: PASS, all eleven (four from Task 3, seven from this task).

- [ ] **Step 5: Confirm nothing else moved**

Run: `npm test`
Expected: PASS. Every existing suite must be green; this stage is terminal, so a failure elsewhere means it was inserted too early.

- [ ] **Step 6: Mutation-prove the two guards**

One at a time — break, run `npx vitest run src/domain/untappd-lookup.flagship.test.ts`, confirm RED, restore:

1. Replace the `bareBrandTarget` condition with `true`. "a distinguishing token in the target keeps the stage out of it" must fail.
2. Change the pool chain to `const flagshipPool = [...strictPool, ...relaxedPool, ...nativePool, ...brandPool];`. Confirm which test goes red and record it in the commit message; if **none** does, say so plainly rather than inventing one — it means the no-mixing rule is currently unwitnessed by the suite, which the reviewer needs to know.

- [ ] **Step 7: Type check and commit**

```bash
npm run typecheck
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.flagship.test.ts
git commit -m "feat(#487): a bare-brand target matches its dominant flagship"
```

---

### Task 5: Document the behaviour in `spec.md`

CLAUDE.md requires `spec.md` to ship in the same PR as the behaviour it describes.

**Files:**
- Modify: `spec.md` — the `SearchResult` paragraph in "Джерело Algolia" (~`:1244-1249`), and the matching-stage prose after "Upstream identity evidence (#427)" (~`:964-967`)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Extend the `SearchResult` paragraph**

In the "Джерело Algolia (серверний пошук Untappd)" section, the paragraph beginning
"`SearchResult` додатково несе опційні `brewery_alias?: string[]` і `alias_alt?: string[]`"
— append to it:

```markdown
Додатково `SearchResult` несе опційний `rating_count?: number` (#487) — скільки користувачів
оцінили пиво. Поле **опційне назавжди**: legacy `htmlSearch` (relay) і web-фолбек його не мають,
і **відсутність ніколи не читається як нуль** — кандидат без лічильника просто не може бути
флагманом. Relay-шлях отримує поле безкоштовно, бо розширення шле Algolia-JSON у той самий
`parseAlgoliaResponse`.
```

- [ ] **Step 2: Correct the #427 sentence and add the new rule**

The sentence in "Upstream identity evidence (#427)" that reads
"exact/near-name кандидати мають дати один унікальний результат; при множині й відомому ABV виграє лише рівно один кандидат у `ABV_TOLERANCE`, інакше матчер відмовляється"
now describes only the exact-key half. Replace that clause with:

```markdown
exact/near-name кандидати мають дати один унікальний результат; при множині правило залежить
від того, **яким** доказом побудований пул. На **точному** ключі (identity-аліаси, native
name-keys, brand-remainder) виграє рівно один кандидат у `ABV_TOLERANCE` — ABV там розділяє
вінтажі одного пива. На **наближеному** near-name пулі (#487) ABV більше не обирає: рішення
ухвалює домінування за `rating_count`, а ABV лише накладає вето.
```

- [ ] **Step 3: Document the flagship stage**

Immediately after the "Brand-as-beer-name (#138B)" paragraph, add:

```markdown
**Флагман на голому бренді (#487).** Термінальна стадія `lookupBeer`, після всіх інших: спрацьовує
лише коли **нормалізована ціль назви не несе нічого понад бренд** вхідної броварні (умова стоїть на
цілі, яку порівнюють стадії, а не на сирій назві — для `Kronenbourg 1664` цифри переживають
`baseNormalize`, тож `isBareBrandName` з #306 цей випадок не описує). Тоді береться найсильніший
непорожній пул у наявному порядку (strict → relaxed → native → brand, **без змішування**) і
матчиться кандидат, що домінує за `rating_count`: щонайменше `DOMINANCE_RATIO` (5×) над другим
місцем і не менше `FLAGSHIP_MIN_RATINGS` (1000) власних оцінок. ABV — **вето, не селектор**:
суперечність у толерансі скасовує матч і **не** передає рішення другому місцю. Інакше — сирота.
Стадія термінальна за побудовою, тож не може змінити жоден наявний матч — лише перетворити сироту
на матч (`Blue Moon` → `Belgian White`, `Pilsner Urquell`, `Primátor Weizen`). Порогові значення
виміряні: правильні флагмани лежать на 5.89×–326×, монетки — на 1.09×–2.45×, між ними порожньо.
```

- [ ] **Step 4: Verify the document is consistent**

Read back all three edits. Confirm no sentence now claims ABV selects on the near-name pool, and that `DOMINANCE_RATIO` / `FLAGSHIP_MIN_RATINGS` appear with the same values as in `src/domain/rating-dominance.ts`.

- [ ] **Step 5: Full verification and commit**

```bash
npm run typecheck && npm test
git add spec.md
git commit -m "docs(#487): spec.md records dominance, the veto and the flagship stage"
```

---

## Done means

- `npm test` and `npm run typecheck` are green.
- Row 196 returns `not_found` for both 5.0 and 5.5.
- `Pilsner Urquell`, `Blue Moon`, `Primator Weizen` and `Breznak` match their measured bids.
- `Goose IPA`, `Brewmen Stout` and `Menabrea` are untouched.
- `git diff` shows no change to `pickByAbv` or to the three exact-key `pickUniqueByAbv` call sites.
- `spec.md` describes the new stage and the corrected #427 sentence.

## Not in this plan

- **The digit identity** (`normalizeName` deleting `1664`). Separate issue; it is what would turn row 196 from an honest orphan into a correct match.
- **A style veto.** Deferred with reasons and numbers in the spec.
- **Re-arming the affected rows in production.** An operator step after deploy, listed in the spec's Verification section, plus the #417 ordering.
