# Web-fallback spend guard + per-call observability (#351) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the metered Brave web fallback from spending on orphans that can never match, and make every spent call explain itself in the log.

**Architecture:** Three independent pieces in the existing #139 code. (1) A storage predicate `isWebFallbackBlocked` consulted at the top of `runWebFallback`, before quota and before the cooldown stamp. (2) The gate logic — today duplicated between the exported `gateWebCandidate` and an inline copy inside `runWebFallback`'s loop — collapses into one stage-returning core `evaluateCandidate`, which both the wrapper and the loop use, and whose stage becomes the rejection reason in a new one-line-per-call `info` log. (3) A merge stops masquerading as `not_found`: a new `'merged'` outcome kind flows into the cron counters and makes `/enrich/result` answer the extension with the canonical bid.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, pino, Hono, Vitest.

**Design doc:** `docs/superpowers/specs/2026-07/2026-07-27-web-fallback-spend-and-observability-design.md`

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/storage/enrich_failures.ts` | modify | add `isWebFallbackBlocked` beside `isWontfix` |
| `src/storage/enrich_failures.test.ts` | modify | predicate tests |
| `src/domain/web-fallback.ts` | modify | eligibility guard, `evaluateCandidate` core, call/skip logging |
| `src/domain/web-fallback.test.ts` | modify | guard, stage, and logging tests |
| `src/domain/lookup-outcome.ts` | modify | `'merged'` outcome kind |
| `src/domain/lookup-outcome.test.ts` | modify | merge-returns-`merged` test |
| `src/jobs/enrich-orphans.ts` | modify | `merged` counter |
| `src/jobs/enrich-orphans.test.ts` | modify | fix the exact-shape assertion |
| `src/api/routes/enrich.ts` | modify | answer `matched` + canonical bid on a merge |
| `src/api/routes/enrich.test.ts` | modify | merge-response test |
| `spec.md` | modify | document the predicate, the log, and the `/enrich/result` behaviour |

No migration, no env change, no `extension/**` diff.

---

### Task 1: `isWebFallbackBlocked` storage predicate

**Files:**
- Modify: `src/storage/enrich_failures.ts` (after `isWontfix`, ~line 66)
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/enrich_failures.test.ts`. `freshDbWithBeer()` and the `EnrichFailureRow` import already exist at the top of that file; add `isWebFallbackBlocked` and `setEnrichFailureReview`/`retireEnrichFailure` to the existing import list from `./enrich_failures` if not already there.

```ts
describe('isWebFallbackBlocked', () => {
  const row = (beerId: number): EnrichFailureRow => ({
    beer_id: beerId,
    brewery: 'Track',
    name: 'Taking Shape',
    search_url: 'https://untappd.com/search?q=Track+Taking+Shape&type=beer',
    source_url: '',
    outcome: 'not_found',
    candidates_count: 0,
    candidates_summary: '',
    at: '2026-07-27T00:00:00.000Z',
  });

  it('is false when there is no failure row at all', () => {
    const { db, id } = freshDbWithBeer();
    expect(isWebFallbackBlocked(db, id)).toBe(false);
    db.close();
  });

  it('is false for an untriaged failure', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row(id));
    expect(isWebFallbackBlocked(db, id)).toBe(false);
    db.close();
  });

  it('is false for matcher_bug — the class the web fallback exists for', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row(id));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-07-27T00:00:00.000Z');
    expect(isWebFallbackBlocked(db, id)).toBe(false);
    db.close();
  });

  it.each(['wontfix', 'parser_bug', 'not_on_untappd'] as const)(
    'is true for %s',
    (cls) => {
      const { db, id } = freshDbWithBeer();
      recordEnrichFailure(db, row(id));
      setEnrichFailureReview(db, id, cls, 'note', '2026-07-27T00:00:00.000Z');
      expect(isWebFallbackBlocked(db, id)).toBe(true);
      db.close();
    },
  );

  it('is true for a retired row regardless of class', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row(id));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-07-27T00:00:00.000Z');
    retireEnrichFailure(db, id, '2026-07-27T00:00:00.000Z');
    expect(isWebFallbackBlocked(db, id)).toBe(true);
    db.close();
  });
});
```

Before writing, open `src/storage/enrich_failures.ts` and check the exact signatures of `setEnrichFailureReview` (line ~76) and `retireEnrichFailure` (line ~100); match the argument order and count they actually declare rather than the call shape above if they differ.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: FAIL — `isWebFallbackBlocked is not a function` / TS error that it is not exported.

- [ ] **Step 3: Implement the predicate**

Add to `src/storage/enrich_failures.ts`, directly below `isWontfix`:

```ts
// True when the METERED web fallback (#139) must not spend a request on this beer.
// Superset of isWontfix: `parser_bug` means the query string itself is garbage, so
// searching the web with the same wrong string cannot help; `not_on_untappd` means
// triage already established the page does not exist; `retired_at` means a shipped
// fix already resolved the row. The free Algolia retry keeps running for all of
// these — only the paid path is tightened (#351).
export function isWebFallbackBlocked(db: DB, beerId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM enrich_failures
          WHERE beer_id = ?
            AND (review_class IN ('wontfix', 'parser_bug', 'not_on_untappd')
                 OR retired_at IS NOT NULL)`,
      )
      .get(beerId) !== undefined
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(#351): isWebFallbackBlocked predicate for the metered web path"
```

---

### Task 2: Guard `runWebFallback` with the predicate (free skip, no stamp)

**Files:**
- Modify: `src/domain/web-fallback.ts:104-126` (`runWebFallback` preamble)
- Test: `src/domain/web-fallback.test.ts` (inside the existing `describe('runWebFallback', …)`)

- [ ] **Step 1: Write the failing test**

Add to `src/domain/web-fallback.test.ts` inside `describe('runWebFallback', …)`. Add these imports at the top of the file:

```ts
import { recordEnrichFailure, setEnrichFailureReview } from '../storage/enrich_failures';
```

```ts
  it('skips a parser_bug orphan without spending quota or stamping a cooldown', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    recordEnrichFailure(db, {
      beer_id: beerId, brewery: input.brewery, name: input.name,
      search_url: 'u', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-07-24T00:00:00.000Z',
    });
    setEnrichFailureReview(db, beerId, 'parser_bug', 'garbled', '2026-07-24T00:00:00.000Z');
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });

    expect(sr).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS c FROM web_search_quota').get()).toMatchObject({ c: 0 });
    // The stamp must stay NULL: a free skip must not cost the beer its 30-day
    // cooldown, or the retry after the parser fix ships waits a month.
    expect(
      (db.prepare('SELECT web_tried_at FROM beers WHERE id = ?').get(beerId) as { web_tried_at: string | null })
        .web_tried_at,
    ).toBeNull();
    db.close();
  });

  it('still runs for a matcher_bug orphan', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    recordEnrichFailure(db, {
      beer_id: beerId, brewery: input.brewery, name: input.name,
      search_url: 'u', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-07-24T00:00:00.000Z',
    });
    setEnrichFailureReview(db, beerId, 'matcher_bug', 'divergent name', '2026-07-24T00:00:00.000Z');
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });

    expect(sr?.bid).toBe(5158585);
    expect(resolver.resolve).toHaveBeenCalled();
    db.close();
  });
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `npx vitest run src/domain/web-fallback.test.ts`
Expected: FAIL — the parser_bug test fails because the resolver WAS called and quota count is 1.

- [ ] **Step 3: Implement the guard**

In `src/domain/web-fallback.ts`, add the import:

```ts
import { isWebFallbackBlocked } from '../storage/enrich_failures';
```

and open `runWebFallback` with the guard, BEFORE the cooldown read:

```ts
  const now = (deps.now ?? (() => new Date()))();

  // Triage classes the metered path must never spend on. Checked first and for
  // free: no quota, and deliberately NO web_tried_at stamp, so a beer unblocked
  // by a later parser fix is retried on the next cron tick rather than 30 days
  // later (#351). Covers the relay path too, which never passes through
  // listLookupCandidates and was previously unfiltered even for `wontfix`.
  if (isWebFallbackBlocked(deps.db, input.beerId)) {
    deps.log.debug({ beerId: input.beerId, reason: 'review-class' }, 'web-fallback skipped');
    return null;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/web-fallback.test.ts`
Expected: PASS — all tests in the file, including the pre-existing cooldown/cap ones.

- [ ] **Step 5: Add the debug line to the other two skip paths**

Still in `runWebFallback`, the existing cooldown and quota branches become:

```ts
  const triedAt = readWebTriedAt(deps.db, input.beerId);
  if (triedAt) {
    const ageDays = (now.getTime() - new Date(triedAt).getTime()) / 86_400_000;
    if (ageDays < RE_WEB_COOLDOWN_DAYS) {
      deps.log.debug({ beerId: input.beerId, reason: 'cooldown' }, 'web-fallback skipped');
      return null;
    }
  }

  if (!tryConsumeWebSearchQuota(deps.db, utcDay(now), deps.cap)) {
    deps.log.debug({ beerId: input.beerId, reason: 'quota' }, 'web-fallback skipped');
    return null;
  }
```

- [ ] **Step 6: Re-run the tests**

Run: `npx vitest run src/domain/web-fallback.test.ts`
Expected: PASS (the `log` in tests is `pino({ level: 'silent' })`, so debug lines are inert).

- [ ] **Step 7: Commit**

```bash
git add src/domain/web-fallback.ts src/domain/web-fallback.test.ts
git commit -m "feat(#351): skip blocked triage classes before spending a web-search unit"
```

---

### Task 3: Collapse the duplicated gate into a stage-returning core

**Files:**
- Modify: `src/domain/web-fallback.ts:63-68` (`gateWebCandidate`) and `:128-134` (the loop)
- Test: `src/domain/web-fallback.test.ts`

Context: `gateWebCandidate` (exported, 6 tests) and the loop inside `runWebFallback` implement the same rules twice, because the loop hydrates ABV lazily. They can drift with no test failing. Extracting a core that returns the *stage* removes the duplication and simultaneously produces the reason string Task 4 logs.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `src/domain/web-fallback.test.ts`, above `describe('runWebFallback', …)`, and add `evaluateCandidate` to the existing import from `./web-fallback`:

```ts
describe('evaluateCandidate (stage-returning gate core)', () => {
  const input = { brewery: 'Maryensztadt', name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon', abv: 11.5 };

  it('returns reject:brewery when the brewery gate fails', () => {
    const cand: ResolvedBeer = { bid: 1, beer_name: 'Grimbergen Blanche', brewery_name: 'Brouwerij Alken-Maes', abv: 6 };
    expect(evaluateCandidate({ brewery: 'Carlsberg', name: 'Grimbergen blanche', abv: 6 }, cand)).toBe('reject:brewery');
  });

  it('returns accept when the same-language name gate passes', () => {
    const cand: ResolvedBeer = { bid: 1000186, beer_name: 'Pan IPAni', brewery_name: 'Trzech Kumpli', abv: null };
    expect(evaluateCandidate({ brewery: 'Trzech Kumpli', name: 'PanIPAni', abv: null }, cand)).toBe('accept');
  });

  it('returns reject:name-token when brewery matches but nothing in the name does', () => {
    const cand: ResolvedBeer = { bid: 2552312, beer_name: 'Te Czasy Się Skończyły', brewery_name: 'Browar Artezan', abv: 11.5 };
    expect(evaluateCandidate({ brewery: 'Artezan', name: 'Święty Spokój', abv: 11.5 }, cand)).toBe('reject:name-token');
  });

  it('returns needs-abv for the cross-language token-overlap branch', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: null,
    };
    expect(evaluateCandidate(input, cand)).toBe('needs-abv');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/web-fallback.test.ts`
Expected: FAIL — `evaluateCandidate` is not exported.

- [ ] **Step 3: Implement the core and rewrite both consumers**

In `src/domain/web-fallback.ts`, replace the existing `gateWebCandidate` (lines 59-68) with:

```ts
export type GateStage = 'accept' | 'reject:brewery' | 'reject:name-token' | 'needs-abv';

// Refined B1, split so the ABV-dependent stage is separable: brewery-strict is
// ALWAYS required; then either the name gate passes (same-language) or there is
// distinctive token overlap, which alone is not enough — it must be corroborated
// by ABV ('needs-abv'). Never accept on abv alone. Hydration-free by construction,
// so runWebFallback can call it before paying for hydrateAbv.
export function evaluateCandidate(input: GateInput, cand: ResolvedBeer): GateStage {
  if (!breweryStrict(input, cand)) return 'reject:brewery';
  if (nameGatePass(input, cand)) return 'accept';
  if (!sharedLongToken(tokens(input.name), tokens(cand.beer_name))) return 'reject:name-token';
  return 'needs-abv';
}

// Whole-gate verdict for an ALREADY-hydrated candidate. Thin wrapper over the
// core so the two can no longer drift.
export function gateWebCandidate(input: GateInput, cand: ResolvedBeer): boolean {
  const stage = evaluateCandidate(input, cand);
  if (stage === 'accept') return true;
  if (stage !== 'needs-abv') return false;
  return abvCorroborates(input.abv, cand.abv);
}
```

Then replace the candidate loop in `runWebFallback` (lines 128-134) with:

```ts
  for (const cand of candidates) {
    const stage = evaluateCandidate(input, cand);
    if (stage === 'accept') return toSearchResult(cand);
    if (stage !== 'needs-abv') continue;
    const abv = await hydrateAbv(deps.hydrate, cand);
    if (abvCorroborates(input.abv, abv)) return toSearchResult({ ...cand, abv });
  }
  return null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/web-fallback.test.ts`
Expected: PASS — the 4 new `evaluateCandidate` tests AND the 6 pre-existing `gateWebCandidate` tests, unedited.

- [ ] **Step 5: Commit**

```bash
git add src/domain/web-fallback.ts src/domain/web-fallback.test.ts
git commit -m "refactor(#351): single stage-returning gate core shared by the wrapper and the loop"
```

---

### Task 4: One `info` line per spent call

**Files:**
- Modify: `src/domain/web-fallback.ts` (`runWebFallback` loop + return)
- Test: `src/domain/web-fallback.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/domain/web-fallback.test.ts` inside `describe('runWebFallback', …)`:

```ts
  // A logger that records what runWebFallback reports, without pino formatting.
  function spyLog() {
    const info = vi.fn();
    const debug = vi.fn();
    return { logger: { ...pino({ level: 'silent' }), info, debug } as never, info, debug };
  }

  it('logs one info line with the rejection stage and both abv sides', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const noAbv: ResolvedBeer = { ...cross, abv: null };
    const resolver: WebResolver = { resolve: vi.fn(async () => [noAbv]) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    // input abv null → the needs-abv branch cannot corroborate → reject:abv
    const sr = await runWebFallback(
      { db, resolver, hydrate: noHydrate, cap: 90, log: logger, now },
      { beerId, brewery: input.brewery, name: input.name, abv: null },
    );

    expect(sr).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, msg] = info.mock.calls[0];
    expect(msg).toBe('web-fallback call');
    expect(fields).toMatchObject({ beerId, results: 1, verdict: 'rejected' });
    expect(fields.rejected[0]).toMatchObject({
      bid: 5158585, stage: 'reject:abv', inputAbv: null, candAbv: null,
    });
    db.close();
  });

  it('logs verdict matched with the winning bid', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log: logger, now }, { beerId, ...input });

    expect(info.mock.calls[0][0]).toMatchObject({ verdict: 'matched', matchedBid: 5158585, results: 1 });
  });

  it('logs verdict no-candidates when the resolver returns nothing', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const resolver: WebResolver = { resolve: vi.fn(async () => []) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log: logger, now }, { beerId, ...input });

    expect(info.mock.calls[0][0]).toMatchObject({ verdict: 'no-candidates', results: 0, rejected: [] });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/web-fallback.test.ts`
Expected: FAIL — `info` was never called (`expected "spy" to be called 1 times, but got 0 times`).

- [ ] **Step 3: Implement the log**

Replace the loop written in Task 3 (and the trailing `return null`) with:

```ts
  // One line per SPENT call. Without it a miss is indistinguishable from a dead
  // key or an empty index, and the rejection stages are the input the gate
  // redesign (#349) is waiting on — reject:abv with inputAbv/candAbv shows
  // exactly how many correct candidates a null ABV costs us.
  const rejected: Array<{
    bid: number; beer_name: string; brewery_name: string;
    stage: string; inputAbv: number | null; candAbv: number | null;
  }> = [];
  const logCall = (verdict: string, matchedBid?: number) =>
    deps.log.info(
      {
        beerId: input.beerId, brewery: input.brewery, name: input.name,
        results: candidates.length, verdict, matchedBid, rejected,
      },
      'web-fallback call',
    );

  for (const cand of candidates) {
    const stage = evaluateCandidate(input, cand);
    if (stage === 'accept') {
      logCall('matched', cand.bid);
      return toSearchResult(cand);
    }
    if (stage !== 'needs-abv') {
      rejected.push({
        bid: cand.bid, beer_name: cand.beer_name, brewery_name: cand.brewery_name,
        stage, inputAbv: input.abv, candAbv: cand.abv,
      });
      continue;
    }
    const abv = await hydrateAbv(deps.hydrate, cand);
    if (abvCorroborates(input.abv, abv)) {
      logCall('matched', cand.bid);
      return toSearchResult({ ...cand, abv });
    }
    rejected.push({
      bid: cand.bid, beer_name: cand.beer_name, brewery_name: cand.brewery_name,
      stage: 'reject:abv', inputAbv: input.abv, candAbv: abv,
    });
  }
  logCall(candidates.length === 0 ? 'no-candidates' : 'rejected');
  return null;
```

Note the `'reject:abv'` stage string is produced here, not by `evaluateCandidate` — the core stops at `needs-abv` because it is hydration-free.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/web-fallback.test.ts`
Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/web-fallback.ts src/domain/web-fallback.test.ts
git commit -m "feat(#351): log every spent web-fallback call with per-candidate gate stages"
```

---

### Task 5: `merged` as a first-class outcome kind

**Files:**
- Modify: `src/domain/lookup-outcome.ts:13` and `:38-53`
- Modify: `src/jobs/enrich-orphans.ts:12-18` (`EnrichOrphansResult`) and `:33-36` (`ZERO_RESULT`)
- Test: `src/domain/lookup-outcome.test.ts`, `src/jobs/enrich-orphans.test.ts:121`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/lookup-outcome.test.ts` (the file already imports `openDb`, `migrate`, `upsertBeer`, `getBeer`, `normalizeName`, `normalizeBrewery`, `applyLookupOutcome`):

```ts
describe('applyLookupOutcome merge', () => {
  test("returns 'merged' and redirects match_links when the bid already belongs to another row", () => {
    const { db, id, log } = fresh();
    const canonicalId = upsertBeer(db, {
      untappd_id: 777, name: 'Canonical Beer', brewery: 'Canonical Brewery',
      style: null, abv: null, rating_global: 4.2,
      normalized_name: normalizeName('Canonical Beer'),
      normalized_brewery: normalizeBrewery('Canonical Brewery'),
    });

    const kind = applyLookupOutcome(
      { db, log }, id,
      { kind: 'matched', result: cand({ bid: 777 }) },
      '2026-07-27T00:00:00Z', input,
    );

    expect(kind).toBe('merged');
    expect(getBeer(db, id)).toBeNull();              // orphan row deleted
    expect(getBeer(db, canonicalId)!.untappd_id).toBe(777);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/lookup-outcome.test.ts`
Expected: FAIL — `expected 'not_found' to be 'merged'`.

- [ ] **Step 3: Implement the new kind**

In `src/domain/lookup-outcome.ts`, widen the union on line 13:

```ts
export type EnrichOutcomeKind = 'matched' | 'merged' | 'not_found' | 'transient' | 'skipped' | 'blocked';
```

and in the UNIQUE-clash branch return `'merged'` when the merge actually happened:

```ts
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
        const canonical = deps.db
          .prepare('SELECT id FROM beers WHERE untappd_id = ?')
          .get(outcome.result.bid) as { id: number } | undefined;
        if (canonical) {
          // mergeIntoCanonical deletes the orphan row → its enrich_failures row is
          // CASCADE-removed; this is a success, not a failure. Reported as its own
          // kind so it stops being counted (and answered) as not_found (#351).
          mergeIntoCanonical(deps.db, beerId, canonical.id);
          deps.log.warn(
            { beerId, canonicalId: canonical.id, bid: outcome.result.bid },
            'enrich: merged duplicate orphan into canonical',
          );
          return 'merged';
        }
        return 'not_found';
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/lookup-outcome.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the counter**

In `src/jobs/enrich-orphans.ts`, add the field to the interface:

```ts
export interface EnrichOrphansResult {
  processed: number;
  matched: number;
  merged: number;
  not_found: number;
  transient: number;
  skipped: number;
  blocked: number;
}
```

and to `ZERO_RESULT`:

```ts
const ZERO_RESULT: EnrichOrphansResult = {
  processed: 0, matched: 0, merged: 0, not_found: 0, transient: 0, skipped: 0, blocked: 0,
};
```

`result[kind]++` in the loop then increments it with no further change.

- [ ] **Step 6: Fix the exact-shape assertion and run the job tests**

`src/jobs/enrich-orphans.test.ts:121` asserts the full result object with `toEqual`; add the new key:

```ts
    expect(result).toEqual({ processed: 0, matched: 0, merged: 0, not_found: 0, transient: 0, skipped: 0, blocked: 0 });
```

Run: `npx vitest run src/jobs/enrich-orphans.test.ts src/jobs/untappd-enrich.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts src/jobs/enrich-orphans.ts src/jobs/enrich-orphans.test.ts
git commit -m "feat(#351): report a merged duplicate as its own outcome, not as not_found"
```

---

### Task 6: `/enrich/result` answers `matched` with the canonical bid on a merge

**Files:**
- Modify: `src/api/routes/enrich.ts:136-138`
- Test: `src/api/routes/enrich.test.ts` (inside `describe('POST /enrich/result', …)`)

- [ ] **Step 1: Write the failing test**

Add to `src/api/routes/enrich.test.ts`:

```ts
  it('reports matched with the canonical bid when the relay result merges a duplicate', async () => {
    const { db, app } = setup();
    // A different row already owns bid 5469263 → recordLookupSuccess will hit the
    // UNIQUE constraint and merge the freshly created orphan into it.
    upsertBeer(db, {
      untappd_id: 5469263, name: 'Legacy Row', brewery: 'Legacy Brewery',
      style: null, abv: null, rating_global: 3.5,
      normalized_name: normalizeName('Legacy Row'),
      normalized_brewery: normalizeBrewery('Legacy Brewery'),
    });

    const res = await post(app, '/enrich/result', {
      brewery: 'PINTA Barrel Brewing',
      name: 'After Hours: Rose Wild Ale',
      algolia: {
        hits: [{
          bid: 5469263,
          beer_name: 'After Hours: Rose Wild Ale',
          brewery_name: 'PINTA Barrel Brewing',
          type_name: 'Wild Ale - Other',
          beer_abv: 5.7,
          rating_score: 3.89,
        }],
        nbHits: 1,
      },
    });

    expect(res.status).toBe(200);
    // Before #351 this answered {status:'not_found'} and the extension showed no
    // badge for a beer that IS on Untappd.
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 5469263 });
    // The orphan row is gone; the canonical keeps the bid.
    expect(findBeerByNormalized(
      db, normalizeBrewery('PINTA Barrel Brewing'), normalizeName('After Hours: Rose Wild Ale'),
    )).toBeNull();
  });
```

Check the return type of `findBeerByNormalized` in `src/storage/beers.ts` first: if it returns `undefined` rather than `null` for a missing row, assert `toBeUndefined()` instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: FAIL — body is `{status:'not_found'}`.

- [ ] **Step 3: Implement**

In `src/api/routes/enrich.ts`, widen the success condition:

```ts
    const kind = applyLookupOutcome({ db: deps.db, log: deps.log }, row.id, outcome, nowIso, { brewery, name, sourceUrl: pageUrl });
    // A merge is a success: the bid is real and already owned by a canonical row,
    // so answer like a match instead of the old not_found. `outcome.result` still
    // holds the bid — nothing needs plumbing through applyLookupOutcome. The
    // extension's status union is untouched ('merged' never crosses the boundary),
    // so old extension versions benefit without an update (#351).
    if ((kind === 'matched' || kind === 'merged') && outcome.kind === 'matched') {
      return c.json({ status: 'matched', untappd_id: outcome.result.bid, rating_global: outcome.result.global_rating });
    }
    return c.json({ status: kind });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(#351): answer the relay with the canonical bid when a duplicate merges"
```

---

### Task 7: Update `spec.md`

**Files:**
- Modify: `spec.md` — the «Web-фолбек на 0 кандидатів (#139)» block (~line 805) and the `POST /enrich/candidates` / `POST /enrich/result` block (~line 834)

`spec.md` is the OpenSpec source of truth and must change in the same PR (CLAUDE.md). It is written in Ukrainian — match the surrounding prose.

- [ ] **Step 1: Add two bullets to the web-fallback block**

Insert after the existing «**Захист витрат:**» bullet, keeping the same `- **Назва:**` style:

```markdown
- **Придатність (метровані виклики, #351):** пиво, чий рядок `enrich_failures` має
  `review_class` з `wontfix`/`parser_bug`/`not_on_untappd` **або** непорожній `retired_at`,
  у web-фолбек **не потрапляє взагалі** (`isWebFallbackBlocked`). Перевірка виконується
  **першою** — до кулдауну і до квоти — і є безкоштовною: ані запиту, ані штампа
  `web_tried_at`, щоб після фікса парсера пиво поверталось у чергу наступним тіком кроні,
  а не через 30 днів. Безкоштовний Algolia-ретрай для цих класів працює як раніше.
  Правило діє і на client-relay `/enrich/result`, який не проходить через
  `listLookupCandidates` і раніше не фільтрувався навіть за `wontfix`.
- **Спостережуваність (#351):** кожен **витрачений** виклик пише один `info`-рядок
  `web-fallback call` (`beerId`, `brewery`, `name`, `results`, `verdict` =
  `matched`/`rejected`/`no-candidates`, `matchedBid`, `rejected[]` зі стадією гейта
  `reject:brewery`/`reject:name-token`/`reject:abv` та парою `inputAbv`/`candAbv`).
  Пропуски (`review-class`, `cooldown`, `quota`) — `debug`-рядок `web-fallback skipped`
  з полем `reason`. Логуються лише **оцінені** кандидати: цикл виходить на першому
  прийнятому.
```

- [ ] **Step 2: Document the merge response**

In the `POST /enrich/result` block, add:

```markdown
Якщо знайдений bid уже належить іншому рядку каталогу, сирота **зливається** в канонічний
(`mergeIntoCanonical`) і ендпоінт відповідає `{"status":"matched","untappd_id":<bid>}` —
раніше це був `not_found`, через що розширення не показувало бейдж на пиві, яке насправді
є в Untappd (#351). Внутрішній вид результату `merged` за межу API не виходить, тож
контракт розширення незмінний.
```

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(#351): spec — web-fallback eligibility, per-call log, merged relay response"
```

---

### Task 8: Final verification and PR

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all files pass; the total count should be the pre-existing ~1370 plus the ~15 tests added here. Zero failures.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Confirm the extension is untouched**

Run: `git diff --stat origin/main -- extension/`
Expected: empty output. If it is not empty, `docs/extension-install-uk.md` must be updated too (CLAUDE.md rule) — but this change should produce no extension diff at all.

- [ ] **Step 5: Push and open the PR**

Branch name: `351-web-fallback-spend-observability`.

```bash
git push -u origin 351-web-fallback-spend-observability
gh pr create --title "feat(#351): web-fallback spend guard + per-call observability" --body "$(cat <<'EOF'
Closes #351.

Day-1 production data on the Brave fallback (30/30 units, 8 successes, 22 misses) surfaced two problems the #349 gate redesign does not cover.

**1. The metered path spent on orphans that can never match.** `listLookupCandidates` excludes only `wontfix`/`retired_at` — correct for a free Algolia retry, wrong for a paid request. ~10 of the 22 day-1 misses were structurally unmatchable. `/enrich/result` was worse: it never passes through `listLookupCandidates`, so even `wontfix` was unfiltered there. New `isWebFallbackBlocked` predicate is checked first in `runWebFallback`, for free — no quota and no `web_tried_at` stamp, so a parser fix re-arms the beer on the next cron tick instead of 30 days later.

**2. Spent calls were invisible.** The resolver logged only non-200s, so a miss could not be attributed to Brave vs our gate — the exact input #349 is waiting on. Every spent call now emits one `info` line with per-candidate gate stages; `reject:abv` carries `inputAbv`/`candAbv`. Skips are `debug`.

To get the stage without duplicating the gate a third time, `gateWebCandidate` and the inline copy in `runWebFallback` collapse into one stage-returning core `evaluateCandidate` — this also resolves the "duplicated gate" bullet in #349, which can be struck there.

**3. A merge stopped masquerading as `not_found`.** `applyLookupOutcome` returned `not_found` after merging a duplicate, so the cron reported `matched:1` for 6+2 real successes, and — worse — the relay answered the extension `not_found` while holding the canonical bid. New `'merged'` kind feeds the cron counter, and `/enrich/result` now answers `matched` + bid. `'merged'` never crosses the API boundary, so the extension contract is unchanged and old versions benefit without an update.

No migration, no env change, no `extension/**` diff. `spec.md` updated.

Design: `docs/superpowers/specs/2026-07/2026-07-27-web-fallback-spend-and-observability-design.md`
Plan: `docs/superpowers/plans/2026-07/2026-07-27-web-fallback-spend-and-observability.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01FgPRL2Vib9f4SxzJrZ2drN
EOF
)"
```

- [ ] **Step 6: Wait for the AI review, then read and assess it**

Poll `gh pr view --comments` on the new PR until the `ai-pr-review` marker comment appears. Verify each finding against the code before acting — the gpt-4o-mini reviewer filed 3 wrong findings out of 4 on the previous PR in this area. Fix what is real, push back on what is not.

Do **not** merge. Report "ready to merge" and let the user merge.

---

## Deployment note (after merge, not part of the PR)

Nothing to enable — no env or migration. Deploy with `bash deploy/deploy.sh`, then after 2–3 days pull the rejection-stage histogram out of the journal and post it to #349:

```bash
journalctl -u warsaw-beer-bot --since "-3 days" --no-pager | grep '"msg":"web-fallback call"'
```
