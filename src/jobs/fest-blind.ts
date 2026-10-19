import type pino from 'pino';
import type { DB } from '../storage/db';
import { coverageSince } from '../storage/fest_coverage';
import { BLIND_MS, blindMs } from '../domain/fest/eye-health';
import { sendThrottledAlert } from './alert-slot';
import { festSessionOn } from './fest-notice';

// The one live fest alert (spec 2026-10-19-fest-status-eyes-design.md): the main venue uncovered by
// every eye for BLIND_MS during a session. Then the group's tap alerts and statuses are wrong, and it
// is worth a message to someone drinking beer at the fest; one eye of three going quiet is not.

export const BLIND_ALERT_KEY = 'fest_blind_alert_at';
const BLIND_ALERT_EVERY_MS = 60 * 60 * 1000;

export interface FestBlindDeps {
  db: DB;
  log: pino.Logger;
  notifyAdmin?: (msg: string) => Promise<void>;
}

/** Minutes the main venue has been blind, when that is past BLIND_MS in a session on now; else null. */
export async function runFestBlindCheck(deps: FestBlindDeps, now: Date): Promise<number | null> {
  const on = festSessionOn(deps.db, now);
  if (!on) return null;
  const { fest, session } = on;
  const window = { from: Date.parse(session.start_at), to: Date.parse(session.end_at) };
  const blind = blindMs(coverageSince(deps.db, fest.menu_venue_id, session.start_at), window, now.getTime());
  if (blind <= BLIND_MS) return null;
  const minutes = Math.round(blind / 60_000);
  deps.log.warn({ festId: fest.id, minutes }, 'fest: main venue uncovered by every eye');
  const notify = deps.notifyAdmin;
  if (notify) {
    await sendThrottledAlert(deps.db, {
      key: BLIND_ALERT_KEY, everyMs: BLIND_ALERT_EVERY_MS, now,
      send: async () => notify(`Фест: бот не бачить головну локацію жодним оком ${minutes} хв — алерти й статуси кранів зараз неправдиві`),
    });
  }
  return minutes;
}
