# Changelog

## [Unreleased]

- Fixed BeerFreak matching for same-name releases: when product details expose `Міцність`, the extension now sends that ABV to the matcher using bounded, cached detail-page lookups.
- Fixed Flasker matching when product titles omit or abbreviate the brewery: trusted shop tags and product links now identify known breweries, and leading preview/sample labels are removed before matching.

## [0.9.0] - 2026-06-17

- Beers you've already had that only loosely match a shop listing (a "fuzzy" match — common when a shop lists a beer without its brewery) now show a ❓ badge ("you've probably had this, but we're not sure") with the global rating, instead of the plain ⭐ that made them look new. Click it to check the beer on Untappd.
- Every badge is now clickable for a quick verify: ✅ (had), ❓, and ⭐ open the matched beer's Untappd page — or, if the beer isn't on Untappd yet, a search prefilled with its name; ⚪ (not yet on Untappd) opens a prefilled Untappd search too. Previously only ⭐ was clickable.

## [0.8.0] - 2026-06-16

- Added Flasker (flasker.com.ua) shop support — your check-in badges now appear across all its product views: the classic category/tag grids, the all-products page on the homepage, and the full product table. Non-beer items (snacks, sauces, glassware, bottle openers, gift sets) are ignored.

## [0.7.1] - 2026-06-16

- Fixed check-in sync only ever loading the most recent page: it now paginates through your full history via Untappd's "Show More" endpoint (older pages were previously not fetched at all), so backfilling a large history and topping up festival gaps work as intended.

## [0.7.0] - 2026-06-15

- Added a "Sync my check-ins" toolbar-popup button that loads your Untappd check-in history straight from your logged-in Untappd session and sends it to the bot — no Untappd Supporter required (unlike `/import`). Requires linking your account first (`/link <username>`). It walks your feed newest-to-oldest and shows live progress; for large histories it syncs in chunks, so tap it again ("Synced X of Y — tap Sync again to continue") until it reports "Fully synced". Useful both to backfill your whole history and to quickly top up recent check-ins (e.g. after a festival) that the server's background sync misses.

## [0.6.1] - 2026-06-13

- Stopped matching non-beer products as beers across all supported shops: mixed and brewery packs, vertical and tasting sets, gift sets, gift certificates, subscriptions, and — on OneMoreBeer — glassware, apparel, books, and the delicatessen/soft-drinks section are now ignored. Real beers that share a page with these (including canned beers sold with a deposit) are unaffected.
- Fixed WineTime beer names that kept a stray "Brewery"/"Броварня" word after the brewery, and added the "янтарне" (amber) descriptor to the name cleanup, so those beers now match on Untappd.

## [0.6.0] - 2026-06-11

- Added a toolbar popup to manage the cache: "Refresh this page" re-fetches badges for the beers on the current supported-shop tab (without waiting out the 8h TTL), and "Clear all cache" empties the whole cache.
- Fixed BeerFreak parsing when product titles repeat a brewery suffix such as "Brewery", or when BeerFreak omits brand metadata for descriptor-led breweries like "Brouwerij ...".
- Fixed BeerRepublic parsing so mixed beer packs, vertical sets, surprise boxes, and advent calendars are ignored instead of being matched as individual beers.
- Fixed Bierloods22 parsing so beer-package products such as Beerbox, Surprise Box, and subscription boxes are ignored instead of being matched as beers.
- Added Hoptimaal shop support, excluding Beer Club, Merch, Spirits, and Bundles category cards from beer matching.

## [0.5.2] - 2026-06-11

- Fixed Bierloods22 product parsing for breweries whose name contains " - " (e.g. "Kykao - Handcrafted") — those beers now match instead of showing as unmatched.
- Fixed WineTime product titles that repeat the brewery name as a suffix.

## [0.5.1] - 2026-06-10

- Fix: Untappd enrichment now runs on large shop pages — it searches a bounded number of beers per page instead of skipping the page entirely.
- Fix: options page checkbox layout (no longer stretched/misplaced).

## [0.5.0] - 2026-06-10

- Added WineTime shop support.
- Orphan beers (no Untappd match yet) now show a ⚪ badge.
- Optional (off by default): find missing beers via Untappd search in your own session and contribute ratings back; enable it in the extension options.
- Fixed WineTime parsing when product titles repeat the brewery name at the end.

## [0.4.0] - 2026-06-10

- Added Bierloods22 shop support.

## [0.3.0] - 2026-06-09

- Show ⭐ global Untappd rating for catalog beers you haven't drunk yet.
- Click any rating badge to open that beer on Untappd in a new tab.

## [0.2.0] - 2026-06-09

- Added BeerFreak shop support.

## [0.1.0] - 2026-06-08

- Initial beta: drunk-status + rating overlay for beerrepublic.eu and onemorebeer.pl.
- Fixed overlays not rerendering after in-page catalog navigation on supported shop pages.
