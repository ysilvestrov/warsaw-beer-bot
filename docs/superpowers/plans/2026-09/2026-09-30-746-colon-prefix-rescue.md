# #746 Colon-Prefix Rescue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rescue orphan beers where Untappd registers a serial or line prefix followed by a colon (`<prefix>: <tail>`) while the menu or tap supplies only the tail, verified by strict brewery gate, exact tail equality, and corroborating ABV.

**Architecture:** A pure domain predicate `isColonPrefixTailMatch` extracts tails after `:\s+` and verifies exact normalized equality against the input beer name (without degrees/extract). An admission stage `colonPrefixRescue` runs on `refusedStrictPools` in `lookupBeer` as a refusal refinement alongside `movedLetterRescue`, enforcing strict brewery admission, exact tail equality, ABV tolerance, priority of plain exact candidates, and single-bid uniqueness.

**Tech Stack:** TypeScript, Node.js, Vitest

**Spec:** [docs/superpowers/specs/2026-09/2026-09-30-746-colon-prefix-rescue-design.md](file:///home/ysi/warsaw-agy-bb/docs/superpowers/specs/2026-09/2026-09-30-746-colon-prefix-rescue-design.md)

## Global Constraints

- Never perform fuzzy or approximate matching on the colon tail: tail match must be strictly exact after `baseNormalize(stripSearchNoise(s))`.
- Candidate must belong to the strict brewery pool (`strictPool`), must not contradict digit identity (#636), and must not mismatch alcohol class.
- When input ABV is present, candidate ABV must agree within `ABV_TOLERANCE` (0.3).
- Plain exact candidates in the pool take precedence over colon-prefixed variants: if an exact match exists, the colon-prefix rescue abstains.
- Ambiguous candidates (multiple distinct bids matching the tail with corroborating ABV) must yield `not_found`.
- Do not modify `matchBeer` (offline catalog matcher) or database schemas.

## Review Focus

1. `Josef` vs `Jozsef`: Candidate `10th Anniversary Collab: Josef` must NEVER match input `JOZSEF 17,0°`.
2. Time or code colons: Strings like `6:15`, `7:45 Escalation`, or `AB:20` must not be parsed as series colon prefixes.
3. Precedence over colon variants: A pool containing both plain `Black Celebration #3` and `Barrel Born: Black Celebration #3` must pick the direct plain candidate.
4. ABV contradiction: A candidate with a matching tail but ABV diverging by > 0.3% must be rejected.
5. Multiple matching bids: Two candidates from the same brewery sharing the tail with agreeing ABV must not guess.

---

### Task 1: Pure Domain Predicate for Colon-Prefix Matching

**Files:**
- Create: `src/domain/colon-prefix.ts`
- Test: `src/domain/colon-prefix.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function extractColonTails(beerName: string): string[];
  export function isColonPrefixTailMatch(inputName: string, candidateBeerName: string): boolean;
  ```

- [x] **Step 1: Write failing unit tests for colon-prefix extraction and tail matching**
- [x] **Step 2: Run test to verify it fails**
- [x] **Step 3: Implement `src/domain/colon-prefix.ts`**
- [x] **Step 4: Run test to verify it passes**
- [x] **Step 5: Commit Task 1**

Commit: `feat(domain): implement pure colon-prefix tail matching predicate (#746)`

---

### Task 2: Integration of `colonPrefixRescue` into `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Modify: `src/domain/untappd-lookup.test.ts`

**Interfaces:**
- Consumes: `isColonPrefixTailMatch` from `src/domain/colon-prefix`
- Produces: `lookupBeer` with `colonPrefixRescue` stage integrated into refusal resolution

- [x] **Step 1: Write integration tests in `src/domain/untappd-lookup.test.ts`**
- [x] **Step 2: Run test to verify it fails**
- [x] **Step 3: Integrate `colonPrefixRescue` into `src/domain/untappd-lookup.ts`**
- [x] **Step 4: Run tests to verify they pass**
- [x] **Step 5: Run full test gate**
- [x] **Step 6: Commit Task 2**

Commit: `feat(domain): integrate colon-prefix rescue in lookupBeer (#746)`

---

### Task 3: Update `spec.md` and Full Verification

**Files:**
- Modify: `spec.md`

- [x] **Step 1: Document `colonPrefixRescue` in `spec.md`**
- [x] **Step 2: Run full verification gate**
- [x] **Step 3: Commit Task 3**

Commit: `docs(spec): document colon-prefix series rescue in spec.md (#746)`

---

### Task 4: Address Claude Cross-Review Findings

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Modify: `src/domain/untappd-lookup.test.ts`
- Modify: `src/domain/digit-identity.ts`
- Modify: `src/domain/digit-identity.test.ts`
- Modify: `src/domain/colon-prefix.test.ts`
- Modify: `spec.md`
- Modify: `docs/superpowers/specs/2026-09/2026-09-30-746-colon-prefix-rescue-design.md`

- [x] **Step 1: Resolve all 9 Claude cross-review findings**
  - Finding 1: Document `coverageScore` single-token guard in spec and design doc; add unit and integration tests.
  - Finding 2: Document `digitIdentity` ordinals in spec, design doc, and plan; add tests for `1st`, `2nd`, `3rd`, `11th` and `digitsCompatibleAsPeers`.
  - Finding 3: Isolate Josef exact-tail guard test by giving `josef` identical ABV (6.5).
  - Finding 4 & 5: Check `candNorm`, `candId`, `stripped` against `targetValues` in condition 6; add test where plain candidate was refused due to ABV divergence and test candidate with brewery name in title.
  - Finding 6 & 7: Add ABV boundaries (0.3 vs 0.31), missing ABV tests, alcohol-class guard tests, non-strict brewery test, `rescueDecided` test, and edge cases in `colon-prefix.test.ts`; strengthen negative assertions to exact objects.
  - Finding 8: Make spec and code ABV conditions consistent; simplify dead code in `untappd-lookup.ts`.
  - Finding 9: Isolate uniqueness in ambiguity test by using `Series Alpha` vs `Series Beta`.
- [x] **Step 2: Run full verification gate (`npm test && npm run typecheck`)**
- [ ] **Step 3: Commit Task 4**

Commit: `fix(domain): address cross-review findings for colon-prefix rescue (#746)`
