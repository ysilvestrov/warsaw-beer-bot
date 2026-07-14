# Extension /match usage in the daily status digest — design

**Date:** 2026-07-14
**Status:** approved (brainstorming) → ready for plan
**Area:** `src/storage/schema.ts` (new table), new `src/storage/api_usage.ts`, `src/api/routes/match.ts`, `src/storage/stats.ts`, `src/jobs/daily-status.ts`, new date helper, `spec.md`

## Problem

The browser extension is now approved and published on the Chrome Web Store, so it
drives a new, mostly **anonymous** usage channel: `POST /match` is called with **no
`Authorization` header** (public users without a linked token — see
`optionalAuthMiddleware`, which sets `telegramId = null` for anonymous callers).

We currently do not count this traffic anywhere. `matchRoute` only emits a
per-request perf log (`'match fallback stats'`); nothing is persisted, and the
daily admin status digest (`buildStatusMessage` in `daily-status.ts`) has no line
about extension/API usage at all. So the operator has zero visibility into how much
load the public extension generates or how much of it is anonymous.

## Goal

Give the daily admin digest an **operational** line: how much `/match` traffic the
extension drove over the last complete Warsaw day, split by anonymous vs
authenticated, plus the volume of beers processed.

## Non-goals (YAGNI)

- Product/adoption metrics (distinct users, trends). Anonymous callers have no
  identity and we do not log IPs (privacy policy), so distinct-anon is not knowable.
- Tracking `/enrich/*` or any endpoint other than `POST /match`.
- A live rolling-24h window or per-request raw log. We use per-day aggregates and
  report the last complete Warsaw day.
- Any extension-side change (`extension/**` untouched ⇒ `docs/extension-install-uk.md`
  is not affected).

## Decisions (from brainstorming)

- **Operational** metric, `/match` only.
- Dimensions per accepted `/match` request: request count split **anonymous**
  (`telegramId === null`) vs **authenticated**, and the **sum of beers** in the
  request body.
- **Storage:** one aggregate row per Warsaw date (bounded, restart-safe, no cleanup
  job). Incremented per request via UPSERT.
- **Best-effort write:** the increment is wrapped in try/catch → `log.warn`; a stats
  failure must never break the `/match` response.
- **Digest** shows the **last complete Warsaw day** (digest date − 1). If there were
  zero requests, the line still shows (zeros) — a missing line would read as a bug.
- Authenticated count is `total − anonymous`; not printed separately (keep one line).

## Architecture

### 1. Schema — new table (migration v17)

Add to `MIGRATIONS` in `src/storage/schema.ts` (latest is v16):

```sql
CREATE TABLE api_usage (
  date            TEXT PRIMARY KEY,   -- Warsaw YYYY-MM-DD
  anon_requests   INTEGER NOT NULL DEFAULT 0,
  authed_requests INTEGER NOT NULL DEFAULT 0,
  beers           INTEGER NOT NULL DEFAULT 0
);
```

One row per day; primary key on `date` makes the UPSERT trivial and keeps growth to
365 rows/year (no retention needed).

### 2. Storage module — new `src/storage/api_usage.ts`

```ts
export interface DailyUsage {
  anonRequests: number;
  authedRequests: number;
  beers: number;
}

// Best-effort increment: one accepted /match request. Caller passes the Warsaw
// date and whether the caller was authenticated.
export function recordMatchUsage(
  db: DB, args: { date: string; authed: boolean; beers: number },
): void;

// Returns the row for a Warsaw date, or all-zeros when absent.
export function getUsageForDate(db: DB, date: string): DailyUsage;
```

`recordMatchUsage` runs:

```sql
INSERT INTO api_usage (date, anon_requests, authed_requests, beers)
VALUES (@date, @anon, @authed, @beers)
ON CONFLICT(date) DO UPDATE SET
  anon_requests   = anon_requests   + excluded.anon_requests,
  authed_requests = authed_requests + excluded.authed_requests,
  beers           = beers           + excluded.beers;
```

with `@anon = authed ? 0 : 1`, `@authed = authed ? 1 : 0`, `@beers = beers`.
`getUsageForDate` returns `{ anonRequests: 0, authedRequests: 0, beers: 0 }` when no
row exists.

### 3. Route hook — `src/api/routes/match.ts`

After the request is validated (so only accepted requests count), record best-effort:

```ts
const telegramId = c.get('telegramId') ?? null;
const { beers } = c.req.valid('json');
try {
  recordMatchUsage(deps.db, {
    date: warsawDateAndHour(new Date()).date,
    authed: telegramId !== null,
    beers: beers.length,
  });
} catch (e) {
  deps.log.warn({ err: e }, 'api_usage record failed');
}
```

Counts every validated `/match` call regardless of how many matched. `beers.length`
is the requested-beer count (1..200, already bounded by the `MatchBody` schema).

### 4. Date helper — previous Warsaw day

The digest needs "yesterday" as a Warsaw calendar date. Add a small pure helper
(next to `warsawDateAndHour`, or a local helper in `stats.ts`):

```ts
// 'YYYY-MM-DD' → the previous calendar date, same format. Pure string/UTC math on
// the date-only value, so DST does not apply.
export function previousDate(date: string): string;
```

e.g. `previousDate('2026-03-01') === '2026-02-28'`. Implemented via
`new Date(`${date}T00:00:00Z`)` minus one day, then slice the ISO date.

### 5. Metrics — `src/storage/stats.ts`

Extend `StatusMetrics` with three fields and populate them in `collectStatus` from
the **previous** Warsaw day:

```ts
extMatchRequests: number;   // total = anon + authed, previous Warsaw day
extMatchAnon: number;       // anonymous subset
extMatchBeers: number;      // sum of beers, previous Warsaw day
```

```ts
const yesterday = previousDate(warsawDateAndHour(now).date);
const u = getUsageForDate(db, yesterday);
// ...
extMatchRequests: u.anonRequests + u.authedRequests,
extMatchAnon: u.anonRequests,
extMatchBeers: u.beers,
```

### 6. Digest line — `src/jobs/daily-status.ts`

Insert one line in `buildStatusMessage`, after the `• Користувачі:` line (still in
the "Стан" section):

```ts
`• Розширення /match (вчора): ${group(m.extMatchRequests)} запитів · ${group(m.extMatchAnon)} анонім. · ${group(m.extMatchBeers)} пив`,
```

Uses the existing `group()` thousands formatter. Ukrainian plural agreement is not
enforced (admin-facing line; "запитів" reads acceptably for all counts). Zeros show
when there was no traffic.

## Data flow

```
POST /match (extension)
  optionalAuthMiddleware → telegramId (null = anonymous)
  validate MatchBody
  recordMatchUsage(db, {date: warsaw today, authed, beers})   [best-effort]
  … existing match logic …

daily-status (next Warsaw morning)
  collectStatus(db, now)
    yesterday = previousDate(warsaw(now))
    getUsageForDate(db, yesterday) → ext* metrics
  buildStatusMessage → "• Розширення /match (вчора): …"
```

## Testing (Vitest, TDD)

- **`api_usage.test.ts`**: `recordMatchUsage` inserts then increments the same-day
  row; anon vs authed land in the right columns; `beers` accumulates;
  `getUsageForDate` returns zeros for an absent date.
- **`previousDate`**: normal day, month boundary, year boundary, leap-day
  (`2026-03-01 → 2026-02-28`).
- **match route** (extend `src/api/index.test.ts`): an anonymous `POST /match`
  increments `anon_requests` and `beers` for today; an authenticated one increments
  `authed_requests`. (Best-effort path is covered by the try/catch; no need to force
  a DB failure.)
- **`stats.ts` / digest**: seed an `api_usage` row for yesterday → `collectStatus`
  returns the three `ext*` fields; `buildStatusMessage` includes the
  "Розширення /match (вчора)" line with grouped numbers; zero-row case shows zeros.

## Docs / spec

- `spec.md`: add `api_usage` to the §3 schema table list (and a one-line table
  description) + schema-version row (v17); add the digest line to the status-digest
  section.
- `extension/**` not touched ⇒ `docs/extension-install-uk.md` **not** updated
  (server-side metric only, no user-facing extension change).

## Ops rollout

Pure additive migration (new table) + code. No env changes. After deploy the counter
starts accumulating; the first meaningful digest line appears the morning **after**
the first full day of counted traffic (before that, "yesterday" has no row → zeros).
