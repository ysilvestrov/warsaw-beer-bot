# Client-side Untappd enrichment for non-matched beers — design

**Date:** 2026-06-10
**Status:** approved (brainstorming)
**Issue:** #89 (extend rating coverage to beers not yet in the catalog)
**Builds on:** [extension ⭐ global-rating badge + Untappd link](2026-06-09-extension-global-rating-untappd-link-design.md), the server orphan→lookup→enrich pipeline (`untappd-lookup.ts`, `lookup-backoff.ts`, `enrich-orphans.ts`), Untappd ban protection (#72).

## Problem

The overlay shows ⭐ global ratings only for beers already in the catalog. A shop beer the
catalog has never seen returns `matched_beer: null` and shows nothing. The server cannot
fill the gap by searching Untappd itself — automated server-side Untappd access gets
rate-limited/banned (#72), which is why server enrichment is a slow, tap-scoped cron.

#89 asks to surface a rating for un-checked-in beers; the ⭐ feature did that for catalog
beers. This closes the remaining gap: beers not in the catalog at all.

## Goal

Let the **user's own browser** search Untappd for orphan beers (real session, no server ban
risk) and feed results into the shared catalog, reusing the existing orphan→lookup→enrich
machinery. The only client-side work is the network fetch and a cheap HTML trim; all
parsing, candidate-picking, validation, and writes stay server-side.

**Orphans are uniform regardless of origin** (tap scrape or shop page). Any beer the server
knows as an orphan (`untappd_id == null`) shows `⚪` immediately from `/match`. The client
and the server enrich-orphans cron are two workers draining the **same** orphan pool on the
**same** backoff schedule (day, then ~3 days, …) — whoever reaches an eligible orphan first
searches it and records the attempt, so the other does not re-search until it is next due.

The client only pitches in opportunistically: it searches an orphan **only when** the orphan
is (1) visible on the current page, (2) eligible — due per backoff or never searched, and
(3) the page has **fewer than `cap`** beers-without-`untappd_id`. If a page is full of
orphans (≥ `cap`), the client abstains and the server cron drains them over time.

Opt-in and throttled, because each search runs in the user's Untappd session and so puts
*their* account at the ban risk #72 guards against server-side.

## Architecture (client fetches, server thinks)

```
Shop page → content script → POST /match  (read-only, UNCHANGED)
  └─ "no-ID" beers = matched_beer:null (new) OR matched_beer.untappd_id==null (⚪ orphan):
       show ⚪ immediately for known orphans (matched_beer present, untappd_id null)
     POST /enrich/candidates {beers:[{brewery,name}]}   (all no-ID beers on the page)
       → server upserts NEW ones as orphans (untappd_id NULL); for each returns
         { eligible: <due per backoff or never searched>, searchUrl }
     → client gate: only if (no-ID count on page < cap), search the eligible subset,
       1 every ~4s; per beer shows a loader badge over its ⚪:
         background SW: fetch(searchUrl) on untappd.com (real session) → raw HTML
         content script: DOMParser → trim to the results container, drop <script>/<style>
         POST /enrich/result {brewery,name,html}
       → server: lookupBeer({brewery,name,abv, fetch: async () => html})
         (reuses parseSearchPage + brewery hard-gate + name-fuzzy ≥0.85 + ABV tiebreak +
         isBlockPage — zero duplication)
           matched   → recordLookupSuccess(orphan, bid, rating, …)   → badge loader→⭐
           not_found → recordLookupNotFound(orphan)  (backoff++)      → badge loader→⚪
           blocked   → no write, soft backoff                          → badge loader→⚪
  → a later /match matches the now-enriched beer (bid+rating) → ⭐
  (orphans not visited by any client, or skipped by the page-cap gate, are drained by the
   existing server enrich cron on the same backoff — same pool, no separate path.)
```

The HTML trim cuts the ~500 KB Untappd search page to ~10–30 KB (the results container,
scripts/styles stripped). Server-side reuse means an Untappd markup change is fixed by a
**deploy** (server parser), not an extension release.

## Components

### Server (mostly reuse — `src/api/routes/`, `src/domain/`, `src/storage/`)

- **`POST /enrich/candidates`** — auth like `/match`. Accepts every on-page "no-ID" beer
  (those `/match` returned as `matched_beer: null` or with `untappd_id == null`). For each
  `{brewery, name}`: `upsertBeer` an orphan (normalized name/brewery, `untappd_id` NULL) if
  it isn't already a row — pre-existing tap orphans are used as-is, so origin doesn't
  matter. Returns, per beer, `eligible` (the existing `lookup-backoff` `isEligible` over
  `untappd_lookup_at` / `untappd_lookup_count` — due, or never searched) and
  `searchUrl = buildSearchUrl(query)` (server owns query construction). The only write is
  the orphan upsert for genuinely new beers.
- **`POST /enrich/result`** — auth. Calls the **existing** `lookupBeer({ brewery, name,
  abv, fetch: async () => html })` with the client-relayed HTML as the fetch result, then
  `recordLookupSuccess` (sets `untappd_id`, `rating_global`, style, abv) / `recordLookupNotFound`
  (backoff bump). `blocked` → no write.
- No change to `/match`, the matcher, drunk logic, or the server enrich crons.

### Extension

- **Options toggle** "Дозбирувати відсутнє пиво через пошук Untappd (використовує твою
  Untappd-сесію)", **default OFF**. Enabling calls
  `chrome.permissions.request({ origins: ['https://untappd.com/*'] })` (needs the
  options-page user gesture). With the toggle off or permission denied, the feature is
  inert. State in `chrome.storage`.
- **Background service worker** does the cross-origin `fetch(searchUrl)` (untappd.com host
  permission) and returns raw HTML to the content script (a SW has no DOM to trim with).
- **Content script** sends on-page no-ID beers to `/enrich/candidates`, applies the
  page-cap gate, then runs a throttled queue (1 search every ~4s) over the eligible subset,
  trimming each returned HTML via `DOMParser` and POSTing `/enrich/result`.
- **Badge** (`extension/src/content/badge.ts`) — state machine grows:

  | beer state | badge |
  | --- | --- |
  | drunk (exact match) | `✅` + personal rating |
  | not drunk, has `untappd_id` + `rating_global` | `⭐` + global rating |
  | queued / being searched (client-side state) | loader (animated spinner) |
  | orphan: `matched_beer` present, `untappd_id == null` | `⚪` (reuse the bot's orphan glyph, `beers-build.ts:64`) |
  | unmatched (`matched_beer: null`, pre-registration) | none → becomes ⚪/loader once registered |

  The former "matched orphan → no badge" case now renders `⚪`. The loader is a transient
  client-driven overlay shown while a beer is in the search queue/in-flight; it resolves to
  `⭐` (after a follow-up match) or back to `⚪`.

### Gate / backoff (full reuse, uniform pool)

Every orphan — whether scraped from a tap or registered from a shop page — lives in one
`beers` pool with `untappd_lookup_at` / `untappd_lookup_count` driving one backoff schedule.
The server enrich cron and the client both consume that schedule; the first to search an
eligible orphan records the attempt (`recordLookupSuccess`/`recordLookupNotFound`), which
moves its next-due time forward so the other worker skips it. No origin-based split, no
double search.

The client's participation is bounded three ways: it searches an orphan only if it is
**visible** on the current page, **eligible** (due or never searched, per `/enrich/candidates`),
and the page's **no-ID count is below `cap`**. Everything else is left to the server cron.

## Throttle and page-cap gate

- **Page-cap gate (`cap`, default ~20):** if the number of no-`untappd_id` beers on the
  current page is `>= cap`, the client searches **none** of them (a heavily-orphaned page
  would be too many searches for one session — leave it to the server). Below `cap`, the
  client searches the eligible subset.
- **Throttle (default 1 every ~4 s):** rate of the eligible searches the client does run.

Both are named constants. Registration of new shop beers as orphans happens regardless of
the cap gate (so they enter the pool for the server cron even when the client abstains).

## Permissions

`untappd.com` is requested at runtime via the options toggle (informed consent, default
OFF), not declared statically. `optional_host_permissions` already covers `https://*/*`;
the toggle narrows the actual grant to `https://untappd.com/*`. The bot-API host permission
is unchanged.

## Error handling / edge cases

- **`isBlockPage`** in the relayed HTML → server writes nothing + applies a soft backoff so
  the client slows down (the user's session is under pressure).
- **Trust:** the client relays HTML; a malicious client could fake it. The server picks the
  candidate with its own matcher against the claimed `brewery`/`name`; a mismatch →
  `not_found`, so nothing wrong lands in the catalog. Bounded by the trusted-tester model.
- **Throttle/queue:** non-eligible or in-flight beers are never re-searched (queue + server
  backoff).
- **Toggle off / permission denied** → no `/enrich/*` calls at all; badges still show
  ✅/⭐/⚪ from `/match` (⚪ for orphans already in the catalog).

## Testing

- **Server:** `/enrich/candidates` (orphan upsert + eligibility/backoff), `/enrich/result`
  (matched→`recordLookupSuccess`, not_found→backoff, blocked→no write) via the
  `lookupBeer` DI `fetch` over an Untappd-search HTML fixture.
- **Extension:** HTML trim (search fixture → small fragment), queue/throttle (fake timers),
  badge states incl. `⚪` orphan and the loader, options toggle + permission request (mocked
  `chrome.permissions`/`chrome.storage`).

## Spec

`spec.md` — new section: client-relay Untappd enrichment (orphan gate, two endpoints,
opt-in toggle, throttle) + the `⚪`/loader badge states.

## Out of scope

- The client acting as a **global** enrichment worker (pulling off-page orphans from the
  whole pool). The client only searches orphans visible on the page it's on; the rest stay
  with the server cron. (The two share one pool and one backoff — this is a coverage bound,
  not a separate orphan path.)
- Retiring or changing the server enrich-orphans cron — it keeps draining the same pool.
- Statically declaring untappd.com permission / always-on enrichment.
- Sharing `parseSearchPage` code into the extension (server keeps all parsing).
- A manual "search this beer now" button (automatic throttled flow only; could be a later add).
