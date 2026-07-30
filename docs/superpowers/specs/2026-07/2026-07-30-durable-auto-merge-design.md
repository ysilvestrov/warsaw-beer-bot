# Durable auto-merge — design

**Date:** 2026-07-30
**Issues:** #366. Complements #343 (curated pins, the manual counterpart) and #361 (pin pipeline, which
receives the inventory/confirmation follow-ups). Distinct from #334 (wrong matcher links).
**Status:** approved

## Problem

An orphan whose Untappd lookup resolves to a bid that **already belongs to another catalog row** is
merged into that row by `mergeIntoCanonical` and its own `beers` row is deleted. The next `refreshOntap`
run re-creates the identical orphan from the identical tap, enriches it again, and merges it again —
indefinitely.

Measured in the production journal, 2026-07-01 … 2026-07-30
(`grep 'enrich: merged duplicate orphan into canonical'`):

| metric | value |
|---|---|
| auto-merges in 30 days | **1823** |
| distinct canonical targets | **98** |
| steady-state rate | **~65 merges/day** |
| top target — `8451 Brooklyn Brewery — The Stonewall Inn IPA` | 102 merges (≈3.4×/day) |

The same loop on the metered path: `ReCraft x Red Light Pub Gdańsk / Slighty Perverted Juicy Sour
Marakuja Winogrona Granat` (a twice-daily tap at The Beer Spot) consumed **5 of the 13 Brave units spent
between 07-28 and 07-30 — 38% of the paid spend** — as beer ids 33883 → 33915 → 33950 → 33995 → 34040,
each resolving to `bid 5748213` and merging into canonical row `32756`. Every cycle starts from a fresh
row whose `web_tried_at` is NULL, so the 30-day cooldown introduced by #351 never applies.

### Mechanism

1. `refreshOntap` (`src/jobs/refresh-ontap.ts:111-137`) skips recomputation only for a **pinned** link
   (`getMatch(...)?.reviewed_by_user`). Otherwise it calls `matchPrepared`, and on a miss calls
   `upsertBeer` + `upsertMatch` — a brand-new orphan id.
2. Inline enrich resolves it to the real bid; `recordLookupSuccess` hits the `beers.untappd_id` UNIQUE
   constraint; `applyLookupOutcome` (`src/domain/lookup-outcome.ts:34-47`) falls back to
   `mergeIntoCanonical`.
3. `mergeIntoCanonical` (`src/storage/beers.ts:120-125`) redirects `match_links.untappd_beer_id` to the
   canonical row and deletes the orphan, leaving `reviewed_by_user = 0`.
4. Next ingest: the link is not pinned → step 1 recomputes → the matcher still cannot match the tap name
   to the canonical name (that is *why* the row needed a merge) → new orphan. Loop.

The knowledge the merge produces — "this `ontap_ref` is that canonical beer" — is written into
`match_links` and then destroyed by the next `upsertMatch`, because nothing distinguishes a
merge-established link from a matcher-established one.

`pinMatch` (#343, `src/domain/pin-match.ts:24-36`) performs the same merge but sets
`reviewed_by_user = 1`, which is exactly why manually pinned name-divergent orphans do not loop. Auto-merge
is the same operation without a durability marker.

### Cost

- **~65 duplicate Untappd/Algolia lookups per day** that can only ever end in a merge — pure re-work
  inside the traffic budget we proxy and circuit-break (#200), and inside the 20-per-run inline enrich budget.
- **Metered Brave units**: 38% of paid spend in the measured window, structurally uncapped because the
  `web_tried_at` cooldown dies with the row.
- Catalog churn invisible to statistics: a fresh `beers` row per ingest, each with an `enrich_failures`
  row that CASCADE-disappears on merge.
- `mergeIntoCanonical` deletes the orphan without redirecting `checkins`. `checkins.beer_id` has no
  ON DELETE CASCADE and `foreign_keys=ON`, so a check-in landing on an orphan before its merge aborts the
  merge with an exception. Not yet observed in production, but reachable.

## Goals

- A tap whose identity was established by a merge stops producing a new orphan (and therefore a new
  Untappd lookup, and therefore a possible metered call) on every ingest.
- The matcher keeps priority: it may overrule the remembered identity at any time.
- The effect is measurable from the journal with the two greps that found the defect.

## Non-goals

- An inventory or revocation CLI for auto-merges, and a confirm-before-trust queue → **#361**.
- #334 (matcher links that regenerate *wrongly*). This design deliberately does not make matcher-established
  links sticky, so a future #334 fix keeps working: when the matcher stops matching, the row becomes an orphan.
- Any change to `/match`, to the extension, or to the enrichment gate (#349).

## Design

### 1. Data — migration v21

```sql
ALTER TABLE match_links ADD COLUMN merged_at TEXT;
```

`NULL` = the link was established by the matcher (or predates this change). Non-null = the link was
established by `mergeIntoCanonical`, with the timestamp of that merge.

**No backfill.** The information cannot be reconstructed: today it is overwritten on the next ingest. The
column fills itself within one ingest cycle after deploy, which is also what makes the rollout check
unambiguous (see §5).

### 2. Ingest priority order (`refresh-ontap.ts`)

Strongest first:

1. **Pin** (`reviewed_by_user = 1`) — unchanged: `continue` before anything else.
2. **Matcher hit** — unchanged behaviour plus one addition: `upsertMatch` rewrites the target **and resets
   `merged_at` to NULL**. This is "the matcher is always in charge": once it can match this tap, the
   memory of the merge disappears.
3. **Matcher miss on a link with `merged_at`**, whose target row still exists and has a non-null
   `untappd_id` → reuse it: no `upsertBeer`, no new orphan, no inline enrich, no `prepared.add`;
   `continue`, counter +1. The link already points at the canonical row, so no write is needed.
4. **Otherwise** — unchanged: create the orphan, link it, inline-enrich it.

Case 3 is deliberately distrustful: if the target row is gone or has no `untappd_id`, the memory is not
honoured and control falls through to case 4.

The `merged_at` reset lives **inside `upsertMatch`** (which has exactly two call sites, both in this file),
so the invariant "any link written by the matcher is not merge-derived" cannot be broken by accident.

### 3. `mergeIntoCanonical` (`storage/beers.ts`)

One transaction, three effects:

1. redirect `match_links.untappd_beer_id` to the canonical row **and stamp `merged_at`**;
2. redirect `checkins.beer_id` to the canonical row (mirroring `pinMatch`) — closes the FK-abort path
   described above;
3. delete the orphan row (`enrich_failures` CASCADEs).

`applyLookupOutcome` needs the timestamp it already has (`nowIso`); no signature change beyond that.

### 4. Observability

One per-run `info` line, in the style of the existing `ontap taps discarded`, emitted only when the count
is non-zero:

```
{ reused: N }  "ontap merged links reused"
```

### 5. Rollout and success criteria

Additive migration, no `.env` change, no extension change, normal deploy.

Verification window is **two ingest cycles (~1 day)**: the first run after deploy still creates one orphan
and one merge per affected ref — that is how each stamp gets written — and from the second run on it stops.

| signal | before | expected after |
|---|---|---|
| `enrich: merged duplicate orphan into canonical` | ~65/day | single digits (genuinely new tap texts only) |
| `ontap merged links reused` | n/a | ≈ the rate that disappeared from the line above |
| repeat `web-fallback call` on the same tap identity | 38% of spend in the measured window | none |

The middle row matters: the work must reappear as reuse, not vanish. If both lines drop, taps are being
lost instead of remembered, and that is a regression (the #306 class of defect).

### 6. Tests (vitest, TDD)

- `mergeIntoCanonical`: stamps `merged_at` on redirected links; redirects `checkins` before deleting the
  orphan (a test with a check-in on the orphan fails today with an FK error — that is the red test);
  deletes the orphan.
- `upsertMatch`: resets `merged_at` to NULL on conflict.
- `refreshOntap`:
  - matcher miss + stamped link → no new `beers` row, enrich not called, link untouched, counter logged;
  - matcher miss + stamped link whose target is missing or has `untappd_id IS NULL` → orphan created as before;
  - matcher hit → link retargeted and `merged_at` cleared;
  - pinned link still short-circuits everything.

### 7. Risks

**A wrong auto-merge becomes durable.** The ambiguity case in #349 (four same-brewery variants clearing
the gate, correctness resting on Brave's ranking) is the realistic source. Mitigations: the matcher overrules
the memory whenever it matches; revocation is `UPDATE match_links SET merged_at = NULL WHERE ontap_ref = …`
(or deleting the row), after which the next ingest re-creates the orphan normally. Inventory and a
confirm-before-trust queue are follow-ups on #361 — deliberately not built here, because production has not
yet produced a single known-wrong auto-merge to design against.

**Spec impact:** in the same PR, `spec.md` §3.6 (`match_links` column table + the curated-pin prose) gains
`merged_at` and the four-way ingest priority order; §5.2 (business invariants) gains the invariant that a
merge-established identity survives re-ingestion while remaining subordinate to the matcher.
