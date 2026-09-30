import { isCovered, type Span } from './coverage';

// "On tap" (spec §6.2) is tri-state. A check-in within the last hour at any festival venue says
// the beer is being poured. Its absence means "not seen" only when every venue's feed was
// provably watched for that whole hour; otherwise we do not know.

export const TAP_WINDOW_MS = 60 * 60 * 1000;

export type TapStatus =
  | { kind: 'on_tap'; lastAt: string; count: number }
  | { kind: 'not_seen' }
  | { kind: 'unknown' };

export interface TapCheckin {
  bid: number;
  checkin_at: string;
}

export function tapStatus(input: {
  bid: number;
  checkins: TapCheckin[];
  coverageByVenue: ReadonlyMap<number, Span[]>;
  venueIds: number[];
  now: Date;
}): TapStatus {
  const to = input.now.getTime();
  const from = to - TAP_WINDOW_MS;
  // The window is (now − 60 min, now]: a check-in exactly an hour old has aged out.
  const hits = input.checkins.filter((c) => {
    if (c.bid !== input.bid) return false;
    const t = Date.parse(c.checkin_at);
    return t > from && t <= to;
  });
  if (hits.length > 0) {
    const lastAt = hits.reduce((a, c) => (c.checkin_at > a ? c.checkin_at : a), hits[0].checkin_at);
    return { kind: 'on_tap', lastAt, count: hits.length };
  }
  const fromIso = new Date(from).toISOString();
  const toIso = input.now.toISOString();
  const watched = input.venueIds.length > 0
    && input.venueIds.every((v) => isCovered(input.coverageByVenue.get(v) ?? [], fromIso, toIso));
  return watched ? { kind: 'not_seen' } : { kind: 'unknown' };
}
