# #664 Contextual Digit Identity Consumers and Numbered Search Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute sequentially in the main thread per AGENTS.md.

**Goal:** Deliver the reviewed numerical kernel to every existing consumer and add one bounded numbered-series search attempt that preserves the original beer identity.

**Architecture:** Extend the existing context literals and query loop in place. Keep the original matcher stages, acceptance tiers, storage transactions, and query error handling. Catalogue labels come from a catalogue already available to the caller; no database/network lookup inside the numerical predicate and no new global cache.

**Tech Stack:** Node.js >=24, TypeScript, Vitest, existing SQLite and BeerSearch adapters.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-28-664-digit-context-design.md`

## Global Constraints

- Work in `.worktrees/664-digit-context-design`, branch `docs/664-digit-context-design`. Reviewed kernel commit: `0bcc021`; source base after the execution rebase: `1cb7f45`.
- Read `spec.md` §§ numerical identity, lookup retries, enrichment, orphan resolution, and dedupe before changing their implementations.
- No new dependencies, migrations, production writes, historical-link repair, issue closure, row remapping, deployment, or extension release.
- Preserve `same > year-fallback > number-fallback > different`. Matcher/lookup/web may consider number-fallback under their existing rules; enrichment row selection, bid resolution, and dedupe accept only same/year-fallback; peers require both directions to avoid different.
- Keep all brewery/name/ABV/alcohol/ambiguity gates and #725 evidence. A search hit is not proof of identity; `GRIT` remains in the original input.
- Do not alter `normalizeName` to equate arbitrary compact/spaced codes. Kernel equivalence does not promise that every caller's existing name or candidate-pool gate accepts the pair.
- Compare original full names/styles/breweries on the new series attempt. Retain existing unnumbered retry behavior; do not turn the series feature into a rewrite of #271/#353.
- Initial and shortened numbered queries preserve the raw digits, including leading zeros and one-digit numbers. Canonicalize `no.N`/`nr.N` to `#N`, never N to its integer value.
- At most one extra series query per brewery part, only after the full search yields zero candidates. Skip an identical query already performed. Blocked/transient errors retain their current outcomes.
- Numbered inputs never take a later fallback that removes their number, even if shortening is refused because another identity-bearing number follows it.
- Tests use literal expected outcomes, no conditional assertions or expectations derived by reimplementing production logic. Run focused RED/GREEN and `npm test && npm run typecheck`, then commit named files after each code task.

## Reviewed interfaces and coverage limits

The kernel is implemented, not speculative:

```ts
interface DigitIdentityContext {
  input: { name: string; style?: string | null; brewery?: string | null };
  candidate: { name: string; style?: string | null; brewery?: string | null };
  knownBreweries?: readonly string[];
}
// Existing imports, not new declarations to put in consumers:
// readNameDigits(name: string): NameDigits
// digitIdentity(input: NameDigits, candidate: NameDigits, context?: DigitIdentityContext): DigitIdentity
// digitsCompatibleAsPeers(a: string, b: string, context?: DigitIdentityContext): boolean
```

Contextual calls re-read the supplied raw names, so retaining only `originalDigits` does not preserve identity on a shortened query. Keep `originalName` and raw brewery/style too. An omitted catalogue never implies a guessed catalogue. Numeric catalogue labels may be filtered once by the caller before a matching batch; the kernel still verifies full brand spans.

The core's final gate passed 4002 tests, one skipped, and typecheck. Frozen replay of 4140 pairs changed zero verdicts in either direction; it covers old observations, not the whole new integration surface. Local review and its two regression corrections are recorded in the core plan's execution report. There was no independent model review or shipping action.

## File map

| File | Change |
|---|---|
| `src/domain/matcher.ts` | Prepared catalogue brand labels and context in exact/fuzzy comparisons |
| `src/domain/untappd-lookup.ts` | Raw brewery context, original-name preservation, bounded series attempt |
| `src/domain/web-fallback.ts` | Candidate/input brewery context before and after hydration |
| `src/storage/beers.ts` | Raw brewery in orphan selection/peers SQL results and contexts |
| `src/api/routes/enrich.ts` | Card brewery in row selection context |
| `src/jobs/dedupe-brewery-aliases.ts` | Already-selected raw pair breweries in the numerical guard |
| `src/domain/normalize.ts` | Canonical search markers and preservation of one-digit marker tokens |
| Corresponding existing `.test.ts` files | Exact consumer verdicts, persistent row outcomes, query/call sequences |
| `spec.md` | Synchronize the delivered digit and query contracts |

## Task 1 (U4): Matching/search/web consumers receive raw context

**Files:** `src/domain/matcher.ts`, `matcher.test.ts`, `untappd-lookup.ts`, `untappd-lookup.test.ts`, `web-fallback.ts`, `web-fallback.test.ts`.

**Consumes:** Reviewed kernel and existing `PreparedCatalog`, `LookupArgs`, `GateInput`/candidate types.
**Produces:** Brewery-qualified comparisons in all three paths, with unchanged return types and acceptance levels. `PreparedCatalog.knownBreweries: readonly string[]` contains deduplicated numeric raw brewery labels from its own rows; `add()` updates that same collection. Add optional `knownBreweries?: readonly string[]` to lookup/gate inputs only if the caller already supplies a catalogue.

- [ ] **Step 1: Add rejecting consumer fixtures that reached the old name gate.** Use identical brewery, ABV and long shared name; differing compact CF codes must reject in fuzzy, and LAB8 missing on the candidate must reject when the surrounding words are exact after normalization. Pin exact and fuzzy paths separately using the existing `c` helper:

```ts
test('LAB8 stays hard on the normalized exact path', () => {
  expect(matchBeer({ brewery: 'Pracownia Piwa', name: 'LAB 8 Porter', abv: 6 }, [
    c({ id: 1, brewery: 'Pracownia Piwa', name: 'LAB Porter', abv: 6 }),
  ])).toBeNull();
});
test('different compact CF codes cannot win the fuzzy path', () => {
  expect(matchBeer({ brewery: 'Charles Faram', name: 'Hop Heats CF317', abv: 6 }, [
    c({ id: 1, brewery: 'Charles Faram', name: 'Hop Heats CF338', abv: 6 }),
  ])).toBeNull();
});
```

For lookup use the existing `fakeSearch` and a complete hit `{ bid: 1, beer_name: 'LAB Porter', brewery_name: 'Pracownia Piwa', style: 'Porter', abv: 6, global_rating: 3.5 }`; input `LAB 8 Porter` must return `kind = 'not_found'` and retain that exact rejected candidate as evidence. For `evaluateCandidate`, the same pair must return `'reject:digits'`. Add a candidate-side numeric brewery fragment and #3 beside a known 3 Fonteinen brand. Keep existing #725 retry/style fixtures unchanged.

- [ ] **Step 2: Run `npx vitest run src/domain/matcher.test.ts src/domain/untappd-lookup.test.ts src/domain/web-fallback.test.ts`.** Confirm a new context-dependent assertion fails, not an import/type error. CF recognition is global and may already reject before this task; that row protects integration rather than supplying its RED proof.

- [ ] **Step 3: Extend context literals using the existing raw values.** In `matchPrepared`:

```ts
const contextFor = (candidate: PreparedBeer): DigitIdentityContext => ({
  input: { name: input.name, style: input.style, brewery: input.brewery },
  candidate: { name: candidate.name, style: candidate.style, brewery: candidate.brewery },
  knownBreweries: prepared.knownBreweries,
});
```

Build the numeric catalogue label collection inside `makePreparedCatalog` from raw `beers[].brewery`, deduplicate it, and update it in `add(row)`; do not populate it from `breweryNorm`, which has already lost separate digits. Test a newly added numeric collaborator through matching, not by pinning the catalogue collection's size. Use the same `contextFor` in exact and fuzzy digit guards; leave direct Czech-grade checks on their existing original profiles/styles.

In lookup set `inputContext = { name: identityName, style: args.style, brewery: args.brewery }`; candidate context uses `result.beer_name`, `result.style`, `result.brewery_name`. In web use `input.brewery` and `cand.brewery_name` in every initial/post-hydration digit evaluation. Preserve candidate styles from the verified same-bid hydration; do not replace an original input name with query text.

- [ ] **Step 4: Verify positive omission and negative identity independently.** Ordinary #N asymmetry, Duvel 6.66, Czech degree evidence with catalogue context, absent optional catalogue, and unrelated equal-ABV names retain existing outcomes. A new candidate found or allowed by digits is not automatically a successful name match; record any remaining name-gate miss without broadening it.
- [ ] **Step 5: Focused GREEN, full gate, named-file commit:** `fix(domain): deliver brewery context to matching consumers (#664) (U4)`.

## Task 2 (U5): Context before row selection, bid resolution, peers, and dedupe

**Files:** `src/storage/beers.ts`, `beers.test.ts`, `src/api/routes/enrich.ts`, `enrich.test.ts`, `src/jobs/dedupe-brewery-aliases.ts`, `dedupe-brewery-aliases.test.ts`.

**Consumes:** Existing `BeerInput`/`BidBeerInput`/`BeerRow`, `PairCandidate` raw breweries, and reviewed kernel. No dependency on U4's prepared catalogue is needed.
**Produces:** Existing persistence decisions use the same explicit pair context; public storage return values, source ranks, inactive-orphan filtering and transactions stay unchanged.

- [ ] **Step 1: Test the missing LAB8 against the unnumbered LAB row in real in-memory SQLite.** These names deliberately share the genuine normalized key `lab porter`; the test must exercise the digit guard, not be rejected by an unrelated SQL-key mismatch:

```ts
test('peers retain separate unnumbered LAB and LAB8 orphans', () => {
  const db = fresh();
  ensureOrphan(db, { brewery: 'Pracownia Piwa', name: 'LAB Porter',
    normalized_brewery: 'pracownia piwa', normalized_name: 'lab porter' });
  ensureOrphan(db, { brewery: 'Pracownia Piwa', name: 'LAB 8 Porter',
    normalized_brewery: 'pracownia piwa', normalized_name: 'lab porter' });
  expect(db.prepare('SELECT name FROM beers ORDER BY id').all()).toEqual([
    { name: 'LAB Porter' }, { name: 'LAB 8 Porter' },
  ]);
  db.close();
});
```

For bid resolution seed orphan `LAB Porter`, then call `upsertBeerByBid` with `LAB 8 Porter`, bid 100, source `'bid'`, same normalized pair; assert stored rows exactly `{ name: 'LAB Porter', untappd_id: null }`, `{ name: 'LAB 8 Porter', untappd_id: 100 }`. This pins rejection of candidate-only hard-code number-fallback before permanent adoption.

Extend the existing `/enrich/result` row-selection tests with a linked `LAB 8 Porter` and an unnumbered `LAB Porter` card: the card must retain its own orphan rather than write into the numbered row. In dedupe seed canonical `LAB 8 Porter` under `Pracownia Piwa / Moersleutel`, orphan `LAB Porter` under `Pracownia Piwa`; both have `normalized_name = 'lab porter'`. Assert result `{ pairsMerged: 0, beersDeleted: 0 }`, both row names/bids, and any existing match link still pointing to its original row.

- [ ] **Step 2: Run `npx vitest run src/storage/beers.test.ts src/api/routes/enrich.test.ts src/jobs/dedupe-brewery-aliases.test.ts`.** The LAB8 adoption/peer regression must fail on the old context delivery.
- [ ] **Step 3: Carry raw brewery fields from the actual compared rows.** Add `b.brewery` to both orphan SQL selects in `resolvableOrphan` and `ensureOrphan` and their row types. Compare `o.brewery` against `b.brewery`, retaining `o.style`/`b.style`; never substitute their normalized bucket label for the source brewery.

```ts
// resolvableOrphan and ensureOrphan context:
{ input: { name: o.name, style: o.style, brewery: o.brewery },
  candidate: { name: b.name, style: b.style, brewery: b.brewery } }
```

Change private `pickRowByDigits` to `pickRowByDigits(cardName: string, rows: BeerRow[], cardStyle?: string | null, cardBrewery?: string): BeerRow | null`; its sole `ensureBeerRow` call supplies `brewery` as the fourth argument. Candidate context uses `row.brewery`. Do not change `ROW_TIERS` or oldest-row selection. Dedupe already selects both raw breweries; add `c.orphan_brewery` and `c.canonical_brewery` to its context literal, preserving its existing alias-overlap gate.

There is no catalogue snapshot in these private storage comparisons: use explicit pair labels and their collaboration parts. Do not add a per-row `loadCatalog` or a second catalogue cache. If a future caller has a catalogue, it can pass it through a separately justified scope; that omission does not permit guessed brand neutrality now.

- [ ] **Step 4: Preserve strict tiers and peer reversal.** Add marked #8, one-sided unmarked TAP8 in explicit Schneider context, differing LAB9/LAB10, EL namespace, Czech styles, and inactive/curated row controls to their reachable existing fixtures. Check stored bid/source and link rows exactly after each operation. Do not weaken normalized candidate-pool or ABV gates to manufacture a rescue.
- [ ] **Step 5: Focused GREEN, full gate, named-file commit:** `fix(storage): retain contextual numerical identity before adoption (#664) (U5)`.

## Task 3 (U6): One numbered-series attempt with the original matching input

**Files:** `src/domain/normalize.ts`, `normalize.test.ts`, `src/domain/untappd-lookup.ts`, `untappd-lookup.test.ts`.

**Consumes:** Existing `searchQueryLadder`, `cleanSearchQuery`, `readNameDigits`, raw `LookupArgs` and `matchAgainst` closure. This task does not require a new matcher stage.
**Produces:** Private `numberedSeriesHead(name: string, brewery: string): string | null` in lookup, and marker preservation in query construction. Existing public outcome types remain unchanged.

- [ ] **Step 1: Pin exact query strings and search sequence.** Add literal normalizer cases:

```ts
test.each<[string, string, string]>([
  ['Messorem', 'Temporalis #0061', 'Messorem Temporalis #0061'],
  ['Dziki Wschod', '10th Anniversary no.5', 'Dziki Wschod 10th Anniversary #5'],
  ['Dziki Wschod', '10th Anniversary nr.5', 'Dziki Wschod 10th Anniversary #5'],
  ['Dziki Wschod', 'ONLY TAPS #21', 'Dziki Wschod ONLY TAPS #21'],
])('preserves the series marker for %s / %s', (brewery, name, expected) => {
  expect(cleanSearchQuery(brewery, name)).toBe(expected);
});
```

Use a fake search that records its actual query argument and returns no hits. For `Messorem`, `Temporalis #0061 Citra Dynaboost Nectaron Strata Hyperboost`, assert calls exactly full query then `'Messorem Temporalis #0061'`; no `'Messorem Temporalis'` or `#61`. Repeat one-digit no.5/nr.5 with a trailing descriptor. Assert outcome `not_found`, exact searchUrls using the existing `buildSearchUrl`, and no candidates.

Fixtures must also cover: full query already equals shortened query (one call); two explicit markers; a second hard number/year/version/soft number/hard LAB or EL code after the marker (no shortened attempt); confirmed HBC code tail (shortening allowed); ordinal `10th` before #5 retained; no leading beer text; and an unnumbered old #271 comma-tail fixture unchanged. Pin collaborative brewery parts and deduped actual call arrays.

- [ ] **Step 2: Run focused RED.** `npx vitest run src/domain/normalize.test.ts src/domain/untappd-lookup.test.ts`; confirm marker/call-sequence failures.
- [ ] **Step 3: Preserve markers in the existing builder.** Canonicalize only explicit integer `#`, `no.` and `nr.` spans before name token cleanup, using captured raw digits rather than `canon`. Keep each marker as a whitespace token `#<raw digits>`; retain it even when `fold(tok).length === 1`. All ordinary short-token/noise filtering remains unchanged:

```ts
const SEARCH_SERIES_MARKER = /(?:#\s*|\b(?:no|nr)\.\s*)(\d+)(?![\p{L}\p{N}]|[.,]\d)/giu;
// Apply to the name before stripSearchNoise/stripQueryTokenNoise:
const markedName = name.replace(SEARCH_SERIES_MARKER, (_, digits: string) => ` #${digits} `);
// cleanName uses markedName rather than name. Within its existing token loop:
const markedNumber = /^#\d+$/.test(tok);
if (!f || (!markedNumber && f.length < MIN_QUERY_TOKEN_LENGTH) || BREWERY_NOISE.has(f)) continue;
```

Do not strip that token as a leading/trailing duplicate brewery token. Existing separate #0061 token naturally retains its zeros; no./nr. are canonicalized both in full and shortened queries. Do not treat `10th` as a series marker or globally retain all one-character tokens. Keep Unicode narrow-query behavior; a single extra query uses `searchQueryLadder(part, head)[0]` and does not add a second Latin-fold series rung.

- [ ] **Step 4: Identify safe shortening from raw spans before cleanup.** Collect explicit integer markers with raw offsets and full digit boundaries (exclude decimal/version continuations). Require exactly one marker and nonempty leading beer text. The head includes the marker's original digits and excludes its following descriptor tail. Refuse shortening when `readNameDigits(tail)` has any ordinary numbers, soft numbers, versions, or years; grades/ABV/confirmed hop codes are descriptors. Additionally compare the full name to the head with same raw brewery context; a different result detects contextual LAB/EL/53M hard codes invisible to the context-free reader. Use the already-reviewed predicate, not a duplicate typed-code classifier:

```ts
const SERIES_MARKER = /(?:#\s*|\b(?:no|nr)\.\s*)(\d+)(?![\p{L}\p{N}]|[.,]\d)/giu;
const HAS_SERIES_MARKER = /(?:#|\b(?:no|nr)\.)\s*\d/i;

function numberedSeriesHead(name: string, brewery: string): string | null {
  const markers = [...name.matchAll(SERIES_MARKER)];
  if (markers.length !== 1) return null;
  const marker = markers[0];
  const prefix = name.slice(0, marker.index).trim();
  const tail = name.slice(marker.index + marker[0].length).trim();
  if (!prefix || !tail) return null;
  const head = `${prefix} #${marker[1]}`;
  const tailDigits = readNameDigits(tail);
  if (tailDigits.numbers.length || tailDigits.soft.length || tailDigits.versions.length || tailDigits.years.length) return null;
  if (digitIdentity(readNameDigits(name), readNameDigits(head), {
    input: { name, brewery }, candidate: { name: head, brewery },
  }) !== 'same') return null;
  return head;
}
```

Keep a broader `hasExplicitSeriesMarker` flag for suppressing number-losing fallbacks, including numbered inputs for which this helper returns null. Do not allow a failed shortening check to route a multi-number input into `headBeforeTail`.

- [ ] **Step 5: Add the series loop after the existing full loop, before recursive fallbacks.** It runs only when `seenCandidates.length === 0`. Iterate the existing `parts`, build one query per part, skip an already-tried query string, and use the existing search try/catch, candidate recording, and `matchAgainst` function. The new call remains in the original invocation, so its name gates and digit context see the original full input, not `head`. Return blocked/transient in the same way as full search. A returned candidate goes through existing staging; rejection is not permission for a weaker query.

Wrap #271/#353 recursive retries in `!hasExplicitSeriesMarker` so none later strips a numbered input. For unnumbered inputs retain their current behavior and original raw digit context. Add no recursion merely to change series query text. Search URLs/candidates record actual attempted queries and returned candidates, not synthetic identity assertions.

- [ ] **Step 6: Prove discovery and acceptance separately.** Mock a full zero response then a candidate with wrong #0062: must return `not_found` and retain the candidate. Mock #0061 with a mismatching brewery or incompatible alcohol/ABV: existing gates reject. For `ONLY TAPS #21 GRIT`, make the shortened query return `Only On Taps #21`; assert the actual full-name gate's result and reject any acceptance introduced solely by replacing its input with the head. If the unchanged fuzzy gate already accepts the full original pair, record that evidence and return to design for any stronger GRIT policy; do not invent a new token veto here.

Also assert no series retry when the full response contains candidates but all are rejected; blocked/transient responses do not call search again; no duplicate query; all-Latin empty inputs and unnumbered lookups retain the old ladder. Include a controlled accepted fixture whose full name already satisfies the existing name gate, proving the new query can discover a match without changing identity thresholds.
- [ ] **Step 7: Focused GREEN, full gate, named-file commit:** `fix(search): preserve numbered-series identity on bounded retries (#664) (U6)`.

## Task 4: Contract synchronization, integration measurements, and branch review

**Files:** `spec.md`, this plan's execution report; inspect all modified consumer tests and the approved design.
**Consumes:** Passing U4/U5/U6 gates and the frozen core baseline. **Produces:** Documented delivered contract and review evidence; no automatic PR or deployment.

- [ ] **Step 1: Update the affected Ukrainian spec paragraphs.** Numerical reading: finite proven hop namespaces/fractions, namespace-aware sets, contextual TAP versus hard LAB/EL/53M, exact brewery source spans/Sir James 101, Duvel 6.66 retained. Context: original names/styles/raw pair breweries, catalogue only where available, strict consumer tiers and peers reversal. Lookup: canonical raw marker digits, one extra series query per part only after full zero, no subsequent number loss, original full match input, actual returned-candidate/error evidence. Remove the statement that all glued codes are ignored universally; retain it for unknown forms. Preserve existing #725 paragraphs.
- [ ] **Step 2: Audit every call site.** Run `rg -n 'digitIdentity\(|digitsCompatibleAsPeers\(' src`. Check each actual raw brewery source and style, including all recursive lookup arguments and web hydration calls. Record which paths supply an existing catalogue versus explicit pair context. Read `src/jobs/untappd-enrich.ts` and API lookup callers to verify their raw `LookupArgs` already retain brewery/name/style; no edits are needed solely to repeat data they already pass.
- [ ] **Step 3: Run the last full gate after the last code correction and whole-branch review.** Use `compound-engineering:ce-code-review` sequentially per AGENTS.md; include U1–U6, both inline core corrections, docs, strict storage tiers, search call bounds and #725. Fix evidenced findings with RED/GREEN, full gate and named-file commits. Do not repeat an unchanged passing gate merely to refresh a timestamp.
- [ ] **Step 4: Measure read-only query and complete-match outcomes separately.** Use existing configured Algolia/search access without printing credentials. Re-probe the full and shortened Temporalis #0061, no.5/#5, and ONLY TAPS #21 GRIT examples from the design. Record query strings, search calls, returned bids, complete `lookupBeer` outcomes and rejection gate evidence. Do not invoke write-producing enrichment commands. A single shortened result remains only search evidence.
- [ ] **Step 5: Repeat frozen replay and inspect every changed pair/direction.** Run `REPO="$PWD" node --require tsx/cjs /tmp/664-core-replay.cjs compare`; preserve the original corpus file. Report diagnostic groups separately and explain exact brand/code spans for each transition. Run live integration against read-only data or an isolated disposable DB, never production mutations. Keep unknown/blocked results as unknown/blocked; do not infer rescue counts from candidates alone.
- [ ] **Step 6: Record completeness and limits.** Map all design sections to implemented tasks, list any full-name/pool gates that still miss despite improved digit context, and record no new persistent fact without its individual match evidence. Before any later issue closure the separate AGENTS adjudication procedure remains mandatory. Only after the full branch is reviewable ask about PR creation under the repository policy; no PR or deployment is part of executing this plan by default.

## Planning self-review

- Design §§1–2 are implemented in the reviewed core; consumer delivery (§4) maps to U4/U5, search (§3) to U6, contract/evidence (§5) to Task 4.
- Raw brewery fields exist in matcher/search/web/enrich/dedupe inputs; the two storage selects are the missing raw fields. No per-predicate database request or invented catalogue is needed.
- The new series loop uses the existing full-input `matchAgainst` closure. Unnumbered recursive head/descriptor semantics stay intact; numbered inputs never enter those paths.
- Integration fixture LAB8 shares a real normalized key and changes the old soft-number adoption, so its RED proof reaches the intended guard. CF rejection can already pass because hop recognition is global; it is not presented as a context-delivery RED test.
- A series query uses the existing narrow Unicode rung exactly once; it preserves #5 and zeros, while original full-name matching remains distinct from discovery. GRIT is not guaranteed rescued or rejected without measuring the unchanged name gate.
- The concrete `numberedSeriesHead` snippet was extracted into `/tmp/664-planned-series-head.ts` and executed against the reviewed kernel: 13 literal cases passed, including zeros, no./nr., second markers/numbers/years/versions, contextual LAB8, omitted heads and degree descriptors. This validates the planning example, not implementation of the consumer/search task.
- No new behavior outside the approved classification/query contracts, extension work, schema changes, historical repair, or speculative cache state is planned.
