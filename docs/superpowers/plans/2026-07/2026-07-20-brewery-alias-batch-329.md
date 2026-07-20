# Brewery Alias / Gate-Miss Batch #329 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four verified curated brewery-alias pairs so the enrichment gate accepts the already-present Untappd candidate for ~7 orphans (4 Ziemia Obiecana beers + Bergquell/Erdbeer + Cieszyn Pilsner + TankBusters/Paranormal Activity).

**Architecture:** Pure data change to `ALIAS_PAIRS` in `src/domain/brewery-aliases.ts`, mirroring the #318 batch. The existing `NEIGHBORS`/`aliasKeys` machinery and `breweryAliases` one-hop expansion pick the pairs up at module load — no logic change. Two test files lock the behaviour: `brewery-aliases.test.ts` (symmetry + no-hub) and `matcher.test.ts` (end-to-end `matchBeer` regression per pair).

**Tech Stack:** TypeScript, Vitest. Design doc: `docs/superpowers/specs/2026-07/2026-07-20-brewery-alias-batch-329-design.md`.

**The four pairs** (normalized forms, verified against `normalizeBrewery`):

| shop brewery | Untappd brewery | pair |
|---|---|---|
| `ZIEMIA OBIACANA Brewery` | `Ziemia Obiecana` | `['ziemia obiacana', 'ziemia obiecana']` |
| `BERGQELL Brewery` | `Bergquell Brauerei Löbau` | `['bergqell', 'bergquell lobau']` |
| `Bracki Browar Zamkowy w Cieszynie Brewery` | `Arcyksiążęcy Browar Zamkowy Cieszyn` | `['bracki zamkowy w cieszynie', 'arcyksiazecy zamkowy cieszyn']` |
| `Tank Busters Brewery` | `TankBusters.Co` | `['tank busters', 'tankbusters']` |

---

### Task 1: Add the four alias pairs (data + tests)

**Files:**
- Modify: `src/domain/brewery-aliases.ts` (append to `ALIAS_PAIRS`, currently ends at line ~40)
- Modify: `src/domain/brewery-aliases.test.ts` (append a `#329` describe block after the `#318` block)
- Modify: `src/domain/matcher.test.ts` (append a `#329` describe block at end of file)

- [ ] **Step 1: Write the failing alias-map tests**

Append to `src/domain/brewery-aliases.test.ts` (after the `describe('#318 gate-miss alias batch', …)` block):

```typescript
describe('#329 gate-miss alias batch', () => {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['ziemia obiacana', 'ziemia obiecana'],
    ['bergqell', 'bergquell lobau'],
    ['bracki zamkowy w cieszynie', 'arcyksiazecy zamkowy cieszyn'],
    ['tank busters', 'tankbusters'],
  ];
  test.each(PAIRS)('resolves %s <-> %s symmetrically', (shop, untappd) => {
    expect(aliasNeighbors(shop)).toContain(untappd);
    expect(aliasNeighbors(untappd)).toContain(shop);
  });
  // Each new form is a 1:1 equivalence — no shared form, so no new alias hub.
  test.each(PAIRS.flat())('form %s has exactly one neighbour (no new hub)', (form) => {
    expect(aliasNeighbors(form)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the alias-map tests to verify they fail**

Run: `npx vitest run src/domain/brewery-aliases.test.ts`
Expected: FAIL — the `#329` `resolves … symmetrically` cases fail (`aliasNeighbors('ziemia obiacana')` returns `[]`, does not contain `'ziemia obiecana'`); the no-hub cases fail with length 0.

- [ ] **Step 3: Write the failing matcher regression tests**

Append to the end of `src/domain/matcher.test.ts`. The `c()` helper and `matchBeer`, `breweryAliases`, `breweryAliasesMatch` imports already exist at the top of the file.

```typescript
describe('#329 gate-miss alias batch — end to end', () => {
  const passes = (shop: string, untappd: string) =>
    breweryAliasesMatch(breweryAliases(shop), breweryAliases(untappd));

  test('new pairs pass the brewery gate', () => {
    expect(passes('ZIEMIA OBIACANA Brewery', 'Ziemia Obiecana')).toBe(true);
    expect(passes('BERGQELL Brewery', 'Bergquell Brauerei Löbau')).toBe(true);
    expect(passes('Bracki Browar Zamkowy w Cieszynie Brewery', 'Arcyksiążęcy Browar Zamkowy Cieszyn')).toBe(true);
    expect(passes('Tank Busters Brewery', 'TankBusters.Co')).toBe(true);
  });

  // Catalog carries the authoritative Untappd brewery/name; input is the shop label.
  const cat: CatalogBeer[] = [
    c({ id: 101, brewery: 'Ziemia Obiecana', name: 'Bryła' }),
    c({ id: 102, brewery: 'Ziemia Obiecana', name: 'Beach Hut' }),
    c({ id: 103, brewery: 'Ziemia Obiecana', name: 'Padel Boys' }),
    c({ id: 104, brewery: 'Ziemia Obiecana', name: 'Prole Juice' }),
    c({ id: 105, brewery: 'Bergquell Brauerei Löbau', name: 'Erdbeer Porter' }),
    c({ id: 106, brewery: 'Arcyksiążęcy Browar Zamkowy Cieszyn', name: 'Cieszyn Pilsner' }),
    c({ id: 107, brewery: 'TankBusters.Co', name: 'Paranormal Activity' }),
  ];

  test.each([
    ['ZIEMIA OBIACANA Brewery', 'BRYŁA', 101],
    ['ZIEMIA OBIACANA Brewery', 'BEACH HUT', 102],
    ['ZIEMIA OBIACANA Brewery', 'PADEL BOYS', 103],
    ['ZIEMIA OBIACANA Brewery', 'Prole Juice', 104],
    ['BERGQELL Brewery', 'Erdbeer', 105],
    ['Bracki Browar Zamkowy w Cieszynie Brewery', 'CIESZYN PILSNER', 106],
    ['Tank Busters Brewery', 'Paranormal Activity', 107],
  ] as const)('%s / %s matches catalog id %i', (brewery, name, id) => {
    expect(matchBeer({ brewery, name }, cat)).toEqual({ id, confidence: 1, source: 'exact' });
  });
});
```

- [ ] **Step 4: Run the matcher tests to verify they fail**

Run: `npx vitest run src/domain/matcher.test.ts -t "#329"`
Expected: FAIL — `passes(...)` returns `false` (gate rejects without the alias) and each `matchBeer` returns `null` instead of the expected `{ id, confidence: 1, source: 'exact' }`.

- [ ] **Step 5: Add the four pairs to `ALIAS_PAIRS`**

In `src/domain/brewery-aliases.ts`, insert immediately before the closing `];` of `ALIAS_PAIRS` (after the last `['drofa', 'дрофа'],` line):

```typescript
  // #329 batch (2026-07-20): gate-miss aliases, each verified against the orphan's
  // enrich_failures.candidates_summary (authoritative Untappd brewery) and the real
  // matcher name stage (only rows whose name already matches post-alias — see the
  // #329 design doc). Name-divergent misses were routed to #319, not aliased here.
  ['ziemia obiacana', 'ziemia obiecana'],      // brewery typo OBIACANA->OBIECANA; 4 beers
  ['bergqell', 'bergquell lobau'],             // Erdbeer (Porter style-stripped)
  ['bracki zamkowy w cieszynie', 'arcyksiazecy zamkowy cieszyn'], // Cieszyn Pilsner
  ['tank busters', 'tankbusters'],             // Paranormal Activity
```

- [ ] **Step 6: Run both test files to verify they pass**

Run: `npx vitest run src/domain/brewery-aliases.test.ts src/domain/matcher.test.ts`
Expected: PASS — all `#329` symmetry, no-hub, gate, and match cases green; no pre-existing test regressed.

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — whole Vitest suite green, `tsc --noEmit` clean.

- [ ] **Step 8: Commit**

```bash
git add src/domain/brewery-aliases.ts src/domain/brewery-aliases.test.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): #329 gate-miss brewery alias batch (4 pairs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Deploy, re-arm, verify (ops — no code)

**Files:** none (production operations).

- [ ] **Step 1: Deploy to prod**

Run: `bash deploy/deploy.sh` (rsyncs working tree to `/opt`, `npm ci && npm run build && npm prune --omit=dev`, restarts the service — activating the new `ALIAS_PAIRS` at module load).
Expected: `journalctl` tail shows the service restarted cleanly.

- [ ] **Step 2: Re-arm the backed-off orphans (dry-run first)**

Run: `sudo -n -u warsaw-beer-bot bash -lc 'cd /opt/warsaw-beer-bot && npm run rearm-matcher-bug-orphans'`
Expected: dry-run lists the affected orphans (incl. the Ziemia/Bergquell/Cieszyn/TankBusters rows) among the matcher_bug set; prints "N matcher-bug orphan(s) would be re-armed".

- [ ] **Step 3: Apply the re-arm**

Run: `sudo -n -u warsaw-beer-bot bash -lc 'cd /opt/warsaw-beer-bot && npm run rearm-matcher-bug-orphans -- --apply'`
Expected: "Re-armed N matcher-bug orphan(s)." (resets `untappd_lookup_count=0`/`untappd_lookup_at=NULL` so the enrich cron retries them).

- [ ] **Step 4: Verify after the next enrich cron**

Run (after the cron has run, e.g. next :30):
```bash
sudo -n -u warsaw-beer-bot bash -lc 'sqlite3 /var/lib/warsaw-beer-bot/bot.db "SELECT id, brewery, name, untappd_id FROM beers WHERE id IN (32647,30934,31948,32312,11991,30141,32683)"'
```
Expected: the seven rows now have a non-null `untappd_id` and have dropped out of `enrich_failures` (self-clear on match, #127).

---

## Notes

- Server-side only: no `extension/**` change → no `docs/extension-install-uk.md` update; no schema change → no `spec.md` change (per the design doc's "spec.md impact: none").
- Open the PR after Task 1 and run the AI-review loop before deploying (Task 2), per the project workflow.
