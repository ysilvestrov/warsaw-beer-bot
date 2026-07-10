# Chrome Web Store — review notes (Warsaw Beer Overlay)

## What the extension does

It overlays your personal Untappd status and ratings onto craft-beer shop pages
(BeerRepublic, OneMoreBeer, BeerFreak, Bierloods22, WineTime, Hoptimaal, Flasker,
Piwne Mosty, Funkyshop). For each product it shows a badge:

- ⭐ + number — the beer's **global** Untappd rating.
- ⚪ — the beer is known but has no linked Untappd id yet.
- ✅ (+ your rating) — you have already checked this beer in (requires a token).
- ❓ — a probable (fuzzy) match you may have had.

## How to verify WITHOUT any setup (anonymous mode)

No account, login, or token is required to see the core feature:

1. Install the extension.
2. Open any supported shop, e.g. `https://onemorebeer.pl/` and browse to a beer
   listing/category page.
3. Wait ~1–2s: ⭐ rating badges appear on beers present in our catalog. Clicking a
   badge opens the beer (or an Untappd search) in a new tab.
4. Click the toolbar icon: the popup shows **"Not connected — showing global ratings
   only (⭐)"** with a **"Get a token"** button. This is the expected unauthenticated
   state — the extension is fully functional for global ratings; a token only adds
   personal ✅/rating data.

## Authorized mode (optional)

Personal "already drank" badges require a token issued by the project's Telegram
bot (`/extension` command) after a user imports their own Untappd history. This is
opt-in and not needed to review the core functionality.

## Permissions

- Host access to the supported shop domains — to read product names and inject
  rating badges.
- `untappd.com` + `*.algolia.net` are **optional** and requested only if the user
  enables "find missing beers" / check-in sync.

## Privacy

See the published privacy policy. Anonymous `/match` sends only shop product
names/breweries to the backend and returns public catalog ratings — no personal or
account data is involved unless the user adds a token.
