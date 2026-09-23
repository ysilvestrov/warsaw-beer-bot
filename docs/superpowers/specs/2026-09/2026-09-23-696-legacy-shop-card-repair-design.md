# #696: Repair a proven legacy shop card

Date: 2026-09-23
Status: proposed for review
Origin: #696; rollout in `docs/superpowers/plans/2026-09/2026-09-23-legacy-orphan-disposition-rollout.md`

## Problem and scope

The adapter now emits a corrected card, but an older extension can keep sending
the frozen brewery/name/ABV that created an orphan. `pin-match` repairs tap
links, not a shop-card alias. A plain orphan merge may forget the exact old
card and recreate it on the next request. This design adds one operator action
for a **proved** legacy card → Untappd bid. It neither changes the Flasker
adapter nor guesses the identities of the eight #677 rows.

The operation must leave both the old card and the corrected card resolving to
the same bid, without changing unrelated ABV variants. It must retain a durable
reason and evidence even though the original `enrich_failures` and possibly
`beers` row disappear during repair.

## Decision

Add a dedicated `repair-legacy-card` operator command and a small append-only
`legacy_card_repairs` audit table. Do not extend `pin-match`: its pin is keyed to
an on-tap reference and has different ingest semantics. Do not use manual SQL:
it cannot reliably couple row-state checks, merge, alias, and audit.

The command accepts one `beer_id`, the responsible `issue_number`, the exact
old card ABV (including an explicit absent value), target Untappd bid,
evidence URL, reason, and operator identity. It is a dry run by default.
`--apply` performs a fresh preview and requires the same
explicit inputs; it cannot apply a saved, unverified candidate list. Evidence
must connect the old card to the exact bid. A shop product page publishing a
bid is direct evidence for the product-to-bid link, but the operator must
separately establish that it produced the old card. An archived capture or
other source needs an explicit documented chain of proof. A search candidate
alone is insufficient. The operator must verify that the evidence represents
the frozen card, not merely
a similarly named product, and that the supplied ABV is what the older client
actually emitted. `beers.abv` is a current catalog fact and may have been
filled after the original card; it is shown for comparison but does not alone
prove the old card's ABV. If the old card-to-product or ABV association cannot
be established, leave the row unresolved rather than making a speculative alias.

### ABV and the explicit override

The alias key always uses the **proved original card ABV**, via
`cardAbv`. If the card said 6% and Untappd says 7%, an old client still sends
6%; keying the alias at 7% would not repair that client. `--overwrite-abv` is
required when the hydrated Untappd ABV differs from a non-null card ABV **or**
from a non-null ABV already stored on the target canonical beer. With that
flag, the canonical beer's `abv` becomes the hydrated Untappd ABV; the old
card's ABV remains 6% in the alias and audit snapshot. The preview shows both
values and the intended write. The reason must explain the discrepancy; the
flag, old ABV, prior canonical ABV, new ABV, and reason are saved in the audit
row. A meaningless flag (no difference) is rejected. If Untappd cannot return
an ABV, the command cannot overwrite and refuses an ABV-conflict repair.

This manual historical operation is deliberately stricter than the ordinary
`resolveByBid` runtime path, which logs `abv-divergence` without vetoing a
shop-published bid. Here the command asserts a permanent alias for a card no
longer emitted by the corrected adapter and can rewrite an existing catalog
fact; that requires an explicit operator decision.

### Transaction and collision boundary

Network evidence and bid hydration happen before the transaction. Inside one
short transaction, re-read and require the same orphan `beer_id`, issue,
brewery/name/stored ABV, `untappd_id IS NULL`, and failure state observed in preview;
reject a row that was rearmed, re-triaged, retired, or repaired meanwhile.
Re-read the target bid and the exact `(cardText(brewery), cardText(name),
cardAbv(proved_card_abv))` alias key. An alias pointing to another bid is a conflict to
investigate, never an implicit `ON CONFLICT` takeover by this operator action.

If the bid already has a canonical row, merge the orphan into it, preserving
`match_links`, `checkins`, and `untappd_had` references, then bind the old-card
alias to it. The current `mergeIntoCanonical` already handles the first two
but cascades away `untappd_had`; the repair must move/merge those references
or refuse until they can be preserved. If the bid is absent, insert a new
canonical row from hydrated Untappd facts first, then merge the malformed
orphan into that row. Do not let `upsertBeerByBid` silently adopt a different
orphan by normalized-name heuristics. On either path, remove the orphan's
failure and insert the audit event in the same database transaction; invalidate
the catalog cache after commit. A constraint failure rolls back all database
effects. An alias already pointing to this exact bid is not a collision: if
the orphan is still present, complete its merge; if the repair audit exists
and the orphan is gone, a repeat application is a reported no-op.

### Durable audit

`legacy_card_repairs` stores a snapshot, not a foreign key to the deleted
orphan: original `beer_id`, `issue_number`, raw card brewery/name/proved card ABV,
original failure source URL, target bid and canonical local ID, operator's
evidence URL, operator, reason, `overwrite_abv`, prior and final target ABV,
and UTC application time. It is written in the same transaction as the alias.
Only this command writes it; normal automatic alias refreshes do not rewrite
historical repair evidence. The orphan ID is unique in the audit table so a
second repair cannot silently overwrite the first. Alias reassignment later
changes the live mapping but not the recorded historical decision.

The ordinary `beer_aliases` table remains the runtime mapping. It should not
carry the reason: normal lookup can later move or delete an alias, whereas the
reason must survive. `review_note` cannot serve either because its
`enrich_failures` row is deleted on success.

## Verification and refusal cases

- Preview shows the old raw card and ABV, evidence and claimed bid,
  hydrated Untappd identity/ABV, existing canonical row if any, exact alias
  key and collision state, references to move, issue, and audit fields.
- Existing-bid and newly hydrated-bid cases both preserve references, clear
  the failure, create exactly one audit event, and answer the old card through
  `/match` and `/enrich/*`. A corrected new card must also resolve; do not
  create a second inferred alias merely because it resembles the old one.
- Distinct ABV variants retain distinct alias keys. The De Cam 2018 case
  requires `--overwrite-abv`: old 6% card → published bid 3615616, target 7%.
- An `untappd_had` row on the orphan is moved without losing a pre-existing
  `(telegram_id, canonical_beer_id)` row; the latest `last_seen_at` survives.
- The Rochefort 8 (2025) case must not use generic bid 11473: the shop page
  publishes vintage bid 6134078. Wrong bid, stale row, alias collision,
  missing evidence, failed hydration, or insufficient card-to-page proof leaves
  the database unchanged.
- No production application occurs before tests, typecheck, a dry run on a
  production-data copy, and a final per-row proof review. #677 stays open and
  labelled `orphan-triage` until all eight have durable dispositions.

## Claims and their evidence

| Recorded fact | Claim it makes | Required proof before write |
|---|---|---|
| `beer_aliases` old-card key → canonical row | This exact legacy card means that bid, including its ABV variant | Historical card/product association, proof of the ABV the old client emitted, direct bid link or documented independent proof chain, and fresh alias-collision check |
| New canonical `beers` row, if needed | The bid has this Untappd identity | Successful hydration of that exact bid; never a name-search candidate alone |
| Canonical `beers.abv` overwrite | Untappd ABV is the chosen catalog value despite shop divergence | Hydrated non-null ABV, `--overwrite-abv`, preview and recorded reason |
| Deletion of `enrich_failures` / orphan | Its links and old card now resolve to the proved bid | Successful reference move, alias insert, and target link in the same transaction |
| `legacy_card_repairs` event | This operator applied this exact decision to this exact row | Fresh DB preconditions, evidence URL, operator and reason; event inserted atomically with repair |

## Existing patterns and non-goals

Reuse `mergeIntoCanonical` and exact `beer_aliases` lookup in
`src/storage/beers.ts`; `cardText`/`cardAbv` in `src/domain/card-text.ts`; the
canary/stale-row philosophy of `adjudicate` for preview/application; and the
existing `/match` and `/enrich/*` alias readers. Tests belong beside the new
operator domain code and in affected route/storage tests. `spec.md` §3.6.1
must be updated before implementation because it currently says only ordinary
merge creates a new alias.

This work does not add a general ABV correction UI, relax automatic bid
validation, change the extension, or decide the unknown-identity state (#695).
