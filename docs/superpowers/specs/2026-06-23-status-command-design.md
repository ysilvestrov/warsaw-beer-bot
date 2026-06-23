# Design — `/status` command (closes #147, #93)

**Date:** 2026-06-23
**Issues:** [#147](https://github.com/ysilvestrov/warsaw-beer-bot/issues/147) (Add /status command), [#93](https://github.com/ysilvestrov/warsaw-beer-bot/issues/93) (show how many check-ins synced)

## Goal

A per-user command that answers one question: **"is my Untappd data linked, synced, and complete — or do I need a re-import?"** Both issues converge on this. We deliberately keep it a *freshness/completeness status*, not a vanity stats dashboard.

## Background (current state)

Check-ins reach the DB two ways:

1. `/import` — user uploads an Untappd export file (CSV/JSON/ZIP).
2. The browser extension's incremental sync: `POST /checkins/sync` pages the user's
   Untappd feed and merges check-ins, advancing `checkin_sync_state`
   (`deepest_max_id`, `complete`).

On every sync page we already parse the user's true Untappd **profile total**
(`page.profileTotal`) and return it in the JSON response, but we **do not persist
it**. We only store our own row count (`countCheckins`) and the `complete` latch.
That parsed total is exactly the "do I need a re-import?" signal #93 asks for.

## Decisions (from brainstorming)

- **Scope:** freshness/completeness only — no average-rating / top-venues dashboard.
- **Persist `profile_total`:** yes (Option A). Add a column to `checkin_sync_state`,
  write it on each `/checkins/sync`. Only ever populated for **extension** users;
  import-only / link-only users won't have it, and `/status` just shows the raw count.
- **`profile_total` write policy:** **latest non-null wins.** The freshest page
  reflects reality; the total can legitimately grow as the user checks in. A page
  that parses `null` leaves the stored value untouched.
- **Nudge logic:** none. Show both numbers (`synced` and `profile_total` when known)
  and let the user judge. No tolerance, no computed "⚠️ re-import recommended" line.

## What `/status` shows

A single Telegram message, localized (uk / pl / en), produced by a **pure**
`buildStatusMessage(...)` function (fully unit-tested, no DB/Telegraf in it).

- **Not linked** (`untappd_username` is null): a short nudge to `/link` (mentioning
  `/import` too). Nothing else — stop here.
- **Linked**, show:
  - Untappd username (HTML-escaped inside the builder — see HTML-mode i18n gotcha).
  - **Check-ins synced**: `synced`. If a stored `profile_total` exists, render as
    `synced / profile_total`; otherwise just `synced`.
  - **Sync status**: "complete" vs "deep sync in progress" (from
    `checkin_sync_state.complete`).
  - **Distinct beers had**: `drunkBeerIds(...).size`.
  - **Last check-in**: date of the newest check-in, or a "no check-ins yet — try
    `/import` or the extension" line when there are none.

## Components

### Data layer

- **Migration v14**: add nullable `profile_total INTEGER` to `checkin_sync_state`.
- `src/storage/checkin_sync_state.ts`:
  - Extend `SyncState` with `profile_total: number | null`.
  - `getSyncState` reads the new column back.
  - `advanceSyncState(db, telegramId, maxId, complete, profileTotal)` gains a
    `profileTotal: number | null` param. **Latest non-null wins**: write the incoming
    value when non-null, else `COALESCE` to the existing stored value.
- `src/api/routes/checkins.ts`: pass `page.profileTotal` into `advanceSyncState`
  (value is already in scope; today it is only echoed in the response).
- `src/storage/checkins.ts`: new `latestCheckinAt(db, telegramId): string | null`
  (newest `checkin_at`, or null when the user has no check-ins).

### Command wiring

- `src/bot/commands/status.ts` — `statusCommand` `Composer`, mirrors `beers.ts`:
  gathers profile + counts + sync state, calls `buildStatusMessage`, sends via
  `replyWithHTML`.
- `src/bot/commands/status-build.ts` — the pure builder. Input: a plain data object
  (`linked` flag, `username`, `synced`, `profileTotal`, `complete`, `distinctBeers`,
  `lastCheckinAt`) plus the translator + locale. Output: HTML string.
- `src/index.ts` — import and register `statusCommand`.
- `src/bot/commands/catalog.ts` — add `{ command: 'status', descKey: 'cmd.status' }`
  to `COMMAND_CATALOG`. This automatically flows into `/help` text and the native
  Telegram command menu.
- i18n: add `cmd.status` and `status.*` keys to `src/i18n/locales/{uk,pl,en}.ts`.
  All metavars passed as interpolation values (no `<…>` angle-bracket metavars in
  strings sent through HTML mode).

### Spec

- `spec.md` §4: new `### /status` command section.
- `spec.md` §3.14: document the `profile_total` column on `checkin_sync_state`.
- `spec.md` §3.17: add a **v14** row to the migration-history table.

## Error handling / edge cases

- Not linked → nudge only (handled by the builder's `linked === false` branch).
- Linked, zero check-ins → count shows 0, last-check-in line becomes the "try
  `/import` or the extension" hint.
- Linked, no `profile_total` (import-only / link-only) → omit the `/ N` part; show
  bare `synced`.
- `profile_total` parsed as `null` on a page → stored value left untouched
  (latest *non-null* wins).

## Testing (Vitest)

- `status-build.test.ts` — covers every state: not-linked; linked with and without
  `profile_total`; zero check-ins; sync in-progress vs complete; HTML escaping of an
  adversarial username.
- `checkin_sync_state` test — `profile_total` persistence and the latest-non-null-wins
  policy (non-null overwrites; null preserves prior value; round-trips through
  `getSyncState`).

## Out of scope (YAGNI)

- Average rating given, top venues, check-ins-this-year, streaks, any leaderboard.
- A computed "re-import recommended" nudge / gap tolerance.
- Backfilling `profile_total` for existing rows (it fills in naturally on the next
  extension sync; import/link-only users never get it, by design).
