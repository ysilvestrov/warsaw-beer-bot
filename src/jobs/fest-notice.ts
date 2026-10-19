import type { DB } from '../storage/db';
import { currentOrNextFests, festSessions, type Fest, type FestSession } from '../storage/fests';
import { setJobState } from '../storage/job_state';

// Mid-session quiet for fest admin alerts (spec 2026-10-19-fest-status-eyes-design.md): the admin is
// at the fest drinking beer, so during a real session an alert is written down for the morning status
// instead of being sent. Only "the bot sees nothing" (fest-blind.ts) still goes out live.

export const NOTICE_PREFIX = 'fest_notice_at:';

export type FestNoticeKey =
  | 'cookie' | 'server_block' | 'server_recover'
  | 'mcp_down' | 'mcp_recover' | 'mcp_login' | 'mcp_shape' | 'mcp_hole';

/** The real session on `now` (no polling margin), with its fest; null between and outside sessions. */
export function festSessionOn(db: DB, now: Date): { fest: Fest; session: FestSession } | null {
  const t = now.getTime();
  for (const fest of currentOrNextFests(db, now)) {
    const session = festSessions(db, fest.id).find((s) => Date.parse(s.start_at) <= t && t <= Date.parse(s.end_at));
    if (session) return { fest, session };
  }
  return null;
}

/**
 * True when the alert is to stay quiet: a session is on, and its time is recorded under
 * `fest_notice_at:<key>`. Checked before the throttle slot, so a quiet alert does not claim it and a
 * problem that outlasts the session is sent as before. Never throws: when the database fails, the
 * alert goes out — one message too many beats a silent one.
 */
export function festNotice(db: DB, now: Date, key: FestNoticeKey): boolean {
  try {
    if (!festSessionOn(db, now)) return false;
    setJobState(db, NOTICE_PREFIX + key, now.toISOString());
    return true;
  } catch {
    return false;
  }
}
