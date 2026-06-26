// Trimmed exponential backoff for Untappd orphan lookups: 4 attempts total
// (immediately, +72h, +168h, +728h), then the orphan goes dormant forever.
// Cuts wasted re-queries against a blocked/rate-limited Untappd IP — a beer
// that fails 4 honest searches is treated as not findable.
export const BACKOFF_HOURS = [0, 72, 168, 728];

export function nextDelayHours(count: number): number {
  if (count < 0) return BACKOFF_HOURS[0];
  return BACKOFF_HOURS[Math.min(count, BACKOFF_HOURS.length - 1)];
}

export function isEligible(
  now: Date,
  lookupAt: string | null,
  count: number,
): boolean {
  // Terminal state: once a beer has exhausted the schedule it is never looked
  // up again (regardless of lookupAt) until something resets its count.
  if (count >= BACKOFF_HOURS.length) return false;
  if (lookupAt === null) return true;
  const dueAt = new Date(lookupAt).getTime() + nextDelayHours(count) * 3600_000;
  return now.getTime() >= dueAt;
}
