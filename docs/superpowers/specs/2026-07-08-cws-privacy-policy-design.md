# CWS prep: privacy policy + data-usage disclosures

**Issue:** #244. Series: `chrome-web-store`.
**Date:** 2026-07-08

## Goal

Provide the Chrome-Web-Store-required privacy policy (stable public URL) and a draft of the
dashboard "Privacy practices" answers, plus record the extension's data flows in `spec.md`.
The policy must accurately describe every place user data goes, with explicit sections for
the two opt-in behaviours (Untappd enrichment, check-in sync).

## Decisions (locked)

- **Hosting:** GitHub Pages, published via a GitHub Actions workflow that deploys **only**
  a `site/` folder (not `/docs`, which would expose internal runbooks as a rendered site).
  URL: `https://ysilvestrov.github.io/warsaw-beer-bot/`.
- **Language:** English only.
- **Contact:** `yuriy@silvestrov.com`.
- **No extension UI change** here (an in-options link to the policy is deferred to #245,
  which already edits the options page). Keeps this issue free of a
  `docs/extension-install-uk.md` update.

## Data inventory (from code audit — the factual basis of the policy)

| Data | Destination | When |
|---|---|---|
| **Auth token** (from bot `/extension`) | `chrome.storage.local`; sent as `Authorization: Bearer` to beer-api only | always |
| **Beer/brewery names** (+ABV) parsed from visible shop cards | `POST beer-api/match` | on every supported shop page |
| **Match cache** | `chrome.storage.local` (`mc2:` keys), local only | — |
| **Enrichment** (opt-in, separate host permission): orphan beer names | → beer-api `/enrich/candidates` → the name is searched on **Algolia** (Untappd's search) from the user's session → raw Algolia response → beer-api `/enrich/result` | only if enabled; ≤20/page, throttled ~4s |
| **Check-in sync** (opt-in, `untappd.com` permission): HTML of the user's **own** Untappd check-in feed | raw HTML → beer-api `/checkins/sync` (server parses drunk beers + personal ratings, stores under the user's account) | only on the popup Sync button |

**Not collected:** no analytics, telemetry, tracking pixels, advertising, or data sale; no
network destinations other than beer-api and (only with the opt-ins) Untappd + its Algolia.

Source references: `extension/src/api/client.ts` (all endpoints), `extension/src/content/enrich.ts`
(enrichment loop), `extension/src/background/handle-checkin-sync.ts` (feed fetch → server).

## Design

### Files added

- `site/index.html` — the privacy policy. Self-contained (inline CSS, no external assets),
  light/dark via `prefers-color-scheme`, mobile-readable. Sections:
  1. Intro (what this extension is, who the maintainer is).
  2. What data is processed and why (the inventory table, in prose + list).
  3. Where data goes (beer-api; and, only with the opt-ins, Untappd + Algolia).
  4. **Untappd enrichment** (opt-in): what it sends, when, how to turn it off.
  5. **Check-in sync** (opt-in): reads the user's own Untappd feed, sends it to the server
     to record drunk beers + ratings; how to avoid it (don't grant / don't press Sync).
  6. Storage & retention (token + cache local until removed; server-side check-in/match
     data tied to the user's bot account, governed by the bot).
  7. What is NOT collected (no analytics/tracking/ads/sale).
  8. User controls (remove token, "Clear all cache", disable enrichment, uninstall).
  9. Contact (`yuriy@silvestrov.com`), effective date, and a "changes to this policy" line.
- `.github/workflows/pages.yml` — on push to `main` touching `site/**` (and manual
  `workflow_dispatch`), upload `site/` as the Pages artifact and deploy via
  `actions/deploy-pages`. Permissions `pages: write`, `id-token: write`; concurrency group
  `pages`.
- `docs/cws-data-usage.md` — draft answers for the CWS dashboard "Privacy practices" tab:
  single-purpose description; per-permission justification (`storage`, `activeTab`,
  `host_permissions` beer-api, optional `untappd.com`/`*.algolia.net`); data categories —
  **Authentication information** (token) + **Website content** (shop card text + Untappd feed
  HTML); the three required certifications (not sold; not used beyond core functionality; not
  for creditworthiness) all affirmed. Includes the policy URL.

### Files modified

- `spec.md` — new subsection under §6 ("Потоки даних розширення") holding the inventory
  table as the canonical source, plus a pointer to the hosted policy + `docs/cws-data-usage.md`.

### One-time setup (outside code)

- Enable Pages with **Source: GitHub Actions**. Attempt via
  `gh api --method POST /repos/ysilvestrov/warsaw-beer-bot/pages -f build_type=workflow`;
  if the token lacks scope, drop a one-line instruction in `./tmp/` for the user.

## Testing / verification

- `site/index.html` is valid, self-contained (no external `http(s)://` asset refs), and
  renders in both colour schemes — verify by opening it headless (Playwright) and checking it
  loads with no external requests + a screenshot in each scheme.
- Workflow YAML parses (`python3 -c yaml.safe_load`) and references
  `actions/upload-pages-artifact` + `actions/deploy-pages`.
- After merge: confirm the Actions run is green and the URL serves the policy (HTTP 200).

## Non-goals

- In-extension link to the policy (#245).
- Actual CWS dashboard submission (#246).
- UK translation.

## Risks

- **Pages not enabled / wrong source** → first deploy fails. Mitigated by attempting the API
  enable and documenting the manual click.
- **Policy drift from code.** The inventory lives in both `spec.md` and the policy; a code
  change that alters data flow must update both. Noted in the policy-adjacent spec section.
