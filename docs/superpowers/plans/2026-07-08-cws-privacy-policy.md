# CWS Privacy Policy + Data-Usage Disclosures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a Chrome-Web-Store-required privacy policy at a stable GitHub Pages URL, draft the dashboard "Privacy practices" answers, and record the extension's data flows in `spec.md`.

**Architecture:** A self-contained `site/index.html` is deployed to GitHub Pages by a workflow that publishes only the `site/` folder (internal `docs/` stays unpublished). Supporting docs (`docs/cws-data-usage.md`) and `spec.md` are plain markdown. No extension code changes.

**Tech Stack:** Static HTML/CSS, GitHub Actions (`actions/upload-pages-artifact`, `actions/deploy-pages`), Playwright (verification only).

**Working dir:** worktree `cws-privacy-policy`. Paths are repo-root-relative. Effective date to use: **2026-07-08**. Policy URL: `https://ysilvestrov.github.io/warsaw-beer-bot/`. Contact: `yuriy@silvestrov.com`.

---

### Task 1: Privacy policy page (`site/index.html`)

**Files:**
- Create: `site/index.html`

- [ ] **Step 1: Write the policy HTML**

Create `site/index.html` with exactly this content:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Warsaw Beer Overlay — Privacy Policy</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        max-width: 46rem; margin: 2rem auto; padding: 0 1.1rem;
        font: 16px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        color: #1a1a1a; background: #fff;
      }
      h1 { font-size: 1.6rem; margin-bottom: .2rem; }
      h2 { font-size: 1.2rem; margin-top: 2rem; }
      .updated { color: #666; margin-top: 0; }
      table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
      th, td { border: 1px solid #ccc; padding: .5rem .6rem; text-align: left; vertical-align: top; }
      th { background: #f2f2f2; }
      code { background: #f2f2f2; padding: .1rem .3rem; border-radius: 3px; }
      a { color: #1a5fb4; }
      footer { margin-top: 2.5rem; color: #666; font-size: .9rem; }
      @media (prefers-color-scheme: dark) {
        body { color: #e6e6e6; background: #16181c; }
        th { background: #23262c; } td, th { border-color: #3a3d44; }
        code { background: #23262c; } a { color: #78aeed; }
        .updated, footer { color: #9aa0a6; }
      }
    </style>
  </head>
  <body>
    <h1>Warsaw Beer Overlay — Privacy Policy</h1>
    <p class="updated">Last updated: 8 July 2026</p>

    <p>
      Warsaw Beer Overlay ("the extension") is a browser extension that shows, on supported
      craft-beer shop pages, which beers you have already drunk and your ratings, by matching
      the beers on the page against your personal beer history held by the Warsaw Beer Crawler
      bot. This policy explains what data the extension processes and where it goes. The
      extension is a personal, non-commercial project maintained by Yuriy Silvestrov.
    </p>

    <h2>What the extension processes, and why</h2>
    <table>
      <tr><th>Data</th><th>Where it goes</th><th>Why</th></tr>
      <tr>
        <td>Your access token (obtained from the bot's <code>/extension</code> command)</td>
        <td>Stored locally in the browser (<code>chrome.storage.local</code>); sent only to the
          bot's API at <code>beer-api.ysilvestrov-ai.uk</code> as an authorization header</td>
        <td>To authenticate your requests to the API</td>
      </tr>
      <tr>
        <td>Beer and brewery names (and, when shown, ABV) read from the shop page you are viewing</td>
        <td>Sent to <code>beer-api.ysilvestrov-ai.uk</code></td>
        <td>To match page beers against your history and return which you have drunk and your ratings</td>
      </tr>
      <tr>
        <td>Match results</td>
        <td>Cached locally in the browser only</td>
        <td>To avoid re-requesting the same beers and to render badges quickly</td>
      </tr>
    </table>

    <h2>Untappd enrichment (optional, off by default)</h2>
    <p>
      If you turn on "Find missing beers via Untappd" in the extension's options, then for beers
      not yet in the catalog the extension performs throttled searches (at most 20 per page)
      against Untappd's search service (Algolia) using your logged-in Untappd session, and sends
      the search results to <code>beer-api.ysilvestrov-ai.uk</code> so the beer can be identified.
      This feature requires a separate permission that you grant explicitly, and it does nothing
      until you enable it. To turn it off, uncheck the option; the permission can be revoked at any
      time from the extension's options.
    </p>

    <h2>Check-in sync (optional, only when you press "Sync")</h2>
    <p>
      The popup's "Sync my check-ins" button fetches the HTML of your own Untappd check-in feed
      using your logged-in Untappd session and sends it to <code>beer-api.ysilvestrov-ai.uk</code>,
      where the server records which beers you have drunk and your ratings under your account. This
      runs only when you press the button and grant access to <code>untappd.com</code>. If you never
      press it, no Untappd data is read.
    </p>

    <h2>Storage and retention</h2>
    <p>
      Your token and the match cache are stored locally in your browser until you remove the token,
      clear the cache, or uninstall the extension. Data sent to <code>beer-api.ysilvestrov-ai.uk</code>
      (matched beers and, if you use it, your check-in history) is stored server-side, tied to your
      bot account, and is governed by the Warsaw Beer Crawler bot; you can ask the maintainer to
      delete it (see Contact).
    </p>

    <h2>What the extension does NOT do</h2>
    <ul>
      <li>No analytics, telemetry, or tracking of your browsing.</li>
      <li>No advertising and no advertising identifiers.</li>
      <li>No selling or sharing of your data with third parties.</li>
      <li>No network requests other than to <code>beer-api.ysilvestrov-ai.uk</code> and — only if
        you enable the optional features — Untappd and its search service (Algolia).</li>
    </ul>

    <h2>Your controls</h2>
    <ul>
      <li>Remove your token in the extension's options to stop all API requests.</li>
      <li>"Clear all cache" in the popup removes locally cached match data.</li>
      <li>Leave "Find missing beers via Untappd" off (or uncheck it) to disable enrichment.</li>
      <li>Simply never press "Sync my check-ins" to avoid reading your Untappd feed.</li>
      <li>Uninstall the extension to remove all locally stored data.</li>
    </ul>

    <h2>Changes to this policy</h2>
    <p>
      If the data the extension handles changes, this page will be updated and the "Last updated"
      date above changed accordingly.
    </p>

    <h2>Contact</h2>
    <p>Questions or data-deletion requests: <a href="mailto:yuriy@silvestrov.com">yuriy@silvestrov.com</a>.</p>

    <footer>Warsaw Beer Overlay — personal, non-commercial project.</footer>
  </body>
</html>
```

- [ ] **Step 2: Verify it is self-contained and renders in both colour schemes**

Create `extension/_verify_policy.mjs` temporarily (extension dir has Playwright):
```js
import { chromium } from 'playwright';
import { resolve } from 'node:path';
const url = 'file://' + resolve(process.argv[2]);
const b = await chromium.launch();
const p = await b.newPage();
const external = [];
p.on('request', (r) => { if (!r.url().startsWith('file://') && !r.url().startsWith('data:')) external.push(r.url()); });
for (const scheme of ['light', 'dark']) {
  await p.emulateMedia({ colorScheme: scheme });
  await p.goto(url, { waitUntil: 'load' });
  await p.screenshot({ path: `/tmp/policy-${scheme}.png` });
}
await b.close();
console.log('external requests:', external);
process.exit(external.length === 0 ? 0 : 1);
```
Run: `cd extension && node _verify_policy.mjs ../site/index.html; echo exit $?; rm -f _verify_policy.mjs`
Expected: `external requests: []` and `exit 0`. Inspect `/tmp/policy-light.png` and `/tmp/policy-dark.png` look readable.

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "docs: privacy policy page for Chrome Web Store (#244)"
```

---

### Task 2: GitHub Pages deploy workflow

**Files:**
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/pages.yml`:
```yaml
name: Deploy privacy policy to Pages

on:
  push:
    branches: [main]
    paths: ['site/**', '.github/workflows/pages.yml']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Verify the YAML parses and references the right actions**

Run:
```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/pages.yml')); assert d['jobs']['deploy']['steps'][-1]['uses'].startswith('actions/deploy-pages'); assert any('upload-pages-artifact' in (s.get('uses') or '') for s in d['jobs']['deploy']['steps']); print('workflow OK')"
```
Expected: `workflow OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: deploy privacy policy to GitHub Pages (#244)"
```

---

### Task 3: CWS data-usage draft (`docs/cws-data-usage.md`)

**Files:**
- Create: `docs/cws-data-usage.md`

- [ ] **Step 1: Write the draft**

Create `docs/cws-data-usage.md`:
```markdown
# Chrome Web Store — Privacy practices answers (draft for #244/#246)

Reference for filling the CWS dashboard "Privacy practices" tab. Privacy policy URL:
https://ysilvestrov.github.io/warsaw-beer-bot/

## Single purpose
Show, on supported craft-beer shop pages, which beers the user has already drunk and their
ratings, by matching page beers against the user's personal history held by the Warsaw Beer
Crawler bot.

## Permission justifications
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
- **Website content** — YES (beer/brewery names read from shop pages; HTML of the user's own
  Untappd check-in feed when they use Sync).
- Personally identifiable info, health, financial, personal communications, location, web
  history, user activity (analytics-style) — NO.

## Required certifications
- I do NOT sell or transfer user data to third parties (outside approved use cases) — TRUE.
- I do NOT use or transfer user data for purposes unrelated to the item's single purpose — TRUE.
- I do NOT use or transfer user data to determine creditworthiness or for lending — TRUE.

## Notes
- Both Untappd-touching behaviours are opt-in and separately permissioned; they are described
  in the privacy policy and must be described in the store listing (#246).
```

- [ ] **Step 2: Commit**

```bash
git add docs/cws-data-usage.md
git commit -m "docs: CWS data-usage disclosure draft (#244)"
```

---

### Task 4: Record data flows in `spec.md`

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Add the data-flow subsection**

In `spec.md`, immediately after the new `### 6.2` store/dev build section (added in #243),
insert a `### 6.3` subsection:
```markdown
### 6.3 Потоки даних розширення (privacy)
> Канонічний перелік для privacy policy (#244). Політика: https://ysilvestrov.github.io/warsaw-beer-bot/ ; чернетка CWS-дисклоужерів: `docs/cws-data-usage.md`.

| Дані | Куди | Коли |
|---|---|---|
| Токен (`/extension`) | `chrome.storage.local`; `Authorization: Bearer` лише на beer-api | завжди |
| Назви пива/броварні (+ABV) з видимих карток | POST `beer-api/match` | на підтримуваній сторінці |
| Кеш матчів (`mc2:`) | локально | — |
| Enrichment (opt-in): назви orphan | beer-api `/enrich/candidates` → Algolia (сесія юзера) → beer-api `/enrich/result` | лише увімкнено, ≤20/стор. |
| Sync check-ins (opt-in): HTML власної стрічки Untappd | beer-api `/checkins/sync` (сервер парсить пиття+оцінки) | лише по кнопці Sync |

Немає аналітики/трекінгу/реклами/продажу даних. Інших мережевих призначень, окрім beer-api та
(за згодою) Untappd+Algolia, немає. Зміна цих потоків у коді МУСИТЬ оновити і політику, і цю таблицю.
```

- [ ] **Step 2: Verify placement**

Run: `grep -n "### 6.3 Потоки даних" spec.md`
Expected: one match, located after the `### 6.2` heading (`grep -n "### 6.2" spec.md` line number is smaller).

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): extension data-flow inventory for privacy policy (#244)"
```

---

### Task 5: Enable Pages, open PR, verify deploy

- [ ] **Step 1: Attempt to enable Pages via API (best-effort)**

Run:
```bash
gh api --method POST /repos/ysilvestrov/warsaw-beer-bot/pages -f build_type=workflow 2>&1 | tail -3 || true
```
Expected: either a JSON Pages object, or "already exists" / a scope error. If it errors on
scope, write `./tmp/enable-pages.md` telling the user: *Settings → Pages → Build and deployment
→ Source: GitHub Actions.*

- [ ] **Step 2: Push branch and open PR**

```bash
git push -u origin worktree-cws-privacy-policy
gh pr create --title "docs: CWS privacy policy + data-usage disclosures (#244)" --body "<summary; Closes #244; policy URL; note Pages one-time enable>"
```

- [ ] **Step 3: After merge — verify the deploy**

After the PR merges to main: confirm the `Deploy privacy policy to Pages` Actions run is green
and `https://ysilvestrov.github.io/warsaw-beer-bot/` returns HTTP 200 with the policy.
Run: `curl -sSI https://ysilvestrov.github.io/warsaw-beer-bot/ | head -1` → expect `200`.

- [ ] **Step 4: Poll AI review, address findings**

Wait for the AI PR review; read each finding critically; fix valid ones, push back on wrong ones.
```

---

## Notes for the executor
- No extension code changes — do not touch `extension/src/**` or the manifest.
- `docs/extension-install-uk.md` is intentionally NOT updated (no user-facing extension change).
- Keep the effective date and the policy URL identical across `site/index.html`,
  `docs/cws-data-usage.md`, and `spec.md`.
