import type { DB } from '../storage/db';
import { deleteJobState, getJobState, setJobState } from '../storage/job_state';

// A throttled admin alert: at most one per `everyMs` under `key`, and the silence counts only from
// an alert that was delivered. The slot is claimed in one IMMEDIATE transaction (check and write
// under the database write lock), so two callers in flight, even from two processes, send one
// alert; a failed send gives the slot back, but only while it still holds this claim, never over
// a newer one.
export async function sendThrottledAlert(
  db: DB,
  p: { key: string; everyMs: number; now: Date; send: () => Promise<void> },
): Promise<boolean> {
  const claim = p.now.toISOString();
  const prev = db.transaction((): string | null | false => {
    const last = getJobState(db, p.key);
    if (last !== null && p.now.getTime() - Date.parse(last) < p.everyMs) return false;
    setJobState(db, p.key, claim);
    return last;
  }).immediate();
  if (prev === false) return false;
  const sent = await p.send().then(() => true, () => false);
  if (!sent) {
    db.transaction(() => {
      if (getJobState(db, p.key) !== claim) return;
      if (prev === null) deleteJobState(db, p.key);
      else setJobState(db, p.key, prev);
    }).immediate();
  }
  return sent;
}
