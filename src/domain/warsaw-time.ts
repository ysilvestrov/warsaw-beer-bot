// Warsaw-local calendar date ("YYYY-MM-DD") and hour (0–23) for d. Uses the
// Europe/Warsaw zone so DST is handled by Intl, not by us. Shared by the
// Warsaw-window jobs (daily-status, orphan-triage).
export function warsawDateAndHour(d: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
}
