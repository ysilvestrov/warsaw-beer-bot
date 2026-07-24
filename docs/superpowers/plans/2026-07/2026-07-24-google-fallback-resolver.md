# Google Fallback Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Untappd/Algolia returns 0 candidates for a beer, resolve its canonical Untappd page via the Google Custom Search JSON API and re-gate that candidate through the existing strict matcher, so cross-language / over-specified names enrich.

**Architecture:** A new `WebResolver` seam (`createGoogleResolver`) queries Google CSE (site-restricted to `untappd.com`) and returns `ResolvedBeer` candidates. A pure orchestrator `runGoogleFallback` guards spend (daily quota by Pacific day + a per-beer 30-day `google_tried_at` cooldown), hydrates ABV (CSE pagemap → Algolia-by-name fallback), and applies the refined-B1 gate. Rather than threading DB/network into the pure `lookupBeer`, a thin `lookupWithFallback` wrapper runs the fallback **only** when `lookupBeer` returns `not_found` with **zero** candidates — invoked at both call sites (cron `enrichOneOrphan`, route `/enrich/result`). Feature-flagged off by absent keys → zero behavioural change.

> **Spec note (boundary refinement):** the spec described injecting `resolve?` into `lookupBeer`. To keep `lookupBeer` pure (no DB/quota/network-orchestration), the implementation instead wraps it at the call sites via `lookupWithFallback`, gated on `not_found` + empty candidates. Observable behaviour is identical to the spec.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, zod, fast-fuzzy, Vitest. Reuses `nameKeys`/`intersects`/`breweryAliases`/`breweryAliasesMatch`/`ABV_TOLERANCE` from `src/domain/matcher.ts` and the `BeerSearch`/`SearchResult` types from `src/sources/untappd/search.ts`.

---

## File Structure

- Create `src/domain/pacific-day.ts` — `pacificDay(date)` → `YYYY-MM-DD` in America/Los_Angeles.
- Create `src/storage/google_quota.ts` — atomic daily quota consume.
- Create `src/sources/google/resolver.ts` — `WebResolver`, `ResolvedBeer`, `parseCseResponse`, `createGoogleResolver`.
- Create `src/domain/google-fallback.ts` — refined-B1 gate helpers, `runGoogleFallback`, `lookupWithFallback`.
- Modify `src/storage/schema.ts` — migration v19 (`google_quota` table + `beers.google_tried_at`).
- Modify `src/storage/beers.ts` — `google_tried_at` on `BeerRow`, `readGoogleTriedAt`, `stampGoogleTried`.
- Modify `src/config/env.ts` — `GOOGLE_CSE_KEY`/`GOOGLE_CSE_CX`/`GOOGLE_CSE_DAILY_CAP` + expected-key warning.
- Modify `src/domain/untappd-lookup.ts` — `export` `hasLongSharedToken` for reuse.
- Modify `src/jobs/untappd-enrich.ts` — thread optional fallback into `enrichOneOrphan`.
- Modify `src/api/types.ts` + `src/api/routes/enrich.ts` — thread optional fallback into `/enrich/result`.
- Modify `src/index.ts` — build the resolver + fallback closure (when keys present) and wire both call sites.
- Modify `spec.md` — document the Google fallback tier.

---

### Task 1: Pacific-day helper

**Files:**
- Create: `src/domain/pacific-day.ts`
- Test: `src/domain/pacific-day.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/pacific-day.test.ts
import { describe, it, expect } from 'vitest';
import { pacificDay } from './pacific-day';

describe('pacificDay', () => {
  it('returns the Los Angeles calendar date as YYYY-MM-DD', () => {
    // 2026-07-24T05:00:00Z is 2026-07-23 22:00 PDT
    expect(pacificDay(new Date('2026-07-24T05:00:00Z'))).toBe('2026-07-23');
  });

  it('rolls to the next day at Pacific midnight, not UTC midnight', () => {
    // 2026-07-24T06:59:00Z = 2026-07-23 23:59 PDT (still the 23rd)
    expect(pacificDay(new Date('2026-07-24T06:59:00Z'))).toBe('2026-07-23');
    // 2026-07-24T07:00:00Z = 2026-07-24 00:00 PDT (now the 24th)
    expect(pacificDay(new Date('2026-07-24T07:00:00Z'))).toBe('2026-07-24');
  });

  it('handles standard time (PST, UTC-8) in winter', () => {
    // 2026-01-15T07:59:00Z = 2026-01-14 23:59 PST
    expect(pacificDay(new Date('2026-01-15T07:59:00Z'))).toBe('2026-01-14');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/pacific-day.test.ts`
Expected: FAIL — `pacificDay` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/pacific-day.ts
// Google CSE's daily free quota resets at midnight Pacific Time, so the quota
// counter must be keyed by the Pacific calendar date — not UTC — or it would
// roll over at the wrong instant. en-CA gives ISO-style YYYY-MM-DD directly.
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pacificDay(date: Date): string {
  return FMT.format(date);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/pacific-day.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/pacific-day.ts src/domain/pacific-day.test.ts
git commit -m "feat(#139): pacificDay helper for Google CSE quota day-keying"
```

---

### Task 2: Migration v19 — quota table + google_tried_at column

**Files:**
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`, after version 18 at ~line 246)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/storage/schema.test.ts` (append inside the existing top-level `describe`, matching the file's existing `migrate`/`openDb` imports and helpers):

```ts
  it('v19 creates google_quota and adds beers.google_tried_at', () => {
    const db = openDb(':memory:');
    migrate(db);

    const cols = (db.prepare(`PRAGMA table_info(beers)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('google_tried_at');

    const quotaCols = (db.prepare(`PRAGMA table_info(google_quota)`).all() as { name: string }[]).map((c) => c.name);
    expect(quotaCols).toEqual(['day', 'count']);

    const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(version).toBeGreaterThanOrEqual(19);
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: FAIL — `google_quota` table has no columns / `google_tried_at` missing.

- [ ] **Step 3: Add the migration**

In `src/storage/schema.ts`, add after the version-18 entry (keep the closing `];` of `MIGRATIONS`):

```ts
  {
    version: 19,
    sql: `
      ALTER TABLE beers ADD COLUMN google_tried_at TEXT;
      CREATE TABLE google_quota (
        day   TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(#139): migration v19 google_quota table + beers.google_tried_at"
```

---

### Task 3: Atomic daily quota consume

**Files:**
- Create: `src/storage/google_quota.ts`
- Test: `src/storage/google_quota.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/storage/google_quota.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { tryConsumeGoogleQuota } from './google_quota';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('tryConsumeGoogleQuota', () => {
  it('allows exactly `cap` calls per day, then blocks', () => {
    const db = freshDb();
    const day = '2026-07-24';
    let ok = 0;
    for (let i = 0; i < 5; i++) if (tryConsumeGoogleQuota(db, day, 3)) ok++;
    expect(ok).toBe(3);
    expect((db.prepare('SELECT count FROM google_quota WHERE day = ?').get(day) as { count: number }).count).toBe(3);
    db.close();
  });

  it('tracks each day independently', () => {
    const db = freshDb();
    expect(tryConsumeGoogleQuota(db, '2026-07-24', 1)).toBe(true);
    expect(tryConsumeGoogleQuota(db, '2026-07-24', 1)).toBe(false);
    expect(tryConsumeGoogleQuota(db, '2026-07-25', 1)).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/google_quota.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/storage/google_quota.ts
import type { DB } from './db';

// Atomically consume one unit of the day's Google CSE budget. Returns true if a
// unit was available (and was consumed), false if the day is already at `cap`.
// The single UPSERT is atomic: a brand-new day inserts count=1; an existing day
// increments only while count < cap (so the max stored count is exactly `cap`);
// at/over cap the WHERE clause fails and no row changes.
export function tryConsumeGoogleQuota(db: DB, day: string, cap: number): boolean {
  const info = db
    .prepare(
      `INSERT INTO google_quota (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?`,
    )
    .run(day, cap);
  return info.changes > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/google_quota.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/google_quota.ts src/storage/google_quota.test.ts
git commit -m "feat(#139): atomic per-Pacific-day Google CSE quota consume"
```

---

### Task 4: `google_tried_at` beers helpers

**Files:**
- Modify: `src/storage/beers.ts` (`BeerRow` interface ~line 20; add two helpers near the other `beers` writers)
- Test: `src/storage/beers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/storage/beers.test.ts` (reuse the file's existing db setup helper; the pattern below matches how other tests insert a row via `upsertBeer`):

```ts
import { readGoogleTriedAt, stampGoogleTried } from './beers';

describe('google_tried_at', () => {
  it('is null until stamped, then reads back the stamp', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', normalized_name: 'x', normalized_brewery: 'y',
    });
    expect(readGoogleTriedAt(db, id)).toBeNull();
    stampGoogleTried(db, id, '2026-07-24T10:00:00.000Z');
    expect(readGoogleTriedAt(db, id)).toBe('2026-07-24T10:00:00.000Z');
    db.close();
  });
});
```

> If `openDb`/`migrate`/`upsertBeer` are already imported at the top of the test file, do not re-import — add only the `readGoogleTriedAt, stampGoogleTried` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: FAIL — `readGoogleTriedAt` not exported.

- [ ] **Step 3: Implement**

In `src/storage/beers.ts`, add `google_tried_at` to `BeerRow`:

```ts
export interface BeerRow extends BeerInput {
  id: number;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
  google_tried_at: string | null;
}
```

Add these two functions at the end of the file:

```ts
export function readGoogleTriedAt(db: DB, beerId: number): string | null {
  const row = db
    .prepare('SELECT google_tried_at FROM beers WHERE id = ?')
    .get(beerId) as { google_tried_at: string | null } | undefined;
  return row?.google_tried_at ?? null;
}

export function stampGoogleTried(db: DB, beerId: number, iso: string): void {
  db.prepare('UPDATE beers SET google_tried_at = ? WHERE id = ?').run(iso, beerId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#139): beers.google_tried_at read/stamp helpers"
```

---

### Task 5: Config keys

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/config/env.test.ts` (reuse the file's existing minimal-valid-env helper; if it builds env via a `base` object, extend that pattern):

```ts
import { loadEnv } from './env';

describe('GOOGLE_CSE config', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: '0123456789',
    DATABASE_PATH: '/tmp/x.db',
    OSRM_BASE_URL: 'http://localhost',
    NOMINATIM_USER_AGENT: 'ua',
  };

  it('defaults GOOGLE_CSE_DAILY_CAP to 90 and leaves keys optional', () => {
    const env = loadEnv({ ...base } as never);
    expect(env.GOOGLE_CSE_KEY).toBeUndefined();
    expect(env.GOOGLE_CSE_CX).toBeUndefined();
    expect(env.GOOGLE_CSE_DAILY_CAP).toBe(90);
  });

  it('coerces GOOGLE_CSE_DAILY_CAP from string', () => {
    const env = loadEnv({ ...base, GOOGLE_CSE_DAILY_CAP: '50' } as never);
    expect(env.GOOGLE_CSE_DAILY_CAP).toBe(50);
  });
});
```

> If the file already defines a `base`/`valid` env fixture, use it instead of redefining `base`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — `GOOGLE_CSE_DAILY_CAP` is undefined (not defaulted).

- [ ] **Step 3: Implement**

In `src/config/env.ts`, add to the `Schema` object (after `UNTAPPD_ALGOLIA_SEARCH_KEY`):

```ts
  GOOGLE_CSE_KEY: z.string().optional(),
  GOOGLE_CSE_CX: z.string().optional(),
  GOOGLE_CSE_DAILY_CAP: z.coerce.number().int().positive().default(90),
```

Add to `EXPECTED_PROD_KEYS`:

```ts
  { key: 'GOOGLE_CSE_KEY', disables: 'Google fallback resolver for 0-candidate lookups (#139)' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(#139): GOOGLE_CSE_KEY/CX/DAILY_CAP env config"
```

---

### Task 6: Google CSE resolver + response parse

**Files:**
- Create: `src/sources/google/resolver.ts`
- Test: `src/sources/google/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/sources/google/resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { parseCseResponse, createGoogleResolver } from './resolver';

const MARYENSZTADT_CSE = {
  items: [
    {
      title:
        'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon - Maryensztadt - Untappd',
      link:
        'https://untappd.com/b/maryensztadt-barrel-aged-project-ice-imperial-brett-baltic-porter-double-barrel-aged-dry-plum-and-cinnamon/5158585',
      pagemap: { metatags: [{ 'twitter:data1': '11.5% ABV' }] },
    },
    {
      title: 'Maryensztadt - Zwoleń - Untappd', // brewery page, not /b/ — dropped
      link: 'https://untappd.com/Maryensztadt',
    },
  ],
};

describe('parseCseResponse', () => {
  it('extracts bid/name/brewery from /b/ items and skips non-beer links', () => {
    const out = parseCseResponse(MARYENSZTADT_CSE);
    expect(out).toHaveLength(1);
    expect(out[0].bid).toBe(5158585);
    expect(out[0].beer_name).toBe(
      'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
    );
    expect(out[0].brewery_name).toBe('Maryensztadt');
    expect(out[0].abv).toBeCloseTo(11.5);
  });

  it('returns [] for empty / missing items', () => {
    expect(parseCseResponse({})).toEqual([]);
    expect(parseCseResponse({ items: [] })).toEqual([]);
  });

  it('yields null abv when pagemap has no ABV', () => {
    const out = parseCseResponse({
      items: [{ title: 'Pan IPAni - Trzech Kumpli - Untappd', link: 'https://untappd.com/b/trzech-kumpli-pan-ipani/1000186' }],
    });
    expect(out[0].abv).toBeNull();
  });
});

describe('createGoogleResolver', () => {
  it('calls the CSE endpoint with key/cx/q and parses the result', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(MARYENSZTADT_CSE), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = createGoogleResolver({ key: 'K', cx: 'C', fetchImpl });
    const out = await r.resolve('Maryensztadt', 'BA Suszona Śliwka');
    expect(out[0].bid).toBe(5158585);
    const calledUrl = (fetchImpl as unknown as vi.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('key=K');
    expect(calledUrl).toContain('cx=C');
    expect(calledUrl).toContain('q=Maryensztadt');
  });

  it('resolves [] on a non-200 (e.g. 429 quota) instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('quota', { status: 429 })) as unknown as typeof fetch;
    const r = createGoogleResolver({ key: 'K', cx: 'C', fetchImpl });
    await expect(r.resolve('a', 'b')).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/google/resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/sources/google/resolver.ts
export interface ResolvedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  abv: number | null; // best-effort from CSE pagemap; null if absent
}

export interface WebResolver {
  resolve(brewery: string, name: string): Promise<ResolvedBeer[]>;
}

interface CseItem {
  title?: unknown;
  link?: unknown;
  pagemap?: { metatags?: Array<Record<string, unknown>> };
}
export interface CseResponse {
  items?: CseItem[];
}

// Untappd beer pages are `/b/<slug>/<digits>` — same shape parsed in search.ts.
function bidFromLink(link: unknown): number | null {
  if (typeof link !== 'string') return null;
  const m = link.match(/\/b\/[^/]+\/(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// CSE title is "<Beer Name> - <Brewery> - Untappd". Split from the right so beer
// names containing " - " survive: the last two segments are brewery and the
// "Untappd" suffix.
function splitTitle(title: unknown): { beer_name: string; brewery_name: string } | null {
  if (typeof title !== 'string') return null;
  const parts = title.split(' - ').map((s) => s.trim());
  if (parts.length < 3) return null;
  const suffix = parts[parts.length - 1];
  if (!/untappd/i.test(suffix)) return null;
  const brewery_name = parts[parts.length - 2];
  const beer_name = parts.slice(0, parts.length - 2).join(' - ');
  if (!beer_name || !brewery_name) return null;
  return { beer_name, brewery_name };
}

function abvFromPagemap(item: CseItem): number | null {
  const tags = item.pagemap?.metatags;
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    for (const v of Object.values(tag)) {
      if (typeof v !== 'string') continue;
      const m = v.match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (m) {
        const n = parseFloat(m[1].replace(',', '.'));
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

export function parseCseResponse(json: CseResponse): ResolvedBeer[] {
  const items = Array.isArray(json.items) ? json.items : [];
  const out: ResolvedBeer[] = [];
  for (const item of items) {
    const bid = bidFromLink(item.link);
    if (bid === null) continue;
    const names = splitTitle(item.title);
    if (!names) continue;
    out.push({ bid, beer_name: names.beer_name, brewery_name: names.brewery_name, abv: abvFromPagemap(item) });
  }
  return out;
}

export interface GoogleResolverOpts {
  key: string;
  cx: string;
  num?: number;              // results to request (default 3)
  fetchImpl?: typeof fetch;
}

export function createGoogleResolver(opts: GoogleResolverOpts): WebResolver {
  const f = opts.fetchImpl ?? fetch;
  const num = opts.num ?? 3;
  return {
    async resolve(brewery: string, name: string): Promise<ResolvedBeer[]> {
      const q = encodeURIComponent(`${brewery} ${name}`.trim());
      const url =
        `https://www.googleapis.com/customsearch/v1` +
        `?key=${encodeURIComponent(opts.key)}&cx=${encodeURIComponent(opts.cx)}&q=${q}&num=${num}`;
      try {
        const res = await f(url);
        if (!res.ok) return []; // 429 quota / any error → "no resolution"
        return parseCseResponse((await res.json()) as CseResponse);
      } catch {
        return [];
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/google/resolver.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/sources/google/resolver.ts src/sources/google/resolver.test.ts
git commit -m "feat(#139): Google CSE WebResolver + response parse"
```

---

### Task 7: Export `hasLongSharedToken` for reuse

**Files:**
- Modify: `src/domain/untappd-lookup.ts:103`

- [ ] **Step 1: Add the export keyword**

Change the declaration at line 103 from:

```ts
function hasLongSharedToken(a: string[], b: string[]): boolean {
```

to:

```ts
export function hasLongSharedToken(a: string[], b: string[]): boolean {
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx vitest run src/domain/untappd-lookup.test.ts`
Expected: PASS (unchanged behaviour; only visibility widened).

- [ ] **Step 3: Commit**

```bash
git add src/domain/untappd-lookup.ts
git commit -m "refactor(#139): export hasLongSharedToken for gate reuse"
```

---

### Task 8: Refined-B1 gate + fallback orchestrator + wrapper

**Files:**
- Create: `src/domain/google-fallback.ts`
- Test: `src/domain/google-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/google-fallback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { gateGoogleCandidate, runGoogleFallback } from './google-fallback';
import type { ResolvedBeer, WebResolver } from '../sources/google/resolver';
import type { BeerSearch } from '../sources/untappd/search';
import pino from 'pino';

const log = pino({ level: 'silent' });
const noHydrate: BeerSearch = { search: async () => [] };

describe('gateGoogleCandidate (refined B1)', () => {
  const input = { brewery: 'Maryensztadt', name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon', abv: 11.5 };

  it('accepts same-language name-gate hit regardless of abv', () => {
    const cand: ResolvedBeer = { bid: 1000186, beer_name: 'Pan IPAni', brewery_name: 'Trzech Kumpli', abv: null };
    expect(gateGoogleCandidate({ brewery: 'Trzech Kumpli', name: 'PanIPAni', abv: null }, cand)).toBe(true);
  });

  it('accepts cross-language candidate on token overlap + abv corroboration', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 11.5,
    };
    expect(gateGoogleCandidate(input, cand)).toBe(true);
  });

  it('rejects same-brewery wrong-name beer (Artezan case) even if abv coincides', () => {
    const cand: ResolvedBeer = { bid: 2552312, beer_name: 'Te Czasy Się Skończyły', brewery_name: 'Browar Artezan', abv: 11.5 };
    expect(gateGoogleCandidate({ brewery: 'Artezan', name: 'Święty Spokój', abv: 11.5 }, cand)).toBe(false);
  });

  it('rejects a different brewery outright', () => {
    const cand: ResolvedBeer = { bid: 1, beer_name: 'Grimbergen Blanche', brewery_name: 'Brouwerij Alken-Maes', abv: 6 };
    expect(gateGoogleCandidate({ brewery: 'Carlsberg', name: 'Grimbergen blanche', abv: 6 }, cand)).toBe(false);
  });

  it('rejects token-overlap candidate when abv is out of tolerance', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 6.0,
    };
    expect(gateGoogleCandidate({ ...input, abv: 11.5 }, cand)).toBe(false);
  });

  it('rejects token-overlap candidate when input abv is missing', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 11.5,
    };
    expect(gateGoogleCandidate({ ...input, abv: null }, cand)).toBe(false);
  });
});

function seed(db: ReturnType<typeof openDb>, brewery: string, name: string) {
  return upsertBeer(db, { name, brewery, normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase() });
}
function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('runGoogleFallback', () => {
  const cross: ResolvedBeer = {
    bid: 5158585,
    beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
    brewery_name: 'Maryensztadt',
    abv: 11.5,
  };
  const input = { brewery: 'Maryensztadt', name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon', abv: 11.5 };

  it('returns a matched SearchResult, spends quota, and stamps google_tried_at', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runGoogleFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr?.bid).toBe(5158585);
    expect((db.prepare('SELECT count FROM google_quota').get() as { count: number }).count).toBe(1);
    expect(db.prepare('SELECT google_tried_at FROM beers WHERE id = ?').get(beerId)).toBeTruthy();
    db.close();
  });

  it('skips (no quota spent) when google_tried_at is within cooldown', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    db.prepare('UPDATE beers SET google_tried_at = ? WHERE id = ?').run('2026-07-20T12:00:00.000Z', beerId);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z'); // 4 days later < 30d cooldown

    const sr = await runGoogleFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS c FROM google_quota').get()).toMatchObject({ c: 0 });
    db.close();
  });

  it('returns null without calling the resolver when the day is at cap', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    db.prepare('INSERT INTO google_quota(day, count) VALUES (?, ?)').run('2026-07-24', 90);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runGoogleFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
    db.close();
  });

  it('hydrates abv from Algolia when the CSE candidate abv is null', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const noAbv: ResolvedBeer = { ...cross, abv: null };
    const resolver: WebResolver = { resolve: vi.fn(async () => [noAbv]) };
    const hydrate: BeerSearch = {
      search: vi.fn(async () => [
        { bid: 5158585, beer_name: noAbv.beer_name, brewery_name: 'Maryensztadt', style: null, abv: 11.5, global_rating: null },
      ]),
    };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runGoogleFallback({ db, resolver, hydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr?.bid).toBe(5158585);
    expect(hydrate.search).toHaveBeenCalled();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/google-fallback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/domain/google-fallback.ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { readGoogleTriedAt, stampGoogleTried } from '../storage/beers';
import { tryConsumeGoogleQuota } from '../storage/google_quota';
import { pacificDay } from './pacific-day';
import { normalizeName } from './normalize';
import {
  ABV_TOLERANCE,
  breweryAliases,
  breweryAliasesMatch,
  nameKeys,
  intersects,
} from './matcher';
import { hasLongSharedToken } from './untappd-lookup';
import { fuzzy } from 'fast-fuzzy';
import type { ResolvedBeer, WebResolver } from '../sources/google/resolver';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

const NAME_FUZZY_THRESHOLD = 0.85;
const RE_GOOGLE_COOLDOWN_DAYS = 30;

interface GateInput { brewery: string; name: string; abv: number | null }

function breweryStrict(input: GateInput, cand: ResolvedBeer): boolean {
  return breweryAliasesMatch(breweryAliases(cand.brewery_name), breweryAliases(input.brewery));
}

function nameGatePass(input: GateInput, cand: ResolvedBeer): boolean {
  // Exact name-key intersection (order-insensitive) OR fuzzy >= 0.85 on the
  // brewery-stripped normalized names — the same signals the main matcher trusts.
  if (intersects(nameKeys(cand.beer_name, cand.brewery_name), nameKeys(input.name, input.brewery))) {
    return true;
  }
  return fuzzy(normalizeName(input.name), normalizeName(cand.beer_name)) >= NAME_FUZZY_THRESHOLD;
}

function tokens(s: string): string[] {
  return normalizeName(s).split(' ').filter((t) => t.length >= 2);
}

function abvCorroborates(a: number | null, b: number | null): boolean {
  return a != null && b != null && Math.abs(a - b) <= ABV_TOLERANCE;
}

// Refined B1: brewery-strict ALWAYS required; then either the name gate passes
// (same-language) OR there is distinctive token overlap AND abv corroborates
// (cross-language). Never accept on abv alone. `cand.abv` must already be
// hydrated by the caller before the token-overlap branch is trusted.
export function gateGoogleCandidate(input: GateInput, cand: ResolvedBeer): boolean {
  if (!breweryStrict(input, cand)) return false;
  if (nameGatePass(input, cand)) return true;
  if (!hasLongSharedToken(tokens(input.name), tokens(cand.beer_name))) return false;
  return abvCorroborates(input.abv, cand.abv);
}

function toSearchResult(cand: ResolvedBeer): SearchResult {
  return {
    bid: cand.bid,
    beer_name: cand.beer_name,
    brewery_name: cand.brewery_name,
    style: null,
    abv: cand.abv,
    global_rating: null,
  };
}

export interface GoogleFallbackDeps {
  db: DB;
  resolver: WebResolver;
  hydrate: BeerSearch; // server-side Algolia, for abv hydration only
  cap: number;
  log: pino.Logger;
  now?: () => Date;
}

// Hydrate a null abv by searching Algolia for the resolved canonical name and
// taking the matching bid's abv. Best-effort: any miss leaves abv null (→ reject
// in the token-overlap branch), never throws into the caller.
async function hydrateAbv(hydrate: BeerSearch, cand: ResolvedBeer): Promise<number | null> {
  if (cand.abv != null) return cand.abv;
  try {
    const hits = await hydrate.search(cand.beer_name);
    const byId = hits.find((h) => h.bid === cand.bid);
    return (byId ?? hits[0])?.abv ?? null;
  } catch {
    return null;
  }
}

export async function runGoogleFallback(
  deps: GoogleFallbackDeps,
  input: { beerId: number; brewery: string; name: string; abv: number | null },
): Promise<SearchResult | null> {
  const now = (deps.now ?? (() => new Date()))();

  // Per-beer cooldown: don't re-spend Google on the same orphan within 30 days.
  const triedAt = readGoogleTriedAt(deps.db, input.beerId);
  if (triedAt) {
    const ageDays = (now.getTime() - new Date(triedAt).getTime()) / 86_400_000;
    if (ageDays < RE_GOOGLE_COOLDOWN_DAYS) return null;
  }

  // Daily budget guard (Pacific day). Consume BEFORE the network call.
  if (!tryConsumeGoogleQuota(deps.db, pacificDay(now), deps.cap)) return null;

  let candidates: ResolvedBeer[];
  try {
    candidates = await deps.resolver.resolve(input.brewery, input.name);
  } finally {
    // A spent call marks the beer regardless of outcome (accept or reject).
    stampGoogleTried(deps.db, input.beerId, now.toISOString());
  }

  for (const cand of candidates) {
    if (!breweryStrict(input, cand)) continue;
    if (nameGatePass(input, cand)) return toSearchResult(cand);
    if (!hasLongSharedToken(tokens(input.name), tokens(cand.beer_name))) continue;
    const abv = await hydrateAbv(deps.hydrate, cand);
    if (abvCorroborates(input.abv, abv)) return toSearchResult({ ...cand, abv });
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/google-fallback.test.ts`
Expected: PASS (all gate + orchestrator cases).

- [ ] **Step 5: Commit**

```bash
git add src/domain/google-fallback.ts src/domain/google-fallback.test.ts
git commit -m "feat(#139): refined-B1 gate + quota/cooldown-guarded Google fallback"
```

---

### Task 9: `lookupWithFallback` wrapper

**Files:**
- Modify: `src/domain/google-fallback.ts` (add wrapper + test in the same test file)
- Test: `src/domain/google-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/google-fallback.test.ts`:

```ts
import { lookupWithFallback } from './google-fallback';
import type { LookupOutcome } from './untappd-lookup';

describe('lookupWithFallback', () => {
  const matched: LookupOutcome = {
    kind: 'matched',
    result: { bid: 1, beer_name: 'A', brewery_name: 'B', style: null, abv: null, global_rating: null },
  };
  const notFoundEmpty: LookupOutcome = { kind: 'not_found', searchUrls: ['u'], candidates: [] };
  const notFoundWithCands: LookupOutcome = {
    kind: 'not_found',
    searchUrls: ['u'],
    candidates: [{ bid: 9, beer_name: 'X', brewery_name: 'Y', style: null, abv: null, global_rating: null }],
  };

  it('passes through a matched outcome without invoking the fallback', async () => {
    const fb = vi.fn();
    const out = await lookupWithFallback(async () => matched, 1, fb);
    expect(out).toBe(matched);
    expect(fb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the fallback when candidates were non-empty (matcher rejection)', async () => {
    const fb = vi.fn();
    const out = await lookupWithFallback(async () => notFoundWithCands, 1, fb);
    expect(out).toBe(notFoundWithCands);
    expect(fb).not.toHaveBeenCalled();
  });

  it('invokes the fallback on not_found + empty candidates and upgrades to matched', async () => {
    const sr = { bid: 5158585, beer_name: 'A', brewery_name: 'B', style: null, abv: 11.5, global_rating: null };
    const fb = vi.fn(async () => sr);
    const out = await lookupWithFallback(async () => notFoundEmpty, 42, fb);
    expect(out).toEqual({ kind: 'matched', result: sr });
    expect(fb).toHaveBeenCalledWith(42);
  });

  it('keeps the original not_found when the fallback yields null', async () => {
    const fb = vi.fn(async () => null);
    const out = await lookupWithFallback(async () => notFoundEmpty, 42, fb);
    expect(out).toBe(notFoundEmpty);
  });

  it('is a no-op passthrough when fallback is null (feature-flag off)', async () => {
    const out = await lookupWithFallback(async () => notFoundEmpty, 42, null);
    expect(out).toBe(notFoundEmpty);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/google-fallback.test.ts`
Expected: FAIL — `lookupWithFallback` not exported.

- [ ] **Step 3: Implement**

Add to `src/domain/google-fallback.ts` (import the type at the top: `import type { LookupOutcome } from './untappd-lookup';`):

```ts
// Runs `doLookup` (the normal matcher), and ONLY when it returns not_found with
// zero candidates — a genuine query-zeroing, not a matcher rejection of real
// candidates — invokes the Google fallback. A fallback hit upgrades the outcome
// to matched; a miss (or fallback === null) leaves the original outcome intact.
export async function lookupWithFallback(
  doLookup: () => Promise<LookupOutcome>,
  beerId: number,
  fallback: ((beerId: number) => Promise<SearchResult | null>) | null,
): Promise<LookupOutcome> {
  const outcome = await doLookup();
  if (!fallback) return outcome;
  if (outcome.kind !== 'not_found' || outcome.candidates.length > 0) return outcome;
  const sr = await fallback(beerId);
  return sr ? { kind: 'matched', result: sr } : outcome;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/google-fallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/google-fallback.ts src/domain/google-fallback.test.ts
git commit -m "feat(#139): lookupWithFallback wrapper (not_found+empty only)"
```

---

### Task 10: Wire the fallback into the cron enrich path

**Files:**
- Modify: `src/jobs/untappd-enrich.ts`
- Test: `src/jobs/untappd-enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/untappd-enrich.test.ts` (reuse its existing db/`EnrichDeps` setup; the sketch below shows the new field and assertion — adapt variable names to the file's helpers):

```ts
it('applies the Google fallback when the normal lookup yields 0 candidates', async () => {
  const db = /* existing freshDb helper */ freshDb();
  const beerId = upsertBeer(db, {
    name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon',
    brewery: 'Maryensztadt',
    normalized_name: 'ice brett porter double ba suszona sliwka i cynamon',
    normalized_brewery: 'maryensztadt',
    abv: 11.5,
  });
  // make the beer eligible
  const emptySearch = { search: async () => [] };
  const fallback = async () => ({
    bid: 5158585,
    beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
    brewery_name: 'Maryensztadt',
    style: null, abv: 11.5, global_rating: null,
  });

  const outcome = await enrichOneOrphan(
    { db, log, search: emptySearch, googleFallback: fallback },
    beerId,
  );
  expect(outcome).toBe('matched');
  expect((db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(beerId) as { untappd_id: number }).untappd_id).toBe(5158585);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/untappd-enrich.test.ts`
Expected: FAIL — `googleFallback` not a known dep / fallback not applied.

- [ ] **Step 3: Implement**

In `src/jobs/untappd-enrich.ts`, add the optional dep and route the lookup through the wrapper. Full modified file body (imports + `EnrichDeps` + `enrichOneOrphan`):

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';
import { isEligible } from '../domain/lookup-backoff';
import { lookupBeer } from '../domain/untappd-lookup';
import { lookupWithFallback } from '../domain/google-fallback';
import { applyLookupOutcome } from '../domain/lookup-outcome';
import type { EnrichOutcomeKind } from '../domain/lookup-outcome';
import { getBeer } from '../storage/beers';

export type { EnrichOutcomeKind } from '../domain/lookup-outcome';

export interface EnrichDeps {
  db: DB;
  log: pino.Logger;
  search: BeerSearch;
  now?: () => Date;
  // Optional Google 0-candidate fallback (null/undefined when unconfigured).
  googleFallback?: ((beerId: number) => Promise<SearchResult | null>) | null;
}

export async function enrichOneOrphan(
  deps: EnrichDeps,
  beerId: number,
): Promise<EnrichOutcomeKind> {
  const beer = getBeer(deps.db, beerId);
  if (!beer || beer.untappd_id !== null) return 'skipped';

  const now = (deps.now ?? (() => new Date()))();
  if (!isEligible(now, beer.untappd_lookup_at, beer.untappd_lookup_count)) {
    return 'skipped';
  }

  const outcome = await lookupWithFallback(
    () => lookupBeer({ brewery: beer.brewery, name: beer.name, abv: beer.abv, search: deps.search }),
    beerId,
    deps.googleFallback ?? null,
  );

  const nowIso = now.toISOString();
  return applyLookupOutcome(deps, beerId, outcome, nowIso, { brewery: beer.brewery, name: beer.name });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/jobs/untappd-enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/untappd-enrich.ts src/jobs/untappd-enrich.test.ts
git commit -m "feat(#139): wire Google fallback into cron enrichOneOrphan"
```

---

### Task 11: Wire the fallback into the client `/enrich/result` route

**Files:**
- Modify: `src/api/types.ts` (add optional `googleFallback` to `ApiDeps`)
- Modify: `src/api/routes/enrich.ts:124-127`
- Test: `src/api/routes/enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/api/routes/enrich.test.ts` (reuse its existing app/deps builder; the sketch shows the new deps field + a relayed-empty payload that should now match via fallback):

```ts
it('applies Google fallback on /enrich/result when the relayed search is empty', async () => {
  // build app deps with a googleFallback that resolves the beer
  const googleFallback = async () => ({
    bid: 5158585, beer_name: 'Dry Plum & Cinnamon', brewery_name: 'Maryensztadt',
    style: null, abv: 11.5, global_rating: null,
  });
  const app = /* existing makeApp helper */ makeApp({ googleFallback });
  const res = await app.request('/enrich/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      brewery: 'Maryensztadt',
      name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon',
      algolia: { hits: [] }, // relayed 0 candidates
      pageUrl: 'https://shop.example/x',
    }),
  });
  const body = await res.json();
  expect(body).toMatchObject({ status: 'matched', untappd_id: 5158585 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: FAIL — fallback not applied (`status: 'not_found'`).

- [ ] **Step 3: Implement**

In `src/api/types.ts`, add to the `ApiDeps` interface:

```ts
  // Optional Google 0-candidate fallback; null/absent when unconfigured.
  googleFallback?: ((beerId: number) => Promise<import('../sources/untappd/search').SearchResult | null>) | null;
```

In `src/api/routes/enrich.ts`, replace the `lookupBeer` call in the `/enrich/result` handler (lines ~124-127):

```ts
    const search = algolia
      ? { search: async () => parseAlgoliaResponse(algolia as AlgoliaResponse) }
      : htmlSearch(html!);
    const outcome = await lookupWithFallback(
      () => lookupBeer({ brewery, name, abv: row.abv, search }),
      row.id,
      deps.googleFallback ?? null,
    );
```

Add the import at the top of `src/api/routes/enrich.ts`:

```ts
import { lookupWithFallback } from '../../domain/google-fallback';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/types.ts src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(#139): wire Google fallback into /enrich/result route"
```

---

### Task 12: Compose the resolver + fallback in `index.ts`

**Files:**
- Modify: `src/index.ts` (near the `algoliaSearch` construction ~line 87, and the two wiring sites: cron `enrichOrphans` ~line 220 and `createApiApp` ~line 296)

- [ ] **Step 1: Build the fallback closure after `algoliaSearch`**

After the `algoliaSearch` construction, add:

```ts
import { createGoogleResolver } from './sources/google/resolver';
import { runGoogleFallback } from './domain/google-fallback';
import type { SearchResult } from './sources/untappd/search';
// ... (place the two imports with the other top-of-file imports)

// Google 0-candidate fallback (#139). Enabled only when both CSE keys are set;
// otherwise null → lookupWithFallback is a passthrough (zero behaviour change).
const googleFallback: ((beerId: number) => Promise<SearchResult | null>) | null =
  env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX
    ? (beerId: number) => {
        const beer = getBeer(db, beerId);
        if (!beer) return Promise.resolve(null);
        return runGoogleFallback(
          {
            db,
            resolver: createGoogleResolver({ key: env.GOOGLE_CSE_KEY!, cx: env.GOOGLE_CSE_CX! }),
            hydrate: algoliaSearch,
            cap: env.GOOGLE_CSE_DAILY_CAP,
            log,
          },
          { beerId, brewery: beer.brewery, name: beer.name, abv: beer.abv },
        );
      }
    : null;
```

> Ensure `getBeer` is imported in `index.ts` (add `import { getBeer } from './storage/beers';` if not already present).

- [ ] **Step 2: Pass it to the cron enrich job**

At the `enrichOrphans({ db, log, search: algoliaSearch, ... })` call (~line 220), add `googleFallback`:

```ts
      enrichOrphans({
        db, log, search: algoliaSearch, googleFallback,
        // ...existing fields unchanged...
      }),
```

> `enrichOrphans` forwards its deps to `enrichOneOrphan`. Confirm `EnrichDeps`/`EnrichOrphansDeps` in `src/jobs/enrich-orphans.ts` include `googleFallback?` and thread it through to each `enrichOneOrphan(deps, id)` call; add the optional field to that deps interface if the compiler flags it.

- [ ] **Step 3: Pass it to the API app**

At `const apiApp = createApiApp({ db, env, log });` (~line 296), add `googleFallback`:

```ts
  const apiApp = createApiApp({ db, env, log, googleFallback });
```

> If `createApiApp` builds its `ApiDeps` from these args explicitly, make sure it forwards `googleFallback` onto the `deps` object passed to the routes.

- [ ] **Step 4: Typecheck + full test run**

Run: `npm run build && npx vitest run`
Expected: build clean; all tests PASS. If `enrich-orphans.ts` or `createApiApp` need the optional `googleFallback` field threaded through, add it (it is a straight passthrough) until the build is green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/jobs/enrich-orphans.ts src/api/index.ts
git commit -m "feat(#139): compose Google resolver + fallback and wire both enrich paths"
```

---

### Task 13: Update `spec.md`

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Locate the enrichment / lookup section**

Run: `grep -n "enrich\|lookup\|candidate\|Algolia\|Untappd search" spec.md | head`
Identify the section describing the orphan lookup / enrichment pipeline.

- [ ] **Step 2: Add the fallback tier description**

Insert a subsection documenting the new tier (adapt heading level/numbering to the surrounding spec):

```markdown
#### Google fallback resolver (#139)

When the Untappd/Algolia search returns **zero** candidates for an orphan (a genuine
query-zeroing, not a matcher rejection of real candidates), the server may resolve the
beer's canonical Untappd page via the Google Custom Search JSON API (site-restricted to
`untappd.com`) and re-gate that candidate through the strict matcher.

- **Feature-flagged** by `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`; absent → no behavioural change.
- **Gate (refined B1):** brewery-strict alias match is always required; then either the
  normal name gate passes (same-language) OR there is distinctive token overlap **and** the
  ABV corroborates (cross-language). ABV alone is never sufficient.
- **ABV hydration:** CSE `pagemap` → Algolia-by-name fallback.
- **Spend guards:** a hard daily cap (`GOOGLE_CSE_DAILY_CAP`, default 90) keyed by the
  Pacific-Time date (`google_quota` table), plus a per-beer 30-day cooldown
  (`beers.google_tried_at`).
- **Covers** both the cron enrichment path and the client relay (`/enrich/result`),
  entirely server-side; the browser extension is unchanged.
```

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(#139): spec — Google fallback resolver tier"
```

---

### Task 14: Full verification

- [ ] **Step 1: Run the whole suite + build + lint**

Run: `npm run build && npx vitest run && npm run lint`
Expected: build clean, all tests green, lint clean.

- [ ] **Step 2: Confirm feature-flag-off parity**

Run: `npx vitest run src/jobs/untappd-enrich.test.ts src/api/routes/enrich.test.ts`
Expected: PASS — existing (no-`googleFallback`) tests unchanged, proving zero behaviour change when unconfigured.

---

## Post-implementation (ops — user-driven)

- Fill prod `.env` with the CSE key/cx via `tmp/set-google-cse-env.sh` (input hidden), then redeploy (`bash deploy/deploy.sh`).
- Recommend **not** enabling billing on the CSE project (429-at-101 is then a free hard stop, independent of the cap-90 guard).
- After deploy, re-arm the 0-candidate orphans so the fallback gets a chance on the existing backlog (the usual `rearm` flow; `google_tried_at` starts null so all are eligible once).
- Follow up per owner's condition: sample the fallback's accept/reject logs; if many correct beers are being rejected (cross-language with zero token overlap), revisit the gate.

## Self-Review Notes

- **Spec coverage:** resolver seam (T6), integration point/wrapper (T8-T9), refined-B1 gate incl. all 3 validation rows (T8), quota by Pacific day + cap 90 (T1-T3), re-Google guard (T4, T8), pagemap→Algolia hydration (T6, T8), config + feature-flag (T5, T12), both paths (T10-T11), no extension change (nothing touches `extension/**` or the install doc), spec.md (T13). All covered.
- **Type consistency:** `WebResolver`/`ResolvedBeer` (T6) used unchanged in T8/T12; `SearchResult`/`LookupOutcome` from existing modules; `googleFallback` signature `(beerId:number)=>Promise<SearchResult|null>` identical across T8-T12; `tryConsumeGoogleQuota(db,day,cap)` and `readGoogleTriedAt`/`stampGoogleTried` match their definitions.
- **No placeholders:** every code step is complete; the few "reuse the file's existing helper" notes concern test-harness wiring that already exists in each target test file.
