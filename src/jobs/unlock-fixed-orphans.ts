import type pino from 'pino';
import type { DB } from '../storage/db';
import type { GithubIssuesClient } from '../infra/github-issues';
import { listLockedRows, markUnlocked } from '../storage/enrich_failures';
import { rearmLookup } from '../storage/beers';
import { getJobState, setJobState } from '../storage/job_state';
import { warsawDateAndHour } from '../domain/warsaw-time';
import { TRIAGE_LABEL } from './orphan-triage';

export const UNLOCK_LAST_RUN_KEY = 'unlock_fixed_orphans_last_run';

// listOpenIssues fetches per_page=100 without pagination, so a FULL page may be a truncated
// open set — and a truncated open set reads as "these issues closed", unlocking rows in bulk
// against issues that are merely on page two. The guard trades a skipped day (harmless: the
// job is idempotent and runs again within the hour) for that corpus-wide write. 15 open
// today; the guard exists because the failure would be silent.
export const OPEN_ISSUE_PAGE_LIMIT = 100;

export interface UnlockDeps {
  db: DB;
  log: pino.Logger;
  github: GithubIssuesClient | null;
  now?: () => Date;
}

export interface UnlockOutcome {
  unlocked: number;
  issuesClosed: number;
  skippedReason: string | null;
  error: string | null;
}

// #421: an actionable verdict is a settled question while the issue it names is open. This
// job is the only thing that turns external GitHub state into the local fact the pool
// queries read (`enrich_failures.unlocked_at`) — the pools themselves can never ask GitHub.
//
// The trigger is deliberately coarse: "the issue left the open set", not "a fix shipped".
// GitHub cannot tell us the latter (checked: closedByPullRequestsReferences is empty across
// the whole referenced set, and stateReason records how the close button was clicked — #319
// is NOT_PLANNED with its fix deployed, #255 is COMPLETED having only been decomposed). The
// ambiguity is paid for in quota instead of cleverness: a close that was really a
// decomposition costs ONE lookup per row, against the four the old timer burned on a
// schedule that could not succeed.
//
// Once per Warsaw day via job_state, on the same UTC-tick pattern as orphan-triage and
// daily-status — node-cron's timezone pin is unreliable on this host. Kept separate from
// orphan-triage despite sharing the listOpenIssues call: triage's failure path is the most
// intricate in this codebase (transient retry, day-burning, #316), and a job that writes to
// `beers` must not be able to take triage down or be taken down by it.
export async function unlockFixedOrphans(deps: UnlockDeps): Promise<UnlockOutcome> {
  const { db, log, github } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { date } = warsawDateAndHour(now);
  const empty: UnlockOutcome = { unlocked: 0, issuesClosed: 0, skippedReason: null, error: null };

  if (getJobState(db, UNLOCK_LAST_RUN_KEY) === date) {
    return { ...empty, skippedReason: 'done_today' };
  }
  if (!github) return { ...empty, skippedReason: 'github_disabled' };

  const locked = listLockedRows(db);
  if (locked.length === 0) {
    setJobState(db, UNLOCK_LAST_RUN_KEY, date);
    return empty;
  }

  let open;
  try {
    open = await github.listOpenIssues(TRIAGE_LABEL);
  } catch (e) {
    // The day is NOT closed: a transient GitHub failure must not cost every locked row a
    // day of reachability. The next hourly tick retries (#316's lesson, applied here).
    const error = e instanceof Error ? e.message : String(e);
    log.error({ err: e }, 'unlock-fixed-orphans: listOpenIssues failed');
    return { ...empty, error };
  }

  if (open.length >= OPEN_ISSUE_PAGE_LIMIT) {
    log.warn({ count: open.length }, 'unlock-fixed-orphans: open-issue page full, skipping');
    return { ...empty, skippedReason: 'open_issue_page_full' };
  }

  const openNumbers = new Set(open.map((i) => i.number));
  const closed = new Set(locked.map((r) => r.issue_number).filter((n) => !openNumbers.has(n)));
  const atIso = now.toISOString();
  let unlocked = 0;
  for (const row of locked) {
    if (!closed.has(row.issue_number)) continue;
    rearmLookup(db, row.beer_id);
    markUnlocked(db, row.beer_id, atIso);
    unlocked += 1;
  }

  setJobState(db, UNLOCK_LAST_RUN_KEY, date);
  log.info({ unlocked, issuesClosed: closed.size }, 'unlock-fixed-orphans finished');
  return { unlocked, issuesClosed: closed.size, skippedReason: null, error: null };
}
