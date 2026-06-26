# Curated brewery-alias layer (GH #202)

**Date:** 2026-06-26
**Issue:** #202 — *matcher: add curated brewery aliases for recurring orphan misses*

## Problem

Orphan triage on 2026-06-26 surfaced many `matcher_bug` rows where Untappd
returned an exact or near-exact beer, but the brewery hard-gate rejected it
because the shop brewery label and the Untappd brewery label are **known aliases**
(different name / spelling of the same brewery) rather than token-prefix variants.

The gate (`breweryAliasesMatch` → `tokenPrefix`) only accepts a leading,
whole-token prefix in either direction. So these all fail despite being the same
brewery:

| shop label (normalized)         | Untappd label (normalized)                       |
|---------------------------------|--------------------------------------------------|
| `nepomucen`                     | `nepo`                                            |
| `van honsebrouck`               | `kasteel vanhonsebrouck`                          |
| `bacchus`                       | `kasteel vanhonsebrouck` (filed under parent)     |
| `weihenstephaner`               | `bayerische staatsbrauerei weihenstephan`         |
| `hopbrook`                      | `hop brook`                                        |
| `starkaft`                      | `starkraft` (spelling)                            |

## Goals / non-goals

- **Goal:** a small, finite, hand-curated equivalence layer so these specific
  pairs pass the brewery gate.
- **Goal:** the layer is shared by both the server lookup (`untappd-lookup.ts`)
  and local catalog matching (`matcher.ts`).
- **Goal:** a cheap, documented path to grow the list during orphan triage.
- **Non-goal:** any general / fuzzy brewery matching. The list stays explicit and
  human-reviewed; nothing is added automatically.

## Design

### 1. Data module — `src/domain/brewery-aliases.ts`

A finite list of equivalence **pairs**, expressed in the exact form
`normalizeBrewery()` produces (verified, not guessed):

```ts
const ALIAS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['nepomucen', 'nepo'],
  ['van honsebrouck', 'kasteel vanhonsebrouck'],
  ['kasteel vanhonsebrouck', 'bacchus'],
  ['weihenstephaner', 'bayerische staatsbrauerei weihenstephan'],
  ['hopbrook', 'hop brook'],
  ['starkaft', 'starkraft'],
];
```

At module load these build a **symmetric, non-transitive** adjacency map
`Map<string, string[]>`: each form maps to the partners it is *directly* paired
with. Non-transitive is deliberate — `van honsebrouck` and `bacchus` both sit
under `kasteel vanhonsebrouck`, but we do **not** want them to become equivalent
to each other. Only the listed pairs match.

Exported surface:

```ts
// Direct curated partners of a normalized brewery form (empty if none).
export function aliasNeighbors(normForm: string): string[];
```

### 2. Hook — `breweryAliases()` in `matcher.ts`

After the existing normalization builds the alias `Set`, do **one hop** of
expansion: snapshot the current aliases, and for each, union in its
`aliasNeighbors(...)`. Return the expanded array.

One hop is provably sufficient for every pair above, because the shared canonical
form bridges both sides. Worked example (Bacchus, the trickiest):

- input `bacchus` → `breweryAliases` → `['bacchus']` → expand → `['bacchus', 'kasteel vanhonsebrouck']`
- candidate Untappd brewery `Kasteel Brouwerij Vanhonsebrouck` → `['kasteel vanhonsebrouck']` → expand → `['kasteel vanhonsebrouck', 'van honsebrouck', 'bacchus']`
- `breweryAliasesMatch` finds `kasteel vanhonsebrouck` ≡ `kasteel vanhonsebrouck` (and `bacchus` ≡ `bacchus`) → gate passes.

Both call sites (`matcher.matchPrepared`, `untappd-lookup.lookupBeer`) build aliases
exclusively through `breweryAliases()`, so they inherit the expansion unchanged.
No other code changes in those files.

### 3. Why it is FP-safe

Expansion only widens the **brewery gate** candidate pool. The independent name
stage still must pass:

- local matcher: exact `nameNorm` equality / `nameKeys` intersection, else fuzzy
  ≥ `FUZZY_THRESHOLD` with the `nameTokensDiverge` guard;
- server lookup: `nameKeys` intersection (Stage 2a), else strict-pool fuzzy
  ≥ 0.85 (Stage 2b).

So a stray alias cannot by itself produce a wrong match — it can only let a beer
through the gate that then has to match by name anyway. Combined with the list
being tiny and specific, FP risk is low.

### 4. Enrichment path during orphan triage

The friction in adding a correct pair is getting the exact normalized forms. A
helper removes it.

**Helper — `scripts/brewery-alias-key.ts`** (run via `npx tsx`, matching the
existing `scripts/` convention; no new deps):

```
npx tsx scripts/brewery-alias-key.ts "Brouwerij Van Honsebrouck Brewery" "Kasteel Brouwerij Vanhonsebrouck"
# prints, ready to paste:
['van honsebrouck', 'kasteel vanhonsebrouck'],
```

It calls `normalizeBrewery` on each argument and prints the pair literal. It only
prints — it never edits the table, so every addition stays a human-reviewed PR
edit. An npm script `alias-key` wraps it for convenience.

**Triage workflow** (added to the runbook): when a `matcher_bug` row is genuinely
a *known-alias* miss — same brewery under a different name/spelling, **not** a
token-prefix/tail-token variant — the fix is a one-line data edit:

1. Run the helper on the two raw labels → get the normalized pair.
2. Paste the pair into `src/domain/brewery-aliases.ts`.
3. Add a focused positive test in `matcher.test.ts`.
4. Open a PR. Mark the `enrich_failures` row `matcher_bug` as usual; it self-clears
   on the next successful enrich.

### 5. Runbook update — `docs/debug-orphan-matching.md`

- Split the single brewery-gate `matcher_bug` subclass into two:
  **tail-token** (#120, existing) vs **known-alias** (#202, new), with the
  distinguishing test: same brewery, different name/spelling, no shared leading
  token.
- Add a short "Як додати brewery-alias" section documenting the 4-step path above
  with the helper command (Ukrainian, to match the runbook).
- Update the Step-4 layer table so the brewery-gate row points at both
  `breweryAliasesMatch` (tail-token) and `brewery-aliases.ts` (curated).

## Testing

- `brewery-aliases.test.ts`: `aliasNeighbors` is symmetric for each pair and
  non-transitive (`van honsebrouck` does not neighbor `bacchus`); unknown form
  returns `[]`.
- `matcher.test.ts`: one positive `breweryAliasesMatch` (or end-to-end
  `matchBeer`) case per issue example asserting the gate now passes; plus guards
  that existing negatives still reject (`harp` ≠ `harpagan`, unrelated breweries
  stay unmatched).
- Existing matcher / untappd-lookup suites must stay green (regression guard).

## Spec & docs obligations (CLAUDE.md)

- Update `spec.md`: add the curated brewery-alias layer to the brewery-gate
  narrative under §4 (`POST /match`, the "Brewery-gate" paragraphs ~L665–680);
  touch §5.2 invariants only if the gate invariant wording needs it.
- No `extension/**` user-facing change → no `docs/extension-install-uk.md` update.
