# Design — `/status` sync completeness from synced/total (closes #190)

**Date:** 2026-06-23
**Issue:** [#190](https://github.com/ysilvestrov/warsaw-beer-bot/issues/190) — `/status` shows "deep sync in progress" indefinitely.

## Root cause (corrected)

`/status` rendered its sync-status line from `checkin_sync_state.complete`, which only
latches `true` when the **extension** deep-pages to the very bottom of the feed
(`nextMaxId === null`). A user whose full history arrived via `/import` never makes the
extension page to the bottom — incremental top-ups from the top never hit `nextMaxId === null` —
so `complete` stays `false` forever.

Confirmed in prod for the one extension user: `synced = 12428`, `profile_total = 12428`,
`complete = 0`. They have **100% of their check-ins**, yet `/status` showed
"Синхронізація: триває глибока синхронізація ⏳", directly contradicting the
"12428 / 12428" count line right above it.

So `complete` is the wrong signal. The real "do I have everything?" signal is
**`synced` vs `profile_total`**, which `/status` already displays.

## Decision

Fold completeness into the existing count line; drop the separate status line.

When `profile_total` is known:
- `synced >= profile_total` → append **✅** → `Синхронізовано чекінів: 12428 / 12428 ✅`
- `synced < profile_total` → bare `synced / profile_total` (numbers already show the gap)

When `profile_total` is unknown (pure import / extension never ran) → just
`Синхронізовано чекінів: N`, unchanged.

No computed "re-import" nudge (consistent with the original #189 decision — show the
numbers, let the user judge). The ✅ is a language-neutral confirmation, not a nudge.

## Changes

- `src/bot/commands/status-build.ts`:
  - Remove the `view.complete ? sync_complete : sync_in_progress` line.
  - On the count line, append ` ✅` when `profileTotal != null && synced >= profileTotal`.
    The suffix is added in code (✅ is language-neutral) — no new locale strings.
  - Remove the `complete` field from `StatusView`.
- `src/bot/commands/status.ts`: stop populating `complete` in the view.
- i18n: delete the now-orphaned `status.sync_complete` / `status.sync_in_progress` keys
  from `src/i18n/types.ts` and `src/i18n/locales/{en,uk,pl}.ts`.
- `spec.md` §4 `/status`: update the sync block description (no "complete / in-progress"
  state; completeness shown as ✅ on the count line).

## Out of scope / unchanged

- `checkin_sync_state.complete` column and `getSyncState().complete` stay (still tracked
  by the sync endpoint; simply not displayed; not load-bearing elsewhere).
- No migration, no data change. Display-only.
- Staleness of `profile_total` (a user checks in on Untappd but hasn't re-run the
  extension) is accepted, as in #189 — we report what the last sync knew.

## Testing (Vitest)

- `status-build.test.ts`: replace the complete/in-progress cases with:
  - ✅ appears when `synced >= profileTotal` (incl. equal);
  - no ✅ when `synced < profileTotal`;
  - no ✅ / no status line when `profileTotal == null`;
  - existing not-linked / no-checkins / settings cases unchanged.
