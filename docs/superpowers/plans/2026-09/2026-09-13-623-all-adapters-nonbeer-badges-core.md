# #623 All-Adapter Non-Beer Badges — Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every adapter's existing per-card non-beer decision render the shared red, non-clickable `✕` without changing classification rules or whole-page skips.

**Architecture:** Adapters return the `Card.nonBeer + skip` state introduced by #615 instead of dropping positively classified cards. The overlay short-circuits already-classified cards before cache-key construction; Flasker's detail-hydrated ordering remains intact. Whole-page gates continue returning no cards and receive no badges.

**Tech Stack:** TypeScript, DOM APIs, Chrome MV3 content script, Vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-623-all-adapters-nonbeer-badges-design.md`

## Global Constraints

- Do not change any adapter's non-beer vocabulary or classification predicate.
- Only a positive deterministic per-card rule may set `nonBeer: true`; missing identity or failed parsing stays silent.
- Return confirmed cards as `{ el, brewery: '', name: '', nonBeer: true, skip: true }` when no useful identity has been parsed yet.
- Keep `isNonBeerPage` and equivalent whole-page metadata gates silent.
- Confirmed non-beer cards never read or write the match cache and never call `/match` or enrichment.
- Reuse `setNonBeer`; do not add a second badge renderer or new dependency.
- Do not alter Flasker's classification or pre-cache detail hydration.

---

### Task 1: Short-circuit confirmed cards before cache-key construction

**Files:**
- Modify: `extension/src/content/index.test.ts`
- Modify: `extension/src/content/index.ts`
- Modify: `extension/src/content/refresh.test.ts`
- Modify: `extension/src/content/refresh.ts`

**Interfaces:**
- Consumes: `Card.nonBeer?: boolean`, `Card.skip?: boolean`, `setNonBeer(host)` and `markSeen(host)` from #615.
- Produces: `runOverlay()` behavior in which an already-confirmed card requires only `el`, is badged and marked seen before normalization/cache work, while a card classified during Flasker hydration retains its pre-hydration key; `refreshCards()` resets non-beer DOM state without returning an irrelevant cache key.

- [ ] **Step 1: Add a failing pre-key short-circuit test**

Add this case beside the existing #615 non-beer test:

```ts
it('renders an already-confirmed non-beer before identity or cache work', async () => {
  vi.mocked(chrome.storage.local.get).mockClear();
  vi.mocked(chrome.storage.local.set).mockClear();
  const card: Card = {
    el: cardEl(),
    brewery: undefined as unknown as string,
    name: undefined as unknown as string,
    nonBeer: true,
    skip: true,
  };
  const sendMatch = vi.fn(async () => [] as MatchResult[]);
  const enrich = vi.fn();

  await runOverlay(document, adapterFor([card]), sendMatch, enrich);

  expect(card.el.querySelector(`[${BADGE_MARKER}]`)?.textContent).toBe('✕');
  expect(isSeen(card.el)).toBe(true);
  expect(chrome.storage.local.get).not.toHaveBeenCalled();
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  expect(sendMatch).not.toHaveBeenCalled();
  expect(enrich).not.toHaveBeenCalled();
});
```

Add this case to `refresh.test.ts`:

```ts
it('resets a confirmed non-beer without returning a cache key', () => {
  const host = cardEl();
  const adapter = {
    id: 'fake',
    hostMatch: () => true,
    parseCards: () => [{
      el: host,
      brewery: '',
      name: '',
      nonBeer: true,
      skip: true,
    }],
  } as SiteAdapter;

  const keys = refreshCards(document, adapter);

  expect(keys).toEqual([]);
  expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  expect(isSeen(host)).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd extension && npm test -- src/content/index.test.ts src/content/refresh.test.ts`

Expected: the new test fails because `normalizeKey(undefined, undefined)` is reached before the non-beer branch, so the outer fail-safe catches the error and no `✕` is attached.

- [ ] **Step 3: Preserve keys only for cards that initially need them**

Replace the eager `keyedCards` map with a pre-hydration key map that excludes already-confirmed cards:

```ts
const cards = adapter.parseCards(doc);
const keyByCard = new Map<Card, string>();
for (const card of cards) {
  if (!card.nonBeer) keyByCard.set(card, normalizeKey(card.brewery, card.name));
}

if (adapter.loadDetailsBeforeCache && adapter.loadCardDetails) {
  await adapter.loadCardDetails(cards);
}

const misses: { el: HTMLElement; key: string; card: Card }[] = [];
for (const card of cards) {
  if (card.nonBeer) {
    setNonBeer(card.el);
    markSeen(card.el);
    continue;
  }
  if (adapter.loadDetailsBeforeCache && card.skip) {
    markSeen(card.el);
    continue;
  }

  const key = keyByCard.get(card);
  if (key === undefined) continue;
  const cached = await getCached(key);
  if (cached?.matched_beer != null) {
    renderBadge(card.el, cached);
    markSeen(card.el);
  } else {
    misses.push({ el: card.el, key, card });
  }
}
```

Do not recompute keys after `loadCardDetails`; the existing Flasker cache-identity test must remain green.

In `refreshCards`, reset every parsed host but return keys only for cards that can participate in
matching:

```ts
for (const card of adapter.parseCards(doc)) {
  if (!card.nonBeer) keys.push(normalizeKey(card.brewery, card.name));
  resetCard(card.el);
}
```

- [ ] **Step 4: Run focused content tests**

Run: `cd extension && npm test -- src/content/index.test.ts src/content/badge.test.ts src/content/refresh.test.ts`

Expected: PASS, including the new pre-key test and the existing Flasker pre-hydration cache-key test.

- [ ] **Step 5: Commit the shared contract**

```bash
git add extension/src/content/index.ts extension/src/content/index.test.ts extension/src/content/refresh.ts extension/src/content/refresh.test.ts
git commit -m "feat(extension): short-circuit confirmed non-beer cards"
```

---

### Task 2: Migrate title-only adapters

**Files:**
- Modify: `extension/src/sites/beerrepublic.ts`
- Modify: `extension/src/sites/beerrepublic.test.ts`
- Modify: `extension/src/sites/beerfreak.ts`
- Modify: `extension/src/sites/beerfreak.test.ts`
- Modify: `extension/src/sites/bierloods22.ts`
- Modify: `extension/src/sites/bierloods22.test.ts`
- Modify: `extension/src/sites/winetime.ts`
- Modify: `extension/src/sites/winetime.test.ts`

**Interfaces:**
- Consumes: the `Card.nonBeer + skip` branch from Task 1 and each adapter's unchanged title predicate.
- Produces: explicit non-beer cards from BeerRepublic, BeerFreak, Bierloods22, and WineTime.

- [ ] **Step 1: Change existing focused expectations to require explicit cards**

For every existing test that currently expects filtered non-beers to disappear, assert the state on the same host elements. The BeerRepublic mixed-grid case must take this shape:

```ts
const parsed = beerrepublic.parseCards(doc);
expect(parsed.filter((card) => card.nonBeer)).toHaveLength(5);
expect(parsed.filter((card) => !card.nonBeer).map((card) => card.name)).toEqual([
  'Mind Haze Galaxy Bender',
]);
expect(parsed.filter((card) => card.nonBeer).every((card) => card.skip)).toBe(true);
```

In BeerFreak's shared-name, bundle, and numbered-series cases; Bierloods22's
visible/published package-title cases; and WineTime's shared-name cases, retain each test's fixture
and replace its empty-array expectation with:

```ts
const cards = adapter.parseCards(doc);
expect(cards.length).toBeGreaterThan(0);
expect(cards.every((card) => card.nonBeer && card.skip)).toBe(true);
```

Use the concrete adapter variable already present in each file in place of `adapter`. Do not change
tests in which absent DOM or an unparseable beer currently produces no card.

- [ ] **Step 2: Run the four adapter test files and verify RED**

Run:

```bash
cd extension
npm test -- src/sites/beerrepublic.test.ts src/sites/beerfreak.test.ts src/sites/bierloods22.test.ts src/sites/winetime.test.ts
```

Expected: only the revised non-beer expectations fail because the adapters still execute `continue`.

- [ ] **Step 3: Emit the shared state at each positive filter**

Replace only these branches, using the same confirmed-card literal in each:

```ts
// BeerRepublic
if (isNonBeerName(name)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}

// BeerFreak
if (isNonBeerName(rawTitle) || isBeerFreakBundle(rawTitle)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}

// Bierloods22
if (isPackageTitle(titleText) || isPackageTitle(titleAttr)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}

// WineTime
if (isNonBeerName(rawTitle)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}
```

Leave the missing-title and failed-identity branches unchanged.

- [ ] **Step 4: Run the four adapter tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the title-only adapters**

```bash
git add extension/src/sites/beerrepublic.ts extension/src/sites/beerrepublic.test.ts extension/src/sites/beerfreak.ts extension/src/sites/beerfreak.test.ts extension/src/sites/bierloods22.ts extension/src/sites/bierloods22.test.ts extension/src/sites/winetime.ts extension/src/sites/winetime.test.ts
git commit -m "feat(extension): mark title-classified non-beer products"
```

---

### Task 3: Migrate adapters with local card evidence

**Files:**
- Modify: `extension/src/sites/onemorebeer.ts`
- Modify: `extension/src/sites/onemorebeer.test.ts`
- Modify: `extension/src/sites/hoptimaal.ts`
- Modify: `extension/src/sites/hoptimaal.test.ts`
- Modify: `extension/src/sites/funkyshop.ts`
- Modify: `extension/src/sites/funkyshop.test.ts`

**Interfaces:**
- Consumes: Task 1's shared overlay behavior; current local merch, soft-drink, URL, description, style, and ABV predicates.
- Produces: explicit non-beer cards for the three adapters without weakening kvass, deposit-can, cider, mead, or 0.0% beer guards.

- [ ] **Step 1: Add explicit-state expectations around every positive local predicate**

In each focused positive case, retain the existing fixture construction and replace the empty-array
expectation with:

```ts
expect(adapter.parseCards(doc)).toEqual([
  expect.objectContaining({ nonBeer: true, skip: true }),
]);
```

For mixed fixtures, split cards with the following code, then keep the test's current literal
brewery/name expectation and change its subject from the full `cards` array to `beerCards`:

```ts
const cards = adapter.parseCards(doc);
const nonBeerCards = cards.filter((card) => card.nonBeer);
const beerCards = cards.filter((card) => !card.nonBeer);
expect(nonBeerCards.length).toBeGreaterThan(0);
expect(nonBeerCards.every((card) => card.skip)).toBe(true);
```

Do not replace those literal identities with a shared fixture value. Preserve these negative
controls as normal beer cards:

- OneMoreBeer: `MAGIC ROAD … PUSZKA … KAUCJA`, eligible kvass, non-alcoholic beer, and a ginger/root-beer family without the required ABV/style evidence.
- Hoptimaal: ordinary product URLs outside the existing excluded collections.
- Funkyshop: beer sold in a can with a deposit when the local predicate does not match the beer title/description.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd extension
npm test -- src/sites/onemorebeer.test.ts src/sites/hoptimaal.test.ts src/sites/funkyshop.test.ts
```

Expected: revised positive cases fail; all negative controls remain green.

- [ ] **Step 3: Convert only the existing positive branches**

For OneMoreBeer, retain the current ordering and emit a confirmed card at both gates:

```ts
if (isNonBeerName(rawTitle) || MERCH_RE.test(rawTitle) || SOFT_DRINK_RE.test(rawTitle)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}
const name = cleanName(rawTitle, brewery);
if (!name) continue;
const facts = technicalFacts(el);
if (isNonAlcoholicSoftDrinkFamily({ name: `${brewery} ${name}`, style: facts.style, abv: facts.abv })) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}
```

For Hoptimaal and Funkyshop:

```ts
if (isNonBeerCard(el, titleLink)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}

if (isNonBeerTitle(rawName, description)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}
```

Keep missing-title and missing-brewery detail behavior unchanged.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the local-evidence adapters**

```bash
git add extension/src/sites/onemorebeer.ts extension/src/sites/onemorebeer.test.ts extension/src/sites/hoptimaal.ts extension/src/sites/hoptimaal.test.ts extension/src/sites/funkyshop.ts extension/src/sites/funkyshop.test.ts
git commit -m "feat(extension): show locally classified non-beer products"
```

---

### Task 4: Migrate metadata adapters and enforce conformance

**Files:**
- Modify: `extension/src/sites/piwnemosty.ts`
- Modify: `extension/src/sites/piwnemosty.test.ts`
- Modify: `extension/src/sites/beershop.ts`
- Modify: `extension/src/sites/beershop.test.ts`
- Modify: `extension/src/sites/conformance.test.ts`

**Interfaces:**
- Consumes: Task 1's overlay short-circuit and Tasks 2–3's adapter behavior.
- Produces: explicit Piwne Mosty and Beershop per-card states plus a registry-wide executable contract; Beershop category-id pages remain silent.

- [ ] **Step 1: Write focused metadata-boundary expectations**

Change Piwne Mosty's non-beer fixture test to require non-empty confirmed cards:

```ts
const cards = piwnemosty.parseCards(doc);
expect(cards.length).toBeGreaterThan(0);
expect(cards.every((card) => card.nonBeer && card.skip)).toBe(true);
```

Keep every `isNonBeerPage` assertion unchanged.

For Beershop, keep all category-id and captured lemonade-category tests equal to `[]`. Change only the mixed-grid shared pack test:

```ts
expect(adapter.parseCards(doc)).toEqual([
  expect.objectContaining({ nonBeer: true, skip: true }),
]);
```

- [ ] **Step 2: Update conformance expectations before implementation**

Replace the old “drops non-beer products” assertion with:

```ts
it('returns confirmed per-card non-beer products (or preserves a whole-page exception)', async () => {
  expect(existsSync(nonBeerHtmlPath(id))).toBe(true);
  const doc = new DOMParser().parseFromString(readFileSync(nonBeerHtmlPath(id), 'utf8'), 'text/html');

  if (id === 'beershop') {
    expect(adapter.parseCards(doc)).toEqual([]);
    return;
  }

  const cards = adapter.parseCards(doc);
  if (id === 'flasker') {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => '<span class="posted_in"><a href="https://flasker.com.ua/product-category/suveniry/">Сувеніри</a></span>',
    } as Response);
    await adapter.loadCardDetails?.(cards);
  }
  expect(cards.length).toBeGreaterThan(0);
  expect(cards.every((card) => card.nonBeer && card.skip)).toBe(true);
});
```

Add an overlay assertion for the same eligible fixtures. Flasker needs its detail response mocked
inside this test because `beforeEach` resets `fetch` before every case:

```ts
it('renders confirmed non-beer cards without matching them', async () => {
  if (id === 'beershop') return;
  const doc = new DOMParser().parseFromString(readFileSync(nonBeerHtmlPath(id), 'utf8'), 'text/html');
  const match = vi.fn(sendMatch);

  if (id === 'flasker') {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => '<span class="posted_in"><a href="https://flasker.com.ua/product-category/suveniry/">Сувеніри</a></span>',
    } as Response);
  }

  await runOverlay(doc, adapter, match);

  const cards = adapter.parseCards(doc);
  expect(cards.length).toBeGreaterThan(0);
  expect(cards.every((card) => card.el.querySelector('[data-beerbadge]')?.textContent === '✕')).toBe(true);
  expect(cards.every((card) => card.el.hasAttribute('data-beerseen'))).toBe(true);
  expect(match).not.toHaveBeenCalled();
});
```

Import `runOverlay` from `../content/index`. Keep the existing normal-fixture re-render test.

In `beershop.test.ts`, import `vi` and `runOverlay`, then add the mixed-grid rendering proof:

```ts
it('renders a non-clickable status for a shared non-beer pack in a mixed grid', async () => {
  const adapter = adapterFor();
  if (!adapter) return;
  const doc = new DOMParser().parseFromString(
    productHtml(156, 'Beershop', 'World Beer Gift Pack'),
    'text/html',
  );
  const sendMatch = vi.fn(async () => []);

  await runOverlay(doc, adapter, sendMatch);

  expect(doc.querySelector('[data-beerbadge]')?.textContent).toBe('✕');
  expect(doc.querySelector('[data-beerseen]')).not.toBeNull();
  expect(sendMatch).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run metadata and conformance tests and verify RED**

Run:

```bash
cd extension
npm test -- src/sites/piwnemosty.test.ts src/sites/beershop.test.ts src/sites/conformance.test.ts
```

Expected: Piwne Mosty, Beershop's mixed pack, and the new conformance assertions fail; Beershop whole-page cases remain green.

- [ ] **Step 4: Emit Piwne Mosty and Beershop per-card states**

In Piwne Mosty, retain the missing-title branch and convert only `isNonBeerCard`:

```ts
if (!title) continue;
if (isNonBeerCard(title, item)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}
```

In Beershop, leave this whole-page gate untouched:

```ts
if (categoryId && NON_BEER_CATEGORY_IDS.has(categoryId)) return [];
```

Convert only the shared per-card predicate after `name` is available:

```ts
if (!name) continue;
if (isNonBeerName(`${brewery} ${name}`)) {
  cards.push({ el, brewery: '', name: '', nonBeer: true, skip: true });
  continue;
}
cards.push({ el, brewery, name });
```

- [ ] **Step 5: Run the complete core test gate**

Run:

```bash
cd extension
npm test -- src/content/index.test.ts src/content/badge.test.ts src/sites/conformance.test.ts src/sites/beerrepublic.test.ts src/sites/onemorebeer.test.ts src/sites/beerfreak.test.ts src/sites/bierloods22.test.ts src/sites/winetime.test.ts src/sites/hoptimaal.test.ts src/sites/piwnemosty.test.ts src/sites/funkyshop.test.ts src/sites/beershop.test.ts
npm run typecheck
```

Expected: all selected tests and extension typecheck PASS.

- [ ] **Step 6: Commit the metadata adapters and conformance contract**

```bash
git add extension/src/sites/piwnemosty.ts extension/src/sites/piwnemosty.test.ts extension/src/sites/beershop.ts extension/src/sites/beershop.test.ts extension/src/sites/conformance.test.ts
git commit -m "feat(extension): enforce non-beer card conformance"
```

## Core review checkpoint

Stop after Task 4. Review the entire branch diff against the design, with special attention to:

- false-positive guards that must still emit normal beer cards;
- branches for missing DOM/identity that must still emit nothing;
- Beershop category-id and all `isNonBeerPage` gates remaining silent;
- Flasker retaining its pre-hydration cache key and detail behavior;
- every confirmed card bypassing cache, `/match`, and enrichment.

Resolve valid findings and rerun the Task 4 gate before starting the periphery plan.
