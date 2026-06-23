import { canonicalCheckinAt } from './checkin-time';

describe('canonicalCheckinAt', () => {
  it('converts RFC-2822 (extension feed format) to canonical UTC', () => {
    // This is the exact format the extension feed parser stored, which broke
    // lexicographic MAX(checkin_at) in /status.
    expect(canonicalCheckinAt('Tue, 05 May 2026 21:40:37 +0000')).toBe('2026-05-05 21:40:37');
    expect(canonicalCheckinAt('Wed, 29 Apr 2026 18:53:59 +0000')).toBe('2026-04-29 18:53:59');
  });

  it('passes through already-canonical "YYYY-MM-DD HH:MM:SS" unchanged', () => {
    expect(canonicalCheckinAt('2016-04-15 19:06:47')).toBe('2016-04-15 19:06:47');
  });

  it('normalizes ISO-8601 with T/Z to canonical (space, no zone)', () => {
    expect(canonicalCheckinAt('2026-04-22T10:00:00Z')).toBe('2026-04-22 10:00:00');
    expect(canonicalCheckinAt('2026-04-22T10:00:00.123Z')).toBe('2026-04-22 10:00:00');
  });

  it('keeps an unparseable value as-is (defensive, never throws)', () => {
    expect(canonicalCheckinAt('5 hours ago')).toBe('5 hours ago');
    expect(canonicalCheckinAt('')).toBe('');
  });

  it('produces a chronologically sortable string for RFC inputs', () => {
    // Lexicographic order of the canonical outputs must match chronology — the
    // property MAX(checkin_at) relies on.
    const a = canonicalCheckinAt('Wed, 29 Apr 2026 18:53:59 +0000');
    const b = canonicalCheckinAt('Tue, 05 May 2026 21:40:37 +0000');
    expect(b > a).toBe(true); // May 5 is later than Apr 29
  });
});
