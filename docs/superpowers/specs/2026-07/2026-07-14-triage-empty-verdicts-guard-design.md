# Triage empty-verdicts guard + raw I/O archive — design

**Date:** 2026-07-14
**Status:** approved (brainstorming) → ready for plan
**Area:** `src/jobs/orphan-triage.ts`, `src/infra/triage-llm.ts`, new `src/infra/triage-archive.ts`, `src/config/env.ts`, `src/index.ts`

## Problem

On 2026-07-14 the daily orphan-triage run pulled a 20-orphan batch, called
`llm.analyze(...)`, and the model returned an **empty verdicts array**
(`verdicts: []`). This passed schema validation (`AnalysisSchema.verdicts` is
`z.array(VerdictSchema)` with **no `.min(1)`**), so `planTriageActions` produced
an empty plan and the job finished as a silent no-op:

```
outcome: { total: 20, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
           skipped: 0, error: null, disabledReason: null }
```

Confirmed against prod DB: all 20 rows remain `review_class IS NULL`; nothing was
reviewed on 2026-07-14. The run finished in ~2s (vs ~55s on 2026-07-13 for a real
50-orphan batch) — consistent with a near-instant empty tool response. The LLM
call was still billed.

Two gaps:

1. **No signal.** An empty (or short) verdict set on a non-empty batch is
   indistinguishable in logs/digest from "nothing to do": `total=N, 0 actions,
   0 skipped, error=null`. The digest line reads `Тріаж: N нових` with no arrow —
   looks healthy while nothing happened.
2. **No diagnosis.** The raw LLM prompt/response is not logged anywhere, so the
   *why* (deliberate empty vs truncation vs refusal) could not be determined.

## Goals

- Detect and act on an empty verdict set on a non-empty batch.
- Preserve enough diagnostic trace to investigate future occurrences.
- Do not change behaviour for healthy runs.

## Non-goals (YAGNI)

- Retrying on partial shortfall (only full-empty retries).
- Prompt tuning / matcher/parser fixes for the underlying miss.
- Alerting outside the existing daily digest.
- Size-based archive rotation or compression.

## Decisions (from brainstorming)

- **Zero verdicts on a non-empty batch = loud error** escalated to the digest;
  **partial shortfall = `warn` log** noted for investigation, not escalated.
- On empty verdicts: **one immediate in-run retry** of `llm.analyze`. If the
  retry is also empty → close the day with `error` in the digest. (Cost: one
  extra call; user accepts — the failed call is still billed but bounded.)
- Anomaly path logs `stop_reason` + counts + a truncated raw payload.
- **Every run** archives the full prompt+response to a rotating file (`N=30`),
  directory from `TRIAGE_LOG_DIR` (unset ⇒ archive disabled; dev/tests silent).

## Architecture

Chosen seam (of three considered): **`analyze` returns a richer
`TriageExchange { analysis, raw }`** (explicit data flow, functional, testable).
Rejected: injecting a raw-sink callback (hidden side effect, mixes concerns);
archiving inside `triage-llm` (mixes transport with persistence, duplicates
across both providers, can't group retry attempts).

### 1. Job orchestration — `src/jobs/orphan-triage.ts`

After `listOpenIssues`, inside the existing `try` around the analysis:

1. `ex1 = await llm.analyze({ orphans, openIssues })`.
2. **Retry on empty:** if `ex1.analysis.verdicts.length === 0` → `log.warn(...)`
   and one retry `ex2 = await llm.analyze({ orphans, openIssues })` (reuse the
   same `openIssues`; no second GitHub fetch). Use `ex2`.
3. `covered = ` count of **distinct in-batch** `beer_id`s across the chosen
   analysis' verdicts (robust to hallucinated foreign ids — filter by `byId`).
4. **Zero-error:** if `covered === 0` (still empty after retry) →
   `outcome.error = 'LLM повернув 0 вердиктів (2 спроби)'`, archive, `finish(outcome)`,
   return. The digest renders `error` via existing `buildTriageLine`
   → `Тріаж: помилка (…)`. Day closes (unchanged `finish` semantics).
5. **Shortfall-warn:** else if `0 < covered < orphans.length` →
   `log.warn({ covered, batch: orphans.length }, 'orphan-triage: verdict shortfall')`.
   Then proceed with normal plan execution (no digest escalation; day closes
   normally).
6. Else: unchanged.

The zod schema is **not** changed — `verdicts` stays permissive (no `.min(1)`).
Rejecting empty in zod would surface it as a generic "analysis failed" error and
lose the explicit retry/error handling above.

`covered` is computed from the analysis, before `planTriageActions`. It counts
distinct batch beer_ids so hallucinated foreign ids don't mask a real shortfall.

### 2. LLM interface — `src/infra/triage-llm.ts`

```ts
export interface TriageRaw {
  prompt: string;                       // buildTriagePrompt(input)
  response: unknown;                    // raw Anthropic message / OpenAI JSON body
  stopReason: string | null;
  provider: 'anthropic' | 'openai';
}
export interface TriageExchange { analysis: Analysis; raw: TriageRaw; }
export interface TriageLlm { analyze(input: TriageInput): Promise<TriageExchange>; }
```

- **Anthropic:** `prompt = buildTriagePrompt(input)`, `response = res`,
  `stopReason = res.stop_reason`, `provider = 'anthropic'`. Existing guards
  (`max_tokens` truncation, missing `tool_use`) still **throw before** building
  the exchange — a transport error takes the normal error path and has no archive
  entry for that attempt (acceptable). `parseAnalysis(block.input)` → `analysis`.
- **OpenAI:** `response = ` parsed JSON body (fallback raw `content`),
  `stopReason = data.choices?.[0]?.finish_reason ?? null`, `provider = 'openai'`.
- **Empty verdicts are not a transport error:** `analyze` returns a successful
  `TriageExchange` with `analysis.verdicts = []`; the retry/error decision is the
  job's (§1). `stopReason` is the key diagnostic (e.g. `end_turn` vs `tool_use`
  vs `max_tokens`).

### 3. Archive — new `src/infra/triage-archive.ts`

```ts
export interface TriageArchive {
  write(dateKey: string, payload: unknown): Promise<void>;  // best-effort, never throws
}
export function createTriageArchive(
  cfg: { dir: string; keep?: number },
  log: pino.Logger,
): TriageArchive | null;   // null when dir is empty/unset
```

- **Writes** one file per run: `${dir}/${dateKey}.json`, content
  `{ dateKey, ranAt, batchSize, exchanges: [ex1, ex2?] }` — both retry attempts in
  one file, each with full `prompt` + `response` + `stopReason`. One run/day, so
  overwriting the same name is fine.
- **Rotation:** after write, list `*.json`, keep the **30** newest by name
  (`YYYY-MM-DD` sorts lexicographically = chronologically), delete the rest.
  `keep` defaults to 30.
- **Best-effort:** all fs work (mkdir/write/rotate) wrapped in `try/catch` →
  `log.warn({ err }, 'triage-archive: write failed')`, never breaks the run.
- **Disabled:** `createTriageArchive` returns `null` when `dir` is empty.

### 4. Config — `src/config/env.ts`

```ts
TRIAGE_LOG_DIR: z.string().optional(),   // e.g. /var/lib/warsaw-beer-bot/triage-logs; unset ⇒ archive off
```

Not added to `requiredFor`/disables — optional diagnostic, not a run condition.

### 5. Wiring — `src/index.ts`

- Create `const triageArchive = createTriageArchive({ dir: env.TRIAGE_LOG_DIR ?? '' }, log)`
  next to `triageLlm` (~line 128).
- Extend `OrphanTriageDeps` with `archive: TriageArchive | null`.
- Pass `archive: triageArchive` at both call sites (cron tick ~247, startup
  catch-up ~270).
- In the job, after any LLM call, best-effort
  `await deps.archive?.write(dateKey, { dateKey, ranAt: nowIso, batchSize: orphans.length, exchanges })`
  — including the zero-error path (where the archive is most valuable).

## Data flow

```
cron tick → orphanTriage
  listOpenIssues
  ex1 = analyze()                      ┐ archive collects exchanges
  if verdicts empty: warn + ex2 = analyze()  ┘
  covered = distinct in-batch verdict beer_ids
  covered == 0  → outcome.error, archive, finish (digest: помилка)
  covered <  N  → warn(shortfall), continue normal plan
  else          → normal plan
  archive.write(dateKey, {…, exchanges})   (best-effort, every run w/ an LLM call)
  finish(outcome)
```

## Testing (Vitest, TDD)

- **`triage-archive.test.ts`**: writes file to a temp dir; rotation keeps exactly
  the 30 newest; returns `null` when dir empty; fs error → `warn`, does not throw.
- **`triage-llm.test.ts`** (update): both providers return `TriageExchange` with
  correct `raw.stopReason` / `provider`; empty verdicts still return successfully.
- **`orphan-triage.test.ts`**:
  - (a) empty verdicts → `analyze` called **twice**; still empty → `outcome.error`
    set, day closed;
  - (b) empty then non-empty retry → normal processing, `analyze` called twice;
  - (c) shortfall (`0 < covered < batch`) → `warn` logged, plan executed normally;
  - (d) `archive.write` called with both exchanges.

## Docs / spec

- Update `spec.md` orphan-triage section (if it documents this behaviour):
  retry-on-empty, zero = digest error, shortfall warn, `TRIAGE_LOG_DIR` archive.
- `extension/**` untouched ⇒ `docs/extension-install-uk.md` not affected.
- Env-ops reference note: add `TRIAGE_LOG_DIR` to prod `.env`
  (`/var/lib/warsaw-beer-bot/triage-logs`).

## Ops rollout

Manual prod `.env` edit (as bot user): add
`TRIAGE_LOG_DIR=/var/lib/warsaw-beer-bot/triage-logs`. Archive is off until set,
so deploy is safe without it; behaviour guard (retry/error/shortfall) is active
regardless.
