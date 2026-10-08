import type pino from 'pino';
import type { DB } from '../storage/db';
import { deleteJobState, getJobState, setJobState } from '../storage/job_state';
import { readHostPatch } from './host-patch';
import { decideRebootAlert, snoozeRebootAlert, type RebootAlertState } from '../domain/status/reboot-alert';

// #469 stage 3: hourly — alert the admin once per pending reboot (and again after a snooze).
// State is saved only after the message went out: a failed send retries on the next tick.
export const REBOOT_ALERT_KEY = 'reboot_alert';

function readState(db: DB): RebootAlertState | null {
  const raw = getJobState(db, REBOOT_ALERT_KEY);
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as { since?: unknown; snoozeUntil?: unknown };
    return Number.isSafeInteger(p.since) && (p.snoozeUntil === null || Number.isSafeInteger(p.snoozeUntil))
      ? { since: p.since as number, snoozeUntil: p.snoozeUntil as number | null }
      : null;
  } catch {
    return null; // corrupt: treat as never alerted — one extra alert beats a silent pending reboot
  }
}

function writeState(db: DB, state: RebootAlertState | null): void {
  if (state === null) deleteJobState(db, REBOOT_ALERT_KEY);
  else setJobState(db, REBOOT_ALERT_KEY, JSON.stringify(state));
}

export interface RebootAlertDeps {
  db: DB;
  log: pino.Logger;
  // since: the reboot this alert is for — the keyboard's buttons carry it
  send: (text: string, since: number) => Promise<void>;
  now?: () => Date;
  hostPatchPath?: string;
  hostPatchUid?: number;
}

export async function rebootAlert(deps: RebootAlertDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const prev = readState(deps.db);
  const decision = decideRebootAlert(readHostPatch(now, deps.hostPatchPath, deps.hostPatchUid), prev, now);
  if (!decision.send) {
    if (decision.state !== prev) writeState(deps.db, decision.state);
    return;
  }
  await deps.send(decision.text, decision.state.since); // throws → nothing saved → the next tick retries
  // A snooze the admin pressed while this was being sent is newer than our decision: keep it.
  const current = readState(deps.db);
  const t = Math.floor(now.getTime() / 1000);
  const snoozedMeanwhile = current !== null && current.since === decision.state.since
    && current.snoozeUntil !== null && current.snoozeUntil > t;
  if (!snoozedMeanwhile) writeState(deps.db, decision.state);
}

/**
 * The «Нагадати через 3 дні» button, bound to the `since` of the alert it sits under.
 * False when there is no alerted reboot, or the button belongs to an older reboot.
 */
export function snoozeRebootAlertNow(db: DB, since: number, now: Date): boolean {
  const state = readState(db);
  if (state === null || state.since !== since) return false;
  writeState(db, snoozeRebootAlert(state, now));
  return true;
}

/**
 * The hourly cron's body. A run can outlast the tick (Telegraf caps a call at 500 s and a
 * failed send is retried next hour), and two overlapping runs would both alert the same
 * reboot — so a tick while one is in flight is skipped. A throw is logged: the state stays
 * unsaved and the next tick retries.
 */
export function createRebootAlertTick(deps: RebootAlertDeps): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) {
      deps.log.warn('reboot-alert: previous run still in flight, skipping this tick');
      return;
    }
    inFlight = true;
    rebootAlert(deps)
      .catch((e) => deps.log.error({ err: e }, 'reboot-alert cron'))
      .finally(() => { inFlight = false; });
  };
}
