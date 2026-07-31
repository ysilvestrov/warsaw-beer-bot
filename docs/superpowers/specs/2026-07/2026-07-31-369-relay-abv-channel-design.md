# #369 — ABV on the extension relay path

**Date:** 2026-07-31
**Issue:** [#369](https://github.com/ysilvestrov/warsaw-beer-bot/issues/369) (`bug`, `priority/tier-1`)
**Status:** design approved, ready for planning

## Problem

ABV never reaches `lookupBeer` for any beer that enters through the browser
extension relay. The ABV gate and every ABV corroborator are inert for that
whole path, which is the path that produces most of our orphans.

Live measurement on prod (`enrich_failures` joined to `beers`, 2026-07-31):

| source | rows | carry ABV |
| --- | --- | --- |
| cron | 413 | 369 (89%) |
| relay | 237 | **1 (0.4%)** |

## What the replay corrected

Per project policy the issue's claims were replayed against the code, the
`onemorebeer` fixture and the prod DB before any design work. Three premises
changed.

### The protocol gap dominates; the adapter gap does not

Relay failures by shop:

| adapter parses ABV? | shops | failures |
| --- | --- | --- |
| **yes** | flasker 108, beerfreak 32, funkyshop 16 | **156 (66%)** |
| no | onemorebeer 30, winetime 26, beerrepublic 21, piwnemosty 2, bierloods22 2 | 81 (34%) |

Two thirds of the loss is pure protocol: flasker already parses ABV off the
title and `content/index.ts` throws it away. The issue led with the
`onemorebeer` adapter, which is worth ~13%.

### "Audit the other four adapters" is nearly a no-op

`beerrepublic`'s 60 `ABV` occurrences are all in the filter sidebar, not in
product cards. `winetime`, `bierloods22` and `piwnemosty` publish no ABV on the
listing page at all. Only a per-product detail fetch would reach it there —
separate, more expensive work, deliberately out of scope (see Non-goals).

### onemorebeer's ABV is not inside the tile

`Dane techniczne` is a collapsed accordion **button** inside the tile
(`aria-expanded="false"`, `aria-controls="collapse<uuid>"`). The panel itself is
a **hidden sibling** (`display: none`) under the shared `.one-product-list-view`
wrapper, already present in the DOM. No fetch and no synthetic click are needed.

Validated against `extension/tests/fixtures/onemorebeer.html`:
`el.closest('.one-product-list-view')` → `.one-product-technical-data` resolves
for **7/7** tiles. 3 carry `Moc (%)` (4.5%, 5.5%, 5.5%), 7 carry `Styl`. The four
PINTA products publish Plato (`15,0°`, `30,0°`) in the title and have no `Moc`
row — **onemorebeer coverage is partial by construction, not by bug**.

## Scope

1. Add an ABV + style channel to `/enrich/candidates` and `/enrich/result`, and
   persist both through `ensureBeerRow`.
2. Parse `Moc (%)` and `Styl` per product in the `onemorebeer` adapter.
3. Cut extension 0.13.0 so the client half actually reaches users.

### Non-goals

- Detail-page ABV fetches for `beerrepublic` / `winetime` / `bierloods22` /
  `piwnemosty`. Their listing pages carry no ABV; adding bounded per-product
  fetches on three more shops changes per-page network behaviour and deserves
  its own risk conversation. File separately.
- Wiring `style` into the matcher. That is #349's design work and needs its own
  live replay first. Here `style` is persisted only.
- Any blind mass re-arm of the 797 ABV-less orphans (see Re-arm).
- `docs/extension-install-uk.md`. No new shop, option, popup button or badge
  behaviour; the only user-visible effect is more ⚪ becoming ⭐ over time. The
  CHANGELOG entry covers it. (Decision recorded per CLAUDE.md's extension-docs
  rule, which requires the check, not necessarily an edit.)

## Architecture

Three independently testable seams.

### 1. Extension — parse

`Card` gains `style?: string`; it already has `abv?: number`. A helper in
`extension/src/sites/onemorebeer.ts` resolves tile → wrapper → technical panel
and reads the `Moc (%)` and `Styl` rows into `card.abv` / `card.style`.

Panel resolution is **structural**: `el.closest('.one-product-list-view')` then
`.one-product-technical-data` within it. (The `aria-controls` → `getElementById`
route was the considered alternative; the structural one was chosen as less
dependent on the accordion library's attributes.) There is deliberately **no
fallback chain** — a silent fallback would mask the adapter breaking, whereas
the conformance tests fail loudly.

The Plato token in titles stays excluded, as documented at
`onemorebeer.ts:22`. Plato is not ABV and must never be sent as one.

### 2. Extension — transport

`content/index.ts:73` currently builds `{key, el, brewery, name}` and drops
everything else. It gains `abv` and `style`, **omitted when absent** rather than
sent as null. `OrphanBeer` and `EnrichDeps.getCandidates` / `submitResult` widen
to match.

`abv` continues to flow to `/match` exactly as today — onemorebeer parsing it is
a free improvement to local catalog matching with no change needed there.
`style` does **not** go to `/match`: nothing reads it.

### 3. Server

`CandidatesBody` items and `ResultBody` gain optional `abv: z.number()` and
`style: z.string().max(BEER_TEXT_LIMIT_CHARS)`. `/enrich/result` keeps calling
`lookupBeer({..., abv: row.abv})` unchanged — by then the row is populated.

### Data flow

```
onemorebeer DOM (hidden technical panel)
  → Card{abv, style}
  → POST /match                 (abv only, as today)
  → OrphanBeer{abv, style}
  → POST /enrich/candidates     → ensureBeerRow fills beers.abv / beers.style
  → POST /enrich/result         → ensureBeerRow (no-op or fill)
  → lookupBeer({abv: row.abv})  → pickByAbv / ABV corroborators finally see a value
```

### Why both endpoints carry the fields

`/enrich/candidates` is where `ensureBeerRow` already runs for **every** card on
the page, so it is the natural persist point, and it dissolves an ordering
problem: today `/candidates` creates the row with `abv: null` and `/result` then
reads that same row back, so setting ABV only on insert would still leave even
brand-new beers looking up blind on the same pass.

Sending the fields on `/result` too is ~10 bytes of redundancy that keeps the
endpoint independently correct instead of silently dependent on call ordering.

Persisting at `/candidates` time also helps #368: that endpoint receives up to
200 beers while only `MAX_SEARCHES_PER_PAGE = 20` get searched, so the ~180
unsearched cards keep their ABV for whenever they next become reachable.

### Payload budget

`/enrich/candidates` is capped at `ENRICH_CANDIDATES_BODY_LIMIT_BYTES` = 256 KiB
for up to 200 beers. A number plus a short style string is ~30 bytes per beer,
~6 KB at the ceiling. No change to `payload-limit.ts`.

## Persistence

`ensureBeerRow(db, brewery, name, facts?)` where
`facts = {abv?: number, style?: string}`:

| row state | behaviour |
| --- | --- |
| does not exist | insert **with** the facts (today: hard-coded `abv: null, style: null`) |
| exists, orphan (`untappd_id IS NULL`) | fill **only columns currently NULL**, only from defined facts. Never overwrite. |
| exists, matched | touch nothing |

Matched rows are left alone because their `abv`/`style` are Untappd's, matching
is already done, and a shop value can only introduce drift. This also keeps
#343's pinned rows out of the path entirely, since pins are matched rows.

Accepted trade-off: a matched row with `abv IS NULL` and a known shop ABV stays
NULL.

## Re-arm

Fires **only** when an orphan row gained an ABV it did not have —
`existing.abv IS NULL` and `facts.abv !== undefined`. Then
`untappd_lookup_at = NULL, untappd_lookup_count = 0`, so `isEligible` returns
true immediately and the beer is retried with the new signal.

- A style-only gain does **not** re-arm: nothing in `lookupBeer` reads style, so
  it cannot change the outcome, and re-arming would spend Untappd lookups for
  nothing.
- `isWontfix` still gates eligibility independently, so a re-armed wontfix row
  stays parked.
- The re-arm is self-limiting: it can only fire as fast as users actually browse
  those shop pages, and only for rows that gained real information.

Prod state of the affected population (2026-07-31): 797 orphans with
`abv IS NULL` — 568 never searched, 229 shallow backoff, **0 deep backoff**. So
re-arming is cheap. No blind mass re-arm: re-arming a row that still has no ABV
merely re-spends the blind lookup that already failed.

## Catalog invalidation and its cost

`loadCatalog` selects `abv`, so `beers.abv` feeds the `/match` catalog cache. A
fill must `bumpCatalogVersion()` or `/match` serves the stale value until the
5-minute TTL expires.

The hazard is that `/enrich/candidates` handles up to 200 beers on a hot path
and a rebuild is ~1.2 s of CPU over the 30 k-row catalog. Therefore:

> **Bump at most once per request, and only if at least one row actually gained
> a fact — never once per row.**

The bump rate then tracks new-beer discovery, the same rate `recordLookupSuccess`
already bumps at today. The cache is stale-while-revalidate, so the rebuild is a
background job, not a blocking one. Second and later visits to the same page fill
nothing and bump nothing.

The fills stay inside the existing `deps.db.transaction(...)` wrapper in
`/enrich/candidates`; the bump is issued after the transaction commits.

## Error handling

- The parse helper is **total**: `n/d`, `-`, an empty cell, or `4,8%` with a
  comma yields either a finite number or `undefined`, never a throw.
- Server-side sanity lives in one shared `sanitizeAbv()` that drops non-finite
  values and anything outside 0–100. The zod shape stays permissive
  (`z.number().optional()`) on purpose: a strict `.min(0).max(100)` would 400 the
  entire 200-beer batch because one card had a rogue value, blanking the badges
  on a whole page for a cosmetic input problem. Degrade to "no ABV", don't fail
  the request.
- `style` truncates at `BEER_TEXT_LIMIT_CHARS` rather than rejecting.

## The 0.0% hazard

**`0.0%` is a real, load-bearing value.** #322's `AleBrowar / KWAS CHLEBOWY
JASNY` is ambiguous between `Kwas Chlebowy Bright` (0.0%) and `Kwas Chlebowy
Light` (0.5%) — same brewery, same style, nothing else separates them. The shop
publishes `Moc 0.0%`, which picks `Bright` (bid 5489374) outright.

Any `if (abv)` truthiness check anywhere on this path silently discards it and
ships a fix that misses the motivating case. Every check must be `!== undefined`
/ `!= null`. Existing code is mostly right already (`content/index.ts:73` uses
`card.abv !== undefined`, `pickByAbv` uses `abv != null`); every new line needs
the same discipline.

## Testing

The 0.0% guard is pinned at **each** boundary, not only end to end:

1. **Adapter** — `card.abv === 0` strictly (not `undefined`) for a 0.0% tile.
2. **Transport** — `content/index.ts` emits `abv: 0` in the orphan payload
   rather than omitting it; `OrphanBeer` carries it through `getCandidates` /
   `submitResult`.
3. **Persistence** — `ensureBeerRow` writes `0` to `beers.abv`, and the fill rule
   treats `0` as present (an existing orphan with NULL gains it **and** re-arms).
4. **End to end** — the #322 case itself: two `AleBrowar / Kwas Chlebowy`
   candidates, `Bright` at 0.0% and `Light` at 0.5%; `lookupBeer` with `abv: 0`
   picks `Bright` (bid 5489374). Permanent regression test.

Boundaries 1 and 2 run against a real captured fixture (below); 3 and 4 are
server-side and need no fixture.

### The 0.0% fixture

The existing `onemorebeer.html` fixture has no 0.0% product, so the guard needs
its own capture. Use a **real page**, not a synthetic tile: the motivating beer
is live on the shop and a real capture also pins the surrounding DOM structure
the adapter depends on.

Target page: `https://onemorebeer.pl/bezalkoholowe/inne` — the `source_url`
recorded for orphan **29552 `AleBrowar / KWAS CHLEBOWY JASNY`** (`abv` NULL,
`untappd_id` NULL on prod as of 2026-07-31). Being the non-alcoholic category it
should be dense with 0.0% products rather than containing a single one.

The catalog is client-rendered (Nuxt): `curl` returns an SSR shell with **zero**
product tiles, so the capture must come from a hydrated browser DOM. Helper:
`tmp/capture-onemorebeer.js` (paste into DevTools console; it reports tile /
panel / 0.0% counts and downloads `onemorebeer.abv.html`). The
`Dane techniczne` panels must **not** be expanded before capturing — they are
already in the DOM and hidden, which is precisely the state under test.

Save as `extension/tests/fixtures/onemorebeer.abv.html`. This follows the
existing multi-fixture convention (`flasker.table.html`, `flasker.block.html`);
`conformance.test.ts` keys strictly on `<id>.html`, so an extra fixture is picked
up only by the adapter's own tests and cannot disturb the contract suite.

Fallback, only if the captured page yields no 0.0% product: a small synthetic
tile. Prefer the real capture.

Beyond the guard:

- Adapter: assert 4.5 / 5.5 / 5.5 and the styles for the DZIKI products; assert
  the PINTA products yield **no** ABV (Plato must not leak in).
- Server: matched row untouched; old-shape bodies (no `abv`/`style`) still return
  200; exactly one catalog bump per request and none when nothing changed; a
  200-beer payload with both fields stays under 256 KiB.

## Compatibility and rollout

Optional fields in both directions: an old extension keeps working against the
new server, and a new extension against an old server is fine too since zod
strips unknown keys rather than rejecting. No lockstep deploy.

1. Deploy the server first.
2. Cut extension **0.13.0** with a matching `## [0.13.0]` CHANGELOG section —
   `release-notes.ts` throws without one.
3. Re-arming happens organically as users browse. No prod DB surgery.

### Checkpoint

Measure **relay-sourced `enrich_failures` carrying ABV**, today **1/237 (0.4%)**,
a few days after the extension release. Given the shop breakdown,
flasker + beerfreak + funkyshop alone should move it to roughly two thirds. If it
does not, the protocol change did not actually land — that is the signal to
investigate.

## Related

- **#322** — the PL↔EN `jasny` ambiguity is an artefact of this bug; sequence
  #369 first so the map is not tuned against artificially blinded inputs.
- **#349** — builds an ABV + style corroborator on the signal this restores.
- **#368** — cron-unreachable orphans; shares the relay population and the
  `/enrich/candidates` persist point.
