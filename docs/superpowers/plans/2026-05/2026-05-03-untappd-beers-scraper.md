# Replace `/beer` Scraper With `/beers` Scraper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose `refresh-untappd` to scrape `/user/<X>/beers` (the distinct-beers list) and populate `beers.rating_global` from the *global* community rating, replacing the broken `/beer` (singular) scraper that landed on the activity feed and stored the *user's* personal rating.

**Architecture:** Three coordinated changes in one PR. (1) New cheerio parser `parseUserBeersPage` reads `.beer-item[data-bid]` rows, distinguishing `Their Rating` vs `Global Rating` by the `.you > p` label text. (2) Job `refreshAllUntappd` switches URL to `/beers`, drops `mergeCheckin` (page has no check-in IDs/timestamps), and only updates `rating_global` on existing rows or upserts new beers with `abv: null`. (3) New live HTML fixture replaces the old activity-feed fixture.

**Tech Stack:** TypeScript, cheerio, better-sqlite3, Jest, Telegraf 4.x. No new dependencies. No schema changes. Single feature branch `feat/untappd-beers-scraper`.

**Spec:** `docs/superpowers/specs/2026-04-30-untappd-beers-scraper-design.md`.

---

## File Structure

**Modified:**
```
src/sources/untappd/scraper.ts       # parseUserBeerPage → parseUserBeersPage; new ScrapedBeer type
src/sources/untappd/scraper.test.ts  # rewritten for new parser
src/jobs/refresh-untappd.ts          # new URL, new scraper call, drop mergeCheckin
docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md  # §14 lesson entry
```

**Created:**
```
src/jobs/refresh-untappd.test.ts     # job-level tests (new file)
tests/fixtures/untappd/user-beers.html  # live /beers HTML, ~25 items
```

**Deleted:**
```
tests/fixtures/untappd/user-beer.html  # old activity-feed fixture
```

No schema migration. No env-var change. No dependency change.

---

## Branch setup

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/untappd-beers-scraper
```

---

## Task 1: Capture the live `/beers` fixture

**Files:**
- Create: `tests/fixtures/untappd/user-beers.html`

The new fixture is a saved HTTP 200 response from `https://untappd.com/user/ysilvestrov/beers`. It backs every parser test, so it must contain the real DOM structure described in the spec (`.beer-item[data-bid]`, `.beer-details .name`, `.beer-details .ratings .you`).

- [ ] **Step 1: Fetch the live page**

```bash
curl -sSL --compressed \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' \
  -o tests/fixtures/untappd/user-beers.html \
  https://untappd.com/user/ysilvestrov/beers
```

If the response is a Cloudflare interstitial (`<title>Just a moment...</title>`) or a login wall, **STOP** and report back — the plan assumes unauthenticated `/beers` still serves HTML, which the spec confirmed on 2026-04-30. If today's response differs, design needs revision before continuing.

- [ ] **Step 2: Verify fixture shape**

```bash
grep -c 'class="beer-item" data-bid=' tests/fixtures/untappd/user-beers.html
grep -c 'Global Rating'              tests/fixtures/untappd/user-beers.html
grep -c 'Their Rating'               tests/fixtures/untappd/user-beers.html
```

Expected: each grep prints a number ≥ 1 (typically ~25). If any count is `0`, the page structure has changed and Task 2 selectors must be re-derived from the new HTML before writing tests.

- [ ] **Step 3: Capture the first item's expected values for use in tests**

```bash
node -e "
const cheerio = require('cheerio');
const fs = require('fs');
const \$ = cheerio.load(fs.readFileSync('tests/fixtures/untappd/user-beers.html', 'utf8'));
const first = \$('.beer-item[data-bid]').first();
const ratings = {};
first.find('.beer-details .ratings .you').each((_, el) => {
  const label = \$(el).find('p').first().text().trim();
  const v = \$(el).find('.caps[data-rating]').attr('data-rating');
  ratings[label] = v;
});
console.log({
  count: \$('.beer-item[data-bid]').length,
  bid: first.attr('data-bid'),
  name: first.find('.beer-details .name a').text().trim(),
  brewery: first.find('.beer-details .brewery a').text().trim(),
  style: first.find('.beer-details .style').text().trim(),
  ratings,
});
"
```

Record the printed values — Task 2's "happy path" test asserts on them. Save the values into a scratch note (commit message draft, or stash in `tests/fixtures/untappd/EXPECTED.txt` temporarily; do not commit the note).

- [ ] **Step 4: Commit the fixture**

```bash
git add tests/fixtures/untappd/user-beers.html
git commit -m "test(untappd): capture live /beers fixture for new scraper"
```

---

## Task 2: Rewrite the scraper for `parseUserBeersPage` (TDD)

**Files:**
- Modify: `src/sources/untappd/scraper.test.ts`
- Modify: `src/sources/untappd/scraper.ts`

The old `parseUserBeerPage` returns `ScrapedCheckin[]` with `checkin_id` + `rating_score` + `checkin_at`. The new `parseUserBeersPage` returns `ScrapedBeer[]` with `bid`, names, style, `their_rating`, `global_rating`. Old function and old type are removed in this task.

- [ ] **Step 1: Replace the test file with failing tests**

Replace the entire contents of `src/sources/untappd/scraper.test.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { parseUserBeersPage } from './scraper';

const fixturePath = path.join(__dirname, '../../../tests/fixtures/untappd/user-beers.html');
const html = fs.readFileSync(fixturePath, 'utf8');

describe('parseUserBeersPage', () => {
  test('parses every .beer-item in the fixture', () => {
    const $ = cheerio.load(html);
    const expected = $('.beer-item[data-bid]').length;
    const items = parseUserBeersPage(html);
    expect(items.length).toBe(Math.min(expected, 25));
    expect(items.length).toBeGreaterThan(0);
  });

  test('first item has bid, name, brewery, style, both ratings populated', () => {
    const items = parseUserBeersPage(html);
    const first = items[0];
    expect(typeof first.bid).toBe('number');
    expect(Number.isFinite(first.bid)).toBe(true);
    expect(first.beer_name.length).toBeGreaterThan(0);
    expect(first.brewery_name.length).toBeGreaterThan(0);
    // style can be null but the field must exist
    expect(first).toHaveProperty('style');
    // global_rating may be null on a fresh release; assert type only
    if (first.global_rating !== null) {
      expect(typeof first.global_rating).toBe('number');
      expect(first.global_rating).toBeGreaterThan(0);
      expect(first.global_rating).toBeLessThanOrEqual(5);
    }
    if (first.their_rating !== null) {
      expect(typeof first.their_rating).toBe('number');
      expect(first.their_rating).toBeGreaterThanOrEqual(0);
      expect(first.their_rating).toBeLessThanOrEqual(5);
    }
  });

  test('caps result at first 25 items', () => {
    // Build a synthetic page with 30 .beer-item entries
    const items30 = Array.from({ length: 30 }, (_, i) => `
      <div class="beer-item" data-bid="${1000 + i}">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${1000 + i}">Beer ${i}</a></p>
          <p class="brewery"><a href="/x">Brewery ${i}</a></p>
          <p class="style">IPA</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (4)</p>
              <div class="caps" data-rating="4"></div>
            </div>
            <div class="you">
              <p>Global Rating (3.5)</p>
              <div class="caps" data-rating="3.5"></div>
            </div>
          </div>
        </div>
      </div>`).join('');
    const out = parseUserBeersPage(`<html><body>${items30}</body></html>`);
    expect(out.length).toBe(25);
  });

  test('returns empty array when page has no .beer-item', () => {
    expect(parseUserBeersPage('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });

  test('global_rating is null when data-rating is "N/A"', () => {
    const html = `
      <div class="beer-item" data-bid="42">
        <div class="beer-details">
          <p class="name"><a href="/b/x/42">New Release</a></p>
          <p class="brewery"><a href="/x">Some Brewery</a></p>
          <p class="style">Lager</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (4.5)</p>
              <div class="caps" data-rating="4.5"></div>
            </div>
            <div class="you">
              <p>Global Rating (N/A)</p>
              <div class="caps" data-rating="N/A"></div>
            </div>
          </div>
        </div>
      </div>`;
    const [it] = parseUserBeersPage(html);
    expect(it.bid).toBe(42);
    expect(it.global_rating).toBeNull();
    expect(it.their_rating).toBe(4.5);
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
          <div class="ratings">
            <div class="you">
              <p>Their Rating (3)</p>
              <div class="caps" data-rating="3"></div>
            </div>
            <div class="you">
              <p>Global Rating (3.6)</p>
              <div class="caps" data-rating="3.6"></div>
            </div>
          </div>
        </div>
      </div>`;
    const out = parseUserBeersPage(html);
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
          <div class="ratings"></div>
        </div>
      </div>`;
    const [it] = parseUserBeersPage(html);
    expect(it.style).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests; expect every case to fail**

```bash
npx jest src/sources/untappd/scraper.test.ts
```

Expected: TS error `Module '"./scraper"' has no exported member 'parseUserBeersPage'`, or — once you stub the export — multiple `expect(...).toBe(...)` failures.

- [ ] **Step 3: Replace `src/sources/untappd/scraper.ts` with the new parser**

Overwrite the entire file with:

```ts
import * as cheerio from 'cheerio';

export interface ScrapedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  their_rating: number | null;
  global_rating: number | null;
}

const MAX_ITEMS = 25;

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseUserBeersPage(html: string): ScrapedBeer[] {
  const $ = cheerio.load(html);
  const out: ScrapedBeer[] = [];

  $('.beer-item[data-bid]').each((_, el) => {
    if (out.length >= MAX_ITEMS) return false;
    const row = $(el);

    const bidRaw = row.attr('data-bid') ?? '';
    const bid = parseInt(bidRaw, 10);
    if (!Number.isFinite(bid) || String(bid) !== bidRaw.trim()) return;

    const details = row.find('.beer-details').first();
    const beer_name = details.find('.name a').first().text().trim().replace(/\s+/g, ' ');
    const brewery_name = details.find('.brewery a').first().text().trim().replace(/\s+/g, ' ');
    const styleText = details.find('.style').first().text().trim().replace(/\s+/g, ' ');
    const style = styleText.length > 0 ? styleText : null;

    let their_rating: number | null = null;
    let global_rating: number | null = null;
    details.find('.ratings .you').each((_, you) => {
      const label = $(you).find('p').first().text().trim();
      const value = parseRating($(you).find('.caps[data-rating]').first().attr('data-rating'));
      if (/^Their Rating/i.test(label)) their_rating = value;
      else if (/^Global Rating/i.test(label)) global_rating = value;
    });

    out.push({ bid, beer_name, brewery_name, style, their_rating, global_rating });
  });

  return out;
}
```

Notes on the implementation:
- The `String(bid) !== bidRaw.trim()` guard rejects `"abc"` (where `parseInt` would return `NaN`) **and** `"42px"` (where `parseInt` returns `42` but the attribute is malformed). Either way, the item is silently skipped.
- The spec says discriminate by `<p>` text, not by index — both `.you` blocks have a `.caps[data-rating]`, but their order is not guaranteed.
- `data-rating="N/A"` makes `parseFloat` return `NaN`, which `Number.isFinite` rejects, yielding `null`.

- [ ] **Step 4: Run the parser tests; expect all pass**

```bash
npx jest src/sources/untappd/scraper.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/scraper.ts src/sources/untappd/scraper.test.ts
git commit -m "feat(untappd): parseUserBeersPage scrapes /beers list with global rating"
```

---

## Task 3: Rewrite the `refresh-untappd` job (TDD)

**Files:**
- Create: `src/jobs/refresh-untappd.test.ts`
- Modify: `src/jobs/refresh-untappd.ts`

The job loses its `mergeCheckin` block (no check-in IDs from `/beers`) and changes write semantics: existing rows get **only** `rating_global` updated; new rows are upserted with `abv: null` (the `/beers` page has no ABV column).

- [ ] **Step 1: Create the failing job-level tests**

Create `src/jobs/refresh-untappd.test.ts`:

```ts
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { ensureProfile, setUntappdUsername } from '../storage/user_profiles';
import type { Http } from '../sources/http';
import { refreshAllUntappd } from './refresh-untappd';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function fakeHttp(htmlByUrl: Record<string, string>): Http {
  return {
    async get(url: string): Promise<string> {
      const v = htmlByUrl[url];
      if (v == null) throw new Error(`unexpected url: ${url}`);
      return v;
    },
  };
}

const PAGE_ONE_BEER = (bid: number, name: string, brewery: string, global: string) => `
  <div class="beer-item" data-bid="${bid}">
    <div class="beer-details">
      <p class="name"><a href="/b/x/${bid}">${name}</a></p>
      <p class="brewery"><a href="/x">${brewery}</a></p>
      <p class="style">IPA</p>
      <div class="ratings">
        <div class="you">
          <p>Their Rating (4)</p>
          <div class="caps" data-rating="4"></div>
        </div>
        <div class="you">
          <p>Global Rating (${global})</p>
          <div class="caps" data-rating="${global}"></div>
        </div>
      </div>
    </div>
  </div>`;

// IMPORTANT for test names: `normalizeBrewery` strips tokens
// `brewing/brewery/co/company/browar`; `normalizeName` strips style words
// like `ipa/lager/stout/...`. Keep test fixtures clear of those tokens
// so the normalized form matches the literal lowercased input.

describe('refreshAllUntappd', () => {
  test('inserts a new beer with rating_global from /beers', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': PAGE_ONE_BEER(101, 'Atak Chmielu', 'Pinta', '4.12'),
    });

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'pinta', 'atak chmielu');
    expect(row).not.toBeNull();
    expect(row!.untappd_id).toBe(101);
    expect(row!.rating_global).toBe(4.12);
    expect(row!.abv).toBeNull();
    expect(row!.style).toBe('IPA');
  });

  test('matches existing row by normalized name+brewery; updates rating_global only', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seededId = upsertBeer(db, {
      untappd_id: null, // imported from a non-Untappd source originally
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: 'NEIPA — Hazy',
      abv: 6.5,
      rating_global: null,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': PAGE_ONE_BEER(101, 'Atak Chmielu', 'Pinta', '4.20'),
    });

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'pinta', 'atak chmielu')!;
    expect(row.id).toBe(seededId);          // same row, not a new insert
    expect(row.rating_global).toBe(4.20);   // updated
    expect(row.style).toBe('NEIPA — Hazy'); // canonical fields untouched
    expect(row.abv).toBe(6.5);
    expect(row.name).toBe('Atak Chmielu');
    expect(row.brewery).toBe('Pinta');
    expect(row.untappd_id).toBeNull();      // was null; we don't backfill bid via this path
  });

  test('global_rating null on /beers → row.rating_global set to NULL (idempotent re-read)', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seededId = upsertBeer(db, {
      untappd_id: null,
      name: 'Brand New Release',
      brewery: 'New Brews',
      style: 'Lager',
      abv: 5.0,
      rating_global: 3.9, // stale value; spec says authoritative null overrides
      normalized_name: 'brand new release',
      normalized_brewery: 'new brews',
    });

    const html = `
      <div class="beer-item" data-bid="555">
        <div class="beer-details">
          <p class="name"><a href="/b/x/555">Brand New Release</a></p>
          <p class="brewery"><a href="/x">New Brews</a></p>
          <p class="style">Lager</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (5)</p>
              <div class="caps" data-rating="5"></div>
            </div>
            <div class="you">
              <p>Global Rating (N/A)</p>
              <div class="caps" data-rating="N/A"></div>
            </div>
          </div>
        </div>
      </div>`;
    const http = fakeHttp({ 'https://untappd.com/user/someone/beers': html });

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'new brews', 'brand new release')!;
    expect(row.id).toBe(seededId);
    expect(row.rating_global).toBeNull();
  });

  test('hits /beers (plural), not /beer (singular)', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        return '';
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http });
    expect(seenUrls).toEqual(['https://untappd.com/user/someone/beers']);
  });

  test('skips profiles with no untappd_username', async () => {
    const db = fresh();
    ensureProfile(db, 1); // no setUntappdUsername — username stays null
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'real');

    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        return '';
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http });
    expect(seenUrls).toEqual(['https://untappd.com/user/real/beers']);
  });

  test('survives a per-profile fetch error and continues', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'broken');
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'someone');

    const http: Http = {
      async get(url: string) {
        if (url.includes('broken')) throw new Error('HTTP 503');
        return PAGE_ONE_BEER(202, 'Survivor Hazy', 'Steady Brews', '3.50');
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'steady brews', 'survivor hazy');
    expect(row).not.toBeNull();
    expect(row!.rating_global).toBe(3.50);
  });
});
```

- [ ] **Step 2: Run the new tests; verify failures**

```bash
npx jest src/jobs/refresh-untappd.test.ts
```

Expected: tests fail because the current job calls `parseUserBeerPage` and `mergeCheckin`, and uses the wrong URL `/beer`. Likely the entire suite errors at import-time once Task 2 has removed `parseUserBeerPage` — which is fine; we're about to rewrite the job.

- [ ] **Step 3: Rewrite `src/jobs/refresh-untappd.ts`**

Overwrite the entire file with:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { parseUserBeersPage } from '../sources/untappd/scraper';
import { allProfiles } from '../storage/user_profiles';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { noopProgress, type ProgressFn } from './progress';

interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  onProgress?: ProgressFn;
}

export async function refreshAllUntappd(deps: Deps): Promise<void> {
  const { db, log, http, onProgress = noopProgress } = deps;
  const profiles = allProfiles(db).filter((p) => p.untappd_username);
  await onProgress(`👤 untappd: 0/${profiles.length} профілів`, { force: true });

  const updateRatingOnly = db.prepare('UPDATE beers SET rating_global = ? WHERE id = ?');

  let i = 0;
  let ok = 0;
  for (const p of profiles) {
    i++;
    try {
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beers`);
      const items = parseUserBeersPage(html);
      for (const it of items) {
        const nb = normalizeBrewery(it.brewery_name);
        const nn = normalizeName(it.beer_name);
        const existing = findBeerByNormalized(db, nb, nn);
        if (existing) {
          // Authoritative read of global rating; leave canonical CSV-import fields alone.
          updateRatingOnly.run(it.global_rating, existing.id);
        } else {
          upsertBeer(db, {
            untappd_id: it.bid,
            name: it.beer_name,
            brewery: it.brewery_name,
            style: it.style,
            abv: null, // /beers does not carry ABV
            rating_global: it.global_rating,
            normalized_name: nn,
            normalized_brewery: nb,
          });
        }
      }
      ok++;
    } catch (e) {
      log.warn({ err: e, user: p.untappd_username }, 'untappd scrape failed');
    }
    await onProgress(`👤 untappd: ${i}/${profiles.length} — ${p.untappd_username}`);
  }
  await onProgress(`👤 untappd: ✓ ${ok}/${profiles.length} профілів`, { force: true });
}
```

Notes:
- `mergeCheckin` import is gone — `/beers` is a per-beer aggregate, no check-in IDs.
- `their_rating` from the parser is intentionally unread here; it stays on the scraped type for future use (per spec § Risks).
- `existing` branch uses a prepared statement that touches **only** `rating_global` to avoid clobbering canonical CSV-import fields (`name`, `brewery`, `style`, `abv`). New rows still go through `upsertBeer` so all schema invariants and bid-first lookup logic stay centralised.

- [ ] **Step 4: Run job tests; verify all pass**

```bash
npx jest src/jobs/refresh-untappd.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Run the full Jest suite + typecheck**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean (no leftover references to `parseUserBeerPage`, `ScrapedCheckin`, or `mergeCheckin` in this code path). All tests pass. The wiring through `src/index.ts:44` and `src/index.ts:53` is unchanged — `refreshAllUntappd` keeps the same `Deps` signature.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
git commit -m "feat(untappd): refresh-untappd hits /beers and updates rating_global only"
```

---

## Task 4: Delete the obsolete fixture

**Files:**
- Delete: `tests/fixtures/untappd/user-beer.html`

The old fixture (the activity-feed redirect target) is unreferenced after Task 2.

- [ ] **Step 1: Confirm no other references**

```bash
grep -rn "user-beer\.html" src tests 2>/dev/null
```

Expected: no output. (Worktree paths under `.worktrees/` may exist; they are throw-away copies and irrelevant.)

- [ ] **Step 2: Delete and commit**

```bash
git rm tests/fixtures/untappd/user-beer.html
git commit -m "test(untappd): drop activity-feed fixture replaced by /beers fixture"
```

---

## Task 5: Log the lesson in §14 of the canonical spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`

Append immediately after the `Untappd global_weighted_rating_score` lesson block (added in PR #32).

- [ ] **Step 1: Locate the insertion point**

```bash
grep -n "Untappd \`global_weighted_rating_score\`" docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
```

Expected: a single line. The block to insert after ends at the line before `Ці грабельки — чек-лист на першу секунду нового деплою.`.

- [ ] **Step 2: Insert the new entry**

Insert the following block between the closing line of the `global_weighted_rating_score` entry and the `Ці грабельки …` paragraph:

```markdown
- **Untappd `/user/<X>/beers` scraper**: fetches the user's distinct-beers
  list (top ~25 unauthenticated) for an incremental refresh of
  `beers.rating_global`. Replaces a multi-layered broken predecessor that
  hit `/beer` (which 303-redirects), used activity-feed selectors
  (`.item[data-checkin-id]`), and stored the user's personal rating in
  `rating_global`. Bulk backfill of `rating_global` is the `/import` path
  (Design 3); this job catches new releases and rating drift between
  imports. `/beers` does not paginate unauthenticated, so the 25-item cap
  is a hard ceiling.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs(spec): log /user/<X>/beers scraper lesson in §14"
```

---

## Task 6: Open the PR

This is a wrap-up step, not a code change.

- [ ] **Step 1: Final green check**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean, all tests pass.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/untappd-beers-scraper
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head feat/untappd-beers-scraper \
  --title "feat(untappd): /beers scraper — incremental rating_global refresh" \
  --body "$(cat <<'EOF'
## Summary
Phase 1 of the post-PR-#30 rating + cleanup roadmap (PR #31).
Spec: \`docs/superpowers/specs/2026-04-30-untappd-beers-scraper-design.md\`.

Replaces the broken \`refresh-untappd\` job that scraped \`/user/<X>/beer\` (303-redirected to the activity feed) and stored the user's personal rating in \`beers.rating_global\`.

- New \`parseUserBeersPage(html)\` reads \`.beer-item[data-bid]\` rows on \`/user/<X>/beers\`, picking out \`Global Rating\` vs \`Their Rating\` by label (no order assumption).
- Job switches URL to \`/beers\` and updates only \`rating_global\` on existing rows; new rows are upserted with \`abv: null\` (the page has no ABV).
- \`mergeCheckin\` is dropped — \`/beers\` is an aggregate per-beer view with no check-in IDs.
- 25-item cap retained (Untappd's hard unauthenticated ceiling).
- New live HTML fixture; old activity-feed fixture deleted.

Together with PR #32, closes the \`rating_global\` end-to-end gap: \`/import\` does the bulk backfill, this job is incremental top-up between imports.

## Test plan
- [x] \`npx tsc --noEmit\` — clean
- [x] \`npx jest\` — all tests pass (parser: 7 cases incl. fixture-driven, N/A, malformed bid, 25-cap; job: 6 cases incl. update-only-rating, NULL override, error survival, URL/profile filtering)
- [ ] Post-deploy smoke (manual): trigger refresh-untappd via cron or admin command. Tail logs for \`untappd scrape failed\` (should be 0). Verify a small bump in \`SELECT COUNT(*) FROM beers WHERE rating_global IS NOT NULL\` from Phase 0 baseline.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 7: Post-deploy smoke (manual checklist — not a commit)

After merge + deploy:

- [ ] Confirm the job runs without errors on the next cron tick:
  ```bash
  ssh <prod> 'journalctl -u warsaw-beer-bot -n 200 | grep -E "untappd|rating_global"'
  ```
  Expected: a `👤 untappd: ✓ N/N профілів` line; no `untappd scrape failed` warnings.

- [ ] Confirm at least one expected ratings-changed signal on the catalog:
  ```bash
  ssh <prod> 'sqlite3 /var/lib/warsaw-beer-bot/bot.db "SELECT COUNT(*) FROM beers WHERE rating_global IS NOT NULL;"'
  ```
  Expected: stable or slightly higher than the post-PR-#32 baseline (no regressions; small bumps from new releases).

- [ ] Spot-check that no row has the user's personal rating in `rating_global` anymore:
  ```bash
  ssh <prod> 'sqlite3 /var/lib/warsaw-beer-bot/bot.db "SELECT id, name, rating_global FROM beers WHERE untappd_id IN (SELECT untappd_id FROM beers WHERE rating_global > 4.5 ORDER BY id DESC LIMIT 5);"'
  ```
  Eyeball: ratings should match Untappd's public weighted community rating, not the user's 4–5⭐ self-ratings.

---

## Done criteria

Branch `feat/untappd-beers-scraper` is ready for PR when:
- Tasks 1–5 committed.
- `npx tsc --noEmit && npx jest` passes.
- PR opened against `main`.

After merge:
- Task 7 smoke checks performed.
