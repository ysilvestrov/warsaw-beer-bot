# PR-D2.1 perf hotfix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/refresh` from processing every on-tap orphan (287 in prod) plus a 500ms sleep on every tap regardless. Inline lookup now fires only for beers `matchBeer` just upserted (~0-5 per sweep); cron stays responsible for the backlog.

**Architecture:** Two surgical edits in `src/jobs/refresh-ontap.ts`: an `isFreshOrphan` flag set only when `matchBeer === null`, used to gate the `enrichOneOrphan` call; and a `outcome !== 'skipped'` guard on the post-call sleep. Plus a paragraph replacement and a Footguns bullet in the master spec so the lesson is recorded.

**Tech Stack:** TypeScript. No new dependencies, no schema changes, no new tests (helper + cron tests unchanged; refresh-ontap is wire-up — verification is by deploy log).

**Spec:** `docs/superpowers/specs/2026-05-26-untappd-enrich-perf-hotfix.md` (commit `6747143`).

**Branch:** `feat/untappd-enrich-perf-hotfix` off `origin/main` (PR-D2 merged as #47).

---

## File Structure

- **Modify** `src/jobs/refresh-ontap.ts` — `isFreshOrphan` flag + conditional sleep (rewrite the inner if-block + the lookup-call block).
- **Modify** `docs/superpowers/specs/2026-05-26-untappd-lookup.md` — replace the `### Inline в refreshOntap` paragraph + add a `Risks / Footguns` bullet.

No new files. No test files modified — existing `untappd-enrich.test.ts` and `enrich-orphans.test.ts` continue to cover the helper and the cron path; the change is purely in which callsite invokes the helper.

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/ysi/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/untappd-enrich-perf-hotfix /home/ysi/warsaw-beer-bot-perf-hotfix origin/main
cd /home/ysi/warsaw-beer-bot-perf-hotfix
```

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exit 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: every suite passes. Baseline at PR-D2 merge = **307 tests / 41 suites** locally.

- [ ] **Step 4: Baseline typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

---

## Task 2: Apply hotfix to `src/jobs/refresh-ontap.ts`

**Files:**
- Modify: `src/jobs/refresh-ontap.ts` — inner tap-loop body.

- [ ] **Step 1: Locate the inner tap-loop block**

Open `src/jobs/refresh-ontap.ts`. Find the inner `for (const t of taps)` block. Currently (post-PR-D2 on main):

```typescript
      const catalog = listBeerCatalog(db);
      for (const t of taps) {
        const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
        const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
        let beerId: number;
        if (m) {
          upsertMatch(db, t.beer_ref, m.id, m.confidence);
          beerId = m.id;
        } else {
          beerId = upsertBeer(db, {
            name: t.beer_ref,
            brewery,
            style: t.style,
            abv: t.abv,
            rating_global: t.u_rating,
            normalized_name: normalizeName(t.beer_ref),
            normalized_brewery: normalizeBrewery(brewery),
          });
          upsertMatch(db, t.beer_ref, beerId, 1.0);
        }

        // Inline Untappd enrichment for orphans (untappd_id NULL) that
        // pass the backoff gate. enrichOneOrphan itself short-circuits
        // for non-orphans and ineligible ones, so the check here only
        // saves the function-call + sleep overhead.
        if (lookupEnabled) {
          await enrichOneOrphan({ db, log, http, now }, beerId);
          if (lookupSleepMs > 0) {
            await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
          }
        }
      }
```

- [ ] **Step 2: Replace the block with the hotfix**

Replace it with:

```typescript
      const catalog = listBeerCatalog(db);
      for (const t of taps) {
        const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
        const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
        let beerId: number;
        let isFreshOrphan = false;
        if (m) {
          upsertMatch(db, t.beer_ref, m.id, m.confidence);
          beerId = m.id;
        } else {
          beerId = upsertBeer(db, {
            name: t.beer_ref,
            brewery,
            style: t.style,
            abv: t.abv,
            rating_global: t.u_rating,
            normalized_name: normalizeName(t.beer_ref),
            normalized_brewery: normalizeBrewery(brewery),
          });
          upsertMatch(db, t.beer_ref, beerId, 1.0);
          isFreshOrphan = true;
        }

        // Inline Untappd enrichment ONLY for beers we just created
        // (matchBeer returned null). Existing orphans (matched to a row
        // that has untappd_id NULL) are handled by the enrich-orphans
        // cron — letting inline try them every 12h multiplies HTTP +
        // sleep across the full backlog. PR-D2.1 perf fix (2026-05-26).
        // Sleep only when HTTP actually fired (outcome !== 'skipped')
        // as a defense in depth.
        if (lookupEnabled && isFreshOrphan) {
          const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
          if (lookupSleepMs > 0 && outcome !== 'skipped') {
            await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
          }
        }
      }
```

Three concrete diffs from the previous version:
1. New `let isFreshOrphan = false;` after `let beerId: number;`.
2. New `isFreshOrphan = true;` inside the `else` branch (after `upsertMatch`).
3. The `if (lookupEnabled)` condition becomes `if (lookupEnabled && isFreshOrphan)`, and the inner sleep gains `&& outcome !== 'skipped'`. The call now binds `enrichOneOrphan`'s return value to `outcome`.

The comment also changes to record why this is now narrower than before.

- [ ] **Step 3: Run the full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0. No tests changed; this is a behavior narrowing inside a code path that no test exercises end-to-end.

- [ ] **Step 4: Verify the structural change**

```bash
grep -n 'isFreshOrphan\|outcome !==' src/jobs/refresh-ontap.ts
```

Expected: 4 matches — `let isFreshOrphan = false;`, `isFreshOrphan = true;`, `lookupEnabled && isFreshOrphan`, and `outcome !== 'skipped'`. If you see 3 or 5, re-check Step 2.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-ontap.ts
git commit -m "$(cat <<'EOF'
fix(refresh-ontap): inline lookup only for fresh orphans

Two narrowings to stop /refresh from multiplying HTTP+sleep across
the full on-tap orphan backlog (287 in prod → +12 min per sweep
post-PR-D2):

1. isFreshOrphan flag — enrichOneOrphan only fires when matchBeer
   returned null AND upsertBeer created a new row this sweep. Existing
   orphans (matched to a row that happens to have untappd_id NULL)
   are now ignored inline; cron handles them.
2. Sleep is gated by outcome !== 'skipped' so a guard miss (backoff,
   row no longer orphan, etc.) doesn't burn 500ms × every tap.

Sweep wall-time returns to ~5 min + 0-3s for any new orphans the
sweep actually surfaced. The cron stays on its 20/run × 2/day budget
and clears the backlog over ~7 days regardless.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update master spec (`docs/superpowers/specs/2026-05-26-untappd-lookup.md`)

**Files:**
- Modify: `docs/superpowers/specs/2026-05-26-untappd-lookup.md` — replace `### Inline в refreshOntap` paragraph, append Footguns bullet.

- [ ] **Step 1: Replace the `### Inline в refreshOntap` paragraph**

Open `docs/superpowers/specs/2026-05-26-untappd-lookup.md`. Find this exact block (currently around lines 213-241):

```markdown
### Inline в `refreshOntap`

`src/jobs/refresh-ontap.ts` зараз робить:

```ts
const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
const beerId = m ? m.id : upsertBeer(db, {...});
// (далі match_links upsert тощо)
```

Стає:

```ts
const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
const beerId = m ? m.id : upsertBeer(db, {...});

const beer = getBeer(db, beerId);    // small helper, returns full row
if (beer.untappd_id === null && isEligible(now, beer.untappd_lookup_at, beer.untappd_lookup_count)) {
  const outcome = await lookupBeer({ brewery, name: t.beer_ref, fetch: http.get });
  await new Promise((r) => setTimeout(r, 500));   // polite spacing
  switch (outcome.kind) {
    case 'matched':       recordLookupSuccess(db, beerId, outcome.result); break;
    case 'not_found':     recordLookupNotFound(db, beerId, now.toISOString()); break;
    case 'transient':     recordLookupTransient(db, beerId, now.toISOString()); break;
  }
}
```

**Overhead в типовому sweep-і:** 0–3 нових orphan-ів за день — 1.5s оверхеду max. Backlog-сценарій керується cron-ом.
```

Replace the ENTIRE block (everything from `### Inline в \`refreshOntap\`` down to and including the `**Overhead...**` line) with:

```markdown
### Inline в `refreshOntap`

Після `matchBeer`, **тільки якщо `matchBeer === null`** (тобто `upsertBeer` створив новий рядок у цьому sweep-і), викликаємо `enrichOneOrphan(beerId)`. Існуючі orphan-и (matchBeer повернув existing рядок без `untappd_id`) інлайн НЕ обробляє — вони чекають cron. Це критично, бо інакше один sweep пробує всі on-tap orphan-и (287 у проді), кожен з HTTP+sleep ≈2.5s → sweep уповільнюється на +12 хв.

```ts
const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
let beerId: number;
let isFreshOrphan = false;
if (m) {
  upsertMatch(db, t.beer_ref, m.id, m.confidence);
  beerId = m.id;
} else {
  beerId = upsertBeer(db, {...});
  upsertMatch(db, t.beer_ref, beerId, 1.0);
  isFreshOrphan = true;
}

if (lookupEnabled && isFreshOrphan) {
  const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
  // sleep тільки якщо HTTP реально був (defense in depth: outcome може
  // повернутись 'skipped' через backoff або race condition)
  if (lookupSleepMs > 0 && outcome !== 'skipped') {
    await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
  }
}
```

**Overhead в типовому sweep-і:** 0–3 нових orphan-ів за день — 1.5s оверхеду max. Backlog (287 рядків у проді) обробляється cron-ом, по 20×2/добу = ~7 днів до 0.
```

- [ ] **Step 2: Append a Footguns bullet**

Find the `## Risks / Footguns` section (around line 415). At the end of the bullet list (after the last `**Curl-first на dev-стороні.**` bullet, around line 422), append a new bullet:

```markdown
- **Inline must NOT process backlog.** PR-D2.1 hotfix (2026-05-26): початковий PR-D2 inline-шлях не розрізняв fresh orphan-ів від існуючого backlog-у. На першому post-deploy sweep-і inline проходив всі 287 on-tap orphan-ів з HTTP+sleep ≈2.5s кожен → sweep уповільнився з ~5 хв до 10+ хв на 28 пабах. Fix: `isFreshOrphan` guard (`matchBeer === null` → upsertBeer create) + conditional sleep on `outcome !== 'skipped'`. Урок: "harmless guard skipped 95% of the time" у hot loop-і — не harmless, коли N=350 тапів × 500ms = 3 хв пустого sleep-у, плюс backlog-multiplier.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-26-untappd-lookup.md
git commit -m "$(cat <<'EOF'
docs(spec): update PR-D2 master spec for the perf hotfix

- Replace the "Inline в refreshOntap" paragraph with the corrected
  design (isFreshOrphan guard + conditional sleep).
- Append a Risks/Footguns bullet recording the regression, root cause,
  and the lesson (harmless guards in hot loops aren't, when N is
  large or backlog skews the steady-state assumption).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Final verification before push

**Files:** none.

- [ ] **Step 1: Full suite**

Run: `npm test -- --silent`
Expected: 307 tests / 41 suites — no change from baseline (no test files modified).

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline origin/main..HEAD`
Expected: exactly 2 commits:
1. `fix(refresh-ontap): inline lookup only for fresh orphans`
2. `docs(spec): update PR-D2 master spec for the perf hotfix`

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff origin/main...HEAD --stat`
Expected files (2):
- `src/jobs/refresh-ontap.ts` (one block rewrite in the inner loop)
- `docs/superpowers/specs/2026-05-26-untappd-lookup.md` (paragraph replacement + bullet append)

No other files touched.

- [ ] **Step 5: Sanity-check the actual diff for refresh-ontap.ts**

Run: `git diff origin/main -- src/jobs/refresh-ontap.ts`
Expected: ~10 lines added (new flag declaration + flag-set + reworked if-block + comment) and ~6 lines removed (old if-block + old comment). Total diff well under 25 lines.

---

## Task 5: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/untappd-enrich-perf-hotfix
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "fix: PR-D2 perf hotfix — inline lookup for fresh orphans only" --body "$(cat <<'EOF'
## Summary
Regression introduced by PR-D2 (#47): \`/refresh\` slowed from ~5 min to 10+ min on 28 pubs at first post-deploy. Two compounding causes:

1. Inline path processed **every** on-tap orphan (287 in prod) every sweep, not just newly-upserted ones. Each lookup ≈ 2.5s (HTTP + sleep) → +12 min.
2. The 500ms post-call sleep ran on every tap iteration regardless of whether \`enrichOneOrphan\` actually made an HTTP request. ~350 taps × 500ms = +3 min pure sleep.

The PR-D2 plan flagged the unconditional sleep as "harmless because most taps are non-orphan in steady state" — true once the backlog is cleared, catastrophically wrong on day one with 287 backlog orphans on tap.

## Fix
- \`isFreshOrphan\` flag, set only inside the \`else\` (matchBeer returned null) branch of the tap loop. Inline \`enrichOneOrphan\` only fires when \`isFreshOrphan\`. Backlog stays the responsibility of the \`enrich-orphans\` cron (20×2/day → ~7 days to clear).
- Sleep gated by \`outcome !== 'skipped'\` as defense in depth (no HTTP → no sleep).

Master spec PR-D2 section and Footguns updated to record the lesson.

Implements \`docs/superpowers/specs/2026-05-26-untappd-enrich-perf-hotfix.md\`.

## Test plan
- [x] \`npm test\` green locally (307/41 — no test files changed)
- [x] \`npm run typecheck\` clean
- [x] \`npm run build\` clean
- [ ] After deploy: \`sudo journalctl -u warsaw-beer-bot --since today | grep "ontap.*пабів"\` — first sweep wall-time ≈ 5 min, not 10+.
- [ ] After 24h: \`sudo journalctl ... | grep "enrich-orphans done"\` — cron still processing ~20/run.
- [ ] After 1 week: prod on-tap orphan count keeps falling toward 0 minus Untappd-uncatalogued cases.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges + redeploys; next sweep should be back to ~5 min.

---

## What this plan does NOT cover

- **Reverting PR-D2.** The cron path is correct; only the inline path needs narrowing.
- **Integration test for `refreshOntap`.** Out of scope — wire-up only; full mock-rig would dwarf the fix. Verification is post-deploy log.
- **Reducing the 500ms sleep.** 500ms × ~3 fresh orphans/sweep = 1.5s, acceptable.
- **Per-sweep lookup limit.** YAGNI — fresh orphans are bounded by genuine new arrivals, not by backlog.
- **Worktree teardown.** Done after PR merges (`git worktree remove /home/ysi/warsaw-beer-bot-perf-hotfix`).
