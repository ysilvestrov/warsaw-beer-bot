# #377 (part B) — triage vocabulary: one meaning per class, one irreversible seal

Date: 2026-08-15
Status: agreed
Parent: `2026-08-14-triage-verdict-integrity-design.md` (decomposition of #377/#381/#408/#412)
Sibling: `2026-08-14-408-triage-verdict-guards-design.md` (part A, shipped `2170717`)

## Goal

Make every triage class mean exactly one thing, make the set of classes complete, and leave exactly
one class whose consequence is irreversible — the one whose claim is itself irreversible.

Enforces the second half of the parent invariant:

> No consequence may be irreversible.

Part A enforced the first half (no consequence without evidence from the row). Part B is what A
cannot reach: A gates *whether* a verdict may be applied, but says nothing about whether the class
the model picked **means** anything stable.

## Why now — the defect measured three ways

The same defect (a class written as a judgement, sealing the row permanently) has now been measured
in three separate populations:

1. **157 rows** bulk-marked `wontfix` in June 2026 as a *bookkeeping* note ("superseded by matcher
   deployment 2026-06-17"). Un-sealed 2026-08-14; a seeded 30-row replay matched **27%**
   (#412, absorbed here).
2. **28 rows** carry `retired_at` — "a shipped fix resolved this" — and are **still orphans**. Had
   the fix resolved them, `clearEnrichFailure` would have deleted the row outright. Each row's own
   existence falsifies the claim that sealed it.
3. **47 rows** currently classed `wontfix`, re-read on 2026-08-15 against the definition this
   design adopts. **29 are not beer at all** (wine, spritz, cocktails, a T-shirt, `Surprise Box
   XL (36)`, `IPA Mystery Box`, `Brewery Pack`, gift sets). Of the remaining 18, **at least 12 more
   are misrouted**:

   | row | note says | why it is not this class |
   |---|---|---|
   | 61, 30796, 30883, 30884, 30885, 30886 | "transient Untappd blocked/circuit outcome" | no evidence exists — Untappd never answered |
   | 32838 | "brewery alias gap → #319" | names a live matcher defect ⇒ `matcher_bug` |
   | 33671 | "the beer is Browar Nowomiejski — Nowomiejskie" | the note **identifies the beer** ⇒ `matcher_bug` (#334) |
   | 33237 | "shop puts the style in the name field → #340" | identifiable ⇒ `matcher_bug` (#340) |
   | 30101, 30931 | "not rescuable by clean rules" (both Guinness) | a claim about **fix difficulty**, not about the row |
   | 31145 | "one-off collab long gone; hopeless" | a pure value judgement; the row's real question was never asked |

   Roughly 6 rows are genuinely unidentifiable (`N/A`/`N/A`; `BRAURIE KEESMANN — Bambergen Herren`;
   `MULTICOLLAB: POLISH CREW`; `MGM-15` as both brewery and name; `takie zero. takie nic. — KRAN
   PUSTY. dużo°·21,37%`). **The class is ~87% filled with rows that do not belong to it.**

Two root causes, both in the prompt (`src/domain/triage-analysis.ts:212-224`):

- **A direct contradiction.** `parser_bug` is defined as covering a "merch/glassware/wine/food row"
  (line 213) while `wontfix` covers "non-beer that is not the adapter's fault" (line 223). The same
  T-shirt legally belongs to two classes at once.
- **A value judgement inside a class definition.** `wontfix` = "not worth fixing (one-off collab
  long gone …)". Worth is not a property of the row, it is reversible, and it is not evidence. Row
  31145 was sealed with the note "likely gone; hopeless" — the definition invited exactly that.

And one structural hole outside the prompt: `applyLookupOutcome` writes an `enrich_failures` row for
`outcome='blocked'` (`src/domain/lookup-outcome.ts:68-80`) — a row we could not even ask about. Six
such rows carry a permanent seal today.

## Design

### 1. The vocabulary is a decision tree

Classes are complete and mutually exclusive because each is the "no" branch of one question, asked in
order. Every row answers every question.

| # | question | "no" ⇒ class | decisive evidence | fix owner | pool consequence | reversible |
|---|---|---|---|---|---|---|
| 1 | Is the row a beer product at all? | **`not_a_beer`** *(new)* | the product itself | ingest/adapter filter | **the only hard exclusion** | no — correctly |
| 2 | Is our row faithful to the source? | **`parser_bug`** | shop page vs our fields | adapter | none | yes |
| 3 | Can we say *which* beer it is? | **`unidentifiable`** *(was `wontfix`)* | several candidates with no basis to choose; or zero candidates and an invented beer / non-existent brewery / garble | nobody today | none | yes, by construction |
| 4 | Is it on Untappd? | **`not_on_untappd`** | a probe that ran and returned empty (gate from part A) | nobody | none (already true) | yes — Untappd grows |
| 5 | all "yes", and we still missed it | **`matcher_bug`** | near-miss candidates, alias gap | matcher / aliases / query normalisation | none | yes |

Outside the tree: a row the tree **cannot be run on** — `outcome != 'not_found'`, i.e. no evidence
could be obtained — takes **no class** and stays `NULL`.

Three properties this buys:

- **`not_a_beer` removes the contradiction.** Non-beer rows have exactly one home, and it is the
  first question asked, so it can never compete with the others.
- **`unidentifiable` removes the judgement.** The question "is it worth fixing" is never asked. Both
  halves of the definition are statements about *our current resolving power*: "several candidates,
  no basis to choose" is precisely #409 (no tie-break), and "invented beer / non-existent brewery"
  is precisely #347/#327 (aliases, brand glue). A shipped fix flips these verdicts, which is why the
  class must not seal.
- **The only irreversible seal is the only irreversible claim.** Merch will not become beer.

#### Why `wontfix` is renamed, not just redefined

The token means "we will not fix this" — the judgement the new definition removes — and the model
carries a strong prior on it from GitHub. That prior has been observed firing (row 31145). The table
is rebuilt anyway (below), so the rename is nearly free at exactly the moment it is cheapest.

#### Not a second class: "the source data is wrong but the beer is identifiable"

Rows 33671 (venue in the brewery field), 33237 (style in the name field), 30931
(`Guinness Chwilowy brak:(`) are `matcher_bug` under the tree: our row is faithful to the source, the
beer is identifiable, and we failed to find it. *Who* fixes it — a source-specific normalisation
rule vs a generic matcher rule — is a second axis, and it already has an owner: the deterministic
`fix_site` field of #381 (part C). Encoding it in `review_class` would put two axes in one column.

### 2. Enforcement: declarative where it must survive raw SQL, runtime elsewhere

`setEnrichFailureReview` (`src/storage/enrich_failures.ts:95`) is the single chokepoint for two of
the three write sites — the LLM (`src/jobs/orphan-triage.ts:306`) and the admin `POST /review`
(`src/api/routes/admin.ts:17`). The third is raw bulk SQL, the source of both measured incidents; it
bypasses everything except the column `CHECK`, which validates spelling and not legality.

So the one rule that must survive a future bulk script is expressed declaratively — both columns sit
on the same row, so it is a plain table constraint:

```sql
CHECK (review_class IS NULL OR outcome = 'not_found')
```

This closes the `blocked` hole permanently at all three write sites at once, including scripts
nobody has written yet.

The remaining gates are runtime, in the chokepoint, in part A's style — pure functions, no LLM,
refusal rather than write:

- `not_on_untappd` requires a probe that ran and returned empty. This gate exists today in
  `planTriageActions`; it **moves down into the chokepoint**, so the admin route — which currently
  accepts any of the four classes with no gate at all — is covered by the same rule as the LLM.
- A class may never be written to a row whose `outcome != 'not_found'` (belt to the CHECK's braces,
  so the failure is a clear refusal rather than a constraint violation).

Bulk SQL remains a hole for everything except the `CHECK`. Accepted deliberately: closing it means
forbidding raw access, which is not in this scope. Its worst outcome — a seal on a row with no
evidence — is now impossible at the schema level.

### 3. `not_a_beer` is actionable

`planTriageActions` (`src/domain/triage-plan.ts:78-80`) splits verdicts into actionable (→ GitHub)
and quiet (→ column). `not_a_beer` goes **actionable**, on the same criterion the split already
uses: it has a fix owner. A T-shirt reaching `beers` is a defect in the ingest filter, so every such
row is simultaneously a bug report. It is also the only irreversible class in the new vocabulary, and
an irreversible verdict that leaves a visible, scoped issue trail is safer than one written silently
into a column.

Two consequences:

- **Exempt from the falsifiable-cause gate.** The #358 verification gate re-runs `proposed_query` and
  checks `expected_target`. A `not_a_beer` row has no beer to find, so it must not be required to
  name a query; requiring one would force the model to invent a falsehood. Its evidence is the
  product, not a query.
- **Not exempt from part A's scope guard.** The issue it attaches to still needs a legal scope and
  the row must satisfy it — and these scopes are unusually crisp (`name contains Pack`,
  `source_url contains beerrepublic`), so the guard has real teeth here.

It competes for the same 3 `new_issues` slots per run. Accepted; revisit the slot count if merch
starts crowding out matcher patterns.

### 4. Reachability is the removal of a block, not a new mechanism

The auto-unseal already exists: `recordEnrichFailure` clears `review_class`/`review_note`/
`reviewed_at` when `candidates_count` crosses the 0↔>0 boundary
(`src/storage/enrich_failures.ts:37-45`). For a sealed row it can never fire — the seal removes the
row from both pools, so no lookup runs, so no new failure is recorded, so the boundary is never
crossed. **The mechanism exists and its only entrance is locked by the thing it would undo.**

The change is therefore one clause, in the two places that share it (`src/storage/beers.ts:272` and
the `orphanWithoutMatchLinkPredicate` at `:314`):

```diff
-  (ef.review_class = 'wontfix'    OR ef.retired_at IS NOT NULL)
+  (ef.review_class = 'not_a_beer' OR ef.retired_at IS NOT NULL)
```

plus `isWontfix` → `isNotABeer` (`enrich_failures.ts:58`, called from
`src/api/routes/enrich.ts:172`). `unidentifiable` rows re-enter the normal pools, take the free
Algolia retry under normal backoff, and the existing 0↔>0 clause lifts the seal by itself when the
world changes. No new job, no cadence rule, and — importantly — no dependency on a "last matcher
deploy" anchor, which does not exist in this system (no build stamp, no `last_deploy_at`,
`package.json` frozen at 1.0.0, `deploy.sh` writes nothing to `job_state`).

**Cost, measured.** 47 rows return to the pools. `enrich-orphans` spends a single shared budget with
on-tap drained first and relay filling only the remainder (`src/jobs/enrich-orphans.ts:87-94`), and
relay idles ~89% of capacity (#368). 47 rows are noise against that, and the ceiling on Untappd load
is unchanged by construction.

**Sealed-population shape (2026-08-15)**, which is why this is worth doing at all: of 75 sealed rows
(47 `wontfix` + 28 `retired`), **51 sit in the relay pool and 6 on tap** — 57 get a lookup on the
next cron once unsealed. The other 18 are off-tap fossils no pool reaches; unsealing them is a no-op,
by design (they cost nothing and will drain if they ever return to a shop or a tap).

### 5. Audit signal

Counting seals *lifted* is impossible after the fact: the auto-unseal nulls `review_class` **and**
`reviewed_at`, erasing the only evidence the row was ever sealed, and the write is SQL inside an
`ON CONFLICT` clause with nowhere to hook. So the signal measures two things that each falsify a
different premise of this design:

1. **`unidentifiable` rows re-observed since their verdict** — `beers.untappd_lookup_at >
   enrich_failures.reviewed_at`. Both columns already exist. **Zero means the mechanism is dead**:
   the rows are formally back in a pool but the cron never reaches them.
2. **Total `unidentifiable` population** — must *fall*, since a row whose seal lifts leaves the
   population. **High (1) with a flat (2) means the mechanism runs and buys nothing.**

Plus two debt counters that depend on nothing:

3. **`not_a_beer` added in the last 7 days** — the ingest filter's debt; the class is actionable, so
   there is an issue to look at.
4. **Falsified retirements** — `retired_at IS NOT NULL` and the beer is still an orphan. 28 today.
   Growth means `retired_at` is being written as blindly as `wontfix` was; that is a separate issue,
   not this one.

Home: one line in the daily digest (`src/jobs/daily-status.ts`, beside `Каталог` and `Enrich`) —
a number nobody reads is not a signal.

Illustrative. The design deliberately starts from `unidentifiable = 0` — the backfill sends all 18
survivors back through triage rather than translating their old classes — so the first non-zero
value in that slot is the new vocabulary's own output, not inherited state:

```
• Печатки: 0 unidentifiable (0 переспостережено) · 29 not_a_beer (+0/7д) · 28 спростованих retire
```

### 6. Migration v24 and backfill

SQLite cannot alter a `CHECK` in place, so migration 12's constraint
(`src/storage/schema.ts:205-206`) forces a table rebuild. Everything below therefore happens in one
migration, in this order — the ordering is not cosmetic:

1. Create the new `enrich_failures` with
   `CHECK (review_class IN ('parser_bug','matcher_bug','not_on_untappd','unidentifiable','not_a_beer'))`
   and `CHECK (review_class IS NULL OR outcome = 'not_found')`.
2. Copy rows, rewriting `review_class` **during the copy** (see the backfill rule below).
3. Drop old, rename new, recreate indexes.

#### The backfill rule: re-derive, do not translate

The tempting move is a class-to-class mapping — read each old note, decide which new class it meant.
That is wrong here, and noticing why is the point: those notes record verdicts reached under
definitions this document has just declared broken. Carrying them forward is precisely the
unverified bulk write that produced all three measured incidents. Three rows show how quickly it
degrades: 30101 (`Gui Brewery — Guinnes`) and 30931 (`Guinness Chwilowy brak:(`) were sealed as "not
rescuable by clean rules" — a statement about **fix difficulty**, which the new tree never asks
about; both beers are plainly identifiable, so the tree routes them to `matcher_bug`. Row 31145 was
sealed as "one-off collab long gone; hopeless" — a pure value judgement, and the row's actual
question (is `Funky Fluid — Gelato XTREME: It Floats!` on Untappd?) has no recorded answer at all.

So the backfill has exactly two branches:

- **`not_a_beer` (29 rows)** — the only reclassification that needs no judgement, because the
  evidence is the product name itself. Wine/spritz/cocktail: 19, 20, 21, 91, 116, 117, 191, 12044,
  12309, 25663, 30053. Merch: 25708. Bundle / mystery box / multipack / gift set: 25709, 25710,
  25725, 25933, 25961, 26006, 26044, 26097, 26098, 26099, 26100, 29486, 29487, 29488, 29489, 32178.
  Kombucha: 33659.
- **`NULL` (the other 18)** — re-triaged under the new vocabulary, including the 6 `outcome='blocked'`
  rows (61, 30796, 30883, 30884, 30885, 30886), which the new `CHECK` requires to be `NULL` anyway
  and which the untriaged selection at `enrich_failures.ts:182` correctly refuses to pick up.

This also gives the new vocabulary its first live exercise on a population we have already read by
hand, so a mis-specified prompt shows up immediately rather than a month later.

**Consequence for the #408 checkpoint (#419, due 2026-08-22): this raises the untriaged backlog from
the recorded baseline of 97 to ~109.** The checkpoint's headline failure mode is "backlog climbing
while verdicts fall", so an unexplained +12 would read as a guard deadlock. Recorded here and to be
noted on #419 before that check runs.

`REVIEW_CLASSES` (`src/domain/review-class.ts:7`) is the single source for the zod schema, the tool
schema, and `triage-scope.ts`, so the class-set change lands in one place. `admin.ts:9` duplicates
the literal list and must be switched to the shared constant rather than edited in parallel.

## Out of scope

- **Periodic re-arm sweep** — #421. Backoff exhaustion (`count >= 4`, `lookup-backoff.ts`) is a
  second, class-independent lock: after four failures a row is dormant forever regardless of class.
  It barely bites today (**10 dormant rows corpus-wide**, because the 157-row re-arm zeroed the
  counters), but over time it will consume exactly what this design reopens. Stated explicitly so
  "part B made rows reachable" is not quietly falsified in six months.
- **`retired_at` semantics** — counted (signal 4), not changed.
- **Metered web fallback for `unidentifiable`** — stays blocked in `isWebFallbackBlocked`
  (`enrich_failures.ts:74`); revisit after #349's ambiguity guard lands. Recorded as a comment on
  #349 with both arguments.
- **Deleting `not_a_beer` rows from `beers`** — they are pollution, but deletion is destructive and
  the seal already removes their cost.

## Testing

- **Decision-tree completeness** as a table-driven test: one representative row per class from the
  measured population, asserting the class each lands in.
- **The `CHECK` is the test for the `blocked` hole**: attempt a direct SQL write of a class onto an
  `outcome='blocked'` row and assert it is rejected — the guard must hold against SQL, not just
  against the chokepoint.
- **Migration test** must rewind every migration from v24 up, not just its own row — the v22 test's
  latent trap (part A, defect 4).
- **Mutation-test the pool change**: revert the one-clause diff and assert the named reachability
  test goes red. The whole of section 4 is that clause.
- **Falsifiability rule** (superpowers 6.3.0): every test names the production change that turns it
  red.

## Validation before merge

Replay the 18 non-`not_a_beer` sealed rows live through `lookupBeer` (project policy: replay before
implementing). This predicts what reachability actually buys and is the honest baseline for audit
signal (2). The 27% hit rate from the 157-row replay is the prior.
