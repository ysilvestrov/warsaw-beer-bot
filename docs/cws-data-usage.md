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
- **Authentication information** — YES (the user's API token, or the anonymous install token
  the extension obtains for itself without one, #923).
- **Website content** — YES (beer/brewery names read from shop pages, including — on Flasker
  — each product's own page fetched in the background for the same beer/brewery data; HTML
  of the user's own Untappd check-in feed when they use Sync). The shop's domain sent with a
  match request (#923) is the same page content: the server already receives these beers.
- Personally identifiable info, health, financial, personal communications, location, web
  history, user activity (analytics-style) — NO.

**Why «User activity» stays NO with the anonymous install token (#923, owner's decision).** The
dashboard's «User activity» means network monitoring, clicks, mouse position, scroll or keystroke
logging. The extension collects none of these. What the server keeps for an install is a count of
calls to its own API: per day and shop domain, the number of match requests, beers and unmatched
beers, and enrich calls and links, plus the extension version. These are recorded against a random
install ID that is not tied to a person, kept 90 days, and deleted when the user switches
«Anonymous usage statistics» off. They serve usage accounting and capacity, which is within the
single purpose. The privacy policy describes it (section «Anonymous usage statistics»). If a reviewer
reads it differently, the conservative fallback is to tick «User activity» — and only that
checkbox changes.

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
