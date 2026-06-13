# Adapter non-beer filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "drops obvious non-beers (packs/sets/merch/soft-drinks)" a tested, enforced requirement of every browser-extension shop adapter, and document a one-time purge of the existing non-beer orphans.

**Architecture:** Three detection layers, each shop-specific where needed:
1. Shared `non-beer.ts` (`isNonBeerName`) — conservative multi-word packaging vocabulary (packs/sets/certificates), used by name-based adapters.
2. Shop-local name tokens — e.g. onemorebeer's Polish merch words (szklanka/pokal/kufel/koszulka/książka) live in the onemorebeer adapter, not the shared helper.
3. Page-category gate — a new optional `SiteAdapter.isNonBeerPage(url)`; the overlay skips a page entirely when true. Needed for whole non-beer categories whose products carry no name signal (onemorebeer `/delikatesy` = cola/kombucha/kvass with real brand names).

Enforcement: a conformance case over `ADAPTERS` requires each adapter to ship a pure-non-beer fixture whose `parseCards()` returns `[]` (or an explicit `none:true` exemption). Page-gate and false-positive guards (e.g. the MAGIC ROAD beer) are covered by bespoke per-adapter tests.

**Tech Stack:** TypeScript, Vitest, jsdom (`DOMParser`), Playwright (SPA fixture capture), Vite. All work under `extension/`.

**Spec:** `docs/superpowers/specs/2026-06-13-adapter-non-beer-filtering-design.md`

**Real non-beer data captured 2026-06-13 (use these for the fixtures):**
- beerfreak `https://beerfreak.org/beer-sets/` — 11 products: `Подарунковий набір …` (×several, → `набір`), `Подарункове пакування замовлення!` (→ `пакування`), `Сертифікат 500/1000/2000/3000` (→ `сертифікат`).
- onemorebeer `https://onemorebeer.pl/szklanki-i-akcesoria` — merch tiles (each WITH a brewery brand): `… KSIĄŻKA …` (book), `… POKAL 0,33 L` (goblet), `… KOSZULKA BIAŁA XL/XXL` (t-shirt), `SCHNEIDER WEISSE SZKLANKA 0,5 L` (glass), `… KUFEL CERAMIKA …` (mug). The beer `MAGIC ROAD … PUSZKA 0,5 L KAUCJA` MUST survive (no merch token; `puszka`/`kaucja` are can+deposit, i.e. beer).
- onemorebeer `https://onemorebeer.pl/delikatesy` — soft drinks WITH real brands: `KOFOLA … PUSZKA`, `… KWAS CHLEBOWY …`, `VITA ALOE …`, `VIGO KOMBUCHA …`. No shared name token → page-gate by URL.

---

## File Structure

- Create: `extension/src/sites/non-beer.ts` — shared `isNonBeerName(name)` + vocabulary.
- Create: `extension/src/sites/non-beer.test.ts` — unit tests (packaging phrases match; FP cases stay).
- Modify: `extension/src/sites/types.ts` — add optional `isNonBeerPage?(url: URL): boolean` to `SiteAdapter`.
- Modify: `extension/src/content/main.ts` — skip the overlay when `adapter.isNonBeerPage?.(url)` is true.
- Modify: `extension/src/sites/beerrepublic.ts` — replace local `isNonBeerProduct` with shared helper.
- Modify: `extension/src/sites/onemorebeer.ts` — merch-token skip in `parseCards` + `isNonBeerPage`.
- Modify: `extension/src/sites/winetime.ts` — add `isNonBeerName(rawTitle)` skip.
- Modify: `extension/src/sites/beerfreak.ts` — add `isNonBeerName(rawTitle)` skip.
- Modify: `extension/src/sites/conformance.test.ts` — add the `.nonbeer` conformance case.
- Create: `extension/tests/fixtures/{beerrepublic,bierloods22,hoptimaal,winetime,onemorebeer,beerfreak}.nonbeer.html`.
- Modify: `spec.md` §6 — adapter non-beer contract (name + page-gate) + conformance description.
- Modify: `docs/adapter-authoring.md` — new step for non-beer filtering + fixture.
- Modify: `docs/debug-orphan-matching.md` — "non-beer orphan" triage branch + purge command.

All commands assume CWD `extension/` unless stated. Test runner: `npm test -- <args>` (Vitest). Single adapter's conformance cases: `npm test -- src/sites/conformance.test.ts -t <id>`.

---

### Task 1: Shared `non-beer.ts` helper

**Files:**
- Create: `extension/src/sites/non-beer.ts`
- Test: `extension/src/sites/non-beer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/sites/non-beer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isNonBeerName } from './non-beer';

describe('isNonBeerName', () => {
  it.each([
    'Drekker Brewery Pack',
    'Limited Edition Anniversary Vertical Set',
    'Beer Package December',
    'Tasting Box 12',
    'Advent Calendar 2024',
    'Surprise Box',
    'Zestaw Prezentowy 6 piw',
    'Подарунковий набір українського крафтового пива!',
    'Подарункове пакування замовлення!',
    'Сертифікат 1000',
    'Gift Certificate 500',
    'Mixed Pack IPA',
    'Beer Club Subscription',
    'Underwood Culture tasting big set + келих',
  ])('flags packaging/voucher product %j', (name) => {
    expect(isNonBeerName(name)).toBe(true);
  });

  it.each([
    'Beer in a Box',          // real beer name — bare "box" must NOT match
    'Glass',                  // a beer could be named this
    'India Pale Ale',
    'Imperial Hard Cider',    // cider stays — valid Untappd entity
    'MAGIC ROAD YES CANNONS SLOW MARKET PUSZKA 0,5 L KAUCJA', // beer (can + deposit)
    'Pomelo Nealko',
  ])('keeps real beer %j', (name) => {
    expect(isNonBeerName(name)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/sites/non-beer.test.ts`
Expected: FAIL — `Failed to resolve import "./non-beer"`.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/sites/non-beer.ts`:

```ts
// Shop-agnostic baseline detector for non-beer products (packs / sets / gift vouchers).
// Matches only MULTI-WORD packaging phrases plus a few unambiguous single words, never bare
// ambiguous words like "box"/"glass"/"puszka" — so real beers ("Beer in a Box", a can with a
// deposit) stay. Glassware/apparel and soft-drink categories are NOT handled here (they have
// no safe shared name token) — those are shop-local (onemorebeer merch tokens / page gate).
// Adapters keep the final say; this is a reusable baseline, not a mandatory gate.
const NON_BEER_NAME_RE = new RegExp(
  [
    'brewery pack',
    'vertical set',
    'tasting set',
    'tasting box',
    'beer package',
    'beerpackage',
    'beer box',
    'beerbox',
    'advent calendar',
    'surprise box',
    'signature box',
    'craftbeer box',
    'gift set',
    'gift box',
    'gift pack',
    'gift certificate',
    'mixed pack',
    'mixed case',
    'subscription',   // unambiguous: no beer is named "Subscription"
    'abonnement',
    'certificate',    // EN gift voucher
    'zestaw',         // PL: set/kit
    'pakiet',         // PL: package
    'набір',          // UA: set/kit
    'сертифікат',     // UA: voucher
    'пакування',      // UA: packaging (e.g. "Подарункове пакування замовлення")
    '\\+ ?келих',     // UA: "+ glass" merch bundle (winetime sets)
    '\\+ ?szklank',   // PL: "+ glass"
    '\\+ ?glass',     // EN: "+ glass"
  ].join('|'),
  'iu',
);

export function isNonBeerName(name: string): boolean {
  return NON_BEER_NAME_RE.test(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/sites/non-beer.test.ts`
Expected: PASS (all 20 cases). Note MAGIC ROAD stays `false` (no token), cider stays `false`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/non-beer.ts extension/src/sites/non-beer.test.ts
git commit -m "feat(extension): shared isNonBeerName non-beer detector"
```

---

### Task 2: Conformance `.nonbeer` enforcement case

**Files:**
- Modify: `extension/src/sites/conformance.test.ts`

> Adds the enforcement gate. Until each adapter ships its `.nonbeer.html` (later tasks) the case
> is RED for adapters without a fixture — expected. Use `-t <id>` to check a single adapter.

- [ ] **Step 1: Add the conformance case**

`conformance.test.ts` already imports `existsSync, readFileSync` and `resolve`, and defines
`const fixturePath = (id) => resolve(__dirname, \`../../tests/fixtures/${id}.html\`)`. Add two sibling helpers next to it:

```ts
const nonBeerHtmlPath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.nonbeer.html`);
const nonBeerJsonPath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.nonbeer.json`);
```

Add this `it(...)` inside the existing `describe.each(...)('adapter contract: %s', (id, adapter) => { ... })`:

```ts
it('drops non-beer products: parses zero cards from its non-beer fixture (or is exempt)', () => {
  // Exemption: a shop with verified-zero non-beers ships {none:true, reason}. Reason required so
  // an exemption is a deliberate, documented choice — not a silently skipped obligation.
  if (existsSync(nonBeerJsonPath(id))) {
    const meta = JSON.parse(readFileSync(nonBeerJsonPath(id), 'utf8')) as { none?: boolean; reason?: string };
    if (meta.none) {
      expect(typeof meta.reason === 'string' && meta.reason.trim().length).toBeTruthy();
      return;
    }
  }
  expect(existsSync(nonBeerHtmlPath(id))).toBe(true);
  const doc = new DOMParser().parseFromString(readFileSync(nonBeerHtmlPath(id), 'utf8'), 'text/html');
  expect(adapter.parseCards(doc)).toEqual([]);
});
```

- [ ] **Step 2: Run the conformance suite to confirm the gate is active**

Run: `npm test -- src/sites/conformance.test.ts`
Expected: FAIL — the new case fails for every adapter lacking a `.nonbeer.html` (all 6). Other cases stay green.

- [ ] **Step 3: Commit**

```bash
git add extension/src/sites/conformance.test.ts
git commit -m "test(extension): conformance requires each adapter to filter non-beers"
```

---

### Task 3: `isNonBeerPage` adapter contract + overlay skip

**Files:**
- Modify: `extension/src/sites/types.ts:8-20`
- Modify: `extension/src/content/main.ts:84-86`
- Test: `extension/src/content/main.test.ts` (or wherever `startOverlay` is unit-tested — verify with `ls src/content/*.test.ts`; if none targets the page-gate, add a small test file `extension/src/sites/non-beer-page.test.ts`)

- [ ] **Step 1: Add the optional contract method**

In `extension/src/sites/types.ts`, add to the `SiteAdapter` interface (after `parseCards`):

```ts
  /**
   * Optional: true when this URL is a whole non-beer category page (e.g. accessories,
   * delicatessen/soft-drinks) whose products carry no usable beer signal. The overlay skips
   * the page entirely. Per-product non-beers are handled in parseCards instead.
   */
  isNonBeerPage?(url: URL): boolean;
```

- [ ] **Step 2: Write the failing test**

Create `extension/src/sites/non-beer-page.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { onemorebeer } from './onemorebeer';

describe('onemorebeer.isNonBeerPage', () => {
  it('flags the delikatesy (soft-drinks) category', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/delikatesy'))).toBe(true);
  });
  it('does NOT flag the beer listing', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/piwa'))).toBe(false);
  });
  it('does NOT flag the accessories page (it contains the MAGIC ROAD beer)', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/szklanki-i-akcesoria'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/sites/non-beer-page.test.ts`
Expected: FAIL — `isNonBeerPage` is not implemented on onemorebeer yet (returns `undefined`, so `?.()` is `undefined`, not `false`/`true`). This is implemented in Task 7; this test stays red until then. (If running tasks strictly in order, accept the red here and confirm green after Task 7. Alternatively reorder: do Task 7 before this test — but the interface + overlay wiring below is a prerequisite for Task 7, so keep this order and re-run after Task 7.)

- [ ] **Step 4: Wire the overlay skip**

In `extension/src/content/main.ts`, replace the bottom adapter bootstrap (currently around line 84):

```ts
const adapter = pickAdapter(new URL(window.location.href));
if (adapter) {
```

with:

```ts
const adapter = pickAdapter(new URL(window.location.href));
if (adapter && !adapter.isNonBeerPage?.(new URL(window.location.href))) {
```

(No other lines in that block change — only the guard condition.)

- [ ] **Step 5: Commit the interface + wiring**

```bash
git add extension/src/sites/types.ts extension/src/content/main.ts extension/src/sites/non-beer-page.test.ts
git commit -m "feat(extension): optional isNonBeerPage adapter gate + overlay skip"
```

---

### Task 4: beerrepublic — migrate to shared helper + fixture

**Files:**
- Modify: `extension/src/sites/beerrepublic.ts:7-9,21`
- Create: `extension/tests/fixtures/beerrepublic.nonbeer.html`

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/beerrepublic.nonbeer.html`:

```html
<!doctype html>
<html><body>
<section data-section-type="collection">
  <div class="product-item">
    <span class="product-item__vendor">Drekker</span>
    <a class="product-item__title">Drekker Brewery Pack</a>
  </div>
  <div class="product-item">
    <span class="product-item__vendor">Beer Republic</span>
    <a class="product-item__title">Mixed Vertical Set 2024</a>
  </div>
</section>
</body></html>
```

- [ ] **Step 2: Migrate to the shared helper**

In `extension/src/sites/beerrepublic.ts`, delete the local `isNonBeerProduct` (lines 7–9) and import the shared helper. Final file:

```ts
import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

function text(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

export const beerrepublic: SiteAdapter = {
  id: 'beerrepublic',
  hostMatch: (url) => url.hostname === 'beerrepublic.eu' || url.hostname.endsWith('.beerrepublic.eu'),
  reRenderContainerSelector: 'section[data-section-type="collection"]',

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.product-item'))) {
      const name = text(el.querySelector('.product-item__title'));
      if (!name) continue;
      if (isNonBeerName(name)) continue;
      const brewery = text(el.querySelector('.product-item__vendor'));
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
```

- [ ] **Step 3: Run beerrepublic tests to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t beerrepublic src/sites/beerrepublic.test.ts`
Expected: PASS — non-beer fixture yields `[]` (`brewery pack`/`vertical set` both in the shared vocab), and existing beerrepublic bespoke tests still pass.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sites/beerrepublic.ts extension/tests/fixtures/beerrepublic.nonbeer.html
git commit -m "refactor(extension/beerrepublic): use shared isNonBeerName + non-beer fixture"
```

---

### Task 5: bierloods22 — fixture only (existing filter)

**Files:**
- Create: `extension/tests/fixtures/bierloods22.nonbeer.html`

> bierloods22 already filters via `PACKAGE_TITLE_RE`. No code change — prove it with a fixture.

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/bierloods22.nonbeer.html`:

```html
<!doctype html>
<html><body>
<div id="collection-container">
  <div class="product-block">
    <a class="title" title="Beer Package December">Beer Package December</a>
  </div>
  <div class="product-block">
    <a class="title" title="BeerBox - Surprise 8 pack">BeerBox - Surprise 8 pack</a>
  </div>
</div>
</body></html>
```

- [ ] **Step 2: Run the adapter's conformance case to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t bierloods22`
Expected: PASS — `Beer Package December` matches `^beer package\b`; `BeerBox - Surprise 8 pack` matches the `^beerbox\s*-` branch. `parseCards` returns `[]`.

- [ ] **Step 3: Commit**

```bash
git add extension/tests/fixtures/bierloods22.nonbeer.html
git commit -m "test(extension/bierloods22): non-beer fixture proves package filter"
```

---

### Task 6: hoptimaal — fixture only (existing URL filter)

**Files:**
- Create: `extension/tests/fixtures/hoptimaal.nonbeer.html`

> hoptimaal filters by collection URL (`NON_BEER_COLLECTION_RE`). No code change.

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/hoptimaal.nonbeer.html`:

```html
<!doctype html>
<html><body>
<div class="collection__products">
  <div class="product-item" data-url="/collections/merch/hoptimaal-tasting-glass">
    <div class="product-item__product-title">
      <a href="/collections/merch/hoptimaal-tasting-glass">Hoptimaal Tasting Glass</a>
    </div>
  </div>
  <div class="product-item" data-url="/collections/bundles/mixed-surprise">
    <div class="product-item__product-title">
      <a href="/collections/bundles/mixed-surprise">Mixed Surprise Bundle</a>
    </div>
  </div>
</div>
</body></html>
```

- [ ] **Step 2: Run the adapter's conformance case to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t hoptimaal`
Expected: PASS — both `data-url`s match `/collections/(merch|bundles)/`; `parseCards` returns `[]`.

- [ ] **Step 3: Commit**

```bash
git add extension/tests/fixtures/hoptimaal.nonbeer.html
git commit -m "test(extension/hoptimaal): non-beer fixture proves collection-URL filter"
```

---

### Task 7: onemorebeer — merch tokens + page gate + real fixture

**Files:**
- Modify: `extension/src/sites/onemorebeer.ts`
- Create: `extension/tests/fixtures/onemorebeer.nonbeer.html` (captured via Playwright)
- Modify: `extension/src/sites/onemorebeer.test.ts` (bespoke: MAGIC ROAD survives)

onemorebeer is a Nuxt SPA: the accessories grid is rendered client-side, so the fixture must be
captured headless. Its non-beers split in two: accessories/merch (name-token catchable, but the
page also holds a real beer) and the delikatesy soft-drink category (no name token → page gate).

- [ ] **Step 1: Capture the accessories fixture (Playwright)**

Create `extension/scripts/capture-omb-nonbeer.ts` (mirrors `capture-omb-fixture.ts`):

```ts
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CARD = '.one-product-list-view__tile';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    await page.goto('https://onemorebeer.pl/szklanki-i-akcesoria', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector(CARD, { timeout: 15_000 });
    // Do NOT scroll/paginate: keep only the first page (all-merch). Later pages may include the
    // MAGIC ROAD beer, which must NOT be in a "pure non-beer" fixture.
    const count = await page.locator(CARD).count();
    console.log(`Rendered ${count} accessory tiles`);
    const html = await page.content();
    const out = fileURLToPath(new URL('../tests/fixtures/onemorebeer.nonbeer.html', import.meta.url));
    writeFileSync(out, html, 'utf8');
    console.log('Wrote tests/fixtures/onemorebeer.nonbeer.html');
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `npx tsx scripts/capture-omb-nonbeer.ts`
Expected: writes `tests/fixtures/onemorebeer.nonbeer.html` with ~7 merch tiles (book / pokal / koszulka×2 / szklanka×2 / kufel), each with a brewery brand. **Verify the fixture contains NO beer tile** (open it, or check `grep -io 'puszka\|kaucja' tests/fixtures/onemorebeer.nonbeer.html` returns nothing relevant). If a beer slipped in, delete that one `.one-product-list-view__tile` block from the fixture by hand.

- [ ] **Step 2: Add the failing bespoke test (MAGIC ROAD survives; merch dropped)**

In `extension/src/sites/onemorebeer.test.ts`, add:

```ts
import { isNonBeerName } from './non-beer'; // (only if not already imported elsewhere — else omit)

function tile(brewery: string, title: string): string {
  return `
    <div class="one-product-list-view__tile">
      <div data-information-type="brand-name">
        <span class="one-product-tile-information__row__value">${brewery}</span>
      </div>
      <a class="product__title">${title}</a>
    </div>`;
}

describe('onemorebeer non-beer filtering', () => {
  it('drops accessory/merch tiles (glass, mug, shirt, book)', () => {
    const html = `<div class="one-catalog-view-list">
      ${tile('Schneider', 'SCHNEIDER WEISSE SZKLANKA 0,5 L')}
      ${tile('Inne', 'BALTIC PORTER DAY 2025 POKAL 0,33 L (gazetka)')}
      ${tile('Pinta', 'BALTIC PORTER DAY KOSZULKA BIAŁA XXL')}
      ${tile('Pinta', 'KSIĄŻKA POLSKIE I WYJĄTKOWE. PIWO GRODZISKIE')}
      ${tile('Schneider', 'SCHNEIDER WEISSE KUFEL CERAMIKA WYSOKI 0,5 L')}
    </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(onemorebeer.parseCards(doc)).toEqual([]);
  });

  it('keeps a real beer that lives among accessories (MAGIC ROAD, can + deposit)', () => {
    const html = `<div class="one-catalog-view-list">
      ${tile('Magic Road', 'MAGIC ROAD YES CANNONS SLOW MARKET PUSZKA 0,5 L KAUCJA')}
    </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = onemorebeer.parseCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].brewery).toBe('Magic Road');
  });
});
```

(Ensure `onemorebeer`, `describe`, `it`, `expect`, and `DOMParser` are available — the existing
`onemorebeer.test.ts` already imports `onemorebeer` and the Vitest globals.)

- [ ] **Step 3: Run the bespoke tests to verify they fail**

Run: `npm test -- src/sites/onemorebeer.test.ts -t "non-beer filtering"`
Expected: FAIL — onemorebeer has no merch filter yet, so the merch tiles are emitted (first test fails).

- [ ] **Step 4: Implement merch tokens + page gate**

In `extension/src/sites/onemorebeer.ts`, add near the top constants (after the existing `const` block, ~line 9):

```ts
// onemorebeer-local merch tokens (Polish): glassware, mugs, apparel, books on the accessories page.
// Stems handle inflection (szklanka/szklanki, koszulka/koszulkę). Deliberately excludes "puszka"
// (can) and "kaucja" (deposit) — those mark a real beer (e.g. MAGIC ROAD … PUSZKA … KAUCJA).
const MERCH_RE = /\b(?:szklank|pokal|kufel|koszulk|ksi[ąa]żk|ksiazk|akcesori|otwieracz|podstawk|podkładk)\w*/i;
```

Add the import for the shared helper at the top:

```ts
import { isNonBeerName } from './non-beer';
```

In `parseCards`, right after `if (!brewery || !rawTitle) continue;` (currently line 42), add:

```ts
      if (isNonBeerName(rawTitle) || MERCH_RE.test(rawTitle)) continue;
```

Add the page gate to the exported adapter object (alongside `hostMatch`). This matches
`/delikatesy` and `/delikatesy/…`, but not `/piwa` or `/szklanki-i-akcesoria`:

```ts
  isNonBeerPage: (url) => /(^|\/)delikatesy(\/|$)/i.test(url.pathname),
```

- [ ] **Step 5: Run onemorebeer tests (bespoke + page gate + conformance) to verify green**

Run: `npm test -- src/sites/onemorebeer.test.ts src/sites/non-beer-page.test.ts src/sites/conformance.test.ts -t onemorebeer`
Expected: PASS — merch dropped, MAGIC ROAD kept, `isNonBeerPage('/delikatesy')===true` / `/piwa`,`/szklanki-i-akcesoria`===false, and the captured accessories fixture yields `[]`. Existing onemorebeer bespoke tests still pass (normal beer titles carry no merch token).

- [ ] **Step 6: Commit**

```bash
git add extension/src/sites/onemorebeer.ts extension/src/sites/onemorebeer.test.ts \
  extension/scripts/capture-omb-nonbeer.ts extension/tests/fixtures/onemorebeer.nonbeer.html
git commit -m "feat(extension/onemorebeer): filter merch tokens + delikatesy page gate"
```

---

### Task 8: beerfreak — add filter + real fixture

**Files:**
- Modify: `extension/src/sites/beerfreak.ts:86`
- Create: `extension/tests/fixtures/beerfreak.nonbeer.html` (captured via curl)

- [ ] **Step 1: Capture the beer-sets fixture (curl + challenge cookie)**

beerfreak serves a JS cookie challenge; pass the hash it embeds, then refetch. Run from repo root:

```bash
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
H=$(curl -sL -A "$UA" https://beerfreak.org/beer-sets/ | grep -oE 'defaultHash = "[a-f0-9]{64}"' | grep -oE '[a-f0-9]{64}')
curl -sL -A "$UA" -b "challenge_passed=$H" https://beerfreak.org/beer-sets/ \
  -o extension/tests/fixtures/beerfreak.nonbeer.html
echo "bytes=$(wc -c < extension/tests/fixtures/beerfreak.nonbeer.html)"
```

Expected: a ~150KB file containing the embedded `products = [...]` metadata. **Verify it holds the
beer-set products and no real beers:**

```bash
grep -oE '"title":"[^"]{3,80}"' extension/tests/fixtures/beerfreak.nonbeer.html | grep -iE 'набір|сертифікат|пакування' | head
```

Should list `Подарунковий набір …`, `Сертифікат …`, `Подарункове пакування …`. If the page also
rendered unrelated "recommended" beer cards (with their own ids in the `products` meta), the
conformance assertion (`parseCards===[]`) will fail; in that case trim the fixture to the
beer-set products only, or use a smaller curated capture.

- [ ] **Step 2: Run beerfreak's conformance case to verify it fails**

Run: `npm test -- src/sites/conformance.test.ts -t beerfreak`
Expected: FAIL — beerfreak has no non-beer filter yet; the 11 set/certificate products are emitted.

- [ ] **Step 3: Add the filter**

In `extension/src/sites/beerfreak.ts`, add the import at the top:

```ts
import { isNonBeerName } from './non-beer';
```

In `parseCards`, right after `if (!rawTitle) continue;` (currently line 86), add:

```ts
      if (isNonBeerName(rawTitle)) continue;
```

- [ ] **Step 4: Run beerfreak tests to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t beerfreak src/sites/beerfreak.test.ts`
Expected: PASS — every set/certificate/packaging title matches the shared vocab (`набір`,
`сертифікат`, `пакування`), so `parseCards` returns `[]`; existing beerfreak bespoke tests still pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/beerfreak.ts extension/tests/fixtures/beerfreak.nonbeer.html
git commit -m "feat(extension/beerfreak): filter gift sets/certificates/packaging"
```

---

### Task 9: winetime — add filter + fixture

**Files:**
- Modify: `extension/src/sites/winetime.ts` (import + one guard in `parseCards`)
- Create: `extension/tests/fixtures/winetime.nonbeer.html`

winetime is the shop that emitted the orphan `Набір пива Underwood … + келих` (beer_id 25794).
WineTime is SSR, so a small synthetic fixture in its card shape is sufficient (no Playwright).

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/winetime.nonbeer.html` (`a.product-micro` card; with no
`window.initialData.category` script the adapter falls back to the visible `.product-micro--title`):

```html
<!doctype html>
<html><body>
<div class="products-column">
  <a class="product-micro">
    <span data-productkey="1"></span>
    <div class="product-micro--title">Набір пива Underwood Culture tasting big set 0.33лх9шт + келих</div>
  </a>
  <a class="product-micro">
    <span data-productkey="2"></span>
    <div class="product-micro--title">Подарунковий сертифікат 1000 грн</div>
  </a>
</div>
</body></html>
```

- [ ] **Step 2: Run the adapter's conformance case to verify it fails**

Run: `npm test -- src/sites/conformance.test.ts -t winetime`
Expected: FAIL — winetime has no non-beer filter yet; it emits 2 cards instead of `[]`.

- [ ] **Step 3: Add the filter**

In `extension/src/sites/winetime.ts`, add the import at the top:

```ts
import { isNonBeerName } from './non-beer';
```

In `parseCards`, right after `if (!rawTitle) continue;` (currently line 145), add:

```ts
      if (isNonBeerName(rawTitle)) continue;
```

(Filter on `rawTitle`, before `cleanName`, so the `Набір`/`+ келих`/`сертифікат` cues are still present.)

- [ ] **Step 4: Run winetime tests to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t winetime src/sites/winetime.test.ts`
Expected: PASS — non-beer fixture yields `[]` (`набір`/`+ келих` and `сертифікат` both in the shared vocab); existing winetime bespoke tests still pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/winetime.ts extension/tests/fixtures/winetime.nonbeer.html
git commit -m "feat(extension/winetime): filter non-beer sets/vouchers (Набір, + келих)"
```

---

### Task 10: Full suite green + docs (spec.md + runbooks)

**Files:**
- Modify: `spec.md` §6
- Modify: `docs/adapter-authoring.md`
- Modify: `docs/debug-orphan-matching.md`

- [ ] **Step 1: Run the full extension test suite**

Run (from `extension/`): `npm test`
Expected: PASS — all conformance cases (incl. the new non-beer case for all 6 adapters),
`non-beer.test.ts`, `non-beer-page.test.ts`, and every bespoke adapter test green.

- [ ] **Step 2: Run the build to catch type errors**

Run (from `extension/`): `npm run build`
Expected: build succeeds (no TS errors from the new import/usage or the `isNonBeerPage` field).

- [ ] **Step 3: Update `spec.md` §6**

In the `**Per-site адаптери**` paragraph (around line 816, after the adapter list), append:

```
Кожен адаптер ПОВИНЕН виключати не-пива — детекція шоп-специфічна: назва через
`non-beer.ts isNonBeerName` (паки/сети/сертифікати), шоп-локальні токени (мерч onemorebeer:
`szklanka/pokal/kufel/koszulka/książka`), URL колекції (`hoptimaal`), або **гейт цілої
категорії** через опційний `SiteAdapter.isNonBeerPage(url)` — overlay пропускає сторінку
повністю (onemorebeer `/delikatesy`: софт-дрінки з реальними брендами, без сигналу в назві).
FP-гард: банка з заставою (`MAGIC ROAD … PUSZKA … KAUCJA`) лишається пивом. Форситься
конформанс-тестом (див. **Тести**).
```

In the `**Тести**` bullet (around line 839), append after the existing conformance description:

```
Плюс **кейс фільтрації не-пива**: кожен адаптер має `tests/fixtures/<id>.nonbeer.html`
(тільки не-пиво) і `parseCards` на ньому МУСИТЬ дати `[]`; або `<id>.nonbeer.json`
`{none:true, reason}` (виняток із обовʼязковою причиною). `isNonBeerPage` і FP-гарди
(MAGIC ROAD) — у bespoke-тестах адаптера. Відсутність фікстури/винятку = червоний CI.
```

- [ ] **Step 4: Update `docs/adapter-authoring.md`**

Insert a new numbered step between current step 4 (conformance) and step 5 (bespoke); renumber the rest (5→6, 6→7):

```
5. **Фільтр не-пива (обовʼязково).** Адаптер не має віддавати картками паки/сети/мерч/
   софт-дрінки. Засоби: `isNonBeerName` з `src/sites/non-beer.ts` (пакувальні фрази/сертифікати);
   шоп-локальні токени в самому адаптері (як `MERCH_RE` в onemorebeer для скла/кухлів/мерчу);
   або опційний `isNonBeerPage(url)` для цілих не-пивних категорій (як onemorebeer `/delikatesy`).
   Поклади `tests/fixtures/<id>.nonbeer.html` з **тільки** не-пивом — конформанс вимагає
   `parseCards`→`[]`. FP-гарди (реальне пиво серед мерчу) і `isNonBeerPage` — у bespoke-тесті.
   Якщо магазин підтверджено без не-пива — `tests/fixtures/<id>.nonbeer.json`
   `{ "none": true, "reason": "…" }` (причина обовʼязкова).
```

- [ ] **Step 5: Update `docs/debug-orphan-matching.md`**

Add a subclass bullet under "### Підкласи `N, not_found`" (after the existing bullets, ~line 62):

```
- **Не-пиво (пак/сет/мерч/софт-дрінк)** — `name` є набором/паком/мерчем/софт-дрінком
  (`Brewery Pack`, `Сертифікат`, скло `SZKLANKA`, `KOMBUCHA`), якого на Untappd немає. Корінь —
  **адаптер не відфільтрував не-пиво**, а НЕ матчер. Лагодити фільтром адаптера
  (`isNonBeerName` / шоп-локальні токени / `isNonBeerPage`) + додати приклад у `<id>.nonbeer.html`.
  Наявні рядки видаляються разовим purge — див. нижче.
```

Append a new section before "## Довідка" (~line 151):

```
## Purge наявних не-пив (разово, ПІСЛЯ broadcast)

Не-пиво-орфани безпечні до видалення (`untappd_id IS NULL`, без посилань у
`match_links`/`checkins`). **Спершу dry-run SELECT**, очима звір список, потім DELETE. Запуск під
bot-користувачем (звичайний `sudo -u warsaw-beer-bot` не працює — лише через дозволений wrapper):

> ⚠️ Порядок: фільтри адаптера клієнтські → діють лише після broadcast розширення.
> Purge до broadcast = старі клієнти наповнять рядки назад через `/enrich/candidates`.
> Послідовність: merge → broadcast → purge.

\`\`\`bash
# DRY-RUN: подивитись, що буде видалено
sudo -u warsaw-beer-bot /usr/bin/bash -lc '
  sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db "
    SELECT ef.beer_id, ef.brewery, ef.name
    FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
    WHERE b.untappd_id IS NULL
      AND (ef.name LIKE \"%brewery pack%\" OR ef.name LIKE \"%vertical set%\"
        OR ef.name LIKE \"%tasting%set%\" OR ef.name LIKE \"%Набір%\"
        OR ef.name LIKE \"%келих%\" OR ef.name LIKE \"%Collective%Pack%\"
        OR ef.name LIKE \"%anniversary vertical%\")
      AND NOT EXISTS (SELECT 1 FROM match_links m WHERE m.untappd_beer_id = ef.beer_id)
      AND NOT EXISTS (SELECT 1 FROM checkins  c WHERE c.beer_id          = ef.beer_id);"'
\`\`\`

Після звірки — той самий WHERE у DELETE (каскадить enrich_failures):

\`\`\`bash
sudo -u warsaw-beer-bot /usr/bin/bash -lc '
  sqlite3 /var/lib/warsaw-beer-bot/bot.db "
    DELETE FROM beers WHERE id IN (
      SELECT ef.beer_id FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE b.untappd_id IS NULL
        AND (ef.name LIKE \"%brewery pack%\" OR ef.name LIKE \"%vertical set%\"
          OR ef.name LIKE \"%tasting%set%\" OR ef.name LIKE \"%Набір%\"
          OR ef.name LIKE \"%келих%\" OR ef.name LIKE \"%Collective%Pack%\"
          OR ef.name LIKE \"%anniversary vertical%\")
        AND NOT EXISTS (SELECT 1 FROM match_links m WHERE m.untappd_beer_id = ef.beer_id)
        AND NOT EXISTS (SELECT 1 FROM checkins  c WHERE c.beer_id          = ef.beer_id));"'
\`\`\`
```

- [ ] **Step 6: Commit**

```bash
git add spec.md docs/adapter-authoring.md docs/debug-orphan-matching.md
git commit -m "docs: adapter non-beer filtering contract + orphan purge runbook"
```

---

## Sequencing after the PR

1. Open PR; run the AI-review loop (memory `feedback_pr_review_loop`); address comments; merge.
2. `npm run release` → broadcast the rebuilt extension (also clears the pending 0.5.2 broadcast).
3. **After** broadcast: run the dry-run SELECT, eyeball the ~21 rows, then run the DELETE.

## Self-review notes

- **Spec coverage:** §3 contract → Tasks 1–9; §3.1 fixture form → Tasks 2,4–9; §3.2 shared helper → Task 1; shop-local + page-gate (this revision) → Tasks 3,7; §3.3 retrofit (all 6 adapters: beerrepublic T4, bierloods22 T5, hoptimaal T6, onemorebeer T7, beerfreak T8, winetime T9) → Tasks 4–9; §4 docs → Task 10; §5 purge → Task 10 + post-PR sequencing; §6 testing → per-task + Task 10 Step 1.
- **Type consistency:** `isNonBeerName(name: string): boolean` (Task 1) used identically in Tasks 4,7,8. `isNonBeerPage?(url: URL): boolean` defined in Task 3 (types.ts), implemented in Task 7, wired in Task 3 (main.ts), tested in Task 3 (`non-beer-page.test.ts`). `MERCH_RE` is onemorebeer-local (Task 7 only).
- **Confirmed decision:** `/delikatesy` is a whole-page `isNonBeerPage` gate (skip the page entirely). Some borderline-eligible items (e.g. kvass) live there, but they also appear under their own subcategories on other pages, so skipping `/delikatesy` loses no coverage. This is intentional — `/delikatesy` is treated as all-non-beer, unlike `/szklanki-i-akcesoria` (per-product, because it holds the MAGIC ROAD beer).
- **bierloods22/hoptimaal:** intentionally fixture-only; no code change unless a fixture leaks.
