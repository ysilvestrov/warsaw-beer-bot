# Daily orphan-triage agent — design

**Date:** 2026-07-05
**Status:** approved
**Related:** `enrich_failures` (schema v10–v12), `docs/debug-orphan-matching.md`,
#228/#229 (manually filed triage issues), daily-status digest job

## Problem

Orphan triage — reading `enrich_failures`, clustering failures into patterns
(alias gaps, parser bugs, query noise, not-on-Untappd), and filing GitHub issues
for the actionable ones — is done manually today. It is repetitive, data-driven
work that goes stale quickly: new orphans accumulate daily, and patterns (e.g.
Nepomucen→Nepo Brewing, nano-noise #228) sit unnoticed until someone runs the
runbook in `docs/debug-orphan-matching.md`.

## Goal

A daily job inside the bot process that:

1. reads the newest untriaged orphans from `enrich_failures`,
2. sends them (plus the currently open triage issues) to an LLM for
   classification and pattern-clustering,
3. creates or updates GitHub issues for actionable classes,
4. writes the verdicts back to `enrich_failures.review_class` / `review_note`,
5. reports a one-line summary in the daily-status Telegram digest.

**Out of scope:** fixing anything. The agent is an analyst; fixes are made later
by a human-driven local agent working from the filed issues. The job never
touches matcher code, aliases, or the backoff state.

## Separation of duties

- **Triage agent (this design):** data analysis and pattern finding only.
  Input: DB rows + open issues. Output: issues + `review_class` writebacks.
- **Fix agent (existing workflow):** a local Claude Code session with repo
  access picks up an `orphan-triage` issue, implements, and PRs.
- **Human:** decision-making moves to the GitHub issue level (accept, reject,
  deprioritize). Raw-failure classification is fully automatic — no
  `review_source` distinction is kept.

## Data flow

```
enrich_failures ──(1) select ──► orchestrator ──(2) fetch open issues ──► GitHub
                                     │
                                     ▼ (3) analyze (LLM, structured output)
                              verdict per orphan
                                     │
                     ┌───────────────┼──────────────────┐
                     ▼ (4a)          ▼ (4b)             ▼ (4c)
              comment on issue  create new issue   no issue (not_on_untappd /
                     │               │              wontfix)
                     └───────┬───────┘                  │
                             ▼ (5)                      ▼ (5)
                  write review_class + review_note to enrich_failures
                             │
                             ▼ (6)
                  digest line for daily-status
```

### 1. Selection

```sql
SELECT beer_id, brewery, name, search_url, source_url,
       candidates_count, candidates_summary, fail_count, last_at
FROM enrich_failures
WHERE review_class IS NULL AND outcome = 'not_found'
ORDER BY last_at DESC
LIMIT 50
```

- **Newest first** — the fresh signal is triaged before the stale backlog; the
  old tail drains over subsequent days instead of blocking new patterns.
- **`blocked` rows are excluded** — they indicate proxy/ban trouble, not a
  matching problem, and are handled by the breaker/rotation machinery.
- **Cap of 50 rows** bounds token usage per run (~10k input tokens).
- Zero rows ⇒ the job exits early and the digest line says there was nothing
  to triage.

### 2. GitHub context

Fetch all **open** issues labeled `orphan-triage` (number, title, body,
labels) via GitHub REST. These are passed to the LLM so it can decide
"existing pattern" vs "new pattern".

### 3. LLM analysis

One request per run. The prompt contains: the runbook-style classification
guide, the open-issue list, and the 50 orphan rows. The model returns, per
orphan, a structured verdict:

```ts
type Verdict = {
  beer_id: number;
  review_class: 'parser_bug' | 'matcher_bug' | 'not_on_untappd' | 'wontfix';
  review_note: string;            // short human-readable reason
  action:
    | { kind: 'none' }                                  // non-actionable classes
    | { kind: 'existing_issue'; issue_number: number }  // add as example
    | { kind: 'new_issue'; key: string };               // ref into new_issues
};
type Analysis = {
  verdicts: Verdict[];
  new_issues: Record<string, {           // keyed by Verdict.action.key
    title: string;
    body: string;
    labels: string[];                    // subset of allowed labels
  }>;
};
```

Structured output is enforced (Anthropic: tool-use with `strict` schema;
OpenAI: JSON mode + client-side validation).

### 4. Execution & validation (script-owned side effects)

The LLM only **proposes**; the script validates and executes:

- `review_class` must be one of the four CHECK-listed values.
- `existing_issue` numbers must be in the fetched open-issue list; anything
  else ⇒ that orphan is skipped (left `NULL` for tomorrow).
- **New-issue cap: 3 per run** — a guard against hallucinated issue spam. New
  issues beyond the cap are dropped; their orphans are skipped.
- Labels are forced to `orphan-triage` + (`parser-bug` | `matcher-bug`)
  regardless of what the model proposed.
- `not_on_untappd` / `wontfix` verdicts never produce GitHub activity.
- **Order per orphan: GitHub first, DB second.** If the GitHub call fails, the
  orphan stays untriaged and is retried next day. Comments batch per issue
  ("+N new examples" with a table) rather than one comment per orphan.

### 5. DB writeback

`UPDATE enrich_failures SET review_class = ?, review_note = ? WHERE beer_id = ?`.
The `review_note` includes the issue reference when one exists (e.g.
`"nano-noise cluster → #228"`). Rows with `review_class` set are excluded from
future selection — the DB itself is the triage state.

### 6. Digest line

The daily-status digest gains a triage line, e.g.:

```
Тріаж: 7 нових → 2 до #228, 1 нова #232, 3 not_on_untappd, 1 пропущено
```

Failure modes are surfaced there too: `Тріаж: помилка (LLM invalid JSON)`,
`Тріаж: вимкнено (нема GITHUB_TOKEN)`. The job runs shortly **before** the
daily-status window so the line lands in the same day's digest; the digest
reads the result from `job_state` rather than the jobs being coupled in-process.

## LLM provider abstraction

Cost control requirement: the model must be swappable via prod `.env` without
a deploy.

```ts
interface TriageLlm {
  analyze(input: TriageInput): Promise<Analysis>; // throws on transport error
}
```

Two implementations:

- **Anthropic** (`@anthropic-ai/sdk`): Messages API, tool-use with a strict
  JSON schema; `ANTHROPIC_API_KEY`.
- **OpenAI** (reuse the plain-fetch style of `scripts/ai-pr-review.ts`): chat
  completions with JSON mode; `OPENAI_API_KEY` (already funded for PR review).

Env configuration:

| Var | Default | Meaning |
|---|---|---|
| `TRIAGE_LLM_PROVIDER` | `anthropic` | `anthropic` \| `openai` |
| `TRIAGE_LLM_MODEL` | `claude-opus-4-8` | model id passed through verbatim |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | per provider |
| `GITHUB_TOKEN` | — | repo-scoped token for issue create/comment/list |

Default is `claude-opus-4-8`: the task is "find a non-obvious pattern in noisy
data", volume is tiny (~$0.15/run ≈ $4.5/mo at 50 orphans/day), and a cheaper
model that files false-positive issues costs more in human time (cf. #175 for
gpt-4o-mini's hallucination rate on PR review). Cheaper alternatives
(`claude-haiku-4-5` ≈ $1/mo, `claude-sonnet-5` ≈ $2–3/mo) are one `.env` edit
away.

Missing keys are not fatal: the job logs a skip, writes the skip reason to
`job_state`, and the digest reports it. The bot must start and run normally
without any of these vars.

## Scheduling

Same pattern as daily-status (see `reference_server_timezone` gotcha — the
node-cron `{timezone}` pin is flaky):

- node-cron fires on a **UTC tick**;
- the job checks the **Warsaw-local window** internally;
- `job_state` provides idempotency (one successful run per local day) and
  startup catch-up after deploy restarts.

Run window: early morning Warsaw time, before the daily-status digest, so the
digest line is fresh.

## Modules

| Module | Responsibility |
|---|---|
| `src/jobs/orphan-triage.ts` | Orchestration: select → fetch issues → analyze → execute → writeback → job_state result |
| `src/domain/triage-analysis.ts` | Prompt construction, `TriageLlm` interface + Anthropic/OpenAI implementations, response parsing & schema validation |
| `src/infra/github-issues.ts` | `listOpenIssues(label)`, `createIssue`, `commentOnIssue` via GitHub REST (fetch, no new deps) |
| `src/storage/enrich_failures.ts` (extend) | `selectUntriaged(limit)`, `writeReview(beerId, cls, note)` |
| daily-status (extend) | render triage line from `job_state` |

All side-effectful collaborators (LLM, GitHub, clock) are injected so the
orchestrator is unit-testable; live APIs are never called from tests.

## Error handling

| Failure | Behavior |
|---|---|
| Missing API keys | Skip run, record reason, digest shows "вимкнено" |
| LLM transport error / invalid JSON / schema violation | Abort run, nothing written, digest shows error; retry is tomorrow's run |
| Invalid verdict (bad class, unknown issue #) | Skip that orphan only, count in digest as `пропущено` |
| GitHub create/comment fails | Skip affected orphans (no DB write), count as `пропущено` |
| DB write fails after GitHub succeeded | Log loudly; worst case the orphan is re-triaged tomorrow and the LLM sees the issue already covers it (idempotent-ish; comment may duplicate once) |

No in-run retries — the daily cadence is the retry loop.

## Testing (Vitest)

- **Verdict validation:** rejects unknown classes, unknown issue numbers,
  enforces the 3-new-issues cap, forces labels.
- **Side-effect ordering:** GitHub failure ⇒ no `review_class` write; GitHub
  success + DB failure ⇒ error surfaced.
- **Selection:** newest-50, `blocked` and already-reviewed rows excluded.
- **Digest line rendering:** counts, error and skip variants.
- **Provider parsing:** both `TriageLlm` implementations parse/reject fixture
  responses correctly (HTTP mocked).

## Documentation updates (same PR)

- `spec.md`: new section describing the triage job (per OpenSpec rule).
- `docs/debug-orphan-matching.md`: note that first-pass triage is automated;
  manual runbook remains for deep-dives and disputes.
- No `extension/**` changes ⇒ `docs/extension-install-uk.md` untouched.

## Ops notes

- `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` must be added to prod `.env`
  **manually** (as with `WEBSHARE_PROXY`; edit as the bot user — see
  `reference_env_config_ops`).
- The `orphan-triage`, `parser-bug`, `matcher-bug` labels must exist in the
  GitHub repo; the job creates issues with them but does not create labels.
