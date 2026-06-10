# WineTime Shop Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WineTime (`winetime.com.ua`) as a supported browser-extension shop adapter for issue #88.

**Architecture:** Follow the existing extension `SiteAdapter` architecture. Capture a WineTime fixture, add a focused SSR adapter that prefers `window.initialData.category.products` metadata with DOM fallback, register it, mirror host matching in the manifest, and document the new supported shop.

**Tech Stack:** TypeScript, MV3 extension, Vitest/jsdom, existing `SiteAdapter` interface.

---

### Task 1: Capture WineTime fixture

**Files:**
- Create: `extension/tests/fixtures/winetime.html`
- Test: `extension/src/sites/conformance.test.ts`

- [ ] **Step 1: Capture the WineTime beer category fixture**

Run:

```bash
curl -L -A 'Mozilla/5.0' 'https://winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo' > extension/tests/fixtures/winetime.html
```

Expected: `extension/tests/fixtures/winetime.html` exists and contains `a.product-micro`, `data-productkey`, and `window.initialData.category.products`.

- [ ] **Step 2: Inspect fixture anchors**

Run:

```bash
rg -n "product-micro|data-productkey|window.initialData.category.products" extension/tests/fixtures/winetime.html
```

Expected: output includes product cards and embedded category product metadata.

---

### Task 2: Add failing WineTime adapter tests

**Files:**
- Create: `extension/src/sites/winetime.test.ts`
- Create later: `extension/src/sites/winetime.ts`
- Test: `extension/src/sites/winetime.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `extension/src/sites/winetime.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { winetime } from './winetime';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/winetime.html'), 'utf8');
const INITIAL_DATA_RE = /window\.initialData\s*=\s*\{[\s\S]*?\n\s*window\.initialData\.category\s*=/;

function withoutInitialData(source: string): string {
  expect(source).toMatch(INITIAL_DATA_RE);
  return source.replace(INITIAL_DATA_RE, 'window.initialData = {};\n        window.initialData.category =');
}

let cards: ReturnType<typeof winetime.parseCards>;
beforeAll(() => {
  cards = winetime.parseCards(new DOMParser().parseFromString(html, 'text/html'));
});

describe('winetime adapter', () => {
  it('matches WineTime hosts', () => {
    expect(winetime.hostMatch(new URL('https://winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(true);
    expect(winetime.hostMatch(new URL('https://www.winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(true);
    expect(winetime.hostMatch(new URL('https://example.com/'))).toBe(false);
  });

  it('parses WineTime product cards from the fixture', () => {
    expect(cards.length).toBeGreaterThan(20);
    for (const card of cards) {
      expect(card.el).toBeInstanceOf(HTMLElement);
      expect(card.name.length).toBeGreaterThan(0);
    }
  });

  it('uses embedded manufacturer metadata for brewery', () => {
    expect(cards).toContainEqual(
      expect.objectContaining({
        brewery: 'Meteor',
        name: 'Session IPA',
      }),
    );
  });

  it('cleans Ukrainian category descriptors conservatively', () => {
    expect(cards).toContainEqual(
      expect.objectContaining({
        brewery: 'Underwood Brewery',
        name: 'Ukrainian Tomato Gose',
      }),
    );
  });

  it('keeps a non-empty name when the title is mostly brewery plus style', () => {
    expect(cards).toContainEqual(
      expect.objectContaining({
        brewery: 'Meteor',
        name: 'Pils',
      }),
    );
  });

  it('falls back to visible DOM text when initial cart metadata is unavailable', () => {
    const doc = new DOMParser().parseFromString(withoutInitialData(html), 'text/html');
    const parsed = winetime.parseCards(doc);

    expect(parsed.length).toBeGreaterThan(20);
    expect(parsed).toContainEqual(
      expect.objectContaining({
        brewery: 'Meteor',
        name: 'Pils',
      }),
    );
  });

  it('does not define waitForGrid because WineTime renders cards in SSR HTML', () => {
    expect(winetime.waitForGrid).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
cd extension && npm test -- src/sites/winetime.test.ts
```

Expected: FAIL because `extension/src/sites/winetime.ts` does not exist.

---

### Task 3: Implement WineTime adapter

**Files:**
- Create: `extension/src/sites/winetime.ts`
- Test: `extension/src/sites/winetime.test.ts`

- [ ] **Step 1: Create the adapter implementation**

Create `extension/src/sites/winetime.ts`:

```ts
import type { Card, SiteAdapter } from './types';

const CARD_SELECTOR = 'a.product-micro';
const CONTAINER_SELECTOR = '.products-column';

interface ProductMeta {
  id: number;
  title: string;
  manufacturer?: {
    title?: string | null;
  } | null;
}

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function ownerDocument(root: ParentNode): Document | null {
  return root instanceof Document ? root : root.ownerDocument;
}

function productMeta(root: ParentNode): Map<number, ProductMeta> {
  const doc = ownerDocument(root);
  if (!doc) return new Map();

  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const source = script.textContent ?? '';
    const match = source.match(/window\.initialData\.category\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:eS\(|<\/script>|$)/);
    if (!match) continue;

    try {
      const category = JSON.parse(match[1]) as { products?: ProductMeta[] };
      return new Map((category.products ?? []).map((product) => [product.id, product]));
    } catch {
      return new Map();
    }
  }

  return new Map();
}

function stripPrefix(value: string, prefix: string): string {
  const trimmed = value.trim();
  if (trimmed.toLocaleLowerCase('uk-UA').startsWith(prefix.toLocaleLowerCase('uk-UA'))) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function cleanName(rawTitle: string, brewery: string): string {
  const original = rawTitle.replace(/\s+/g, ' ').trim();
  let name = stripPrefix(original, 'Пиво');

  if (brewery) name = stripPrefix(name, brewery);

  const cleaned = name
    .replace(/\s+(?:\d+(?:[,.]\d+)?\s*(?:л|l|ml|мл))$/i, '')
    .replace(/\s+(?:світле|темне|напівтемне|нефільтроване|фільтроване|пастеризоване|безалкогольне)$/iu, '')
    .replace(/\s+(?:світле|темне|напівтемне|нефільтроване|фільтроване|пастеризоване|безалкогольне)$/iu, '')
    .trim();

  return cleaned || name || original;
}

function visibleBrewery(el: Element): string {
  const rows = Array.from(el.querySelectorAll('.j-grow-1-xs.j-size-0\\.75-xs'));
  return text(rows.at(-1));
}

export const winetime: SiteAdapter = {
  id: 'winetime',
  hostMatch: (url) => url.hostname === 'winetime.com.ua' || url.hostname.endsWith('.winetime.com.ua'),
  reRenderContainerSelector: CONTAINER_SELECTOR,

  parseCards(root) {
    const meta = productMeta(root);
    const cards: Card[] = [];

    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const id = Number(el.querySelector<HTMLElement>('[data-productkey]')?.dataset.productkey);
      const product = Number.isFinite(id) ? meta.get(id) : undefined;
      const rawTitle = product?.title ?? text(el.querySelector('.product-micro--title'));
      if (!rawTitle) continue;

      const brewery = product?.manufacturer?.title?.trim() || visibleBrewery(el);
      const name = cleanName(rawTitle, brewery);
      if (!name) continue;

      cards.push({ el, brewery, name });
    }

    return cards;
  },
};
```

- [ ] **Step 2: Run WineTime tests to verify GREEN or selector evidence**

Run:

```bash
cd extension && npm test -- src/sites/winetime.test.ts
```

Expected: PASS. If it fails, use the fixture evidence to adjust only `INITIAL_DATA_RE`, `CARD_SELECTOR`, `CONTAINER_SELECTOR`, `visibleBrewery`, or conservative cleanup tokens.

- [ ] **Step 3: Re-run WineTime tests after implementation**

Run:

```bash
cd extension && npm test -- src/sites/winetime.test.ts
```

Expected: PASS.

---

### Task 4: Register adapter and manifest support

**Files:**
- Modify: `extension/src/sites/registry.ts`
- Modify: `extension/src/sites/registry.test.ts`
- Modify: `extension/manifest.config.ts`
- Modify: `extension/src/manifest.test.ts`
- Test: `extension/src/sites/registry.test.ts`
- Test: `extension/src/manifest.test.ts`
- Test: `extension/src/sites/conformance.test.ts`

- [ ] **Step 1: Update registry**

Modify `extension/src/sites/registry.ts`:

```ts
import type { SiteAdapter } from './types';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
import { beerfreak } from './beerfreak';
import { bierloods22 } from './bierloods22';
import { winetime } from './winetime';

export const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer, beerfreak, bierloods22, winetime];

export function pickAdapter(url: URL): SiteAdapter | null {
  return ADAPTERS.find((a) => a.hostMatch(url)) ?? null;
}
```

- [ ] **Step 2: Update registry tests**

Modify `extension/src/sites/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickAdapter } from './registry';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
import { beerfreak } from './beerfreak';
import { bierloods22 } from './bierloods22';
import { winetime } from './winetime';

describe('pickAdapter', () => {
  it('selects beerrepublic for beerrepublic.eu', () => {
    expect(pickAdapter(new URL('https://beerrepublic.eu/collections/all'))).toBe(beerrepublic);
  });

  it('selects onemorebeer for onemorebeer.pl', () => {
    expect(pickAdapter(new URL('https://onemorebeer.pl/piwa'))).toBe(onemorebeer);
  });

  it('selects beerfreak for beerfreak.org', () => {
    expect(pickAdapter(new URL('https://beerfreak.org/beer/'))).toBe(beerfreak);
  });

  it('selects bierloods22 for bierloods22.nl', () => {
    expect(pickAdapter(new URL('https://www.bierloods22.nl/en/all-beers/'))).toBe(bierloods22);
  });

  it('selects winetime for winetime.com.ua', () => {
    expect(pickAdapter(new URL('https://winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(winetime);
    expect(pickAdapter(new URL('https://www.winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(winetime);
  });

  it('returns null for an unknown host', () => {
    expect(pickAdapter(new URL('https://example.com/'))).toBeNull();
  });
});

describe('adapter ids', () => {
  it('every adapter has a unique non-empty id', () => {
    const ids = [beerrepublic, onemorebeer, beerfreak, bierloods22, winetime].map((a) => a.id);
    expect(ids).toEqual(['beerrepublic', 'onemorebeer', 'beerfreak', 'bierloods22', 'winetime']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Add manifest host patterns**

In `extension/manifest.config.ts`, add:

```ts
'https://winetime.com.ua/*',
'https://*.winetime.com.ua/*',
```

Place them in `content_scripts[0].matches` near the other shop hosts.

- [ ] **Step 4: Update manifest tests**

Modify the host-pattern test in `extension/src/manifest.test.ts` so it asserts:

```ts
expect(contentScript.matches).toContain('https://winetime.com.ua/*');
expect(contentScript.matches).toContain('https://*.winetime.com.ua/*');
```

- [ ] **Step 5: Run targeted registration tests**

Run:

```bash
cd extension && npm test -- src/sites/registry.test.ts src/manifest.test.ts src/sites/conformance.test.ts
```

Expected: PASS.

---

### Task 5: Update docs and final verification

**Files:**
- Modify: `extension/CHANGELOG.md`
- Modify: `spec.md`
- Test: `extension/src/sites/winetime.test.ts`
- Test: `extension/src/sites/conformance.test.ts`
- Test: `extension/src/sites/registry.test.ts`
- Test: `extension/src/manifest.test.ts`

- [ ] **Step 1: Update changelog**

In `extension/CHANGELOG.md`, add under `## [Unreleased]`:

```md
- Added WineTime shop support.
```

- [ ] **Step 2: Update spec**

In `spec.md` section 6, add WineTime to the per-site adapter list:

```md
`winetime` (WineTime SSR — `a.product-micro`, brewery/name з
`window.initialData.category.products` metadata keyed by `data-productkey`,
fallback на видимий title/brewery, ABV опускається, домен `winetime.com.ua`)
```

- [ ] **Step 3: Run targeted extension tests**

Run:

```bash
cd extension && npm test -- src/sites/winetime.test.ts src/sites/conformance.test.ts src/sites/registry.test.ts src/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full extension test suite**

Run:

```bash
cd extension && npm test
```

Expected: PASS.

- [ ] **Step 5: Check git diff**

Run:

```bash
git diff --stat
```

Expected: changes are limited to the WineTime fixture, adapter, adapter tests, registry, manifest, changelog, and `spec.md`.

- [ ] **Step 6: Commit implementation**

Run:

```bash
git add extension/tests/fixtures/winetime.html extension/src/sites/winetime.ts extension/src/sites/winetime.test.ts extension/src/sites/registry.ts extension/src/sites/registry.test.ts extension/manifest.config.ts extension/src/manifest.test.ts extension/CHANGELOG.md spec.md
git commit -m "feat(extension): add WineTime adapter"
```

Expected: commit succeeds after tests pass.
