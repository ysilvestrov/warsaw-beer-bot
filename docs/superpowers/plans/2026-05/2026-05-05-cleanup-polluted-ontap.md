# Cleanup ABV-Polluted Ontap Rows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent startup job that re-derives clean beer names for ~495 ontap-side `beers` rows whose `name` is the full pre-Task-25 `<h4>` text (brewery + ABV/strength suffix + style); each polluted row is either merged into a canonical match (matcher confidence ≥ 0.9) or rewritten in place.

**Architecture:** New job mirrors `dedupeBreweryAliases`: pure-SQL setup, JS-side regex + matcher, single `db.transaction(...)` wrapping the whole pass for atomicity. Wired into `src/index.ts` immediately after the existing `dedupeBreweryAliases` call. Uses the live parser's `extractBeerName` and the production `matchBeer` so cleanup converges exactly on what current scrapes produce.

**Tech Stack:** TypeScript, better-sqlite3, Jest, pino. No new dependencies. No schema changes. Single feature branch `feat/cleanup-polluted-ontap`.

**Spec:** `docs/superpowers/specs/2026-04-30-cleanup-polluted-ontap-design.md`.

---

## File Structure

**Created:**
```
src/jobs/cleanup-polluted-ontap.ts        # cleanupPollutedOntap(db, log) → CleanupResult
src/jobs/cleanup-polluted-ontap.test.ts   # 7 cases covering rewrite/merge/idempotent
```

**Modified:**
```
src/index.ts                                                   # wire call after dedupeBreweryAliases
docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md    # §14 lesson entry
```

No schema migration. No env-var change. No dependency change.

---

## Branch setup

- [ ] **Step 1: Create the feature branch (worktree)**

```bash
cd /root/warsaw-beer-bot
git checkout main
git pull --ff-only
git worktree add .worktrees/feat-cleanup-polluted-ontap -b feat/cleanup-polluted-ontap main
cd .worktrees/feat-cleanup-polluted-ontap
npm install
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass (baseline ≥ 194 from PR #34).

---

## Task 1: Write the failing tests

**Files:**
- Create: `src/jobs/cleanup-polluted-ontap.test.ts`

These tests reference `cleanupPollutedOntap` and the `CleanupResult` interface. Both don't exist yet — Task 2 creates them. Tests will fail to compile/import; that's the red state.

The seven cases mirror the spec's "Tests" section, with `Test 4` (cross-source canonicals) made deterministic by relying on the matcher's actual tiebreaker: `matcher.ts:53` sorts `exacts` by `id` **descending**, so when two equal canonicals exist, the higher-id one wins. (Spec's narrative claim about untappd-side preference was based on insertion order; we encode the actual rule.)

- [ ] **Step 1: Create the test file**

```ts
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { cleanupPollutedOntap } from './cleanup-polluted-ontap';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function getRow(db: ReturnType<typeof openDb>, id: number) {
  return db.prepare('SELECT id, name, brewery, normalized_name, normalized_brewery, untappd_id FROM beers WHERE id = ?').get(id) as
    | { id: number; name: string; brewery: string; normalized_name: string; normalized_brewery: string; untappd_id: number | null }
    | undefined;
}

describe('cleanupPollutedOntap', () => {
  test('empty DB → no-op', () => {
    const db = fresh();
    expect(cleanupPollutedOntap(db, silentLog)).toEqual({ rewritten: 0, merged: 0 });
  });

  test('single polluted row, no canonical → rewrite in place', () => {
    const db = fresh();
    // Pre-Task-25 polluted row: full <h4> text as name.
    const id = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 1, merged: 0 });

    const row = getRow(db, id)!;
    expect(row.name).toBe('Oxymel');
    expect(row.normalized_name).toBe('oxymel');
    expect(row.brewery).toBe('Wagabunda Brewery'); // brewery untouched
    expect(row.normalized_brewery).toBe('wagabunda'); // untouched
  });

  test('polluted + ontap canonical → merge with match_links + checkins repointed', () => {
    const db = fresh();
    // Canonical (clean) ontap-side row.
    const cleanId = upsertBeer(db, {
      untappd_id: null,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: null,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    // Polluted row.
    const pollutedId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });
    // Reference rows pointing at the polluted id.
    db.prepare(
      'INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence) VALUES (?, ?, ?)',
    ).run('Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale', pollutedId, 1.0);
    db.prepare(
      'INSERT INTO checkins (checkin_id, telegram_id, beer_id, checkin_at) VALUES (?, ?, ?, ?)',
    ).run('chk-1', 42, pollutedId, '2026-04-01 12:00:00');

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 1 });

    expect(getRow(db, pollutedId)).toBeUndefined(); // polluted gone
    expect(getRow(db, cleanId)?.name).toBe('Oxymel'); // canonical intact

    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(cleanId);

    const checkin = db.prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?')
      .get('chk-1') as { beer_id: number };
    expect(checkin.beer_id).toBe(cleanId);
  });

  test('polluted with both ontap and untappd canonicals → merge into the higher-id exact match', () => {
    // matcher.ts:53 sorts exacts by id DESC; with no abv tiebreak, exacts[0]
    // is the highest-id row. Insert ontap-side LAST so it has the higher id.
    const db = fresh();
    const untappdId = upsertBeer(db, {
      untappd_id: 12345,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: 3.7,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const ontapCleanId = upsertBeer(db, {
      untappd_id: null,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: null,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const pollutedId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 1 });
    expect(getRow(db, pollutedId)).toBeUndefined();
    // Both canonicals untouched.
    expect(getRow(db, untappdId)?.untappd_id).toBe(12345);
    expect(getRow(db, ontapCleanId)?.untappd_id).toBeNull();
  });

  test('two polluted rows resolving to the same clean name, no canonical → both rewrite (become duplicates)', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 12°·4,2% — Sour',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.2,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 12 4 2',
      normalized_brewery: 'wagabunda',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 2, merged: 0 });

    expect(getRow(db, aId)?.name).toBe('Oxymel');
    expect(getRow(db, aId)?.normalized_name).toBe('oxymel');
    expect(getRow(db, bId)?.name).toBe('Oxymel');
    expect(getRow(db, bId)?.normalized_name).toBe('oxymel');
    // Both rows still exist — out-of-scope same-brewery dedup.
  });

  test('idempotent: second invocation returns {0, 0}', () => {
    const db = fresh();
    upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const first = cleanupPollutedOntap(db, silentLog);
    expect(first).toEqual({ rewritten: 1, merged: 0 });

    const second = cleanupPollutedOntap(db, silentLog);
    expect(second).toEqual({ rewritten: 0, merged: 0 });
  });

  test('clean rows preserved — no pollution markers means no touching', () => {
    const db = fresh();
    const cleanId = upsertBeer(db, {
      untappd_id: null,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: null,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const untappdRowId = upsertBeer(db, {
      untappd_id: 99,
      // Even with pollution markers, untappd-side rows are out of scope.
      name: 'Some Brewery Stuff 14°·5%',
      brewery: 'Some Brewery',
      style: null,
      abv: 5.0,
      rating_global: 3.5,
      normalized_name: 'some stuff 14 5',
      normalized_brewery: 'some',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 0 });
    expect(getRow(db, cleanId)?.name).toBe('Oxymel');
    expect(getRow(db, untappdRowId)?.name).toBe('Some Brewery Stuff 14°·5%');
  });
});
```

- [ ] **Step 2: Run the tests; expect compile-time failure**

```bash
npx jest src/jobs/cleanup-polluted-ontap.test.ts
```

Expected: TS error `Cannot find module './cleanup-polluted-ontap'` — the file does not exist yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/jobs/cleanup-polluted-ontap.test.ts
git commit -m "test(cleanup): failing tests for polluted-ontap cleanup job"
```

(Committing red is acceptable on a feature branch — the next commit fixes it.)

---

## Task 2: Implement the cleanup job (green)

**Files:**
- Create: `src/jobs/cleanup-polluted-ontap.ts`

The job mirrors `dedupeBreweryAliases`'s structure: load candidates, compute the JS-side action plan, execute everything inside one `db.transaction`. Reuse `extractBeerName` from the live parser and `matchBeer` from `domain/matcher`.

- [ ] **Step 1: Create the implementation**

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { extractBeerName } from '../sources/ontap/pub';
import { matchBeer, type CatalogBeer } from '../domain/matcher';
import { normalizeName } from '../domain/normalize';

const POLLUTION_RE = /\d+(?:[.,]\d+)?\s*[°%]| — /;
const MERGE_THRESHOLD = 0.9;

interface BeerRow extends CatalogBeer {
  normalized_name: string;
  untappd_id: number | null;
}

export interface CleanupResult {
  rewritten: number;
  merged: number;
}

interface MergePlan { kind: 'merge'; pollutedId: number; targetId: number }
interface RewritePlan { kind: 'rewrite'; pollutedId: number; cleaned: string; cleanedNormalized: string }
type Plan = MergePlan | RewritePlan;

export function cleanupPollutedOntap(db: DB, log: pino.Logger): CleanupResult {
  // Pull all ontap-side rows once; SQLite has no JS regex so partition in JS.
  const allOntap = db
    .prepare(
      `SELECT id, name, brewery, abv, normalized_name, untappd_id
         FROM beers
        WHERE untappd_id IS NULL`,
    )
    .all() as BeerRow[];

  const pollutedIds = new Set<number>();
  const polluted: BeerRow[] = [];
  for (const r of allOntap) {
    if (POLLUTION_RE.test(r.name)) {
      polluted.push(r);
      pollutedIds.add(r.id);
    }
  }

  if (polluted.length === 0) {
    log.info({ polluted: 0 }, 'cleanup-polluted-ontap: catalog clean');
    return { rewritten: 0, merged: 0 };
  }

  // Match pool: every beer minus polluted ids — guarantees we never merge
  // a polluted row into another polluted row.
  const cleanPool = db
    .prepare('SELECT id, name, brewery, abv FROM beers')
    .all() as CatalogBeer[];
  const pool = cleanPool.filter((c) => !pollutedIds.has(c.id));

  const plans: Plan[] = [];
  for (const p of polluted) {
    const cleaned = extractBeerName(p.name, p.brewery);
    if (!cleaned) continue; // h4 was just brewery + ABV — nothing to salvage
    const cleanedNorm = normalizeName(cleaned);
    if (cleanedNorm === p.normalized_name) continue; // no-op cleanup

    const match = matchBeer({ brewery: p.brewery, name: cleaned, abv: p.abv }, pool);
    if (match && match.confidence >= MERGE_THRESHOLD) {
      plans.push({ kind: 'merge', pollutedId: p.id, targetId: match.id });
    } else {
      plans.push({ kind: 'rewrite', pollutedId: p.id, cleaned, cleanedNormalized: cleanedNorm });
    }
  }

  const updateLinks = db.prepare(
    'UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?',
  );
  const updateCheckins = db.prepare(
    'UPDATE checkins SET beer_id = ? WHERE beer_id = ?',
  );
  const deleteBeer = db.prepare('DELETE FROM beers WHERE id = ?');
  const rewriteName = db.prepare(
    'UPDATE beers SET name = ?, normalized_name = ? WHERE id = ?',
  );

  let rewritten = 0;
  let merged = 0;
  const tx = db.transaction((items: Plan[]) => {
    for (const plan of items) {
      if (plan.kind === 'merge') {
        updateLinks.run(plan.targetId, plan.pollutedId);
        updateCheckins.run(plan.targetId, plan.pollutedId);
        deleteBeer.run(plan.pollutedId);
        merged++;
      } else {
        rewriteName.run(plan.cleaned, plan.cleanedNormalized, plan.pollutedId);
        rewritten++;
      }
    }
  });
  tx(plans);

  log.info({ rewritten, merged }, 'cleanup-polluted-ontap: pass complete');
  return { rewritten, merged };
}
```

Notes:
- `cleanPool` is built from a separate SELECT (not filtered from `allOntap`) so that untappd-side rows are eligible merge targets. Polluted ids are excluded by the JS-side filter to ensure merge targets are guaranteed clean.
- `matchBeer` already filters its catalog to brewery-alias-overlapping rows internally; we pass the whole pool and let it do the filtering. (See `matcher.ts:42-83`.)
- The early `continue` when `cleanedNorm === p.normalized_name` defends against `extractBeerName` returning a string that re-normalizes to the same form (e.g., a row whose name lacks a brewery prefix and only had ABV). Without this guard such a row would be counted as `rewritten` even though no DB write changed.
- Single-transaction wrapping: matches `dedupeBreweryAliases`'s pattern (`src/jobs/dedupe-brewery-aliases.ts:60-67`).

- [ ] **Step 2: Run the cleanup tests; expect all pass**

```bash
npx jest src/jobs/cleanup-polluted-ontap.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 3: Run the full suite + typecheck**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass (≥ 201 = previous 194 + 7 new).

- [ ] **Step 4: Commit**

```bash
git add src/jobs/cleanup-polluted-ontap.ts
git commit -m "feat(jobs): cleanup-polluted-ontap merges or rewrites pre-Task-25 ontap rows"
```

---

## Task 3: Wire the job into startup

**Files:**
- Modify: `src/index.ts`

Run the cleanup right after `dedupeBreweryAliases` so both startup-time fixes converge before the bot accepts traffic. Order matters: dedup first (collapses brewery-alias pairs), then this cleanup (re-derives polluted ontap names against the deduped catalog).

- [ ] **Step 1: Add the import + call**

In `src/index.ts`, after the existing line:

```ts
import { dedupeBreweryAliases } from './jobs/dedupe-brewery-aliases';
```

Add:

```ts
import { cleanupPollutedOntap } from './jobs/cleanup-polluted-ontap';
```

Then, after the existing line:

```ts
  dedupeBreweryAliases(db, log);
```

Add:

```ts
  cleanupPollutedOntap(db, log);
```

- [ ] **Step 2: Verify it compiles + tests still green**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(bot): run cleanup-polluted-ontap at startup after dedupe"
```

---

## Task 4: Log the lesson in §14 of the canonical spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`

- [ ] **Step 1: Locate the insertion point**

```bash
grep -n "Untappd \`/user/<X>/beers\`\|Ці грабельки" docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
```

The new entry goes between the closing line of the `/user/<X>/beers` scraper block and the `Ці грабельки …` paragraph.

- [ ] **Step 2: Insert the entry**

Insert the following block immediately before `Ці грабельки — чек-лист на першу секунду нового деплою.`:

```markdown
- **Polluted ontap-row cleanup**: pre-Task 25 scrapes left ~500 rows where
  `name` was the full `<h4>` text (brewery + name + ABV + style suffix).
  Cleaned at startup by `src/jobs/cleanup-polluted-ontap.ts`: re-runs the
  parser's `extractBeerName` on each ontap-side (`untappd_id IS NULL`) row
  whose name still matches the pollution regex (`\d+[°%]` or ` — `), then
  either merges into a canonical match (confidence ≥ 0.9, exact or
  high-fuzzy) or rewrites in place. Idempotent — second boot finds 0 rows.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs(spec): log polluted-ontap cleanup lesson in §14"
```

---

## Task 5: Open the PR

- [ ] **Step 1: Final green check**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/cleanup-polluted-ontap
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head feat/cleanup-polluted-ontap \
  --title "feat(jobs): cleanup polluted ontap rows at startup" \
  --body "$(cat <<'EOF'
## Summary
Phase 2 of the post-PR-#30 rating + cleanup roadmap (PR #31).
Spec: `docs/superpowers/specs/2026-04-30-cleanup-polluted-ontap-design.md`.

Pre-Task-25 ontap scrapes wrote the entire `<h4>` text (brewery prefix + ABV/strength + " — style") into `beers.name`, leaving ~495 / 663 ontap-side rows (~75%) unmatchable to any future tap. New idempotent startup job:

- Detects polluted rows via JS-side regex (`\d+[°%]` or ` — `) over `untappd_id IS NULL` rows.
- Re-derives the clean name with the live parser's `extractBeerName`.
- Either merges (matchBeer confidence ≥ 0.9 against a clean-pool) or rewrites in place.
- Wrapped in a single `db.transaction` for atomicity. Mirrors `dedupeBreweryAliases`'s structure.
- Runs in `src/index.ts` right after `dedupeBreweryAliases` so both startup-time catalog fixes converge before the bot accepts traffic.

## Test plan
- [x] `npx tsc --noEmit` — clean
- [x] `npx jest` — all tests pass (7 new cases: empty, single rewrite, merge with link/checkin repoint, cross-source canonicals tiebreak, two-polluted-no-canonical, idempotent, negative)
- [ ] Post-deploy smoke (manual): on first boot, expect a single log line `cleanup-polluted-ontap: pass complete` with non-zero `rewritten` / `merged`. Second boot: `catalog clean`. Verify with: `sqlite3 /var/lib/warsaw-beer-bot/bot.db "SELECT COUNT(*) FROM beers WHERE untappd_id IS NULL AND (name GLOB '*[0-9]*[°%]*' OR name LIKE '% — %');"` — expect 0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 6: Post-deploy smoke (manual checklist — not a commit)

After merge + deploy:

- [ ] First-boot log:
  ```bash
  ssh <prod> 'journalctl -u warsaw-beer-bot -n 200 | grep cleanup-polluted-ontap'
  ```
  Expected: a `pass complete` line with `rewritten` + `merged` summing close to ~495 (the prod-DB scope-check baseline).

- [ ] Convergence on second boot:
  ```bash
  ssh <prod> 'systemctl restart warsaw-beer-bot && sleep 5 && journalctl -u warsaw-beer-bot -n 50 | grep cleanup-polluted-ontap'
  ```
  Expected: `catalog clean` (0 polluted rows found).

- [ ] DB-level check:
  ```bash
  ssh <prod> 'sqlite3 /var/lib/warsaw-beer-bot/bot.db "SELECT COUNT(*) FROM beers WHERE untappd_id IS NULL AND (name GLOB \"*[0-9]*[°%]*\" OR name LIKE \"% — %\");"'
  ```
  Expected: 0.

---

## Done criteria

Branch `feat/cleanup-polluted-ontap` is ready for PR when:
- Tasks 1–4 committed.
- `npx tsc --noEmit && npx jest` passes.
- PR opened against `main`.

After merge:
- Task 6 smoke checks performed.
