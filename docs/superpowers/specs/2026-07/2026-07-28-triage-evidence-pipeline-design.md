# Triage evidence pipeline — design

**Date:** 2026-07-28
**Issues:** implements the structural half of the 2026-07-28 triage-quality analysis; complements #357 (hints / refuted list / thinking).
**Status:** approved

## Problem

The daily orphan-triage LLM produces causal hypotheses that are wrong more often than right, and
those hypotheses seed real engineering work: two of them (#340 PL→EN translation, #303 colon-label
stripping) would have made matching **worse** if implemented, and one proposed a brewery alias
(`ReCraft ↔ Browar Cornelius`, issue #347) that would have written a false match.

Measured on eight days of `TRIAGE_LOG_DIR` archives (2026-07-21 … 2026-07-28):

| metric | value |
|---|---|
| verdicts | 69 |
| verdicts carrying a causal hypothesis (routed to an issue) | 56 (81%) |
| rows with `candidates_count = 0` — empty `candidates_summary` | 51 (74%) |
| zero-candidate rows still given a specific cause | 38 |
| causal hypotheses later verified by live replay | ~16 checked, **4 held up** |

The model is `claude-opus-4-8` with a ~9.8k-token prompt. This is **not** a model-capability problem:
in three quarters of cases the model is asked to explain *why a search returned nothing* while being
shown nothing but the query string. Its only available strategy is surface pattern-matching on the
beer name — "Polish word → translation gap", "colon → label prefix", "typographic quote → quote fold".
Each of those three was refuted by a single probe query that the job never runs.

Two secondary defects compound it:

1. **No ABV anywhere in the payload.** `summarizeCandidates` emits `"<brewery> — <name>"` for the top
   three candidates; the shop's own ABV and style are not passed either. ABV was the decisive
   discriminator in nearly every case the audit resolved (ReCraft `HAZY APA` 4.2 = shop 4.2 vs
   Cornelius 5.0; `Platan Jedenáctka` 4.6 = 4.6; the 0.5% vs 4.5% non-alcoholic twin pair).
2. **Hypotheses are unfalsifiable at generation time.** Nothing tests them before they are published
   to GitHub, so a wrong guess costs a human (or agent) a full replay session to refute.

There is also a feedback loop worth naming: the prompt carries up to 30 open issues with bodies. A
wrongly-attached example makes the issue a better match for the next similar name, so the same error
becomes more likely over time.

## Goals

- Give the model evidence instead of asking it to guess (probes + richer candidate data).
- Publish a causal claim to GitHub only when it survives an automatic check.
- Keep the job's cost, runtime and failure semantics essentially unchanged.

## Non-goals

- Deterministic hints, the refuted-hypotheses list, and extended thinking → #357.
- Changing the classification taxonomy (`parser_bug` / `matcher_bug` / `not_on_untappd` / `wontfix`).
- Any change to matching itself.

## Design

### 1. Evidence probes (before the prompt is built)

For every orphan in the batch with `candidates_count = 0`, run two deterministic probes through the
existing `BeerSearch` seam:

- `probe_brewery` — the cleaned brewery alone. Answers "does this brewery exist on Untappd, and what
  does its catalogue look like?" (This is what refuted "Kingpin contract-brewery alias gap" and
  surfaced `Browar Artezan — Jasne`.)
- `probe_name` — the cleaned name alone. Answers "does this beer exist under a different brewery
  label?" (This is what surfaced `Browar Cztery Ściany — Trzebnica Pils` and
  `Browar Nowomiejski — Nowomiejskie Pils`.)

Each probe contributes its top three results in the same enriched text form as `candidates_summary`.
Probes are skipped for rows that already have candidates — there the evidence exists already.

Budget and safety:

- Both probes share the Algolia rate gap and the existing circuit breaker. A breaker-open or failing
  probe is **non-fatal**: the field is omitted and triage proceeds exactly as today.
- Hard cap per run (`TRIAGE_PROBE_LIMIT`, default 120 searches). Beyond the cap, probes are omitted.
- Expected steady-state volume: ≤ 50 zero-candidate rows × 2 ≈ 100 searches, once per day, against
  the 160 lookups/day the enrich cron already performs.

### 2. Richer candidate evidence

`summarizeCandidates` gains bid, ABV and style:

```
Browar Cornelius — Cornelius Hazy APA (bid 1511478, 5.0%, IPA - American)
```

Chosen over a new JSON column: nothing parses `candidates_summary` (only the prompt and humans read
it), so a text change needs no migration and no second source of truth. Old rows keep the old format
until their next failure refreshes them; both forms are readable.

The orphan payload also gains the shop's own `abv` and `style`, so the model can compare like with
like. This is what makes an ABV-contradiction visible (`Moontrick` 6.3 vs a candidate at 0.0%).

### 3. Falsifiable verdicts

`VerdictSchema` gains two optional fields, used only when the verdict carries a causal hypothesis
(`issue_number` or `new_issue_key` set):

- `proposed_query` — the query the model believes would find the beer;
- `expected_target` — the `"<brewery> — <name>"` it expects that query to return.

After the LLM responds and before any GitHub write, the job runs each `proposed_query` and checks
whether `expected_target` appears among the results (normalised comparison, reusing `normalizeName` /
`normalizeBrewery`). Then:

- **verified** → published as today, and the verification line is appended to `review_note`;
- **unverified or absent** → the row is still classified and written to the DB, but with
  `issue_number`/`new_issue_key` cleared and the note prefixed `unverified:`. Nothing reaches GitHub.

This is the rule that stops issue pollution, which was the actual cost of the current behaviour.
Classification quality (`matcher_bug` vs `not_on_untappd`) is unaffected — only causal claims are gated.

The digest line gains an `N неперевірених` segment so the rate is visible daily without opening logs.

## Data flow

```
listUntriagedFailures(50)
        │
        ├─ for rows with candidates_count = 0 → probe_brewery, probe_name   (≤ TRIAGE_PROBE_LIMIT)
        │
        ▼
buildTriagePrompt(orphans + probes + abv/style)
        │
        ▼
LLM verdicts (+ proposed_query / expected_target)
        │
        ├─ verify each causal verdict by running proposed_query
        │      ├─ target found      → keep the issue attachment
        │      └─ not found / absent → strip attachment, prefix note "unverified:"
        ▼
planTriageActions → GitHub → DB (unchanged ordering: GitHub first, then DB)
```

## Error handling

- Probe failure, verification failure, breaker open, or cap exhaustion: degrade to today's behaviour
  (no probe evidence / no verification) rather than failing the run. A triage run must never be lost
  because Untappd is unreachable.
- `blocked` outcomes are excluded from the batch already (`listUntriagedFailures`) — unchanged.
- Verification never *upgrades* a verdict: a missing `proposed_query` on a causal verdict is treated
  as unverified, not as a pass.

## Testing

- `summarizeCandidates`: enriched format, missing ABV/style rendered without gaps, cap at 3.
- Prompt builder: probe sections present for zero-candidate rows, absent otherwise; shop abv/style
  rendered; existing field-capping/prompt-injection guards still hold.
- Verification: target found → attachment kept; target absent → attachment stripped and note
  prefixed; `proposed_query` missing → treated as unverified; search throwing → unverified, run
  continues.
- Probe budget: cap respected; breaker-open path omits probes and does not throw.
- Job-level: a run where every probe fails still produces the same verdicts as today (regression guard).

## Rollout

Server-side only, no schema migration, no extension impact. Deploy, then compare one week of
`TRIAGE_LOG_DIR` archives against the pre-change baseline recorded above: share of verdicts carrying
a cause, share of causes that survive verification, and rows later reclassified by hand. That review
is the checkpoint noted on #357 (~2026-08-04).
