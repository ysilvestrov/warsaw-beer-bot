# Rating Fallback to Catalog `rating_global` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `/newbeers` or `/route` surfaces a tap whose `tap.u_rating` is NULL but the bot's catalog has a non-NULL `rating_global` for the matched beer, render that catalog rating instead of `⭐ —`. Fallback is transparent (both values are global Untappd ratings).

**Architecture:** New SQL helper `tapsForSnapshotWithBeer` does match + COALESCE in one query — replaces the per-tap `getMatch(...)` lookup in the two command files. `filterInteresting` and the rendering layer consume `u_rating` blindly, so the fallback applies to both display and the `min_rating` filter without further code changes. Pure read-time change; no schema migration, no write-time backfill.

**Tech Stack:** TypeScript, better-sqlite3, Jest. No new dependencies. No schema changes. Single feature branch `feat/rating-fallback`.

**Spec:** `docs/superpowers/specs/2026-04-30-rating-fallback-design.md`.

---

## File Structure

**Modified:**
```
src/storage/snapshots.ts             # add TapWithBeer + tapsForSnapshotWithBeer
src/storage/snapshots.test.ts        # 5 fallback tests
src/bot/commands/newbeers.ts         # call new helper, drop getMatch import
src/bot/commands/route.ts            # call new helper, drop getMatch import
docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md  # §14 lesson entry
```

**Untouched:** `src/domain/filters.ts` (consumes `u_rating` blindly), `src/bot/commands/newbeers-format.ts`, `src/bot/commands/route-format.ts` (rendering blind to source). Existing `tapsForSnapshot` stays — used by ingestion paths.

No schema migration. No env-var change. No dependency change.

---

## Branch setup

- [ ] **Step 1: Create the feature branch (worktree)**

```bash
cd /root/warsaw-beer-bot
git checkout main
git pull --ff-only
git worktree add .worktrees/feat-rating-fallback -b feat/rating-fallback main
cd .worktrees/feat-rating-fallback
npm install
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass (baseline ≥ 201 from PR #35).

---

## Task 1: Add `tapsForSnapshotWithBeer` helper (TDD)

**Files:**
- Modify: `src/storage/snapshots.ts`
- Modify: `src/storage/snapshots.test.ts`

The helper joins `taps`, `match_links`, and `beers`, COALESCing `tap.u_rating` over `beers.rating_global`, and surfaces the matched `beer_id` (which is `match_links.untappd_beer_id`).

`TapWithBeer` extends the existing `TapRow` and adds `beer_id`. Note: the `u_rating` field on a row of this type is **the COALESCEd value** — the SQL aliases its column to `u_rating`, so callers (including `filterInteresting`) see the fallback transparently.

- [ ] **Step 1: Append failing tests to `src/storage/snapshots.test.ts`**

First, extend the existing import line at the top of the file:

```ts
import { createSnapshot, latestSnapshot, insertTaps, tapsForSnapshot } from './snapshots';
```

becomes:

```ts
import { createSnapshot, latestSnapshot, insertTaps, tapsForSnapshot, tapsForSnapshotWithBeer } from './snapshots';
```

And add these two new imports below it:

```ts
import { upsertBeer } from './beers';
import { upsertMatch } from './match_links';
```

Then append at the bottom of the file (after the existing two tests):

```ts
function setupWithBeer() {
  const out = setup();
  const snapId = createSnapshot(out.db, out.pubId, '2026-05-01T12:00:00Z');
  return { ...out, snapId };
}

describe('tapsForSnapshotWithBeer', () => {
  test('tap with non-NULL u_rating and no match → keeps tap u_rating, beer_id null', () => {
    const { db, snapId } = setupWithBeer();
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Mystery Beer', brewery_ref: 'Anon', abv: 5, ibu: null, style: 'IPA', u_rating: 3.9 },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBe(3.9);
    expect(row.beer_id).toBeNull();
  });

  test('tap with NULL u_rating + matched beer carrying rating_global → fallback rating, beer_id set', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 100,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: 'AIPA',
      abv: 6.1,
      rating_global: 3.85,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA Atak Chmielu', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA', abv: 6.1, ibu: null, style: 'AIPA', u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBe(3.85);
    expect(row.beer_id).toBe(beerId);
  });

  test('tap with non-NULL u_rating + matched beer with different rating_global → COALESCE keeps tap u_rating', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 101,
      name: 'Buty Skejta',
      brewery: 'Stu Mostow',
      style: 'Pilsner',
      abv: 5.0,
      rating_global: 3.10,
      normalized_name: 'buty skejta',
      normalized_brewery: 'stu mostow',
    });
    upsertMatch(db, 'Stu Mostow Buty Skejta', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Stu Mostow Buty Skejta', brewery_ref: 'Stu Mostow', abv: 5.0, ibu: null, style: 'Pilsner', u_rating: 3.7 },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBe(3.7); // tap's value wins over catalog
    expect(row.beer_id).toBe(beerId);
  });

  test('tap with NULL u_rating + matched beer with NULL rating_global → NULL u_rating, beer_id set', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 102,
      name: 'New Release',
      brewery: 'New Brews',
      style: 'Lager',
      abv: 5.0,
      rating_global: null,
      normalized_name: 'new release',
      normalized_brewery: 'new brews',
    });
    upsertMatch(db, 'New Brews New Release', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'New Brews New Release', brewery_ref: 'New Brews', abv: 5.0, ibu: null, style: 'Lager', u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBeNull();
    expect(row.beer_id).toBe(beerId);
  });

  test('tap with no matching match_links row → NULL u_rating (when tap had it NULL), NULL beer_id', () => {
    const { db, snapId } = setupWithBeer();
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Unmatched', brewery_ref: 'Nobody', abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBeNull();
    expect(row.beer_id).toBeNull();
  });

  test('preserves ORDER BY tap_number', () => {
    const { db, snapId } = setupWithBeer();
    insertTaps(db, snapId, [
      { tap_number: 3, beer_ref: 'C', brewery_ref: 'X', abv: null, ibu: null, style: null, u_rating: null },
      { tap_number: 1, beer_ref: 'A', brewery_ref: 'X', abv: null, ibu: null, style: null, u_rating: null },
      { tap_number: 2, beer_ref: 'B', brewery_ref: 'X', abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const rows = tapsForSnapshotWithBeer(db, snapId);
    expect(rows.map((r) => r.beer_ref)).toEqual(['A', 'B', 'C']);
  });
});
```

- [ ] **Step 2: Run tests; expect compile-time failure**

```bash
npx jest src/storage/snapshots.test.ts
```

Expected: TS error `'"./snapshots"' has no exported member 'tapsForSnapshotWithBeer'`.

- [ ] **Step 3: Add the helper to `src/storage/snapshots.ts`**

Append at the bottom of the file (after `latestSnapshotsPerPub`):

```ts
export interface TapWithBeer extends TapRow {
  beer_id: number | null;
  // u_rating on this row is the COALESCEd value: tap.u_rating ?? beers.rating_global ?? null
}

export function tapsForSnapshotWithBeer(db: DB, snapshotId: number): TapWithBeer[] {
  return db.prepare(`
    SELECT
      t.id, t.snapshot_id, t.tap_number, t.beer_ref, t.brewery_ref,
      t.abv, t.ibu, t.style,
      COALESCE(t.u_rating, b.rating_global) AS u_rating,
      ml.untappd_beer_id AS beer_id
    FROM taps t
    LEFT JOIN match_links ml ON t.beer_ref = ml.ontap_ref
    LEFT JOIN beers b ON ml.untappd_beer_id = b.id
    WHERE t.snapshot_id = ?
    ORDER BY t.tap_number
  `).all(snapshotId) as TapWithBeer[];
}
```

Notes:
- Both `LEFT JOIN`s are required: an unmatched tap (no `match_links` row) still produces a result row with `beer_id = NULL`. The second `LEFT JOIN` covers the rare case where `match_links.untappd_beer_id` is NULL (manual review pending).
- Column order in the SELECT mirrors `tap` columns first, then the two synthesised values, so casting to `TapWithBeer` is straightforward.
- `COALESCE(t.u_rating, b.rating_global)` — if both are NULL, the COALESCE result is NULL. `b.rating_global` is naturally NULL when `b` is the no-match row (missing JOIN).

- [ ] **Step 4: Run tests; expect all pass**

```bash
npx jest src/storage/snapshots.test.ts
```

Expected: all 8 tests pass (existing 2 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/storage/snapshots.ts src/storage/snapshots.test.ts
git commit -m "feat(storage): tapsForSnapshotWithBeer joins match + COALESCEs rating_global"
```

---

## Task 2: Refactor `/newbeers` to use the new helper

**Files:**
- Modify: `src/bot/commands/newbeers.ts`

The per-tap `getMatch(...)` lookup becomes a single `tapsForSnapshotWithBeer` call. `TapWithBeer` already carries `beer_id`, `u_rating`, `beer_ref`, `brewery_ref`, `style`, `abv` — so it directly satisfies `filterInteresting`'s `TapView` requirement and the candidate-construction loop.

- [ ] **Step 1: Update imports**

Replace these two existing import lines in `src/bot/commands/newbeers.ts`:

```ts
import { latestSnapshotsPerPub, tapsForSnapshot } from '../../storage/snapshots';
```

```ts
import { getMatch } from '../../storage/match_links';
```

with the single line:

```ts
import { latestSnapshotsPerPub, tapsForSnapshotWithBeer } from '../../storage/snapshots';
```

(The `getMatch` import is dropped; it has no other call sites in this file.)

- [ ] **Step 2: Replace the per-tap mapping**

Replace the existing block in the for-loop (currently lines 36–43):

```ts
    const taps = tapsForSnapshot(db, snap.id).map((t) => ({
      beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
      style: t.style,
      abv: t.abv,
      u_rating: t.u_rating,
      beer_ref: t.beer_ref,
      brewery_ref: t.brewery_ref,
    }));
```

with the single line:

```ts
    const taps = tapsForSnapshotWithBeer(db, snap.id);
```

- [ ] **Step 3: Run typecheck + suite**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean (no `getMatch` reference left in this file). All tests pass (no test fixtures needed updates because there's no `newbeers.test.ts` for the command flow itself).

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/newbeers.ts
git commit -m "feat(newbeers): use tapsForSnapshotWithBeer for rating fallback"
```

---

## Task 3: Refactor `/route` to use the new helper

**Files:**
- Modify: `src/bot/commands/route.ts`

Symmetric to Task 2.

- [ ] **Step 1: Update imports**

Replace these two existing import lines in `src/bot/commands/route.ts`:

```ts
import { latestSnapshotsPerPub, tapsForSnapshot } from '../../storage/snapshots';
```

```ts
import { getMatch } from '../../storage/match_links';
```

with the single line:

```ts
import { latestSnapshotsPerPub, tapsForSnapshotWithBeer } from '../../storage/snapshots';
```

- [ ] **Step 2: Replace the per-tap mapping**

Replace the existing block (currently lines 59–66):

```ts
    const taps = tapsForSnapshot(db, snap.id).map((t) => ({
      beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
      style: t.style,
      abv: t.abv,
      u_rating: t.u_rating,
      beer_ref: t.beer_ref,
      brewery_ref: t.brewery_ref,
    }));
```

with:

```ts
    const taps = tapsForSnapshotWithBeer(db, snap.id);
```

- [ ] **Step 3: Run typecheck + suite**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/route.ts
git commit -m "feat(route): use tapsForSnapshotWithBeer for rating fallback"
```

---

## Task 4: Log the lesson in §14 of the canonical spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`

- [ ] **Step 1: Locate the insertion point**

```bash
grep -n "Polluted ontap-row cleanup\|Ці грабельки" docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
```

The new entry goes between the closing line of the polluted-ontap cleanup block (added in PR #35) and the `Ці грабельки …` paragraph.

- [ ] **Step 2: Insert the entry**

Insert immediately before `Ці грабельки — чек-лист на першу секунду нового деплою.`:

```markdown
- **Rating fallback (catalog → tap)**: `tap.u_rating` is the rating ontap.pl
  showed at scrape time; often NULL when ontap.pl hasn't matched the beer
  to Untappd. `tapsForSnapshotWithBeer` (`src/storage/snapshots.ts`) now
  COALESCEs into `beers.rating_global` from the matched catalog row,
  giving render and `min_rating` filter a usable rating in the ~2 % of
  rows where the catalog has one but the tap doesn't.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs(spec): log rating-fallback lesson in §14"
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
git push -u origin feat/rating-fallback
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head feat/rating-fallback \
  --title "feat(storage): rating fallback — taps coalesce u_rating over beers.rating_global" \
  --body "$(cat <<'EOF'
## Summary
Phase 3 of the post-PR-#30 rating + cleanup roadmap (PR #31). Final phase.
Spec: `docs/superpowers/specs/2026-04-30-rating-fallback-design.md`.

When `/newbeers` or `/route` surfaces a tap whose `tap.u_rating` is NULL but the catalog has a non-NULL `rating_global` for the matched beer, render the catalog rating instead of `⭐ —`.

- New helper `tapsForSnapshotWithBeer` joins `taps` ↔ `match_links` ↔ `beers` and `COALESCE(t.u_rating, b.rating_global) AS u_rating` in one SQL — replaces the per-tap `getMatch(...)` loop in both command files.
- Fallback is transparent: both values are global Untappd ratings (no asterisk, no dim star).
- `filterInteresting`'s `min_rating` threshold now applies to fallback values too — closes a current loophole where unmatched taps bypassed the filter even when the catalog had a rating.
- Pure read-time change. No schema migration. Snapshots stay raw (no write-time backfill of `taps.u_rating`).

## Test plan
- [x] `npx tsc --noEmit` — clean
- [x] `npx jest` — all tests pass (6 new cases on `tapsForSnapshotWithBeer`: tap-rating-only, fallback, COALESCE order, both-null, unmatched, ORDER BY)
- [ ] Post-deploy smoke (manual): in Telegram, run `/newbeers`. Confirm at least one row that previously showed `⭐ —` now shows a numeric rating sourced from `beers.rating_global`. Cross-check with `sqlite3 /var/lib/warsaw-beer-bot/bot.db "SELECT COUNT(*) FROM taps t JOIN match_links ml ON t.beer_ref = ml.ontap_ref JOIN beers b ON ml.untappd_beer_id = b.id WHERE t.u_rating IS NULL AND b.rating_global IS NOT NULL;"` — expect a non-zero count (the size of the fallback-eligible set).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 6: Post-deploy smoke (manual checklist — not a commit)

After merge + deploy:

- [ ] In Telegram, run `/newbeers` and `/route`. Visually confirm a couple of taps that used to show `⭐ —` now show a numeric rating.

- [ ] DB-level confirmation of fallback set size:
  ```bash
  ssh <prod> 'sqlite3 /var/lib/warsaw-beer-bot/bot.db "SELECT COUNT(*) FROM taps t JOIN match_links ml ON t.beer_ref = ml.ontap_ref JOIN beers b ON ml.untappd_beer_id = b.id WHERE t.u_rating IS NULL AND b.rating_global IS NOT NULL;"'
  ```
  Expected: non-zero (counts how many rendered rows benefit from the fallback in the latest snapshots).

- [ ] Filter sanity: set `/filters min_rating 4.0`, run `/newbeers`. Beers whose only rating source is the fallback `rating_global ≥ 4.0` should pass; previously they would have been excluded as `0 < 4.0`.

---

## Done criteria

Branch `feat/rating-fallback` is ready for PR when:
- Tasks 1–4 committed.
- `npx tsc --noEmit && npx jest` passes.
- PR opened against `main`.

After merge:
- Task 6 smoke checks performed.
