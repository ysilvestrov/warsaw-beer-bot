# #425 Blocked-Outcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a `blocked` lookup outcome from overwriting a row that already carries a real observation — which today violates v24's `CHECK` and aborts the entire enrich run — and stop any single beer from ending a run.

**Architecture:** One guard in `recordEnrichFailure`: a `blocked` record may create a row, but against an existing `not_found` row it only bumps `fail_count`/`last_at`. One `try`/`catch` around the per-beer call in `enrichOrphans`, deliberately not wired to the circuit breaker.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-15-425-blocked-outcome-design.md`

## Global Constraints

- **`enrich_failures.outcome` means "how the last attempt that learned something ended."** A `blocked` attempt learned nothing, so it never moves `outcome` on an existing row.
- **The v24 `CHECK` is correct and stays**: `CHECK (review_class IS NULL OR outcome = 'not_found')`. This change makes the illegal write impossible; it does not relax the constraint.
- **A caught per-beer error must never reach the circuit breaker.** `breaker.onResult(true, …)` means "Untappd blocked us"; a storage or fallback exception is not evidence about Untappd.
- **Smallest safe fix** (AGENTS.md): no refactoring of the surrounding upsert arms, no changes to `retired_at` or the 0↔>0 auto-unseal.
- **Every new logic path needs Vitest coverage** (CLAUDE.md), and every test names in a comment the production change that turns it red.
- **`spec.md` (repo root) is updated in this same PR** (Task 2).

---

### Task 1: `blocked` creates rows but never downgrades one

**Files:**
- Modify: `src/storage/enrich_failures.ts` (`recordEnrichFailure`, lines 22-51)
- Test: `src/storage/enrich_failures.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `recordEnrichFailure(db, r)` keeps its exact shape; only its behaviour for `r.outcome === 'blocked'` against an existing `not_found` row changes.

- [ ] **Step 1: Write the failing tests**

In `src/storage/enrich_failures.test.ts`. The file already has a `seedFailure(db, beerId, { outcome })` helper that inserts a beer plus an `enrich_failures` row with `candidates_count = 0` — use it, do not write new seeding.

```ts
// THE REPORTED CRASH. Red if the blocked guard is removed: this throws
// SqliteError: CHECK constraint failed: review_class IS NULL OR outcome = 'not_found'
// because the 0<->>0 clause does not fire (both counts are 0), so the verdict survives
// the upsert onto outcome='blocked'.
test('a blocked record on a triaged zero-candidate row preserves the verdict', () => {
  const db = freshDb();
  seedFailure(db, 1);
  expect(setEnrichFailureReview(db, 1, 'matcher_bug', 'alias gap', NOW, 347)).toBe('written');

  expect(() => recordEnrichFailure(db, {
    beer_id: 1, brewery: 'b', name: 'n', search_url: '', source_url: '',
    outcome: 'blocked', candidates_count: 0, candidates_summary: '',
    at: '2026-08-15T10:00:00.000Z',
  })).not.toThrow();

  const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 1').get() as any;
  expect(row.outcome).toBe('not_found');
  expect(row.review_class).toBe('matcher_bug');
  expect(row.reviewed_at).toBe(NOW);
  expect(row.fail_count).toBe(2);
  expect(row.last_at).toBe('2026-08-15T10:00:00.000Z');
});

// THE NEGATIVE CONTROL, and the reason #377's suite missed the bug: with candidates_count
// > 0 the old code also survived — but only because the 0<->>0 clause nulled the verdict
// first, i.e. it passed for the wrong reason. After the fix the verdict must SURVIVE.
// Red if the guard keys off candidates_count instead of outcome.
test('a blocked record on a triaged row with candidates preserves the verdict too', () => {
  const db = freshDb();
  seedFailure(db, 2);
  db.prepare('UPDATE enrich_failures SET candidates_count = 3, candidates_summary = ? WHERE beer_id = 2')
    .run('Mad Elf; MadTree; Mad Tom');
  expect(setEnrichFailureReview(db, 2, 'matcher_bug', 'alias gap', NOW, 347)).toBe('written');

  recordEnrichFailure(db, {
    beer_id: 2, brewery: 'b', name: 'n', search_url: '', source_url: '',
    outcome: 'blocked', candidates_count: 0, candidates_summary: '',
    at: '2026-08-15T10:00:00.000Z',
  });

  const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 2').get() as any;
  expect(row.review_class).toBe('matcher_bug');
  expect(row.candidates_count).toBe(3);
  expect(row.candidates_summary).toBe('Mad Elf; MadTree; Mad Tom');
});

// Red if the narrow UPDATE widens to touch diagnostics: a blocked attempt learned nothing,
// so the last real evidence must stay readable for triage.
test('a blocked record leaves search_url and the diagnostics of the last real attempt', () => {
  const db = freshDb();
  seedFailure(db, 3);
  db.prepare('UPDATE enrich_failures SET search_url = ? WHERE beer_id = 3')
    .run('https://untappd.com/search?q=real');

  recordEnrichFailure(db, {
    beer_id: 3, brewery: 'b', name: 'n', search_url: 'https://untappd.com/search?q=blocked',
    source_url: '', outcome: 'blocked', candidates_count: 0, candidates_summary: '',
    at: '2026-08-15T10:00:00.000Z',
  });

  const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 3').get() as any;
  expect(row.search_url).toBe('https://untappd.com/search?q=real');
});

// Red if the guard swallows creates as well as updates: a beer we have never recorded still
// needs its blocked row (#377 relies on such rows existing and carrying no class).
test('a blocked record still creates a row for a beer with no prior failure', () => {
  const db = freshDb();
  db.prepare(
    'INSERT INTO beers (id, brewery, name, normalized_name, normalized_brewery) VALUES (4, ?, ?, ?, ?)',
  ).run('b', 'n', 'n', 'b');

  recordEnrichFailure(db, {
    beer_id: 4, brewery: 'b', name: 'n', search_url: '', source_url: '',
    outcome: 'blocked', candidates_count: 0, candidates_summary: '',
    at: '2026-08-15T10:00:00.000Z',
  });

  const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 4').get() as any;
  expect(row.outcome).toBe('blocked');
  expect(row.review_class).toBeNull();
  expect(row.fail_count).toBe(1);
});

// Red if `outcome` is allowed to move on an existing row. A block window is about us, not
// about the beer, and listUntriagedFailures excludes blocked — so letting it move silently
// drops untriaged rows out of the triage queue.
test('a block window does not push an untriaged row out of the triage queue', () => {
  const db = freshDb();
  seedFailure(db, 5);

  recordEnrichFailure(db, {
    beer_id: 5, brewery: 'b', name: 'n', search_url: '', source_url: '',
    outcome: 'blocked', candidates_count: 0, candidates_summary: '',
    at: '2026-08-15T10:00:00.000Z',
  });

  expect(listUntriagedFailures(db, 10).map((r) => r.beer_id)).toContain(5);
});

// Red if the guard is applied to an already-blocked row in some other way: two blocked
// attempts in a row are just a counter bump, and the row keeps outcome='blocked'.
test('a blocked record on an already-blocked row bumps the counter', () => {
  const db = freshDb();
  seedFailure(db, 6, { outcome: 'blocked' });

  recordEnrichFailure(db, {
    beer_id: 6, brewery: 'b', name: 'n', search_url: '', source_url: '',
    outcome: 'blocked', candidates_count: 0, candidates_summary: '',
    at: '2026-08-15T10:00:00.000Z',
  });

  const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 6').get() as any;
  expect(row.outcome).toBe('blocked');
  expect(row.fail_count).toBe(2);
});
```

Use the file's own `freshDb`/`NOW` if they are named differently — do not introduce new helpers. `listUntriagedFailures` is already exported from `src/storage/enrich_failures.ts`; add it to the test file's import list if absent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/enrich_failures.test.ts -t blocked`
Expected: FAIL. The first test fails with `SqliteError: CHECK constraint failed: review_class IS NULL OR outcome = 'not_found'` — that is the bug being reproduced.

- [ ] **Step 3: Write minimal implementation**

At the top of `recordEnrichFailure` in `src/storage/enrich_failures.ts`, before the existing `INSERT … ON CONFLICT`:

```ts
  // #425: `outcome` records how the last attempt THAT LEARNED SOMETHING ended. A blocked
  // attempt learned nothing about the beer — it is a fact about us (throttled IP, open
  // circuit), so it may CREATE a row for a beer we have never recorded, but it must never
  // overwrite one that already carries a real observation.
  //
  // Two defects close here. (1) The crash: the upsert clears review_class only when
  // candidates_count crosses the 0<->>0 boundary, so on a row already at 0 the verdict
  // survived onto outcome='blocked' and violated migration 24's CHECK — throwing out of
  // enrichOrphans and ending the whole run. (2) The quiet one: listUntriagedFailures
  // excludes blocked rows, so a block window silently dropped untriaged rows out of the
  // triage queue over an outage that had nothing to do with them.
  if (r.outcome === 'blocked') {
    const existing = db
      .prepare('SELECT outcome FROM enrich_failures WHERE beer_id = ?')
      .get(r.beer_id) as { outcome: string } | undefined;
    if (existing) {
      db.transaction(() => {
        db.prepare(
          `UPDATE enrich_failures
              SET fail_count = fail_count + 1, last_at = ?
            WHERE beer_id = ?`,
        ).run(r.at, r.beer_id);
      })();
      return;
    }
  }
```

The read-then-write pair needs no transaction for correctness under better-sqlite3's synchronous single-process model; it gets one because that is a property of the process, not of this code.

Update the function's doc comment (lines 15-21) to name the new rule alongside the 0↔>0 one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "fix(#425): a blocked lookup may create a failure row but never downgrade one"
```

---

### Task 2: One beer may not end a run, plus `spec.md`

**Files:**
- Modify: `src/jobs/enrich-orphans.ts` (`EnrichOrphansResult` lines 12-25; `ZERO_RESULT` line 44; the candidate loop lines 102-123)
- Modify: `spec.md`
- Test: `src/jobs/enrich-orphans.test.ts`

**Interfaces:**
- Consumes: Task 1's guard (so the natural injection for a throwing beer is no longer the CHECK crash — use `webFallback`, see below).
- Produces: `EnrichOrphansResult` gains `errors: number`. The result is only ever logged (`log.info(result, 'enrich-orphans done')`), so nothing downstream needs updating.

- [ ] **Step 1: Write the failing tests**

`enrichOrphans` takes `webFallback` in its deps and `lookupWithFallback` awaits it unguarded (`src/domain/web-fallback.ts:235`), so a throwing fallback is a real, dependency-injected way to make exactly one beer blow up — no mocking framework, and it exercises the same containment gap the CHECK crash exercised.

The fallback only runs for a `not_found` outcome with zero candidates, so the search stub must return no hits for the orphan queries (it still has to answer `CANARY_QUERY` — see `GUINNESS_HIT` in the test file).

```ts
// Red if the try/catch around enrichOneOrphan is removed: one throwing beer ends the whole
// run and every candidate after it is silently never attempted. The loop is 20 network-and-DB
// operations; it must not end on the first surprise.
test('a beer that throws does not end the run', async () => {
  const db = fresh();
  const a = seedOrphanOnTap(db, 'Alpha Brew', 'Alpha');
  const b = seedOrphanOnTap(db, 'Beta Brew', 'Beta');
  const c = seedOrphanOnTap(db, 'Gamma Brew', 'Gamma');

  const search = { search: vi.fn(async (q: string): Promise<SearchResult[]> =>
    q === CANARY_QUERY ? [GUINNESS_HIT] : []) };

  const result = await enrichOrphans({
    db, log: silentLog, search, sleepMs: 0,
    webFallback: async (beerId: number) => {
      if (beerId === b) throw new Error('brave fallback exploded');
      return null;
    },
  });

  expect(result.errors).toBe(1);
  expect(result.processed).toBe(3);
  // The beers on either side of the thrower were both attempted.
  expect(getBeer(db, a)!.untappd_lookup_count).toBe(1);
  expect(getBeer(db, c)!.untappd_lookup_count).toBe(1);
});

// Red if the catch feeds the breaker. onResult(true) means "Untappd blocked us"; a storage or
// fallback exception is not evidence about Untappd, and letting it in would let a local bug
// open the circuit and stop all enrichment for the backoff window.
test('a thrown error is never reported to the circuit breaker', async () => {
  const db = fresh();
  const b = seedOrphanOnTap(db, 'Beta Brew', 'Beta');
  const breaker = { canAttempt: () => true, onResult: vi.fn(), state: 'closed' as const };

  const search = { search: vi.fn(async (q: string): Promise<SearchResult[]> =>
    q === CANARY_QUERY ? [GUINNESS_HIT] : []) };

  await enrichOrphans({
    db, log: silentLog, search, sleepMs: 0, breaker,
    webFallback: async () => { throw new Error('brave fallback exploded'); },
  });

  expect(breaker.onResult).not.toHaveBeenCalledWith(true, expect.anything());
});
```

Match the test file's existing call shape for `enrichOrphans` (its deps object, `silentLog`, `fresh()`, `seedOrphanOnTap`, `GUINNESS_HIT`) rather than the shorthand above where they differ.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/enrich-orphans.test.ts -t throw`
Expected: FAIL — the first test rejects with `brave fallback exploded` instead of returning a result.

- [ ] **Step 3: Write minimal implementation**

Add `errors: number` to `EnrichOrphansResult` (with a comment) and `errors: 0` to `ZERO_RESULT`. Then wrap the per-beer call:

```ts
    let kind;
    try {
      kind = await enrichOneOrphan(
        { db: deps.db, log: deps.log, search: deps.search, now, webFallback: deps.webFallback },
        c.id,
      );
    } catch (e) {
      // #425: containment. One row must never end a run of ~20 network-and-DB operations.
      // Deliberately NOT reported to the breaker: onResult(true) means "Untappd blocked us",
      // and a storage or fallback exception is not evidence about Untappd — feeding it in
      // would let a local bug open the circuit and stop all enrichment for the backoff window.
      deps.log.error({ err: e, beerId: c.id }, 'enrich-orphans: beer failed, continuing');
      result.errors++;
      result.processed++;
      if (sleepMs > 0 && i < candidates.length - 1) await sleep(sleepMs);
      continue;
    }
```

Leave the `blocked` branch, the breaker calls and the sleep pacing below it exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/enrich-orphans.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Update `spec.md`**

In the orphan-enrichment section, state two behaviours:

1. A blocked lookup outcome records that the attempt could not be made; it creates a failure row for a beer that has none, and otherwise only increments the failure counter — it never replaces the diagnostics, the outcome, or the triage verdict of a previous real attempt.
2. A failure while enriching one orphan is logged and counted, and the run continues with the next candidate; such a failure is not reported to the Untappd circuit breaker.

- [ ] **Step 6: Full verification**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all green. Paste the output — no completion claim without it.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/enrich-orphans.ts src/jobs/enrich-orphans.test.ts spec.md
git commit -m "fix(#425): contain a per-beer failure instead of ending the enrich run"
```

---

## Deployment notes (after the PR is merged by the user)

1. Deploy from `main` on this host: `./deploy/deploy.sh` (needs `dangerouslyDisableSandbox`). No migration in this change.
2. Nothing to clean up in prod: the `CHECK` fired on write, so no row was ever persisted in the illegal state.
3. The fix is only observable during an Untappd block window. Confirm by watching `journalctl -u warsaw-beer-bot` for `enrich-orphans done` lines that carry `blocked > 0` and complete instead of aborting.
