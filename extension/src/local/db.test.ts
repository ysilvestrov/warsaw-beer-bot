import 'fake-indexeddb/auto';
import { clearLocalDb, currentGeneration, inPageTx, localStats, type LocalCheckin } from './db';

const row = (checkin_id: string, bid: number): LocalCheckin =>
  ({ checkin_id, bid, beer_name: 'B', brewery_name: 'Br', user_rating: null, checkin_at: '2026-10-01T10:00:00.000Z' });

describe('localStats (#924)', () => {
  beforeEach(async () => { await clearLocalDb(); });

  it('an empty database has no check-ins, no beers and no owner', async () => {
    expect(await localStats()).toEqual({ checkins: 0, beers: 0, meta: null });
  });

  it('counts every check-in and each beer once, however often it was had', async () => {
    const meta = { username: 'bob', generation: await currentGeneration(), profileTotal: 4, oldestId: null, updatedAt: '2026-11-07T10:00:00.000Z' };
    await inPageTx(async (tx) => {
      for (const r of [row('1', 7), row('2', 7), row('3', 7), row('4', 9)]) await tx.putCheckin(r);
      await tx.putMeta(meta);
    });
    expect(await localStats()).toEqual({ checkins: 4, beers: 2, meta });
  });
});
