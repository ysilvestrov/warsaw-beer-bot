# Design: English extension docs, Pages hosting & project README (#162)

**Date:** 2026-07-11
**Issue:** #162 — "Provide user-related extension documentation in english"
**Status:** approved (brainstorming)

## Problem

Issue #162 asks for three things, all still open:

1. Translate `docs/extension-install-uk.md` into English.
2. Host the guide "somewhere on server (GitHub sites/wiki)" and link to it **from the
   extension**.
3. Add a README to the GitHub project (there is none).

Current state (verified 2026-07-11):

- Only the Ukrainian guide exists (`docs/extension-install-uk.md`, ~18 KB).
- GitHub Pages already serves a landing page (`site/index.html`) + privacy policy
  (`site/privacy/`), built by `.github/workflows/pages.yml`, which uploads `site/`
  verbatim. The landing page links the UK guide as a **raw GitHub markdown blob**,
  labelled "(Ukrainian)" — it already anticipates an English version.
- The extension links to **no** guide. The popup no-token state has a "Get a token"
  button that opens the options page (`chrome.runtime.openOptionsPage()`); the options
  page has only the token field (hint: "from the bot's `/extension` command").
- No `README.md` at the repo root.

## Goals

- A faithful English translation of the install/setup guide.
- Both guides rendered as **real HTML pages on GitHub Pages**, styled like the landing
  page, from a single markdown source of truth (no hand-maintained HTML duplicate).
- The extension surfaces a link to the (English) guide where a new user needs it.
- An English project README that orients a visitor and links onward.

## Non-goals

- No CWS-listing or store changes (tracked in the `chrome-web-store` series).
- No rewrite of the guide's content — the English version mirrors the Ukrainian one
  section-for-section.
- No i18n framework for the extension UI (it is already English-only).

## Design

### 1. English guide — `docs/extension-install-en.md`

Faithful, section-for-section translation of `docs/extension-install-uk.md`. Markdown
stays the **single source of truth** for both languages; the HTML pages are generated
(see §2). The two `.md` files are kept structurally parallel so the CLAUDE.md mandate
("update the UK guide in every user-facing extension PR") can be applied to both at once.

### 2. Pages rendering — build step in `pages.yml`

`.github/workflows/pages.yml` gains a render step before the upload:

- Add `actions/setup-node`, `npm ci`, then run a repo script
  `scripts/render-docs.mjs` (Node, using `marked` — new devDependency).
- The script renders each source doc into `site/`:
  - `docs/extension-install-en.md` → `site/install/index.html`
  - `docs/extension-install-uk.md` → `site/install-uk/index.html`
- Each output is wrapped in a **shared HTML template** that matches the landing page:
  self-contained `<style>` (light/dark via `prefers-color-scheme`, no external assets),
  a header with an **EN ⇄ UK language switch** and a "← Home" link back to the landing
  page, and the rendered markdown body.
- Generated output lives under `site/install/` and `site/install-uk/`, which are
  **git-ignored** (produced in CI, not committed). The script is runnable locally for
  preview.
- Trigger `paths` is extended to include `docs/extension-install-*.md` and
  `scripts/render-docs.mjs`, so editing a guide re-deploys Pages.

Public URLs:
- EN: `https://ysilvestrov.github.io/warsaw-beer-bot/install/`
- UK: `https://ysilvestrov.github.io/warsaw-beer-bot/install-uk/`

The landing page (`site/index.html`) link list is updated: the "Install & setup guide"
entry points at `install/` (English), with a second entry for `install-uk/` (Ukrainian),
replacing the current raw-blob link.

### 3. Extension links to the guide

A single shared guide URL constant (English page) is added to the extension config.

- **Options page** (`options.html` / `options.ts`): a short line near the token field —
  "New here? Read the setup guide →" — linking to the EN guide URL (open in a new tab).
- **Popup, no-token state** (`popup.html` / `popup.ts`): the same guide link shown
  alongside the existing auth note + "Get a token" button, so a user without a token is
  pointed at the guide immediately. Shown/hidden with the same no-token logic as the
  `getToken` button.

These are new English UI strings and a new user-facing behavior → the guides
(`extension-install-en.md` + `-uk.md`) must document where the link appears, and
`spec.md` is reviewed for a matching update (extension UI surface).

### 4. Project README — `README.md` (English)

Overview-level, not a duplicate of the install guide:

- What the project is: Warsaw craft-beer crawler bot + Untappd matching + browser
  extension that badges beers on shop pages.
- Key features (badges ✅/⭐/❓/⚪, supported shops list).
- Links: install guides (EN/UK on Pages), privacy policy, `spec.md`, the extension.
- Short developer section: stack (Node/TypeScript/Telegraf/SQLite), `.env` keys read from
  file, `npm test` (Vitest) / `npm run dev`.

## Testing

- **Render script:** a unit/smoke test invoking `render-docs.mjs` against a small
  markdown fixture (or the real docs) asserts it produces valid HTML containing the
  rendered body **and** the EN ⇄ UK language-switch markup.
- **Extension:** extend `extension/src/options/options.test.ts` and
  `extension/src/popup/popup.test.ts` to assert the setup-guide link renders with the
  correct `href` (and, for the popup, only in the no-token state).
- **README:** no automated test.

## Definition of done

- `docs/extension-install-en.md` exists and mirrors the UK guide.
- `pages.yml` renders both guides to `site/install/` and `site/install-uk/`; landing
  page links updated; generated dirs git-ignored.
- Extension options + popup (no-token) link to the EN guide; tests cover the links.
- `README.md` added at repo root.
- `extension-install-{en,uk}.md` mention the in-extension guide link; `spec.md` reviewed.
- All tests green; `npm audit` unaffected.

## Workflow

Separate branch + PR per the standard cycle. This is a user-facing extension change, so
the extension-docs mandate and the AI-review/PR loop apply.
