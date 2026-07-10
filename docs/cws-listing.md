# Chrome Web Store — store listing materials (Warsaw Beer Overlay)

Copy-paste source for the CWS dashboard **Store listing** tab (#246). Privacy /
permission answers live in [`cws-data-usage.md`](./cws-data-usage.md); reviewer notes
in [`cws-review-notes.md`](./cws-review-notes.md). Listing language: **English only**
(a Ukrainian locale can be added later).

## Listing metadata

- **Name:** Warsaw Beer Overlay
- **Category:** Shopping
- **Language:** English (United States)
- **Summary** (≤132 chars, matches the manifest `description`):
  `Shows which beers you have already drunk + your rating on craft beer stores.`
- **Single purpose** (also in `cws-data-usage.md`):
  Show, on supported craft-beer shop pages, which beers the user has already drunk and
  their ratings, by matching page beers against the user's personal Untappd history.

## Detailed description (paste as-is)

```
See which beers you've already had — right on the shop page.

Warsaw Beer Overlay adds a small badge to every beer on supported craft-beer shops,
so you can decide at a glance:

• ⭐ community rating — the beer's global Untappd score
• ✅ you've already checked this beer in — with your own rating
• ❓ a probable match you may have had
• ⚪ known beer, not yet linked on Untappd

Works on: BeerRepublic, OneMoreBeer, BeerFreak, Bierloods22, WineTime, Hoptimaal,
Flasker, Piwne Mosty, and Funkyshop.

No account needed to start: global ⭐ ratings appear immediately. To unlock your
personal "already drank" ✅ badges, connect the companion Telegram bot (it imports
your own Untappd history) and paste the token into the extension's options.

Optional extras (off by default, ask for permission when enabled): find beers missing
from the catalog via your Untappd session, and sync your check-ins.

Clicking any badge opens the beer on Untappd (or a prefilled search). Your data stays
yours — see the privacy policy.
```

## Permission justifications

The CWS "Privacy practices" tab gives **one justification field per API permission**
plus a **single combined "Host permission justification"** textarea that covers ALL
host access (content-script shop domains + the API host + optional hosts) — not one
field per host. Fill them as follows.

### API permissions (separate fields)

- **storage** — `Caches beer-match results and stores the user's API token and settings locally, so pages show badges quickly without re-querying.`
- **activeTab** — `The popup's "Refresh this page" button and status readout act only on the tab where the user clicks the extension icon.`

### Host permission justification (one combined field — paste verbatim)

```
This extension needs host access to three groups of sites, each directly required by its single purpose — showing the user's Untappd check-in status and ratings on craft-beer shop pages.

1) Supported craft-beer shops (content scripts). Match patterns:
https://beerrepublic.eu/*, https://*.beerrepublic.eu/*,
https://onemorebeer.pl/*, https://*.onemorebeer.pl/*,
https://beerfreak.org/*, https://*.beerfreak.org/*,
https://bierloods22.nl/*, https://*.bierloods22.nl/*,
https://winetime.com.ua/*, https://*.winetime.com.ua/*,
https://hoptimaal.com/*, https://*.hoptimaal.com/*,
https://flasker.com.ua/*, https://*.flasker.com.ua/*,
https://piwnemosty.pl/*, https://*.piwnemosty.pl/*,
https://funkyshop.pl/*, https://*.funkyshop.pl/*.
On these specific stores the content script reads product (beer/brewery) names from the page and injects a small rating badge next to each beer. Every store is listed explicitly; the "*." subdomain wildcard only covers www/regional subdomains of the same store.

2) The extension's own backend — https://beer-api.ysilvestrov-ai.uk/*.
Badges are computed server-side: the extension sends the page's beer names to this API, which matches them against the beer catalog and the user's own Untappd history and returns the rating / already-drunk status. No third-party host is involved in the core feature.

3) Optional hosts, requested at runtime only if the user enables extra features — https://untappd.com/* and https://*.algolia.net/*.
Used solely for the opt-in "find missing beers" and "sync my check-ins" features, which query Untappd (and its Algolia search backend) from the user's own logged-in session. They are not requested unless the user turns the feature on.
```

Reference for the pattern syntax: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns

## Screenshots (capture at 1280×800 or 640×400; PNG/JPEG; min 1, aim 3–4)

Capture from the **store build** loaded unpacked (`cd extension && npm run build:store`,
then load `extension/dist` via chrome://extensions → Load unpacked). Anonymous
⭐ badges render without a token; load a token first if you want a ✅ in shot 1.

1. **Shop page with badges — the hero shot.** A real supported shop grid (e.g.
   `https://onemorebeer.pl/` category page) with several ⭐ and ⚪ badges visible on
   product cards; include one ✅ (your rating) if a token is loaded. Frame so 4–8 cards
   with badges are clearly visible. Full 1280×800.
2. **Popup.** Click the toolbar icon over a shop page so the popup is open and visible.
   Show either the working sync state (token loaded) or the no-token guidance
   ("Не авторизовано" note + "Як отримати токен" button) — pick one; the working state
   reads best for shoppers. Center the popup; pad to 1280×800 if needed.
3. **Options page.** `chrome://extensions` → Details → Extension options (or the popup's
   button). Show the token field and the "Find missing beers via Untappd" toggle — this
   is how a user connects. 1280×800.
4. *(optional)* **Badge legend / close-up.** A zoomed product card or lightly annotated
   shot explaining ✅ / ⭐ / ⚪ / ❓. Reinforces the value in one glance.

Tips: use a clean browser window (no unrelated extensions/toolbars in frame); prefer a
shop page with recognizable beers; keep captions short if the dashboard offers them.

## Store icon

128×128 listing icon already exists: `extension/public/icons/icon-128.png` (from #242).

## Privacy & data usage (dashboard "Privacy practices" tab)

All answers are in [`cws-data-usage.md`](./cws-data-usage.md):
- **Privacy policy URL:** https://ysilvestrov.github.io/warsaw-beer-bot/
- Data collected: Authentication information (YES), Website content (YES); everything
  else NO.
- The 3 required certifications: all TRUE.

## Reviewer notes (dashboard "Account" → review notes field)

Paste [`cws-review-notes.md`](./cws-review-notes.md). No test token is needed —
anonymous ⭐ mode (#245) makes the core feature verifiable with zero setup.

## Operational checklist (only you can do these)

- [ ] Register a Chrome Web Store developer account (one-time $5, verified email).
- [ ] EU DSA trader status: declare **non-trader** (free, non-commercial extension).
      Check the deadline/consequences shown at registration.
- [ ] Store listing tab: paste name, summary, detailed description; set category
      **Shopping**, language **English**; upload the 128×128 icon and screenshots.
- [ ] Permissions tab: paste each justification (table above / `cws-data-usage.md`).
- [ ] Privacy practices tab: privacy policy URL, data-collected checkboxes, 3
      certifications (`cws-data-usage.md`).
- [ ] Account → review notes: paste `cws-review-notes.md`.
- [ ] Upload the store package (`cd extension && npm run package:store`) and submit for
      review.

Part of the `chrome-web-store` series. Depends on #242 (icons), #244 (privacy), #245
(no-token UX + review notes). Distribution migration is tracked separately in #247.
