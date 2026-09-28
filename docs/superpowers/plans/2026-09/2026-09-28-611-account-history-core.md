# #611 Account History Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Follow this repository's tool mapping: execute sequentially in the main thread. Steps use checkbox syntax for tracking.

**Goal:** Store and read each Telegram user's history separately for each linked Untappd username, preserving archived history through switching and beer merges.

**Architecture:** Add `account_key` to the existing four history tables and scope existing repositories by `(telegram_id, account_key)`. Capture ownership explicitly for writers; preserve current reader signatures by resolving the active account internally. `/link` changes the active binding transactionally without deleting another account's history.

**Tech Stack:** Node.js >=24, TypeScript, better-sqlite3/SQLite WAL, Vitest; no new dependencies.

**Spec:** [Approved design](../../specs/2026-09/2026-09-28-611-account-history-design.md), approved by the user on 2026-09-28. Read it together with `spec.md` before execution.

## Global constraints

- Worktree: `/home/ysi/warsaw-bb-codex/.worktrees/issue-611`; branch: `fix/issue-611`; starting commit: `3aa7e94`.
- Preserve the main checkout's pending operational reminder in `AGENTS.md`; it is unrelated to #611 and must not enter this branch.
- Keep separate histories for every `(telegram_id, normalized username)`; the empty key denotes unlinked imports.
- Existing production history is assigned to current linked usernames because the user explicitly confirmed those four users never switched accounts. Do not infer this from counts or revision values.
- No account picker, history deletion, automatic username-rename recognition, new dependencies, or traversal redesign.
- Every task gets a red/green focused regression cycle, the full `npm test && npm run typecheck` gate, and a commit containing only its files.
- This core is deliberately incomplete as a deployable feature. Import/network race protection and extension compatibility belong to the next plan. Do not deploy, push, open a PR, close #611, or mark the whole issue fixed from this plan alone.
- Do not mutate production data. Inspect a database copy for migration verification; retain raw resource-monitoring artifacts.
- Use exact expected assertions, deterministic test paths, and explicit constants. Assert this migration's recorded version, not a growing global head.

## Scope and stage boundary

The design remains whole; this plan implements only its core mechanism. Tasks 1–3 build that mechanism, and task 4 reviews the complete core. Only after that review create a separate periphery plan using the actual resulting interfaces. That later plan must cover captured-owner ingestion, feed revision enforcement and legacy-client compatibility, extension cached status, bot messages, installation docs/changelog, production preflight/backup, and whole-branch integration tests.

The current migration head is 40. Reserve 41 for this work only if it is still free when execution starts; if upstream introduces a new migration, append after it and update only the new migration's tests and this plan's literal version. Do not renumber an upstream migration or pin old migration tests to the new head.

## File map and interfaces

- `src/storage/schema.ts`: one transactional account-history migration; export its SQL constant for exact migration replay tests, following `V23_BACKFILL_SQL`.
- New `src/storage/history-owner.ts`: the small shared representation of an account binding and normalization; no I/O outside the injected SQLite connection.
- `src/storage/checkins.ts`, `untappd_had.ts`, `checkin_coverage.ts`, `checkin_sync_state.ts`: owner-scoped history SQL.
- `src/storage/user_profiles.ts`: revision/baseline fields and atomic first-link adoption/switching.
- Catalog deletion paths: `src/storage/beers.ts`, `src/domain/pin-match.ts`, `src/domain/repair-legacy-card.ts`, `src/jobs/dedupe-brewery-aliases.ts`, `src/jobs/cleanup-polluted-ontap.ts`.
- `spec.md`: document core schema and isolation, while marking client/ingestion guarantees as pending the periphery stage.
- Tests stay alongside each existing owning module; add `src/storage/history-owner.test.ts` for the new helper.

Define these shared contracts in task 1:

```ts
export interface HistoryOwner {
  telegramId: number;
  accountKey: string;
  linkRevision: number;
}
export function accountKeyFor(username: string | null): string;
export function getHistoryOwner(db: DB, telegramId: number): HistoryOwner;
export function isCurrentHistoryOwner(db: DB, owner: HistoryOwner): boolean;
```

`accountKeyFor(null)` returns `''`; a username returns `.toLowerCase()`. `getHistoryOwner` directly selects `untappd_username, untappd_link_revision` from `user_profiles`, avoiding a circular dependency on `user_profiles.ts`. Missing profiles resolve to empty key/revision 0, matching existing history helpers' support for pre-link fixtures. `isCurrentHistoryOwner` compares both key and revision; its return value is not an atomic write guard unless used inside the caller's writer transaction.

`CheckinInput` gains optional `account_key?: string`; `CheckinRow` exposes a required `account_key: string`. `mergeCheckin` uses the supplied key or the current owner for existing synchronous callers. This fallback is transitional: the later ingestion plan must pass a captured key at every asynchronous writer.

Append an optional `accountKey?: string` parameter to these existing functions; default only an omitted key, preserving explicit `''` with `??`, never `||`:

```ts
markHad(db, telegramId, beerId, at, userRating?, accountKey?): void
checkinExists(db, telegramId, checkinId, accountKey?): boolean
countCheckins(db, telegramId, accountKey?): number
oldestCheckinId(db, telegramId, accountKey?): number | null
coverageFor(db, telegramId, accountKey?): CoverageRange[]
addCoverage(db, telegramId, from, to, accountKey?): void
rangeContaining(db, telegramId, id, accountKey?): CoverageRange | null
deepestCoveredId(db, telegramId, accountKey?): number | null
getSyncState(db, telegramId, accountKey?): SyncState
recordProfileTotal(db, telegramId, profileTotal, accountKey?): void
```

Preserve existing signatures of `checkinsForUser`, `latestRatingsByBeer`, `hasBeenDrunk`, `latestCheckinAt`, `countDistinctBeers`, `drunkBeerIds`, `hadBeerIds`, `triedBeerIds`, and `countHadWithoutCheckins`; each reads the active owner. In joined/union reads both sides must use the same captured active key.

### Task 1: Migrate history keys and scope repository access

**Files:** `src/storage/schema.ts`, new `src/storage/history-owner.ts`, the four history repositories listed above, `src/storage/user_profiles.ts` (row type only), `src/domain/repair-legacy-card.ts` (mechanical conflict-key compatibility), `spec.md`; their colocated tests.

**Consumes:** existing migration runner, existing history repositories, confirmed migration mapping.

**Produces:** the shared contracts above; `ProfileRow.legacy_sync_revision: number | null`; owner-scoped uniqueness and reads. Preserve the existing `/link` implementation until task 2.

- [x] Write failing migration regressions using a literal v40 fixture containing `user_profiles`, `beers`, and all four old history tables, with foreign keys enabled. Seed linked username `Old_Name`, revision 3, and unlinked user 2. Execute the exported new migration SQL itself, not a copy of its transformation algorithm. Assert complete preserved rows, including IDs, nulls, dates, personal rating 0, and existing coverage; expect linked key `old_name`, unlinked key `''`, linked legacy baseline 3 and unlinked baseline null.
- [x] Add a normal fresh-DB migration test asserting `SELECT version FROM schema_version WHERE version = 41` yields exactly `{ version: 41 }`, plus `PRAGMA foreign_key_check` returning `[]`. Re-running `migrate` preserves the exact seeded rows.
- [x] Add repository regressions with explicit owners before relying on `/link`: the same Telegram user stores check-in `123` in keys `a` and `b`; another user stores `123` in key `a`. Assert all three distinct rows exist. Set the active profile username directly to `a`, then `b`, and assert exact check-in counts, rating maps, tried sets, oldest IDs, profile totals, and coverage for each owner.
- [x] Run `npm test -- src/storage/schema.test.ts src/storage/history-owner.test.ts src/storage/checkins.test.ts src/storage/untappd_had.test.ts src/storage/checkin_coverage.test.ts src/storage/checkin_sync_state.test.ts`. Confirm failures concern missing key/isolation, not fixture corruption.
- [x] Implement the migration with replacement tables using the existing schema's full column definitions, defaults, checks, and foreign-key actions. Keep check-in IDs and preserve autoincrement high-water state, including when the greatest historical ID was deleted. Copy using this owner expression:

```sql
COALESCE((SELECT lower(p.untappd_username)
          FROM user_profiles p WHERE p.telegram_id = old.telegram_id), '')
```

  The new keys are `UNIQUE(telegram_id, account_key, checkin_id)`, `PRIMARY KEY(telegram_id, account_key, beer_id)`, `PRIMARY KEY(telegram_id, account_key, from_id)`, and `PRIMARY KEY(telegram_id, account_key)` respectively. Create replacement tables, copy explicit columns, drop old tables, rename replacements, then recreate indexes. There are no inbound references to these four tables in the current schema. Keep `foreign_keys=ON`; a failed statement rolls back through the existing migration transaction.

```sql
ALTER TABLE user_profiles ADD COLUMN legacy_sync_revision INTEGER;
UPDATE user_profiles SET legacy_sync_revision = untappd_link_revision
 WHERE untappd_username IS NOT NULL;
```

- [x] Implement owner resolution and modify all history inserts/conflict targets/selects. Representative check-in SQL:

```sql
INSERT INTO checkins
  (checkin_id, telegram_id, account_key, beer_id, user_rating, checkin_at, venue)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(telegram_id, account_key, checkin_id) DO UPDATE SET
  beer_id = excluded.beer_id,
  user_rating = excluded.user_rating,
  checkin_at = excluded.checkin_at,
  venue = excluded.venue;
```

  Preserve timestamp canonicalization and existing rating semantics. For `countHadWithoutCheckins`, add `h.account_key = ?` and `c.account_key = h.account_key`; a check-in in archived A must not hide B's scraped-only beer. Every coverage overlap query and delete includes the owner. `getSyncState` passes the same explicit key to `deepestCoveredId`.
- [x] Update the legacy repair's existing observation-copy SQL mechanically in this task: include `account_key` in its insert/select and use `ON CONFLICT(telegram_id, account_key, beer_id)`. Otherwise the new schema breaks this existing path and the full gate before task 3. Task 3 replaces that compatible inline statement with the shared owner-preserving operation; it owns changes to the other deletion paths.
- [x] Update raw-SQL fixtures/conflict targets that assume old keys. A fixture writing history for a linked user must specify that account's key explicitly; omission must not accidentally put it in the empty bucket. Historical migration replays in `schema.test.ts` must genuinely start from the intended schema: add an explicit test-only v40 history fixture restoration helper before undoing/replaying older migrations, preserving any rows needed by that test. Reuse it in `dropV39AuditColumns`, the v40 replay, and every earlier replay that currently starts from a fully migrated database. Do not merely delete a version marker while leaving v41 tables and columns installed. Existing earlier tests still assert their own migration facts.
- [x] Update `spec.md` table keys and active-history semantics. Do not claim async stale responses are protected yet.
- [x] Run focused tests, then `npm test && npm run typecheck`; inspect `git diff --check`. Commit task-owned files with `feat(storage): partition Untappd history by linked account (#611)`.

### Task 2: Make `/link` transitions atomic and reversible

**Files:** `src/storage/user_profiles.ts`, `src/storage/user_profiles.test.ts`, `src/storage/history-owner.test.ts`, `spec.md`.

**Consumes:** task 1's owner keys, repositories, and `legacy_sync_revision` field.

**Produces:** existing `setUntappdUsername(db, telegramId, username): void` with a complete immediate transaction. No new public bot command or response shape in this core stage.

- [x] Replace the #612 test that expects another account's scraped ratings to be cleared. Seed A with check-in `123`, rating 4, scraped-only beer rating 0, profile total 100, and coverage 1000–1099. Switch to B and assert active count 0, ratings `[]`, tried IDs `[]`, null cursor/total, and unchanged archived A rows. Seed B, switch back to A, and assert restoration of all A values with none of B's observations.
- [x] Add case-only, fresh empty account, unlinked import adoption, same username across two Telegram users, and A → B → A revision tests. Exact revision progression for first link/A/B/A is 1/2/3; case-only remains 1. The first-link legacy baseline is 1 and remains 1 through all later switches. A captured owner from the first A binding must fail `isCurrentHistoryOwner` after returning to A.
- [x] Add adoption collision tests: a pre-existing named destination and an empty bucket both contain check-in `123`. Preserve the named non-null beer/rating/venue, fill only missing fields from the unbound row, and keep the named timestamp unless it is absent in a deliberately constructed legacy fixture. Scraped collisions retain the later observation and its non-null rating, with deterministic named-destination precedence at equal observation time. First linking must not create or transfer unbound coverage or sync totals as evidence for the named account. Normally unbound imports have neither; treat unexpected unbound sync metadata as unproven and leave it archived.
- [x] Run `npm test -- src/storage/user_profiles.test.ts src/storage/history-owner.test.ts`; see the old clearing/retention semantics fail the new isolation/restoration assertions.
- [x] Implement `setUntappdUsername` using `.immediate()` and this transition order:

```ts
const previous = getProfile(db, telegramId);
const same = accountKeyFor(previous?.untappd_username ?? null) === accountKeyFor(username);
// same key: update display spelling only; no revision/baseline/history mutation.
// changed key: adopt unbound imported observations only on the first link;
// increment revision; first link initializes legacy baseline to the new revision;
// later switches preserve that baseline and all archived observations.
```

  For adoption use owner-keyed `INSERT ... SELECT ... WHERE account_key = ''` with explicit collision handling, followed by deletion of only the adopted empty-key check-ins and scraped observations. Keep all other owners unchanged. Never clear named account ratings, coverage, or totals. Keep the entire transition, including adoption and profile update, inside one writer transaction.
- [x] Add a rollback regression that forces the adoption write to fail (a temporary SQLite trigger raises `ABORT` for the destination insert), and assert profile username/revision/baseline and all old rows remain exactly unchanged. Add a two-connection binding test with a temporary database to validate visibility of the completed transition and invalidation of a captured old owner.
- [x] Update `spec.md` to replace #612's rating-clearing rule with archived preservation; explain empty-bucket adoption and username-key limitations. User-visible success copy remains a periphery requirement.
- [x] Run focused tests and the full backend gate; commit with `fix(storage): preserve and restore history on account switches (#611)`.

### Task 3: Preserve every owner's observations through beer repair and merges

**Files:** `src/storage/untappd_had.ts`, `src/storage/beers.ts`, `src/domain/pin-match.ts`, `src/domain/repair-legacy-card.ts`, `src/jobs/dedupe-brewery-aliases.ts`, `src/jobs/cleanup-polluted-ontap.ts`; their existing tests, including `src/storage/beers.test.ts`.

**Consumes:** account-keyed observations and existing catalog mutation transactions.

**Produces:** a narrow reusable SQL operation in the existing observation repository:

```ts
export function mergeHadBeerReferences(db: DB, fromBeerId: number, toBeerId: number): void;
```

The helper is called inside each existing caller's transaction, before deleting the source beer. It preserves all owners and fills a missing canonical rating from the source; it does not resolve an active profile or open another connection.

- [x] In existing merge tests seed observations for user 1/account A, user 1/account B, and user 2/account A. Include a target collision for only user 1/account A. Exercise each actual merge entry point; assert exact surviving `(telegram_id, account_key, beer_id, last_seen_at, user_rating)` tuples, redirected check-ins, and deleted source beer. Switching A/B after the merge must restore each account's own tried/rating results.
- [x] Run the existing focused suites: `npm test -- src/storage/untappd_had.test.ts src/storage/beers.test.ts src/domain/pin-match.test.ts src/domain/repair-legacy-card.test.ts src/jobs/dedupe-brewery-aliases.test.ts src/jobs/cleanup-polluted-ontap.test.ts`. Expected failures are missing/cross-owner observations or an old conflict target.
- [x] Add the helper using the following conflict rule, matching the current legacy repair's canonical-rating precedence:

```sql
INSERT INTO untappd_had
  (telegram_id, account_key, beer_id, last_seen_at, user_rating)
SELECT telegram_id, account_key, ?, last_seen_at, user_rating
FROM untappd_had WHERE beer_id = ?
ON CONFLICT(telegram_id, account_key, beer_id) DO UPDATE SET
  last_seen_at = MAX(untappd_had.last_seen_at, excluded.last_seen_at),
  user_rating = COALESCE(untappd_had.user_rating, excluded.user_rating);
```

  Call it from `mergeIntoCanonical`, the canonical-merge branch of `pinMatch`, and both cleanup jobs before their `DELETE FROM beers`. Replace the legacy repair's inline old-key copy with this helper; if `mergeIntoCanonical` already performs the copy, remove the redundant repair copy instead. Keep existing reference redirection, dispositions, alias behavior, and catalog-version bumps intact.
- [x] Add a transaction failure regression through a real caller: a forced delete failure must not leave partially copied observations or redirected check-ins. Preserve existing FK behavior; never disable foreign keys to make the merge pass.
- [x] Run focused suites and the full backend gate; commit with `fix(storage): preserve account history across catalog merges (#611)`.

### Task 4: Review the entire core before planning clients and ingestion

**Files:** all core changes; this plan and the approved design. Review findings and the next-stage plan go under the current month's docs folders.

**Consumes:** all three tasks' complete diff and verification evidence, including any inline work.

**Produces:** a core review receipt with resolved findings and exact final interfaces for the periphery. This is a stage gate, not a shipping gate.

- [x] Review the whole diff against the design with the repository's `ce-code-review` workflow and sequential tool mapping. Include migration safety, correctness, API compatibility of transitional repository parameters, and all catalog deletion paths. Explicitly identify unimplemented periphery guarantees so review does not mistake the core for a deployable fix.
- [x] Search all non-test source for history SQL and source-beer deletion; verify each user-facing reader has an owner predicate and each relevant merge preserves all owners. Commands:

```bash
rg -n 'FROM checkins|JOIN checkins|FROM untappd_had|JOIN untappd_had|FROM checkin_coverage|FROM checkin_sync_state|DELETE FROM beers' src --glob '*.ts' --glob '!*.test.ts'
git diff origin/main -- src/storage src/domain src/jobs spec.md
```

- [x] Test migration on a safely copied production database obtained with SQLite's backup API, not an ordinary copy of a live WAL database. Assert per-user assignment, exact selected rows and coverage, foreign-key validity, and ID allocation preservation. Keep all access read-only against production; application writers run only against the copy. Do not use this check to establish external provenance: that remains the user's confirmation.
- [x] Resolve valid findings, repeat the affected focused tests and full gate after changes, and record the final commit plus commands/results. No PR or production deployment from this stage.
- [x] Write the separate periphery plan only after review, using the reviewed `HistoryOwner`, baseline and writer interfaces. Include imports and scraper captured ownership, GET/POST `linkRevision`, `account_changed` and `sync_context_required`, legacy baseline enforcement, extension handling/cached-status isolation, `/link` messages in all locales, guide/changelog updates, and `/match`/MCP/whole-branch regressions. The final shipping stage must ask whether to create a PR, refresh/rebase `main`, rerun the full gate after a rebase, and wait for CI/AI review before reporting readiness.

## Completion evidence and remaining work

Core is complete only when task 4 has no unresolved core defects and the exact tested migration and repository interfaces are recorded. This plan never asserts that #611 is fixed for end users. The later periphery must close asynchronous cross-account writes and cached-client-state gaps before deployment.

Spec coverage is intentional: storage/ownership, scoped reads, reversible transitions, and catalog preservation are here; ingestion/API/client behavior and deployment are deferred explicitly to the reviewed next stage. Execute sequentially; do not write that next plan against a mechanism that has not yet been built and reviewed.


## Executed stage record — 2026-09-28

Tasks 1–4 completed sequentially in the isolated worktree. Commits: `aff502a` (migration/repositories), `7c4af24` (link adoption/switching), `87d7c0b` (catalog merges), `9c4d0cc` (review-discovered mixed-snapshot correction), `c6617ea` (owner contracts). The final full gate passed 3869 tests with one pre-existing skip; typecheck passed. Focused red/green evidence and exact production-copy migration results are in [the review record](../../../reviews/2026-09-28-611-core.md). Planned test selections were also covered by the full gate; the owner test file was added during final review.

Review used the repository's sequential main-context mapping. The cross-model job produced no receipt by its shared deadline and ended `died-without-result`; it was collected and cleaned up. Independent corroboration is unavailable, not silently counted as approval. No unresolved core defect remains in the local review.

The [periphery plan](2026-09-28-611-account-history-periphery.md) was written only after that review finished. It has not been executed or approved for execution yet. Core remains intentionally unshippable; no push, PR, production mutation, deployment or issue closure occurred.
