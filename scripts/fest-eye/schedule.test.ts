import { eyeTasks, type EyeConfig, type EyeState } from './schedule';

const CFG: EyeConfig = {
  pollMarginMs: 30 * 60 * 1000,
  sessions: [{ start_at: '2026-10-15T14:00:00.000Z', end_at: '2026-10-15T22:00:00.000Z' }],
  menuVenueId: 11142155,
  menuPath: '/v/wfp/11142155',
  venues: [
    { venueId: 2167060, feedPath: '/v/stadion/2167060' },
    { venueId: 11142155, feedPath: '/v/wfp/11142155/activity' },
  ],
};
const t = (iso: string) => Date.parse(iso);
const state = (feedAt: [number, string][] = [], menuAt: string | null = null, configAt: string | null = '2026-10-15T14:00:00.000Z',
  attemptAt: [string, string][] = []): EyeState => ({
  configAt: configAt === null ? null : t(configAt),
  menuAt: menuAt === null ? null : t(menuAt),
  feedAt: new Map(feedAt.map(([v, at]) => [v, t(at)])),
  attemptAt: new Map(attemptAt.map(([k, at]) => [k, t(at)])),
});

describe('eyeTasks', () => {
  it('without a config it only fetches the config', () => {
    expect(eyeTasks(t('2026-10-15T15:00:00.000Z'), null, state())).toEqual({ config: true, menu: false, feeds: [], inWindow: false });
  });

  it('outside a window it reads nothing, only refreshes the config hourly', () => {
    expect(eyeTasks(t('2026-10-15T13:29:00.000Z'), CFG, state([], null, '2026-10-15T12:29:00.000Z')))
      .toEqual({ config: true, menu: false, feeds: [], inWindow: false });
  });

  it('the first tick of a window reads every venue with 5 pages allowed, and the menu', () => {
    const r = eyeTasks(t('2026-10-15T13:30:00.000Z'), CFG, state([[11142155, '2026-10-14T21:00:00.000Z']], '2026-10-14T21:00:00.000Z'));
    expect([r.menu, r.feeds.map((f) => [f.venueId, f.maxPages])]).toEqual([true, [[2167060, 5], [11142155, 5]]]);
  });

  it('then reads the festival venue every 3 min and the others every 6 min, with 3 pages', () => {
    const read = [[2167060, '2026-10-15T15:00:00.000Z'], [11142155, '2026-10-15T15:00:00.000Z']] as [number, string][];
    const at = (iso: string) => eyeTasks(t(iso), CFG, state(read, '2026-10-15T15:00:00.000Z')).feeds.map((f) => [f.venueId, f.maxPages]);
    expect([at('2026-10-15T15:02:59.000Z'), at('2026-10-15T15:03:00.000Z'), at('2026-10-15T15:06:00.000Z')])
      .toEqual([[], [[11142155, 3]], [[2167060, 3], [11142155, 3]]]);
  });

  it('reads the menu every 2 hours inside a window', () => {
    const read = [[2167060, '2026-10-15T17:00:00.000Z'], [11142155, '2026-10-15T17:00:00.000Z']] as [number, string][];
    expect([
      eyeTasks(t('2026-10-15T16:59:00.000Z'), CFG, state(read, '2026-10-15T15:00:00.000Z')).menu,
      eyeTasks(t('2026-10-15T17:00:00.000Z'), CFG, state(read, '2026-10-15T15:00:00.000Z')).menu,
    ]).toEqual([false, true]);
  });

  it('a failed read is retried after a minute, not after its full interval', () => {
    // Feeds last read an hour ago, the menu before the window, the config two hours ago; every task
    // then failed at 15:00.
    const failed = state([[2167060, '2026-10-15T14:00:00.000Z'], [11142155, '2026-10-15T14:00:00.000Z']], '2026-10-15T12:00:00.000Z',
      '2026-10-15T13:00:00.000Z', [['config', '2026-10-15T15:00:00.000Z'], ['menu', '2026-10-15T15:00:00.000Z'],
        ['feed:2167060', '2026-10-15T15:00:00.000Z'], ['feed:11142155', '2026-10-15T15:00:00.000Z']]);
    const at = (iso: string) => { const r = eyeTasks(t(iso), CFG, failed); return [r.config, r.menu, r.feeds.length]; };
    expect([at('2026-10-15T15:00:59.000Z'), at('2026-10-15T15:01:00.000Z')]).toEqual([[false, false, 0], [true, true, 2]]);
  });
});
