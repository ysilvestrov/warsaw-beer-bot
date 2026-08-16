// Trimmed exponential backoff for Untappd orphan lookups: 4 attempts total
// (immediately, +72h, +168h, +728h), then the orphan goes dormant forever.
// Cuts wasted re-queries against a blocked/rate-limited Untappd IP — a beer
// that fails 4 honest searches is treated as not findable.
export const BACKOFF_HOURS = [0, 72, 168, 728];

export function nextDelayHours(count: number): number {
  if (count < 0) return BACKOFF_HOURS[0];
  return BACKOFF_HOURS[Math.min(count, BACKOFF_HOURS.length - 1)];
}

// #421: verdicts whose answer is changed by TIME rather than by a fix we own. Untappd's
// catalogue grows, so "not on Untappd" carries an expiry date; exhausting the schedule
// would make a verdict that is reversible by construction permanently unreversible. Every
// other class waits on a fix (matcher_bug/parser_bug — see the lock in storage/beers.ts)
// or on nothing at all (unidentifiable), and for those a repeating retry would be a timer
// with no bet behind it.
export const RECURRING_CLASSES: readonly string[] = ['not_on_untappd'];

export function isEligible(
  now: Date,
  lookupAt: string | null,
  count: number,
  recurring = false,
): boolean {
  // Terminal state: once a beer has exhausted the schedule it is never looked
  // up again (regardless of lookupAt) until something resets its count — UNLESS its
  // verdict is one whose answer time can still change, in which case the last delay
  // simply repeats (nextDelayHours already clamps to it, so the tail needs no arithmetic
  // of its own). `recurring` defaults to false: a caller that does not know the class
  // gets the conservative schedule.
  if (count >= BACKOFF_HOURS.length && !recurring) return false;
  if (lookupAt === null) return true;
  const dueAt = new Date(lookupAt).getTime() + nextDelayHours(count) * 3600_000;
  return now.getTime() >= dueAt;
}
