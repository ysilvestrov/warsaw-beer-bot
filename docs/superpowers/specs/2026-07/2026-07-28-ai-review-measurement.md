# AI review — replay measurement (#175)

**Date:** 2026-07-28
**Tool:** `npm run ai-review-replay -- <pr>` (no posting)
**Baseline:** `2026-07-28-ai-review-baseline-labels.md` — 1 real / 13 false / 4 unfalsifiable of 18 (6% precision)

## Configurations

| config | find model | verify model |
|---|---|---|
| A | gpt-5.4-mini | gpt-5.5 |
| B | gpt-5.5 | gpt-5.5 |

## Method

Each PR was replayed against its own head commit (`gh pr view --json headRefOid`), so the pipeline
saw the same tree a live review would have. Every **published** finding was then checked against
that tree with `git show <head>:<path>` before being labelled — no finding was labelled from its
claim text alone.

Labels are the baseline's: `real` = a genuine defect in that diff (acting on it prevents a bug);
`false` = contradicted by the code; `unfalsifiable` = speculation about code not shown, a generic
ask with no concrete failure path, **or a design preference restated as a defect**. The last case
follows the baseline's own precedent (#358-3, "probe evidence is best-effort by design"), and it is
where most of the judgement in this pass went: the new pipeline's findings are overwhelmingly
accurate *about the code* and the real question is whether acting on them would improve it.

Note on head commits: #344's replay head is `ef2ebd2`, which already contains the checkins-redirect
fix. The one `real` finding in the baseline is therefore not reachable in this replay — neither
config can be credited or blamed for it.

## Precision set (PRs #344, #348, #352, #356, #358)

### Per-PR funnel

| config | PR | raised | gated | verified | published labels |
|---|---|---|---|---|---|
| A | 344 | 5 | 5 | 3 | 2 real, 1 false |
| A | 348 | 3 | 2 | 1 | 1 false |
| A | 352 | 4 | 4 | 2 | 1 false, 1 unfalsifiable |
| A | 356 | 3 | 3 | 1 | 1 unfalsifiable |
| A | 358 | 4 | 3 | 3 | 2 false, 1 unfalsifiable |
| A | **total** | **19** | **17** | **10** | 2 real, 5 false, 3 unfalsifiable |
| B | 344 | 10 | 9 | 9 | 4 real, 5 unfalsifiable |
| B | 348 | 4 | 4 | 4 | 2 real, 2 unfalsifiable |
| B | 352 | 2 | 2 | 2 | 1 real, 1 unfalsifiable |
| B | 356 | 3 | 2 | 2 | 1 real, 1 unfalsifiable |
| B | 358 | 7 | 5 | 5 | 3 real, 2 unfalsifiable |
| B | **total** | **26** | **22** | **22** | 11 real, 0 false, 11 unfalsifiable |

Gate drops, all 10 runs: `quote_not_found` ×4, `outside_changed_lines` ×1, `duplicate` ×1 (6 of 45
raised, 13%). Verify drops: config A rejected 7 of 17 gated (6 `refuted`, 1 `out_of_scope`); config
B rejected **0 of 22**.

**Run failure:** config B / PR #348 failed on its first attempt with `OpenAI returned an empty
completion` (the find call returned no tool call; 150 s wall). A straight re-run of the same PR and
config succeeded. No 401s; the trial key held for all runs. The B/#358 first attempt was killed by
my own 10-minute shell timeout, not by the tool, and was likewise re-run. Both re-runs are the ones
tabulated; the failure is counted here rather than dropped.

### Published findings, labelled

| config | PR | finding (short) | label | evidence |
|---|---|---|---|---|
| A | 344 | `parseBid` accepts any string ending in digits | real | `/(\d+)\/?$/` is unanchored, so pasting a *checkin* URL (`…/checkin/1234567890`) yields a bid and `main` pins it; the resulting `untappd_id` write is not undone by `--unpin` |
| A | 344 | `--beer` is not validated before `parseInt` | real | `pinMatch(db, parseInt(beer, 10), …)` with no check — `--beer 123abc` silently pins beer 123 |
| A | 344 | `pinMatch` returns a "silent" noop for a missing beer id | false | not silent: `{ kind: 'noop', reason: … }` is an exported member of `PinResult` and the CLI prints it as JSON; the typed noop is the design |
| A | 348 | Brave resolver "never aborts" the request timeout | false | `signal: AbortSignal.timeout(8000)` is present, with an inline comment explaining the serialization gate is exactly why it is there |
| A | 352 | `finally` stamps `web_tried_at` even when the resolver throws | unfalsifiable | accurate but attacks documented deliberate behaviour ("A spent call marks the beer regardless of outcome"); the quota unit is consumed *before* the call, so not stamping would let a spent beer re-spend. The line is also pre-existing — the diff only edits its comment |
| A | 352 | `isWebFallbackBlocked` "no longer" treats `outcome = 'blocked'` as blocked | false | fabricated regression: before this PR `runWebFallback` had no block check at all, so the guard is strictly additive. `blocked` is a transient ban-page marker, not a per-beer state |
| A | 356 | dropping one-character name tokens changes the emitted query | unfalsifiable | true and the point of the PR; no example and no wrong-result path. Same class as baseline #356-2 |
| A | 358 | actionable verdicts with no target are treated as quiet | false | lines 85-89 document exactly this ("either the model deliberately declined … or the job stripped an unverified one"); "even when the model intended to file one" is impossible — with neither field there is no target to file to |
| A | 358 | tool schema requires the verification fields for every verdict | false | harm refuted by `type: ['string', 'null']` plus the comment "strict mode requires … every property required (hence nullable fields)": a non-causal verdict passes `null` |
| A | 358 | `expectedKey` splits on the first dash only | unfalsifiable | accurate, but the comment states the tradeoff ("beer names legitimately contain dashes") and the failure mode is fail-safe (`unverified`, cause withheld). Splitting on the last dash would break the commoner case |
| B | 344 | `pinMatch` never checks whether the source row is already matched | real | `beer.untappd_id` is SELECTed at line 16 and never read again; pinning an already-matched beer takes the merge branch and `DELETE FROM beers WHERE id = ?` destroys a real, identified row |
| B | 344 | merge branch deletes the source even when `redirected = 0` | unfalsifiable | accurate; but merge-deleting a link-less duplicate is the documented intent and `redirected: 0` is printed back to the operator. **Torn** — it does mean a "durable pin" operation can leave no pin |
| B | 344 | `parseBid` accepts any string ending in digits | real | same as A |
| B | 344 | `--beer` unchecked `parseInt` in the pin path | real | same as A |
| B | 344 | `--beer` unchecked `parseInt` in the unpin path | real | `unpinByBeer(db, parseInt(beer, 10))`; `--beer 12abc` unpins beer 12 |
| B | 344 | `loadOperatorEnv()` runs as a top-level import side effect | unfalsifiable | accurate, but `loadOperatorEnv` is idempotent (`if (loaded) return`) and `config({ quiet: true })` on a missing file is a no-op; no failure path, and the test suite imports it today without incident |
| B | 344 | DB is opened before argument validation | unfalsifiable | accurate ordering observation; `DATABASE_PATH` comes from env and every script in the repo does this. No wrong result named |
| B | 344 | `unpinByBeer` clears every pin pointing at a beer | unfalsifiable | accurate and a genuine footgun after a merge, but `unpinByRef` exists precisely for the narrow case and the docstring says which to use |
| B | 344 | the ingest guard only honours a pin on an exact `beer_ref` | unfalsifiable | accurate: `getMatch(db, t.beer_ref)` keys on the raw scraped ref. But `match_links` is keyed on `ontap_ref` for pinned and unpinned rows alike — a structural property, not a defect of this diff |
| B | 348 | `hydrateAbv` falls back to `hits[0]` when the bid is absent | real | `return (byId ?? hits[0])?.abv ?? null` — an unrelated beer's ABV can satisfy `abvCorroborates`, which is the *only* thing making the cross-language token-overlap branch safe. The comment covers a miss (`null`), not a wrong value |
| B | 348 | the UTC day key does not bound a rolling 31-day window | unfalsifiable | arithmetic is right and it refutes the comment's own claim (a 31-day span touches 32 keys), but 32 × 30 = 960 < Brave's 1000/month, so no failure path exists |
| B | 348 | a non-200 (revoked key) is indistinguishable from a real miss | unfalsifiable | the code comment already concedes this and the exact historical incident; the disagreement is over the remedy (log vs. don't stamp the 30-day cooldown). **Torn** — the residual harm is real and unmitigated |
| B | 348 | `bidFromLink` rejects a canonical URL with a trailing slash | real | `(\d+)(?:[?#]|$)` cannot match `…/b/slug/12345/`, so a valid, already-paid-for result is silently dropped; the exclusion of `/photos` sub-pages is achievable without the over-strictness |
| B | 352 | sticky `review_class` can suppress the paid path permanently | real | `isWebFallbackBlocked` blocks on `parser_bug`; `recordEnrichFailure` only resets the class across the 0↔>0 candidate boundary, and `scripts/rearm-*.ts` only re-arms `matcher_bug` — nothing clears a stale `parser_bug` after the parser is fixed |
| B | 352 | the `merged` response returns the relayed rating, not the stored one | unfalsifiable | accurate, but the pre-existing `matched` branch does the identical thing on the same line, and both describe the same bid — stale cache vs. live value, not a data error |
| B | 356 | one-character name tokens carry variants: `Plan B` → `Plan` | real | concrete, and the pool it widens is one the name stage cannot re-narrow (`nameTokens` also keeps length ≥ 2), so `Plan A` and `Plan B` become indistinguishable to the gate — the multi-variant over-pick class already filed as #334 |
| B | 356 | one-character brewery tokens: `X Brewery` → query is name-only | unfalsifiable | mechanically right (`foldToken('X')` length 1, `BREWERY_NOISE.has('brewery')`), but the example is constructed rather than drawn from the corpus and the downstream brewery-strict gate still filters the widened pool |
| B | 358 | `TRIAGE_PROBE_LIMIT=0` does not disable verification — it strips every cause | real | `0 ?? default` keeps 0; `verifyCauses` then hits `spent >= limit` on the first verdict, so every causal verdict is marked unverified and loses its attachment. `env.test.ts` names this case "(probes + verification off)" — the code does the opposite of the documented kill-switch |
| B | 358 | the evidence cap is not shared between probes and verification | real | the same undecremented `probeLimit` is passed to `collectTriageProbes` and `verifyCauses`, so a run can spend 2× a limit whose own docstring says "for the whole run" — against an API this project has already been IP-banned by |
| B | 358 | verification spends budget on verdicts the planner will discard | unfalsifiable | accurate ordering point, but its stated harm (starvation → valid causes downgraded) needs the 120-search budget to bind, which current batch sizes cannot reach |
| B | 358 | `isCausal` ignores `review_class`, unlike `isActionable` | unfalsifiable | a genuine inconsistency between two notions of "causal", but the only consequence is a wasted search; no verdict changes |
| B | 358 | `expected_target` copied with `(bid …, abv%, style)` fails verification | real | `formatCandidate` renders `"<brewery> — <name> (bid N, X%, style)"` and the prompt asks for `expected_target` as `"<brewery> — <name>"` using the *same* em dash; `expectedKey` takes everything after the first separator as the name, so a copied line silently marks a correct cause unverified |

### Totals

| config | published | real | false | unfalsifiable | precision |
|---|---|---|---|---|---|
| A | 10 | 2 | 5 | 3 | 20% |
| B | 22 | 11 | 0 | 11 | 50% |
| (old reviewer) | 18 | 1 | 13 | 4 | 6% |

A stricter reading is worth stating alongside, because it changes config A's number a lot and
config B's much less. If `real` is narrowed to "would have prevented a defect of the class the
baseline's single `real` was" — data loss or a wrong published result, not input-validation
hardening — then config A drops to **0/10 (0%)**, since both of its `real` findings are `parseInt`
nits on an operator-only CLI. Config B drops to **7/22 (32%)**: it keeps the already-matched
`pinMatch` delete, `hydrateAbv`'s `hits[0]`, the trailing-slash URL drop, the sticky `parser_bug`
suppression, `Plan B`, `TRIAGE_PROBE_LIMIT=0`, and the copied `expected_target`. Config B's four
distinct `real` findings on #344 also collapse to two distinct defects (loose numeric parsing;
missing already-matched guard), so "11 real" overstates the number of separate things to fix.

## Observations

**The false-positive class the baseline was dominated by is gone in config B.** The baseline's
signature failure was confident invention — asserting the absence of a `catch`, a `WHERE` clause, a
test, a redirect that was present, in several cases added by the diff under review. Across 22
published findings config B did that **zero** times. Every one of its claims survived being checked
against `git show`. That is the single most important number here and it is not a close call.
Config A still does it: 5 of its 10 published findings are refuted by the code, including two
(`isWebFallbackBlocked` "no longer", the tool-schema `required` list) that are the same
fabricated-regression pattern as the baseline.

**Published volume did not fall — judgement changed.** Config B publishes 22 findings where the old
reviewer published 18, so this is not "the pipeline got quieter". It raised more (26 vs. the old
reviewer's unknown pre-filter count), published more, and was right far more often. Config A *is*
quieter (10 published) but buys that quiet at the cost of finding almost nothing: its two `real`
findings are CLI `parseInt` nits, and it missed every substantive defect config B found — the
`pinMatch` already-matched delete, `hydrateAbv`'s `hits[0]`, `TRIAGE_PROBE_LIMIT=0`. Fewer findings
is not the goal and A demonstrates why.

**The mechanical gate earns its place, but barely, and not where it was expected to.** It dropped 6
of 45 raised findings (13%) across the 10 runs: 4 `quote_not_found`, 1 `outside_changed_lines`, 1
`duplicate`. So it is not dead weight — the answer to "did the gate drop anything at all" is yes.
But its dominant reason is `quote_not_found`, which is the gate failing to *locate* a quote rather
than the gate catching a bad finding. The replay tool prints only the claim for a dropped finding,
not its quote, so the anchoring failure cannot be confirmed directly — but at least two of those
four claims are demonstrably about code that exists (config B/#356's "the empty-output fallback can
reintroduce the one-character token" is `cleanSearchQuery`'s final `return out.length ? … :
(cleanName || …)`, and config B/#358's "results are keyed only by `beer_id`" is `verifyCauses`'
`out.set(verdict.beer_id, …)` with no duplicate handling). Those are lost signal, not caught noise,
and the first is arguably a better finding than several that were published. `outside_changed_lines`
fired exactly once in 45; `duplicate` once. The gate's cheap deterministic value is real but small,
and its main contribution is arguably the `matchedLine` it computes, not the findings it removes.
**Follow-up for the tool itself:** the replay output should print the quote alongside a
`quote_not_found` drop, otherwise this failure mode cannot be diagnosed at all.

**The verify pass is doing nothing in config B, and everything in config A.** Config A's verifier
(gpt-5.5 checking gpt-5.4-mini) rejected 7 of 17 gated findings — 41%, and inspection confirms it
was rejecting the right ones. Config B's verifier (gpt-5.5 checking gpt-5.5) rejected **0 of 22**.
A model does not refute its own reasoning. Config B's 0% false rate is therefore attributable to
the *find* pass, not to adversarial verification: in config B the verify pass is an expensive
rubber stamp, costing one API call per finding to confirm everything. That is a design finding, not
a config finding, and it is the most actionable thing in this document.

**Run-to-run variance is high enough to matter.** The two configs found almost disjoint sets on
#358 (config A: triage-plan quiet handling, tool schema, `expectedKey` dash; config B: probe limit,
shared cap, `isCausal`, `expected_target` metadata) with only the `expectedKey`/`expected_target`
region in common — and they reached opposite conclusions about it. The five-PR sample is small,
one run per config, and a 50% vs. 20% gap on 22 and 10 findings has wide error bars. The direction
(B ≫ A ≫ baseline) is safe; the exact percentages are not. One config-B run also failed outright
on the find call (`empty completion`) and needed a re-run — a live workflow needs a retry there.

**One caution about the `unfalsifiable` half of config B.** Eleven of 22 findings are accurate
statements about the code that argue against deliberate, usually inline-documented design. That is
a much better failure mode than invention — a maintainer can dismiss them in one read — but eleven
of them in a single review is real noise, and two (the #348 non-200 stamp, the #344 merge-with-
zero-redirects delete) are close enough to `real` that I have flagged them as torn rather than
force the label. The prompt lever worth pulling is not "find less" but "when the code carries a
comment justifying the behaviour you are about to flag, either refute the comment or drop the
finding".

## Cost

The replay tool prints no token counts, so cost is reported as wall time and API calls. One find
call per PR plus one verify call per gated finding, all sequential.

| config | PR | wall time | API calls |
|---|---|---|---|
| A | 344 | 45 s | 1 + 5 |
| A | 348 | 18 s | 1 + 2 |
| A | 352 | 50 s | 1 + 4 |
| A | 356 | 63 s | 1 + 3 |
| A | 358 | 55 s | 1 + 3 |
| A | **total** | **231 s** (mean 46 s) | **22** |
| B | 344 | 174 s | 1 + 9 |
| B | 348 | 134 s (after one 150 s failed attempt) | 1 + 4 |
| B | 352 | 136 s | 1 + 2 |
| B | 356 | 136 s | 1 + 2 |
| B | 358 | 130 s | 1 + 5 |
| B | **total** | **710 s** (mean 142 s) | **27** (+1 failed) |

Config B is ~3.1× slower per PR at ~1.2× the call count, i.e. the cost is per-call latency on the
larger model rather than call volume. At ~2.5 minutes per PR it is still well inside what a CI
review step can absorb. Roughly 40% of config B's calls are verify calls that rejected nothing.

## Recall set (defects that escaped review and were fixed later)

Same method as the precision set: each PR replayed against its own head commit, no posting. These
four PRs each shipped a defect that both the old AI reviewer and a human review missed at the time,
and that had to be fixed in a later commit. Every fix commit was read first (`git show`) so the
target defect was known before the replay output was looked at.

`#274`'s head object was not present locally (`git cat-file` failed) and was fetched with
`git fetch origin pull/274/head` before replaying. All four PRs replayed without error; no 401s.

| config | PR | escaped defect | fixed in | verdict | evidence |
|---|---|---|---|---|---|
| A | 233 | a non-empty orphan batch that comes back with **zero LLM verdicts** closes the Warsaw day via `finish()` with `error: null` — no retry, no warning, digest reads "Тріаж: 50 нових" while nothing was triaged | `98c05da` (#296) | missed | published 1 finding, on `orphan-triage.ts:111` — the *other* `finish()` caller: "The job exits after marking success when there are no untriaged orphans". Nearest miss of the whole set: it names the right mechanism (`finish` writes `TRIAGE_LAST_RUN_KEY`, so the day is closed) but the wrong branch, and the branch it names is deliberate (nothing to triage → nothing to do). A maintainer would have replied "intended" and stopped |
| A | 237 | the sharpened prompt lists "name divergence (translation, …)" as a matcher_bug hint with no guard, so the triage model reads "Polish name + 0 candidates" as a PL→EN translation gap | `7a9e262` (#354, issue #340) | missed | raised 1, published **0**. The single raised finding was about the `Scope:` line and was refuted by the verifier |
| A | 274 | `rearm-matcher-bug-orphans` can only select by the `review_class='matcher_bug' AND candidates_count > 0` predicate — no way to re-arm a known list of beer ids after a fix | `243b75f` (#336) | missed | did land on the file, but with a **false** claim about the same SELECT: "can include beers that already have a later non-`matcher_bug` failure row … does not choose the latest failure state". `enrich_failures.beer_id` is `INTEGER NOT NULL PRIMARY KEY` (schema v10) and `recordEnrichFailure` upserts `ON CONFLICT(beer_id)` — there is exactly one row per beer, so no later row can exist. Nothing about targeting |
| A | 312 | `## [0.11.0]` was renamed to `## [0.12.0]`, folding already-CWS-shipped 0.11 bullets into the 0.12 notes, so 0.11 users get their own features re-announced | `7b2d10b` (#313) | missed | **structurally impossible**: `no reviewable files`. The PR touches only `extension/CHANGELOG.md`, `extension/package.json`, `extension/package-lock.json`; `INCLUDE_PATTERNS` is `.ts`/`.yml` only and `IGNORE_PATTERNS` has `*.md` |
| B | 233 | as above | `98c05da` (#296) | missed | published 5 findings — PR-vs-issue confusion in `listOpenIssues`, `per_page=100` with no pagination, the new-issue cap spent before verdict routing, `OPENAI_API_KEY` absent from `EXPECTED_PROD_KEYS`, Markdown-table injection in `exampleTable`. None touches the analysis path or the empty-verdict case. The two gate-dropped claims (non-atomic day guard; duplicate `beer_id` marked seen before validation) are also not it |
| B | 237 | as above | `7a9e262` (#354) | missed | published 2, both about prompt *mechanics* rather than prompt *content*: the `Scope:` example wraps across two array elements so it renders on two lines (verified true), and the "merch/glassware/wine/food ⇒ parser_bug" test conflicts with the `wontfix` definition (also true). Neither questions a classification rule against how Untappd actually behaves |
| B | 274 | as above | `243b75f` (#336) | missed | same file, same shape of **false** claim as A: "can return the same beer more than once … no `DISTINCT`". Refuted by the `beer_id` primary key. Nothing about targeting |
| B | 312 | as above | `7b2d10b` (#313) | missed | `no reviewable files` — identical structural exclusion |

### Totals

| config | caught | partial | missed |
|---|---|---|---|
| A | 0 | 0 | 4 |
| B | 0 | 0 | 4 |

### Recall-set funnel

| config | PR | raised | gated | verified | wall time |
|---|---|---|---|---|---|
| A | 233 | 3 | 2 | 1 | 23 s |
| A | 237 | 1 | 1 | 0 | 34 s |
| A | 274 | 3 | 3 | 2 | 43 s |
| A | 312 | — | — | — | 1 s (no reviewable files) |
| A | **total** | **7** | **6** | **3** | **101 s** |
| B | 233 | 8 | 6 | 5 | 143 s |
| B | 237 | 3 | 3 | 2 | 90 s |
| B | 274 | 3 | 2 | 2 | 81 s |
| B | 312 | — | — | — | 1 s (no reviewable files) |
| B | **total** | **14** | **11** | **9** | **315 s** |

## Recall observations

**Recall against known-escaped defects is zero. Both configs, all four PRs, no partial credit.** That
is the headline and it should not be softened. The rebuilt pipeline published 3 findings (config A)
and 9 findings (config B) across these PRs and not one of them would have led a maintainer to the
bug that later had to be fixed. Set against the precision result — config B at 22 published, 0
fabricated — the honest reading is: **this change makes the reviewer trustworthy, not perceptive.**
It stopped lying. It has not started catching the things that get past us. Those are different
properties and only one of them has improved.

**The four misses are four different failure modes, and only two are fixable by prompting.**

1. *#312 is out of scope by construction.* `INCLUDE_PATTERNS` covers `src|tests|scripts|extension/**/*.ts`
   plus workflow YAML; `IGNORE_PATTERNS` contains `*.md`. A release PR that changes only a CHANGELOG
   and a version bump has literally nothing for the reviewer to read, and the replay prints `no
   reviewable files` in one second. No model choice can fix this. This is a real, non-trivial class
   for this repo — extension release PRs are routine, `CLAUDE.md` makes changelog/doc correctness a
   merge requirement, and the reviewer is blind to all of it.
2. *#274 is a missing feature, not a defect.* Nothing in the diff is wrong; what is wrong is what is
   absent (an `--ids` mode). "Notice the ops tool has no escape hatch you will want in three weeks"
   is not a review task any find-prompt phrasing reaches. It is a weak recall target and I would not
   weight it heavily.
3. *#237 needs domain knowledge the reviewer does not have and cannot get from the diff.* The defect
   is that a prompt line ("name divergence (translation, …)") is *empirically wrong about Untappd* —
   Untappd keeps the original Polish spelling, so translating the query zeroes it too. That was only
   established by a live Algolia replay months later. Nothing in the repository says it. Config B did
   critique the prompt twice, correctly, but both critiques were internal-consistency checks
   (a wrapped example line, a conflict between two of its own rules) — the class of prompt bug you
   can find by reading the prompt. The escaped one required knowing the world outside it.
4. *#233 is the miss that matters, and it was reachable.* The empty-verdict no-op is ordinary
   defensive-programming territory: an external call returns an anomalous-but-well-formed response
   and the code proceeds as if it succeeded, marking the day complete. Config A came within ten
   lines and stopped at the wrong `finish()` caller. Config B raised eight findings on this PR,
   ranged over four files, found several true things — and never asked what happens when
   `analysis.verdicts` is empty. This one is a genuine prompt gap, not a scope or knowledge gap.

**The greedy pass is not greedy enough — and it is markedly less greedy on this set.** Config B
raised 5.2 findings per PR on the precision set and **4.7 per PR** here (14 across three replayable
PRs); config A dropped from 3.8 to **2.3** (7 across three). The lowest counts land exactly where the
escaped defects are: 3 raised on #237, 3 on #274. A pass told to be greedy should be producing double
digits per PR and letting the gate and verifier cut them down; instead the funnel starts narrow and
only gets narrower (B: 14 → 11 → 9). Both configs are self-censoring before the machinery designed to
censor them ever runs. The verify pass again rejected almost nothing for B (2 of 11) and, as on the
precision set, config A's verifier is the one doing real work (3 of 6 rejected) because it is
checking a weaker model.

**Config B's zero-false-positive record does not survive contact with this set.** Both configs made
the same false claim on #274 — that the `enrich_failures` join can yield duplicate or stale rows —
and `beer_id` is the table's `PRIMARY KEY`. This is exactly the baseline's signature failure
(asserting the absence of a constraint that exists), and it happened because `src/storage/schema.ts`
was not in the diff and so never entered the context. The context builder only sends changed files.
That is a concrete, mechanical cause with a concrete fix: a finding that reasons about row
multiplicity or uniqueness needs the table definition, and the gate cannot catch it because the
quote it anchors on — the `JOIN` — is really there. Precision measured on five PRs was 0 false in 22;
on nine more published findings it is 1 in 9. The true rate is somewhere between and the sample is
too small to say where.

**What was published that is worth keeping.** Recall against known bugs is a floor, and the ceiling
here is better than the floor suggests. Three config-B findings are real and were news:

- `listOpenIssues` maps every item the GitHub Issues API returns, with no `pull_request` filter —
  verified against `5b2be6ef`. A pull request carrying the `orphan-triage` label becomes a triage
  target the LLM can route verdicts to and the job will comment on. Nobody has ever noticed this.
- `normalizeName` = `baseNormalize(preserveDecimalIdentifiers(stripSearchNoise(s)))` — `stripSearchNoise`
  runs *first*, and its parenthetical rule keeps only `[\p{L}\p{N}]+` with a digit, so `(9.0)` fails
  on the dot and is erased before `preserveDecimalIdentifiers` can protect it. Distinct releases
  collapse to the same normalized name. That is a live regression **introduced by #274 itself**,
  found on the PR that introduced it, and it is precisely the "second pair of eyes" outcome the
  rebuild is for. It is also the strongest single argument in this document for config B over A.
- `exampleTable` interpolates scraped brewery/beer strings and LLM notes straight into a Markdown
  table with no escaping of `|` or newlines. Beer names in this corpus contain pipes.

Config A's one comparable finding (`cleanSearchQuery` falls back to the raw name when cleaning
empties it, reintroducing the structural noise the PR exists to remove) is also true — and is the
same claim the gate silently dropped as `quote_not_found` on config B/#356 in the precision run,
which strengthens the earlier suspicion that those drops are lost signal rather than caught noise.

**Verdict.** On this evidence the pipeline finds true things and misses the things that hurt. It is
still clearly better than what it replaces — the baseline's 13-of-18 fabrication rate was actively
harmful, and a reviewer whose claims survive `git show` is worth having. But "zero fabrications" was
bought at least partly by a find pass that is not looking hard enough, and the recall number says so
plainly. Before this is called an improvement rather than a de-risking, three things follow directly
from the data above, none of which is a model choice:
(a) the find prompt must be pushed to actually be greedy, and specifically to ask what happens when
an external dependency returns a well-formed empty/degenerate response — the #233 class;
(b) the context builder must include the schema (and other unchanged files a finding depends on) or
accept a recurring false-positive class about uniqueness and multiplicity — the #274 class;
(c) the scope globs exclude `*.md` and non-TS release metadata entirely, which makes a whole
category of this repo's PRs unreviewable — the #312 class.

## Config C — asymmetric verifier (gpt-5.5 → gpt-5.4)

**Question.** Config B showed the verify pass rejecting 0 of 22 with the same model on both sides.
The proposed explanation was "a model does not refute its own reasoning". Config C tests it directly:
keep `gpt-5.5` as the finder (it has the better precision) and give pass 2 a *different, weaker*
model. Two failure modes were distinguished in advance — (1) verify still rubber-stamps, so
asymmetry is not the fix; (2) verify rejects, but rejects the **good** findings, because a weaker
model cannot adjudicate a stronger one's reasoning. Only outcome 2 would be expensive to ship
unnoticed, so rejections were to be judged on their merits rather than counted.

**API viability.** `gpt-5.4` was probed with the exact request shape (`max_completion_tokens` +
`response_format: json_schema, strict: true`) before the run: HTTP 200, schema-conforming output.
No 400s, no 401s; the trial key held for all five replays. The experiment is answered by the data,
not by the API.

### Per-PR funnel

| config | PR | raised | gated | verified | verify rejections | published labels |
|---|---|---|---|---|---|---|
| C | 344 | 7 | 7 | 7 | 0 | 4 real, 3 unfalsifiable |
| C | 348 | 4 | 4 | 4 | 0 | 2 real, 2 unfalsifiable |
| C | 352 | 2 | 2 | 2 | 0 | 2 unfalsifiable |
| C | 356 | 1 | 0 | 0 | — | (nothing published) |
| C | 358 | 4 | 3 | 3 | 0 | 2 real, 1 unfalsifiable |
| C | **total** | **18** | **16** | **16** | **0 of 16** | 8 real, 0 false, 8 unfalsifiable |

Gate drops: `quote_not_found` ×1 (#356), `outside_changed_lines` ×1 (#358) — 2 of 18 raised (11%).

### Published findings, labelled

| PR | finding (short) | label | evidence |
|---|---|---|---|
| 344 | `--beer` is not validated before `parseInt` (pin path) | real | `pinMatch(db, parseInt(beer, 10), bid, …)` at `scripts/pin-match.ts`; `--beer 12abc` pins beer 12. Same as A and B |
| 344 | `--beer` unchecked `parseInt` (unpin path) | real | `unpinByBeer(db, parseInt(beer, 10))`, and the log still echoes the original string. Same as B |
| 344 | `parseBid` accepts any string ending in digits | real | `/(\d+)\/?$/` is unanchored and checks no host/path. Same as A and B |
| 344 | the set branch overwrites an existing different `untappd_id` | real | `SELECT id, untappd_id FROM beers WHERE id = ?` reads `untappd_id` and **never uses it**; when no row owns the target bid the code runs `UPDATE beers SET untappd_id = ?, untappd_lookup_at = ?` unconditionally, silently re-identifying an already-matched beer (and, combined with the `parseInt` finding above, `--beer 12abc` does it to the wrong row) |
| 344 | merge branch deletes the source even when `redirected = 0` | unfalsifiable | identical to B's; same reasoning — documented intent, `redirected: 0` is printed back |
| 344 | merge marks **every** link pointing at that beer as reviewed | unfalsifiable | accurate, but redirecting all links is *forced*: the beer row is deleted immediately after, so any link left behind would dangle. The `reviewed_by_user = 1` half is the documented design ("redirect + pin the orphan's links to the canonical row") |
| 344 | `loadOperatorEnv()` runs as a top-level import side effect | unfalsifiable | identical to B's; idempotent, no failure path |
| 348 | `bidFromLink` rejects a canonical URL with a trailing slash | real | `(\d+)(?:[?#]|$)` cannot match `…/b/slug/12345/` at any offset, so a paid-for result is dropped. Same as B |
| 348 | `hydrateAbv` falls back to `hits[0]` when the bid is absent | real | `return (byId ?? hits[0])?.abv ?? null` — an unrelated beer's ABV can satisfy the only corroborator the token-overlap branch has. Same as B |
| 348 | a throwing resolver bubbles out instead of failing soft | unfalsifiable | mechanically exact — `try { … } finally { … }` with no `catch`, and neither `lookupWithFallback`, `enrichOneOrphan` nor `enrichOrphans`' loop catches, so a throw would abort the whole nightly batch. But `createBraveResolver.resolve` wraps its entire body in `try/catch → return []` and never throws, so no input reaches the path. Decisively: **PR #352 later added a `catch` at exactly this line and deliberately rethrows unchanged** ("this must not alter the caller's error semantics in any way") — the project looked at this and chose the propagating semantics |
| 348 | same-language accepts return before ABV hydration | unfalsifiable | accurate (`if (nameGatePass) return toSearchResult(cand)` with `cand.abv` always `null` from Brave), but `recordLookupSuccess` writes `abv = COALESCE(?, abv)`, so a null never overwrites anything — the cost is a missed enrichment, not a wrong value, and hydrating every accept would add an Algolia call per match |
| 352 | `retired_at` is treated as a permanent web-fallback block even after the row re-fails | unfalsifiable | the mechanism is right (`recordEnrichFailure`'s `ON CONFLICT` never clears `retired_at`; only `clearEnrichFailure` removes the row). But `listLookupCandidates` **already** excludes `retired_at IS NOT NULL` from the enrich pool entirely — a broader, pre-existing exclusion this diff did not introduce — so the cron path never reaches the new guard, and on the relay path skipping a retired row is the stated intent. Contrast with B's `parser_bug` finding below, which is `real` precisely because those rows *do* stay in the pool |
| 352 | the `merged` response returns the relayed rating, not the stored one | unfalsifiable | identical to B's |
| 358 | `TRIAGE_PROBE_LIMIT=0` does not disable verification — it strips every cause | real | identical to B's; `0 ?? default` keeps 0, `verifyCauses` then trips `spent >= limit` on the first verdict |
| 358 | the evidence cap is not shared between probes and verification | real | identical to B's; the same undecremented `probeLimit` goes to both calls |
| 358 | verification spends budget on verdicts the planner will discard | unfalsifiable | identical to B's; needs the 120-search budget to bind |

### Totals

| config | published | real | false | unfalsifiable | precision |
|---|---|---|---|---|---|
| B | 22 | 11 | 0 | 11 | 50% |
| C | 16 | 8 | 0 | 8 | 50% |

Under the stricter reading used above (excluding input-validation hardening on an operator-only
CLI), config C is **5/16 (31%)** — the set-branch overwrite, the trailing-slash URL drop,
`hydrateAbv`'s `hits[0]`, `TRIAGE_PROBE_LIMIT=0` and the shared cap — against config B's 7/22 (32%).
The two configurations are indistinguishable on precision. That is expected: they share a finder.

### Every verify rejection, judged

**There were none.** `gpt-5.4` adjudicated 16 findings raised by `gpt-5.5` and returned `confirmed`
on all 16. Zero `refuted`, zero `out_of_scope`, zero `error`. There is nothing to judge as correct
or wrong, and failure mode 2 (a weak verifier killing good findings) did not occur because the
verifier did not kill anything at all.

### Answering the two failure modes

**Failure mode 1 — verify still rubber-stamps: confirmed, decisively.** 0 of 16, against config B's
0 of 22. Model asymmetry is not the fix. The self-verification hypothesis ("a model does not refute
its own reasoning") is now **refuted as the explanation**: a different model, from a weaker
generation, adjudicating with the same adversarial prompt, confirmed at exactly the same rate.

**Failure mode 2 — a weak verifier killing good findings: did not occur, and could not be
observed.** This is worth stating carefully rather than as a clean bill of health. The experiment
cannot show that `gpt-5.4` *would* adjudicate a stronger model's reasoning correctly; it only shows
that it never tried. A verifier that confirms everything is safe in the trivial sense that it
destroys nothing, and useless in the same breath.

**What actually drives the rejection rate is the quality of the findings, not the relationship
between the two models.** Config A's verifier rejected 41% because it was handed findings that were
*wrong about the code* — `gpt-5.4-mini` asserted a missing `AbortSignal`, a fabricated
`isWebFallbackBlocked` regression, a `required` list that harms nothing. Those are refutable by
reading the file, which is exactly what `VERIFY.md` asks. Under a strong finder that class of
finding stops being produced: across configs B and C, 38 published findings, **zero** are refuted by
the code. Every one is accurate about what the code does. So the verifier is asked "does the file
show this?", answers "yes", and confirms — correctly, on its own terms, every time.

The residual noise under a strong finder is a different class entirely: 8 of C's 16 (and 11 of B's
22) are accurate statements that argue against deliberate, usually inline-documented design. That is
not a truth question and `VERIFY.md`'s truth-shaped rubric cannot reach it. The prompt does carry an
`out_of_scope` verdict nominally covering "style preference, a wish for extra tests" — and in 38
adjudications across B and C it was used **zero** times. The one verdict that could discriminate a
design-intent finding from a defect is dead text.

**Verdict: pass 2 does not earn its cost under a strong finder — not with this verifier, and more
importantly not with this rubric.** In config C it consumed 16 of 21 API calls (76%) and changed the
published review by nothing at all. Two directions follow, and they are mutually exclusive:

- *Give it a question it can answer.* Not "is this claim true of the file" (a strong finder already
  clears that bar) but "would acting on this improve the code" — concretely: *when the code carries
  a comment justifying the behaviour being flagged, the finding must refute that comment or be
  dropped*. That single rule targets the entire `unfalsifiable` half of both B and C. It is untested
  and would need its own replay before anyone believes it.
- *Delete it and spend the budget on a second find pass.* The variance data below argues this is
  worth more.

### Run-to-run variance: the same finder found a substantially different set

B and C used the **same finder model and the same prompt** on the **same five PRs**. B raised 26 and
published 22; C raised 18 and published 16. Only ~11 findings are common to both. The difference is
not the verifier — it never rejected anything in either config — it is pure sampling noise in the
find pass, and it is large.

Findings B published and C never raised, that are `real`:

- **#344 `pinMatch` never checks whether the source row is already matched** → the merge branch
  `DELETE FROM beers` destroys a real, identified row. C found the *other half of the same root
  cause* — the unread `beer.untappd_id` — but only its set-branch consequence (a recoverable
  overwrite), missing the destructive branch.
- **#352 sticky `review_class` suppresses the paid path permanently.** C landed on the neighbouring
  `retired_at` clause in the same function and drew the weaker conclusion.
- **#356 one-character name tokens: `Plan B` → `Plan`.** C raised exactly one finding on #356 and
  the gate dropped it.
- **#358 `expected_target` copied with `(bid N, X%, style)` fails verification.**

Findings C produced that B did not:

- **#344 the set branch overwrites an existing `untappd_id`** (`real`, published).
- **#358 the digest counts unverified `matcher_bug`/`parser_bug` rows as `wontfix`** — raised, and
  **killed by the gate as `outside_changed_lines`**. It is true and it is the best finding of the
  run: `planTriageActions` now routes actionable-class verdicts with no target into `plan.quiet`
  (new in this PR), and `orphan-triage.ts`'s pre-existing quiet loop is `if (review_class ===
  'not_on_untappd') notOnUntappd++; else wontfix++`. Unverified matcher/parser rows therefore land
  in the `else` and are reported as `wontfix` in the daily digest — the very metric the 2026-08-04
  quality checkpoint (#357) is meant to read. The gate is *technically* right that the quoted line is
  unchanged; the defect is nonetheless introduced by this diff, elsewhere. This is the clearest
  single case in the whole measurement of `outside_changed_lines` destroying real signal.

Two runs of the same configuration, and the union of their `real` findings is materially larger than
either alone (B contributes 4 the other missed, C contributes 2). Nothing in this document suggests
a verify pass buys that much. A second *find* pass, deduplicated by the existing gate, plausibly
would — and would cost less than the 16 confirming calls C just spent.

Also worth recording: the #356 `quote_not_found` drop is now the **third** time the same claim (the
`cleanSearchQuery` empty-output fallback `return out.length ? … : (cleanName || cleanBrewery ||
name.trim())`, which bypasses the one-character filter the PR exists to add) has been suppressed —
gate-dropped in B/#356, gate-dropped again in C/#356, and published by A only on the recall set. The
code is there and the claim is true. That drop reason needs the diagnostic output the earlier
section already asked for.

### Cost

| config | PR | wall time | API calls |
|---|---|---|---|
| C | 344 | 88 s | 1 + 7 |
| C | 348 | 68 s | 1 + 4 |
| C | 352 | 85 s | 1 + 2 |
| C | 356 | 77 s | 1 + 0 |
| C | 358 | 72 s | 1 + 3 |
| C | **total** | **390 s** (mean 78 s) | **21** (5 find + 16 verify) |

Config C is ~1.8× faster than B (390 s vs 710 s) at 21 calls vs 27, entirely because `gpt-5.4`
verifies faster than `gpt-5.5`. No failed calls, no retries — the `empty completion` failure that
hit B/#348 did not recur. So the cheapest framing of the result is: config C paid 16 API calls and
roughly a third of its wall clock to confirm a set of findings that would have been published
unchanged had pass 2 not run.
