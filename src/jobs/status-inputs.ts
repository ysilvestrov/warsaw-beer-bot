import type { DB } from '../storage/db';
import type { Avail, FestInputs, StatusInputs } from '../domain/status/types';
import { collectStatus } from '../storage/stats';
import { getJobState } from '../storage/job_state';
import { summarizeSince } from '../storage/bug_reports';
import { listStatusSnapshots } from '../storage/status_snapshots';
import { currentOrNextFests } from '../storage/fests';
import { shiftDate } from '../domain/status/helpers';
import { STATUS_RULES } from '../domain/status/rules';
import { MENU_INTERVAL_RUN_UP_MS } from '../domain/fest/schedule';
import { readTestDiagnostics } from './test-diagnostics';
import { CANARY_STATE_KEY } from './enrich-orphans';
import { TRIAGE_LAST_RESULT_KEY, TRIAGE_LAST_RUN_KEY } from './orphan-triage';
import { UNLOCK_LAST_RESULT_KEY, UNLOCK_LAST_RUN_KEY } from './unlock-fixed-orphans';
import { BUG_REPORT_PAUSED_KEY } from './bug-report-worker';
import { FEST_MENU_LAST_KEY } from './fest-poll';
import { KEEPALIVE_EVERY_MS, KEEPALIVE_LAST_KEY } from './fest-friend-feed';

export interface StatusInputOptions {
  repo?: string;
  testDiagnosticsPath?: string;
  testDiagnosticsUid?: number;
}

const parse = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
};

function readCanary(db: DB): Avail<{ ok: boolean; at: string } | null> {
  const raw = getJobState(db, CANARY_STATE_KEY);
  if (raw === null) return { ok: true, value: null };
  const p = parse(raw) as { ok?: unknown; at?: unknown } | null | undefined;
  return p && typeof p.ok === 'boolean' && typeof p.at === 'string' && Number.isFinite(Date.parse(p.at))
    ? { ok: true, value: { ok: p.ok, at: p.at } }
    : { ok: false, reason: 'стан канарки пошкоджено' };
}

function readTriage(db: DB, dateKey: string): StatusInputs['triage'] {
  const p = parse(getJobState(db, TRIAGE_LAST_RESULT_KEY)) as { date?: unknown; line?: unknown; saturated?: unknown } | null | undefined;
  const today = p && p.date === dateKey;
  return {
    ranToday: getJobState(db, TRIAGE_LAST_RUN_KEY) === dateKey,
    line: today && typeof p.line === 'string' ? p.line : null,
    // `?? null` semantics: a payload written before #431 has no saturated key.
    saturated: today && typeof p.saturated === 'string' ? p.saturated : null,
  };
}

const validId = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) > 0;

// `withheld: null` means today's result exists but cannot be trusted; it must not read as zero
// withheld rows. No result, or a result of another date, is simply nothing to report today.
function readUnlock(db: DB, dateKey: string): StatusInputs['unlock'] {
  const ranToday = getJobState(db, UNLOCK_LAST_RUN_KEY) === dateKey;
  const p = parse(getJobState(db, UNLOCK_LAST_RESULT_KEY));
  if (p === null) return { ranToday, withheld: [] };
  if (p === undefined || typeof p !== 'object' || Array.isArray(p)) return { ranToday, withheld: null };
  const r = p as { date?: unknown; withheld?: unknown };
  if (r.date !== dateKey) return { ranToday, withheld: [] };
  if (!Array.isArray(r.withheld)) return { ranToday, withheld: null };
  const rows = r.withheld as ({ beerId?: unknown; issueNumber?: unknown } | null)[];
  // All-or-nothing, as the old digest did: one malformed row means the result is not trustworthy.
  if (!rows.every((x) => x && validId(x.beerId) && validId(x.issueNumber))) return { ranToday, withheld: null };
  return { ranToday, withheld: rows.map((x) => ({ beerId: Number(x!.beerId), issueNumber: Number(x!.issueNumber) })) };
}

function readPaused(db: DB): { since: string; status: number } | null {
  const p = parse(getJobState(db, BUG_REPORT_PAUSED_KEY)) as { since?: unknown; status?: unknown } | null | undefined;
  return p && typeof p.since === 'string' && typeof p.status === 'number' ? { since: p.since, status: p.status } : null;
}

function readFest(db: DB, now: Date): FestInputs | null {
  if (currentOrNextFests(db, now).length === 0) return null;
  return {
    menuLastAt: getJobState(db, FEST_MENU_LAST_KEY),
    menuCycleMs: MENU_INTERVAL_RUN_UP_MS,
    keepaliveLastAt: getJobState(db, KEEPALIVE_LAST_KEY),
    keepaliveCycleMs: KEEPALIVE_EVERY_MS,
  };
}

// The only place the morning report reads the DB, job_state and files. Every source that can be
// missing comes back as a value the evaluators can colour, never as an exception.
export function collectStatusInputs(db: DB, now: Date, dateKey: string, opts: StatusInputOptions): StatusInputs {
  const metrics = collectStatus(db, now);
  const diag = readTestDiagnostics(now, opts.testDiagnosticsPath, opts.testDiagnosticsUid);
  const historyDays = 2 * STATUS_RULES.historyDays - 1; // flows compare d-13..d-7 with d-6..today
  return {
    now,
    dateKey,
    metrics: {
      ...metrics,
      diskBytesAvailable: diag.kind === 'ok' ? diag.bytesAvailable : null,
      inodesFree: diag.kind === 'ok' ? diag.inodesFree : null,
    },
    history: listStatusSnapshots(db, shiftDate(dateKey, -historyDays), dateKey),
    canary: readCanary(db),
    algoliaOpenUntil: getJobState(db, 'untappd_circuit_open_until'),
    profileOpenUntil: getJobState(db, 'untappd_profile_http_open_until'),
    triage: readTriage(db, dateKey),
    unlock: readUnlock(db, dateKey),
    bugReports: opts.repo
      ? { summary: summarizeSince(db, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()), paused: readPaused(db) }
      : null,
    disk: diag.kind === 'ok'
      ? { ok: true, value: { bytesAvailable: diag.bytesAvailable, inodesFree: diag.inodesFree, pendingRuns: diag.pendingRuns } }
      : { ok: false, reason: diag.kind === 'stale' ? 'дані монітора застарілі' : 'дані монітора недоступні' },
    fest: readFest(db, now),
  };
}
