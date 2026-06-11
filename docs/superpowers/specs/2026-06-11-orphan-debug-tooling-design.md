# Orphan-debug tooling + extension cache control — design

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

Three maintenance gaps around the orphan-matching debug workflow and the extension:

1. **No source URL for orphans.** When a beer ends up an orphan it can be either a
   *parser* bug (adapter mis-read the page) or a *matcher* bug. The matcher case is
   diagnosable from the data already in `enrich_failures` (brewery/name/candidates);
   the parser case is **not** — you need the page the beer was scraped from. The shop
   page URL is currently stored nowhere.
2. **No way to mark an orphan failure as triaged.** Agents re-process the same
   `enrich_failures` rows on every pass. There is no record that a row was already
   looked at, why it was left unmatched, or whether the decision still holds.
3. **No cache control in the extension.** Match results are cached 8h in
   `chrome.storage.local`. There is no way to refresh badges on a page sooner.

All three are one coherent "debug & maintenance" theme → one spec, but **three
independent worktree branches / PRs**.

## Background (current state)

- Orphan beer rows (`beers.untappd_id IS NULL`) are created in the enrichment flow via
  `ensureBeerRow` (`src/api/routes/enrich.ts`), called from `/enrich/candidates` and
  `/enrich/result`. `/match` only *reads* the catalog.
- `enrich_failures` (keyed on `beer_id`) is written in `applyLookupOutcome`
  (`src/domain/lookup-outcome.ts`), reached from **two** paths:
  - client relay `POST /enrich/result` — the extension knows the shop page URL here;
  - server cron `enrich-orphans` (`enrichOneOrphan`) — page URL is **unknown** (the
    orphan was created earlier).
  The row self-clears (`clearEnrichFailure`) once the beer matches, and is
  CASCADE-deleted if the beer row is removed.
- Extension cache (`extension/src/cache/store.ts`): `chrome.storage.local`, prefix
  `mc2:`, key = `normalizeKey(brewery, name)` — **site-independent**, 8h TTL.
- Extension UI surfaces: `options_page` only, **no popup/action**. Content script runs
  on the 5 supported shop hosts.

### Key consequence for #3 (site-independent keys)

Because the cache key has no site dimension, a fixed adapter parsing a name correctly
produces a *different* key → automatic cache miss → fresh fetch. So per-site clearing is
**not** needed for the "I fixed the adapter" case — stale entries simply expire. The real
remaining need is: a beer just got matched/enriched server-side and the user wants to
**refresh the badges on the open page now**, without waiting out the 8h TTL or nuking the
whole cache. "Per-site" is therefore implemented as **"refresh the open page"**, not as
true per-site key isolation.

## Data model (shared)

One new migration in `src/storage/schema.ts` adds four columns to `enrich_failures`:

| column         | type                                   | notes                                  |
|----------------|----------------------------------------|----------------------------------------|
| `source_url`   | `TEXT NOT NULL DEFAULT ''`             | shop page URL (#1)                     |
| `review_class` | `TEXT` (nullable)                      | CHECK ∈ {parser_bug, matcher_bug, not_on_untappd, wontfix} OR NULL (#2) |
| `review_note`  | `TEXT` (nullable)                      | free-text triage note (#2)             |
| `reviewed_at`  | `TEXT` (nullable)                      | ISO timestamp of the review (#2)       |

Bump the migration version; the migration is additive (new nullable / defaulted columns),
no backfill.

## #1 — Page URL for orphans

- `EnrichFailureRow` (`src/storage/enrich_failures.ts`) gains `source_url: string`.
- `recordEnrichFailure` writes `source_url` on INSERT and, on `ON CONFLICT(beer_id)`,
  **does not overwrite a known URL with an empty one**:
  `source_url = CASE WHEN excluded.source_url != '' THEN excluded.source_url
                     ELSE enrich_failures.source_url END`.
  (Protects the URL captured by `/enrich/result` from being wiped by a later cron
  re-fail that has no URL.)
- `applyLookupOutcome` `input` param gains `sourceUrl?: string` (default `''`); passed to
  `recordEnrichFailure` for both `not_found` and `blocked` outcomes.
- `POST /enrich/result` body gains `pageUrl: z.string().optional()`; threaded into the
  `applyLookupOutcome` `input`.
- Server cron (`enrichOneOrphan`) passes `''` (URL unknown).
- **Limitation (accepted):** `source_url` is populated only when an opt-in user's
  `/enrich/result` fails — which is exactly the adapter-relevant case. Cron-only orphans
  keep `''`.
- Extension: `submitResult(brewery, name, html, pageUrl)` →
  `postEnrichResult(..., pageUrl)` sends `pageUrl`; `main.ts` supplies
  `window.location.href`.

## #2 — Orphan review classification + admin API

- `recordEnrichFailure` `ON CONFLICT` also **resets** the review fields
  (`review_class = NULL, review_note = NULL, reviewed_at = NULL`) so a recurring failure
  re-surfaces in triage. Fresh INSERT leaves them NULL.
- New storage fn `setEnrichFailureReview(db, beerId, reviewClass, note, atIso)` — updates
  the three review columns for the row; returns whether a row was updated.
- New route `POST /enrich/failures/review`, body
  `{ beer_id: number, review_class: <enum>, note?: string }`:
  - **404** if no `enrich_failures` row exists for `beer_id` (cannot review a
    non-existent / already-cleared failure).
  - **200** with the stored review on success.
- **Admin auth:** new env var `ADMIN_API_TOKEN`. A dedicated admin middleware does a
  constant-time compare of the request token (header) against it. If `ADMIN_API_TOKEN` is
  unset the route returns **503** (disabled). This is separate from the existing per-user
  Telegram-token auth.
- Agents continue to read `enrich_failures` **read-only** (now with `source_url` + review
  columns), filtering `WHERE review_class IS NULL` to skip triaged rows, and POST review
  marks via `curl` with the admin token. Update the orphan-failure runbook in `docs/`.
- **Why an API (not direct DB write / CLI):** dev host == prod host; the bot process owns
  the open SQLite DB; `sudo -u warsaw-beer-bot` does not work and direct file writes risk
  lock/permission problems. Routing the write through the bot's own process avoids all of
  that.

## #3 — Extension popup for cache control

- `manifest`: add `"action": { "default_popup": "src/popup/popup.html" }` and permissions
  `activeTab`, `tabs` (query + message the active tab; host permission for the 5 shop
  hosts already exists).
- `src/popup/popup.html` + `popup.ts`:
  - **"Refresh this page"** — queries the active tab; if its URL matches a supported site
    adapter, sends `{ type: 'refresh-page' }` to that tab's content script; otherwise the
    button is disabled with a hint.
  - **"Clear all cache"** — removes all `mc2:` keys directly from the popup.
- `cache/store.ts`: add `clearAll()` and `clearKeys(keys: string[])`.
- Content script (`main.ts`): register a `chrome.runtime.onMessage` listener for
  `refresh-page` → re-parse the current cards, delete their cache keys (`clearKeys`), and
  re-run `runOverlay` via the existing re-render path (`content/rerender.ts`) so badges
  update live.

## Testing

- **Storage:** upsert preserves a known `source_url` against an empty one; conflict resets
  review fields; `setEnrichFailureReview` updates / reports no-op.
- **Route:** admin middleware (401 bad token, 503 when unset, pass-through on match);
  review endpoint (404 unknown beer, 200 happy path); `/enrich/result` stores `pageUrl`.
- **Extension:** `clearAll` / `clearKeys`; popup button enable/disable + messaging logic;
  content-script `refresh-page` handler clears keys and re-renders.

## Rollout

- Three worktree branches / PRs (one per feature), shared design doc.
- Extension version bump + release / broadcast per the release-ops process.
- **spec.md:** review whether the OpenSpec `spec.md` needs the new endpoint and the
  `enrich_failures` columns documented; if so, update it in the same PR (per CLAUDE.md).
