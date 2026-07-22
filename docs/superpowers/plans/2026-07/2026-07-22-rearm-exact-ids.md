# Rearm by exact beer IDs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `rearm-matcher-bug-orphans` re-arm an explicit list of orphan beer IDs, bypassing the default `matcher_bug`/`candidates_count` filters.

**Architecture:** Add a shared `selectRearmTargetsByIds` helper (orphan-only gate) to `rearm-aliased-orphans.ts`; wire a `--ids <csv>` mode into `rearm-matcher-bug-orphans.ts`'s `main`, mirroring `retire-resolved-orphans` parsing; document in `spec.md`.

**Tech Stack:** TypeScript, better-sqlite3 (via `src/storage/db`), Vitest, tsx.

---

### Task 1: `selectRearmTargetsByIds` helper + tests

**Files:**
- Modify: `scripts/rearm-aliased-orphans.ts` (add exported helper after `applyRearm`)
- Modify: `scripts/rearm-matcher-bug-orphans.ts` (re-export helper for the test's import path)
- Test: `scripts/rearm-matcher-bug-orphans.test.ts` (new `describe`)

- [ ] **Step 1: Write the failing test**

Append to `scripts/rearm-matcher-bug-orphans.test.ts` (and add `selectRearmTargetsByIds` to the existing import from `./rearm-matcher-bug-orphans`):

```typescript
describe('selectRearmTargetsByIds', () => {
  it('returns orphan rows for the given ids in id order, ignoring class/candidate filters', () => {
    const db = fresh();
    try {
      const parserZero = insertFailure(db, {
        name: 'Parser Zero',
        brewery: 'Brewery Zero',
        review_class: 'parser_bug',
        candidates_count: 0,
      });
      const matched = insertFailure(db, {
        name: 'Already Matched',
        brewery: 'Brewery Matched',
        untappd_id: 999,
      });
      const plain = insertFailure(db, { name: 'Plain Orphan', brewery: 'Brewery Plain' });
      const missing = plain + 10_000;

      expect(selectRearmTargetsByIds(db, [plain, parserZero, matched, missing])).toEqual([
        { id: parserZero, brewery: 'Brewery Zero', name: 'Parser Zero', untappd_lookup_count: 3 },
        { id: plain, brewery: 'Brewery Plain', name: 'Plain Orphan', untappd_lookup_count: 3 },
      ]);
    } finally {
      db.close();
    }
  });

  it('returns an empty array for an empty id list', () => {
    const db = fresh();
    try {
      expect(selectRearmTargetsByIds(db, [])).toEqual([]);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/rearm-matcher-bug-orphans.test.ts -t selectRearmTargetsByIds`
Expected: FAIL — `selectRearmTargetsByIds is not exported` / not a function.

- [ ] **Step 3: Add the helper to `scripts/rearm-aliased-orphans.ts`**

Insert after `applyRearm` (before `function main`):

```typescript
// Orphans (no Untappd match) selected by explicit beer id, bypassing the class/candidate
// filters of the query-based selectors. The only gate is "still an orphan" (untappd_id IS NULL):
// never reset a matched beer. Empty id list short-circuits to no targets.
export function selectRearmTargetsByIds(db: DB, ids: number[]): RearmTarget[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, brewery, name, untappd_lookup_count
         FROM beers
        WHERE untappd_id IS NULL AND id IN (${placeholders})
        ORDER BY id`,
    )
    .all(...ids) as RearmTarget[];
}
```

- [ ] **Step 4: Re-export it from `scripts/rearm-matcher-bug-orphans.ts`**

Change the existing re-export line:

```typescript
export { applyRearm } from './rearm-aliased-orphans';
```

to:

```typescript
export { applyRearm, selectRearmTargetsByIds } from './rearm-aliased-orphans';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/rearm-matcher-bug-orphans.test.ts -t selectRearmTargetsByIds`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/rearm-aliased-orphans.ts scripts/rearm-matcher-bug-orphans.test.ts scripts/rearm-matcher-bug-orphans.ts
git commit -m "feat(ops): selectRearmTargetsByIds — rearm orphans by explicit id"
```

---

### Task 2: Wire `--ids` exact-id mode into the CLI

**Files:**
- Modify: `scripts/rearm-matcher-bug-orphans.ts` (import helper, add `parseIds`, branch in `main`)

- [ ] **Step 1: Import the helper for use**

Change the top import:

```typescript
import { applyRearm } from './rearm-aliased-orphans';
```

to:

```typescript
import { applyRearm, selectRearmTargetsByIds } from './rearm-aliased-orphans';
```

- [ ] **Step 2: Add `parseIds` and branch in `main`**

Add above `main`:

```typescript
function parseIds(argv: string[]): number[] | null {
  const idx = argv.indexOf('--ids');
  if (idx < 0) return null;
  return (argv[idx + 1] ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
}
```

Replace the body of `main` (keep the `openDb`/`try`/`finally` shape) so target selection branches on `--ids`:

```typescript
function main(argv: string[]): void {
  const apply = argv.includes('--apply');
  const ids = parseIds(argv);
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    let targets: RearmTarget[];
    if (ids !== null) {
      targets = selectRearmTargetsByIds(db, ids);
      const found = new Set(targets.map((t) => t.id));
      for (const id of ids) {
        if (!found.has(id)) {
          console.warn(`⚠ ${id}: skipped (missing or already matched)`);
        }
      }
    } else {
      targets = selectRearmTargets(db);
    }

    for (const target of targets) {
      console.log(
        `${target.brewery} / ${target.name} (count=${target.untappd_lookup_count})`,
      );
    }

    if (apply) {
      const count = applyRearm(db, targets);
      console.log(`Re-armed ${count} orphan(s).`);
    } else {
      console.log(
        `${targets.length} orphan(s) would be re-armed (dry-run; pass --apply to write).`,
      );
    }
  } finally {
    db.close();
  }
}
```

- [ ] **Step 3: Typecheck + full script tests**

Run: `npx tsc --noEmit && npx vitest run scripts/rearm-matcher-bug-orphans.test.ts`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 4: Smoke-test the CLI against a throwaway DB**

Run:
```bash
npx tsx -e '
import { openDb } from "./src/storage/db";
import { migrate } from "./src/storage/schema";
import { selectRearmTargetsByIds } from "./scripts/rearm-aliased-orphans";
const db = openDb(":memory:"); migrate(db);
db.prepare("INSERT INTO beers (untappd_id,name,brewery,normalized_name,normalized_brewery,untappd_lookup_count,rating_refresh_count) VALUES (NULL,?,?,?,?,3,0)").run("N","B","n","b");
console.log(JSON.stringify(selectRearmTargetsByIds(db, [1, 2])));
'
```
Expected: prints one target for id 1, nothing for id 2.

- [ ] **Step 5: Commit**

```bash
git add scripts/rearm-matcher-bug-orphans.ts
git commit -m "feat(ops): --ids exact-id mode for rearm-matcher-bug-orphans"
```

---

### Task 3: Document in `spec.md`

**Files:**
- Modify: `spec.md` (rearm runbook paragraph, ~line 1113)

- [ ] **Step 1: Extend the rearm runbook + add the arg-convention bullet**

After the sentence ending `…а `tsx` лишається runtime-залежністю після `npm prune --omit=dev`.`, append to that bullet:

```
Escape-hatch **`--ids <csv>`**: явно задані `beer_id` re-arm-яться напряму, минаючи фільтри `review_class`/`candidates_count` (єдина умова — рядок ще orphan, `untappd_id IS NULL`) — для zero-candidate класів (напр. #326 query-noise), які дефолтний фільтр `candidates_count > 0` пропускає; неіснуючі чи вже зматчені id пропускаються з попередженням.
```

Then add a new bullet immediately after it:

```
- **Ops-тули: конвенція аргументів.** Список `beer_id` передається через `--ids <csv>` (кома-розділений, пробіл після прапорця), запис вмикається `--apply` (dry-run за замовчуванням) — однаково для `rearm-matcher-bug-orphans` і `retire-resolved-orphans`.
```

- [ ] **Step 2: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document --ids exact-id rearm + ops-tool arg convention"
```

---

### Task 4: Final verification

- [ ] **Step 1: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS; typecheck clean.
