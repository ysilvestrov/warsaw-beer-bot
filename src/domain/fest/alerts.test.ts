import { ALERT_FRESH_MS, CLOCK_SKEW_MS, planAlerts } from './alerts';

const NOW = new Date('2026-10-15T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('planAlerts', () => {
  it('a first check-in exactly 15 minutes old is news; a minute older is "already pouring"', () => {
    const plan = planAlerts({
      onTap: [
        { beerId: 1, firstAt: ago(ALERT_FRESH_MS), firstCheckinId: 11 },
        { beerId: 2, firstAt: ago(ALERT_FRESH_MS + 60_000), firstCheckinId: 12 },
      ],
      sent: new Set(),
      now: NOW,
    });
    expect([plan.fresh.map((a) => a.beerId), plan.pouring.map((a) => a.beerId)]).toEqual([[1], [2]]);
  });

  it('a beer already announced this session is left out', () => {
    const plan = planAlerts({ onTap: [{ beerId: 1, firstAt: ago(0), firstCheckinId: 11 }], sent: new Set([1]), now: NOW });
    expect(plan).toEqual({ fresh: [], pouring: [] });
  });

  it('lists beers by the time of their first check-in', () => {
    const plan = planAlerts({
      onTap: [
        { beerId: 3, firstAt: ago(60_000), firstCheckinId: 13 },
        { beerId: 4, firstAt: ago(120_000), firstCheckinId: 14 },
      ],
      sent: new Set(),
      now: NOW,
    });
    expect(plan.fresh.map((a) => a.beerId)).toEqual([4, 3]);
  });
});

describe('planAlerts on implausible times', () => {
  it('keeps a first check-in up to 5 minutes ahead as fresh; drops one further ahead or unparseable', () => {
    const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    const plan = planAlerts({
      onTap: [
        { beerId: 1, firstAt: ahead(CLOCK_SKEW_MS), firstCheckinId: 11 },
        { beerId: 2, firstAt: ahead(CLOCK_SKEW_MS + 1000), firstCheckinId: 12 },
        { beerId: 3, firstAt: 'not a time', firstCheckinId: 13 },
      ],
      sent: new Set(),
      now: NOW,
    });
    expect(plan).toEqual({ fresh: [{ beerId: 1, firstAt: ahead(CLOCK_SKEW_MS), firstCheckinId: 11 }], pouring: [] });
  });
});
