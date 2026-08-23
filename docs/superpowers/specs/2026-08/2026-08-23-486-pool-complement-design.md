# #486 — the two enrich pools become one predicate and its negation

Date: 2026-08-23
Status: agreed
Issue: #486
Related: `2026-07-29-ontap-identity-v2-design.md` (`ontap_ref` is the raw tap string),
`2026-08-22-430-non-beer-boundary-design.md` (the same shape: one definition, N enforcers),
`2026-08-15-377-triage-vocabulary-design.md` (`not_a_beer` is the only pool exclusion)
Measured from: the prod database, 2026-08-23

## The model

> The two pools were written as two independent conditions that do not partition the orphans. The
> gap between them was found, measured, and declared deliberate. That decision is what this design
> reverses, on evidence the decision did not have.

`listLookupCandidates` takes orphans whose `match_links` row joins a tap on some pub's **latest**
snapshot. `listRelayLookupCandidates` takes orphans with **no `match_links` row at all**. These are
not complements: a beer with a link that no longer reaches a latest-snapshot tap satisfies neither,
and no cron will ever look at it again.

The fix is to stop writing the second condition. There is one predicate — *is this beer on a tap
right now* — used positively by the on-tap pool and negated by the relay pool. Partition becomes a
property of the construction rather than a coincidence between two hand-written queries.

## What the spec says today, and why it is wrong

`spec.md` (the "Два пули кандидатів, один бюджет (#368)" section) already documents this exact gap:

> «…вони не покривають усіх orphan'ів: orphan із рядком у `match_links`, чий кран зійшов з
> останнього снапшоту, не потрапляє в жоден пул (387 рядків станом на 2026-08-08) і лишається
> cron-недосяжним, поки не повернеться на кран. Це **навмисне виключення** — on-tap gate свідомо
> ігнорує пиво, яке зараз ніхто не наливає, — **а не дефект**.»

So this is not an oversight being corrected; it is a decision being reversed. Three measurements
the decision did not have:

1. **The rationale belongs to the on-tap pool, not to the relay pool.** "The on-tap gate ignores
   beer nobody is pouring" is a correct description of `listLookupCandidates`. But the relay pool
   (#368) exists precisely to spend idle capacity on orphans that are *not* on tap. A beer dropped
   by the on-tap gate is exactly what relay was built to catch; the gap is relay failing at its own
   job, not the on-tap gate succeeding at its.
2. **"Until it returns to a tap" is doing work the data does not support.** 376 of the 462 have
   **never been queried once**. The exclusion did not stop us spending on these rows — we never
   spent anything on them, so there was never a saving to book.
3. **The population is not what the rationale assumes.** It is dominated by rotating standards
   (`Weihenstephaner — Dunkelweizen`, `Pivovar Lobkowicz — Rychtář Premium 12°`,
   `W Brzesku — Žatecký Světlý Ležák`), and 824 of the 2,682 beers ever linked to a tap (31%) carry
   both a live and a dead link — they demonstrably come back. A beer resolved once stays resolved
   across every return; a beer left unqueried is re-paid for on each one.

The old text is also candid that `orphansOffCron` "міряє саме чергу relay-дренажу, а не сумарну
cron-недосяжність" — the blind spot was known and accepted. What changed is the size and the
composition, both measured below. `spec.md` must be rewritten in the same PR: the paragraph that
calls this deliberate becomes the paragraph that defines the partition.

## Measured 2026-08-23 (production)

### 1. The gap holds 462 of 911 orphans, and 376 have never been queried once

| pool | orphans |
|---|---|
| on-tap | 106 |
| relay | 343 |
| **no pool at all** | **462** |

Of the 462, **376 have `untappd_lookup_count = 0`** — they have never been looked up. In the on-tap
pool, 102 of 106 have. This is not a backlog of hard cases; it is a population nobody ever asked
Untappd about.

### 2. The cause is retention, not a bad migration

`refresh-ontap` is the only writer of `match_links`, and it always writes the `beer_ref` of a tap it
has just parsed — so every link was a real tap once. `SNAPSHOT_RETENTION_DAYS` defaults to **14**
(unset in prod) and `cleanup-old-snapshots` cascades snapshot deletion into `taps`, while
`match_links` rows live forever. A link therefore dies ~14 days after its beer stops being poured.

- 405 of the 462 have no ref that joins any tap; the other 57 still join a tap that is simply not on
  a latest snapshot. **The 57 are the same defect one stage earlier** — which is why "no *live* link"
  is not a sufficient fix, and why the relay predicate must be the exact complement.
- A minority carry the pre-#18 composite ref shape (`h4Text — subtitle`), dropped by `fdd1230`
  (2026-04-26). **0 of 46,611 tap rows have ever carried that shape.** It explains 40 beers
  exclusively, 142 including mixed cases — a side story, not the cause, and unrelated to #306.

### 3. The complement costs what the on-tap query already costs

| query | time | rows |
|---|---|---|
| current relay predicate | 0.23 s | 285 |
| **proposed complement** | **1.41 s** | **713** |
| the existing on-tap query, run on every cron tick today | 1.59 s | 101 |

The plan drives from the latest-snapshot co-routine and reaches `match_links` through its UNIQUE
index; `taps` is never scanned. Four cron ticks a day pay ~1.2 s more in total. The cost objection
does not survive measurement.

### 4. No re-arm is needed

Of the 428 rows that become reachable (462 minus `not_a_beer`/`retired`):

| `untappd_lookup_count` | rows | consequence |
|---|---|---|
| 0 | 354 | eligible immediately |
| 1–3 | 73 | eligible on schedule (`BACKOFF_HOURS = [0, 72, 168, 728]`) |
| ≥ 4 | 1 | terminal under `isEligible`; not worth a migration |

29 of the 428 are held by the `matcher_bug`/`parser_bug` lock on an open issue and stay out until
that issue closes — correct behaviour, unchanged by this design.

## Design

### The predicate

`src/storage/beers.ts` exports one fragment, `onLatestTapPredicate`, with the `beers` alias `b`
baked in exactly as `orphanWithoutMatchLinkPredicate` does today:

```
EXISTS (SELECT 1 FROM match_links ml
        JOIN taps t ON t.beer_ref = ml.ontap_ref
        JOIN tap_snapshots ts ON ts.id = t.snapshot_id
        JOIN (SELECT pub_id, MAX(snapshot_at) AS m FROM tap_snapshots GROUP BY pub_id) latest
          ON latest.pub_id = ts.pub_id AND latest.m = ts.snapshot_at
        WHERE ml.untappd_beer_id = b.id)
```

`listLookupCandidates` interpolates it. `listRelayLookupCandidates` interpolates `NOT` + it.
`orphanWithoutMatchLinkPredicate` is deleted; nothing else may reintroduce a second spelling of
"reachable".

Both pools keep their existing `not_a_beer`/`retired` exclusion, their `lockedRowPredicate`
exclusion, their `ORDER BY untappd_lookup_count ASC, b.id ASC`, and their JS-side `isEligible`
filter. None of that changes.

**The invariant this buys:** every orphan that is not `not_a_beer`, not retired and not locked
appears in exactly one pool. Disjoint because the predicate and its negation cannot both hold;
exhaustive because they cannot both fail.

### The metric

`StatusMetrics.orphansOffCron` is renamed `orphansRelayQueue` and computed with the negated shared
predicate, so it still cannot drift from the pool it describes. The digest line changes from
`N поза cron` to `N у relay-черзі`.

The rename is not cosmetic. The current label claims to count unreachable orphans and in fact counts
the relay drain queue; the genuinely unreachable population — the subject of this issue — has never
appeared in the digest at all. After this change the first digest reports **713 where it reported
285**. That jump is the label being corrected, and the PR must say so, or it reads as an incident.

A permanent "truly off-cron" counter was considered and rejected: after this change it is 0 by
construction, and a line that always reads 0 stops being read. It is measured once, by the
checkpoint below, which is where a claim about a design's premise belongs.

### Testing

The regression test is the defect reduced to one row: a beer whose only `match_links` row points at
a tap that exists on an older snapshot but not the latest one. Today it appears in neither pool;
after the change it appears in exactly one. That test must be red before the fix.

Alongside it:

- a beer on a latest-snapshot tap appears in the on-tap pool and not in relay;
- a beer with no link at all appears in relay (the case that already worked, protected);
- an exhaustiveness property over a seeded catalogue: every orphan that is not
  `not_a_beer`/retired/locked appears in exactly one of the two lists — the invariant stated
  as an assertion rather than as a comment. The property is about **membership**, so the seed must
  keep the two later filters out of the way: every seeded row eligible under `isEligible`
  (`untappd_lookup_count = 0`), and a `limit` above the seed size, or the test would measure
  slicing instead of partitioning;
- `stats.test.ts` updated for the renamed metric, asserting it equals the relay list's length on the
  same seed, which is what "cannot drift" means operationally.

Every one of these is mutation-proven: removing the `NOT`, or restoring
`orphanWithoutMatchLinkPredicate`, must turn them red. A seed that writes through a guarded API can
silently no-op, so each test asserts its fixture landed before asserting behaviour.

### Out of scope

- **Dead-link cleanup.** 571 links across 405 beers are safely deletable (dead, `merged_at IS NULL`,
  `reviewed_by_user = 0`, orphan, no live link), but that is garbage collection. Reachability must
  not depend on a cleaning job having run.
- **Unlocking the nine proven-fixed rows** that this change makes reachable — that belongs to the
  checkpoint, and each needs its live match verified first (1 of 14 in the 2026-08-23 sweep matched
  the wrong beer, #487).
- **`SNAPSHOT_RETENTION_DAYS`.** It is unset in prod and running on the 14-day default. That is a
  separate decision; this design deliberately makes reachability independent of it.

### Documentation

`spec.md` is not optional here and not a footnote: it currently asserts the opposite of what this
change makes true. The "Два пули кандидатів, один бюджет (#368)" section must lose the "навмисне
виключення … а не дефект" claim and the `orphanWithoutMatchLinkPredicate` name, and gain the
partition statement: one predicate, used positively and negated, so that every orphan outside the
`not_a_beer`/retired/locked exclusions is in exactly one pool.

## Checkpoint

A separate issue, filed with the PR, due 1–2 weeks after deploy:

1. **The invariant.** Count orphans in neither pool. **It must be 0.** Named in advance: a non-zero
   result means the complement is not a complement — investigate the query, do not adjust the number.
2. **The drain.** How many of the 428 were queried, and how many matched. A yield near zero would
   mean the population is genuinely unmatchable and the queue should be capped rather than drained.
3. **No displacement.** On-tap selections per run must not fall — the on-tap pool is chosen first by
   construction, and this is the assertion that construction holds under a fuller relay queue.
