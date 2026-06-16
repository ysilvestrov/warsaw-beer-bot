# Flasker Shop Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-extension `SiteAdapter` for `flasker.com.ua` that badges beers across its three browsing surfaces (client-rendered "All Products" block, classic WooCommerce archives, and the Barn2 product table).

**Architecture:** One `SiteAdapter` in `extension/src/sites/flasker.ts`. `parseCards` unions three view extractors into a shared `{el, title, categoryHint}` shape, then routes each title through one parser. A **volume token is the primary positive gate** (Flasker beers always quote a volume; snacks/merch never do); secondary token + category gates drop sets/glassware. Title→`{brewery,name,abv}`: brewery = first token (relying on the matcher's symmetric leading-prefix gate), with parenthetical/known-two-word promotion.

**Tech Stack:** TypeScript, Vite, Vitest (jsdom), Playwright (fixture capture for the client-rendered view).

**Spec:** `docs/superpowers/specs/2026-06-16-flasker-shop-adapter-design.md`
**Runbook:** `docs/adapter-authoring.md` (steps mirrored below).

---

## File Structure

- **Create** `extension/src/sites/flasker.ts` — the adapter (selectors, title parser, non-beer gates, view extractors, `SiteAdapter`).
- **Create** `extension/src/sites/flasker.test.ts` — bespoke tests (quirks only; the contract is covered by conformance).
- **Create** `extension/scripts/capture-flasker-fixture.ts` — Playwright capture for the client-rendered home block (view 1).
- **Create** fixtures: `extension/tests/fixtures/flasker.html` (canonical = view 2), `flasker.table.html` (view 3), `flasker.block.html` (view 1, rendered), `flasker.nonbeer.html` (snacks only).
- **Modify** `extension/src/sites/registry.ts` — register `flasker`.
- **Modify** `extension/manifest.config.ts` — add host match patterns.
- **Modify** `extension/package.json` — add `capture-flasker` script.
- **Modify** `docs/extension-install-uk.md` — add Flasker to supported-shops list + quick-start/usage domains.
- **Modify** `spec.md` — add Flasker to the supported-shops list if one is enumerated there.

All `cd extension` commands assume repo root `/home/ysi/warsaw-beer-bot`.

---

## Task 1: Capture the four fixtures

**Files:**
- Create: `extension/scripts/capture-flasker-fixture.ts`
- Modify: `extension/package.json` (scripts)
- Create: `extension/tests/fixtures/flasker.html`, `flasker.table.html`, `flasker.block.html`, `flasker.nonbeer.html`

- [ ] **Step 1: Capture the three SSR fixtures with curl**

Run from repo root:

```bash
cd extension
curl -sL -A 'Mozilla/5.0' 'https://flasker.com.ua/1-2/' -o tests/fixtures/flasker.html
curl -sL -A 'Mozilla/5.0' 'https://flasker.com.ua/%d1%82%d0%b0%d0%b1%d0%bb%d0%b8%d1%86%d1%8f-%d1%82%d0%be%d0%b2%d0%b0%d1%80%d1%83/' -o tests/fixtures/flasker.table.html
curl -sL -A 'Mozilla/5.0' 'https://flasker.com.ua/product-category/snacks/' -o tests/fixtures/flasker.nonbeer.html
```

- [ ] **Step 2: Verify the SSR fixtures contain the expected markup**

```bash
cd extension
echo -n "archive li.product (expect ~24): "; grep -coE '<li[^>]*class="[^"]*\bproduct\b[^"]*"' tests/fixtures/flasker.html
echo -n "table rows data-title (expect many): "; grep -coE '<tr[^>]*data-title=' tests/fixtures/flasker.table.html
echo -n "nonbeer li.product (expect ~4, all snacks): "; grep -coE '<li[^>]*class="[^"]*\bproduct\b[^"]*"' tests/fixtures/flasker.nonbeer.html
echo "nonbeer titles (must be ONLY non-beer — no volume tokens):"
grep -oE '<h2 class="woocommerce-loop-product__title">[^<]*</h2>' tests/fixtures/flasker.nonbeer.html | sed 's/<[^>]*>//g'
```

Expected: archive ≥1, table ≥1, nonbeer ≥1 with titles like `…Крафтові соуси`, `…сало…`, `грибна продукція`, `ШКВАРКА…`. If any nonbeer title carries a volume token (`\d+ml`/`0.33`), remove that product from the fixture or pick a cleaner non-beer page.

- [ ] **Step 3: Add the Playwright capture script**

Create `extension/scripts/capture-flasker-fixture.ts`:

```ts
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Flasker's home/store grid is the WooCommerce "All Products" block — rendered
// client-side via the Store API as li.wc-block-grid__product. Capture after
// networkidle so the cards are in the DOM.
const CARD_SELECTOR = 'li.wc-block-grid__product';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    await page.goto('https://flasker.com.ua/', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector(CARD_SELECTOR, { timeout: 15_000 });

    const count = await page.locator(CARD_SELECTOR).count();
    console.log(`Rendered ${count} cards (${CARD_SELECTOR})`);

    const html = await page.content();
    const outDir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}flasker.block.html`, html, 'utf8');
    console.log('Wrote tests/fixtures/flasker.block.html');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Register the capture npm script**

In `extension/package.json`, add to `"scripts"` (after `"capture-omb"`):

```json
    "capture-flasker": "tsx scripts/capture-flasker-fixture.ts"
```

- [ ] **Step 5: Run the capture and verify the block fixture**

```bash
cd extension && npm run capture-flasker
grep -coE '<li[^>]*class="[^"]*wc-block-grid__product[^"]*"' tests/fixtures/flasker.block.html
```

Expected: console prints `Rendered 24 cards …`; grep prints a number ≥1.

- [ ] **Step 6: Commit**

```bash
git add extension/scripts/capture-flasker-fixture.ts extension/package.json extension/tests/fixtures/flasker.html extension/tests/fixtures/flasker.table.html extension/tests/fixtures/flasker.block.html extension/tests/fixtures/flasker.nonbeer.html
git commit -m "test(extension): capture Flasker fixtures (archive/table/block/non-beer) (#86)"
```

---

## Task 2: Title parser (`parseTitle`)

Pure function, no DOM. TDD first.

**Files:**
- Create: `extension/src/sites/flasker.ts`
- Create: `extension/src/sites/flasker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/sites/flasker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTitle } from './flasker';

describe('parseTitle', () => {
  it('single-token brewery + style name', () => {
    expect(parseTitle('Burgomistr NEIPA 6% 500ml')).toEqual({ brewery: 'Burgomistr', name: 'NEIPA', abv: 6 });
  });

  it('comma decimal abv, Cyrillic name', () => {
    expect(parseTitle('REBREW Труханів Острів SIPA 4,3% 330ml'))
      .toEqual({ brewery: 'REBREW', name: 'Труханів Острів SIPA', abv: 4.3 });
  });

  it('brewery = first token; dash + style stay in the name', () => {
    expect(parseTitle('Ципа 380 – Triple IPA 7.9% 500ml'))
      .toEqual({ brewery: 'Ципа', name: '380 – Triple IPA', abv: 7.9 });
  });

  it('parenthetical second token joins the brewery', () => {
    expect(parseTitle('ШО (IIIO) Totem IPA 6% 0.33l'))
      .toEqual({ brewery: 'ШО (IIIO)', name: 'Totem IPA', abv: 6 });
  });

  it('known two-word brewery + bare-decimal volume', () => {
    expect(parseTitle('Vibrant Pour Frost & Flame Imperial Porter 10% 0.33'))
      .toEqual({ brewery: 'Vibrant Pour', name: 'Frost & Flame Imperial Porter', abv: 10 });
  });

  it('no abv → volume marks the head end', () => {
    expect(parseTitle('Orval {2025} 330ml')).toEqual({ brewery: 'Orval', name: '{2025}' });
  });

  it('zero abv', () => {
    expect(parseTitle('Barely Beer 0% ABV 330ml')).toEqual({ brewery: 'Barely', name: 'Beer', abv: 0 });
  });

  it('returns null when there is no volume token (primary gate)', () => {
    expect(parseTitle('ВИТРЕБЕНЬКИ. Крафтові соуси')).toBeNull();
    expect(parseTitle('Золота Сота – Найдорожче сало в Україні')).toBeNull();
  });

  it('does not treat a weight decimal as a volume', () => {
    expect(parseTitle('Сало традиційне 0.5кг')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npm test -- src/sites/flasker.test.ts`
Expected: FAIL — `Failed to resolve import "./flasker"` / `parseTitle is not a function`.

- [ ] **Step 3: Write the parser**

Create `extension/src/sites/flasker.ts`:

```ts
import type { Card, SiteAdapter } from './types';
import { waitForSelector } from '../content/grid-ready';
import { isNonBeerName } from './non-beer';

// --- volume / abv --------------------------------------------------------
// Beers always quote a volume; snacks/merch never do. Volume is both the primary
// non-beer gate and the marker for where the beer name ends.
const VOLUME_UNIT_RE = /\d+(?:[.,]\d+)?\s*(?:ml|мл|l|л)\b/iu;          // 330ml, 0.33л, 500 мл, 1l
const VOLUME_BARE_RE = /\b0[.,]\d+\b(?!\s*(?:кг|g|г|gr)\b)/iu;          // bare litre decimal, not a weight
const ABV_RE = /(\d+(?:[.,]\d+)?)\s*%/u;

function firstIndex(s: string, re: RegExp): number {
  const m = s.match(re);
  return m && m.index != null ? m.index : -1;
}

function volumeIndex(title: string): number {
  const a = firstIndex(title, VOLUME_UNIT_RE);
  const b = firstIndex(title, VOLUME_BARE_RE);
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

// --- brewery / name ------------------------------------------------------
const PAREN_RE = /^\([^)]*\)$/u;
const TWO_WORD_BREWERIES = new Set(['vibrant pour']);

function splitBreweryName(head: string): { brewery: string; name: string } {
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return { brewery: head, name: head };

  const firstTwo = `${tokens[0]} ${tokens[1]}`.toLowerCase();
  const takeTwo = TWO_WORD_BREWERIES.has(firstTwo) || PAREN_RE.test(tokens[1]);

  const breweryTokens = takeTwo ? tokens.slice(0, 2) : tokens.slice(0, 1);
  const brewery = breweryTokens.join(' ');
  const name = tokens.slice(breweryTokens.length).join(' ').trim();
  return { brewery, name: name || brewery };
}

// Returns null when the title carries no volume token → treat as non-beer.
export function parseTitle(rawTitle: string): { brewery: string; name: string; abv?: number } | null {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const volAt = volumeIndex(title);
  if (volAt < 0) return null;                         // primary positive gate

  const abvAt = firstIndex(title, ABV_RE);
  const headEnd = abvAt >= 0 ? Math.min(abvAt, volAt) : volAt;
  const head = title.slice(0, headEnd).trim();
  if (!head) return null;

  const abvMatch = title.match(ABV_RE);
  const abv = abvMatch ? Number(abvMatch[1].replace(',', '.')) : undefined;

  const { brewery, name } = splitBreweryName(head);
  return abv == null || !Number.isFinite(abv) ? { brewery, name } : { brewery, name, abv };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && npm test -- src/sites/flasker.test.ts`
Expected: PASS (9 assertions).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts
git commit -m "feat(extension): Flasker title parser with volume gate (#86)"
```

---

## Task 3: Non-beer gates

**Files:**
- Modify: `extension/src/sites/flasker.ts`
- Modify: `extension/src/sites/flasker.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/sites/flasker.test.ts`:

```ts
import { isNonBeerTitle, isNonBeerCategory } from './flasker';

describe('isNonBeerTitle (secondary gate — sets/glassware that DO quote a volume)', () => {
  it('drops a tasting set bundled with a glass', () => {
    expect(isNonBeerTitle('Набір 4×0.33 + келих')).toBe(true);
    expect(isNonBeerTitle('Tasting set 4×0.33l')).toBe(true);
  });
  it('keeps a real beer whose name merely contains "set"', () => {
    expect(isNonBeerTitle('Sunset Hazy IPA 6% 330ml')).toBe(false);
  });
  it('keeps an ordinary beer', () => {
    expect(isNonBeerTitle('Burgomistr NEIPA 6% 500ml')).toBe(false);
  });
});

describe('isNonBeerCategory (table data-product_cat hint)', () => {
  it('drops snack/merch categories', () => {
    expect(isNonBeerCategory('812:Снеки, ')).toBe(true);
    expect(isNonBeerCategory('900:Аксесуари, ')).toBe(true);
  });
  it('keeps a beer-style category', () => {
    expect(isNonBeerCategory('812:Темне міцне, ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npm test -- src/sites/flasker.test.ts`
Expected: FAIL — `isNonBeerTitle is not a function`.

- [ ] **Step 3: Implement the gates**

Add to `extension/src/sites/flasker.ts` (after the imports / before `parseTitle`):

```ts
// --- non-beer gates ------------------------------------------------------
// Secondary gate: catches sets/glassware/vouchers that DO quote a volume (the
// volume gate alone would let them through). Short ambiguous words are bounded
// so they never fire inside a beer name (e.g. "Sunset"). isNonBeerName supplies
// the shared multi-word phrases (gift set, "+ келих", набір, сертифікат, …).
const NONBEER_TITLE_RE = /(?:\bset\b|\bglass\b|\bmerch\b|\bsouvenir\b|\bgift\b|zestaw|келих|сувенір|мерч|сертифікат|подарунк)/iu;

// Category hint (Barn2 table data-product_cat). Category names are safe for
// broader snack/merch tokens since they are not beer names.
const NONBEER_CATEGORY_RE = /(?:снек|снэк|закуск|набор|набір|сет|set|аксесуар|мерч|merch|подарунк|snack|glass|gift)/iu;

export function isNonBeerTitle(title: string): boolean {
  return isNonBeerName(title) || NONBEER_TITLE_RE.test(title);
}

export function isNonBeerCategory(cat: string): boolean {
  return NONBEER_CATEGORY_RE.test(cat);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && npm test -- src/sites/flasker.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts
git commit -m "feat(extension): Flasker non-beer title + category gates (#86)"
```

---

## Task 4: View extractors + `SiteAdapter`

**Files:**
- Modify: `extension/src/sites/flasker.ts`
- Modify: `extension/src/sites/flasker.test.ts`

- [ ] **Step 1: Write the failing test (fixture-driven, all three views)**

Append to `extension/src/sites/flasker.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flasker } from './flasker';

const load = (name: string) =>
  new DOMParser().parseFromString(readFileSync(resolve(__dirname, `../../tests/fixtures/${name}`), 'utf8'), 'text/html');

describe('flasker adapter', () => {
  it('hostMatch matches the shop and its subdomains, not others', () => {
    expect(flasker.hostMatch(new URL('https://flasker.com.ua/1-2/'))).toBe(true);
    expect(flasker.hostMatch(new URL('https://www.flasker.com.ua/store/'))).toBe(true);
    expect(flasker.hostMatch(new URL('https://example.com/'))).toBe(false);
  });

  it('parses cards from the SSR archive view (li.product)', () => {
    const cards = flasker.parseCards(load('flasker.html'));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.brewery.length).toBeGreaterThan(0);
    }
  });

  it('parses cards from the Barn2 product table view (tr[data-title])', () => {
    expect(flasker.parseCards(load('flasker.table.html')).length).toBeGreaterThan(0);
  });

  it('parses cards from the client-rendered block view (li.wc-block-grid__product)', () => {
    expect(flasker.parseCards(load('flasker.block.html')).length).toBeGreaterThan(0);
  });

  it('drops every product on a non-beer page', () => {
    expect(flasker.parseCards(load('flasker.nonbeer.html'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npm test -- src/sites/flasker.test.ts`
Expected: FAIL — `flasker.parseCards is not a function` / `flasker` has no such export.

- [ ] **Step 3: Implement extractors + the adapter**

Append to `extension/src/sites/flasker.ts`:

```ts
// --- view extractors -----------------------------------------------------
const ARCHIVE_CARD = 'li.product';                               // SSR loop: /1-2/, /product-category, /product-tag
const ARCHIVE_TITLE = 'h2.woocommerce-loop-product__title';
const TABLE_ROW = 'tr[data-title]';                              // Barn2 product table: /таблиця-товару/
const BLOCK_CARD = 'li.wc-block-grid__product';                  // "All Products" block: home/store (client-rendered)
const BLOCK_TITLE = '.wc-block-grid__product-title';
const GRID_SELECTOR = `${ARCHIVE_CARD}, ${TABLE_ROW}, ${BLOCK_CARD}`;

interface RawEntry { el: HTMLElement; title: string; categoryHint?: string }

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function archiveEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ARCHIVE_CARD))
    .map((el) => ({ el, title: text(el.querySelector(ARCHIVE_TITLE)) }));
}

function blockEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_CARD))
    .map((el) => ({ el, title: text(el.querySelector(BLOCK_TITLE)) }));
}

function tableEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABLE_ROW)).map((el) => ({
    el,
    title: (el.getAttribute('data-title') ?? '').replace(/\s+/g, ' ').trim(),
    categoryHint: el.getAttribute('data-product_cat') ?? undefined,
  }));
}

// --- adapter -------------------------------------------------------------
export const flasker: SiteAdapter = {
  id: 'flasker',
  hostMatch: (url) => url.hostname === 'flasker.com.ua' || url.hostname.endsWith('.flasker.com.ua'),

  async waitForGrid(root) {
    await waitForSelector(root, GRID_SELECTOR, { timeoutMs: 8000 });
  },

  parseCards(root) {
    const entries = [...archiveEntries(root), ...tableEntries(root), ...blockEntries(root)];
    const cards: Card[] = [];
    for (const e of entries) {
      if (!e.title) continue;
      if (isNonBeerTitle(e.title)) continue;
      if (e.categoryHint && isNonBeerCategory(e.categoryHint)) continue;
      const parsed = parseTitle(e.title);
      if (!parsed) continue;
      cards.push({ el: e.el, ...parsed });
    }
    return cards;
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && npm test -- src/sites/flasker.test.ts`
Expected: PASS (all describe blocks, including the three fixture-driven view tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts
git commit -m "feat(extension): Flasker adapter — 3-view extractors + parseCards (#86)"
```

---

## Task 5: Register adapter + manifest; full suite green

**Files:**
- Modify: `extension/src/sites/registry.ts`
- Modify: `extension/manifest.config.ts`

- [ ] **Step 1: Register the adapter**

In `extension/src/sites/registry.ts`, add the import and array entry:

```ts
import { flasker } from './flasker';
```

```ts
export const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer, beerfreak, bierloods22, winetime, hoptimaal, flasker];
```

- [ ] **Step 2: Add manifest host patterns**

In `extension/manifest.config.ts`, add to `content_scripts[].matches` (after the `hoptimaal.com` lines):

```ts
        'https://flasker.com.ua/*',
        'https://*.flasker.com.ua/*',
```

- [ ] **Step 3: Run the conformance suite (auto-covers the new adapter)**

Run: `cd extension && npm test -- src/sites/conformance.test.ts`
Expected: PASS — the `adapter contract: flasker` group passes (fixture exists, ≥1 well-formed card, non-beer fixture → `[]`, re-badges after grid replacement).

If the re-badge test fails: confirm `flasker.html` is the SSR archive (view 2) and that `parseCards` returns cards for it (Task 4 test already asserts this).

- [ ] **Step 4: Run the full extension test suite + typecheck**

Run: `cd extension && npm test && npm run typecheck`
Expected: all tests PASS; `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/registry.ts extension/manifest.config.ts
git commit -m "feat(extension): register Flasker adapter + manifest host match (#86)"
```

---

## Task 6: Docs (install guide + spec)

**Files:**
- Modify: `docs/extension-install-uk.md`
- Modify: `spec.md` (if it enumerates supported shops)

- [ ] **Step 1: Add Flasker to the supported-shops list**

In `docs/extension-install-uk.md`, after the `hoptimaal.com` bullet (~line 12) add:

```markdown
- `flasker.com.ua` (і піддомени)
```

- [ ] **Step 2: Update the quick-start / usage domain lists**

In `docs/extension-install-uk.md` (~lines 143–144), add `flasker.com.ua` to the inline list of supported shops so it is not stale:

```markdown
   `beerrepublic.eu`, `onemorebeer.pl`, `beerfreak.org`, `bierloods22.nl`,
   `winetime.com.ua`, `hoptimaal.com` або `flasker.com.ua`.
```

- [ ] **Step 3: Check spec.md for a supported-shops list and update if present**

Run: `grep -niE "hoptimaal|winetime|supported shop|підтримув.*магазин|onemorebeer" spec.md | head`
If a supported-shops enumeration exists, add `flasker.com.ua` to it in the same style. If none exists, no change.

- [ ] **Step 4: Commit**

```bash
git add docs/extension-install-uk.md spec.md
git commit -m "docs: add Flasker to supported shops (install guide + spec) (#86)"
```

(If `spec.md` was unchanged, drop it from the `git add`.)

---

## Task 7: Real-browser verification (runbook step 9)

**Files:** none (manual verification).

- [ ] **Step 1: Build the extension**

Run: `cd extension && npm run build`
Expected: build succeeds; `dist/` produced.

- [ ] **Step 2: Load the unpacked `dist/` in Chrome and visit each view**

Load `extension/dist` via `chrome://extensions` (Developer mode → Load unpacked). Then visit:
- `https://flasker.com.ua/` (block view)
- `https://flasker.com.ua/1-2/` (archive view)
- `https://flasker.com.ua/таблиця-товару/` (table view)
- a style tag, e.g. `https://flasker.com.ua/product-tag/ipa/`

- [ ] **Step 3: Confirm behaviour**

Expected on each: seen-marker badges (⚪/⏳/⭐) appear on first load and **remain after pagination/filtering**. Confirm our badge does **not** overlap the shop's native yellow `.mbua-untappd-badge` (top-left). If they overlap, nudge our badge position for this adapter and re-verify (note any code change goes back through Tasks 4–5 test/commit flow).

- [ ] **Step 4: Clean up scratch fixtures**

Remove any temporary `/tmp/flasker-*.html` probe files used during development (not part of the repo).

---

## Self-Review (completed by plan author)

- **Spec coverage:** three views (Tasks 1,4), volume primary gate (Task 2), secondary token + category gates (Task 3), brewery=first-token w/ parenthetical+two-word promotion (Task 2), no `reRenderContainerSelector` (Task 4 — omitted), `waitForGrid` over combined selector (Task 4), fixtures incl. Playwright block capture (Task 1), conformance + bespoke tests (Tasks 4–5), registry+manifest (Task 5), install-doc + spec (Task 6), real-browser + native-badge collision check (Task 7). All covered.
- **Placeholders:** none — every code/command step is concrete.
- **Type consistency:** `parseTitle` returns `{brewery,name,abv?}`; `Card` is `{el,brewery,name,abv?}` (per `src/sites/types.ts`); `parseCards` spreads `parsed` into a `Card` with `el`. `isNonBeerTitle`/`isNonBeerCategory`/`flasker`/`parseTitle` exports match their test imports. `waitForSelector(root, selector, {timeoutMs})` signature matches `src/content/grid-ready.ts`.
