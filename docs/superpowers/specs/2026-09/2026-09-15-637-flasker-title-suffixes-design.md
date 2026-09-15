# #637 — Flasker: Imperial Stout suffix and post-ABV identity text

**Date:** 2026-09-15
**Status:** approved for review
**Issue:** [#637](https://github.com/ysilvestrov/warsaw-beer-bot/issues/637)

## Problem and evidence

Flasker abbreviates *Imperial Stout* as a terminal `IS` in product titles. The
extension currently sends that suffix as part of `Card.name`. For example,
`VARVAR BLACK BEAN IS 11% 0.33л` becomes `VARVAR / BLACK BEAN IS`; the recorded
production replay shows that `/match` returns no result, while `VARVAR / BLACK
BEAN` returns the exact, already-drunk beer `Varvar Brew / Black Bean` (bid
2815).

The adapter also takes the brewery/name head only up to the earliest ABV or
volume marker. It therefore parses `The Lost Philosopher Xmas Eve 10% [2025]
0.75л` as `Xmas Eve`, losing the vintage that distinguishes the edition. A
live Flasker product page on 2026-09-15 publishes precisely that title and its
own Untappd URL contains `the-lost-philosopher-xmas-eve-2025` (bid 6546037),
which proves `[2025]` is identity text, not packaging.

The production catalogue has 19 terminal-`IS` rows. The sole name that exists
on Untappd with `IS` as part of its actual name is `Rebrew / LOVE IS` (bid
6686326). In particular, Flasker's `CherryEmber IS` is named `Cherry Ember` on
Untappd. A token-count guard is insufficient: it would keep other multi-word
false suffixes such as `Kaska Cherry IS` and `Vibrant Coffee IS`.

## Decision

### Preserve identity text between ABV and package volume

`parseTitle` keeps using the earliest ABV or volume marker as the point where
the leading brewery/name head ends, so brewery discovery continues to see only
the stable title head. When ABV comes before a later package-volume marker, it
retains a standalone four-digit vintage between them and appends it to the
parsed beer name. This preserves identity qualifiers such as `[2025]` while
excluding the ABV, package volume, and unproven packaging labels such as `can`.

The new tail is accepted only when it is non-empty. A title with volume before
ABV has no identity tail; a title with only ABV has none either. Packaging text
after the volume remains excluded. This change deliberately does not interpret
arbitrary description text after the package volume.

### Treat Flasker's terminal `IS` as a shop abbreviation

At the Flasker adapter boundary, remove a terminal, standalone `IS` from the
parsed beer name after the post-ABV text has been joined. Preserve exactly
`LOVE IS` (case-insensitively) as the documented genuine Untappd name. The
exception is an intentionally narrow compatibility record, not a general
normalization rule; it is kept alongside the adapter's other shop-specific
title rules and must be reconsidered only if measured catalogue/Untappd
evidence identifies another genuine terminal-`IS` name.

Neither rule changes `normalizeName`, the server matcher, cache keys, API
payload shape, database data, or any other shop adapter. Existing frozen
orphan rows are not rewritten; new Flasker cards will send the corrected
identity and avoid creating the bad rows.

## Behaviour table

| Flasker product title | Parsed name | Why |
|---|---|---|
| `VARVAR BLACK BEAN IS 11% 0.33л` | `BLACK BEAN` | `IS` is Flasker's Imperial Stout abbreviation |
| `CherryEmber IS 8% 330ml` | `CherryEmber` | published Untappd name omits `IS` |
| `REBREW LOVE IS 8% 330ml` | `LOVE IS` | only measured genuine terminal-`IS` name |
| `The Lost Philosopher Xmas Eve 10% [2025] 0.75л` | `Xmas Eve [2025]` | vintage is identity text between ABV and packaging |
| `LEFFE BLONDE 6.6% 0.33л` | `BLONDE` | no text exists between ABV and volume |

## Claims and evidence

| Recorded fact | Claim | Evidence |
|---|---|---|
| `Card.name` passed to `/match` | It represents the shop title's beer identity without Flasker's style shorthand or package text | adapter-level regression tests for each behaviour-table row |
| `LOVE IS` remains in `Card.name` | This is the actual beer name, not a style suffix | production catalogue bid 6686326 and direct Untappd-name verification recorded in #637 |
| `[2025]` remains in `Card.name` | The qualifier distinguishes the published Xmas Eve edition | live Flasker title and published Untappd URL containing `xmas-eve-2025` |

No database row, cache entry, cursor, or verdict is newly recorded by this
change.

## Failure and compatibility behaviour

- Missing ABV or volume retains the existing `parseTitle` behaviour.
- A malformed title cannot gain a brewery/name merely because tail cleanup ran.
- The exception matches the complete resulting name, never a substring, so a
  name such as `LOVE IS MORE` is not protected accidentally.
- Existing detail hydration, bid-first identity, non-beer classification and
  cache-key freezing retain their #615/#384 semantics.

## Tests and delivery

Add focused `parseTitle` tests before production changes and observe them fail
on the current parser. Cover the five behaviour-table rows, including both
positive and negative `IS` cases. Run the targeted Flasker tests, the extension
suite and extension typecheck, then both repository gates:

```text
npm test && npm run typecheck
npm --prefix extension test && npm --prefix extension run typecheck
```

Update `spec.md` §6 to replace the early-marker-only statement with the
post-ABV/preceding-volume rule and the Flasker-only `IS` exception. Add one
user-facing `[Unreleased]` changelog entry describing badges appearing for
Flasker Imperial Stouts and vintage editions. Update `docs/extension-install-uk.md`
because users will see corrected Flasker badge matching.

## Scope

- `extension/src/sites/flasker.ts`
- `extension/src/sites/flasker.test.ts`
- `spec.md`
- `extension/CHANGELOG.md`
- `docs/extension-install-uk.md`

No dependency, manifest, server, database, Chrome Web Store publishing, or
production-data mutation is in scope.
