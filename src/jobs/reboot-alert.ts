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
  send: (text: string) => Promise<void>;
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
  await deps.send(decision.text); // throws → nothing saved → the next tick retries
  writeState(deps.db, decision.state);
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
