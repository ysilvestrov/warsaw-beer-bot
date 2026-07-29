# Ontap identity normalization v2 (#306)

**Date:** 2026-07-29
**Issue:** [#306](https://github.com/ysilvestrov/warsaw-beer-bot/issues/306)
**Related:** #235/#238 (the fix this supersedes), #321 (Czech grade), #343 + #361 (curated pins),
#286 (fossil retirement), #326/#295/#350 (query-side noise stripping)

## Problem

`#238` moved ontap tap-identity handling from "let garbage through" to "drop suspicious rows". A
replay of every distinct tap identity from three days of production (1100 `(brewery_ref, beer_ref)`
pairs / 13030 tap rows, 2026-07-26..29) through the current
`extractBeerName` → `isOntapNonBeerTap` → `normalizeOntapTapIdentity` chain shows three live
defects.

### 1. Real taps are dropped, invisibly (14 identities / 148 tap rows per 3 days)

`normalizeOntapTapIdentity` returns `null` and `refresh-ontap.ts:108` does `continue`. The raw tap is
still snapshotted, but there is no catalog row, no match attempt, no match link and no
`enrich_failures` row — so the beer never gets a rating or check-in state, **and produces no orphan**.
The defect is unobservable by construction, which is why it survived three weeks.

Two guards over-fire:

- `name == breweryCore` (`pub.ts:99-100`) — for single-brand breweries the beer name legitimately
  equals the brand: `Guinness/Guinness`, `Pilsner Urquell/Pilsner Urquell`, `Holba`, `Litovel`,
  `Herrnbrau`, `Blanche de Namur`, `Umorušany Janíček`, `Cydr Dzik`, `Cydr Dobroński`.
- `POLLUTED_BREWERIES` (`pub.ts:81-97`) — a bad **brewery** value discards a good beer name:
  `W Brzesku Brewery / Žatecký Nealko`, `… / Žatecký Světlý Ležák`.

### 2. Trailing spec residue survives into the stored name (19 live identities)

`extractBeerName` (`pub.ts:63-66`) strips one canonical `N°·M%` shape and misses every real
variation: doubled `%%`/`°°`, `<`/`>` bounds, `N/D°`, `;` decimals, `%°`, truncated tails.

This is a **catalog/display-quality** defect, not a matching defect: `stripSearchNoise` +
`stripQueryTokenNoise` (#326/#295/#350) already neutralise these forms on the query side. Do not
expect it to rescue orphans on its own.

### 3. The trailing °Plato grade is destroyed, which manufactures defect 1

`pub.ts:65` strips a trailing `N°` as strength. In CZ/PL listings it is the °Plato grade and part of
the identity, so `Konrad 12°` collapses to `Konrad`, which then equals the brewery core and is
dropped.

## Decisions

**D1 — the parser may not decide "this is not a beer" from string shape.**
It cannot distinguish `Guinness/Guinness` from `Frankies/Frankies`. A dropped tap is unrecoverable
and unobservable; an orphan is visible, triaged daily, and pinnable. Everything passes through unless
there is a positive non-beer/placeholder signal or the name is empty.

**D2 — a polluted brewery clears the brewery field; it never discards the beer.**
The matcher explicitly supports an empty input brewery (`untappd-lookup.ts:206`, #149 empty-input
bypass): all candidates land in the relaxed pool, which accepts **exact name equality only** — never
approximate fuzzy. `Žatecký Nealko` with no brewery is therefore searched safely.

**D3 — preserve a trailing °Plato grade; let the search try it both ways.**
We cannot tell from the string whether the grade belongs to the Untappd name (`Konrad 12°`) or was
appended by the shop (`Pszeniczne 12°°·5%`), so the parser must not guess. Verified that the matching
layer already searches both ways — no new matcher work is implied:

| stage | `Konrad 12°` | `Pszeniczne 12°°·5%` |
|---|---|---|
| `cleanSearchQuery` | `Konrad` | `Czarna Owca Pszeniczne` |
| `normalizeName` | `konrad` | `pszeniczne` |
| `extractGrade` (raw name, stage 3 #321) | `12` | `12` |

**D4 — a bare brand name may match exactly, never fuzzily.**
Un-dropping alone would create false positives. Measured against the production catalog:
`Holba/Holba` → `Holba Šerák` (untappd 99098) and `Litovel/Litovel` → `Litovel Dark` (717906), both
via the **fuzzy** stage. A wrong match is worse than an orphan — it shows a stranger's rating and
marks the beer drunk. The same inputs reach `/match` from the browser extension, so the guard belongs
in `matchPrepared`, not in the ontap layer.

Consequence, accepted deliberately: `Guinness / Guinness` will not auto-match
`Guinness — Guinness Draught` (bid 4473). It becomes a live orphan and a **curated-pin candidate**;
the pin workflow is tracked separately in #361.

## Architecture

Two boundaries, matching where the pipeline already makes each kind of decision.

**Exclusion stays in `non-beer.ts`**, which runs *before* the snapshot is written
(`refresh-ontap.ts:76`) — a placeholder is not a tap and should not be snapshotted, exactly like the
existing `kran w serwisie` sentinel. The module gains a reason-returning entry point so the caller can
count causes:

```ts
export type TapExclusion = 'non-beer' | 'placeholder';
export function ontapTapExclusion(tap: OntapNonBeerInput): TapExclusion | null;
```

`placeholder` covers curated normalized phrases, substring-matched on **both** fields:
`chwilowy brak`, `wypite`, `kran w serwisie`, `czeka na lepsze czasy`. Substring is correct here:
`Guinness Chwilowy brak:(` means "the Guinness ran out", not a beer named that. A punctuation-only
brewery (`-`) is itself a placeholder marker. No regex heuristics: this is a finite set of shop-UI
strings, and a false drop costs more than a missed placeholder (which stays visible as an orphan).

**Cleanup moves to a new module `src/sources/ontap/identity.ts`** — pure, no DOM, no DB:

```ts
export type TapIdentity =
  | { kind: 'keep'; brewery: string; name: string }
  | { kind: 'drop'; reason: 'empty-name' };

export function resolveTapIdentity(breweryRef: string | null, beerRef: string): TapIdentity;
```

Internally a pipeline of individually testable rules:

1. `sanitizeBrewery` — sentinel/pollution values (`w brzesku`, `vaisiu sultys`, punctuation-only)
   clear the brewery to `''`. The curated cider mappings (`Cydr Dzik → Cydrownia`,
   `Cydr Flirt → Kauno Alus`) are kept unchanged.
2. `stripTrailingSpec` — one grammar replacing two regexes. A spec atom is
   `[<>]? (number | N/D) [°%]{1,2}`; atoms join with `·`/`•`/`∙`/space; the match is anchored to the
   **end** of the string. Two safeguards: (a) if stripping would empty the name, strip nothing;
   (b) if the first atom is a clean grade (digits + `°`, no `<`/`>`), it stays in the name and only
   the ABV tail is removed.
3. `dedupeBreweryPrefix` — strips a leading brewery prefix in both its full and core form
   (`PINTA Brewery `, `PINTA `), but **never empties the name**: `Guinness Brewery / Guinness` keeps
   `Guinness`. A duplicated adjacent name token (`Hoppik Hoppik`) is out of scope — no live sample.

`pub.ts` keeps DOM parsing only (`extractBeerName` moves into `identity.ts`; `cleanup-polluted-ontap.ts`
follows it there). `refresh-ontap.ts` counts every discarded tap by cause and logs the totals per pub
(`ontap taps discarded {non-beer: n, placeholder: n, empty-name: n}`) — the observability whose absence
let #238's regression hide for three weeks.

### `stripTrailingSpec` truth table (all rows are live production data)

| input | output | rule |
|---|---|---|
| `Konrad 12° · 5,2%` | `Konrad 12°` | grade preserved (D3) |
| `Bajlando za mango 16°·5,8%%` | `Bajlando za mango 16°` | doubled `%%` |
| `Fizzy 7,7°·2,8%%` | `Fizzy 7,7°` | doubled `%%` |
| `Pszeniczne 12°°·5%` | `Pszeniczne 12°` | doubled `°°` |
| `CIESZYN PILSNER 11,8%°·4,8%%` | `CIESZYN PILSNER 11,8°` | mangled `%°` |
| `Cookie Monster Ice Destilated N/D°·13%` | `Cookie Monster Ice Destilated` | `N/D°` is not a grade |
| `Free <0.5°·<0,5%` | `Free` | `<` ⇒ not a grade |
| `Green IQ <0,5%` | `Green IQ` | ABV without a grade |
| `Pilsiwko 0%` | `Pilsiwko` | ABV without a grade |
| `Plum Plum Plum 12,5°·4` | `Plum Plum Plum 12,5°` | truncated tail |
| `This ls light 8°·3;5%` | `This ls light 8°` | `;` decimal typo |
| `La 150° Bionda 8,5%` | `La 150° Bionda` | interior degree untouched |
| `Litovel Pomelo 0% 12°·<0,5%` | `Litovel Pomelo 0% 12°` | interior `0%` untouched |
| `300% Normy` | `300% Normy` | spec is not at the end |
| `11%` (Primator) | `11%` | non-empty safeguard |
| `12 12°·4` (Rampušák) | `12 12°` | non-empty safeguard + grade |

### Matcher guard (D4)

In `matchPrepared`, before the fuzzy fallback: if `normalizeName(input.name)` equals the normalized
brewery brand, the fuzzy stage is skipped and the input can only match exactly. The exact stages run
first and are unaffected, so `Blanche de Namur`, `Umorušany Janíček`, `Cydr Dobroński` and
`Konrad 12°` keep matching; `Holba` and `Litovel` become orphans instead of wrong products.

## Testing

- `identity.test.ts` — table-driven from the production replay: all 17 spec rows, the 14 currently
  dropped identities, the placeholder rows. Each rule tested in isolation plus end-to-end cases.
- Regression coverage for #235/#238's genuine wins: `vaisiu sultys` no longer drops the tap but does
  not resurrect as a brewery either; `W Brzesku` never returns as a brewery value;
  `Cydr Dzik → Cydrownia`; `La 150° Bionda` intact.
- `pub.test.ts` reduced to DOM parsing; `non-beer.test.ts` extended with the new placeholder
  sentinels.
- `matcher.test.ts` — the bare-brand guard: `Holba/Holba` and `Litovel/Litovel` must not match;
  `Blanche de Namur`, `Umorušany Janíček`, `Konrad 12°` must still match exactly.
- `refresh-ontap.test.ts` — drop counters by reason.

## Rollout

1. **Before deploying**, dry-run `cleanupPollutedOntap` against a copy of the production DB. It runs
   at process start (`index.ts:66`) and calls `extractBeerName`, so it will rewrite/merge the 26
   spec-polluted catalog names as soon as we deploy — its plan must be reviewed by eye first
   (it merges at confidence ≥ 0.9).
2. Deploy; the next ontap cron re-ingests, and the drop counters appear in the logs.
3. Re-run the same 3-day replay: the `drop` bucket must contain only `non-beer` and `placeholder`.
4. Re-arm affected orphans (`rearm-matcher-bug-orphans`, or `--ids` for targeted rows) — without a
   count reset, backed-off rows are never re-queried.
5. Retire fossils that do not resurrect (e.g. `12289`) via #286 once re-ingestion produces clean rows.
6. Measure: new catalog entries created, how many matched immediately, how many became orphans, and
   whether the daily triage volume stays in single digits.

## Out of scope

- Head-token truncation (`PINTA / of the month lager`), duplicated adjacent name tokens
  (`Hoppik Hoppik`), and a brewery field carrying the full name+degree (`30913`) — not reproducible
  with the current parser; issue #306 §5 keeps them as fossils pending a live sample.
- Brewery alias gaps exposed once these rows flow again (`Konrad` ↔ `Pivovar Vratislavice nad
  Nisou`) — #254/#347.
- The curated-pin workflow — #361.
