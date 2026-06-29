# Re-arm Alias-Covered Orphans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a maintenance script that resets the Untappd-lookup backoff state of orphan beers the curated brewery-alias layer now covers, so the enrich cron re-attempts them.

**Architecture:** A pure predicate `hasCuratedAlias(brewery)` (built on the existing `breweryAliases` + a new `aliasKeys()` set) decides coverage. A `tsx` CLI selects orphans (`untappd_id IS NULL`, `untappd_lookup_count > 0`, alias-covered) and either prints them (dry-run, default) or resets `untappd_lookup_count = 0` / `untappd_lookup_at = NULL` in a transaction (`--apply`). No Untappd traffic — the cron does the real lookups.

**Tech Stack:** TypeScript (CommonJS), better-sqlite3, Vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-06-29-rearm-aliased-orphans-design.md`

---

### Task 1: `aliasKeys()` — the curated alias key set

**Files:**
- Modify: `src/domain/brewery-aliases.ts`
- Test: `src/domain/brewery-aliases.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/brewery-aliases.test.ts` (extend the existing import line to include `aliasKeys`):

```ts
import { aliasNeighbors, aliasKeys } from './brewery-aliases';

describe('aliasKeys', () => {
  it('contains both sides of every curated pair, excludes non-aliases', () => {
    const keys = aliasKeys();
    expect(keys.has('nepomucen')).toBe(true);
    expect(keys.has('nepo')).toBe(true);
    expect(keys.has('starkraft')).toBe(true);
    expect(keys.has('starkaft')).toBe(true);
    expect(keys.has('pinta')).toBe(false);
  });
});
```

(If `aliasNeighbors` is already imported in this file, just add `, aliasKeys` to that import instead of duplicating the line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/brewery-aliases.test.ts -t aliasKeys`
Expected: FAIL — `aliasKeys is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/domain/brewery-aliases.ts`, after the `NEIGHBORS` map definition and `aliasNeighbors`, add:

```ts
// Every normalized form that appears in ALIAS_PAIRS (both sides of every pair).
const ALIAS_KEYS: ReadonlySet<string> = new Set(NEIGHBORS.keys());

// The set of curated-alias keys — used to decide whether a brewery is covered by
// the curated layer at all (see hasCuratedAlias in matcher.ts).
export function aliasKeys(): ReadonlySet<string> {
  return ALIAS_KEYS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/brewery-aliases.test.ts -t aliasKeys`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/brewery-aliases.ts src/domain/brewery-aliases.test.ts
git commit -m "feat(matcher): export aliasKeys() curated-alias key set"
```

---

### Task 2: `hasCuratedAlias()` predicate

**Files:**
- Modify: `src/domain/matcher.ts`
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/matcher.test.ts` (add `hasCuratedAlias` to the existing `from './matcher'` import):

```ts
describe('hasCuratedAlias', () => {
  it('true for breweries with a curated alias pair', () => {
    expect(hasCuratedAlias('Nepomucen Brewery')).toBe(true);
    expect(hasCuratedAlias('Starkaft Brewery')).toBe(true);
  });
  it('false for plain collabs and unrelated breweries', () => {
    expect(hasCuratedAlias('Stu Mostów / Ophiussa')).toBe(false);
    expect(hasCuratedAlias('Pinta')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/matcher.test.ts -t hasCuratedAlias`
Expected: FAIL — `hasCuratedAlias is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/domain/matcher.ts`:

1. Add `aliasKeys` to the existing import from `./brewery-aliases` (currently imports `aliasNeighbors`):

```ts
import { aliasNeighbors, aliasKeys } from './brewery-aliases';
```

2. Add the predicate immediately after the `breweryAliases` function:

```ts
// True iff the curated alias layer adds coverage for this brewery, i.e. one of its
// normalized alias forms is a curated alias key. NOTE: `breweryAliases(b).length > 1`
// is the WRONG predicate — plain collaborations ("A / B") also split into multiple
// tokens without any curated pair. This intersection check excludes them.
export function hasCuratedAlias(brewery: string): boolean {
  const keys = aliasKeys();
  return breweryAliases(brewery).some((a) => keys.has(a));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/matcher.test.ts -t hasCuratedAlias`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): hasCuratedAlias predicate for alias coverage"
```

---

### Task 3: Re-arm script core + CLI

**Files:**
- Create: `scripts/rearm-aliased-orphans.ts`
- Create: `scripts/rearm-aliased-orphans.test.ts`
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Write the failing test**

Create `scripts/rearm-aliased-orphans.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { normalizeName, normalizeBrewery } from '../src/domain/normalize';
import { selectRearmTargets, applyRearm } from './rearm-aliased-orphans';

function fresh(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

interface SeedBeer {
  name: string;
  brewery: string;
  untappd_id?: number | null;
  untappd_lookup_count: number;
  untappd_lookup_at?: string | null;
}

function insertBeer(db: DB, b: SeedBeer): void {
  db.prepare(
    `INSERT INTO beers
       (untappd_id, name, brewery, style, abv, rating_global,
        normalized_name, normalized_brewery, untappd_lookup_at, untappd_lookup_count)
     VALUES
       (@untappd_id, @name, @brewery, NULL, NULL, NULL,
        @normalized_name, @normalized_brewery, @untappd_lookup_at, @untappd_lookup_count)`,
  ).run({
    untappd_id: b.untappd_id ?? null,
    name: b.name,
    brewery: b.brewery,
    normalized_name: normalizeName(b.name),
    normalized_brewery: normalizeBrewery(b.brewery),
    untappd_lookup_at: b.untappd_lookup_at ?? null,
    untappd_lookup_count: b.untappd_lookup_count,
  });
}

function seedAll(db: DB): void {
  // alias-covered, attempted orphan -> SELECTED
  insertBeer(db, { name: 'Hoppiness Pils', brewery: 'Nepomucen Brewery', untappd_lookup_count: 4, untappd_lookup_at: '2026-06-23T06:30:18.348Z' });
  // alias-covered but untried (count 0) -> not selected
  insertBeer(db, { name: 'Tonkowiec Bałtycki', brewery: 'Starkaft Brewery', untappd_lookup_count: 0 });
  // plain collab, attempted -> not selected (no curated alias)
  insertBeer(db, { name: 'Some Hazy', brewery: 'Stu Mostów / Ophiussa', untappd_lookup_count: 2 });
  // already matched alias-brewery beer -> not selected (has untappd_id)
  insertBeer(db, { name: 'Black Grodzisz', brewery: 'Nepomucen Brewery', untappd_id: 999, untappd_lookup_count: 4 });
}

describe('selectRearmTargets', () => {
  it('selects only attempted, alias-covered orphans', () => {
    const db = fresh();
    seedAll(db);
    const targets = selectRearmTargets(db);
    expect(targets.map((t) => t.name)).toEqual(['Hoppiness Pils']);
    expect(targets[0].untappd_lookup_count).toBe(4);
  });
});

describe('applyRearm', () => {
  it('resets count + lookup_at and is idempotent', () => {
    const db = fresh();
    seedAll(db);
    const targets = selectRearmTargets(db);
    expect(applyRearm(db, targets)).toBe(1);

    const row = db
      .prepare('SELECT untappd_lookup_count AS c, untappd_lookup_at AS a FROM beers WHERE name = ?')
      .get('Hoppiness Pils') as { c: number; a: string | null };
    expect(row.c).toBe(0);
    expect(row.a).toBeNull();

    // count > 0 filter now excludes the re-armed row -> second pass is a no-op.
    expect(selectRearmTargets(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/rearm-aliased-orphans.test.ts`
Expected: FAIL — cannot resolve `./rearm-aliased-orphans` / `selectRearmTargets` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/rearm-aliased-orphans.ts`:

```ts
import 'dotenv/config';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { loadEnv } from '../src/config/env';
import { hasCuratedAlias } from '../src/domain/matcher';

export interface RearmTarget {
  id: number;
  brewery: string;
  name: string;
  untappd_lookup_count: number;
}

// Orphans (no Untappd match) that have already been attempted (count > 0) and whose
// brewery is covered by the curated alias layer. Untried (count = 0) orphans are
// already eligible for the cron, so they are intentionally excluded.
export function selectRearmTargets(db: DB): RearmTarget[] {
  const rows = db
    .prepare(
      `SELECT id, brewery, name, untappd_lookup_count
         FROM beers
        WHERE untappd_id IS NULL AND untappd_lookup_count > 0`,
    )
    .all() as RearmTarget[];
  return rows.filter((r) => hasCuratedAlias(r.brewery));
}

// Reset the lookup-backoff state so the enrich cron re-attempts these beers.
// Returns the number of rows updated. Runs in a single transaction.
export function applyRearm(db: DB, targets: RearmTarget[]): number {
  const upd = db.prepare(
    `UPDATE beers SET untappd_lookup_count = 0, untappd_lookup_at = NULL WHERE id = ?`,
  );
  const txn = db.transaction((ts: RearmTarget[]) => {
    for (const t of ts) upd.run(t.id);
    return ts.length;
  });
  return txn(targets);
}

function main(argv: string[]): void {
  const apply = argv.includes('--apply');
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    const targets = selectRearmTargets(db);
    for (const t of targets) {
      console.log(`${t.brewery} / ${t.name} (count=${t.untappd_lookup_count})`);
    }
    if (apply) {
      const n = applyRearm(db, targets);
      console.log(`Re-armed ${n} orphan(s).`);
    } else {
      console.log(
        `${targets.length} orphan(s) would be re-armed (dry-run; pass --apply to write).`,
      );
    }
  } finally {
    db.close();
  }
}

// Run only when invoked directly, not when imported by the test.
if (require.main === module) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/rearm-aliased-orphans.test.ts`
Expected: PASS (both `selectRearmTargets` and `applyRearm` describe blocks).

- [ ] **Step 5: Add the npm script**

In `package.json`, add to the `"scripts"` object (after `"alias-key"`):

```json
    "alias-key": "tsx scripts/brewery-alias-key.ts",
    "rearm-aliased-orphans": "tsx scripts/rearm-aliased-orphans.ts"
```

(Add a comma after the `alias-key` line.)

- [ ] **Step 6: Verify the CLI dry-run runs**

Run: `npm run rearm-aliased-orphans`
Expected: prints a list of `brewery / name (count=N)` lines and a `… would be re-armed (dry-run; pass --apply to write).` summary, exits 0, writes nothing. (Uses the prod `DATABASE_PATH` from `.env`.)

- [ ] **Step 7: Commit**

```bash
git add scripts/rearm-aliased-orphans.ts scripts/rearm-aliased-orphans.test.ts package.json
git commit -m "feat(scripts): rearm-aliased-orphans re-arm tool (dry-run + --apply)"
```

---

### Task 4: Runbook — re-arm workflow + triage columns

**Files:**
- Modify: `docs/debug-orphan-matching.md`

- [ ] **Step 1: Append the two sections**

Add these two sections at the end of `docs/debug-orphan-matching.md`:

```markdown
## Re-arming orphans after a matcher fix

The orphan-lookup backoff (`src/domain/lookup-backoff.ts`) is **terminal**: a beer is
re-tried at `[0, 72h, 168h, 728h]` and then, at `untappd_lookup_count >= 4`, goes
**dormant forever** until its count is reset.

So when you ship a matcher improvement — most often a new curated brewery-alias pair
(see "Як додати brewery-alias" above) — orphans it now resolves do **not** come back
on their own:

- `ALIAS_PAIRS` is read at startup, so a deployed alias does nothing until the service
  is **restarted**. Attempts in the gap waste backoff against the old binary.
- Orphans already at `count >= 4` are dormant; the cron will never re-attempt them.

After deploying the fix **and restarting the service**, re-arm the affected orphans:

```bash
npm run rearm-aliased-orphans            # dry-run: lists what would be re-armed
npm run rearm-aliased-orphans -- --apply # resets untappd_lookup_count=0 / untappd_lookup_at=NULL
```

Targeting is derived entirely from the curated alias list (`hasCuratedAlias`): it
re-arms orphans (`untappd_id IS NULL`) that have been attempted (`count > 0`) and whose
brewery has a curated alias pair. It makes **no** Untappd calls — the next enrich-cron
tick performs the real lookups. `--apply` is idempotent (re-armed rows drop to
`count = 0` and are excluded next run).

## Triage columns on `enrich_failures`

`enrich_failures` carries two columns that are the entry point for orphan analysis:

- **`source_url`** — where the beer entered. `''` = the `enrichOrphans` cron
  (tap-derived). A non-empty host identifies the extension-relay shop adapter
  (`flasker.com.ua`, `beerfreak.org`, `beerrepublic.eu`, `winetime.com.ua`,
  `onemorebeer.pl`, …).
- **`review_class`** (+ `review_note`, `reviewed_at`) — manual triage bucket:
  `parser_bug` (shop adapter mis-split brewery/name), `matcher_bug` (gate/fuzzy
  rejected a correct candidate — often fixable with a curated alias), `not_on_untappd`
  (cider/wine/placeholder genuinely absent), `wontfix` (non-beer merch, accessories).

Example triage query (read-only prod DB):

```bash
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db \
  "SELECT review_class, COUNT(*) FROM enrich_failures GROUP BY review_class;"
```
```

- [ ] **Step 2: Verify the build still passes (docs change is inert, but confirm nothing else broke)**

Run: `npm run typecheck`
Expected: clean (no output / exit 0).

- [ ] **Step 3: Commit**

```bash
git add docs/debug-orphan-matching.md
git commit -m "docs(runbook): re-arm workflow + enrich_failures triage columns"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all green, including the new `aliasKeys`, `hasCuratedAlias`, and
`rearm-aliased-orphans` tests.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

---

## Self-Review

**Spec coverage:**
- `aliasKeys()` → Task 1. ✓
- `hasCuratedAlias()` → Task 2. ✓
- `selectRearmTargets` (orphan + `count > 0` + alias-covered) → Task 3. ✓
- `applyRearm` (txn reset) → Task 3. ✓
- dry-run default / `--apply` CLI → Task 3 (impl + Step 6 manual run). ✓
- `package.json` npm script → Task 3 Step 5. ✓
- Vitest: selection, idempotency, predicate → Tasks 1–3. ✓
- Runbook: re-arm workflow + triage columns → Task 4. ✓
- Non-goals (no brewery arg, no deploy hook, no Untappd traffic) → respected (script only resets DB). ✓

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `RearmTarget { id, brewery, name, untappd_lookup_count }` used identically in `selectRearmTargets`, `applyRearm`, and the test. `hasCuratedAlias(brewery: string): boolean` and `aliasKeys(): ReadonlySet<string>` consistent across tasks.
