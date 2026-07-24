import { describe, it, expect } from 'vitest';
import { pacificDay } from './pacific-day';

describe('pacificDay', () => {
  it('returns the Los Angeles calendar date as YYYY-MM-DD', () => {
    // 2026-07-24T05:00:00Z is 2026-07-23 22:00 PDT
    expect(pacificDay(new Date('2026-07-24T05:00:00Z'))).toBe('2026-07-23');
  });

  it('rolls to the next day at Pacific midnight, not UTC midnight', () => {
    // 2026-07-24T06:59:00Z = 2026-07-23 23:59 PDT (still the 23rd)
    expect(pacificDay(new Date('2026-07-24T06:59:00Z'))).toBe('2026-07-23');
    // 2026-07-24T07:00:00Z = 2026-07-24 00:00 PDT (now the 24th)
    expect(pacificDay(new Date('2026-07-24T07:00:00Z'))).toBe('2026-07-24');
  });

  it('handles standard time (PST, UTC-8) in winter', () => {
    // 2026-01-15T07:59:00Z = 2026-01-14 23:59 PST
    expect(pacificDay(new Date('2026-01-15T07:59:00Z'))).toBe('2026-01-14');
  });
});
