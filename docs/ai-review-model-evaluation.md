# Evaluating a model for the AI PR reviewer

How to decide whether a different model can run `find` or `verify`, without betting the
reviewer's quality on a price list. Written after the 2026-09-22 evaluation, whose
first pass cost ≈$7.2 and spent most of that re-deriving a method that already existed;
the later passes, run to this document, cost ≈$5 more including the whole OpenRouter screen
at $1.21.

Run this whenever a new model generation lands, a price changes materially, or someone
proposes a swap. The answer is never read off a benchmark.

## The two things being measured

A reviewer fails in two independent ways, and a single number hides one of them.

- **Fabrication** — it asserts something the code contradicts. This is what killed
  `gpt-5.4-mini` in 2026-07 (5 `false` of 10 published) and what the 2026-07 rebuild fixed
  (72% → 2%). Measured on the labelled corpus.
- **Recall** — it does not find defects that are there. Measured on a recall probe, because
  the corpus cannot measure it: you only know what a config *found*, not what it missed.

A config that is quiet looks excellent on precision alone. Measure both or neither.

## Setup

```
export OPENAI_API_KEY=…                 # not in .env; it is a GitHub secret
export OPENAI_API_ENDPOINT=https://api.openai.com/v1
AI_REVIEW_MODEL=<candidate> AI_REVIEW_VERIFY_MODEL=<candidate> \
  npm run ai-review-replay -- <pr> [base-sha]
```

`replay` posts nothing and reads file bodies from the PR head via `git show`, so it never
touches the working tree. `--head <sha>` replays at an arbitrary commit (see the recall
probe, which needs it).

Probe `/v1/models` with the key before assuming a model name exists. It is free, and the
key's reachable set has twice been wider than assumed.

## 1. Corpus — fabrication and precision

PRs **#344, #348, #352, #356, #358**, labelled in
`docs/superpowers/specs/2026-07/2026-07-28-ai-review-baseline-labels.md`. Replay each at its
own head, then check **every published finding against that tree** with
`git show <head>:<path>` before labelling it. Never label from the claim text.

Labels, unchanged since 2026-07 — changing them between evaluations destroys comparability:

- `real` — a genuine defect in that diff; acting on it prevents a bug.
- `false` — contradicted by the code, checkably wrong.
- `unfalsifiable` — speculation about code not shown, a generic ask with no concrete
  failure path, or a design preference restated as a defect.

The metric that decides: **`false` count**. A candidate that fabricates is rejected however
cheap it is.

## 2. Recall probe — what it misses

Pick a PR whose review produced findings that were **all confirmed real and then fixed**,
and replay it at the head the live review actually saw.

> **The trap.** Replaying at the merged head measures nothing: the defects are gone. This
> has now cost two investigations — the 2026-07 note on #344, and 2026-09 on #418, where
> the very next commit is `fix(#408): close all five findings from the AI review`. Find the
> reviewed head in the review's own state block (`<!-- ai-pr-review-state {"head":…} -->`)
> or take the commit before the fix commit.

Current probe: **PR #418 at `584aa661`**, five known-real findings — scope-fence hijack,
new-issue scope guard, in-run saturation counter, free-string tool schema, and the guard
counters. Score a config by how many of the five it publishes.

## 3. Variance probe — is the difference real

There is no determinism knob: `temperature: 0` is rejected on gpt-5.x, and stability comes
only from the JSON schema. Repeat one rich PR (#358 works) **three times per config**.

2026-09-22 spread: gpt-5.5 published 4 / 3 / 2; gpt-5.6-luna 3 / 3 / 2. A one-PR difference
of two findings is noise. Only aggregates across the corpus, or a miss repeated across
every run, carry signal.

**Match the number of draws, not just the session.** A union over N runs of one config
against a single run of another is not a comparison, it is a head start. This exact mistake
was made here on 2026-09-22: three luna runs unioned against one baseline draw scored luna
**4/5** on the recall probe; three-against-three on the identical context scored it **2/5**,
and the recommendation flipped. Luna's per-run spread is 1–2 findings, so the union was
carried by a single lucky draw. Report per-run numbers **and** the union, for every config.

## 4. Re-measure the baseline in the same session

**Always.** The 2026-07 run of config B gave 26 raised / 22 published; the identical config
on the identical heads gave 17 / 15 in 2026-09. Comparing a candidate against a stored
number charges the baseline's own drift to the candidate.

## 5. Hold the context constant — and check it is not starving

Context composition changes what a model can possibly find, so a model comparison across
two different contexts measures nothing.

This is not hypothetical. In 2026-09 `gpt-5.6-luna` scored 2/5 on the recall probe and
looked clearly worse. The two findings it missed were never raised in **four** independent
runs — a blind spot, not variance. Dropping test-file bodies from the context took it to
4/5, matching gpt-5.5, because one of the missed findings lived in a file the budget had
demoted to diff-only.

Before comparing models, print the assembled context and confirm no source file is
diff-only:

```
Context budget: N file(s) sent as diff only.
```

If a source file is on that list, fix the context first. A model evaluation run against a
starved context will recommend the wrong model.

## Reference results — 2026-09-22

`B` = gpt-5.5, `T` = gpt-5.6-terra, `L` = gpt-5.6-luna, all with `verify` on gpt-5.5.

Corpus, published findings, one run each:

| config | #344 | #348 | #352 | #356 | #358 | total | fabrications |
|---|---|---|---|---|---|---|---|
| B | 4 | 4 | 2 | 1 | 4 | 15 | 0 |
| T | 3 | 3 | 1 | 0 | 3 | 10 | 0 (1 nit) |
| L | 3 | 4 | 1 | 0 | 3 | 11 | 0 |

Recall probe, PR #418 @ `584aa661`, **on the pre-stage-1 (starved) context** — kept only to
show what context starvation does, not as a model comparison:

| config | of 5 |
|---|---|
| gpt-5.5 | 4/5 |
| gpt-5.6-terra | 3/5 |
| gpt-5.6-luna | 2/5 |

## Reference results — 2026-09-22, second pass (the one to compare against)

Run after stage 1 shipped, so the context is the one CI now assembles; baseline re-measured
in the same session; **three draws per config**, per the rule above. This supersedes the
first pass for every purpose except the starvation illustration.

| config | verified per run | of the 5 known defects | price in/out |
|---|---|---|---|
| gpt-5.5 | 5 / 5 / 3 | **5/5** | $5 / $30 |
| **gpt-5.6-sol** (now the default `find`) | **8 / 6 / 5** | **5/5** plus several more | **$4 / $20** |
| gpt-5.6-terra | 4 / 3 / 5 | 3–4/5 | $2 / $12 |
| gpt-5.6-luna | 1 / 2 / 2 | 2/5 — **refuted** | $0.20 / $1.20 |

Corpus, findings published in total: gpt-5.5 **16**, terra **9**, luna **6**.

Sol is cheaper than the model it replaces on both input and output *and* published more of
the known defects, so the switch carried no quality bet. Its one real cost is triage time:
8 verified findings per run is more to read, and by the 2026-07 labels about half of what
this pipeline publishes is `unfalsifiable`.

Prices per 1M tokens, read from the vendor page 2026-09-22 — recheck before reusing:

| model | input | cached | output | note |
|---|---|---|---|---|
| gpt-5.5 | $5.00 | $0.50 | $30.00 | confirmed against a real bill, not transcribed |
| gpt-5.6-sol | $4.00 | $0.40 | $20.00 | ← **promotional until 2026-11-21**, then may revert to $5/$30 |
| gpt-5.6-terra | $2.00 | $0.20 | $12.00 | |
| gpt-5.6-luna | $0.20 | $0.02 | $1.20 | |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 | |

Non-OpenAI candidates priced the same day, for the record: DeepSeek Pro $0.60/$1.80,
GLM 5.3 FlashX $0.37/$1.25, DeepSeek Flash $0.12/$0.48, Kimi K2.6 $0.95/$4.00. All were
rejected on arithmetic — luna undercuts all but DeepSeek Flash, whose ≈7% further saving
does not pay for a second vendor account, a per-model request-shape seam (`max_tokens` vs
`max_completion_tokens`), provider pinning against silent re-quantization, and
`require_parameters: true` to keep strict `json_schema` routing.

## The OpenRouter pass — RUN 2026-09-22, no candidate came close

Recall probe, PR #418 @ `584aa661`, three draws each, verify on `gpt-5.5` throughout.
Total spend for the whole screen: **$1.21**.

| config | verified per run | what happened |
|---|---|---|
| `gpt-5.6-sol` (incumbent, direct) | 8 / 6 / 5 | — |
| `deepseek/deepseek-v4-pro-0813` | **0 / 1 / 1** | raises 8, 10 and **31**; verify returns **35 `refuted`** across the three runs |
| `z-ai/glm-5.3` | — | one truncated JSON body, then empty completions |
| `moonshotai/kimi-k2.7-code` | — | empty completions |

**DeepSeek fabricates.** Its findings die at *verify*, not at the gate, with the verdict
`refuted` — the adversarial judge saying the code contradicts the claim. For scale: the
production counters from PRs #359–#363 recorded 8 rejections of 29, **all `out_of_scope`
and not one `refuted`**. Thirty-five refutations in three runs is the `gpt-5.4-mini` failure
mode of 2026-07, at a larger size.

**GLM and Kimi could not complete a structured call** over the path available to us. That may
be routing rather than the models: unpinned, a request can land on an endpoint that does not
honour `strict` (see the three preconditions below). Fixing it needs the request-shape seam —
and nothing here justifies building one, since the only candidate that worked mechanically
published 0–1 findings against the incumbent's 5–8.

### Two things this pass corrected about its own instructions

- **No seam is needed to *measure* through OpenRouter.** Probed live: it accepts our exact
  body — `max_completion_tokens` (not `max_tokens`) together with
  `response_format: {json_schema, strict: true}` — and both candidates returned schema-valid
  JSON. The seam is required only to talk to a vendor *directly*. An evaluation is therefore
  two env vars, not a project.
- **OpenRouter is not cheaper for OpenAI's models — it is dearer, and its listed price does
  not predict the bill.** Measured on one call each: `gpt-5.5` billed $0.021385, exactly this
  repo's price table, while the listing implied $0.0107; `gpt-5.6-sol` billed $0.025497
  against a listing implying $0.0041 and a direct price of $0.016332, because routing sent it
  to **Azure**. The model-level `pricing` field reflects the cheapest endpoint, not the one
  that serves you. Never quote it as a saving.

A side benefit: `gpt-5.5` billed through a third party matched `PRICES['gpt-5.5']` to the
cent, so that row is now confirmed by an independent source rather than transcribed.

## The preconditions

Prices seen 2026-09-22, for sizing only — recheck before spending on them: DeepSeek Pro
$0.60/$1.80, GLM 5.3 FlashX $0.37/$1.25, DeepSeek Flash $0.12/$0.48, Kimi K2.6 $0.95/$4.00.
Against the shipped default (`gpt-5.6-sol`, $4/$20) the headroom is real; against `terra`
($2/$12) it is a factor of a few, not an order of magnitude.

**Take one OpenRouter account, not one account per vendor.** One key, one balance, one
OpenAI-compatible endpoint, so `OPENAI_API_ENDPOINT` + `AI_REVIEW_MODEL` reach every
candidate with no code change. The repo is public, so handing a diff to another vendor
raises nothing we do not already publish.

Three things must be settled before any number from such a run means anything:

1. **`response_format: {json_schema, strict: true}` must actually be honoured.** The whole
   pipeline depends on it. OpenRouter supports it, but the *endpoint it routes to* may not —
   set `require_parameters: true` in the provider preferences, or a run silently degrades to
   free-form JSON.
2. **Pin the provider.** The same open-weight model is served by several hosts at different
   quantizations. Without `provider.order`/`only`, a measurement is not reproducible a week
   later, and a regression looks like model drift.
3. **A request-shape seam is needed only to go DIRECT to a vendor**, not to measure.
   `openai.ts` sends `max_completion_tokens` because gpt-5.x rejects `max_tokens`, and
   DeepSeek direct wants the opposite — but OpenRouter accepts our body unchanged (probed
   2026-09-22). Build the seam when a candidate has already earned a direct account, never
   before.

Measure exactly as above: the labelled corpus for fabrication, the recall probe at
`584aa661` for coverage, three draws per config, and the incumbent re-measured in the same
session. A candidate that cannot beat `terra` on coverage is not interesting, because terra
is already available with no account, no seam and no pinning.

Two failure modes to expect, both seen on 2026-09-22: a candidate that **raises volume and
loses it at verify** (`refuted`, not `out_of_scope` — that distinction is the whole signal),
and a candidate that **returns empty or truncated completions**, which is usually the
unpinned endpoint not honouring `strict` rather than the model being unable. Diagnose the
second with precondition 1 before blaming the model.

## Outcomes that are settled — do not re-derive

- **The verify pass is not a removal candidate** (production counters, PRs #359–#363:
  8 of 29 gated rejected, 7 `out_of_scope` + 1 `error`). It filters design noise.
- **The prompt cache is not a lever.** Prefix overlap between consecutive runs on a PR is
  0%, and still 0% with bodies reordered ahead of the diff, because churn ordering puts the
  just-edited file first.
- **Repeated cheap sampling does not recover recall.** Four luna runs, zero hits on the two
  missing findings. Union-of-samples is not a substitute for context.
- **`max_tokens` and `temperature: 0` are rejected on gpt-5.x.** Use
  `max_completion_tokens`; determinism comes from the schema.
- **A spent OpenAI balance returns 429, not 402.**
