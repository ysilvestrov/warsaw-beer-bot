# #611 — Separate history for each linked Untappd account

Status: approved; core and periphery implemented locally. Deployment remains a separate authorized step.

Issue: https://github.com/ysilvestrov/warsaw-beer-bot/issues/611

## Purpose and agreed decisions

Changing `/link` must never make one account's check-ins, ratings, or feed coverage describe another account. Preserve each account's history and restore it when the user links that account again. Account switching is exceptional: protection against mistakes and support for testing, rather than a new account-management product.

The user chose separate histories and confirmed that the four existing production users with check-ins have not changed accounts, then explicitly extended that confirmation to both had-only owners during final preflight. Accordingly, the migration assigns their existing history to their currently linked username without asking them to confirm it. This is an operator-confirmed provenance decision, not an inference from counts or revision values.

No account picker or delete-history feature is added. `/link` remains the switching interface. First linking and linking the same username remain straightforward; username comparison is case-insensitive.

## Evidence and current behavior

A replay against the existing storage functions in an in-memory database seeded account A with 100 check-ins and coverage 1000–1099, then linked account B and recorded B's profile total of 30. Observed: `serverCount=100`, inherited cursor `1000`, one coverage range, `caughtUp=true`, and A's beer still marked drunk. No production data was changed.

`setUntappdUsername` already increments `untappd_link_revision` for a case-insensitive change and clears scraped ratings (#612), but preserves all history. The feed endpoint receives only HTML and a cursor: it cannot know whether a request was fetched before a relink. The scheduled profile scraper already checks username and revision in an immediate transaction before recording observations.

Production read-only inspection on 2026-09-28 found 46,577 check-ins across four users, all currently linked. Final preflight also identified two had-only owners (no imported check-ins); the user explicitly confirmed that neither changed accounts. These numbers describe scope only; they do not prove the rows' provenance. The user's explicit confirmation is the migration's evidence for that provenance.

Imports currently work without a linked username, and the parsed export does not carry a verified account identity. Canonical beer merges and the legacy-card repair path also touch history; they must preserve account ownership.

## Storage and ownership

Use a normalized `account_key` in the existing history tables rather than a new account-management layer. A named account's key is its ASCII username lowercased; username parsing already admits only ASCII letters, digits, underscore, dot, and hyphen. The owner is the pair `(telegram_id, account_key)`, never username alone. Two Telegram users linking the same username retain separate histories.

Add a non-null `account_key` to `checkins`, `untappd_had`, `checkin_coverage`, and `checkin_sync_state`. Update their uniqueness and lookup indexes to include it:

- check-ins: `(telegram_id, account_key, checkin_id)`;
- scraped observations: `(telegram_id, account_key, beer_id)`;
- coverage: `(telegram_id, account_key, from_id)`;
- sync state: `(telegram_id, account_key)`.

Retain check-in row IDs, beer references, ratings, dates, venues, and existing coverage values. The migration must replace existing uniqueness constraints, not merely add a second index. Rebuild tables transactionally where SQLite requires it and recreate their indexes. Validate foreign keys and exact representative row values, not only row counts.

The empty key represents imports made before the first link. It is not a claimed Untappd identity. While unlinked, existing history views read this bucket. At the first link, atomically adopt that bucket into the named account based on the user's explicit linking action; imports do not prove feed coverage. If a destination bucket already exists, merge check-ins and observations by their defined uniqueness keys; do not overwrite better existing values or invent coverage. An import begun before that adoption must stop if the binding changes, rather than append new unbound rows after adoption.

An import with a linked profile belongs to the account captured when the import starts. This is user-selected attribution, not independent validation of the export. Do not infer identity from beer names or check-in IDs. Stop further batches when the captured binding changes; already committed batches stay with their captured owner. Report interruption and the imported count without claiming success for the newly active account.

## Reads and writes

All user-facing history reads select the active account: tried/drunk sets, latest personal ratings, counts, latest/oldest check-in, sync state, coverage, bot statistics, `/match`, and MCP results. Archived accounts contribute nothing to active results. Global catalog and deployment metrics may still count all stored rows where they explicitly describe the database rather than a user's active history.

Writers use an explicit captured owner; they must not resolve the active account afresh after awaited I/O. The profile scraper retains its revision guard and writes to the captured key. Import batches validate the captured binding under the same writer transaction as their writes. Feed pages validate their sync context and write check-ins, profile totals, and coverage under one immediate transaction.

Beer repair/merge operations redirect references across every account without combining ownership. In particular, copying `untappd_had` observations during a legacy repair includes `account_key` in both insertion and conflict handling. Catalog merges must not silently delete archived observations via foreign-key cascade; preserve or merge those observations within each owner before deleting the old beer.

## `/link` behavior

Linking the same username, including a case-only change, preserves history, coverage, ratings, and revision. A display-case update may retain current behavior.

Switching to a different username atomically changes the active key and increments the existing link revision. It does not delete or clear either account's history or ratings. Existing #612 tests that assert destructive clearing of scraped ratings must be replaced by tests of isolation and restoration.

For a new account, active history starts empty; for a previously used account, its stored history and coverage become active again. The reply names the newly linked account and explains that the previous account's history is saved separately. Do not assert that restored history is complete or current merely because it exists.

Username is the identity available in this integration. This design does not claim stable numeric Untappd user identity: an actual username rename is treated as another key, and linking back restores the old key. Automatic detection of renames or reused usernames is outside #611.

## Feed context and compatibility

Add `linkRevision` to `GET /checkins/sync/state`. A new extension captures that revision with the username and includes it in every `POST /checkins/sync` page. The server rejects a supplied revision that differs from the current profile with `409 account_changed`, before any catalog/history/coverage mutation. This also rejects A → B → A responses from the first A binding. A revision is a binding guard, not proof that arbitrary client-provided HTML belongs to an account; the existing client remains responsible for fetching the linked user's feed.

To preserve normal operation of older extensions, add nullable `legacy_sync_revision` to `user_profiles`. The migration sets it to the current link revision for linked profiles using the confirmed initial mapping. First linking an unlinked profile sets it to that new binding's revision. Later switches do not advance it. Requests without `linkRevision` are allowed only when the current revision equals this baseline; otherwise reject with `409 sync_context_required`. A → B → A does not reopen legacy writes. An unlinked profile still returns `not_linked`.

New extension clients stop a run on `account_changed` or `sync_context_required`, and explain that the account changed or an extension update is needed. They must not report successful completion. Older clients may display their existing generic sync error after a switch; document the update requirement in the install guide. Matching and ordinary unchanged-account sync remain available to them.

Existing popup status is only a cached report of a sync run. On a new run, replace it from active server state; never reuse its counts as account coverage. Scope any persisted sync report reused across account changes to its captured binding, and ensure status queries cannot present an archived account's cached completion as the current account's result.

## Migration boundary

In the migration transaction, assign each linked user's existing rows to their normalized current username and retain their proven coverage. Rows of an unlinked user remain in the empty bucket. Do not assign rows to guessed historical usernames or fabricate new ranges. The confirmed production mapping is valid for this deployment; if preflight finds new users with ambiguous history or actual relinks before deployment, pause migration and resolve those users individually.

Capture a read-only preflight summary and make a database backup before deployment using the established deployment procedure. Validate a database copy first. Do not run the old binary against the migrated schema: its old conflict targets and unscoped queries are no longer valid. Rollback requires the established binary/database backup procedure, not simply starting the old binary on the new schema. No production writes are authorized by this design preparation.

## Claims and evidence

| Stored fact | Claim | Evidence or guard |
| --- | --- | --- |
| Migrated named `account_key` | Existing rows belong to the user's current username | User explicitly confirmed unchanged accounts for all six existing history owners (four check-in owners plus two had-only owners); deployment preflight must verify the population and bindings remain covered |
| Empty-key rows | User imported history before linking; named account unknown | No linked profile at import start; do not assert external identity |
| Adopted first-link rows | User selected the account to own pre-link imports | First `/link` action and atomic transfer; does not prove the export's identity independently |
| New check-in / scraped observation owner | Captured account selected for this operation | Explicit owner plus revision validation in the writing transaction |
| Coverage range | Feed traversal observed this interval for this owner | Existing page/cursor validation, binding guard, and owner-scoped transaction; imports never seed coverage |
| Profile total | Last observed total for this account | Accepted page for the captured binding; never another account's last value |
| Link revision | Current binding generation | Increment on every genuine switch, including A → B → A; case-only link does not increment |
| Legacy sync baseline | Untagged clients may write only to the original accepted binding | Migration/first-link baseline; never advanced on a switch |
| Cached extension match | Result belongs to the current credentials and account binding | Worker captures a credential digest and fresh server username/revision before and after matching; cache reads compare fresh binding before and after storage; writes compare against fresh binding, including negative personal answers. Failed deletion cannot make a mismatched entry readable |
| Cached extension sync report | Outcome of a run for a particular binding | Captured revision/username; current-state comparison before reuse |
| Drunk status / personal rating | Active account has a stored observation of this beer | Owner-scoped check-ins and scraped observations; archived owners excluded |

## Verification

Focused regressions cover A → B → A; new B with fewer check-ins; case-only relink; two Telegram users with the same username; overlapping check-in IDs between owners; empty history; unlinked import and first adoption; interrupted imports; delayed scraper/feed responses; ABA stale revision; legacy writes before and after switching; owner-preserving catalog repairs and merges; and exact migration preservation including IDs, ratings, and ranges.

Integration tests must exercise `/match` and MCP drunk/rating results, bot history counts, active feed responses, and extension terminal/error states, rather than testing storage in isolation. Run the existing full backend test/typecheck gate and extension test/typecheck/build gate for the resulting branch. Migration tests pin this migration's own version, not the global schema head.

## Staging

Keep this specification whole. The first implementation plan covers the core ownership mechanism: schema/migration, owner-scoped repositories, atomic link transitions, and ownership-preserving catalog operations. Review that core before writing a separate periphery plan grounded in the resulting code. The periphery covers ingestion context, API/extension compatibility, bot messages, install guide/changelog, and final whole-branch integration verification. Do not deploy the incomplete core by itself.

## Out of scope

Account pickers, account deletion, verification of arbitrary export ownership, stable numeric Untappd user identity, a rewrite of sync traversal, and changes to token ownership are outside #611. Tokens remain bound to their Telegram user; all their history responses reflect that user's active account.

## PR review follow-up: match cache

The live PR replay exposed delayed content-script cache writes after credential/account changes, failed physical cache deletion, and ordinary sync starts invalidating unrelated matches. Reuse the existing binding identity for match caching: attach only a credential digest (never the token), username and revision to worker-produced results; verify server identity before/after a match, and before cache reads/writes. Read visible-card caches in one batch so a catalog scan checks the server binding before and after the batch, rather than once per card. Missing/failed binding verification is a cache miss. Old unscoped entries are misses. Sync-run generation does not decide match validity.
