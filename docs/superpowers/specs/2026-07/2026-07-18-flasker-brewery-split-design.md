# Extension/Flasker: generalize brewery/name split via a generated brewery registry (#304)

- **Date**: 2026-07-18
- **Issues**: #304 (generalize Flasker brewery/name split; supersedes the narrow #169). Sibling: #307 (imported beers — out of scope here). Parent triage: #255.
- **Files**: `extension/src/sites/flasker.ts`, `extension/src/sites/flasker-breweries.generated.ts` (new), `extension/scripts/gen-flasker-breweries.ts` (new), `extension/src/sites/flasker.test.ts`, `docs/extension-install-uk.md` (only if user-facing behaviour changes — likely not).

## Problem

`splitBreweryName` in `extension/src/sites/flasker.ts` takes **only the first token** of the
title head as the brewery, except for a hardcoded allow-list `TWO_WORD_BREWERIES` (currently just
`'vibrant pour'`). Any brewery that is not one word gets cut in half and the leftover token leaks
into the beer name, so the beer drops out of its brewery's exact-match pool and matches only
fuzzy — or becomes a permanent orphan. Flasker is the **largest** orphan cluster (≈46
`enrich_failures.review_class='parser_bug'` rows, source `flasker.com.ua`).

The reliable path (`resolveBreweryRule`) already exists but recognises only **5** breweries via a
curated `BREWERY_RULES` list keyed on product tags/slug. Everything else falls through to the
naive split. #169 "fixed" one case by adding a single allow-list entry — which is exactly why it
did not scale.

### Root cause: a discarded signal

Flasker publishes every house/guest brewery **twice** in the DOM:

1. **Brand strip** — `mb-brand-tile` elements with `data-mb-brand-id` and `<img alt="Brewery">`
   (56 tiles observed: `Copper Head`, `Хмільний кіт`, `First Actors Brewery`, `KLB`, …).
2. **Product tag** — the brewery appears among the product's tags (`.mb-thumb-tag` /
   `data-product_tag`), mixed indistinguishably with style/ingredient/country/volume tags.

The current code throws both away for any brewery outside the 5-entry list. The generalising
insight: **the brewery is the tag that also appears as the leading prefix of the title**, and the
brand strip gives us the authoritative set of brewery names on the site.

## Design

### Resolution order (replaces the first-token guess)

For each product card, resolve the brewery in this order (first hit wins):

1. **Tag ∩ registry** — a product tag that is a known brewery (registry membership) → use it.
   Handles cards where the brewery is tagged but not at the title head
   (e.g. `HOME REBREWING …` tagged `rebrew`). Generalises today's `resolveBreweryRule` from 5 to 54.
2. **Registry ∩ title-head** — the title starts with a known brewery display form
   (case-insensitive, **longest match wins**) → split there. Covers the no-tag **block view** and
   closes the two-word-brewery bug (`Copper Head`, `Хмільний кіт`).
3. **First-word split** — the existing `splitBreweryName` heuristic, unchanged, as last resort.
   No regression for single-word breweries and untagged/unknown cards.

Whichever step resolves the brewery, the beer **name** is the title head with the matched brewery
form stripped from its front (reusing the existing `stripTitleAlias` mechanics), then run through
`stripMerchandisingPrefix`.

### The brewery registry

New generated module `extension/src/sites/flasker-breweries.generated.ts`, exporting an array of:

```ts
interface FlaskerBrewery {
  match: string[];      // Flasker display forms to match in titles/tags, e.g. ["KLB"]
  canonical: string;    // brewery emitted to the matcher,   e.g. "Kyiv Local Brewery"
}
```

- `match` powers steps 1 and 2 (membership + title-head prefix). Case-insensitive; may hold
  spacing variants (`Gold Fish` / `GoldFish`).
- `canonical` is what the adapter emits, so the matcher receives a form it already knows.

**54 breweries** kept after reconciliation against the live Untappd catalog via `normalizeBrewery`
(2 site-section pseudo-brands dropped: `Імпортне пиво`, `НАБОРИ І КОЛАБИ`). Reconciliation buckets
from the review pass:

- **Exact / prefix catalog match (45)** → `canonical` = catalog form
  (`Copper Head`→`Copper Head. Beer Workshop`, `Гонір`→`Гонір - Honir Brewery`, …).
- **Variant match (5)** → `Vibrant Pour`→`VibrantPour`, `Правда`→`Pravda`, `Оболонь`→`Obolon`,
  `Kumpel`→`Кумпель / Kumpel`, `Gold Fish`→`GoldFish`.
- **Not in catalog but confirmed real (4)** — user-verified Untappd profiles:
  `Звір Beer`, `IIIO`, `KLB`→`Kyiv Local Brewery`, `Holy Brewery`. `canonical` = best-known name.

### Generation script

New committed script `extension/scripts/gen-flasker-breweries.ts`:

1. Fetch Flasker's live brand strip; extract `{ id, displayName }` from each `mb-brand-tile`
   (HTML-entity decode: `П&#039;Ю` → `П'Ю`).
2. Drop the non-brewery site sections (deny-list: `Імпортне пиво`, `НАБОРИ І КОЛАБИ`).
3. Reconcile each name against the catalog's `normalized_brewery` (exact, then leading-token
   prefix) to fill `canonical`; leave a small curated override map for the not-in-catalog set and
   any known variant/canonical differences.
4. Write `flasker-breweries.generated.ts` (sorted, stable) — reviewable in the diff, regenerated
   on demand (not on every build).

### Curated supplement (kept, small)

Relationships not derivable from the brand strip stay as explicit code in `flasker.ts`:

- Mad Brew's `familySlugPrefixes` (`lost-philosopher-`, `de-zwarte-regel-`, … → `Mad Brew`).
- Merch-prefix stripping (`ПРЕДРЕЛІЗ` / `ПРОБНИК:`) via `stripMerchandisingPrefix`.

These run **before/around** the registry lookup exactly as today; the registry replaces only the
brewery *identification*, not these curated cleanups.

## Out of scope

- **Imported/foreign beers** (`Duchesse de Bourgogne`, `De Cam …`): Flasker never names the
  foreign brewery (bucketed under the generic `Імпортне пиво` section, no brand tile, no brewery
  tag), so the registry cannot cover them. This is a matcher/alias problem tracked in **#307**.
- Live/hybrid registry extraction from the page DOM: considered and deferred; the static generated
  list is deterministic and testable. Revisit only if staleness becomes a real problem.

## Testing

Extend `extension/src/sites/flasker.test.ts` (Vitest):

- **Step 1 (tag→registry)**: a title whose head omits the brewery but whose tags include a known
  registry brewery resolves to the canonical form.
- **Step 2 (registry→title-head)**: two-word brewery at the head splits correctly
  (`Copper Head Royal Cookie …` → `{Copper Head. Beer Workshop, Royal Cookie}`); longest-match
  (`Хмільний кіт` beats a bare `Хмільний`); block-view card (no tags) resolves via registry.
- **Canonicalisation**: `KLB …` → `Kyiv Local Brewery`; `Правда …` → `Pravda`.
- **Step 3 (fallback)**: unknown single-word brewery still splits as today (no regression);
  unknown multi-word head falls back without throwing.
- **Registry matcher unit**: membership + longest-prefix helper against the 54-entry fixture.
- **Curated supplement intact**: Mad Brew family-slug and merch-prefix cases still pass.

Existing fixtures (`extension/tests/fixtures/flasker*.html`) suffice; no new fixture needed.

## Success criteria

- The ≈46 in-scope Flasker `parser_bug` orphans (excluding #307 imports) parse to the correct
  `{ brewery: canonical, name }`.
- No regression in existing `flasker.test.ts` cases.
- `BREWERY_RULES` collapses into generated data + the small curated supplement; no per-brewery
  hardcoding remains for the 54 registry breweries.
- Stale orphan rows are retired via the #286 reconciliation path after deploy (not part of this PR).
