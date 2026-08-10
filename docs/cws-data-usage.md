# Chrome Web Store — Privacy practices answers (draft for #244/#246)

Reference for filling the CWS dashboard "Privacy practices" tab. Privacy policy URL:
https://ysilvestrov.github.io/warsaw-beer-bot/privacy/

## Single purpose
Show, on supported craft-beer shop pages, which beers the user has already drunk and their
ratings, by matching page beers against the user's personal history held by the Warsaw Beer
Crawler bot.

## Permission justifications
Dashboard reality: `storage` and `activeTab` each get their own field; **all host
access shares one combined "Host permission justification" field** (content-script shop
domains + `beer-api` + optional hosts) — paste the consolidated text from
[`cws-listing.md`](./cws-listing.md) ("Host permission justification").

- **storage** — cache match results and store the user's token/settings locally.
- **activeTab** — the popup reads the active tab's URL and messages its content script to
  refresh badges on the current page.
- **host `beer-api.ysilvestrov-ai.uk`** — the extension's own API: matching and (optional)
  enrichment/check-in submission.
- **optional host `untappd.com`** — only if the user enables enrichment or presses "Sync":
  read the user's own Untappd check-in feed / run searches from their session.
- **optional host `*.algolia.net`** — Untappd's search backend, used by the optional
  enrichment feature to find missing beers.

## Data collected (dashboard checkboxes)
- **Authentication information** — YES (the user's API token).
- **Website content** — YES (beer/brewery names read from shop pages, including — on Flasker
  — each product's own page fetched in the background for the same beer/brewery data; HTML
  of the user's own Untappd check-in feed when they use Sync).
- Personally identifiable info, health, financial, personal communications, location, web
  history, user activity (analytics-style) — NO.

## Required certifications
- I do NOT sell or transfer user data to third parties (outside approved use cases) — TRUE.
- I do NOT use or transfer user data for purposes unrelated to the item's single purpose — TRUE.
- I do NOT use or transfer user data to determine creditworthiness or for lending — TRUE.

## Notes
- Both Untappd-touching behaviours are opt-in and separately permissioned; they are described
  in the privacy policy and must be described in the store listing (#246).
- **Flasker product-detail fetch (#384, not opt-in).** On Flasker listings, the content
  script also fetches each new product's own page in the background (capped at 20 per page
  load) to read the brewery and the Untappd link the shop publishes there — same data
  category ("Website content") and same already-granted content-script host, so no new
  permission and no dashboard-answer change; noted here because it is a second network
  request per product, not just a DOM read of the page the user is on.
