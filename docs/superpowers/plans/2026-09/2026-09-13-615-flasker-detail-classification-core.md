# Flasker Detail Classification Core Implementation Plan

> **For implementation:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the main thread. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 24 Flasker home-page cards reach product-detail classification, restore badges for the six reported beers, and render confirmed merchandise with a non-clickable red `✕`.

**Architecture:** Flasker opts into a new pre-cache detail-hydration mode. `runOverlay` freezes each listing cache key, hydrates every candidate, renders an explicit `Card.nonBeer` state before any cached match can leak through, and preserves the existing miss-only path for every other adapter. Flasker treats title/category rejections and no-volume ABV titles as provisional, resolves them from WooCommerce product-category links, and removes the 20-detail cap.

**Tech Stack:** TypeScript 7, MV3 browser extension, Vanilla DOM APIs, Vitest 5 + jsdom 30.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-615-flasker-detail-classification-design.md`

## Global Constraints

- Scope is Flasker only; other adapters keep silently dropping non-beer products until #623.
- Do not add dependencies or change manifest permissions, the server API, cache schema, or enrichment policy.
- Preserve the pre-hydration listing identity as the cache read/write key; detail-hydrated brewery/name are payload facts only.
- Flasker detail hydration runs before cache lookup and has no total-card cap; the URL promise cache still deduplicates identical URLs.
- A successful non-beer product category is the only new `✕` claim. Network failure, malformed HTML, missing category, missing match, and missing rating never render `✕`.
- Provisional cards fail closed; established volume/title beer cards fail open when detail loading fails.
- The non-beer badge is exactly `✕`, uses the existing dark badge geometry with red `#ff6b6b`, carries `role="img"` and `aria-label="Не пиво"`, and has no click, auxclick, focus or pointer interaction.
- Follow strict RED → GREEN TDD. Run the named test and observe the expected failure before changing production code.
- Do not edit `spec.md`, `extension/CHANGELOG.md`, or `docs/extension-install-uk.md` in this core plan. Write their separate periphery plan only after the core whole-branch review passes.

---

### Task 1: Add the explicit non-beer badge primitive

**Files:**
- Modify: `extension/src/content/badge.ts:31-74,99-118`
- Test: `extension/src/content/badge.test.ts:1-4,173-221`

**Interfaces:**
- Consumes: existing `makeBadge(text: string, href: string | null): HTMLElement` and `attach(host, badge)` helpers.
- Produces: `setNonBeer(host: HTMLElement): void`, imported by Task 2.

- [ ] **Step 1: Write the failing badge behavior test**

Add `setNonBeer` to the import from `./badge`, then add this focused block beside the orphan/enrichment badge tests:

```ts
describe('non-beer badge (#615)', () => {
  it('renders a red accessible ✕ without an Untappd action', () => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    setNonBeer(host);
    setNonBeer(host); // replacement stays idempotent

    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    expect(badge.textContent).toBe('✕');
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Не пиво');
    expect(badge.style.color).toBe('rgb(255, 107, 107)');
    expect(badge.style.pointerEvents).toBe('none');
    expect(badge.style.cursor).toBe('default');
    expect(badge.tabIndex).toBe(-1);
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`)).toHaveLength(1);

    badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    badge.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    expect(open).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the badge test and verify RED**

Run from `extension/`:

```bash
npm test -- src/content/badge.test.ts
```

Expected: FAIL at module import because `setNonBeer` is not exported.

- [ ] **Step 3: Implement the minimal badge primitive**

Add this export after `setOrphan` in `badge.ts`; do not generalize the badge style API:

```ts
/** Show that the shop explicitly classified this card as not beer. */
export function setNonBeer(host: HTMLElement): void {
  const badge = makeBadge('✕', null);
  badge.style.color = '#ff6b6b';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', 'Не пиво');
  attach(host, badge);
}
```

`makeBadge(..., null)` already supplies `pointer-events: none`, `cursor: default`, no event handlers and no focusable element.

- [ ] **Step 4: Run the badge test and verify GREEN**

Run:

```bash
npm test -- src/content/badge.test.ts
```

Expected: PASS, including all existing clickable badge tests.

- [ ] **Step 5: Run the UI detector once for the changed badge target**

Run from the repository root:

```bash
node /home/ysi/.agents/skills/impeccable/scripts/detect.mjs --json extension/src/content/badge.ts extension/src/content/badge.test.ts
```

Expected: no blocking accessibility, interaction or styling finding. Resolve only findings caused by this task.

- [ ] **Step 6: Commit the badge primitive**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts
git commit -m "feat(extension): add non-beer status badge"
```

---

### Task 2: Hydrate and classify cards before cache lookup

**Files:**
- Modify: `extension/src/sites/types.ts:1-39`
- Modify: `extension/src/content/index.ts:1-75`
- Test: `extension/src/content/index.test.ts:106-158,338-360`

**Interfaces:**
- Consumes: `setNonBeer(host: HTMLElement): void` from Task 1; existing `Card.skip`, `SiteAdapter.loadCardDetails`, `normalizeKey`, cache and seen-marker APIs.
- Produces:
  - `Card.nonBeer?: boolean` — confirmed shop classification, never a parse/network fallback.
  - `SiteAdapter.loadDetailsBeforeCache?: boolean` — opt-in timing switch; false/undefined preserves miss-only hydration.
  - `runOverlay` behavior that renders `nonBeer`, marks pre-cache skipped cards seen, and excludes both from cache/API paths.

- [ ] **Step 1: Write the cached non-beer regression test**

Add this test beside the existing detail-loading tests in `content/index.test.ts`:

```ts
it('classifies before cache and renders confirmed non-beer without API or cache writes', async () => {
  const card: Card = { el: cardEl(), brewery: 'Термос', name: 'для пляшки' };
  await setCached(
    normalizeKey(card.brewery, card.name),
    drunkResult(card.brewery, card.name),
  );
  vi.mocked(chrome.storage.local.set).mockClear();
  const adapter: SiteAdapter = {
    ...adapterFor([card]),
    loadDetailsBeforeCache: true,
    loadCardDetails: vi.fn(async (cards: Card[]) => {
      cards[0].nonBeer = true;
      cards[0].skip = true;
    }),
  };
  const sendMatch = vi.fn(async () => [] as MatchResult[]);
  const enrich = vi.fn();

  await runOverlay(document, adapter, sendMatch, enrich);

  expect(adapter.loadCardDetails).toHaveBeenCalledWith([card]);
  expect(card.el.querySelector(`[${BADGE_MARKER}]`)?.textContent).toBe('✕');
  expect(isSeen(card.el)).toBe(true);
  expect(sendMatch).not.toHaveBeenCalled();
  expect(enrich).not.toHaveBeenCalled();
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
});
```

The production mutation this catches is moving pre-cache hydration back below `getCached`: the seeded drunk result would render `✅` instead of `✕`.

- [ ] **Step 2: Run the content test and verify RED**

Run from `extension/`:

```bash
npm test -- src/content/index.test.ts
```

Expected: TypeScript/Vitest FAIL because `Card.nonBeer` and `SiteAdapter.loadDetailsBeforeCache` do not exist; without the new branch the cached result wins.

- [ ] **Step 3: Add the two narrow adapter-contract fields**

Update `types.ts` without changing existing field meanings:

```ts
export interface Card {
  // existing fields unchanged
  skip?: boolean;
  /** Shop-confirmed non-beer; renders a status badge and never reaches /match. */
  nonBeer?: boolean;
}

export interface SiteAdapter {
  // existing fields unchanged
  /** Hydrate all cards before cache lookup when details determine eligibility. */
  loadDetailsBeforeCache?: boolean;
  loadCardDetails?(cards: Card[]): Promise<void>;
}
```

Keep `loadDetailsBeforeCache` adjacent to `loadCardDetails` and update the latter's comment: it receives all cards for opt-in adapters and only cache misses otherwise.

- [ ] **Step 4: Implement the pre-cache branch while freezing listing keys**

Import `setNonBeer` with the existing badge helpers. Replace the initial card/cache loop with this shape:

```ts
const cards = adapter.parseCards(doc);
const keyedCards = cards.map((card) => ({
  el: card.el,
  key: normalizeKey(card.brewery, card.name),
  card,
}));

if (adapter.loadDetailsBeforeCache && adapter.loadCardDetails) {
  await adapter.loadCardDetails(cards);
}

const misses: { el: HTMLElement; key: string; card: Card }[] = [];
for (const entry of keyedCards) {
  const { card } = entry;
  if (card.nonBeer) {
    setNonBeer(card.el);
    markSeen(card.el);
    continue;
  }
  if (adapter.loadDetailsBeforeCache && card.skip) {
    markSeen(card.el);
    continue;
  }

  const cached = await getCached(entry.key);
  if (cached?.matched_beer != null) {
    renderBadge(card.el, cached);
    markSeen(card.el);
  } else {
    misses.push(entry);
  }
}
if (misses.length === 0) return;

if (!adapter.loadDetailsBeforeCache && adapter.loadCardDetails) {
  await adapter.loadCardDetails(misses.map((m) => m.card));
}
```

Leave the existing late-path `.filter(({ card }) => !card.skip)`, ABV sanitization, API mapping, cache writes and enrichment mapping unchanged. Do not recompute `key` after hydration.

- [ ] **Step 5: Verify new and legacy hydration behavior**

Run:

```bash
npm test -- src/content/index.test.ts
```

Expected: PASS. In particular, the existing tests must still prove that adapters without the flag hydrate only uncached cards and store results under the pre-hydration key.

- [ ] **Step 6: Commit the pipeline contract**

```bash
git add extension/src/sites/types.ts extension/src/content/index.ts extension/src/content/index.test.ts
git commit -m "feat(extension): classify cards before cache lookup"
```

---

### Task 3: Classify all Flasker candidates from product categories

**Files:**
- Modify: `extension/src/sites/flasker.ts:6-24,264-389,461-516`
- Test: `extension/src/sites/flasker.test.ts:18-210,286-319,495-666`
- Test: `extension/src/sites/conformance.test.ts:64-77`

**Interfaces:**
- Consumes: `Card.nonBeer`, `Card.skip`, `SiteAdapter.loadDetailsBeforeCache` from Task 2; existing Flasker URL promise cache and identity hydration.
- Produces:
  - `ProductDetail.categories?: string[]` containing only WooCommerce `/product-category/` links.
  - no-volume ABV parsing with the same earliest-marker name boundary.
  - provisional-card fail-closed state, classification-only fallback cards, and category-confirmed `nonBeer` state.
  - unbounded per-pass Flasker hydration with same-URL deduplication.

- [ ] **Step 1: Add RED tests for the six reported beers**

Add a block-view helper and the literal live cases to `flasker.test.ts`:

```ts
function blockCard(url: string, title: string): string {
  return `<li class="wc-block-grid__product">
    <h2 class="wc-block-grid__product-title"><a href="${url}">${title}</a></h2>
  </li>`;
}

const issue615Beers = [
  ['vibrantpour-kraken-wasabi', 'VibrantPour КРАКЕН з Васабі Gose 4%', 'КРАКЕН з Васабі Gose', 4],
  ['vibrantpour-kraken-tom-yum', 'VibrantPour КРАКЕН Tom Yum 4%', 'КРАКЕН Tom Yum', 4],
  ['vibrantpour-kraken-ink', 'VibrantPour КРАКЕН у власному чорнилі 4%', 'КРАКЕН у власному чорнилі', 4],
  ['vibrantpour-salo-pepper', 'VibrantPour Сало з часником та перцем Gose 4.5%', 'Сало з часником та перцем Gose', 4.5],
  ['vibrantpour-real-smoothie', 'VibrantPour Real Smoothie Ale: Mango, Passion Fruit 6.9%', 'Real Smoothie Ale: Mango, Passion Fruit', 6.9],
  ['vibrantpour-lardomato', 'VibrantPour LardoMato/Сало з часником Gose 4%', 'LardoMato/Сало з часником Gose', 4],
] as const;

it('keeps all six #615 beers provisional until beer-category details confirm them', async () => {
  const html = issue615Beers.map(([slug, title]) =>
    blockCard(`https://flasker.com.ua/product/${slug}/`, title)).join('');
  const doc = new DOMParser().parseFromString(`<ul>${html}</ul>`, 'text/html');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    text: async () =>
      '<span class="posted_in">Категорія: ' +
      '<a href="https://flasker.com.ua/product-category/styles/tomatne/">Томатне</a></span>' +
      '<script>{"brand":{"@type":"Brand","name":"Vibrant Pour"}}</script>',
  } as Response);

  const cards = flasker.parseCards(doc);
  expect(cards).toHaveLength(6);
  expect(cards.every((card) => card.skip === true)).toBe(true);

  await flasker.loadCardDetails?.(cards);

  expect(cards.map(({ brewery, name, abv, skip, nonBeer }) =>
    ({ brewery, name, abv, skip, nonBeer }))).toEqual(
    issue615Beers.map(([, , name, abv]) => ({
      brewery: 'VibrantPour', name, abv, skip: false, nonBeer: undefined,
    })),
  );
  expect(fetchSpy).toHaveBeenCalledTimes(6);
});
```

The test fails on current `main`: four titles return `null` at the volume gate and two are removed by the `сало` title regex.

- [ ] **Step 2: Add RED category, thermos, and failure tests**

Extend the product-detail tests with selectors that distinguish category from brand:

```ts
it('reads product categories without treating the posted brand row as a category', () => {
  const html = `
    <span class="posted_in">Категорія:
      <a href="https://flasker.com.ua/product-category/styles/tomatne/">Томатне</a>
    </span>
    <span class="posted_in">Бренд:
      <a href="https://flasker.com.ua/brand/ukraine/vibrant-pour/">Vibrant Pour</a>
    </span>`;
  expect(parseProductDetail(html)).toEqual({ categories: ['Томатне'] });
});
```

Update the captured `flasker.product.html` expectation to include `categories: ['Томатне']`.

Add the thermos and markerless-glass classification test:

```ts
it('marks volume-bearing and markerless merchandise non-beer from Сувеніри', async () => {
  const doc = new DOMParser().parseFromString(
    `<ul>
      ${blockCard(
        'https://flasker.com.ua/product/термос-для-пляшки-033мл/',
        'Термос для пляшки 0,33мл',
      )}
      ${blockCard(
        'https://flasker.com.ua/product/келих-flasker-teku/',
        'Келих Flasker Teku',
      )}
    </ul>`,
    'text/html',
  );
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    text: async () =>
      '<span class="posted_in"><a href="https://flasker.com.ua/product-category/suveniry/">Сувеніри</a></span>',
  } as Response);
  const cards = flasker.parseCards(doc);

  expect(cards).toHaveLength(2);
  expect(cards.every((card) => card.skip === true)).toBe(true);
  await flasker.loadCardDetails?.(cards);

  expect(cards.every((card) => card.skip && card.nonBeer)).toBe(true);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});
```

Add this distinct-URL failure test to pin both sides of the failure policy:

```ts
it('fails closed for provisional cards and open for established beers when details fail', async () => {
  const doc = new DOMParser().parseFromString(
    `<ul>
      ${blockCard(
        'https://flasker.com.ua/product/vibrantpour-mystery-gose-4-fails/',
        'VibrantPour Mystery Gose 4%',
      )}
      ${blockCard(
        'https://flasker.com.ua/product/burgomistr-ipa-6-500ml-fails/',
        'Burgomistr IPA 6% 500ml',
      )}
    </ul>`,
    'text/html',
  );
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
  const cards = flasker.parseCards(doc);

  await flasker.loadCardDetails?.(cards);

  expect(cards).toHaveLength(2);
  expect(cards[0]).toMatchObject({
    brewery: 'VibrantPour', name: 'Mystery Gose', abv: 4, skip: true,
  });
  expect(cards[0].nonBeer).toBeUndefined();
  expect(cards[1]).toMatchObject({ brewery: 'Burgomistr', name: 'IPA', abv: 6 });
  expect(cards[1].skip).toBeUndefined();
  expect(cards[1].nonBeer).toBeUndefined();
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 3: Replace the 20-card cap test with a 24-card coverage test**

Change the existing cap test to use 24 unique URLs and a successful beer-category response:

```ts
it('hydrates all 24 unique Flasker cards in one pass, including a markerless product', async () => {
  const items = Array.from({ length: 23 }, (_, i) =>
    archiveCard(`https://flasker.com.ua/product/beer-${i}-5-330ml/`, `Beer${i} Name 5% 330ml`));
  items.push(archiveCard(
    'https://flasker.com.ua/product/markerless-glass/',
    'Келих Flasker Teku',
  ));
  const doc = new DOMParser().parseFromString(`<ul>${items.join('')}</ul>`, 'text/html');
  const cards = flasker.parseCards(doc);
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    text: async () =>
      '<span class="posted_in"><a href="https://flasker.com.ua/product-category/ipa/">IPA</a></span>' +
      '<script>{"brand":{"@type":"Brand","name":"Hydrated Brand"}}</script>',
  } as Response);

  await flasker.loadCardDetails?.(cards);

  expect(cards).toHaveLength(24);
  expect(fetchSpy).toHaveBeenCalledTimes(24);
  expect(cards.slice(0, 23).every((card) => card.brewery === 'Hydrated Brand')).toBe(true);
  expect(cards[23].skip).toBe(true);
});
```

Keep the existing same-URL test: two cards with one URL must still issue one fetch.

- [ ] **Step 4: Run Flasker tests and verify RED**

Run from `extension/`:

```bash
npm test -- src/sites/flasker.test.ts
```

Expected failures: six-card parse length, missing `categories`, thermos `nonBeer`, and 24-fetch expectation. Confirm each failure names the missing behavior rather than test setup.

- [ ] **Step 5: Parse names at the earliest available volume/ABV marker**

In `parseTitle`, find ABV before rejecting the title and use literal marker selection:

```ts
const volAt = volumeIndex(title);
const abvMatch = title.match(ABV_RE);
const abvAt = abvMatch?.index ?? -1;
const headMarkers = [volAt, abvAt].filter((index) => index >= 0);
if (headMarkers.length === 0) return null;
const headEnd = Math.min(...headMarkers);
```

Leave ABV numeric parsing and all brewery-resolution stages unchanged.

- [ ] **Step 6: Extract category evidence and distinguish fetch failure**

Remove `MAX_DETAIL_FETCHES_PER_PASS`. Change the detail cache and loader to preserve failure as `null`:

```ts
const detailByUrl = new Map<string, Promise<ProductDetail | null>>();

export interface ProductDetail {
  bid?: number;
  bidSlug?: string;
  brand?: string;
  categories?: string[];
}
```

At the end of `parseProductDetail`, add:

```ts
const doc = new DOMParser().parseFromString(html, 'text/html');
const categories = Array.from(
  doc.querySelectorAll<HTMLAnchorElement>('.posted_in a[href*="/product-category/"]'),
)
  .map((link) => link.textContent?.replace(/\s+/g, ' ').trim() ?? '')
  .filter(Boolean);
if (categories.length > 0) out.categories = [...new Set(categories)];
```

Make `loadDetail(url)` return `null` for a rejected fetch, non-OK response, or thrown error. A successful HTML response still returns `parseProductDetail(html)`, including `{}` when no supported signal exists.

Add `сувенір` to `NONBEER_CATEGORY_RE`; do not remove `сало` from `NONBEER_TITLE_RE`, because it remains useful provisional evidence for actual food products.

- [ ] **Step 7: Emit provisional cards and hydrate every Flasker URL**

Add a module-local `WeakSet<HTMLElement>` for parsed provisional cards that may become matchable:

```ts
const detailProofRequired = new WeakSet<HTMLElement>();
```

In `parseCards`, compute the current title/category rejection before parsing. Every remaining raw
entry with a product URL must produce either a parsed card or a classification-only fallback. The
fallback uses an empty brewery, the normalized raw title as its name, and `skip: true`; remember its
URL but do not add it to `detailProofRequired`, so no category can send an identity-less card to
`/match`:

```ts
const parsed = parseTitle(e.title, {
  productTags: e.productTags,
  productUrl: e.productUrl,
});
if (!parsed) {
  if (!e.productUrl) continue;
  detailUrls.set(e.el, e.productUrl);
  cards.push({ el: e.el, brewery: '', name: e.title, skip: true });
  continue;
}
```

For a parsed card, preserve the existing terminal soft-drink-family guard. A remaining parsed card
requires detail proof when it has no volume or either current synchronous non-beer gate rejected it:

```ts
const titleNonBeer = isNonBeerTitle(e.title);
const categoryNonBeer = Boolean(e.categoryHint && isNonBeerCategory(e.categoryHint));
if (isNonAlcoholicSoftDrinkFamily({
  name: `${parsed.brewery} ${parsed.name}`,
  abv: parsed.abv,
})) continue;

const requiresDetail = volumeIndex(e.title) < 0 || titleNonBeer || categoryNonBeer;
if (requiresDetail && !e.productUrl) continue;
if (e.productUrl) detailUrls.set(e.el, e.productUrl);
if (requiresDetail) detailProofRequired.add(e.el);
cards.push({ el: e.el, ...parsed, ...(requiresDetail ? { skip: true } : {}) });
```

Set `loadDetailsBeforeCache: true` on the Flasker adapter. In `loadCardDetails`, remove `.slice(...)`, load every card with a remembered URL, and apply classification before brand/bid hydration:

```ts
const detail = await loadDetail(url);
if (!detail) return;

const categories = detail.categories ?? [];
if (categories.some(isNonBeerCategory)) {
  card.nonBeer = true;
  card.skip = true;
  return;
}
if (detailProofRequired.has(card.el)) {
  if (categories.length === 0) return;
  card.skip = false;
}
```

After that block, retain the existing canonicalized brand and bid/bidSlug assignments unchanged. This yields fail-closed provisional cards and fail-open established cards without inventing a beer-category allowlist.

- [ ] **Step 8: Update Flasker's conformance branch**

Make the existing non-beer conformance test async. Keep the current zero-card assertion for every adapter except Flasker. For Flasker, return one successful `Сувеніри` category response, hydrate the parsed fixture cards, and assert all emitted cards are confirmed non-beer:

```ts
if (id === 'flasker') {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    text: async () =>
      '<span class="posted_in"><a href="https://flasker.com.ua/product-category/suveniry/">Сувеніри</a></span>',
  } as Response);
  const cards = adapter.parseCards(doc);
  await adapter.loadCardDetails?.(cards);
  expect(cards.length).toBeGreaterThan(0);
  expect(cards.every((card) => card.nonBeer && card.skip)).toBe(true);
  return;
}
expect(adapter.parseCards(doc)).toEqual([]);
```

This is a temporary Flasker-only branch. #623 owns replacing it with a shared all-adapter contract.

- [ ] **Step 9: Run targeted tests and verify GREEN**

Run from `extension/`:

```bash
npm test -- src/sites/flasker.test.ts src/sites/conformance.test.ts src/content/index.test.ts src/content/badge.test.ts
```

Expected: PASS. Also run the existing no-capture fixture parser as a parser sanity check:

```bash
npm run capture -- flasker.block --parse --no-capture
```

Expected: no throw; output now includes the captured no-volume `VibrantPour Real Smoothie Ale` candidate.

- [ ] **Step 10: Commit Flasker classification**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts extension/src/sites/conformance.test.ts
git commit -m "fix(extension): classify every Flasker product card"
```

---

## Core Review Checkpoint — stop before periphery work

After Task 3, do not edit `spec.md`, changelog or user documentation yet.

1. Run the full extension gate from `extension/`:

   ```bash
   npm test
   npm run typecheck
   npm run build
   ```

2. Run the repository gate from the repository root:

   ```bash
   npm test
   npm run typecheck
   ```

3. Run `git diff --check` and inspect every changed core line against the design's failure table and claims/evidence table.
4. Run a whole-branch code review scoped to the three implementation commits. The review package must explicitly name the inline Task 1 badge work, as required by `AGENTS.md`.
5. Resolve valid core findings and rerun both gates.
6. Only after the core review is clean, write a separate periphery plan for:
   - `spec.md` §6;
   - `extension/CHANGELOG.md` `[Unreleased]`;
   - `docs/extension-install-uk.md` badge legend.

The core checkpoint is not completion of #615. It is the required boundary before planning files that describe a mechanism which did not exist when this plan was written.
