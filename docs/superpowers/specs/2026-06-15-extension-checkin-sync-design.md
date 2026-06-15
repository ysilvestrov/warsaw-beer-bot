# Extension Check-in Sync (#145) — Design

**Date:** 2026-06-15
**Issue:** #145 — Add ability to catch non-synchronised check-ins via extension

## Problem

Today the only way to populate the `checkins` table (per-check-in history with
`checkin_id`, timestamp, venue, personal rating) is the `/import` command — a file
upload that requires an Untappd **Supporter** account (Supporter → Download History).
The server's `refreshAllUntappd` job (`src/jobs/refresh-untappd.ts`) scrapes each
linked user's `/user/<name>/beers` page with a single shared bot cookie, but it only
captures the **trailing ~25 distinct beers** into `untappd_had` — never full
per-check-in rows.

This leaves two unserved cases:

1. **Non-supporter backfill.** A user who linked their profile but can't (or won't)
   pay for Supporter has no way to upload their check-in history at all.
2. **Supporter top-up.** A supporter did the initial `/import`, then tasted 30+ beers
   per day at a two-day festival while the server's daily trailing-25 job captured
   only 25 distinct beers/day — leaving a gap of recent check-ins.

Walking *full history* on the single shared server cookie (a non-supporter with
thousands of check-ins = 100+ pages) is exactly the ban risk that #72 (ban protection)
and #89 (client-side enrichment) exist to avoid. So the fix runs in the **user's own
browser session**, distributing the load onto their own Untappd quota — the same
client-relay pattern as enrichment.

## Goals

- A second ingest channel for `checkins`, working **without** Untappd Supporter.
- Covers both first-time backfill and incremental top-up via one unified mechanism.
- Full coverage for large histories (5K+ check-ins) achievable across several runs.
- Reuse the proven relay-HTML → parse-server-side pattern (#89); keep parsing testable
  in Node with Jest fixtures.
- Resolve each check-in's beer by canonical **bid** (`untappd_id`) — no fuzzy matching;
  doubles as orphan enrichment.

## Non-goals (YAGNI)

- No automatic/periodic background sync — on-demand popup button only (v1).
- No reliance on which Untappd account is logged in (we scrape the **linked**
  username's public feed; identity of the logged-in session is irrelevant).
- No replacement of `/import` or the server trailing-25 job — this is additive.

## Key decisions

- **Approach A — relay HTML, parse server-side.** MV3 service workers have no
  `DOMParser`; the established enrich pattern relays trimmed HTML to the server and
  parses with cheerio. This keeps parsing in Node (Jest fixtures, reproducible),
  avoids the `DOMParser` problem, and lets the server own beer-resolution and
  idempotency.
- **`/link` is a hard prerequisite.** The feed scraped is always the linked
  `user_profiles.untappd_username`'s public feed. If unlinked, the endpoint refuses.
- **Pagination is `max_id`-cursor only.** Untappd's check-in feed walks newer→older
  ("older than this id"); there is no offset / random access. "Start from the other
  end" is therefore realized as a **persisted resume cursor** rather than a direct
  jump to the oldest page.
- **Stop logic** is not literal count-equality (fragile: deleted/private check-ins
  never reconcile). Instead: stop on first fully-known page, feed bottom, or page cap.
  The profile **Total Check-ins** stat is a progress target + backstop, never a gate.

## Coverage model — resumable, capped, two-phase walk

Because `checkins` is only ever fed by `/import` (contiguous history up to a date) and
this feature, **gaps always live at the newest end** — there is never an interior hole.
A newest-first contiguous walk therefore suffices, made resumable for large histories:

**Per-user server state — `checkin_sync_state`:** `{ telegram_id, deepest_max_id,
complete, updated_at }`. Persisting server-side (keyed by `telegram_id`) survives
extension reinstalls.

**Per run (one "Sync" tap):**

1. **Phase 1 — top-up.** Walk newest→older from "now" (`maxId` unset, then the page's
   `nextMaxId`), merging each page, until the first **fully-known page**
   (`alreadyKnown === pageSize`) or feed bottom. Cheap when nothing is new; catches
   festival gaps. For supporters this is the whole story — Phase 2 immediately hits
   their imported history and stops.
2. **Phase 2 — deep extend.** If `!complete` and page budget remains, **resume from
   `deepest_max_id`** and keep walking older, advancing the cursor as it merges, until
   the page cap (~200/run ≈ 5000 check-ins) is hit or feed bottom is reached
   (`complete = true`).

**Across runs:** the persisted cursor makes each tap extend deeper — run 1 does the
newest ~5000, run 2 picks up at the saved cursor, etc. A 5K+ user reaches full
coverage over a few runs. `missing = profileTotal − serverCount` tells the popup
whether a re-run is worthwhile.

## Data flow

```
[Popup] ──"Sync"──▶ [Service Worker loop]
                         │  GET /checkins/sync/state  → { deepest_max_id, complete,
                         │                                serverCount, profileTotal, username }
                         │  per page, throttled ~4s:
                         │    fetch(feedPage, credentials:'include')  ← user's untappd cookies
                         │    trim HTML to check-in list
                         ▼
                    POST /checkins/sync  { html, maxId? }   (Bearer token → telegram_id)
                         │  parseCheckinFeedPage(html)
                         │  per check-in: upsertBeer(untappd_id=bid,…) → beers.id
                         │               mergeCheckin(checkin_id,…)   [idempotent]
                         │  advance checkin_sync_state cursor; set complete at bottom
                         ▼
                    returns { merged, alreadyKnown, pageSize, nextMaxId,
                              profileTotal, serverCount, complete }
                         │
[Popup] ◀──progress──[Service Worker]  decides: continue (nextMaxId) or stop
```

## Server design

**Schema v13 — new table `checkin_sync_state`:**

| Field | Type | Notes |
|---|---|---|
| `telegram_id` | INTEGER | PK → `user_profiles(telegram_id)` ON DELETE CASCADE |
| `deepest_max_id` | TEXT | lowest feed cursor merged so far (nullable until first run) |
| `complete` | INTEGER | NOT NULL DEFAULT 0; 1 once feed bottom reached |
| `updated_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP |

**Parser — `src/sources/untappd/checkin-feed.ts` → `parseCheckinFeedPage(html)`**
(sibling to `parseUserBeersPage`), returns:

```ts
{
  checkins: {
    checkin_id: string;       // from the check-in permalink
    bid: number;              // data-bid on the beer
    beer_name: string;
    brewery_name: string;
    user_rating: number | null;
    checkin_at: string;
    venue: string | null;
  }[];
  nextMaxId: string | null;   // cursor for the next (older) page; null = feed bottom
  profileTotal: number | null; // Total Check-ins from the feed header when present
}
```

Built test-first from a saved fixture HTML. Defensive like `parseUserBeersPage`:
skip entries missing a valid `checkin_id` or `bid`. The exact feed URL and `max_id`
mechanism are confirmed against live HTML during implementation.

**Endpoint — `POST /checkins/sync`** (same Bearer auth as `/match`, `/enrich/*`):

- Body: `{ html, maxId? }` (trimmed page + the cursor that produced it).
- Resolve `telegram_id` → `untappd_username`; if unlinked → `409 { error: "not_linked" }`.
- Reuse `block.ts` detection on the HTML → `502 { error: "blocked" }` (cursor untouched).
- Parse; per check-in: `upsertBeer({ untappd_id: bid, name, brewery, rating? })` →
  local `beers.id`, then `mergeCheckin({ checkin_id, telegram_id, beer_id, user_rating,
  checkin_at, venue })` (idempotent on `UNIQUE(telegram_id, checkin_id)`).
- Update `checkin_sync_state`: advance `deepest_max_id`; set `complete = 1` when
  `nextMaxId` is null.
- Return `{ merged, alreadyKnown, pageSize, nextMaxId, profileTotal, serverCount,
  complete }`.

**Endpoint — `GET /checkins/sync/state`** (same auth): returns
`{ deepest_max_id, complete, serverCount, profileTotal, username }` so the client knows
where to start Phase 2 and which feed URL to fetch. (`profileTotal` may be stale/null
until the first page is parsed; it is a hint only.)

All writes route through existing `upsertBeer` + `mergeCheckin`; re-syncing is a no-op.
Beer resolution is by **bid** (canonical `untappd_id`), so orphans are resolved
canonically with no fuzzy matching.

## Extension design

**Popup (`src/popup/`):** new **"Sync my check-ins"** button + status line.
States: idle → `Syncing… 1,240 / 8,200` → `Synced 5,000 of 8,200 — tap Sync again to
continue` (budget hit) / `✓ Fully synced` (complete) / errors
(`not_linked` → "Link your Untappd account in the bot first";
`blocked` → "Untappd is rate-limiting — try later"). Button disabled while running.

**Loop in the service worker** (`src/background/handle-checkin-sync.ts`, sibling to
`handle-enrich.ts`) — not the popup, so closing the popup doesn't kill a multi-minute
sync:

1. `GET /checkins/sync/state`.
2. **Phase 1:** `maxId` unset, fetch `https://untappd.com/user/<username>` (then
   `?max_id=`), `credentials: 'include'`; trim to the check-in list; `POST
   /checkins/sync`; stop on `alreadyKnown === pageSize` or `nextMaxId === null`.
3. **Phase 2:** if `!complete` and budget remains, resume from `deepest_max_id`, walk
   older until cap or bottom.
4. Throttle ~4s between page fetches (reuse the enrich `DEFAULT_DELAY_MS` convention);
   hard cap ~200 pages/run.

**Keep-alive / resumability:** MV3 workers can be killed mid-`sleep`. Mitigations:
(a) the server cursor makes any interruption safely resumable — worst case the user
taps Sync again; (b) pace inter-page delay with `chrome.alarms` rather than a bare
`setTimeout`, and persist `{ running, phase, lastMaxId, mergedThisRun }` to
`chrome.storage.session` so a revived worker / reopened popup resumes/reports instead
of restarting. Progress is pushed to the popup via `chrome.runtime` messages and
mirrored in storage.

**Politeness:** same ~4s spacing as enrich; all fetches use the user's own
cookies/quota, never the server cookie.

## Error handling & edge cases

- **Not linked:** `409 not_linked` → popup tells user to `/link` first; no scraping.
- **Untappd block/captcha** (`block.ts`): `502 blocked` → loop halts gracefully,
  cursor preserved, popup says rate-limited.
- **Private profile / empty feed:** parser returns `checkins: []`, `nextMaxId: null` →
  treated as feed bottom; if `serverCount` stays 0 the popup notes nothing was found.
- **Untappd login redirect** (session not signed in): unparseable HTML → 0 check-ins,
  surfaced as "couldn't read your feed — open untappd.com and sign in."
- **Token invalid/expired:** `401` → popup prompts to regenerate via `/extension`.
- **Partial/garbled page:** skip entries missing `checkin_id`/`bid`; a page with 0
  usable rows but a `nextMaxId` continues; 0 rows + no `nextMaxId` = stop.
- **`profileTotal` unparseable:** `null` → progress shows count only; stop logic falls
  back to known-page / feed-bottom / cap.
- **Worker killed mid-run:** server cursor + `chrome.storage.session` make it
  resumable; idempotent merge prevents duplicate writes.

## Testing (Jest server / Vitest extension, per CLAUDE.md)

- **`parseCheckinFeedPage`** — from saved fixture HTML: extracts
  `checkin_id`/`bid`/rating/timestamp/venue, parses `nextMaxId` and `profileTotal`,
  skips malformed entries, handles empty/last page (`nextMaxId: null`).
- **`POST /checkins/sync`** — merges new, no-ops duplicates, resolves beer by bid
  (orphan → canonical), advances cursor, sets `complete` at bottom; `409 not_linked`,
  `502 blocked`, `401` bad token.
- **`GET /checkins/sync/state`** — returns cursor/complete/serverCount/profileTotal/username.
- **`mergeCheckin`** — idempotency (existing) + bid-resolution case if missing.
- **Extension `handle-checkin-sync`** — mocked fetch + API client: Phase 1 stops on
  fully-known page; Phase 2 resumes from cursor; page cap enforced; throttle invoked;
  block/not_linked surface correct popup states; progress messages emitted.

## Spec & docs (mandatory, same PR)

- **`spec.md`:** add §3 table `checkin_sync_state` (v13) + migration-history bump; add
  HTTP API entries `POST /checkins/sync` and `GET /checkins/sync/state` under §4; note
  that `checkins` now has a second writer besides `/import` and the new background
  relay channel.
- **`docs/extension-install-uk.md`:** document the new **"Sync my check-ins"** popup
  button, the `/link` prerequisite, what it does, and the "tap again to continue"
  multi-run behavior (user-facing extension change → required per CLAUDE.md).
- **`extension/CHANGELOG.md`** + version bump (next minor, e.g. 0.7.0) per the
  established release flow.
