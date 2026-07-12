# Replace Untappd Profile-Feed Scraper With `/beers` Page Scraper — Design Spec

**Date:** 2026-04-30
**Status:** Approved (design); pending plan + implementation
**Phase:** 1 of 4 in the post-PR-#30 follow-up sequence (Designs 3, 4, 1, 2).

## Problem

`src/jobs/refresh-untappd.ts` is broken at three layers and has been quietly producing junk for the bot's lifetime:

1. **Wrong URL.** Line 28: `https://untappd.com/user/${username}/beer` (singular). This URL returns HTTP 303, redirecting to `/user/<username>` (the profile summary). We've been scraping the redirect target — a profile feed of recent activity — not the beer list.
2. **Wrong selectors for the wrong page.** `parseUserBeerPage` (`src/sources/untappd/scraper.ts`) targets `.item[data-checkin-id]` and `a.time.timezoner` — selectors written for the activity feed it accidentally landed on, not the beer list it intended to land on. The fixture `tests/fixtures/untappd/user-beer.html` corroborates this: 5 `.item[data-checkin-id]` rows, no global ratings, name singular.
3. **Wrong field semantics.** Line 42: `rating_global: it.rating_score` — stores the *user's* rating from the redirect-target activity feed as `rating_global`. Eleven untappd-side rows in prod were populated this way; all hold the user's personal rating in a field that should hold the Untappd community rating.

End result: 11 catalog rows out of ~6 000 from this user have a non-NULL `rating_global`, and that value is wrong.

## Goal

Repurpose the job to do what it always meant to do: refresh global community ratings for the user's most recent ~25 distinct beers. This is the ceiling Untappd lets us scrape unauthenticated — `/user/<X>/beers?start=N` and similar query parameters are server-side ignored, "Show More" links to a login wall, and rate-limiting precludes per-beer detail-page scraping for 6 000 beers.

The bulk of `rating_global` backfill therefore comes from Design 3 (`/import` reads `global_weighted_rating_score`). This job's role is **incremental top-up**: catch new beers and updated global ratings between full imports.

## Non-goals

- Bypassing Untappd's auth / pagination boundary. No cookie injection, no headless browser, no API key ladder. Single unauthenticated GET.
- Synthesising fake check-ins. `/beers` is an aggregate per-beer view (no check-in IDs, no timestamps, no venues). The scraper updates `beers.rating_global` only — `mergeCheckin` is dropped from this code path. CSV / JSON imports remain the only source of truth for the `checkins` table.
- Refreshing the user's personal rating. /beers does expose "Their Rating", but `checkins.user_rating` is per-checkin and CSV-sourced; introducing a separate per-beer aggregate user rating column would require a schema decision out of scope here.
- Updating `name`, `brewery`, `style`, or `abv` on existing rows from `/beers`. Avoid clobbering CSV-import canonical fields with potentially-truncated scraped strings. New rows (no prior import) get whatever `/beers` provides.

## Architecture

### URL change

```
- https://untappd.com/user/${username}/beer
+ https://untappd.com/user/${username}/beers
```

Returns HTTP 200 with the user's distinct-beers list (~25 items per fetch unauthenticated). Confirmed with manual `curl -sIL` against `/user/ysilvestrov/beers`.

### New scraper: `parseUserBeersPage(html)`

Replaces `parseUserBeerPage`. Located in the same file (`src/sources/untappd/scraper.ts`), keeping the module boundary intact.

**Page structure** (sampled from a live fetch on 2026-04-30):

```html
<div class="beer-item" data-bid="6455502">
  <div class="beer-details">
    <p class="name"><a href="/b/.../6455502">Captain Hazy - Foreign Legion 2025</a></p>
    <p class="brewery"><a href="/KompaanBier">KOMPAAN Dutch Craft Beer Company</a></p>
    <p class="style">Bock - Doppelbock</p>
    <div class="ratings">
      <div class="you">
        <p>Their Rating (4)</p>
        <div class="rating_bar_awesome">
          <div class="caps" data-rating="4">...</div>
        </div>
      </div>
      <div class="you">
        <p>Global Rating (3.73)</p>
        <div class="rating_bar_awesome">
          <div class="caps" data-rating="3.73">...</div>
        </div>
      </div>
    </div>
  </div>
</div>
```

`Global Rating` may be `(N/A)` for very new releases — parse to `null` then.

**Output type:**

```ts
export interface ScrapedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  their_rating: number | null;     // user's overall rating; informational, not stored today
  global_rating: number | null;    // Untappd community rating → beers.rating_global
}

export function parseUserBeersPage(html: string): ScrapedBeer[];
```

**Selector strategy** (cheerio):

- Items: `$('.beer-item[data-bid]')`. Cap at first 25 (matches what unauth gets).
- `bid`: `data-bid` attribute, parsed.
- `beer_name`: `.beer-details .name a`, text, whitespace-normalised.
- `brewery_name`: `.beer-details .brewery a`, text.
- `style`: `.beer-details .style`, text, blank → `null`.
- `their_rating` and `global_rating`: scope to `.beer-details .ratings .you`. Each `.you` has a `<p>` with text matching `Their Rating (...)` or `Global Rating (...)`. Inside, `.caps[data-rating]` gives the value. `data-rating="N/A"` or absent → `null`.

Two `.caps[data-rating]` per item — discriminate by the parent `.you > p` text. (No relying on order in case Untappd reorders.)

### `src/jobs/refresh-untappd.ts` rewrite

Streamlined to the new paradigm:

```ts
for (const p of profiles) {
  const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beers`);
  const items = parseUserBeersPage(html);
  for (const it of items) {
    const nb = normalizeBrewery(it.brewery_name);
    const nn = normalizeName(it.beer_name);
    const existing = findBeerByNormalized(db, nb, nn);
    if (existing) {
      // Update only rating_global; leave other fields alone.
      db.prepare('UPDATE beers SET rating_global = ? WHERE id = ?')
        .run(it.global_rating, existing.id);
    } else {
      upsertBeer(db, {
        untappd_id: it.bid,
        name: it.beer_name,
        brewery: it.brewery_name,
        style: it.style,
        abv: null,                  // /beers doesn't carry ABV
        rating_global: it.global_rating,
        normalized_name: nn,
        normalized_brewery: nb,
      });
    }
  }
}
```

`mergeCheckin` is gone from this path. Profile feed iteration unchanged.

### Test fixture

Replace `tests/fixtures/untappd/user-beer.html` with `tests/fixtures/untappd/user-beers.html` — a saved live fetch of `/user/ysilvestrov/beers`. Curated down to ~3 representative items if size matters for repo footprint, but full ~25-item page is acceptable (it's already 215 KB; comparable to existing fixture).

## Files

**Modified:**
- `src/sources/untappd/scraper.ts` — replace `parseUserBeerPage` → `parseUserBeersPage`. New types.
- `src/sources/untappd/scraper.test.ts` — rewrite for new selectors + new interface.
- `src/jobs/refresh-untappd.ts` — new URL, call new scraper, drop `mergeCheckin` block, drop `it.rating_score` misuse.

**Replaced:**
- `tests/fixtures/untappd/user-beer.html` → `tests/fixtures/untappd/user-beers.html` (live re-fetch).

**Removed:**
- None — no schema or storage changes.

## Tests

`src/sources/untappd/scraper.test.ts` (rewrite):

1. **Parses every `.beer-item` in fixture.** Length matches manually counted items.
2. **First item happy path.** Verifies bid, name, brewery, style, both ratings on a known fixture row.
3. **Beer with `Global Rating (N/A)`** → `global_rating === null`, other fields populated.
4. **Their Rating present, Global Rating present** → both numeric.
5. **Cap to first 25 items** even if fixture happens to contain more (defensive; the live page may grow if Untappd changes layout).
6. **Empty page or no `.beer-item`** → empty array.
7. **Malformed `data-bid` (non-numeric)** → item skipped, others kept.

Add to `src/jobs/refresh-untappd.test.ts` (or create if missing):

1. **End-to-end: scraped beer absent from DB → upserted with rating_global from `global_rating`.**
2. **End-to-end: scraped beer matches existing row by normalized name+brewery → only rating_global updated; name/brewery/style/abv untouched.**
3. **`global_rating === null` → row's rating_global set to NULL (or untouched, depending on implementation; spec one explicitly).**

For (3), pick **set to NULL** — it's an authoritative read, "we just checked Untappd and they have no global rating". This makes refresh idempotent.

## Risks

- **Untappd HTML change.** Already happened once between when this scraper was written and now. Mitigation: tight selectors, defensive `null` parsing, the bot has logged retries via `log.warn` on `try/catch`. A future Untappd redesign costs us the scraper; CSV / JSON imports (Design 3) remain.
- **The 25-item cap is silently lossy** if a user has more than 25 new beers since last refresh. Acceptable — the next `/import` covers the gap.
- **Rate-limiting / Cloudflare.** Untappd has been known to gate logged-out scrapes. Today's fetch worked unauthenticated; if it stops working, we have CSV / JSON imports as the safety net.
- **`their_rating` is collected but unused.** Reserved field for future use; documented in code as such, not piped to storage. Kept on the scraped type so the scraper is reusable later if we add a per-beer user-rating column.

## Operational notes

- No DB migration.
- No env var changes.
- Roll-out order: ship Design 3 first (so `/import` populates `rating_global` for the bulk), then this job (incremental top-up). The two together close the gap end-to-end.
- After deploy, the job runs on the existing cron schedule (no schedule change). First run will rate-update ≤ 25 beers per profile; subsequent runs converge fast.

## Lesson to log in §14 of the canonical spec

```markdown
- **Untappd `/user/<X>/beers` scraper**: fetches the user's distinct-beers
  list (top ~25 unauthenticated) for an incremental refresh of
  `beers.rating_global`. Replaces a multi-layered broken predecessor that
  hit `/beer` (which 303-redirects), used activity-feed selectors
  (`.item[data-checkin-id]`), and stored the user's personal rating in
  `rating_global`. Bulk backfill of `rating_global` is the `/import` path
  (Design 3); this job catches new releases and rating drift between
  imports. `/beers` does not paginate unauthenticated, so the 25-item cap
  is a hard ceiling.
```
