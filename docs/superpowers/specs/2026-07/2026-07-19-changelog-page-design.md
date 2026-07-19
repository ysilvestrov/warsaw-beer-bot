# Changelog page on GitHub Pages — design

**Date:** 2026-07-19
**Status:** approved

## Problem

The Chrome Web Store has no per-version "release notes" / "What's new" field, so CWS
users get silent auto-updates with no way to see what changed. We already host a static
docs site on GitHub Pages (`site/`, deployed via `.github/workflows/pages.yml` after
`npm run render-docs`). Add a public changelog page there so users have an out-of-band
place to read what changed per version.

## Approach

Render `extension/CHANGELOG.md` verbatim into a new static page using the existing
`scripts/render-docs.ts` (marked → self-contained HTML) pipeline. The CHANGELOG is the
single source of truth and is already user-facing prose, so the page self-maintains on
every release with no extra step.

## Changes

### `scripts/render-docs.ts`
The current `renderPage` assumes every page is a bilingual install guide: it hardcodes
the `<title>` ("Warsaw Beer Overlay — Setup") and always emits an alternate-language nav
link ("Read in English" / "Читати українською"). The changelog is EN-only with a
different title, so generalize two `RenderOptions` fields:

- `title: string` — page `<title>`. Install guides pass "Warsaw Beer Overlay — Setup";
  changelog passes "Warsaw Beer Overlay — Changelog".
- alt-language link optional — make `altLang`/`altHref` optional. When omitted, the nav
  renders only the "← Home" link (no alt-language link).

Add a third render target: `extension/CHANGELOG.md` → `site/changelog/index.html`
(`lang: 'en'`, `homeHref: '../'`, no alt link).

The two install-guide targets keep identical output (they still pass `title` +
`altLang`/`altHref`).

### `site/index.html`
Add one link to the existing `ul.links` list:
`📝 <a href="changelog/">Changelog</a>` (placed after the install guides, before or near
the privacy link).

### `.github/workflows/pages.yml`
Add `extension/CHANGELOG.md` to the `on.push.paths` list so the page redeploys when the
changelog changes.

## Testing

Extend the existing `render-docs` test (`scripts/render-docs.test.ts`) to cover the two
new behaviors:
- `renderPage` uses a custom `title` when provided.
- `renderPage` omits the alternate-language nav link when `altLang`/`altHref` are not
  provided (and still renders the "← Home" link).

Existing install-guide rendering (title + both nav links) stays covered.

## Out of scope (YAGNI)

- No changelog links injected into the install-guide markdown.
- No per-version anchors / deep-linking.
- No Ukrainian translation of the changelog (EN-only, like the privacy policy).
