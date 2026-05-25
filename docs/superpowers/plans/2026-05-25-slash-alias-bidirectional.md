# Bidirectional slash-alias dedup (PR-C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `breweryAliases` whitespace-tolerant around `/` and make `dedupeBreweryAliases` symmetric in both SQL pre-filter and JS overlap check — so that Polish slash-form colab orphans (currently 17 in prod) merge into their Untappd canonical at next startup AND future ontap scrapes never create such orphans again.

**Architecture:** Two production files change. `src/domain/matcher.ts:31` swaps the literal-space check `brewery.includes(' / ')` for a `/\s*\/\s*/` regex so all spacing variants (`X/Y`, `X / Y`, `X/ Y`, `X /Y`) split into the same alias set. `src/jobs/dedupe-brewery-aliases.ts` widens its SQL WHERE to detect compound form on EITHER pair side (was canonical-only) and changes its `'%/%'` patterns to match unspaced slashes; the JS overlap check becomes symmetric (`breweryAliases(canonical) ∩ breweryAliases(orphan) ≠ ∅`) rather than `canonical-aliases.has(orphan_norm_brewery)`. Tests cover the new cases plus PR-A regression. Master-spec §10 gains a third footgun bullet.

**Tech Stack:** TypeScript, Jest, better-sqlite3 (`:memory:` for tests), pino logger. No new dependencies. No schema changes. No migrations.

**Spec:** `docs/superpowers/specs/2026-05-25-slash-alias-bidirectional-design.md` (commit `757fd18`).

**Branch:** `feat/slash-alias-bidirectional` off `origin/main`.

---

## File Structure

- **Modify** `src/domain/matcher.ts` — one regex line + updated header comment.
- **Modify** `src/domain/matcher.test.ts` — 4 new tests in the existing `describe('breweryAliases', …)` block + 1 new `matchBeer` integration test.
- **Modify** `src/jobs/dedupe-brewery-aliases.ts` — SQL WHERE widening, new `orphan_brewery` field in `PairCandidate`, symmetric JS overlap check.
- **Modify** `src/jobs/dedupe-brewery-aliases.test.ts` — 3 new tests (compound-on-orphan spaced, compound-on-orphan unspaced, ambiguity / no-overlap). Existing PR-A test (Kemker Kultuur paren) stays as regression.
- **Modify** `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` — append a third footgun bullet at the end of §10 (after `Two-source drunk model`).

No new files. No locale changes. No storage-helper changes.

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/ysi/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/slash-alias-bidirectional /home/ysi/warsaw-beer-bot-slash-alias origin/main
cd /home/ysi/warsaw-beer-bot-slash-alias
```

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exit 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: every suite passes (the baseline we will not regress).

- [ ] **Step 4: Baseline typecheck**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 2: `breweryAliases` whitespace-tolerant slash regex

**Files:**
- Modify: `src/domain/matcher.ts:21-46` (comment + slash-split line)
- Modify: `src/domain/matcher.test.ts` — extend the existing `describe('breweryAliases', …)` block and add a `matchBeer` integration test.

TDD: write failing tests first, then change the one regex line.

- [ ] **Step 1: Add failing tests**

In `src/domain/matcher.test.ts`, find the existing test `'mixed slash + paren splits on both'` inside `describe('breweryAliases', …)` (currently around lines 43-53). AFTER it, BEFORE the existing `'empty input returns empty array'` test, insert these four tests:

```typescript
  test('slash without spaces (Sady/Beer Bacon collab style) splits both halves', () => {
    const out = breweryAliases('Sady/Beer Bacon and Liberty Brewery');
    expect(new Set(out)).toEqual(
      new Set([
        'sady beer bacon and liberty',
        'sady',
        'beer bacon and liberty',
      ]),
    );
  });

  test('slash with right-side space only (Nieczajna/ Monsters style) splits both halves', () => {
    const out = breweryAliases('Nieczajna/ Monsters Brewery');
    expect(new Set(out)).toEqual(
      new Set(['nieczajna monsters', 'nieczajna', 'monsters']),
    );
  });

  test('slash with left-side space only (Stu Mostów /Ophiussa style) splits both halves', () => {
    const out = breweryAliases('Stu Mostów /Ophiussa Brewery');
    expect(new Set(out)).toEqual(
      new Set(['stu mostow ophiussa', 'stu mostow', 'ophiussa']),
    );
  });

  test('multi-slash collab (A/B/C) splits into all parts', () => {
    const out = breweryAliases('Nieczajna/Craftownia Brewery');
    expect(new Set(out)).toEqual(
      new Set(['nieczajna craftownia', 'nieczajna', 'craftownia']),
    );
  });
```

Then ADD a new top-level test AFTER the closing of the existing `describe('matchBeer — slash-alias breweries', …)` block (search the file for that describe name). Place it right before `describe('vintage handling', …)`:

```typescript
describe('matchBeer — bare-slash (insert-time prevention)', () => {
  test('ontap "Sady/Beer Bacon and Liberty Brewery Midnight Mass" hits canonical Untappd row "Browar Sady Midnight Mass"', () => {
    const canon: CatalogBeer[] = [
      c({ id: 100, brewery: 'Browar Sady', name: 'Midnight Mass', abv: 10.9 }),
    ];
    const m = matchBeer(
      { brewery: 'Sady/Beer Bacon and Liberty Brewery', name: 'Midnight Mass', abv: 10.9 },
      canon,
    );
    expect(m).toEqual({ id: 100, confidence: 1, source: 'exact' });
  });
});
```

(Reuse the existing `c(...)` helper that other matchBeer tests use; it should already be in scope at the file top — verify before adding.)

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=matcher --silent`
Expected: FAIL — the 4 new `breweryAliases` tests assert split-into-halves but current code returns only `['<full normalized>']` for bare-slash. The `matchBeer` integration test returns `null` because the overlap fails.

- [ ] **Step 3: Apply the regex fix in `matcher.ts`**

In `src/domain/matcher.ts`, find line 31:

```typescript
  const slashParts = brewery.includes(' / ') ? brewery.split(' / ') : [brewery];
```

Replace with:

```typescript
  const slashRegex = /\s*\/\s*/;
  const slashParts = slashRegex.test(brewery) ? brewery.split(slashRegex) : [brewery];
```

Also update the header comment (lines 20-25). Replace:

```typescript
// Untappd records breweries either as a single name ("Piwne Podziemie Brewery"),
// as an "X / Y" alias used for bilingual ("Piwne Podziemie / Beer Underground")
// or collaboration ("AleBrowar / Poppels Bryggeri") pairs, or as an "X (Y)"
// form for German aliases ("Kemker Kultuur (Brauerei J. Kemker)").
// Ontap.pl renders only one of these. For matching purposes all three forms
// collapse to: "any side of the separator is a valid brewery for this beer".
```

With:

```typescript
// Untappd records breweries either as a single name ("Piwne Podziemie Brewery"),
// as a slash alias used for bilingual ("Piwne Podziemie / Beer Underground")
// or collaboration ("Sady/Beer Bacon and Liberty Brewery") pairs, or as an
// "X (Y)" form for German aliases ("Kemker Kultuur (Brauerei J. Kemker)").
// The slash form appears with any spacing around "/" (with, without, or one
// side only) — the regex absorbs all variants. Ontap.pl renders only one of
// these. For matching purposes all forms collapse to: "any side of the
// separator is a valid brewery for this beer".
```

- [ ] **Step 4: Confirm tests pass**

Run: `npm test -- --testPathPatterns=matcher --silent`
Expected: all matcher tests pass (existing + 5 new).

- [ ] **Step 5: Run the full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0. No other suite is affected — matcher's change is purely additive on the alias-split direction.

- [ ] **Step 6: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "$(cat <<'EOF'
feat(matcher): breweryAliases splits slash with any spacing

Replace the literal " / " containment check with a /\s*\/\s*/ regex
so "X/Y", "X / Y", "X/ Y", and "X /Y" all split into the same alias
set. Polish slash-form collabs (Sady/Beer Bacon and Liberty Brewery,
Nieczajna/Craftownia Brewery, etc.) now produce per-side aliases just
like the existing spaced form did.

matchBeer is already symmetric on breweryAliases (uses
brewerySetsOverlap on both input and catalog candidates), so this
single line fixes insert-time prevention: future ontap scrapes of
"Sady/..." find the existing Untappd canonical "Browar Sady" instead
of upserting a new orphan row.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `dedupeBreweryAliases` symmetric SQL + JS overlap

**Files:**
- Modify: `src/jobs/dedupe-brewery-aliases.ts`
- Modify: `src/jobs/dedupe-brewery-aliases.test.ts`

TDD: 3 new tests first, then SQL + JS changes together (they are coupled — `orphan_brewery` field must be selected by SQL and consumed by JS).

- [ ] **Step 1: Add failing tests**

In `src/jobs/dedupe-brewery-aliases.test.ts`, find the existing test `'merges paren-form alias pair (Kemker Kultuur case)'` (currently around lines 168-217). AFTER its closing `});` and BEFORE the final closing `});` of the outer `describe('dedupeBreweryAliases', …)`, insert these three tests:

```typescript
  test('merges bare-slash collab orphan (Sady/Beer Bacon Midnight Mass case)', () => {
    const db = fresh();
    // Canonical Untappd-side row — simple brewery name.
    const aId = upsertBeer(db, {
      untappd_id: 6645648,
      name: 'Midnight Mass',
      brewery: 'Browar Sady',
      style: null,
      abv: 10.9,
      rating_global: 3.92,
      normalized_name: 'midnight mass',
      normalized_brewery: 'sady',
    });
    // Orphan ontap-side row — brewery is compound bare-slash form.
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Midnight Mass',
      brewery: 'Sady/Beer Bacon and Liberty Brewery',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'midnight mass',
      normalized_brewery: 'sady beer bacon and liberty',
    });
    upsertMatch(db, 'Midnight Mass', bId, 1.0);

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 1, beersDeleted: 1 });

    // Orphan gone; canonical survives.
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(bId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(aId)).toEqual({ id: aId });

    // match_link transferred to canonical.
    const link = db
      .prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Midnight Mass') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(aId);
  });

  test('merges mixed-spacing slash orphan (Nieczajna/ Monsters style)', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 5712429,
      name: 'Mexican',
      brewery: 'Browar Monsters',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'mexican',
      normalized_brewery: 'monsters',
    });
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Mexican',
      brewery: 'Nieczajna/ Monsters Brewery',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'mexican',
      normalized_brewery: 'nieczajna monsters',
    });
    upsertMatch(db, 'Mexican', bId, 1.0);

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 1, beersDeleted: 1 });
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(bId)).toBeUndefined();
  });

  test('does NOT merge slash orphan when no alias overlaps with canonical', () => {
    const db = fresh();
    // Canonical: "Genys Brewing Co.", normalized 'genys brewing co'.
    const aId = upsertBeer(db, {
      untappd_id: 5738553,
      name: 'Grodziskie',
      brewery: 'Genys Brewing Co.',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'grodziskie',
      normalized_brewery: 'genys brewing co',
    });
    // Orphan: "Miejski Stargard/Nieczajna Brewery" — aliases include
    // 'miejski stargard' and 'nieczajna' but NOT 'genys brewing co'.
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Grodziskie',
      brewery: 'Miejski Stargard/Nieczajna Brewery',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'grodziskie',
      normalized_brewery: 'miejski stargard nieczajna',
    });
    upsertMatch(db, 'Grodziskie', bId, 1.0);

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 0, beersDeleted: 0 });
    // Both rows still present.
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(aId)).toBeDefined();
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(bId)).toBeDefined();
  });
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=dedupe-brewery-aliases --silent`
Expected: FAIL — the first two new tests expect `pairsMerged: 1` but current code returns `0` (SQL WHERE only matches compound-on-canonical with spaced slash). The third test ('does NOT merge') currently passes accidentally for the wrong reason (no candidate row reaches JS overlap), but with the symmetric fix it should still pass — the JS overlap is what excludes it. We're TDD-ing the first two; the third is a regression guard.

- [ ] **Step 3: Update `dedupe-brewery-aliases.ts`**

Overwrite `src/jobs/dedupe-brewery-aliases.ts` with:

```typescript
import type pino from 'pino';
import type { DB } from '../storage/db';
import { breweryAliases } from '../domain/matcher';

interface PairCandidate {
  canonical_id: number;
  canonical_brewery: string;
  orphan_id: number;
  orphan_brewery: string;
  orphan_norm_brewery: string;
}

export interface DedupeResult {
  pairsMerged: number;
  beersDeleted: number;
}

export function dedupeBreweryAliases(db: DB, log: pino.Logger): DedupeResult {
  // Find candidates: same normalized_name, A has untappd_id and B doesn't.
  // Compound brewery form ("X/Y" slash, any spacing, or "X (Y)" paren) may
  // appear on EITHER side of the pair — PR-A had it on canonical (Kemker
  // (Brauerei J. Kemker)), PR-C had it on orphan (Sady/Beer Bacon and
  // Liberty Brewery). Match either; JS alias-overlap will decide whether
  // the pair actually corresponds.
  const candidates = db
    .prepare(
      `SELECT
         a.id AS canonical_id,
         a.brewery AS canonical_brewery,
         b.id AS orphan_id,
         b.brewery AS orphan_brewery,
         b.normalized_brewery AS orphan_norm_brewery
       FROM beers a
       JOIN beers b
         ON a.normalized_name = b.normalized_name
        AND a.id <> b.id
       WHERE a.untappd_id IS NOT NULL
         AND b.untappd_id IS NULL
         AND (
           a.brewery LIKE '%/%'
           OR (a.brewery LIKE '%(%' AND a.brewery LIKE '%)%')
           OR b.brewery LIKE '%/%'
           OR (b.brewery LIKE '%(%' AND b.brewery LIKE '%)%')
         )
       ORDER BY a.id, b.id`,
    )
    .all() as PairCandidate[];

  // Symmetric alias-overlap: pair merges only if breweryAliases(canonical)
  // and breweryAliases(orphan) share at least one element. This filters out
  // false-positives where the SQL pre-filter caught a pair that happens to
  // share normalized_name but whose breweries are unrelated.
  const pairsByOrphan = new Map<number, PairCandidate>();
  for (const c of candidates) {
    const canonicalAliases = new Set(breweryAliases(c.canonical_brewery));
    const orphanAliases = breweryAliases(c.orphan_brewery);
    const overlap = orphanAliases.some((x) => canonicalAliases.has(x));
    if (!overlap) continue;
    if (!pairsByOrphan.has(c.orphan_id)) pairsByOrphan.set(c.orphan_id, c);
  }

  if (pairsByOrphan.size === 0) {
    log.info({ pairs: 0 }, 'dedupe-brewery-aliases: catalog clean');
    return { pairsMerged: 0, beersDeleted: 0 };
  }

  const updateLinks = db.prepare(
    'UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?',
  );
  const updateCheckins = db.prepare(
    'UPDATE checkins SET beer_id = ? WHERE beer_id = ?',
  );
  const deleteBeer = db.prepare('DELETE FROM beers WHERE id = ?');

  const tx = db.transaction((pairs: PairCandidate[]) => {
    for (const p of pairs) {
      updateLinks.run(p.canonical_id, p.orphan_id);
      updateCheckins.run(p.canonical_id, p.orphan_id);
      deleteBeer.run(p.orphan_id);
    }
  });
  tx(Array.from(pairsByOrphan.values()));

  const merged = pairsByOrphan.size;
  log.info(
    { pairs: merged },
    'dedupe-brewery-aliases: merged orphan ontap rows into canonical Untappd rows',
  );
  return { pairsMerged: merged, beersDeleted: merged };
}
```

Key diffs vs the previous version:

1. `PairCandidate` gains `orphan_brewery: string` field.
2. SQL `SELECT` adds `b.brewery AS orphan_brewery`.
3. SQL `WHERE` drops the spaced-slash literal `'% / %'` in favor of unspaced `'%/%'` (still matches both forms), and ORs the same conditions on `b.brewery`.
4. JS overlap check is symmetric: builds aliases from both sides and tests for intersection, rather than checking if canonical's alias set contains the orphan's normalized brewery.

- [ ] **Step 4: Confirm tests pass**

Run: `npm test -- --testPathPatterns=dedupe-brewery-aliases --silent`
Expected: all dedupe tests pass — the existing 8 (Piwne-Podziemie, checkins, collab right-side, unrelated, idempotent, paren Kemker, plus the two simpler ones at the top) and the 3 new ones.

- [ ] **Step 5: Run the full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/dedupe-brewery-aliases.ts src/jobs/dedupe-brewery-aliases.test.ts
git commit -m "$(cat <<'EOF'
feat(dedupe): catch compound brewery form on either pair side

WHERE now matches slash/paren compound on EITHER canonical or orphan
side (PR-A assumed canonical-only; PR-C real-world cases have it on
the orphan side, e.g. ontap-rendered "Sady/Beer Bacon and Liberty
Brewery"). The %/% pattern also drops the spaced-slash assumption so
unspaced slashes catch through.

JS overlap becomes symmetric: breweryAliases(canonical) and
breweryAliases(orphan) must share at least one element, regardless of
which side was the trigger. Combined with the matcher fix landed
earlier in this PR, the 17 orphan rows currently in prod will merge on
the next startup, and future ontap scrapes won't recreate them.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Master spec §10 footgun bullet

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` — append a new bullet at the end of §10 (after the `Two-source drunk model` bullet).

- [ ] **Step 1: Locate the insertion point**

Open `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`. Find the `Two-source drunk model` bullet that currently ends with:

```
because the scrape rewrote `beers.rating_global` but never marked
the user as having had it.
```

That bullet is the last one in §10. Insert the new bullet IMMEDIATELY AFTER it (still inside §10).

- [ ] **Step 2: Append the new bullet**

Insert this block right after the `Two-source drunk model` bullet's closing line:

```markdown
- **Bare-slash brewery aliases (any side)**: Polish collab breweries
  often render with no spaces around `/` ("Sady/Beer Bacon and Liberty
  Brewery", "Nieczajna/Craftownia Brewery"). The original PR-A
  assumption was that the compound form lives on the Untappd-canonical
  side and uses `' / '` with spaces — both wrong for this case.
  `breweryAliases` (`src/domain/matcher.ts`) now splits on `/\s*\/\s*/`
  to absorb any spacing, and `dedupeBreweryAliases`
  (`src/jobs/dedupe-brewery-aliases.ts`) detects compound form on
  either pair side with a symmetric alias-overlap check. Caught
  2026-05-25 via 17 prod orphans (e.g. *Midnight Mass* duplicated as
  `beers#12276/12286`); merged on next boot.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "$(cat <<'EOF'
docs(spec): §10 footgun bullet for bare-slash brewery aliases

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final verification before push

**Files:** none.

- [ ] **Step 1: Full suite**

Run: `npm test -- --silent`
Expected: every test passes. Total = baseline 240 + 5 new matcher (4 breweryAliases + 1 matchBeer integration) + 3 new dedupe = **248** tests. Suite count unchanged (no new suites).

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline origin/main..HEAD`
Expected: 3 commits in order:
1. `feat(matcher): breweryAliases splits slash with any spacing`
2. `feat(dedupe): catch compound brewery form on either pair side`
3. `docs(spec): §10 footgun bullet for bare-slash brewery aliases`

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff origin/main...HEAD --stat`
Expected files (5):
- `src/domain/matcher.ts`
- `src/domain/matcher.test.ts`
- `src/jobs/dedupe-brewery-aliases.ts`
- `src/jobs/dedupe-brewery-aliases.test.ts`
- `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`

No stray edits outside this set.

- [ ] **Step 5: Sanity-check against the prod orphan count**

This is a manual check, not a hard automated assertion. Run locally against the production DB snapshot OR after merge in deploy verify:

```bash
sqlite3 /var/lib/warsaw-beer-bot/bot.db <<'SQL'
SELECT COUNT(DISTINCT b.id) AS orphans
FROM beers a
JOIN beers b ON a.normalized_name = b.normalized_name AND a.id <> b.id
WHERE a.untappd_id IS NOT NULL AND b.untappd_id IS NULL
  AND (b.brewery LIKE '%/%' OR (b.brewery LIKE '%(%' AND b.brewery LIKE '%)%'));
SQL
```

Expected before deploy: 17. After post-deploy `systemctl restart warsaw-beer-bot`: 0 (or close — some may stay if their compound-form aliases genuinely don't overlap any canonical, e.g. orphan 399 'Miejski Stargard/Nieczajna' with no canonical-Nieczajna in the 'grodziskie' match set).

---

## Task 6: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/slash-alias-bidirectional
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: bidirectional slash-alias dedup (PR-C)" --body "$(cat <<'EOF'
## Summary
- `breweryAliases` now splits on `/\s*\/\s*/` — catches `X/Y`, `X / Y`, `X/ Y`, `X /Y`. Polish-collab slash-form breweries (Sady/Beer Bacon and Liberty Brewery, Nieczajna/Craftownia Brewery, etc.) now produce per-side aliases.
- `dedupeBreweryAliases` SQL widens to match compound form on EITHER pair side and to detect unspaced `/`. JS overlap check becomes symmetric (`breweryAliases(canonical) ∩ breweryAliases(orphan) ≠ ∅`).
- `matchBeer` is unchanged — it already uses `breweryAliases` symmetrically, so the matcher fix automatically prevents future ontap scrapes from creating these orphans.
- Master spec §10 gains a third footgun bullet.

Implements `docs/superpowers/specs/2026-05-25-slash-alias-bidirectional-design.md`. Extends PR-A (#39) and PR-B (#42).

## Test plan
- [x] `npm test` green locally (248 tests; +5 matcher, +3 dedupe vs main baseline 240)
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [ ] Post-deploy: check startup log for `dedupe-brewery-aliases: merged N orphan ontap rows into canonical Untappd rows` with N close to 17 (some ambiguity orphans may stay).
- [ ] Post-deploy: re-issue `/newbeers` against the same filter set the *Midnight Mass* bug was reported under. The duplicate entry should be gone.
- [ ] Post-deploy: confirm a fresh `/refresh` does not recreate any of the merged orphans (verifies insert-time prevention from the matcher fix).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges; runtime verification happens post-deploy (the startup dedupe lands the cleanup automatically).

---

## What this plan does NOT cover

- **Other alias separators** (`X & Y`, `X | Y`, `X + Y`) — YAGNI per spec; no such forms in current prod brewery names.
- **Backfill script** — existing `dedupeBreweryAliases(db, log)` in `src/index.ts:29` runs on every startup; restart-on-deploy is the backfill.
- **Metrics/monitoring** for the dedupe job — existing `log.info({pairs})` covers it.
- **UI for ambiguity orphans** (e.g. `Miejski Stargard/Nieczajna` with no canonical-Nieczajna in the same name set) — they stay as orphans, no manual merge path; revisit only if real users hit them.
- **Worktree teardown** — done after the PR merges (`git worktree remove /home/ysi/warsaw-beer-bot-slash-alias`).
