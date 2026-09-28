# #665 — replay and copied-database recovery

Date: 2026-09-28. Code under review: ca6552e0c1fa041a813ef566b7f13ac2645a0370.
Status: Konrad recovery verified on a copy; shipping blocked by an unapproved non-Czech selection change. No production writes, push, PR, deployment or issue close.

## Same-snapshot replay

A consistent better-sqlite3 backup was taken from the production database opened readonly/fileMustExist. Both matchers received the same 34,916 catalog rows and all 1,699 latest taps, in snapshot/id order. All tap identities were kept. The baseline matcher and its imports came from a git archive of 4964f00; the new matcher came from the clean ca6552e worktree. The initial run captured an earlier HEAD with P3 uncommitted; the replay was repeated after P3 was committed, at the head above, with identical results.

Ingest replay supplied raw tap style/ABV/name/brewery to both sides without a fallback budget, as refreshOntap does. A separate illustrative bounded /match replay supplied only fields in the current wire request, with identical per-snapshot default budgets. It is a matcher comparison, not an HTTP or remembered-alias replay. No budget counters changed in the bounded comparison.

Exactly two results changed in each comparison:

| Tap | Input | Before | After | Judgment |
|---|---|---|---|---|
| 427772 / snapshot30505 | KONRAD Brewery, KONRAD 10°, 4%, Svetlý Ležák | 37334 / exact / 1 | 45 / fuzzy / 1 | Confirmed correction: distinct twelve rejected; catalog ten agrees with search bid227734 |
| 427305 / snapshot30475 | Litovel Brewery, Litovel 12°, 4.7%, Pszeniczne | 256 / fuzzy / 1 | 35306 / fuzzy / 1 | Blocker: supplied wheat style does not establish that pale-lager35306 is this beer |

Both links were automatic (reviewed_by_user=0) and had no merged_at. The bounded replay omits style; its Litovel result cannot be judged against supplied wheat metadata because that metadata is absent from that request. Its selection change remains recorded, not counted as a proven rescue.

## Litovel mechanism and design decision

Catalog row30255 is Gustav 13°, Czech Amber Lager. It passes the fuzzy score threshold for the short brand query. Rejecting its explicit grade sets gradeVetoed, so the approved post-veto evidence rule drops grade-less Dark256 and selects Bohatá12 row35306, Czech Pale Lager. Existing isAleStyle recognizes Wheat but not the observed Polish token Pszeniczne. On the actual catalog the new matcher gives35306 with Pszeniczne and256 with Wheat or Wheat Beer - Hefeweizen. Null style also gives35306.

The latest-tap snapshot has several Polish wheat labels, including Pszeniczne24 times, PSZENICZNE4 times and other compound labels. The query and probe are retained below. This finding is not a request to add every translation or redesign style matching.

Recommended amendment, pending user approval: add the observed normalized token pszeniczne to the existing ale marker list. Verify raw-name/style markers on both sides, contextual grade identity, matcher preservation for the observed Litovel input, and search-grade fallback exclusion. This changes a shared rule; it must be approved and documented before implementation. It preserves the pre-existing Litovel match rather than claiming Dark256 is the correct wheat beer. The baseline wheat-versus-dark mismatch is separate evidence, not resolved by this proposal. Requests without style remain an explicit evidence limitation.

No code for this amendment has been written.

## Live search evidence

Algolia searches ran with Guinness Draught canaries before and after; both returned bid4473. Konrad12 returned bid158057, Konrad12°, Pivovar Vratislavice nad Nisou, Pilsner - Czech / Bohemian, 5.2%. Konrad10 returned bid227734, currently named Konrad světlé výčepní, same brewery, Lager - Světlé (Czech Pale), 4%. The current live ten name omits a grade; the stored historical name supplies the soft10 used by the matcher. Neither the missing live grade nor ABV alone is treated as contradictory-grade evidence.

## Recovery rehearsal — second database copy only

The readonly replay snapshot was backed up to a second writable copy. Every incoming link was asserted by id, raw key, target, confidence, human-pin flag and merge marker before changing it. There were no incoming check-ins or beer aliases. Targets were asserted as45/bid227734 and31849/bid158057.

| Link / exact raw brewery and name | Before | Operation on copy | Read back |
|---|---|---|---|
| 692 / KONRAD Brewery / KONRAD 10° | 37334, confidence1, unpinned, no marker | upsertMatch to45 BEFORE merge | 45, confidence1, unpinned, no marker |
| 693 / KONRAD Brewery / KONRAD 12° | 37334, confidence1, unpinned, no marker | merge37334 into31849 | 31849, confidence1, unpinned, rehearsal merge marker |
| 5164 / KONRAD Brewery / Konrad 12° | 37334, confidence1, unpinned, no marker | same merge | 31849, confidence1, unpinned, rehearsal merge marker |

Both operations ran inside an outer copy-database transaction. Afterward37334 was absent; the single created alias was KONRAD Brewery / Konrad12° ->31849. There was no ten alias created. On the copied post-recovery catalog, KONRAD10° matched45/fuzzy/1 and KONRAD12° matched31849/exact/1.

The first rehearsal assertion incorrectly expected uppercase KONRAD in the alias name; the source row actually says Konrad. The expected source text was corrected and the entire rehearsal was rerun from the unchanged snapshot. Final assertions passed.

Production recovery must freshly verify these exact preconditions, preserve any new pins/check-ins or unresolved incoming rows, separate each confirmed automatic ten before merging twelve, and read back every affected row. This receipt does not authorize production writes.

A fresh readonly production query after the rehearsal found no enrich_failures owned by issue665. Row37334 remains matcher_bug with issue_number NULL. No issue linkage or review_class was changed. Adjudication must be reassessed before closing the issue if ownership changes.

## Claims and evidence

| Recorded claim | Evidence | Limitation |
|---|---|---|
| Changed Konrad result identifies the ten | raw10°, contextual grade veto, stored ten name, canonical bid227734 live search | live name currently omits grade |
| Twelve canonical identity | live bid158057, raw12°, brewery alias evidence | duplicates still exist in production |
| Copy ten link is independent of twelve merge | exact before/after assertion on692 | production needs a fresh inventory |
| Copy twelve links remember the merge | exact before/after assertions on693/5164 | rehearsal timestamps are copy-only |
| Non-Czech behavior preserved | NOT ESTABLISHED: Litovel counterexample | blocks shipping |
| Current code passes full gate | P3 run:3728 passed/1 skipped; both typechecks passed | tests did not previously cover this Polish marker |

## Review status and retained artifacts

The main-thread whole-branch inspection covered U1/U2/S1/P1/P2/P3: identity/context roles, complete candidate filtering, SQL/cache delivery, authoritative API routes, retry raw text, production loaders, cleanup and dedupe writes. Existing pins/bids/aliases retain their authoritative paths. The replay finding above is unresolved; this is not a passing whole-branch review receipt. A fresh independent review of this head has not run. The earlier one-time Claude authorization and receipt cover the old core only.

Temporary local artifacts: /tmp/issue-665-{snapshot.ts,replay.db,full-replay.ts,replay-results.json,replay.log,marker-probe.ts,live-confirm.ts,live-confirm.log,recovery.ts,recovery.db,recovery.log}; /tmp/issue-665-p3-gate.log. They contain copied operational data and are not committed. The durable observations are recorded in this document.
