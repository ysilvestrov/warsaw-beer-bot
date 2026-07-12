# CWS prep: extension icons + store/dev manifest variant

**Issues:** #242 (icons), #243 (store manifest). Series: `chrome-web-store`.
**Date:** 2026-07-08

## Goal

Make the extension package acceptable to the Chrome Web Store without breaking the
existing unpacked/beta channel (bot broadcast + `extension_releases`). Two coupled
changes shipped in one PR because both touch `manifest.config.ts` and `manifest.test.ts`:

1. **Icons** — the manifest currently declares none; CWS rejects a package without them.
2. **Store/dev manifest variant** — the current manifest carries fields CWS rejects
   (`key`) or that trigger deep review (`tabs`, `optional_host_permissions: https://*/*`).

## Non-goals

- Actually uploading to CWS (that is #246/#247).
- Privacy policy, listing assets, no-token UX (#244/#245).
- Changing the dev/beta release pipeline (`npm run release` → bot broadcast) behaviour.

## Design

### Icons (#242)

- **Source of truth is an SVG**, not committed binaries. The user-provided
  `tmp/gemini-svg.svg` (a map-pin / location teardrop with a hop cone, amber→green
  gradient, bold black outline) becomes `extension/icons/icon.svg`.
- **`scripts/render-icons.ts`** rasterises the SVG → `extension/public/icons/icon-{16,32,48,128}.png`
  using Playwright (already a devDependency; the repo already uses it for fixture capture).
  The SVG is non-square (200×240); the script centres it in a square canvas with ~8%
  padding and a transparent background, preserving aspect ratio.
- **Reproducibility over prebuild:** the PNGs are generated artefacts, committed to git
  (so a plain `npm run build` needs no browser — important for CI) and regenerated via
  `npm run render-icons` when the SVG changes. No `prebuild` hook — building must not
  require a browser.
- **Manifest:** add `icons: {16,32,48,128}` and `action.default_icon: {16,32,48,128}`
  pointing at `public/icons/icon-<n>.png`. crxjs copies `public/` to the dist root, so the
  referenced paths resolve to `icons/icon-<n>.png` in the built extension.
- The 128px PNG doubles as the store-listing icon (#246).

### Store/dev manifest variant (#243)

- **Factory:** refactor `manifest.config.ts` to
  `export function buildManifest(opts: { store: boolean }): ManifestConfig`. The
  `default export` calls `buildManifest({ store: process.env.CWS_BUILD === '1' })` so
  `defineManifest` still receives a plain object.
- **Per-variant differences:**
  | field | dev (default) | store (`CWS_BUILD=1`) |
  |---|---|---|
  | `key` | present (stable unpacked id for testers) | **omitted** |
  | `optional_host_permissions` | `untappd.com`, `*.algolia.net`, `https://*/*` | `untappd.com`, `*.algolia.net` (no `https://*/*`) |
  | `permissions` | `storage`, `activeTab` | same |
- **`tabs` removed in BOTH variants** (not build-specific). The popup only reads the
  active tab (`chrome.tabs.query({active,currentWindow})` → `.url`) and messages its
  content script (`chrome.tabs.sendMessage`). `activeTab` covers the URL read (popup open
  is the invoking gesture) and `sendMessage` needs no tabs permission. Verified manually
  in Chrome (Refresh-this-page button) as part of implementation.
- **Options custom baseUrl field:** hidden in the store build. A compile-time constant
  `__CWS_BUILD__` is injected via Vite `define` (mirrors `CWS_BUILD`). In `options.ts`,
  when `__CWS_BUILD__` is true the baseUrl input + its arbitrary-origin
  `chrome.permissions.request` (`options.ts:62-72`) are hidden/skipped, since without
  `https://*/*` the request cannot succeed anyway. Dev build unchanged.
- **Build scripts:** add `build:store` (`CWS_BUILD=1 vite build`) and
  `package:store` (`build:store` + zip). Existing `build`/`package`/`release` stay dev.

### Tests

- `src/manifest.test.ts` imports `buildManifest` and asserts both variants:
  - dev: has `key` (len > 100), has `https://*/*` in optional hosts.
  - store: no `key`, no `https://*/*`; still has `untappd.com` + `*.algolia.net`.
  - both: `permissions` contains `activeTab`, does NOT contain `tabs`; content-script
    matches unchanged; popup action present; `icons` + `action.default_icon` declare
    16/32/48/128.
- A lightweight assertion that the four icon PNG files exist on disk (guards against a
  manifest that points at missing assets).

## Files touched

- `extension/icons/icon.svg` (new — from user SVG)
- `extension/public/icons/icon-{16,32,48,128}.png` (new, generated)
- `extension/scripts/render-icons.ts` (new)
- `extension/manifest.config.ts` (factory + icons)
- `extension/src/options/options.ts` (hide baseUrl in store build)
- `extension/vite.config.ts` (`define: __CWS_BUILD__`)
- `extension/package.json` (`render-icons`, `build:store`, `package:store`)
- `extension/src/manifest.test.ts` (both variants + icon files)
- `spec.md` (store/dev build variants section)
- `docs/extension-install-uk.md` — only if the options UI change is user-facing to
  current (dev-build) testers; it is not (dev build keeps the field), so likely untouched —
  confirm at the end.

## Risks

- **Playwright browser in the render path.** Mitigated: PNGs are committed; render is a
  manual/on-change command, not part of `build`.
- **`activeTab` insufficient for the popup.** Mitigated by manual Chrome verification of
  the Refresh button before merge; fallback is to restore `tabs` if the URL read fails.
- **crxjs `public/` path handling.** Verified by inspecting `dist/` after build that
  `icons/icon-*.png` exist and the manifest references resolve.
