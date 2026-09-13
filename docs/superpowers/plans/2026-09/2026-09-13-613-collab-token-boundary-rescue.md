# #613 Collab-Token Boundary Rescue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve orphan 36588 to Untappd bid 6852067 when a shop welds a collaboration brand into one beer-name token, without weakening ordinary name matching.

**Architecture:** Add one strict rescue at the strict-only near-name stage's existing terminal refusal inside `lookupBeer`. It compares a complete single-token collaboration part from the input brewery with an exact concatenation of adjacent candidate-name tokens, then requires the same explicit year, matching known ABV, and one unique bid. Existing stages, normalizers, fuzzy thresholds, and selection rules remain unchanged.

**Tech Stack:** TypeScript, Vitest, `fast-fuzzy`-based existing matcher, live Untappd Algolia replay.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-613-collab-token-boundary-rescue-design.md`

## Global Constraints

- Work only in the existing `fix-613-collab-token-rescue` isolated worktree.
- Do not change `normalizeName`, `nameKeys`, fuzzy thresholds, popularity selection, storage, APIs, or extension code.
- The rescue runs only after the strict-only near-name stage has candidates but its current score/popularity resolver declines to choose one and would return terminal `not_found`.
- Require strict brewery evidence, a complete single-token collab part, exact token-boundary repair, equal explicit four-digit years, known ABV within `ABV_TOLERANCE`, and one distinct bid.
- Missing evidence or ambiguity remains `not_found`.
- Add no dependency and perform no unrelated refactor.
- Before closing #613, adjudicate every production row owned by the issue.

## File Map

- `src/domain/untappd-lookup.ts` — owns the private boundary comparison and terminal rescue.
- `src/domain/untappd-lookup.test.ts` — owns the public-seam regression and fail-closed cases.
- No new source module: the rule is private to enrich lookup and does not justify a reusable abstraction.

---

### Task 1: Implement the fail-closed collab-token rescue

**Files:**

- Modify: `src/domain/untappd-lookup.ts:1-13,225-285,635-660`
- Test: `src/domain/untappd-lookup.test.ts`

**Interfaces:**

- Consumes: existing `COLLAB_SEP`, `normalizeBrewery`, `normalizeName`, `extractYear`, `ABV_TOLERANCE`, `SearchResult`, and the strict candidate pool built inside `matchAgainst`.
- Produces: no exported interface; `lookupBeer(args: LookupArgs): Promise<LookupOutcome>` may return the existing `{ kind: 'matched', result }` shape from the new terminal stage.

- [ ] **Step 1: Add the recorded red regression and fail-closed cases**

Add this block to `src/domain/untappd-lookup.test.ts` near the other terminal matching-stage suites:

```ts
describe('#613 collab-token boundary rescue', () => {
  const candidates: SearchResult[] = [
    {
      bid: 5989079,
      beer_name: 'Birthday Cookie: Multi Qlti 2024',
      brewery_name: 'Funky Fluid',
      style: 'Stout - Imperial / Double Pastry',
      abv: 13,
      global_rating: 4.08,
      brewery_alias: ['Browar Funky Fluid'],
      alias_alt: [],
      rating_count: 131,
    },
    {
      bid: 6852067,
      beer_name: 'Birthday Cookie: Multi Qlti 2026',
      brewery_name: 'Funky Fluid',
      style: 'Stout - Imperial / Double Pastry',
      abv: 13,
      global_rating: 0,
      brewery_alias: ['Browar Funky Fluid'],
      alias_alt: [],
      rating_count: 0,
    },
    {
      bid: 5526331,
      beer_name: 'Birthday Cookie: Multi Qlti (2023)',
      brewery_name: 'Funky Fluid',
      style: 'Stout - Imperial / Double Pastry',
      abv: 12,
      global_rating: 4.29273,
      brewery_alias: ['Browar Funky Fluid'],
      alias_alt: [],
      rating_count: 110,
    },
  ];

  test.each([false, true])(
    'resolves the recorded 2026 row independently of result order (reversed=%s)',
    async (reversed) => {
      const results = reversed ? [...candidates].reverse() : candidates;
      const out = await lookupBeer({
        brewery: 'Funky Fluid X MultiQlti Brewery',
        name: 'Birthday Cookie MultiQlti 2026 36°',
        abv: 13,
        search: fakeSearch(() => results),
      });

      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(6852067);
    },
  );

  test('refuses boundary-equivalent candidates from the wrong year', async () => {
    const out = await lookupBeer({
      brewery: 'Funky Fluid X MultiQlti Brewery',
      name: 'Birthday Cookie MultiQlti 2026 36°',
      abv: 13,
      search: fakeSearch(() => candidates.filter((candidate) => candidate.bid !== 6852067)),
    });
    expect(out.kind).toBe('not_found');
  });

  test.each([
    {
      label: 'missing input year',
      inputName: 'Birthday Cookie MultiQlti 36°',
      candidateName: 'Birthday Cookie: Multi Qlti 2026',
    },
    {
      label: 'missing candidate year',
      inputName: 'Birthday Cookie MultiQlti 2026 36°',
      candidateName: 'Birthday Cookie: Multi Qlti',
    },
  ])('refuses $label', async ({ inputName, candidateName }) => {
    const target = { ...candidates[1], beer_name: candidateName };
    const out = await lookupBeer({
      brewery: 'Funky Fluid X MultiQlti Brewery',
      name: inputName,
      abv: 13,
      search: fakeSearch(() => [target, candidates[0]]),
    });
    expect(out.kind).toBe('not_found');
  });

  test.each([
    { label: 'missing input ABV', inputAbv: null, candidateAbv: 13 },
    { label: 'missing candidate ABV', inputAbv: 13, candidateAbv: null },
    { label: 'contradictory ABV', inputAbv: 13, candidateAbv: 12.5 },
  ])('refuses $label', async ({ inputAbv, candidateAbv }) => {
    const target = { ...candidates[1], abv: candidateAbv };
    const out = await lookupBeer({
      brewery: 'Funky Fluid X MultiQlti Brewery',
      name: 'Birthday Cookie MultiQlti 2026 36°',
      abv: inputAbv,
      search: fakeSearch(() => [target, candidates[0]]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('does not ignore the same token boundary outside a collab participant', async () => {
    const out = await lookupBeer({
      brewery: 'Funky Fluid',
      name: 'Birthday Cookie MultiQlti 2026 36°',
      abv: 13,
      search: fakeSearch(() => [candidates[1], candidates[0]]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('does not forgive a different one-letter token elsewhere in the name', async () => {
    const target = { ...candidates[1], beer_name: 'B Birthday Cookie: Multi Qlti 2026' };
    const out = await lookupBeer({
      brewery: 'Funky Fluid X MultiQlti Brewery',
      name: 'A Birthday Cookie MultiQlti 2026 36°',
      abv: 13,
      search: fakeSearch(() => [target, candidates[0]]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('refuses two distinct bids with the same repaired name, year, and ABV', async () => {
    const duplicate = { ...candidates[1], bid: 7000000 };
    const out = await lookupBeer({
      brewery: 'Funky Fluid X MultiQlti Brewery',
      name: 'Birthday Cookie MultiQlti 2026 36°',
      abv: 13,
      search: fakeSearch(() => [candidates[1], duplicate, candidates[0]]),
    });
    expect(out.kind).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run the focused regression and confirm the current defect**

Run:

```bash
npx vitest run src/domain/untappd-lookup.test.ts -t "#613 collab-token boundary rescue"
```

Expected: the two recorded-row cases fail with `expected 'not_found' to be 'matched'`. The fail-closed cases pass. If a negative case fails before implementation, stop and trace which existing stage accepted it; do not weaken that test to fit the current behavior.

- [ ] **Step 3: Import raw-year extraction into the enrich matcher**

Extend the existing import from `./matcher` in `src/domain/untappd-lookup.ts` to include `extractYear`. Keep the current imported identifiers and formatting style:

```ts
import {
  breweryAliases,
  breweryAliasesMatch,
  breweryAliasContained,
  ABV_TOLERANCE,
  COLLAB_SEP,
  extractYear,
  nameKeys,
  intersects,
  stripBreweryFromName,
} from './matcher';
```

- [ ] **Step 4: Add the private exact-boundary helpers**

Place these helpers after `nameTokens` in `src/domain/untappd-lookup.ts`:

```ts
function singleTokenCollabParts(brewery: string): Set<string> {
  const parts = brewery.split(COLLAB_SEP).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return new Set();
  return new Set(
    parts
      .map(normalizeBrewery)
      .filter((part) => part !== '' && !part.includes(' ')),
  );
}

function differsOnlyByCollabTokenBoundary(
  inputTokens: readonly string[],
  candidateName: string,
  collabParts: ReadonlySet<string>,
): boolean {
  const candidateTokens = normalizeName(candidateName).split(' ').filter(Boolean);
  const splitLength = candidateTokens.length - inputTokens.length + 1;
  if (splitLength < 2) return false;

  return inputTokens.some((token, inputIndex) => {
    if (!collabParts.has(token)) return false;
    if (!inputTokens.slice(0, inputIndex).every(
      (prefixToken, index) => prefixToken === candidateTokens[index],
    )) return false;

    const split = candidateTokens.slice(inputIndex, inputIndex + splitLength);
    if (split.length !== splitLength || split.join('') !== token) return false;

    return inputTokens.slice(inputIndex + 1).every(
      (suffixToken, index) =>
        suffixToken === candidateTokens[inputIndex + splitLength + index],
    );
  });
}

function collabTokenBoundaryRescue(
  input: { brewery: string; name: string; abv: number | null },
  strictPool: SearchResult[],
): SearchResult | null {
  const inputYear = extractYear(input.name);
  const inputAbv = input.abv;
  if (inputYear === null || inputAbv === null) return null;

  const collabParts = singleTokenCollabParts(input.brewery);
  if (collabParts.size === 0) return null;
  const inputTokens = normalizeName(input.name).split(' ').filter(Boolean);

  const matches = strictPool.filter((candidate) =>
    extractYear(candidate.beer_name) === inputYear &&
    candidate.abv !== null &&
    Math.abs(candidate.abv - inputAbv) <= ABV_TOLERANCE &&
    differsOnlyByCollabTokenBoundary(
      inputTokens,
      candidate.beer_name,
      collabParts,
    ),
  );
  const unique = Array.from(new Map(matches.map((candidate) => [candidate.bid, candidate])).values());
  return unique.length === 1 ? unique[0] : null;
}
```

- [ ] **Step 5: Refine the near-name stage's existing terminal refusal**

In the near-name stage's `nearMatches.length > 0` block, preserve an existing `nearHit` exactly as today. Only
when `pickScoredCandidate` returns no winner, try the strict boundary rescue before returning the
same terminal `not_found`:

```ts
if (nearHit) return { kind: 'matched', result: nearHit };
const boundaryHit = collabTokenBoundaryRescue(
  { brewery, name, abv },
  strictPool,
);
return boundaryHit ? { kind: 'matched', result: boundaryHit } : notFound();
```

Do not run the rescue before `pickScoredCandidate`, and do not move the near-name refusal to a later
stage. The current pipeline already terminates here for an unresolved scored cohort; the rescue may
refine only that refusal and must never second-guess an existing winner.

- [ ] **Step 6: Run the focused suite**

Run:

```bash
npx vitest run src/domain/untappd-lookup.test.ts -t "#613 collab-token boundary rescue"
```

Expected: all 11 #613 cases pass, including both candidate orders and every fail-closed case.

- [ ] **Step 7: Run the complete owner test file and typecheck**

Run:

```bash
npx vitest run src/domain/untappd-lookup.test.ts
npm run typecheck
```

Expected: both commands pass with no changed existing expectation.

- [ ] **Step 8: Run the original live Algolia reproduction**

Run the current branch against public Algolia defaults:

```bash
npx tsx -e "import { lookupBeer } from './src/domain/untappd-lookup.ts'; import { createAlgoliaSearch, ALGOLIA_DEFAULTS } from './src/sources/untappd/algolia.ts'; void (async()=>{const search=createAlgoliaSearch({appId:ALGOLIA_DEFAULTS.appId,searchKey:ALGOLIA_DEFAULTS.searchKey}); const out=await lookupBeer({brewery:'Funky Fluid X MultiQlti Brewery',name:'Birthday Cookie MultiQlti 2026 36°',abv:13,search}); console.log(JSON.stringify(out,null,2));})();"
```

Expected: `kind` is `matched` and `result.bid` is `6852067`. If live candidate data has changed, retain the fixture result and record the new live response rather than changing the matcher to chase search order.

- [ ] **Step 9: Run the full project gate**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: 0 test failures, 0 type errors, and no whitespace errors.

- [ ] **Step 10: Self-review and commit only the implementation-owned files**

Inspect every changed line and confirm there is no normalizer, threshold, API, storage, or extension change. Then commit only the source and test:

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(matcher): rescue fused collab tokens for #613"
```

### Task 2: Verify the issue-owned production row before handoff

**Files:**

- Read: `docs/superpowers/specs/2026-09/2026-09-13-613-collab-token-boundary-rescue-design.md`
- Read: the verdict file printed by the adjudication command under `/tmp`
- Modify: none

**Interfaces:**

- Consumes: committed branch matcher, production `enrich_failures.issue_number = 613`, the read-only adjudication probe, and its generated verdict file.
- Produces: replay evidence that beer 36588 is `rescued`; no source or database change for a rescued verdict.

- [ ] **Step 1: Run issue adjudication with the branch matcher**

Run in an operator environment that supplies the production service configuration and database path:

```bash
npm run adjudicate -- --issue 613
```

Expected output includes:

```text
36588  rescued  Funky Fluid X MultiQlti Brewery / Birthday Cookie MultiQlti 2026 36°
probed 1 rows for issue 613: 1 rescued / 0 unrescued / 0 inconclusive / 0 already marked
```

The probe performs no database writes. If either canary fails or the verdict is inconclusive, stop; do not close #613 and do not apply a partial result.

- [ ] **Step 2: Inspect the complete verdict file**

Open the literal verdict path printed after `verdicts written to` in Step 1. Confirm:

```json
{
  "issue": 613,
  "verdicts": [
    {
      "beer_id": 36588,
      "brewery": "Funky Fluid X MultiQlti Brewery",
      "name": "Birthday Cookie MultiQlti 2026 36°",
      "verdict": "rescued"
    }
  ]
}
```

The file also contains lookup bookkeeping fields and `probed_at`; preserve them unchanged. Do not synthesize or edit a verdict file.

- [ ] **Step 3: Apply the fresh verdict file through the guarded command**

Within the four-hour freshness window, copy the literal path printed after `verdicts written to`
in Step 1 and pass it as the final argument to `npm run adjudicate -- --apply`. Do not select a
file by glob or modification time: the exact printed path identifies the run whose canaries passed.

Expected: `marked 0, already marked 0`, with no skipped row. A rescued verdict deliberately writes no `unrescued_at` marker; the file is the replay record. If the command reports `input_changed`, re-probe. If it reports `issue_moved`, leave the row for its new issue. Do not use `--force` for routine execution.

- [ ] **Step 4: Record final branch evidence**

Run:

```bash
git status --short
git log --oneline -3
```

Expected: no implementation-owned uncommitted files; the history contains the design/spec commit and the matcher-fix commit. Report the full gate counts, live bid, and adjudication tally in the handoff.

Do not close the issue manually before the fix is merged. The PR may link #613 so merge performs the normal close/unlock sequence.
