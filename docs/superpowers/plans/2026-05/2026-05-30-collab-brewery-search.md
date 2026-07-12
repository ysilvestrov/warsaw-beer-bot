# Collab Brewery Search Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `enrich-orphans` returning `not_found` for all collab brewery beers by (1) adding ` x `/` X ` as a collab separator in `breweryAliases` so the brewery gate passes, and (2) retrying Untappd search with each brewery part separately so a single unregistered partner doesn't poison the query to zero results.

**Architecture:** Two changes, both in `src/domain/`. A new `COLLAB_SEP` regex constant is exported from `matcher.ts` and reused in `untappd-lookup.ts` so the split logic never drifts. In `lookupBeer`, the single `fetch(brewery + name)` call becomes a loop over `brewerySearchParts(brewery)` — for non-collab breweries this is identical to current behaviour (one part = one request). Transient errors still short-circuit immediately; `not_found` is returned only after all parts are exhausted.

**Tech Stack:** TypeScript, Jest. No new dependencies.

**Empirical basis (user-verified 2026-05-30):**
- `"TankBusters/Blech.Brut/Yeast Side Labs Brewery S.M.O.K.E."` → Untappd returns 0 results
- `"TankBusters S.M.O.K.E."` → finds the beer (correct result first)
- `"Blech.Brut S.M.O.K.E."` → finds the beer
- `"Yeast Side Labs Brewery S.M.O.K.E."` → 0 results (brewery not on Untappd)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/domain/matcher.ts` | Modify | Add `x`/`X` connector to `COLLAB_SEP`; export `COLLAB_SEP` |
| `src/domain/matcher.test.ts` | Modify | Two new `breweryAliases` tests for `x`-connector |
| `src/domain/untappd-lookup.ts` | Modify | Import `COLLAB_SEP`; add `brewerySearchParts`; loop over parts in `lookupBeer` |
| `src/domain/untappd-lookup.test.ts` | Modify | Four new `lookupBeer` tests covering collab retry, x-connector, transient short-circuit, all-parts-empty |

No new files. No storage, bot, or job changes.

---

## Task 1: Add x-connector to `breweryAliases`

**Files:**
- Modify: `src/domain/matcher.ts:28-49`
- Modify: `src/domain/matcher.test.ts` (append two tests inside the `breweryAliases` describe block)

- [ ] **Step 1: Write the two failing tests**

Open `src/domain/matcher.test.ts`. Inside the `describe('breweryAliases', ...)` block, after the existing `'multi-slash collab (A/B/C)'` test (around line 90), append:

```ts
  test('x-connector collab (lower case x) returns full + each side', () => {
    const out = breweryAliases('ZIEMIA OBIECANA x Weźże Krafta Brewery');
    expect(new Set(out)).toEqual(
      new Set(['ziemia obiecana x wezze krafta', 'ziemia obiecana', 'wezze krafta']),
    );
  });

  test('X-connector collab (upper case X) returns full + each side', () => {
    const out = breweryAliases('HOPITO X SADY Brewery');
    expect(new Set(out)).toEqual(
      new Set(['hopito x sady', 'hopito', 'sady']),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest --testPathPattern="matcher.test" --no-coverage 2>&1 | tail -20
```

Expected: two failures — `Expected: Set {"ziemia obiecana x wezze krafta", "ziemia obiecana", "wezze krafta"} Received: Set {"ziemia obiecana x wezze krafta"}` (only the full form, no split).

- [ ] **Step 3: Implement the fix in `matcher.ts`**

In `src/domain/matcher.ts`, replace the block starting at the comment and the `slashRegex`/`slashParts` lines:

Find:
```ts
// Untappd records breweries either as a single name ("Piwne Podziemie Brewery"),
// as a slash alias used for bilingual ("Piwne Podziemie / Beer Underground")
// or collaboration ("Sady/Beer Bacon and Liberty Brewery") pairs, or as an
// "X (Y)" form for German aliases ("Kemker Kultuur (Brauerei J. Kemker)").
// The slash form appears with any spacing around "/" (with, without, or one
// side only) — the regex absorbs all variants. Ontap.pl renders only one of
// these. For matching purposes all forms collapse to: "any side of the
// separator is a valid brewery for this beer".
export function breweryAliases(brewery: string): string[] {
  const aliases = new Set<string>();
  const full = normalizeBrewery(brewery);
  if (full) aliases.add(full);

  const slashRegex = /\s*\/\s*/;
  const slashParts = slashRegex.test(brewery) ? brewery.split(slashRegex) : [brewery];
  for (const part of slashParts) {
```

Replace with:
```ts
// Separator regex for collab/bilingual brewery names. Untappd uses:
//   "A / B"  — slash with any spacing (bilingual or collab)
//   "A x B"  — " x "/" X " connector (collab, case-insensitive)
//   "A (B)"  — paren form for German aliases
// Ontap.pl renders only one side. All forms collapse to: "any side is valid".
export const COLLAB_SEP = /\s*\/\s*|\s+[Xx]\s+/;

export function breweryAliases(brewery: string): string[] {
  const aliases = new Set<string>();
  const full = normalizeBrewery(brewery);
  if (full) aliases.add(full);

  const collabParts = COLLAB_SEP.test(brewery) ? brewery.split(COLLAB_SEP) : [brewery];
  for (const part of collabParts) {
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest --testPathPattern="matcher.test" --no-coverage 2>&1 | tail -20
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/domain/matcher.ts src/domain/matcher.test.ts && git commit -m "$(cat <<'EOF'
feat(matcher): split on ' x '/' X ' collab connector in breweryAliases

ZIEMIA OBIECANA x Weźże Krafta and HOPITO X SADY style brewery names
now produce individual-side aliases alongside the full combined form,
so the brewery hard-gate in lookupBeer passes when Untappd stores the
beer under just one collab partner's name.

Also exports COLLAB_SEP for reuse in untappd-lookup (next commit).
EOF
)"
```

---

## Task 2: Add collab-part retry to `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Modify: `src/domain/untappd-lookup.test.ts` (append four new tests)

- [ ] **Step 1: Write the four failing tests**

Open `src/domain/untappd-lookup.test.ts`. After the last existing test (`'empty search results return not_found'`, around line 94), append:

```ts
  test('non-collab brewery: single fetch call (behaviour unchanged)', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 1, name: 'Fifty/Fifty', brewery: 'Magic Road' }]),
    );
    await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Fifty/Fifty', fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('Magic%20Road%20Brewery'));
  });

  test('slash collab: first part returns 0 results, second part matches', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce('<html><body></body></html>')
      .mockResolvedValueOnce(
        htmlFor([{ bid: 7777, name: 'S.M.O.K.E.', brewery: 'TankBusters / Blech.Brut' }]),
      );
    const out = await lookupBeer({
      brewery: 'TankBusters/Blech.Brut/Yeast Side Labs Brewery',
      name: 'S.M.O.K.E.',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(7777);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining('TankBusters'));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining('Blech.Brut'));
  });

  test('x-connector collab: first part finds the beer', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 8888, name: 'NOT YOUR MILKSHAKE', brewery: 'Ziemia Obiecana' }]),
    );
    const out = await lookupBeer({
      brewery: 'ZIEMIA OBIECANA x Weźże Krafta Brewery',
      name: 'NOT YOUR MILKSHAKE',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(8888);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('ZIEMIA%20OBIECANA'));
  });

  test('collab: transient on any part short-circuits immediately', async () => {
    const boom = new Error('ETIMEDOUT');
    const fetch = jest.fn(async () => { throw boom; });
    const out = await lookupBeer({
      brewery: 'TankBusters/Blech.Brut Brewery',
      name: 'S.M.O.K.E.',
      fetch,
    });
    expect(out.kind).toBe('transient');
    if (out.kind !== 'transient') return;
    expect(out.error).toBe(boom);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest --testPathPattern="untappd-lookup.test" --no-coverage 2>&1 | tail -30
```

Expected: the four new tests fail (current implementation does one fetch with the full brewery string, so the slash-collab test sees one call instead of two, the x-connector test passes the full form to Untappd, etc.).

- [ ] **Step 3: Implement the fix in `untappd-lookup.ts`**

Replace the entire content of `src/domain/untappd-lookup.ts` with:

```ts
import { Searcher } from 'fast-fuzzy';
import { breweryAliases, COLLAB_SEP } from './matcher';
import { normalizeName } from './normalize';
import {
  buildSearchUrl,
  parseSearchPage,
  type SearchResult,
} from '../sources/untappd/search';

const NAME_FUZZY_THRESHOLD = 0.85;

export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found' }
  | { kind: 'transient'; error: unknown };

export interface LookupArgs {
  brewery: string;
  name: string;
  fetch: (url: string) => Promise<string>;
}

// Split a brewery name into individual parts for search queries.
// For non-collab breweries ("Magic Road Brewery") returns [brewery] unchanged.
// For collab breweries ("TankBusters/Blech.Brut/Yeast Side Labs Brewery")
// returns ["TankBusters", "Blech.Brut", "Yeast Side Labs Brewery"] so each
// part is tried as a separate Untappd search query. This avoids an unregistered
// collab partner poisoning the query to zero results.
function brewerySearchParts(brewery: string): string[] {
  const parts = brewery.split(COLLAB_SEP).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [brewery];
}

export async function lookupBeer(args: LookupArgs): Promise<LookupOutcome> {
  const { brewery, name, fetch } = args;
  const inputBreweryAliases = new Set(breweryAliases(brewery));
  const targetName = normalizeName(name);
  const parts = brewerySearchParts(brewery);

  for (const part of parts) {
    let html: string;
    try {
      html = await fetch(buildSearchUrl(`${part} ${name}`));
    } catch (error) {
      return { kind: 'transient', error };
    }

    const results = parseSearchPage(html);
    if (results.length === 0) continue;

    // Stage 1: brewery hard-gate — alias overlap.
    const breweryPassed = results.filter((r) => {
      const candidateAliases = breweryAliases(r.brewery_name);
      return candidateAliases.some((a) => inputBreweryAliases.has(a));
    });
    if (breweryPassed.length === 0) continue;

    // Stage 2: name fuzzy >= 0.85.
    const searcher = new Searcher(breweryPassed, {
      keySelector: (r) => normalizeName(r.beer_name),
      threshold: NAME_FUZZY_THRESHOLD,
      returnMatchData: true,
    });
    const matches = searcher.search(targetName);
    if (matches.length === 0) continue;

    return { kind: 'matched', result: matches[0].item };
  }

  return { kind: 'not_found' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest --testPathPattern="untappd-lookup.test" --no-coverage 2>&1 | tail -20
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts && git commit -m "$(cat <<'EOF'
feat(lookup): retry each collab brewery part as separate Untappd query

For slash-collab breweries (TankBusters/Blech.Brut/Yeast Side Labs),
a single unregistered partner used to poison the combined query to zero
results. lookupBeer now splits on COLLAB_SEP and tries each part
individually, stopping on the first match. Non-collab breweries are
unaffected (one part = one request, same as before).

Combined with the x-connector alias fix, this closes the main category
of not_found false negatives in enrich-orphans for collab beers.
EOF
)"
```

---

## Task 3: Full verification + PR

**Files:** N/A (verification and git only)

- [ ] **Step 1: Typecheck**

```bash
cd /home/ysi/warsaw-beer-bot && npm run typecheck 2>&1 | tail -10
```

Expected: exit code 0, no errors.

- [ ] **Step 2: Full test suite**

```bash
cd /home/ysi/warsaw-beer-bot && npm test 2>&1 | tail -20
```

Expected: all tests pass, 0 failures. No regressions in matcher, untappd-lookup, or any other module.

- [ ] **Step 3: Review the full diff**

```bash
cd /home/ysi/warsaw-beer-bot && git diff HEAD~2
```

Expected diff:
- `src/domain/matcher.ts`: comment updated, `COLLAB_SEP` exported, `slashRegex`/`slashParts` → `COLLAB_SEP`/`collabParts`
- `src/domain/matcher.test.ts`: two new `breweryAliases` tests
- `src/domain/untappd-lookup.ts`: import `COLLAB_SEP`, new `brewerySearchParts` helper, `lookupBeer` body replaced with loop
- `src/domain/untappd-lookup.test.ts`: four new `lookupBeer` tests

No other files touched.

- [ ] **Step 4: Push and open PR**

```bash
cd /home/ysi/warsaw-beer-bot && git push -u origin main
```

Wait — these commits are on `main`. If the project uses feature branches + PRs (as confirmed by git history showing merge commits), create a branch first:

```bash
cd /home/ysi/warsaw-beer-bot && git checkout -b feat/collab-brewery-search && git push -u origin feat/collab-brewery-search
```

Then open PR:

```bash
gh pr create --title "feat(lookup): fix collab brewery search — x-connector aliases + per-part retry" --body "$(cat <<'EOF'
## Summary
- `breweryAliases` now splits on ` x `/` X ` in addition to `/` and `()`, so beers with `ZIEMIA OBIECANA x Weźże Krafta`-style brewery names pass the brewery hard-gate when Untappd stores them under a single partner's name
- `lookupBeer` retries each collab brewery part as a separate Untappd search query; a single unregistered partner no longer poisons the combined query to zero results
- `COLLAB_SEP` regex exported from `matcher.ts` and reused in `untappd-lookup.ts` so the split logic stays in sync

**Empirical basis:** user-verified that `"TankBusters S.M.O.K.E."` finds the beer while `"TankBusters/Blech.Brut/Yeast Side Labs Brewery S.M.O.K.E."` returns 0 results.

## Test plan
- [x] `npm run typecheck` clean
- [x] `npm test` green (two new `breweryAliases` tests, four new `lookupBeer` tests)
- [ ] Post-deploy: watch `enrich-orphans done` logs — expect `matched` count to start rising above 0 for collab-brewery beers
- [ ] Post-deploy: check specific canary beers: `S.M.O.K.E.` (TankBusters/Blech.Brut/Yeast Side Labs), `NOT YOUR MILKSHAKE` (Ziemia Obiecana x Weźże Krafta)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Fix 1 (x-connector in aliases) → Task 1 ✓
- Fix 2 (per-part search retry) → Task 2 ✓
- Non-collab unchanged → Task 2 Step 1 test `'non-collab brewery: single fetch call'` ✓
- Transient short-circuits → Task 2 Step 1 test `'transient on any part short-circuits'` ✓
- All-parts-empty → covered by existing `'empty search results return not_found'` test (single part) + the collab retry loop falls through to `return { kind: 'not_found' }` ✓

**Placeholder scan:** No TBDs. Every step has code or command. ✓

**Type consistency:**
- `COLLAB_SEP` exported from `matcher.ts` line 22, imported in `untappd-lookup.ts` line 3 ✓
- `brewerySearchParts` returns `string[]`, consumed in `for (const part of parts)` ✓
- `LookupOutcome`, `LookupArgs`, `SearchResult` unchanged ✓
