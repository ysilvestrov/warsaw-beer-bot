# Paren-alias dedup (PR-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend brewery alias matching to handle parenthesized German aliases ("X (Y)") parallel to the existing slash form, and let the startup dedupe job collapse the duplicates this gap left in the catalog.

**Architecture:** Rename `brewerySlashAliases` → `breweryAliases` in `src/domain/matcher.ts` and broaden its return to include both `/`-split halves and `(...)`-split inner/outer segments. Extend `dedupeBreweryAliases`' SQL candidate filter to also match `LIKE '%(%' AND LIKE '%)%'`. No schema changes, no new tables. The same alias-overlap check carries through both consumers.

**Tech Stack:** TypeScript, Jest, better-sqlite3 (`:memory:` for tests), pino logger. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-10-paren-alias-and-had-list.md` (PR-A section).

**Branch:** `feat/paren-alias-dedup` off `main`.

---

## File Structure

- **Modify** `src/domain/matcher.ts` — rename `brewerySlashAliases` to `breweryAliases`, extend logic to handle `X (Y)` form; update all call sites in this file.
- **Modify** `src/domain/matcher.test.ts` — add tests for the paren-alias form (plain `X`, `X / Y`, `X (Y)`, mixed `X / Y (Z)`).
- **Modify** `src/jobs/dedupe-brewery-aliases.ts` — update import to new name, extend SQL `WHERE` clause to include paren-form candidates.
- **Modify** `src/jobs/dedupe-brewery-aliases.test.ts` — add test that paren-form duplicate pair (Kemker case) is merged.
- **Modify** `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` — add §10 bullet documenting paren-alias matching as a known footgun.

---

## Task 1: Worktree + branch setup

**Files:** none yet — workspace prep only.

- [ ] **Step 1: Create isolated worktree off main**

Run:
```bash
cd /root/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/paren-alias-dedup ../warsaw-beer-bot-paren-alias origin/main
cd ../warsaw-beer-bot-paren-alias
```

Expected: new worktree at `../warsaw-beer-bot-paren-alias` on branch `feat/paren-alias-dedup`.

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exits 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: all tests pass. Confirms baseline before edits.

---

## Task 2: TDD — failing test for `breweryAliases` paren form

**Files:**
- Modify: `src/domain/matcher.test.ts` (add tests above existing block)

- [ ] **Step 1: Add failing tests for `breweryAliases`**

At the top of `src/domain/matcher.test.ts`, change the import line:

```typescript
import { matchBeer, breweryAliases, type CatalogBeer } from './matcher';
```

Then add this `describe` block immediately after the imports and `c` factory (before the existing top-level `test('exact normalized match...')`):

```typescript
describe('breweryAliases', () => {
  test('plain brewery returns one alias', () => {
    expect(breweryAliases('Pinta')).toEqual(['pinta']);
  });

  test('drops noise words consistent with normalizeBrewery', () => {
    expect(breweryAliases('Piwne Podziemie Brewery')).toEqual(['piwne podziemie']);
  });

  test('slash form returns full + each half', () => {
    const out = breweryAliases('Piwne Podziemie / Beer Underground');
    expect(new Set(out)).toEqual(
      new Set(['piwne podziemie beer underground', 'piwne podziemie', 'beer underground']),
    );
  });

  test('paren form returns full + outer + inner', () => {
    const out = breweryAliases('Kemker Kultuur (Brauerei J. Kemker)');
    expect(new Set(out)).toEqual(
      new Set([
        'kemker kultuur brauerei j kemker',
        'kemker kultuur',
        'brauerei j kemker',
      ]),
    );
  });

  test('mixed slash + paren splits on both', () => {
    const out = breweryAliases('AleBrowar / Kemker Kultuur (Brauerei J. Kemker)');
    expect(out).toContain('alebrowar');
    expect(out).toContain('kemker kultuur');
    expect(out).toContain('brauerei j kemker');
  });

  test('empty input returns empty array', () => {
    expect(breweryAliases('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `npm test -- --testPathPattern=matcher --silent`
Expected: import error / "breweryAliases is not a function" — the symbol doesn't exist yet. Existing `matcher.test.ts` tests should still attempt to run (the file-level import failure will fail every test in the file; that is OK and expected for this red phase).

---

## Task 3: Implement `breweryAliases`

**Files:**
- Modify: `src/domain/matcher.ts:26-32` (rename + replace body)

- [ ] **Step 1: Replace `brewerySlashAliases` with `breweryAliases`**

In `src/domain/matcher.ts`, replace the existing function and the comment block immediately preceding it (lines 20-32) with:

```typescript
// Untappd records breweries either as a single name ("Piwne Podziemie Brewery"),
// as an "X / Y" alias used for bilingual ("Piwne Podziemie / Beer Underground")
// or collaboration ("AleBrowar / Poppels Bryggeri") pairs, or as an "X (Y)"
// form for German aliases ("Kemker Kultuur (Brauerei J. Kemker)").
// Ontap.pl renders only one of these. For matching purposes all three forms
// collapse to: "any side of the separator is a valid brewery for this beer".
export function breweryAliases(brewery: string): string[] {
  const aliases = new Set<string>();
  const full = normalizeBrewery(brewery);
  if (full) aliases.add(full);

  const slashParts = brewery.includes(' / ') ? brewery.split(' / ') : [brewery];
  for (const part of slashParts) {
    const parenMatch = part.match(/^(.+?)\s*\((.+)\)\s*$/);
    if (parenMatch) {
      const outer = normalizeBrewery(parenMatch[1]);
      const inner = normalizeBrewery(parenMatch[2]);
      if (outer) aliases.add(outer);
      if (inner) aliases.add(inner);
    } else {
      const norm = normalizeBrewery(part);
      if (norm) aliases.add(norm);
    }
  }

  return Array.from(aliases);
}
```

- [ ] **Step 2: Update call sites in matcher.ts**

In the same file, replace every occurrence of `brewerySlashAliases` with `breweryAliases`. The current call sites (per `grep -n 'brewerySlashAliases'`) are lines 42, 50, 69, and a comment reference on line 78. Use `replace_all` on the symbol; then in the line-78 comment update the wording from "appears at index 0 of brewerySlashAliases" to "appears at index 0 of breweryAliases".

- [ ] **Step 3: Run the `breweryAliases` tests**

Run: `npm test -- --testPathPattern=matcher --silent`
Expected: all `breweryAliases` tests pass; the existing `matchBeer` tests still pass (they exercise the same path through the renamed function).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. If the dedupe job still imports the old name it will error here — that's fixed in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): extend breweryAliases to handle X (Y) paren form"
```

(Typecheck failure on `dedupe-brewery-aliases.ts` import is expected until Task 4; do NOT amend or skip the commit.)

---

## Task 4: Update dedupe job import

**Files:**
- Modify: `src/jobs/dedupe-brewery-aliases.ts:3` (import) and `:42` (call site)

- [ ] **Step 1: Update import + call site**

In `src/jobs/dedupe-brewery-aliases.ts`, change line 3 from:

```typescript
import { brewerySlashAliases } from '../domain/matcher';
```

to:

```typescript
import { breweryAliases } from '../domain/matcher';
```

And on line 42, change:

```typescript
    const aliases = new Set(brewerySlashAliases(c.canonical_brewery));
```

to:

```typescript
    const aliases = new Set(breweryAliases(c.canonical_brewery));
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Run dedupe tests (paren handling not yet wired through SQL — slash tests must still pass)**

Run: `npm test -- --testPathPattern=dedupe-brewery-aliases --silent`
Expected: all existing tests still pass. The job behaves identically for slash-form input because the SQL filter hasn't changed yet.

---

## Task 5: TDD — failing test for paren-form dedup

**Files:**
- Modify: `src/jobs/dedupe-brewery-aliases.test.ts` (add new test)

- [ ] **Step 1: Add failing test for the Kemker case**

Read the bottom of `src/jobs/dedupe-brewery-aliases.test.ts` to find where to insert. Add the following test inside the existing `describe('dedupeBreweryAliases', ...)` block, after the last existing `test(...)`:

```typescript
  test('merges paren-form alias pair (Kemker Kultuur case)', () => {
    const db = fresh();
    // Canonical Untappd-side row — brewery in "X (Y)" form.
    const aId = upsertBeer(db, {
      untappd_id: 2133795,
      name: 'Stadt Land Bier',
      brewery: 'Kemker Kultuur (Brauerei J. Kemker)',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'stadt land bier',
      normalized_brewery: 'kemker kultuur brauerei j kemker',
    });
    // Orphan ontap-side row — normalized brewery matches one alias half.
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Stadt Land Bier',
      brewery: 'Kemker Kultuur Brewery',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'stadt land bier',
      normalized_brewery: 'kemker kultuur',
    });
    upsertMatch(db, 'Stadt Land Bier', bId, 1.0);
    ensureProfile(db, 42);
    mergeCheckin(db, {
      checkin_id: 'kemker-1',
      telegram_id: 42,
      beer_id: bId,
      user_rating: 4.5,
      checkin_at: '2026-05-10T12:00:00Z',
      venue: null,
    });

    const result = dedupeBreweryAliases(db, silentLog);

    expect(result).toEqual({ pairsMerged: 1, beersDeleted: 1 });
    // Orphan deleted.
    const orphan = db.prepare('SELECT id FROM beers WHERE id = ?').get(bId);
    expect(orphan).toBeUndefined();
    // Canonical survives.
    const canonical = db.prepare('SELECT id FROM beers WHERE id = ?').get(aId);
    expect(canonical).toEqual({ id: aId });
    // match_link transferred to canonical.
    const link = db
      .prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Stadt Land Bier') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(aId);
    // Checkin re-pointed to canonical.
    const checkin = db
      .prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?')
      .get('kemker-1') as { beer_id: number };
    expect(checkin.beer_id).toBe(aId);
  });
```

- [ ] **Step 2: Run and confirm the new test fails**

Run: `npm test -- --testPathPattern=dedupe-brewery-aliases --silent`
Expected: the new "paren-form alias pair" test fails because the SQL filter `WHERE a.brewery LIKE '% / %'` excludes the canonical row (no slash in its brewery name). All other tests still pass.

---

## Task 6: Extend dedupe SQL candidate filter

**Files:**
- Modify: `src/jobs/dedupe-brewery-aliases.ts:33` (the `WHERE` clause)

- [ ] **Step 1: Broaden the `WHERE` clause**

In `src/jobs/dedupe-brewery-aliases.ts`, locate the SELECT statement (around lines 21-35). Change the filter line from:

```typescript
         AND a.brewery LIKE '% / %'
```

to:

```typescript
         AND (a.brewery LIKE '% / %'
              OR (a.brewery LIKE '%(%' AND a.brewery LIKE '%)%'))
```

The outer parentheses keep the OR scoped under the preceding `AND a.untappd_id IS NOT NULL AND b.untappd_id IS NULL` conditions.

- [ ] **Step 2: Run the dedupe test suite**

Run: `npm test -- --testPathPattern=dedupe-brewery-aliases --silent`
Expected: all tests pass, including the new Kemker case. The existing Piwne-Podziemie slash test still passes (the new OR-branch is additive).

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test -- --silent`
Then: `npm run typecheck`
Expected: both exit 0. No unrelated regressions.

- [ ] **Step 4: Commit**

```bash
git add src/jobs/dedupe-brewery-aliases.ts src/jobs/dedupe-brewery-aliases.test.ts
git commit -m "feat(dedupe): merge paren-form brewery alias duplicates at startup"
```

---

## Task 7: Update master spec §10 (footgun list)

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`

- [ ] **Step 1: Locate the §10 list**

Open `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` and find the bullet list under the "Грабельки що ми вже наступили" heading (per prior `grep`, around lines 395-426 — verify with a Read before editing). The last bullet today is **Rating fallback (catalog → tap)** ending with the line that says "...the ~2 % of rows where the catalog has one but the tap doesn't."

- [ ] **Step 2: Insert the new bullet immediately after the rating-fallback bullet, before the closing line `Ці грабельки — чек-лист на першу секунду нового деплою.`**

Append exactly:

```markdown
- **Paren-form brewery aliases**: Untappd renders some breweries with a
  parenthesized German alias — "Kemker Kultuur (Brauerei J. Kemker)" —
  parallel to the "X / Y" bilingual/collab form. `breweryAliases`
  (`src/domain/matcher.ts`) splits BOTH forms so that either side counts
  as a valid brewery for the beer. Missing the paren form let
  ontap-side rows fail to find their Untappd canonical and create
  duplicates (caught 2026-05-10 via duplicated `beers#12061/12093`
  for *Stadt Land Bier*; startup `dedupeBreweryAliases` now sweeps both
  forms on boot).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs(spec): document paren-form brewery aliases in §10 footguns"
```

---

## Task 8: Verification before push

**Files:** none — final checks only.

- [ ] **Step 1: Final full suite**

Run: `npm test -- --silent`
Expected: every test passes.

- [ ] **Step 2: Final typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline main..HEAD`
Expected: three commits in order — matcher rename/extend, dedupe SQL change, spec §10 update.

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff main...HEAD --stat`
Expected: five files touched — `src/domain/matcher.ts`, `src/domain/matcher.test.ts`, `src/jobs/dedupe-brewery-aliases.ts`, `src/jobs/dedupe-brewery-aliases.test.ts`, `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`. No stray edits.

---

## Task 9: Push + open PR

**Files:** none — GitHub interaction.

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feat/paren-alias-dedup`
Expected: branch published to origin.

- [ ] **Step 2: Open PR via gh**

Run:
```bash
gh pr create --title "feat: paren-alias brewery dedup (PR-A)" --body "$(cat <<'EOF'
## Summary
- Extend `breweryAliases` (renamed from `brewerySlashAliases`) to split `X (Y)` paren-form German aliases alongside the existing `X / Y` slash form.
- Broaden `dedupeBreweryAliases` SQL candidate filter to match paren-form canonical rows; the startup job now collapses duplicates of both shapes on boot.
- Add §10 footgun bullet to the master spec.

Implements PR-A from `docs/superpowers/specs/2026-05-10-paren-alias-and-had-list.md`.
PR-B (scrape-based had-list) follows.

## Test plan
- [ ] `npm test` green locally
- [ ] After merge + deploy: startup logs show `dedupe-brewery-aliases: merged orphan ontap rows` for the Kemker pair (and ~5 other paren pairs in prod data)
- [ ] After merge + deploy: `SELECT COUNT(*) FROM beers WHERE name='Stadt Land Bier'` returns 1, not 2

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges. Deployment smoke (the two checkbox items in the PR body) happens after merge.

---

## What this plan does NOT cover

- The new `untappd_had` table, `markHad` / `hadBeerIds` / `triedBeerIds` helpers, and the scrape-job + filter wiring — all of those belong to PR-B, with its own plan in a follow-up branch (`feat/scrape-had-list`).
- USER-GUIDE changes — none in PR-A; user-facing behavior is unchanged. PR-B will update USER-GUIDE.
- Worktree teardown — done after PR merges, not part of this plan.
