# Bierloods22 Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bierloods22 (`bierloods22.nl`) as a supported browser-extension shop adapter for issue #90.

**Architecture:** Follow `docs/adapter-authoring.md`: capture one SSR collection fixture, add one focused `SiteAdapter`, register it, mirror `hostMatch` in the manifest, and rely on registry-wide conformance tests for parsing and re-render behavior. Add bespoke tests only for Bierloods22-specific parsing quirks.

**Tech Stack:** TypeScript, MV3 extension, Vitest/jsdom, existing `SiteAdapter` interface.

---

### Task 1: Capture Fixture And Prove Missing Adapter Coverage

**Files:**
- Create: `extension/tests/fixtures/bierloods22.html`
- Modify: `extension/src/sites/registry.ts`
- Test: `extension/src/sites/conformance.test.ts`

- [ ] **Step 1: Capture the SSR collection fixture**

Run:

```bash
curl -L -A 'Mozilla/5.0' 'https://www.bierloods22.nl/en/all-beers/' > extension/tests/fixtures/bierloods22.html
```

Expected: `extension/tests/fixtures/bierloods22.html` exists and contains product-card HTML from Bierloods22.

- [ ] **Step 2: Add a temporary registry import that proves the adapter is missing**

Edit `extension/src/sites/registry.ts` to include this import and entry:

```ts
import type { SiteAdapter } from './types';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
import { beerfreak } from './beerfreak';
import { bierloods22 } from './bierloods22';

export const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer, beerfreak, bierloods22];

export function pickAdapter(url: URL): SiteAdapter | null {
  return ADAPTERS.find((a) => a.hostMatch(url)) ?? null;
}
```

- [ ] **Step 3: Run conformance to verify RED**

Run:

```bash
cd extension && npm test -- src/sites/conformance.test.ts
```

Expected: FAIL because `extension/src/sites/bierloods22.ts` does not exist.

### Task 2: Implement Bierloods22 Adapter

**Files:**
- Create: `extension/src/sites/bierloods22.ts`
- Test: `extension/src/sites/conformance.test.ts`

- [ ] **Step 1: Create the minimal SSR adapter**

Create `extension/src/sites/bierloods22.ts`:

```ts
import type { Card, SiteAdapter } from './types';

const CARD_SELECTOR = '.product-block';
const CONTAINER_SELECTOR = '.collection-products, .products';

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function cleanName(raw: string): string {
  return raw
    .replace(/\s+\|\s*Bierloods22\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const bierloods22: SiteAdapter = {
  id: 'bierloods22',
  hostMatch: (url) => url.hostname === 'bierloods22.nl' || url.hostname.endsWith('.bierloods22.nl'),
  reRenderContainerSelector: CONTAINER_SELECTOR,

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const name = cleanName(text(el.querySelector('.product-title a, .title a, a.title')));
      if (!name) continue;
      const brewery = text(el.querySelector('.product-vendor, .brand, .product-brand'));
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
```

- [ ] **Step 2: Run conformance and inspect failures**

Run:

```bash
cd extension && npm test -- src/sites/conformance.test.ts
```

Expected: Either PASS, or FAIL with selector-specific evidence. If selectors fail, inspect the fixture and update only `CARD_SELECTOR`, `CONTAINER_SELECTOR`, name selector, and brewery selector to match the fixture.

- [ ] **Step 3: Verify GREEN**

Run:

```bash
cd extension && npm test -- src/sites/conformance.test.ts
```

Expected: PASS.

### Task 3: Add Manifest Host Patterns And Changelog

**Files:**
- Modify: `extension/manifest.config.ts`
- Modify: `extension/CHANGELOG.md`
- Test: `extension/src/manifest.test.ts`

- [ ] **Step 1: Add manifest matches mirroring hostMatch**

In `extension/manifest.config.ts`, add these entries to `content_scripts[0].matches`:

```ts
'https://bierloods22.nl/*',
'https://*.bierloods22.nl/*',
```

- [ ] **Step 2: Add changelog entry**

In `extension/CHANGELOG.md`, under `## [Unreleased]`, add:

```md
- Added Bierloods22 shop support.
```

- [ ] **Step 3: Run manifest test**

Run:

```bash
cd extension && npm test -- src/manifest.test.ts
```

Expected: PASS.

### Task 4: Final Extension Verification

**Files:**
- All changed extension files

- [ ] **Step 1: Run targeted extension tests**

Run:

```bash
cd extension && npm test -- src/sites/conformance.test.ts src/sites/registry.test.ts src/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full extension suite**

Run:

```bash
cd extension && npm test
```

Expected: PASS.

- [ ] **Step 3: Review diff**

Run:

```bash
git diff --stat
git diff -- extension/src/sites/bierloods22.ts extension/src/sites/registry.ts extension/manifest.config.ts extension/CHANGELOG.md
```

Expected: Diff is limited to the Bierloods22 adapter, fixture, registry, manifest, changelog, and this plan.
