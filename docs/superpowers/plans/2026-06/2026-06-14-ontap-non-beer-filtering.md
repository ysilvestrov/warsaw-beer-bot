# Ontap Non-Beer Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent obvious wine/prosecco/spritz/cocktail ontap rows from entering snapshots, catalog rows, matcher, or enrichment while keeping cider, kvass, and mead eligible.

**Architecture:** Add a small pure ontap gate that looks only at `style` and `brewery_ref`, then apply it in `refreshOntap` immediately after `parsePubPage`. The parser still reports raw taps, but persistence/matching/enrichment only see retained taps.

**Tech Stack:** Node.js 20+, TypeScript, Jest, better-sqlite3, existing ontap parser/refresh job.

---

## File Structure

- Create `src/sources/ontap/non-beer.ts`: pure `isOntapNonBeerTap` helper. It accepts only `style` and `brewery_ref` so callers cannot accidentally use `beer_ref`.
- Create `src/sources/ontap/non-beer.test.ts`: unit tests for wine/prosecco/spritz/cocktail positives and cider/kvass/mead false-positive guards.
- Modify `src/jobs/refresh-ontap.ts`: filter parsed taps before `insertTaps`, matcher, `upsertBeer`, and inline enrichment.
- Modify `src/jobs/refresh-ontap.test.ts`: integration test proving mixed pub pages persist only eligible taps.
- No schema migration. No extension changes. No DB cleanup.

---

### Task 1: Pure Ontap Non-Beer Gate

**Files:**
- Create: `src/sources/ontap/non-beer.ts`
- Create: `src/sources/ontap/non-beer.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `src/sources/ontap/non-beer.test.ts`:

```ts
import { isOntapNonBeerTap } from './non-beer';

describe('isOntapNonBeerTap', () => {
  test.each([
    ['style prosecco', { style: 'PROSECCO', brewery_ref: 'Cantine Vitevis' }],
    ['style vino', { style: 'Vino Bianco', brewery_ref: 'Conegliano Brewery' }],
    ['style frizzante', { style: 'Frizzante [wino musujące]', brewery_ref: 'Maccari' }],
    ['style spritz', { style: 'Aperol Spritz', brewery_ref: 'Maccari / Frizzanti' }],
    ['style cocktail', { style: 'Koktajl na bazie wina musującego', brewery_ref: 'Maccari / Frizzanti' }],
    ['exact cocktail style', { style: 'Drink, czarny bez, mięta i limonka', brewery_ref: 'Monte Santi Brewery' }],
    ['wine brewery', { style: null, brewery_ref: 'Dolium Vini' }],
    ['san martino brewery', { style: null, brewery_ref: 'SAN MARTINO' }],
    ['hugo sentinel brewery', { style: null, brewery_ref: 'HUGO' }],
    ['mojito sentinel brewery', { style: null, brewery_ref: 'MOJITO' }],
  ])('flags %s', (_label, tap) => {
    expect(isOntapNonBeerTap(tap)).toBe(true);
  });

  test.each([
    ['cider Polish', { style: 'Cydr Wytrawny', brewery_ref: 'Chyliczki' }],
    ['cider English', { style: 'Sweet cider', brewery_ref: 'PRZETWÓRNIA CHMIELU' }],
    ['kvass Polish', { style: 'Kwas chlebowy', brewery_ref: 'Vilniaus Alus Brewery' }],
    ['kvass beer name but safe style', { style: 'Catharina Sour', brewery_ref: 'PINTA Brewery' }],
    ['mead', { style: 'Mead - Melomel', brewery_ref: 'Berryland' }],
    ['normal beer', { style: 'West Coast IPA', brewery_ref: 'PINTA Brewery' }],
    ['drinkability prose does not match generic drink', {
      style: 'Dark, smooth, and deceptively light on the palate, endlessly drinkable Schwarzbier',
      brewery_ref: 'FUERST WIACEK Berlin Brewery',
    }],
  ])('keeps %s eligible', (_label, tap) => {
    expect(isOntapNonBeerTap(tap)).toBe(false);
  });

  test('does not inspect beer_ref/name', () => {
    const tapWithName = {
      style: null,
      brewery_ref: 'Beer Brewery',
      beer_ref: 'Vino Merlot Spritz Prosecco',
    };
    expect(isOntapNonBeerTap(tapWithName)).toBe(false);
  });
});
```

- [ ] **Step 2: Run unit test to verify it fails**

Run:

```bash
npm test -- src/sources/ontap/non-beer.test.ts
```

Expected: FAIL because `src/sources/ontap/non-beer.ts` does not exist.

- [ ] **Step 3: Implement the pure helper**

Create `src/sources/ontap/non-beer.ts`:

```ts
export interface OntapNonBeerInput {
  style: string | null;
  brewery_ref: string | null;
}

const STYLE_TOKENS = [
  'vino',
  'wino',
  'wina',
  'prosecco',
  'frizzante',
  'spritz',
  'aperitivo',
  'koktajl',
  'musujące',
  'wytrawne',
  'półwytrawne',
  'słodkie',
];

const EXACT_STYLE_PHRASES = new Set([
  'aperitivo',
  'aperitivo spritz',
  'aperol spritz',
  'białe wino musujące',
  'białe wino musujące wytrawne',
  'drink, czarny bez, mięta i limonka',
  'frizzante [wino musujące]',
  'mojito drink',
  'orange bitter',
  'primitivo',
  'własny koktajl z kija',
]);

const BREWERY_TOKENS = [
  'wino',
  'wine',
  'winiarska',
  'maccari',
  'frizzanti',
  'cantine',
  'san martino',
  'conegliano',
  'puglia',
  'vini',
  'dolium vini',
  'stacja winiarska',
];

const EXACT_BREWERY_SENTINELS = new Set([
  'aperitivo spritz',
  'hugo',
  'mojito',
]);

function norm(raw: string | null): string {
  return raw?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

export function isOntapNonBeerTap(tap: OntapNonBeerInput): boolean {
  const style = norm(tap.style);
  if (style && (EXACT_STYLE_PHRASES.has(style) || STYLE_TOKENS.some((token) => style.includes(token)))) {
    return true;
  }

  const brewery = norm(tap.brewery_ref);
  if (brewery && (EXACT_BREWERY_SENTINELS.has(brewery) || BREWERY_TOKENS.some((token) => brewery.includes(token)))) {
    return true;
  }

  return false;
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run:

```bash
npm test -- src/sources/ontap/non-beer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/sources/ontap/non-beer.ts src/sources/ontap/non-beer.test.ts
git commit -m "feat(ontap): add non-beer tap classifier"
```

---

### Task 2: Filter Ontap Refresh Before Persistence

**Files:**
- Modify: `src/jobs/refresh-ontap.ts`
- Modify: `src/jobs/refresh-ontap.test.ts`

- [ ] **Step 1: Write failing integration test**

Replace `src/jobs/refresh-ontap.test.ts` with this full file:

```ts
import pino from 'pino';
import { filterIndexBySlugs, refreshOntap } from './refresh-ontap';
import type { IndexPub } from '../sources/ontap/index';
import type { Http } from '../sources/http';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { latestSnapshot, tapsForSnapshot } from '../storage/snapshots';
import { listLookupCandidates } from '../storage/beers';

const silentLog = pino({ level: 'silent' });

const idx: IndexPub[] = [
  { slug: 'bracka', name: 'Bracka 4', taps: 10 },
  { slug: 'piwpaw', name: 'PiwPaw', taps: 20 },
  { slug: 'kufle', name: 'Kufle i kapsle', taps: 30 },
];

describe('filterIndexBySlugs', () => {
  test('returns the full list unchanged when no slugs given', () => {
    expect(filterIndexBySlugs(idx, undefined)).toEqual(idx);
  });

  test('keeps only entries whose slug is in the set', () => {
    const out = filterIndexBySlugs(idx, new Set(['piwpaw', 'kufle']));
    expect(out.map((p) => p.slug)).toEqual(['piwpaw', 'kufle']);
  });

  test('empty set yields empty list', () => {
    expect(filterIndexBySlugs(idx, new Set())).toEqual([]);
  });
});

describe('refreshOntap non-beer filtering', () => {
  test('drops style/brewery non-beer taps before snapshots, catalog, and enrichment', async () => {
    const db = openDb(':memory:');
    migrate(db);

    const indexHtml = `
      <div onclick="location.assign('https://mixed.ontap.pl/')">
        <div class="panel-body">Mixed Pub 6 taps</div>
      </div>
    `;
    const pubHtml = `
      <html>
        <head><meta property="og:title" content="Mixed Pub / ontap.pl"></head>
        <body>
          ${panel(1, 'PINTA Brewery', 'PINTA Atak Chmielu 6%', 'West Coast IPA')}
          ${panel(2, 'Maccari', 'Glera Frizzante IGT Veneto 10,5%', 'PROSECCO')}
          ${panel(3, 'SAN MARTINO', 'SAN MARTINO Chardonnay 11,5%', 'Białe Wytrawne')}
          ${panel(4, 'HUGO', 'HUGO 7%', '')}
          ${panel(5, 'Chyliczki', 'Chyliczki Antonówka 2025 5,5%', 'Cydr Wytrawny')}
          ${panel(6, 'Vilniaus Alus Brewery', 'Vilniaus Alus Brewery Kwas Chlebowy Retro', 'Kwas chlebowy')}
        </body>
      </html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://mixed.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db,
      log: silentLog,
      http,
      geocoder: async () => null,
      lookupEnabled: false,
      now: () => new Date('2026-06-14T12:00:00Z'),
    });

    const pub = db.prepare('SELECT id FROM pubs WHERE slug = ?').get('mixed') as { id: number };
    const snap = latestSnapshot(db, pub.id);
    expect(snap).not.toBeNull();

    const taps = tapsForSnapshot(db, snap!.id);
    expect(taps.map((t) => t.tap_number)).toEqual([1, 5, 6]);
    expect(taps.map((t) => t.style)).toEqual(['West Coast IPA', 'Cydr Wytrawny', 'Kwas chlebowy']);

    const beers = db.prepare('SELECT brewery, name, style FROM beers ORDER BY id').all() as Array<{
      brewery: string;
      name: string;
      style: string | null;
    }>;
    expect(beers).toEqual([
      expect.objectContaining({ brewery: 'PINTA Brewery', style: 'West Coast IPA' }),
      expect.objectContaining({ brewery: 'Chyliczki', style: 'Cydr Wytrawny' }),
      expect.objectContaining({ brewery: 'Vilniaus Alus Brewery', style: 'Kwas chlebowy' }),
    ]);
    expect(beers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ brewery: 'Maccari' }),
      expect.objectContaining({ brewery: 'SAN MARTINO' }),
      expect.objectContaining({ brewery: 'HUGO' }),
    ]));

    const links = db.prepare('SELECT ontap_ref FROM match_links ORDER BY id').all() as Array<{ ontap_ref: string }>;
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.ontap_ref).join(' ')).not.toMatch(/Frizzante|Chardonnay|HUGO/i);

    const candidates = listLookupCandidates(db, 20, new Date('2026-06-14T12:00:00Z'));
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.brewery)).toEqual([
      'PINTA Brewery',
      'Chyliczki',
      'Vilniaus Alus Brewery',
    ]);
  });
});

function panel(
  tap: number,
  brewery: string,
  h4: string,
  style: string,
): string {
  return `
    <div class="panel panel-default" onclick="location.href='https://mixed.ontap.pl/beer?mode=view'">
      <h5><span class="label label-primary">${tap}</span></h5>
      <div class="brewery">${brewery}</div>
      <h4>${h4}</h4>
      <span class="cml_shadow"><b>${style}</b></span>
    </div>
  `;
}
```

- [ ] **Step 2: Run integration test to verify it fails**

Run:

```bash
npm test -- src/jobs/refresh-ontap.test.ts
```

Expected: FAIL because all six parsed taps are still inserted and cataloged.

- [ ] **Step 3: Apply filter in refreshOntap**

In `src/jobs/refresh-ontap.ts`, add the import near the other ontap imports:

```ts
import { isOntapNonBeerTap } from '../sources/ontap/non-beer';
```

Then replace:

```ts
      const { pub, taps } = parsePubPage(html);
```

with:

```ts
      const { pub, taps: parsedTaps } = parsePubPage(html);
      const taps = parsedTaps.filter((t) => !isOntapNonBeerTap(t));
      const droppedNonBeer = parsedTaps.length - taps.length;
      if (droppedNonBeer > 0) {
        log.info({ slug: ip.slug, droppedNonBeer }, 'ontap non-beer taps filtered');
      }
```

No other code should change. The existing `insertTaps(db, snapshotId, taps)` and `for (const t of taps)` then naturally operate only on retained taps.

- [ ] **Step 4: Run integration test to verify it passes**

Run:

```bash
npm test -- src/jobs/refresh-ontap.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run pure gate test again**

Run:

```bash
npm test -- src/sources/ontap/non-beer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "fix(ontap): filter non-beer taps before ingest"
```

---

### Task 3: Verification and PR Readiness

**Files:**
- Verify: `docs/superpowers/specs/2026-06-14-ontap-non-beer-filtering-design.md`
- Verify: `spec.md`
- Verify: `src/sources/ontap/non-beer.ts`
- Verify: `src/jobs/refresh-ontap.ts`

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- src/sources/ontap/non-beer.test.ts src/jobs/refresh-ontap.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run adjacent ontap parser tests**

Run:

```bash
npm test -- src/sources/ontap/pub.test.ts src/sources/ontap/index.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Run full test suite if focused checks pass**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat main...HEAD
git diff --check
git status --short --branch
```

Expected:

- `git diff --check` prints nothing.
- Working tree is clean after commits.
- Diff contains only issue #154 docs/spec plus ontap gate implementation/tests.

- [ ] **Step 6: Prepare PR summary**

Use this PR summary:

```markdown
## Summary
- add a server-side ontap non-beer gate based only on tap style and brewery_ref
- filter wine/prosecco/frizzante/spritz/cocktail taps before snapshots, matching, orphan creation, and enrichment
- preserve cider, kvass/Kwas chlebowy, and mead/melomel as eligible matchable categories

## Tests
- npm test -- src/sources/ontap/non-beer.test.ts src/jobs/refresh-ontap.test.ts
- npm test -- src/sources/ontap/pub.test.ts src/sources/ontap/index.test.ts
- npm run typecheck
- npm test
```

- [ ] **Step 7: Ask before opening PR**

Ask the user whether to create the PR. If confirmed, push `issue-154-ontap-nonbeer` and open a PR for issue #154.
