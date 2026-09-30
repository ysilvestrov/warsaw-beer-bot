// Festival coverage (spec §6.1). A feed page is a contiguous slice of a venue's check-ins, newest
// first, so each page proves on its own that nothing between its oldest item and its upper bound
// was missed:
//   - the head page (no cursor) proves [oldest on page, fetchedAt];
//   - a cursor page proves [oldest on page, time of the cursor check-in].
// An empty page proves nothing — "HTTP 200, empty body" is exactly what a logged-out more_feed
// returns. Coverage of a venue is the union of the spans from every eye.

export interface Span {
  from_at: string;
  to_at: string;
}

export interface PageSpanInput {
  /** ISO times of the page's check-ins, as ordered on the page (newest first). */
  checkinTimes: string[];
  /** ISO time of the cursor check-in for a cursor page; null for the head page. */
  cursorAt: string | null;
  fetchedAt: string;
  now: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function pageSpan(p: PageSpanInput): Span | null {
  if (p.checkinTimes.length === 0) return null;
  const oldest = Math.min(...p.checkinTimes.map((t) => Date.parse(t)));
  // Neither the eye's clock nor a stored cursor time may stretch coverage into the future.
  const upper = Math.min(p.cursorAt !== null ? Date.parse(p.cursorAt) : Date.parse(p.fetchedAt), Date.parse(p.now));
  if (!Number.isFinite(oldest) || !Number.isFinite(upper) || upper < oldest) return null;
  return { from_at: iso(oldest), to_at: iso(upper) };
}

function merged(spans: Span[]): { from: number; to: number }[] {
  const sorted = spans
    .map((s) => ({ from: Date.parse(s.from_at), to: Date.parse(s.to_at) }))
    .sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // Touching ends (a.to === b.from) leave no instant uncovered, so they merge.
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** Whether the union of `spans` covers every instant of [from, to]. */
export function isCovered(spans: Span[], from: string, to: string): boolean {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return merged(spans).some((m) => m.from <= a && m.to >= b);
}

/** Whether `span` overlaps or touches existing coverage — i.e. the page stitched onto what we had. */
export function touches(spans: Span[], span: Span): boolean {
  const a = Date.parse(span.from_at);
  const b = Date.parse(span.to_at);
  return spans.some((s) => Date.parse(s.from_at) <= b && Date.parse(s.to_at) >= a);
}
