# Legacy orphan disposition: rollout plan

Created: 2026-09-23

## Goal and boundary

Close the eight historical Flasker orphans owned by #677 without making an
unproved beer match, losing an old-client card, or returning an irreparable row
to enrichment and triage. The current Flasker adapter is not the target of this
plan. #678 and #684 have already been consolidated into #677; no future rows
belong to this cohort.

This is a sequencing plan, not an implementation design. Each new behavior
needs its own design/specification and a focused implementation plan before code
changes. Do not reinterpret existing `retired_at` or `unrescued_at`: `spec.md`
§3.13 gives them different meanings from a durable inactive legacy row.

## Order and gates

- [ ] **0. Establish evidence for #677.** Inventory exactly the eight linked
  `beer_id`s and their stored card, ABV, issue, review class, candidates,
  source URL, existing aliases, and current references. Run the read-only
  `adjudicate --issue 677` replay with both canaries; retain the verdict file.
  For each row, seek a product-page or other direct identity proof and record
  whether the exact Untappd bid is proven, identity is genuinely unknown, or
  the evidence is inconclusive. A search candidate alone never proves identity.
  No row is merged or made inactive in this step.
- [ ] **1. Implement #696 for proven identities.** Design and specify a
  per-row operator repair using the existing `mergeIntoCanonical` and
  `beer_aliases` semantics (`spec.md` §3.6.1). Require a preview of the exact
  legacy brewery/name/ABV, target bid, evidence, and collision checks. Apply
  merge/link, reference preservation, failure cleanup, and old-card alias
  atomically. Test an existing catalog bid, a bid requiring hydration, both
  `/match` and `/enrich/*`, an old client repeating the original card, a new
  client sending the corrected card, ABV variants, and contradictory evidence.
  A differing ABV requires explicit `--overwrite-abv`: preserve the original
  card ABV in its alias key, set the canonical beer to hydrated Untappd ABV,
  and atomically record the operator's reason and evidence in a durable audit
  event. Design: `docs/superpowers/specs/2026-09/2026-09-23-696-legacy-shop-card-repair-design.md`.
  Likely code areas: `src/storage/beers.ts`, an operator script under `scripts/`,
  their colocated tests, and `spec.md`.
- [ ] **2. Implement #695 for identities that cannot be established.** This
  can proceed alongside #696. Design and specify a distinct auditable inactive
  state with a per-`beer_id` operator action, reason, evidence, issue number,
  and an explicit reopening path. Exclude it from both enrich pools, client
  relay, daily triage, and issue-close rearming. Test that an old client cannot
  recreate an active orphan while a correctly parsed new card remains usable.
  Likely code areas: `src/storage/schema.ts`, `src/storage/enrich_failures.ts`,
  `src/storage/beers.ts`, API enrichment routes, `src/jobs/orphan-triage.ts`,
  `src/jobs/unlock-fixed-orphans.ts`, their tests, and `spec.md`.
- [ ] **3. Implement #697 after both dispositions work.** Update
  `docs/orphan-triage-issues-runbook.md` and the close-out command/gate to
  enumerate the live linked rows and reject closure while any lacks a durable
  disposition. Require a fresh row-state check before applying a verdict;
  document conflicts between a shop-published bid and search candidates.
  Verify that closure or label removal cannot rearm an unresolved row.
- [ ] **4. Finish #677 row by row.** Recheck live evidence and state before
  each operation. Use #696 only for proved bids, #695 only for rows whose
  identity cannot be established, and leave inconclusive rows open. Verify
  persisted aliases/inactive markers and all three exclusion paths. Only after
  all eight rows have a durable disposition, remove `orphan-triage` from #677
  and close it. Confirm no #677 row was rearmed or re-triaged.

## Baseline and evidence already obtained

On 2026-09-23 a read-only production query found exactly these eight live
`enrich_failures` rows linked to #677: 29781, 29786, 29893, 29898, 29912,
29955, 34199, 35180. All eight are still orphans (`untappd_id IS NULL`),
`outcome='not_found'`, with `retired_at IS NULL` and `unrescued_at IS NULL`.
All eight have search candidates; none is thereby proven to be that candidate.
The 2026-09-23 14:41 UTC live `adjudicate --issue 677` run passed both
canaries and returned **8 `unrescued`, 0 `rescued`, 0 `inconclusive`**. Its
unaltered verdict file is `/tmp/adjudicate-677-1790174498696.json` on the
production host; `--apply` has **not** been run. This proves only that lookup
of the *stored malformed strings* currently finds none of them. It does not
prove that the identity of any actual shop beer is unknowable. The verdict
file must be regenerated if a later operation needs fresh row-state evidence.

A read-only reference inventory found zero `beer_aliases`, `match_links`,
`checkins`, and `untappd_had` references for each of the eight rows.
The stored `source_url` is a Flasker homepage, category, or generic product
endpoint, not yet sufficient as per-row identity proof. In particular, 29955
has a stored 2018/6.0% card but candidates for unvintaged 6.0% and 2018/7.0%;
34199 has stored 10.0% versus a cited 8.4% candidate; and 35180 has a
2025-vintage name while the old issue proposed a generic bid. Treat these as
explicit evidence conflicts, not matching instructions.

Initial storefront research found a **shop-published Untappd link** on product
pages that match five stored cards. This is stronger than a search candidate,
but before an operator action confirm that the present product page is the
historical source of the exact frozen card and resolve any conflicting ABV:

| beer_id | product-page evidence | published bid | caveat |
|---|---|---:|---|
| 29781 | [Laatste Plicht](https://flasker.com.ua/product/%D0%BF%D1%80%D0%B5%D0%B4%D1%80%D0%B5%D0%BB%D1%96%D0%B7-de-zwarte-regel-laatste-plitcht-9-0-33/) | 6560530 | page is tagged Vibrant Pour; Untappd names Mad Brew |
| 29898 | [Eerste Hoede](https://flasker.com.ua/product/vibrantpour-zwarte-regel-5-5-0-33/) | 6560529 | page is tagged Vibrant Pour; Untappd names Mad Brew |
| 29912 | [Derde Wacht](https://flasker.com.ua/product/%D0%BF%D1%80%D0%B5%D0%B4%D1%80%D0%B5%D0%BB%D1%96%D0%B7-de-zwarte-regel-derde-wacht-7-5-0-33/) | 6560526 | page is tagged Vibrant Pour; Untappd names Mad Brew |
| 29955 | [De Cam 2018](https://flasker.com.ua/product/de-cam-abrikoos-rabarber-2018-750-ml/) | 3615616 | shop card says 6%, candidate for this vintage says 7% |
| 35180 | [Rochefort 8 2025](https://flasker.com.ua/product/trappistes-rochefort-8-2025-330-ml/) | 6134078 | old issue proposed generic bid 11473, which is not this vintage |

For 29786 and 29893, current Candlelit listings did not yet prove which
historical card produced each frozen row. For 34199, the current
[Morava Smoked IS 10% page](https://flasker.com.ua/product/vibrantpour-morava-smoked-is-10-0-33/)
publishes bid 6724242, but the stored name is `Morava Winter Flow IS`; the
search candidate instead names bid 6828611 at 8.4%. None of these three may
be linked by name similarity alone.

The existing exact `triage-scope` on #677 admits only those eight IDs. Keep its
`orphan-triage` label until step 4: `unlock-fixed-orphans` interprets label
removal like issue closure for locked rows (`spec.md` §3.13).

## Verification and stopping rules

Before each code change, write failing focused tests and follow the existing
schema, alias, enrich, and triage conventions. Run `npm test && npm run
typecheck` after each implementation slice, plus operator dry-runs against a
copy of production data before any production write. No bulk update by
`issue_number`. If a product identity remains inconclusive, do not force it
into either state; #677 remains open for that row. Changes to `spec.md` and
the design must precede implementation, not rationalize it afterward.

The isolated worktree `plan/legacy-orphan-disposition` started from
`origin/main` at `b5c868c`. Its baseline `npm test` passed: 184 test files,
3118 tests; one test file and one test skipped. Baseline `npm run typecheck`
also passed.
