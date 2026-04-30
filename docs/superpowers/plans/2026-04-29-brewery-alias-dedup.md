# Brewery Alias Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the bot from recommending already-drunk beers when the Untappd brewery name uses a `" / "` alias (bilingual or collab) that ontap.pl renders as just one half. Beer matching must reconcile both sides; existing duplicate catalog rows must be merged.

**Architecture:** Two coordinated changes. (1) `matchBeer` learns brewery aliases at lookup time — for each candidate row and the input, expand `"X / Y"` into `[X, Y, full]`, normalize each, match if alias sets intersect AND name matches. No schema change, no normalizer change. (2) An idempotent dedupe job walks `beers`, finds orphan ontap-side rows that pair with a real Untappd-side row via the new alias logic, repoints `match_links`/`checkins` to the canonical row, deletes the orphan. Job runs at startup — costs one indexed query when the catalog is clean.

**Tech Stack:** TypeScript, better-sqlite3, Jest, Telegraf 4.x. No new dependencies.

---

## Background (read first)

Today's bug: user has a check-in for `Juicilicious` brewed by `Piwne Podziemie / Beer Underground` (Untappd brewery name; CSV import gives `beer_id = 8396`, `normalized_brewery = "piwne podziemie beer underground"`). Ontap.pl shows the same beer with brewery `Piwne Podziemie Brewery`, normalized to `"piwne podziemie"`. The current `matchBeer` filters the catalog by exact-equal normalized brewery; row 8396 isn't visible, so no match is found, and `refresh-ontap` calls `upsertBeer` to create a fresh row 11814 (`untappd_id = NULL`). `match_links` then points the ontap_ref `"Juicilicious"` at 11814. The user's drunk-set contains 8396 but not 11814, so the tap surfaces in `/newbeers`/`/route`.

Scope check (run on prod DB): at least 7 distinct slash-aliased breweries already in the catalog (`Piwne Podziemie / Beer Underground`, `Кумпель / Kumpel`, `36По / 36Po`, `Київська Мануфактура Пива / Kyiv Beer Manufactory`, `ЛИСПИ / Діміорс`, `Browar Cztery Ściany / Four Walls Brewery`, `Symbiose Brewing / Blending`). At least 2 confirmed duplicate pairs for one of them. Pattern affects both bilingual aliases (`X / X-translated`) and collabs (`Brewery1 / Brewery2`); the matching logic treats them identically because for either case the ontap brand is one half of the Untappd two-half string.

---

## File Structure

**New files:**
```
src/jobs/dedupe-brewery-aliases.ts          # Idempotent dedupe — exported function + log summary
src/jobs/dedupe-brewery-aliases.test.ts     # In-memory DB seed + assertions
```

**Modified files:**
```
src/domain/matcher.ts                       # alias-aware exact + fuzzy lookup
src/domain/matcher.test.ts                  # new cases: bilingual alias, collab L/R, negative
src/index.ts                                # call dedupeBreweryAliases(db, log) on startup, after migrate()
docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md   # one §14 lessons entry
```

Why startup-side invocation: idempotent + no extra ops surface. After first boot post-deploy, the catalog is clean and subsequent calls find 0 pairs and return (a single SQL query, ~ms).

---

## Task 1: Brewery alias expansion in `matchBeer`

**Files:**
- Modify: `src/domain/matcher.ts:23-56`
- Modify: `src/domain/matcher.test.ts` (append)

The current matcher does `normalizeBrewery(c.brewery) === nb`. Replace with alias-set intersection. Same change applies to the fuzzy pool filter.

- [ ] **Step 1: Write failing tests**

Append to `src/domain/matcher.test.ts`:

```ts
describe('matchBeer — slash-alias breweries', () => {
  test('exact: ontap "Piwne Podziemie Brewery" hits Untappd row "Piwne Podziemie / Beer Underground"', () => {
    const catalog: CatalogBeer[] = [
      { id: 8396, brewery: 'Piwne Podziemie / Beer Underground', name: 'Juicilicious', abv: 6.0 },
    ];
    const m = matchBeer(
      { brewery: 'Piwne Podziemie Brewery', name: 'Juicilicious', abv: 6.0 },
      catalog,
    );
    expect(m).toEqual({ id: 8396, confidence: 1, source: 'exact' });
  });

  test('exact: reverse direction also works', () => {
    const catalog: CatalogBeer[] = [
      { id: 1, brewery: 'Piwne Podziemie Brewery', name: 'X', abv: null },
    ];
    const m = matchBeer(
      { brewery: 'Piwne Podziemie / Beer Underground', name: 'X' },
      catalog,
    );
    expect(m?.id).toBe(1);
    expect(m?.source).toBe('exact');
  });

  test('exact: collab — ontap shows left brewery, Untappd has "A / B"', () => {
    const catalog: CatalogBeer[] = [
      { id: 42, brewery: 'AleBrowar / Poppels Bryggeri', name: 'Son Of The Son', abv: 8.0 },
    ];
    const m = matchBeer(
      { brewery: 'AleBrowar', name: 'Son Of The Son', abv: 8.0 },
      catalog,
    );
    expect(m).toEqual({ id: 42, confidence: 1, source: 'exact' });
  });

  test('exact: collab — ontap shows right brewery', () => {
    const catalog: CatalogBeer[] = [
      { id: 42, brewery: 'AleBrowar / Poppels Bryggeri', name: 'Son Of The Son', abv: 8.0 },
    ];
    const m = matchBeer(
      { brewery: 'Poppels Bryggeri Brewery', name: 'Son Of The Son', abv: 8.0 },
      catalog,
    );
    expect(m?.id).toBe(42);
    expect(m?.source).toBe('exact');
  });

  test('negative: brewery alias does not bridge unrelated names', () => {
    const catalog: CatalogBeer[] = [
      { id: 1, brewery: 'Piwne Podziemie / Beer Underground', name: 'Different Beer', abv: null },
    ];
    const m = matchBeer(
      { brewery: 'Piwne Podziemie Brewery', name: 'Juicilicious' },
      catalog,
    );
    // Name doesn't match; alias overlap alone is not enough.
    expect(m).toBeNull();
  });

  test('negative: completely different brewery — no alias overlap', () => {
    const catalog: CatalogBeer[] = [
      { id: 1, brewery: 'Piwne Podziemie / Beer Underground', name: 'Juicilicious', abv: null },
    ];
    const m = matchBeer(
      { brewery: 'Browar Stu Mostów', name: 'Juicilicious' },
      catalog,
    );
    expect(m).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
npx jest src/domain/matcher.test.ts
```

Expected: the 6 new cases fail (matcher's exact filter compares `normalizeBrewery(c.brewery) === nb` strictly).

- [ ] **Step 3: Implement alias expansion**

Replace `src/domain/matcher.ts` body. Keep imports and types as-is; rewrite `matchBeer` and add a private helper:

```ts
import { Searcher } from 'fast-fuzzy';
import { normalizeName, normalizeBrewery } from './normalize';

export interface CatalogBeer {
  id: number;
  brewery: string;
  name: string;
  abv: number | null;
}

export interface MatchResult {
  id: number;
  confidence: number;
  source: 'exact' | 'fuzzy';
}

const FUZZY_THRESHOLD = 0.75;
const ABV_TOLERANCE = 0.3;

// Untappd records breweries either as a single name ("Piwne Podziemie Brewery")
// or as a "X / Y" alias used for two purposes:
//   • bilingual presentation — "Piwne Podziemie / Beer Underground", same brewery
//   • collaboration — "AleBrowar / Poppels Bryggeri", two different breweries
// Ontap.pl renders only one half. For matching purposes both cases collapse to:
// "the brewery on either side of '/' is also a valid brewery for this beer".
export function brewerySlashAliases(brewery: string): string[] {
  const full = normalizeBrewery(brewery);
  if (!brewery.includes(' / ')) return full ? [full] : [];
  const parts = brewery.split(' / ').map((p) => normalizeBrewery(p)).filter(Boolean);
  const all = [full, ...parts].filter(Boolean);
  return Array.from(new Set(all));
}

function brewerySetsOverlap(a: string[], b: Set<string>): boolean {
  return a.some((x) => b.has(x));
}

export function matchBeer(
  input: { brewery: string; name: string; abv?: number | null },
  catalog: CatalogBeer[],
): MatchResult | null {
  const inputAliases = new Set(brewerySlashAliases(input.brewery));
  const nn = normalizeName(input.name);

  // Exact-normalized hits — multiple rows are common when Untappd has
  // several vintages of the same beer. Latest id first.
  const exacts = catalog
    .filter(
      (c) =>
        brewerySetsOverlap(brewerySlashAliases(c.brewery), inputAliases) &&
        normalizeName(c.name) === nn,
    )
    .sort((a, b) => b.id - a.id);

  if (exacts.length) {
    const wantAbv = input.abv ?? null;
    if (wantAbv !== null) {
      const abvHit = exacts.find(
        (c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE,
      );
      if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };
    }
    return { id: exacts[0].id, confidence: 1, source: 'exact' };
  }

  // Fuzzy fallback: prefer rows whose brewery aliases overlap the input's,
  // otherwise full catalog.
  const pool = catalog.filter((c) =>
    brewerySetsOverlap(brewerySlashAliases(c.brewery), inputAliases),
  );
  const candidates = pool.length ? pool : catalog;
  const searcher = new Searcher(candidates, {
    keySelector: (c) => `${normalizeBrewery(c.brewery)} ${normalizeName(c.name)}`,
    threshold: FUZZY_THRESHOLD,
    returnMatchData: true,
  });
  // Use the first alias as the search seed — full normalized brewery already
  // appears at index 0 of brewerySlashAliases when no slash is present.
  const seedBrewery = Array.from(inputAliases)[0] ?? '';
  const results = searcher.search(`${seedBrewery} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}
```

- [ ] **Step 4: Run tests and verify pass**

```bash
npx jest src/domain/matcher.test.ts
```

Expected: all matcher tests pass (existing + 6 new).

- [ ] **Step 5: Run full suite**

```bash
npx tsc --noEmit && npx jest
```

Expected: 165 + 6 = 171 tests pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "fix(matcher): handle bilingual + collab brewery aliases (X / Y)"
```

---

## Task 2: Dedupe job — `src/jobs/dedupe-brewery-aliases.ts`

**Files:**
- Create: `src/jobs/dedupe-brewery-aliases.ts`
- Create: `src/jobs/dedupe-brewery-aliases.test.ts`

The job is idempotent: it finds duplicate pairs caused by past matcher misses, repoints `match_links` + `checkins`, deletes orphan rows. Returns a summary for the log.

**Selection criteria** (a "duplicate pair" `(canonical A, orphan B)`):
- `A.normalized_name = B.normalized_name`
- `A.untappd_id IS NOT NULL` (canonical row, came from a CSV/JSON import)
- `B.untappd_id IS NULL` (orphan, came from `refresh-ontap` upsertBeer fallback)
- `A.brewery` contains `' / '` (limits the pattern to slash-alias cases only — keeps the job conservative; legacy ABV-polluted rows are out of scope)
- `B.normalized_brewery` is one of `brewerySlashAliases(A.brewery)` (the orphan's brewery is one half of the alias)

If multiple A's match a single B, pick the lowest `A.id` (deterministic; usually the earliest import).

- [ ] **Step 1: Write failing tests**

Create `src/jobs/dedupe-brewery-aliases.test.ts`:

```ts
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import pino from 'pino';
import { upsertBeer } from '../storage/beers';
import { upsertMatch } from '../storage/match_links';
import { mergeCheckin } from '../storage/checkins';
import { ensureProfile } from '../storage/user_profiles';
import { dedupeBreweryAliases } from './dedupe-brewery-aliases';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const silentLog = pino({ level: 'silent' });

describe('dedupeBreweryAliases', () => {
  test('returns zero when catalog is clean', () => {
    const db = fresh();
    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 0, beersDeleted: 0 });
  });

  test('merges Piwne-Podziemie style alias pair', () => {
    const db = fresh();
    // Canonical Untappd-side row.
    const aId = upsertBeer(db, {
      untappd_id: 1905189,
      name: 'Juicilicious',
      brewery: 'Piwne Podziemie / Beer Underground',
      style: 'NEIPA',
      abv: 6.0,
      rating_global: null,
      normalized_name: 'juicilicious',
      normalized_brewery: 'piwne podziemie beer underground',
    });
    // Orphan ontap-side row.
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Juicilicious',
      brewery: 'Piwne Podziemie Brewery',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'juicilicious',
      normalized_brewery: 'piwne podziemie',
    });
    upsertMatch(db, 'Juicilicious', bId, 1.0);

    // User check-in on canonical row.
    ensureProfile(db, 207079110);
    mergeCheckin(db, {
      checkin_id: 'ck-1',
      telegram_id: 207079110,
      beer_id: aId,
      user_rating: 4.25,
      checkin_at: '2026-04-01T00:00:00Z',
      venue: null,
    });

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 1, beersDeleted: 1 });

    // match_links now points to canonical row.
    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Juicilicious') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(aId);

    // Orphan row gone.
    const orphan = db.prepare('SELECT id FROM beers WHERE id = ?').get(bId);
    expect(orphan).toBeUndefined();

    // Canonical row intact, check-in intact.
    const canon = db.prepare('SELECT id, untappd_id FROM beers WHERE id = ?').get(aId) as { id: number; untappd_id: number };
    expect(canon.untappd_id).toBe(1905189);
    const ck = db.prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?').get('ck-1') as { beer_id: number };
    expect(ck.beer_id).toBe(aId);
  });

  test('moves checkins from orphan onto canonical when both have check-ins', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 12345, name: 'Y', brewery: 'X / Y',
      style: null, abv: null, rating_global: null,
      normalized_name: 'y', normalized_brewery: 'x y',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'Y', brewery: 'X',
      style: null, abv: null, rating_global: null,
      normalized_name: 'y', normalized_brewery: 'x',
    });
    ensureProfile(db, 1);
    mergeCheckin(db, { checkin_id: 'a', telegram_id: 1, beer_id: aId, user_rating: 4.0, checkin_at: '2026-01-01T00:00:00Z', venue: null });
    mergeCheckin(db, { checkin_id: 'b', telegram_id: 1, beer_id: bId, user_rating: 3.5, checkin_at: '2026-01-02T00:00:00Z', venue: null });

    dedupeBreweryAliases(db, silentLog);

    const all = db.prepare('SELECT checkin_id, beer_id FROM checkins ORDER BY checkin_id').all() as { checkin_id: string; beer_id: number }[];
    expect(all).toEqual([
      { checkin_id: 'a', beer_id: aId },
      { checkin_id: 'b', beer_id: aId },
    ]);
  });

  test('handles collab orphan (right-side ontap brewery)', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 999, name: 'Son Of The Son', brewery: 'AleBrowar / Poppels Bryggeri',
      style: null, abv: 8.0, rating_global: null,
      normalized_name: 'son of son', normalized_brewery: 'alebrowar poppels bryggeri',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'Son Of The Son', brewery: 'Poppels Bryggeri Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: 'son of son', normalized_brewery: 'poppels bryggeri',
    });
    upsertMatch(db, 'Son Of The Son', bId, 1.0);

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result.pairsMerged).toBe(1);

    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Son Of The Son') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(aId);
  });

  test('does NOT merge when the orphan brewery is unrelated', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 111, name: 'Z', brewery: 'X / Y',
      style: null, abv: null, rating_global: null,
      normalized_name: 'z', normalized_brewery: 'x y',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'Z', brewery: 'Browar Stu Mostów',
      style: null, abv: null, rating_global: null,
      normalized_name: 'z', normalized_brewery: 'stu mostow',
    });

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 0, beersDeleted: 0 });
    // Both rows still present.
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(aId)).toBeDefined();
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(bId)).toBeDefined();
  });

  test('idempotent — second run is a no-op', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 1, name: 'N', brewery: 'X / Y',
      style: null, abv: null, rating_global: null,
      normalized_name: 'n', normalized_brewery: 'x y',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'N', brewery: 'X',
      style: null, abv: null, rating_global: null,
      normalized_name: 'n', normalized_brewery: 'x',
    });
    upsertMatch(db, 'N', bId, 1.0);

    const r1 = dedupeBreweryAliases(db, silentLog);
    expect(r1.pairsMerged).toBe(1);
    const r2 = dedupeBreweryAliases(db, silentLog);
    expect(r2).toEqual({ pairsMerged: 0, beersDeleted: 0 });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
npx jest src/jobs/dedupe-brewery-aliases.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the job**

Create `src/jobs/dedupe-brewery-aliases.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { brewerySlashAliases } from '../domain/matcher';

interface PairCandidate {
  canonical_id: number;
  canonical_brewery: string;
  orphan_id: number;
  orphan_norm_brewery: string;
}

export interface DedupeResult {
  pairsMerged: number;
  beersDeleted: number;
}

export function dedupeBreweryAliases(db: DB, log: pino.Logger): DedupeResult {
  // Find candidates: same normalized_name, A has untappd_id + slash, B has neither.
  // Return brewery raw so we can compute aliases in JS (SQLite has no JS regex).
  const candidates = db
    .prepare(
      `SELECT
         a.id AS canonical_id,
         a.brewery AS canonical_brewery,
         b.id AS orphan_id,
         b.normalized_brewery AS orphan_norm_brewery
       FROM beers a
       JOIN beers b
         ON a.normalized_name = b.normalized_name
        AND a.id <> b.id
       WHERE a.untappd_id IS NOT NULL
         AND b.untappd_id IS NULL
         AND a.brewery LIKE '% / %'
       ORDER BY a.id, b.id`,
    )
    .all() as PairCandidate[];

  // Filter to pairs where the orphan brewery actually overlaps an alias of canonical.
  // Group by orphan_id to ensure each orphan is merged into its earliest canonical.
  const pairsByOrphan = new Map<number, PairCandidate>();
  for (const c of candidates) {
    const aliases = new Set(brewerySlashAliases(c.canonical_brewery));
    if (!aliases.has(c.orphan_norm_brewery)) continue;
    if (!pairsByOrphan.has(c.orphan_id)) pairsByOrphan.set(c.orphan_id, c);
  }

  if (pairsByOrphan.size === 0) {
    log.info({ pairs: 0 }, 'dedupe-brewery-aliases: catalog clean');
    return { pairsMerged: 0, beersDeleted: 0 };
  }

  const updateLinks = db.prepare(
    'UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?',
  );
  const updateCheckins = db.prepare(
    'UPDATE checkins SET beer_id = ? WHERE beer_id = ?',
  );
  const deleteBeer = db.prepare('DELETE FROM beers WHERE id = ?');

  const tx = db.transaction((pairs: PairCandidate[]) => {
    for (const p of pairs) {
      updateLinks.run(p.canonical_id, p.orphan_id);
      updateCheckins.run(p.canonical_id, p.orphan_id);
      deleteBeer.run(p.orphan_id);
    }
  });
  tx(Array.from(pairsByOrphan.values()));

  const merged = pairsByOrphan.size;
  log.info(
    { pairs: merged },
    'dedupe-brewery-aliases: merged orphan ontap rows into canonical Untappd rows',
  );
  return { pairsMerged: merged, beersDeleted: merged };
}
```

- [ ] **Step 4: Run tests and verify pass**

```bash
npx jest src/jobs/dedupe-brewery-aliases.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Run full suite**

```bash
npx tsc --noEmit && npx jest
```

Expected: 171 + 6 = 177 tests pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/dedupe-brewery-aliases.ts src/jobs/dedupe-brewery-aliases.test.ts
git commit -m "feat(jobs): idempotent dedupe of slash-alias brewery duplicates"
```

---

## Task 3: Wire dedupe into startup

**Files:**
- Modify: `src/index.ts:18` (add import alongside the other `./jobs/*` imports)
- Modify: `src/index.ts:26` (insert call on the line right after `migrate(db);`)

- [ ] **Step 1: Add the import**

In `src/index.ts`, on a new line right after `import { refreshAllUntappd } from './jobs/refresh-untappd';` (currently line 19):

```ts
import { dedupeBreweryAliases } from './jobs/dedupe-brewery-aliases';
```

- [ ] **Step 2: Add the call**

In `src/index.ts`, on a new line right after `migrate(db);` (currently line 26), inside `main()`:

```ts
  dedupeBreweryAliases(db, log);
```

The function is synchronous, idempotent, and logs the merge count via the `log` instance.

- [ ] **Step 3: Verify typecheck + full suite**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc, 177 tests pass (no test changes here; this is wiring).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(bot): run brewery-alias dedupe at startup"
```

---

## Task 4: Canonical spec — log the lesson

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` (§14 lessons-learned, append after the i18n entry)

- [ ] **Step 1: Append the lessons entry**

After the `**i18n (uk + pl + en)**:` block in §14, add:

```markdown
- **Brewery alias dedup (slash form)**: Untappd uses `"X / Y"` brewery names
  for two different things — bilingual presentation
  (`Piwne Podziemie / Beer Underground`) and collabs
  (`AleBrowar / Poppels Bryggeri`). Ontap.pl renders only one half. The
  matcher (`src/domain/matcher.ts`) treats both cases identically: it
  expands a brewery into the set `{full, left, right}` of normalized
  aliases and treats two beers as the same when alias sets overlap AND
  normalized names match. A startup-time idempotent job
  (`src/jobs/dedupe-brewery-aliases.ts`) merges any pre-existing duplicate
  catalog rows the old strict matcher had created; it's a no-op once the
  catalog is clean. Legacy ABV-polluted ontap rows
  (`Pilsner Urquell Brewery Pilsner Urquell 11.8°·4,4% — Pilsner` as
  beer name) are out of scope for this fix — separate cleanup task.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs(spec): log brewery-alias dedup lesson in §14"
```

---

## Task 5: Manual smoke verification (post-deploy)

This is a PR-checklist item, **not** part of any commit.

- [ ] On staging or a copy of prod DB: run the bot once. Check logs — `dedupe-brewery-aliases` should report a non-zero `pairs` count on the first boot, then 0 on subsequent boots.
- [ ] Verify on prod DB after deploy:
  ```sql
  -- Should return zero rows after first boot:
  SELECT a.id, b.id FROM beers a JOIN beers b
    ON a.normalized_name = b.normalized_name AND a.id <> b.id
   WHERE a.untappd_id IS NOT NULL AND b.untappd_id IS NULL
     AND a.brewery LIKE '% / %';
  ```
- [ ] In Telegram: `/newbeers` should no longer surface `Piwne Podziemie / Beer Underground — Juicilicious` for the affected user (telegram_id=207079110).
- [ ] In Telegram: `/route 5` for the same user — header should not list any beer they've checked in.
- [ ] Trigger `/refresh` once; confirm no fresh duplicate rows are created (a follow-up SQL check on the same query returns zero).

---

## Done criteria

Branch `fix/brewery-alias-dedup` is ready for PR when:
- Tasks 1–4 committed.
- `npx tsc --noEmit && npx jest` passes (177 tests).
- Task 5 smoke checks pass post-deploy.

PR title: `fix(matcher): bilingual + collab brewery aliases — match across "X / Y" forms`.
