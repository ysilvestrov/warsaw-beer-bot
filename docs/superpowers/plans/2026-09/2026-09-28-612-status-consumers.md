# #612 Status and Consumers Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, sequentially under AGENTS.md.

**Goal:** Present honest historical sync state and verify profile ratings reach existing consumers safely.

**Architecture:** Keep the existing status renderer, extend its view with last sync activity and had-only beer count. Query the existing DB only. Transfer the new rating field alongside existing had rows in the manual legacy-card repair.

**Tech Stack:** TypeScript, SQLite, Telegraf, Hono, Vitest; no dependencies added.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-28-612-sync-status-ratings-design.md`

## Global Constraints

- Equal historical counters do not establish present completeness.
- `last_seen_at` is observation time, not drinking time.
- Check-in ratings take priority; profile ratings are fallback only.
- No arbitrary freshness threshold or network request in `/status`.
- Preserve user isolation and exact-match disclosure gates.

## Core review receipt

Reviewed the complete schema/storage/parser/scrape/account-setter diff against the
approved design. Storage keeps zero and prior values on absent data; profile-owner
guard runs after HTTP fetch with no awaits before writes. The shared reader retains
latest non-null check-in priority. Migration adds only a nullable column, initializes
no ratings, and does not seed completeness. Core full gate: 3606 passed, one skipped;
`npm run typecheck` passed. Existing account-history mixing is #611, outside scope;
only new scraped ratings are cleared on relink. No retained core findings.

### Task 1: Honest status

**Files:** `src/storage/untappd_had.ts`, `untappd_had.test.ts`, `checkin_sync_state.ts`, `checkin_sync_state.test.ts`, `src/bot/commands/status.ts`, `status-build.ts`, `status-build.test.ts`, new `status.test.ts`, `src/i18n/types.ts`, `src/i18n/locales/{uk,pl,en}.ts`.

**Interfaces:** `countHadWithoutCheckins(db, telegramId): number`; `SyncState.updated_at: string | null`; `StatusView.lastSyncAt: string | null`, `StatusView.hadWithoutCheckins: number`.

- [x] First test equality/over-count no longer renders ✅, unknown sync shows no-sync text, known activity shows UTC date/time, profile-total copy identifies the last sync, and nonzero missing-beer counts give a sync suggestion in every locale.
- [x] Test per-user anti-join: count distinct had beers absent from that user's check-ins irrespective of rating or observation date. A repeat check-in and another user's check-in do not alter the answer. After importing the user's check-in, count decreases.
- [x] Test sync-state reader returns the stored timestamp or NULL, without changing API wire payloads (routes map explicit fields).
- [x] Exercise actual `/status` middleware using a real in-memory DB and a Telegraf harness, capturing outgoing HTML instead of contacting Telegram.
- [x] Run these tests before implementation and confirm missing behavior.
- [x] Implement anti-join `SELECT COUNT(*) AS n FROM untappd_had h WHERE telegram_id = ? AND NOT EXISTS (SELECT 1 FROM checkins c WHERE c.telegram_id=h.telegram_id AND c.beer_id=h.beer_id)`.
- [x] Read `updated_at` into sync state and propagate both fields to the view. Render stored SQLite UTC time as `YYYY-MM-DD HH:mm:ss UTC`; explicitly distinguish historical total, and remove `caughtUp` entirely.
- [x] Run focused tests then full gate; commit.

### Task 2: Repair and consumer verification

**Files:** `src/domain/repair-legacy-card.ts`, `repair-legacy-card.test.ts`, `src/api/routes/match.test.ts`, `src/api/mcp/match-tool.test.ts`, `src/bot/commands/beers-build.test.ts`, `spec.md`, `extension/CHANGELOG.md`, `docs/extension-install-uk.md`.

- [x] Test manual had transfer retains source-only rating, keeps a rated canonical row on collision, fills a canonical NULL from source (including zero), and keeps MAX observation time. Canonical priority avoids treating last_seen_at as rating time.
- [x] Run repair tests before implementation, then add `user_rating` to the transfer SELECT/INSERT and `user_rating = COALESCE(untappd_had.user_rating, excluded.user_rating)` to its conflict update.
- [x] Verify existing /match and MCP consumers expose had-only ratings on exact matches, retain check-in priority, and withhold personal data for other users/anonymous/fuzzy matches. Verify a pub beer line uses a profile rating.
- [x] Document storage migration, rating priority, relink clearing, historical status and the distinction between beers and check-ins in `spec.md`. Add one user-facing extension changelog entry and install-guide explanation of automatic profile ratings.
- [x] Run focused tests, the full test/typecheck gate, and a read-only-production-snapshot migration dry run.
- [x] Review the whole branch (correctness, data safety, contracts, tests, scope); fix justified findings, then commit. Ask whether to create a PR only after concrete verified work is complete.

## Final verification and review

Full gate on 2026-09-28: 3621 tests passed, one pre-existing test skipped;
`npm run typecheck` passed. `git diff origin/main --check` passed.

SQLite online backup opened read-only from production and migrated on a local
copy from v39 to v40, twice. Existing facts unchanged: 34909 beers, 46503
check-ins, 3677 had rows, check-in rating sum, sync state and coverage. No profile
ratings invented. `PRAGMA integrity_check`: ok; `PRAGMA foreign_key_check`: empty.
The production-derived `/status` renders 12634 / 12634 without a checkmark,
sync activity 2026-09-03 22:19:05 UTC, and 53 known beers without imported check-ins.

Whole-branch review covered correctness, account isolation, migration safety,
manual had transfer, existing API wire contracts, exact/fuzzy disclosure gates,
zero/NULL distinction, and the approved scope. One retained defect was fixed:
explicit `Their Rating (N/A)` with display `data-rating="0"` now remains unknown
instead of overwriting an observed personal rating. No outstanding findings.
Review ran sequentially in the main agent under AGENTS.md; independent GitHub AI
review remains for the PR stage. Live authenticated HTML was not reprobed; parser
verification uses the archived real Untappd fixture plus focused edge cases.

Implementation is committed locally. PR creation and deployment await the user's
separate decision; the existing #611 account-history behavior remains unchanged.

## PR #724 review corrections

The user authorized push and PR creation. AI review identified an account-link
ABA race and a status hint tying a retained total to the latest sync activity.

- [x] Extend the design with a persisted account-link revision: increment only
  for real username changes, then compare before scrape writes. Start at zero
  without claiming any past link history.
- [x] Reproduce old → new → old during the HTTP request and retained totals after
  a null-total sync in failing tests before implementation.
- [x] Extend unreleased migration v40 with the revision column and verify
  migration replay and unchanged case-only links. Change all three locale hints
  to say last known total, without associating it with the activity timestamp.
- [x] Full gate: 3622 passed, one existing skip; typecheck passed. Repeat v39 →
  v40 migration twice on a fresh read-only production backup: hashes of every old
  column in beers, checkins, had, profiles, sync state and coverage unchanged;
  no non-null ratings or nonzero revisions invented, integrity ok, FK check empty.

The next review identified a second-connection race between the revision read
and writes. A two-connection SQLite test reproduced a successful concurrent
relink before the fix; an immediate transaction now holds the writer lock across
the guard and page writes, and the test verifies the competing relink is blocked
until those writes finish, then clears the ratings after acquiring the lock.
