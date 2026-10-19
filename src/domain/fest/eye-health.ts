import { merged, type Span } from './coverage';

// Eye health for the morning status and the one live alert (spec 2026-10-19-fest-status-eyes-design.md).
// An eye is judged by the longest stretch of a session its own proven coverage leaves open on the
// main venue, never by recorded_at: history pages below a cursor refresh recorded_at too, and would
// hide that the eye stopped reading the venue as it is now (spec review #4).

const MIN = 60 * 1000;

export interface Window {
  from: number;
  to: number;
}

export interface Gap {
  ms: number;
  /** Start of the longest uncovered stretch; meaningless when ms is 0. */
  from: number;
}

/** Longest stretch of a gap allowed per eye: about 4× the longest seen while it worked on WFP22. */
export const EYE_GAP_MS = { mcp_venue: 15 * MIN, server: 30 * MIN, laptop: 15 * MIN } as const;
/** «Neither MCP nor the laptop»: the fast eyes; the server alone sees about a third of the check-ins. */
export const FAST_EYES_GAP_MS = 30 * MIN;
/** The main venue uncovered by every eye this long, in a session, is the one live alert. */
export const BLIND_MS = 10 * MIN;

/** The longest part of `w` no span covers; spans may overlap each other and stick out of the window. */
export function longestGap(spans: Span[], w: Window): Gap {
  let best: Gap = { ms: 0, from: w.from };
  let cursor = w.from;
  for (const m of merged(spans)) {
    if (m.to <= cursor) continue;
    if (m.from >= w.to) break;
    if (m.from > cursor && m.from - cursor > best.ms) best = { ms: m.from - cursor, from: cursor };
    cursor = Math.max(cursor, m.to);
    if (cursor >= w.to) return best;
  }
  return w.to - cursor > best.ms ? { ms: w.to - cursor, from: cursor } : best;
}

/**
 * How long the main venue has gone uncovered by every eye, within a session that is on now: from the
 * latest covered instant, never earlier than the session start (a night between sessions is not
 * blindness), and 0 outside the session (spec review #3).
 */
export function blindMs(spans: Span[], session: Window, now: number): number {
  if (now < session.from || now > session.to) return 0;
  const lastCovered = spans.reduce((last, s) => {
    const to = Math.min(Date.parse(s.to_at), now);
    return Date.parse(s.from_at) <= now && to > last ? to : last;
  }, session.from);
  return now - lastCovered;
}
