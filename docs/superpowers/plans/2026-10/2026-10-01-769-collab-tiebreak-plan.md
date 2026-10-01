# Issue #769 Collab Co-Brewer ABV Tie-Break Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disambiguate tied top-score candidates from co-brewers of a collaboration brewery using input ABV when popularity dominance cannot resolve the tie.

**Architecture:** Implement a strict `collabCoBrewerTiebreak` helper in `src/domain/untappd-lookup.ts`. Wire it as a refusal refinement in Stage 2a.5 (strict near-name) and Stage 2b (fuzzy) when `pickScoredCandidate` returns `null` for a tied top cohort, selecting the unique candidate whose ABV is strictly closer to the input ABV within `ABV_TOLERANCE`.

**Tech Stack:** TypeScript, Node.js, Vitest, Fast-Fuzzy.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-01-769-collab-tiebreak-design.md`

## Global Constraints

- Never modify `normalizeName`, `nameKeys`, `dominantCandidate`, or fuzzy scoring algorithms.
- Zero weak assertions in tests (`toBe`, `toEqual` only; no `toBeDefined` or `toBeTruthy`).
- Single deterministic assertion paths with no conditional branching in tests.
- Full gate: `npm test && npm run typecheck`.

## Review Focus

1. **Non-collab brewery with tied candidates:** Collab tie-break must not fire for a single brewery's tied candidates; must fail closed.
2. **Distinct candidate names:** Tied candidates with different names (e.g. `Wheat Love` vs `Wheat Hate`) must not be compared by ABV; must fail closed.
3. **Equidistant ABVs:** Two candidates with identical ABV or equidistant delta from input ABV must not guess; must fail closed.
4. **Missing input or candidate ABV:** If input ABV is null or any tied candidate has null ABV, must fail closed.
5. **Collab candidate order independence:** Swapping the order of candidates returned by search must produce the exact same winning candidate.

---

### Task 1: Implement `collabCoBrewerTiebreak` and wire into Stage 2a.5 and Stage 2b

**Files:**
- Modify: `src/domain/untappd-lookup.ts:850-890`
- Test: `src/domain/untappd-lookup.test.ts`

**Step 1: Write focused unit tests in `src/domain/untappd-lookup.test.ts`**

Add a `describe('#769 collab co-brewer ABV tie-break')` block testing:
1. `matched: co-brewer with exact matching ABV is selected over diverging co-brewer` (Sarabanda 4.5% vs Palatum 4.8% at input 4.5%).
2. `order independence: candidate order does not change the selected co-brewer`.
3. `not_found: non-collab brewery with tied candidates fails closed`.
4. `not_found: candidates with different names fail closed`.
5. `not_found: candidates with equidistant ABVs fail closed`.
6. `not_found: null input ABV fails closed`.
7. `not_found: winner ABV exceeding ABV_TOLERANCE fails closed`.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "#769"`

**Step 3: Implement `collabCoBrewerTiebreak` in `src/domain/untappd-lookup.ts`**

Define:
```ts
function collabCoBrewerTiebreak(
  input: { brewery: string; name: string; abv: number | null },
  matches: ScoredCandidate[],
): SearchResult | null {
  const inputAbv = input.abv;
  if (inputAbv == null) return null;

  const rawParts = input.brewery.split(BREWERY_COLLAB_SEP).map((p) => p.trim()).filter(Boolean);
  if (rawParts.length < 2) return null;
  const collabParts = rawParts.map(normalizeBrewery).filter(Boolean);
  if (collabParts.length < 2) return null;

  const bestByBid = new Map<number, ScoredCandidate>();
  for (const match of matches) {
    const existing = bestByBid.get(match.result.bid);
    if (!existing || match.score > existing.score) bestByBid.set(match.result.bid, match);
  }
  const unique = Array.from(bestByBid.values());
  if (unique.length < 2) return null;

  const topScore = Math.max(...unique.map((m) => m.score));
  const top = unique.filter((m) => m.score === topScore).map((m) => m.result);
  if (top.length < 2) return null;

  // All candidates in the tie must have identical candidate identity
  const firstIdent = candIdentValue(top[0]);
  if (!top.every((r) => candIdentValue(r) === firstIdent)) return null;

  // All candidates must have a known ABV
  if (top.some((r) => r.abv == null)) return null;

  // Each candidate must strictly match a different collab part
  const matchesPart = (cand: SearchResult, part: string): boolean => {
    const aliases = breweryAliases(cand.brewery_name);
    return breweryAliasesMatch(aliases, [part]);
  };
  const partAssignments = top.map((cand) =>
    collabParts.filter((part) => matchesPart(cand, part)),
  );
  if (partAssignments.some((parts) => parts.length === 0)) return null;

  // Calculate delta to input ABV for each candidate
  const candidatesWithDelta = top.map((cand) => ({
    cand,
    delta: Math.abs((cand.abv as number) - inputAbv),
  }));

  // Sort by delta ascending
  candidatesWithDelta.sort((a, b) => a.delta - b.delta);
  const best = candidatesWithDelta[0];
  const secondBest = candidatesWithDelta[1];

  // Best candidate must be within ABV_TOLERANCE and strictly closer than second best
  if (best.delta > ABV_TOLERANCE) return null;
  if (best.delta >= secondBest.delta) return null;

  return best.cand;
}
```

Wire into Stage 2a.5:
```ts
      if (nearMatches.length > 0) {
        const nearHit = pickScoredCandidate(nearMatches, abv);
        if (nearHit) return { kind: 'matched', result: nearHit };
        const boundaryHit = collabTokenBoundaryRescue({ brewery, name, abv }, strictPool);
        if (boundaryHit) return { kind: 'matched', result: boundaryHit };
        const collabHit = collabCoBrewerTiebreak({ brewery, name, abv }, nearMatches);
        return collabHit ? { kind: 'matched', result: collabHit } : notFound();
      }
```

Wire into Stage 2b:
```ts
      if (matches.length > 0) {
        const fuzzyHit = pickScoredCandidate(
          matches.map((match) => ({ result: match.item, score: match.score })),
          abv,
        );
        if (fuzzyHit) return { kind: 'matched', result: fuzzyHit };
        const collabHit = collabCoBrewerTiebreak(
          { brewery, name, abv },
          matches.map((match) => ({ result: match.item, score: match.score })),
        );
        return collabHit ? { kind: 'matched', result: collabHit } : notFound();
      }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "#769"`

**Step 5: Run full verification suite**

Run: `npm test && npm run typecheck`

**Step 6: Commit changes**

Commit: `git commit -m "fix(matcher): add collab co-brewer ABV tie-break for #769"`

---

### Task 2: Update `spec.md` with Collab Co-Brewer Tie-Break Specification

**Files:**
- Modify: `spec.md:1290-1325`

**Step 1: Add specification paragraph to `spec.md` under matching section §3.1**

Document the exact 6 preconditions for `collabCoBrewerTiebreak` as specified in `docs/superpowers/specs/2026-10/2026-10-01-769-collab-tiebreak-design.md`.

**Step 2: Verify git diff for `spec.md`**

Run: `git diff spec.md`

**Step 3: Commit `spec.md` update**

Commit: `git commit -m "docs(spec): document collab co-brewer ABV tie-break (#769)"`

---

### Task 3: Operational action for row 38482 and adjudication of #769

**Files:**
- Modify: none (database operations)

**Step 1: Curated pin for mis-triaged row 38482**

Run:
`sudo -n -u warsaw-beer-bot /usr/bin/bash -lc "cd /home/ysi/warsaw-agy-bb && npm run pin-match -- --beer 38482 --untappd 6028011"`

Verify in `bot.db` that row 38482 is removed from `enrich_failures` and beer 38482 is assigned `untappd_id = 6028011` with `untappd_id_source = 'curated'`.

**Step 2: Run live adjudication probe for #769**

Run: `npm run adjudicate -- --issue 769`
Expected: 1 rescued (row 38475 -> bid 5756147), 0 unrescued, 0 inconclusive.

**Step 3: Apply verdicts file**

Run: `npm run adjudicate -- --apply /tmp/adjudicate-769-<timestamp>.json`
Expected: row 38475 leaves fix in known rescued state.
