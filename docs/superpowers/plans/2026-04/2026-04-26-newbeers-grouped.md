# Plan: /newbeers — group by beer + format

Closes ysilvestrov/warsaw-beer-bot#13 (duplicates) and #11 (formatting).

## Scope

Single PR `feat/newbeers-grouped` rewrites the response of the `/newbeers`
handler. No schema, storage, or domain changes.

## Decisions (confirmed by user)

- **Group key**: `match_links.untappd_beer_id` when available; otherwise
  fallback to `${normalizeBrewery(brewery_ref)}|${normalizeName(beer_ref)}`.
  This collapses the same physical beer pulled from different ontap
  pub-page strings, while still grouping unmatched ones sensibly.
- **Per-line format** (Telegram HTML parse mode):
  ```
  1. <b>{beer name}</b>  ⭐ {rating}
       · {pub1}, {pub2}, {pub3}
  ```
  Two lines per beer; `⭐ —` if rating is null.
- **Pub-list cap**: max 3 pubs shown; if more, append `+N інших`.

## Modules

- New: `src/bot/commands/newbeers-format.ts`
  - `interface CandidateTap { beer_id, beer_ref, brewery_norm, name_norm, rating, pub_name }`
  - `interface BeerGroup { display, rating, pubs: string[] }`
  - `groupTaps(taps: CandidateTap[]): BeerGroup[]`
    - Group key as above.
    - Per group: representative `display` = `beer_ref` of the highest-rated
      tap (ties → first seen). `rating` = max non-null rating (or null).
      `pubs` = unique pub names, alphabetically sorted (deterministic for tests).
  - `rankGroups(groups: BeerGroup[]): BeerGroup[]`
    - Sort: rating desc (nulls last), pub-count desc, display asc.
  - `formatGroupedBeers(groups, { topN=15, maxPubs=3 }): string`
    - HTML-escape `<>&` in every dynamic field.
    - Numbered list, format as above. Empty input → empty string (caller
      decides on the "Нічого цікавого" fallback).

- New: `src/bot/commands/newbeers-format.test.ts`
  - groupTaps: groups by matched id, dedups same id with different beer_ref;
    falls back to normalized tuple for null id; chooses highest-rated
    representative; ties broken stably.
  - rankGroups: rating-then-pub-count-then-name; nulls last.
  - formatGroupedBeers: pub cap with +N, HTML escaping, "—" for null rating,
    numbering, empty input → "".

- Modified: `src/bot/commands/newbeers.ts`
  - Build `CandidateTap[]` directly from `latestSnapshotsPerPub` →
    `tapsForSnapshot` → `filterInteresting`. Drop the per-pub top-3 cut
    (it pre-emptively hid grouping options); instead pass everything to
    `groupTaps` then trim with `topN` in formatter.
  - `await ctx.replyWithHTML(text || 'Нічого цікавого — спробуй /refresh.')`.

## Sequence (TDD)

1. Write `newbeers-format.test.ts` with failing tests for the three exports.
2. Implement `newbeers-format.ts` until green.
3. Rewire `newbeers.ts` (handler stays a thin wrapper).
4. `npm run typecheck && npm test && npm run build` → green.
5. Smoke composition root locally with dummy token.
6. Commit, PR `Closes #13, #11`.

## Risks / non-goals

- The previous per-pub top-3 cut is gone; if a single pub has 50 interesting
  unmatched taps, it could skew the global list. Acceptable for MVP — we can
  add a per-pub cap later if it bites.
- HTML escape only on user-visible strings; rating is numeric. Should be
  enough for Telegram parse mode without a full sanitizer.
