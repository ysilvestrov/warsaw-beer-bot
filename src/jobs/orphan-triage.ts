import type pino from 'pino';
import type { DB } from '../storage/db';
import { getJobState, setJobState } from '../storage/job_state';
import {
  listUntriagedFailures, setEnrichFailureReview, type UntriagedFailure,
} from '../storage/enrich_failures';
import type { TriageLlm, TriageExchange } from '../infra/triage-llm';
import type { GithubIssuesClient } from '../infra/github-issues';
import type { TriageArchive } from '../infra/triage-archive';
import { planTriageActions } from '../domain/triage-plan';
import { collectTriageProbes } from '../domain/triage-probes';
import { verifyCauses, isCausal } from '../domain/triage-verify';
import type { BeerSearch } from '../sources/untappd/search';
import type { Analysis, Verdict } from '../domain/triage-analysis';
import { warsawDateAndHour } from '../domain/warsaw-time';

export const TRIAGE_LAST_RUN_KEY = 'orphan_triage_last_run';
export const TRIAGE_LAST_RESULT_KEY = 'orphan_triage_last_result';
export const TRIAGE_LABEL = 'orphan-triage';
export const TRIAGE_ATTEMPTS_KEY = 'orphan_triage_attempts';
// Transient upstream failures (5xx/429/network) do not consume the Warsaw day —
// the next 15-min tick inside [06:00,09:00) retries. Bounded at 3 because each
// attempt costs a full probe budget (up to 120 Untappd searches) plus a
// 50-orphan LLM call; the window itself would allow ~12 (#316).
export const TRIAGE_MAX_ATTEMPTS = 3;
export const TRIAGE_BATCH_LIMIT = 50;
// Shared budget for evidence probes and cause verification, in Untappd searches
// per run. ~50 zero-candidate rows x 2 probes + up to 50 verifications fits; 0
// disables both paths and the job behaves as it did before the evidence pipeline.
export const TRIAGE_PROBE_LIMIT_DEFAULT = 120;

// Non-Error throws (strings, objects) must not escape our catch blocks — the
// run-marked-for-the-day guarantee depends on finish() always being reached.
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Re-entrancy guard: a run slower than the 15-min cron tick must not overlap
// with the next tick (duplicate GitHub issues/comments). Module-level is fine —
// the bot is a single process.
let triageRunning = false;

// Same Warsaw-window pattern as daily-status, but earlier — [06:00,09:00) — so
// the result line is ready before the digest window [09:00,12:00).
export function shouldRunTriage(args: {
  now: Date; lastRunDate: string | null;
  windowStartHour?: number; windowEndHour?: number;
}): { run: boolean; dateKey: string } {
  const { now, lastRunDate, windowStartHour = 6, windowEndHour = 9 } = args;
  const { date, hour } = warsawDateAndHour(now);
  const inWindow = hour >= windowStartHour && hour < windowEndHour;
  return { run: inWindow && lastRunDate !== date, dateKey: date };
}

export interface TriageOutcome {
  total: number;
  commented: { issueNumber: number; count: number }[];
  created: { issueNumber: number; count: number }[];
  notOnUntappd: number;
  wontfix: number;
  skipped: number;
  unverified: number;   // causal verdicts whose proposed query did not reproduce the target
  error: string | null;
  // Attempt number for a retriable failure (1-based); null for success,
  // disabled runs and permanent errors.
  attempt: number | null;
  disabledReason: string | null;
}

export function buildTriageLine(o: TriageOutcome): string {
  if (o.disabledReason) return `Тріаж: вимкнено (${o.disabledReason})`;
  if (o.error) {
    if (o.attempt === null) return `Тріаж: помилка (${o.error})`;
    return o.attempt < TRIAGE_MAX_ATTEMPTS
      ? `Тріаж: тимчасова помилка (${o.error}), спроба ${o.attempt}/${TRIAGE_MAX_ATTEMPTS}`
      : `Тріаж: помилка (${o.error}, ${o.attempt} спроби)`;
  }
  const parts: string[] = [
    ...o.commented.map((c) => `${c.count} до #${c.issueNumber}`),
    ...o.created.map((c) => `${c.count} нова #${c.issueNumber}`),
  ];
  if (o.notOnUntappd > 0) parts.push(`${o.notOnUntappd} not_on_untappd`);
  if (o.wontfix > 0) parts.push(`${o.wontfix} wontfix`);
  if (o.unverified > 0) parts.push(`${o.unverified} неперевірених`);
  if (o.skipped > 0) parts.push(`${o.skipped} пропущено`);
  return `Тріаж: ${o.total} нових${parts.length ? ` → ${parts.join(', ')}` : ''}`;
}

function exampleTable(verdicts: Verdict[], orphans: Map<number, UntriagedFailure>): string {
  const rows = verdicts.map((v) => {
    const o = orphans.get(v.beer_id);
    return `| ${v.beer_id} | ${o?.brewery ?? '?'} | ${o?.name ?? '?'} | ${v.review_class} | ${v.review_note} |`;
  });
  return ['| beer_id | brewery | name | class | note |', '|---|---|---|---|---|', ...rows].join('\n');
}

export interface OrphanTriageDeps {
  db: DB;
  log: pino.Logger;
  llm: TriageLlm | null;
  github: GithubIssuesClient | null;
  archive?: TriageArchive | null;
  // Evidence probes + cause verification. Optional: without it the job runs exactly
  // as it did before the evidence pipeline (no probes, no verification gate).
  search?: BeerSearch | null;
  probeLimit?: number;
  now?: () => Date;
}

// Daily orphan triage. Cron-safe: window + job_state make it run once per Warsaw
// day. The LLM proposes; planTriageActions validates; this function executes with
// GitHub-first-DB-second ordering so a GitHub failure leaves orphans untriaged
// (they re-enter tomorrow's batch). Result line is persisted for the digest.
export async function orphanTriage(deps: OrphanTriageDeps): Promise<void> {
  if (triageRunning) {
    deps.log.debug('orphan-triage: previous run still in progress, skipping tick');
    return;
  }
  triageRunning = true;
  try {
    const { db, log, llm, github } = deps;
    const now = (deps.now ?? (() => new Date()))();
    const { run, dateKey } = shouldRunTriage({ now, lastRunDate: getJobState(db, TRIAGE_LAST_RUN_KEY) });
    if (!run) return;

    const finish = (outcome: TriageOutcome): void => {
      setJobState(db, TRIAGE_LAST_RUN_KEY, dateKey);
      setJobState(db, TRIAGE_LAST_RESULT_KEY,
        JSON.stringify({ date: dateKey, line: buildTriageLine(outcome) }));
      log.info({ outcome, dateKey }, 'orphan-triage finished');
    };
    const empty: TriageOutcome = {
      total: 0, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
      skipped: 0, unverified: 0, error: null, attempt: null, disabledReason: null,
    };

    if (!llm || !github) {
      finish({ ...empty, disabledReason: !llm ? 'нема ключа LLM' : 'нема GITHUB_TOKEN' });
      return;
    }

    const orphans = listUntriagedFailures(db, TRIAGE_BATCH_LIMIT);
    if (orphans.length === 0) {
      finish(empty);
      return;
    }
    const byId = new Map(orphans.map((o) => [o.beer_id, o]));
    const outcome: TriageOutcome = { ...empty, total: orphans.length };
    const nowIso = now.toISOString();

    let plan;
    let analysis: Analysis;
    let unverified = 0;
    let probeFailures = 0;
    let verifyFailures = 0;
    let causesChecked = 0;
    const exchanges: TriageExchange[] = [];
    const probeLimit = deps.probeLimit ?? TRIAGE_PROBE_LIMIT_DEFAULT;
    try {
      const openIssues = await github.listOpenIssues(TRIAGE_LABEL);
      // Deterministic evidence first: without it the model is asked to explain a
      // zero-candidate search with nothing but the query string, which is where its
      // wrong hypotheses come from (2026-07-28 review).
      const probes = deps.search
        ? await collectTriageProbes({
            orphans, search: deps.search, limit: probeLimit,
            onError: (query, err) => {
              probeFailures += 1;
              log.warn({ err, query }, 'orphan-triage: probe failed');
            },
          })
        : new Map();
      const ex1 = await llm.analyze({ orphans, openIssues, probes });
      exchanges.push(ex1);
      // An empty verdict set on a non-empty batch is anomalous (the prompt asks
      // for a verdict per orphan). Retry once against the same open-issues set.
      // Only a fully-empty array retries; a non-empty array of only foreign
      // (hallucinated) ids falls through to the covered===0 error below.
      if (ex1.analysis.verdicts.length === 0) {
        log.warn({ batch: orphans.length, stopReason: ex1.raw.stopReason },
          'orphan-triage: empty verdicts, retrying once');
        const ex2 = await llm.analyze({ orphans, openIssues, probes });
        exchanges.push(ex2);
      }
      analysis = exchanges[exchanges.length - 1].analysis;
      // A cause the model cannot prove must not reach GitHub: re-run its proposed
      // query and, if the expected target does not come back, strip the issue
      // attachment and keep only the classification.
      if (deps.search) {
        const verified = await verifyCauses({
          verdicts: analysis.verdicts, search: deps.search, limit: probeLimit,
          onError: (query, err) => {
            verifyFailures += 1;
            log.warn({ err, query }, 'orphan-triage: verification failed');
          },
        });
        causesChecked = verified.size;
        analysis = {
          ...analysis,
          verdicts: analysis.verdicts.map((v) => {
            if (!isCausal(v) || verified.get(v.beer_id)) return v;
            unverified += 1;
            log.info({ beerId: v.beer_id, query: v.proposed_query, expected: v.expected_target },
              'orphan-triage: cause unverified, attachment dropped');
            return {
              ...v, issue_number: null, new_issue_key: null,
              review_note: `unverified: ${v.review_note}`,
            };
          }),
        };
      }
      // One line per run summarising how much evidence actually reached the model.
      // The 2026-08-04 quality review compares these against the pre-change baseline,
      // and a run where every probe failed (breaker open) must be visible as such —
      // its verdicts were made blind, even though the verification gate still blocks
      // unproven causes from reaching GitHub.
      if (deps.search) {
        log.info({ rowsWithEvidence: probes.size, probeFailures, causesChecked, unverified, verifyFailures },
          'orphan-triage: evidence summary');
      }
      plan = planTriageActions(analysis, openIssues.map((i) => i.number), [...byId.keys()]);
    } catch (e) {
      log.error({ err: e }, 'orphan-triage: analysis failed');
      await deps.archive?.write(dateKey, { dateKey, ranAt: nowIso, batchSize: orphans.length, exchanges });
      finish({ ...outcome, error: errMessage(e).slice(0, 120) });
      return;
    }

    // Every run with an LLM call is archived — the zero-verdict path most of all.
    await deps.archive?.write(dateKey, { dateKey, ranAt: nowIso, batchSize: orphans.length, exchanges });

    // Distinct in-batch beer_ids that actually got a verdict (ignores any
    // hallucinated foreign ids the model may echo from open-issue bodies).
    const covered = new Set(
      analysis.verdicts.map((v) => v.beer_id).filter((id) => byId.has(id)),
    ).size;
    if (covered === 0) {
      log.error({ batch: orphans.length, stopReasons: exchanges.map((e) => e.raw.stopReason) },
        'orphan-triage: zero verdicts after retry');
      finish({ ...outcome, error: `LLM повернув 0 вердиктів (${exchanges.length} спроб)` });
      return;
    }
    if (covered < orphans.length) {
      log.warn({ covered, batch: orphans.length }, 'orphan-triage: verdict shortfall');
    }
    outcome.skipped = plan.skipped;
    outcome.unverified = unverified;

    const review = (v: Verdict, issueNumber: number | null): void => {
      const note = issueNumber === null ? v.review_note : `${v.review_note} → #${issueNumber}`;
      if (!setEnrichFailureReview(db, v.beer_id, v.review_class, note, nowIso)) {
        // Row self-cleared between selection and write (the beer matched meanwhile).
        log.warn({ beerId: v.beer_id }, 'orphan-triage: review write no-op (row gone)');
      }
    };

    for (const issue of plan.newIssues) {
      try {
        const number = await github.createIssue({ title: issue.title, body: issue.body, labels: issue.labels });
        issue.verdicts.forEach((v) => review(v, number));
        outcome.created.push({ issueNumber: number, count: issue.verdicts.length });
      } catch (e) {
        log.error({ err: e, key: issue.key }, 'orphan-triage: createIssue failed');
        outcome.skipped += issue.verdicts.length;
      }
    }

    for (const c of plan.comments) {
      try {
        const body = `Автотріаж ${dateKey}: +${c.verdicts.length} нових прикладів\n\n${exampleTable(c.verdicts, byId)}`;
        await github.commentOnIssue(c.issueNumber, body);
        c.verdicts.forEach((v) => review(v, c.issueNumber));
        outcome.commented.push({ issueNumber: c.issueNumber, count: c.verdicts.length });
      } catch (e) {
        log.error({ err: e, issue: c.issueNumber }, 'orphan-triage: comment failed');
        outcome.skipped += c.verdicts.length;
      }
    }

    for (const v of plan.quiet) {
      review(v, null);
      if (v.review_class === 'not_on_untappd') outcome.notOnUntappd++;
      else outcome.wontfix++;
    }

    finish(outcome);
  } finally {
    triageRunning = false;
  }
}
