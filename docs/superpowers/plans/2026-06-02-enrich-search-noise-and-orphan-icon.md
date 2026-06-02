# Enrich Search Noise Fix + Orphan Backfill + Honest 🟢/⚪ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Untappd enrichment search from being poisoned by brewery noise words (e.g. "Brewery"), reset backoff so the ~260 affected orphans get re-enriched by the existing cron, and make the `/beers` 🟢/⚪ icon reflect real Untappd-ID presence instead of mere match-link existence.

**Architecture:** Three independent changes. (1) A pure `stripBreweryNoise` helper removes `BREWERY_NOISE` tokens from the brewery string used to build the Untappd search query, while preserving case/diacritics. (2) A one-time schema migration (v7) nulls the backoff state of orphan beers so the enrich-orphans cron retries them with the fixed query. (3) `tapsForSnapshotWithBeer` surfaces `beers.untappd_id`, and `/beers` keys the icon off it.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Jest, cheerio.

---

## File Structure

- **Modify** `src/domain/normalize.ts` — new exported `stripBreweryNoise`.
- **Modify** `src/domain/normalize.test.ts` — unit tests for `stripBreweryNoise`.
- **Modify** `src/domain/untappd-lookup.ts:43` — build query from noise-stripped brewery.
- **Modify** `src/domain/untappd-lookup.test.ts` — new "noise stripped from query" test; fix the existing `Magic%20Road%20Brewery` assertion.
- **Modify** `src/storage/schema.ts` — migration `version: 7`.
- **Modify** `src/storage/schema.test.ts` — migration v7 test.
- **Modify** `src/storage/snapshots.ts` — add `untappd_id` to `TapWithBeer` + query.
- **Modify** `src/bot/commands/beers-build.ts:64` — icon from `tap.untappd_id`.
- **Modify** `src/bot/commands/beers-build.test.ts` — orphan-with-match-link → ⚪ test.

---

## Task 1: Strip brewery noise words from the enrichment search query

**Files:**
- Modify: `src/domain/normalize.ts`
- Test: `src/domain/normalize.test.ts`
- Modify: `src/domain/untappd-lookup.ts`
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing test for `stripBreweryNoise`**

Append to `src/domain/normalize.test.ts` (add `stripBreweryNoise` to the existing import from `./normalize`):

```ts
describe('stripBreweryNoise', () => {
  test('drops a trailing "Brewery" suffix', () => {
    expect(stripBreweryNoise('JBW Brewery')).toBe('JBW');
  });
  test('drops "Browar" in any position', () => {
    expect(stripBreweryNoise('Browar Pinta')).toBe('Pinta');
  });
  test('preserves case and diacritics of non-noise tokens', () => {
    expect(stripBreweryNoise('Gościszewo Brewery')).toBe('Gościszewo');
  });
  test('multi-word brewery keeps all non-noise words', () => {
    expect(stripBreweryNoise('Trzech Kumpli Brewery')).toBe('Trzech Kumpli');
  });
  test('all-noise brewery collapses to empty string', () => {
    expect(stripBreweryNoise('Browar')).toBe('');
  });
  test('brewery with no noise words is unchanged', () => {
    expect(stripBreweryNoise('Magic Road')).toBe('Magic Road');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/normalize.test.ts -t stripBreweryNoise`
Expected: FAIL — `stripBreweryNoise` is not exported.

- [ ] **Step 3: Implement `stripBreweryNoise`**

In `src/domain/normalize.ts`, add below the existing `normalizeBrewery` function (it reuses the module-private `BREWERY_NOISE` set already defined at the top of the file):

```ts
// Remove brewery noise words ("Browar", "Brewery", "Brewing", "Co", "Company")
// from a brewery label while preserving the original case and diacritics of the
// remaining tokens. Used to build Untappd search queries: the raw ontap label
// often appends "Brewery", which Untappd's term-AND search does not find in the
// real brewery name (e.g. "JBW Brewery" vs the registered "JBW Browar").
export function stripBreweryNoise(brewery: string): string {
  return brewery
    .split(/\s+/)
    .filter((tok) => tok && !BREWERY_NOISE.has(tok.toLowerCase()))
    .join(' ')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/normalize.test.ts -t stripBreweryNoise`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing test for the lookup query**

In `src/domain/untappd-lookup.test.ts`, add a new test inside the existing `describe('lookupBeer', ...)` block. It asserts the search URL no longer carries the noise word and that the candidate still matches:

```ts
  test('strips brewery noise word from the search query', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 6172039, name: 'WOCKY TALKY', brewery: 'JBW Browar', rating: '3.18' }]),
    );
    const out = await lookupBeer({ brewery: 'JBW Brewery', name: 'Wocky Talky', fetch });

    const calledUrl = fetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('JBW%20Wocky%20Talky');
    expect(calledUrl).not.toContain('Brewery');

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6172039);
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx jest src/domain/untappd-lookup.test.ts -t "strips brewery noise"`
Expected: FAIL — the current query is `JBW%20Brewery%20Wocky%20Talky`, so `.not.toContain('Brewery')` fails (and the brewery gate rejects "JBW Browar" vs "JBW Brewery", so `matched` also fails).

- [ ] **Step 7: Wire the helper into `lookupBeer`**

In `src/domain/untappd-lookup.ts`, add `stripBreweryNoise` to the import from `./normalize`:

```ts
import { normalizeName, stripBreweryNoise } from './normalize';
```

Then change the query construction (currently line 43):

```ts
      html = await fetch(buildSearchUrl(`${part} ${name}`));
```

to:

```ts
      html = await fetch(buildSearchUrl(`${stripBreweryNoise(part)} ${name}`.trim()));
```

- [ ] **Step 8: Fix the existing assertion broken by this change**

The test `non-collab brewery: single fetch call (behaviour unchanged)` (around line 100) asserts the URL contains `Magic%20Road%20Brewery`, which no longer holds. Replace its assertion:

```ts
    await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Fifty/Fifty', fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('Magic%20Road%20Brewery'));
```

with:

```ts
    await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Fifty/Fifty', fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('Magic%20Road');
    expect(url).not.toContain('Brewery');
```

- [ ] **Step 9: Run the full lookup + normalize suites**

Run: `npx jest src/domain/untappd-lookup.test.ts src/domain/normalize.test.ts`
Expected: PASS (all, including the collab tests — their asserted parts `TankBusters`, `Blech.Brut`, `ZIEMIA%20OBIECANA` contain no noise words, so they are unaffected).

- [ ] **Step 10: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(untappd-lookup): strip brewery noise words from search query

The raw ontap brewery label (e.g. 'JBW Brewery') was used verbatim in the
Untappd search query. Untappd ANDs query terms, so the noise word 'Brewery'
— absent from the real brewery name 'JBW Browar' — zeroed the results and
left the beer an unenriched orphan. Strip BREWERY_NOISE tokens from the
query while preserving case/diacritics.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Backfill — reset orphan backoff so the cron re-enriches them

**Files:**
- Modify: `src/storage/schema.ts`
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/storage/schema.test.ts` inside the existing `describe('schema migrations', ...)` block. Migrations run once on a then-empty `beers` table, so the test pins two things: (a) v7 is registered (fails fast before v7 exists), and (b) the exact statement resets orphan backoff while leaving matched beers untouched:

```ts
  it('migration v7 is registered and resets only orphan lookup backoff', () => {
    const db = openDb(':memory:');
    migrate(db);

    // (a) v7 is registered — this is the fail-first hook (maxV is 6 before v7).
    const maxV = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(maxV).toBeGreaterThanOrEqual(7);

    // (b) the v7 statement: orphans (untappd_id NULL) get backoff cleared,
    //     matched beers (untappd_id set) are left untouched.
    db.prepare(
      `INSERT INTO beers (name, brewery, normalized_name, normalized_brewery,
         untappd_id, untappd_lookup_at, untappd_lookup_count)
       VALUES ('Wocky Talky', 'JBW Brewery', 'wocky talky', 'jbw',
         NULL, '2026-05-31T21:30:08.061Z', 3)`,
    ).run();
    db.prepare(
      `INSERT INTO beers (name, brewery, normalized_name, normalized_brewery,
         untappd_id, untappd_lookup_at, untappd_lookup_count)
       VALUES ('Atak Chmielu', 'Pinta', 'atak chmielu', 'pinta',
         12345, '2026-05-31T21:30:08.061Z', 2)`,
    ).run();
    db.exec("UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0 WHERE untappd_id IS NULL");

    const orphan = db.prepare(
      "SELECT untappd_lookup_at AS at, untappd_lookup_count AS cnt FROM beers WHERE untappd_id IS NULL",
    ).get() as { at: string | null; cnt: number };
    const matched = db.prepare(
      "SELECT untappd_lookup_at AS at, untappd_lookup_count AS cnt FROM beers WHERE untappd_id = 12345",
    ).get() as { at: string | null; cnt: number };
    expect(orphan).toEqual({ at: null, cnt: 0 });
    expect(matched).toEqual({ at: '2026-05-31T21:30:08.061Z', cnt: 2 });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/storage/schema.test.ts -t "v7 is registered"`
Expected: FAIL — `maxV` is currently 6, so `expect(maxV).toBeGreaterThanOrEqual(7)` fails.

- [ ] **Step 3: Add migration v7**

In `src/storage/schema.ts`, append to the `MIGRATIONS` array (after the `version: 6` entry):

```ts
  {
    version: 7,
    sql: `
      UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0
      WHERE untappd_id IS NULL;
    `,
  },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/storage/schema.test.ts`
Expected: PASS (all, including the new test and the existing idempotency test).

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(schema): migration v7 resets orphan lookup backoff for re-enrichment

After the search-query fix, the ~260 orphans that previously failed lookup
carry exhausted backoff state. Nulling untappd_lookup_at/count for all
untappd_id IS NULL rows lets the enrich-orphans cron retry them (~2 days at
160/day) with the corrected query. Matched beers are untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Honest 🟢/⚪ — key the icon off real `untappd_id`

**Files:**
- Modify: `src/storage/snapshots.ts`
- Modify: `src/bot/commands/beers-build.ts`
- Test: `src/bot/commands/beers-build.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/bot/commands/beers-build.test.ts` inside the existing `describe('buildBeersMessage ...')` block (the `upsertBeer`/`upsertMatch` imports already exist at the top of the file):

```ts
  test('tap matched to an orphan beers row (untappd_id NULL) shows ⚪, not 🟢', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    // Orphan beers row: created from ontap, no untappd_id yet, but match_links
    // points the ontap_ref at this row's own id (as refreshOntap does).
    const orphanId = upsertBeer(db, {
      untappd_id: null, name: 'Wocky Talky', brewery: 'JBW Brewery', style: null,
      abv: 4.2, rating_global: null,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, 'JBW Brewery Wocky Talky', orphanId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
        abv: 4.2, ibu: null, style: null, u_rating: null },
    ]);

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.html.split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toContain('⚪');
    expect(line).not.toContain('🟢');
  });

  test('tap matched to a real catalog beer (untappd_id set) shows 🟢', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 6172039, name: 'Wocky Talky', brewery: 'JBW Browar', style: null,
      abv: 4.2, rating_global: 3.18,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, 'JBW Brewery Wocky Talky', beerId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
        abv: 4.2, ibu: null, style: null, u_rating: null },
    ]);

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.html.split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toContain('🟢');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/bot/commands/beers-build.test.ts -t "orphan beers row"`
Expected: FAIL — the orphan currently renders 🟢 because the icon keys off `tap.beer_id` (the match-link's local id), which is set.

- [ ] **Step 3: Surface `untappd_id` from the tap query**

In `src/storage/snapshots.ts`, extend the `TapWithBeer` interface:

```ts
export interface TapWithBeer extends TapRow {
  beer_id: number | null;
  untappd_id: number | null;
  // u_rating on this row is the COALESCEd value: tap.u_rating ?? beers.rating_global ?? null
}
```

And add the column to the SELECT in `tapsForSnapshotWithBeer` (alongside `ml.untappd_beer_id AS beer_id`):

```ts
      COALESCE(t.u_rating, b.rating_global) AS u_rating,
      ml.untappd_beer_id AS beer_id,
      b.untappd_id AS untappd_id
```

- [ ] **Step 4: Key the icon off `untappd_id`**

In `src/bot/commands/beers-build.ts` (line 64), change:

```ts
    const icon = tap.beer_id != null ? '🟢' : '⚪';
```

to:

```ts
    const icon = tap.untappd_id != null ? '🟢' : '⚪';
```

- [ ] **Step 5: Run the beers-build suite**

Run: `npx jest src/bot/commands/beers-build.test.ts`
Expected: PASS — new tests pass; the existing "shows every tap incl. orphan" test still passes (its matched beer has `untappd_id: 1` → 🟢; its orphan 'Mystery Brew' has no match_link → `untappd_id` NULL → ⚪).

- [ ] **Step 6: Verify newbeers is unaffected**

`newbeers-build.ts` reads `tap.beer_id` (unchanged). Confirm:

Run: `npx jest src/bot/commands/newbeers-build.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/snapshots.ts src/bot/commands/beers-build.ts src/bot/commands/beers-build.test.ts
git commit -m "fix(beers): icon reflects real untappd_id, not match-link existence

match_links.untappd_beer_id is a local beers.id and is set even for orphans
(pointed at their own row), so 🟢 showed for unenriched orphans. Key the
icon off beers.untappd_id so 🟢 means a real Untappd match and ⚪ means
orphan/unmatched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Full verification + live confirmation

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, build, full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck/build exit 0; all suites pass.

- [ ] **Step 2: Confirm the fix against live Untappd**

Write `/tmp/verify-lookup.ts` and run it with `npx tsx` (enrichment uses the non-cookie HTTP client, so a plain fetch reproduces it):

```ts
import { lookupBeer } from '/home/ysi/warsaw-beer-bot/src/domain/untappd-lookup';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const fetch_ = async (url: string) => (await fetch(url, { headers: { 'User-Agent': UA } })).text();
(async () => {
  for (const [brewery, name] of [['JBW Brewery', 'Wocky Talky'], ['Trzech Kumpli Brewery', 'Old School Classic English IPA']] as const) {
    const out = await lookupBeer({ brewery, name, fetch: fetch_ });
    console.log(brewery, '/', name, '->', out.kind, out.kind === 'matched' ? `bid=${out.result.bid} ⭐${out.result.global_rating}` : '');
    await new Promise((r) => setTimeout(r, 1500));
  }
})();
```

Run: `npx tsx /tmp/verify-lookup.ts`
Expected: both print `matched` with a non-null rating (e.g. `JBW Brewery / Wocky Talky -> matched bid=6172039 ⭐3.18`).

- [ ] **Step 3: Clean up the scratch script**

Run: `rm -f /tmp/verify-lookup.ts /tmp/diag-lookup.ts /tmp/diag-lookup2.ts /tmp/diag-lookup3.ts`

---

## Notes for deployment (post-merge, not part of the plan's commits)

On deploy, `migrate()` runs v7 once, nulling orphan backoff. The enrich-orphans
cron (LIMIT 20, every 3h) then re-enriches with the fixed query, draining ~260
orphans over ~2 days. No manual SQL needed. `/beers` shows ⚪ + `—` for a given
orphan until its cron turn, then 🟢 + rating.
