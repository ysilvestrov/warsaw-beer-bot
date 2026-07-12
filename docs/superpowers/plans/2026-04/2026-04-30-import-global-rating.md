# Capture `global_weighted_rating_score` From Untappd Imports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read `global_weighted_rating_score` from Untappd JSON / CSV exports into `beers.rating_global` so a one-shot user re-import backfills ~6 000 catalog rows that today have NULL global rating.

**Architecture:** Pure ingestion change. Add an optional field to the `Checkin` interface, read it in both `mapCsv` and `mapJson`, pass it through `/import`'s `upsertBeer` call. `upsertBeer`'s existing UPDATE branch (`src/storage/beers.ts:24`) already updates `rating_global` on existing rows, so re-running `/import` on an unchanged export naturally backfills.

**Tech Stack:** TypeScript, csv-parse, stream-json, better-sqlite3, Jest, Telegraf 4.x. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-30-import-global-rating-design.md`.

---

## File Structure

**Modified files:**
```
src/sources/untappd/export.ts        # interface field + read in two mappers
src/sources/untappd/export.test.ts   # assertions for the new field
src/bot/commands/import.ts           # pass-through to upsertBeer
tests/fixtures/untappd/export.csv    # add global_weighted_rating_score column
tests/fixtures/untappd/export.json   # add global_weighted_rating_score key
docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md  # §14 lesson entry
```

**No new files.** No schema changes. No new dependencies.

---

## Task 1: Capture `global_rating` in the export parser

**Files:**
- Modify: `src/sources/untappd/export.ts`
- Modify: `src/sources/untappd/export.test.ts`
- Modify: `tests/fixtures/untappd/export.csv`
- Modify: `tests/fixtures/untappd/export.json`

The parser today reads only `rating_score` (user's personal rating). We add `global_rating: number | null` sourced from `global_weighted_rating_score` — Untappd's publicly displayed weighted community rating. Defensive: if the field is absent (older export formats), `numOrNull` returns `null`.

- [ ] **Step 1: Update fixtures with `global_weighted_rating_score`**

Replace `tests/fixtures/untappd/export.csv` with (one extra column at end):

```csv
beer_name,brewery_name,beer_type,beer_abv,rating_score,created_at,venue_name,checkin_id,bid,global_weighted_rating_score
Atak Chmielu,Pinta,American IPA,6.1,4.25,2024-03-01 20:12:00,Beer & Bones,1234,567,3.85
Buty Skejta,Stu Mostow,Pilsner,5.0,3.75,2024-03-10 19:55:00,,2345,890,
```

The trailing empty cell on row 2 verifies that an absent / blank value parses to `null`.

Replace `tests/fixtures/untappd/export.json` with:

```json
[
  {
    "beer_name": "Atak Chmielu",
    "brewery_name": "Pinta",
    "beer_type": "American IPA",
    "beer_abv": 6.1,
    "rating_score": 4.25,
    "global_weighted_rating_score": 3.85,
    "created_at": "2024-03-01 20:12:00",
    "venue_name": "Beer & Bones",
    "checkin_id": 1234,
    "bid": 567
  },
  {
    "beer_name": "Buty Skejta",
    "brewery_name": "Stu Mostow",
    "beer_type": "Pilsner",
    "beer_abv": 5.0,
    "rating_score": 3.75,
    "created_at": "2024-03-10 19:55:00",
    "venue_name": "",
    "checkin_id": 2345,
    "bid": 890
  }
]
```

(Row 2 omits `global_weighted_rating_score` entirely, exercising the JSON missing-key branch.)

The ZIP fixture (`export.zip`) wraps the JSON internally — re-zip it after editing the JSON. From the repo root:

```bash
cd tests/fixtures/untappd
zip -j export.zip export.json
```

Verify: `unzip -p tests/fixtures/untappd/export.zip | head -3` should show the new JSON content.

- [ ] **Step 2: Write failing tests**

Append to `src/sources/untappd/export.test.ts`:

```ts
test('captures global_weighted_rating_score from CSV', async () => {
  const rows = await collect('csv', fx('export.csv'));
  expect(rows[0].global_rating).toBe(3.85);
  expect(rows[1].global_rating).toBeNull();
});

test('captures global_weighted_rating_score from JSON', async () => {
  const rows = await collect('json', fx('export.json'));
  expect(rows[0].global_rating).toBe(3.85);
  expect(rows[1].global_rating).toBeNull();
});
```

- [ ] **Step 3: Run tests and verify they fail**

```bash
npx jest src/sources/untappd/export.test.ts
```

Expected: the two new cases fail. `Property 'global_rating' does not exist on type 'Checkin'` (TS error) or `expect(rows[0].global_rating).toBe(3.85)` → `undefined` (runtime).

- [ ] **Step 4: Add the field to the `Checkin` interface and both mappers**

Edit `src/sources/untappd/export.ts`:

In the `Checkin` interface, append `global_rating: number | null;`:

```ts
export interface Checkin {
  checkin_id: string;
  bid: number | null;
  beer_name: string;
  brewery_name: string;
  beer_type: string | null;
  beer_abv: number | null;
  rating_score: number | null;
  global_rating: number | null;
  created_at: string;
  venue_name: string | null;
}
```

In `mapCsv`, add `global_rating: numOrNull(r['global_weighted_rating_score'])` before the closing brace:

```ts
function mapCsv(r: Record<string, string>): Checkin {
  return {
    checkin_id: r['checkin_id'],
    bid: numOrNull(r['bid']),
    beer_name: r['beer_name'],
    brewery_name: r['brewery_name'],
    beer_type: blankNull(r['beer_type']),
    beer_abv: numOrNull(r['beer_abv']),
    rating_score: numOrNull(r['rating_score']),
    global_rating: numOrNull(r['global_weighted_rating_score']),
    created_at: r['created_at'],
    venue_name: blankNull(r['venue_name']),
  };
}
```

Same change in `mapJson`:

```ts
function mapJson(r: Record<string, unknown>): Checkin {
  return {
    checkin_id: String(r['checkin_id']),
    bid: numOrNull(r['bid']),
    beer_name: String(r['beer_name'] ?? ''),
    brewery_name: String(r['brewery_name'] ?? ''),
    beer_type: blankNull(r['beer_type']),
    beer_abv: numOrNull(r['beer_abv']),
    rating_score: numOrNull(r['rating_score']),
    global_rating: numOrNull(r['global_weighted_rating_score']),
    created_at: String(r['created_at'] ?? ''),
    venue_name: blankNull(r['venue_name']),
  };
}
```

`numOrNull` already coerces `undefined` (missing JSON key) and `''` (empty CSV cell) to `null`, so no extra defensive code is needed.

- [ ] **Step 5: Run tests and verify they pass**

```bash
npx jest src/sources/untappd/export.test.ts
```

Expected: all tests pass (4 existing + 2 new = 6).

- [ ] **Step 6: Run full suite + typecheck**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean. Full Jest suite passes. (Existing import.ts call site at line 64 still compiles — `Checkin` gained a field but no consumer broke.)

- [ ] **Step 7: Commit**

```bash
git add src/sources/untappd/export.ts \
        src/sources/untappd/export.test.ts \
        tests/fixtures/untappd/export.csv \
        tests/fixtures/untappd/export.json \
        tests/fixtures/untappd/export.zip
git commit -m "feat(import): capture global_weighted_rating_score from Untappd export"
```

---

## Task 2: Wire `global_rating` through `/import` to `beers.rating_global`

**Files:**
- Modify: `src/bot/commands/import.ts:64`

`upsertBeer` already accepts `rating_global`. Today the import call site hard-codes `null`. Pass through the value the parser captured.

- [ ] **Step 1: Replace `rating_global: null` with the parsed value**

Edit `src/bot/commands/import.ts`. The current snippet at line 64:

```ts
const beerId = upsertBeer(db, {
  untappd_id: r.bid ?? null,
  name: r.beer_name,
  brewery: r.brewery_name,
  style: r.beer_type,
  abv: r.beer_abv,
  rating_global: null,
  normalized_name: normalizeName(r.beer_name),
  normalized_brewery: normalizeBrewery(r.brewery_name),
});
```

Replace `rating_global: null` with `rating_global: r.global_rating`:

```ts
const beerId = upsertBeer(db, {
  untappd_id: r.bid ?? null,
  name: r.beer_name,
  brewery: r.brewery_name,
  style: r.beer_type,
  abv: r.beer_abv,
  rating_global: r.global_rating,
  normalized_name: normalizeName(r.beer_name),
  normalized_brewery: normalizeBrewery(r.brewery_name),
});
```

- [ ] **Step 2: Run typecheck + full Jest suite**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass. No test changes needed for this step — coverage comes from Task 1's parser tests; the wiring is one field assignment with no branching.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/import.ts
git commit -m "feat(import): pass global_rating to beers.rating_global"
```

---

## Task 3: Log the lesson in §14 of the canonical spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`

Append after the brewery-alias dedup entry (the last `- **...**` block before `Ці грабельки — чек-лист на першу секунду нового деплою.`).

- [ ] **Step 1: Append the lesson entry**

Find the closing line of the brewery-alias dedup entry:

```
  beer name) are out of scope for this fix — separate cleanup task.

Ці грабельки — чек-лист на першу секунду нового деплою.
```

Insert this block between them:

```markdown
- **Untappd `global_weighted_rating_score`**: the public "rating" Untappd
  shows on every beer page. JSON / CSV exports include it on every row.
  Read into `beers.rating_global` at `/import` time
  (`src/sources/untappd/export.ts` + `src/bot/commands/import.ts`).
  Re-importing the same export backfills `rating_global` for existing
  rows via `upsertBeer`'s UPDATE branch — no migration needed. The
  legacy `refresh-untappd` job stored the user's *personal* rating in
  this field; that misuse goes away when the job is rewritten in the
  next phase.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs(spec): log global_weighted_rating_score lesson in §14"
```

---

## Task 4: Open the PR

This is a wrap-up step, not a code change.

- [ ] **Step 1: Verify all green locally**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/import-global-rating
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head feat/import-global-rating \
  --title "feat(import): capture global_weighted_rating_score from Untappd export" \
  --body "$(cat <<'EOF'
## Summary
Phase 0 of the post-PR-#30 rating + cleanup roadmap (PR #31).
Spec: \`docs/superpowers/specs/2026-04-30-import-global-rating-design.md\`.

- Read \`global_weighted_rating_score\` (Untappd's public weighted community rating) from CSV / JSON / ZIP exports.
- Pipe it through \`/import\` into \`beers.rating_global\` (was hard-coded \`null\`).
- \`upsertBeer\`'s UPDATE branch backfills the field on existing rows — re-running \`/import\` on the same export populates \`rating_global\` on ~6 000 historical rows in seconds.

No schema change, no migration. Defensive against missing field (older / free-tier exports).

## Test plan
- [x] \`npx tsc --noEmit\` — clean
- [x] \`npx jest\` — all tests pass (existing + 2 new for CSV / JSON \`global_rating\` capture)
- [ ] Post-deploy smoke (manual): re-run \`/import\` on existing JSON export. Confirm via SQL that \`SELECT COUNT(*) FROM beers WHERE rating_global IS NOT NULL\` jumps from 232 to several thousand.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 5: Post-deploy smoke (manual checklist — not a commit)

After merge + deploy:

- [ ] In Telegram, run `/import` with the existing Untappd JSON export.
- [ ] On the host, verify the backfill:
  ```bash
  node -e "const db = require('better-sqlite3')('/var/lib/warsaw-beer-bot/bot.db', {readonly: true}); console.log(db.prepare('SELECT COUNT(*) AS n FROM beers WHERE rating_global IS NOT NULL').get());"
  ```
  Expected: a result well above the pre-deploy baseline of 232 (likely several thousand).
- [ ] Spot-check a known beer:
  ```bash
  node -e "const db = require('better-sqlite3')('/var/lib/warsaw-beer-bot/bot.db', {readonly: true}); console.log(db.prepare(\"SELECT id, name, rating_global FROM beers WHERE name = 'Mons Pius Dark (Dunkel)' AND brewery = 'Mons Pius' LIMIT 1\").get());"
  ```
  Expected: `rating_global ≈ 3.69` (Untappd weighted global at time of writing).

---

## Done criteria

Branch `feat/import-global-rating` is ready for PR when:
- Tasks 1–3 committed.
- `npx tsc --noEmit && npx jest` passes.
- PR opened against `main`.

After merge:
- Task 5 smoke checks performed.
