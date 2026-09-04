# Changelog

<!--
  This file is USER-FACING: it is rendered to
  https://ysilvestrov.github.io/warsaw-beer-bot/changelog/ and it is the entire
  content of the release announcement the bot sends to extension users (#379).

  So write every entry for the person using the extension, not for us:

  - Say what THEY see change — a badge that now appears, a button that now
    works, a beer that now shows the right brewery. Lead with the symptom they
    would have noticed, then what it does now.
  - Name things as the UI names them («Sync my check-ins», ⚪, the options page),
    not as the code names them (selectors, adapters, caches, observers,
    service workers, parse stages).
  - If a change has NO effect a user could notice — test infrastructure, a
    dependency bump, a refactor — it does not belong here at all. Delete the
    line; do not translate it. The git log already records it.
  - One entry per user-visible change, newest section on top, ordered by how
    much the reader is likely to care.

  Written under `## [Unreleased]`; the release cut renames that heading to
  `## [x.y.z] - DATE` (see docs/extension-release.md).
-->

## [Unreleased]

- Fixed check-in sync stopping short of a full sync when a run had been interrupted earlier (closed tab, lost connection, hitting Stop): it now finds and fills gaps left in the middle of your history instead of getting stuck just above them, and shows «✓ Fully synced» once everything is in. If your Untappd session has expired it now says so instead of quietly reporting success.
- Fixed many Beershop beers showing no badge because a style printed after the beer name was searched as part of the name. The extension now uses the product address to keep the actual name, while preserving the degree and real name endings such as «Italian Pilsner».
- Fixed imported beers on Flasker showing no badge because the shop labels their brewery as «Імпортне пиво». The extension now keeps the beer identity from the title and verifies the Untappd link published on the product page.

## [0.16.0] - 2026-09-02

- Before you save a token, the popup now leads with getting one: «Get a token» sits directly under the title as the main button and is the keyboard's first stop, while «Sync my check-ins» is greyed out and explains that it needs a token — previously it was the big amber button, and pressing it asked for access to untappd.com only to fail with a connection error. The link to the setup guide also stops vanishing once you have a token: it moves to the bottom of the popup, where the people most likely to hit a sync problem can still find it.
- «Clear all cache» now asks before it acts: the first click tells you how many cached entries would go, the second clears them and reports how many it removed. Each popup action also reports beside its own button, so clearing the cache no longer wipes out the explanation of why «Refresh this page» is unavailable — and the refresh caption now says how many beers it found on the page instead of counting cache entries. None of the three captions is read aloud when the popup opens, only when your click changes one.
- Fixed check-in sync getting stuck on «Starting…» and never moving: it now recovers on its own and picks the progress back up. A running sync can be stopped with the same button, and a run that hits its limit offers «Continue — N left» instead of hiding the next step in the status text.
- Fixed beers losing their ⚪ badge when you come back to a shop page you have already visited. Beers that had no answer the first time are now checked again, so the page can show the ⚪ or a rating that has since appeared on Untappd.
- Fixed clicking a rating badge on Beershop opening both Untappd and the shop's own product page; the shop page now stays where it is while Untappd opens in a new tab. Middle-clicking a badge works again too.
- Fixed badges not appearing on Piwne Mosty listings after the shop redraws its catalog — for example when you filter it or move between pages.
- Fixed Flasker's Morava series being listed under a brewery called «Morava» that does not exist, or losing «Morava» from the beer name. Those beers now appear under VibrantPour, where they belong.
- The options page now looks and behaves like the toolbar popup: «Save» is the clear primary action, «Test connection» is the secondary one beside it, keyboard focus is visible, and the page follows your browser's light or dark theme.

## [0.15.0] - 2026-08-30

- Added Beershop support across its Polish, Czech, Slovak, English, and German domains. Beer badges now follow language switching between `beershop.pl`, `.cz`, `.sk`, `.eu`, and `.de`, while localized soft-drink, functional-drink, gift, merch, snack, and spirits categories are ignored.
- Added a country-grouped supported-shop directory to the toolbar popup. Each shop opens in a separate browser window, and Beershop resolves to one storefront compatible with the user's supported browser languages instead of appearing once per domain.
- The popup's actions are now ranked by importance instead of rendering as three identical grey boxes: "Sync my check-ins" is a filled button at the top and the first stop for the keyboard, "Refresh this page" is outlined below it, and the irreversible "Clear all cache" is quiet, under a hairline — previously the destructive action sat directly under the cursor's descent from the toolbar icon. Buttons also inherit the popup's typeface instead of the browser's default one, a disabled button reads as unavailable rather than half-painted, and keyboard focus is visible.

## [0.14.0] - 2026-08-10

- Flasker beers now match through the Untappd link the shop itself publishes on a product page, instead of being searched for by name. Where that link exists it settles the identity outright, so releases whose shop name and Untappd name simply disagree stop sitting unmatched — and a wrong ⭐ that name-matching had picked is corrected.
- Fixed Flasker pre-release banners ("PRE-ORDER", "СКОРО" and similar) leaking into the brewery: the banner is now removed before the brewery is worked out, not after, so those products identify the right brewery instead of one prefixed with shelf text.
- Fixed Flasker's Tomatøl series being attributed to the wrong brewery; the products now resolve to Mad Brew through the shop's own product address.
- Ginger beer, root beer and energy drinks are no longer matched as beer. The rule is gated on alcohol strength, so an alcohol-free beer at 0.0% still matches as it always did, and a published style overrides the name — a 0.0% "Stout" that merely mentions ginger beer stays a beer.
- Fixed BeerFreak brewery detection for products the shop publishes without a brand label: titles led by a brewery word ("Brasserie", "Browar", "Brouwerij", "Pivovar", "Birrificio", "Brauerei") no longer swallow the beer name into the brewery, so "Brasserie du Bocq Blanche de Namur" is now the beer "Blanche de Namur" by "Brasserie du Bocq" instead of a beer called "Namur".
- Beers whose names carry Cyrillic words are now searched for with those words kept, falling back to the previous broader search only when the narrow one finds nothing. Previously the search dropped them, which left Ukrainian- and Russian-named releases unmatched even when Untappd had them.

## [0.13.0] - 2026-07-31

- Missing beers are now matched using the alcohol strength the shop publishes, instead of ignoring it. This tells apart releases that share a brewery, a style and a name and differ only in strength — for example AleBrowar's alcohol-free Kwas Chlebowy versus its 0.5% version — so more ⚪ beers become ⭐ instead of staying unmatched.
- Added OneMoreBeer alcohol strength and style parsing: the shop's "Dane techniczne" panel is now read for every product, so its beers get the same strength-aware matching as the other supported shops.

## [0.12.0] - 2026-07-19

- Improved Flasker brewery detection: listings where the brewery isn't the first word of the title — or appears only in a product tag or the brand strip — now identify the correct brewery for dozens more breweries, instead of guessing the first word, so more beers match and badge correctly.
- Fixed BeerFreak beer names that duplicated the brewery (e.g. "Hoppy Hog Family Brewery Hoppy Hog …") when the shop's brand label and product title used different brewery wordings; the brewery is no longer repeated inside the beer name.
- Fixed BeerFreak filtering so tasting sets, mix packs, and numbered multi-beer series are ignored instead of being matched as individual beers.

## [0.11.0] - 2026-07-10

- Extension now shows global Untappd ratings (⭐) on supported shops even without a token; the popup shows a "Not connected" note and links to token setup. Personal ✅/rating badges still require a token.
- Fixed Funkyshop parsing on English/home grids: product detail fallback now fills missing breweries, can/deposit rows are ignored, and trailing volume/format text is removed from beer names before matching.
- Fixed Piwne Mosty parsing so out-of-stock placeholders such as "Chwilowy brak:(" and "Wypite" are ignored instead of being sent as brewery or beer names.

## [0.10.0] - 2026-06-30

- Fixed Flasker parsing for more metadata-backed breweries and product families, including Copper Head, Lost Philosopher, and DE ZWARTE REGEL listings that previously fell back to first-word brewery guesses.
- Added Funkyshop (funkyshop.pl) shop support. Glass/merch category pages are skipped so non-beer products are not matched.
- Added Piwne Mosty (piwnemosty.pl) shop support. Snack and glass/merch category pages are skipped so non-beer products are not matched.

## [0.9.3] - 2026-06-28

- Fixed optional missing-beer enrichment after Untappd moved search results into Algolia: the extension now asks for the required Algolia host permission, queries Untappd's Algolia API from the user's browser/IP, and relays JSON hits to the server, so orphan beers can become ⭐ again instead of staying ⚪ forever.

## [0.9.1] - 2026-06-28

- Fixed BeerRepublic filtering so variety/twelve-pack products are ignored instead of being matched as individual beers.
- Fixed BeerFreak parsing for slash/backslash collaborator titles, so brandless products and branded collabs emit the primary brewery with a clean beer name.
- Fixed BeerFreak matching for same-name releases: when product details expose `Міцність`, the extension now sends that ABV to the matcher using bounded, cached detail-page lookups.
- Fixed Flasker matching when product titles omit or abbreviate the brewery: trusted shop tags and product links now identify known breweries, and leading preview/sample labels are removed before matching.
- Fixed OneMoreBeer delicatessen filtering so kvass/Kwas Chlebowy stays eligible while Kofola, kombucha, and aloe soft drinks are ignored per product.

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
