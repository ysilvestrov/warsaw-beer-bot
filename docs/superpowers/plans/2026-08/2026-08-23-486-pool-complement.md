# #486 — Pool Complement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two enrich candidate pools one predicate and its negation, so that every orphan outside the `not_a_beer`/retired/locked exclusions belongs to exactly one pool.

**Architecture:** `src/storage/beers.ts` gains one exported SQL fragment, `onLatestTapPredicate` ("this beer is on a tap on some pub's latest snapshot", `beers` alias `b` baked in). `listLookupCandidates` interpolates it; the shared relay/metric predicate interpolates `NOT` + it and is renamed. `orphanWithoutMatchLinkPredicate` is deleted. Nothing else about the pools changes — same exclusions, same ordering, same `isEligible` filter.

**Tech Stack:** TypeScript (CommonJS, `tsc`), better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-23-486-pool-complement-design.md`

## Global Constraints

- **Predicate fragments bake in the `beers` alias `b`.** Every call site must `FROM beers b`. Fragments are WHERE-clause fragments only: no `WHERE` keyword, no `SELECT`, no `ORDER BY`, no `LIMIT`.
- **`lockedRowPredicate` stays appended at the two pool call sites, never folded into the shared fragment.** The digest metric deliberately counts locked rows; folding it in would make the backlog look like it shrank when it only went quiet. This is pinned by an existing test (`stats.test.ts`, "orphansOffCron still counts a row that is locked out of the pools").
- **The digest metric must keep sharing its predicate with the relay pool**, so the two cannot drift.
- **No re-arm, no data migration, no deletion of `match_links` rows.** Reachability must not depend on a cleaning job.
- **Every new test must be mutation-proven**: revert the production change, watch the new test go red, restore. A test that stays green against the old code is not a test.
- Language of comments follows the surrounding file (this codebase mixes English and Ukrainian; match the neighbours).
- Run the full suite with `npm test`; typecheck with `npm run typecheck`.

---

### Task 1: The complement predicate

**Files:**
- Modify: `src/storage/beers.ts:278-395` (add `onLatestTapPredicate`, rewrite `listLookupCandidates`'s inline EXISTS and `orphanWithoutMatchLinkPredicate`)
- Test: `src/storage/beers.test.ts` (add to the existing `describe('listLookupCandidates')` block, which already imports both pool functions at line 229)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const onLatestTapPredicate: string` — an `EXISTS (...)` SQL fragment; and `export const orphanNotOnTapPredicate: string` — replaces `orphanWithoutMatchLinkPredicate`, same three-clause shape (`b.untappd_id IS NULL` + not_a_beer/retired exclusion + **`NOT ${onLatestTapPredicate}`**). Task 3 imports `orphanNotOnTapPredicate` in `src/storage/stats.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/storage/beers.test.ts`, inside the existing `describe('listLookupCandidates', ...)` block (it already has the `seedBeerOnTap` helper and imports `listLookupCandidates, listRelayLookupCandidates` at line 229):

```typescript
  // #486: the gap between the two pools, reduced to one row. The beer was on a tap once,
  // that snapshot is no longer the pub's latest, and the `match_links` row outlives it.
  // Before the fix it is in NEITHER pool: the on-tap join wants a latest-snapshot tap and
  // the relay predicate wants no link at all. spec.md called this deliberate; #486 measured
  // 462 of 911 live orphans sitting in it, 376 never queried once.
  test('#486: a beer whose tap left the latest snapshot is in exactly one pool', () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      untappd_id: null, name: 'Dunkelweizen', brewery: 'Weihenstephaner',
      style: null, abv: null, rating_global: null,
      normalized_name: 'dunkelweizen', normalized_brewery: 'weihenstephaner',
    });
    const pubId = upsertPub(db, {
      slug: 'pub-486', name: 'Pub 486', address: null, lat: null, lon: null, city: 'warszawa',
    });
    const ref = 'Weihenstephaner Dunkelweizen';

    // The beer was poured on an older snapshot...
    const oldSnap = createSnapshot(db, pubId, '2026-05-01T12:00:00Z');
    upsertMatch(db, ref, beerId, 1.0);
    insertTaps(db, oldSnap, [{
      tap_number: 1, beer_ref: ref, brewery_ref: 'Weihenstephaner',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    // ...and the pub's LATEST snapshot pours something else.
    const newSnap = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');
    insertTaps(db, newSnap, [{
      tap_number: 1, beer_ref: 'Something Else', brewery_ref: 'Other',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    const now = new Date('2026-05-26T12:00:00Z');
    const onTap = listLookupCandidates(db, 10, now).map((c) => c.id);
    const relay = listRelayLookupCandidates(db, 10, now).map((c) => c.id);

    expect(onTap).not.toContain(beerId);   // correct: nobody is pouring it
    expect(relay).toContain(beerId);       // the point of #486: relay is the complement
  });
```

If `fresh`, `upsertBeer`, `upsertPub`, `createSnapshot`, `insertTaps` or `upsertMatch` are not already imported in this test file, add them to the existing imports at the top rather than creating new import lines mid-file.

- [ ] **Step 2: Run the test and confirm it fails for the right reason**

Run: `npx vitest run src/storage/beers.test.ts -t "#486"`

Expected: FAIL on the last assertion — `relay` does not contain `beerId`. If it fails on `onTap` instead, the seed is wrong (the beer is being treated as currently on tap) — fix the seed, not the assertion.

- [ ] **Step 3: Extract the on-tap predicate**

In `src/storage/beers.ts`, immediately after `lockedRowPredicate` (which ends at line 285), add:

```typescript
// #486: the single definition of "this beer is on a tap right now" — a `match_links` row
// reaching a tap on some pub's LATEST snapshot. `listLookupCandidates` interpolates it as-is;
// `orphanNotOnTapPredicate` below interpolates its negation, which is what makes the two pools
// a partition rather than two conditions that merely looked complementary. Bakes in the `beers`
// alias `b`, like the fragments around it; WHERE-clause fragment only.
export const onLatestTapPredicate = `EXISTS (
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
         )`;
```

Then, in `listLookupCandidates`, replace the inline `AND EXISTS ( ... )` block (currently lines 314-325, the one joining `match_links → taps → tap_snapshots → latest`) with:

```typescript
         AND ${onLatestTapPredicate}
```

- [ ] **Step 4: Rewrite the shared predicate as the negation**

Replace `orphanWithoutMatchLinkPredicate` (lines 351-360, including the comment block above it that starts `// #368: shared WHERE predicate`) with:

```typescript
// #368/#486: shared WHERE predicate — "orphan that is NOT on a tap right now" (untappd_id
// IS NULL, minus not_a_beer/retired, minus anything currently on a latest-snapshot tap). Used
// by listRelayLookupCandidates below (the drain query) AND by orphansRelayQueue in stats.ts
// (the digest metric), so the two can't silently diverge if one is edited later. Bakes in `b`
// as the `beers` table alias — every call site must FROM/JOIN beers AS b. Fragment only, no
// WHERE keyword/SELECT/ORDER BY/LIMIT — each caller keeps owning its own query shape. The
// digest metric interpolates this as-is and deliberately skips the JS-side backoff filter
// (isEligible) applied below: it counts the whole drain queue, not just the slice eligible to
// query right now.
//
// #486: the third clause is the NEGATION of onLatestTapPredicate, not an independent test.
// It used to be `NOT EXISTS(match_links)`, which is strictly narrower — a beer whose link no
// longer reaches a latest-snapshot tap satisfied neither pool and became unreachable by any
// cron. spec.md called that deliberate; it cost 462 of 911 orphans, 376 of them never queried
// once. Writing it as the negation makes the partition a property of the construction.
export const orphanNotOnTapPredicate = `b.untappd_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND (ef.review_class = 'not_a_beer' OR ef.retired_at IS NOT NULL)
         )
         AND NOT ${onLatestTapPredicate}`;
```

Then update the one reference inside `listRelayLookupCandidates` (line 381): `WHERE ${orphanWithoutMatchLinkPredicate}` becomes `WHERE ${orphanNotOnTapPredicate}`.

Also fix the two stale references to the old name in the comment above `lookupCandidates`/`lockedRowPredicate` (lines 273-277 mention `orphanWithoutMatchLinkPredicate` twice) — rename them to `orphanNotOnTapPredicate` so no comment names a symbol that no longer exists.

- [ ] **Step 5: Keep the build green — rename the import in the one other consumer**

`src/storage/stats.ts` imports `orphanWithoutMatchLinkPredicate`; that name no longer exists. Change the import and its single use site (`orphansOffCron`'s query, line ~103) to `orphanNotOnTapPredicate`. **Change nothing else in stats.ts** — the metric keeps its old field name and comment until Task 3, which owns the rename. Do not leave an alias export behind in `beers.ts`; the old name must be gone.

This is the mechanical fallout of a rename, not the metric change, and it belongs here so this task ends with a green build.

- [ ] **Step 6: Run the full suite and the typecheck**

Run: `npm test`
Expected: the `#486` test PASSES and everything else still passes — including `stats.test.ts`, whose `orphansOffCron` assertions now read the wider predicate. **If a stats test fails here, do not edit it: stop and report.** A stats assertion that moves is a behaviour change in the digest, which is Task 3's subject and needs its own review. (The known one is `stats.test.ts:140` case 3 — a beer with a link and no tap. Under the old predicate it was excluded; under the new one it is in the relay pool and counted.)

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Mutation-prove the test**

Temporarily change the third clause of `orphanNotOnTapPredicate` back to:

```typescript
         AND NOT EXISTS (
           SELECT 1 FROM match_links ml WHERE ml.untappd_beer_id = b.id
         )`;
```

Run: `npx vitest run src/storage/beers.test.ts -t "#486"`
Expected: FAIL. Then restore the negation and confirm it passes again. If it passed with the old clause, the test is not testing the fix — fix the test before continuing.

- [ ] **Step 8: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/storage/stats.ts
git commit -m "fix(#486): the relay pool becomes the complement of the on-tap pool"
```

---

### Task 2: The partition, asserted

**Files:**
- Test: `src/storage/beers.test.ts` (new `describe` block after the existing pool describes)

**Interfaces:**
- Consumes: `listLookupCandidates`, `listRelayLookupCandidates` (already imported at line 229); `onLatestTapPredicate` is NOT imported — this task tests behaviour, not SQL text.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the property test**

The invariant from the spec: every orphan that is not `not_a_beer`, not retired and not locked appears in **exactly one** pool. This is about MEMBERSHIP, so the seed must keep the two later filters out of the way — every seeded row eligible under `isEligible` (`untappd_lookup_count = 0`, which `upsertBeer` gives by default) and a `limit` far above the seed size. Otherwise the test measures slicing, not partitioning.

Add to `src/storage/beers.test.ts`:

```typescript
describe('#486 pool partition', () => {
  // The invariant stated as an assertion instead of a comment: with one predicate and its
  // negation, an orphan cannot fall between the pools however its taps and links are arranged.
  // Every case below is a shape that exists in production.
  test('every eligible orphan is in exactly one pool, across every tap/link arrangement', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'partition', name: 'Partition', address: null, lat: null, lon: null, city: 'warszawa',
    });
    const oldSnap = createSnapshot(db, pubId, '2026-05-01T12:00:00Z');
    const newSnap = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');

    const mk = (name: string): number => upsertBeer(db, {
      untappd_id: null, name, brewery: 'Br', style: null, abv: null, rating_global: null,
      normalized_name: name.toLowerCase(), normalized_brewery: 'br',
    });

    // 1. on a tap on the latest snapshot
    const current = mk('Current');
    upsertMatch(db, 'ref-current', current, 1.0);
    insertTaps(db, newSnap, [{
      tap_number: 1, beer_ref: 'ref-current', brewery_ref: 'Br',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    // 2. link + tap, but only on the OLDER snapshot (the #486 gap)
    const rotatedOff = mk('RotatedOff');
    upsertMatch(db, 'ref-rotated', rotatedOff, 1.0);
    insertTaps(db, oldSnap, [{
      tap_number: 2, beer_ref: 'ref-rotated', brewery_ref: 'Br',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    // 3. link whose ref matches no tap at all (retention deleted them)
    const deadLink = mk('DeadLink');
    upsertMatch(db, 'ref-dead-no-tap-anywhere', deadLink, 1.0);

    // 4. no link at all (shop-sourced relay orphan)
    const noLink = mk('NoLink');

    const now = new Date('2026-05-26T12:00:00Z');
    const onTap = listLookupCandidates(db, 100, now).map((c) => c.id);
    const relay = listRelayLookupCandidates(db, 100, now).map((c) => c.id);

    // Exactly one, for every arrangement. The membership pair is asserted as a labelled
    // tuple so a failure names the beer and which side it fell on, instead of "false !== true".
    const membership = [current, rotatedOff, deadLink, noLink].map((id) => ({
      id, onTap: onTap.includes(id), relay: relay.includes(id),
    }));
    expect(membership).toEqual([
      { id: current,    onTap: true,  relay: false },
      { id: rotatedOff, onTap: false, relay: true  },
      { id: deadLink,   onTap: false, relay: true  },
      { id: noLink,     onTap: false, relay: true  },
    ]);
    // and the split is the one we intend, not merely disjoint
    expect(onTap).toEqual([current]);
    expect(relay.sort()).toEqual([rotatedOff, deadLink, noLink].sort());
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/storage/beers.test.ts -t "partition"`
Expected: PASS (Task 1 already made it true).

- [ ] **Step 3: Mutation-prove it**

Same mutation as Task 1 Step 6 — restore `NOT EXISTS(match_links)` in `orphanNotOnTapPredicate`.
Run: `npx vitest run src/storage/beers.test.ts -t "partition"`
Expected: FAIL on `rotatedOff` (in neither pool). Restore the negation.

- [ ] **Step 4: Commit**

```bash
git add src/storage/beers.test.ts
git commit -m "test(#486): assert the pool partition instead of documenting it"
```

---

### Task 3: The metric says what it counts

**Files:**
- Modify: `src/storage/stats.ts:14-17` (the `orphansOffCron` field + its comment) and `:102-104` (the query)
- Modify: `src/jobs/daily-status.ts:24` (the digest line)
- Test: `src/storage/stats.test.ts:53`, `:140-167`, `:174-189`; `src/jobs/daily-status.test.ts:19`

**Interfaces:**
- Consumes: `orphanNotOnTapPredicate` from Task 1 (`src/storage/beers.ts`).
- Produces: `StatusMetrics.orphansRelayQueue: number` — replaces `orphansOffCron`. `daily-status.ts` is its only renderer.

- [ ] **Step 1: Update the metric and its comment**

Task 1 already renamed the import in `src/storage/stats.ts`. Replace the field declaration and its comment (lines 14-17):

```typescript
  // #368/#486: розмір черги relay-дренажу — orphan'и, яких enrich-крон бачить ЛИШЕ через
  // relay-пул (не на крані зараз), за винятком not_a_beer/retired. Той самий предикат, що
  // й у listRelayLookupCandidates, мінус backoff. Назва «offCron» була неправдою: цей
  // лічильник ніколи не міряв cron-недосяжність — після #486 недосяжних немає за побудовою.
  orphansRelayQueue: number;
```

and the query (lines 102-104):

```typescript
    orphansRelayQueue: count(
      `SELECT COUNT(*) AS c FROM beers b WHERE ${orphanNotOnTapPredicate}`,
    ),
```

- [ ] **Step 2: Update the digest line**

In `src/jobs/daily-status.ts:24`, change `${group(m.orphansOffCron)} поза cron` to `${group(m.orphansRelayQueue)} у relay-черзі`. Leave the rest of the line untouched.

- [ ] **Step 3: Update the tests, keeping their intent**

In `src/storage/stats.test.ts`:
- line 53: `orphansOffCron: 1,` → `orphansRelayQueue: 1,` (the comment about orphan `C` still holds — it has no link, so it is not on a tap).
- line 140: rename the test to `'orphansRelayQueue counts orphans not on a tap right now, minus not_a_beer/retired'` and update the three `expect`s / field reads. **Case 3 in that test changes meaning and must be re-seeded:** it currently creates a beer with a `match_links` row and no tap and asserts it is NOT counted ("крон його й так бачить"). After #486 that beer *is* in the relay pool and MUST be counted. Change that case to a beer that is genuinely on a latest-snapshot tap — add a pub, a snapshot and a tap whose `beer_ref` equals the ref passed to `upsertMatch` — and keep the assertion that it is not counted, because now it is the on-tap pool's row. Update the final expectation to the new total.
- line 174: keep this test and its intent exactly (a locked row is still counted); only the field name changes.

In `src/jobs/daily-status.test.ts:19`: `orphansOffCron: 751` → `orphansRelayQueue: 751`. If the file asserts the rendered string, update `поза cron` to `у relay-черзі` there too.

- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test`
Expected: PASS, including the Task 1 and Task 2 tests, with no remaining reference to `orphansOffCron` or `orphanWithoutMatchLinkPredicate`.

Run: `npm run typecheck`
Expected: clean.

Run: `grep -rn "orphansOffCron\|orphanWithoutMatchLinkPredicate" src/ scripts/ spec.md docs/ || echo "no stale references"`
Expected: only historical mentions inside `docs/superpowers/specs/` (design docs are a record and are not rewritten); nothing in `src/`, `scripts/` or `spec.md`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/stats.ts src/storage/stats.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "fix(#486): the digest counts the relay queue and says so"
```

---

### Task 4: spec.md tells the truth about the pools

**Files:**
- Modify: `spec.md:1327-1346` (the "Два пули кандидатів, один бюджет (#368)" section)

**Interfaces:**
- Consumes: the names introduced in Tasks 1 and 3 (`onLatestTapPredicate`, `orphanNotOnTapPredicate`, `orphansRelayQueue`).
- Produces: nothing.

`spec.md` currently asserts the opposite of what this change makes true — it calls the gap «навмисне виключення … а не дефект» and measures it at 387 rows. Leaving that in place would make the repo's source of truth contradict the code.

- [ ] **Step 1: Rewrite the section**

Replace the sentences from «Предикати взаємовиключні…» through «…щоб пул і лічильник не розійшлись.» with:

```markdown
Пули — **розбиття**, а не дві незалежні умови: єдиний предикат `onLatestTapPredicate`
(«беер на крані на останньому снапшоті хоча б одного паба») вживається в `listLookupCandidates`
позитивно, а в спільній константі `orphanNotOnTapPredicate` — під `NOT`. Тому orphan, який не
`not_a_beer`, не `retired` і не під замком, потрапляє **рівно в один** пул: обидва предикати
не можуть бути істинними разом і не можуть бути хибними разом.

До #486 relay-пул перевіряв `NOT EXISTS(match_links)` — строго вужче за заперечення. Orphan із
рядком у `match_links`, чий кран зійшов з останнього снапшоту, не потрапляв у жоден пул і ставав
недосяжним для будь-якого крона. Причина — retention: `refresh-ontap` пише лінк на кожен
розпарсений кран, `cleanup-old-snapshots` видаляє снапшоти старші за `SNAPSHOT_RETENTION_DAYS`
(дефолт 14) з каскадом на `taps`, а `match_links` живуть вічно, тож лінк «помирає» приблизно
через два тижні після того, як пиво зійшло з крана. Ця спека раніше називала таку діру навмисним
виключенням; вимір 2026-08-23 показав **462 з 911 orphan'ів у ній, 376 із них не запитані
жодного разу**, і рішення скасовано (#486).

`LIMIT 20` — **сумарний** бюджет запуску: on-tap вичерпується першим і не може бути витіснений,
relay добирає лише невикористані слоти. Обидва пули однаково виключають
`review_class = 'not_a_beer'` і `retired_at IS NOT NULL` і однаково фільтруються backoff'ом.
Спільна умова живе в експортованій константі `orphanNotOnTapPredicate` (`src/storage/beers.ts`)
і переюзається лічильником `orphansRelayQueue` у дайджесті — щоб пул і лічильник не розійшлись.
Лічильник називається «у relay-черзі», бо саме її й міряє: після #486 cron-недосяжних немає
за побудовою.
```

Keep the sentences before «Предикати взаємовиключні…» (the descriptions of the two pools) but update the relay-pool sentence so it no longer says «у яких рядка в `match_links` немає взагалі» — it now reads «які зараз не на крані». Keep the historical measurement «на 2026-08-08 це 846 із 1427 orphan'ів» as-is: it is dated and still true of that date.

- [ ] **Step 2: Check no other part of spec.md still describes the old predicate**

Run: `grep -n "orphanWithoutMatchLinkPredicate\|orphansOffCron\|поза cron" spec.md || echo "clean"`
Expected: `clean`. If a hit remains (e.g. in the #421 or retirement sections), update it to the new name in place.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(#486): spec.md — the pools are a partition, not two conditions"
```

---

### Task 5: The checkpoint issue

**Files:** none (GitHub only).

**Interfaces:** none.

- [ ] **Step 1: File the checkpoint**

The spec requires a checkpoint issue filed with the PR, due 1–2 weeks after deploy. Create it with `gh issue create`, labels `stability` and `triage-quality`, titled for the date it is due, containing the three measurements verbatim from the spec's Checkpoint section:

1. **The invariant** — count orphans in neither pool; **must be 0**. Named surprise, stated up front: a non-zero result means the complement is not a complement — investigate the query, do not adjust the number.
2. **The drain** — how many of the 428 newly-reachable rows were queried, and how many matched. A yield near zero means the population is genuinely unmatchable and the queue should be capped rather than drained.
3. **No displacement** — on-tap selections per run must not fall.

Include the runnable SQL for measurement 1 (the two-pool census used in #486) and the `journalctl` line for reading `enrich-orphans done` counts, so the checkpoint can be run without rebuilding the queries.

Also record, as a fourth item, that nine rows proven fixed by the 2026-08-23 sweep become reachable but stay locked by their issues — and that each needs its live match verified before unlocking, because 1 of 14 matches in that sweep was wrong (#487).

- [ ] **Step 2: Link it**

Comment on #486 with the checkpoint issue number so the pair is navigable from either side.
