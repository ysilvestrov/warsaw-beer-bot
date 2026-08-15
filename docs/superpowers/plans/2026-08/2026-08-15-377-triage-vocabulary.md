# #377 part B — triage vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every triage class exactly one meaning, complete the class set with `not_a_beer`, and leave `not_a_beer` as the only class that excludes an orphan from the enrichment pools.

**Architecture:** The class set lives in one constant (`src/domain/review-class.ts`) that feeds the zod schema, the LLM tool schema, the scope grammar and the DB `CHECK`. Migration v24 rebuilds `enrich_failures` (SQLite cannot alter a `CHECK` in place) with the new class list plus a second constraint that makes a verdict on an unaskable row impossible, and rewrites the 47 legacy `wontfix` rows during the copy. The pool change is a single clause in the two predicates that share it; reachability then falls out of the auto-unseal that already exists in `recordEnrichFailure`.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Vitest, Hono, Telegraf.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-15-377-triage-vocabulary-design.md`

## Global Constraints

- **Class set, exact strings:** `parser_bug`, `matcher_bug`, `not_on_untappd`, `unidentifiable`, `not_a_beer`. `wontfix` must not survive anywhere in `src/` after Task 5.
- **`not_a_beer` is the ONLY hard pool exclusion.** `unidentifiable` must NOT appear in `listLookupCandidates` or `orphanWithoutMatchLinkPredicate`.
- **`unidentifiable` stays blocked on the metered web fallback** (`isWebFallbackBlocked`). Revisit is parked on #349, not here.
- **Migration is v24.** Current head is v23. Every migration test must rewind from its own version *up*, never by deleting a single `schema_version` row (the v22 test's latent trap).
- **`REVIEW_CLASSES` (`src/domain/review-class.ts:7`) is the single source.** No file may re-declare the class list as literals — `src/api/routes/admin.ts:9` currently does and must switch to the constant.
- **Every test names the production change that turns it red** (superpowers 6.3.0 falsifiability rule). Where a step says "mutation-test", it means: revert the named line, watch the named test fail, restore.
- **Ukrainian for user-facing strings** (digest lines); English for code comments, notes and issue bodies.
- Run the full suite with `npm test` and types with `npm run typecheck`. Both must be green before each commit.

---

### Task 1: The class set and migration v24

**Files:**
- Modify: `src/domain/review-class.ts:7`
- Modify: `src/storage/enrich_failures.ts:87-88` (the `ReviewClass` type)
- Modify: `src/storage/schema.ts` (append migration 24 after the v23 entry, ~line 312)
- Test: `src/storage/schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `REVIEW_CLASSES: readonly ['parser_bug','matcher_bug','not_on_untappd','unidentifiable','not_a_beer']`
  - `type ReviewClass = (typeof REVIEW_CLASSES)[number]` — replaces the hand-written union.
  - `V24_NOT_A_BEER_IDS: readonly number[]` and `V24_REBUILD_SQL: string`, both exported from `src/storage/schema.ts` so tests exercise the exact statement (the pattern v23 established with `V23_BACKFILL_SQL`).

- [ ] **Step 1: Write the failing schema tests**

Add to `src/storage/schema.test.ts`:

```typescript
import { openDb } from './db';
import { migrate, V24_NOT_A_BEER_IDS } from './schema';

// Minimal beer row so the enrich_failures FK (beer_id -> beers.id) is satisfiable.
function seedBeer(db: ReturnType<typeof openDb>, id: number): void {
  db.prepare('INSERT INTO beers (id, brewery, name) VALUES (?, ?, ?)')
    .run(id, `brewery-${id}`, `name-${id}`);
}

function insertFailure(
  db: ReturnType<typeof openDb>,
  id: number,
  outcome: 'not_found' | 'blocked',
  reviewClass: string | null,
): void {
  seedBeer(db, id);
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, source_url, outcome,
        candidates_count, candidates_summary, fail_count, last_at, review_class)
     VALUES (?, 'b', 'n', '', '', ?, 0, '', 1, '2026-08-01T00:00:00.000Z', ?)`,
  ).run(id, outcome, reviewClass);
}

describe('v24 triage vocabulary', () => {
  it('accepts the new class set and rejects wontfix', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedBeer(db, 900);
    const write = (cls: string) =>
      db.prepare(
        `INSERT INTO enrich_failures
           (beer_id, brewery, name, search_url, source_url, outcome,
            candidates_count, candidates_summary, fail_count, last_at, review_class)
         VALUES (900, 'b', 'n', '', '', 'not_found', 0, '', 1, '2026-08-01T00:00:00.000Z', ?)
         ON CONFLICT(beer_id) DO UPDATE SET review_class = excluded.review_class`,
      ).run(cls);

    for (const cls of ['parser_bug', 'matcher_bug', 'not_on_untappd', 'unidentifiable', 'not_a_beer']) {
      expect(() => write(cls)).not.toThrow();
    }
    expect(() => write('wontfix')).toThrow(/CHECK/i);
  });

  it('refuses any class on a row we could not ask about (outcome != not_found)', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedBeer(db, 901);
    const insertBlocked = (cls: string | null) =>
      db.prepare(
        `INSERT INTO enrich_failures
           (beer_id, brewery, name, search_url, source_url, outcome,
            candidates_count, candidates_summary, fail_count, last_at, review_class)
         VALUES (901, 'b', 'n', '', '', 'blocked', 0, '', 1, '2026-08-01T00:00:00.000Z', ?)
         ON CONFLICT(beer_id) DO UPDATE SET review_class = excluded.review_class`,
      ).run(cls);

    expect(() => insertBlocked(null)).not.toThrow();
    // The point of the constraint: this must fail for RAW SQL, not only via the chokepoint.
    expect(() => insertBlocked('unidentifiable')).toThrow(/CHECK/i);
  });

  it('rewrites legacy wontfix rows during the rebuild', () => {
    const db = openDb(':memory:');
    // Rewind to v23 so the v24 migration runs against real legacy data.
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);`);
    migrate(db);
    db.prepare('DELETE FROM schema_version WHERE version >= 24').run();
    db.exec(`
      DROP TABLE enrich_failures;
      CREATE TABLE enrich_failures (
        beer_id INTEGER NOT NULL PRIMARY KEY REFERENCES beers(id) ON DELETE CASCADE,
        brewery TEXT NOT NULL, name TEXT NOT NULL, search_url TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('not_found','blocked')),
        candidates_count INTEGER NOT NULL, candidates_summary TEXT NOT NULL,
        fail_count INTEGER NOT NULL DEFAULT 1, last_at TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        review_class TEXT CHECK (review_class IN ('parser_bug','matcher_bug','not_on_untappd','wontfix')),
        review_note TEXT, reviewed_at TEXT, retired_at TEXT, issue_number INTEGER
      );
    `);

    const notABeer = V24_NOT_A_BEER_IDS[0];
    insertFailure(db, notABeer, 'not_found', 'wontfix');       // enumerated non-beer
    insertFailure(db, 777001, 'not_found', 'wontfix');          // survivor -> re-triage
    insertFailure(db, 777002, 'blocked', 'wontfix');            // sealed with no evidence
    insertFailure(db, 777003, 'not_found', 'matcher_bug');      // untouched
    db.prepare(`UPDATE enrich_failures SET review_note = 'old note', reviewed_at = '2026-06-19T00:00:00.000Z'
                 WHERE beer_id IN (?, ?)`).run(notABeer, 777001);

    migrate(db);

    const cls = (id: number) =>
      (db.prepare('SELECT review_class AS c FROM enrich_failures WHERE beer_id = ?').get(id) as { c: string | null }).c;
    expect(cls(notABeer)).toBe('not_a_beer');
    expect(cls(777001)).toBeNull();
    expect(cls(777002)).toBeNull();
    expect(cls(777003)).toBe('matcher_bug');

    // A voided verdict must not leave a reviewed_at behind: the row has to look
    // untriaged to listUntriagedFailures, not merely unclassified.
    const voided = db.prepare('SELECT reviewed_at AS r, review_note AS n FROM enrich_failures WHERE beer_id = ?')
      .get(777001) as { r: string | null; n: string };
    expect(voided.r).toBeNull();
    expect(voided.n).toContain('old note');   // audit trail preserved
    expect(voided.n).toContain('#377');

    // not_a_beer keeps its verdict: it was re-derived from the product itself.
    const kept = db.prepare('SELECT reviewed_at AS r FROM enrich_failures WHERE beer_id = ?')
      .get(notABeer) as { r: string | null };
    expect(kept.r).not.toBeNull();

    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(24);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/storage/schema.test.ts -t 'v24'`
Expected: FAIL — `V24_NOT_A_BEER_IDS` is not exported from `./schema`.

- [ ] **Step 3: Widen the class constant and the type**

`src/domain/review-class.ts` — replace line 7:

```typescript
export const REVIEW_CLASSES = [
  'parser_bug', 'matcher_bug', 'not_on_untappd', 'unidentifiable', 'not_a_beer',
] as const;
```

`src/storage/enrich_failures.ts` — replace the hand-written union at lines 87-88 so the type can never drift from the constant:

```typescript
// Values must stay in sync with the CHECK on enrich_failures.review_class (migration 24).
// Derived from REVIEW_CLASSES rather than repeated: the two lists silently diverging is
// exactly how `wontfix` ended up meaning two different things.
import { REVIEW_CLASSES } from '../domain/review-class';
export type ReviewClass = (typeof REVIEW_CLASSES)[number];
```

- [ ] **Step 4: Add migration 24**

In `src/storage/schema.ts`, above the `MIGRATIONS` array (beside `V23_BACKFILL_SQL`):

```typescript
// #377 part B. The 29 rows whose product is self-evidently not a beer — read one by
// one off prod on 2026-08-15, not derived by a LIKE over review_note. A heuristic here
// would be the same unverified bulk write that produced the 157-row incident.
// wine / spritz / cocktail, merch, bundle / mystery box / multipack / gift set, kombucha.
export const V24_NOT_A_BEER_IDS: readonly number[] = [
  19, 20, 21, 91, 116, 117, 191, 12044, 12309, 25663, 30053,
  25708,
  25709, 25710, 25725, 25933, 25961, 26006, 26044, 26097, 26098, 26099, 26100,
  29486, 29487, 29488, 29489, 32178,
  33659,
];

// SQLite cannot alter a CHECK in place, so the class-set change forces a full table
// rebuild — which is also the only moment the legacy rows can be rewritten, because
// the new CHECK rejects 'wontfix' outright. Hence the rewrite lives in the copy's
// SELECT, not in a follow-up UPDATE.
//
// Two branches only (spec: "re-derive, do not translate"):
//   * the enumerated ids  -> not_a_beer, verdict kept (the product is the evidence)
//   * every other wontfix -> NULL, verdict voided, note preserved for audit
// plus the general rule that a row we could not ask about (outcome != 'not_found')
// carries no class at all — which the second CHECK then enforces forever.
//
// FK note: enrich_failures is a child table and nothing references it, so the rebuild
// is safe with `foreign_keys = ON` and needs no PRAGMA toggle (which would be a no-op
// inside migrate()'s transaction anyway).
export const V24_REBUILD_SQL = `
  CREATE TABLE enrich_failures_v24 (
    beer_id            INTEGER NOT NULL PRIMARY KEY
                       REFERENCES beers(id) ON DELETE CASCADE,
    brewery            TEXT NOT NULL,
    name               TEXT NOT NULL,
    search_url         TEXT NOT NULL,
    outcome            TEXT NOT NULL CHECK (outcome IN ('not_found','blocked')),
    candidates_count   INTEGER NOT NULL,
    candidates_summary TEXT NOT NULL,
    fail_count         INTEGER NOT NULL DEFAULT 1,
    last_at            TEXT NOT NULL,
    source_url         TEXT NOT NULL DEFAULT '',
    review_class       TEXT CHECK (review_class IN
                         ('parser_bug','matcher_bug','not_on_untappd','unidentifiable','not_a_beer')),
    review_note        TEXT,
    reviewed_at        TEXT,
    retired_at         TEXT,
    issue_number       INTEGER,
    CHECK (review_class IS NULL OR outcome = 'not_found')
  );

  INSERT INTO enrich_failures_v24
    (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
     fail_count, last_at, source_url, review_class, review_note, reviewed_at, retired_at, issue_number)
  SELECT beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
         fail_count, last_at, source_url,
         CASE
           WHEN outcome <> 'not_found' THEN NULL
           WHEN review_class = 'wontfix' AND beer_id IN (${V24_NOT_A_BEER_IDS.join(',')}) THEN 'not_a_beer'
           WHEN review_class = 'wontfix' THEN NULL
           ELSE review_class
         END,
         CASE
           WHEN outcome <> 'not_found' AND review_class IS NOT NULL
             THEN '#377: verdict voided (written with no evidence — Untappd never answered). Was: '
                  || COALESCE(review_note, '')
           WHEN review_class = 'wontfix' AND beer_id NOT IN (${V24_NOT_A_BEER_IDS.join(',')})
             THEN '#377: prior wontfix verdict voided (vocabulary rework); re-triage. Was: '
                  || COALESCE(review_note, '')
           ELSE review_note
         END,
         CASE
           WHEN outcome <> 'not_found' THEN NULL
           WHEN review_class = 'wontfix' AND beer_id NOT IN (${V24_NOT_A_BEER_IDS.join(',')}) THEN NULL
           ELSE reviewed_at
         END,
         retired_at,
         CASE
           WHEN outcome <> 'not_found' THEN NULL
           WHEN review_class = 'wontfix' AND beer_id NOT IN (${V24_NOT_A_BEER_IDS.join(',')}) THEN NULL
           ELSE issue_number
         END
    FROM enrich_failures;

  DROP TABLE enrich_failures;
  ALTER TABLE enrich_failures_v24 RENAME TO enrich_failures;
`;
```

Then append the migration entry after the v23 object:

```typescript
  {
    version: 24,
    // #377 part B: one meaning per class. Adds not_a_beer, renames wontfix ->
    // unidentifiable (no row carries the new name at migration time — every legacy
    // wontfix is either re-derived as not_a_beer or voided), and adds the constraint
    // that a verdict cannot exist on a row we could not ask about.
    sql: V24_REBUILD_SQL,
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/storage/schema.test.ts -t 'v24'`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: failures ONLY in files that still reference `'wontfix'` as a class literal (`enrich_failures.ts`, `triage-plan.ts`, `admin.ts`, `orphan-triage.ts`, and their tests). Record the list — Tasks 2-5 consume it. Do not fix them here.

- [ ] **Step 7: Commit**

```bash
git add src/domain/review-class.ts src/storage/enrich_failures.ts src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(#377): v24 class set — add not_a_beer, retire wontfix, forbid verdicts on unaskable rows"
```

---

### Task 2: The chokepoint refuses what the schema cannot express

**Files:**
- Modify: `src/storage/enrich_failures.ts:95-111` (`setEnrichFailureReview`)
- Modify: `src/jobs/orphan-triage.ts:306` (caller)
- Modify: `src/api/routes/admin.ts:9,17` (caller + shared constant)
- Test: `src/storage/enrich_failures.test.ts`, `src/api/routes/admin.test.ts` (create the admin test file if absent)

**Interfaces:**
- Consumes: `ReviewClass`, `REVIEW_CLASSES` from Task 1.
- Produces:
  ```typescript
  export type SetReviewResult = 'written' | 'no_row' | 'refused_unaskable' | 'refused_unproved_absence';
  export function setEnrichFailureReview(
    db: DB, beerId: number, reviewClass: ReviewClass, note: string | null, atIso: string,
    issueNumber?: number | null,
    evidence?: { absenceProved: boolean },
  ): SetReviewResult;
  ```
  Callers must switch from `if (!result)` to `if (result !== 'written')`.

**Deviation from the spec, deliberate:** the spec says the `not_on_untappd` probe gate "moves down into the chokepoint". A storage function cannot see probes, and threading a probe map into `src/storage` would invert the layering. Instead the chokepoint takes an explicit `evidence.absenceProved` flag that defaults to `false`, so the *default* is refusal and each caller must prove absence deliberately. `planTriageActions` keeps its own guard (it needs the counter for `guardHits`); the admin route cannot set the flag at all, so `POST /review` can no longer assert absence. Net effect matches the spec: no write site can claim absence without evidence.

- [ ] **Step 1: Write the failing chokepoint tests**

Add to `src/storage/enrich_failures.test.ts`:

```typescript
describe('setEnrichFailureReview guards', () => {
  it('refuses a verdict on a row we could not ask about', () => {
    const db = freshDb();                       // existing helper in this file
    seedFailure(db, 42, { outcome: 'blocked' }); // existing helper; add the option if missing
    expect(setEnrichFailureReview(db, 42, 'unidentifiable', 'n', NOW)).toBe('refused_unaskable');
    const row = db.prepare('SELECT review_class AS c FROM enrich_failures WHERE beer_id = 42')
      .get() as { c: string | null };
    expect(row.c).toBeNull();
  });

  it('refuses not_on_untappd unless absence was proved', () => {
    const db = freshDb();
    seedFailure(db, 43, { outcome: 'not_found' });
    expect(setEnrichFailureReview(db, 43, 'not_on_untappd', 'n', NOW))
      .toBe('refused_unproved_absence');
    expect(setEnrichFailureReview(db, 43, 'not_on_untappd', 'n', NOW, null, { absenceProved: true }))
      .toBe('written');
  });

  it('still writes an ordinary verdict and still reports a missing row', () => {
    const db = freshDb();
    seedFailure(db, 44, { outcome: 'not_found' });
    expect(setEnrichFailureReview(db, 44, 'not_a_beer', 'merch', NOW)).toBe('written');
    expect(setEnrichFailureReview(db, 45, 'matcher_bug', 'n', NOW)).toBe('no_row');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/storage/enrich_failures.test.ts -t 'guards'`
Expected: FAIL — the function returns booleans.

- [ ] **Step 3: Implement the guards**

Replace `setEnrichFailureReview` in `src/storage/enrich_failures.ts`:

```typescript
export type SetReviewResult =
  | 'written'
  | 'no_row'
  | 'refused_unaskable'
  | 'refused_unproved_absence';

// The single write site for a triage verdict: the LLM job and the admin route both
// go through here, so a rule added here binds both. Raw bulk SQL does NOT come
// through here — that is why the "no verdict on an unaskable row" rule ALSO exists
// as a table CHECK (migration 24). This function turns that constraint violation
// into a countable refusal instead of an exception.
//
// `evidence.absenceProved` defaults to false so the safe answer is the default one:
// a caller that has not looked cannot accidentally assert absence. The admin route
// deliberately never sets it.
export function setEnrichFailureReview(
  db: DB,
  beerId: number,
  reviewClass: ReviewClass,
  note: string | null,
  atIso: string,
  issueNumber: number | null = null,
  evidence: { absenceProved: boolean } = { absenceProved: false },
): SetReviewResult {
  const existing = db
    .prepare('SELECT outcome FROM enrich_failures WHERE beer_id = ?')
    .get(beerId) as { outcome: string } | undefined;
  if (!existing) return 'no_row';
  if (existing.outcome !== 'not_found') return 'refused_unaskable';
  if (reviewClass === 'not_on_untappd' && !evidence.absenceProved) {
    return 'refused_unproved_absence';
  }

  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET review_class = ?, review_note = ?, reviewed_at = ?, issue_number = ?
       WHERE beer_id = ?`,
    )
    .run(reviewClass, note, atIso, issueNumber, beerId);
  return info.changes > 0 ? 'written' : 'no_row';
}
```

- [ ] **Step 4: Update the two callers**

`src/jobs/orphan-triage.ts:306` — the guard already ran in `planTriageActions`, so absence reaching here is proved:

```typescript
      const written = setEnrichFailureReview(
        db, v.beer_id, v.review_class, note, nowIso, issueNumber,
        { absenceProved: v.review_class === 'not_on_untappd' },
      );
      if (written !== 'written') {
```

`src/api/routes/admin.ts` — use the shared constant and surface a refusal honestly:

```typescript
import { REVIEW_CLASSES } from '../../domain/review-class';

const ReviewBody = z.object({
  beer_id: z.number().int().positive(),
  review_class: z.enum(REVIEW_CLASSES),
  note: z.string().nullable().optional(),
});
```

```typescript
    const result = setEnrichFailureReview(
      deps.db, beer_id, review_class, note ?? null, new Date().toISOString(),
    );
    if (result === 'no_row') return c.json({ error: 'no failure for beer_id' }, 404);
    if (result !== 'written') return c.json({ error: result }, 422);
    return c.json({ status: 'reviewed', beer_id, review_class });
```

- [ ] **Step 5: Write the admin route test**

```typescript
it('rejects an absence claim from the admin route — it cannot prove one', async () => {
  const res = await app.request('/admin/enrich-failures/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ beer_id: 43, review_class: 'not_on_untappd' }),
  });
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({ error: 'refused_unproved_absence' });
});
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/storage/enrich_failures.test.ts src/api/routes/admin.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Mutation-test the default**

Change `evidence: { absenceProved: boolean } = { absenceProved: false }` to `= { absenceProved: true }`.
Run: `npx vitest run src/storage/enrich_failures.test.ts -t 'absence'`
Expected: FAIL on "refuses not_on_untappd unless absence was proved". Restore the line.

- [ ] **Step 8: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts src/jobs/orphan-triage.ts src/api/routes/admin.ts src/api/routes/admin.test.ts
git commit -m "feat(#377): route every verdict through one chokepoint that refuses unaskable rows and unproved absence"
```

---

### Task 3: `not_a_beer` becomes the only pool exclusion

**Files:**
- Modify: `src/storage/beers.ts:259-273` (`listLookupCandidates` comment + SQL) and `:302-320` (`orphanWithoutMatchLinkPredicate`)
- Modify: `src/storage/enrich_failures.ts:56-85` (`isWontfix` → `isNotABeer`, `isWebFallbackBlocked`)
- Modify: `src/api/routes/enrich.ts:16,172` (call site)
- Modify: `src/storage/stats.ts:13-16` (comment naming `wontfix`)
- Test: `src/storage/beers.test.ts`, `src/storage/enrich_failures.test.ts`

**Interfaces:**
- Consumes: `ReviewClass` from Task 1.
- Produces: `export function isNotABeer(db: DB, beerId: number): boolean` — replaces `isWontfix`, same shape.

- [ ] **Step 1: Write the failing reachability test**

Add to `src/storage/beers.test.ts`:

```typescript
describe('#377: only not_a_beer leaves the pools', () => {
  it('keeps an unidentifiable orphan in the on-tap pool and drops a not_a_beer one', () => {
    const db = freshDb();
    const onTap = (id: number) => { /* existing helper that puts a beer on a latest snapshot */ };

    seedOrphanOnTap(db, 1); setReview(db, 1, 'unidentifiable');
    seedOrphanOnTap(db, 2); setReview(db, 2, 'not_a_beer');
    seedOrphanOnTap(db, 3); setReview(db, 3, null);

    const ids = listLookupCandidates(db, 10, new Date('2026-08-15T00:00:00Z')).map((c) => c.id);
    expect(ids).toContain(1);      // the whole point of part B
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });

  it('keeps an unidentifiable orphan in the relay pool', () => {
    const db = freshDb();
    seedOrphanNoMatchLink(db, 11); setReview(db, 11, 'unidentifiable');
    seedOrphanNoMatchLink(db, 12); setReview(db, 12, 'not_a_beer');

    const ids = listRelayLookupCandidates(db, 10, new Date('2026-08-15T00:00:00Z')).map((c) => c.id);
    expect(ids).toContain(11);
    expect(ids).not.toContain(12);
  });

  it('lets the existing auto-unseal fire on a row that is no longer sealed', () => {
    // This is the mechanism part B exists to unlock: recordEnrichFailure clears the
    // class when candidates_count crosses 0 <-> >0. Under `wontfix` the row never
    // reached a lookup, so this transition could not happen at all.
    const db = freshDb();
    seedOrphanNoMatchLink(db, 13);
    recordEnrichFailure(db, { beer_id: 13, /* ... */ candidates_count: 0, outcome: 'not_found' } as never);
    setReview(db, 13, 'unidentifiable');
    recordEnrichFailure(db, { beer_id: 13, /* ... */ candidates_count: 4, outcome: 'not_found' } as never);

    const row = db.prepare('SELECT review_class AS c FROM enrich_failures WHERE beer_id = 13')
      .get() as { c: string | null };
    expect(row.c).toBeNull();
  });
});
```

Fill the `/* ... */` fields from the existing `recordEnrichFailure` test in the same file; the helpers `freshDb`, `seedOrphanOnTap`, `seedOrphanNoMatchLink`, `setReview` follow the file's existing patterns — add them if the file does not already have equivalents.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/storage/beers.test.ts -t '#377'`
Expected: FAIL — id 1 and 11 are missing (still excluded as the old clause matches nothing, or the helper writes `wontfix`).

- [ ] **Step 3: Change the two predicates**

`src/storage/beers.ts` — in `listLookupCandidates`:

```sql
             AND (ef.review_class = 'not_a_beer' OR ef.retired_at IS NOT NULL)
```

and the same single line inside `orphanWithoutMatchLinkPredicate`. Update both comments: the exclusion is now "rows that are not beer at all (re-querying a T-shirt can never match) or retired (provably resolved)". Delete the phrase "intentionally never matched".

- [ ] **Step 4: Rename `isWontfix` and retighten the web fallback**

`src/storage/enrich_failures.ts`:

```typescript
// True when the row is not a beer product at all (merch, bundle, wine, kombucha).
// The only class that excludes an orphan from the enrich pools: every other verdict
// is a statement about our current resolving power and can be overturned by a
// shipped fix, so the row must stay reachable (#377 part B).
export function isNotABeer(db: DB, beerId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM enrich_failures WHERE beer_id = ? AND review_class = 'not_a_beer'`,
      )
      .get(beerId) !== undefined
  );
}

// True when the METERED web fallback (#139) must not spend a request on this beer.
// Wider than isNotABeer: `parser_bug` means the query string itself is garbage, so
// searching the web with the same wrong string cannot help; `not_on_untappd` means a
// probe already established the page does not exist; `unidentifiable` means we cannot
// say which beer is meant, and the paid quota should not be spent on the population
// whose verdicts we trust least (revisit once #349's ambiguity guard lands);
// `retired_at` means a shipped fix already resolved the row. The free Algolia retry
// keeps running for all of these — only the paid path is tightened (#351).
export function isWebFallbackBlocked(db: DB, beerId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM enrich_failures
          WHERE beer_id = ?
            AND (review_class IN ('not_a_beer', 'unidentifiable', 'parser_bug', 'not_on_untappd')
                 OR retired_at IS NOT NULL)`,
      )
      .get(beerId) !== undefined
  );
}
```

Update `src/api/routes/enrich.ts:16` (import) and `:172` (`!isNotABeer(deps.db, row.id)`), and the `wontfix` mention in the `orphansOffCron` comment at `src/storage/stats.ts:13-16`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/storage/beers.test.ts src/storage/enrich_failures.test.ts src/api/routes/enrich.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-test the pool clause**

In `orphanWithoutMatchLinkPredicate`, temporarily restore `ef.review_class = 'wontfix'`.
Run: `npx vitest run src/storage/beers.test.ts -t 'relay pool'`
Expected: FAIL on "keeps an unidentifiable orphan in the relay pool" — that one clause IS the whole of section 4 of the spec. Restore it.

- [ ] **Step 7: Commit**

```bash
git add src/storage/beers.ts src/storage/enrich_failures.ts src/storage/stats.ts src/api/routes/enrich.ts src/storage/beers.test.ts src/storage/enrich_failures.test.ts
git commit -m "feat(#377): make not_a_beer the only pool exclusion so unidentifiable rows stay reachable"
```

---

### Task 4: `not_a_beer` is actionable

**Files:**
- Modify: `src/domain/triage-plan.ts:57-62` (`CLASS_LABELS`)
- Modify: `src/domain/triage-verify.ts:12-15` (`isCausal`)
- Modify: `src/jobs/orphan-triage.ts:64,86-88,351-352` (outcome counters + summary line)
- Test: `src/domain/triage-plan.test.ts`, `src/domain/triage-verify.test.ts`

**Interfaces:**
- Consumes: `REVIEW_CLASSES` (Task 1); `SetReviewResult` (Task 2).
- Produces: `CLASS_LABELS` gains `not_a_beer: 'not-a-beer'`; `TriagePlan.quiet` now carries only `not_on_untappd` / `unidentifiable`.

- [ ] **Step 1: Write the failing tests**

`src/domain/triage-plan.test.ts`:

```typescript
it('routes not_a_beer to GitHub instead of writing it quietly', () => {
  const plan = planTriageActions(
    analysisWith({ beer_id: 1, review_class: 'not_a_beer', new_issue_key: 'merch',
                   review_note: 'mystery box SKU' }),
    [],
    [rowFor(1, { name: 'Surprise Box XL (36)' })],
    new Map(),
  );
  expect(plan.quiet).toHaveLength(0);
  expect(plan.newIssues[0].labels).toContain('not-a-beer');
  expect(plan.newIssues[0].verdicts.map((v) => v.beer_id)).toEqual([1]);
});
```

`src/domain/triage-verify.test.ts`:

```typescript
it('never demands a reproducing query for not_a_beer — there is no beer to find', () => {
  expect(isCausal({ review_class: 'not_a_beer', issue_number: 405,
                    new_issue_key: null } as never)).toBe(false);
  expect(isCausal({ review_class: 'matcher_bug', issue_number: 405,
                    new_issue_key: null } as never)).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/triage-plan.test.ts src/domain/triage-verify.test.ts -t 'not_a_beer'`
Expected: FAIL — `not_a_beer` lands in `quiet`; `isCausal` returns true.

- [ ] **Step 3: Implement**

`src/domain/triage-plan.ts`:

```typescript
// Single source of truth for which classes go to GitHub and which label each maps to.
// not_a_beer is actionable on the same criterion as the other two — it has a fix
// owner (the ingest filter: a T-shirt should never have reached `beers`). It is also
// the only irreversible class, and an irreversible verdict that leaves a scoped issue
// trail is safer than one written silently into a column (#377 part B).
const CLASS_LABELS = {
  parser_bug: 'parser-bug',
  matcher_bug: 'matcher-bug',
  not_a_beer: 'not-a-beer',
} as const;
```

`src/domain/triage-verify.ts`:

```typescript
// A verdict makes a causal claim when it routes the orphan to an issue — EXCEPT
// not_a_beer, whose claim is about the product, not about a query. Demanding a
// reproducing query there would force the model to invent one, and the gate would
// then drop every correct not_a_beer attachment (#377 part B).
export function isCausal(v: Verdict): boolean {
  if (v.review_class === 'not_a_beer') return false;
  return v.issue_number !== null || v.new_issue_key !== null;
}
```

`src/jobs/orphan-triage.ts` — rename the `wontfix` counter to `unidentifiable`, add `notABeer`, and update the summary at lines 86-88 and the tally at 351-352:

```typescript
      if (v.review_class === 'not_on_untappd') outcome.notOnUntappd++;
      else if (v.review_class === 'not_a_beer') outcome.notABeer++;
      else outcome.unidentifiable++;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/domain/ src/jobs/orphan-triage.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-plan.ts src/domain/triage-verify.ts src/jobs/orphan-triage.ts src/domain/triage-plan.test.ts src/domain/triage-verify.test.ts
git commit -m "feat(#377): file not_a_beer as an actionable ingest-filter defect, exempt from the query gate"
```

---

### Task 5: The prompt states the decision tree

**Files:**
- Modify: `src/domain/triage-analysis.ts:200-224` (the classification block) and `:268` (scope grammar mention of `review_class`), `:273` (quiet-class rule)
- Test: `src/domain/triage-analysis.test.ts`

**Interfaces:**
- Consumes: `REVIEW_CLASSES` (Task 1), `CLASS_LABELS` semantics (Task 4).
- Produces: no new exports; the prompt text is asserted by tests.

- [ ] **Step 1: Write the failing prompt tests**

```typescript
describe('#377: the prompt states one meaning per class', () => {
  const prompt = buildTriagePrompt(/* existing fixture args */);

  it('offers all five classes and no retired vocabulary', () => {
    for (const cls of REVIEW_CLASSES) expect(prompt).toContain(cls);
    expect(prompt).not.toContain('wontfix');
  });

  it('never asks the model to judge whether a fix is worth making', () => {
    // The exact phrasing that sealed row 31145 ("one-off collab long gone; hopeless").
    expect(prompt).not.toMatch(/not worth fixing/i);
    expect(prompt).not.toMatch(/one-off collab/i);
  });

  it('gives non-beer rows exactly one home', () => {
    // The old prompt listed merch under BOTH parser_bug and wontfix.
    const parserClause = prompt.slice(prompt.indexOf('- parser_bug:'), prompt.indexOf('- matcher_bug:'));
    expect(parserClause).not.toMatch(/merch|glassware|wine|food/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/triage-analysis.test.ts -t '#377'`
Expected: FAIL on all three.

- [ ] **Step 3: Replace the classification block**

Replace lines 200-224 of `src/domain/triage-analysis.ts` with:

```typescript
    'Classify EVERY orphan by walking this decision tree in order and stopping at the',
    'first NO. The classes are the NO branches, so exactly one always applies:',
    '',
    '1. Is the row a beer product at all? NO -> not_a_beer.',
    '   Merch, glassware, wine/cider/cocktail/food, kombucha, and bundles: mystery',
    '   boxes, multipacks, gift sets, "Brewery Pack". A bundle is not a beer even when',
    '   every bottle inside it is. This is the ONE verdict that is never revisited, so',
    '   apply it only to the product itself, never to a beer you merely cannot find.',
    '2. Is OUR row faithful to the shop page? NO -> parser_bug.',
    '   Wrong brewery/name split, truncation, HTML noise, a shop or ingredient token in',
    '   the brewery field. The fix is in our adapter. If the SHOP\'s own listing is',
    '   garbled (typos in the shop\'s data, e.g. "BRAURIE KEESMANN"), our adapter read it',
    '   correctly — that is NOT parser_bug; keep walking the tree.',
    '3. Can you say WHICH beer is meant? NO -> unidentifiable.',
    '   Either several candidates with no basis to choose between them, or none at all',
    '   and the listing points to an invented beer / a brewery that does not exist /',
    '   data garbled beyond rescue. This is a statement about what is knowable from the',
    '   row TODAY, not about whether a fix is worthwhile — never weigh effort or value.',
    '4. Is the beer on Untappd? NO -> not_on_untappd.',
    '   A real, NAMED beer that is simply not listed. Requires a probe that RAN and came',
    '   back empty; without that evidence the verdict is refused.',
    '5. Everything above is YES and we still missed it -> matcher_bug.',
    '   Brewery alias gap, name divergence, or query noise that only needs normalising.',
    '   Candidates that nearly match are a strong hint.',
    '',
    'The difference between 3 and 4 is whether you can NAME the beer. "I know it is',
    'Guinness but our rules cannot reach it" is matcher_bug, not unidentifiable —',
    'difficulty of the fix is never a classification input.',
```

Delete the old "Key test before you classify" block at lines 200-209 (the tree replaces it) and update line 273 to read `not_on_untappd / unidentifiable verdicts must have issue_number: null and new_issue_key: null.` — `not_a_beer` is actionable and MAY carry a target.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/domain/triage-analysis.test.ts && npm test`
Expected: PASS across the suite. `grep -rn "wontfix" src/` must return nothing.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts
git commit -m "feat(#377): state the triage classes as a decision tree with one meaning each"
```

---

### Task 6: The audit signal

**Files:**
- Modify: `src/storage/stats.ts` (`StatusMetrics` + `collectStatus`)
- Modify: `src/jobs/daily-status.ts:20-26` (`buildStatusMessage`)
- Test: `src/storage/stats.test.ts`, `src/jobs/daily-status.test.ts`

**Interfaces:**
- Consumes: the v24 class set (Task 1).
- Produces: four new `StatusMetrics` fields — `sealUnidentifiable: number`, `sealUnidentifiableReobserved: number`, `sealNotABeer: number`, `sealNotABeer7d: number`, `sealRetiredFalsified: number`.

- [ ] **Step 1: Write the failing stats test**

```typescript
it('counts the seals and the falsified retirements', () => {
  const db = freshDb();
  // unidentifiable, looked up AFTER its verdict -> re-observed
  seedOrphanFailure(db, 1, { review_class: 'unidentifiable', reviewed_at: '2026-08-01T00:00:00.000Z' });
  db.prepare('UPDATE beers SET untappd_lookup_at = ? WHERE id = 1').run('2026-08-10T00:00:00.000Z');
  // unidentifiable, never looked up since -> counted in the total only
  seedOrphanFailure(db, 2, { review_class: 'unidentifiable', reviewed_at: '2026-08-01T00:00:00.000Z' });
  db.prepare('UPDATE beers SET untappd_lookup_at = ? WHERE id = 2').run('2026-07-01T00:00:00.000Z');
  seedOrphanFailure(db, 3, { review_class: 'not_a_beer', reviewed_at: '2026-08-14T00:00:00.000Z' });
  seedOrphanFailure(db, 4, { review_class: 'not_a_beer', reviewed_at: '2026-06-01T00:00:00.000Z' });
  // retired but the beer is still an orphan -> the claim is falsified by the row itself
  seedOrphanFailure(db, 5, { review_class: 'matcher_bug', retired_at: '2026-07-01T00:00:00.000Z' });

  const m = collectStatus(db, new Date('2026-08-15T12:00:00.000Z'));
  expect(m.sealUnidentifiable).toBe(2);
  expect(m.sealUnidentifiableReobserved).toBe(1);
  expect(m.sealNotABeer).toBe(2);
  expect(m.sealNotABeer7d).toBe(1);
  expect(m.sealRetiredFalsified).toBe(1);
});
```

And in `src/jobs/daily-status.test.ts`:

```typescript
it('renders the seal line', () => {
  const msg = buildStatusMessage(
    { ...baseMetrics, sealUnidentifiable: 9, sealUnidentifiableReobserved: 7,
      sealNotABeer: 29, sealNotABeer7d: 0, sealRetiredFalsified: 28 },
    '2026-08-15',
  );
  expect(msg).toContain(
    "• Печатки: 9 unidentifiable (7 переспостережено) · 29 not_a_beer (+0/7д) · 28 спростованих retire",
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts -t 'seal'`
Expected: FAIL — fields do not exist.

- [ ] **Step 3: Implement the metrics**

Add to `StatusMetrics` (with the reasoning, since these numbers exist to falsify a design):

```typescript
  // #377 part B. Two of these can refute the design that produced them:
  // `sealUnidentifiableReobserved` at 0 means the rows are formally back in a pool but
  // the cron never reaches them (the mechanism is dead); a high re-observed count with a
  // flat `sealUnidentifiable` means it runs and buys nothing. Counting seals *lifted* is
  // impossible after the fact — the auto-unseal nulls review_class AND reviewed_at.
  sealUnidentifiable: number;
  sealUnidentifiableReobserved: number;
  sealNotABeer: number;
  sealNotABeer7d: number;
  // retired_at claims "a shipped fix resolved this"; if the beer were resolved,
  // clearEnrichFailure would have deleted the row. Growth means retired_at is being
  // written as blindly as wontfix was.
  sealRetiredFalsified: number;
```

In `collectStatus`, using the existing `count` helper and `cutoff24`-style arithmetic for a 7-day cutoff:

```typescript
  const cutoff7d = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString();
  const sealUnidentifiable = count(
    `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE ef.review_class = 'unidentifiable' AND b.untappd_id IS NULL`,
  );
  const sealUnidentifiableReobserved = count(
    `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE ef.review_class = 'unidentifiable' AND b.untappd_id IS NULL
        AND ef.reviewed_at IS NOT NULL AND b.untappd_lookup_at > ef.reviewed_at`,
  );
  const sealNotABeer = count(
    `SELECT COUNT(*) AS c FROM enrich_failures WHERE review_class = 'not_a_beer'`,
  );
  const sealNotABeer7d = count(
    `SELECT COUNT(*) AS c FROM enrich_failures
      WHERE review_class = 'not_a_beer' AND reviewed_at > ?`, [cutoff7d],
  );
  const sealRetiredFalsified = count(
    `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE ef.retired_at IS NOT NULL AND b.untappd_id IS NULL`,
  );
```

- [ ] **Step 4: Render the line**

In `buildStatusMessage`, after the `Enrich` line:

```typescript
    `• Печатки: ${group(m.sealUnidentifiable)} unidentifiable (${group(m.sealUnidentifiableReobserved)} переспостережено) · ${group(m.sealNotABeer)} not_a_beer (+${group(m.sealNotABeer7d)}/7д) · ${group(m.sealRetiredFalsified)} спростованих retire`,
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/stats.ts src/jobs/daily-status.ts src/storage/stats.test.ts src/jobs/daily-status.test.ts
git commit -m "feat(#377): daily seal audit — re-observation, not_a_beer debt, falsified retirements"
```

---

### Task 7: Spec, docs and the pre-merge replay

**Files:**
- Modify: `spec.md` (repo root — the OpenSpec source of truth)
- Test: none (documentation + a live measurement)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update `spec.md`**

Find the section describing orphan triage / `review_class` and replace the four-class list with the five-class decision tree from Task 5, stating explicitly that `not_a_beer` is the only class that removes an orphan from the enrichment pools, and that `unidentifiable` is provisional by construction. Per CLAUDE.md this must land in the same PR, not a follow-up.

`docs/extension-install-uk.md` needs NO change — nothing here touches `extension/**`.

- [ ] **Step 2: Run the live replay (the spec's pre-merge validation)**

Write `./tmp/replay-377.ts` that loads the 18 non-`not_a_beer` legacy ids
(61, 30101, 30617, 30796, 30883, 30884, 30885, 30886, 30931, 30956, 31145, 32838, 33237, 33530, 33671, 34357, 34696, 37)
from the PROD database read-only (`file:/var/lib/warsaw-beer-bot/bot.db?mode=ro`) and runs each through the compiled `lookupBeer` against live Untappd, printing `id | brewery | name | matched bid or MISS`.

Run it and record the hit rate in the PR description. The prior from the 157-row replay is 27%. This is the honest baseline for audit signal (1) — without it, "re-observation buys something" stays an assertion.

Note: `scripts/*.ts` never reach prod, but this runs on the dev checkout, which is the same host — that is fine. Use the compiled `dist/` entry points, not `scripts/`.

- [ ] **Step 3: Note the backlog shift on issue #419**

The backfill returns 12 rows to the untriaged queue, moving the #408 checkpoint's baseline from **97 to ~109**. #419's headline failure mode is "backlog climbing while verdicts fall", so leave a comment there BEFORE 2026-08-22 explaining the step change, or the checkpoint will misread it as a guard deadlock.

```bash
gh issue comment 419 --body '<the +12 explanation, linking this PR>'
```

- [ ] **Step 4: Commit and open the PR**

```bash
git add spec.md
git commit -m "docs(#377): spec.md — the five-class triage vocabulary"
gh pr create --title "feat(#377): triage vocabulary — one meaning per class, one irreversible seal" --body '<summary + replay hit rate + the #419 baseline note>'
```

- [ ] **Step 5: Wait for the AI review and answer every comment**

Per project policy: poll the review, verify each finding against the code, push back on wrong ones with evidence. Green tests are not "done".

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Vocabulary decision tree | 1 (constant + CHECK), 5 (prompt) |
| 2. Declarative CHECK + runtime chokepoint | 1 (CHECK), 2 (chokepoint) |
| 3. `not_a_beer` actionable, exempt from the cause gate, inside the scope guard | 4 |
| 4. Reachability = removing the block | 3 |
| 5. Audit signal, four numbers, digest line | 6 |
| 6. Migration v24 + backfill (29 / 18 split) | 1 |
| Out of scope (#421, retired semantics, #349 web fallback) | honoured: no task touches backoff, `retireEnrichFailure`, or opens the paid path |
| Validation replay | 7 |

**One deliberate deviation**, recorded in Task 2: the `not_on_untappd` probe gate is enforced in the chokepoint via an explicit `evidence.absenceProved` flag that defaults to `false`, rather than by moving probe data into the storage layer. Same guarantee, correct layering; `planTriageActions` keeps its counter.

**Type consistency:** `ReviewClass` is derived from `REVIEW_CLASSES` (Task 1) and used unchanged in Tasks 2-4. `setEnrichFailureReview` returns `SetReviewResult` from Task 2 onward; its two callers are updated in the same task. `isNotABeer` replaces `isWontfix` in Task 3 together with its only call site. `CLASS_LABELS` keys are the actionable subset of `REVIEW_CLASSES`.
