import type pino from 'pino';
import type { DB } from '../storage/db';
import { getJobState, setJobState } from '../storage/job_state';
import {
  listUntriagedFailures, setEnrichFailureReview, type UntriagedFailure,
} from '../storage/enrich_failures';
import type { TriageLlm } from '../infra/triage-llm';
import type { GithubIssuesClient } from '../infra/github-issues';
import { planTriageActions } from '../domain/triage-plan';
import type { Verdict } from '../domain/triage-analysis';
import { warsawDateAndHour } from '../domain/warsaw-time';

export const TRIAGE_LAST_RUN_KEY = 'orphan_triage_last_run';
export const TRIAGE_LAST_RESULT_KEY = 'orphan_triage_last_result';
export const TRIAGE_LABEL = 'orphan-triage';
export const TRIAGE_BATCH_LIMIT = 50;

// Non-Error throws (strings, objects) must not escape our catch blocks — the
// run-marked-for-the-day guarantee depends on finish() always being reached.
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  error: string | null;
  disabledReason: string | null;
}

export function buildTriageLine(o: TriageOutcome): string {
  if (o.disabledReason) return `Тріаж: вимкнено (${o.disabledReason})`;
  if (o.error) return `Тріаж: помилка (${o.error})`;
  const parts: string[] = [
    ...o.commented.map((c) => `${c.count} до #${c.issueNumber}`),
    ...o.created.map((c) => `${c.count} нова #${c.issueNumber}`),
  ];
  if (o.notOnUntappd > 0) parts.push(`${o.notOnUntappd} not_on_untappd`);
  if (o.wontfix > 0) parts.push(`${o.wontfix} wontfix`);
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
  now?: () => Date;
}

// Daily orphan triage. Cron-safe: window + job_state make it run once per Warsaw
// day. The LLM proposes; planTriageActions validates; this function executes with
// GitHub-first-DB-second ordering so a GitHub failure leaves orphans untriaged
// (they re-enter tomorrow's batch). Result line is persisted for the digest.
export async function orphanTriage(deps: OrphanTriageDeps): Promise<void> {
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
    skipped: 0, error: null, disabledReason: null,
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
  try {
    const openIssues = await github.listOpenIssues(TRIAGE_LABEL);
    const analysis = await llm.analyze({ orphans, openIssues });
    plan = planTriageActions(analysis, openIssues.map((i) => i.number), [...byId.keys()]);
  } catch (e) {
    log.error({ err: e }, 'orphan-triage: analysis failed');
    finish({ ...outcome, error: errMessage(e).slice(0, 120) });
    return;
  }
  outcome.skipped = plan.skipped;

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
}
