# #695: Inactive legacy orphans with an operator-only reopen

Date: 2026-09-23
Status: proposed for review
Origin: #695; rollout in `docs/superpowers/plans/2026-09/2026-09-23-legacy-orphan-disposition-rollout.md`

## Problem and boundary

An adapter fix cannot repair a stored malformed shop card if nobody can establish which beer it meant. Repeating that card through an old extension can also mint another orphan after the original is removed from a pool. `retired_at` asserts that a fix resolved the row, while `unrescued_at` only denies a free retry for one fix; neither means “keep this historical input, but let no automatic path act on it.” `review_class = 'unidentifiable'` remains reversible by observation and deliberately stays in lookup pools.

This design adds a separate, evidence-backed disposition for **one existing orphan and one exact historical shop card**. It does not classify every `unidentifiable` row as inactive, guess a bid, modify the extension, or decide any of the eight #677 rows in bulk. A row with inconclusive card provenance remains unresolved and keeps #677 open.

## Decision and alternatives

Keep the orphan and its `enrich_failures` record. Add a small `legacy_orphan_dispositions` table whose active record is both the row-level exclusion marker and the exact-card tombstone. Its decision fields are immutable; an explicit operator reopen closes that episode while retaining its history. No automatic lookup, review reset, issue closure, ABV update, imported bid, or repeated client request may close it.

An `inactive_at` flag only on `enrich_failures` would be simpler but could be lost when that row is deleted or rewritten, and would not remember which old card to refuse. Deleting the orphan and keeping only a card tombstone would lose its existing references and row-level audit. Both alternatives make later evidence harder to use safely.

## Stored state and exact key

Each disposition episode stores: its own ID; historical `beer_id` and `issue_number`; raw historical card brewery/name/ABV, with an explicit distinction between absent and present ABV; `cardText` brewery/name and `cardAbv` ABV key; the original failure `source_url`; operator, reason, evidence URL, and UTC `inactive_at`. Reopening fills `reopened_at`, reopening operator, reason, and evidence URL on that episode. Decision fields cannot be edited in place. A subsequent inactivity decision creates a new episode. Partial unique indexes allow at most one active episode per `beer_id` and per exact card key. The historical `beer_id` is not an `ON DELETE CASCADE` foreign key: later deletion must not erase the decision trail.

The operator must prove the exact key the old client emitted, including its ABV or its absence. `beers.abv` alone is insufficient: later enrichment may have changed it. The card source/capture and investigation note must establish that the stored malformed row came from that card; the evidence URL points to the durable record. “Search currently returns no match” alone proves neither the card provenance nor that the underlying beer is unknowable. The reason records why no defensible bid can presently be chosen, not a claim that no future evidence can exist.

Distinct ABV keys remain distinct. A 6% historical card does not suppress a 7% corrected card with otherwise identical text. A different old-client key is not covered by this decision and needs its own investigation and row-level disposition if it appears; there is no wildcard brewery/name ban. If the corrected adapter emits the **same** exact key, the server cannot distinguish it from the old client: it remains blocked until an operator explicitly reopens the episode.

## Operator action and concurrency

Provide a per-row command, dry-run by default, with explicit `--apply`. The input names `beer_id`, responsible issue, raw historical card and ABV/absent ABV, reason, evidence URL, and operator. The preview shows the row and failure state, derived exact key, source URL, linked references, and any alias/disposition collision. Before inserting an active episode, one short transaction rechecks the orphan still exists with `untappd_id IS NULL`, the failure still belongs to the supplied issue and has the same relevant card fields/state, the row is not retired or already repaired, and the exact key has neither an active disposition nor a `beer_aliases` mapping. Stale or contradictory input is a refusal, not an upsert. The command does not change `review_class`, `unrescued_at`, or existing lookup counters.

Reopening is a separate explicit operator mode targeting the active episode. It requires a new reason, evidence URL, and operator, confirms the row and active episode still match, then stamps the closure once. It does not delete or rewrite the original decision, auto-assign a bid, or implicitly rearm lookup/backoff; a later repair or re-triage is a separate action. A repeated identical apply/reopen reports a no-op only when the persisted episode proves it is the same action; a different proposal is a conflict. Concurrent attempts are serialized by the transaction and unique indexes.

## Runtime behavior

All automatic readers use the active episode, not `review_class` or `review_note`, as the authority:

- Both on-tap and relay enrichment pools, their queue counts, web fallback, daily triage/ownerless queues, and issue-close unlock/rearm omit inactive `beer_id`s. A review reset cannot erase the episode.
- `/enrich/candidates` checks the exact card key **before** `ensureBeerRow` and returns `eligible: false` for that card without creating or updating a beer/failure. `/enrich/result` checks before `ensureBeerRow`, even when the caller supplies a bid, and returns the existing `not_found` status without a beer/failure write. This protects old clients that call the result endpoint directly or ignore candidate eligibility.
- `/match` and its MCP equivalent answer no match for the active exact key before alias/matcher resolution. Otherwise an automatic matcher improvement could silently treat the historical card as a proven identity. The request/response shapes do not change.
- Normalized-name reuse and bid-based orphan adoption exclude inactive IDs. A different, corrected card can therefore create or use its own live row and resolve normally; import/check-in/refresh cannot silently attach a bid to the inactive historical row. An explicit manual reopen precedes any later repair of that row.

No global name ban is introduced. A disposition is scoped to its exact historical card for client ingress and to its `beer_id` for row-based work. The inactive row remains queryable for audit. The API must not advertise a new status that older extensions would not understand.

## Verification and rollout

Focused tests cover active/inactive/reopened episodes, stale-row and key collisions, missing card-ABV proof, and repeat idempotency. Integration tests replay an old client through `/match`, `/enrich/candidates`, and a direct `/enrich/result` (including a published bid); they assert no new active orphan, lookup, failure, or triage issue. A distinct corrected card, including an ABV-only difference, must still resolve. Storage/job tests cover both pools, queue counts, web fallback, daily triage, issue-close unlocking, review resets, and bid/import adoption. Reopen restores normal eligibility without itself resetting backoff or claiming a match.

Before a production write, run the full test and typecheck gate and rehearse the command against a copy of production data. For each #677 row, collect fresh evidence and preview separately; a search candidate or an `unrescued` verdict is not sufficient to mark it inactive. #697 must gate closing #677 on durable per-row disposition. No `WHERE issue_number = 677` bulk disposition.

## Claims and their evidence

| Recorded fact | Claim it makes | Required proof before write |
|---|---|---|
| Active `legacy_orphan_dispositions.beer_id` | This specific malformed orphan is deliberately out of automatic work | Fresh orphan/failure/issue state, card-to-row provenance, operator reason and evidence |
| Active exact card key | Repeating this precise historical input must not create or resolve an active orphan | Historical emitted brewery/name/ABV (including proved absence), fresh alias/key collision check |
| Decision reason and evidence | No defensible bid can currently be chosen for this row | Per-row investigation of the source product and conflicting/absent identity evidence; not merely an empty search |
| `reopened_at` and reopening fields | An operator deliberately lifted the active seal on new evidence | Explicit targeted reopen command, fresh active-episode check, operator and new reason/evidence |
| New live row for a corrected card | The corrected input is distinct from the sealed historical card | Exact-key comparison before normalized-name reuse; ordinary matching evidence still required for a bid |

## Existing patterns and non-goals

Use the existing `cardText`/`cardAbv` exact-key functions, `beer_aliases` collision semantics, storage queries in `beers.ts`/`enrich_failures.ts`, and dry-run-first operator style of `repair-legacy-card`. Keep `retired_at`, `unrescued_at`, and the review-class vocabulary unchanged. The implementation plan should stage the core state and operator action, review that mechanism, then plan the runtime readers/clients as periphery; the design remains one contract.
