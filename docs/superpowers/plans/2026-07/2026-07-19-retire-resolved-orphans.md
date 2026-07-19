# Retire Resolved Orphans (#286) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manual ops tool that moves *provably-resolved* classified `enrich_failures` rows to a terminal `retired` state, and stops those rows polluting the enrich pool, daily stats, and ops views.

**Architecture:** Add a nullable `retired_at` timestamp column to `enrich_failures` (retirement keeps the original `review_class` for audit and appends the reason to `review_note`). A storage helper `retireEnrichFailure` performs the write. A CLI script `scripts/retire-resolved-orphans.ts` selects targets two ways — an **auto path** (re-run the current `isOntapNonBeerTap` predicate against the stored beer) and an **`--ids` escape hatch** (operator-supplied, requires `--reason`) — with dry-run default and `--apply`. Consumers (`listLookupCandidates`, `stats.orphansPending`) exclude retired rows.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Vitest, `tsx` (ops scripts). Design doc: `docs/superpowers/specs/2026-07/2026-07-19-retire-resolved-orphans-design.md`.

---

## File Structure

- `src/storage/schema.ts` — add migration 18 (`ALTER TABLE enrich_failures ADD COLUMN retired_at TEXT`).
- `src/storage/enrich_failures.ts` — add `retireEnrichFailure(db, beerId, note, atIso)`.
- `src/storage/enrich_failures.test.ts` — tests for `retireEnrichFailure`.
- `src/storage/beers.ts` — `listLookupCandidates`: extend the `wontfix` exclusion to also skip `retired_at IS NOT NULL`.
- `src/storage/beers.test.ts` — test: retired orphan drops out of the candidate pool.
- `src/storage/stats.ts` — `orphansPending`: exclude retired orphans.
- `src/storage/stats.test.ts` — test: retired orphan not counted.
- `scripts/retire-resolved-orphans.ts` — CLI + `selectAutoRetireTargets`, `selectIdTargets`, `applyRetire`.
- `scripts/retire-resolved-orphans.test.ts` — unit tests for the three exported functions.
- `package.json` — add `"retire-resolved-orphans"` script alias.
- `spec.md` — document the `retired_at` terminal state in the enrich_failures / orphan-triage section.

**Note for the implementer (repo conventions):**
- Ops scripts import from `../src/...`, call `loadOperatorEnv()` at module top, default to dry-run and write only on `--apply`. Follow `scripts/rearm-matcher-bug-orphans.ts`.
- Tests use `openDb(':memory:')` + `migrate(db)`. Run a single test file with `npx vitest run <path>`.
- `isOntapNonBeerTap` lives in `src/sources/ontap/non-beer.ts` and takes `{ style, brewery_ref, beer_ref }`.

---

## Task 1: Migration 18 — `retired_at` column

**Files:**
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`, after the `version: 17` object)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/storage/schema.test.ts` (inside the top-level `describe`, or as a new `test`):

```ts
test('migration 18 adds nullable retired_at to enrich_failures', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare(`PRAGMA table_info(enrich_failures)`).all() as { name: string; notnull: number }[];
  const retired = cols.find((c) => c.name === 'retired_at');
  expect(retired).toBeDefined();
  expect(retired!.notnull).toBe(0); // nullable
});
```

If `openDb`/`migrate` are not already imported in this test file, add:
`import { openDb } from './db';` and `import { migrate } from './schema';` (check the existing imports first — reuse them if present).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/schema.test.ts -t "retired_at"`
Expected: FAIL (`retired` is `undefined`).

- [ ] **Step 3: Add the migration**

In `src/storage/schema.ts`, add a new object to the `MIGRATIONS` array immediately after the `version: 17` object (before the closing `];`):

```ts
  {
    version: 18,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN retired_at TEXT;
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/schema.test.ts -t "retired_at"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(db): add enrich_failures.retired_at column (migration 18, #286)"
```

---

## Task 2: `retireEnrichFailure` storage helper

Sets `retired_at`, appends the reason to `review_note`, preserves `review_class`. Idempotent: only touches rows not already retired.

**Files:**
- Modify: `src/storage/enrich_failures.ts`
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/storage/enrich_failures.test.ts`. The file already has `freshDbWithBeer()`, `row()`, and imports from `./enrich_failures`. Add `retireEnrichFailure` to the import list, and add this `describe` block:

```ts
describe('retireEnrichFailure', () => {
  test('sets retired_at, appends note, preserves review_class', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    setEnrichFailureReview(db, id, 'parser_bug', 'garbled name', '2026-07-01T00:00:00Z');

    const changed = retireEnrichFailure(db, id, 'retired: current non-beer filter rejects', '2026-07-19T00:00:00Z');
    expect(changed).toBe(true);

    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.retired_at).toBe('2026-07-19T00:00:00Z');
    expect(got.review_class).toBe('parser_bug'); // preserved
    expect(got.review_note).toContain('garbled name');
    expect(got.review_note).toContain('retired: current non-beer filter rejects');
  });

  test('is idempotent — a second call does not change or re-append', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    retireEnrichFailure(db, id, 'retired: x', '2026-07-19T00:00:00Z');

    const changed = retireEnrichFailure(db, id, 'retired: x', '2026-07-20T00:00:00Z');
    expect(changed).toBe(false);
    const got = db.prepare('SELECT retired_at, review_note FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.retired_at).toBe('2026-07-19T00:00:00Z'); // unchanged
    expect((got.review_note.match(/retired: x/g) ?? []).length).toBe(1);
  });

  test('returns false when no row exists', () => {
    const { db } = freshDbWithBeer();
    expect(retireEnrichFailure(db, 999, 'retired: x', '2026-07-19T00:00:00Z')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/enrich_failures.test.ts -t "retireEnrichFailure"`
Expected: FAIL (`retireEnrichFailure is not a function`).

- [ ] **Step 3: Implement `retireEnrichFailure`**

Add to `src/storage/enrich_failures.ts` (after `setEnrichFailureReview`):

```ts
// Terminal state for a classified failure whose underlying problem is resolved
// (the responsible fix has shipped). Sets retired_at and appends `note` to
// review_note, preserving the original review_class for audit. Idempotent: only
// rows not already retired are touched (WHERE retired_at IS NULL), so re-runs
// neither re-append the note nor overwrite the timestamp. Returns false when no
// eligible row exists (missing, or already retired).
export function retireEnrichFailure(
  db: DB,
  beerId: number,
  note: string,
  atIso: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET retired_at  = ?,
             review_note = TRIM(COALESCE(review_note, '') || ' | ' || ?)
       WHERE beer_id = ? AND retired_at IS NULL`,
    )
    .run(atIso, note, beerId);
  return info.changes > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/enrich_failures.test.ts -t "retireEnrichFailure"`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(storage): retireEnrichFailure terminal-state helper (#286)"
```

---

## Task 3: Exclude retired orphans from the enrich candidate pool

**Files:**
- Modify: `src/storage/beers.ts` (`listLookupCandidates`, the `NOT EXISTS` sub-select ~lines 169-172)
- Test: `src/storage/beers.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/storage/beers.test.ts`, inside the `describe('listLookupCandidates', ...)` block, add a test right after the existing `'excludes orphans triaged as wontfix'` test. Reuse that block's `seedBeerOnTap(db, { brewery, name })` helper and `recordEnrichFailure` + `setEnrichFailureReview` imports (already present). Retire by setting `retired_at` directly via UPDATE (there is no retire helper in this layer's imports; a raw UPDATE keeps the test self-contained):

```ts
test('excludes retired orphans (retired_at set)', () => {
  const db = fresh();
  const retired = seedBeerOnTap(db, { brewery: 'VINO KARPATIA', name: 'Bialy bez' });
  const live = seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine' });
  recordEnrichFailure(db, {
    beer_id: retired, brewery: 'VINO KARPATIA', name: 'Bialy bez',
    search_url: '', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
  });
  setEnrichFailureReview(db, retired, 'parser_bug', 'wine', '2026-05-26T11:30:00Z');
  db.prepare('UPDATE enrich_failures SET retired_at = ? WHERE beer_id = ?')
    .run('2026-05-26T11:45:00Z', retired);

  const now = new Date('2026-05-26T12:00:00Z');
  const out = listLookupCandidates(db, 10, now);
  expect(out.map((c) => c.id)).toEqual([live]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/beers.test.ts -t "retired orphans"`
Expected: FAIL (candidate still present — array not empty).

- [ ] **Step 3: Widen the exclusion**

In `src/storage/beers.ts`, `listLookupCandidates`, change the `NOT EXISTS` sub-select from:

```sql
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id AND ef.review_class = 'wontfix'
         )
```

to:

```sql
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND (ef.review_class = 'wontfix' OR ef.retired_at IS NOT NULL)
         )
```

Also update the adjacent comment (currently mentions only `wontfix`) to note retired rows are excluded too.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: PASS (new test + all existing `listLookupCandidates` tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(storage): exclude retired orphans from enrich pool (#286)"
```

---

## Task 4: Exclude retired orphans from daily stats

**Files:**
- Modify: `src/storage/stats.ts` (`orphansPending`, line ~64)
- Test: `src/storage/stats.test.ts`

- [ ] **Step 1: Write the failing test**

The exported stats function is `collectStatus(db, now)` (verified in `src/storage/stats.ts:30`); existing tests call it as `collectStatus(db, new Date(...))` and use a `fresh()` helper (`openDb(':memory:')` + `migrate`). Add this test to `src/storage/stats.test.ts`, reusing that file's `fresh()` helper and its `upsertBeer` import (the `'reports enrich health metrics'` test shows the raw-insert style):

```ts
it('orphansPending excludes retired orphans', () => {
  const db = fresh();
  // two orphan beers (untappd_id NULL)
  const { lastInsertRowid: a } = db.prepare(
    `INSERT INTO beers (untappd_id,name,brewery,normalized_name,normalized_brewery) VALUES (NULL,'Alpha','Brew A','alpha','brew a')`,
  ).run();
  db.prepare(
    `INSERT INTO beers (untappd_id,name,brewery,normalized_name,normalized_brewery) VALUES (NULL,'Beta','Brew B','beta','brew b')`,
  ).run();
  // retire the first
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id,brewery,name,search_url,outcome,candidates_count,candidates_summary,
        fail_count,last_at,source_url,review_class,retired_at)
     VALUES (?,'Brew A','Alpha','u','not_found',0,'',1,'2026-07-01T00:00:00Z','','parser_bug','2026-07-19T00:00:00Z')`,
  ).run(a);

  const m = collectStatus(db, new Date('2026-07-19T10:00:00Z'));
  expect(m.orphansPending).toBe(1);
});
```

> If `fresh()` is not defined in `stats.test.ts`, inline `const db = openDb(':memory:'); migrate(db);` (imports already present at the top of the file).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/stats.test.ts -t "excludes retired"`
Expected: FAIL (`orphansPending` is 2, not 1).

- [ ] **Step 3: Update the query**

In `src/storage/stats.ts`, change:

```ts
    orphansPending: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NULL'),
```

to:

```ts
    orphansPending: count(
      `SELECT COUNT(*) AS c FROM beers b
        WHERE b.untappd_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM enrich_failures ef
            WHERE ef.beer_id = b.id AND ef.retired_at IS NOT NULL
          )`,
    ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/stats.test.ts`
Expected: PASS (new test + existing stats tests, including the original `orphansPending` assertion).

- [ ] **Step 5: Commit**

```bash
git add src/storage/stats.ts src/storage/stats.test.ts
git commit -m "feat(stats): exclude retired orphans from orphansPending (#286)"
```

---

## Task 5: The `retire-resolved-orphans` ops tool

Exports `selectAutoRetireTargets`, `selectIdTargets`, `applyRetire`; CLI with dry-run default, `--apply`, `--ids <csv>`, `--reason <text>`.

**Files:**
- Create: `scripts/retire-resolved-orphans.ts`
- Create: `scripts/retire-resolved-orphans.test.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the failing tests**

Create `scripts/retire-resolved-orphans.test.ts` (model the seeding on `scripts/rearm-matcher-bug-orphans.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { normalizeBrewery, normalizeName } from '../src/domain/normalize';
import { selectAutoRetireTargets, selectIdTargets, applyRetire } from './retire-resolved-orphans';

interface Seed {
  name: string;
  brewery: string;
  style?: string | null;
  untappd_id?: number | null;
  review_class?: 'parser_bug' | 'matcher_bug' | 'not_on_untappd' | 'wontfix' | null;
  retired_at?: string | null;
}

function fresh(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seed(db: DB, s: Seed): number {
  const info = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global, normalized_name, normalized_brewery)
     VALUES (@untappd_id, @name, @brewery, @style, NULL, NULL, @nn, @nb)`,
  ).run({
    untappd_id: s.untappd_id ?? null, name: s.name, brewery: s.brewery, style: s.style ?? null,
    nn: normalizeName(s.name), nb: normalizeBrewery(s.brewery),
  });
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
        fail_count, last_at, source_url, review_class, retired_at)
     VALUES (?, ?, ?, 'u', 'not_found', 0, '', 1, '2026-07-01T00:00:00Z', '', ?, ?)`,
  ).run(id, s.brewery, s.name, s.review_class ?? null, s.retired_at ?? null);
  return id;
}

describe('selectAutoRetireTargets', () => {
  it('selects classified orphans the current non-beer filter now rejects', () => {
    const db = fresh();
    const wine = seed(db, { name: 'Biały bez', brewery: 'VINO KARPATIA', review_class: 'parser_bug' });
    seed(db, { name: 'Hazy IPA', brewery: 'Real Brewery', review_class: 'parser_bug' }); // real beer, kept
    const ids = selectAutoRetireTargets(db).map((t) => t.beer_id);
    expect(ids).toEqual([wine]);
  });

  it('excludes matched beers, untriaged rows, and already-retired rows', () => {
    const db = fresh();
    seed(db, { name: 'Wino A', brewery: 'VINO A', review_class: 'parser_bug', untappd_id: 555 }); // matched
    seed(db, { name: 'Wino B', brewery: 'VINO B', review_class: null });                          // untriaged
    seed(db, { name: 'Wino C', brewery: 'VINO C', review_class: 'wontfix', retired_at: '2026-07-01T00:00:00Z' }); // already retired
    expect(selectAutoRetireTargets(db)).toEqual([]);
  });
});

describe('selectIdTargets', () => {
  it('returns only existing, orphan, not-yet-retired rows for the given ids', () => {
    const db = fresh();
    const a = seed(db, { name: 'Forest IPA', brewery: 'Forest IPA Brewery', review_class: 'parser_bug' });
    const matched = seed(db, { name: 'M', brewery: 'M Brew', review_class: 'parser_bug', untappd_id: 9 });
    const retired = seed(db, { name: 'R', brewery: 'R Brew', review_class: 'parser_bug', retired_at: '2026-07-01T00:00:00Z' });
    const got = selectIdTargets(db, [a, matched, retired, 12345]).map((t) => t.beer_id);
    expect(got).toEqual([a]);
  });
});

describe('applyRetire', () => {
  it('retires the targets and is idempotent', () => {
    const db = fresh();
    const a = seed(db, { name: 'Biały bez', brewery: 'VINO KARPATIA', review_class: 'parser_bug' });
    const targets = selectAutoRetireTargets(db);
    expect(applyRetire(db, targets, 'retired: current non-beer filter rejects')).toBe(1);
    const got = db.prepare('SELECT retired_at, review_class FROM enrich_failures WHERE beer_id = ?').get(a) as any;
    expect(got.retired_at).not.toBeNull();
    expect(got.review_class).toBe('parser_bug');
    // re-running selects nothing (already retired)
    expect(selectAutoRetireTargets(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/retire-resolved-orphans.test.ts`
Expected: FAIL (cannot import from `./retire-resolved-orphans`).

- [ ] **Step 3: Implement the tool**

Create `scripts/retire-resolved-orphans.ts`:

```ts
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { loadEnv } from '../src/config/env';
import { retireEnrichFailure } from '../src/storage/enrich_failures';
import { isOntapNonBeerTap } from '../src/sources/ontap/non-beer';
import { loadOperatorEnv } from './operator-env';

loadOperatorEnv();

const AUTO_NOTE = 'retired: current non-beer filter rejects';

export interface RetireTarget {
  beer_id: number;
  brewery: string;
  name: string;
  style: string | null;
  review_class: string | null;
}

// Classified orphan failures (review_class set, not yet retired) whose stored
// beer the CURRENT non-beer filter would now reject — the proof of resolution.
export function selectAutoRetireTargets(db: DB): RetireTarget[] {
  const rows = db
    .prepare(
      `SELECT ef.beer_id, b.brewery, b.name, b.style, ef.review_class
         FROM enrich_failures ef
         JOIN beers b ON b.id = ef.beer_id
        WHERE b.untappd_id IS NULL
          AND ef.review_class IS NOT NULL
          AND ef.retired_at IS NULL
        ORDER BY ef.beer_id`,
    )
    .all() as RetireTarget[];
  return rows.filter((r) =>
    isOntapNonBeerTap({ style: r.style, brewery_ref: r.brewery, beer_ref: r.name }),
  );
}

// Escape hatch: exactly the given beer_ids, restricted to existing orphan rows
// not already retired. Unknown / matched / already-retired ids are silently
// dropped here (the CLI warns about the difference).
export function selectIdTargets(db: DB, ids: number[]): RetireTarget[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT ef.beer_id, b.brewery, b.name, b.style, ef.review_class
         FROM enrich_failures ef
         JOIN beers b ON b.id = ef.beer_id
        WHERE b.untappd_id IS NULL
          AND ef.retired_at IS NULL
          AND ef.beer_id IN (${placeholders})
        ORDER BY ef.beer_id`,
    )
    .all(...ids) as RetireTarget[];
}

// Retire all targets in one transaction. Returns the number actually written.
export function applyRetire(db: DB, targets: RetireTarget[], note: string): number {
  const txn = db.transaction((ts: RetireTarget[]) => {
    let n = 0;
    for (const t of ts) {
      if (retireEnrichFailure(db, t.beer_id, note, new Date().toISOString())) n += 1;
    }
    return n;
  });
  return txn(targets);
}

function parseArgs(argv: string[]): { apply: boolean; ids: number[] | null; reason: string | null } {
  const apply = argv.includes('--apply');
  const idsIdx = argv.indexOf('--ids');
  const reasonIdx = argv.indexOf('--reason');
  const ids = idsIdx >= 0
    ? (argv[idsIdx + 1] ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
    : null;
  const reason = reasonIdx >= 0 ? (argv[reasonIdx + 1] ?? null) : null;
  return { apply, ids, reason };
}

function main(argv: string[]): void {
  const { apply, ids, reason } = parseArgs(argv);
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    let targets: RetireTarget[];
    let note: string;

    if (ids !== null) {
      if (!reason) {
        console.error('Error: --ids requires --reason "<text>".');
        process.exitCode = 1;
        return;
      }
      note = `retired: ${reason}`;
      targets = selectIdTargets(db, ids);
      const found = new Set(targets.map((t) => t.beer_id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        console.warn(`Skipping ${missing.length} id(s) — unknown, already matched, or already retired: ${missing.join(', ')}`);
      }
    } else {
      if (reason) {
        console.error('Error: --reason is only valid with --ids (auto path uses a fixed note).');
        process.exitCode = 1;
        return;
      }
      note = AUTO_NOTE;
      targets = selectAutoRetireTargets(db);
    }

    for (const t of targets) {
      console.log(`#${t.beer_id} [${t.review_class}] ${t.brewery} / ${t.name}${t.style ? ` (style: ${t.style})` : ''}`);
    }

    if (apply) {
      const n = applyRetire(db, targets, note);
      console.log(`Retired ${n} orphan(s). Note: "${note}"`);
    } else {
      console.log(`${targets.length} orphan(s) would be retired (dry-run; pass --apply to write).`);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Add the npm script**

In `package.json`, in `"scripts"`, add after the `rearm-matcher-bug-orphans` line:

```json
    "retire-resolved-orphans": "tsx scripts/retire-resolved-orphans.ts",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run scripts/retire-resolved-orphans.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Smoke-test the CLI dry-run against a temp DB**

Run:
```bash
npx tsx -e "const {openDb}=require('./src/storage/db');const {migrate}=require('./src/storage/schema');const db=openDb('/tmp/retire-smoke.db');migrate(db);db.prepare(\"INSERT INTO beers (untappd_id,name,brewery,style,normalized_name,normalized_brewery) VALUES (NULL,'Biały bez','VINO KARPATIA',NULL,'bialy bez','vino karpatia')\").run();db.prepare(\"INSERT INTO enrich_failures (beer_id,brewery,name,search_url,outcome,candidates_count,candidates_summary,fail_count,last_at,source_url,review_class) VALUES (1,'VINO KARPATIA','Biały bez','u','not_found',0,'',1,'2026-07-01T00:00:00Z','','parser_bug')\").run();db.close();"
DOTENV_CONFIG_PATH=/dev/null DATABASE_PATH=/tmp/retire-smoke.db npx tsx scripts/retire-resolved-orphans.ts
rm -f /tmp/retire-smoke.db
```
Expected: prints `#1 [parser_bug] VINO KARPATIA / Biały bez` then `1 orphan(s) would be retired (dry-run; ...)`.

> If `loadEnv()` rejects a bare `DATABASE_PATH` env (it may require a full `.env`), instead point `DOTENV_CONFIG_PATH` at a throwaway `.env` file containing the required keys plus `DATABASE_PATH=/tmp/retire-smoke.db`. The goal is only to eyeball the dry-run output.

- [ ] **Step 7: Commit**

```bash
git add scripts/retire-resolved-orphans.ts scripts/retire-resolved-orphans.test.ts package.json
git commit -m "feat(ops): retire-resolved-orphans tool (auto + --ids escape hatch, #286)"
```

---

## Task 6: Update `spec.md`

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Locate the enrich_failures / orphan-triage section**

Run: `grep -n "enrich_failures\|review_class\|wontfix\|orphan" spec.md | head -30`
Read the surrounding section that documents `enrich_failures` columns / triage classes.

- [ ] **Step 2: Document the terminal state**

Add a sentence/bullet to that section describing the `retired_at` column and its semantics. Use wording consistent with the surrounding prose. Content to convey:

> `retired_at` (nullable ISO timestamp): terminal state for a classified failure whose responsible parser/filter fix has shipped. Set by the `retire-resolved-orphans` ops tool. Retired rows keep their original `review_class` for audit; they are excluded from the enrich candidate pool (`listLookupCandidates`, alongside `wontfix`) and from the `orphansPending` daily-stats count. Selection is verification-based (auto: the current non-beer filter now rejects the row) or an explicit operator `--ids` escape hatch; never age- or class-based.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document enrich_failures.retired_at terminal state (#286)"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: all pass (no regressions in `beers`, `stats`, `enrich_failures`, `schema`, plus the new script tests).

- [ ] **Step 2: Typecheck / lint (match repo conventions)**

Run: `npm run typecheck` (or `npx tsc --noEmit` if that's the repo's check — verify in `package.json`).
Expected: no errors.

- [ ] **Step 3: Final review**

Confirm: migration 18 present; `retireEnrichFailure` idempotent; both consumers exclude retired; tool has auto + `--ids` paths with dry-run default; `package.json` script added; `spec.md` updated. No `extension/**` change → no `docs/extension-install-uk.md` update required.
