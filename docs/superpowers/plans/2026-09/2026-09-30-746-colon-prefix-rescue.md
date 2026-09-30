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

- [ ] **Step 1: Write failing unit tests for colon-prefix extraction and tail matching**

Create `src/domain/colon-prefix.test.ts` covering:
- Standard single colon: `Classic: Pils` -> tail `Pils`
- Long collab prefix: `10th Anniversary Collab: Casimir` -> tail `Casimir`
- Collab prefix with accented name: `10th Anniversary Collab: Jozsef` -> tail `Jozsef`
- Negative trap test: `isColonPrefixTailMatch('JOZSEF 17,0°', '10th Anniversary Collab: Josef') === false`
- Negative timing/code test: `isColonPrefixTailMatch('15', '6:15') === false`
- Negative non-colon test: `isColonPrefixTailMatch('Pils', 'Pilsner') === false`
- Multiple colons: `Carles: Gelato: Sangria` -> tails `Gelato: Sangria`, `Sangria`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/colon-prefix.test.ts`
Expected: FAIL (module `colon-prefix` does not exist).

- [ ] **Step 3: Implement `src/domain/colon-prefix.ts`**

Implement:
```typescript
import { baseNormalize, stripSearchNoise, NAME_COLLAB_SEP } from './normalize';

const DIGIT_OR_CODE_PREFIX = /^\d+:\d+/;

export function extractColonTails(beerName: string): string[] {
  if (DIGIT_OR_CODE_PREFIX.test(beerName)) return [];
  const parts = beerName.split(/:\s+/);
  if (parts.length < 2) return [];
  const tails: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const tail = parts.slice(i).join(': ').trim();
    if (tail.length > 0) tails.push(tail);
  }
  return tails;
}

export function isColonPrefixTailMatch(inputName: string, candidateBeerName: string): boolean {
  const tails = extractColonTails(candidateBeerName);
  if (tails.length === 0) return false;
  const inputSides = (NAME_COLLAB_SEP.test(inputName) ? inputName.split(NAME_COLLAB_SEP) : [inputName])
    .map((s) => baseNormalize(stripSearchNoise(s)))
    .filter(Boolean);
  if (inputSides.length === 0) return false;
  const normalizedTails = tails
    .map((t) => baseNormalize(stripSearchNoise(t)))
    .filter(Boolean);
  return normalizedTails.some((t) => inputSides.includes(t));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/colon-prefix.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Commit: `feat(domain): implement pure colon-prefix tail matching predicate (#746)`

---

### Task 2: Integration of `colonPrefixRescue` into `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Modify: `src/domain/untappd-lookup.test.ts`

**Interfaces:**
- Consumes: `isColonPrefixTailMatch` from `src/domain/colon-prefix`
- Produces: `lookupBeer` with `colonPrefixRescue` stage integrated into refusal resolution

- [ ] **Step 1: Write integration tests in `src/domain/untappd-lookup.test.ts`**

Add tests for:
- `lookupBeer` rescues 37961 (`Sarabanda Brewery` / `Pils 11,5°` @ 4.8% -> `Classic: Pils`, bid 6902833)
- `lookupBeer` rescues 37966 (`Ziemia Obiecana/Maplewood Brewery` / `CASIMIR 13,0°` @ 5.5% -> `10th Anniversary Collab: Casimir`, bid 6914830)
- `lookupBeer` rescues 37967 (`Ziemia Obiecana/Brew Your Mind Brewery` / `JOZSEF 17,0°` @ 6.5% -> `10th Anniversary Collab: Jozsef`, bid 6914829)
- Negative boundary: candidate `10th Anniversary Collab: Josef` (bid 6921732 @ 7.0%) alone returns `not_found` for `JOZSEF 17,0°` @ 6.5%
- Negative collision: two candidates with same tail and matching ABV return `not_found`
- Negative ABV gap: candidate ABV 5.5% vs input 4.8% returns `not_found`
- Direct plain candidate precedence: if pool has both `Black Celebration #3` (bid 1) and `Barrel Born: Black Celebration #3` (bid 2), plain candidate is chosen

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "colon-prefix"`
Expected: FAIL (records return `not_found`).

- [ ] **Step 3: Integrate `colonPrefixRescue` into `src/domain/untappd-lookup.ts`**

In `src/domain/untappd-lookup.ts`:
1. Import `isColonPrefixTailMatch` from `./colon-prefix`.
2. Define `colonPrefixRescue(pool: SearchResult[]): SearchResult | null`:
   - Checks `isAlcoholClassMismatch`.
   - Checks if plain exact candidate already exists in pool (`pool.some(r => targetValues.has(baseNormalize(stripSearchNoise(r.beer_name))))`), if so returns `null`.
   - Checks ABV tolerance if input ABV is present; if input ABV is absent or candidate ABV is absent, rejects single-token style names.
   - Collects distinct matching `bid`s.
   - If `hits.size === 1`, returns the unique candidate.
3. Wire `colonPrefixRescue` before `movedLetterRescue`:
   ```typescript
   const rescued = colonPrefixRescue(refusedStrictPools) ?? movedLetterRescue(refusedStrictPools);
   ```
   both in `judge` and at the terminal return of `lookupBeer`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/untappd-lookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full test gate**

Run: `npm test && npm run typecheck`
Expected: ALL PASS.

- [ ] **Step 6: Commit Task 2**

Commit: `feat(domain): integrate colon-prefix rescue in lookupBeer (#746)`

---

### Task 3: Update `spec.md` and Full Verification

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document `colonPrefixRescue` in `spec.md`**

Add description in `spec.md` under `lookupBeer` staging detailing the colon-prefix series rescue.

- [ ] **Step 2: Run full verification gate**

Run: `npm test && npm run typecheck`
Expected: All tests pass, typecheck clean.

- [ ] **Step 3: Commit Task 3**

Commit: `docs(spec): document colon-prefix series rescue in spec.md (#746)`
