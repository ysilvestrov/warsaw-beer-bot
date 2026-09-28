# #611 Account History Periphery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Follow the repository's sequential tool mapping. Steps use checkbox syntax.

**Goal:** Prevent delayed imports/feed pages from writing into another linked account and make clients report the active account's sync result.

**Architecture:** Use the reviewed `HistoryOwner` and existing revision as the write context. Validate that context inside immediate transactions before catalog/history mutation. Keep the existing feed traversal and extension status machinery.

**Tech Stack:** Node.js >=24, TypeScript, better-sqlite3/WAL, Hono/Zod, Vitest and the existing extension/Vite; no new dependencies.

**Spec:** [Approved design](../../specs/2026-09/2026-09-28-611-account-history-design.md), `spec.md`, and [core review](../../../reviews/2026-09-28-611-core.md). The core review has no unresolved local defects; the external pass produced no receipt and is explicitly degraded.

## Global constraints

- Continue in `/home/ysi/warsaw-bb-codex/.worktrees/issue-611`, branch `fix/issue-611`, core head `c6617ea`.
- Separate histories remain keyed by `(telegram_id, account_key)`. Keep A → B → A restoration, first-link adoption, zero ratings and established coverage. Never derive coverage from imports or equal counts.
- A case-only relink does not change revision; every genuine switch does, including ABA.
- Existing migration mapping rests on the user's confirmation about the four history owners. Recheck the affected population before deployment; resolve ambiguous/new ownership individually.
- No account picker, deletion, username-rename recognition, traversal redesign or unrelated refactor.
- Preserve the main checkout's `AGENTS.md` monitoring reminder outside this branch.
- Each implementation task: failing focused regressions, smallest implementation, passing focused tests, full `npm test && npm run typecheck`, then a local commit. For extension changes also run its test/typecheck/build gate.
- Never deploy the core alone. This plan authorizes implementation only when the user accepts execution; production writes, deployment and store publishing require their own authorization. Ask about a PR after the concrete branch is verified.

## Reviewed contracts

```ts
interface HistoryOwner { telegramId: number; accountKey: string; linkRevision: number }
getHistoryOwner(db, telegramId): HistoryOwner
isCurrentHistoryOwner(db, owner): boolean
```

`isCurrentHistoryOwner` is a guard only inside the same immediate transaction as the protected writes. Missing profiles resolve to `''`/0. `CheckinInput.account_key` and optional final `accountKey` parameters on `markHad`, `checkinExists`, `countCheckins`, `oldestCheckinId`, coverage helpers, `getSyncState` and `recordProfileTotal` already exist. Pass captured keys at asynchronous writers; do not depend on the transitional current-owner default.

`ProfileRow.legacy_sync_revision` is initialized by migration/first link and never advanced by later switches. Compound storage reads use read transactions; API response construction must also keep its profile/count/state in one context.

### Task 1: Enforce feed binding and preserve legacy compatibility

**Files:** `src/api/routes/checkins.ts`, `src/api/routes/checkins.test.ts`, `spec.md`.

**Consumes:** reviewed owner helpers, `getProfile`, explicit-key history repositories.
**Produces:** GET state includes `linkRevision: number`; POST accepts optional `linkRevision: number` and rejects stale contexts before any mutation.

- [ ] Add endpoint regressions using existing `setup`, `get`, `post`, `PAGE_ONE` and `PAGE_BOTTOM`: fresh/unchanged binding accepts legacy pages; matching revision accepts pages; stale A and ABA revisions return exactly `409 {error:'account_changed'}`; missing revision after a switch returns exactly `409 {error:'sync_context_required'}`. Case-only relink preserves acceptance. Invalid revisions (null, negative, fraction, unsafe integer, string) fail validation. Unlinked profiles retain `not_linked`.

```ts
const { db, app } = setup();
const a = getHistoryOwner(db, TELEGRAM_ID);
setUntappdUsername(db, TELEGRAM_ID, 'other');
const res = await post(app, '/checkins/sync',
  { html: PAGE_ONE, linkRevision: a.linkRevision }, RAW_TOKEN);
expect(res.status).toBe(409);
expect(await res.json()).toEqual({ error: 'account_changed' });
```

Assert exact history, coverage, sync-state and catalog rows before/after rejected requests, including empty pages. An error response alone cannot establish no mutation. Test GET username/revision/count/state consistency under an injected switch from a second WAL connection.

- [ ] Run the endpoint suite and verify the failures concern missing context guards.
- [ ] Extend `SyncBody` with `z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()`. Wrap the GET response's profile/owner/count/state reads in a read transaction. Wrap POST's current-profile check, empty-page branch, catalog/history writes and response-derived counts/ranges in one immediate transaction. Preserve existing block/cursor/no-session behavior.

Inside that transaction, after the existing linked-profile check and before mutations:

```ts
const owner = getHistoryOwner(deps.db, telegramId);
if (linkRevision !== undefined && linkRevision !== owner.linkRevision)
  return c.json({ error: 'account_changed' }, 409);
if (linkRevision === undefined && profile.legacy_sync_revision !== owner.linkRevision)
  return c.json({ error: 'sync_context_required' }, 409);
```

Pass `owner.accountKey` to every check-in/count/coverage/total operation, and `account_key: owner.accountKey` to `mergeCheckin`. Construct the accepted response within the same transaction. Returning an HTTP Response from the synchronous transaction callback preserves Hono's existing handler contract.

- [ ] Make §feed/API guarantees in `spec.md` concrete; do not change the caught-up rule. Run focused tests and the backend gate, then commit `fix(api): reject stale Untappd sync contexts (#611)`.

### Task 2: Bind imports and scraper observations to their starting account

**Files:** `src/bot/commands/import.ts`, `import-checkins.ts`, `import-checkins.test.ts`; new `src/bot/commands/import.test.ts`; `src/jobs/refresh-untappd.ts` and its tests; `src/i18n/locales/{uk,pl,en}.ts`, `spec.md`.

**Consumes:** `HistoryOwner`, immediate guard and explicit writer keys.
**Produces:** `importCheckins(db, telegramId, rows, owner?)` where omitted owner is captured inside the synchronous batch transaction for existing callers; exported `ImportAccountChangedError` identifies interrupted attribution. The async command always supplies its original owner.

- [ ] Add failing batch tests: captured A rejects after B or ABA, with zero new catalog/history rows; captured unlinked import rejects after first-link adoption; committed earlier batches remain under A and are restored on relink; another Telegram user's changes do not interrupt it. Extend the existing delayed-scraper regression to assert all observations stay with their captured owner.
- [ ] Add command tests with a mocked export stream/file download: switch during download, between batches, and during busy retry. Assert exact committed counts, interruption copy and no success message for the newly active account. Do not mock `importCheckins` away: run it against real SQLite.
- [ ] Run those suites and confirm stale-owner failures. Implement the batch guard before beer upserts:

```ts
export class ImportAccountChangedError extends Error {
  constructor() { super('Untappd account changed during import'); }
}
// Within db.transaction(...).immediate():
const captured = owner ?? getHistoryOwner(db, telegramId);
if (captured.telegramId !== telegramId || !isCurrentHistoryOwner(db, captured))
  throw new ImportAccountChangedError();
// Every mergeCheckin receives account_key: captured.accountKey.
```

Capture the command owner immediately after `ensureProfile`, before the first awaited download call. Pass the same owner through every `withBusyRetry` batch attempt. Increment `total` only after a committed batch. Catch the typed interruption separately, stop/destroy the export stream, report the committed count and captured account, and return without the normal success message. Recheck the binding before terminal success; preserve existing handling of parse/network failures.

- [ ] In `refresh-untappd`, retain the existing immediate username/revision guard and pass the normalized captured key to `markHad`; test delayed A/B/ABA responses and case-only changes. Add interruption text in all three locales; user copy says which import stopped and how many rows were saved, without implementation vocabulary.
- [ ] Run focused tests/backend gate, update the ingestion guarantees in `spec.md`, commit `fix(bot): bind imported and scraped history to its account (#611)`.

### Task 3: Send revisions and isolate extension status

**Files:** `extension/src/api/{types,client}.ts` and client tests; `extension/src/background/{handle-checkin-sync,index}.ts` and tests; `extension/src/popup/popup.ts` and tests; `extension/CHANGELOG.md`, `docs/extension-install-uk.md`.

**Consumes:** task 1 GET `linkRevision`, POST revision and the two new 409 codes.
**Produces:** `CheckinSyncState.linkRevision: number`; `submitPage(html,maxId,linkRevision)`; `SyncStatus` includes `account_changed` and `sync_context_required`; cached run reports carry their binding.

- [ ] Add failing client tests for exact POST JSON including revision and parsing each 409 response by its JSON error code. Preserve `not_linked`; unknown/malformed errors remain generic server errors. Append the revision parameter to `postCheckinSyncPage` after existing parameters so signal/timeout callers are not silently reordered.
- [ ] Add sync-runner regressions: every submitted page carries the initially fetched revision; missing/invalid server revision prevents fetching/submitting; both new errors stop immediately, produce no subsequent pages or successful completion, and preserve the run's committed merged count.

```ts
submitPage: (html, maxId, linkRevision) =>
  postCheckinSyncPage(baseUrl, token, html, maxId,
    controller.signal, undefined, linkRevision)
```

Set `complete` false for context errors even when cached counts happen to agree. The runner must not reinterpret the rejected old run as a new account's success.

- [ ] Add background/popup regressions: completed A status is not displayed for B or ABA; legacy stored reports without binding are discarded; same binding retains status; failed current-state validation cannot establish a cached completion; worker recovery and queued progress writes cannot restore an obsolete binding.
- [ ] Store captured username/revision with each progress/terminal report and compare against a fresh authenticated state before reuse. Also compare the run's settings/token/base URL with current settings, so changing credentials cannot reuse another user's report. On mismatch, invalidate the old report and clear personal match cache through existing `handleCacheClearAll`; expose current counts only from the fresh state. Serialize status writes through the existing chain. Do not add polling, account-picker UI or a new cache architecture.
- [ ] Display specific popup messages for account change/update requirement. Add one user-facing Unreleased changelog entry describing wrong-account history/sync status and its corrected behavior. Update the install guide with preserved/restored histories and the old-client update requirement after changing accounts. Do not publish to the store.
- [ ] Run `npm test && npm run typecheck` in the backend, and `npm --prefix extension test && npm --prefix extension run typecheck && npm --prefix extension run build`; commit `fix(extension): scope check-in sync to the linked account (#611)`.

### Task 4: Whole-branch integration, bot messages and shipping preparation

**Files:** `src/bot/commands/link.ts`, `link.test.ts`, `src/i18n/locales/{uk,pl,en}.ts`; `src/api/routes/match.test.ts`, `src/api/mcp/match-tool.test.ts`, `src/bot/commands/status.test.ts`; `spec.md`; review evidence and deployment preflight document under `docs/reviews/`.

**Consumes:** completed guarded ingestion and revision-aware client from tasks 1–3.
**Produces:** end-to-end evidence for #611 and a concrete branch ready for the user's PR decision.

- [ ] Add failing `/link` message tests for first link, case-only link, real switch and restoration; implement plain localized copy explaining that the selected account's history is shown, the other history is saved, and sync/update may be needed. Keep the existing username parser.
- [ ] Add `/match`, MCP and bot-status regressions using real repositories: A ratings/drunk/counts exclude B, fresh B with fewer check-ins does not inherit caught-up state, B's observations do not alter A, and A is restored on relink. Assert exact response fields (including zero ratings and unknown-vs-not-drunk MCP evidence), rather than only storage results.
- [ ] Verify one whole sequence through accepted feed page A → switch B → delayed rejected A page → accepted B page → switch A → restored counts/coverage. Include ABA stale-page rejection and two users with the same username/check-in IDs. Reuse existing fixture pages and authenticated endpoint setup; do not duplicate production traversal logic in tests.
- [ ] Run focused regressions, full backend test/typecheck/build and extension test/typecheck/build. Review the entire branch against the approved design, migration/ingestion contracts and all user-visible copy. Apply valid findings with regression tests and repeat affected gates. Record external-review failure explicitly if independent corroboration is unavailable; do not report an absent receipt as approval.
- [ ] Finish `spec.md`: remove the core-incomplete note only after every pending guarantee has implementation and integration evidence. Verify every row of the design's claims/evidence table has its guard or provenance.
- [ ] Prepare a read-only production preflight and SQLite backup/replay procedure based on the core verification. Confirm migration 41 is still free on current upstream; if not, append the account-history migration after upstream's head without renumbering existing migrations. Recheck that ownership provenance still covers the affected users. Any new ambiguous history requires an individual decision before deployment.
- [ ] Document rollback using the pre-migration database backup plus matching binary; the old binary must never run against the migrated schema. Use `deploy/README.md` procedures and verify runtime health after an authorized deployment. Store submission remains a maintainer action; any later release PR must merge before `npm run release:store`.
- [ ] Commit the verified final copy/tests/docs. Ask whether to create a PR. Once authorized, fetch `origin/main`, rebase if moved, repeat the full gates after any rebase, push and open the PR. Wait for CI and AI-review results, evaluate comments technically and address valid findings before reporting readiness. No deployment/issue closure solely because the PR exists.
- [ ] After an authorized deployment succeeds and health is verified, remove only clean worktrees/branches whose PR is confirmed merged; preserve unrelated/dirty work and raw resource-monitoring artifacts.

## Completion boundary

This plan is ready for execution after user acceptance. #611 is complete only when guarded ingestion, legacy compatibility, binding-scoped extension reports, exact integration tests and whole-branch review are done. Production deployment and closing the issue follow the user's authorized shipping flow; they are not implied by planning or by the core's green tests.
