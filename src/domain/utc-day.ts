// The web-search quota bucket is a self-imposed spend guard (Brave bills
// monthly credits, it does not reset a daily quota), so the day key is plain
// UTC. A daily cap bounds any rolling 31-day window, which is what protects the
// monthly credit budget regardless of when Brave's cycle resets.
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
