# #505 — The Token Filter May Not Leave a Name Without Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `normalizeName`'s token filter from erasing the only tokens that identify a beer, without letting the recovered tokens become a licence to guess.

**Architecture:** A new pure module `src/domain/name-identity.ts` computes a beer name's *identity* — brewery-aware, with a fallback that fires only when the filter would leave nothing beyond the brand — and carries a `restored` flag saying whether the fallback fired. `src/domain/untappd-lookup.ts` uses it on **both** the input and the candidate side, and gates approximate stages so restored evidence needs corroboration. `normalizeName` and `nameKeys` are not touched.

**Tech Stack:** TypeScript, Node 24, Vitest (globals enabled — do not import `describe`/`test`), `fast-fuzzy`.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-26-505-name-identity-floor-design.md`

## Global Constraints

- **`normalizeName` must not change.** It also feeds the search-query builder; re-admitting `2024` / `10°` there re-poisons queries (#295, #321).
- **`nameKeys` must not change.** Measured: a single-token restored identity is served by the existing non-key stages, so the `toks.length < 2` weak-key rule stays.
- **The rule lands on both sides in ONE change.** Measured: input-only gains 0 and *loses* 2 rows. There is no valid intermediate state, so Task 3 may not be split or partially merged.
- **Reuse existing constants**: `ABV_TOLERANCE` (0.3) from `./matcher`, `extractGrade` (grades 7–20 plus Czech grade words) from `./czech-grade`. Do not redefine either.
- **Style**: functional, no classes, no mutation of inputs. Match the surrounding file's comment density — this codebase explains *why*, not *what*.
- **Every guard must be mutation-proven**: delete the guard line, watch the named test go red, restore it. A test that passes with the guard deleted is not a test.
- Scratch scripts live in `./tmp/` (gitignored). The validated replay harness is already there.

---

### Task 1: The identity computation

**Files:**
- Create: `src/domain/name-identity.ts`
- Test: `src/domain/name-identity.test.ts`

**Interfaces:**
- Consumes: `normalizeName`, `baseNormalize`, `normalizeBrewery` from `./normalize`; `stripBreweryFromName` from `./matcher`.
- Produces:
  - `export interface NameIdentity { value: string; restored: boolean }`
  - `export function nameIdentity(rawName: string, breweryNorm: string): NameIdentity`
  - `export function candidateIdentity(beerName: string, breweryName: string): NameIdentity`

- [ ] **Step 1: Write the failing tests**

```ts
import { nameIdentity, candidateIdentity } from './name-identity';
import { normalizeBrewery } from './normalize';

const ident = (name: string, brewery: string) => nameIdentity(name, normalizeBrewery(brewery));

describe('nameIdentity', () => {
  test('leaves a name alone when the filter leaves something behind', () => {
    // The filter did its job: "ipa" is noise, "buzdygan rozkoszy" is the beer.
    const out = ident('Buzdygan Rozkoszy IPA', 'Buzdygan');
    expect(out.value).toBe('rozkoszy');
    expect(out.restored).toBe(false);
  });

  test('shape A: recovers a name the filter empties completely', () => {
    const out = ident('Weizen', 'Primátor');
    expect(out.value).toBe('weizen');
    expect(out.restored).toBe(true);
  });

  test('shape B: recovers a name the filter reduces to the bare brand', () => {
    // normalizeName('Kronenbourg 1664') === 'kronenbourg' — non-empty, but no identity.
    const out = ident('Kronenbourg 1664', 'Kronenbourg Brewery');
    expect(out.value).toBe('1664');
    expect(out.restored).toBe(true);
  });

  test('the witness: one name that all three predicates strip', () => {
    // 300 = digit, IBU = spec label, IPA = style word. bid 212077.
    const out = ident('300 IBU IPA', 'Southern Brewing & Winemaking');
    expect(out.value).toBe('300 ibu ipa');
    expect(out.restored).toBe(true);
  });

  test('a sibling with surviving content does NOT restore, so it stays distinct', () => {
    const bare = ident('1664', 'Brasseries Kronenbourg');
    const blanc = ident('1664 Blanc', 'Brasseries Kronenbourg');
    expect(bare.value).toBe('1664');
    expect(blanc.value).toBe('blanc');
    expect(blanc.restored).toBe(false);
    expect(bare.value).not.toBe(blanc.value);
  });

  test('beers indistinguishable today become distinguishable', () => {
    expect(ident('0 IBU', 'Mikkeller').value).toBe('0 ibu');
    expect(ident('1000 IBU', 'Mikkeller').value).toBe('1000 ibu');
  });

  test('a name that is nothing but the brand is not rescued', () => {
    // "Holba Brewery / Holba" has no identity to recover; #306 owns this case.
    const out = ident('Holendr', 'Pivovar Holendr Brewery');
    expect(out.restored).toBe(false);
  });

  test('candidateIdentity keys on the candidate own brewery', () => {
    const out = candidateIdentity('1664', 'Brasseries Kronenbourg');
    expect(out).toEqual({ value: '1664', restored: true });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/domain/name-identity.test.ts`
Expected: FAIL — `Failed to resolve import "./name-identity"`.

- [ ] **Step 3: Write the implementation**

```ts
import { baseNormalize, normalizeBrewery, normalizeName } from './normalize';
import { stripBreweryFromName } from './matcher';

/**
 * #505 — a beer name's identity, and whether we had to dig it back out.
 *
 * `normalizeName` is one filter chaining STYLE_WORDS, SPEC_LABEL_WORDS and
 * isNumericNoise. Each predicate removes real noise; between them they can remove
 * every token that says *which* beer this is, leaving either the empty string
 * ("Weizen") or the bare brewery brand ("Kronenbourg 1664" -> "kronenbourg").
 * A name in that state cannot discriminate, and the matcher then decides on some
 * other property — which is how a 0.5% ABV typo picked a different product (#487).
 */
export interface NameIdentity {
  /** The identity tokens, brewery echo removed. */
  value: string;
  /** True when the filter destroyed everything and we fell back to unfiltered tokens. */
  restored: boolean;
}

/**
 * Identity means "a token that is not part of the brewery brand". Testing for the
 * EMPTY STRING is not enough: `stripBreweryFromName` refuses to strip a name to
 * nothing, so "Kronenbourg 1664" survives as the non-empty but identity-less
 * "kronenbourg".
 */
function hasIdentity(norm: string, breweryNorm: string): boolean {
  const brandTokens = new Set(breweryNorm.split(' ').filter(Boolean));
  return norm.split(' ').filter(Boolean).some((token) => !brandTokens.has(token));
}

/**
 * Today's value, unless the filter left nothing beyond the brand — then re-derive
 * from the unfiltered tokens. Self-limiting by construction: the fallback can only
 * fire where the filtered form has nothing to lose, so every name the filter was
 * built for ("Buzdygan Rozkoszy IPA") is untouched.
 *
 * `breweryNorm` must already be normalized (`normalizeBrewery`), because callers
 * on the hot path have it in hand and re-normalizing per candidate is wasted work.
 */
export function nameIdentity(rawName: string, breweryNorm: string): NameIdentity {
  const filtered = normalizeName(rawName);
  if (hasIdentity(filtered, breweryNorm)) {
    return { value: stripBreweryFromName(filtered, breweryNorm), restored: false };
  }
  const unfiltered = baseNormalize(rawName);
  if (hasIdentity(unfiltered, breweryNorm)) {
    return { value: stripBreweryFromName(unfiltered, breweryNorm), restored: true };
  }
  // Nothing to recover — the name really is only the brand. #306 owns that case.
  return { value: stripBreweryFromName(filtered, breweryNorm), restored: false };
}

/** A search candidate's identity, keyed on the candidate's OWN brewery. */
export function candidateIdentity(beerName: string, breweryName: string): NameIdentity {
  return nameIdentity(beerName, normalizeBrewery(breweryName));
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/domain/name-identity.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation-prove the two branches**

Delete `if (hasIdentity(filtered, breweryNorm)) { ... }` — the "leaves a name alone" and "1664 Blanc stays distinct" tests must go red. Restore it.
Change `!brandTokens.has(token)` to `true` in `hasIdentity` — the "shape B" test must go red (nothing would ever restore). Restore it.
Record both results in the commit message. If either mutation leaves the suite green, the test is vacuous — fix the test, not the code.

- [ ] **Step 6: Commit**

```bash
git add src/domain/name-identity.ts src/domain/name-identity.test.ts
git commit -m "feat(#505): a name's identity, and whether we had to restore it"
```

---

### Task 2: Restored identity is second-class evidence

**Files:**
- Modify: `src/domain/name-identity.ts`
- Test: `src/domain/name-identity.test.ts`

**Interfaces:**
- Consumes: `NameIdentity` from Task 1; `ABV_TOLERANCE` from `./matcher`; `extractGrade` from `./czech-grade`.
- Produces: `export function identityAllowsApprox(target: NameIdentity, candidate: NameIdentity, inputAbv: number | null, candidateAbv: number | null): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
import { identityAllowsApprox, type NameIdentity } from './name-identity';

const plain = (value: string): NameIdentity => ({ value, restored: false });
const back = (value: string): NameIdentity => ({ value, restored: true });

describe('identityAllowsApprox', () => {
  test('untouched identities on both sides are never gated', () => {
    expect(identityAllowsApprox(plain('rozkoszy'), plain('rozkoszyy'), null, null)).toBe(true);
  });

  test('restored evidence with an exact match needs no ABV', () => {
    expect(identityAllowsApprox(back('weizen'), back('weizen'), null, null)).toBe(true);
  });

  test('restored evidence approximating needs ABV agreement', () => {
    // "IPA" must not reach "IPALIT" at 7.0 vs 7.5.
    expect(identityAllowsApprox(back('ipa'), plain('ipalit'), 7, 7.5)).toBe(false);
    expect(identityAllowsApprox(back('weizen'), plain('weizenbier'), 4.8, 4.8)).toBe(true);
  });

  test('restored evidence approximating with no ABV at all is refused', () => {
    expect(identityAllowsApprox(back('wheat'), plain('wheatly'), null, 4.3)).toBe(false);
  });

  test('a bare grade is exact-only — ABV is not a substitute', () => {
    // "11" @4.5 must not reach "Session IPA 11%" @4.7 even though 0.2 is inside tolerance.
    expect(identityAllowsApprox(back('11'), back('session 11'), 4.5, 4.7)).toBe(false);
  });

  test('but a beer literally NAMED after the number still matches', () => {
    // Browar Artezan — 11; Nepo Brewing — 15. The number is the name, not the grade.
    expect(identityAllowsApprox(back('11'), back('11'), 6.5, 6.5)).toBe(true);
    expect(identityAllowsApprox(back('15'), back('15'), 6.8, 6.8)).toBe(true);
  });

  test('a number outside the grade range is an ordinary restored token', () => {
    // 1664 is not a grade, so ABV corroboration applies as usual.
    expect(identityAllowsApprox(back('1664'), plain('1664 blanc'), 5, 5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/domain/name-identity.test.ts -t identityAllowsApprox`
Expected: FAIL — `identityAllowsApprox is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/domain/name-identity.ts`. **Extend** the existing `./matcher` import rather than adding
a second one (`stripBreweryFromName` is already imported from there by Task 1), and add the
`czech-grade` import:

```ts
// existing line becomes:
import { ABV_TOLERANCE, stripBreweryFromName } from './matcher';
// new line:
import { extractGrade } from './czech-grade';

/**
 * A restored token is a style word, a spec label or a bare grade — exactly the noise
 * the filter exists to remove. Handing it to an approximate stage as full identity
 * turns "IPA" into "IPALIT" and "Wheat" into "We're Wheatly Sorry" (measured: 6 wrong
 * matches over the 326 at-risk rows). So restored evidence buys an EXACT match
 * outright, and an approximate one only with ABV agreement.
 */
function isBareGrade(ident: NameIdentity): boolean {
  if (!ident.restored) return false;
  const tokens = ident.value.split(' ').filter(Boolean);
  return tokens.length === 1 && extractGrade(tokens[0]) !== null;
}

export function identityAllowsApprox(
  target: NameIdentity,
  candidate: NameIdentity,
  inputAbv: number | null,
  candidateAbv: number | null,
): boolean {
  if (!target.restored && !candidate.restored) return true;
  const exact = target.value === candidate.value;
  // A bare grade ("11", "desítka") is a strength marker, not a name — UNLESS the other
  // side is the same bare token, in which case the number really is the beer's name
  // (Browar Artezan — 11, Nepo Brewing — 15). Measured: forbidding grades outright cost
  // three correct matches; exact-only keeps them and still refuses `11` -> `Session IPA 11%`.
  if (isBareGrade(target) || isBareGrade(candidate)) return exact;
  if (exact) return true;
  return (
    inputAbv != null && candidateAbv != null && Math.abs(candidateAbv - inputAbv) <= ABV_TOLERANCE
  );
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/domain/name-identity.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Mutation-prove the grade rule**

Replace `if (isBareGrade(target) || isBareGrade(candidate)) return exact;` with `;` — the "bare grade is exact-only" test must go red. Restore it.
Replace `return exact;` in that same line with `return true;` — the same test must go red. Restore it.

- [ ] **Step 6: Commit**

```bash
git add src/domain/name-identity.ts src/domain/name-identity.test.ts
git commit -m "feat(#505): restored identity is second-class evidence"
```

---

### Task 3: Wire both sides into the lookup — one change, no intermediate state

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (five sites, listed below)
- Test: `src/domain/untappd-lookup.test.ts`
- Test: `src/domain/name-identity.test.ts` (Step 4 adds the vintage-premise guard here — it pins
  `normalizeName`, which is a `name-identity` concern, not a lookup one)

**Interfaces:**
- Consumes: `nameIdentity`, `candidateIdentity`, `identityAllowsApprox`, `NameIdentity` from `./name-identity`.
- Produces: `FuzzyTarget` gains `restored: boolean`, consumed by Task 4.

**Why this is one task:** measured, input-only gains 0 rows and loses 2. A reviewer cannot approve half of this.

- [ ] **Step 1: Write the failing tests**

Add to `src/domain/untappd-lookup.test.ts`:

```ts
describe('lookupBeer — name identity floor (#505)', () => {
  test('matched: a bare style-word candidate is reachable', async () => {
    const search = fakeSearch(() => [
      { bid: 30947, beer_name: 'Weizen', brewery_name: 'Primátor', style: 'Hefeweizen', abv: 4.8, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Primator Brewery', name: 'Weizenbier', abv: 4.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(30947);
  });

  test('matched: the digit that IS the name beats the ABV coincidence', async () => {
    // The shop says 5.0, which points at 1664 Blanc. The name says 1664.
    const search = fakeSearch(() => [
      { bid: 5939, beer_name: '1664', brewery_name: 'Brasseries Kronenbourg', style: 'Lager', abv: 5.5, global_rating: 3.4 },
      { bid: 5999, beer_name: '1664 Blanc', brewery_name: 'Brasseries Kronenbourg', style: 'Witbier', abv: 5, global_rating: 3.6 },
    ]);
    const out = await lookupBeer({ brewery: 'Kronenbourg Brewery', name: 'Kronenbourg 1664', abv: 5, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5939);
  });

  test('BOTH sides must apply the rule: input-only would break this row', async () => {
    // Guards the measured regression: with the rule on the input side only, the target
    // becomes "weizen" while the candidate stays "", and this row stops matching.
    const search = fakeSearch(() => [
      { bid: 30947, beer_name: 'Weizen', brewery_name: 'Primátor', style: 'Hefeweizen', abv: 4.8, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Primator Brewery', name: 'Primator Weizen', abv: 4.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(30947);
  });

  test('not_found: restored evidence never fuzzy-reaches a different beer', async () => {
    // "IPA" must not become "IPALIT".
    const search = fakeSearch(() => [
      { bid: 4463769, beer_name: 'IPALIT (ИПАЛИТ)', brewery_name: 'Augustine (Августин)', style: 'IPA', abv: 7.5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Августин', name: 'IPA', abv: 7, search });
    expect(out.kind).toBe('not_found');
  });

  test('not_found: a bare brand plus a style word stays an honest orphan', async () => {
    // "Tyskie Lager" carries no identity beyond the brand; guessing is worse than refusing.
    const search = fakeSearch(() => [
      { bid: 5334255, beer_name: 'Tyskie Sport Lager', brewery_name: 'Tyskie Browary Książęce', style: 'Lager', abv: 4.6, global_rating: 3.2 },
      { bid: 5099975, beer_name: 'Książęce Lager', brewery_name: 'Tyskie Browary Książęce', style: 'Lager', abv: 5, global_rating: 3.3 },
    ]);
    const out = await lookupBeer({ brewery: 'Tyskie Brewery', name: 'Tyskie Lager', abv: 4.6, search });
    expect(out.kind).toBe('not_found');
  });

  test('unchanged: a name the filter leaves intact still matches as before', async () => {
    const search = fakeSearch(() => [
      { bid: 6620595, beer_name: 'Buzdygan Rozkoszy', brewery_name: 'Harpagan Craft Beer', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Harpagan', name: 'Buzdygan Rozkoszy IPA', abv: 5, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6620595);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "name identity floor"`
Expected: the four `matched` tests FAIL with `not_found`; the two `not_found` tests may already pass — that is fine, they are regression guards, not drivers.

- [ ] **Step 3: Apply the five edits**

Add the import at the top of `src/domain/untappd-lookup.ts`:

```ts
import { nameIdentity, candidateIdentity, identityAllowsApprox, type NameIdentity } from './name-identity';
```

Add a candidate-identity helper next to `fuzzyTargets` (candidates are re-read at several stages, so give it one name):

```ts
const candIdent = (c: SearchResult): NameIdentity => candidateIdentity(c.beer_name, c.brewery_name);
const candIdentValue = (c: SearchResult): string => candIdent(c).value;
```

**3a.** `interface FuzzyTarget` — add the flag:

```ts
interface FuzzyTarget {
  value: string;
  exactOnly: boolean;
  restored: boolean;
}
```

**3b.** In `fuzzyTargets`, replace the `value` line and the `targets.set` line:

```ts
    const ident = nameIdentity(raw, breweryNorm);
    const value = ident.value;
    if (!value) continue;
    const tokenCount = value.split(' ').filter(Boolean).length;
    const exactOnly = index > 0 && tokenCount < 2;
    const existing = targets.get(value);
    targets.set(value, {
      value,
      exactOnly: (existing?.exactOnly ?? true) && exactOnly,
      restored: ident.restored,
    });
```

**3c.** In `nearNameScore`, add the restored form to `candidateVariants`:

```ts
  const candidateVariants = new Set([
    candidateNameNorm,
    stripBreweryFromName(candidateNameNorm, candidateBreweryNorm),
    candIdentValue(candidate),
  ]);
```

**3d.** Stage 2a.5 — gate the near-name score on corroboration:

```ts
            const score =
              (identityAllowsApprox(targetName, candIdent(result), abv, result.abv)
                ? nearNameScore(targetName.value, result, strictPool.length === 1)
                : null) ??
              swappedBrandNameScore(targetName.value, inputBreweryAliases, result);
```

**3e.** Stage 2b — key the searcher on identity, and gate the filter:

```ts
      const searcher = new Searcher(strictPool, {
        keySelector: (r) => candIdentValue(r),
        threshold: NAME_FUZZY_THRESHOLD,
        returnMatchData: true,
      });
      const matches = targetNames
        .flatMap((targetName) =>
          searcher
            .search(targetName.value)
            .filter(
              (m) =>
                (!targetName.exactOnly || candIdentValue(m.item) === targetName.value) &&
                identityAllowsApprox(targetName, candIdent(m.item), abv, m.item.abv),
            ),
        )
        .sort((a, b) => b.score - a.score);
```

**3f.** `relaxedExact` — accept a restored-identity equality too. This is the stage row 196 wins on, and its pool is the RELAXED one, so do not "tighten" it to strict:

```ts
    const relaxedExact = relaxedPool.filter(
      (r) =>
        relaxedTargetValues.has(normalizeName(r.beer_name)) ||
        relaxedTargetValues.has(candIdentValue(r)),
    );
```

- [ ] **Step 4: Pin the vintage premise (Decision 5)**

`#504` predicted that restoring digits would disturb the vintage partition. It does not, for a
structural reason: `normalizeName` is untouched and `extractYear` reads the **raw** name. That is a
premise, so pin it — add to `src/domain/name-identity.test.ts`:

```ts
import { normalizeName } from './normalize';
import { extractYear } from './matcher';

describe('the vintage partition still sees what it always saw (#505 / #504)', () => {
  test('normalizeName still strips the year, and extractYear still reads the raw name', () => {
    // This test fails the moment someone "simplifies" the identity floor into
    // normalizeName itself — which would re-poison queries (#295) and move the
    // input extractYear partitions on (matcher.ts).
    expect(normalizeName('Funky Fluid Tribute To Billie 2024')).toBe('funky fluid tribute to billie');
    expect(extractYear('Funky Fluid Tribute To Billie 2024')).toBe(2024);
  });
});
```

Run: `npx vitest run src/domain/name-identity.test.ts -t "vintage partition"`
Expected: PASS immediately — it guards a premise rather than driving new code.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, including every pre-existing `untappd-lookup` test. If an existing test goes red, stop and report it — it is evidence about the design, not a test to be edited.

- [ ] **Step 6: Mutation-prove the both-sides requirement**

Revert **both** candidate-side edits — **3c** and **3e** — leaving 3b in place, so the rule applies to
the input side alone. The test `BOTH sides must apply the rule` must go red (verified during design:
input-only returns `not_found` for this fixture). Restore both, and record the result in the commit
message. Note the two edits guard different rows: reverting 3e alone still leaves `Primator Weizen`
matching, while `Weizenbier` needs 3c — so do not treat either as redundant.

- [ ] **Step 7: Commit**

```bash
git add src/domain/name-identity.test.ts src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(#505): the token filter may not leave a name without identity"
```

---

### Task 4: Gate the identity-alias rescue

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (the `identityHits` branch)
- Test: `src/domain/untappd-lookup.test.ts`

**Interfaces:**
- Consumes: `FuzzyTarget.restored` from Task 3; the existing `pickUniqueByAbv(results, abv, rejectAbvContradiction)`.
- Produces: nothing new.

**Why separate:** a reviewer can accept Task 3 and reject this. The stage was found by tracing, and it is the one place a restored input can still buy a badly-off candidate.

- [ ] **Step 1: Write the failing test**

```ts
  test('not_found: the identity-alias rescue refuses an ABV contradiction on restored evidence', async () => {
    // "Lambic Boon" restores to "lambic"; the rescue must not hand back a 7% beer for a 4% tap.
    const search = fakeSearch(() => [
      { bid: 756972, beer_name: 'Unblended Oude Lambiek', brewery_name: 'Brouwerij Boon', style: 'Lambic', abv: 7, global_rating: 3.9 },
    ]);
    const out = await lookupBeer({ brewery: 'Brouwerij Boon Brewery', name: 'Lambic Boon', abv: 4, search });
    expect(out.kind).toBe('not_found');
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "identity-alias rescue"`
Expected: FAIL — `matched` with bid 756972.

- [ ] **Step 3: Apply the edit**

```ts
    if (identityHits.length > 0) {
      // #505: when the input's own identity had to be restored, this rescue must not
      // accept a candidate whose ABV contradicts the input — restored evidence is too
      // weak to carry a 3% gap on its own.
      const inputRestored = targetNames.some((t) => t.restored);
      const identityHit = pickUniqueByAbv(identityHits, abv, inputRestored);
      return identityHit ? { kind: 'matched', result: identityHit } : typoRescue();
    }
```

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Mutation-prove it**

Change `inputRestored` to `false` in the `pickUniqueByAbv` call — the new test must go red. Restore it.

- [ ] **Step 6: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(#505): the identity-alias rescue inherits the restored-evidence gate"
```

---

### Task 5: Re-measure against production, and update `spec.md`

**Files:**
- Modify: `spec.md` (the matching-invariants list, near "Голий бренд — тільки exact")
- Use: `./tmp/replay.ts`, `./tmp/rows-affected.json`, `./tmp/rows-trigger.json`, `./tmp/search-cache.json` (already present)

**Interfaces:** none — this task produces evidence and documentation.

- [ ] **Step 1: Point the replay harness at the real module**

The harness compares two implementations. The "after" side is the real
`../src/domain/untappd-lookup.js`. The "before" side is the pre-change file, which is addressable in
git history — **do not stash anything**:

```bash
git show c397cb5:src/domain/untappd-lookup.ts   | sed -e "s#from './matcher'#from '../src/domain/matcher'#"         -e "s#from './normalize'#from '../src/domain/normalize'#"         -e "s#from './czech-grade'#from '../src/domain/czech-grade'#"         -e "s#from '../sources/untappd/search'#from '../src/sources/untappd/search'#"         -e "s#from '../sources/http'#from '../src/sources/http'#"         -e "s#from '../sources/untappd/block'#from '../src/sources/untappd/block'#"         -e "s#from './rating-dominance'#from '../src/domain/rating-dominance'#"   > ./tmp/lookup-base.ts
```

Then edit `./tmp/replay.ts` so the baseline import is `./lookup-base.js` and the other is
`../src/domain/untappd-lookup.js`.

- [ ] **Step 2: Re-run both populations**

```bash
npx tsx ./tmp/replay.ts ./tmp/rows-affected.json
npx tsx ./tmp/replay.ts ./tmp/rows-trigger.json > ./tmp/out-final.txt; tail -1 ./tmp/out-final.txt
grep -c "✓EXPECTED" ./tmp/out-final.txt
```

Expected, and every number must be reconciled if it differs:

```
affected : 23 rows | gained 5 | lost 0 | switched 0
trigger  : 326 rows | 191 on the stored bid | 12 disagreements
           8 of those are baseline WRONG links now refused
           2 bad (30272 accepted by design; 31180 belongs to #506)
           2 benign (3018, 4760)
```

A number that moved is a finding, not a nuisance: name it and explain it before merging. The search cache makes the run deterministic and costs no live traffic; delete `./tmp/search-cache.json` first if a live re-verification is wanted.

- [ ] **Step 3: Add the invariant to `spec.md`**

In the matching-invariants list (the block containing «Голий бренд — тільки exact»), add:

```markdown
- **Фільтр токенів не має права лишити назву без ідентичності (#505).** `normalizeName`
  прибирає стильові слова, спец-мітки (`alc`/`abv`/`ibu`) і чисті цифри. Якщо разом вони
  з'їдають **усі** токени, не пов'язані з брендом, ідентичність береться з нефільтрованих
  токенів (`nameIdentity`, `src/domain/name-identity.ts`). Правило самообмежувальне: воно
  спрацьовує лише там, де відфільтрована форма не має що втрачати, тож
  `Buzdygan Rozkoszy IPA` → `Buzdygan Rozkoszy` не змінюється. **Сам `normalizeName` НЕ
  змінюється** — він годує ще й побудову запиту, а повернення `2024`/`10°` туди відкотило б
  #295 і #321. Відновлена ідентичність — доказ **другого сорту**: точний збіг приймається,
  наближений вимагає збігу ABV у межах `ABV_TOLERANCE`, а голий чеський градус — лише точний.
```

- [ ] **Step 4: Verify the docs build and the suite is green**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spec.md
git commit -m "docs(#505): spec.md — the identity floor invariant"
```

---

## After the plan

Open the PR, wait for the AI review, and verify every comment against the measurements above rather than accepting or dismissing it on sight. Do **not** run `gh pr merge` — the user merges. After the merge lands and is deployed, closing #505 unlocks its 7 rows through the #421 keyed lock; 239 and 29561 are knowingly not covered and will each spend one retry.
