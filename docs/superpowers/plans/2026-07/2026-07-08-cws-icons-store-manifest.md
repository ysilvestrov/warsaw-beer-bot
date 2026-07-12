# CWS Icons + Store Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add extension icons and a store/dev manifest variant so the package is Chrome-Web-Store-acceptable without breaking the unpacked/beta channel.

**Architecture:** `manifest.config.ts` becomes a `buildManifest({store})` factory; the store variant drops `key` and `optional_host_permissions: https://*/*`; `tabs` is dropped everywhere in favour of `activeTab`. Icons come from one committed SVG rasterised to PNGs by a Playwright script. A Vite `define` (`__CWS_BUILD__`) lets the options page hide the custom-baseUrl field in the store build.

**Tech Stack:** TypeScript, Vite + @crxjs/vite-plugin, Vitest, Playwright (rasteriser), tsx.

**Working dir:** worktree `cws-icons-store-manifest`. All paths below are relative to repo root; extension code lives under `extension/`.

---

### Task 1: Icon source SVG + Playwright rasteriser

**Files:**
- Create: `extension/icons/icon.svg` (from `tmp/gemini-svg.svg`)
- Create: `extension/scripts/render-icons.ts`
- Modify: `extension/package.json` (add `render-icons` script)
- Create (generated): `extension/public/icons/icon-{16,32,48,128}.png`

- [ ] **Step 1: Copy the approved SVG into the extension**

```bash
cp tmp/gemini-svg.svg extension/icons/icon.svg
```

- [ ] **Step 2: Write `extension/scripts/render-icons.ts`**

```ts
// Rasterises extension/icons/icon.svg → public/icons/icon-<n>.png at CWS sizes.
// Uses Playwright (already a devDependency, also used for fixture capture). The SVG
// is non-square (200×240); we centre it in a square canvas with ~8% padding and a
// transparent background, preserving aspect ratio. Run via `npm run render-icons`
// whenever icon.svg changes; the PNGs are committed so `build` needs no browser.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');
const SIZES = [16, 32, 48, 128] as const;

async function main() {
  const svg = readFileSync(resolve(EXT_ROOT, 'icons/icon.svg'), 'utf8');
  const outDir = resolve(EXT_ROOT, 'public/icons');
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    for (const size of SIZES) {
      await page.setViewportSize({ width: size, height: size });
      const inner = Math.round(size * 0.92);
      await page.setContent(
        `<style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px}` +
          `.wrap{width:${size}px;height:${size}px;display:flex;align-items:center;` +
          `justify-content:center;box-sizing:border-box}` +
          `svg{width:${inner}px;height:${inner}px}</style>` +
          `<div class="wrap">${svg}</div>`,
        { waitUntil: 'load' },
      );
      const buf = await page.locator('.wrap').screenshot({ omitBackground: true });
      writeFileSync(resolve(outDir, `icon-${size}.png`), buf);
      console.log(`wrote icon-${size}.png`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm script**

In `extension/package.json` `"scripts"`, add:
```json
"render-icons": "tsx scripts/render-icons.ts",
```

- [ ] **Step 4: Generate the PNGs**

Run: `cd extension && npm run render-icons`
Expected: prints `wrote icon-16.png` … `wrote icon-128.png`; four files exist in `extension/public/icons/`.

- [ ] **Step 5: Sanity-check the PNGs are valid and correctly sized**

Run:
```bash
cd extension && for n in 16 32 48 128; do node -e "const b=require('fs').readFileSync('public/icons/icon-$n.png'); const w=b.readUInt32BE(16),h=b.readUInt32BE(20); if(b.slice(1,4).toString()!=='PNG'){process.exit(1)} console.log('$n:',w+'x'+h); if(w!==$n||h!==$n)process.exit(2)"; done
```
Expected: `16: 16x16` … `128: 128x128`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add extension/icons/icon.svg extension/scripts/render-icons.ts extension/package.json extension/public/icons
git commit -m "feat(extension): icon source SVG + Playwright rasteriser (#242)"
```

---

### Task 2: Refactor manifest into a store/dev factory + icons

**Files:**
- Modify: `extension/manifest.config.ts`
- Test: `extension/src/manifest.test.ts`

- [ ] **Step 1: Rewrite the failing tests for both variants**

Replace `extension/src/manifest.test.ts` with:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest } from '../manifest.config';
import pkg from '../package.json';

const dev = buildManifest({ store: false });
const store = buildManifest({ store: true });

describe('manifest (both variants)', () => {
  it('derives version from package.json', () => {
    expect(dev.version).toBe(pkg.version);
    expect(store.version).toBe(pkg.version);
  });

  it('drops tabs, keeps activeTab, in both variants', () => {
    for (const m of [dev, store]) {
      expect(m.permissions).toContain('activeTab');
      expect(m.permissions).not.toContain('tabs');
    }
  });

  it('injects the content script on supported shop pages', () => {
    const [cs] = dev.content_scripts!;
    expect(cs.matches).toContain('https://beerfreak.org/*');
    expect(cs.matches).toContain('https://funkyshop.pl/*');
  });

  it('exposes a popup action with a default icon', () => {
    expect(dev.action?.default_popup).toBe('src/popup/popup.html');
    expect(dev.action?.default_icon).toMatchObject({
      16: 'public/icons/icon-16.png',
      128: 'public/icons/icon-128.png',
    });
  });

  it('declares icons at 16/32/48/128', () => {
    for (const size of [16, 32, 48, 128] as const) {
      expect(dev.icons?.[size]).toBe(`public/icons/icon-${size}.png`);
    }
  });

  it('ships the referenced icon PNG files', () => {
    for (const size of [16, 32, 48, 128]) {
      expect(existsSync(resolve(__dirname, `../public/icons/icon-${size}.png`))).toBe(true);
    }
  });

  it('keeps enrichment optional origins in both variants', () => {
    for (const m of [dev, store]) {
      expect(m.optional_host_permissions).toContain('https://untappd.com/*');
      expect(m.optional_host_permissions).toContain('https://*.algolia.net/*');
    }
  });
});

describe('dev variant', () => {
  it('pins a stable extension id via key', () => {
    expect(typeof dev.key).toBe('string');
    expect((dev.key as string).length).toBeGreaterThan(100);
  });
  it('allows a custom baseUrl origin (https://*/*)', () => {
    expect(dev.optional_host_permissions).toContain('https://*/*');
  });
});

describe('store variant', () => {
  it('omits key (CWS rejects packages that carry one)', () => {
    expect(dev.key).toBeDefined();
    expect(store.key).toBeUndefined();
  });
  it('omits the broad https://*/* optional origin', () => {
    expect(store.optional_host_permissions).not.toContain('https://*/*');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run src/manifest.test.ts`
Expected: FAIL — `buildManifest` is not exported.

- [ ] **Step 3: Rewrite `extension/manifest.config.ts` as a factory**

```ts
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqyZ4PALvAS9pOB6ImBCHA9T+5+8R94pTlH0NlALbbwTBbx4lIkilGB82gxXN1u/i/f7FSRhmxN4w/1b4jcl8MxqsxUrJOFg9u2dm84lwIqLN0ocjcGliZsnUFpwXBkn/23EWnPFhHtSV7OLfegPP2edMvZLCJ7yeXNZpfpDhNCdsBbQraLawY21zE+x0OpnRZ7CT2TLXyi+JtiDusaYvSN4eOnGTOAZTCBvXdrikll1zOpqkWrZ2fjryQ8A+8NGEz3eXsokG9O6jy9oK21AS+fKTmjkNCsddsbCoZm8D0m4xLnDBxxkv4LOMWGFG1MPv4gz0aXspaximsyFExL38KQIDAQAB';

const ICONS = {
  16: 'public/icons/icon-16.png',
  32: 'public/icons/icon-32.png',
  48: 'public/icons/icon-48.png',
  128: 'public/icons/icon-128.png',
};

const SHOP_MATCHES = [
  'https://beerrepublic.eu/*', 'https://*.beerrepublic.eu/*',
  'https://onemorebeer.pl/*', 'https://*.onemorebeer.pl/*',
  'https://beerfreak.org/*', 'https://*.beerfreak.org/*',
  'https://bierloods22.nl/*', 'https://*.bierloods22.nl/*',
  'https://winetime.com.ua/*', 'https://*.winetime.com.ua/*',
  'https://hoptimaal.com/*', 'https://*.hoptimaal.com/*',
  'https://flasker.com.ua/*', 'https://*.flasker.com.ua/*',
  'https://piwnemosty.pl/*', 'https://*.piwnemosty.pl/*',
  'https://funkyshop.pl/*', 'https://*.funkyshop.pl/*',
];

// Enrichment/checkin-sync reach Untappd + its Algolia search from the user's session.
// The store build drops the broad 'https://*/*' (custom-baseUrl debugging) that the
// dev build keeps, to avoid an "access all sites" review flag.
const ENRICH_ORIGINS = ['https://untappd.com/*', 'https://*.algolia.net/*'];

export function buildManifest(opts: { store: boolean }) {
  // Single shape (key?: string) rather than a conditional spread, so consumers/tests can
  // read `.key` without a union type. `key: undefined` is dropped when crx serialises the
  // manifest to JSON, so the store build emits no key at all (CWS rejects packages with one).
  return {
    manifest_version: 3 as const,
    name: 'Warsaw Beer Overlay',
    description: 'Shows which beers you have already drunk + your rating on craft beer stores.',
    version: pkg.version,
    icons: ICONS,
    // storage: match cache + token/settings. activeTab: the popup reads the active tab's
    // URL (chrome.tabs.query) and messages its content script (chrome.tabs.sendMessage)
    // for "Refresh this page" — both covered by activeTab, so `tabs` is not needed.
    permissions: ['storage', 'activeTab'],
    host_permissions: ['https://beer-api.ysilvestrov-ai.uk/*'],
    optional_host_permissions: opts.store
      ? ENRICH_ORIGINS
      : [...ENRICH_ORIGINS, 'https://*/*'],
    action: { default_popup: 'src/popup/popup.html', default_icon: ICONS },
    options_page: 'src/options/options.html',
    background: { service_worker: 'src/background/index.ts', type: 'module' as const },
    content_scripts: [
      { matches: SHOP_MATCHES, js: ['src/content/main.ts'], run_at: 'document_idle' as const },
    ],
    // Dev keeps a pinned unpacked id so a tester's stored token survives folder changes.
    // Public key only; private key (~/warsaw-beer-extension-key.pem) kept by the maintainer.
    key: opts.store ? undefined : (KEY as string | undefined),
  };
}

export default defineManifest(buildManifest({ store: process.env.CWS_BUILD === '1' }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run src/manifest.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.config.ts extension/src/manifest.test.ts
git commit -m "feat(extension): store/dev manifest factory, drop tabs, add icons (#242, #243)"
```

---

### Task 3: Store build wiring (Vite define + scripts) and options baseUrl gating

**Files:**
- Modify: `extension/vite.config.ts`
- Modify: `extension/src/options/options.ts`
- Modify: `extension/package.json`
- Test: `extension/src/options/options.test.ts` (only if it references the gated code — check first)

- [ ] **Step 1: Inject `__CWS_BUILD__` via Vite define**

Rewrite `extension/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

const isStore = process.env.CWS_BUILD === '1';

export default defineConfig({
  plugins: [crx({ manifest })],
  define: { __CWS_BUILD__: JSON.stringify(isStore) },
  build: { target: 'es2022' },
});
```

- [ ] **Step 2: Declare the global for TypeScript**

Append to `extension/src/options/options.ts` top (after imports) — actually declare in a
type location. Add at the very top of `options.ts`:
```ts
declare const __CWS_BUILD__: boolean;
```
And add to `extension/tsconfig.json` nothing (the ambient `declare const` in the module
is sufficient because `options.ts` is a module; the `define` replaces the identifier at
build time). Under Vitest (no define) the identifier is undefined, so guard reads must be
written as `typeof __CWS_BUILD__ !== 'undefined' && __CWS_BUILD__`.

- [ ] **Step 3: Gate the custom-baseUrl field in `options.ts`**

In `initOptionsPage()`, after grabbing `urlInput`, add:
```ts
  const storeBuild = typeof __CWS_BUILD__ !== 'undefined' && __CWS_BUILD__;
  if (storeBuild && urlInput) {
    const row = urlInput.closest('label, .row, p') ?? urlInput;
    (row as HTMLElement).style.display = 'none';
  }
```
And in the `save` click handler, wrap the arbitrary-origin request so the store build
never asks for a host it cannot get:
```ts
    if (!storeBuild) {
      try {
        const origin = new URL(urlInput.value.trim()).origin + '/*';
        await chrome.permissions.request({ origins: [origin] });
      } catch {
        /* invalid URL or denied — surfaced by Test connection */
      }
    }
```
(Replace the existing unconditional try/catch block at `options.ts:64-70`.)

- [ ] **Step 4: Add build/package scripts for the store variant**

In `extension/package.json` `"scripts"`, add:
```json
"build:store": "CWS_BUILD=1 vite build",
"package:store": "CWS_BUILD=1 vite build && python3 scripts/zip-dist.py",
```

- [ ] **Step 5: Run the options tests (if any reference changed code)**

Run: `cd extension && npx vitest run src/options/options.test.ts`
Expected: PASS. If a test breaks because `__CWS_BUILD__` is undefined under Vitest, the
`typeof … !== 'undefined'` guard already handles it; fix the test only if it asserted the
old unconditional request behaviour.

- [ ] **Step 6: Commit**

```bash
git add extension/vite.config.ts extension/src/options/options.ts extension/package.json
git commit -m "feat(extension): store-build define + hide custom baseUrl in store options (#243)"
```

---

### Task 4: Build both variants, verify dist, update spec.md

**Files:**
- Modify: `spec.md`
- Modify: `docs/extension-install-uk.md` (only if user-facing — confirm)

- [ ] **Step 1: Full test + typecheck**

Run: `cd extension && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 2: Dev build and inspect dist manifest + icons**

Run:
```bash
cd extension && npm run build
node -e "const m=require('./dist/manifest.json'); console.log('key?', !!m.key, '| tabs?', (m.permissions||[]).includes('tabs'), '| activeTab?', (m.permissions||[]).includes('activeTab'), '| icons', Object.keys(m.icons||{}), '| broad?', (m.optional_host_permissions||[]).includes('https://*/*'))"
ls dist/icons
```
Expected: `key? true | tabs? false | activeTab? true | icons [16,32,48,128] | broad? true`; `dist/icons` lists the four PNGs.

- [ ] **Step 3: Store build and inspect**

Run:
```bash
cd extension && npm run build:store
node -e "const m=require('./dist/manifest.json'); console.log('key?', !!m.key, '| broad?', (m.optional_host_permissions||[]).includes('https://*/*'), '| untappd?', (m.optional_host_permissions||[]).includes('https://untappd.com/*'), '| icons', Object.keys(m.icons||{}))"
```
Expected: `key? false | broad? false | untappd? true | icons [16,32,48,128]`.

- [ ] **Step 4: Update `spec.md` — document store/dev build variants**

Add a subsection under the extension/build area of `spec.md` describing: dev build (default,
carries `key` + `https://*/*` for local testers), store build (`CWS_BUILD=1`, drops both;
`build:store`/`package:store`), icons pipeline (SVG → `render-icons` → committed PNGs), and
that `tabs` was replaced by `activeTab`. (Match the existing spec.md heading style.)

- [ ] **Step 5: Confirm docs/extension-install-uk.md**

The dev build (what testers load unpacked) is unchanged in behaviour: same key, same options
field, plus a real toolbar icon. No install-flow or user-facing option change for testers →
no doc update required. If, on inspection, the toolbar icon warrants a mention, add one line.

- [ ] **Step 6: Commit**

```bash
git add spec.md docs/extension-install-uk.md 2>/dev/null; git add spec.md
git commit -m "docs(spec): store/dev extension build variants + icon pipeline (#242, #243)"
```

---

### Task 5: Manual Chrome verification (activeTab) + PR

- [ ] **Step 1: Manual popup check (documented, best-effort)**

Load `extension/dist` (dev build) unpacked in Chrome, open a supported shop page, open the
popup, click "Refresh this page". Expected: status shows `Refreshed (N cleared)`, not a
permission error — confirming `activeTab` suffices without `tabs`. Record the result in the
PR description. (If it fails, restore `tabs` in `buildManifest` permissions and note it.)

- [ ] **Step 2: Push branch and open PR**

```bash
git push -u origin worktree-cws-icons-store-manifest
gh pr create --title "feat(extension): CWS-ready icons + store/dev manifest (#242, #243)" --body "<summary + Closes #242, #243 + manual-check result>"
```

- [ ] **Step 3: Poll AI review, address findings**

Wait for the AI PR review, read each finding critically, fix valid ones, push back on wrong
ones. Do not consider done at green tests.
