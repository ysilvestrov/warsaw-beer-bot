import type { DB } from '../storage/db';
import type { Avail, FestInputs, StatusInputs } from '../domain/status/types';
import { collectStatus } from '../storage/stats';
import { getJobState } from '../storage/job_state';
import { summarizeSince } from '../storage/bug_reports';
import { listStatusSnapshots } from '../storage/status_snapshots';
import { currentOrNextFests } from '../storage/fests';
import { parseIsoInstant, shiftDate } from '../domain/status/helpers';
import { STATUS_RULES } from '../domain/status/rules';
import { MENU_INTERVAL_RUN_UP_MS } from '../domain/fest/schedule';
import { readTestDiagnostics } from './test-diagnostics';
import { CANARY_STATE_KEY } from './enrich-orphans';
import { TRIAGE_LAST_RESULT_KEY, TRIAGE_LAST_RUN_KEY } from './orphan-triage';
import { UNLOCK_LAST_RESULT_KEY, UNLOCK_LAST_RUN_KEY } from './unlock-fixed-orphans';
import { readHostPatch } from './host-patch';
import { readHostUpstream } from './host-upstream';
import { BUG_REPORT_PAUSED_KEY } from './bug-report-worker';
import { FEST_MENU_LAST_KEY } from './fest-poll';
import { KEEPALIVE_EVERY_MS, KEEPALIVE_LAST_KEY } from './fest-friend-feed';

export interface StatusInputOptions {
  repo?: string;
  testDiagnosticsPath?: string;
  testDiagnosticsUid?: number;
  hostPatchPath?: string;
  hostPatchUid?: number;
}

const parse = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
};

// Clock skew a stored timestamp may have against `now` before it counts as "from the future".
const FUTURE_SKEW_MS = 60_000;
const validPast = (iso: unknown, now: Date): boolean => {
  if (typeof iso !== 'string') return false;
  const t = parseIsoInstant(iso);
  return Number.isFinite(t) && t <= now.getTime() + FUTURE_SKEW_MS;
};

function readCanary(db: DB, now: Date): Avail<{ ok: boolean; at: string } | null> {
  const raw = getJobState(db, CANARY_STATE_KEY);
  if (raw === null) return { ok: true, value: null };
  const p = parse(raw) as { ok?: unknown; at?: unknown } | null | undefined;
  return p && typeof p.ok === 'boolean' && typeof p.at === 'string' && validPast(p.at, now)
    ? { ok: true, value: { ok: p.ok, at: p.at } }
    : { ok: false, reason: 'стан канарки пошкоджено' };
}

function readTriage(db: DB, dateKey: string): StatusInputs['triage'] {
  const ranToday = getJobState(db, TRIAGE_LAST_RUN_KEY) === dateKey;
  const raw = getJobState(db, TRIAGE_LAST_RESULT_KEY);
  // Triage publishes its result before closing the day, so "ran today" with no result is a contradiction.
  if (raw === null) return ranToday ? { ranToday, line: null, saturated: null, unreadable: true } : { ranToday, line: null, saturated: null };
  const p = parse(raw);
  // A result that cannot be read might be today's and might carry saturation: say so, not "nothing".
  if (p === null || p === undefined || typeof p !== 'object' || Array.isArray(p)) {
    return { ranToday, line: null, saturated: null, unreadable: true };
  }
  const r = p as { date?: unknown; line?: unknown; saturated?: unknown };
  // A payload of another date is yesterday's news — unless triage says it ran today, in which
  // case today's result should be here and a missing/mismatched date means it cannot be read.
  if (r.date !== dateKey) {
    return ranToday ? { ranToday, line: null, saturated: null, unreadable: true } : { ranToday, line: null, saturated: null };
  }
  // `saturated` absent/null is legitimate: a payload written before #431 has no such key.
  const saturatedOk = r.saturated === undefined || r.saturated === null || typeof r.saturated === 'string';
  if (typeof r.line !== 'string' || !saturatedOk) return { ranToday, line: null, saturated: null, unreadable: true };
  return { ranToday, line: r.line, saturated: typeof r.saturated === 'string' ? r.saturated : null };
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

// A pause marker that exists but cannot be read is not "not paused": the worker may be stopped.
function readPaused(db: DB, now: Date): { paused: { since: string; status: number } | null; pausedUnreadable: boolean } {
  const raw = getJobState(db, BUG_REPORT_PAUSED_KEY);
  if (raw === null) return { paused: null, pausedUnreadable: false };
  const p = parse(raw) as { since?: unknown; status?: unknown } | null | undefined;
  return p && typeof p === 'object' && typeof p.since === 'string' && validPast(p.since, now) && typeof p.status === 'number'
    ? { paused: { since: p.since, status: p.status }, pausedUnreadable: false }
    : { paused: null, pausedUnreadable: true };
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

// #469: the reader's kinds as report text; "stale" is the spec's wording for a silent collector.
function readHostPatchInput(now: Date, opts: StatusInputOptions): StatusInputs['hostPatch'] {
  const r = readHostPatch(now, opts.hostPatchPath, opts.hostPatchUid);
  if (r.kind === 'ok') return { ok: true, value: r.facts };
  return { ok: false, reason: r.kind === 'stale' ? 'збирач патчів мовчить' : 'підсумок патчів хоста недоступний' };
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
    canary: readCanary(db, now),
    algoliaOpenUntil: getJobState(db, 'untappd_circuit_open_until'),
    profileOpenUntil: getJobState(db, 'untappd_profile_http_open_until'),
    triage: readTriage(db, dateKey),
    unlock: readUnlock(db, dateKey),
    bugReports: opts.repo
      ? { summary: summarizeSince(db, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()), ...readPaused(db, now) }
      : null,
    disk: diag.kind === 'ok'
      ? { ok: true, value: { bytesAvailable: diag.bytesAvailable, inodesFree: diag.inodesFree, pendingRuns: diag.pendingRuns } }
      : { ok: false, reason: diag.kind === 'stale' ? 'дані монітора застарілі' : 'дані монітора недоступні' },
    hostPatch: readHostPatchInput(now, opts),
    upstream: readHostUpstream(db, now),
    fest: readFest(db, now),
  };
}
