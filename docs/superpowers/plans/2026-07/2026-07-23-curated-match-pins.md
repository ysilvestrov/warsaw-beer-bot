# Curated Match Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give name-divergent orphans a durable, human-curated Untappd link (a "pin") that the on-tap ingest never auto-rematches away, plus a tested `pin-match` ops tool to create/undo/list pins.

**Architecture:** Revive the dead `match_links.reviewed_by_user` column as the pin flag. A one-line guard in the on-tap ingest loop (`src/jobs/refresh-ontap.ts`) skips re-matching any tap whose link is pinned. A pure, tested `pinMatch`/`unpin`/`listPins` module in `src/domain/pin-match.ts` performs the DB mutation for both cases (merge into an existing canonical row, or set `untappd_id` on the orphan's own row). A thin CLI (`scripts/pin-match.ts`) wraps it.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Vitest. Follows existing `scripts/rearm-*.ts` CLI conventions and `src/storage/*` helpers.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-23-curated-match-pins-design.md`

---

## File Structure

- Create `src/domain/pin-match.ts` — pure DB operations: `pinMatch`, `unpinByRef`, `unpinByBeer`, `listPins`, plus the `PinResult`/`PinRow` types. Owns the merge-vs-set decision. Prod-reachable via `dist`.
- Create `src/domain/pin-match.test.ts` — unit tests for the above.
- Modify `src/jobs/refresh-ontap.ts` — add the pin guard in the per-tap loop; import `getMatch`.
- Modify `src/jobs/refresh-ontap.test.ts` — add a test proving a pinned tap survives ingest.
- Create `scripts/pin-match.ts` — CLI wrapper (`npm run pin-match`), mirrors `scripts/rearm-matcher-bug-orphans.ts`.
- Create `scripts/pin-match.test.ts` — unit test for URL→bid parsing.
- Modify `package.json` — add the `pin-match` npm script.
- Modify `spec.md` — document curated pins as a matcher behavior.

---

## Task 1: `pinMatch` core operation

**Files:**
- Create: `src/domain/pin-match.ts`
- Test: `src/domain/pin-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/pin-match.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { upsertMatch, getMatch } from '../storage/match_links';
import { recordEnrichFailure } from '../storage/enrich_failures';
import { pinMatch } from './pin-match';

function newDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function orphan(db: ReturnType<typeof openDb>, brewery: string, name: string): number {
  return upsertBeer(db, {
    untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase(),
  });
}

const AT = '2026-07-23T12:00:00.000Z';

describe('pinMatch', () => {
  test('merge case: redirects the orphan link to the canonical row, pins it, deletes orphan', () => {
    const db = newDb();
    const canonicalId = upsertBeer(db, {
      untappd_id: 6614460, name: 'Banany Na Rauszu 2026', brewery: 'ReCraft',
      style: null, abv: null, rating_global: 4.1,
      normalized_name: 'banany na rauszu 2026', normalized_brewery: 'recraft',
    });
    upsertMatch(db, 'Banany Na Rauszu', canonicalId, 1.0);
    const orphanId = orphan(db, 'Recraft / Z INNEJ BECZKI Brewery', 'Urodzinowe');
    upsertMatch(db, 'Urodzinowe', orphanId, 1.0);
    recordEnrichFailure(db, {
      beer_id: orphanId, brewery: 'Recraft', name: 'Urodzinowe', search_url: '',
      source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: AT,
    });

    const res = pinMatch(db, orphanId, 6614460, AT);

    expect(res).toEqual({ kind: 'merged', canonicalId, redirected: 1 });
    expect(getBeer(db, orphanId)).toBeNull();                    // orphan gone
    const link = getMatch(db, 'Urodzinowe');
    expect(link?.untappd_beer_id).toBe(canonicalId);             // redirected
    expect(link?.reviewed_by_user).toBe(1);                      // pinned
    expect(getMatch(db, 'Banany Na Rauszu')?.reviewed_by_user).toBe(0); // canonical's own link untouched
    expect(db.prepare('SELECT COUNT(*) AS n FROM enrich_failures').get()).toEqual({ n: 0 }); // CASCADE
  });

  test('new-bid case: sets untappd_id on the orphan row, pins its link, clears failure', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    recordEnrichFailure(db, {
      beer_id: orphanId, brewery: 'CYDR Fizz', name: 'Pear taste', search_url: '',
      source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: AT,
    });

    const res = pinMatch(db, orphanId, 1093012, AT);

    expect(res).toEqual({ kind: 'set', beerId: orphanId });
    expect(getBeer(db, orphanId)?.untappd_id).toBe(1093012);
    expect(getMatch(db, 'Pear taste')?.reviewed_by_user).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM enrich_failures').get()).toEqual({ n: 0 });
  });

  test('idempotent: re-pinning an already-pinned beer is a no-op that keeps the flag', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    pinMatch(db, orphanId, 1093012, AT);

    const res = pinMatch(db, orphanId, 1093012, AT);

    expect(res).toEqual({ kind: 'set', beerId: orphanId });
    expect(getBeer(db, orphanId)?.untappd_id).toBe(1093012);
    expect(getMatch(db, 'Pear taste')?.reviewed_by_user).toBe(1);
  });

  test('unknown beer: returns noop without throwing', () => {
    const db = newDb();
    const res = pinMatch(db, 99999, 1093012, AT);
    expect(res.kind).toBe('noop');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/pin-match.test.ts`
Expected: FAIL — `pinMatch` is not exported from `./pin-match` (module missing).

- [ ] **Step 3: Implement `pinMatch`**

Create `src/domain/pin-match.ts`:

```ts
import type { DB } from '../storage/db';
import { bumpCatalogVersion } from '../storage/catalog-version';

export type PinResult =
  | { kind: 'merged'; canonicalId: number; redirected: number }
  | { kind: 'set'; beerId: number }
  | { kind: 'noop'; reason: string };

// Curate a durable match pin for a name-divergent orphan. Two data-model cases:
//  - the target bid already belongs to a canonical row → MERGE (redirect + pin the
//    orphan's links to the canonical row, delete the orphan; enrich_failures CASCADE);
//  - the bid is new → SET untappd_id on the orphan's own row and pin its links.
// Idempotent. The pin (reviewed_by_user = 1) is what the ingest guard honours.
export function pinMatch(db: DB, beerId: number, untappdId: number, at: string): PinResult {
  const beer = db
    .prepare('SELECT id, untappd_id FROM beers WHERE id = ?')
    .get(beerId) as { id: number; untappd_id: number | null } | undefined;
  if (!beer) return { kind: 'noop', reason: `beer ${beerId} not found` };

  const canonical = db
    .prepare('SELECT id FROM beers WHERE untappd_id = ?')
    .get(untappdId) as { id: number } | undefined;

  return db.transaction((): PinResult => {
    if (canonical && canonical.id !== beerId) {
      const info = db
        .prepare('UPDATE match_links SET untappd_beer_id = ?, reviewed_by_user = 1 WHERE untappd_beer_id = ?')
        .run(canonical.id, beerId);
      db.prepare('DELETE FROM beers WHERE id = ?').run(beerId); // enrich_failures CASCADE-drop
      bumpCatalogVersion();
      return { kind: 'merged', canonicalId: canonical.id, redirected: info.changes as number };
    }
    // New bid (or already this bid) → set on the orphan's own row and pin its links.
    db.prepare('UPDATE beers SET untappd_id = ?, untappd_lookup_at = ? WHERE id = ?')
      .run(untappdId, at, beerId);
    db.prepare('UPDATE match_links SET reviewed_by_user = 1 WHERE untappd_beer_id = ?').run(beerId);
    db.prepare('DELETE FROM enrich_failures WHERE beer_id = ?').run(beerId);
    bumpCatalogVersion();
    return { kind: 'set', beerId };
  })();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/pin-match.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/pin-match.ts src/domain/pin-match.test.ts
git commit -m "feat(matcher): #343 pinMatch core — durable curated match pins"
```

---

## Task 2: `unpinByRef`, `unpinByBeer`, `listPins`

**Files:**
- Modify: `src/domain/pin-match.ts`
- Test: `src/domain/pin-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/pin-match.test.ts` (add `unpinByRef, unpinByBeer, listPins` to the import from `./pin-match`):

```ts
describe('unpin & list', () => {
  test('unpinByRef clears the flag for a merged pin addressed by its ontap_ref', () => {
    const db = newDb();
    const canonicalId = upsertBeer(db, {
      untappd_id: 6614460, name: 'Banany Na Rauszu 2026', brewery: 'ReCraft',
      style: null, abv: null, rating_global: null,
      normalized_name: 'banany na rauszu 2026', normalized_brewery: 'recraft',
    });
    const orphanId = orphan(db, 'Recraft', 'Urodzinowe');
    upsertMatch(db, 'Urodzinowe', orphanId, 1.0);
    pinMatch(db, orphanId, 6614460, AT); // merges → 'Urodzinowe' pinned to canonicalId

    expect(unpinByRef(db, 'Urodzinowe')).toBe(1);
    expect(getMatch(db, 'Urodzinowe')?.reviewed_by_user).toBe(0);
    expect(getMatch(db, 'Urodzinowe')?.untappd_beer_id).toBe(canonicalId); // link itself stays
  });

  test('unpinByBeer clears the flag for a same-row pin', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    pinMatch(db, orphanId, 1093012, AT);

    expect(unpinByBeer(db, orphanId)).toBe(1);
    expect(getMatch(db, 'Pear taste')?.reviewed_by_user).toBe(0);
  });

  test('listPins returns all pinned links with their beer + untappd_id', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    pinMatch(db, orphanId, 1093012, AT);

    expect(listPins(db)).toEqual([
      { ontap_ref: 'Pear taste', beer_id: orphanId, brewery: 'CYDR Fizz', name: 'Pear taste', untappd_id: 1093012 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/pin-match.test.ts`
Expected: FAIL — `unpinByRef`/`unpinByBeer`/`listPins` not exported.

- [ ] **Step 3: Implement**

Append to `src/domain/pin-match.ts`:

```ts
export interface PinRow {
  ontap_ref: string;
  beer_id: number;
  brewery: string;
  name: string;
  untappd_id: number | null;
}

// Undo a pin by its ontap_ref (reliable for merged pins whose orphan row is gone).
export function unpinByRef(db: DB, ontapRef: string): number {
  return db
    .prepare('UPDATE match_links SET reviewed_by_user = 0 WHERE ontap_ref = ? AND reviewed_by_user = 1')
    .run(ontapRef).changes as number;
}

// Undo a pin by the beer it points at (natural for same-row pins whose orphan survives).
export function unpinByBeer(db: DB, beerId: number): number {
  return db
    .prepare('UPDATE match_links SET reviewed_by_user = 0 WHERE untappd_beer_id = ? AND reviewed_by_user = 1')
    .run(beerId).changes as number;
}

export function listPins(db: DB): PinRow[] {
  return db
    .prepare(
      `SELECT ml.ontap_ref AS ontap_ref, ml.untappd_beer_id AS beer_id,
              b.brewery AS brewery, b.name AS name, b.untappd_id AS untappd_id
         FROM match_links ml
         JOIN beers b ON b.id = ml.untappd_beer_id
        WHERE ml.reviewed_by_user = 1
        ORDER BY ml.ontap_ref`,
    )
    .all() as PinRow[];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/pin-match.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/pin-match.ts src/domain/pin-match.test.ts
git commit -m "feat(matcher): #343 unpin + listPins helpers"
```

---

## Task 3: Ingest guard — pinned taps are never auto-rematched

**Files:**
- Modify: `src/jobs/refresh-ontap.ts` (import line 11; loop at line 100–105)
- Test: `src/jobs/refresh-ontap.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing top-level `describe` block area of `src/jobs/refresh-ontap.test.ts` (the `panel(...)` helper and `silentLog` are already defined at module scope; add imports `getMatch` from `../storage/match_links` and `upsertMatch` from `../storage/match_links` at the top if not present):

```ts
test('leaves a pinned tap link untouched instead of re-matching it', async () => {
  const db = openDb(':memory:');
  migrate(db);

  // Canonical target beer (already matched) + a curated pin whose ontap_ref does NOT
  // describe it, so normal matching would re-orphan the tap and clobber the link.
  const canonicalId = upsertBeer(db, {
    untappd_id: 6614460, name: 'Banany Na Rauszu 2026', brewery: 'ReCraft',
    style: null, abv: null, rating_global: 4.1,
    normalized_name: normalizeName('Banany Na Rauszu 2026'),
    normalized_brewery: normalizeBrewery('ReCraft'),
  });
  upsertMatch(db, 'Urodzinowe', canonicalId, 1.0);
  db.prepare("UPDATE match_links SET reviewed_by_user = 1 WHERE ontap_ref = 'Urodzinowe'").run();

  const indexHtml = `
    <div onclick="location.assign('https://mixed.ontap.pl/')">
      <div class="panel-body">Mixed Pub 1 taps</div>
    </div>
  `;
  const pubHtml = `
    <html><head><meta property="og:title" content="Mixed Pub / ontap.pl"></head>
    <body>${panel(1, 'Recraft', 'Urodzinowe 5%', 'Ale')}</body></html>
  `;
  const http: Http = {
    async get(url: string): Promise<string> {
      if (url === 'https://ontap.pl/warszawa') return indexHtml;
      if (url === 'https://mixed.ontap.pl/') return pubHtml;
      throw new Error(`Unexpected URL ${url}`);
    },
  };

  await refreshOntap({
    db, log: silentLog, http, search: { search: async () => [] }, geocoder: async () => null,
    lookupEnabled: false, cities: CITIES.filter((c) => c.slug === 'warszawa'),
  });

  // The pin held: 'Urodzinowe' still points at the canonical row, still flagged,
  // and no fresh orphan was created for it.
  const link = getMatch(db, 'Urodzinowe');
  expect(link?.untappd_beer_id).toBe(canonicalId);
  expect(link?.reviewed_by_user).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM beers WHERE name = 'Urodzinowe'").get()).toEqual({ n: 0 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts -t "pinned tap"`
Expected: FAIL — without the guard, ingest creates a `Urodzinowe` orphan and `upsertMatch` repoints the link away from `canonicalId` (the count assertion and/or `untappd_beer_id` assertion fails).

- [ ] **Step 3: Add the guard**

In `src/jobs/refresh-ontap.ts`, extend the import on line 11:

```ts
import { upsertMatch, getMatch } from '../storage/match_links';
```

Then in the per-tap loop, immediately after the `isOntapEmptyTapRef` check (currently line 101) and before `normalizeOntapTapIdentity`, add:

```ts
          // Curated pin: a human fixed this tap's Untappd link (reviewed_by_user = 1).
          // Never recompute it — the tap row is already persisted by insertTaps above,
          // and the pinned target beer stays in the catalog for other taps to match.
          const pinned = getMatch(db, t.beer_ref);
          if (pinned?.reviewed_by_user) continue;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "feat(matcher): #343 ingest guard — never auto-rematch a pinned tap"
```

---

## Task 4: `pin-match` CLI

**Files:**
- Create: `scripts/pin-match.ts`
- Test: `scripts/pin-match.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test for bid parsing**

Create `scripts/pin-match.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { parseBid } from './pin-match';

describe('parseBid', () => {
  test('extracts the trailing id from an Untappd beer URL', () => {
    expect(parseBid('https://untappd.com/b/a-le-coq-cider-fizz-pear-taste/1093012')).toBe(1093012);
  });
  test('accepts a bare numeric id', () => {
    expect(parseBid('6614460')).toBe(6614460);
  });
  test('tolerates a trailing slash', () => {
    expect(parseBid('https://untappd.com/b/x/6614460/')).toBe(6614460);
  });
  test('returns null for garbage', () => {
    expect(parseBid('not-a-bid')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/pin-match.test.ts`
Expected: FAIL — `parseBid` not exported from `./pin-match`.

- [ ] **Step 3: Implement the CLI**

Create `scripts/pin-match.ts` (mirrors `scripts/rearm-matcher-bug-orphans.ts` for env/db handling):

```ts
import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';
import { pinMatch, unpinByRef, unpinByBeer, listPins } from '../src/domain/pin-match';
import { loadOperatorEnv } from './operator-env';

loadOperatorEnv();

// Accepts a full Untappd beer URL (…/b/<slug>/<bid>) or a bare numeric id.
export function parseBid(input: string): number | null {
  const m = input.match(/(\d+)\/?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) ? n : null;
}

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): void {
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    if (argv.includes('--list')) {
      for (const p of listPins(db)) {
        console.log(`${p.ontap_ref}  →  #${p.beer_id} ${p.brewery} / ${p.name}  (untappd ${p.untappd_id})`);
      }
      return;
    }

    if (argv.includes('--unpin')) {
      const ref = argVal(argv, '--ref');
      const beer = argVal(argv, '--beer');
      if (ref) {
        console.log(`Unpinned ${unpinByRef(db, ref)} link(s) for ref "${ref}".`);
      } else if (beer) {
        console.log(`Unpinned ${unpinByBeer(db, parseInt(beer, 10))} link(s) for beer ${beer}.`);
      } else {
        console.error('--unpin requires --ref <ontap_ref> or --beer <id>');
        process.exitCode = 1;
      }
      return;
    }

    const beer = argVal(argv, '--beer');
    const untappd = argVal(argv, '--untappd');
    if (!beer || !untappd) {
      console.error('Usage: pin-match --beer <id> --untappd <url|bid> | --unpin (--ref <r> | --beer <id>) | --list');
      process.exitCode = 1;
      return;
    }
    const bid = parseBid(untappd);
    if (bid == null) {
      console.error(`Could not parse an Untappd bid from "${untappd}"`);
      process.exitCode = 1;
      return;
    }
    const res = pinMatch(db, parseInt(beer, 10), bid, new Date().toISOString());
    console.log(JSON.stringify(res));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run scripts/pin-match.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the npm script**

In `package.json`, add to `"scripts"` (after the `rearm-*` entries):

```json
    "pin-match": "tsx scripts/pin-match.ts",
```

- [ ] **Step 6: Commit**

```bash
git add scripts/pin-match.ts scripts/pin-match.test.ts package.json
git commit -m "feat(ops): #343 pin-match CLI (pin/unpin/list)"
```

---

## Task 5: Update `spec.md`

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Locate the matching section**

Run: `grep -n "match_links\|reviewed_by_user\|enrich\|orphan" spec.md | head`
Read the surrounding matching/enrichment section to find where match-link behavior is described.

- [ ] **Step 2: Add the curated-pin behavior**

In the matching section, add a paragraph describing curated pins. Use this text (adapt heading level/wording to the surrounding style):

```markdown
### Curated match pins

A `match_links` row with `reviewed_by_user = 1` is a **curated pin**: a human has fixed
this tap's Untappd identity for a beer whose name diverges from Untappd in a way no
algorithm can bridge (e.g. a shop's `Urodzinowe` that is Untappd `Banany Na Rauszu 2026`).
The on-tap ingest never recomputes a pinned tap's match, and the enrichment cron never
revisits it (the pinned beer is no longer an orphan). Pins are created, undone, and listed
with `npm run pin-match` (`--beer/--untappd`, `--unpin --ref/--beer`, `--list`). A pin is
keyed on the scraped beer-name string (`ontap_ref`); if a shop later reuses the exact same
string for a different beer the pin must be undone by hand — it does not self-correct.
```

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): #343 document curated match pins"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — all suites green, including the three new test files.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Confirm the CLI wires up (dry, against a throwaway DB)**

Run: `npx tsx scripts/pin-match.ts --list`
Expected: exits 0 (prints nothing on an empty pin set, or the current pins against the configured DB). Do NOT run any mutating `--beer/--untappd` invocation against prod here — the prod pin is a separate rollout step performed by the operator after merge (see the spec's Rollout section: pin `33280 → 28831`).

---

## Rollout (post-merge, operator-run — not part of the coding tasks)

After this branch is merged and deployed:

1. Pin `33280 → 28831` in prod via the tested path (or equivalent verified SQL run as the
   `warsaw-beer-bot` user), then confirm `beers` id `33280` is gone, the `Urodzinowe`
   `match_link` points at `28831` with `reviewed_by_user = 1`, and its `enrich_failures`
   row is cleared.
2. Confirm `33238` (already linked on 2026-07-23) shows a `rating_global` after the next
   rating-refresh cron.
3. Close #343 noting: 33238 linked, 33280 pinned, durable tool shipped for the class.
