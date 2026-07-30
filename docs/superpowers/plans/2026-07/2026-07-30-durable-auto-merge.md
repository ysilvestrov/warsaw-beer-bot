# Durable auto-merge (#366) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a tap whose identity was established by `mergeIntoCanonical` from re-creating the same orphan (and paying for the same Untappd/Brave lookup) on every ingest.

**Architecture:** A new nullable `match_links.merged_at` marks a link as merge-established. `mergeIntoCanonical` stamps it (and, while we are in that function, redirects `checkins` before deleting the orphan); `upsertMatch` clears it, so anything the matcher writes is by definition not merge-derived. `refreshOntap` gains one branch: on a matcher miss, a stamped link whose target still exists and has an `untappd_id` is reused instead of creating a fresh orphan.

**Tech Stack:** Node.js + TypeScript, better-sqlite3 (`src/storage/*`), Vitest, pino.

**Design doc:** `docs/superpowers/specs/2026-07/2026-07-30-durable-auto-merge-design.md`

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/storage/schema.ts` | modify (append migration v21) | additive column |
| `src/storage/match_links.ts` | modify | `MatchRow.merged_at`; `upsertMatch` clears the stamp |
| `src/storage/beers.ts:120-125` | modify | `mergeIntoCanonical`: stamp links, redirect checkins, delete orphan — one transaction |
| `src/domain/lookup-outcome.ts:41` | modify | pass `nowIso` into `mergeIntoCanonical` |
| `src/jobs/refresh-ontap.ts:106-174` | modify | reuse branch + per-run counter/log |
| `src/storage/schema.test.ts` | modify | v21 column exists |
| `src/storage/match_links.test.ts` | modify | stamp cleared by `upsertMatch` |
| `src/storage/beers.test.ts` | modify | `mergeIntoCanonical` behaviour incl. the checkins FK case |
| `src/jobs/refresh-ontap.test.ts` | modify | the three ingest branches |
| `spec.md` | modify | §3.6 column + priority order, §5.2 invariant |

No `extension/**` change → `docs/extension-install-uk.md` is deliberately untouched.

---

### Task 1: Migration v21 + `upsertMatch` clears the stamp

**Files:**
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`, after the `version: 20` entry)
- Modify: `src/storage/match_links.ts`
- Test: `src/storage/schema.test.ts`, `src/storage/match_links.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/schema.test.ts` inside the `describe('schema migrations', …)` block:

```ts
  it('v21 adds the merge stamp to match_links', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(match_links)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('merged_at');
  });
```

Append to `src/storage/match_links.test.ts`:

```ts
test('upsertMatch clears a merge stamp — a matcher write is never merge-derived', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'PINTA|atak', beerId, 1.0);
  db.prepare("UPDATE match_links SET merged_at = '2026-07-30T00:00:00Z' WHERE ontap_ref = 'PINTA|atak'").run();

  upsertMatch(db, 'PINTA|atak', beerId, 0.8);

  expect(getMatch(db, 'PINTA|atak')?.merged_at).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/storage/schema.test.ts src/storage/match_links.test.ts`
Expected: FAIL — `expect(cols).toContain('merged_at')` fails, and the second test errors on the
`UPDATE … SET merged_at` (`no such column: merged_at`).

- [ ] **Step 3: Add the migration**

In `src/storage/schema.ts`, append a new entry to `MIGRATIONS` immediately after the `version: 20` object:

```ts
  {
    version: 21,
    sql: `
      ALTER TABLE match_links ADD COLUMN merged_at TEXT;
    `,
  },
```

- [ ] **Step 4: Extend the row type and clear the stamp on matcher writes**

In `src/storage/match_links.ts`, add the field to `MatchRow`:

```ts
export interface MatchRow {
  id: number;
  ontap_ref: string;
  untappd_beer_id: number | null;
  confidence: number;
  reviewed_by_user: number;
  merged_at: string | null;   // #366: non-null ⇒ this link was established by a merge
}
```

and rewrite `upsertMatch`:

```ts
// #366: this is the matcher's write path (both call sites live in refresh-ontap), so it also
// clears merged_at. Invariant: a link written by the matcher is never merge-derived, which is
// what keeps the matcher authoritative over a remembered merge.
export function upsertMatch(db: DB, ontapRef: string, beerId: number | null, confidence: number): void {
  db.prepare(
    `INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user)
       VALUES (?, ?, ?, 0)
     ON CONFLICT(ontap_ref) DO UPDATE SET
       untappd_beer_id = excluded.untappd_beer_id,
       confidence = excluded.confidence,
       merged_at = NULL`,
  ).run(ontapRef, beerId, confidence);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/storage/schema.test.ts src/storage/match_links.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/storage/match_links.ts src/storage/schema.test.ts src/storage/match_links.test.ts
git commit -m "feat(#366): match_links.merged_at (migration v21); upsertMatch clears the stamp"
```

---

### Task 2: `mergeIntoCanonical` stamps the link and redirects check-ins

**Files:**
- Modify: `src/storage/beers.ts:117-125`
- Modify: `src/domain/lookup-outcome.ts:41`
- Test: `src/storage/beers.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/beers.test.ts` (the file already imports `openDb`, `migrate`, `upsertBeer`,
`normalizeName`, `normalizeBrewery` and defines `fresh()`; add `mergeIntoCanonical` and `getBeer` to the
existing import from `./beers`):

```ts
function mergeFixture() {
  const db = fresh();
  const canonicalId = upsertBeer(db, {
    untappd_id: 999, name: 'Marine', brewery: 'Moon Lark Brewery',
    style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Marine'), normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
  });
  const orphanId = upsertBeer(db, {
    name: 'Deep Sea Diver', brewery: 'Moon Lark Brewery',
    style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Deep Sea Diver'),
    normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
  });
  db.prepare(
    "INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user) VALUES ('Deep Sea Diver', ?, 1.0, 0)",
  ).run(orphanId);
  return { db, canonicalId, orphanId };
}

test('mergeIntoCanonical redirects the link and stamps it as merge-established', () => {
  const { db, canonicalId, orphanId } = mergeFixture();

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-07-30T10:00:00Z');

  const link = db.prepare('SELECT untappd_beer_id, merged_at FROM match_links WHERE ontap_ref = ?')
    .get('Deep Sea Diver') as { untappd_beer_id: number; merged_at: string | null };
  expect(link.untappd_beer_id).toBe(canonicalId);
  expect(link.merged_at).toBe('2026-07-30T10:00:00Z');
  expect(getBeer(db, orphanId)).toBeNull();
});

test('mergeIntoCanonical redirects check-ins instead of FK-crashing on the delete', () => {
  const { db, canonicalId, orphanId } = mergeFixture();
  db.prepare(
    "INSERT INTO checkins (checkin_id, telegram_id, beer_id, checkin_at) VALUES ('c1', 42, ?, '2026-07-30T09:00:00Z')",
  ).run(orphanId);

  expect(() => mergeIntoCanonical(db, orphanId, canonicalId, '2026-07-30T10:00:00Z')).not.toThrow();

  const checkin = db.prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?').get('c1') as { beer_id: number };
  expect(checkin.beer_id).toBe(canonicalId);
  expect(getBeer(db, orphanId)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: FAIL — the first test on the 4th argument (TS error: Expected 3 arguments, but got 4) and on
`merged_at`; the second with `FOREIGN KEY constraint failed` from the `DELETE FROM beers`.

- [ ] **Step 3: Rewrite `mergeIntoCanonical`**

Replace `src/storage/beers.ts:117-125` with:

```ts
// Merges an orphan beer into a canonical catalog entry by redirecting all match_links and
// deleting the orphan. Called when recordLookupSuccess hits a UNIQUE constraint (the found
// untappd_id already belongs to another row).
export function mergeIntoCanonical(db: DB, orphanId: number, canonicalId: number, at: string): void {
  db.transaction(() => {
    // #366: the merge is the only moment we learn "this ontap_ref is that canonical beer".
    // The stamp keeps that knowledge past the next ingest; without it refreshOntap recomputes,
    // misses again (that is why the row needed a merge) and re-creates the orphan — ~65 wasted
    // Untappd lookups a day, plus repeat metered web-fallback calls.
    db.prepare('UPDATE match_links SET untappd_beer_id = ?, merged_at = ? WHERE untappd_beer_id = ?')
      .run(canonicalId, at, orphanId);
    // checkins.beer_id → beers(id) has NO ON DELETE CASCADE and foreign_keys=ON, so a check-in
    // on the orphan would abort the DELETE. Point it at the canonical row first (as pinMatch does).
    db.prepare('UPDATE checkins SET beer_id = ? WHERE beer_id = ?').run(canonicalId, orphanId);
    db.prepare('DELETE FROM beers WHERE id = ?').run(orphanId);
  })();
  bumpCatalogVersion();
}
```

- [ ] **Step 4: Pass the timestamp at the call site**

In `src/domain/lookup-outcome.ts:41`, replace:

```ts
          mergeIntoCanonical(deps.db, beerId, canonical.id);
```

with:

```ts
          mergeIntoCanonical(deps.db, beerId, canonical.id, nowIso);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/storage/beers.test.ts src/domain/lookup-outcome.test.ts`
Expected: PASS. The existing `applyLookupOutcome merge` test must stay green unchanged — it asserts
`kind === 'merged'`, the deleted orphan and the redirected link, none of which this task alters.

- [ ] **Step 6: Commit**

```bash
git add src/storage/beers.ts src/domain/lookup-outcome.ts src/storage/beers.test.ts
git commit -m "feat(#366): mergeIntoCanonical stamps merged_at and redirects checkins"
```

---

### Task 3: Ingest reuses a merge-established link instead of re-orphaning

**Files:**
- Modify: `src/jobs/refresh-ontap.ts` (lines 39-56 for the counter, 106-137 for the branch, 175-186 for the log, and the file's import block)
- Test: `src/jobs/refresh-ontap.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these three tests to `src/jobs/refresh-ontap.test.ts` **inside the last `describe(...)` block**
(the one containing `'a fresh orphan merged by inline enrich in one pub does not FK-crash a later pub'`,
which already provides `geocoder`, `oneCity`, `beerCount` and `panel` in scope):

```ts
  test('#366: reuses a merge-stamped link instead of re-creating the orphan', async () => {
    const db = openDb(':memory:'); migrate(db);
    // The canonical row the tap really is. Its name does NOT match the tap text, so the matcher
    // cannot get there — exactly the situation a merge resolves.
    const canonicalId = upsertBeer(db, {
      untappd_id: 999, name: 'Marine', brewery: 'Moon Lark Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Marine'), normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
    });
    upsertMatch(db, 'Deep Sea Diver', canonicalId, 1.0);
    db.prepare("UPDATE match_links SET merged_at = '2026-07-30T00:00:00Z' WHERE ontap_ref = 'Deep Sea Diver'").run();

    const index = `<div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>`;
    const body = `<body>${panel(1, 'Moon Lark Brewery', 'Deep Sea Diver 6%', 'IPA')}</body>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/')
          return `<html><head><meta property="og:title" content="P / ontap.pl"></head>${body}</html>`;
        return '';
      },
    };
    let searches = 0;
    const search: BeerSearch = { search: async () => { searches++; return []; } };

    await refreshOntap({
      db, log: silentLog, http, search, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 5, lookupSleepMs: 0,
    });

    expect(beerCount(db)).toBe(1);        // no fresh orphan
    expect(searches).toBe(0);             // and therefore no Untappd lookup
    const link = getMatch(db, 'Deep Sea Diver');
    expect(link?.untappd_beer_id).toBe(canonicalId);
    expect(link?.merged_at).toBe('2026-07-30T00:00:00Z');
  });

  test('#366: a stamped link whose target is not canonical is not trusted', async () => {
    const db = openDb(':memory:'); migrate(db);
    // Stamped link pointing at a row with NO untappd_id (e.g. a target that lost its match).
    const staleId = upsertBeer(db, {
      name: 'Marine', brewery: 'Moon Lark Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Marine'), normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
    });
    upsertMatch(db, 'Deep Sea Diver', staleId, 1.0);
    db.prepare("UPDATE match_links SET merged_at = '2026-07-30T00:00:00Z' WHERE ontap_ref = 'Deep Sea Diver'").run();

    const index = `<div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>`;
    const body = `<body>${panel(1, 'Moon Lark Brewery', 'Deep Sea Diver 6%', 'IPA')}</body>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/')
          return `<html><head><meta property="og:title" content="P / ontap.pl"></head>${body}</html>`;
        return '';
      },
    };

    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder,
      cities: oneCity, lookupEnabled: false,
    });

    // Fell through to the normal orphan path: the tap now has its own catalog row.
    expect(db.prepare("SELECT COUNT(*) AS n FROM beers WHERE name = 'Deep Sea Diver'").get()).toEqual({ n: 1 });
  });

  test('#366: a matcher hit retargets the link and clears the stamp', async () => {
    const db = openDb(':memory:'); migrate(db);
    // Stamped link points at one canonical row…
    const rememberedId = upsertBeer(db, {
      untappd_id: 888, name: 'Marine', brewery: 'Moon Lark Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Marine'), normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
    });
    // …while the catalog now also holds a row the matcher can reach by name.
    const exactId = upsertBeer(db, {
      untappd_id: 999, name: 'Deep Sea Diver', brewery: 'Moon Lark Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Deep Sea Diver'),
      normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
    });
    upsertMatch(db, 'Deep Sea Diver', rememberedId, 1.0);
    db.prepare("UPDATE match_links SET merged_at = '2026-07-30T00:00:00Z' WHERE ontap_ref = 'Deep Sea Diver'").run();

    const index = `<div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>`;
    const body = `<body>${panel(1, 'Moon Lark Brewery', 'Deep Sea Diver 6%', 'IPA')}</body>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/')
          return `<html><head><meta property="og:title" content="P / ontap.pl"></head>${body}</html>`;
        return '';
      },
    };

    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder,
      cities: oneCity, lookupEnabled: false,
    });

    const link = getMatch(db, 'Deep Sea Diver');
    expect(link?.untappd_beer_id).toBe(exactId);   // matcher overrules the memory
    expect(link?.merged_at).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts -t '#366'`
Expected: FAIL — the first test finds `beerCount(db) === 2` (a fresh orphan was created) and
`searches === 1`; the third finds `merged_at` still stamped only if Task 1 was skipped (with Task 1 in
place it already passes — leave it, it is the regression guard for the invariant).

- [ ] **Step 3: Add the reuse branch**

In `src/jobs/refresh-ontap.ts`:

(a) extend the `match_links` import to bring in the row type:

```ts
import { upsertMatch, getMatch, type MatchRow } from '../storage/match_links';
```

(b) declare the counter next to the other per-run state (after `let inlineEnrichStopped = false;`):

```ts
  let reusedMergedLinks = 0;
```

(c) replace the pin lookup and the match/orphan branch (currently lines 108-137) with:

```ts
          // Curated pin: a human fixed this tap's Untappd link (reviewed_by_user = 1).
          // Never recompute it — the tap row is already persisted by insertTaps above,
          // and the pinned target beer stays in the catalog for other taps to match.
          const link = getMatch(db, t.beer_ref);
          if (link?.reviewed_by_user) continue;
          const identity = resolveTapIdentity(t.brewery_ref, t.beer_ref);
          if (identity.kind === 'drop') {
            discarded[identity.reason]++;
            continue;
          }
          const { brewery, name } = identity;
          const m = matchPrepared({ brewery, name, abv: t.abv }, prepared);
          let beerId: number;
          let isFreshOrphan = false;
          if (m) {
            upsertMatch(db, t.beer_ref, m.id, m.confidence);
            beerId = m.id;
          } else if (isRememberedMerge(db, link)) {
            // #366: a previous enrich already resolved this tap and merged it into the canonical
            // row the link points at. Re-creating the orphan would only get it merged again, at
            // the cost of an Untappd (or metered web-fallback) lookup. The link already points at
            // the right row, so there is nothing to write.
            reusedMergedLinks++;
            continue;
          } else {
            beerId = upsertBeer(db, {
              name,
              brewery,
              style: t.style,
              abv: t.abv,
              rating_global: t.u_rating,
              normalized_name: normalizeName(name),
              normalized_brewery: normalizeBrewery(brewery),
            });
            upsertMatch(db, t.beer_ref, beerId, 1.0);
            isFreshOrphan = true;
          }
```

(d) add the per-run log right after the `for (const city of cities)` loop closes (i.e. immediately
before the closing brace of `refreshOntap`, after the last `await onProgress(...)` line of the loop body):

```ts
  if (reusedMergedLinks > 0) {
    log.info({ reused: reusedMergedLinks }, 'ontap merged links reused');
  }
```

(e) add the helper at the bottom of the file, next to `listBeerCatalog`:

```ts
// #366: a link stamped by mergeIntoCanonical remembers which canonical row this tap is. Honour it
// only while the target still exists and is really canonical (has an untappd_id) — a stale stamp
// must fall through to the normal orphan path rather than silently pinning the tap to nothing.
function isRememberedMerge(db: DB, link: MatchRow | null): boolean {
  if (!link?.merged_at || link.untappd_beer_id == null) return false;
  return getBeer(db, link.untappd_beer_id)?.untappd_id != null;
}
```

- [ ] **Step 4: Run the whole ingest suite**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: PASS, all tests including the pre-existing
`'a fresh orphan merged by inline enrich in one pub does not FK-crash a later pub'`. That test now
exercises the new branch on the second pub (pub A merges and stamps; pub B reuses), and its assertions —
one surviving row owning bid 999, no `ontap pub refresh failed` — still hold.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "feat(#366): ingest reuses a merge-established link instead of re-orphaning the tap"
```

---

### Task 4: Spec

**Files:**
- Modify: `spec.md` §3.6 (`match_links`, around line 257) and §5.2 (business invariants, around line 1104)

- [ ] **Step 1: Add the column to the §3.6 table**

Insert one row after the `reviewed_by_user` row:

```markdown
| `merged_at` | TEXT | nullable | штамп `mergeIntoCanonical`: посилання встановив **merge**, а не матчер (#366) |
```

- [ ] **Step 2: Document the ingest priority order in §3.6**

Add after the "Куровані піни" paragraph:

```markdown
**Пам'ять про merge (`merged_at`).** Коли enrich знаходить bid, який уже належить іншому рядку,
`mergeIntoCanonical` переспрямовує посилання на канонічний рядок і **штампує `merged_at`**. Порядок
пріоритетів в ingest (`refresh-ontap`), від найсильнішого:

1. пін (`reviewed_by_user = 1`) — кран не переобраховується взагалі;
2. влучання матчера — посилання перезаписується, `merged_at` скидається в NULL (матчер завжди головний);
3. промах матчера + `merged_at IS NOT NULL` + жива ціль із `beers.untappd_id` — посилання
   перевикористовується: ні нової сироти, ні inline-enrich (лічильник `ontap merged links reused`);
4. інакше — нова сирота + посилання + inline-enrich.

Без п.3 кожен інжест створював сироту заново, знову її збагачував і знову зливав: ~65 зайвих запитів
до Untappd на добу і повторні платні виклики web-fallback на той самий кран (#366).
```

- [ ] **Step 3: Add the invariant to §5.2**

Append one bullet to the §5.2 list, in the style of the surrounding bullets:

```markdown
- **Ідентичність, здобута merge-ом, переживає повторний інжест, але поступається матчеру.**
  `merged_at` ставить лише `mergeIntoCanonical`; будь-який запис матчера (`upsertMatch`) його скидає.
  Довіряти штампу лише поки ціль існує і має `beers.untappd_id`.
```

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(#366): spec — match_links.merged_at and the ingest priority order"
```

---

### Task 5: Full verification and PR

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, build, full test suite**

```bash
npm run typecheck && npm run build && npx vitest run
```
Expected: typecheck and build clean; every test green. Baseline before this work is **1639** tests
(from PR #365) — the count must be baseline + 7 (2 in Task 1, 2 in Task 2, 3 in Task 3).

- [ ] **Step 2: Confirm the migration applies to a copy of the real schema**

```bash
npx tsx -e "import {openDb} from './src/storage/db'; import {migrate} from './src/storage/schema'; const db=openDb(':memory:'); migrate(db); console.log(db.prepare('SELECT MAX(version) v FROM schema_version').get()); console.log(db.prepare('PRAGMA table_info(match_links)').all().map((c:any)=>c.name).join(','));"
```
Expected: `{ v: 21 }` and a column list containing `merged_at`.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "fix(#366): durable auto-merge — stop re-orphaning merged taps every ingest" --body "$(cat <<'EOF'
Closes #366.

`mergeIntoCanonical` now stamps `match_links.merged_at` (migration v21) and redirects `checkins`
before deleting the orphan; `upsertMatch` clears the stamp, so anything the matcher writes stays
authoritative. `refreshOntap` gains one branch: on a matcher miss, a stamped link whose target still
exists and has an `untappd_id` is reused instead of creating a fresh orphan.

Production evidence: 1823 auto-merges in 30 days over 98 canonical targets (~65/day), and 38% of the
metered Brave spend in the 07-28…07-30 window went to one tap re-orphaning five times.

Design: `docs/superpowers/specs/2026-07/2026-07-30-durable-auto-merge-design.md`
Plan: `docs/superpowers/plans/2026-07/2026-07-30-durable-auto-merge.md`

Post-deploy check (two ingest cycles, ~1 day): `enrich: merged duplicate orphan into canonical` drops
from ~65/day to single digits while the new `ontap merged links reused` counter takes over the same
volume. Both dropping would mean taps are being lost, not remembered.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_018rQqgyW4diwt5ttVPdNaAH
EOF
)"
```

- [ ] **Step 4: Wait for the AI review, then read and assess every finding**

Poll the PR review by head SHA, verify each finding against the code, fix the valid ones and rebut the
wrong ones in a PR comment. Do **not** merge — the user merges.
