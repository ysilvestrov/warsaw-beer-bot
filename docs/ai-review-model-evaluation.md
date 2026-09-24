# Evaluating a model for the AI PR reviewer

How to decide whether a different model can run `find` or `verify`, without betting the
reviewer's quality on a price list. Written after the 2026-09-22 evaluation, whose
first pass cost ≈$7.2 and spent most of that re-deriving a method that already existed;
the later passes, run to this document, cost ≈$5 more including the whole OpenRouter screen
at $1.21. The 2026-09-23 census that follows them cost under $0.10, because it measured
prices and request shapes before spending anything on quality.

Run this whenever a new model generation lands, a price changes materially, or someone
proposes a swap. The answer is never read off a benchmark.

The document has two halves and they are read differently. **The protocol** (sections 1–5,
then the preconditions) is how to measure; change it only when a measurement teaches you
something about measuring. **The results log** is append-only: every pass gets a dated
entry with its own numbers, and an earlier entry is never edited to agree with a later one
— a superseded number is labelled superseded, because the drift between two passes is
itself evidence (see section 4).

Companion: `docs/ai-review-fabrication-corpus-2026-09-22.md` holds 16 wrong claims a good
judge rejected — the test set for a **verify** candidate, which the recall probe cannot
measure.

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

Current probe: **PR #418 at `584aa661`**. The five known-real findings are the ones the fix
commit `2170717` closed ("All five were valid on inspection; none were declined") — read them
there, never from a summary:

- **D1 — body scope hijack.** `issue.body` is model prose and lands *before* our rendered
  block, so a `triage-scope` fence written there wins `parseScopeBlock`'s first-match race.
- **D2 — `isLegalScope` lets a cohort launder a whole-class `where`.** `rowSatisfiesScope` ORs
  `beer_ids` with `where`, so a `review_class`-only `where` decides for every row outside the
  cohort.
- **D3 — a verdict routed to a NEW issue was never checked against that issue's scope.**
- **D4 — saturation counted only pre-run rows**, so one batch could walk an issue past its cap.
- **D5 — the tool schema advertised `col`/`op` as free strings**, so a tool-valid term that zod
  rejects failed the whole run instead of the term.

Score a config by how many of the five it publishes, judged on the **mechanism**, not the
wording — and check the claim against both trees before crediting it.

> **Corrected 2026-09-23.** This list previously read "scope-fence hijack, new-issue scope
> guard, in-run saturation counter, free-string tool schema, and **the guard counters**". The
> last is not one of the five: "guard counters are logged only when the model omitted
> verdicts" is a separate observation the fix commit never closed, and **D2** was missing
> altogether. Every pass before this one scored against a list off by one.
>
> A near-miss to adjudicate the same way: a run claiming *"parsed scopes on existing issues are
> never passed through `isLegalScope`"* has **not** found D2. Verified in both trees — the fix
> changed the rule *inside* `isLegalScope` and left its single call site on `new_issues`, so
> existing issues still skip the guard after the fix. It is real and still open — filed as
> **#692** — but it is a different defect.

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

## The preconditions

Prices seen 2026-09-22, for sizing only — recheck before spending on them: DeepSeek Pro
$0.60/$1.80, GLM 5.3 FlashX $0.37/$1.25, DeepSeek Flash $0.12/$0.48, Kimi K2.6 $0.95/$4.00.
Against the shipped default (`gpt-5.6-sol`, $4/$20) the headroom is real; against `terra`
($2/$12) it is a factor of a few, not an order of magnitude.

**Take one OpenRouter account, not one account per vendor.** One key, one balance, one
OpenAI-compatible endpoint, so `OPENAI_API_ENDPOINT` + `AI_REVIEW_MODEL` reach every
candidate with no code change. The repo is public, so handing a diff to another vendor
raises nothing we do not already publish.

Four things must be settled before any number from such a run means anything:

1. **`response_format: {json_schema, strict: true}` must actually be honoured.** The whole
   pipeline depends on it. OpenRouter supports it, but the *endpoint it routes to* may not —
   set `require_parameters: true` in the provider preferences, or a run silently degrades to
   free-form JSON.
2. **Pin the provider.** The same open-weight model is served by several hosts at different
   quantizations. Without `provider.order`/`only`, a measurement is not reproducible a week
   later, and a regression looks like model drift.
3. **Probe the request shape per vendor; never infer it.** `openai.ts` sends
   `max_completion_tokens` because gpt-5.x rejects `max_tokens`, and DeepSeek direct wants
   the opposite — from which this document once concluded that any direct vendor needs a
   seam. Wrong: OpenRouter accepts our body unchanged (probed 2026-09-22) and so does
   **Anthropic, directly**, over its OpenAI-compatibility endpoint at
   `https://api.anthropic.com/v1` with a Bearer key (probed 2026-09-23, three models). One
   free structured call settles it. Build the seam only for a vendor that has actually
   refused the body.
4. **Check the candidate's reasoning switch reaches it.** The find stage leans on reasoning
   — 5.1k of 5.6k find completion tokens on PR #688 — and gpt-5.x reasons by default.
   Anthropic's compat endpoint accepts both `reasoning_effort` and a native `thinking`
   block **and ignores them** (probed 2026-09-23: completion tokens unchanged, no reasoning
   accounting). A candidate measured with reasoning off can only be cleared by that test,
   never rejected by it.

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
- **A price row is not a cost.** Multiply it by the tokens *that vendor* counts for your
  prompt: Anthropic counts 1.65× what OpenAI does for identical text (measured 2026-09-23),
  which is enough to flip a ranking.
- **Output is no longer a rounding error.** #364 recorded that input dominates the bill;
  with a reasoning model on `find` it does not — output was 60% of find's cost on PR #688.
  Weigh both halves of a candidate's price.
- **`gpt-6-*` does not match a `gpt-5` grep.** Filter the `/v1/models` list by date, not by
  name, or you will miss a whole generation (2026-09-23).
- **`verify` is not ≈18% of the bill.** Measured 2026-09-23 across 12 draws: 38–47% of a run
  with the incumbent on find, and **94–96%** with a cheap find model. The 18% came from PRs
  carrying one or two findings. Verify, not find, is where the remaining money is.
- **Cheap does not mean thoughtless.** `gpt-6-luna` spent *more* reasoning tokens than the
  incumbent (4.1–4.9k vs 2.6–3.1k) at 1/38 the find cost. When a cheap model under-covers,
  find the blind spot; do not explain it with the price.
- **Quote per-draw scores and the union together.** They are different numbers and a candidate
  is compared like-to-like with each. Half of a 2026-09-22 confusion was this alone.

---

# Results log

Newest pass last. Each entry states what was measured, on what context, and what it
settled; numbers from a superseded pass stay put with a note saying so.

## 2026-09-22, first pass — superseded, kept for the starvation illustration

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

## 2026-09-22, second pass — the baseline to compare against

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

## 2026-09-22, OpenRouter pass — no candidate came close

Recall probe, PR #418 @ `584aa661`, three draws each, verify on `gpt-5.5` throughout.
Total spend for the whole screen: **$1.21**.

| config | verified per run | what happened |
|---|---|---|
| `gpt-5.6-sol` (incumbent, direct) | 8 / 6 / 5 | — |
| `deepseek/deepseek-v4-pro-0813` | **0 / 1 / 1** | raises 8, 10 and **31**; of the 37 claims that reached verify, **16 came back `refuted`** |
| `z-ai/glm-5.3` | — | one truncated JSON body, then empty completions |
| `moonshotai/kimi-k2.7-code` | — | empty completions |

**DeepSeek fabricates.** Its findings die at *verify*, not at the gate, with the verdict
`refuted` — the adversarial judge saying the code contradicts the claim. For scale: the
production counters from PRs #359–#363 recorded 8 rejections of 29, **all `out_of_scope`
and not one `refuted`**. Sixteen refutations of 37 adjudicated claims is the `gpt-5.4-mini`
failure mode of 2026-07, at a larger size.

> **Corrected 2026-09-23.** This section first read "35 `refuted`". Recounting the run
> outputs gives 16 `refuted` + 19 `out_of_scope` = the 35 verify **rejections**; only the
> refutations are the fabrication signal, and conflating the two doubled the headline
> number. The conclusion is unchanged — production has produced zero refutations — and the
> 16 claims are now preserved verbatim in
> `docs/ai-review-fabrication-corpus-2026-09-22.md`.

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
  two env vars, not a project. *(The second sentence was itself refuted on 2026-09-23:
  Anthropic takes our body directly too. See that entry.)*
- **OpenRouter is not cheaper for OpenAI's models — it is dearer, and its listed price does
  not predict the bill.** Measured on one call each: `gpt-5.5` billed $0.021385, exactly this
  repo's price table, while the listing implied $0.0107; `gpt-5.6-sol` billed $0.025497
  against a listing implying $0.0041 and a direct price of $0.016332, because routing sent it
  to **Azure**. The model-level `pricing` field reflects the cheapest endpoint, not the one
  that serves you. Never quote it as a saving.

A side benefit: `gpt-5.5` billed through a third party matched `PRICES['gpt-5.5']` to the
cent, so that row is now confirmed by an independent source rather than transcribed.

## 2026-09-23, census and mechanical screen — no quality numbers yet

Two new generations landed within days of the 2026-09-22 passes: OpenAI's **gpt-6** family
(`gpt-6-astra` 2026-08-27, `gpt-6-sol` and `gpt-6-luna` 2026-09-14) and Anthropic's
**Claude Opus 5.5** (2026-09-21). This entry is the cheap half of the protocol — what
exists, what it costs, and whether it takes our request body. **No recall or corpus numbers
were measured**; the pass that measures them is specified at the end.

Both vendor keys were probed against `/v1/models` first, per the protocol's standing note,
and again it paid: `gpt-6-*` does not match a `gpt-5` grep, so the first sweep of the model
list missed the whole new generation.

### Prices, read from the vendor pages 2026-09-23

Per 1M tokens, short-context tier. OpenAI's long-context tier still starts above **272k
input tokens** (2× input, 1.5× output, applied to the whole request) and our budget of
240 000 *characters* cannot reach it.

| model | input | cached in | output | context | note |
|---|---|---|---|---|---|
| `gpt-5.6-sol` | $4.00 | $0.40 | $20.00 | | incumbent `find`; promo price ends 2026-11-21 |
| `gpt-5.5` | $5.00 | $0.50 | $30.00 | | incumbent `verify` |
| **`gpt-6-sol`** | **$2.00** | **$0.20** | **$10.00** | 1 050 000 / 128k out | knowledge cutoff 2026-04-20 |
| **`gpt-6-luna`** | **$0.10** | **$0.01** | **$0.50** | | |
| `gpt-6-astra` | $10.00 | $1.00 | $50.00 | | flagship — dearer, excluded |
| `gpt-5.6-cyber` | $12.50 | $1.25 | $75.00 | | excluded |
| **`claude-opus-5-5`** | $4.00 | $0.20 read / $5.00 write | $20.00 | | |
| **`claude-sonnet-5`** | $2.00 | $0.20 / $2.50 | $10.00 | | |
| **`claude-haiku-4-5`** | $1.00 | $0.10 / $1.25 | $5.00 | | API id `claude-haiku-4-5-20251001` |
| `claude-opus-5` | $5.00 | $0.50 / $6.25 | $25.00 | | dearer than the incumbent |
| `claude-fable-5-1` | $10.00 | $0.25 / $12.50 | $50.00 | | excluded |

### Three live probes, and what each one settled

**1. Every candidate accepts our exact request body.** One structured call each with
`max_completion_tokens`, no `temperature`, and `response_format: {json_schema, strict:true}`
— the body `scripts/ai-review/openai.ts` sends. All six returned schema-valid JSON:
`gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, and — through Anthropic's OpenAI-compatibility
endpoint at `https://api.anthropic.com/v1` with a Bearer key — `claude-opus-5-5`,
`claude-sonnet-5`, `claude-haiku-4-5`.

> This **refutes precondition 3 as written**. It claimed a request-shape seam is needed to
> talk to a vendor directly, generalising from DeepSeek's `max_tokens`. Anthropic needs no
> seam: two env vars reach it, exactly as OpenRouter does. What a vendor rejects has to be
> probed per vendor, not inferred from another vendor.

**2. Anthropic counts 1.65× more input tokens for the identical prompt.** The same 6 596-char
TypeScript file, same messages, same schema: OpenAI 1 725 prompt tokens (3.82 char/token),
Anthropic 2 850 (2.31 char/token). The ratio held across Sonnet 5 and Opus 5.5 and is partly
tokenizer, partly the compat layer re-expressing our `json_schema`. **A price row alone does
not compare two vendors** — multiply it by the tokens that vendor counts. This one
measurement moves `claude-opus-5-5` from "same price as the incumbent" to *dearer than it*.

**3. Extended thinking cannot be switched on through the compat endpoint.** Both
`reasoning_effort: "medium"` and an Anthropic-native `thinking` block were accepted without
error and had no observable effect: completion tokens unchanged (227 / 209 / 212 on an
identical prompt) and no reasoning accounting in `usage`. gpt-5.x reasons by default and the
find stage leans on it — PR #688's live review spent 5.1k of its 5.6k find completion tokens
on reasoning. So a Claude candidate measured over this endpoint is measured **with reasoning
off**, which makes the test one-sided: a pass is strong evidence, a failure is inconclusive
and would have to be re-run over the native Messages API before it means anything.

### Cost per real review call, not per million tokens

Grounded on PR #688's own footer — `find 1 call 18.5k→5.6k (5.1k reasoning) · verify 1 call
3.6k→665` — because that is a whole review of a real PR. Anthropic input scaled by the
measured 1.65×; output held at the same count, which is an assumption the pass has to
replace with a measurement.

| `find` model | input $ | output $ | per call | vs incumbent |
|---|---|---|---|---|
| `gpt-5.6-sol` (incumbent) | 0.074 | 0.112 | **$0.186** | — |
| `gpt-6-sol` | 0.037 | 0.056 | **$0.093** | **−50%** |
| `gpt-6-luna` | 0.002 | 0.003 | **$0.005** | −97% |
| `claude-sonnet-5` | 0.061 | 0.056 | **$0.117** | −37% |
| `claude-haiku-4-5` | 0.031 | 0.028 | **$0.059** | −68% |
| `claude-opus-5-5` | 0.122 | 0.112 | **$0.234** | **+26% — excluded** |

Note what this corrects about an older belief: the #364 cost review recorded that **input
dominates the bill**. With a reasoning model on `find` that is no longer true — on PR #688 output was
60% of find's cost, because 5.1k of 5.6k completion tokens were reasoning. A candidate's
output price now matters as much as its input price, which is why `gpt-6-sol`'s halving of
*both* is worth more than it looks.

### Candidate register

Verdicts filled in from the quality pass that follows.

| candidate | stage | price verdict | outcome |
|---|---|---|---|
| `gpt-6-sol` | find | −60% measured | **3/5 union — shelved**, D5 blind spot |
| `claude-haiku-4-5` | find | −78% measured | **0/5 union + 2 `refuted` — refuted** |
| `gpt-6-luna` | find | −97% measured | **3/5 union — shelved**, but reasons *more* than the incumbent |
| `claude-sonnet-5` | **verify** | ≈27% vs `gpt-5.5` (uncached; measured 2026-09-23) | **no certifiable divergence on the 15-entry corpus — not adopted, corpus resolution unproven** |
| `claude-opus-5-5` | — | +26% per call once tokens are counted | excluded on price |
| `gpt-6-astra`, `gpt-5.6-cyber`, `claude-fable-5-1`, `claude-opus-5` | — | dearer | excluded |

### The pass that is planned, and what it costs

> **Run the same day** — results in the next entry. Read this section for the method and the
> budget that was set before spending; read the next one for what the numbers turned out to be.
> Two of its predictions were wrong: `gpt-6-sol` was expected to be the front-runner and came
> in at 3/5, and the estimate of Anthropic's token penalty (1.65×, from a small file) was 1.22×
> on the real review prompt.

Nothing above says a word about quality. The pass to run, per the protocol and in this
order, so a cheap refutation stops the spending early:

1. **Recall probe, PR #418 @ `584aa661`, three draws each**, verify pinned to `gpt-5.5`
   throughout, and the incumbent `gpt-5.6-sol` **re-measured in the same session** —
   `gpt-6-sol`, then `claude-haiku-4-5`, then `gpt-6-luna`. Print the context budget line
   first and confirm no source file is diff-only.
2. **Corpus pass** (#344, #348, #352, #356, #358, one run each) for anything that survives
   step 1, labelling every published finding against its own tree.
3. **Verify candidates** only after a `find` model is settled: `claude-sonnet-5` against
   `docs/ai-review-fabrication-corpus-2026-09-22.md`, scored on how many of the 12 usable
   claims it returns `refuted`, with `gpt-5.5` re-scored on the same 12 in the same session.

Commands, with the key files in `./tmp/` (ephemeral — not committed):

```
export OPENAI_API_ENDPOINT=https://api.openai.com/v1        # or https://api.anthropic.com/v1
export OPENAI_API_KEY=$(tr -d '\r\n ' < tmp/openai.key)     # or tmp/claude.key
AI_REVIEW_MODEL=gpt-6-sol AI_REVIEW_VERIFY_MODEL=gpt-5.5 \
  npm run ai-review-replay -- 418 --head 584aa66183e55e4371819c9c5b19b2662ddaa6a2
```

Add a `PRICES` row for each candidate **before** running, or every footer reads
"(unpriced model)" and the run measures coverage without measuring cost.

Sizing from the 2026-09-22 passes: the whole OpenRouter screen (3 configs × 3 draws) cost
$1.21, and a corpus pass runs $1–2 per config. Budget **$5–8** for all of the above.

### Jev — assessed 2026-09-23, rejected without a run

`typesafe/jev` was proposed for `verify`. It is a **structured decision model**: it returns
a typed choice (`noul`/`choice`/`score`) over a separate alpha endpoint,
`POST https://openrouter.ai/api/alpha/decisions`, with a 32 000-token ceiling and free
output. Three things rule it out for this stage, in order of severity:

1. **No prose field.** `verify` must return `evidence` — "one sentence citing the code that
   settles it" — which is published as "**Verified:** …", stored in the state block and
   carried into the next run; the prompt says in so many words that *"Looks correct" is not
   evidence*. A typed vote cannot produce it. That is a change in what the stage is, not in
   who supplies it.
2. **A context ceiling we do not have today.** `verify` sends the full current file body.
   The largest reviewable sources are `src/storage/beers.ts` (45 638 ch ≈ 11.4k tok) and
   `src/domain/untappd-lookup.ts` (43 673 ch ≈ 10.9k tok), and observed production verify
   inputs ran 1.5k–19.0k tokens. Most calls fit; the ones that would not are the big files
   where findings matter most.
3. **A different protocol**, not a different parameter — a second client, not a seam.

Standing economics behind all three: `verify` is ~18% of the bill and the stage whose job is
to decide what a human sees. It is the worst candidate for saving money and the best one for
losing precision. The probe was not run — both keys used on 2026-09-22 had been revoked at
that point — and nothing above needs a probe to settle.

## 2026-09-23, quality pass — nothing replaces the incumbent on `find`, and the money moved

The pass planned in the entry above, run the same day for **$2.72**. Recall probe, PR #418 @
`584aa661`, **three draws per config**, verify pinned to `gpt-5.5` on OpenAI throughout, the
incumbent re-measured in the same session. Context identical for every draw — 147 605 chars,
6 files diff-only, **all six `*.test.ts`, zero source** — so the § 5 precondition held.

Scored against the five defects the fix commit closed (see § 2, whose list this pass had to
correct first). Costs are recomputed from token counts at **uncached** list rates; see the
cache note below.

| config | per draw | **union** | published | find $/run | whole run $ |
|---|---|---|---|---|---|
| **`gpt-5.6-sol`** (incumbent) | 3 / 4 / 4 | **5/5** | 6 / 7 / 5 | $0.2564 | **$0.4440** |
| `gpt-6-sol` | 2⚠ / 2⚠ / 3 | 3/5 | 3 / 3 / 5 | $0.1021 | $0.1928 |
| `gpt-6-luna` | 2 / 3 / 1 | 3/5 | 3 / 5 / 2 | **$0.0068** | $0.1301 |
| `claude-haiku-4-5` | 0 / 0 / 0 | **0/5** | 1 / 0 / 0 | $0.0575 | $0.1412 |

⚠ = the defect was **raised** and verify returned `error` rather than a verdict — a harness
failure, scored apart from a miss. See "the empty-completion defect" below.

**The incumbent stays.** No candidate matched 5/5, and the band the two gpt-6 models land in
(3/5) is the band `gpt-5.6-terra` was shelved in on 2026-09-22. Rejecting terra for costing one
of five and then accepting a model that costs two would not be a decision, it would be a mood.

### What each candidate actually did

**`gpt-6-sol` — cheaper because it thinks less.** On the identical prompt it spent 871 / 658 /
871 reasoning tokens against the incumbent's 2 562 / 2 563 / 3 072, and emitted 2.0k completion
against 4.2–4.8k. −60% on find, and the two defects it never raised are the price.

**`gpt-6-luna` — the surprise, and still not enough.** It reasons *more* than the incumbent
(4 078 / 4 900 / 4 430 tokens) at 1/38 the find cost: **$0.0068 a run against $0.2564**. Its
union is 3/5 and its per-draw spread is 1–3, so it is not a replacement — but "cheap models
don't think" is not why it fails, and that is worth knowing before the next generation lands.

**`claude-haiku-4-5` — refuted, three different ways in three draws.** r1 published one finding
outside the five and produced **2 `refuted`** (production has zero in 29); r2 raised 6 and every
one came back `out_of_scope`; r3 returned an **empty findings array** (8 completion tokens).
Reasoning was 0 tokens in all three, exactly as precondition 4 predicted, so this rejects haiku
**over the compat endpoint**, not as a model — but 0/5 plus fabrications does not pay for a
native Messages client.

### Which misses carry signal

Both gpt-6 models missed D2 and D5 in all three of their draws. Only one of those is a finding:

- **D5 (free-string tool schema) is a real blind spot** of the generation. The incumbent raised
  it in 2 of 3 draws, the two gpt-6 models in **0 of 6** — at p≈2/3, six consecutive misses
  land about 0.1% of the time.
- **D2 is not established.** The incumbent itself raised it in only 1 of 3 draws, so at p≈1/3
  six misses happen ~9% of the time. Under-powered, and it needs draws rather than adjectives.

### The money moved to verify — this is the pass's real finding

`verify`'s share of a run, measured here rather than assumed:

| find model | verify share of the run |
|---|---|
| `gpt-5.6-sol` | 41% / 47% / 38% |
| `gpt-6-sol` | 35% / 40% / 59% |
| `claude-haiku-4-5` | 65% / 69% / — |
| `gpt-6-luna` | **96% / 94% / 94%** |

The "verify is ≈18% of the bill" figure this repo has been quoting came from PRs carrying one
or two findings. On a PR where the reviewer has real work — seven findings, full file bodies
re-sent per file group — the judge costs as much as the hunter. And the cheaper the find model,
the more completely verify *is* the bill: at luna's prices it is 94–96% of it.

Consequence for the next pass: **`find` is no longer the lever.** Verify runs `gpt-5.5` at
$5/$30, the dearest model in play, and a candidate there is measured on the fabrication corpus
and on agreement with the incumbent judge — never on the recall probe, which measures a hunter.

### The empty-completion defect — found by this pass, ours not a candidate's

`[verify:error] … reason: OpenAI returned an empty completion`, seen 3 times across 12 draws,
always on `src/jobs/orphan-triage.ts` (31 689 chars). Mechanism: `verifyFile` requests
`max(MIN_VERIFY_TOKENS=2000, n * TOKENS_PER_VERDICT=1200)` completion tokens, gpt-5.5 spends
the whole budget reasoning over a large file, returns no content, and `callStructured` throws.
Two consequences, both live in production:

1. **every finding in that file is silently lost** — they surface as `error`, and a fail-open
   re-check publishes nothing;
2. **the call is billed and never counted**, because the throw happens before usage is
   returned. Visible in the numbers: verify usage 3.6k on the errored draws against 11.9k on the
   draw where the same file's call succeeded.

It penalised `gpt-6-sol` twice on D1 — i.e. this defect can make a candidate look blind when it
was not. Filed as **#691**.

### Two things this pass corrected about its own method

- **Quote per-draw and union together, always.** Yesterday's "sol 5/5" was a *union*; today's
  incumbent scores 3/4/4 per draw and 5/5 as a union. Both numbers are true and neither is the
  other, so a candidate is compared union-to-union and draw-to-draw, never across.
- **An identical replay hits the prefix cache; a model comparison must not use the cached
  figure.** INC r2's own footer printed find `$0.1092` where the same 41 384→4 630 tokens cost
  `$0.2581` uncached. Production never replays an identical prompt, so a cached draw flatters a
  candidate for having been measured second. (This does not revive "the cache is a lever" — that
  finding is about consecutive runs on a live PR, where the diff and churn order change.)

## 2026-09-23, verify-judge parity — three judges on the filled 15-entry corpus, haiku as a negative control

A prior pass, on the 6-entry corpus before Tasks 1–3 of this stage filled it, found `gpt-5.5`
and `claude-sonnet-5` **identical** on `verify` — same union, same consensus, both wavering on
the same single entry. That corpus is now 15 entries, but stage 2's own findings say its
discriminating power is narrow: 11 of its 15 entries are quote-local — all 7 harvested `refuted`
entries carry their decisive construct inside the quoted span, as do 3 of the 4 constructed
shifts (the fourth, `D4t`, is the corpus's one whole-file probe — see the per-entry drill-down
below), and two of the four constructed shifts have the fix's own comment stating the resolution
in near-claim language. Re-running the same two near-equal judges on a corpus this shallow
cannot tell "the judges are equal" from "the instrument cannot
tell them apart." A third, deliberately weaker config settles which: **`claude-haiku-4-5-20251001`**,
over the same Anthropic OpenAI-compat endpoint (`https://api.anthropic.com/v1`), already known
weak on this pipeline as a *finder* (2 fabrications, six `out_of_scope`, and an empty findings
array across three 2026-09-23 draws).

`npm run verify-corpus -- --check`: **15/15 `ok`, exit 0** — every entry's `quote` still matches
its pinned tree byte-for-byte before anything was spent.

Corpus: 15 entries — 4 `confirmed` (all harvested, PR #418 D2/D3/D4/D5) and 11 `refuted` (7
harvested from the 2026-07 baseline, plus 4 constructed shifts D2t/D3t/D4t/D5t — see Tasks 1–3
of this stage for how each label was earned). Three draws per config, one
session, `OPENAI_API_ENDPOINT` switched between OpenAI and Anthropic between configs, the
incumbent re-measured here rather than read from the entry above (that entry scores a different
corpus — `find` recall on PR #418 — not this one).

| config | draw 1 | draw 2 | draw 3 | union | **consensus** | confirmed (consensus) | refuted (consensus) | tokens (prompt→completion) | cost |
|---|---|---|---|---|---|---|---|---|---|
| `gpt-5.5` (incumbent) | 15/15 | 15/15 | 15/15 | 15/15 | **15/15** | 4/4 | 11/11 | 115.9k→9.7k | $0.6849 (priced) |
| `claude-sonnet-5` | 15/15 | 15/15 | 14/15 | 15/15 | **14/15** | 4/4 | 10/11 | 188.8k→26.0k | $0.6376 (recomputed) |
| `claude-haiku-4-5-20251001` | 13/15 | 13/15 | 13/15 | 14/15 | **12/15** | 4/4 | 8/11 | 144.3k→4.5k | $0.1668 (recomputed) |

No `error` outcomes in any of the 9 draws — nothing excluded from the scored ratios.

### Per-entry drill-down

All four `confirmed` entries were unanimous — every config, every draw. They carry no signal
here (the design note's own prediction: a judge that never fakes reading the fix on the easy
half tells you nothing about the hard half). Three `refuted` entries were ever wrong, and only
those three:

- **`0728-358-1`** (harvested, 2026-07 baseline — the dropped-attachment/lost-query claim).
  `gpt-5.5`: refuted, refuted, refuted. `claude-sonnet-5`: refuted, refuted, **out_of_scope**
  (draw 3). `claude-haiku-4-5`: refuted, **confirmed**, **out_of_scope** — wrong in two directions
  in two of three draws. This is **not** the entry that wavered in the 6-entry pass — `0728-358-1`
  entered the corpus only in this branch (commit `d70e8b1`); the 6-entry waverer was
  `0723-344-1`, later deleted under the in-file evidence rule. The tie the 6-entry pass found is
  reproduced here, but by a different boundary entry, which strengthens rather than weakens the
  "reproduced, not overturned" reading below: two separate entries have now put both close
  judges on the same knife-edge. Caveat: the corpus's
  own schema excludes `out_of_scope` from labelled ground truth — "its correctness depends on
  the diff, and a label we cannot defend against the tree poisons the corpus" — so a flip to
  `out_of_scope` is scored as *not-refuted*, not necessarily proven wrong. It may be a
  defensible boundary call this corpus cannot adjudicate, not a fabrication. Deeper cause, found
  this pass: this entry's `claim` is an authored transcription of a softer, observability-class
  original ("could lead to loss of important information", "Consider logging…"), and its span was
  drawn to include the refuting `log.info` rather than around the rewrite alone — see the design
  doc's "Наше не лише проміжок" section. The judge's label rests on a sharpening it cannot see,
  which is a plausible mechanism for exactly this entry being the one two of three judges waver
  on.
- **`0923-418-D2t`** (constructed shift — `isLegalScope` cohort-laundering closed by
  `whereIsWholeClass`, expected `refuted`). `gpt-5.5` and `claude-sonnet-5`: refuted every draw.
  `claude-haiku-4-5`: **confirmed**, refuted, refuted — wrong once, then self-corrected.
- **`0923-418-D3t`** (constructed shift — proposed-issue scope guard, expected `refuted`
  because the tree's own comment reads "Guard 2 applies to a PROPOSED issue too"). `gpt-5.5`
  and `claude-sonnet-5`: refuted every draw. `claude-haiku-4-5`: **confirmed in all three
  draws** — the one non-noisy miss in this run. This entry's `why_expected` field warns in
  advance that answering `confirmed` here means the judge recognised the defect from memory
  rather than reading the tree; haiku did exactly that, every time.

### Cost, recomputed from tokens

`gpt-5.5` has a `PRICES` row, and the CLI's printed `$0.6849` is exactly what was billed — but
it is **not** the number to compare against sonnet's, because it is not fully uncached. Three
identical draws on this corpus hit OpenAI's prefix cache, and `PRICES['gpt-5.5']` prices cached
input at $0.5/1M against $5/1M uncached (`scripts/ai-review/usage.ts:84`). Solving the printed
total against the run's known prompt/completion split (115.9k → 9.7k) implies **≈41.2k of the
115.9k prompt tokens were billed at the cached rate** — a third of the input, from the three
repeated draws. This is exactly the trap the previous entry names twenty lines above, at line
594: "An identical replay hits the prefix cache; a model comparison must not use the cached
figure." An earlier draft of this section made that mistake anyway.

Fully uncached, `gpt-5.5` costs 115 900 × $5/1M + 9 700 × $30/1M = $0.5795 + $0.2910 =
**$0.8705** — the figure to compare against. The Anthropic compatibility endpoint offers no
equivalent prompt-caching discount, so sonnet's recomputed figure below has no cache in it at
all: it was already an apples-to-apples uncached number, and only the incumbent's side needed
correcting.

`claude-sonnet-5` and `claude-haiku-4-5-20251001` have no `PRICES` row, so the CLI prints
`(unpriced model)`; recomputed here at $2/$10 per 1M (sonnet) and $1/$5 per 1M (haiku), from the
same run's token totals (the CLI prints these at `formatTokens` resolution — nearest ~100 tokens
— not re-derived from a second paid run):

- **sonnet**: 188 800 × $2/1M + 26 000 × $10/1M = $0.3776 + $0.2600 = **$0.6376** — 73% of the
  incumbent's uncached $0.8705. **≈27% cheaper**, not the ~7% a comparison against the cached
  $0.6849 reads off, and still short of the ~60% the sticker prices ($2/$10 vs $5/$30) alone
  would suggest.
- **haiku**: 144 300 × $1/1M + 4 500 × $5/1M = $0.1443 + $0.0225 = **$0.1668** — 19% of the
  incumbent's uncached figure, **~81% cheaper**.

The trap is invisible in the tool's own output, which is why it is worth naming for the next
reader: `formatReport` prints `promptTokens` but never `cachedTokens`
(`scripts/ai-review/verify-corpus-report.ts:120-124`), so a cached discount cannot be seen in
the report a write-up is based on — it has to be solved for, as above, or read from the raw
usage object before the number is trusted.

Token ratios this session: sonnet/gpt-5.5 input = 188.8k/115.9k ≈ **1.63×**. That lands close to
the 1.65× measured 2026-09-23 on a small file (section 2 above), but that number is itself not
stable across workloads: the same estimate came out at **1.22×** on a real review prompt (the
callout at line 444). Three measurements now span **1.22×–1.65×** — wider a spread than
"consistent" implies, so each workload still needs its own check rather than reuse of any one of
them. Output ratio here is **2.68×** (26.0k/9.7k); the stage-2 plan logs **2.19×** on the same
verify workload measured earlier in that plan's own pass (`docs/superpowers/plans/2026-09/
2026-09-23-verify-corpus-stage-2.md`, step 4) — not logged anywhere in this document, so cited
rather than restated. The two probes measure different workloads (a single-file review call
there, 13 verify groups across the whole corpus here), and the multiplier moved with it.
**This is the point of recomputing rather than reusing the stored ratio** — it moved
by more than a fifth between two verify workloads. Net effect: sonnet's input markup eats into
the sticker discount but does not cancel it — corrected for the incumbent's own cached draws
(above), the two rates net to a real **≈27% saving** on this workload. A case for switching
`verify` to sonnet would be buying at a real, if modest, discount, not at parity.

Haiku's ratios run the other way: output 4.5k/9.7k ≈ **0.46×** (it writes shorter evidence, not
longer) and input 144.3k/115.9k ≈ **1.25×** (smaller than sonnet's) — consistent with a smaller
model producing terser, less hedged output.

### What this settles

**The corpus discriminates — the negative control was the point of this pass.**
`claude-haiku-4-5-20251001`, already known weak on this pipeline as a *finder*, scores **12/15
consensus** against the incumbent's clean **15/15**, and one of its three wrong entries
(`0923-418-D3t`) is wrong in all three draws, not just noisy. A blind instrument would not show
a bad judge as bad; this one did. That rules out "the instrument cannot tell judges apart" as
the explanation for `gpt-5.5` and `claude-sonnet-5` scoring close to each other — but it proves
only that the corpus can separate a much weaker judge from the incumbent. It does not prove the
corpus has the resolution to detect a *small* difference between two close judges; that is a
different, unanswered question, and the paragraph below does not claim it is answered.

**No certifiable divergence from `gpt-5.5`.** Sonnet's only deviation across all 45 judgments
(15 entries × 3 draws) is the single `refuted`→`out_of_scope` flip on `0728-358-1` — the one
entry the corpus's own design cannot certify as wrong, since it excludes `out_of_scope` from
labelled ground truth. Excluding an entry removes three judgments — one per draw — from **each**
judge, not just from sonnet's side: sonnet is **42/42** against the incumbent's **42/42**, an
exact tie on identical denominators, not the 44/44-vs-45/45 mismatched count an earlier draft of
this section reported. On every judgment this corpus can actually certify, the two judges are
still exactly tied. A corpus the negative control just proved is not blind **reproduces** the
6-entry tie
rather than overturning it. That is not the same as proving there is no small gap: the control
shows the instrument can catch a large difference, not that it can resolve a small one, so this
result neither confirms nor rules out a real, small gap between the two — it gives no evidence
of one.

**What would sharpen this further:** more draws on `0728-358-1` alone (5–6 rather than 3) would
say whether sonnet's `out_of_scope` flip recurs at a stable rate or was a single-draw event; a
second harvested entry testing that same `refuted`/`out_of_scope` boundary would say whether
this is one quirky entry or a class the corpus systematically under-tests. Neither is needed to
answer this pass's question — haiku's clean separation from the other two already proves the
corpus is not blind — but either would be needed to raise this corpus's resolution enough to
certify a small gap between the two close judges, if one exists.

**Not a recommendation to switch `verify` to `claude-sonnet-5`.** Cost is not the reason to
decline: recomputed above against the incumbent's own uncached figure (not its cached one),
sonnet runs **≈27% cheaper** on this workload — real, on a stage that is 38–47% of a review's
bill, but not large enough on its own to force the question, and not the reason to hold off
either way. The reason is methodological: this pass measures agreement with the incumbent's own
labelled verdicts, not real-PR recall or precision, and it inherits every caveat Tasks 1–3
already logged about this corpus. Most of its `refuted` half and all but one of its constructed
shifts are tests of "did you read the quoted span," not "did you read the whole file": **11 of
the corpus's 15 entries are quote-local** (10 of 11 `refuted`, 1 of 4 `confirmed`). The one
exception, `0923-418-D4t`, is a whole-file probe but a weak one — the `accepted` variable its
claim turns on is defined one line above the quote, under a comment that already states the fix
in near-claim language, the same weakness already flagged above for two of the four constructed
shifts. An instrument that admits what it cannot test is worth more here than a verdict it
cannot support.

**`0923-418-D3t` confirms, rather than reverses, Task 3's own prediction.** Task 3 built the
constructed shifts to separate "read the quote" from "read nothing," not a careful reader from
a merely literate one, and warned that a `confirmed` verdict on `D3t` would mean the judge
recognised the defect from memory instead of the tree. This run is the first data point on that
line, and it lands exactly there: `gpt-5.5` and `claude-sonnet-5` answered `D3t` correctly in
all 6 of their combined draws, while `claude-haiku-4-5` missed it in all 3 of its own — the
predicted "reads nothing" failure, reproduced in a model verdict rather than asserted. Recorded
so `D3t` is not later misread as evidence the shifts probe something beyond quote-reading; this
pass confirms they probe exactly what Task 3 said they would, no more.

**Against the stage's own stated criterion, this is unmet, and the entry should say so plainly.**
The stage-2 plan set the bar explicitly, before any measurement: "the corpus separates two
judges, or shows with adequate draws that they do not differ"
(`docs/superpowers/plans/2026-09/2026-09-23-verify-corpus-stage-2.md:17`). This pass did neither.
Summarised in the plan's own terms: the instrument is proven non-blind to a large gap (haiku's
12/15 against two clean 15/15s); no divergence between `gpt-5.5` and `claude-sonnet-5` was
detected at this resolution (42/42 vs 42/42 on everything this corpus can certify); the corpus's
discriminating surface is narrow (11 of 15 entries quote-local, and the one non-quote-local
`refuted` probe, `D4t`, is quote-adjacent rather than a deep whole-file read); three draws is not
"adequate draws" on a corpus whose small-gap resolution is explicitly unproven. **The stage's
stated criterion is unmet.** (The plan's other stage-2 item, updating `spec.md`, needs no
follow-up here: it was already satisfied in stage 1 — `spec.md:2349-2361` documents the CLI and
`--check` — so the plan's own "`spec.md` needs no change" line is correct, not a contradiction of
the design's stage-2 description.)
