# Matcher query over-constraint fixes (#270 + #271) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `cleanSearchQuery`/`lookupBeer` from building over-constrained Untappd/Algolia queries that AND-zero the search, per issues #270 (destructive split + dedup) and #271 (bare adjunct tails, narrowed to the safe delimiter-list slice).

**Architecture:** Two independent changes. (1) Rewrite the pure `cleanSearchQuery` in `src/domain/normalize.ts`: split brewery and name separately (never split a name on ` x `), and replace global fold-dedup with edge-run-only dedup (strip leading/trailing name tokens that duplicate a brewery brand token; keep mid-name duplicates). (2) Add a single, whole-lookup head-retry in `src/domain/untappd-lookup.ts` that fires only when the search returned zero candidates and the name has a `,`/`#N` flavour-list tail, recursing with the head. A read-only prod dry-run script measures the query-shape change before merge.

**Tech Stack:** TypeScript, Vitest (`npm test` → `vitest run`), better-sqlite3 (read-only prod replay), tsx.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-15-matcher-query-overconstraint-236-followups-design.md`

**Worktree/branch note for subagents:** Before committing in any task, run `git rev-parse --show-toplevel` and `git branch --show-current` and confirm you are in the intended worktree on the feature branch (NOT the main checkout). Report the toplevel path in your summary.

---

## Task 1: #270 — rewrite `cleanSearchQuery` (edge-run dedup, no name ` x ` split)

**Files:**
- Modify: `src/domain/normalize.ts:144-161` (`cleanSearchQuery`)
- Test: `src/domain/normalize.test.ts` (add cases to the existing `describe('cleanSearchQuery', …)` block, ~line 173-225)

- [ ] **Step 1: Add failing tests for the #270 cases**

Add these tests inside the existing `describe('cleanSearchQuery', () => { … })` block in `src/domain/normalize.test.ts` (append before the closing `});` at line 225):

```ts
  test('#270 31133: mid-name tokens repeating the brewery are kept, lone leading "x" dropped', () => {
    // Was destroyed to "Magic Road Upside Down: to" — Road/Upside dropped as dup-of-brewery.
    expect(
      cleanSearchQuery('Browar Magic Road', 'x Upside Down: Road to Upside'),
    ).toBe('Magic Road Upside Down: Road to Upside');
  });
  test('#270: mid-name token duplicating the brewery is kept (not deduped away)', () => {
    // OLD global dedup dropped the second "Milk" (part of the beer name) -> "Milk Coffee Stout".
    // NEW edge-run dedup keeps the mid-name "Milk"; a repeated identical Algolia term is harmless.
    expect(cleanSearchQuery('Milk Brewery', 'Coffee x Milk Stout')).toBe('Milk Coffee Milk Stout');
  });
  test('#270 31135: leading collab "x" dropped, rest of the name intact (regression guard)', () => {
    expect(cleanSearchQuery('Nepo Brewing', 'x Uncharted: Top-Tier')).toBe(
      'Nepo Uncharted: Top-Tier',
    );
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/domain/normalize.test.ts -t "#270"`
Expected: FAIL — 31133 currently returns `Magic Road Upside Down: to` (Road/Upside dropped by global dedup); the `Milk Brewery` case currently returns `Milk Coffee Stout` (second `Milk` deduped). The 31135 guard may already pass on the old code (it survived incidentally) — that is fine.

- [ ] **Step 3: Rewrite `cleanSearchQuery`**

Replace the entire body of `cleanSearchQuery` (lines 144-161) in `src/domain/normalize.ts` with:

```ts
export function cleanSearchQuery(brewery: string, name: string): string {
  const cleanBrewery = stripSearchNoise(stripLegalForm(brewery));
  const cleanName = stripSearchNoise(name);

  // Brewery brand tokens: split collab separators (defensive — detaches glued junk like
  // "collab/"), then whitespace; drop BREWERY_NOISE and empty folds; dedup by fold.
  const brandTokens: string[] = [];
  const brandFolds = new Set<string>();
  for (const tok of cleanBrewery.split(COLLAB_SEP).join(' ').split(/\s+/)) {
    const f = foldToken(tok);
    if (!f || BREWERY_NOISE.has(f) || brandFolds.has(f)) continue;
    brandFolds.add(f);
    brandTokens.push(tok);
  }

  // Name tokens: whitespace split, "/" -> space (unambiguous collab slash); drop lone collab
  // connectors ("x"), empty folds, and BREWERY_NOISE anywhere. The name is NEVER split on " x "
  // (#270): a name beginning "x <partner>:" is a shop artifact, not a collab-brewery separator.
  const nameTokens: string[] = [];
  for (const tok of cleanName.replace(/\//g, ' ').split(/\s+/)) {
    const f = foldToken(tok);
    if (!f || f === 'x' || BREWERY_NOISE.has(f)) continue;
    nameTokens.push(tok);
  }

  // Strip only the leading and trailing runs of name tokens that duplicate a brewery brand token
  // (the "name restates the brewery" case: #126 leading, #155 trailing). Mid-name duplicates are
  // KEPT (#270 "Road"/"Upside") — Algolia collapses a repeated identical term to one, so keeping
  // them is harmless while dropping them destroyed the beer name.
  let start = 0;
  let end = nameTokens.length;
  while (start < end && brandFolds.has(foldToken(nameTokens[start]))) start++;
  while (end > start && brandFolds.has(foldToken(nameTokens[end - 1]))) end--;

  const out = [...brandTokens, ...nameTokens.slice(start, end)];
  // Last resort: never emit an empty query.
  return out.length ? out.join(' ') : (cleanName || cleanBrewery || name.trim());
}
```

- [ ] **Step 4: Run the full normalize suite (new + existing regression tests)**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: PASS — all new #270 tests pass AND every pre-existing `cleanSearchQuery` test still passes, specifically:
- `#126 Track` → `TRACK Taking Shape`
- `#155 Trzech Kumpli` → `TRZECH KUMPLI Porter Bałtycki Żytnio-Orkiszowy` (trailing dedup preserved)
- `Alpha x Beta` / `Some Beer` → `Alpha Beta Some Beer`
- `Funky Fluid` / `Mosaic (collab Yakima Chief` → `Funky Fluid Mosaic Yakima Chief` (mid-name `collab` noise dropped)
- all fallback tests (`Brewing Co`/`Company` → `Company`, `''`/`(only)` → `(only)`)

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): edge-run dedup + no name x-split in cleanSearchQuery (#270)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: #271 — narrowed head-retry in `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (add `headBeforeTail` helper near line 32; thread `headRetried` param into `lookupBeer` at line 164; add the retry fallback before the final `return { kind: 'not_found', … }` at line 316)
- Test: `src/domain/untappd-lookup.test.ts` (append to the existing `describe('lookupBeer', …)` block)

- [ ] **Step 1: Write failing tests for the head-retry gates**

Append these tests inside the existing `describe('lookupBeer', () => { … })` block in `src/domain/untappd-lookup.test.ts`:

```ts
  test('#271 head-retry: zero candidates + comma/#N tail retries with the head and matches', async () => {
    const search = fakeSearch((q) =>
      q === 'Pinta Fantazja'
        ? [{ bid: 7000, beer_name: 'Fantazja', brewery_name: 'Pinta', style: 'Sour', abv: 5, global_rating: 3.7 }]
        : [],
    );
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Fantazja #1, Pastry Sour z Guavą, Mango', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(7000);
  });

  test('#271: no head-retry when the full query already returned candidates (even if unmatched)', async () => {
    let calls = 0;
    const search = fakeSearch(() => {
      calls++;
      return [{ bid: 9, beer_name: 'Whatever', brewery_name: 'Other Brewery', style: 'IPA', abv: 5, global_rating: 3 }];
    });
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Fantazja #1, Mango', search });
    expect(out.kind).toBe('not_found');
    expect(calls).toBe(1); // brewery gate rejected the candidate; retry must NOT fire
  });

  test('#271: no head-retry for a dash-only tail (excluded delimiter)', async () => {
    let calls = 0;
    const search = fakeSearch(() => { calls++; return []; });
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Imperial Stout - Barrel Aged', search });
    expect(out.kind).toBe('not_found');
    expect(calls).toBe(1); // no comma/#N delimiter → no head-retry
  });

  test('#271: single-retry guard — head-retry does not recurse forever', async () => {
    let calls = 0;
    const search = fakeSearch(() => { calls++; return []; });
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Fantazja, Mango, Guava', search });
    expect(out.kind).toBe('not_found');
    expect(calls).toBe(2); // original pass + exactly one head-retry pass
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "#271"`
Expected: FAIL — the first test returns `not_found` (no retry exists yet); the single-retry test sees `calls === 1`.

- [ ] **Step 3: Add the `headBeforeTail` helper**

Insert this helper in `src/domain/untappd-lookup.ts` immediately after the `brewerySearchParts` function (after line 42):

```ts
// #271: the head of a name up to the first bare adjunct/flavour-LIST delimiter — a comma or
// " #<n>". Deliberately EXCLUDES the " - " dash (often a real sub-edition) and any token cap, both
// of which risk truncating a legitimate name. Returns null when there is no such delimiter or the
// head is empty / equal to the whole name.
const TAIL_LIST_DELIMITER = /,|\s#\d/;
function headBeforeTail(name: string): string | null {
  const m = TAIL_LIST_DELIMITER.exec(name);
  if (!m) return null;
  const head = name.slice(0, m.index).trim();
  return head && head !== name.trim() ? head : null;
}
```

- [ ] **Step 4: Thread the `headRetried` guard param into `lookupBeer`**

Change the signature at line 164 from:

```ts
export async function lookupBeer(args: LookupArgs): Promise<LookupOutcome> {
```

to:

```ts
export async function lookupBeer(args: LookupArgs, headRetried = false): Promise<LookupOutcome> {
```

- [ ] **Step 5: Add the retry fallback before the final not_found return**

Replace the final `return { kind: 'not_found', searchUrls: triedUrls, candidates: seenCandidates };` (line 316) with:

```ts
  // #271 fallback: the search returned zero candidates across every brewery part — a genuine
  // query-zeroing (a matcher rejection would leave seenCandidates non-empty and is NOT retried).
  // If the name has a comma/#N flavour-list tail, retry the WHOLE lookup once with the head only,
  // so the tail cannot AND-zero the Algolia search. Matching then evaluates the head (brewery gate
  // unchanged) — this is what lets a short Untappd name match. Single retry (headRetried guard).
  if (!headRetried && seenCandidates.length === 0) {
    const head = headBeforeTail(name);
    if (head) {
      const retry = await lookupBeer({ ...args, name: head }, true);
      if (retry.kind === 'not_found') {
        return {
          kind: 'not_found',
          searchUrls: [...triedUrls, ...retry.searchUrls],
          candidates: retry.candidates,
        };
      }
      return retry;
    }
  }
  return { kind: 'not_found', searchUrls: triedUrls, candidates: seenCandidates };
```

- [ ] **Step 6: Run the lookup suite (new + existing)**

Run: `npx vitest run src/domain/untappd-lookup.test.ts`
Expected: PASS — all four #271 tests pass and every pre-existing `lookupBeer` test still passes.

- [ ] **Step 7: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(matcher): head-retry for comma/#N flavour-list tails (#271, narrowed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: prod dry-run replay — measure query-shape change (validation, read-only)

**Files:**
- Create: `./tmp/dryrun-270.ts` (ephemeral scratch — NOT committed; `./tmp/` is gitignored)

- [ ] **Step 1: Write the read-only replay script**

Create `./tmp/dryrun-270.ts`:

```ts
// Read-only replay of matcher_bug enrich_failures through the NEW cleanSearchQuery.
// Compares against the OLD query decoded from search_url (approximate: search_url stores the last
// tried part's URL, and for collab breweries uses a single part, so `before` is a best-effort
// baseline). Purpose: surface how many queries change shape and flag suspicious shortening.
import Database from 'better-sqlite3';
import { cleanSearchQuery } from '../src/domain/normalize';

const db = new Database('/var/lib/warsaw-beer-bot/bot.db', { readonly: true });
const rows = db.prepare(
  "SELECT beer_id, brewery, name, search_url FROM enrich_failures WHERE review_class='matcher_bug'",
).all() as { beer_id: number; brewery: string; name: string; search_url: string }[];

function oldQuery(searchUrl: string): string {
  try { return decodeURIComponent(new URL(searchUrl).searchParams.get('q') ?? ''); }
  catch { return ''; }
}

let changed = 0;
let newlyEmpty = 0;
const diffs: string[] = [];
for (const r of rows) {
  const before = oldQuery(r.search_url);
  const after = cleanSearchQuery(r.brewery, r.name);
  if (before !== after) {
    changed++;
    if (!after.trim()) newlyEmpty++;
    diffs.push(`#${r.beer_id}\n  brewery: ${r.brewery}\n  name:    ${r.name}\n  before:  ${before}\n  after:   ${after}`);
  }
}
console.log(`rows=${rows.length} changed=${changed} newly-empty=${newlyEmpty}`);
console.log('---');
console.log(diffs.join('\n\n'));
db.close();
```

- [ ] **Step 2: Run the replay and capture the report**

Run: `npx tsx ./tmp/dryrun-270.ts | tee ./tmp/dryrun-270.out`
Expected: prints `rows=<~279> changed=<N> newly-empty=<M>` followed by per-row before→after diffs.

- [ ] **Step 3: Review the diff for regressions**

Manually inspect `./tmp/dryrun-270.out`. Confirm:
- `newly-empty` is **0** (no query became empty — the fallback guarantees non-empty, so any non-zero here is a bug to investigate).
- The 31133/31135 rows (if present) now preserve their mid-name tokens.
- No row shows a *suspicious* shortening where a real beer-name token was dropped mid-name (edge-run dedup should only trim leading/trailing brewery duplicates).

Report the `changed`/`newly-empty` counts and any suspicious rows in the task summary. Do **not** commit anything from `./tmp/` (gitignored scratch).

---

## Notes for the executor

- After Tasks 1-3, run the **full** suite once: `npm test` — expected all green.
- `./tmp/` is ephemeral scratch (gitignored); leave the dry-run artefacts for review but never `git add` them.
- Head-retry (#271) is deliberately narrowed; the deferred remainder (bare-space tails, token-cap, dash) is documented in the spec's "Out of scope / follow-ups".
