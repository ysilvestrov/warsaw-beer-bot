# #384 — Use the Untappd bid flasker publishes as identity

**Status:** design approved 2026-08-09
**Issue:** [#384](https://github.com/ysilvestrov/warsaw-beer-bot/issues/384)
**Related:** #385 (shipped, left the wrong link this fixes), #334 (name-stage
disambiguation), #349 (hydrate by bid), #343 (curated pins), #373 (detail fetch
for ABV), #376 / #307 / #370 (flasker brewery-split defects)

## Problem

Flasker publishes a direct Untappd beer URL — slug and bid — on its product
detail pages. We ignore it and reconstruct identity from the product title
instead. Flasker is consequently our worst shop: 139 active `enrich_failures`
rows, 55 filed as parser bugs.

Reconstruction does not merely fail to match; it can match the **wrong beer**:

```
input:   Mad Brew / "Tomatol Bulgogi"  abv=3.8   (correct parse, post-#385)
cands:   6648348  Mad Brew / "Tomatøl:BULDAK BULGOGI"     4.2   ← shop-published
         6708599  Mad Brew / "Tomatol: Bulgogi Sriracha"  4.2
result:  MATCHED 6708599                                        ← wrong
```

The shop title omits "Buldak", so the input tokens are a strict subset of the
wrong candidate's. Nothing in the pipeline separates them: both candidates are
4.2% so ABV cannot; Algolia folds `ø`/`o` so spelling cannot; and a curated pin
cannot, because `pinMatch` would merge the row into canonical 25291 and delete
it, after which `ensureBeerRow` recreates the shop identity on the next relay.

## Measurements (live, 2026-08-09)

Taken before design, on 45 real flasker product pages sampled from the product
table, `/1-2/` and the home grid.

| signal | coverage | notes |
|---|---|---|
| `untappd.com/b/<slug>/<bid>` | **37/45 (82%)** | confirms the issue's 10/12 |
| JSON-LD `{"@type":"Brand","name":…}` | **45/45 (100%)** | independent brewery signal |
| duplicate bids across products | **0** | bid-as-identity is unambiguous here |

The bid link sits in a rendered block beside the shop's cached Untappd rating
(`Untappd: 4.06 / 5`) and appears on **no** listing view, so a per-product detail
fetch is required.

Misses cluster on Vibrant Pour (6 of 8) but are not structural — three other
Vibrant Pour products do carry bids. Reads as un-curated, not systematically
absent.

### The brand signal is worth as much as the bid

100% coverage, and it is exactly what `BREWERY_RULES`, `familySlugPrefixes` and
the generated brewery registry in `flasker.ts` hand-approximate:

| shop title | JSON-LD brand |
|---|---|
| `Tomatol Bulgogi 3.8%` | Mad Brew — would have resolved #385 with no slug rule |
| `Vespers 7.6%` | Mad Brew |
| `MGM-15 330мл` | Mad Brew |
| `Mad Girl Granat 4,2°` | Mad Brew |
| `Morava Winter Flow IS 10%` | Vibrant Pour |
| `ШО (IIIO) Beetnik Tomato Gose` | IIIO |

Both signals are therefore in scope: one fetch yields both.

### Algolia hydration by bid works, and batches

Verified live before depending on it (project policy):

- `objectID === bid`, so `POST /1/indexes/*/objects` with
  `{"requests":[{"indexName":"beer","objectID":"6648348"}, …]}` returns full
  records — **one request for a whole page of bids**.
- `filters=bid=<n>` also works. A plain query for the number returns 0 hits.
- Records expose `beer_slug`, `brewery_name`, `brewery_alias`, `beer_abv`,
  `type_name`, `rating_score`.
- The record's `beer_slug` matches the slug the shop publishes, on 4/4 checked.

## Approach

Client parses the detail page and relays the evidence; the server hydrates,
decides trust, and writes. Rejected alternatives: having the client resolve and
post a finished link (moves a trust decision into unversioned client code we
cannot update in the wild), and a server-side detail fetch (only ever repairs
rows that already failed, and re-introduces shop scraping from our
block-prone IP).

### Client

`flasker.ts` gains `loadCardDetails`, modelled on `beerfreak.ts:234` — the same
`WeakMap<HTMLElement, url>` plus module-level promise cache keyed by URL, the
same `MAX_DETAIL_FETCHES_PER_PASS = 20`, the same swallow-on-failure. It is
called only for cache misses, immediately before `/match`
(`content/index.ts:46`).

Each fetch yields:

- `brand` → overrides the brewery from `parseCards`.
- `bid` + `bidSlug` → from the `untappd.com/b/<slug>/<bid>` anchor.

`Card` gains `bid?: number` and `bidSlug?: string`. Both ride the existing
payloads as **optional** fields, so older clients are unaffected and the server
reads absence as "no evidence".

### Server

New `src/domain/bid-identity.ts`, one entry point:

```
resolveByBid({ bid, bidSlug, brand, db, hydrate })
  → { kind: 'accepted', result: SearchResult }
  | { kind: 'rejected', reason: string }
```

Resolution order:

1. `SELECT … FROM beers WHERE untappd_id = ?` — UNIQUE, therefore indexed. On a
   hit, build the result from our own row; **no Algolia call**. With ~34k
   catalogued beers this is the common case, and it keeps working while Untappd
   is blocking us.
2. On a miss, `hydrateByBid([bid])` — a new batched method on the Algolia client.
3. Apply the guard.

`/enrich/result` consults `resolveByBid` **before** `lookupBeer`. The bid is
ground truth, so it must precede query construction, the brewery gate, alias
expansion and fuzzy matching — every stage that currently produces these
orphans. Running it afterwards would let the wrong match win first.

#### The early return has to change

`/enrich/result` currently returns at `enrich.ts:144` whenever
`row.untappd_id != null`, reporting the stored link as `matched`. Row 34564 hits
exactly that branch, which is why the wrong link is unreachable today. The
override case therefore cannot work without relaxing it:

```
return early when  untappd_id != null
                   AND (no bid  OR  bid == untappd_id  OR  source refuses override)
```

Everything else falls through to `resolveByBid`. This is the only change to an
existing hot path in the design, and it is behaviour-neutral for every client
that sends no bid — which is every client until 0.14.

**No new write path is required.** `resolveByBid` returns a `LookupOutcome` of
kind `matched`, and `applyLookupOutcome` already handles the rest:
`recordLookupSuccess` → `SQLITE_CONSTRAINT_UNIQUE` → `mergeIntoCanonical`
(`src/domain/lookup-outcome.ts:33-47`). That is exactly the 34564 → 25291 merge
the acceptance test requires, on a path already running in production.

### Scope boundary: `/match` is untouched

`/match` is a pure read over a prepared in-memory catalog (`matchBeerList`) with
no write path, so a bid cannot create a link there. Passing the bid would also
mean changing a hot, cached path. All bid handling therefore goes through
`/enrich/*`. Consequence: the badge becomes correct on the **next** page view,
not the current one.

## The guard

**Brewery agreement is the only veto.**

| check | verdict | rationale |
|---|---|---|
| brewery: `brand` ⟷ `brewery_name` + `brewery_alias` | **veto** | the load-bearing check; catches a shop linking someone else's beer |
| slug: `bidSlug` ⟷ record `beer_slug` | **log only** | an integrity signal, but a bid that hydrates to a real beer whose brewery agrees is trustworthy regardless |
| name similarity | **log only** | vetoing rejects `Tomatol Bulgogi` ⟷ `Tomatøl:BULDAK BULGOGI` — the exact case this exists to fix |
| ABV | **log only** | the shop states 3.8% while its own linked record says 4.2% |

The issue's proposed "brewery/name similarity" check would have rejected its own
motivating case, in the same way its ABV warning describes.

Slug divergence is logged rather than vetoed for two reasons: it is unavailable
on the local-catalog path at all (`beer_slug` is not stored, and adding a column
is not worth it), so vetoing on it would make trust depend on whether we happen
to hold the record; and brewery agreement already covers the failure it guards
against. If logs ever show slug divergence occurring in practice, promoting it
to a veto is a one-line change.

## Provenance (migration v22)

Prod is on v21.

```sql
ALTER TABLE beers ADD COLUMN untappd_id_source TEXT
  CHECK (untappd_id_source IN ('search','bid','curated','checkin'));
```

Decision table for a published bid `Y` against a row holding `X`:

| state | action |
|---|---|
| `X == Y` | no-op |
| `X IS NULL` | accept `Y` (guarded) — the orphan case |
| `X != Y`, source `curated` or `checkin` | **refuse**, log |
| `X != Y`, source `search`, `bid`, or `NULL` | accept `Y` (guarded) |

"Accept" means `UPDATE beers SET untappd_id = Y` when `Y` is unowned, and
`mergeIntoCanonical` into `Y`'s existing owner when it is not — the latter being
the 34564 → 25291 case. Both are reached through `applyLookupOutcome`, so
neither is new code.

Writers: `recordLookupSuccess` → `'search'`; `pinMatch` → `'curated'`; the
check-ins sync's `upsertBeer` → `'checkin'`; the new path → `'bid'`.

`checkin` refuses override for the same reason `curated` does: the link is
Untappd's own record of the beer, not a guess of ours. Such a row becomes
reachable only because of the early-return change above, so the refusal is what
preserves today's behaviour for it.

### Backfill is mandatory, not cosmetic

All ~34k existing rows would otherwise be `NULL`. If `NULL` reads as
machine-derived, every curated pin becomes overridable and #343 is silently
undone. The migration therefore backfills first:

```sql
UPDATE beers SET untappd_id_source = 'curated'
 WHERE id IN (SELECT untappd_beer_id FROM match_links WHERE reviewed_by_user = 1);
```

`match_links.untappd_beer_id` is a local `beers.id`, not an Untappd bid — the
standing gotcha. Everything else stays `NULL` = unknown = overridable, the
correct reading for search-derived links.

Known limitation: existing check-in-sourced rows cannot be distinguished
retroactively, so they backfill to `NULL` and are nominally overridable. Accepted
— overriding one would require a shop card to normalise to the same
brewery + name *and* publish a different bid *and* pass the brewery veto. New
check-in rows are labelled correctly from the migration onward.

`search` cannot clobber `bid` **by construction**: `/enrich/result` returns early
when `untappd_id != null`, and the enrich cron selects only
`untappd_id IS NULL`. This is asserted in a test rather than enforced in code.

## Error handling

The governing rule: the bid path must never make an outcome worse than today.
Every failure falls through to the existing `lookupBeer` pipeline.

| failure | behaviour |
|---|---|
| detail fetch fails (404 / network / Cloudflare) | swallowed client-side; card keeps its `parseCards` brewery and sends no bid |
| Algolia hydrate throws or is blocked | fall through; never surfaced as a request error |
| bid hydrates to nothing (beer deleted upstream) | reject, log, fall through |
| guard vetoes on brewery | reject with reason, log, fall through |

## Testing

- Guard truth table, including the two negative assertions most likely to be
  "helpfully" reintroduced later: name divergence and ABV divergence must **not**
  veto.
- `loadCardDetails` parsing against a captured flasker **product page** — a new
  fixture kind. `capture-omb-abv-fixture.ts` is the precedent for single-product
  captures; the registry-driven `npm run capture` deliberately models only
  listing pages.
- Provenance decision table, including the `curated` and `checkin` refusals.
- The relaxed early return: a client sending **no** bid must produce byte-identical
  behaviour to today for an already-matched row.
- Migration test: the backfill marks exactly the pinned set and nothing else.
- End-to-end: `/enrich/result` carrying bid 6648348 for `Mad Brew / Tomatol
  Bulgogi` yields `merged` into 25291.

## Rollout

1. Take a local pre-v22 snapshot as the bot user (`VACUUM INTO`, WAL-safe and
   consistent); verify size and `PRAGMA integrity_check`. Litestream replicates
   to R2 continuously, but restoring from it needs R2 access plus a restore step,
   and `migrate()` runs automatically on service start with no backup hook in
   `deploy.sh`.
2. Deploy the server half. It is a **no-op in production until a client sends a
   bid** — 0.13.0 never will — so the migration and new code soak with zero
   behavioural change.
3. Verify `schema_version = 22` and that the backfill count equals the current
   pin count.
4. Verify the acceptance test server-side by POSTing `/enrich/result` with the
   bid directly, rather than waiting for the store.
5. The client half rides the 0.14 store release.

## Acceptance

Row `34564 Mad Brew / Tomatol Bulgogi → 6708599`, live in prod since 19:17 UTC
2026-08-09, carries **6648348** and stays there across a re-ingest.

Users see nothing until 0.14 is cut and passes store review, as with #383 and
#385. The server half is verifiable immediately; the badge fix is gated on the
release.

## Non-goals

- Changing `/match`.
- Retiring `BREWERY_RULES` / `familySlugPrefixes` / the generated registry in
  `flasker.ts`. The brand signal makes that possible later; doing it here would
  widen the blast radius to every flasker card at once.
- Extending the bid channel to other shops. Measured flasker-only: winetime 0/6,
  onemorebeer 0/3, beerfreak 0/2.
- Widening `tomatol-` handling or other #334 name-stage work.
