// Alerts (spec §6.5): a Target of the team that is on tap and was not announced yet in this
// session. Whether it is news is decided by the time of its first check-in in the session, not by
// the state of the job: a first check-in at most 15 minutes old is "🆕", an older one goes to the
// "already pouring" block of the same message. That one rule covers the first tick of a session,
// a bot that was down, and an eye that paged in a check-in late — all of them learned it late.

export const ALERT_FRESH_MS = 15 * 60 * 1000;

export interface OnTapTarget {
  beerId: number;
  /** Earliest check-in of this beer at a festival venue since the session started. */
  firstAt: string;
  firstCheckinId: number;
}

export interface AlertPlan {
  fresh: OnTapTarget[];
  pouring: OnTapTarget[];
}

/** A first check-in up to this far ahead of our clock is Untappd's clock, not bad data. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function planAlerts(input: { onTap: OnTapTarget[]; sent: ReadonlySet<number>; now: Date }): AlertPlan {
  // An unparseable time or one further ahead than clock skew explains is no fact to announce:
  // it is left out (and stays unsent), not guessed into either block.
  const plausible = (t: OnTapTarget) => {
    const at = Date.parse(t.firstAt);
    return !Number.isNaN(at) && at <= input.now.getTime() + CLOCK_SKEW_MS;
  };
  const due = input.onTap
    .filter((t) => !input.sent.has(t.beerId) && plausible(t))
    .sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.beerId - b.beerId);
  const isFresh = (t: OnTapTarget) => input.now.getTime() - Date.parse(t.firstAt) <= ALERT_FRESH_MS;
  return { fresh: due.filter(isFresh), pouring: due.filter((t) => !isFresh(t)) };
}
