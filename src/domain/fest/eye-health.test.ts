import { blindMs, longestGap } from './eye-health';

const t = (hhmm: string) => Date.parse(`2026-10-16T${hhmm}:00.000Z`);
const span = (from: string, to: string) => ({ from_at: new Date(t(from)).toISOString(), to_at: new Date(t(to)).toISOString() });
const SESSION = { from: t('12:00'), to: t('22:00') };

describe('longestGap', () => {
  it('no spans leave the whole window open', () => {
    expect(longestGap([], SESSION)).toEqual({ ms: 10 * 3600_000, from: t('12:00') });
  });

  it('finds the longest stretch between overlapping spans, and spans sticking out of the window count only inside it', () => {
    const spans = [span('11:00', '12:30'), span('12:20', '15:29'), span('22:00', '23:00'), span('15:29', '15:30')];
    expect(longestGap(spans, SESSION)).toEqual({ ms: t('22:00') - t('15:30'), from: t('15:30') });
  });

  it('a gap at the start counts, and spans that touch leave no gap', () => {
    expect([
      longestGap([span('12:40', '22:00')], SESSION),
      longestGap([span('12:00', '13:00'), span('13:00', '22:00')], SESSION),
    ]).toEqual([{ ms: 40 * 60_000, from: t('12:00') }, { ms: 0, from: t('12:00') }]);
  });
});

describe('blindMs', () => {
  it('counts from the latest covered instant during the session', () => {
    expect(blindMs([span('12:00', '14:00')], SESSION, t('14:11'))).toBe(11 * 60_000);
  });

  it('a night before the session is not blindness: the count starts at the session start', () => {
    const lastNight = { from_at: '2026-10-15T20:00:00.000Z', to_at: '2026-10-15T22:00:00.000Z' };
    expect([blindMs([lastNight], SESSION, t('12:05')), blindMs([], SESSION, t('12:05'))]).toEqual([5 * 60_000, 5 * 60_000]);
  });

  it('is 0 outside the session, before and after it', () => {
    expect([blindMs([], SESSION, t('11:40')), blindMs([], SESSION, t('22:20'))]).toEqual([0, 0]);
  });

  it('a span reaching past now counts only up to now', () => {
    expect(blindMs([span('13:00', '14:30')], SESSION, t('14:00'))).toBe(0);
  });
});
