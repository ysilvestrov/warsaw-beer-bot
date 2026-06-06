# Brewery-gate token-prefix matching — design

**Date:** 2026-06-06
**Status:** Approved (brainstorming)

## Problem

The bot fails to match beers when ontap.pl labels a brewery with the bare
brand + a generic suffix while Untappd registers it under a longer official
name. Concrete report:

| id | brewery | name | abv | untappd_id |
|----|---------|------|-----|------------|
| 11824 | `Harpagan Brewery` | Buzdygan Rozkoszy | 8.5 | **NULL ⚪ (orphan)** |
| 2725 | `Harpagan Contracts` | Buzdygan Rozkoszy | 8.5 | 2388534 ✅ |

These are the same beer. The live Untappd search for `Harpagan Buzdygan
Rozkoszy` *does* return bid `2388534` (Buzdygan Rozkoszy, 8.5%, rating 4.075).

### Root cause

The brewery check is a **hard gate** that requires exact string equality of a
normalized brewery alias:

- ontap.pl `"Harpagan Brewery"` → `normalizeBrewery` → `"harpagan"`
  (`brewery` is a noise word, stripped)
- Untappd `"Harpagan Contracts"` → `"harpagan contracts"`
  (`contracts` is not noise)

`brewerySetsOverlap` uses `Set.has` (exact membership), so `"harpagan"` ≠
`"harpagan contracts"` → the gate rejects every candidate → orphan never
matches. The same gate breaks **both** paths: the local catalog matcher
(`matcher.ts`) and the online enrichment lookup (`untappd-lookup.ts`).

This is a recurring class of failure (any brewery where ontap drops the
official suffix Untappd uses), not a one-off.

## Decisions

1. **Token-boundary "starts-with" gate**, not subset and not raw-string prefix.
   - Subset rejected: order-independent, so `"Project"` would match
     `"Side Project"`. Prefix requires shared tokens to *lead*, which brands
     almost always do.
   - Raw-string prefix rejected: `"harpagan contracts".startsWith("harp")` is
     true, so a brewery named **"Harp"** would falsely match **"Harpagan"**.
     Comparing **token lists** avoids mid-token cuts.
   - The name-fuzzy ≥ 0.85 gate that follows the brewery gate remains the
     false-positive backstop.

2. **Add genuine noise words / strip legal forms** regardless of the gate
   change, because they carry no brand meaning:
   - Add `contracts` to `BREWERY_NOISE`.
   - Strip trailing legal-entity suffixes (`Sp. z o.o.` + dotted/spacing
     variants, `S.A.`) from the raw string *before* tokenizing, so we never
     have to denylist the single letters `z`/`o`.

3. **Backfill** stored `normalized_brewery` now (the normalize-rule change makes
   stored values stale; it is the upsert idempotency key).

4. **Let the existing orphan self-heal** via the backoff schedule rather than
   force-resetting it.

## Design

### 1. `src/domain/normalize.ts`

- Add `contracts` to `BREWERY_NOISE`.
- New `stripLegalForm(raw: string): string` — removes trailing legal-entity
  suffixes via a conservative, anchored regex over a finite set
  (`sp. z o.o.` variants, `s.a.`). Applied inside `normalizeBrewery` and
  `stripBreweryNoise` only — **not** name normalization.
- Results:
  - `normalizeBrewery("Harpagan Contracts") → "harpagan"`
  - `normalizeBrewery("Browar X Sp. z o.o.") → "x"` (`browar` is noise)

### 2. Shared token-prefix predicate (core)

- New exported helper in `matcher.ts`:
  `breweryAliasesMatch(aAliases: string[], bAliases: string[]): boolean` —
  true if any alias pair has one's **token list** as a leading prefix of the
  other's. Exact equality is the equal-length case, so all current matches
  still pass (backward compatible).
  - `[harpagan]` ⊑ `[harpagan, contracts]` → match
  - `[harpagan]` ⊑ `[harpagan, craft, beer]` → match (so `craft`/`beer` need
    not be denylisted)
  - `[harp]` vs `[harpagan]` → reject (token mismatch)
  - `[project]` vs `[side, project]` → reject (not leading)
- `matcher.ts`: replace both `brewerySetsOverlap(...)` call sites (exact-match
  filter, fuzzy pool filter) with the new predicate.
- `untappd-lookup.ts`: replace the Stage-1 `inputBreweryAliases.has(a)`
  membership check with the new predicate. Name-fuzzy ≥ 0.85 unchanged.
- `dedupe-brewery-aliases.ts`: **unchanged.** Its SQL pre-filter targets only
  slash/paren collab forms (the Harpagan case has neither), and the enrich
  path already self-heals duplicates (see §4). Adopting the predicate there is
  out of scope.

### 3. Migration — backfill `normalized_brewery`

- A one-time, idempotent backfill that recomputes `normalized_brewery` for all
  `beers` rows, run at startup alongside the existing `migrate(db)` /
  `dedupeBreweryAliases(db, log)` calls in `index.ts`.
- Rationale: `(normalized_brewery, normalized_name)` is the upsert idempotency
  key. Without backfill, old rows keep `"harpagan contracts"` while new writes
  use `"harpagan"`, risking duplicate catalog rows on re-import.
- Runtime matching (`matchBeer`) recomputes `normalizeBrewery` live, so it is
  unaffected by stale stored values — the backfill is purely for the stored
  idempotency key / index consistency.

### 4. Existing orphan self-heal (no code)

Orphan 11824 is at `lookup_count = 2`, last tried `2026-06-04T12:30`. The 72h
backoff (`BACKOFF_HOURS[2]`) makes it eligible `2026-06-07T12:30`. The next
`enrich-orphans` run after that finds bid 2388534, hits the UNIQUE constraint
(2725 owns it), and `mergeIntoCanonical(11824 → 2725)`. No code change; just
not instant (~1 day after deploy).

## Testing

- **`normalize.test.ts`**: `normalizeBrewery("Harpagan Contracts") === "harpagan"`;
  legal-form strip (`Sp. z o.o.`, `S.A.`, dotted/spacing variants); confirm
  standalone `z`/`o` tokens are not globally clobbered.
- **`matcher.test.ts`**: `[harpagan]` ⊑ `[harpagan, contracts]` passes;
  `[harp]` vs `[harpagan]` rejected; `[project]` vs `[side, project]` rejected;
  exact-equality still passes.
- **`untappd-lookup.test.ts`**: Harpagan scenario with mocked search HTML →
  resolves to bid 2388534.
- **Backfill test**: stale `normalized_brewery` rows are recomputed; re-upsert
  produces no duplicate.

## Spec update

`spec.md` §5 brewery-aliases note (~lines 577–584): document the token-prefix
gate and the `contracts` / legal-form stripping. Per CLAUDE.md, spec.md is the
single source of truth and is updated in the same PR.

## Out of scope

- Changing `dedupe-brewery-aliases.ts` matching semantics.
- Confidence scoring / softening the name-fuzzy ≥ 0.85 gate.
- Force-resetting orphan backoff.
