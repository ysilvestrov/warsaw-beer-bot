// Canonicalize a check-in timestamp to a sortable 'YYYY-MM-DD HH:MM:SS' (UTC).
//
// check-in timestamps arrive in source-dependent formats: `/import` stores the
// Untappd export's ISO-ish `created_at` ("2016-04-15 19:06:47"), while the
// extension feed parser stored the visible RFC-2822 string
// ("Tue, 05 May 2026 21:40:37 +0000"). Mixing them breaks lexicographic
// MAX(checkin_at)/ORDER BY (letters sort after digits, weekday name dominates),
// which surfaced as a wrong/garbled date in `/status`. Normalizing on the way in
// (and backfilling legacy rows) keeps the column sortable.
export function canonicalCheckinAt(raw: string): string {
  // Already date-first (YYYY-MM-DD then space or 'T'): take date+time, drop any
  // zone/fractional suffix, normalize 'T' -> space. Pure string op, no Date
  // parsing — so an already-UTC value can never be time-zone shifted.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(raw)) {
    return raw.slice(0, 19).replace('T', ' ');
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw; // unparseable — keep as-is, never throw
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
