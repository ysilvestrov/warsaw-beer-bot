# Changelog

## [Unreleased]

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
