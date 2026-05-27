# Untappd rating refresh (PR-D3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Periodic refresh of `rating_global` for beers that already have `untappd_id` set but `rating_global IS NULL` (Untappd shows the rating only once ≥10 check-ins accumulate). Polls `https://untappd.com/beer/<bid>` on a separate cron, 09:00/21:00 UTC, limited to current-tap beers.

**Architecture:** New cheerio parser at `src/sources/untappd/beer-page.ts` (fixture-tested via curl-first). New storage helpers parallel to PR-D1's `recordLookup*` family but writing to dedicated migration-v6 columns (`rating_refresh_at`, `rating_refresh_count`) so PR-D3's retry state stays independent of PR-D2's `/search` retry state. New `src/jobs/refresh-tap-ratings.ts` cron-callable job mirrors the shape of `enrich-orphans.ts` (iterate candidates, polite sleep, `UNTAPPD_LOOKUP_ENABLED` kill switch). Reuses `isEligible` + `nextDelayHours` from PR-D1's `src/domain/lookup-backoff.ts` (same backoff schedule: 0/24/72/168/336/720 h).

**Tech Stack:** TypeScript, Jest, better-sqlite3 (`:memory:` for tests), cheerio (already a dep), pino, node-cron. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-untappd-lookup.md` PR-D3 section.

**Branch:** `feat/untappd-rating-refresh` off `origin/main` (post-PR-D2.1 merge, commit on `main`).

---

## File Structure

- **Modify** `src/storage/schema.ts` — append migration v6.
- **Modify** `src/storage/schema.test.ts` — assert new columns exist.
- **Create** `tests/fixtures/untappd/beer-page-magic-road.html` — curl-captured snapshot of a real beer page (bid 6645513).
- **Create** `src/sources/untappd/beer-page.ts` — `buildBeerPageUrl`, `parseBeerPage`, `BeerPageData` type.
- **Create** `src/sources/untappd/beer-page.test.ts` — fixture + synthetic edge cases.
- **Modify** `src/storage/beers.ts` — add `recordRatingSuccess`, `recordRatingNotFound`, `recordRatingTransient`, `listRatingRefreshCandidates`, plus extend `BeerRow` with the two new columns.
- **Modify** `src/storage/beers.test.ts` — tests for each new helper.
- **Create** `src/jobs/refresh-tap-ratings.ts` — cron-callable job.
- **Create** `src/jobs/refresh-tap-ratings.test.ts` — tests using stub http + in-memory DB.
- **Modify** `src/index.ts` — import and register the cron at `0 9,21 * * *`.

No new locales. No changes to existing test files outside the storage + schema additions.

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/ysi/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/untappd-rating-refresh /home/ysi/warsaw-beer-bot-rating-refresh origin/main
cd /home/ysi/warsaw-beer-bot-rating-refresh
```

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exit 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: every suite passes. Baseline at PR-D2.1 merge = **307 tests / 41 suites**.

- [ ] **Step 4: Baseline typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

---

## Task 2: Migration v6 — `rating_refresh_at` + `rating_refresh_count`

**Files:**
- Modify: `src/storage/schema.ts` — append a `version: 6` entry to `MIGRATIONS`.
- Modify: `src/storage/schema.test.ts` — add an assertion for both new columns.

- [ ] **Step 1: Write the failing test**

Add to the end of `src/storage/schema.test.ts` (inside the existing outer `describe`):

```typescript
  test('migration v6 adds beers.rating_refresh_at + rating_refresh_count columns', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare('PRAGMA table_info(beers)')
      .all() as { name: string; type: string; notnull: number; dflt_value: unknown }[];

    const refreshAt = cols.find((c) => c.name === 'rating_refresh_at');
    expect(refreshAt).toBeDefined();
    expect(refreshAt?.type).toBe('TEXT');
    expect(refreshAt?.notnull).toBe(0);

    const refreshCount = cols.find((c) => c.name === 'rating_refresh_count');
    expect(refreshCount).toBeDefined();
    expect(refreshCount?.type).toBe('INTEGER');
    expect(refreshCount?.notnull).toBe(1);
    expect(String(refreshCount?.dflt_value)).toBe('0');
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npm test -- --testPathPatterns=schema --silent`
Expected: FAIL — `Received: undefined`, the v6 columns don't exist yet.

- [ ] **Step 3: Append migration v6**

In `src/storage/schema.ts`, find the closing `];` of the `MIGRATIONS` array. Just before it (after the version 5 entry's closing brace + comma), insert:

```typescript
  {
    version: 6,
    sql: `
      ALTER TABLE beers ADD COLUMN rating_refresh_at TEXT;
      ALTER TABLE beers ADD COLUMN rating_refresh_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
```

- [ ] **Step 4: Run the test — confirm green**

Run: `npm test -- --testPathPatterns=schema --silent`
Expected: PASS (6 tests in the schema suite now).

- [ ] **Step 5: Full suite**

Run: `npm test -- --silent`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): migration v6 — beers.rating_refresh_at + rating_refresh_count

Separate retry-state columns for PR-D3's /beer/{id} rating-refresh
cycle. Kept distinct from PR-D1's untappd_lookup_at/count (which
tracks /search retries for orphan-bid lookup) so the two state
machines don't interfere — a beer can be in the middle of one schedule
without affecting the other.

Both columns are meaningful only while untappd_id IS NOT NULL AND
rating_global IS NULL. No production code reads or writes them yet —
PR-D3 helpers + cron land in subsequent commits.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Curl-first — capture live `/beer/<bid>` HTML

**Files:**
- Create: `tests/fixtures/untappd/beer-page-magic-road.html` — saved curl response.

One-time manual capture against a known beer. We pick bid **6645513** (Magic Road Fifty/Fifty Clementine & Passionfruit — the beer that motivated PR-D, surfaced by PR-D1's fixture). Its current rating (3.984 at PR-D1 capture time) is non-NULL, so the parser will see a real rating value to test against.

- [ ] **Step 1: Curl Untappd beer page and save fixture**

```bash
curl -sS \
  -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' \
  'https://untappd.com/beer/6645513' \
  -o tests/fixtures/untappd/beer-page-magic-road.html
```

- [ ] **Step 2: Sanity-check the fixture**

Run: `wc -c tests/fixtures/untappd/beer-page-magic-road.html`
Expected: ≥ 20 KB. A small response (<2 KB) typically means a captcha/login wall — retry from a different network or UA.

```bash
grep -c 'data-rating\|caps' tests/fixtures/untappd/beer-page-magic-road.html
```
Expected: at least one match. Untappd has consistently used `.caps[data-rating="X"]` for star ratings across pages (we already see it in search.ts and scraper.ts).

- [ ] **Step 3: Inspect HTML structure to find the rating-bearing element**

Look at the fixture to find the canonical rating element. Common patterns:
- `<div class="caps" data-rating="3.984">` somewhere in `.details` or `.rating` wrapper.
- `<p class="num">(3.984)</p>` next to the caps div.

Identify the single most specific selector the parser should use. If the fixture surfaces multiple `.caps[data-rating]` (e.g., one for global, one for current user) — the parser must target only the GLOBAL one. Common heuristic: it's inside a top-level `.details` / `.basic` div, NOT inside `.checkin` / `.you` blocks.

Adjust Task 4's selector to whatever the fixture shows. The synthetic tests in Task 4 use the spec's expected layout.

- [ ] **Step 4: Commit the fixture**

```bash
git add tests/fixtures/untappd/beer-page-magic-road.html
git commit -m "$(cat <<'EOF'
test(fixtures): curl-captured Untappd /beer/{id} HTML for Magic Road

Captured 2026-05-27 from https://untappd.com/beer/6645513 (the same
beer whose search snapshot motivated PR-D1). Consumed by the
parseBeerPage tests in the next commit. Regenerate locally (curl +
commit) if Untappd's beer-page HTML schema drifts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `parseBeerPage` parser

**Files:**
- Create: `src/sources/untappd/beer-page.ts`
- Create: `src/sources/untappd/beer-page.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/sources/untappd/beer-page.test.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { buildBeerPageUrl, parseBeerPage } from './beer-page';

const fixturePath = path.join(__dirname, '../../../tests/fixtures/untappd/beer-page-magic-road.html');
const html = fs.readFileSync(fixturePath, 'utf8');

describe('buildBeerPageUrl', () => {
  test('formats /beer/{bid}', () => {
    expect(buildBeerPageUrl(6645513)).toBe('https://untappd.com/beer/6645513');
  });

  test('integer-only — fractional bids are not Untappd-valid', () => {
    // Defensive: the type system enforces number, but a downstream
    // injection should never produce a non-integer bid.
    expect(buildBeerPageUrl(1)).toBe('https://untappd.com/beer/1');
  });
});

describe('parseBeerPage', () => {
  test('extracts non-null global_rating from the captured fixture', () => {
    const out = parseBeerPage(html);
    expect(out.global_rating).not.toBeNull();
    expect(typeof out.global_rating).toBe('number');
    expect(out.global_rating).toBeGreaterThan(0);
    expect(out.global_rating).toBeLessThanOrEqual(5);
  });

  test('returns null global_rating when page has no .caps[data-rating]', () => {
    const out = parseBeerPage('<html><body><p>nothing here</p></body></html>');
    expect(out.global_rating).toBeNull();
  });

  test('returns null when data-rating is "N/A" (Untappd uses this before 10 check-ins)', () => {
    const synthetic = `
      <html><body>
        <div class="basic">
          <div class="rating">
            <div class="caps" data-rating="N/A"></div>
          </div>
        </div>
      </body></html>`;
    const out = parseBeerPage(synthetic);
    expect(out.global_rating).toBeNull();
  });

  test('returns the global rating when a numeric data-rating is present', () => {
    const synthetic = `
      <html><body>
        <div class="basic">
          <div class="rating">
            <div class="caps" data-rating="3.78"></div>
          </div>
        </div>
      </body></html>`;
    const out = parseBeerPage(synthetic);
    expect(out.global_rating).toBeCloseTo(3.78);
  });

  test('handles "0" data-rating as 0 (not null) — distinguishes "no rating" from "rated zero"', () => {
    // Untappd uses "N/A" for unrated; "0" would be a literal zero rating,
    // which is technically possible. Parser must not coerce 0 to null.
    const synthetic = `
      <html><body>
        <div class="basic">
          <div class="rating">
            <div class="caps" data-rating="0"></div>
          </div>
        </div>
      </body></html>`;
    const out = parseBeerPage(synthetic);
    expect(out.global_rating).toBe(0);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=beer-page --silent`
Expected: FAIL — `Cannot find module './beer-page'`.

- [ ] **Step 3: Create the parser**

Create `src/sources/untappd/beer-page.ts`:

```typescript
import * as cheerio from 'cheerio';

export interface BeerPageData {
  global_rating: number | null;
}

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function buildBeerPageUrl(bid: number): string {
  return `https://untappd.com/beer/${bid}`;
}

export function parseBeerPage(html: string): BeerPageData {
  const $ = cheerio.load(html);

  // Untappd renders the global rating as <div class="caps" data-rating="X">
  // inside a .rating wrapper at the top of the beer page. The fixture from
  // Task 3 has exactly one such element near the top; if multiple are present
  // (e.g. inside checkin cards), the first one in document order is the
  // canonical global rating.
  const global_rating = parseRating(
    $('.caps[data-rating]').first().attr('data-rating'),
  );

  return { global_rating };
}
```

**Important:** if the Task 3 fixture inspection shows that `.caps[data-rating]` appears in unwanted places (e.g. checkin sub-cards) BEFORE the canonical global one, narrow the selector to something like `.details .caps[data-rating]` or `.rating > .caps[data-rating]` based on the actual structure. Adjust the synthetic test cases above to match the chosen selector so they remain meaningful regression checks.

- [ ] **Step 4: Run the tests — confirm green**

Run: `npm test -- --testPathPatterns=beer-page --silent`
Expected: 7 passing tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sources/untappd/beer-page.ts src/sources/untappd/beer-page.test.ts
git commit -m "$(cat <<'EOF'
feat(untappd): beer-page.ts — buildBeerPageUrl + parseBeerPage

cheerio parser for https://untappd.com/beer/<bid>. Returns
{ global_rating: number | null }. NULL when Untappd hasn't accumulated
≥10 check-ins yet (data-rating="N/A"); a literal "0" is preserved.

Fixture-tested against tests/fixtures/untappd/beer-page-magic-road.html
(curl-captured snapshot of bid 6645513) plus 4 synthetic edge cases.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Storage helpers — `recordRating*` + `listRatingRefreshCandidates`

**Files:**
- Modify: `src/storage/beers.ts` — extend `BeerRow` with the two new columns; add 3 recorders + 1 lister.
- Modify: `src/storage/beers.test.ts` — tests for each new helper.

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/beers.test.ts`:

```typescript
import {
  recordRatingSuccess,
  recordRatingNotFound,
  recordRatingTransient,
  listRatingRefreshCandidates,
} from './beers';

describe('recordRatingSuccess', () => {
  test('sets rating_global from the parsed beer-page rating', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 6645513,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingSuccess(db, id, 3.98);
    const row = getBeer(db, id);
    expect(row?.rating_global).toBeCloseTo(3.98);
    expect(row?.rating_refresh_count).toBe(0);     // success doesn't increment
  });

  test('overwrites a stale existing rating', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 100,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: 3.5,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingSuccess(db, id, 3.9);
    expect(getBeer(db, id)?.rating_global).toBeCloseTo(3.9);
  });
});

describe('recordRatingNotFound', () => {
  test('increments count + sets refresh_at', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 100,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingNotFound(db, id, '2026-05-27T12:00:00Z');
    let row = getBeer(db, id);
    expect(row?.rating_refresh_at).toBe('2026-05-27T12:00:00Z');
    expect(row?.rating_refresh_count).toBe(1);

    recordRatingNotFound(db, id, '2026-05-28T12:00:00Z');
    row = getBeer(db, id);
    expect(row?.rating_refresh_at).toBe('2026-05-28T12:00:00Z');
    expect(row?.rating_refresh_count).toBe(2);
  });
});

describe('recordRatingTransient', () => {
  test('updates refresh_at but does NOT increment count', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 100,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingTransient(db, id, '2026-05-27T12:00:00Z');
    expect(getBeer(db, id)?.rating_refresh_count).toBe(0);
    expect(getBeer(db, id)?.rating_refresh_at).toBe('2026-05-27T12:00:00Z');
  });
});

describe('listRatingRefreshCandidates', () => {
  function seedBeerOnTap(
    db: ReturnType<typeof fresh>,
    opts: {
      brewery: string; name: string;
      untappdId: number;                 // always set — this list is for known-bid beers
      ratingGlobal?: number | null;
      refreshAt?: string | null;
      refreshCount?: number;
    },
  ): number {
    const beerId = upsertBeer(db, {
      untappd_id: opts.untappdId,
      name: opts.name, brewery: opts.brewery,
      style: null, abv: null,
      rating_global: opts.ratingGlobal ?? null,
      normalized_name: opts.name.toLowerCase(),
      normalized_brewery: opts.brewery.toLowerCase(),
    });
    if (opts.refreshAt !== undefined || opts.refreshCount !== undefined) {
      db.prepare(
        'UPDATE beers SET rating_refresh_at = ?, rating_refresh_count = ? WHERE id = ?',
      ).run(opts.refreshAt ?? null, opts.refreshCount ?? 0, beerId);
    }
    const pubId = upsertPub(db, {
      slug: `pub-${beerId}`, name: `Pub ${beerId}`,
      address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-27T12:00:00Z');
    const ref = `${opts.brewery} ${opts.name}`;
    upsertMatch(db, ref, beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: ref, brewery_ref: opts.brewery,
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    return beerId;
  }

  test('returns beers with untappd_id AND rating_global IS NULL on a current tap', () => {
    const db = fresh();
    const candidate = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
    });
    // Has rating already — must be excluded.
    seedBeerOnTap(db, {
      brewery: 'Pinta', name: 'Atak', untappdId: 12345, ratingGlobal: 3.9,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    const out = listRatingRefreshCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([candidate]);
    expect(out[0].untappd_id).toBe(6645513);
  });

  test('omits orphan beers (untappd_id NULL — those are PR-D2 territory)', () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    const pubId = upsertPub(db, {
      slug: 'p', name: 'P', address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-27T12:00:00Z');
    upsertMatch(db, 'X', beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: 'X', brewery_ref: 'Y',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 10, now)).toEqual([]);
  });

  test('omits beers not on any current tap', () => {
    const db = fresh();
    upsertBeer(db, {
      untappd_id: 100,
      name: 'Ghost', brewery: 'Old', style: null, abv: null, rating_global: null,
      normalized_name: 'ghost', normalized_brewery: 'old',
    });
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 10, now)).toEqual([]);
  });

  test('respects backoff via shared lookup-backoff isEligible', () => {
    const db = fresh();
    // count=1 → 24h delay. Last refresh 1h ago → not eligible.
    seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
      refreshAt: '2026-05-27T11:00:00Z', refreshCount: 1,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 10, now)).toEqual([]);
  });

  test('returns backoff-eligible beer 25h after last refresh attempt', () => {
    const db = fresh();
    const id = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
      refreshAt: '2026-05-26T11:00:00Z', refreshCount: 1,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    const out = listRatingRefreshCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([id]);
  });

  test('applies the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedBeerOnTap(db, {
        brewery: `Brew${i}`, name: `Beer${i}`, untappdId: 1000 + i,
      });
    }
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 2, now).length).toBe(2);
  });

  test('returned shape carries untappd_id for the cron to use as URL input', () => {
    const db = fresh();
    seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    const [c] = listRatingRefreshCandidates(db, 10, now);
    expect(c).toEqual(expect.objectContaining({
      id: expect.any(Number),
      untappd_id: 6645513,
      rating_refresh_at: null,
      rating_refresh_count: 0,
    }));
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=beers --silent`
Expected: FAIL — `recordRatingSuccess`, etc. not exported.

- [ ] **Step 3: Extend `BeerRow` interface**

In `src/storage/beers.ts`, find the existing `BeerRow` interface (extended in PR-D1):

```typescript
export interface BeerRow extends BeerInput {
  id: number;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
}
```

Replace with:

```typescript
export interface BeerRow extends BeerInput {
  id: number;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
}
```

- [ ] **Step 4: Add the recorders**

At the end of `src/storage/beers.ts`, AFTER the existing `listLookupCandidates` function, append:

```typescript
export function recordRatingSuccess(
  db: DB,
  beerId: number,
  rating: number,
): void {
  // Success overwrites whatever rating_global was there. Count not touched —
  // the beer leaves the candidate pool naturally (rating_global IS NOT NULL).
  db.prepare('UPDATE beers SET rating_global = ? WHERE id = ?')
    .run(rating, beerId);
}

export function recordRatingNotFound(
  db: DB,
  beerId: number,
  at: string,
): void {
  db.prepare(
    `UPDATE beers SET
       rating_refresh_at = ?,
       rating_refresh_count = rating_refresh_count + 1
     WHERE id = ?`,
  ).run(at, beerId);
}

export function recordRatingTransient(
  db: DB,
  beerId: number,
  at: string,
): void {
  db.prepare(
    'UPDATE beers SET rating_refresh_at = ? WHERE id = ?',
  ).run(at, beerId);
}

export interface RatingRefreshCandidate {
  id: number;
  untappd_id: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
}

export function listRatingRefreshCandidates(
  db: DB,
  limit: number,
  now: Date,
): RatingRefreshCandidate[] {
  // SQL pre-filter: beers WITH untappd_id but NO rating, currently on tap.
  // Same on-tap join as listLookupCandidates.
  const rows = db
    .prepare(
      `SELECT b.id, b.untappd_id,
              b.rating_refresh_at, b.rating_refresh_count
       FROM beers b
       WHERE b.untappd_id IS NOT NULL
         AND b.rating_global IS NULL
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
       ORDER BY b.rating_refresh_count ASC, b.id ASC`,
    )
    .all() as RatingRefreshCandidate[];

  // JS-side backoff filter using the shared lookup-backoff module.
  const eligible = rows.filter((r) =>
    isEligible(now, r.rating_refresh_at, r.rating_refresh_count),
  );

  return eligible.slice(0, limit);
}
```

Note: `isEligible` is already imported at the top of `beers.ts` (PR-D1 added it for `listLookupCandidates`). No new import.

- [ ] **Step 5: Run tests — confirm green**

Run: `npm test -- --testPathPatterns=beers --silent`
Expected: all tests pass (existing + 11 new across the 4 describe blocks).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "$(cat <<'EOF'
feat(storage): rating-refresh recorders + listRatingRefreshCandidates

- BeerRow extended with rating_refresh_at + rating_refresh_count
  (migration v6).
- recordRatingSuccess writes rating_global directly; the beer leaves
  the candidate pool naturally (WHERE rating_global IS NULL).
- recordRatingNotFound bumps count + sets refresh_at.
- recordRatingTransient updates refresh_at only — HTTP/network noise
  shouldn't burn through the retry budget.
- listRatingRefreshCandidates(limit, now): same on-tap EXISTS join as
  listLookupCandidates, but filters on
    (untappd_id IS NOT NULL AND rating_global IS NULL).
  JS-side backoff via the shared isEligible from lookup-backoff.

PR-D3 cron lands these next.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `refresh-tap-ratings` cron job

**Files:**
- Create: `src/jobs/refresh-tap-ratings.ts`
- Create: `src/jobs/refresh-tap-ratings.test.ts`

Mirror of `enrich-orphans.ts` structure (iterate candidates, polite sleep, kill-switch) but uses `/beer/{id}` not `/search` and writes to the rating columns. Whether to extract a shared inner-helper (parallel to `enrichOneOrphan`) is a judgement call — for one cron call site, inlining keeps things readable. We can extract later if PR-D4 reuses it.

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/refresh-tap-ratings.test.ts`:

```typescript
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import type { Http } from '../sources/http';
import { refreshTapRatings } from './refresh-tap-ratings';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function beerPageHtml(rating: string): string {
  return `<html><body>
    <div class="basic">
      <div class="rating">
        <div class="caps" data-rating="${rating}"></div>
      </div>
    </div>
  </body></html>`;
}

function seedIdBeerOnTap(
  db: ReturnType<typeof fresh>,
  brewery: string, name: string, untappdId: number,
): number {
  const beerId = upsertBeer(db, {
    untappd_id: untappdId,
    name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase(),
  });
  const pubId = upsertPub(db, {
    slug: `pub-${beerId}`, name: `Pub ${beerId}`,
    address: null, lat: null, lon: null,
  });
  const snapId = createSnapshot(db, pubId, '2026-05-27T12:00:00Z');
  const ref = `${brewery} ${name}`;
  upsertMatch(db, ref, beerId, 1.0);
  insertTaps(db, snapId, [{
    tap_number: 1, beer_ref: ref, brewery_ref: brewery,
    abv: null, ibu: null, style: null, u_rating: null,
  }]);
  return beerId;
}

describe('refreshTapRatings', () => {
  test('matched: fills rating_global and stats it as matched', async () => {
    const db = fresh();
    const beerId = seedIdBeerOnTap(db, 'Magic Road', 'Clementine', 6645513);
    const calls: string[] = [];
    const http: Http = {
      async get(url: string): Promise<string> {
        calls.push(url);
        return beerPageHtml('3.98');
      },
    };
    const fixedNow = new Date('2026-05-27T12:00:00Z');

    const result = await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result).toEqual({
      processed: 1, matched: 1, not_found: 0, transient: 0,
    });
    expect(calls).toEqual(['https://untappd.com/beer/6645513']);
    expect(getBeer(db, beerId)?.rating_global).toBeCloseTo(3.98);
  });

  test('not_found: NULL rating bumps count + records refresh_at', async () => {
    const db = fresh();
    const beerId = seedIdBeerOnTap(db, 'Brand', 'New', 999);
    const http: Http = {
      async get(): Promise<string> { return beerPageHtml('N/A'); },
    };
    const fixedNow = new Date('2026-05-27T12:00:00Z');

    const result = await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result).toEqual({
      processed: 1, matched: 0, not_found: 1, transient: 0,
    });
    const row = getBeer(db, beerId);
    expect(row?.rating_global).toBeNull();
    expect(row?.rating_refresh_count).toBe(1);
    expect(row?.rating_refresh_at).toBe('2026-05-27T12:00:00.000Z');
  });

  test('transient: HTTP error records refresh_at without incrementing count', async () => {
    const db = fresh();
    const beerId = seedIdBeerOnTap(db, 'X', 'Y', 100);
    const http: Http = {
      async get(): Promise<string> { throw new Error('ETIMEDOUT'); },
    };
    const fixedNow = new Date('2026-05-27T12:00:00Z');

    const result = await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result).toEqual({
      processed: 1, matched: 0, not_found: 0, transient: 1,
    });
    const row = getBeer(db, beerId);
    expect(row?.rating_refresh_count).toBe(0);
    expect(row?.rating_refresh_at).toBe('2026-05-27T12:00:00.000Z');
  });

  test('respects limit', async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedIdBeerOnTap(db, `Brew${i}`, `Beer${i}`, 100 + i);
    }
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> { calls++; return beerPageHtml('N/A'); },
    };
    const result = await refreshTapRatings({
      db, log: silentLog, http, limit: 2, sleepMs: 0,
      now: () => new Date('2026-05-27T12:00:00Z'),
    });
    expect(result.processed).toBe(2);
    expect(calls).toBe(2);
  });

  test('lookupEnabled=false: no candidates touched, no HTTP', async () => {
    const db = fresh();
    seedIdBeerOnTap(db, 'X', 'Y', 100);
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> { calls++; return ''; },
    };
    const result = await refreshTapRatings({
      db, log: silentLog, http, lookupEnabled: false, sleepMs: 0,
      now: () => new Date('2026-05-27T12:00:00Z'),
    });
    expect(result).toEqual({ processed: 0, matched: 0, not_found: 0, transient: 0 });
    expect(calls).toBe(0);
  });

  test('sleeps between HTTP calls when sleepMs > 0', async () => {
    const db = fresh();
    seedIdBeerOnTap(db, 'A', 'B', 100);
    seedIdBeerOnTap(db, 'C', 'D', 200);
    const sleeps: number[] = [];
    const http: Http = {
      async get(): Promise<string> { return beerPageHtml('N/A'); },
    };
    const sleep = async (ms: number) => { sleeps.push(ms); };

    await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 500, sleep,
      now: () => new Date('2026-05-27T12:00:00Z'),
    });
    expect(sleeps).toEqual([500]);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- --testPathPatterns=refresh-tap-ratings --silent`
Expected: FAIL — `Cannot find module './refresh-tap-ratings'`.

- [ ] **Step 3: Create the cron job**

Create `src/jobs/refresh-tap-ratings.ts`:

```typescript
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import {
  listRatingRefreshCandidates,
  recordRatingSuccess,
  recordRatingNotFound,
  recordRatingTransient,
} from '../storage/beers';
import { buildBeerPageUrl, parseBeerPage } from '../sources/untappd/beer-page';

export interface RefreshTapRatingsResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
}

export interface RefreshTapRatingsDeps {
  db: DB;
  log: pino.Logger;
  http: Http;
  lookupEnabled?: boolean;     // default true
  limit?: number;               // default 20
  sleepMs?: number;             // default 500
  sleep?: (ms: number) => Promise<void>;   // for tests
  now?: () => Date;             // for tests
}

const ZERO_RESULT: RefreshTapRatingsResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0,
};

export async function refreshTapRatings(
  deps: RefreshTapRatingsDeps,
): Promise<RefreshTapRatingsResult> {
  if (deps.lookupEnabled === false) {
    deps.log.info(
      'untappd-lookup disabled (UNTAPPD_LOOKUP_ENABLED=false), skipping refresh-tap-ratings',
    );
    return ZERO_RESULT;
  }

  const limit = deps.limit ?? 20;
  const sleepMs = deps.sleepMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) =>
    new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());

  const candidates = listRatingRefreshCandidates(deps.db, limit, now());
  const result: RefreshTapRatingsResult = { ...ZERO_RESULT };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const tickNow = now();
    const nowIso = tickNow.toISOString();
    try {
      const html = await deps.http.get(buildBeerPageUrl(c.untappd_id));
      const { global_rating } = parseBeerPage(html);
      if (global_rating !== null) {
        recordRatingSuccess(deps.db, c.id, global_rating);
        result.matched++;
      } else {
        recordRatingNotFound(deps.db, c.id, nowIso);
        result.not_found++;
      }
    } catch (err) {
      deps.log.warn({ err, beerId: c.id, untappdId: c.untappd_id },
        'rating-refresh transient failure');
      recordRatingTransient(deps.db, c.id, nowIso);
      result.transient++;
    }
    result.processed++;

    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
  }

  deps.log.info(result, 'refresh-tap-ratings done');
  return result;
}
```

- [ ] **Step 4: Run tests — confirm green**

Run: `npm test -- --testPathPatterns=refresh-tap-ratings --silent`
Expected: 6 passing tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/refresh-tap-ratings.ts src/jobs/refresh-tap-ratings.test.ts
git commit -m "$(cat <<'EOF'
feat(jobs): refresh-tap-ratings cron — refresh global ratings

For beers with untappd_id set but rating_global NULL on a current
tap, fetch https://untappd.com/beer/{id}, parse global rating,
record outcome. Same shape as enrich-orphans (limit 20, polite
500ms spacing, UNTAPPD_LOOKUP_ENABLED kill switch) but a different
endpoint and a different state-column pair (rating_refresh_at/count).

Untappd shows global rating only once ≥10 check-ins accumulate;
this cron periodically re-checks beers that PR-D2 found but Untappd
hadn't yet rated.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Register cron in `src/index.ts`

**Files:**
- Modify: `src/index.ts` — import + register cron at `0 9,21 * * *`.

- [ ] **Step 1: Add the import**

In `src/index.ts`, find the existing job imports (around line 22-26):

```typescript
import { enrichOrphans } from './jobs/enrich-orphans';
```

Add directly below it:

```typescript
import { refreshTapRatings } from './jobs/refresh-tap-ratings';
```

- [ ] **Step 2: Register the cron**

Find the `cronJobs` array (after the enrich-orphans cron). Add a new entry:

```typescript
    cron.schedule('0 9,21 * * *', () => {
      refreshTapRatings({
        db, log, http,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
      }).catch((e) => log.error({ err: e }, 'refresh-tap-ratings cron'));
    }),
```

Final cron schedule lineup: `0 */12` (ontap 00/12), `0 3` (untappd-had 03), `0 6,18` (enrich-orphans 06/18), `0 9,21` (refresh-tap-ratings 09/21). No overlapping start times.

- [ ] **Step 3: Typecheck + full suite + build**

```bash
npm run typecheck
npm test -- --silent
npm run build
```

Expected: all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(refresh): register refresh-tap-ratings cron (0 9,21 * * *)

Threads env.UNTAPPD_LOOKUP_ENABLED through to the new cron so the
kill switch (added in PR-D2) silences PR-D3 too. Cron offsets:
- 00/12  refreshOntap
- 03     refreshAllUntappd
- 06/18  enrich-orphans
- 09/21  refresh-tap-ratings  ← new

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final verification before push

**Files:** none.

- [ ] **Step 1: Full suite**

Run: `npm test -- --silent`
Expected: every test passes. Total = baseline 307 + Task 2 (1) + Task 4 (7) + Task 5 (11) + Task 6 (6) = **332 tests** across **43 suites** (baseline 41 + 2 new: `beer-page.test.ts`, `refresh-tap-ratings.test.ts`).

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline origin/main..HEAD`
Expected: 6 commits in order:
1. `feat(schema): migration v6 — beers.rating_refresh_at + rating_refresh_count`
2. `test(fixtures): curl-captured Untappd /beer/{id} HTML for Magic Road`
3. `feat(untappd): beer-page.ts — buildBeerPageUrl + parseBeerPage`
4. `feat(storage): rating-refresh recorders + listRatingRefreshCandidates`
5. `feat(jobs): refresh-tap-ratings cron — refresh global ratings`
6. `feat(refresh): register refresh-tap-ratings cron (0 9,21 * * *)`

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff origin/main...HEAD --stat`
Expected files (10):
- `src/storage/schema.ts`
- `src/storage/schema.test.ts`
- `src/storage/beers.ts`
- `src/storage/beers.test.ts`
- `src/sources/untappd/beer-page.ts`
- `src/sources/untappd/beer-page.test.ts`
- `src/jobs/refresh-tap-ratings.ts`
- `src/jobs/refresh-tap-ratings.test.ts`
- `src/index.ts`
- `tests/fixtures/untappd/beer-page-magic-road.html`

No edits outside this set.

- [ ] **Step 5: Sanity-check pre-deploy candidate count**

```bash
sqlite3 /var/lib/warsaw-beer-bot/bot.db <<'SQL'
SELECT COUNT(*) AS rating_refresh_candidates
FROM beers b
WHERE b.untappd_id IS NOT NULL
  AND b.rating_global IS NULL
  AND EXISTS (
    SELECT 1 FROM match_links ml
    JOIN taps t ON t.beer_ref = ml.ontap_ref
    JOIN tap_snapshots ts ON ts.id = t.snapshot_id
    JOIN (SELECT pub_id, MAX(snapshot_at) m FROM tap_snapshots GROUP BY pub_id) latest
      ON latest.pub_id = ts.pub_id AND latest.m = ts.snapshot_at
    WHERE ml.untappd_beer_id = b.id);
SQL
```

Expected: a small number (was 0 at plan-write time; PR-D2 may have added a few since). Record it — post-deploy this number should slowly fall to 0 minus genuinely-unrated-on-Untappd beers.

---

## Task 9: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/untappd-rating-refresh
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: Untappd rating refresh (PR-D3 of 3)" --body "$(cat <<'EOF'
## Summary
Closes the PR-D series:

- **Migration v6**: \`beers.rating_refresh_at\` + \`rating_refresh_count\` (separate from PR-D1's lookup_at/count so the two state machines don't interfere).
- **New \`src/sources/untappd/beer-page.ts\`**: cheerio parser for \`https://untappd.com/beer/<bid>\`, returning \`{ global_rating: number | null }\`. Fixture-tested against curl-captured snapshot.
- **New storage helpers in \`src/storage/beers.ts\`**: \`recordRatingSuccess\`, \`recordRatingNotFound\`, \`recordRatingTransient\`, \`listRatingRefreshCandidates\`. Reuse \`isEligible\` + the 0/24/72/168/336/720 h backoff schedule from PR-D1's \`lookup-backoff\`.
- **New \`src/jobs/refresh-tap-ratings.ts\` cron**: 09:00 / 21:00 UTC, limit 20 per run, 500ms polite spacing, respects \`UNTAPPD_LOOKUP_ENABLED\`.

## Behavior change
Beers that PR-D2 found by bid but Untappd hadn't yet rated (≤9 check-ins) now get periodic re-checks via \`/beer/{id}\`. When Untappd's rating crosses the 10-checkin threshold, the next cron run picks it up and \`/newbeers\` starts showing ⭐ instead of \`⭐ —\`.

Implements \`docs/superpowers/specs/2026-05-26-untappd-lookup.md\` PR-D3 section.

## Test plan
- [x] \`npm test\` green locally (332/43 — baseline 307 + 25 new)
- [x] \`npm run typecheck\` clean
- [x] \`npm run build\` clean
- [ ] After deploy: \`sudo journalctl -u warsaw-beer-bot --since today | grep "refresh-tap-ratings done"\` shows \`{processed, matched, not_found, transient}\` stats.
- [ ] After deploy: rating_refresh_candidates count (see Task 8 Step 5 query) trends toward 0 over time minus genuinely-unrated beers.
- [ ] Kill switch: \`UNTAPPD_LOOKUP_ENABLED=false\` already silences PR-D2; same for PR-D3 — no separate flag.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges + redeploys.

---

## What this plan does NOT cover

- **Backfill of `rating_global` for beers NOT on current tap** — out of scope; the on-tap filter is deliberate (no point spending HTTP on beers we don't show).
- **Force-refresh user command** — YAGNI.
- **Worktree teardown** — done after PR merges (`git worktree remove /home/ysi/warsaw-beer-bot-rating-refresh`).
