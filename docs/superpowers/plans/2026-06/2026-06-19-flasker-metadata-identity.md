# Flasker Metadata-Led Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Flasker extension adapter prefer fixture-pinned brewery tags and product slugs over first-token title parsing, and remove only the approved leading merchandising labels.

**Architecture:** Keep all behavior inside `extension/src/sites/flasker.ts`. View extractors collect title, tags, and product URL into `RawEntry`; a shared pure resolver selects one explicit `BreweryRule`, derives the name conservatively, and falls back to the existing parser on missing or conflicting evidence. `DE ZWARTE REGEL` and product-name spelling/localization corrections remain out of scope.

**Tech Stack:** TypeScript, Vitest, jsdom, Chrome MV3 extension, WooCommerce HTML fixtures

---

## File map

- Modify `extension/src/sites/flasker.ts` — rule table, metadata resolver, merchandising cleanup, and three-view evidence extraction.
- Modify `extension/src/sites/flasker.test.ts` — pure resolver tests and exact fixture assertions.
- Modify `extension/CHANGELOG.md` — user-facing Unreleased fix note.
- Modify `spec.md` — replace the first-word-only Flasker description with metadata precedence and fallback behavior.
- Do not modify shared matcher, API, storage, `SiteAdapter`, or fixtures. The initial implementation includes only rules already pinned in existing fixtures: Vibrant Pour, Mad Brew, Flasker, and Hoppy Hog.

### Task 1: Add explicit merchandising-prefix cleanup

**Files:**
- Modify: `extension/src/sites/flasker.test.ts:9-66`
- Modify: `extension/src/sites/flasker.ts:25-40`

- [ ] **Step 1: Write failing cleanup tests**

Add `stripMerchandisingPrefix` to the Flasker test import and add this block after the current `parseTitle` tests:

```ts
import {
  parseTitle,
  stripMerchandisingPrefix,
  isNonBeerTitle,
  isNonBeerCategory,
  flasker,
} from './flasker';

describe('stripMerchandisingPrefix', () => {
  it.each([
    ['ПРЕДРЕЛІЗ Galaxy Juice', 'Galaxy Juice'],
    ['предреліз: Galaxy Juice', 'Galaxy Juice'],
    ['ПРЕДРЕДІЗ — Candlelit', 'Candlelit'],
    ['ПРОБНИК: MGM Tapped Ed.', 'MGM Tapped Ed.'],
  ])('strips an approved leading label from %s', (input, expected) => {
    expect(stripMerchandisingPrefix(input)).toBe(expected);
  });

  it('does not strip unknown or mid-name labels', () => {
    expect(stripMerchandisingPrefix('РЕЛІЗ Galaxy Juice')).toBe('РЕЛІЗ Galaxy Juice');
    expect(stripMerchandisingPrefix('Galaxy ПРЕДРЕЛІЗ Juice')).toBe('Galaxy ПРЕДРЕЛІЗ Juice');
    expect(stripMerchandisingPrefix('ПРОБНИК Galaxy Juice')).toBe('ПРОБНИК Galaxy Juice');
  });

  it('retains the original when cleanup would empty the name', () => {
    expect(stripMerchandisingPrefix('ПРЕДРЕЛІЗ')).toBe('ПРЕДРЕЛІЗ');
    expect(stripMerchandisingPrefix('ПРОБНИК:')).toBe('ПРОБНИК:');
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd extension && npm test -- src/sites/flasker.test.ts
```

Expected: FAIL because `stripMerchandisingPrefix` is not exported.

- [ ] **Step 3: Implement the allowlist-only cleanup**

Add below `splitBreweryName`:

```ts
const MERCH_PREFIX_RE = /^(?:(?:ПРЕДРЕЛІЗ|ПРЕДРЕДІЗ)(?=$|[\s:–—-])|ПРОБНИК:)[\s:–—-]*/iu;

export function stripMerchandisingPrefix(name: string): string {
  const stripped = name.replace(MERCH_PREFIX_RE, '').trim();
  return stripped || name;
}
```

This deliberately does not accept bare `ПРОБНИК` because the approved allowlist contains `ПРОБНИК:`.

- [ ] **Step 4: Run the focused test and verify success**

Run:

```bash
cd extension && npm test -- src/sites/flasker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the cleanup primitive**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts
git commit -m "fix(extension): strip Flasker merchandising prefixes"
```

### Task 2: Resolve brewery identity from explicit evidence

**Files:**
- Modify: `extension/src/sites/flasker.test.ts`
- Modify: `extension/src/sites/flasker.ts:25-81`

- [ ] **Step 1: Write failing resolver tests through `parseTitle`**

Keep the existing two-word fallback expectation unchanged, then add evidence tests:

```ts
it('canonicalizes a brewery from a trusted product tag', () => {
  expect(parseTitle('Vibrant Pour Frost & Flame Imperial Porter 10% 0.33', {
    productTags: ['330 ml', 'Vibrant Pour', 'Україна'],
  })).toEqual({
    brewery: 'VibrantPour',
    name: 'Frost & Flame Imperial Porter',
    abv: 10,
  });
});

it('uses a trusted product slug when block cards have no tags', () => {
  expect(parseTitle('Barely Beer 0% ABV 330ml', {
    productUrl: 'https://flasker.com.ua/product/mad-barely-beer-0-abv-pale-ale-330ml/',
  })).toEqual({ brewery: 'Mad Brew', name: 'Barely Beer', abv: 0 });
});

it('retains the complete name when the brewery is absent from the title', () => {
  expect(parseTitle('Barely Beer 0% ABV 330ml', {
    productTags: ['mad brew'],
  })).toEqual({ brewery: 'Mad Brew', name: 'Barely Beer', abv: 0 });
});

it('prefers one trusted tag over a conflicting URL rule', () => {
  expect(parseTitle('Barely Beer 0% ABV 330ml', {
    productTags: ['mad brew'],
    productUrl: 'https://flasker.com.ua/product/vibrant-pour-barely-beer/',
  })).toEqual({ brewery: 'Mad Brew', name: 'Barely Beer', abv: 0 });
});

it('falls back to title parsing when trusted tags conflict', () => {
  expect(parseTitle('Mystery Beer 5% 330ml', {
    productTags: ['mad brew', 'Vibrant Pour'],
    productUrl: 'https://flasker.com.ua/product/mad-mystery-beer/',
  })).toEqual({ brewery: 'Mystery', name: 'Beer', abv: 5 });
});

it('falls back for unknown tags, foreign URLs, and malformed URLs', () => {
  for (const evidence of [
    { productTags: ['Imperial Stout'] },
    { productUrl: 'https://example.com/product/mad-mystery-beer/' },
    { productUrl: 'not a URL' },
  ]) {
    expect(parseTitle('Mystery Beer 5% 330ml', evidence))
      .toEqual({ brewery: 'Mystery', name: 'Beer', abv: 5 });
  }
});

it('removes the longest matching title alias', () => {
  expect(parseTitle('Hoppy Hog — Winter Cherry 8% 330ml', {
    productTags: ['Hoppy Hog'],
  })).toEqual({
    brewery: 'Hoppy Hog Family Brewery',
    name: 'Winter Cherry',
    abv: 8,
  });
});

it('cleans a merchandising label after metadata resolution', () => {
  expect(parseTitle('ПРЕДРЕЛІЗ Galaxy Juice 6% 330ml', {
    productTags: ['mad brew'],
  })).toEqual({ brewery: 'Mad Brew', name: 'Galaxy Juice', abv: 6 });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd extension && npm test -- src/sites/flasker.test.ts
```

Expected: FAIL because `parseTitle` ignores its second argument and returns first-token identities.

- [ ] **Step 3: Add evidence types and fixture-pinned rules**

Add above `splitBreweryName`:

```ts
export interface FlaskerEvidence {
  productTags?: string[];
  productUrl?: string;
}

interface BreweryRule {
  canonical: string;
  tags: string[];
  slugPrefixes: string[];
  titleAliases: string[];
}

const BREWERY_RULES: BreweryRule[] = [
  {
    canonical: 'VibrantPour',
    tags: ['vibrant pour'],
    slugPrefixes: ['vibrant-pour-', 'vibrantpour-'],
    titleAliases: ['Vibrant Pour', 'VibrantPour'],
  },
  {
    canonical: 'Mad Brew',
    tags: ['mad brew'],
    slugPrefixes: ['mad-brew-', 'mad-'],
    titleAliases: ['Mad Brew'],
  },
  {
    canonical: 'Flasker',
    tags: ['flasker'],
    slugPrefixes: ['flasker-'],
    titleAliases: ['Flasker'],
  },
  {
    canonical: 'Hoppy Hog Family Brewery',
    tags: ['hoppy hog'],
    slugPrefixes: ['hoppy-hog-'],
    titleAliases: ['Hoppy Hog'],
  },
];

const normalizeEvidence = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

function flaskerProductSlug(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'flasker.com.ua' && !url.hostname.endsWith('.flasker.com.ua')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const productAt = parts.indexOf('product');
    if (productAt < 0 || !parts[productAt + 1]) return null;
    return decodeURIComponent(parts[productAt + 1]).toLocaleLowerCase();
  } catch {
    return null;
  }
}

function uniqueRule(matches: BreweryRule[]): BreweryRule | null {
  return matches.length === 1 ? matches[0] : null;
}

function resolveBreweryRule(evidence: FlaskerEvidence): BreweryRule | null {
  const tags = new Set((evidence.productTags ?? []).map(normalizeEvidence));
  const tagMatches = BREWERY_RULES.filter((rule) => rule.tags.some((tag) => tags.has(tag)));
  if (tagMatches.length > 0) return uniqueRule(tagMatches);

  const slug = flaskerProductSlug(evidence.productUrl);
  if (!slug) return null;
  return uniqueRule(BREWERY_RULES.filter((rule) =>
    rule.slugPrefixes.some((prefix) => slug.startsWith(prefix)),
  ));
}

function stripTitleAlias(head: string, aliases: string[]): string {
  const ordered = [...aliases].sort((a, b) => b.length - a.length);
  const lowerHead = head.toLocaleLowerCase();
  for (const alias of ordered) {
    const lowerAlias = alias.toLocaleLowerCase();
    if (lowerHead === lowerAlias) return head;
    if (!lowerHead.startsWith(lowerAlias)) continue;
    const rest = head.slice(alias.length);
    if (!/^[\s:–—-]/u.test(rest)) continue;
    const stripped = rest.replace(/^[\s:–—-]+/u, '').trim();
    return stripped || head;
  }
  return head;
}
```

Do not add `DE ZWARTE REGEL`, De Cam, Duchesse, Malle, or Honir rules in this task: current fixtures do not pin trustworthy evidence for them.

- [ ] **Step 4: Integrate the resolver into title parsing**

Change the signature and identity section of `parseTitle`:

```ts
export function parseTitle(
  rawTitle: string,
  evidence: FlaskerEvidence = {},
): { brewery: string; name: string; abv?: number } | null {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const volAt = volumeIndex(title);
  if (volAt < 0) return null;

  const abvMatch = title.match(ABV_RE);
  const abvAt = abvMatch?.index ?? -1;
  const headEnd = abvAt >= 0 ? Math.min(abvAt, volAt) : volAt;
  const head = title.slice(0, headEnd).trim();
  if (!head) return null;

  const abv = abvMatch ? Number(abvMatch[1].replace(',', '.')) : undefined;
  const rule = resolveBreweryRule(evidence);
  const fallback = splitBreweryName(head);
  const brewery = rule?.canonical ?? fallback.brewery;
  const uncleanName = rule ? stripTitleAlias(head, rule.titleAliases) : fallback.name;
  const name = stripMerchandisingPrefix(uncleanName);

  return abv == null || !Number.isFinite(abv) ? { brewery, name } : { brewery, name, abv };
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
cd extension && npm test -- src/sites/flasker.test.ts && npm run typecheck
```

Expected: Flasker tests PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit the resolver**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts
git commit -m "fix(extension): resolve Flasker breweries from trusted evidence"
```

### Task 3: Extract evidence consistently from all Flasker views

**Files:**
- Modify: `extension/src/sites/flasker.test.ts:104-137`
- Modify: `extension/src/sites/flasker.ts:83-135`

- [ ] **Step 1: Replace broad fixture checks with exact identity assertions**

Add this helper near `load`:

```ts
const findCard = (fixture: string, expectedName: string) => {
  const card = flasker.parseCards(load(fixture)).find((item) => item.name === expectedName);
  expect(card, `${fixture}: ${expectedName}`).toBeDefined();
  return card!;
};
```

Keep the existing non-empty loops, then add:

```ts
it('uses visible archive tags for canonical identity', () => {
  expect(findCard('flasker.html', 'Frost & Flame Imperial Porter')).toMatchObject({
    brewery: 'VibrantPour',
    name: 'Frost & Flame Imperial Porter',
    abv: 10,
  });
});

it('uses table data-product_tag when the title omits the brewery', () => {
  expect(findCard('flasker.table.html', 'Barely Beer')).toMatchObject({
    brewery: 'Mad Brew',
    name: 'Barely Beer',
    abv: 0,
  });
});

it('uses the block product URL when tags are unavailable', () => {
  expect(findCard('flasker.block.html', 'Barely Beer')).toMatchObject({
    brewery: 'Mad Brew',
    name: 'Barely Beer',
    abv: 0,
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd extension && npm test -- src/sites/flasker.test.ts
```

Expected: FAIL because `RawEntry` does not extract or forward tags and URLs.

- [ ] **Step 3: Extend `RawEntry` and add extraction helpers**

Replace the compact interface and add helpers:

```ts
interface RawEntry {
  el: HTMLElement;
  title: string;
  categoryHint?: string;
  productTags: string[];
  productUrl?: string;
}

function href(el: Element | null | undefined): string | undefined {
  return el?.getAttribute('href') ?? undefined;
}

function parseTableTags(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.replace(/^\s*\d+:/u, '').trim())
    .filter(Boolean);
}
```

- [ ] **Step 4: Populate evidence in all three extractors**

Replace the extractor bodies with:

```ts
function archiveEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ARCHIVE_CARD)).map((el) => ({
    el,
    title: text(el.querySelector(ARCHIVE_TITLE)),
    productTags: Array.from(el.querySelectorAll('.mb-thumb-tag')).map((tag) => text(tag)),
    productUrl: href(el.querySelector('.woocommerce-LoopProduct-link[href]')),
  }));
}

function blockEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_CARD)).map((el) => ({
    el,
    title: text(el.querySelector(BLOCK_TITLE)),
    productTags: [],
    productUrl: href(el.querySelector('.wc-block-grid__product-title a[href]')),
  }));
}

function tableEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABLE_ROW)).map((el) => ({
    el,
    title: (el.getAttribute('data-title') ?? '').replace(/\s+/g, ' ').trim(),
    categoryHint: el.getAttribute('data-product_cat') ?? undefined,
    productTags: parseTableTags(el.getAttribute('data-product_tag')),
    productUrl: el.getAttribute('data-href') ?? undefined,
  }));
}
```

Pass evidence at the call site:

```ts
const parsed = parseTitle(e.title, {
  productTags: e.productTags,
  productUrl: e.productUrl,
});
```

- [ ] **Step 5: Run Flasker and complete extension tests**

Run:

```bash
cd extension && npm test -- src/sites/flasker.test.ts && npm test
```

Expected: focused Flasker tests PASS; complete extension suite PASS.

- [ ] **Step 6: Commit view integration**

```bash
git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts
git commit -m "fix(extension): read Flasker brewery evidence in every view"
```

### Task 4: Document behavior and verify the complete change

**Files:**
- Modify: `extension/CHANGELOG.md:3`
- Modify: `spec.md:936-937`

- [ ] **Step 1: Add the user-facing changelog entry**

Under `## [Unreleased]`, add:

```md
- Fixed Flasker matching when product titles omit or abbreviate the brewery: trusted shop tags and product links now identify known breweries, and leading preview/sample labels are removed before matching.
```

- [ ] **Step 2: Update the master specification**

Replace the Flasker adapter description in `spec.md` with:

```md
`flasker` (Flasker WooCommerce SSR — `li.product`/`h2.woocommerce-loop-product__title`
(archive), `tr[data-title]` (Barn2 product table), `li.wc-block-grid__product` (block
grid); brewery з explicit allowlist Flasker product-tag/product-slug metadata
(tag > slug), fallback — перше слово title; відомий display-prefix brewery
видаляється з name, leading `ПРЕДРЕЛІЗ`/`ПРЕДРЕДІЗ`/`ПРОБНИК:` labels теж;
volume-gate: пиво завжди містить об'єм в ml/л/l, non-beer без об'єму
відкидається; ABV із `%` у title), домен `flasker.com.ua`).
```

- [ ] **Step 3: Run formatting checks, typecheck, and all relevant tests**

Run:

```bash
git diff --check
cd extension && npm run typecheck && npm test && npm run build
cd .. && npm test -- --run
```

Expected:

- `git diff --check`: no output.
- Extension typecheck: exit 0.
- Extension tests: all PASS.
- Extension build and zip packaging: exit 0.
- Root suite: all PASS (baseline was 78 files, 743 tests).

- [ ] **Step 4: Perform browser verification without changing fixtures**

Load the unpacked extension build and visit:

```text
https://flasker.com.ua/
https://flasker.com.ua/1-2/
https://flasker.com.ua/таблиця-товару/
```

Verify one mapped product on each view receives the same badge identity, pagination/re-render retains badges, and the extension badge does not overlap Flasker's yellow native rating. Do not classify old `enrich_failures` as regressions; only newly-created rows after the release are relevant.

- [ ] **Step 5: Commit documentation and verification metadata**

```bash
git add extension/CHANGELOG.md spec.md
git commit -m "docs(extension): document Flasker identity evidence"
```

### Task 5: Review scope and prepare handoff

**Files:**
- Review only: all files changed by Tasks 1-4

- [ ] **Step 1: Inspect the final diff**

Run:

```bash
git status --short
git diff origin/main...HEAD -- extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts extension/CHANGELOG.md spec.md
```

Expected: only the four implementation files above plus the already-committed design/plan documents are present. Confirm there are no matcher, API, storage, shared adapter-interface, fixture, or `DE ZWARTE REGEL` special-case changes.

- [ ] **Step 2: Confirm commit history is reviewable**

Run:

```bash
git log --oneline --decorate -8
```

Expected: separate commits for prefix cleanup, resolver, view integration, and documentation, following the existing conventional-commit style.

- [ ] **Step 3: Ask whether to create a pull request**

Per repository policy, present the verified branch status and ask the user whether to create a PR. If confirmed, use the repository PR workflow and wait for checks/review before reporting final status.
