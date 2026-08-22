# #430 Drink Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "a drink we try to find on Untappd" a single definition with three enforcers, so the triage prompt stops permanently burying cider, mead, kvass and kombucha.

**Architecture:** The existing ontap-private filter becomes a shared domain module. Its eligible-token list gains kombucha and its non-beer lists gain the five gaps measured on prod. The triage prompt stops restating the boundary in prose and interpolates the constant instead, with a drift test. A new pure predicate classifies obvious non-beer rows *after* a failed Untappd search — the only place a name-side token test is safe — and ships writing nothing until a week of shadow comparison says it is right.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, pino.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-22-430-non-beer-boundary-design.md`

## Global Constraints

- **The governing asymmetry:** being wrong toward "eligible" costs one Untappd search; being wrong toward `not_a_beer` is irreversible. Every judgement call resolves toward eligible.
- **Eligible families are cider, mead, kvass, braggot, melomel and kombucha.** Never classify one as `not_a_beer`.
- **`ontapTapExclusion` may test only `style` and `brewery_ref`.** No name-side token test at ingest — that would destroy 554 already-matched beers (268 `wine`/`wino`/`vino`, 257 food words).
- **Name-side tokens are word-boundary matches only, never substrings.** `wine` is inside `Dwinell` and inside `barleywine`.
- **`NON_BEER_NAME_TOKENS` never contains bare `wine`/`wino`/`vino`.**
- **#306 stands:** a tap the ingest filter rejects is dropped and counted by cause; it may reject only on evidence in the source's own fields.
- Run `npm test` (vitest) and `npm run typecheck` before every commit.
- Every commit message ends with the two footer lines used across this repo:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01K91mQ7rDMf2SfmdUfG4k8S`

---

### Task 1: Move the filter into the domain, unchanged

**Files:**
- Create: `src/domain/drink-boundary.ts` (content moved verbatim from the file below)
- Delete: `src/sources/ontap/non-beer.ts`
- Create: `src/domain/drink-boundary.test.ts` (moved verbatim from the file below)
- Delete: `src/sources/ontap/non-beer.test.ts`
- Modify: `src/jobs/refresh-ontap.ts` — the `ontapTapExclusion` import path

**Interfaces:**
- Consumes: nothing.
- Produces: `src/domain/drink-boundary.ts` exporting `ontapTapExclusion(tap: OntapNonBeerInput): TapExclusion | null`, `isOntapNonBeerTap(tap: OntapNonBeerInput): boolean`, `type TapExclusion = 'non-beer' | 'placeholder'`, `interface OntapNonBeerInput { style: string | null; brewery_ref: string | null; beer_ref?: string | null }`. Behaviour identical to today.

**This task changes no behaviour.** Its whole value to a reviewer is that the diff is a pure move, so Task 2's token diff is readable.

- [ ] **Step 1: Move both files with git so the rename is visible**

```bash
git mv src/sources/ontap/non-beer.ts src/domain/drink-boundary.ts
git mv src/sources/ontap/non-beer.test.ts src/domain/drink-boundary.test.ts
```

- [ ] **Step 2: Fix the two import paths inside the moved files**

In `src/domain/drink-boundary.ts` the import of `breweryCore` moves one level:

```ts
import { breweryCore } from '../sources/ontap/identity';
```

(`src/domain/` already imports from `src/sources/` in eight modules — `bid-identity`, `triage-verify`, `untappd-lookup`, `candidate-format`, `triage-probes`, `web-fallback` — so this is the established direction, not a new one.)

In `src/domain/drink-boundary.test.ts` the import of the module under test becomes:

```ts
import { ontapTapExclusion, isOntapNonBeerTap } from './drink-boundary';
```

- [ ] **Step 3: Fix the consumer**

In `src/jobs/refresh-ontap.ts`, change the `ontapTapExclusion` import to `../domain/drink-boundary`. Leave the call site at line 83 untouched.

- [ ] **Step 4: Prove nothing moved but the file**

Run: `npm test && npm run typecheck`
Expected: PASS, with the same test count as before the move. If any test fails, the move was not verbatim — revert and redo it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(#430): move the ontap non-beer filter into the domain

The boundary it encodes is about to gain two consumers outside ontap (the
triage prompt and a post-search classifier), so it stops being a private
detail of one source. Pure move: no behaviour change, same tests.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K91mQ7rDMf2SfmdUfG4k8S"
```

---

### Task 2: Kombucha becomes eligible; patch the five measured gaps

**Files:**
- Modify: `src/domain/drink-boundary.ts` — token lists only
- Modify: `src/domain/drink-boundary.test.ts` — add the fixture table below

**Interfaces:**
- Consumes: Task 1's `src/domain/drink-boundary.ts`.
- Produces: `export const ELIGIBLE_TOKENS: readonly string[]` (renamed from `ELIGIBLE_STYLE_TOKENS`, now also covering kombucha). Task 3 and Task 4 both import it by that name.

Every fixture below is a **real tap row recovered from the prod `taps` table** behind a leaked orphan. Do not invent extra cases; these fourteen are the measurement.

- [ ] **Step 1: Write the failing test**

Append to `src/domain/drink-boundary.test.ts`. **Merge the import into the file's existing
import statements** rather than adding a second one — a duplicate named import of the same
symbol is a TypeScript error, and the moved file already imports from `vitest` and from
`./drink-boundary`:

```ts
// merged into the existing import: add ELIGIBLE_TOKENS to the drink-boundary import
import { ontapTapExclusion, ELIGIBLE_TOKENS } from './drink-boundary';

// The 14 real tap rows behind the not_a_beer orphans, replayed 2026-08-22.
// `expected` is the verdict this task must produce.
const LEAKED_TAPS: { brewery_ref: string | null; beer_ref: string; style: string | null;
                     expected: 'non-beer' | 'placeholder' | null }[] = [
  // Eligible drinks the filter already keeps, and MUST keep.
  { brewery_ref: 'Cydr Smykan', beer_ref: 'Kwaśny Zdzichu', style: 'Cydr wytrawny z czarną porzeczką', expected: null },
  { brewery_ref: 'Dzik', beer_ref: 'Cydr Perry', style: 'Polslodki Gruszkowy', expected: null },
  { brewery_ref: 'Jabłecznik Trzebnicki', beer_ref: 'Cydr tradycyjny', style: 'Cydr półwytrawny', expected: null },
  { brewery_ref: 'Chyliczki', beer_ref: 'Cydr Chyliczki - Japoński Sad', style: 'Wytrawny i naturalnie musujący', expected: null },
  { brewery_ref: 'Flirt', beer_ref: 'BLOOD ORANGE', style: 'Cydr', expected: null },
  { brewery_ref: 'Tradycinis', beer_ref: 'Borówka z miętą', style: 'Cydr', expected: null },
  // The five gaps this task closes.
  { brewery_ref: 'VINO KARPATIA', beer_ref: 'Biały bez', style: null, expected: 'non-beer' },
  { brewery_ref: 'Sangria', beer_ref: 'Sangria Czerwona', style: null, expected: 'non-beer' },
  { brewery_ref: 'Bianco Frizzante', beer_ref: 'Frizzante Bianco', style: null, expected: 'non-beer' },
  { brewery_ref: 'Ima Distillery Brewery', beer_ref: 'Stefanówka z Pyrów', style: 'Wódka ziemniaczana', expected: 'non-beer' },
  { brewery_ref: 'takie zero. takie nic. Brewery', beer_ref: 'KRAN PUSTY. dużo°·21,37%', style: '67 VEGETARIAN PROGRESSIVE IMPERIAL BASS BOOSTED PORTER LEWOSKRETNY', expected: 'placeholder' },
  // Deliberately still leaking — a name-side test at ingest is forbidden (see Global
  // Constraints). Task 4's post-search enforcer is what covers these. Asserted so that a
  // later change which catches them here is a visible decision, not a silent drift.
  { brewery_ref: 'Culaccino', beer_ref: 'Aperol Spritz', style: null, expected: null },
  { brewery_ref: 'Monte Santi', beer_ref: 'Hugo Spritz', style: null, expected: null },
  { brewery_ref: null, beer_ref: 'N/A', style: null, expected: null },
];

describe('ontapTapExclusion against the measured leak set', () => {
  for (const t of LEAKED_TAPS) {
    it(`${t.brewery_ref ?? '(null)'} / ${t.beer_ref} -> ${t.expected ?? 'kept'}`, () => {
      expect(ontapTapExclusion(t)).toBe(t.expected);
    });
  }
});

describe('kombucha is an eligible drink family', () => {
  it('is listed as eligible', () => {
    expect(ELIGIBLE_TOKENS).toContain('kombucha');
  });

  it('keeps a hard kombucha tap — Untappd carries Hard Kombucha / Jun', () => {
    expect(ontapTapExclusion({
      brewery_ref: 'LOBSTER Brewery', beer_ref: 'Kombucha Calamansi', style: 'Kombucha',
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/drink-boundary.test.ts`
Expected: FAIL. Six failures — the five gap rows return `null` instead of a verdict, and both kombucha tests fail (`ELIGIBLE_TOKENS` is not exported yet and kombucha is currently in `STYLE_TOKENS`/`BREWERY_TOKENS`).

- [ ] **Step 3: Make the minimal changes**

In `src/domain/drink-boundary.ts`:

1. Rename `ELIGIBLE_STYLE_TOKENS` to `ELIGIBLE_TOKENS`, **export** it, and add kombucha:

```ts
// Drinks Untappd lists and our matcher resolves every day: 1339 rows in our own
// catalogue carry a Cider/Mead/Kvass style, and 10 more carry a Kombucha style
// (Hard Kombucha / Jun, Non-Alcoholic - Kombucha). Being wrong toward eligible costs
// one search; being wrong toward not_a_beer is irreversible. #430.
export const ELIGIBLE_TOKENS = [
  'cydr', 'cider', 'kwas chlebowy', 'kvass', 'квас', 'mead', 'melomel', 'kombucha',
] as const;
```

2. Remove `'kombucha'` from `STYLE_TOKENS` and from `BREWERY_TOKENS` — it is eligible now, and leaving it in both places would make the lists contradict each other. (This reverses #208/#214 on evidence they did not have.)

3. Add the measured gaps. To `STYLE_TOKENS`: `'wódka'`, `'wodka'`, `'vodka'`, `'sangria'`. To `BREWERY_TOKENS`: `'vino'`, `'sangria'`, `'frizzante'` (the list has `frizzanti` only). To `PLACEHOLDER_PHRASES`: `'kran pusty'`.

4. Update the two references to the old constant name inside `isOntapNonBeerTap`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/drink-boundary.test.ts && npm test && npm run typecheck`
Expected: PASS, all 14 fixtures and both kombucha tests.

- [ ] **Step 5: Mutation-prove each added token**

For each of `wódka`, `sangria` (style), `vino`, `sangria` (brewery), `frizzante`, `kran pusty`, and the kombucha move: delete it, run `npx vitest run src/domain/drink-boundary.test.ts`, confirm a **named** test goes red, restore it. A token whose removal breaks nothing is a token with no evidence — report it instead of keeping it.

- [ ] **Step 6: Commit**

```bash
git add src/domain/drink-boundary.ts src/domain/drink-boundary.test.ts
git commit -m "fix(#430): kombucha is eligible, and close the five measured ingest gaps

Replaying the real filter against the real tap rows behind the leaked
orphans caught 0 of 14. Six of those it keeps correctly (cider). This
closes five of the remaining eight: vino in the brewery list (it had only
vini), sangria in no list at all, frizzante vs frizzanti, vodka, and the
kran pusty placeholder variant.

Kombucha moves the other way, into the eligible list: Untappd carries Hard
Kombucha / Jun and Non-Alcoholic - Kombucha, and our catalogue holds 10.

The three still leaking are two bare '... Spritz' names and an 'N/A'.
Catching those needs a name-side test, which at ingest would destroy 554
already-matched beers — they belong to the post-search enforcer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K91mQ7rDMf2SfmdUfG4k8S"
```

---

### Task 3: The triage prompt interpolates the boundary instead of restating it

**Files:**
- Modify: `src/domain/drink-boundary.ts` — add `eligibleFamiliesForPrompt()`
- Modify: `src/domain/triage-analysis.ts:203-207` — the `not_a_beer` branch of the decision tree
- Modify: `src/domain/triage-analysis.test.ts` — add the drift test

**Interfaces:**
- Consumes: `ELIGIBLE_TOKENS` from Task 2.
- Produces: `eligibleFamiliesForPrompt(): string` — one rendered sentence naming every eligible family. Nothing later depends on it.

This is the task that fixes the live defect: the prompt has buried 15 rows in six days.

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/triage-analysis.test.ts`:

```ts
import { buildTriagePrompt } from './triage-analysis';
import { ELIGIBLE_TOKENS } from './drink-boundary';

const emptyInput = { orphans: [], openIssues: [], probes: new Map() } as never;

describe('the triage prompt states the drink boundary from the shared constant', () => {
  it('never lists an eligible family as not_a_beer', () => {
    const prompt = buildTriagePrompt(emptyInput);
    const notABeerClause = prompt.slice(
      prompt.indexOf('NO -> not_a_beer'),
      prompt.indexOf('2. Is OUR row faithful'),
    );
    expect(notABeerClause).not.toBe('');
    for (const token of ELIGIBLE_TOKENS) {
      expect(notABeerClause.toLowerCase()).not.toContain(token);
    }
  });

  it('names every eligible family so the model is told what to keep', () => {
    const prompt = buildTriagePrompt(emptyInput).toLowerCase();
    for (const token of ELIGIBLE_TOKENS) {
      expect(prompt).toContain(token);
    }
  });
});
```

The first test is the one that would have caught this defect on the day #377 shipped: today the clause contains the literal word `cider`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: FAIL — the first test fails on the literal `cider` in the merch list; the second fails because the prompt never names mead, kvass, melomel or kombucha.

- [ ] **Step 3: Implement**

In `src/domain/drink-boundary.ts`:

```ts
// The triage prompt must not restate the boundary in prose — two independent
// statements of one rule is exactly what let the prompt bury cider for six days
// while this module was keeping it eligible. #430.
export function eligibleFamiliesForPrompt(): string {
  return ELIGIBLE_TOKENS.join(', ');
}
```

In `src/domain/triage-analysis.ts`, replace the `not_a_beer` branch (currently lines 203-207) with:

```ts
    '1. Is the row a beer product at all? NO -> not_a_beer.',
    '   Merch, glassware, wine/cocktail/food, and bundles: mystery boxes, multipacks,',
    '   gift sets, "Brewery Pack". A bundle is not a beer even when every bottle inside',
    '   it is. This is the ONE verdict that is never revisited, so apply it only to the',
    '   product itself, never to a beer you merely cannot find.',
```

`cider` is gone from the merch list. The eligible sentence must NOT go inside this clause —
the drift test in Step 1 slices exactly this clause and asserts no eligible token appears in
it, so interpolating here would fail the task's own test. Put it **after** the tree instead,
immediately before the existing `'Pivot on candidates_count before you blame query noise:'`
line:

```ts
    `Eligible drink families — ${eligibleFamiliesForPrompt()} — ARE beer-adjacent and`,
    'Untappd lists them; our catalogue already holds 1339 matched rows across them. NEVER',
    'class one as not_a_beer merely because it is not literally beer.',
    '',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-analysis.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation-prove the drift test**

Add the literal word `cider` back into the merch list, run `npx vitest run src/domain/triage-analysis.test.ts`, confirm `never lists an eligible family as not_a_beer` goes red, then remove it again. If it stays green the slice bounds are wrong and the test is vacuous.

- [ ] **Step 6: Commit**

```bash
git add src/domain/drink-boundary.ts src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts
git commit -m "fix(#430): the triage prompt must not restate the drink boundary

triage-analysis.ts listed cider under not_a_beer while drink-boundary.ts
kept it eligible. The prompt won, because it runs last and not_a_beer is
the only irreversible class: 15 rows buried between 08-16 and 08-21, eight
of them with candidates Untappd had already returned.

The clause now interpolates ELIGIBLE_TOKENS, and a drift test asserts the
not_a_beer clause contains none of them. That test fails on today's code.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K91mQ7rDMf2SfmdUfG4k8S"
```

---

### Task 4: `classifyOrphanAsNonBeer` — the post-search predicate

**Files:**
- Modify: `src/domain/drink-boundary.ts`
- Modify: `src/domain/drink-boundary.test.ts`

**Interfaces:**
- Consumes: `ELIGIBLE_TOKENS` from Task 2.
- Produces:
  ```ts
  export const NON_BEER_NAME_TOKENS: readonly string[];
  export interface OrphanBoundaryInput {
    brewery: string; name: string; style: string | null; candidates_count: number;
  }
  export function classifyOrphanAsNonBeer(
    row: OrphanBoundaryInput,
  ): { nonBeer: true; token: string } | null;
  ```
  Task 5 imports `classifyOrphanAsNonBeer` and reads `.token`.

A name test is safe **only here**: every one of the 554 dangerous beers matched, so none of them is ever in the orphan population.

- [ ] **Step 1: Write the failing test**

Append to `src/domain/drink-boundary.test.ts`:

```ts
// merged into the existing drink-boundary import; OrphanBoundaryInput is a type-only import
import {
  classifyOrphanAsNonBeer, NON_BEER_NAME_TOKENS, type OrphanBoundaryInput,
} from './drink-boundary';

const orphan = (over: Partial<OrphanBoundaryInput> = {}): OrphanBoundaryInput => ({
  brewery: '', name: '', style: null, candidates_count: 0, ...over,
});

describe('classifyOrphanAsNonBeer catches the rows the ingest filter must not guess at', () => {
  it('catches a bare Spritz name', () => {
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'Culaccino', name: 'Aperol Spritz' })))
      .toEqual({ nonBeer: true, token: 'spritz' });
  });

  it('catches a Hugo Spritz', () => {
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'Monte Santi', name: 'Hugo Spritz' })))
      .toEqual({ nonBeer: true, token: 'spritz' });
  });
});

describe('the three necessary conditions', () => {
  it('declines when Untappd returned candidates — the model decides those', () => {
    expect(classifyOrphanAsNonBeer(
      orphan({ brewery: 'Culaccino', name: 'Aperol Spritz', candidates_count: 3 }),
    )).toBeNull();
  });

  it('declines when an eligible family is named anywhere on the row', () => {
    expect(classifyOrphanAsNonBeer(
      orphan({ brewery: 'Cydr Dzik', name: 'Spritz Cydr', style: 'Cydr' }),
    )).toBeNull();
  });

  it('matches on a word boundary, never a substring', () => {
    // "spritzer" is not "spritz"; if this passes as a substring the rule is unsafe.
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'X', name: 'Spritzered Ale' }))).toBeNull();
  });
});

describe('false positives drawn from beers we have ALREADY matched', () => {
  // Every one of these is a real style/name family from our own catalogue: 268 matched
  // beers carry wine/wino/vino, 257 carry a food word. If any of them classifies, the
  // rule is destroying live beers.
  const realBeers = [
    { brewery: 'Dwinell Country Ales', name: 'Field Guide' },
    { brewery: 'Vinohradský pivovar', name: 'Vinohradská 12' },
    { brewery: 'Anonymous', name: 'Barley Wine 2021' },
    { brewery: 'Anonymous', name: 'Bourbon Barrel Aged Wine Cask Stout' },
    { brewery: 'Anonymous', name: 'Sausage Fingers' },
    { brewery: 'Anonymous', name: 'Birthday Cake Pastry Stout' },
    { brewery: 'LOBSTER Brewery', name: 'Kombucha Calamansi' },
    { brewery: 'Hidden Legend Winery', name: 'Wild Elderberry Mead' },
  ];
  for (const b of realBeers) {
    it(`keeps ${b.brewery} / ${b.name}`, () => {
      expect(classifyOrphanAsNonBeer(orphan(b))).toBeNull();
    });
  }
});

describe('NON_BEER_NAME_TOKENS is narrower than the ingest lists on purpose', () => {
  it('never contains a bare wine token', () => {
    for (const unsafe of ['wine', 'wino', 'vino']) {
      expect(NON_BEER_NAME_TOKENS).not.toContain(unsafe);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/drink-boundary.test.ts`
Expected: FAIL with "classifyOrphanAsNonBeer is not exported".

- [ ] **Step 3: Implement**

Append to `src/domain/drink-boundary.ts`:

```ts
// Deliberately NARROWER than STYLE_TOKENS: only unambiguous drink-category words, and
// never a bare wine token — 268 matched beers carry wine/wino/vino (barleywine, barrel
// ageing) and 257 carry a food word. #430.
export const NON_BEER_NAME_TOKENS = [
  'spritz', 'sangria', 'mojito', 'prosecco', 'frizzante', 'aperol', 'aperitivo',
  'nalewka', 'szprycer', 'wódka', 'wodka', 'vodka',
] as const;

export interface OrphanBoundaryInput {
  brewery: string;
  name: string;
  style: string | null;
  candidates_count: number;
}

// Word set, not substring search: `\b` in JS is ASCII-only and would break on `wódka`,
// and a substring test puts `wine` inside `Dwinell` and `spritz` inside `spritzered`.
function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

// Runs ONLY on a row that has already failed an Untappd search. That condition is what
// makes a name-side test safe: every dangerous beer above matched, so it is never here.
export function classifyOrphanAsNonBeer(
  row: OrphanBoundaryInput,
): { nonBeer: true; token: string } | null {
  // 1. Untappd returned something — let the model judge it.
  if (row.candidates_count !== 0) return null;

  const haystack = `${row.brewery} ${row.name} ${row.style ?? ''}`.toLowerCase();

  // 2. An eligible family named anywhere wins, and wins as a SUBSTRING: the asymmetry
  //    says a false "eligible" costs one search while a false not_a_beer is forever.
  if (ELIGIBLE_TOKENS.some((token) => haystack.includes(token))) return null;

  // 3. A non-beer category word, on a word boundary.
  const bag = words(haystack);
  const hit = NON_BEER_NAME_TOKENS.find((token) => bag.has(token));
  return hit ? { nonBeer: true, token: hit } : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/drink-boundary.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation-prove all three conditions**

Disable each in turn and confirm a **named** test goes red, then restore:
1. Delete the `candidates_count !== 0` line → `declines when Untappd returned candidates` must fail.
2. Delete the `ELIGIBLE_TOKENS` line → `declines when an eligible family is named` and `keeps LOBSTER Brewery / Kombucha Calamansi` must fail.
3. Replace the word-set test with `haystack.includes(token)` → `matches on a word boundary, never a substring` must fail.

- [ ] **Step 6: Commit**

```bash
git add src/domain/drink-boundary.ts src/domain/drink-boundary.test.ts
git commit -m "feat(#430): classifyOrphanAsNonBeer, the post-search enforcer

A name-side token test at ingest would destroy 554 already-matched beers.
Conditioning it on 'already an orphan' removes that population by
construction — those beers matched, so they are never here.

Three necessary conditions: zero candidates, no eligible family named
anywhere on the row, and a category word on a word boundary. The token
list is narrower than the ingest lists and deliberately excludes bare
wine/wino/vino. Pure function; nothing calls it yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K91mQ7rDMf2SfmdUfG4k8S"
```

---

### Task 5: Wire the enforcer into the failure path, in shadow mode

**Files:**
- Modify: `src/domain/drink-boundary.ts` — add the shadow constant
- Modify: `src/domain/lookup-outcome.ts:50-62` — the `not_found` case
- Modify: `src/domain/lookup-outcome.test.ts`

**Interfaces:**
- Consumes: `classifyOrphanAsNonBeer` from Task 4; `setEnrichFailureReview(db, beerId, reviewClass, note, atIso, issueNumber?)` from `src/storage/enrich_failures.ts`, which returns `'written' | 'no_row' | 'refused_unaskable' | 'refused_unproved_absence'`.
- Produces: nothing later depends on this.

`applyLookupOutcome` is shared by the enrich cron and the `/enrich/result` relay endpoint, so wiring it here covers both paths at once.

- [ ] **Step 1: Write the failing test**

Append to `src/domain/lookup-outcome.test.ts`, following the existing in-memory DB setup in that file:

```ts
import { SHADOW_ONLY } from './drink-boundary';

describe('#430 post-search non-beer enforcer', () => {
  it('logs what it would classify and writes NO review_class while shadowed', () => {
    expect(SHADOW_ONLY).toBe(true); // the flip is a deliberate, separate change
    const warns: unknown[] = [];
    const log = { warn: (o: unknown) => warns.push(o), error: () => {} } as never;

    applyLookupOutcome({ db, log }, beerId, {
      kind: 'not_found', searchUrls: ['https://x/?q=aperol+spritz'], candidates: [],
    } as never, '2026-08-22T00:00:00.000Z', { brewery: 'Culaccino', name: 'Aperol Spritz' });

    const row = db.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
      .get(beerId) as { review_class: string | null };
    expect(row.review_class).toBeNull();          // the DB write, not just the log
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ beerId, token: 'spritz', shadow: true });
  });

  it('says nothing at all about a row it would not classify', () => {
    const warns: unknown[] = [];
    const log = { warn: (o: unknown) => warns.push(o), error: () => {} } as never;

    applyLookupOutcome({ db, log }, beerId, {
      kind: 'not_found', searchUrls: ['https://x/?q=hazy+ipa'], candidates: [],
    } as never, '2026-08-22T00:00:00.000Z', { brewery: 'Pinta', name: 'Hazy IPA' });

    expect(warns).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/lookup-outcome.test.ts`
Expected: FAIL with "SHADOW_ONLY is not exported".

- [ ] **Step 3: Implement**

In `src/domain/drink-boundary.ts`:

```ts
// #430: the enforcer writes nothing until a week of shadow logs has been compared with
// what the model decided for the same rows. Flipping this to false is the whole change.
// The reason this is not shipped live: the defect that motivated it was a rule that ran
// unattended for six days and destroyed rows nobody was watching.
export const SHADOW_ONLY = true;
```

In `src/domain/lookup-outcome.ts`, inside `case 'not_found':` **after** the existing
`recordEnrichFailure` and `recordLookupNotFound` calls (the row must exist before it can
be reviewed) and before `return 'not_found'`:

```ts
      const boundary = classifyOrphanAsNonBeer({
        brewery: input.brewery,
        name: input.name,
        style: null,
        candidates_count: outcome.candidates.length,
      });
      if (boundary) {
        if (SHADOW_ONLY) {
          deps.log.warn(
            { beerId, token: boundary.token, name: input.name, shadow: true },
            'drink-boundary: would classify as not_a_beer',
          );
        } else {
          const result = setEnrichFailureReview(
            deps.db, beerId, 'not_a_beer', `auto: ${boundary.token}`, nowIso, null,
          );
          if (result !== 'written') {
            deps.log.warn({ beerId, result }, 'drink-boundary: auto-classify refused');
          }
        }
      }
```

`style` is `null` because `applyLookupOutcome`'s `input` carries no style; the brewery and
name are the fields the rule needs. Add the two imports at the top of the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/lookup-outcome.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the non-shadow branch is not dead code**

Temporarily set `SHADOW_ONLY = false`, add a scratch assertion that `review_class` becomes `'not_a_beer'` and that `setEnrichFailureReview` returned `'written'`, run the file, then revert both. A seed that writes through a guarded API can silently no-op — confirm the write, do not assume it.

- [ ] **Step 6: Commit**

```bash
git add src/domain/drink-boundary.ts src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts
git commit -m "feat(#430): run the drink-boundary enforcer on the failure path, shadowed

applyLookupOutcome is shared by the enrich cron and the /enrich/result
relay, so one call site covers both. It writes nothing yet: SHADOW_ONLY
logs what it would classify so a week of runs can be compared against the
model's own verdicts before an irreversible class is handed to a rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K91mQ7rDMf2SfmdUfG4k8S"
```

---

### Task 6: Un-bury the 16 wrongly-classified rows

**Files:**
- Create: `scripts/rearm-eligible-drinks.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (it is a data repair, deliberately independent of the code changes).
- Produces: nothing.

`not_a_beer` is the only hard pool exclusion, so clearing it restores the row to both pools with no other machinery. `fail_count` and `last_at` are left alone so backoff history survives.

**The id list is explicit, never a `LIKE` predicate** — it was enumerated from prod on 2026-08-22 and a predicate could widen against a row nobody inspected.

- [ ] **Step 1: Write the script**

```ts
// One-shot repair for #430: 16 rows classified not_a_beer while being cider, kvass or
// kombucha — every one written by the model between 2026-08-16 and 2026-08-21 under the
// prompt this issue fixes. Enumerated from prod, never re-derived by a LIKE predicate.
import Database from 'better-sqlite3';

const IDS = [
  258, 298, 366, 391, 11966, 11989, 12272, 29906,
  29931, 29940, 30122, 30134, 30135, 31246, 31299, 33659,
];

const path = process.argv[2];
if (!path) throw new Error('usage: rearm-eligible-drinks <db-path> [--apply]');
const apply = process.argv.includes('--apply');
const db = new Database(path, { readonly: !apply });

const before = db.prepare(
  `SELECT COUNT(*) n FROM enrich_failures WHERE review_class = 'not_a_beer'`,
).get() as { n: number };
const untriagedBefore = db.prepare(
  `SELECT COUNT(*) n FROM enrich_failures
    WHERE review_class IS NULL AND outcome = 'not_found' AND retired_at IS NULL`,
).get() as { n: number };
const targets = db.prepare(
  `SELECT beer_id, brewery, name FROM enrich_failures
    WHERE beer_id IN (${IDS.join(',')}) AND review_class = 'not_a_beer'`,
).all();

console.log(`not_a_beer before: ${before.n}   untriaged before: ${untriagedBefore.n}`);
console.log(`rows matching the id list AND still not_a_beer: ${targets.length} of ${IDS.length}`);
for (const t of targets) console.log(' ', t);

if (!apply) { console.log('\nDRY RUN — pass --apply to write'); process.exit(0); }

const info = db.prepare(
  `UPDATE enrich_failures
      SET review_class = NULL, review_note = NULL, reviewed_at = NULL, issue_number = NULL
    WHERE beer_id IN (${IDS.join(',')}) AND review_class = 'not_a_beer'`,
).run();
const after = db.prepare(
  `SELECT COUNT(*) n FROM enrich_failures WHERE review_class = 'not_a_beer'`,
).get() as { n: number };
const untriagedAfter = db.prepare(
  `SELECT COUNT(*) n FROM enrich_failures
    WHERE review_class IS NULL AND outcome = 'not_found' AND retired_at IS NULL`,
).get() as { n: number };
console.log(`updated: ${info.changes}`);
console.log(`not_a_beer after: ${after.n}   untriaged after: ${untriagedAfter.n}`);
```

- [ ] **Step 2: Dry-run against a byte copy of the prod DB**

Project policy: an irreversible rewrite is proven against a copy first, and every number that moved is reconciled. Use `VACUUM INTO`, never `cp` — the live WAL is larger than the DB.

```bash
sudo -n -u warsaw-beer-bot bash -lc "sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \"VACUUM INTO '/tmp/bot-copy-430.db'\""
sudo -n -u warsaw-beer-bot bash -lc "chmod a+r /tmp/bot-copy-430.db"
npx tsx scripts/rearm-eligible-drinks.ts /tmp/bot-copy-430.db
```

Expected: `16 of 16` rows listed, and the printed names are all cider/kvass/kombucha. **If it reports fewer than 16, stop and report** — a row changed class since the measurement and the list needs re-deriving, not forcing.

- [ ] **Step 3: Apply to the copy and reconcile**

```bash
npx tsx scripts/rearm-eligible-drinks.ts /tmp/bot-copy-430.db --apply
```

Expected, and each must be checked rather than skimmed: `updated: 16`; `not_a_beer` falls by exactly 16 (83 → 67); untriaged rises by exactly 16. Any other arithmetic means the predicate touched something unintended.

- [ ] **Step 4: Commit the script only**

Production is NOT written in this task — `scripts/*.ts` never reach prod (tsc emits `src/` only), so this runs from the working tree here after the PR merges and deploys.

```bash
git add scripts/rearm-eligible-drinks.ts
git commit -m "chore(#430): one-shot re-arm for the 16 wrongly-buried eligible drinks

Cider, kvass and kombucha rows classed not_a_beer between 2026-08-16 and
2026-08-21 under the prompt Task 3 fixes. not_a_beer is the only hard pool
exclusion, so clearing it is the whole repair. Explicit id list, dry-run
by default, reconciles not_a_beer and untriaged counts on both sides.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K91mQ7rDMf2SfmdUfG4k8S"
```

---

## After the plan

1. Open the PR and wait for the AI review; verify each comment rather than accepting or dismissing it.
2. After merge + deploy, run Task 6's script against **prod** with `--apply` and reconcile the same three numbers.
3. `spec.md` — check whether the drink boundary belongs in it; if so, update it in this PR.
4. Open the follow-up issue for the shadow-mode comparison, and rewrite #430 to its narrower routing scope.
