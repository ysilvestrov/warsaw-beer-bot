# Untappd search capability (PR-D1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land all infrastructure needed to query Untappd's `/search?q=...&type=beer` endpoint for a given brewery+name, run a 2-stage filter (brewery hard-gate + name fuzzy ≥ 0.85), and record the outcome with an exponential-backoff retry schedule. No behavior change — this PR only adds capability; PR-D2 wires it into refresh-ontap and a cron.

**Architecture:** New HTML scraper at `src/sources/untappd/search.ts` (cheerio, fixture-tested — Untappd HTML captured via `curl` before parser is written). Pure orchestrator at `src/domain/untappd-lookup.ts` returning a `LookupOutcome` tagged union (`matched` | `not_found` | `transient`). Pure backoff at `src/domain/lookup-backoff.ts`. Storage helpers extend `src/storage/beers.ts` with `getBeer`, three recorders, and `listLookupCandidates` (on-tap + backoff-eligible). Migration v5 adds two `beers` columns (`untappd_lookup_at`, `untappd_lookup_count`) consumed only while `untappd_id IS NULL`.

**Tech Stack:** TypeScript, Jest, better-sqlite3 (`:memory:` for tests), cheerio (already a dep via `src/sources/untappd/scraper.ts`), `fast-fuzzy` (already a dep via `src/domain/matcher.ts`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-untappd-lookup.md` (commit `da47015`) — PR-D1 section.

**Branch:** `feat/untappd-search` off `origin/main`.

---

## File Structure

- **Modify** `src/storage/schema.ts` — append migration v5.
- **Modify** `src/storage/schema.test.ts` — assert new columns exist.
- **Create** `tests/fixtures/untappd/search-magic-road.html` — curl-captured HTML snapshot of a live Untappd search response.
- **Create** `src/sources/untappd/search.ts` — `buildSearchUrl`, `parseSearchPage`, `SearchResult` type.
- **Create** `src/sources/untappd/search.test.ts` — fixture-based parser tests.
- **Create** `src/domain/lookup-backoff.ts` — `nextDelayHours`, `isEligible`, exported `BACKOFF_HOURS`.
- **Create** `src/domain/lookup-backoff.test.ts` — table-driven tests.
- **Create** `src/domain/untappd-lookup.ts` — `lookupBeer`, `LookupOutcome` tagged union.
- **Create** `src/domain/untappd-lookup.test.ts` — 4 cases (matched, not-found via brewery, not-found via name, transient).
- **Modify** `src/storage/beers.ts` — extend `BeerRow` with new fields; add `getBeer`, `recordLookupSuccess`, `recordLookupNotFound`, `recordLookupTransient`, `listLookupCandidates`.
- **Modify** `src/storage/beers.test.ts` — add tests for each new helper.

No production handlers are touched. `src/index.ts` is unchanged. No locale changes. No cron registration (that's PR-D2).

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/ysi/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/untappd-search /home/ysi/warsaw-beer-bot-untappd-search origin/main
cd /home/ysi/warsaw-beer-bot-untappd-search
```

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exit 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: every suite passes (baseline we will not regress).

- [ ] **Step 4: Baseline typecheck**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 2: Migration v5 — `beers.untappd_lookup_at` + `untappd_lookup_count`

**Files:**
- Modify: `src/storage/schema.ts` — append a v5 entry to `MIGRATIONS`.
- Modify: `src/storage/schema.test.ts` — add an assertion that both columns exist.

- [ ] **Step 1: Write the failing test**

Add to the end of `src/storage/schema.test.ts` (inside the existing outer `describe`):

```typescript
  test('migration v5 adds beers.untappd_lookup_at + untappd_lookup_count columns', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare('PRAGMA table_info(beers)')
      .all() as { name: string; type: string; notnull: number; dflt_value: unknown }[];

    const lookupAt = cols.find((c) => c.name === 'untappd_lookup_at');
    expect(lookupAt).toBeDefined();
    expect(lookupAt?.type).toBe('TEXT');
    expect(lookupAt?.notnull).toBe(0);

    const lookupCount = cols.find((c) => c.name === 'untappd_lookup_count');
    expect(lookupCount).toBeDefined();
    expect(lookupCount?.type).toBe('INTEGER');
    expect(lookupCount?.notnull).toBe(1);
    expect(String(lookupCount?.dflt_value)).toBe('0');
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --testPathPatterns=schema --silent`
Expected: FAIL — `Received: undefined`, the v5 columns don't exist yet.

- [ ] **Step 3: Append migration v5**

In `src/storage/schema.ts`, find the closing `];` of the `MIGRATIONS` array. Just before it (after the version 4 entry's closing brace + comma), insert:

```typescript
  {
    version: 5,
    sql: `
      ALTER TABLE beers ADD COLUMN untappd_lookup_at TEXT;
      ALTER TABLE beers ADD COLUMN untappd_lookup_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
```

- [ ] **Step 4: Run the test — confirm green**

Run: `npm test -- --testPathPatterns=schema --silent`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test -- --silent`
Expected: every test passes (no production code consumes the columns yet).

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): migration v5 — beers.untappd_lookup_at + untappd_lookup_count

Nullable TEXT for last-lookup timestamp; NOT NULL INTEGER DEFAULT 0
for confirmed-not-found count. Both columns are meaningful only while
beers.untappd_id IS NULL; PR-D2/D3 will populate via the new search
orchestrator. No production code reads or writes them in this PR.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Curl-first — capture live Untappd search HTML

**Files:**
- Create: `tests/fixtures/untappd/search-magic-road.html` — saved curl response.

This is a one-time manual capture. The fixture is then committed and tests in Task 4 run against it. If Untappd's HTML schema drifts, the parser will start failing on this exact snapshot — that's the canary.

- [ ] **Step 1: Ensure fixtures dir exists**

Run: `ls tests/fixtures/untappd/`
Expected: lists `user-beers.html` (and `export.*`). The directory already exists; we will add one more file.

- [ ] **Step 2: Curl Untappd search and save fixture**

The query targets the exact real-world beer from the spec's background bug (Magic Road / Fifty/Fifty / Clementine & Passionfruit). Use a normal browser user-agent — Untappd serves a different page to non-browser UAs.

```bash
curl -sS \
  -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' \
  'https://untappd.com/search?q=Magic+Road+Fifty%2FFifty+Clementine&type=beer' \
  -o tests/fixtures/untappd/search-magic-road.html
```

- [ ] **Step 3: Sanity-check the fixture**

Run: `wc -c tests/fixtures/untappd/search-magic-road.html`
Expected: a non-trivial size — at least several KB. If output is tiny (< 2 KB), Untappd likely returned a captcha/login wall — try again from a different network or with a different UA string.

Also:

```bash
grep -c 'data-bid' tests/fixtures/untappd/search-magic-road.html
```

Expected: > 0 (at least one beer-card with a `data-bid` attribute is present).

- [ ] **Step 4: Inspect HTML structure to confirm selectors**

Open the fixture and locate one beer-result block. Untappd's search result page typically uses `.beer-item` containers (same convention as `/user/<X>/beers`), with each card containing `data-bid` on the wrapper, a `.beer-details` block with `.name a`, `.brewery a`, `.style`, and rating `.caps[data-rating]` like the existing scraper.

If the structure differs from the existing user-beers pattern — note any selector differences before writing the parser in Task 4. The parser in Task 4 should adapt to whatever the fixture shows.

- [ ] **Step 5: Commit the fixture**

```bash
git add tests/fixtures/untappd/search-magic-road.html
git commit -m "$(cat <<'EOF'
test(fixtures): curl-captured Untappd /search HTML for Magic Road query

Captured 2026-05-26 from https://untappd.com/search with the
Magic Road Fifty/Fifty Clementine query that motivated PR-D. Saved as
tests/fixtures/untappd/search-magic-road.html; consumed by the
parseSearchPage tests in the next commit. Regenerate locally (curl
+ commit) if Untappd's HTML schema drifts and tests start failing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `parseSearchPage` parser (fixture-driven)

**Files:**
- Create: `src/sources/untappd/search.ts`
- Create: `src/sources/untappd/search.test.ts`

TDD: write tests first using the fixture, then the parser. Mirrors the structure of `src/sources/untappd/scraper.test.ts` for the user-beers page.

- [ ] **Step 1: Write the failing test file**

Create `src/sources/untappd/search.test.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { buildSearchUrl, parseSearchPage } from './search';

const fixturePath = path.join(__dirname, '../../../tests/fixtures/untappd/search-magic-road.html');
const html = fs.readFileSync(fixturePath, 'utf8');

describe('buildSearchUrl', () => {
  test('encodes query and includes type=beer', () => {
    const url = buildSearchUrl('Magic Road Fifty/Fifty Clementine');
    expect(url.startsWith('https://untappd.com/search?')).toBe(true);
    expect(url).toContain('type=beer');
    expect(url).toContain('Magic');
    expect(url).toContain('Road');
    expect(url).toContain('%2F'); // the literal "/" must be url-encoded
  });

  test('handles empty query gracefully (still returns a valid URL)', () => {
    const url = buildSearchUrl('');
    expect(url).toMatch(/^https:\/\/untappd\.com\/search\?/);
  });
});

describe('parseSearchPage', () => {
  test('parses at least one beer-item from the captured fixture', () => {
    const $ = cheerio.load(html);
    const expectedCards = $('.beer-item[data-bid]').length;
    const items = parseSearchPage(html);
    // Cap is 5; fixture may have more cards but we keep only the top 5.
    expect(items.length).toBe(Math.min(expectedCards, 5));
    expect(items.length).toBeGreaterThan(0);
  });

  test('first item has bid, beer_name, brewery_name', () => {
    const items = parseSearchPage(html);
    const first = items[0];
    expect(typeof first.bid).toBe('number');
    expect(Number.isFinite(first.bid)).toBe(true);
    expect(first.beer_name.length).toBeGreaterThan(0);
    expect(first.brewery_name.length).toBeGreaterThan(0);
    expect(first).toHaveProperty('style');
    expect(first).toHaveProperty('abv');
    expect(first).toHaveProperty('global_rating');
  });

  test('caps result at first 5 items', () => {
    const items30 = Array.from({ length: 30 }, (_, i) => `
      <div class="beer-item" data-bid="${1000 + i}">
        <div class="beer-details">
          <p class="name"><a>Beer ${i}</a></p>
          <p class="brewery"><a>Brewery ${i}</a></p>
          <p class="style">IPA</p>
          <div class="caps" data-rating="3.5"></div>
        </div>
      </div>`).join('');
    const out = parseSearchPage(`<html><body>${items30}</body></html>`);
    expect(out.length).toBe(5);
  });

  test('returns empty array when page has no .beer-item', () => {
    expect(parseSearchPage('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });

  test('global_rating is null when data-rating is "N/A" or missing', () => {
    const html = `
      <div class="beer-item" data-bid="42">
        <div class="beer-details">
          <p class="name"><a>New Release</a></p>
          <p class="brewery"><a>Some Brewery</a></p>
          <p class="style">Lager</p>
          <div class="caps" data-rating="N/A"></div>
        </div>
      </div>`;
    const [it] = parseSearchPage(html);
    expect(it.bid).toBe(42);
    expect(it.global_rating).toBeNull();
  });

  test('skips item with non-numeric data-bid; keeps siblings', () => {
    const html = `
      <div class="beer-item" data-bid="abc">
        <div class="beer-details">
          <p class="name"><a>Bad</a></p>
          <p class="brewery"><a>X</a></p>
        </div>
      </div>
      <div class="beer-item" data-bid="99">
        <div class="beer-details">
          <p class="name"><a>Good</a></p>
          <p class="brewery"><a>Y</a></p>
          <p class="style">Stout</p>
          <div class="caps" data-rating="3.6"></div>
        </div>
      </div>`;
    const out = parseSearchPage(html);
    expect(out.length).toBe(1);
    expect(out[0].bid).toBe(99);
  });

  test('blank style → null', () => {
    const html = `
      <div class="beer-item" data-bid="7">
        <div class="beer-details">
          <p class="name"><a>Whatever</a></p>
          <p class="brewery"><a>Anyone</a></p>
          <p class="style"></p>
        </div>
      </div>`;
    const [it] = parseSearchPage(html);
    expect(it.style).toBeNull();
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=untappd/search --silent`
Expected: FAIL — `Cannot find module './search'`.

- [ ] **Step 3: Create the parser**

Create `src/sources/untappd/search.ts`:

```typescript
import * as cheerio from 'cheerio';

export interface SearchResult {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  abv: number | null;
  global_rating: number | null;
}

const MAX_ITEMS = 5;

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function parseAbv(raw: string): number | null {
  // ABV typically rendered as "6.5% ABV" or "ABV 6.5%". Extract first %-number.
  const m = raw.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function buildSearchUrl(query: string): string {
  const q = encodeURIComponent(query);
  return `https://untappd.com/search?q=${q}&type=beer`;
}

export function parseSearchPage(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];

  $('.beer-item[data-bid]').each((_, el) => {
    if (out.length >= MAX_ITEMS) return false;
    const row = $(el);

    const bidRaw = (row.attr('data-bid') ?? '').trim();
    const bid = parseInt(bidRaw, 10);
    if (!Number.isFinite(bid) || String(bid) !== bidRaw) return;

    const details = row.find('.beer-details').first();
    const beer_name = details.find('.name a').first().text().trim().replace(/\s+/g, ' ');
    const brewery_name = details.find('.brewery a').first().text().trim().replace(/\s+/g, ' ');
    const styleText = details.find('.style').first().text().trim().replace(/\s+/g, ' ');
    const style = styleText.length > 0 ? styleText : null;

    // Search results often render ABV in a separate .abv span; fall back to
    // scanning .beer-details text for "X% ABV".
    let abv: number | null = null;
    const abvText = details.find('.abv').first().text().trim();
    if (abvText) abv = parseAbv(abvText);
    if (abv === null) abv = parseAbv(details.text());

    const global_rating = parseRating(
      details.find('.caps[data-rating]').first().attr('data-rating'),
    );

    out.push({ bid, beer_name, brewery_name, style, abv, global_rating });
  });

  return out;
}
```

**Note for the engineer:** if the live fixture from Task 3 uses different CSS classes than the user-beers page (e.g. `.beer-item` vs `.search-item`), update the selectors in `parseSearchPage` to match. The tests in Step 1 use synthetic HTML that matches the spec's expected selectors; if you adjust selectors, also adjust those synthetic test cases.

- [ ] **Step 4: Run tests — confirm green**

Run: `npm test -- --testPathPatterns=untappd/search --silent`
Expected: all 8 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sources/untappd/search.ts src/sources/untappd/search.test.ts
git commit -m "$(cat <<'EOF'
feat(untappd): search.ts — buildSearchUrl + parseSearchPage

cheerio-based parser for https://untappd.com/search?q=...&type=beer
results. Mirrors the existing scraper.ts pattern: extract data-bid,
beer name, brewery name, style, ABV, and global rating from up to 5
beer-item cards. Fixture-tested against a curl-captured snapshot
(tests/fixtures/untappd/search-magic-road.html) plus synthetic edge
cases (cap, no items, N/A rating, non-numeric bid, blank style).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `lookup-backoff` pure module

**Files:**
- Create: `src/domain/lookup-backoff.ts`
- Create: `src/domain/lookup-backoff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/lookup-backoff.test.ts`:

```typescript
import { nextDelayHours, isEligible, BACKOFF_HOURS } from './lookup-backoff';

describe('BACKOFF_HOURS', () => {
  test('exactly the schedule from the spec', () => {
    expect(BACKOFF_HOURS).toEqual([0, 24, 72, 168, 336, 720]);
  });
});

describe('nextDelayHours', () => {
  test.each([
    [0, 0],
    [1, 24],
    [2, 72],
    [3, 168],
    [4, 336],
    [5, 720],
    [6, 720],
    [10, 720],
    [100, 720],
  ])('count=%i returns %i', (count, expected) => {
    expect(nextDelayHours(count)).toBe(expected);
  });
});

describe('isEligible', () => {
  const now = new Date('2026-05-26T12:00:00Z');

  test('returns true when lookupAt is null (never tried)', () => {
    expect(isEligible(now, null, 0)).toBe(true);
    expect(isEligible(now, null, 3)).toBe(true);
  });

  test('count=0 with any lookupAt is eligible (delay = 0h)', () => {
    expect(isEligible(now, '2026-05-26T11:59:00Z', 0)).toBe(true);
  });

  test('count=1: not eligible if last lookup was 23h ago', () => {
    const tried = new Date('2026-05-25T13:00:00Z').toISOString(); // 23h before now
    expect(isEligible(now, tried, 1)).toBe(false);
  });

  test('count=1: eligible if last lookup was 25h ago', () => {
    const tried = new Date('2026-05-25T11:00:00Z').toISOString(); // 25h before now
    expect(isEligible(now, tried, 1)).toBe(true);
  });

  test('count=5: eligible exactly at 30d boundary', () => {
    const tried = new Date('2026-04-26T12:00:00Z').toISOString(); // exactly 30d before now
    expect(isEligible(now, tried, 5)).toBe(true);
  });

  test('count=5: not eligible at 29d ago', () => {
    const tried = new Date('2026-04-27T12:00:00Z').toISOString(); // 29d before now
    expect(isEligible(now, tried, 5)).toBe(false);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=lookup-backoff --silent`
Expected: FAIL — `Cannot find module './lookup-backoff'`.

- [ ] **Step 3: Create the implementation**

Create `src/domain/lookup-backoff.ts`:

```typescript
export const BACKOFF_HOURS = [0, 24, 72, 168, 336, 720];

export function nextDelayHours(count: number): number {
  if (count < 0) return BACKOFF_HOURS[0];
  return BACKOFF_HOURS[Math.min(count, BACKOFF_HOURS.length - 1)];
}

export function isEligible(
  now: Date,
  lookupAt: string | null,
  count: number,
): boolean {
  if (lookupAt === null) return true;
  const dueAt = new Date(lookupAt).getTime() + nextDelayHours(count) * 3600_000;
  return now.getTime() >= dueAt;
}
```

- [ ] **Step 4: Run tests — confirm green**

Run: `npm test -- --testPathPatterns=lookup-backoff --silent`
Expected: all tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/lookup-backoff.ts src/domain/lookup-backoff.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): lookup-backoff — exponential schedule + isEligible gate

Pure module shared by PR-D2 (search-based bid lookup) and PR-D3
(rating refresh via /beer/{id}). Schedule: 0h / 24h / 3d / 7d / 14d /
30d cap. Never permanently gives up — repeated retries at 30d after
count >= 5. isEligible reads (now, last_attempt_iso, count) and
returns true when due.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `lookupBeer` orchestrator with 2-stage match

**Files:**
- Create: `src/domain/untappd-lookup.ts`
- Create: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/untappd-lookup.test.ts`:

```typescript
import { lookupBeer } from './untappd-lookup';

function htmlFor(items: Array<{ bid: number; name: string; brewery: string; rating?: string }>): string {
  const cards = items
    .map((it) => `
      <div class="beer-item" data-bid="${it.bid}">
        <div class="beer-details">
          <p class="name"><a>${it.name}</a></p>
          <p class="brewery"><a>${it.brewery}</a></p>
          <p class="style">IPA</p>
          <div class="caps" data-rating="${it.rating ?? '3.5'}"></div>
        </div>
      </div>`)
    .join('');
  return `<html><body>${cards}</body></html>`;
}

describe('lookupBeer', () => {
  test('matched: brewery overlaps + name fuzzy >= 0.85 returns best result', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 5000, name: 'Fifty / Fifty - Pineapple', brewery: 'Magic Road' },
        { bid: 5001, name: 'Fifty / Fifty Clementine & Passionfruit', brewery: 'Magic Road', rating: '3.98' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5001);
    expect(out.result.global_rating).toBe(3.98);
  });

  test('not_found: brewery hard-gate filters every candidate', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 9000, name: 'Fifty/Fifty Clementine & Passionfruit', brewery: 'Some Other Brewery' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      fetch,
    });
    expect(out.kind).toBe('not_found');
  });

  test('not_found: brewery passes hard-gate but every name is below 0.85 fuzzy', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 9000, name: 'Atak Chmielu IPA', brewery: 'Magic Road' },
        { bid: 9001, name: 'Buty Skejta Pils', brewery: 'Magic Road' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      fetch,
    });
    expect(out.kind).toBe('not_found');
  });

  test('transient: fetch throws → kind=transient with the error captured', async () => {
    const boom = new Error('ETIMEDOUT');
    const fetch = jest.fn(async () => {
      throw boom;
    });
    const out = await lookupBeer({
      brewery: 'Magic Road',
      name: 'Fifty/Fifty',
      fetch,
    });
    expect(out.kind).toBe('transient');
    if (out.kind !== 'transient') return;
    expect(out.error).toBe(boom);
  });

  test('empty search results return not_found', async () => {
    const fetch = jest.fn(async () => '<html><body></body></html>');
    const out = await lookupBeer({
      brewery: 'Magic Road',
      name: 'Fifty/Fifty',
      fetch,
    });
    expect(out.kind).toBe('not_found');
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=untappd-lookup --silent`
Expected: FAIL — `Cannot find module './untappd-lookup'`.

- [ ] **Step 3: Create the orchestrator**

Create `src/domain/untappd-lookup.ts`:

```typescript
import { Searcher } from 'fast-fuzzy';
import { breweryAliases } from './matcher';
import { normalizeName } from './normalize';
import {
  buildSearchUrl,
  parseSearchPage,
  type SearchResult,
} from '../sources/untappd/search';

const NAME_FUZZY_THRESHOLD = 0.85;

export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found' }
  | { kind: 'transient'; error: unknown };

export interface LookupArgs {
  brewery: string;
  name: string;
  fetch: (url: string) => Promise<string>;
}

export async function lookupBeer(args: LookupArgs): Promise<LookupOutcome> {
  const { brewery, name, fetch } = args;

  let html: string;
  try {
    html = await fetch(buildSearchUrl(`${brewery} ${name}`));
  } catch (error) {
    return { kind: 'transient', error };
  }

  const results = parseSearchPage(html);
  if (results.length === 0) return { kind: 'not_found' };

  // Stage 1: brewery hard-gate — alias overlap.
  const inputBreweryAliases = new Set(breweryAliases(brewery));
  const breweryPassed = results.filter((r) => {
    const candidateAliases = breweryAliases(r.brewery_name);
    return candidateAliases.some((x) => inputBreweryAliases.has(x));
  });
  if (breweryPassed.length === 0) return { kind: 'not_found' };

  // Stage 2: name fuzzy >= 0.85.
  const targetName = normalizeName(name);
  const searcher = new Searcher(breweryPassed, {
    keySelector: (r) => normalizeName(r.beer_name),
    threshold: NAME_FUZZY_THRESHOLD,
    returnMatchData: true,
  });
  const matches = searcher.search(targetName);
  if (matches.length === 0) return { kind: 'not_found' };

  return { kind: 'matched', result: matches[0].item };
}
```

- [ ] **Step 4: Run tests — confirm green**

Run: `npm test -- --testPathPatterns=untappd-lookup --silent`
Expected: 5 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): untappd-lookup — 2-stage match orchestrator

lookupBeer({brewery, name, fetch}) → LookupOutcome
  ('matched' | 'not_found' | 'transient'). Fetches /search HTML via
the injected fetch, parses up to 5 candidates, applies brewery
hard-gate via breweryAliases overlap, then name fuzzy ≥ 0.85 via
fast-fuzzy's Searcher. The fetch dependency is injected so the
orchestrator stays unit-testable without HTTP.

PR-D2 will wire this into refresh-ontap (inline) and a cron job
(backfill). This commit lands only the capability.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Storage helpers — `getBeer` + 3 recorders

**Files:**
- Modify: `src/storage/beers.ts` — extend `BeerRow` and add 4 helpers (`getBeer`, `recordLookupSuccess`, `recordLookupNotFound`, `recordLookupTransient`).
- Modify: `src/storage/beers.test.ts` — add tests for each helper.

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/beers.test.ts` (after the existing tests):

```typescript
import {
  getBeer,
  recordLookupSuccess,
  recordLookupNotFound,
  recordLookupTransient,
} from './beers';

describe('getBeer', () => {
  test('returns full row including new lookup_at + lookup_count columns', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    const row = getBeer(db, id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(id);
    expect(row?.untappd_id).toBeNull();
    expect(row?.untappd_lookup_at).toBeNull();
    expect(row?.untappd_lookup_count).toBe(0);
  });

  test('returns null when beer does not exist', () => {
    expect(getBeer(fresh(), 9999)).toBeNull();
  });
});

describe('recordLookupSuccess', () => {
  test('sets untappd_id, style, abv, rating_global from SearchResult', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupSuccess(db, id, {
      bid: 5001, beer_name: 'X', brewery_name: 'Y',
      style: 'IPA', abv: 6.5, global_rating: 3.98,
    });
    const row = getBeer(db, id);
    expect(row?.untappd_id).toBe(5001);
    expect(row?.style).toBe('IPA');
    expect(row?.abv).toBeCloseTo(6.5);
    expect(row?.rating_global).toBeCloseTo(3.98);
  });

  test('NULL rating_global does NOT overwrite existing non-null rating', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: 'Lager', abv: 5.0, rating_global: 3.5,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupSuccess(db, id, {
      bid: 5001, beer_name: 'X', brewery_name: 'Y',
      style: 'IPA', abv: 6.5, global_rating: null,   // Untappd does not have rating yet
    });
    const row = getBeer(db, id);
    expect(row?.rating_global).toBeCloseTo(3.5);    // preserved
    expect(row?.untappd_id).toBe(5001);             // set
    expect(row?.style).toBe('IPA');                  // overwritten
  });

  test('NULL abv does NOT overwrite existing non-null abv', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: 4.6, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupSuccess(db, id, {
      bid: 5001, beer_name: 'X', brewery_name: 'Y',
      style: null, abv: null, global_rating: 3.5,
    });
    const row = getBeer(db, id);
    expect(row?.abv).toBeCloseTo(4.6);    // preserved
  });
});

describe('recordLookupNotFound', () => {
  test('increments count + sets lookup_at', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupNotFound(db, id, '2026-05-26T12:00:00Z');
    let row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00Z');
    expect(row?.untappd_lookup_count).toBe(1);

    recordLookupNotFound(db, id, '2026-05-27T12:00:00Z');
    row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-27T12:00:00Z');
    expect(row?.untappd_lookup_count).toBe(2);
  });
});

describe('recordLookupTransient', () => {
  test('updates lookup_at but does NOT increment count', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupTransient(db, id, '2026-05-26T12:00:00Z');
    let row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00Z');
    expect(row?.untappd_lookup_count).toBe(0);

    recordLookupTransient(db, id, '2026-05-26T13:00:00Z');
    row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T13:00:00Z');
    expect(row?.untappd_lookup_count).toBe(0);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=beers --silent`
Expected: FAIL — `getBeer`, `recordLookupSuccess`, etc. don't exist; tests can't import them.

- [ ] **Step 3: Extend `BeerRow` and add helpers**

In `src/storage/beers.ts`, find the `BeerRow` interface (around line 14):

```typescript
export interface BeerRow extends BeerInput { id: number; }
```

Replace with:

```typescript
export interface BeerRow extends BeerInput {
  id: number;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
}
```

Then at the end of the file (after `findBeerByNormalized`), append:

```typescript
export function getBeer(db: DB, beerId: number): BeerRow | null {
  const row = db
    .prepare('SELECT * FROM beers WHERE id = ?')
    .get(beerId) as BeerRow | undefined;
  return row ?? null;
}

export function recordLookupSuccess(
  db: DB,
  beerId: number,
  r: {
    bid: number;
    style: string | null;
    abv: number | null;
    global_rating: number | null;
  },
): void {
  db.prepare(
    `UPDATE beers SET
       untappd_id = ?,
       style = COALESCE(?, style),
       abv = COALESCE(?, abv),
       rating_global = COALESCE(?, rating_global)
     WHERE id = ?`,
  ).run(r.bid, r.style, r.abv, r.global_rating, beerId);
}

export function recordLookupNotFound(db: DB, beerId: number, at: string): void {
  db.prepare(
    `UPDATE beers SET
       untappd_lookup_at = ?,
       untappd_lookup_count = untappd_lookup_count + 1
     WHERE id = ?`,
  ).run(at, beerId);
}

export function recordLookupTransient(
  db: DB,
  beerId: number,
  at: string,
): void {
  db.prepare(
    'UPDATE beers SET untappd_lookup_at = ? WHERE id = ?',
  ).run(at, beerId);
}
```

Note: `recordLookupSuccess` accepts the minimal shape it needs (`{ bid, style, abv, global_rating }`) rather than the full `SearchResult`. This decouples storage from the source module — callers can pass either a `SearchResult` (structural compatibility) or any other source-shape with those four fields.

`style = COALESCE(?, style)` is a deliberate choice: if Untappd happens to know a style we don't, we record it; if Untappd doesn't have it but we already do (from ontap-scrape), we preserve it. The spec also requires the same `COALESCE` behaviour for `abv` and `rating_global`.

- [ ] **Step 4: Run tests — confirm green**

Run: `npm test -- --testPathPatterns=beers --silent`
Expected: all tests pass (existing tests + new ones).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "$(cat <<'EOF'
feat(storage): getBeer + 3 lookup recorders on beers

- BeerRow gains untappd_lookup_at: string|null and
  untappd_lookup_count: number (added by migration v5).
- getBeer(db, id) → BeerRow|null — reads full row including lookup
  state; needed by PR-D2 inline path to check eligibility after
  upsert/match.
- recordLookupSuccess writes untappd_id and COALESCE-merges style /
  abv / rating_global so a NULL field from Untappd does not erase a
  value already in the row (Untappd shows rating only after ≥10
  check-ins; we keep whatever the catalog already had).
- recordLookupNotFound bumps the confirmed-not-found counter +
  updates lookup_at.
- recordLookupTransient updates lookup_at only — HTTP/network
  failures shouldn't burn through the retry budget.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `listLookupCandidates` — on-tap + backoff-eligible

**Files:**
- Modify: `src/storage/beers.ts` — add `listLookupCandidates`.
- Modify: `src/storage/beers.test.ts` — add tests using snapshots + match_links fixtures.

This is the gate consumed by both PR-D2's inline path AND PR-D2's cron. SQL filters by on-tap + `untappd_id IS NULL`; JS filters by backoff (because `isEligible` lives in TypeScript and is easier to maintain there than as SQL `julianday()` arithmetic).

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/beers.test.ts`:

```typescript
import { upsertPub } from './pubs';
import { createSnapshot, insertTaps } from './snapshots';
import { upsertMatch } from './match_links';
import { listLookupCandidates } from './beers';

describe('listLookupCandidates', () => {
  function seedBeerOnTap(
    db: ReturnType<typeof fresh>,
    opts: { brewery: string; name: string; untappdId?: number | null;
            lookupAt?: string | null; lookupCount?: number },
  ): number {
    const beerId = upsertBeer(db, {
      untappd_id: opts.untappdId ?? null,
      name: opts.name, brewery: opts.brewery,
      style: null, abv: null, rating_global: null,
      normalized_name: opts.name.toLowerCase(),
      normalized_brewery: opts.brewery.toLowerCase(),
    });
    if (opts.lookupAt !== undefined || opts.lookupCount !== undefined) {
      db.prepare(
        'UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = ? WHERE id = ?',
      ).run(opts.lookupAt ?? null, opts.lookupCount ?? 0, beerId);
    }
    const pubId = upsertPub(db, {
      slug: `pub-${beerId}`, name: `Pub ${beerId}`,
      address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');
    const ref = `${opts.brewery} ${opts.name}`;
    upsertMatch(db, ref, beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: ref, brewery_ref: opts.brewery,
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    return beerId;
  }

  test('returns orphan beers currently on tap, omits beers with untappd_id', () => {
    const db = fresh();
    const orphan = seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine' });
    seedBeerOnTap(db, { brewery: 'Pinta', name: 'Atak', untappdId: 12345 });

    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    const ids = out.map((c) => c.id);
    expect(ids).toContain(orphan);
    expect(ids.length).toBe(1);
  });

  test('omits orphans not on any current tap', () => {
    const db = fresh();
    // Beer not on tap.
    upsertBeer(db, {
      name: 'Ghost', brewery: 'Old', style: null, abv: null, rating_global: null,
      normalized_name: 'ghost', normalized_brewery: 'old',
    });

    const now = new Date('2026-05-26T12:00:00Z');
    expect(listLookupCandidates(db, 10, now)).toEqual([]);
  });

  test('respects backoff: not eligible when lookup_at + delay > now', () => {
    const db = fresh();
    // count=1 → 24h delay. Last attempt 1h ago.
    seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine',
      lookupAt: '2026-05-26T11:00:00Z', lookupCount: 1,
    });
    const now = new Date('2026-05-26T12:00:00Z');
    expect(listLookupCandidates(db, 10, now)).toEqual([]);
  });

  test('backoff-eligible orphan IS returned', () => {
    const db = fresh();
    // count=1 → 24h delay. Last attempt 25h ago.
    const id = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine',
      lookupAt: '2026-05-25T11:00:00Z', lookupCount: 1,
    });
    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([id]);
  });

  test('applies the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedBeerOnTap(db, { brewery: `Brew ${i}`, name: `Beer ${i}` });
    }
    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 2, now);
    expect(out.length).toBe(2);
  });

  test('returned shape carries brewery and name (raw, not normalized)', () => {
    const db = fresh();
    seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine & Passionfruit' });
    const now = new Date('2026-05-26T12:00:00Z');
    const [c] = listLookupCandidates(db, 10, now);
    expect(c.brewery).toBe('Magic Road');
    expect(c.name).toBe('Clementine & Passionfruit');
    expect(c.untappd_lookup_at).toBeNull();
    expect(c.untappd_lookup_count).toBe(0);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=beers --silent`
Expected: FAIL — `listLookupCandidates` not exported.

- [ ] **Step 3: Implement `listLookupCandidates`**

Append to `src/storage/beers.ts`:

```typescript
import { isEligible } from '../domain/lookup-backoff';

export interface LookupCandidate {
  id: number;
  brewery: string;
  name: string;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
}

export function listLookupCandidates(
  db: DB,
  limit: number,
  now: Date,
): LookupCandidate[] {
  // SQL pre-filter: orphan beers (untappd_id NULL) whose beer_id is on the
  // latest snapshot of at least one pub. The on-tap join goes
  // beers ← match_links.untappd_beer_id ← taps.beer_ref → tap_snapshots →
  // (latest snapshot per pub).
  const rows = db
    .prepare(
      `SELECT b.id, b.brewery, b.name,
              b.untappd_lookup_at, b.untappd_lookup_count
       FROM beers b
       WHERE b.untappd_id IS NULL
         AND EXISTS (
           SELECT 1 FROM match_links ml
           JOIN taps t ON t.beer_ref = ml.ontap_ref
           JOIN tap_snapshots ts ON ts.id = t.snapshot_id
           JOIN (
             SELECT pub_id, MAX(snapshot_at) AS m
             FROM tap_snapshots
             GROUP BY pub_id
           ) latest ON latest.pub_id = ts.pub_id
                  AND latest.m = ts.snapshot_at
           WHERE ml.untappd_beer_id = b.id
         )
       ORDER BY b.untappd_lookup_count ASC, b.id ASC`,
    )
    .all() as LookupCandidate[];

  // JS-side backoff filter (isEligible lives in lookup-backoff; reproducing
  // its math in SQLite julianday arithmetic would duplicate the schedule
  // and drift over time).
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count),
  );

  return eligible.slice(0, limit);
}
```

`ORDER BY untappd_lookup_count ASC, id ASC` prefers fresh orphans (count=0) ahead of ones we've already tried — keeps the queue moving even when backlog includes long-tried beers.

The `LIMIT` is applied AFTER backoff filtering (in JS), not before — otherwise a bunch of backed-off rows at the top of the SQL result could starve eligible ones further down. The fixed SQL ordering keeps the SQL scan deterministic.

- [ ] **Step 4: Run tests — confirm green**

Run: `npm test -- --testPathPatterns=beers --silent`
Expected: all tests pass (existing + 6 new for `listLookupCandidates`).

- [ ] **Step 5: Full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "$(cat <<'EOF'
feat(storage): listLookupCandidates — on-tap orphans, backoff-eligible

SQL pre-filter for beers.untappd_id IS NULL with an EXISTS subquery
that requires the beer to be referenced from the latest snapshot of
at least one pub. JS-side filter then drops rows whose
isEligible(now, lookup_at, count) is false. Returns up to LIMIT
candidates ordered by lowest lookup_count first.

Why JS-side backoff: reproducing the schedule (0/24/72/168/336/720
hours) as julianday() arithmetic in SQL would duplicate the table
from src/domain/lookup-backoff.ts and silently drift if either side
changes. Keeping it in TS keeps the source of truth single.

PR-D2 will consume this from both the inline refresh path and a cron.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final verification before push

**Files:** none.

- [ ] **Step 1: Full suite**

Run: `npm test -- --silent`
Expected: every test passes. Total = baseline + Task 2 (1) + Task 4 (8) + Task 5 (16: 1 BACKOFF + 9 test.each rows + 6 isEligible) + Task 6 (5) + Task 7 (7) + Task 8 (6) = **+43 new tests**. Suite count grows by **3 new suites** (`search.test.ts`, `lookup-backoff.test.ts`, `untappd-lookup.test.ts`); `schema.test.ts` and `beers.test.ts` extend existing suites.

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline origin/main..HEAD`
Expected: 7 commits in order:
1. `feat(schema): migration v5 — beers.untappd_lookup_at + untappd_lookup_count`
2. `test(fixtures): curl-captured Untappd /search HTML for Magic Road query`
3. `feat(untappd): search.ts — buildSearchUrl + parseSearchPage`
4. `feat(domain): lookup-backoff — exponential schedule + isEligible gate`
5. `feat(domain): untappd-lookup — 2-stage match orchestrator`
6. `feat(storage): getBeer + 3 lookup recorders on beers`
7. `feat(storage): listLookupCandidates — on-tap orphans, backoff-eligible`

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff origin/main...HEAD --stat`
Expected files (11):
- `src/storage/schema.ts`
- `src/storage/schema.test.ts`
- `src/storage/beers.ts`
- `src/storage/beers.test.ts`
- `src/sources/untappd/search.ts`
- `src/sources/untappd/search.test.ts`
- `src/domain/lookup-backoff.ts`
- `src/domain/lookup-backoff.test.ts`
- `src/domain/untappd-lookup.ts`
- `src/domain/untappd-lookup.test.ts`
- `tests/fixtures/untappd/search-magic-road.html`

No stray edits — in particular, no changes under `src/jobs/` or `src/index.ts` (those are PR-D2).

---

## Task 10: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/untappd-search
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: Untappd /search capability (PR-D1 of 3)" --body "$(cat <<'EOF'
## Summary
- Migration v5: `beers.untappd_lookup_at` + `untappd_lookup_count`.
- New `src/sources/untappd/search.ts`: cheerio parser for `/search?q=...&type=beer`. Fixture-tested against a curl-captured snapshot.
- New `src/domain/lookup-backoff.ts`: pure exponential schedule (0/24/72/168/336/720 h).
- New `src/domain/untappd-lookup.ts`: `lookupBeer({brewery, name, fetch})` orchestrator that returns `{kind: 'matched' | 'not_found' | 'transient'}`. Two-stage filter: brewery hard-gate (`breweryAliases` overlap) + name fuzzy ≥ 0.85.
- New `src/storage/beers.ts` helpers: `getBeer`, `recordLookupSuccess` (COALESCE-merges style/abv/rating to preserve catalog values when Untappd lacks them), `recordLookupNotFound`, `recordLookupTransient`, `listLookupCandidates` (on-tap + backoff-eligible).

**No behavior change.** This PR lands only capability. PR-D2 wires `lookupBeer` into `refreshOntap` (inline) and a new cron `enrich-orphans`. PR-D3 adds rating refresh via `/beer/{id}`.

Implements `docs/superpowers/specs/2026-05-26-untappd-lookup.md` PR-D1 section.

## Test plan
- [x] `npm test` green locally (baseline + ~41 new tests)
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [ ] After merge: `dist/` builds + bot still launches; migration v5 applies cleanly to the prod DB (visible via `PRAGMA table_info(beers);`).
- [ ] No runtime change expected. `journalctl -u warsaw-beer-bot | grep -i untappd-lookup` should be silent — the new code paths are unreachable in this PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges; PR-D2 plan is generated next.

---

## What this plan does NOT cover

- **Wiring into refresh-ontap** — PR-D2.
- **The `enrich-orphans` cron job** — PR-D2.
- **`UNTAPPD_LOOKUP_ENABLED` env var / kill switch** — PR-D2 (the first PR with reachable callsites is where the flag becomes meaningful).
- **`/beer/{id}` rating-refresh scraper** — PR-D3.
- **Master spec §10 footgun bullet** — none yet; if PR-D2/D3 turn up a footgun, that's where to add it.
- **Worktree teardown** — done after PR-D1 merges (`git worktree remove /home/ysi/warsaw-beer-bot-untappd-search`).
