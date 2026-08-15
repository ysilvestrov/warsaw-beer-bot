# #421 Fix-Keyed Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-querying Untappd about orphans whose verdict names an unfixed bug, and re-arm those rows once the bug's issue leaves the open set.

**Architecture:** A row with an actionable verdict (`matcher_bug`/`parser_bug`) and a non-null `issue_number` is *locked* out of both lookup pools — a local column (`unlocked_at`, v25) is the only thing the pool queries read. A daily job translates external GitHub state into that local fact: issues no longer in the open set get their rows re-armed (beat 1). The verdict itself is only cleared when the retry fails (beat 2), which is the evidence that the shipped fix did not cover the row. `not_on_untappd` keeps the timer it deserves, with a recurring final step instead of a terminal one.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Vitest, node-cron, GitHub REST via plain `fetch`.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-15-421-fix-keyed-lock-design.md`

## Global Constraints

- **Functional style, modular structure** (CLAUDE.md). Pure functions in `src/domain/`, SQL in `src/storage/`, orchestration in `src/jobs/`.
- **Every new logic module needs Vitest coverage before merge** (CLAUDE.md).
- **Falsifiability rule** (superpowers 6.3.0): every test names, in a comment, the production change that turns it red.
- **`scripts/*.ts` never reach production** — `tsc` emits `src/` only. Anything that must run on prod is a job under `src/jobs/`.
- **Locked = actionable class + `issue_number IS NOT NULL` + `unlocked_at IS NULL`.** Actionable classes are exactly `'matcher_bug'` and `'parser_bug'`.
- **The lock is enforced in the two lookup pools only** — never in `src/api/routes/enrich.ts` (that search runs on the user's Untappd session, not our quota) and never in `orphansOffCron` (a backlog metric, not an eligibility slice).
- **`unlocked_at` carries exactly one meaning**: *this row is spending its post-fix free retry*. It is stamped at beat 1 and cleared at beat 2.
- **`spec.md` (repo root) is the source of truth** — Task 8 updates it in this same PR.

---

### Task 1: Migration v25 — the `unlocked_at` column

**Files:**
- Modify: `src/storage/schema.ts` (append a migration after `version: 24`, ends near line 399)
- Test: `src/storage/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: column `enrich_failures.unlocked_at TEXT` (nullable, no default), readable by every later task.

- [ ] **Step 1: Write the failing test**

In `src/storage/schema.test.ts`, next to the existing migration tests:

```ts
// Red if migration 25 is removed or renamed: the column is the only local fact
// the pool queries may read about an unlock.
it('v25 adds enrich_failures.unlocked_at, nullable and NULL for every existing row', () => {
  const db = openTestDb();
  migrate(db);
  const cols = db.prepare(`PRAGMA table_info(enrich_failures)`).all() as {
    name: string; type: string; notnull: number; dflt_value: string | null;
  }[];
  const col = cols.find((c) => c.name === 'unlocked_at');
  expect(col).toBeDefined();
  expect(col!.type).toBe('TEXT');
  expect(col!.notnull).toBe(0);
  expect(col!.dflt_value).toBeNull();
});

// Red if the migration is inserted before v24's table rebuild: the rebuild copies
// a fixed column list and would silently drop the new column.
it('v25 runs after the v24 rebuild and survives a full rewind', () => {
  const db = openTestDb();
  migrate(db);
  const version = db.prepare(`PRAGMA user_version`).get() as { user_version: number };
  expect(version.user_version).toBe(25);
});
```

If `openTestDb`/`migrate` are named differently in the existing file, use the file's own helpers — do not add new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/schema.test.ts -t 'unlocked_at'`
Expected: FAIL — `col` is `undefined`, and `user_version` is 24.

- [ ] **Step 3: Write minimal implementation**

Append to the migrations array in `src/storage/schema.ts`, after the `version: 24` entry:

```ts
  {
    version: 25,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN unlocked_at TEXT;
    `,
  },
```

No table rebuild: v24 already rebuilt this table for its `CHECK` changes and this migration adds no constraint. `NULL` is the correct initial state for every row — nobody has spent a free retry yet.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: PASS, including the pre-existing migration-rewind test.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(#421): v25 — enrich_failures.unlocked_at"
```

---

### Task 2: The lock predicate and the two pools

**Files:**
- Modify: `src/storage/beers.ts` (the `listLookupCandidates` SQL near lines 268-291; `orphanWithoutMatchLinkPredicate` near line 314; the `LookupCandidate` interface near line 251)
- Test: `src/storage/beers.test.ts`

**Interfaces:**
- Consumes: `enrich_failures.unlocked_at` (Task 1).
- Produces:
  - `export const lockedRowPredicate: string` — a SQL fragment, `EXISTS (...)`, that assumes the `beers` alias `b`; true when the row is locked.
  - `LookupCandidate` gains `review_class: string | null` (needed by Task 4; select it now so the pools are touched once).

- [ ] **Step 1: Write the failing test**

In `src/storage/beers.test.ts`:

```ts
// Red if lockedRowPredicate is dropped from listLookupCandidates: a matcher_bug row
// whose issue is still open would be re-queried on a timer that cannot change its answer.
it('excludes a locked row from the on-tap pool and includes it once unlocked', () => {
  const db = seedOnTapOrphan(1); // existing helper: orphan on the latest snapshot
  recordEnrichFailure(db, failureRow(1));
  setEnrichFailureReview(db, 1, 'matcher_bug', 'alias gap', '2026-08-15T00:00:00Z', 347);

  expect(listLookupCandidates(db, 10, new Date('2026-08-15T12:00:00Z')).map((r) => r.id))
    .not.toContain(1);

  db.prepare(`UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?`)
    .run('2026-08-15T06:00:00Z', 1);

  expect(listLookupCandidates(db, 10, new Date('2026-08-15T12:00:00Z')).map((r) => r.id))
    .toContain(1);
});

// Red if the predicate keys off the class alone: a verdict with no issue names no fix,
// so nothing can ever unlock it and the row would be dormant forever.
it('does not lock an actionable row that carries no issue_number', () => {
  const db = seedOnTapOrphan(2);
  recordEnrichFailure(db, failureRow(2));
  setEnrichFailureReview(db, 2, 'matcher_bug', 'legacy row', '2026-08-15T00:00:00Z', null);

  expect(listLookupCandidates(db, 10, new Date('2026-08-15T12:00:00Z')).map((r) => r.id))
    .toContain(2);
});

// Red if the predicate widens to every class: not_on_untappd names no fix owner and is
// waiting on Untappd, not on us.
it('does not lock not_on_untappd or unidentifiable rows', () => {
  const db = seedOnTapOrphan(3);
  recordEnrichFailure(db, failureRow(3));
  setEnrichFailureReview(db, 3, 'unidentifiable', 'garbled', '2026-08-15T00:00:00Z', 405);

  expect(listLookupCandidates(db, 10, new Date('2026-08-15T12:00:00Z')).map((r) => r.id))
    .toContain(3);
});

// Red if lockedRowPredicate is dropped from orphanWithoutMatchLinkPredicate. Both pools
// share the lock; only the relay pool proves this one.
it('excludes a locked row from the relay pool', () => {
  const db = seedRelayOrphan(4); // existing helper: orphan with no match_links row
  recordEnrichFailure(db, failureRow(4));
  setEnrichFailureReview(db, 4, 'parser_bug', 'adapter split', '2026-08-15T00:00:00Z', 376);

  expect(listRelayLookupCandidates(db, 10, new Date('2026-08-15T12:00:00Z')).map((r) => r.id))
    .not.toContain(4);
});

// Red if the lock is added to orphansOffCron: that metric counts the whole drain queue,
// exactly as it already ignores the backoff filter. Hiding locked rows would make the
// backlog look like it shrank when it only went quiet.
// NOTE: this one belongs in src/storage/stats.test.ts — the metric lives there.
it('orphansOffCron still counts a locked row', () => {
  const db = seedRelayOrphan(5);
  recordEnrichFailure(db, failureRow(5));
  setEnrichFailureReview(db, 5, 'matcher_bug', 'alias gap', '2026-08-15T00:00:00Z', 347);

  expect(collectStatus(db, new Date('2026-08-15T12:00:00Z')).orphansOffCron).toBe(1);
});
```

Use the file's existing seeding helpers and their real names; if a helper for a relay orphan does not exist, add one alongside the on-tap helper rather than inlining SQL in each test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/beers.test.ts -t 'lock'`
Expected: FAIL — the locked rows are returned by both pools.

- [ ] **Step 3: Write minimal implementation**

In `src/storage/beers.ts`, above `orphanWithoutMatchLinkPredicate`:

```ts
// #421: a verdict that names an unfixed bug is a settled question — while the issue is
// open the answer cannot move, so re-asking Untappd spends quota on nothing AND burns the
// row's four backoff attempts before its fix ships. The row is held out of both pools
// until `unlock-fixed-orphans` sees its issue leave the open set and stamps `unlocked_at`.
//
// Three conditions, each load-bearing: the class must name a fix owner (only matcher_bug
// and parser_bug do), the row must name WHICH fix (`issue_number`, v23 — a verdict with no
// issue can never be unlocked, so locking it would be a permanent seal), and the free retry
// must not already be spent (`unlocked_at IS NULL`).
//
// Deliberately NOT applied in two places: `/enrich/candidates` (that search runs in the
// user's Untappd session, so the quota this saves is not ours to save) and `orphansOffCron`
// in stats.ts (a backlog metric, which already ignores the backoff filter for the same
// reason — it counts the queue, not the slice eligible right now).
// Assumes the `beers` alias `b`, like orphanWithoutMatchLinkPredicate.
export const lockedRowPredicate = `EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND ef.review_class IN ('matcher_bug', 'parser_bug')
             AND ef.issue_number IS NOT NULL
             AND ef.unlocked_at IS NULL
         )`;
```

Add `AND NOT ${lockedRowPredicate}` to the `WHERE` of `listLookupCandidates` and to `orphanWithoutMatchLinkPredicate`. `orphansOffCron` in `src/storage/stats.ts` interpolates `orphanWithoutMatchLinkPredicate`, so keep the lock **out** of that constant and append it at the two pool call sites instead:

```ts
       WHERE ${orphanWithoutMatchLinkPredicate}
         AND NOT ${lockedRowPredicate}
```

Also add `ef.review_class` to both pool `SELECT`s (via a correlated subquery, so the pools keep their existing shape) and to the `LookupCandidate` interface:

```ts
              (SELECT ef.review_class FROM enrich_failures ef WHERE ef.beer_id = b.id)
                AS review_class
```

```ts
export interface LookupCandidate {
  id: number;
  brewery: string;
  name: string;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  // #421: the backoff schedule differs by class (Task 4). Selected here so the pool
  // query stays the single place that reads enrich_failures for a candidate.
  review_class: string | null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/beers.test.ts src/storage/stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-test the shared predicate**

Delete `AND NOT ${lockedRowPredicate}` from the **relay** pool only, run `npx vitest run src/storage/beers.test.ts -t 'relay pool'`, and confirm it goes RED. Restore the line and confirm GREEN. Both pools share the lock and it is easy to add it to one and believe it covers both.

- [ ] **Step 6: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#421): hold rows whose verdict names an unfixed bug out of both pools"
```

---

### Task 3: Beat 2 — the retry settles the verdict

**Files:**
- Modify: `src/storage/enrich_failures.ts` (the `ON CONFLICT DO UPDATE` arms of `recordEnrichFailure`)
- Test: `src/storage/enrich_failures.test.ts`

**Base changed since this plan was written (#425).** `recordEnrichFailure` now wraps its whole body in `db.transaction(...)` and short-circuits a `blocked` record against an existing row into a narrow `fail_count`/`last_at` bump. Consequences for this task, none of which change what it must do:

- Edit the `INSERT … ON CONFLICT DO UPDATE` arms **inside** the transaction callback; do not restructure the transaction or the blocked guard.
- Beat 2 fires on the `not_found` path only, which is correct and now explicit: a `blocked` record never reaches the upsert, so a transient Untappd outage can no longer settle an unlock. **Add a test pinning exactly that** — an unlocked row that receives a `blocked` record keeps its `review_class` *and* its `unlocked_at`, so the free retry is still owed. Red if the blocked guard is removed or if beat 2 is moved above it.

**Interfaces:**
- Consumes: `unlocked_at` (Task 1).
- Produces: no new exports. `recordEnrichFailure` gains one behaviour: a failure recorded on a row with `unlocked_at` set clears `review_class`, `review_note`, `reviewed_at` and `unlocked_at`.

- [ ] **Step 1: Write the failing test**

In `src/storage/enrich_failures.test.ts`:

```ts
// Red if the unlocked_at arm is dropped from the CASE: the verdict would survive a retry
// that disproved it, and the row would sit classified and invisible to triage forever.
it('clears the verdict when a retry after an unlock fails again', () => {
  const db = freshDb();
  recordEnrichFailure(db, failureRow(1, { candidates_count: 3 }));
  setEnrichFailureReview(db, 1, 'matcher_bug', 'alias gap → #347', '2026-08-01T00:00:00Z', 347);
  db.prepare(`UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?`)
    .run('2026-08-15T06:00:00Z', 1);

  recordEnrichFailure(db, failureRow(1, { candidates_count: 3 }));

  const row = db.prepare(`SELECT * FROM enrich_failures WHERE beer_id = 1`).get() as any;
  expect(row.review_class).toBeNull();
  expect(row.review_note).toBeNull();
  expect(row.reviewed_at).toBeNull();
  expect(row.unlocked_at).toBeNull();
});

// Red if the arm keys off the class instead of unlocked_at: an ordinary re-fail on a
// locked-but-not-unlocked row would wipe verdicts wholesale and silently empty triage.
it('keeps the verdict when a row that was never unlocked fails again', () => {
  const db = freshDb();
  recordEnrichFailure(db, failureRow(2, { candidates_count: 3 }));
  setEnrichFailureReview(db, 2, 'matcher_bug', 'alias gap → #347', '2026-08-01T00:00:00Z', 347);

  recordEnrichFailure(db, failureRow(2, { candidates_count: 3 }));

  const row = db.prepare(`SELECT * FROM enrich_failures WHERE beer_id = 2`).get() as any;
  expect(row.review_class).toBe('matcher_bug');
  expect(row.reviewed_at).toBe('2026-08-01T00:00:00Z');
});

// Red if the new arm replaces the 0<->>0 arm rather than joining it (#377 part B).
it('still clears the verdict when candidates_count crosses the 0<->>0 boundary', () => {
  const db = freshDb();
  recordEnrichFailure(db, failureRow(3, { candidates_count: 0 }));
  setEnrichFailureReview(db, 3, 'unidentifiable', 'no candidates', '2026-08-01T00:00:00Z', null);

  recordEnrichFailure(db, failureRow(3, { candidates_count: 4 }));

  const row = db.prepare(`SELECT * FROM enrich_failures WHERE beer_id = 3`).get() as any;
  expect(row.review_class).toBeNull();
});

// Red if issue_number is cleared along with the class: the link is the evidence trail for
// which fix was tested and failed, and #381 will need it.
it('leaves issue_number in place when beat 2 clears the verdict', () => {
  const db = freshDb();
  recordEnrichFailure(db, failureRow(4, { candidates_count: 3 }));
  setEnrichFailureReview(db, 4, 'parser_bug', 'split → #376', '2026-08-01T00:00:00Z', 376);
  db.prepare(`UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?`)
    .run('2026-08-15T06:00:00Z', 4);

  recordEnrichFailure(db, failureRow(4, { candidates_count: 3 }));

  const row = db.prepare(`SELECT * FROM enrich_failures WHERE beer_id = 4`).get() as any;
  expect(row.issue_number).toBe(376);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/enrich_failures.test.ts -t 'unlock'`
Expected: FAIL — the first test finds `review_class` still `'matcher_bug'`.

- [ ] **Step 3: Write minimal implementation**

In `recordEnrichFailure`, replace each of the three `CASE` expressions so the existing 0↔>0 condition and the new one share one predicate, and add the `unlocked_at` reset. Update the function's doc comment to name both triggers:

```ts
       review_class       = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
           OR enrich_failures.unlocked_at IS NOT NULL
         THEN NULL ELSE enrich_failures.review_class END,
       review_note        = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
           OR enrich_failures.unlocked_at IS NOT NULL
         THEN NULL ELSE enrich_failures.review_note END,
       reviewed_at        = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
           OR enrich_failures.unlocked_at IS NOT NULL
         THEN NULL ELSE enrich_failures.reviewed_at END,
       unlocked_at        = NULL
```

`unlocked_at` resets unconditionally: the only way a row reaches this statement with it set is that its free retry just failed, and the column means "spending the free retry". `issue_number` is deliberately untouched — the class says what kind of defect it was, the issue says which fix was tested and did not cover it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(#421): a failed post-unlock retry retires the verdict it disproved"
```

---

### Task 4: A recurring tail for `not_on_untappd`

**Files:**
- Modify: `src/domain/lookup-backoff.ts` (`isEligible`, lines 11-23)
- Modify: `src/storage/beers.ts` (the two `isEligible` filters, near lines 297 and 349)
- Modify: `src/storage/enrich_failures.ts` (new `reviewClassOf` export)
- Modify: `src/jobs/untappd-enrich.ts:30` and `src/api/routes/enrich.ts:172`
- Test: `src/domain/lookup-backoff.test.ts`, `src/storage/beers.test.ts`

**Interfaces:**
- Consumes: `LookupCandidate.review_class` (Task 2).
- Produces:
  - `isEligible(now: Date, lookupAt: string | null, count: number, recurring?: boolean): boolean` — `recurring` defaults to `false`, preserving every existing call.
  - `reviewClassOf(db: DB, beerId: number): string | null` in `src/storage/enrich_failures.ts`.
  - `RECURRING_CLASSES: readonly string[]` in `src/domain/lookup-backoff.ts`, exported so the four call sites cannot drift.

- [ ] **Step 1: Write the failing test**

In `src/domain/lookup-backoff.test.ts`:

```ts
// Red if the recurring branch is removed: a not_on_untappd row that exhausts the schedule
// goes dormant forever, contradicting the verdict's own justification ("Untappd grows").
it('re-offers an exhausted row after the last delay when recurring', () => {
  const last = '2026-06-01T00:00:00Z';
  expect(isEligible(new Date('2026-07-05T00:00:00Z'), last, 6, true)).toBe(true);  // 728h+
  expect(isEligible(new Date('2026-06-15T00:00:00Z'), last, 6, true)).toBe(false); // inside
});

// Red if `recurring` is passed unconditionally: unidentifiable and legacy no-issue rows
// have neither a fix owner nor a growing external catalogue, so a recurring retry would be
// exactly the timer-without-a-bet #421 exists to remove.
it('keeps the terminal schedule when not recurring', () => {
  expect(isEligible(new Date('2027-01-01T00:00:00Z'), '2026-06-01T00:00:00Z', 4)).toBe(false);
});
```

In `src/storage/beers.test.ts`:

```ts
// Red if the pools stop passing the class through to isEligible: the 24 not_on_untappd rows
// sitting at count=3 today would go dormant on their next miss.
it('keeps an exhausted not_on_untappd row in the pool once the last delay has passed', () => {
  const db = seedOnTapOrphan(6);
  recordEnrichFailure(db, failureRow(6));
  setEnrichFailureReview(db, 6, 'not_on_untappd', 'probe empty', '2026-06-01T00:00:00Z', null,
    { absenceProved: true });
  db.prepare(`UPDATE beers SET untappd_lookup_count = 5, untappd_lookup_at = ? WHERE id = 6`)
    .run('2026-06-01T00:00:00Z');

  expect(listLookupCandidates(db, 10, new Date('2026-07-05T00:00:00Z')).map((r) => r.id))
    .toContain(6);
});

// Red if the recurring flag leaks to every class.
it('leaves an exhausted unidentifiable row dormant', () => {
  const db = seedOnTapOrphan(7);
  recordEnrichFailure(db, failureRow(7));
  setEnrichFailureReview(db, 7, 'unidentifiable', 'garbled', '2026-06-01T00:00:00Z', null);
  db.prepare(`UPDATE beers SET untappd_lookup_count = 5, untappd_lookup_at = ? WHERE id = 7`)
    .run('2026-06-01T00:00:00Z');

  expect(listLookupCandidates(db, 10, new Date('2026-07-05T00:00:00Z')).map((r) => r.id))
    .not.toContain(7);
});
```

And in `src/api/routes/enrich.test.ts`:

```ts
// Red if someone adds the lock to /enrich/candidates for symmetry with the pools. This
// search runs in the user's own Untappd session and costs none of the quota the lock
// protects, so a locked row must stay offerable — the extension may find a beer the
// matcher cannot.
it('offers a locked row to the extension', async () => {
  const db = freshDb();
  seedOrphanWithVerdict(db, 1, 'matcher_bug', 347); // locked: open issue, unlocked_at NULL

  const res = await postCandidates(db, [{ brewery: 'Mad Brew', name: 'Bitter Cost' }]);

  expect((await res.json()).candidates[0].eligible).toBe(true);
});
```

Use the test file's own request helper and seeding style rather than the names above if they differ.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/lookup-backoff.test.ts src/storage/beers.test.ts src/api/routes/enrich.test.ts -t 'recurring'`
Expected: FAIL — `isEligible` takes three arguments and returns `false` at `count >= 4`. The extension test fails only if someone has already added the lock there; it is a guard against a future edit, so passing immediately is the correct outcome for it.

- [ ] **Step 3: Write minimal implementation**

`src/domain/lookup-backoff.ts`:

```ts
// #421: classes whose answer is changed by TIME rather than by a fix we own. Untappd's
// catalogue grows, so "not on Untappd" is a statement with an expiry date; exhausting the
// schedule would make the verdict permanent, which is precisely what it must not be.
export const RECURRING_CLASSES: readonly string[] = ['not_on_untappd'];

export function isEligible(
  now: Date,
  lookupAt: string | null,
  count: number,
  recurring = false,
): boolean {
  // Terminal state: once a beer has exhausted the schedule it is never looked up again
  // (regardless of lookupAt) until something resets its count — UNLESS the class is one
  // whose answer time can still change, in which case the last delay simply repeats.
  if (count >= BACKOFF_HOURS.length && !recurring) return false;
  if (lookupAt === null) return true;
  const dueAt = new Date(lookupAt).getTime() + nextDelayHours(count) * 3600_000;
  return now.getTime() >= dueAt;
}
```

`nextDelayHours` already clamps to the last element, so the recurring case needs no arithmetic of its own.

In `src/storage/beers.ts`, both filters:

```ts
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count,
      RECURRING_CLASSES.includes(r.review_class ?? '')),
  );
```

In `src/storage/enrich_failures.ts`:

```ts
// The row's triage class, or null when it has never been triaged (or has no failure row
// at all). Callers outside the pool queries need it to pick the backoff schedule (#421).
export function reviewClassOf(db: DB, beerId: number): string | null {
  const row = db
    .prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
    .get(beerId) as { review_class: string | null } | undefined;
  return row ? row.review_class : null;
}
```

In `src/jobs/untappd-enrich.ts` (the second eligibility gate, which would otherwise skip exactly the rows the pool just admitted):

```ts
  const recurring = RECURRING_CLASSES.includes(reviewClassOf(deps.db, beerId) ?? '');
  if (!isEligible(now, beer.untappd_lookup_at, beer.untappd_lookup_count, recurring)) {
    return 'skipped';
  }
```

In `src/api/routes/enrich.ts`, inside the same `eligible` expression that already calls `isNotABeer`:

```ts
          isEligible(now, row.untappd_lookup_at, row.untappd_lookup_count,
            RECURRING_CLASSES.includes(reviewClassOf(deps.db, row.id) ?? ''));
```

Leave the `isNotABeer` veto and the surrounding #384 logic untouched, and do **not** add the lock here — the comment block above that expression should gain one line saying so:

```ts
        // #421: the fix-keyed lock is deliberately absent here. This search runs in the
        // user's own Untappd session, so it costs none of the quota the lock protects, and
        // a locked row may still be findable by a client the matcher cannot reach.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/lookup-backoff.test.ts src/storage/beers.test.ts src/jobs/untappd-enrich.test.ts src/api/routes/enrich.test.ts`
Expected: PASS. All pre-existing three-argument `isEligible` calls in tests still compile, because `recurring` defaults to `false`.

- [ ] **Step 5: Commit**

```bash
git add src/domain/lookup-backoff.ts src/domain/lookup-backoff.test.ts src/storage/beers.ts src/storage/beers.test.ts src/storage/enrich_failures.ts src/jobs/untappd-enrich.ts src/api/routes/enrich.ts
git commit -m "feat(#421): not_on_untappd waits on a recurring tail, not a death sentence"
```

---

### Task 5: The unlock job

**Files:**
- Create: `src/jobs/unlock-fixed-orphans.ts`
- Create: `src/jobs/unlock-fixed-orphans.test.ts`
- Modify: `src/storage/enrich_failures.ts` (two new exports)

**Interfaces:**
- Consumes: `rearmLookup(db, beerId)` (`src/storage/beers.ts:139`), `GithubIssuesClient.listOpenIssues(label)` (`src/infra/github-issues.ts:5`), `TRIAGE_LABEL` (`src/jobs/orphan-triage.ts:21`), `getJobState`/`setJobState` (`src/storage/job_state.ts`), `warsawDateAndHour` (`src/domain/warsaw-time.ts`).
- Produces:
  - `listLockedRows(db: DB): { beer_id: number; issue_number: number }[]` in `src/storage/enrich_failures.ts`
  - `markUnlocked(db: DB, beerId: number, atIso: string): void` in `src/storage/enrich_failures.ts`
  - `unlockFixedOrphans(deps: UnlockDeps): Promise<UnlockOutcome>` and `UNLOCK_LAST_RUN_KEY` in the new job module.

- [ ] **Step 1: Write the failing test**

`src/jobs/unlock-fixed-orphans.test.ts`:

```ts
// Red if the job stops comparing against the open set: rows whose fix shipped would stay
// locked forever, which is the seal #377 spent a whole design removing.
it('unlocks rows whose issue has left the open set and re-arms their backoff', async () => {
  const db = freshDb();
  seedOrphanWithVerdict(db, 1, 'matcher_bug', 347);
  seedOrphanWithVerdict(db, 2, 'parser_bug', 376);
  db.prepare(`UPDATE beers SET untappd_lookup_count = 3, untappd_lookup_at = ? WHERE id = 1`)
    .run('2026-08-01T00:00:00Z');

  const out = await unlockFixedOrphans({
    db, log, github: stubGithub([{ number: 376 }]),
    now: () => new Date('2026-08-15T07:00:00Z'),
  });

  expect(out.unlocked).toBe(1);
  const row = db.prepare(`SELECT * FROM enrich_failures WHERE beer_id = 1`).get() as any;
  expect(row.unlocked_at).toBe('2026-08-15T07:00:00.000Z');
  expect(row.review_class).toBe('matcher_bug'); // beat 1 keeps the verdict
  const beer = db.prepare(`SELECT * FROM beers WHERE id = 1`).get() as any;
  expect(beer.untappd_lookup_count).toBe(0);
  expect(beer.untappd_lookup_at).toBeNull();
  // #376 is still open, so row 2 is untouched.
  expect((db.prepare(`SELECT * FROM enrich_failures WHERE beer_id = 2`).get() as any).unlocked_at)
    .toBeNull();
});

// Red if the pagination guard is removed. listOpenIssues fetches per_page=100 with no
// pagination, so a full page may be a TRUNCATED open set — and a truncated open set unlocks
// rows corpus-wide, silently, in one run.
it('unlocks nothing when the open-issue page is full', async () => {
  const db = freshDb();
  seedOrphanWithVerdict(db, 1, 'matcher_bug', 347);
  const hundred = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i }));

  const out = await unlockFixedOrphans({
    db, log, github: stubGithub(hundred), now: () => new Date('2026-08-15T07:00:00Z'),
  });

  expect(out.unlocked).toBe(0);
  expect(out.skippedReason).toBe('open_issue_page_full');
});

// Red if job_state idempotency is dropped: the job would re-arm the same rows on every
// tick, resetting the backoff of rows that are legitimately working through it.
it('runs once per Warsaw day', async () => {
  const db = freshDb();
  seedOrphanWithVerdict(db, 1, 'matcher_bug', 347);
  const deps = {
    db, log, github: stubGithub([]), now: () => new Date('2026-08-15T07:00:00Z'),
  };

  expect((await unlockFixedOrphans(deps)).unlocked).toBe(1);
  expect((await unlockFixedOrphans(deps)).unlocked).toBe(0);
});

// Red if a GitHub failure is allowed to close the day: one 500 would cost every row a day,
// the failure mode #316 fixed for triage.
it('does not close the day when GitHub fails', async () => {
  const db = freshDb();
  seedOrphanWithVerdict(db, 1, 'matcher_bug', 347);
  const failing = { listOpenIssues: async () => { throw new Error('GitHub 502'); } } as any;
  const now = () => new Date('2026-08-15T07:00:00Z');

  const first = await unlockFixedOrphans({ db, log, github: failing, now });
  expect(first.error).toContain('502');

  const second = await unlockFixedOrphans({ db, log, github: stubGithub([]), now });
  expect(second.unlocked).toBe(1);
});

// Red if the job unlocks on class alone: a row with no issue names no fix, so "the fix
// shipped" is not a claim anything could make about it.
it('ignores rows with no issue_number', async () => {
  const db = freshDb();
  seedOrphanWithVerdict(db, 1, 'matcher_bug', null);

  const out = await unlockFixedOrphans({
    db, log, github: stubGithub([]), now: () => new Date('2026-08-15T07:00:00Z'),
  });

  expect(out.unlocked).toBe(0);
});
```

Two helpers to define at the top of this test file, both reused by Task 7 and by the extension test in Task 4 — export them from a shared test helper module if the repo already has one for `enrich_failures` seeding, otherwise duplicate the four lines rather than inventing a helpers framework:

```ts
const stubGithub = (open: { number: number }[]) => ({
  listOpenIssues: async () => open.map((i) => ({
    ...i, title: '', body: '', labels: ['orphan-triage'], createdAt: '2026-01-01T00:00:00Z',
  })),
}) as unknown as GithubIssuesClient;

// An orphan with a failure row and a verdict — the shape every locked row has.
function seedOrphanWithVerdict(
  db: DB, id: number, cls: ReviewClass, issue: number | null,
): void {
  db.prepare(`INSERT INTO beers (id, brewery, name) VALUES (?, 'Mad Brew', 'Bitter Cost')`).run(id);
  recordEnrichFailure(db, {
    beer_id: id, brewery: 'Mad Brew', name: 'Bitter Cost', search_url: '', source_url: '',
    outcome: 'not_found', candidates_count: 3, candidates_summary: '', at: '2026-08-01T00:00:00Z',
  });
  setEnrichFailureReview(db, id, cls, 'note', '2026-08-01T00:00:00Z', issue);
}
```

If `beers` has NOT NULL columns beyond `brewery`/`name`, follow the insert shape already used by `src/storage/beers.test.ts` instead of the one above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/unlock-fixed-orphans.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the storage helpers**

In `src/storage/enrich_failures.ts`:

```ts
// #421: rows held out of the pools by lockedRowPredicate, with the issue each is waiting on.
// The predicate lives in beers.ts (it is a pool concern); this is its read-side twin, and the
// two must agree — a row listed here but not locked there would be re-armed for no reason.
export function listLockedRows(db: DB): { beer_id: number; issue_number: number }[] {
  return db
    .prepare(
      `SELECT beer_id, issue_number FROM enrich_failures
        WHERE review_class IN ('matcher_bug', 'parser_bug')
          AND issue_number IS NOT NULL
          AND unlocked_at IS NULL`,
    )
    .all() as { beer_id: number; issue_number: number }[];
}

// Beat 1 of the unlock: the row is spending its post-fix free retry. The verdict is kept —
// we still believe it, we are testing it. recordEnrichFailure settles it (beat 2).
export function markUnlocked(db: DB, beerId: number, atIso: string): void {
  db.prepare('UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?').run(atIso, beerId);
}
```

- [ ] **Step 4: Write the job**

`src/jobs/unlock-fixed-orphans.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { GithubIssuesClient } from '../infra/github-issues';
import { listLockedRows, markUnlocked } from '../storage/enrich_failures';
import { rearmLookup } from '../storage/beers';
import { getJobState, setJobState } from '../storage/job_state';
import { warsawDateAndHour } from '../domain/warsaw-time';
import { TRIAGE_LABEL } from './orphan-triage';

export const UNLOCK_LAST_RUN_KEY = 'unlock_fixed_orphans_last_run';

// listOpenIssues fetches per_page=100 without pagination. A full page may therefore be a
// truncated open set, and a truncated open set reads as "these issues closed" — unlocking
// rows in bulk against issues that are merely on page two. The guard trades a skipped day
// (harmless: the job is idempotent and runs again tomorrow) for that corpus-wide write.
export const OPEN_ISSUE_PAGE_LIMIT = 100;

export interface UnlockDeps {
  db: DB;
  log: pino.Logger;
  github: GithubIssuesClient | null;
  now?: () => Date;
}

export interface UnlockOutcome {
  unlocked: number;
  issuesClosed: number;
  skippedReason: string | null;
  error: string | null;
}

// #421: an actionable verdict is a settled question while its issue is open. This job is the
// only thing that turns external GitHub state into the local fact the pool queries read.
// Once per Warsaw day, same UTC-tick + job_state pattern as orphan-triage and daily-status
// (node-cron's timezone pin is unreliable on this host).
//
// Kept separate from orphan-triage despite sharing the listOpenIssues call: triage's failure
// path is the most intricate in this codebase (transient retry, day-burning, #316), and a job
// that writes to `beers` must not be able to take triage down or be taken down by it.
export async function unlockFixedOrphans(deps: UnlockDeps): Promise<UnlockOutcome> {
  const { db, log, github } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { date } = warsawDateAndHour(now);
  const empty: UnlockOutcome = { unlocked: 0, issuesClosed: 0, skippedReason: null, error: null };

  if (getJobState(db, UNLOCK_LAST_RUN_KEY) === date) return { ...empty, skippedReason: 'done_today' };
  if (!github) return { ...empty, skippedReason: 'github_disabled' };

  const locked = listLockedRows(db);
  if (locked.length === 0) {
    setJobState(db, UNLOCK_LAST_RUN_KEY, date);
    return empty;
  }

  let open;
  try {
    open = await github.listOpenIssues(TRIAGE_LABEL);
  } catch (e) {
    // The day is NOT closed: a transient GitHub failure must not cost every locked row a day.
    const error = e instanceof Error ? e.message : String(e);
    log.error({ err: e }, 'unlock-fixed-orphans: listOpenIssues failed');
    return { ...empty, error };
  }

  if (open.length >= OPEN_ISSUE_PAGE_LIMIT) {
    log.warn({ count: open.length }, 'unlock-fixed-orphans: open-issue page full, skipping');
    return { ...empty, skippedReason: 'open_issue_page_full' };
  }

  const openNumbers = new Set(open.map((i) => i.number));
  const closed = new Set(
    locked.map((r) => r.issue_number).filter((n) => !openNumbers.has(n)),
  );
  const atIso = now.toISOString();
  let unlocked = 0;
  for (const row of locked) {
    if (!closed.has(row.issue_number)) continue;
    rearmLookup(db, row.beer_id);
    markUnlocked(db, row.beer_id, atIso);
    unlocked += 1;
  }

  setJobState(db, UNLOCK_LAST_RUN_KEY, date);
  log.info({ unlocked, issuesClosed: closed.size }, 'unlock-fixed-orphans finished');
  return { unlocked, issuesClosed: closed.size, skippedReason: null, error: null };
}
```

Note there is no Warsaw *window*: unlike triage and the digest, this job has no reason to prefer an hour, and the `date` key alone gives once-per-day.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/jobs/unlock-fixed-orphans.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/unlock-fixed-orphans.ts src/jobs/unlock-fixed-orphans.test.ts src/storage/enrich_failures.ts
git commit -m "feat(#421): daily job re-arms rows whose issue left the open set"
```

---

### Task 6: Cron wiring

**Files:**
- Modify: `src/index.ts` (the `cronJobs` array near lines 279-292)
- Create: `src/jobs/unlock-fixed-orphans.wiring.test.ts`

**Interfaces:**
- Consumes: `unlockFixedOrphans` (Task 5), the already-constructed `triageGithub` client.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

`src/index.ts` has no unit test — composition-root wiring is invisible to the suite, which is why this repo already pins such invariants with a source-level guard (`src/bot/commands/city-gate.wiring.test.ts`, written after a reviewer disabled the whole city gate with all 1848 tests still green). Follow that file's shape:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Red if the job is never scheduled. Every other task in this change can be green while no
// row is ever unlocked in production — a job that exists and is never called is exactly the
// failure the suite cannot otherwise see, because nothing imports the composition root.
test('src/index.ts schedules unlockFixedOrphans on a cron tick', () => {
  const src = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
  expect(src).toMatch(/cron\.schedule\([^)]*\)[\s\S]{0,200}unlockFixedOrphans\(\{/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/unlock-fixed-orphans.wiring.test.ts`
Expected: FAIL — the string is absent from `src/index.ts`.

- [ ] **Step 3: Write minimal implementation**

Add the import and a schedule entry beside the `orphan-triage` one in `cronJobs`:

```ts
    // #421: re-arm rows whose issue left the open set. Hourly tick, once-per-Warsaw-day
    // via job_state inside the job — the same UTC-tick pattern as triage, since node-cron's
    // timezone pin is unreliable on this host.
    cron.schedule('20 * * * *', () => {
      unlockFixedOrphans({ db, log, github: triageGithub })
        .catch((e) => log.error({ err: e }, 'unlock-fixed-orphans cron'));
    }),
```

An hourly tick is deliberate: a GitHub failure returns without closing the day, so the next tick retries within the hour instead of losing the day.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/jobs/unlock-fixed-orphans.wiring.test.ts
git commit -m "feat(#421): schedule the unlock job"
```

---

### Task 7: Audit counters in the daily digest

**Files:**
- Modify: `src/storage/stats.ts` (the `StatusMetrics` interface, near the #377 seal counters at lines 33-47; the `collectStatus(db, now)` return object, lines 81-140)
- Modify: `src/jobs/daily-status.ts` (the `Печатки` line, line 27)
- Test: `src/storage/stats.test.ts`, `src/jobs/daily-status.test.ts`

**Interfaces:**
- Consumes: `unlocked_at`, `lockedRowPredicate` semantics.
- Produces: `StatusMetrics` gains `lockedRows: number`, `unlocked7d: number`, `verdictsOutlived7d: number`.
- Reuses, do not redefine: `collectStatus`'s local `count(sql, params)` helper (line 54) and its `cutoff7d` (line 53), already added for the #377 `not_a_beer` 7-day counter.

- [ ] **Step 1: Write the failing test**

In `src/storage/stats.test.ts`:

```ts
// Red if the counters are dropped. Each falsifies a premise: lockedRows is the quota the
// lock saves; unlocked7d at zero across a week in which issues closed means the mechanism
// is dead; verdictsOutlived7d near the unlock count means our fixes never cover the rows
// that motivated them, and the lock buys reversibility with no value behind it.
it('counts locked rows, recent unlocks and outlived verdicts', () => {
  const db = freshDb();
  seedOrphanWithVerdict(db, 1, 'matcher_bug', 347);                    // locked
  seedOrphanWithVerdict(db, 2, 'parser_bug', 376);
  db.prepare(`UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = 2`)
    .run('2026-08-14T00:00:00Z');                                      // unlocked, in flight
  seedOrphanWithVerdict(db, 3, 'not_on_untappd', null);                // never locked

  const s = collectStatus(db, new Date('2026-08-15T12:00:00Z'));
  expect(s.lockedRows).toBe(1);
  expect(s.unlocked7d).toBe(1);
});
```

In `src/jobs/daily-status.test.ts`, extend the existing digest-line assertion to expect the new segment.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/stats.test.ts -t 'locked'`
Expected: FAIL — `lockedRows` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

`verdictsOutlived7d` cannot be counted directly — beat 2 nulls the very columns that would prove it fired, the same erasure #377 hit with the auto-unseal. What survives is `issue_number` (Task 3 leaves it in place deliberately), so the count reads that residue. Add to the `collectStatus` return object, using its existing `count` helper and `cutoff7d`:

```ts
    // #421 audit. `lockedRows` is the quota the lock is saving; a number that only grows
    // means fixes are not shipping (a backlog signal, not a mechanism failure).
    lockedRows: count(
      `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.review_class IN ('matcher_bug','parser_bug')
          AND ef.issue_number IS NOT NULL AND ef.unlocked_at IS NULL
          AND b.untappd_id IS NULL`,
    ),
    // Beat 1 firing. Zero across a week in which issues closed means the mechanism is dead.
    unlocked7d: count(
      `SELECT COUNT(*) AS c FROM enrich_failures WHERE unlocked_at >= ?`,
      [cutoff7d],
    ),
    // Beat 2 firing: the verdict was cleared by a retry that disproved it, but issue_number
    // survives (Task 3), so an untriaged row that still names an issue is exactly one whose
    // fix was tested and did not cover it. Slight overcount by construction — the 0<->>0
    // clause can also clear a verdict that carried an issue. Accepted: both readings mean
    // "a shipped fix did not settle this row", which is what the signal is for.
    verdictsOutlived7d: count(
      `SELECT COUNT(*) AS c FROM enrich_failures
        WHERE review_class IS NULL AND issue_number IS NOT NULL AND last_at >= ?`,
      [cutoff7d],
    ),
```

Note `unlocked7d` counts only rows still *in flight* — beat 2 clears `unlocked_at`, so a row that settles within the same week leaves this count and appears in `verdictsOutlived7d` instead. That is the intended reading: the two numbers partition the week's unlocks between "still being tested" and "fix disproved", and a row that matched left the table entirely.

In `src/jobs/daily-status.ts`, append to the `Печатки` line:

```ts
    ` · ${group(m.lockedRows)} під замком (+${group(m.unlocked7d)} розімкнено/7д, ${group(m.verdictsOutlived7d)} вердиктів пережили фікс)`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/stats.ts src/storage/stats.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(#421): digest counters for the lock, the unlocks and the outlived verdicts"
```

---

### Task 8: `spec.md` and the pre-merge replay

**Files:**
- Modify: `spec.md` (the orphan-enrichment / triage sections touched by #377)
- Create: `./tmp/replay-421.ts` (scratch, not committed — `./tmp/` is gitignored and must be emptied when the task is done)

**Interfaces:**
- Consumes: everything above.
- Produces: the replay measurement recorded on issue #421.

- [ ] **Step 1: Update `spec.md`**

Document three behaviours, in the sections where #377 already describes triage classes and the enrich pools:

1. An orphan with `review_class` in (`matcher_bug`, `parser_bug`) and a non-null `issue_number` is held out of both lookup pools until its issue leaves the open set.
2. On unlock the row is re-armed (backoff reset) and keeps its verdict; the verdict is cleared only if the retry fails again.
3. `not_on_untappd` rows are re-queried on a repeating 728h step instead of going dormant at four attempts.

- [ ] **Step 2: Run the pre-merge replay**

Project policy (replay before implementing): measure what the first unlock will actually buy, against the live matcher, before merging.

Write `./tmp/replay-421.ts` as a thin runner over the compiled `dist` functions (`scripts/*.ts` do not exist on prod, but this runs on the dev checkout against a **copy** of the prod DB, never the live file). Take a seeded random sample of 30 from the 96 rows that have never been re-queried since their issue closed, run each through `lookupBeer`, and report the hit rate.

The 96 are those where `enrich_failures.issue_number` names a closed issue and `beers.untappd_lookup_at` predates that issue's `closedAt`. The prior is **27%** (the 157-row replay of 2026-08-14).

- [ ] **Step 3: Post the measurement on #421**

Comment the sample size, hit rate, and the beers that matched. This number is the honest baseline for the `verdictsOutlived7d` counter: its complement is what beat 2 will hand to triage.

- [ ] **Step 4: Full verification**

Run: `npx vitest run && npm run typecheck`
Expected: all green. Do not claim completion without pasting this output.

- [ ] **Step 5: Commit and empty the scratch directory**

```bash
rm -rf ./tmp/*
git add spec.md
git commit -m "docs(#421): spec — fix-keyed lock, two-beat unlock, recurring not_on_untappd tail"
```

---

## Deployment notes (after the PR is merged by the user)

1. Deploy from `main` on this host: `./deploy/deploy.sh` (needs `dangerouslyDisableSandbox`). `migrate()` runs at boot — confirm `PRAGMA user_version` reads 25.
2. The first unlock run re-arms the **157** rows whose issue is already closed, of which **96** have never been retested. Watch the next `enrich-orphans` cycle and the following morning's digest line.
3. Do **not** re-arm anything by hand first — the job is the mechanism, and a manual sweep would destroy the measurement it exists to produce.
