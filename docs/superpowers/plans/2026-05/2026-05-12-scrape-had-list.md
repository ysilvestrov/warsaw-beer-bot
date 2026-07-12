# Scrape-based had-list (PR-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop requiring `/import` for everyday `/newbeers` filtering by having the daily `refresh-untappd` job populate a per-user `untappd_had` table from the trailing-25 had-list scrape; `/newbeers` and `/route` then filter on `(checkins ∪ untappd_had)`.

**Architecture:** New SQLite table `untappd_had(telegram_id, beer_id, last_seen_at)` keyed `(telegram_id, beer_id)`. Storage module `src/storage/untappd_had.ts` exposes `markHad`, `hadBeerIds`, and `triedBeerIds` (union with `drunkBeerIds`). `refreshAllUntappd` calls `markHad` after each `upsertBeer`. `/newbeers` and `/route` swap their `drunkBeerIds` import for `triedBeerIds`; `filterInteresting`'s parameter is renamed `drunk → tried` for clarity. Append-only — rows are kept even when a beer falls out of the trailing-25 window.

**Tech Stack:** TypeScript, Jest, better-sqlite3 (`:memory:` for tests), pino logger. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-10-paren-alias-and-had-list.md` (PR-B section).

**Branch:** `feat/scrape-had-list` off `main` (currently at `f8b2c9d`, includes PR-A).

**Note on existing `/link` command:** The spec mentions `/setuser` in the USER-GUIDE update text, but the actual bot command is **`/link`** (see `src/bot/commands/link.ts`). USER-GUIDE wording in this plan uses `/link`.

---

## File Structure

- **Modify** `src/storage/schema.ts` — append migration v4 creating `untappd_had`.
- **Create** `src/storage/untappd_had.ts` — `markHad`, `hadBeerIds`, `triedBeerIds`.
- **Create** `src/storage/untappd_had.test.ts` — unit tests for those three.
- **Modify** `src/jobs/refresh-untappd.ts` — after each beer resolution, call `markHad(db, telegram_id, beer_id, isoNow)`.
- **Modify** `src/jobs/refresh-untappd.test.ts` — assert that scraped beers land in `untappd_had` for the right user.
- **Modify** `src/domain/filters.ts` — rename `drunk` parameter to `tried` (type unchanged).
- **Modify** `src/domain/filters.test.ts` — update parameter usage in existing tests.
- **Modify** `src/bot/commands/newbeers.ts` — swap `drunkBeerIds` → `triedBeerIds` import + call.
- **Modify** `src/bot/commands/route.ts` — same swap.
- **Modify** `docs/USER-GUIDE.md` — add scrape→had-list note near the `/link` and `/import` sections.
- **Modify** `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` — §10 bullet documenting the two-source drunk model.

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /root/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/scrape-had-list ../warsaw-beer-bot-had-list origin/main
cd ../warsaw-beer-bot-had-list
```

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exit 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: all suites pass.

---

## Task 2: Schema migration v4 (`untappd_had`)

**Files:**
- Modify: `src/storage/schema.ts` — append a `version: 4` entry to `MIGRATIONS`.
- Test: `src/storage/schema.test.ts` — add a single assertion that the new table exists.

- [ ] **Step 1: Write the failing test**

Add to the end of `src/storage/schema.test.ts` (inside the existing `describe`):

```typescript
  test('migration v4 creates untappd_had table', () => {
    const db = openDb(':memory:');
    migrate(db);
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='untappd_had'",
      )
      .get();
    expect(row).toEqual({ name: 'untappd_had' });
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_untappd_had_telegram'",
      )
      .get();
    expect(idx).toEqual({ name: 'idx_untappd_had_telegram' });
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --testPathPatterns=schema --silent`
Expected: FAIL — `Received: undefined`, no `untappd_had` table.

- [ ] **Step 3: Append migration v4**

In `src/storage/schema.ts`, find the closing `];` of the `MIGRATIONS` array. Just before that closing bracket, insert (after the `version: 3` entry's closing brace + comma):

```typescript
  {
    version: 4,
    sql: `
      CREATE TABLE untappd_had (
        telegram_id INTEGER NOT NULL,
        beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (telegram_id, beer_id)
      );
      CREATE INDEX idx_untappd_had_telegram ON untappd_had(telegram_id);
    `,
  },
```

- [ ] **Step 4: Run the test — it should pass now**

Run: `npm test -- --testPathPatterns=schema --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(schema): add untappd_had table (migration v4)

Append-only per-user mark of beers seen on the user's Untappd had-list
scrape. PRIMARY KEY (telegram_id, beer_id) makes upsert idempotent;
ON DELETE CASCADE on beer_id keeps it clean if a beer row is removed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Storage helpers — `markHad`, `hadBeerIds`, `triedBeerIds`

**Files:**
- Create: `src/storage/untappd_had.ts`
- Create: `src/storage/untappd_had.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/storage/untappd_had.test.ts`:

```typescript
import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { mergeCheckin } from './checkins';
import { markHad, hadBeerIds, triedBeerIds } from './untappd_had';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seedBeer(db: ReturnType<typeof fresh>, name: string): number {
  return upsertBeer(db, {
    untappd_id: null,
    name,
    brewery: 'Anon',
    style: null,
    abv: null,
    rating_global: null,
    normalized_name: name.toLowerCase(),
    normalized_brewery: 'anon',
  });
}

describe('markHad', () => {
  test('inserts a new (user, beer) pair', () => {
    const db = fresh();
    const beerId = seedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-05-12T10:00:00Z');

    const row = db
      .prepare('SELECT telegram_id, beer_id, last_seen_at FROM untappd_had')
      .get() as { telegram_id: number; beer_id: number; last_seen_at: string };
    expect(row).toEqual({
      telegram_id: 42,
      beer_id: beerId,
      last_seen_at: '2026-05-12T10:00:00Z',
    });
  });

  test('upserts: same pair twice updates last_seen_at, no duplicate row', () => {
    const db = fresh();
    const beerId = seedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-05-12T10:00:00Z');
    markHad(db, 42, beerId, '2026-05-12T11:00:00Z');

    const rows = db
      .prepare('SELECT last_seen_at FROM untappd_had WHERE telegram_id = ? AND beer_id = ?')
      .all(42, beerId) as { last_seen_at: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].last_seen_at).toBe('2026-05-12T11:00:00Z');
  });

  test('different users for same beer get separate rows', () => {
    const db = fresh();
    const beerId = seedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-05-12T10:00:00Z');
    markHad(db, 99, beerId, '2026-05-12T10:00:00Z');

    const count = (db.prepare('SELECT COUNT(*) AS c FROM untappd_had').get() as { c: number }).c;
    expect(count).toBe(2);
  });
});

describe('hadBeerIds', () => {
  test('returns empty set for user with no had rows', () => {
    const db = fresh();
    expect(hadBeerIds(db, 42)).toEqual(new Set());
  });

  test('returns just the beer_ids for the given user', () => {
    const db = fresh();
    const a = seedBeer(db, 'A');
    const b = seedBeer(db, 'B');
    const c = seedBeer(db, 'C');
    markHad(db, 42, a, '2026-05-12T10:00:00Z');
    markHad(db, 42, b, '2026-05-12T10:00:00Z');
    markHad(db, 99, c, '2026-05-12T10:00:00Z'); // other user

    expect(hadBeerIds(db, 42)).toEqual(new Set([a, b]));
    expect(hadBeerIds(db, 99)).toEqual(new Set([c]));
  });
});

describe('triedBeerIds', () => {
  test('returns union of drunkBeerIds and hadBeerIds', () => {
    const db = fresh();
    const checkedIn = seedBeer(db, 'Checked-in');
    const had = seedBeer(db, 'Had');
    const both = seedBeer(db, 'Both');

    // Checkin path
    mergeCheckin(db, {
      checkin_id: 'ci-1',
      telegram_id: 42,
      beer_id: checkedIn,
      user_rating: null,
      checkin_at: '2026-05-01T00:00:00Z',
      venue: null,
    });
    mergeCheckin(db, {
      checkin_id: 'ci-2',
      telegram_id: 42,
      beer_id: both,
      user_rating: null,
      checkin_at: '2026-05-01T00:00:00Z',
      venue: null,
    });
    // Had path
    markHad(db, 42, had, '2026-05-12T10:00:00Z');
    markHad(db, 42, both, '2026-05-12T10:00:00Z');

    expect(triedBeerIds(db, 42)).toEqual(new Set([checkedIn, had, both]));
  });

  test('does not leak across users', () => {
    const db = fresh();
    const a = seedBeer(db, 'A');
    const b = seedBeer(db, 'B');
    mergeCheckin(db, {
      checkin_id: 'ci-1',
      telegram_id: 42,
      beer_id: a,
      user_rating: null,
      checkin_at: '2026-05-01T00:00:00Z',
      venue: null,
    });
    markHad(db, 99, b, '2026-05-12T10:00:00Z');

    expect(triedBeerIds(db, 42)).toEqual(new Set([a]));
    expect(triedBeerIds(db, 99)).toEqual(new Set([b]));
  });
});
```

- [ ] **Step 2: Run the test file — confirm it fails on import**

Run: `npm test -- --testPathPatterns=untappd_had --silent`
Expected: FAIL — `Cannot find module './untappd_had'`.

- [ ] **Step 3: Create the implementation**

Create `src/storage/untappd_had.ts`:

```typescript
import type { DB } from './db';
import { drunkBeerIds } from './checkins';

export function markHad(
  db: DB,
  telegramId: number,
  beerId: number,
  at: string,
): void {
  db.prepare(
    `INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, beer_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at`,
  ).run(telegramId, beerId, at);
}

export function hadBeerIds(db: DB, telegramId: number): Set<number> {
  const rows = db
    .prepare('SELECT beer_id FROM untappd_had WHERE telegram_id = ?')
    .all(telegramId) as { beer_id: number }[];
  return new Set(rows.map((r) => r.beer_id));
}

export function triedBeerIds(db: DB, telegramId: number): Set<number> {
  const out = drunkBeerIds(db, telegramId);
  for (const id of hadBeerIds(db, telegramId)) out.add(id);
  return out;
}
```

- [ ] **Step 4: Run tests, confirm green**

Run: `npm test -- --testPathPatterns=untappd_had --silent`
Expected: all 8 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/storage/untappd_had.ts src/storage/untappd_had.test.ts
git commit -m "feat(storage): add markHad / hadBeerIds / triedBeerIds

triedBeerIds = drunkBeerIds ∪ hadBeerIds. Single helper that
/newbeers and /route will use to filter beers the user has
either checked in (manual /import) or seen on their Untappd
had-list (daily scrape).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Wire `refresh-untappd` to call `markHad`

**Files:**
- Modify: `src/jobs/refresh-untappd.ts`
- Modify: `src/jobs/refresh-untappd.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/jobs/refresh-untappd.test.ts`, add this test at the end of the `describe('refreshAllUntappd', ...)` block:

```typescript
  test('marks each scraped beer in untappd_had for that user', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const html = `
      ${PAGE_ONE_BEER(101, 'Atak Chmielu', 'Pinta', '4.12')}
      ${PAGE_ONE_BEER(202, 'Buty Skejta', 'Stu Mostow', '3.5')}`;
    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': html,
    });

    await refreshAllUntappd({ db, log: silentLog, http });

    const rows = db
      .prepare('SELECT telegram_id, beer_id FROM untappd_had ORDER BY beer_id')
      .all() as { telegram_id: number; beer_id: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.telegram_id === 1)).toBe(true);

    // beer_ids should be the actual catalog rows that were upserted.
    const atak = findBeerByNormalized(db, 'pinta', 'atak chmielu')!;
    const buty = findBeerByNormalized(db, 'stu mostow', 'buty skejta')!;
    expect(new Set(rows.map((r) => r.beer_id))).toEqual(new Set([atak.id, buty.id]));
  });
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- --testPathPatterns=refresh-untappd --silent`
Expected: FAIL — `Received length: 0` (untappd_had has no rows because `refreshAllUntappd` doesn't write to it yet).

- [ ] **Step 3: Wire `markHad` into the job**

In `src/jobs/refresh-untappd.ts`:

(a) Add the import at the top alongside the existing storage imports:

```typescript
import { markHad } from '../storage/untappd_had';
```

(b) Inside the `for (const it of items)` loop (currently lines 31-49), capture the resulting `beer_id` from both branches and call `markHad` after the if/else. Replace the loop body with:

```typescript
      for (const it of items) {
        const nb = normalizeBrewery(it.brewery_name);
        const nn = normalizeName(it.beer_name);
        const existing = findBeerByNormalized(db, nb, nn);
        let beerId: number;
        if (existing) {
          updateRatingOnly.run(it.global_rating, existing.id);
          beerId = existing.id;
        } else {
          beerId = upsertBeer(db, {
            untappd_id: it.bid,
            name: it.beer_name,
            brewery: it.brewery_name,
            style: it.style,
            abv: null,
            rating_global: it.global_rating,
            normalized_name: nn,
            normalized_brewery: nb,
          });
        }
        markHad(db, p.telegram_id, beerId, new Date().toISOString());
      }
```

- [ ] **Step 4: Run the test — it should pass**

Run: `npm test -- --testPathPatterns=refresh-untappd --silent`
Expected: PASS. All existing tests in the same file still pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
git commit -m "feat(refresh-untappd): mark scraped beers in untappd_had

Each beer surfaced by the /user/<X>/beers scrape (trailing-25 cap)
is now recorded in untappd_had for the scraped profile. Combined
with the existing rating_global refresh, the same scrape pass now
maintains a per-user 'has had this' index.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Rename `filterInteresting`'s `drunk` parameter to `tried`

**Files:**
- Modify: `src/domain/filters.ts:16-20`
- Modify: `src/domain/filters.test.ts` (rename any `drunk` argument names)

This is a pure rename — no behavior change. Done as its own commit so the next commit's diff is purely the call-site swap.

- [ ] **Step 1: Update `filters.ts`**

In `src/domain/filters.ts`, change line 16 from:

```typescript
  taps: T[], drunk: Set<number>, opts: FilterOpts,
```

to:

```typescript
  taps: T[], tried: Set<number>, opts: FilterOpts,
```

And change line 20 from:

```typescript
    if (drunk.has(t.beer_id)) return false;
```

to:

```typescript
    if (tried.has(t.beer_id)) return false;
```

- [ ] **Step 2: Update `filters.test.ts`**

Read `src/domain/filters.test.ts`. For every call that names a `Set<number>` as `drunk` and passes it as the second argument to `filterInteresting`, rename that local variable to `tried`. (If the tests use anonymous inline `new Set([...])` calls, leave them alone.)

- [ ] **Step 3: Run filter tests**

Run: `npm test -- --testPathPatterns=filters --silent`
Expected: all green. The call sites in `newbeers.ts` and `route.ts` still pass `drunk` positionally — argument names at call sites don't have to match parameter names in TypeScript, so this remains compilable until Task 6.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "refactor(filters): rename filterInteresting param 'drunk' -> 'tried'

The set is about to include both checkins and Untappd had-list marks,
not just check-ins. Pure rename — no behavior change.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Switch `/newbeers` and `/route` to `triedBeerIds`

**Files:**
- Modify: `src/bot/commands/newbeers.ts:4` (import) and `:20` (call site, local name)
- Modify: `src/bot/commands/route.ts:5` (import) and `:42` (call site, local name)

- [ ] **Step 1: Update `newbeers.ts`**

Change line 4 from:

```typescript
import { drunkBeerIds } from '../../storage/checkins';
```

to:

```typescript
import { triedBeerIds } from '../../storage/untappd_had';
```

Change line 20 from:

```typescript
  const drunk = drunkBeerIds(db, ctx.from.id);
```

to:

```typescript
  const tried = triedBeerIds(db, ctx.from.id);
```

Change line 36 from:

```typescript
    const good = filterInteresting(taps, drunk, filters);
```

to:

```typescript
    const good = filterInteresting(taps, tried, filters);
```

- [ ] **Step 2: Update `route.ts`**

Change line 5 from:

```typescript
import { drunkBeerIds } from '../../storage/checkins';
```

to:

```typescript
import { triedBeerIds } from '../../storage/untappd_had';
```

Change line 42 from:

```typescript
  const drunk = drunkBeerIds(db, ctx.from.id);
```

to:

```typescript
  const tried = triedBeerIds(db, ctx.from.id);
```

Change line 59 from:

```typescript
    const good = filterInteresting(taps, drunk, filters);
```

to:

```typescript
    const good = filterInteresting(taps, tried, filters);
```

- [ ] **Step 3: Run full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0. No test changes needed here — the call-site swap is mechanical and existing tests at the `filterInteresting` level still cover the path.

Note: `drunkBeerIds` in `src/storage/checkins.ts` is still used by `triedBeerIds` internally and remains exported. Do not remove it.

- [ ] **Step 4: Verify nothing else imports `drunkBeerIds`**

Run: `grep -rn "drunkBeerIds" src/ --include="*.ts"`
Expected: matches only in `src/storage/checkins.ts` (definition), `src/storage/untappd_had.ts` (the internal call inside `triedBeerIds`), and existing `src/storage/checkins.test.ts` (testing the export). No production-handler imports remain.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/newbeers.ts src/bot/commands/route.ts
git commit -m "feat(commands): /newbeers and /route filter on triedBeerIds

Replace the checkin-only drunkBeerIds with the union triedBeerIds
(checkins ∪ untappd_had). Beers seen on the user's Untappd had-list
scrape are now excluded from /newbeers and /route without requiring
a manual /import.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: USER-GUIDE update

**Files:**
- Modify: `docs/USER-GUIDE.md` — adjust the `/import` section to note that `/link` is now sufficient for daily use.

- [ ] **Step 1: Locate the `/import` section**

Open `docs/USER-GUIDE.md`. Find the `### /import` heading (around line 45) and the paragraph immediately under it that starts "Приймає експорт з Untappd для повного бекфілу історії…".

- [ ] **Step 2: Insert clarification immediately above the `### /import` heading**

Insert this block right BEFORE the `### /import` line:

```markdown
> **Чи треба робити `/import`?** Для повсякденного користування —
> ні. Як тільки ти зробив `/link <username>`, бот раз на добу
> підхоплює останні 25 пив зі сторінки `/user/<username>/beers`
> і виключає їх з `/newbeers` та `/route`. `/import` потрібен у
> двох випадках: (1) одноразовий бекфіл повної історії, (2) після
> фестивалю / турне, коли за день нових чекінів **більше ніж 25**
> (тоді скрейпер бачить лише top-25 і решта залишиться поза
> had-list, доки ти не імпортуєш свіжий експорт).

```

(Note: end the block with a blank line so the `### /import` heading is still surrounded by blank lines.)

- [ ] **Step 3: Also update the Quick Start bullet for `/import`**

Find the "Швидкий старт" block (around line 15-23). Replace this line:

```markdown
3. (опційно) `/import` — заллє повну історію з Untappd-експорту, краще ніж
   тільки публічна сторінка (там видно лише останні ~25 чекінів).
```

with:

```markdown
3. (опційно) `/import` — потрібен лише для бекфілу повної історії або
   після фестивалів, коли за день > 25 чекінів. Інакше щоденного
   скрейпу `/user/<username>/beers` достатньо — бот сам мітить ці пива
   як випиті.
```

- [ ] **Step 4: Commit**

```bash
git add docs/USER-GUIDE.md
git commit -m "docs(user-guide): clarify /link is sufficient for daily use

After PR-B, the daily refresh-untappd scrape populates untappd_had,
so /newbeers excludes scraped beers without manual /import. /import
remains useful for backfill and festival catch-up beyond the
trailing-25 cap.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Master spec §10 footgun bullet (two-source drunk model)

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` — insert into the §10 footgun list immediately after the Paren-form bullet (added by PR-A) and before the closing `Ці грабельки — чек-лист на першу секунду нового деплою.` line.

- [ ] **Step 1: Read the file to find the exact insertion point**

The paren-form bullet from PR-A is now around lines 426-434. The closing sentence "Ці грабельки — чек-лист на першу секунду нового деплою." is just below it. Read those lines to confirm before editing.

- [ ] **Step 2: Insert the new bullet immediately after the paren-form bullet**

Append exactly this between the end of the paren-form bullet (line ending with "...sweeps both forms on boot).") and the closing sentence:

```markdown
- **Two-source drunk model**: A beer is filtered from `/newbeers` and
  `/route` if it appears in EITHER `checkins` (manual `/import` bulk
  and post-festival catch-up) OR `untappd_had` (per-user trailing-25
  incremental scrape, populated by `refreshAllUntappd` via
  `markHad`). Reading only `checkins` forces users into a constant
  re-import loop just to keep `/newbeers` accurate; `triedBeerIds`
  (`src/storage/untappd_had.ts`) is the single union helper handlers
  consume. Caught 2026-05-10 — `/newbeers` showed *Stadt Land Bier*
  because the scrape rewrote `beers.rating_global` but never marked
  the user as having had it.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs(spec): document two-source drunk model in §10 footguns

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Verification before push

**Files:** none.

- [ ] **Step 1: Final full suite**

Run: `npm test -- --silent`
Expected: every test passes. ≥222 tests (baseline 214 + 8 new from this branch).

- [ ] **Step 2: Final typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline main..HEAD`
Expected: 7 commits in order — schema migration, storage helpers, refresh-untappd wiring, filters rename, command swap, USER-GUIDE, spec §10.

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff main...HEAD --stat`
Expected files (11):
- `src/storage/schema.ts`
- `src/storage/schema.test.ts`
- `src/storage/untappd_had.ts`
- `src/storage/untappd_had.test.ts`
- `src/jobs/refresh-untappd.ts`
- `src/jobs/refresh-untappd.test.ts`
- `src/domain/filters.ts`
- `src/domain/filters.test.ts`
- `src/bot/commands/newbeers.ts`
- `src/bot/commands/route.ts`
- `docs/USER-GUIDE.md`
- `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`

No stray edits outside this set.

---

## Task 10: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/scrape-had-list
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: scrape-based Untappd had-list (PR-B)" --body "$(cat <<'EOF'
## Summary
- Add `untappd_had(telegram_id, beer_id, last_seen_at)` table (migration v4) plus storage helpers `markHad`, `hadBeerIds`, `triedBeerIds`.
- Wire `refreshAllUntappd` to call `markHad` for every beer it surfaces from `/user/<X>/beers`, scoped to the scraped profile.
- Replace `drunkBeerIds` with `triedBeerIds` in `/newbeers` and `/route`; rename `filterInteresting`'s `drunk` parameter to `tried`.
- USER-GUIDE: clarify `/import` is no longer required for daily use.
- Master spec §10: document the two-source drunk model.

Implements PR-B from `docs/superpowers/specs/2026-05-10-paren-alias-and-had-list.md`. PR-A (paren-alias dedup, #39) shipped on 2026-05-12.

## Test plan
- [x] `npm test` green locally (≥222 / 222)
- [x] `npm run typecheck` clean
- [ ] After merge + deploy: within 24h, `SELECT COUNT(*) FROM untappd_had` > 0 for the active user
- [ ] After merge + deploy: re-issue `/newbeers`; beers that appear in the user's Untappd `/user/<X>/beers` top-25 are absent from output, even without re-running `/import`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges; deployment smoke happens after merge.

---

## What this plan does NOT cover

- Backfill of `untappd_had` for users whose data was scraped before this PR landed — they'll be populated organically on the next 24h cycle. No batch migration job.
- Increasing the 25-item scrape cap (would require authenticated scraping — out of scope per spec).
- Pruning `untappd_had` when a beer falls out of the trailing-25 window — by design, the table is append-only (rows are valuable history regardless of current visibility on Untappd's page).
- Worktree teardown — done after PR merges.
