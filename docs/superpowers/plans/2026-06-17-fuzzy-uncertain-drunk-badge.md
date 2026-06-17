# Fuzzy "uncertain drunk" (`❓`) Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a distinct, clickable `❓ {global rating}` badge for shop beers the user has drunk but that matched via the fuzzy path (instead of the misleading plain `⭐`).

**Architecture:** The server's `POST /match` gains one additive boolean `drunk_uncertain` (true when a match is `fuzzy` AND the beer is in the user's drunk set). The extension reads it and renders a new `❓` badge slotted between `✅` (certain drunk) and `⭐` (rated, not drunk). `is_drunk`/`user_rating` semantics are untouched, so older installed extensions degrade to today's behaviour.

**Tech Stack:** TypeScript, Node, Hono (server `/match`), vitest (extension tests), jest→vitest (server tests; root project test runner is `vitest run`), MV3 browser extension (vanilla TS).

**Spec:** `docs/superpowers/specs/2026-06-17-fuzzy-uncertain-drunk-badge-design.md`

---

## File Structure

**Server (root project, runner: `npm test` = `vitest run`):**
- Modify `src/domain/match-list.ts` — add `drunk_uncertain` to `MatchListResult` + populate it.
- Modify `src/domain/match-list.test.ts` — assert `drunk_uncertain` across exact/fuzzy/no-match.

**Extension (`extension/`, runner: `npm test` = `vitest run` from `extension/`):**
- Modify `extension/src/api/types.ts` — add `drunk_uncertain` to `MatchResult`.
- Modify `extension/src/content/badge.ts` — new `❓` branch in `badgeFor`.
- Modify `extension/src/content/badge.test.ts` — badge rendering/clickability tests.
- Modify `extension/src/cache/store.ts` — defensive read note (no code change needed; verify reads tolerate a missing field).

**Docs (root project):**
- Modify `spec.md` — badge state + revise #108 wording.
- Modify `docs/extension-install-uk.md` — add `❓` to the badge legend.

> **Note on the two `MatchResult` shapes:** the server returns `MatchListResult` (`src/domain/match-list.ts`); the extension has its **own** `MatchResult` (`extension/src/api/types.ts`). They are independent declarations of the same JSON — both must gain `drunk_uncertain`. Keep field name/type identical.

---

## Task 1: Server — add `drunk_uncertain` to the match result

**Files:**
- Modify: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts`

Context: `matchBeerList` loops over input beers, calls `matchPrepared(item, prepared)` which
returns `{ id, confidence, source: 'exact' | 'fuzzy' }` or `null`. Today it sets
`is_drunk: m.source === 'exact' && drunkSet.has(m.id)`. We add the fuzzy counterpart.

- [ ] **Step 1: Read the current test file to match its harness style**

Run: `sed -n '1,140p' src/domain/match-list.test.ts`
Note how the catalog fixture, `drunkSet`, `ratings`, and `matchBeerList(...)` are set up,
and find the existing test titled `'a fuzzy match never claims drunk or personal rating'`
(it uses `Atak Chmiel` → catalog `Atak Chmielu`, id `200`, which is in the drunk set).

- [ ] **Step 2: Update the existing fuzzy test + add new assertions (write failing test)**

In `src/domain/match-list.test.ts`, in the test `'a fuzzy match never claims drunk or personal rating'`, keep the existing `is_drunk`/`user_rating` assertions and ADD an assertion that the fuzzy-but-drunk result now flags uncertainty:

```ts
expect(res[0].is_drunk).toBe(false);
expect(res[0].user_rating).toBe(null);
expect(res[0].drunk_uncertain).toBe(true);   // NEW: fuzzy + in drunk set
```

Then add a new test right after it:

```ts
it('drunk_uncertain is false for exact, non-drunk-fuzzy, and no-match', async () => {
  // Exact + drunk → certain, not uncertain.
  const exactDrunk = await matchBeerList(catalog, drunkSet, ratings, [
    { brewery: 'Pinta', name: 'Atak Chmielu' },
  ]);
  expect(exactDrunk[0].is_drunk).toBe(true);
  expect(exactDrunk[0].drunk_uncertain).toBe(false);

  // Fuzzy match whose beer is NOT in the drunk set → not uncertain.
  const fuzzyNotDrunk = await matchBeerList(catalog, new Set<number>(), ratings, [
    { brewery: 'Pinta', name: 'Atak Chmiel' },
  ]);
  expect(fuzzyNotDrunk[0].is_drunk).toBe(false);
  expect(fuzzyNotDrunk[0].drunk_uncertain).toBe(false);

  // No catalog match → not uncertain.
  const noMatch = await matchBeerList(catalog, drunkSet, ratings, [
    { brewery: 'Nope', name: 'Does Not Exist At All' },
  ]);
  expect(noMatch[0].matched_beer).toBe(null);
  expect(noMatch[0].drunk_uncertain).toBe(false);
});
```

> If the local `catalog`/`drunkSet`/`ratings` variable names differ in this file, use the
> file's actual names (discovered in Step 1). The beer `Atak Chmielu`/id `200` and the
> typo `Atak Chmiel` are the file's existing fuzzy fixture — reuse them.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/domain/match-list.test.ts`
Expected: FAIL — `drunk_uncertain` is `undefined` (property does not exist yet), e.g.
`expected undefined to be true`.

- [ ] **Step 4: Add the field to the interface**

In `src/domain/match-list.ts`, add `drunk_uncertain` to `MatchListResult` (place it right
after `is_drunk`):

```ts
export interface MatchListResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  drunk_uncertain: boolean;
  user_rating: number | null;
}
```

- [ ] **Step 5: Populate the field in both push sites**

In `matchBeerList`, the no-match branch becomes:

```ts
if (!m) {
  out.push({ raw, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null });
} else {
```

and the matched branch's pushed object becomes (add the one line; leave `is_drunk`/`user_rating` exactly as they are):

```ts
  out.push({
    raw,
    matched_beer: {
      id: beer.id,
      name: beer.name,
      brewery: beer.brewery,
      rating_global: beer.rating_global,
      untappd_id: beer.untappd_id ?? null,
    },
    is_drunk: m.source === 'exact' && drunkSet.has(m.id),
    drunk_uncertain: m.source === 'fuzzy' && drunkSet.has(m.id),
    user_rating: m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
  });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/domain/match-list.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Typecheck**

Run: `npm run build`
Expected: exit 0 (no `tsc` errors). This catches any other in-repo caller of
`MatchListResult` that constructs the object literal and now needs the field.

> If `tsc` flags another construction site (e.g. a test helper), add `drunk_uncertain` there
> with the same `m.source === 'fuzzy' && drunkSet.has(m.id)` logic, or `false` for fixtures.

- [ ] **Step 8: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "feat(match): add drunk_uncertain (fuzzy + in drunk set) to /match result (#23-followup)"
```

---

## Task 2: Extension — add `drunk_uncertain` to the API type

**Files:**
- Modify: `extension/src/api/types.ts`

Context: the extension declares its own `MatchResult` mirroring the server JSON. All
extension commands below run from the `extension/` directory.

- [ ] **Step 1: Add the field**

In `extension/src/api/types.ts`, update `MatchResult`:

```ts
export interface MatchResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  drunk_uncertain: boolean;
  user_rating: number | null;
}
```

- [ ] **Step 2: Typecheck the extension**

Run (from repo root): `cd extension && npm run typecheck`
Expected: FAIL — existing test fixtures / call sites that build a `MatchResult` literal now
miss `drunk_uncertain`. That's expected; the next tasks fix the tests. (If it passes because
all `MatchResult`s are built via helpers, even better.)

- [ ] **Step 3: Commit**

```bash
git add extension/src/api/types.ts
git commit -m "feat(extension): add drunk_uncertain to MatchResult type"
```

---

## Task 3: Extension — render the `❓` badge

**Files:**
- Modify: `extension/src/content/badge.ts`
- Test: `extension/src/content/badge.test.ts`

Context: `badgeFor(result)` returns an `HTMLElement | null`. `makeBadge(text, untappdId)`
creates the badge and makes it clickable (opens the Untappd beer page) **only** when
`untappdId` is non-null. Current precedence: `is_drunk` → `✅`; else matched+bid+global →
`⭐`; else orphan (no bid) → `⚪`; else null. We insert the `❓` branch after `is_drunk`.

- [ ] **Step 1: Read the existing badge test to match its DOM harness**

Run: `sed -n '1,120p' extension/src/content/badge.test.ts`
Note how it builds a `MatchResult`, calls `renderBadge`/`badgeFor`, and reads
`textContent` / asserts clickability (look for `click`, `window.open`, or `cursor`).

- [ ] **Step 2: Write failing tests for the `❓` badge**

Add to `extension/src/content/badge.test.ts` (adapt the result-builder + host-element setup
to the file's existing pattern from Step 1). The four cases from the spec:

```ts
describe('❓ uncertain-drunk badge', () => {
  const base = {
    raw: { brewery: 'Mad Brew', name: 'Bendera ya Uhuru' },
    is_drunk: false,
    drunk_uncertain: true,
    user_rating: null,
  };

  it('renders ❓ + global rating and is clickable when a bid exists', () => {
    const host = document.createElement('div');
    renderBadge(host, {
      ...base,
      matched_beer: { id: 1, name: 'Bendera ya Uhuru', brewery: 'Mad Brew', rating_global: 3.9, untappd_id: 6024297 },
    });
    const badge = host.querySelector('[data-beerbadge]') as HTMLElement;
    expect(badge.textContent).toBe('❓ 3.9');
    expect(badge.style.cursor).toBe('pointer');
  });

  it('renders bare ❓ when there is no global rating', () => {
    const host = document.createElement('div');
    renderBadge(host, {
      ...base,
      matched_beer: { id: 1, name: 'X', brewery: 'Y', rating_global: null, untappd_id: 6024297 },
    });
    expect(host.querySelector('[data-beerbadge]')!.textContent).toBe('❓');
  });

  it('renders bare ❓ and is not clickable for a drunk-uncertain orphan (no bid)', () => {
    const host = document.createElement('div');
    renderBadge(host, {
      ...base,
      matched_beer: { id: 1, name: 'X', brewery: 'Y', rating_global: null, untappd_id: null },
    });
    const badge = host.querySelector('[data-beerbadge]') as HTMLElement;
    expect(badge.textContent).toBe('❓');
    expect(badge.style.cursor).toBe('default');
  });

  it('is_drunk wins over drunk_uncertain (still ✅)', () => {
    const host = document.createElement('div');
    renderBadge(host, {
      ...base,
      is_drunk: true,
      drunk_uncertain: true, // should never co-occur, but assert precedence anyway
      user_rating: 4.2,
      matched_beer: { id: 1, name: 'X', brewery: 'Y', rating_global: 3.9, untappd_id: 6024297 },
    });
    expect(host.querySelector('[data-beerbadge]')!.textContent).toBe('✅ 4.2');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from repo root): `cd extension && npm test -- src/content/badge.test.ts`
Expected: FAIL — the uncertain cases currently fall through to `⭐`/`⚪` (e.g.
`expected '⭐ 3.9' to be '❓ 3.9'`).

- [ ] **Step 4: Implement the `❓` branch**

In `extension/src/content/badge.ts`, update the comment and `badgeFor` to insert the new
branch immediately after the `is_drunk` block:

```ts
// drunk → ✅ (+ personal rating); fuzzy-match-but-drunk → ❓ (+ global rating, uncertain);
// not-drunk with a bid + global rating → ⭐; not-drunk matched orphan (no bid) → ⚪;
// truly unmatched (matched_beer null) → no badge.
function badgeFor(result: MatchResult): HTMLElement | null {
  if (result.is_drunk) {
    return makeBadge(result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅', null);
  }
  const m = result.matched_beer;
  if (!m) return null;
  if (result.drunk_uncertain) {
    return makeBadge(m.rating_global != null ? `❓ ${m.rating_global.toFixed(1)}` : '❓', m.untappd_id);
  }
  if (m.untappd_id != null && m.rating_global != null) {
    return makeBadge(`⭐ ${m.rating_global.toFixed(1)}`, m.untappd_id);
  }
  if (m.untappd_id == null) return makeBadge('⚪', null);
  return null;
}
```

> Note the `❓` branch sits **after** the `if (!m) return null;` guard, so `m` is non-null
> and `m.untappd_id` is safely passed to `makeBadge` (null bid → non-clickable, by design).

- [ ] **Step 5: Run the tests to verify they pass**

Run (from repo root): `cd extension && npm test -- src/content/badge.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts
git commit -m "feat(extension): render ❓ uncertain-drunk badge for fuzzy matches"
```

---

## Task 4: Extension — tolerate a cache miss of the new field, fix remaining typecheck

**Files:**
- Modify (if needed): `extension/src/cache/store.ts`
- Possibly modify: any extension test/helper still constructing `MatchResult` literals.

Context: `extension/src/cache/store.ts` `getCached` returns `MatchResult | null` from
persisted storage. A `MatchResult` cached by an older extension build lacks
`drunk_uncertain`. At runtime a missing field reads as `undefined`, which is falsy, so
`badgeFor`'s `if (result.drunk_uncertain)` already degrades safely to `⭐` — no code change
is required for correctness. This task confirms that and clears any leftover `tsc` errors.

- [ ] **Step 1: Run the full extension typecheck**

Run (from repo root): `cd extension && npm run typecheck`
Expected: either PASS, or FAIL listing specific files that build a `MatchResult` literal
without `drunk_uncertain` (e.g. test fixtures, `client.test.ts`, `main.test.ts`).

- [ ] **Step 2: Fix each flagged construction site**

For every literal the compiler flags, add `drunk_uncertain: false` (fixtures represent
"not uncertain" unless the test is specifically about uncertainty). Do NOT add it via a
default in `store.ts` — keep the type honest; runtime tolerance comes from the falsy read.

Example shape of an edit:

```ts
// before
const r: MatchResult = { raw, matched_beer: null, is_drunk: false, user_rating: null };
// after
const r: MatchResult = { raw, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null };
```

- [ ] **Step 3: Re-run typecheck + full extension test suite**

Run (from repo root): `cd extension && npm run typecheck && npm test`
Expected: typecheck exit 0; all extension tests PASS.

- [ ] **Step 4: Commit (only if files changed)**

```bash
git add -A extension/
git commit -m "test(extension): set drunk_uncertain on MatchResult fixtures"
```

> If Step 1 already passed and nothing changed, skip the commit and note it in the report.

---

## Task 5: Docs — `spec.md` + extension install guide

**Files:**
- Modify: `spec.md`
- Modify: `docs/extension-install-uk.md`

Context: CLAUDE.md requires `spec.md` to stay the source of truth, and any user-facing
extension change to update `docs/extension-install-uk.md`, in the same PR.

- [ ] **Step 1: Find the badge/`is_drunk` description in `spec.md`**

Run: `grep -niE "is_drunk|⭐|⚪|fuzzy|drunk|badge|значок|бейдж" spec.md`
Identify the section that describes the `/match` badges and the #108 "fuzzy never asserts
drunk" statement.

- [ ] **Step 2: Update `spec.md`**

In the badge/`/match` section: add the `❓` state and the `drunk_uncertain` field, and
revise the #108 wording. Concretely, where the spec says fuzzy matches never assert drunk,
change it to describe the new behaviour (match the surrounding Ukrainian phrasing/format):

> Раніше: «fuzzy-збіг ніколи не стверджує drunk/особистий рейтинг».
> Тепер: «fuzzy-збіг для випитого пива позначається **`❓` (ймовірно випите, без певності)** з
> глобальним рейтингом і кліком на Untappd для перевірки; особистий рейтинг (`user_rating`)
> лишається тільки для exact-збігів. Поле відповіді: `drunk_uncertain: boolean`
> (= fuzzy-збіг І пиво в drunk-set).»

Keep it consistent with how the existing badges (`✅`/`⭐`/`⚪`) are documented there.

- [ ] **Step 3: Update `docs/extension-install-uk.md`**

Run: `grep -niE "⭐|⚪|✅|значок|бейдж|badge" docs/extension-install-uk.md`
Add `❓` to the badge legend next to the others, e.g.:

> `❓ <рейтинг>` — ви, ймовірно, вже пили це пиво, але збіг неточний (fuzzy). Клік відкриває
> Untappd для перевірки.

Match the file's existing legend formatting and language.

- [ ] **Step 4: Sanity-check no stale "fuzzy never drunk" wording remains**

Run: `grep -niE "fuzzy.*(never|ніколи).*(drunk|випит)" spec.md docs/extension-install-uk.md`
Expected: no matches (the old absolute statement is gone/updated).

- [ ] **Step 5: Commit**

```bash
git add spec.md docs/extension-install-uk.md
git commit -m "docs: document ❓ uncertain-drunk badge in spec + extension install guide"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Root project tests + build**

Run (from repo root): `npm test && npm run build`
Expected: all server tests PASS; `tsc` exit 0.

- [ ] **Step 2: Extension tests + typecheck**

Run (from repo root): `cd extension && npm test && npm run typecheck`
Expected: all extension tests PASS; typecheck exit 0.

- [ ] **Step 3: Confirm the badge-state matrix end to end**

Re-read `badgeFor` in `extension/src/content/badge.ts` against the spec's precedence table
(✅ → ❓ → ⭐ → ⚪ → none) and confirm the order matches. Confirm `match-list.ts` sets
`is_drunk` and `drunk_uncertain` mutually exclusively (exact xor fuzzy).

- [ ] **Step 4: Grep for leftover absolutes**

Run (from repo root): `git grep -niE "fuzzy.*(never|ніколи).*(drunk|випит)" -- ':!docs/superpowers/'`
Expected: no matches outside the archived superpowers specs/plans.

---

## Self-Review (completed by plan author)

- **Spec coverage:** server field (Task 1), extension type (Task 2), `❓` rendering +
  clickability + precedence (Task 3), backward-compat/cache + fixture typecheck (Task 4),
  spec.md + extension-install docs (Task 5), full verification (Task 6). Edge cases
  (orphan `❓`, no-global-rating `❓`, cache miss) covered in Tasks 3–4. ✅
- **Placeholder scan:** no TBD/TODO; all code steps show real code; test bodies are
  concrete. The only conditional is Task 4 (fix whatever `tsc` flags) — bounded with an
  exact edit shape and a do-not-default constraint. ✅
- **Type consistency:** `drunk_uncertain: boolean` placed after `is_drunk` in BOTH
  `MatchListResult` (server) and `MatchResult` (extension); populated as
  `m.source === 'fuzzy' && drunkSet.has(m.id)`; read as `result.drunk_uncertain` in
  `badgeFor`. Field name identical across server/extension/tests/docs. ✅
