# Issue #117 — Collab/order-aware name matching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 6 of the 7 #117 beers enrich correctly by teaching the matcher order-insensitive + collab/bilingual-aware name matching, fixing the bierloods22 brewery parse, and stripping `collab` junk from enrichment search queries — with zero new false positives.

**Architecture:** Three independent changes. (1) `domain/`: a `nameKeys(name, brewery)` set — collab-split + brewery-dedup + token-sort, multi-token-guarded — wired as an *additional* exact-equivalent condition into `matchPrepared` and as a pre-fuzzy stage in `lookupBeer`. (2) `extension/`: derive bierloods22 brewery from the `a.title` `title=` brand-prefix. (3) `domain/normalize.ts`: add `collab` to `BREWERY_NOISE` and make `stripBreweryNoise` collab-separator-aware. No DB migration.

**Tech Stack:** Node 20, TypeScript (strict), Jest (server), Vitest (extension), fast-fuzzy, cheerio.

**Spec:** `docs/superpowers/specs/2026-06-11-issue-117-matcher-collab-order-design.md`. Read it first.

**Ground-truth fixtures (already committed):** `tests/fixtures/untappd-search/{kykao,schneider,fast-talking,messorem,primator,omnipollo,staropolski}.html`.

---

## Task 1: Collab-aware brewery query (Omnipollo)

Moves `COLLAB_SEP` to `normalize.ts` (single source), adds `collab`/`collaboration` to `BREWERY_NOISE`, and makes `stripBreweryNoise` split on collab separators so glued junk like `collab/` is stripped.

**Files:**
- Modify: `src/domain/normalize.ts`
- Modify: `src/domain/matcher.ts` (re-export `COLLAB_SEP`)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/normalize.test.ts` inside the existing `describe('stripBreweryNoise', …)` block (or append a new `describe`):

```typescript
describe('collab-aware stripBreweryNoise (#117 Omnipollo)', () => {
  test('drops the "collab" descriptor glued to a slash and joins collab parts', () => {
    expect(stripBreweryNoise('Omnipollo collab/ Trillium Brewing Company')).toBe('Omnipollo Trillium');
  });
  test('drops bare "collab"/"collaboration" tokens', () => {
    expect(stripBreweryNoise('Foo collab Bar')).toBe('Foo Bar');
    expect(stripBreweryNoise('Foo Collaboration Bar')).toBe('Foo Bar');
  });
  test('collapses x- and &-connectors to space', () => {
    expect(stripBreweryNoise('Alpha x Beta')).toBe('Alpha Beta');
    expect(stripBreweryNoise('Alpha & Beta')).toBe('Alpha Beta');
  });
  test('leaves a non-collab " - " brewery intact', () => {
    expect(stripBreweryNoise('Kykao - Handcrafted')).toBe('Kykao - Handcrafted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/normalize.test.ts -t "collab-aware"`
Expected: FAIL — `'Omnipollo collab/ Trillium'` (current output keeps `collab/`).

- [ ] **Step 3: Add `COLLAB_SEP` to `normalize.ts`**

In `src/domain/normalize.ts`, add near the top (after the imports / before `STYLE_WORDS` is fine), with the explanatory comment moved from `matcher.ts`:

```typescript
// Separator for collab/bilingual brewery names. Untappd uses:
//   "A / B"  — slash with any spacing (bilingual or collab)
//   "A x B"  — " x "/" X " connector (collab, case-insensitive)
//   "A & B"  — " & " connector (collab)
// String.split() applies this to every occurrence regardless of the global flag.
export const COLLAB_SEP = /\s*\/\s*|\s+[Xx]\s+|\s+&\s+/;
```

Add `'collab', 'collaboration',` to the `BREWERY_NOISE` set (English/Polish line):

```typescript
const BREWERY_NOISE = new Set([
  // English / Polish
  'browar', 'browary', 'brewery', 'brewing', 'co', 'company', 'contracts',
  'collab', 'collaboration',
  // Czech / Slovak, German, French, Italian, Dutch/Flemish,
  // Scandinavian (+ definite form), Spanish (post-diacritic-strip form)
  'pivovar', 'pivovary', 'brauerei', 'brasserie', 'birrificio',
  'brouwerij', 'bryggeri', 'bryggeriet', 'cerveceria',
]);
```

Replace the body of `stripBreweryNoise` to split on `COLLAB_SEP` first:

```typescript
export function stripBreweryNoise(brewery: string): string {
  return stripLegalForm(brewery)
    .split(COLLAB_SEP)             // collapse "/", " x ", " & " so glued junk ("collab/") detaches
    .join(' ')
    .split(/\s+/)
    .filter((tok) => tok && !BREWERY_NOISE.has(tok.toLowerCase()))
    .join(' ')
    .trim();
}
```

- [ ] **Step 4: Re-export `COLLAB_SEP` from `matcher.ts`**

In `src/domain/matcher.ts`, change the import line to include `COLLAB_SEP`:

```typescript
import { normalizeName, normalizeBrewery, COLLAB_SEP } from './normalize';
```

Delete the local definition block (the comment + `export const COLLAB_SEP = /…/;`) and replace it with a re-export so existing importers (`untappd-lookup.ts`) keep working:

```typescript
export { COLLAB_SEP } from './normalize';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/domain/normalize.test.ts src/domain/matcher.test.ts src/domain/untappd-lookup.test.ts`
Expected: PASS (all, including the pre-existing collab/x-connector lookup tests).

- [ ] **Step 6: Add the enrich-endpoint searchUrl assertion**

In `src/api/routes/enrich.test.ts`, add (inside the existing `describe('POST /enrich/candidates', …)`) a test that the candidate searchUrl no longer carries `collab`. Reuse the file's existing `setup()` and `post()` helpers (no auth on this route in tests):

```typescript
it('candidate searchUrl strips collab junk and both collab breweries (#117)', async () => {
  const { app } = setup();
  const res = await post(app, '/enrich/candidates', {
    beers: [{ brewery: 'Omnipollo collab/ Trillium Brewing Company', name: 'Kanelbullar' }],
  });
  const body = await res.json();
  const url = body.candidates[0].searchUrl as string;
  expect(url).toContain('Omnipollo%20Trillium%20Kanelbullar');
  expect(url.toLowerCase()).not.toContain('collab');
});
```

> No production change needed; `/enrich/candidates` already calls `stripBreweryNoise`, which Task 1 fixed.

- [ ] **Step 7: Run it**

Run: `npx jest src/api/routes/enrich.test.ts -t "collab junk"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/normalize.ts src/domain/matcher.ts src/domain/normalize.test.ts src/api/routes/enrich.test.ts
git commit -m "fix(matcher): collab-aware brewery query — strip 'collab' + collapse collab separators (#117 Omnipollo)"
```

---

## Task 2: `nameKeys` matcher + `matchPrepared` integration

Adds the order-insensitive, collab/bilingual-aware, brewery-deduped, multi-token-guarded name-key set and wires it into `matchPrepared`'s exact stage as an *additional* condition.

**Files:**
- Modify: `src/domain/matcher.ts`
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/matcher.test.ts`:

```typescript
import { nameKeys, intersects } from './matcher';

describe('nameKeys (#117)', () => {
  test('order-insensitive: reordered tokens produce the same key', () => {
    expect(nameKeys('TAP04 FESTWEISSE', 'Schneider'))
      .toEqual(nameKeys('Festweisse (TAP04)', 'Schneider Weisse'));
  });
  test('collab split: each "/"-side is its own key', () => {
    expect([...nameKeys('Fast Talking / North Park', 'Root + Branch')])
      .toEqual(expect.arrayContaining(['fast talking', 'north park']));
  });
  test('multi-token guard: single-token sides are dropped', () => {
    // "Finback" (1 token) dropped; "Globe Coagulant" (2) kept and sorted
    expect([...nameKeys('Globe Coagulant / Finback', 'Messorem')]).toEqual(['coagulant globe']);
  });
  test('single-token whole name → empty key set (falls through to fuzzy)', () => {
    expect(nameKeys('Kanelbullar', 'Omnipollo').size).toBe(0);
  });
  test('strips brewery duplicated into the name', () => {
    // "PRIMÁTOR Free Mother In Law" with brewery Primator → "free in law mother"
    expect([...nameKeys('PRIMÁTOR FREE MOTHER IN LAW', 'Primator')]).toEqual(['free in law mother']);
  });
  test('bilingual canonical: English side matches the deduped input', () => {
    const input = nameKeys('PRIMÁTOR FREE MOTHER IN LAW', 'Primator');
    const canon = nameKeys('Free Tchyně / Free Mother In Law', 'Primátor');
    expect([...input].some((k) => canon.has(k))).toBe(true);
  });
  test('FP: superset input does not match a shorter single-token canonical', () => {
    // "Hazy Mango" (2-token key) vs "Hazy" (1-token, dropped) → no shared key
    expect(intersects(nameKeys('Hazy Mango', 'Foo'), nameKeys('Hazy', 'Foo'))).toBe(false);
  });
  test('regression: Fifty/Fifty Clementine keys only the 2-token side, not "fifty"', () => {
    const input = nameKeys('Fifty/Fifty Clementine & Passionfruit', 'Magic Road');
    expect(intersects(input, nameKeys('Fifty / Fifty Clementine & Passionfruit', 'Magic Road'))).toBe(true);
    expect(intersects(input, nameKeys('Fifty / Fifty - Pineapple', 'Magic Road'))).toBe(false);
  });
});

describe('matchPrepared key-intersection (#117)', () => {
  const cat: CatalogBeer[] = [
    c({ id: 10, brewery: 'Schneider Weisse', name: 'Festweisse (TAP04)' }),
    c({ id: 11, brewery: 'Root + Branch', name: 'Fast Talking' }),
  ];
  test('reordered name matches as exact (source=exact, confidence 1)', () => {
    const m = matchBeer({ brewery: 'Schneider', name: 'TAP04 FESTWEISSE' }, cat);
    expect(m).toEqual({ id: 10, confidence: 1, source: 'exact' });
  });
  test('collab partner in input name matches the base beer as exact', () => {
    const m = matchBeer({ brewery: 'Root + Branch', name: 'Fast Talking / North Park' }, cat);
    expect(m).toEqual({ id: 11, confidence: 1, source: 'exact' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/domain/matcher.test.ts -t "#117"`
Expected: FAIL — `nameKeys` is not exported / not a function.

- [ ] **Step 3: Implement `nameKeys`, `stripLeadingBrewery`, `intersects`**

In `src/domain/matcher.ts`, add after `breweryAliases` (and export them):

```typescript
// Strip leading brewery tokens duplicated into a normalized name (e.g. the product
// title "PRIMÁTOR Free Mother In Law" with brewery "Primátor"). Token-prefix only.
function stripLeadingBrewery(nameNorm: string, breweryNorm: string): string {
  if (!breweryNorm) return nameNorm;
  const nt = nameNorm.split(' ').filter(Boolean);
  const bt = breweryNorm.split(' ').filter(Boolean);
  if (bt.length && bt.length < nt.length && bt.every((t, i) => nt[i] === t)) {
    return nt.slice(bt.length).join(' ');
  }
  return nameNorm;
}

// Set of canonical name keys: split on COLLAB_SEP (collab/bilingual sides), normalize
// each side, strip a leading brewery duplication, drop <2-token sides (weak keys), then
// sort tokens (order-insensitive). Names match when their key sets intersect — set
// EQUALITY per side, as FP-safe as exact match. Single-token whole names yield an empty
// set and fall through to the fuzzy path. See spec §3.1.
export function nameKeys(rawName: string, brewery: string): Set<string> {
  const bNorm = normalizeBrewery(brewery);
  const keys = new Set<string>();
  for (const side of rawName.split(COLLAB_SEP)) {
    const toks = stripLeadingBrewery(normalizeName(side), bNorm).split(' ').filter(Boolean);
    if (toks.length < 2) continue;
    keys.add([...toks].sort().join(' '));
  }
  return keys;
}

export function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}
```

- [ ] **Step 4: Add `keys` to `PreparedBeer` and `prepareBeer`**

In `src/domain/matcher.ts`, extend the interface:

```typescript
export interface PreparedBeer extends CatalogBeer {
  nameNorm: string;     // normalizeName(name)
  breweryNorm: string;  // normalizeBrewery(brewery)
  aliases: string[];    // breweryAliases(brewery)
  keys: Set<string>;    // nameKeys(name, brewery)  (#117)
}
```

In `prepareBeer`, add the field:

```typescript
export function prepareBeer(c: CatalogBeer): PreparedBeer {
  return {
    ...c,
    nameNorm: normalizeName(c.name),
    breweryNorm: normalizeBrewery(c.brewery),
    aliases: breweryAliases(c.brewery),
    keys: nameKeys(c.name, c.brewery),
  };
}
```

- [ ] **Step 5: Augment the `matchPrepared` exact stage**

In `matchPrepared`, just before the `exacts` filter, compute input keys; then add the OR condition:

```typescript
  const inputAliases = breweryAliases(input.brewery);
  const nn = normalizeName(input.name);
  const inputKeys = nameKeys(input.name, input.brewery);   // #117
  const catalog = prepared.beers;

  const exacts = catalog
    .filter(
      (c) =>
        breweryAliasesMatch(c.aliases, inputAliases) &&
        (c.nameNorm === nn || intersects(c.keys, inputKeys)),   // #117: order/collab-aware exact
    )
    .sort((a, b) => b.id - a.id);
```

Leave the rest of `matchPrepared` (vintage/ABV partitioning, fuzzy fallback, divergence guard) unchanged.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/domain/matcher.test.ts`
Expected: PASS (new #117 tests + all pre-existing).

- [ ] **Step 7: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): order/collab-aware nameKeys set + matchPrepared exact-stage intersection (#117)"
```

---

## Task 3: `lookupBeer` name-keys stage (enrichment)

Adds a pre-fuzzy name-keys intersection stage to `lookupBeer` so collab/order cases match during Untappd enrichment.

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/untappd-lookup.test.ts` (reuse the file's `htmlFor` helper):

```typescript
describe('lookupBeer name-keys stage (#117)', () => {
  test('matched: reordered name (below fuzzy 0.85) via key intersection', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 11827, name: 'Festweisse (TAP04)', brewery: 'Schneider Weisse G. Schneider & Sohn' }]),
    );
    const out = await lookupBeer({ brewery: 'Schneider', name: 'TAP04 FESTWEISSE', fetch });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(11827);
  });

  test('matched: collab partner in input name → base-beer key hit', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 6683161, name: 'Fast Talking', brewery: 'Root + Branch Brewing' }]),
    );
    const out = await lookupBeer({ brewery: 'Root + Branch', name: 'Fast Talking / North Park', fetch });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6683161);
  });

  test('not_found: single-token name with no fuzzy hit stays not_found', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 1, name: 'Totally Different', brewery: 'Root + Branch' }]),
    );
    const out = await lookupBeer({ brewery: 'Root + Branch', name: 'Hazy', fetch });
    expect(out.kind).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/domain/untappd-lookup.test.ts -t "name-keys stage"`
Expected: FAIL — first two return `not_found` (fuzzy < 0.85, no key stage yet).

- [ ] **Step 3: Add the name-keys stage**

In `src/domain/untappd-lookup.ts`, update the import from `./matcher`:

```typescript
import { breweryAliases, breweryAliasesMatch, ABV_TOLERANCE, COLLAB_SEP, nameKeys, intersects } from './matcher';
```

Inside `lookupBeer`, after the Stage-1 brewery filter (`if (breweryPassed.length === 0) continue;`) and **before** the `Searcher` construction, insert:

```typescript
    // Stage 2a: name-keys exact intersection (order-insensitive, collab/bilingual aware).
    const inputKeys = nameKeys(name, brewery);
    const keyHits = breweryPassed.filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), inputKeys),
    );
    if (keyHits.length > 0) {
      if (abv != null) {
        const abvHit = keyHits.find(
          (r) => r.abv != null && Math.abs(r.abv - abv) <= ABV_TOLERANCE,
        );
        if (abvHit) return { kind: 'matched', result: abvHit };
      }
      return { kind: 'matched', result: keyHits[0] };
    }

    // Stage 2b: name fuzzy >= 0.85 (fallback).
```

Leave the existing fuzzy `Searcher` block (now Stage 2b) unchanged below.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/domain/untappd-lookup.test.ts`
Expected: PASS (new #117 tests + all pre-existing, incl. the Fifty/Fifty fuzzy test which still routes via 2b).

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "feat(enrich): name-keys intersection stage in lookupBeer before fuzzy (#117)"
```

---

## Task 4: bierloods22 brewery from brand-prefix

Fixes the Kykao parse: derive brewery from the `a.title` `title=` brand-prefix instead of splitting the visible title on the first `" - "`.

**Files:**
- Modify: `extension/src/sites/bierloods22.ts`
- Create: `extension/src/sites/bierloods22.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/sites/bierloods22.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { bierloods22 } from './bierloods22';

// Minimal card markup: bierloods22 cards expose the visible title as a.title text and
// the "{brand} {title}" string as the a.title `title=` attribute.
function card(titleAttr: string, titleText: string): string {
  return `<div class="product-block"><h4><a class="title" title="${titleAttr}">${titleText}</a></h4></div>`;
}
function parse(html: string) {
  return bierloods22.parseCards(new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html'));
}

describe('bierloods22 brewery extraction (#117)', () => {
  it('uses the brand prefix for a brewery containing " - " (Kykao)', () => {
    const [c] = parse(card(
      'KYKAO - Handcrafted Kykao - Handcrafted - Sour Berliner Weisse - Raspberry Edition (2025)',
      'Kykao - Handcrafted - Sour Berliner Weisse - Raspberry Edition (2025)',
    ));
    expect(c.brewery).toBe('Kykao - Handcrafted');
    expect(c.name).toBe('Sour Berliner Weisse - Raspberry Edition (2025)');
  });

  it('single-segment brewery still splits on the first dash (Brokreacja)', () => {
    const [c] = parse(card('Brokreacja Browar Brokreacja - The Dancer', 'Browar Brokreacja - The Dancer'));
    expect(c.brewery).toBe('Browar Brokreacja');
    expect(c.name).toBe('The Dancer');
  });

  it('no brand prefix → first-dash fallback', () => {
    const [c] = parse(card('Foo - Bar', 'Foo - Bar'));
    expect(c.brewery).toBe('Foo');
    expect(c.name).toBe('Bar');
  });

  it('no dash → empty brewery, whole title as name', () => {
    const [c] = parse(card('Solo', 'Solo'));
    expect(c.brewery).toBe('');
    expect(c.name).toBe('Solo');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd extension && npx vitest run src/sites/bierloods22.test.ts`
Expected: FAIL — Kykao brewery comes back as `Kykao` (current first-dash split).

- [ ] **Step 3: Implement brand-prefix extraction**

Replace `splitTitle` and the `parseCards` body in `extension/src/sites/bierloods22.ts`:

```typescript
// bierloods22 cards expose the visible title (a.title text) as "{brewery} - {beer}" and
// the brand-prefixed form "{brand} {title}" as the a.title `title=` attribute. The brand
// tells us how many leading " - " segments are the brewery (handles breweries that
// themselves contain " - ", e.g. "Kykao - Handcrafted"). Empty/mismatched brand → split
// on the first " - " (previous behaviour).
function splitTitle(titleText: string, titleAttr: string): { brewery: string; name: string } | null {
  const title = titleText.trim();
  if (!title) return null;

  const segs = title.split(' - ');
  let brewerySegs = 1;
  const attr = titleAttr.trim();
  if (attr.length > title.length && attr.toLowerCase().endsWith(title.toLowerCase())) {
    const brand = attr.slice(0, attr.length - title.length).trim();
    if (brand) brewerySegs = brand.split(' - ').length;
  }

  if (segs.length <= brewerySegs) {
    // No separable name (no dash, or brand spans the whole title) → whole title as name.
    return { brewery: '', name: title };
  }
  const name = segs.slice(brewerySegs).join(' - ').trim();
  if (!name) return { brewery: '', name: title };
  return { brewery: segs.slice(0, brewerySegs).join(' - ').trim(), name };
}

export const bierloods22: SiteAdapter = {
  id: 'bierloods22',
  hostMatch: (url) => url.hostname === 'bierloods22.nl' || url.hostname.endsWith('.bierloods22.nl'),
  reRenderContainerSelector: '#collection-container',

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const a = el.querySelector('a.title');
      const parsed = splitTitle(text(a), a?.getAttribute('title') ?? '');
      if (!parsed) continue;
      cards.push({ el, brewery: parsed.brewery, name: parsed.name });
    }
    return cards;
  },
};
```

- [ ] **Step 4: Run the adapter + conformance tests**

Run: `cd extension && npx vitest run src/sites/bierloods22.test.ts src/sites/conformance.test.ts`
Expected: PASS (bespoke + conformance over the registry/fixture).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sites/bierloods22.ts extension/src/sites/bierloods22.test.ts
git commit -m "fix(extension): bierloods22 brewery from a.title brand-prefix (handles 'Kykao - Handcrafted') (#117)"
```

---

## Task 5: End-to-end integration test against the 7 real Untappd pages

Pins `lookupBeer` against the real captured search pages: 6 match (post-adapter-fix inputs), Staropolski stays `not_found` (deferred #120).

**Files:**
- Create: `src/domain/untappd-lookup.fixtures.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lookupBeer } from './untappd-lookup';

const dir = resolve(__dirname, '../../tests/fixtures/untappd-search');
const html = (slug: string) => readFileSync(resolve(dir, `${slug}.html`), 'utf8');

// brewery/name are the values produced AFTER the #117 adapter + query fixes.
const cases: Array<{ slug: string; brewery: string; name: string; bid: number | null }> = [
  { slug: 'kykao',        brewery: 'Kykao - Handcrafted', name: 'Sour Berliner Weisse - Raspberry Edition (2025)', bid: 6479503 },
  { slug: 'schneider',    brewery: 'Schneider',           name: 'TAP04 FESTWEISSE',          bid: 11827 },
  { slug: 'fast-talking', brewery: 'Root + Branch',       name: 'Fast Talking / North Park', bid: 6683161 },
  { slug: 'messorem',     brewery: 'Messorem',            name: 'Globe Coagulant / Finback', bid: 6538432 },
  { slug: 'primator',     brewery: 'Primator',            name: 'PRIMÁTOR FREE MOTHER IN LAW', bid: 5817947 },
  { slug: 'omnipollo',    brewery: 'Omnipollo collab/ Trillium Brewing Company', name: 'Kanelbullar', bid: 6423273 },
  { slug: 'staropolski',  brewery: 'Staropolski',         name: 'KULTOWE PILS',              bid: null }, // deferred #120
];

describe('#117 lookupBeer against real Untappd search pages', () => {
  for (const { slug, brewery, name, bid } of cases) {
    test(`${slug} → ${bid === null ? 'not_found (deferred #120)' : `bid ${bid}`}`, async () => {
      const out = await lookupBeer({ brewery, name, fetch: async () => html(slug) });
      if (bid === null) {
        expect(out.kind).toBe('not_found');
      } else {
        expect(out.kind).toBe('matched');
        if (out.kind !== 'matched') return;
        expect(out.result.bid).toBe(bid);
      }
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `npx jest src/domain/untappd-lookup.fixtures.test.ts`
Expected: PASS — 6 matched with the listed bids, staropolski `not_found`.

> If a bid assertion is off, re-derive it: `parseSearchPage(html(slug))` and inspect — do not loosen the assertion without confirming the page actually lists a different bid.

- [ ] **Step 3: Commit**

```bash
git add src/domain/untappd-lookup.fixtures.test.ts
git commit -m "test(#117): integration coverage of lookupBeer over the 7 real Untappd search pages"
```

---

## Task 6: Spec sync + full suite

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Update `spec.md`**

- §4 (`/match`, `/enrich/*`): note that name matching is now **order-insensitive + collab/bilingual-split + brewery-deduped** (`nameKeys` set intersection as an exact-equivalent condition), with a multi-token guard; collab `stripBreweryNoise` for search queries.
- §6 (bierloods22 adapter bullet): brewery from `a.title` brand-prefix (`title=` attr) instead of first `" - "` split; backward-compatible fallback.
- Appendix gotchas: add `collab`/`collaboration` to the `BREWERY_NOISE` list; record `nameKeys` (multi-token guard; single-token whole names fall through to fuzzy); note Staropolski trailing-brewery-token gate is **out of scope, tracked in #120**.

- [ ] **Step 2: Run the full suites**

Run: `npx jest && cd extension && npx vitest run && cd ..`
Expected: PASS, no regressions.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck && cd extension && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): sync §4/§6/appendix for #117 nameKeys matching + bierloods22 brand-prefix"
```

---

## Done criteria
- All Jest + Vitest suites green; typecheck clean.
- `lookupBeer` fixtures test: 6 matched, staropolski `not_found`.
- No production change to DB schema. Existing matcher/enrich/adapter tests unbroken.

## Out of scope / follow-ups
- **Staropolski** trailing-token brewery gate → issue **#120**.
- **Extension release:** the bierloods22 fix is user-facing; cutting a new extension release (`npm run release`) is a separate ops step per `docs/extension-release.md`, not part of this plan.
