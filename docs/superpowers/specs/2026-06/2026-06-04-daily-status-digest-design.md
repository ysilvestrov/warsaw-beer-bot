# Daily Status Digest — Design

**Date:** 2026-06-04
**Status:** Approved (brainstorming)
**Slug:** daily-status-digest

## Problem

There is no daily heartbeat for the bot. To know whether scraping, matching, and
the background jobs are healthy, the operator must SSH in and read `journalctl`
or query the DB by hand. Silent breakage (e.g. the ontap scraper stops producing
snapshots) can go unnoticed for days.

Goal: once a day, the operator receives a short Telegram message summarising the
bot's status — **mostly health, with a content line or two** — built only from
metrics already derivable from the existing schema. **No new tables or columns.**

## Decisions

- **Audience:** the admin only, delivered via the existing `notifyAdmin` helper
  (bound to `ADMIN_TELEGRAM_ID`). If `ADMIN_TELEGRAM_ID` is unset the job is a
  **no-op**, matching the convention of the existing admin alerts.
- **Schedule:** daily at **09:00 Warsaw** (`0 9 * * *`). node-cron already runs in
  the server's Warsaw local time (cf. the `0 5 * * *` cleanup commented "05:00
  Warsaw"), so no TZ math. 09:00 lands after all overnight jobs (00:00 ontap,
  03:00 untappd, 05:00 cleanup) have settled.
- **Format:** **plain text**, not HTML. `notifyAdmin` already sends a plain
  `sendMessage` (no `parse_mode`), and the `•`/emoji layout needs no markup —
  this sidesteps the Telegram HTML-escaping gotcha entirely.
- **Language:** **Ukrainian**, single fixed language (no `ctx`/`ctx.t` in a cron
  job, admin-only). No i18n plumbing.
- **No stored state / no deltas vs. yesterday** — that would require a new table.
  The one comparative metric ("new on tap in 24h") is derived from the retained
  snapshot window, not from stored history (see caveat below).

## Components

Two focused, independently testable units.

### 1. `src/storage/stats.ts` — data collection (pure SQL + fs.stat)

```ts
export interface StatusMetrics {
  lastScrapeHoursAgo: number | null; // now − MAX(tap_snapshots.snapshot_at) in hours (float); null if no snapshots
  pubsScraped24h: number;            // distinct pub_id with a snapshot in last 24h
  beersTotal: number;
  beersMatched: number;              // untappd_id IS NOT NULL
  orphansPending: number;            // untappd_id IS NULL
  ratingsMissing: number;            // untappd_id IS NOT NULL AND rating_global IS NULL
  snapshots: number;                 // COUNT(tap_snapshots)
  taps: number;                      // COUNT(taps)
  dbSizeMb: number | null;           // fs.statSync(db.name).size / 1e6, 1dp; null for :memory:
  usersTotal: number;                // COUNT(user_profiles)
  usersLinked: number;               // untappd_username IS NOT NULL
  onTapDistinct: number;             // distinct beer_ref across each pub's latest snapshot
  onTapPubs: number;                 // pubs whose latest snapshot has >=1 tap
  newOnTap24h: number;               // see caveat
}

export function collectStatus(db: DB, now: Date): StatusMetrics;
```

- **DB file size:** better-sqlite3 exposes the file path as `db.name`. `fs.statSync(db.name)`
  → MB (1 decimal). When `db.name === ':memory:'` (tests) or the stat throws,
  `dbSizeMb` is `null`. This keeps tests hermetic.
- **`matchRatePct`** is not stored in the struct — the formatter derives it from
  `beersMatched / beersTotal` to avoid a redundant field (guard divide-by-zero → 0).
- **`newOnTap24h` caveat:** computed as *distinct `beer_ref` appearing in snapshots
  from the last 24h that appear in no earlier retained snapshot*. Because history
  is capped at `SNAPSHOT_RETENTION_DAYS` (14), a beer that vanished >14 days ago
  and returned counts as "new." Accepted approximation (the operator confirmed).
- **"latest snapshot per pub"** reuses the established `MAX(snapshot_at)`-per-pub
  pattern already in `latestSnapshotsPerPub` / `currentTapStyles`.

### 2. `src/jobs/daily-status.ts` — formatting + delivery

```ts
export function buildStatusMessage(m: StatusMetrics, date: string): string;

export interface DailyStatusDeps {
  db: DB;
  log: pino.Logger;
  notifyAdmin?: (msg: string) => Promise<void>;
  now?: () => Date;
}
export async function dailyStatus(deps: DailyStatusDeps): Promise<void>;
```

- `buildStatusMessage` is pure: `StatusMetrics` + a pre-formatted date string →
  the message text. The ✅/⚠️ scrape flag lives here: ⚠️ when
  `lastScrapeHoursAgo === null || lastScrapeHoursAgo > 14` (ontap runs every 12h,
  so >14h = a missed cycle — the single most important heartbeat), else ✅.
- Integer grouping uses a small local helper (space as thousands separator, e.g.
  `12 840`) so output is deterministic and exact-string testable (no reliance on
  runtime `toLocaleString` locale data). `lastScrapeHoursAgo` is displayed
  rounded to whole hours (`Math.round`); the float is kept in the struct so the
  ⚠️ threshold comparison is exact.
- `date` is formatted as `YYYY-MM-DD HH:mm` in Warsaw time by the job before
  calling `buildStatusMessage`.
- `dailyStatus`: if `notifyAdmin` is undefined → log a debug line and return
  (no-op). Otherwise `collectStatus` → `buildStatusMessage` → `await notifyAdmin(text)`,
  then `log.info`. A throw from the send is caught and logged (never rethrown).

### Message layout (Ukrainian, plain text)

```
🍺 Статус бота — 2026-06-05 09:00

Стан
• Останній скрейп: 9 год тому ✅ (42 паби за 24 год)
• Каталог: 12 840 пив · 78% зматчено · 287 orphan'ів у черзі
• Рейтинги: 134 зматчених пив без рейтингу
• БД: 1 976 snapshot'ів / 29 459 кранів · 13.2 МБ
• Користувачі: 31 профіль (24 прив'язано)

На кранах зараз
• 1 118 унікальних пив у 42 пабах
• Нових на кранах (24 год): 37
```

When `dbSizeMb` is null the БД line omits the size suffix; when there are no
snapshots the scrape line reads `Останній скрейп: немає даних ⚠️`.

## Data flow

`cron 0 9 * * *` → `dailyStatus({ db, log, notifyAdmin })`
→ `collectStatus(db, now)` → `buildStatusMessage(metrics, warsawDate)`
→ `notifyAdmin(text)`.

## Wiring (`src/index.ts`)

Add to the `cronJobs` array (only meaningful when `notifyAdmin` exists, but the
job self-noops so it can be registered unconditionally):

```ts
cron.schedule('0 9 * * *', () => {
  dailyStatus({ db, log, notifyAdmin })
    .catch((e) => log.error({ err: e }, 'daily-status cron'));
});
```

(`dailyStatus` is async — `.catch` is correct here, unlike the synchronous
cleanup job.)

## Error handling

- Cron wrapper `.catch` → `log.error`; the job never crashes the process.
- A failed `notifyAdmin` send is caught inside `dailyStatus` and logged; the
  cron `.catch` is a backstop for any unexpected throw in collection/formatting.

## Testing (Jest, per CLAUDE.md)

**`src/storage/stats.test.ts`** — seed an in-memory DB via `migrate`, then assert:
- matched vs orphan counts (`untappd_id` null/not-null), `ratingsMissing`.
- `lastScrapeHoursAgo` from a fixed `now` vs a seeded `MAX(snapshot_at)`; `null`
  when no snapshots.
- `pubsScraped24h` counts only pubs with a snapshot inside the 24h window.
- `onTapDistinct` / `onTapPubs` use the latest snapshot per pub (older snapshots
  ignored).
- `newOnTap24h`: a beer only in a <24h snapshot counts; one also in an older
  snapshot does not.
- `dbSizeMb === null` for `:memory:`.

**`src/jobs/daily-status.test.ts`**:
- `buildStatusMessage` exact-string for a known `StatusMetrics` (incl. space
  grouping, `%` rounding, `·` separators).
- ✅ vs ⚠️ flag at the 14h boundary (e.g. 9h → ✅, 15h → ⚠️, null → ⚠️ "немає даних").
- null `dbSizeMb` → БД line without size suffix.
- `dailyStatus` with `notifyAdmin` undefined → no send, resolves (no-op).
- `dailyStatus` with a stub `notifyAdmin` → called once with the built text.

## Spec update (same PR)

`spec.md` (OpenSpec single source of truth):
- Add `dailyStatus` to the §4 "Фонові джоби" table: `0 9 * * *`, purpose
  "щоденний health-дайджест адміну (лише якщо є `ADMIN_TELEGRAM_ID`)".

No schema migration — no DDL change.

## Out of scope (YAGNI)

- New tables/columns of any kind (hard constraint).
- Deltas/trends vs. previous days (needs stored state).
- Broadcasting the digest to non-admin users.
- i18n of the digest / per-recipient language.
- Configurable metric selection or schedule via env.
- HTML/Markdown formatting.
