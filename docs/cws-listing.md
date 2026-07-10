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

⚠️ The field caps at **1000 characters**, so do NOT list every match pattern (the
reviewer sees them in the manifest). This condensed version is 872 chars:

```
Host access maps directly to this extension's single purpose: showing the user's Untappd check-in status and ratings on craft-beer shop pages.

Content scripts run only on 9 specific craft-beer stores — BeerRepublic, OneMoreBeer, BeerFreak, Bierloods22, WineTime, Hoptimaal, Flasker, Piwne Mosty and Funkyshop (including their www/regional subdomains) — to read product beer/brewery names from the page and inject a small rating badge next to each beer.

beer-api.ysilvestrov-ai.uk is the extension's own backend: it receives the page's beer names and returns the rating / already-drunk status. No third party is involved in the core feature.

untappd.com and *.algolia.net are optional and requested at runtime only if the user enables "find missing beers" or "sync my check-ins", which query Untappd and its Algolia search backend from the user's own logged-in session.
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
   ("Not connected" note + "Get a token" button) — pick one; the working state
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
- **Privacy policy URL:** https://ysilvestrov.github.io/warsaw-beer-bot/privacy/
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
- [ ] Permissions tab: paste the `storage` and `activeTab` justifications, then the
      combined **Host permission justification** text (see "Permission justifications").
- [ ] Privacy practices tab: privacy policy URL, data-collected checkboxes, 3
      certifications (`cws-data-usage.md`).
- [ ] Account → review notes: paste `cws-review-notes.md`.
- [ ] Upload the store package (`cd extension && npm run package:store`) and submit for
      review.

Part of the `chrome-web-store` series. Depends on #242 (icons), #244 (privacy), #245
(no-token UX + review notes). Distribution migration is tracked separately in #247.
