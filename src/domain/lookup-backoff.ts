export const BACKOFF_HOURS = [0, 24, 72, 168, 336, 720];

export function nextDelayHours(count: number): number {
  if (count < 0) return BACKOFF_HOURS[0];
  return BACKOFF_HOURS[Math.min(count, BACKOFF_HOURS.length - 1)];
}

export function isEligible(
  now: Date,
  lookupAt: string | null,
  count: number,
): boolean {
  if (lookupAt === null) return true;
  const dueAt = new Date(lookupAt).getTime() + nextDelayHours(count) * 3600_000;
  return now.getTime() >= dueAt;
}
