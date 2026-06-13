# Adapter non-beer filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "drops obvious non-beers (packs/sets/merch)" a tested, enforced requirement of every browser-extension shop adapter, and document a one-time purge of the existing non-beer orphans.

**Architecture:** Add a shared `non-beer.ts` helper (`isNonBeerName`) with a conservative multi-word packaging vocabulary; the three unfiltered adapters (`winetime`, `onemorebeer`, `beerfreak`) adopt it, `beerrepublic` migrates to it (DRY), `bierloods22`/`hoptimaal` keep their existing shop-specific filters. A new conformance case over `ADAPTERS` requires each adapter to ship a pure-non-beer fixture whose `parseCards()` returns `[]` (or an explicit `none:true` exemption). Detection stays shop-specific; the test enforces the behavior.

**Tech Stack:** TypeScript, Vitest, jsdom (`DOMParser`), Vite. All work is under `extension/`.

**Spec:** `docs/superpowers/specs/2026-06-13-adapter-non-beer-filtering-design.md`

---

## File Structure

- Create: `extension/src/sites/non-beer.ts` — shared `isNonBeerName(name)` + vocabulary.
- Create: `extension/src/sites/non-beer.test.ts` — unit tests (packaging phrases match; FP cases stay).
- Modify: `extension/src/sites/beerrepublic.ts` — replace local `isNonBeerProduct` with shared helper.
- Modify: `extension/src/sites/winetime.ts` — add `isNonBeerName(rawTitle)` skip.
- Modify: `extension/src/sites/onemorebeer.ts` — add `isNonBeerName(rawTitle)` skip.
- Modify: `extension/src/sites/beerfreak.ts` — add `isNonBeerName(rawTitle)` skip.
- Modify: `extension/src/sites/conformance.test.ts` — add the `.nonbeer` conformance case.
- Create: `extension/tests/fixtures/{beerrepublic,bierloods22,hoptimaal,winetime,onemorebeer,beerfreak}.nonbeer.html` — pure non-beer fixtures.
- Modify: `spec.md` §6 — adapter non-beer contract invariant + conformance description.
- Modify: `docs/adapter-authoring.md` — new step for non-beer filtering + fixture.
- Modify: `docs/debug-orphan-matching.md` — "non-beer orphan" triage branch + purge pointer.

All commands below assume CWD `extension/` unless stated. Test runner: `npm test -- <args>` (Vitest).

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
    'Pakiet Smakowy',
    'Набір пива Underwood tasting set + келих',
    'Mixed Pack IPA',
    'Beer Club Subscription',
  ])('flags packaging product %j', (name) => {
    expect(isNonBeerName(name)).toBe(true);
  });

  it.each([
    'Beer in a Box',          // real beer name — bare "box" must NOT match
    'Glass',                  // a beer could be named this
    'Ironic T-Shirt Stout',   // apparel word inside a real beer name
    'India Pale Ale',
    'Imperial Hard Cider',    // cider stays — valid Untappd entity
    'Pomelo Nealko',
  ])('keeps real beer %j', (name) => {
    expect(isNonBeerName(name)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/sites/non-beer.test.ts`
Expected: FAIL — `Failed to resolve import "./non-beer"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/sites/non-beer.ts`:

```ts
// Shop-agnostic baseline detector for non-beer products (packs / sets / merch bundles).
// Matches only MULTI-WORD packaging phrases (and a few unambiguous single words), never
// bare ambiguous words like "box"/"glass" — so a real beer named "Beer in a Box" stays.
// Adapters keep the final say: they may add shop-specific signals (e.g. collection URL) or
// override. This is a reusable baseline, not a mandatory gate.
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
    'mixed pack',
    'mixed case',
    'subscription',   // unambiguous: no beer is named "Subscription"
    'abonnement',
    'zestaw',         // PL: set/kit
    'pakiet',         // PL: package
    'набір',          // UA: set/kit
    '\\+ ?келих',     // UA: "+ glass" merch bundle
    '\\+ ?szklank',   // PL: "+ glass"
    '\\+ ?glass',
  ].join('|'),
  'iu',
);

export function isNonBeerName(name: string): boolean {
  return NON_BEER_NAME_RE.test(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/sites/non-beer.test.ts`
Expected: PASS (all 17 cases).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/non-beer.ts extension/src/sites/non-beer.test.ts
git commit -m "feat(extension): shared isNonBeerName non-beer detector"
```

---

### Task 2: Conformance `.nonbeer` enforcement case

**Files:**
- Modify: `extension/src/sites/conformance.test.ts` (add one `it(...)` inside the existing `describe.each`)

> This task adds the enforcement gate. Until each adapter ships its `.nonbeer.html` (Tasks 3–8),
> the new case is RED for adapters without a fixture — that is expected and is the point. Use
> `-t <adapter id>` to check a single adapter as you go.

- [ ] **Step 1: Add the conformance case**

In `extension/src/sites/conformance.test.ts`, the file already imports `existsSync, readFileSync` and `resolve`, and has `const fixturePath = (id) => resolve(__dirname, \`../../tests/fixtures/${id}.html\`)`. Add a sibling path helper near it:

```ts
const nonBeerHtmlPath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.nonbeer.html`);
const nonBeerJsonPath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.nonbeer.json`);
```

Then add this test inside the `describe.each(...)('adapter contract: %s', (id, adapter) => { ... })` block (alongside the existing `it(...)` cases):

```ts
it('drops non-beer products: parses zero cards from its non-beer fixture (or is exempt)', () => {
  // Exemption: a shop with verified-zero non-beers ships {none:true, reason}. Reason is required
  // so an exemption is a deliberate, documented choice — not a silently skipped obligation.
  if (existsSync(nonBeerJsonPath(id))) {
    const meta = JSON.parse(readFileSync(nonBeerJsonPath(id), 'utf8')) as { none?: boolean; reason?: string };
    if (meta.none) {
      expect(typeof meta.reason === 'string' && meta.reason.trim().length).toBeTruthy();
      return;
    }
  }
  // Otherwise the adapter MUST ship a pure-non-beer fixture, and must filter all of it out.
  expect(existsSync(nonBeerHtmlPath(id))).toBe(true);
  const doc = new DOMParser().parseFromString(readFileSync(nonBeerHtmlPath(id), 'utf8'), 'text/html');
  expect(adapter.parseCards(doc)).toEqual([]);
});
```

- [ ] **Step 2: Run the conformance suite to confirm the gate is active**

Run: `npm test -- src/sites/conformance.test.ts`
Expected: FAIL — the new case fails for every adapter that has no `.nonbeer.html` yet (all 6 at this point). Other conformance cases stay green. This confirms the gate exists.

- [ ] **Step 3: Commit**

```bash
git add extension/src/sites/conformance.test.ts
git commit -m "test(extension): conformance requires each adapter to filter non-beers"
```

---

### Task 3: beerrepublic — migrate to shared helper + fixture

**Files:**
- Modify: `extension/src/sites/beerrepublic.ts:7-9,21`
- Create: `extension/tests/fixtures/beerrepublic.nonbeer.html`

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/beerrepublic.nonbeer.html` (BeerRepublic `.product-item` card shape, brewery in `.product-item__vendor`, title in `.product-item__title`):

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

- [ ] **Step 2: Run the adapter's conformance case to verify it fails**

Run: `npm test -- src/sites/conformance.test.ts -t beerrepublic`
Expected: FAIL on the non-beer case — `Mixed Vertical Set 2024` passes the current local regex (`vertical set`), but `Drekker Brewery Pack` also passes (`brewery pack`). Both are already covered, so this may PASS even before migration. If it PASSES, that is fine — proceed to the migration step (refactor, behavior preserved). If it FAILS, note which title leaked.

> beerrepublic already filters `brewery pack`/`vertical set`, so the fixture should already be
> filtered. The migration below is a DRY refactor that must keep the case green.

- [ ] **Step 3: Migrate to the shared helper**

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

- [ ] **Step 4: Run beerrepublic tests (conformance case + bespoke) to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t beerrepublic src/sites/beerrepublic.test.ts`
Expected: PASS — non-beer fixture yields `[]`, and the existing beerrepublic bespoke tests still pass (the shared vocabulary is a superset of the old regex).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/beerrepublic.ts extension/tests/fixtures/beerrepublic.nonbeer.html
git commit -m "refactor(extension/beerrepublic): use shared isNonBeerName + non-beer fixture"
```

---

### Task 4: bierloods22 — fixture only (existing filter)

**Files:**
- Create: `extension/tests/fixtures/bierloods22.nonbeer.html`

> bierloods22 already filters via `PACKAGE_TITLE_RE` (`beer package`, `beerbox`, `subscription`,
> `surprise box`, …). No code change — just prove it with a fixture.

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/bierloods22.nonbeer.html` (bierloods22 `.product-block` card, title in `a.title` with a `title=` attr):

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
Expected: PASS — `Beer Package December` matches `beer package\b`; `BeerBox - Surprise 8 pack` matches the `^beerbox\s*-` branch. `parseCards` returns `[]`.

> If either leaks, the existing `PACKAGE_TITLE_RE` needs the missing phrase — but both are already
> covered by the current regex; do not change the adapter unless the test actually fails.

- [ ] **Step 3: Commit**

```bash
git add extension/tests/fixtures/bierloods22.nonbeer.html
git commit -m "test(extension/bierloods22): non-beer fixture proves package filter"
```

---

### Task 5: hoptimaal — fixture only (existing URL filter)

**Files:**
- Create: `extension/tests/fixtures/hoptimaal.nonbeer.html`

> hoptimaal filters by collection URL (`NON_BEER_COLLECTION_RE`: `/bundles`, `/merch`, `/spirits`,
> `/beer-club`, `/beer-packages`, `/abonnement`). The card URL comes from `data-url` or the title
> link's `href`. No code change — prove with a fixture whose cards live in those collections.

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/hoptimaal.nonbeer.html` (hoptimaal `.product-item` with title link `.product-item__product-title a`, non-beer collection URLs):

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
Expected: PASS — both cards' `data-url` match `/collections/(merch|bundles)/`, so `isNonBeerCard` filters them; `parseCards` returns `[]`.

- [ ] **Step 3: Commit**

```bash
git add extension/tests/fixtures/hoptimaal.nonbeer.html
git commit -m "test(extension/hoptimaal): non-beer fixture proves collection-URL filter"
```

---

### Task 6: winetime — add filter + fixture

**Files:**
- Modify: `extension/src/sites/winetime.ts` (import + one guard in `parseCards`)
- Create: `extension/tests/fixtures/winetime.nonbeer.html`

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/winetime.nonbeer.html` (winetime `a.product-micro` card; with no `window.initialData.category` script, the adapter falls back to the visible `.product-micro--title`):

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
    <div class="product-micro--title">Подарунковий набір крафтового пива</div>
  </a>
</div>
</body></html>
```

- [ ] **Step 2: Run the adapter's conformance case to verify it fails**

Run: `npm test -- src/sites/conformance.test.ts -t winetime`
Expected: FAIL — winetime has no non-beer filter yet, so it emits 2 cards instead of `[]`.

- [ ] **Step 3: Add the filter**

In `extension/src/sites/winetime.ts`, add the import at the top:

```ts
import { isNonBeerName } from './non-beer';
```

Then in `parseCards`, right after `if (!rawTitle) continue;` (currently line 145), add:

```ts
      if (isNonBeerName(rawTitle)) continue;
```

(Filter on `rawTitle`, before `cleanName`, so the `Набір`/`+ келих` cues are still present.)

- [ ] **Step 4: Run winetime tests to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t winetime src/sites/winetime.test.ts`
Expected: PASS — non-beer fixture yields `[]`; existing winetime bespoke tests still pass (the helper only matches packaging phrases, not the normal beer titles in `winetime.html`).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/winetime.ts extension/tests/fixtures/winetime.nonbeer.html
git commit -m "feat(extension/winetime): filter non-beer sets/merch (Набір, + келих)"
```

---

### Task 7: onemorebeer — add filter + fixture

**Files:**
- Modify: `extension/src/sites/onemorebeer.ts` (import + one guard in `parseCards`)
- Create: `extension/tests/fixtures/onemorebeer.nonbeer.html`

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/onemorebeer.nonbeer.html` (onemorebeer `.one-product-list-view__tile`; brewery in `[data-information-type="brand-name"] .one-product-tile-information__row__value`, title in `a.product__title`):

```html
<!doctype html>
<html><body>
<div class="one-catalog-view-list">
  <div class="one-product-list-view__tile">
    <div data-information-type="brand-name">
      <span class="one-product-tile-information__row__value">OneMoreBeer</span>
    </div>
    <a class="product__title">OneMoreBeer Zestaw Prezentowy 6 piw</a>
  </div>
  <div class="one-product-list-view__tile">
    <div data-information-type="brand-name">
      <span class="one-product-tile-information__row__value">OneMoreBeer</span>
    </div>
    <a class="product__title">Advent Calendar 24 piwa</a>
  </div>
</div>
</body></html>
```

- [ ] **Step 2: Run the adapter's conformance case to verify it fails**

Run: `npm test -- src/sites/conformance.test.ts -t onemorebeer`
Expected: FAIL — onemorebeer has no non-beer filter; it emits 2 cards instead of `[]`.

- [ ] **Step 3: Add the filter**

In `extension/src/sites/onemorebeer.ts`, add the import at the top:

```ts
import { isNonBeerName } from './non-beer';
```

Then in `parseCards`, right after `if (!brewery || !rawTitle) continue;` (currently line 42), add:

```ts
      if (isNonBeerName(rawTitle)) continue;
```

- [ ] **Step 4: Run onemorebeer tests to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t onemorebeer src/sites/onemorebeer.test.ts`
Expected: PASS — non-beer fixture yields `[]`; existing onemorebeer bespoke tests still pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/onemorebeer.ts extension/tests/fixtures/onemorebeer.nonbeer.html
git commit -m "feat(extension/onemorebeer): filter non-beer sets/calendars"
```

---

### Task 8: beerfreak — add filter + fixture

**Files:**
- Modify: `extension/src/sites/beerfreak.ts` (import + one guard in `parseCards`)
- Create: `extension/tests/fixtures/beerfreak.nonbeer.html`

- [ ] **Step 1: Create the pure-non-beer fixture**

Create `extension/tests/fixtures/beerfreak.nonbeer.html` (beerfreak `.catalogCard.j-catalog-card`; with no `products = [...]` script, the adapter falls back to `.catalogCard-title a` text + brandless split):

```html
<!doctype html>
<html><body>
<div data-catalog-view-block="products">
  <div class="catalogCard j-catalog-card">
    <div class="j-product-container" data-id="1"></div>
    <div class="catalogCard-title"><a>BeerFreak Подарунковий набір пива</a></div>
  </div>
  <div class="catalogCard j-catalog-card">
    <div class="j-product-container" data-id="2"></div>
    <div class="catalogCard-title"><a>Gift Box Craft Selection</a></div>
  </div>
</div>
</body></html>
```

- [ ] **Step 2: Run the adapter's conformance case to verify it fails**

Run: `npm test -- src/sites/conformance.test.ts -t beerfreak`
Expected: FAIL — beerfreak has no non-beer filter; it emits 2 cards instead of `[]`.

- [ ] **Step 3: Add the filter**

In `extension/src/sites/beerfreak.ts`, add the import at the top:

```ts
import { isNonBeerName } from './non-beer';
```

Then in `parseCards`, right after `if (!rawTitle) continue;` (currently line 86), add:

```ts
      if (isNonBeerName(rawTitle)) continue;
```

- [ ] **Step 4: Run beerfreak tests to verify green**

Run: `npm test -- src/sites/conformance.test.ts -t beerfreak src/sites/beerfreak.test.ts`
Expected: PASS — non-beer fixture yields `[]`; existing beerfreak bespoke tests still pass (`Подарунковий набір` matches `набір`, `Gift Box Craft Selection` matches `gift box`).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/beerfreak.ts extension/tests/fixtures/beerfreak.nonbeer.html
git commit -m "feat(extension/beerfreak): filter non-beer gift sets/boxes"
```

---

### Task 9: Full suite green + docs (spec.md + runbooks)

**Files:**
- Modify: `spec.md` §6
- Modify: `docs/adapter-authoring.md`
- Modify: `docs/debug-orphan-matching.md`

- [ ] **Step 1: Run the full extension test suite**

Run (from `extension/`): `npm test`
Expected: PASS — all conformance cases (including the new non-beer case for all 6 adapters), `non-beer.test.ts`, and every bespoke adapter test green.

- [ ] **Step 2: Run the build to catch type errors**

Run (from `extension/`): `npm run build`
Expected: build succeeds (no TS errors from the new import/usage).

- [ ] **Step 3: Update `spec.md` §6**

In `spec.md`, in the `## 6. Browser Extension Client` adapter bullet (the `**Per-site адаптери**` paragraph, around line 799), append this sentence after the adapter list:

```
Кожен адаптер ПОВИНЕН виключати не-пива (паки/сети/мерч) — детекція шоп-специфічна
(назва через `non-beer.ts isNonBeerName` для name-based магазинів; URL колекції для
`hoptimaal`); це форситься конформанс-тестом (див. **Тести**).
```

Then in the `**Тести**` bullet (around line 839), append after the existing conformance description:

```
Плюс **кейс фільтрації не-пива**: кожен адаптер має `tests/fixtures/<id>.nonbeer.html`
(тільки не-пиво) і `parseCards` на ньому МУСИТЬ дати `[]`; або сайдкар
`<id>.nonbeer.json` `{none:true, reason}` (виняток із обовʼязковою причиною). Відсутність
обох = червоний CI.
```

- [ ] **Step 4: Update `docs/adapter-authoring.md`**

In `docs/adapter-authoring.md`, insert a new numbered step between current step 4 (conformance) and step 5 (bespoke). Renumber the following steps (5→6, 6→7). New step text:

```
5. **Фільтр не-пива (обовʼязково).** Адаптер не має віддавати картками паки/сети/мерч.
   Для name-based магазинів використовуй `isNonBeerName` з `src/sites/non-beer.ts`
   (консервативний словник пакувальних фраз); для магазинів, де сигнал у URL/колекції —
   фільтруй по URL (як `hoptimaal`). Поклади `tests/fixtures/<id>.nonbeer.html` з **тільки**
   не-пивом — конформанс-тест вимагає, щоб `parseCards` на ньому дав `[]`. Якщо магазин
   підтверджено не має не-пива — `tests/fixtures/<id>.nonbeer.json` `{ "none": true,
   "reason": "…" }` (причина обовʼязкова).
```

- [ ] **Step 5: Update `docs/debug-orphan-matching.md`**

In `docs/debug-orphan-matching.md`, add a new subclass bullet under "### Підкласи `N, not_found`" (after the existing two bullets, around line 62):

```
- **Не-пиво (пак/сет/мерч)** — `name` є набором/паком/мерчем (`Brewery Pack`,
  `Vertical Set`, `Набір … + келих`), якого на Untappd немає. Корінь — **адаптер не
  відфільтрував не-пиво**, а НЕ матчер. Лагодити фільтром адаптера
  (`extension/src/sites/<shop>.ts` + `isNonBeerName`/URL) і додати картку у
  `<id>.nonbeer.html`. Наявні рядки видаляються разовим purge — див. нижче.
```

Then append a new section before "## Довідка" (around line 151):

```
## Purge наявних не-пив (разово, ПІСЛЯ broadcast)

Не-пиво-орфани безпечні до видалення (`untappd_id IS NULL`, без посилань у
`match_links`/`checkins`/`taps`). **Спершу dry-run SELECT**, очима звір список, потім DELETE.
Запуск під bot-користувачем (звичайний `sudo -u warsaw-beer-bot` не працює — через wrapper):

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
2. `npm run release` → broadcast the rebuilt extension to testers (also clears the pending 0.5.2 broadcast).
3. **After** broadcast: run the dry-run SELECT from the runbook, eyeball the ~21 rows, then run the DELETE.

## Self-review notes

- **Spec coverage:** §3 contract → Tasks 1–8; §3.1 fixture form → Tasks 2–8; §3.2 shared helper → Task 1 + adoption in Tasks 3,6,7,8; §3.3 retrofit → Tasks 3–8; §4 docs → Task 9; §5 purge → Task 9 runbook + post-PR sequencing; §6 testing → per-task + Task 9 Step 1; §7 rollout → "Sequencing after the PR".
- **Type consistency:** `isNonBeerName(name: string): boolean` is defined in Task 1 and called identically in Tasks 3,6,7,8. Conformance helpers `nonBeerHtmlPath`/`nonBeerJsonPath` defined and used in Task 2.
- **bierloods22/hoptimaal:** intentionally fixture-only (existing filters cover their fixtures); no code change unless Step 2 reveals a leak.
