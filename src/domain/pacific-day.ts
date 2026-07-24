// Google CSE's daily free quota resets at midnight Pacific Time, so the quota
// counter must be keyed by the Pacific calendar date — not UTC — or it would
// roll over at the wrong instant. en-CA gives ISO-style YYYY-MM-DD directly.
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pacificDay(date: Date): string {
  return FMT.format(date);
}
