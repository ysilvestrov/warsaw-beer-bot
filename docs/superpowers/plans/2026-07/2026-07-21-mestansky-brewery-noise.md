# "Měšťanský pivovar" Brewery-Gate Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the strict brewery gate for orphans whose Untappd brewery is `Měšťanský pivovar <place>` while the shop lists just `<place>`, by treating `mestansky` as generic brewery noise plus one curated alias for the Polička locative declension.

**Architecture:** Two small, well-understood changes to the existing matcher layer: (1) add the diacritic-stripped token `mestansky` to `BREWERY_NOISE` in `normalize.ts` (a generic Czech "burgher's brewery" descriptor, like `pivovar`/`brewery`); (2) add one curated non-transitive alias pair `['policka', 'v policce']` in `brewery-aliases.ts` for the Czech locative declension. No new modules.

**Tech Stack:** Node.js, TypeScript, Vitest. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-07/2026-07-21-mestansky-brewery-noise-design.md`

---

## File Structure

- **Modify** `src/domain/normalize.ts` — add `'mestansky'` to the `BREWERY_NOISE` set (with a comment).
- **Modify** `src/domain/normalize.test.ts` — assert the Untappd form normalizes to the bare place.
- **Modify** `src/domain/brewery-aliases.ts` — add `['policka', 'v policce']` to `ALIAS_PAIRS`.
- **Modify** `src/domain/brewery-aliases.test.ts` — assert the new pair is present symmetrically.
- **Modify** `src/domain/matcher.test.ts` — assert `breweryAliasesMatch` now opens the gate for the real shop↔Untappd forms (both nominative and Polička).
- **Modify** `src/domain/untappd-lookup.test.ts` — one end-to-end lookup for a case that cleanly resolves once the gate opens (Kutná Hora `Zlata 12`).

**Ordering matters:** Task 1 (noise) must land before Task 2 (alias), because the alias form `v policce` is what `normalizeBrewery('Měšťanský pivovar v Poličce')` produces *only after* `mestansky` is noise. Verify with `npx tsx scripts/brewery-alias-key.ts 'Polička Brewery' 'Měšťanský pivovar v Poličce'` once Task 1 is in.

---

### Task 1: `mestansky` → `BREWERY_NOISE`

**Files:**
- Modify: `src/domain/normalize.ts` (the `BREWERY_NOISE` set, ~lines 8–22)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/normalize.test.ts` (after the existing `normalizeBrewery` test near the top):

```typescript
test('strips Měšťanský (burgher-brewery descriptor) so only the place remains', () => {
  expect(normalizeBrewery('Měšťanský pivovar Kutná Hora')).toBe('kutna hora');
  expect(normalizeBrewery('Měšťanský pivovar Kojetín')).toBe('kojetin');
  expect(normalizeBrewery('Měšťanský pivovar Havlíčkův Brod')).toBe('havlickuv brod');
  // A real brand token next to it is untouched.
  expect(normalizeBrewery('Měšťanský pivovar Polička Brewery')).toBe('policka');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/normalize.test.ts -t 'Měšťanský'`
Expected: FAIL — receives `'mestansky kutna hora'` (token not yet stripped).

- [ ] **Step 3: Add the noise token**

In `src/domain/normalize.ts`, add `mestansky` to the `BREWERY_NOISE` set. Place it with the Czech/Slavic descriptors and give it a comment:

```typescript
  // Czech / Slovak, German, French, Italian, Dutch/Flemish,
  // Scandinavian (+ definite form), Spanish (post-diacritic-strip form)
  'pivovar', 'pivovary', 'brauerei', 'brasserie', 'birrificio',
  'brouwerij', 'bryggeri', 'bryggeriet', 'cerveceria',
  // "Měšťanský pivovar <place>" = burgher's/civic brewery — a generic Czech
  // brewery-type descriptor (~15 breweries on Untappd). Stripping the leading
  // token lets the bare shop "<place>" pass the leading-prefix brewery gate.
  'mestansky',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/normalize.test.ts -t 'Měšťanský'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): treat 'Měšťanský' (burgher-brewery) as brewery noise"
```

---

### Task 2: Polička locative-declension alias

**Files:**
- Modify: `src/domain/brewery-aliases.ts` (the `ALIAS_PAIRS` array)
- Test: `src/domain/brewery-aliases.test.ts`

- [ ] **Step 1: Verify the normalized forms with the alias-key tool**

Run (Task 1 must be committed first):
`npx tsx scripts/brewery-alias-key.ts 'Polička Brewery' 'Měšťanský pivovar v Poličce'`
Expected output (the exact pair to paste): `['policka', 'v policce'],`

- [ ] **Step 2: Write the failing test**

Add to `src/domain/brewery-aliases.test.ts` inside the `describe('aliasNeighbors', …)` block:

```typescript
  test('Polička locative declension pairs policka <-> v policce', () => {
    expect(aliasNeighbors('policka')).toContain('v policce');
    expect(aliasNeighbors('v policce')).toContain('policka');
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/domain/brewery-aliases.test.ts -t 'Polička'`
Expected: FAIL — `aliasNeighbors('policka')` returns `[]`.

- [ ] **Step 4: Add the alias pair**

In `src/domain/brewery-aliases.ts`, append to the `ALIAS_PAIRS` array (after the `#329 batch` block):

```typescript
  // Měšťanský-pivovar batch (2026-07-21): Czech locative declension. After the
  // `mestansky` noise strip the shop "Polička" normalizes to `policka` and the
  // Untappd "Měšťanský pivovar v Poličce" to `v policce`. Verified via alias-key.
  ['policka', 'v policce'],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/domain/brewery-aliases.test.ts -t 'Polička'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/brewery-aliases.ts src/domain/brewery-aliases.test.ts
git commit -m "feat(matcher): Polička locative-declension brewery alias"
```

---

### Task 3: Gate-open verification (matcher + one end-to-end lookup)

**Files:**
- Test: `src/domain/matcher.test.ts`
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the gate-open matcher tests**

Add to `src/domain/matcher.test.ts` (find the `describe`/section covering `breweryAliasesMatch`; if none, add a new `describe('breweryAliasesMatch — Měšťanský', …)` block). Import `breweryAliases, breweryAliasesMatch` from `./matcher` if not already imported.

```typescript
describe('breweryAliasesMatch — Měšťanský pivovar', () => {
  const gateOpens = (shop: string, untappd: string) =>
    breweryAliasesMatch(breweryAliases(shop), breweryAliases(untappd));

  test('nominative place matches via noise strip', () => {
    expect(gateOpens('Kutna Hora Brewery', 'Měšťanský pivovar Kutná Hora')).toBe(true);
    expect(gateOpens('Kojetin Brewery', 'Měšťanský pivovar Kojetín')).toBe(true);
    expect(gateOpens('Havlickuv Brod Brewery', 'Měšťanský pivovar Havlíčkův Brod')).toBe(true);
  });

  test('Polička locative matches via curated alias (all shop spellings)', () => {
    expect(gateOpens('Polička Brewery', 'Měšťanský pivovar v Poličce')).toBe(true);
    expect(gateOpens('Pivovar Policka Brewery', 'Měšťanský pivovar v Poličce')).toBe(true);
    expect(gateOpens('Měšťanský Pivovar Polička Brewery', 'Měšťanský pivovar v Poličce')).toBe(true);
  });

  test('does not over-match a different Měšťanský place', () => {
    expect(gateOpens('Kutna Hora Brewery', 'Měšťanský pivovar Kojetín')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the matcher tests to verify they fail**

Run: `npx vitest run src/domain/matcher.test.ts -t 'Měšťanský'`
Expected: FAIL — the "matches" cases currently return `false`.
(These pass automatically once Tasks 1 & 2 are in; run this step after them to confirm.)

- [ ] **Step 3: Write the end-to-end lookup test**

Add to `src/domain/untappd-lookup.test.ts` inside `describe('lookupBeer', …)` (before its closing `});`). This exercises the full path: gate opens via noise, then the name resolves (Zlatá shared token + #321 grade):

```typescript
  test('Měšťanský: nominative gate opens, name resolves (Kutná Hora Zlata 12)', async () => {
    const search = fakeSearch(() => [
      { bid: 70, beer_name: 'Kutnohorská Zlatá 12', brewery_name: 'Měšťanský pivovar Kutná Hora', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
      { bid: 71, beer_name: 'Kutnohorská Zlatá 12 Chmelená za studena', brewery_name: 'Měšťanský pivovar Kutná Hora', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
      { bid: 72, beer_name: 'Zlatá 12 nefiltrovaná', brewery_name: 'Měšťanský pivovar Kutná Hora', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Kutna Hora Brewery', name: 'Zlata 12', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect([70, 71, 72]).toContain(out.result.bid);
  });
```

- [ ] **Step 4: Run the lookup test to verify it fails, then passes with Tasks 1–2**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t 'Měšťanský'`
Expected: with Tasks 1 & 2 already committed, this PASSES (the brewery gate opens and the name resolves). If Tasks 1–2 were not yet in, it would return `not_found`.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.test.ts src/domain/untappd-lookup.test.ts
git commit -m "test(matcher): Měšťanský brewery-gate opens + Kutná Hora e2e"
```

---

### Task 4: Full verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full domain suite + typecheck**

Run: `npx vitest run src/domain && npx tsc --noEmit`
Expected: all pass, no type errors. (Watch specifically that no existing brewery test regresses from the new noise token.)

- [ ] **Step 2: Run the complete suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin HEAD
gh pr create --title "fix(matcher): Měšťanský pivovar brewery-gate reconciliation" \
  --body "$(cat <<'EOF'
Restores the strict brewery gate for orphans whose Untappd brewery is `Měšťanský pivovar <place>` while the shop lists just `<place>`.

- `mestansky` added to `BREWERY_NOISE` — generic Czech "burgher's brewery" descriptor (~15 breweries on Untappd); rescues the nominative-place orphans (Havlíčkův Brod, Kojetín, Kutná Hora).
- One curated alias `['policka','v policce']` for the Czech locative declension (Polička cluster).

The brewery gate is only half a match: each of the 9 affected orphans is verified end-to-end against its real candidates; only clean matches are re-armed. Name-stage ambiguities that survive the gate are flagged, not forced.

Spec: docs/superpowers/specs/2026-07/2026-07-21-mestansky-brewery-noise-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Poll AI review** (per project `feedback_pr_review_loop`): wait for the AI PR review, read + critically assess each comment, fix valid ones, push back on wrong ones.

---

## Post-merge (deploy + re-arm — not part of the branch)

After merge + deploy (`bash deploy/deploy.sh`):

1. **Verify all 9 end-to-end.** Reproduce each orphan's real candidates (from `enrich_failures.candidates_summary`) and confirm which fully match now (gate + name). The nine: 11993, 12198, 25630, 30206, 32458 (Polička), 12246 (Havlíčkův Brod), 12271, 29971 (Kojetín), 30095 (Kutná Hora). Expect grade/degree names (`Zlata 12`, `Otakar 11`) to resolve via #321; expect pale/dark or multi-variant flavour names (`Hradební světlé`/`tmavé`, `Kyselej …`, `Moontrick …`) to be **ambiguous** — flag, do not re-arm those.
2. **Re-arm only the clean matches** whose `untappd_lookup_count > 0` (reset `untappd_lookup_count=0, untappd_lookup_at=NULL` as `warsaw-beer-bot`). Several already have count 0 (eligible; retry when on tap).

---

## Self-Review notes

- **Spec coverage:** noise strip → Task 1; Polička alias → Task 2; gate-open verification (nominative + declension) → Task 3 matcher tests; end-to-end resolution → Task 3 lookup test; "gate is half a match / flag not force" → Task 4 + Post-merge. All spec sections covered.
- **Type consistency:** uses existing exports `normalizeBrewery`, `aliasNeighbors`, `breweryAliases`, `breweryAliasesMatch`, `lookupBeer`, and the existing `fakeSearch` test helper — signatures unchanged.
- **No placeholders:** every code/test/command block is concrete and runnable.
