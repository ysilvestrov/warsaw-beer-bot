# Split-invariant exact match (catalog-anchored second try)

**Issue:** #169 — two-word breweries in a Flasker title are split wrong, so a beer
that should exact-match (e.g. `Pastry Mastery — SCHWARZBROT PORTER`) only matches
fuzzy, which hides the personal drunk status (shows ⭐ instead of ✅).

**Decision:** Fix the matcher, not the adapter. The brewery/name boundary an adapter
chooses is unreliable — different shops cut it in different places, some omit the
brewery entirely. When the brewery tokens *are* present in the title, the matcher
should reach the same exact hit regardless of where the cut fell.

## Problem

`matchPrepared` (`src/domain/matcher.ts`) trusts the input `(brewery, name)`
boundary. Every exact-match test is therefore boundary-sensitive. For
`Pastry Mastery — SCHWARZBROT` the same beer fails three different ways:

| input split | why exact fails today |
|---|---|
| `("Pastry Mastery", "SCHWARZBROT")` | brewery gate passes, but catalog name `schwarzbrot` is a single token → its `nameKeys` is empty (the `<2`-token rule), and no `nameNorm` equality either → fuzzy |
| `("Pastry", "Mastery SCHWARZBROT")` | gate passes (prefix), but `mastery` leaked into the name → input keys `{mastery schwarzbrot}` ≠ catalog → fuzzy |
| `("", "Pastry Mastery SCHWARZBROT")` | no brewery alias → can't even seed the gate |

All the tokens are present in each case — only the partition differs. The only case
this issue does **not** cover: titles where the brewery tokens are genuinely absent
(bare-name shops like `Blazing Gold 7.3% 330ml`), which stay fuzzy regardless and
are a separate concern (relaxed `is_drunk` gate, #108).

## Approach

Add a **catalog-anchored, split-invariant exact check** that runs as a **second try,
only when the existing exact path found nothing**. Considered and rejected:

- **Combined token-bag equality** — compare sorted multiset of `brewery+name` on both
  sides. Fully split-invariant but loses the brewery/name distinction, so it can't
  require "brewery actually present" and is more FP-prone. Rejected.
- **Input re-split candidates** — try every leading-token cut of the input and re-run
  the existing matcher. Still hits the single-token `nameKeys`-empty wall, so it
  doesn't fix the core case. Rejected.

## Design

### 1. Placement in `matchPrepared`

```
exacts = <existing logic>            // UNCHANGED
if (exacts.length === 0)
    exacts = anchoredExacts(...)     // NEW second try
if (exacts.length) { <existing ABV/year disambiguation; return source:'exact'> }
<existing fuzzy fallback>            // UNCHANGED
```

The second try is gated on `exacts.length === 0`. Consequence: any input that already
exact-matches today (including adapters that supply a correct separate brewery field)
produces a non-empty `exacts`, the anchored path **never executes**, and behavior is
byte-identical. The anchored try can only *upgrade* a current miss to an exact hit; it
can never perturb an existing hit or change which row wins disambiguation.

Anchored hits are fed into the **same** ABV/year/vintage disambiguation block and
return `source: 'exact'` — so vintage and ABV handling come for free and the badge
becomes ✅.

### 2. Candidate enumeration

Build `combinedNameNorm = normalizeName(\`${input.brewery} ${input.name}\`)`.
Enumerate candidates by its **leading token** via the existing first-token index,
exposed through a new accessor:

```ts
interface PreparedCatalog {
  // ...existing...
  candidatesByFirstToken(token: string): PreparedBeer[];
}
```

(returns the raw `byFirstToken` bucket; `breweryCandidates` already consumes the same
map internally.)

In these shop titles the brewery always leads, so the title's first token equals the
brewery's first token — including the empty-brewery case where the whole brewery sits
in the `name` field. This is what lets `("", "Pastry Mastery SCHWARZBROT")` find the
`Pastry Mastery` rows even though there is no input brewery alias.

### 3. Anchored predicate

A candidate `c` is accepted as an exact hit when **both** hold for some alias
`a ∈ c.aliases` (iterating aliases so collab/bilingual breweries work):

1. **Leading run (the FP gate):** `a` is a token-boundary *leading prefix* of
   `combinedNameNorm` — the candidate's *whole* brewery must be present at the front.
   This is why a bare `Schwarzbrot` from no brewery can never anchor onto
   `Pastry Mastery`.
2. **Name equality:** `stripBreweryFromName(combinedNameNorm, a)`, tokens sorted,
   equals `c`'s canonical name `stripBreweryFromName(c.nameNorm, c.breweryNorm)`,
   tokens sorted, and is non-empty.

Single-token names like `schwarzbrot` are allowed here — the brewery-presence gate (1)
supplies the evidence that the `<2`-token guard in `nameKeys` was compensating for, so
that guard is not needed on this path.

All candidates that pass are collected (several vintages → several rows), sorted
id-desc, and handed to the existing disambiguation as the new `exacts`.

A new exported helper (e.g. `leadingRun(haystackNorm, aliasNorm): boolean`) implements
(1) at token boundaries; (2) reuses the existing `stripBreweryFromName`.

### 4. FP safety

The anchored predicate is **strictly stronger** than today's gate (full brewery present
as a leading run **and** remainder equals the catalog name), and it only runs when the
current path found zero exacts. Therefore:

- **working cases** (correct brewery, exact name) — second try skipped → unchanged;
- **mis-split fuzzy cases** — upgraded to exact;
- **genuinely different beers** (brewery present, remainder ≠ name) — no anchored hit →
  fall through to fuzzy / none exactly as today.

## Tests (`src/domain/matcher.test.ts`)

- All three splits of `Pastry Mastery SCHWARZBROT` → exact, **same** catalog id.
- A second two-word-brewery case (e.g. `Mad Brew …`, `Mad Girl …`).
- Negative: bare `Schwarzbrot` with no brewery present → does **not** anchor onto
  `Pastry Mastery` (stays fuzzy/none).
- Negative: same brewery, different name remainder → no false exact.
- Regression: an already-exact `(brewery, name)` returns the same id (proves the second
  try didn't fire and didn't change the result).
- Vintage/ABV: an anchored hit still respects year and ABV disambiguation.

## Spec / docs

- **`spec.md`** — update the matching section to describe the split-invariant
  second try (required by CLAUDE.md).
- **`docs/extension-install-uk.md`** — **not** required. This change lives in
  `src/domain/**` (server matcher), not `extension/**`, and adds no new badge, option,
  shop, or popup behavior. The user-visible effect (more beers showing ✅) is a
  consequence of server matching, not an extension UI change.

## Out of scope

- Adapter changes (`splitBreweryName`, `TWO_WORD_BREWERIES`) — left as-is; the
  matcher no longer depends on the split being correct.
- Bare-name titles with the brewery genuinely absent (#108 relaxed `is_drunk` gate).
