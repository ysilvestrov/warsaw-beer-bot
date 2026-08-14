# #347 Curated Brewery-Alias Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the twelve rows left in #347 by adding ten curated brewery-alias pairs, with two rows pinned instead, and prove by regression test that no existing alias path breaks.

**Architecture:** `src/domain/brewery-aliases.ts` is a hand-curated, symmetric, deliberately non-transitive table of normalized brewery-form pairs. `breweryAliases()` in `src/domain/matcher.ts` expands a brewery name one hop through it: a *hub* (a form with >1 partner) expands to all its spokes, a *spoke* whose partner is a hub does not expand back. The brewery hard-gate in `lookupBeer` then compares candidate aliases against input aliases. This batch adds pairs only — no logic changes — but it turns three existing forms into hubs, so the tests must lock in that every pre-existing path survives.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (prod DB read-only for verification), tsx for scripts.

**Design doc:** `docs/superpowers/specs/2026-08/2026-08-14-347-brewery-alias-batch-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/domain/brewery-aliases.ts` | Modify (append to `ALIAS_PAIRS`, before the closing `];` at line 64) | The curated table itself |
| `src/domain/brewery-aliases.test.ts` | Modify (append a describe block; amend two legacy assertions) | Table-shape invariants: symmetry, hubs |
| `src/domain/matcher.test.ts` | Modify (append a describe block) | Alias-expansion invariants: hub/spoke behaviour, pre-existing paths |
| `src/domain/untappd-lookup.test.ts` | Modify (append a describe block) | End-to-end: the row matches the documented bid |

No new files. No production-logic files change — if a task tempts you to edit `matcher.ts` or `untappd-lookup.ts`, stop: this batch is data only, and a behaviour change belongs to #405/#406/#407.

---

## Task 1: Add the ten pairs with table-level tests

**Files:**
- Modify: `src/domain/brewery-aliases.ts:64` (insert before the closing `];` of `ALIAS_PAIRS`)
- Test: `src/domain/brewery-aliases.test.ts` (append at end of file, and amend lines ~99-108 and ~119-128)

- [ ] **Step 1: Write the failing test**

Append to `src/domain/brewery-aliases.test.ts`:

```typescript
describe('#347 gate-miss alias batch', () => {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['ksiazece', 'tyskie ksiazece'],
    ['petrus', 'de brabandere'],
    ['kacov', 'hubertus'],
    ['mazurskie', 'mazurski'],
    ['lobkowicz', 'jihlava'],
    ['lobkowicz', 'rychtar'],
    ['cieszyn', 'arcyksiazecy zamkowy cieszyn'],
    ['cidre royal', 'royal fruit garden'],
    ['tomatol', 'mad brew'],
    ['nachod', 'primator'],
  ];
  test.each(PAIRS)('resolves %s <-> %s symmetrically', (shop, untappd) => {
    expect(aliasNeighbors(shop)).toContain(untappd);
    expect(aliasNeighbors(untappd)).toContain(shop);
  });

  // Unlike #318/#329, this batch deliberately creates hubs: one shop label maps to
  // several registered brewers (a portfolio owner), and two series names share one
  // brewer. The table stays non-transitive, so spokes never become equivalent.
  test('lobkowicz is a hub over both group breweries', () => {
    expect(aliasNeighbors('lobkowicz').sort()).toEqual(['jihlava', 'rychtar']);
  });
  test('mad brew is a hub over both of its series names', () => {
    expect(aliasNeighbors('mad brew').sort()).toEqual(['smoothiemaker', 'tomatol']);
  });
  test('the Cieszyn brewery is a hub over both of its shop labels', () => {
    expect(aliasNeighbors('arcyksiazecy zamkowy cieszyn').sort())
      .toEqual(['bracki zamkowy w cieszynie', 'cieszyn']);
  });
  test('spokes of a hub are not neighbours of each other', () => {
    expect(aliasNeighbors('jihlava')).not.toContain('rychtar');
    expect(aliasNeighbors('rychtar')).not.toContain('jihlava');
    expect(aliasNeighbors('tomatol')).not.toContain('smoothiemaker');
    expect(aliasNeighbors('cieszyn')).not.toContain('bracki zamkowy w cieszynie');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/brewery-aliases.test.ts`
Expected: FAIL — the new `resolves … symmetrically` cases report `expect(aliasNeighbors('ksiazece')).toContain('tyskie ksiazece')` against an empty array, and the hub cases fail with `[]` / `['smoothiemaker']` / `['bracki zamkowy w cieszynie']`.

- [ ] **Step 3: Add the pairs**

In `src/domain/brewery-aliases.ts`, insert immediately after the line `  ['st james s gate', 'guinness'],` and before the closing `];`:

```typescript
  // #347 batch (2026-08-14): gate misses where the search returned the beer at the
  // shop's own ABV and only the brewer label diverged. Every pair was verified by
  // replaying the orphan live through lookupBeer() against Algolia before curating;
  // keys produced with `npm run alias-key`. See
  // docs/superpowers/specs/2026-08/2026-08-14-347-brewery-alias-batch-design.md
  ['ksiazece', 'tyskie ksiazece'],   // 33544 Złote Pszeniczne -> bid 323265, abv 4.9 = 4.9
  ['petrus', 'de brabandere'],       // 33571 Kriek -> bid 6682946, abv 4.0 = 4.0 (Petrus is a De Brabandere brand)
  ['kacov', 'hubertus'],             // 33664 Hořký ležák L.P. 1457 -> bid 2204361, abv 4.4 = 4.4
  // Morphological variant ("Mazurskie Brewery" / "Mazurski Browar"), not a brand
  // relation; same shape as ['ziemia obiacana', 'ziemia obiecana']. Redundant if
  // #407 ever adds an edit-distance rescue to the gate.
  ['mazurskie', 'mazurski'],         // 34252 Lager Ciemny -> bid 4586540, abv 5.1 = 5.1
  // Portfolio owner: the shop files group beers under "Lobkowicz". A hub, so the
  // two group breweries never become equivalent to each other.
  ['lobkowicz', 'jihlava'],          // 11995 Ježek Kvasnicový -> bid 71011, abv 4.9 = 4.9
  ['lobkowicz', 'rychtar'],          // 34336 Rychtář Premium -> bid 301434, abv 5.0 = 5.0
  ['cieszyn', 'arcyksiazecy zamkowy cieszyn'], // 34371 Pszeniczne -> bid 1036654, abv 5.4 = 5.4
  // Cidre Royal is the brand of the Ukrainian producer Royal Fruit Garden; the
  // Belarusian licensee (Royal Fruit Bel) is deliberately NOT paired — no observed
  // row belongs to it, and 34518 is pinned to bid 402651 instead of guessed.
  ['cidre royal', 'royal fruit garden'],
  // Tomatøl is a Mad Brew series filed as a brewery, exactly like smoothiemaker
  // above. Server-side twin of the client-side #385/#384 fixes, so 0.13.0 clients
  // benefit too. NB 34351's shop ABV (3.8) contradicts the record (4.2).
  ['tomatol', 'mad brew'],           // 34352 Wasabi -> bid 6819716, abv 3.8 = 3.8
  // Necessary but not sufficient for 34642: after the gate opens, WEIZENBIER vs
  // Weizen still fails the name stage (#322 / #334).
  ['nachod', 'primator'],
```

- [ ] **Step 4: Run the alias tests — new ones pass, two legacy ones fail**

Run: `npx vitest run src/domain/brewery-aliases.test.ts`
Expected: the `#347 gate-miss alias batch` block passes; exactly two pre-existing cases fail — `form mad brew has exactly one neighbour (no new hub)` (#318 block) and `form arcyksiazecy zamkowy cieszyn has exactly one neighbour (no new hub)` (#329 block), each reporting `expected length 1, got 2`. Any other failure means a pair was mistyped — fix before continuing.

- [ ] **Step 5: Amend the two legacy hub assertions**

In the `#318 batch` describe block, replace the whole no-hub test with:

```typescript
  // Every form in this batch is a 1:1 equivalence EXCEPT `mad brew`, which the #347
  // batch widened into a hub over its two series names (smoothiemaker, tomatol).
  test.each(PAIRS.flat().filter((f) => f !== 'mad brew'))(
    'form %s has exactly one neighbour (no new hub)',
    (form) => {
      expect(aliasNeighbors(form)).toHaveLength(1);
    },
  );
  test('mad brew is a hub only over its own series names', () => {
    expect(aliasNeighbors('mad brew').sort()).toEqual(['smoothiemaker', 'tomatol']);
  });
```

In the `#329 gate-miss alias batch` describe block, replace the whole no-hub test with:

```typescript
  // As above: `arcyksiazecy zamkowy cieszyn` became a hub in the #347 batch, which
  // added the bare-town shop label `cieszyn` as a second spoke of the same brewery.
  test.each(PAIRS.flat().filter((f) => f !== 'arcyksiazecy zamkowy cieszyn'))(
    'form %s has exactly one neighbour (no new hub)',
    (form) => {
      expect(aliasNeighbors(form)).toHaveLength(1);
    },
  );
  test('the Cieszyn brewery is a hub only over its own shop labels', () => {
    expect(aliasNeighbors('arcyksiazecy zamkowy cieszyn').sort())
      .toEqual(['bracki zamkowy w cieszynie', 'cieszyn']);
  });
```

- [ ] **Step 6: Run the alias tests again**

Run: `npx vitest run src/domain/brewery-aliases.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/domain/brewery-aliases.ts src/domain/brewery-aliases.test.ts
git commit -m "feat(#347): curate ten brewery-alias pairs from the live replay batch"
```

---

## Task 2: Lock in alias-expansion behaviour around the three new hubs

The risk this task defends against: the batch turns `jihlava`, `mad brew` and `arcyksiazecy zamkowy cieszyn` into hubs, and a spoke whose partner is a hub stops expanding (`src/domain/matcher.ts:196-200`). Pre-existing rows that relied on that expansion must still match through the candidate side.

**Files:**
- Test: `src/domain/matcher.test.ts` (append at end of file)

- [ ] **Step 1: Write the failing test**

Append to `src/domain/matcher.test.ts`. Note the argument order: `breweryAliasesMatch(candidateAliases, inputAliases)`, matching how `lookupBeer` calls it.

```typescript
describe('#347 alias hubs', () => {
  test('the portfolio label expands to every group brewery', () => {
    expect(breweryAliases('Lobkowicz Brewery').sort()).toEqual(['jihlava', 'lobkowicz', 'rychtar']);
  });

  test('a spoke does not expand back to the hub', () => {
    expect(breweryAliases('Pivovar Rychtář')).toEqual(['rychtar']);
  });

  test('group breweries do not become equivalent to each other', () => {
    expect(breweryAliasesMatch(breweryAliases('Pivovar Rychtář'), breweryAliases('Pivovar Jihlava')))
      .toBe(false);
  });

  test('two Mad Brew series do not become equivalent to each other', () => {
    expect(breweryAliasesMatch(breweryAliases('Tomatol'), breweryAliases('SmoothieMaker')))
      .toBe(false);
  });

  test('pre-existing jezek path survives jihlava becoming a hub', () => {
    expect(breweryAliasesMatch(breweryAliases('Pivovar Jihlava'), breweryAliases('Ježek Kwasnicowy')))
      .toBe(true);
  });

  test('pre-existing smoothiemaker path survives mad brew becoming a hub', () => {
    expect(breweryAliasesMatch(breweryAliases('Mad Brew'), breweryAliases('SmoothieMaker')))
      .toBe(true);
  });

  test('pre-existing bracki path survives the Cieszyn brewery becoming a hub', () => {
    expect(breweryAliasesMatch(
      breweryAliases('Arcyksiążęcy Browar Zamkowy Cieszyn'),
      breweryAliases('Bracki Browar Zamkowy w Cieszynie'),
    )).toBe(true);
  });

  test('the bare-town label reaches the full brewery name', () => {
    expect(breweryAliasesMatch(
      breweryAliases('Arcyksiążęcy Browar Zamkowy Cieszyn'),
      breweryAliases('Cieszyn Brewery'),
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/domain/matcher.test.ts -t '#347 alias hubs'`
Expected: PASS — Task 1 already added the pairs, so this task documents and locks behaviour rather than driving new code. If any case fails, the pair list from Task 1 Step 3 was mistyped: compare against the design doc's table before touching any logic.

- [ ] **Step 3: Commit**

```bash
git add src/domain/matcher.test.ts
git commit -m "test(#347): lock alias-expansion behaviour around the three new hubs"
```

---

## Task 3: End-to-end regressions with the real candidate pools

Every pool below is the actual Algolia result set captured on 2026-08-14. The point of this task is the one thing a table test cannot prove: that the row reaches the *documented* bid and not a sibling.

**Files:**
- Test: `src/domain/untappd-lookup.test.ts` (append at end of file; `fakeSearch` is already defined at line 5)

- [ ] **Step 1: Write the failing test**

Append to `src/domain/untappd-lookup.test.ts`:

```typescript
describe('#347 curated alias batch', () => {
  test('33544: parent-company prefix, ABV separates the decoy siblings', async () => {
    const search = fakeSearch(() => [
      { bid: 323265, beer_name: 'Książęce Złote Pszeniczne', brewery_name: 'Tyskie Browary Książęce', style: 'Wheat Beer - Other', abv: 4.9, global_rating: 3.4 },
      { bid: 4732673, beer_name: 'Książęce Złote Pszeniczne 0,0%', brewery_name: 'Tyskie Browary Książęce', style: 'Non-Alcoholic - Wheat', abv: 0, global_rating: 3.1 },
      { bid: 6743380, beer_name: 'Złote Pszeniczne Z Nutą Mango', brewery_name: 'Tyskie Browary Książęce', style: 'Wheat Beer - Fruited', abv: 4.8, global_rating: 3.2 },
    ]);
    const out = await lookupBeer({ brewery: 'Browary Książęce Brewery', name: 'Złote Pszeniczne', abv: 4.9, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(323265);
  });

  test('11995: portfolio label reaches the group brewery', async () => {
    const search = fakeSearch(() => [
      { bid: 71011, beer_name: 'Ježek Kvasnicový', brewery_name: 'Pivovar Jihlava', style: 'Pilsner - Czech / Bohemian', abv: 4.9, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Lobkowicz Brewery', name: 'Ježek Kvasnicovy', abv: 4.9, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(71011);
  });

  test('34336: picks the group brewery over the same-named house beer', async () => {
    const search = fakeSearch(() => [
      { bid: 215285, beer_name: 'Lobkowicz Premium ležák', brewery_name: 'Pivovary Lobkowicz', style: 'Pilsner - Czech / Bohemian', abv: 4.7, global_rating: 3.4 },
      { bid: 301434, beer_name: 'Rychtář Premium', brewery_name: 'Pivovar Rychtář', style: 'Pilsner - Czech / Bohemian', abv: 5.0, global_rating: 3.5 },
      { bid: 897066, beer_name: 'Lobkowicz Premium Černý', brewery_name: 'Pivovary Lobkowicz', style: 'Lager - Tmavé (Czech Dark)', abv: 4.7, global_rating: 3.3 },
    ]);
    const out = await lookupBeer({ brewery: 'Pivovar Lobkowicz Brewery', name: 'Rychtář Premium 12°', abv: 5.0, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(301434);
  });

  test('the widened gate does not let a Rychtář row take a Lobkowicz beer', async () => {
    const search = fakeSearch(() => [
      { bid: 215285, beer_name: 'Lobkowicz Premium ležák', brewery_name: 'Pivovary Lobkowicz', style: 'Pilsner - Czech / Bohemian', abv: 4.7, global_rating: 3.4 },
      { bid: 301434, beer_name: 'Rychtář Premium', brewery_name: 'Pivovar Rychtář', style: 'Pilsner - Czech / Bohemian', abv: 5.0, global_rating: 3.5 },
    ]);
    // No ABV on purpose: the name stage alone must discriminate.
    const out = await lookupBeer({ brewery: 'Pivovar Rychtář', name: 'Premium', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(301434);
  });

  test('34371: bare-town shop label reaches the full brewery name', async () => {
    const search = fakeSearch(() => [
      { bid: 1036654, beer_name: 'Pszeniczne Cieszyńskie', brewery_name: 'Arcyksiążęcy Browar Zamkowy Cieszyn', style: 'Wheat Beer - Hefeweizen', abv: 5.4, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Cieszyn Brewery', name: 'Pszeniczne 12,5°', abv: 5.4, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1036654);
  });

  test('34352: series-as-brewery reaches Mad Brew, not the other tomato goses', async () => {
    const search = fakeSearch(() => [
      { bid: 6819716, beer_name: 'Tomatol Wasabi', brewery_name: 'Mad Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 3.8, global_rating: 3.6 },
      { bid: 6689682, beer_name: 'KOTOMATO WASABI TOMATO GOSE', brewery_name: 'Rebrew', style: 'Sour - Tomato / Vegetable Gose', abv: 5, global_rating: 3.5 },
      { bid: 5970182, beer_name: 'WASABI TOMATO GOSE', brewery_name: 'LiS Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 6, global_rating: 3.4 },
    ]);
    const out = await lookupBeer({ brewery: 'Tomatol', name: 'Wasabi', abv: 3.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6819716);
  });

  test('34351: a contradicting shop ABV must not veto the published beer', async () => {
    // flasker prints 3.8% in the title while the linked Untappd record says 4.2%.
    const search = fakeSearch(() => [
      { bid: 6648348, beer_name: 'Tomatøl:BULDAK BULGOGI', brewery_name: 'Mad Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 4.2, global_rating: 3.6 },
      { bid: 6708599, beer_name: 'Tomatol: Bulgogi Sriracha', brewery_name: 'Mad Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 4.2, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Tomatol', name: 'Bulgogi', abv: 3.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6648348);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t '#347 curated alias batch'`
Expected: PASS (7 cases). If `34351` fails with bid 6708599, do **not** relax the assertion — that is the wrong-link case #384 already had to merge away in prod; report it and stop.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS, no failures anywhere. The alias table is read by the matcher, the enrich path and `scripts/rearm-aliased-orphans.ts`, so a break can surface far from the files you edited.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.test.ts
git commit -m "test(#347): end-to-end regressions for the curated alias batch"
```

---

## Task 4: Verify against all twenty affected orphans, then open the PR

The design's acceptance criterion is that no pair misfires on a row it touches incidentally — the twelve in the issue plus eight passengers.

**Files:**
- Use (do not commit): `tmp/replay-347.ts` (already written; replays a beer_id list through the real `lookupBeer()` against live Algolia using the read-only prod DB)

- [ ] **Step 1: Run the replay over every affected row**

```bash
npx tsx tmp/replay-347.ts 33544 33571 33664 34252 11995 34336 34371 34607 34518 34351 34352 34642 25802 30059 30273 31808 34703 30063 30233 31201
```

Expected: each row prints either `MATCHED → <brewery> — <beer> (bid …)` or `NOT_FOUND, candidates=N`.

- [ ] **Step 2: Check the run against the acceptance criteria**

Confirm all three by reading the output:

1. No row matched a beer whose ABV contradicts the shop's beyond ±0.5 (`ABV_TOLERANCE`).
2. No row matched a brewer other than the one documented in the design doc's table.
3. These are expected to stay `NOT_FOUND` and are **not** failures — they belong to other issues: 34642 (name stage, #322/#334), 25802 (`PSZENICA` ↔ `Pšenice`, #322), 30273 (zero candidates, #388/#406), 30059 (ambiguous `PLATAN`, #334), 30063 / 30233 / 31201 (zero candidates, #406).

If any row matches a brewer outside the documented table, stop and remove the offending pair — a wrong match is worse than an orphan, because it silently mislabels a beer for every user.

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin <branch-name>
gh pr create --title "feat(#347): curated brewery-alias batch (ten pairs)" --body "$(cat <<'EOF'
Closes the alias-gate class of #347 after the 2026-08-14 live replay and re-routing.

Ten curated pairs, verified by replaying each orphan end-to-end through the real
`lookupBeer()` against Algolia. Freigeist (contract brewing) and Cidre Royal (three
same-ABV candidates) get pins instead of pairs — applied in prod after merge.

Verification run over all twenty affected orphans is in the task list below;
rows that stay unmatched are listed with the issue that actually owns them.

Design: docs/superpowers/specs/2026-08/2026-08-14-347-brewery-alias-batch-design.md
Plan: docs/superpowers/plans/2026-08/2026-08-14-347-brewery-alias-batch.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Kgthzkhf22sMhFN8wiNWxT
EOF
)"
```

- [ ] **Step 4: Paste the replay result into the PR as a comment**

Include the full Step 1 output plus a one-line verdict per row (matched → bid, or unmatched → owning issue). This is the evidence the reviewer needs to judge the pairs; without it the diff is ten unexplained string tuples.

- [ ] **Step 5: Wait for the AI review, then read and assess it**

Poll with `gh pr view <n> --comments`. Verify each finding before acting: confirm the quoted line still does what the finding claims, and push back in a reply when it does not. Do not merge — the user merges.

---

## Task 5: Post-merge production operations

Do not start until the user reports the PR is merged.

- [ ] **Step 1: Deploy**

```bash
./deploy.sh
```

Expected: rsync to `/opt/warsaw-beer-bot`, service restarted. Confirm with `systemctl status warsaw-beer-bot`.

- [ ] **Step 2: Apply the two pins**

The CLI is `pin-match --beer <id> --untappd <url|bid>`; it writes to the prod DB, so it runs as the bot user against the compiled `dist`. Pin 34518 → bid 402651 (`Royal Fruit Garden — Cidre Royal Apple Cider Demi-Sec`, the Ukrainian producer, matching the row's `style = "Apple Cider (Ukraina)"`) and 34607 → bid 6733435 (`Kreuzbräu — Acid Trip: Tangier`, abv 4.3 = 4.3):

```bash
sudo -n -u warsaw-beer-bot /usr/bin/bash -lc 'cd /opt/warsaw-beer-bot && node dist/scripts/pin-match.js --beer 34518 --untappd 402651'
sudo -n -u warsaw-beer-bot /usr/bin/bash -lc 'cd /opt/warsaw-beer-bot && node dist/scripts/pin-match.js --beer 34607 --untappd 6733435'
```

Each prints a JSON result. Then confirm both are recorded:

```bash
sudo -n -u warsaw-beer-bot /usr/bin/bash -lc 'cd /opt/warsaw-beer-bot && node dist/scripts/pin-match.js --list' | grep -E 'Apple Cider|Acid Trip'
```

Expected: two lines, mapping ontap refs `Apple Cider` and `Acid Trip:Tangier` to beers 34518 and 34607 with the untappd ids above. To undo one: `node dist/scripts/pin-match.js --unpin --beer <id>`.

- [ ] **Step 3: Re-arm the affected orphans**

```bash
sudo -n -u warsaw-beer-bot /usr/bin/bash -lc 'cd /opt/warsaw-beer-bot && node dist/scripts/rearm-aliased-orphans.js'
```

This selects every orphan whose brewery is now covered by `hasCuratedAlias()` and resets its lookup backoff. Expect roughly twenty targets.

- [ ] **Step 4: Read the result off the next enrich cron**

```bash
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db "SELECT id, brewery, name, untappd_id FROM beers WHERE id IN (33544,33571,33664,34252,11995,34336,34371,34607,34518,34351,34352,34642,31808,34703);"
```

Expected: `untappd_id` populated for the rows the replay matched, and for the two pinned rows.

- [ ] **Step 5: Report on #347 and close out**

Post the before/after table to #347. Close it if nothing is left; otherwise move each surviving row to the issue that owns it (#322, #334, #388, #405, #406, #407) and say so explicitly in the comment.

- [ ] **Step 6: If a pair misbehaves in prod, roll it back**

Only if Step 4 shows a wrong match. The table is data and the enrich path re-derives everything, so `git revert` of the Task 1 commit plus a redeploy is sufficient; delete any wrong link with `node dist/scripts/pin-match.js --unpin --beer <id>`, then re-arm the affected rows so they are retried cleanly.

- [ ] **Step 7: Clear the scratch directory**

```bash
rm -f tmp/*.ts tmp/*.sql
```

`./tmp/` is ephemeral by CLAUDE.md and must be emptied when the task is done.

---

## Follow-up, not part of this plan

The 29789/30845 re-arm from #391/#382 was blocked on the extension 0.14.0 store rollout, which has now happened. Raise it as its own piece of work once this batch is verified in prod.
