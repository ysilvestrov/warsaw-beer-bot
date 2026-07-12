# Design: "probably drunk" (`❓`) badge for fuzzy matches

**Date:** 2026-06-17
**Status:** approved (brainstorm)
**Related:** #108 (exact-only drunk/personal claims + divergence guard), #167 (make all badges clickable), #169 (Flasker adapter brewery mis-split)

## Problem

The extension overlays a per-beer badge on craft-shop grids via `POST /match`. Today
(`extension/src/content/badge.ts`):

| Match | In user's drunk set? | Badge |
|---|---|---|
| exact | yes | `✅` (+ personal rating) |
| exact | no | `⭐ {global}` |
| **fuzzy** | **yes** | **`⭐ {global}`** — drunk status lost |
| fuzzy | no | `⭐ {global}` |
| matched, no Untappd id | — | `⚪` |
| no match | — | (no badge) |

`#108` deliberately gates `is_drunk`/`user_rating` to **exact** matches: in
`src/domain/match-list.ts`, `is_drunk = m.source === 'exact' && drunkSet.has(m.id)`.
The intent was to avoid falsely asserting "you drank this" on a low-confidence match.

The side effect (reported by user `esodin` for several Flasker beers): a beer the user
**has** drunk, matched **correctly** but via the **fuzzy** path, shows the plain `⭐`
"not drunk" badge instead of a drunk indicator. The Untappd link is correct (the fuzzy
match resolved to the right catalog beer), only the drunk status is hidden.

These beers reach the fuzzy path because the shop sends a wrong/absent brewery (see #169
for the adapter side). Some of those cases (brewery absent from the shop's DOM) cannot be
made exact by any adapter fix, so they will **always** be fuzzy — the matching layer alone
cannot restore their drunk status. This design adds an honest *uncertain* signal for them.

## Goal

Surface a distinct, honest "you've probably had this, but we're not 100% sure" badge for
beers that are in the user's drunk set but matched via the **fuzzy** path. The badge is
clickable so the user can verify (coexisting with #167).

## Non-goals

- Not changing the matcher or the Flasker adapter (that's #169).
- Not flagging *all* fuzzy matches as approximate (the "uncertain `⭐`" option was
  considered and explicitly dropped — scope is the drunk dimension only).
- Not surfacing the *personal* rating for uncertain matches (we show the global rating).

## Design

### Server — `src/domain/match-list.ts`

Add one boolean field to `MatchListResult`:

```ts
export interface MatchListResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;          // unchanged: exact match AND in drunk set
  drunk_uncertain: boolean;   // NEW: fuzzy match AND in drunk set
  user_rating: number | null; // unchanged: exact-only
}
```

In the matched branch:

```ts
is_drunk:        m.source === 'exact' && drunkSet.has(m.id),
drunk_uncertain: m.source === 'fuzzy' && drunkSet.has(m.id),
user_rating:     m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
```

The no-match branch sets `drunk_uncertain: false`.

`is_drunk` and `user_rating` semantics are **unchanged**. `is_drunk` and `drunk_uncertain`
are mutually exclusive (a match is exact xor fuzzy).

### Extension — `extension/src/api/types.ts`

Add `drunk_uncertain: boolean` to `MatchResult` (always present from the new server).

### Extension — `extension/src/content/badge.ts`

New `badgeFor` precedence:

1. `is_drunk` → `✅` (+ personal rating) — unchanged, **not** clickable (that's #167)
2. **`drunk_uncertain` → `❓ {global}`**, passing `matched_beer.untappd_id` so it is
   **clickable** to the Untappd beer page (when a bid exists) — NEW
3. matched + bid + global rating → `⭐ {global}` (clickable) — unchanged
4. matched orphan (no bid) → `⚪` — unchanged
5. no match → no badge

Rendering details:
- Glyph is `❓` alone (no `✅`), followed by the **global** rating
  (`m.rating_global.toFixed(1)`). If global rating is null, render bare `❓`.
- Standard dark badge background (`rgba(20,20,20,0.82)`) — same as all sibling badges;
  the glyph alone carries the meaning. No custom background colour.
- Clickability uses the existing `makeBadge(text, untappdId)` mechanism: pass
  `m.untappd_id`. When the bid is null (fuzzy+drunk *orphan*), the badge is non-clickable
  until #167 adds search-click — graceful, no breakage.

### Data flow

```
shop grid → adapter parseCards → POST /match
  → matchBeerList(catalog, drunkSet, ratings, items)
     → matchPrepared() returns { id, source: 'exact'|'fuzzy', ... } (already vetted by
       the nameTokensDiverge guard, so a returned fuzzy match is the same base beer)
     → per result: is_drunk / drunk_uncertain / user_rating
  → extension renderBadge → badgeFor → ✅ / ❓ / ⭐ / ⚪
```

### Backward compatibility

`is_drunk`/`user_rating` are untouched, and `drunk_uncertain` is purely additive. Older
installed extensions ignore the unknown field and keep rendering `⭐` for fuzzy+drunk
beers (today's behaviour) — no regression, no over-claim. New extensions render `❓`.

### Edge cases

- **Fuzzy+drunk orphan** (in drunk set, matched beer has no bid): renders bare `❓`,
  non-clickable until #167. The enrichment filter in `extension/src/content/index.ts`
  now excludes `drunk_uncertain` results (alongside `is_drunk`) so the `❓` badge is
  not clobbered in-session by the enrichment pipeline (⏳ → ⭐/⚪ via `setEnriched`/`setOrphan`).
- **Cached results** (`extension/src/cache/store.ts` `getCached`/`setCached`, returning
  `MatchResult | null`): a cached `MatchResult` written by a previous extension version may
  lack `drunk_uncertain`; reads must treat a missing field as `false` (e.g. type it
  `drunk_uncertain?: boolean` on read or coerce with `?? false`) so a stale cache degrades
  to today's `⭐`, not a crash.

## Testing

- `src/domain/match-list.test.ts`:
  - Update the existing "a fuzzy match never claims drunk or personal rating" test:
    `is_drunk` and `user_rating` stay as they are, but assert `drunk_uncertain === true`
    for a fuzzy match whose beer is in the drunk set.
  - Add: exact + drunk → `drunk_uncertain === false`; fuzzy + **not** in drunk set →
    `drunk_uncertain === false`; no match → `drunk_uncertain === false`.
- `extension/src/content/badge.test.ts`:
  - `drunk_uncertain: true` + bid + global rating → text `❓ 3.9`, clickable (opens the
    beer page).
  - `drunk_uncertain: true` + no global rating → bare `❓`.
  - `drunk_uncertain: true` + no bid → bare `❓`, non-clickable.
  - Precedence: `is_drunk: true` wins over `drunk_uncertain` (still `✅`).

## Docs / spec updates (mandatory per CLAUDE.md)

- `spec.md`: document the `❓`/`drunk_uncertain` badge state and revise the #108 wording
  ("fuzzy never asserts drunk") to "fuzzy asserts *uncertain* drunk (`❓`), never the
  personal rating."
- `docs/extension-install-uk.md`: add `❓` to the badge legend (user-facing change).

## Out of scope

- The Flasker adapter brewery mis-split (#169).
- The "uncertain `⭐`" treatment for all fuzzy matches (dropped during brainstorm).
- Making `✅`/`⚪` clickable (#167).
