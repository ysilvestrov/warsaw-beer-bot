# PR-D-throughput-bump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bump `enrich-orphans` and `refresh-tap-ratings` cron frequency from 12h to 3h so the 287-orphan backlog drains in ~1.8 days instead of 7, without changing per-burst HTTP signature (LIMIT=20, sleep=500ms → 10s burst).

**Architecture:** Two-line edit in `src/index.ts`: replace `0 6,18 * * *` with `30 */3 * * *` for enrich-orphans, and `0 9,21 * * *` with `30 1,4,7,10,13,16,19,22 * * *` for refresh-tap-ratings (offset 1h, so the two never burst simultaneously). All job logic, backoff schedule, kill switch, and storage helpers stay unchanged. Plus three small text updates in the master spec.

**Tech Stack:** Node.js, TypeScript, node-cron, Jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-29-untappd-cron-frequency-bump.md` (commit `6f7ef58`)

**Branch:** `feat/untappd-cron-frequency-bump`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/index.ts` | Modify lines 71 + 77 | Cron schedule strings — only thing that changes runtime behaviour |
| `docs/superpowers/specs/2026-05-26-untappd-lookup.md` | Modify line ~268 (D2 backfill sentence), line ~339 (D3 09/21 sentence), line ~422 (extend Footgun bullet) | Master spec stays the source of truth for D-series; this PR's note in commit-trail keeps it discoverable |

No new files. No tests added (cron strings are wire-up, not unit-testable). All existing tests must stay green.

---

## Task 1: Branch + worktree setup

**Files:**
- N/A (git state only)

- [ ] **Step 1: Create worktree on a new branch**

Run:
```bash
git -C /home/ysi/warsaw-beer-bot worktree add -b feat/untappd-cron-frequency-bump /home/ysi/warsaw-beer-bot-cron-bump main
```
Expected: `Preparing worktree (new branch 'feat/untappd-cron-frequency-bump')` and a fresh checkout at `/home/ysi/warsaw-beer-bot-cron-bump`.

- [ ] **Step 2: Verify clean state**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && git status && git log --oneline -1
```
Expected: `nothing to commit, working tree clean` and HEAD at `6f7ef58 docs(spec): PR-D-throughput-bump`.

- [ ] **Step 3: Verify the cron lines we'll edit**

Run:
```bash
grep -n "cron.schedule" /home/ysi/warsaw-beer-bot-cron-bump/src/index.ts
```
Expected output includes:
```
71:    cron.schedule('0 6,18 * * *', () => {
77:    cron.schedule('0 9,21 * * *', () => {
```
(If line numbers differ, use the matched lines — content is what matters.)

---

## Task 2: Bump `enrich-orphans` cron from 12h to 3h

**Files:**
- Modify: `src/index.ts:71` (cron string)

- [ ] **Step 1: Replace the enrich-orphans cron string**

Edit `src/index.ts`. Find:
```ts
    cron.schedule('0 6,18 * * *', () => {
      enrichOrphans({
```

Replace with:
```ts
    // enrich-orphans runs every 3h at xx:30 (offset to avoid the busy
    // on-the-hour slot used by refreshOntap and refreshAllUntappd).
    // 8 runs/day × LIMIT 20 = 160 lookups/day; 287-orphan backlog drains
    // in ~1.8 days. Burst signature unchanged (20 calls × 500ms = ~10s).
    // Bumped from '0 6,18 * * *' (12h) in PR-D-throughput-bump 2026-05-29.
    cron.schedule('30 */3 * * *', () => {
      enrichOrphans({
```

- [ ] **Step 2: Verify the edit landed**

Run:
```bash
grep -n "30 \*/3 \* \* \*" /home/ysi/warsaw-beer-bot-cron-bump/src/index.ts
```
Expected: one match showing the new cron string. And:
```bash
grep -n "0 6,18 \* \* \*" /home/ysi/warsaw-beer-bot-cron-bump/src/index.ts
```
Expected: no matches (old string fully replaced).

---

## Task 3: Bump `refresh-tap-ratings` cron from 12h to 3h (offset 1h)

**Files:**
- Modify: `src/index.ts:77` (cron string)

- [ ] **Step 1: Replace the refresh-tap-ratings cron string**

Edit `src/index.ts`. Find:
```ts
    cron.schedule('0 9,21 * * *', () => {
      refreshTapRatings({
```

Replace with:
```ts
    // refresh-tap-ratings runs every 3h at xx:30 too, but on hours
    // 1/4/7/10/13/16/19/22 — offset 1h from enrich-orphans so the two
    // jobs never burst Untappd simultaneously. 8 runs/day × LIMIT 20.
    // Bumped from '0 9,21 * * *' (12h) in PR-D-throughput-bump 2026-05-29.
    cron.schedule('30 1,4,7,10,13,16,19,22 * * *', () => {
      refreshTapRatings({
```

- [ ] **Step 2: Verify the edit landed**

Run:
```bash
grep -n "30 1,4,7,10,13,16,19,22" /home/ysi/warsaw-beer-bot-cron-bump/src/index.ts
```
Expected: one match. And:
```bash
grep -n "0 9,21 \* \* \*" /home/ysi/warsaw-beer-bot-cron-bump/src/index.ts
```
Expected: no matches.

---

## Task 4: Typecheck, build, and run full test suite

**Files:**
- N/A (verification only)

- [ ] **Step 1: Typecheck**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && npm run typecheck
```
Expected: exit code 0, no output (or only "tsc" line, no errors).

- [ ] **Step 2: Build**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && npm run build
```
Expected: exit code 0, `dist/` populated.

- [ ] **Step 3: Full Jest test suite**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && npm test
```
Expected: all tests pass. No new tests in this PR — pure cron-string change, so existing `enrichOrphans` / `refreshTapRatings` unit suites stay green by inertia.

- [ ] **Step 4: Sanity-check the cron strings parse**

node-cron silently accepts malformed crontab on `schedule()` and only throws at first tick, so do a syntactic verification:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && node -e "const c=require('node-cron'); console.log('enrich:', c.validate('30 */3 * * *')); console.log('rating:', c.validate('30 1,4,7,10,13,16,19,22 * * *'));"
```
Expected: `enrich: true` and `rating: true`.

---

## Task 5: Update master spec — PR-D2 backfill paragraph

**Files:**
- Modify: `docs/superpowers/specs/2026-05-26-untappd-lookup.md` near line 268

- [ ] **Step 1: Replace the backfill sentence in the PR-D2 section**

Edit `docs/superpowers/specs/2026-05-26-untappd-lookup.md`. Find:
```
(06:00 і 18:00 — offset від існуючих cron-ів: refreshOntap 00:00/12:00, refreshAllUntappd 03:00.)

LIMIT 20 × 2 рази/добу = 40 запитів/день. За тиждень backlog-кейс (286) закриється повністю.
```

Replace with:
```
(xx:30 кожні 3 години — offset від on-the-hour cron-ів: refreshOntap 00:00/12:00, refreshAllUntappd 03:00.)

LIMIT 20 × 8 разів/добу = 160 запитів/день. Backlog ~287 закривається за ~1.8 днів. Бамп з 12h до 3h частоти виконано в PR-D-throughput-bump (2026-05-29) після виявлення, що 7-денний backfill не покриває реальний user-pain (orphan-и з spurious not_found чекали тиждень на retry).
```

- [ ] **Step 2: Verify**

Run:
```bash
grep -n "160 запитів/день\|1.8 днів\|PR-D-throughput-bump" /home/ysi/warsaw-beer-bot-cron-bump/docs/superpowers/specs/2026-05-26-untappd-lookup.md
```
Expected: matches around line 268.

---

## Task 6: Update master spec — PR-D3 cron paragraph

**Files:**
- Modify: `docs/superpowers/specs/2026-05-26-untappd-lookup.md` near line 339

- [ ] **Step 1: Replace the D3 cron offset sentence**

Edit `docs/superpowers/specs/2026-05-26-untappd-lookup.md`. Find:
```
09:00/21:00 — offset від D2 (06/18) і від існуючих.
```

Replace with:
```
xx:30 кожні 3 години на годинах 1, 4, 7, 10, 13, 16, 19, 22 UTC — offset 1h від enrich-orphans (хх:30 на 0/3/6/9/12/15/18/21) і ніколи не одночасно. Frequency bumped from 12h to 3h together with enrich-orphans (PR-D-throughput-bump 2026-05-29).
```

- [ ] **Step 2: Verify**

Run:
```bash
grep -n "1, 4, 7, 10, 13, 16, 19, 22 UTC" /home/ysi/warsaw-beer-bot-cron-bump/docs/superpowers/specs/2026-05-26-untappd-lookup.md
```
Expected: one match.

---

## Task 7: Update master spec — extend Risks/Footguns with throughput-tuning lesson

**Files:**
- Modify: `docs/superpowers/specs/2026-05-26-untappd-lookup.md` near line 422 (after the "Inline must NOT process backlog" bullet)

- [ ] **Step 1: Append the new bullet after the last existing Footgun**

Edit `docs/superpowers/specs/2026-05-26-untappd-lookup.md`. Find:
```
- **Inline must NOT process backlog.** PR-D2.1 hotfix (2026-05-26): початковий PR-D2 inline-шлях не розрізняв fresh orphan-ів від існуючого backlog-у. На першому post-deploy sweep-і inline проходив всі 287 on-tap orphan-ів з HTTP+sleep ≈2.5s кожен → sweep уповільнився з ~5 хв до 10+ хв на 28 пабах. Fix: `isFreshOrphan` guard (`matchBeer === null` → upsertBeer create) + conditional sleep on `outcome !== 'skipped'`. Урок: "harmless guard skipped 95% of the time" у hot loop-і — не harmless, коли N=350 тапів × 500ms = 3 хв пустого sleep-у, плюс backlog-multiplier.
```

Append below (preserving the existing bullet, adding a new one):
```
- **Throughput-tuning lesson** (PR-D-throughput-bump 2026-05-29). Initial PR-D2 plan хардкодив `LIMIT=20` × 12h cron «з рукава», без розрахунку backlog-часу. На реальному 287-orphan backlog це дало 7-денний фікс — неприйнятно для one-off bug-trace user-flow (`/newbeers Piw Paw` пропускав Bleat без rating). Бамп до 3h cron-частоти (LIMIT незмінний) дає 1.8-денний backfill і зберігає burst-сигнатуру (10s × 20 calls), яку Untappd толерує. Якщо `transient`-метрика в логах почне рости — dial-back до 6h або 12h (one-line revert). Урок: коли LIMIT × cron-frequency визначає user-facing latency, рахуй backlog-time перед коммітом плану.
```

- [ ] **Step 2: Verify**

Run:
```bash
grep -n "Throughput-tuning lesson" /home/ysi/warsaw-beer-bot-cron-bump/docs/superpowers/specs/2026-05-26-untappd-lookup.md
```
Expected: one match.

---

## Task 8: Final verification + commit

**Files:**
- N/A (git operations)

- [ ] **Step 1: Re-run typecheck and tests after spec edits**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && npm run typecheck && npm test
```
Expected: green. (Spec edits don't touch code, but the rerun catches accidental cross-edits.)

- [ ] **Step 2: Review the diff**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && git diff
```
Expected diff contents:
- `src/index.ts`: two cron strings replaced, two surrounding comment blocks added.
- `docs/superpowers/specs/2026-05-26-untappd-lookup.md`: three localized text edits (D2 backfill paragraph, D3 cron paragraph, new Footgun bullet).
No other files touched.

- [ ] **Step 3: Stage and commit**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && git add src/index.ts docs/superpowers/specs/2026-05-26-untappd-lookup.md
```

Then commit:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && git commit -m "$(cat <<'EOF'
feat(cron): bump Untappd cron frequency 12h → 3h

enrich-orphans now runs at xx:30 every 3h (8 runs/day); refresh-tap-ratings
at xx:30 on hours 1/4/7/10/13/16/19/22 (offset 1h, never simultaneous).
LIMIT=20 and 500ms sleep unchanged — burst signature stays at ~10s,
Untappd sees the same per-burst pattern, just 4× more often.

Drains the 287-orphan backlog in ~1.8 days vs the previous 7. Master
spec PR-D2/D3 sections updated and a Footgun bullet added documenting
the throughput-tuning lesson.

Spec: docs/superpowers/specs/2026-05-29-untappd-cron-frequency-bump.md
EOF
)"
```
Expected: one new commit on `feat/untappd-cron-frequency-bump`.

- [ ] **Step 4: Push and open PR**

Run:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && git push -u origin feat/untappd-cron-frequency-bump
```

Then:
```bash
cd /home/ysi/warsaw-beer-bot-cron-bump && gh pr create --title "feat(cron): bump Untappd cron frequency 12h → 3h" --body "$(cat <<'EOF'
## Summary
- enrich-orphans: `0 6,18 * * *` → `30 */3 * * *` (8 runs/day)
- refresh-tap-ratings: `0 9,21 * * *` → `30 1,4,7,10,13,16,19,22 * * *` (offset 1h from enrich)
- LIMIT=20 and 500ms sleep unchanged → burst signature stays at ~10s
- Drains 287-orphan backlog in ~1.8 days (vs 7 days at 12h frequency)
- Master spec PR-D2/D3 sections updated + new Footgun bullet on throughput-tuning lesson

Spec: `docs/superpowers/specs/2026-05-29-untappd-cron-frequency-bump.md`

## Test plan
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [x] `npm test` green
- [x] node-cron validates both new strings
- [ ] Post-deploy: count `enrich-orphans done` lines per day should be 8
- [ ] Post-deploy: watch `"transient":` counts in logs for spikes (signal for rate-limit; dial-back to 6h if spiking)
- [ ] Post-deploy: backlog orphan count drops from ~267 to ~0 in 2-3 days
EOF
)"
```
Expected: PR URL returned.

---

## Self-Review Checklist (already applied)

1. **Spec coverage:** Every section of the spec is covered:
   - "Architecture / Зміна у `src/index.ts`" → Tasks 2 + 3
   - "Master spec оновлення" 3 sub-items → Tasks 5, 6, 7
   - "Тести" (no new tests, npm test stays green) → Task 4
   - "Post-deploy verification" → captured in PR body Test plan checkboxes
2. **Placeholders:** None. Every code block has full content; every command shows expected output.
3. **Type consistency:** No new types introduced; cron strings are string literals validated by node-cron at Step 4.
