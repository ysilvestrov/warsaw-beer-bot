import 'fake-indexeddb/auto';
import type { MatchResult } from '../api/types';
import { clearLocalDb, inPageTx, type LocalCheckin } from './db';
import { anonymous, buildHadIndex, hadIndex, invalidateHadIndex, overlayHad } from './had';

const row = (bid: number, checkin_at: string, user_rating: number | null, checkin_id = `${bid}-${checkin_at}`): LocalCheckin =>
  ({ checkin_id, bid, beer_name: 'B', brewery_name: 'Br', user_rating, checkin_at });

const result = (over: Partial<MatchResult> = {}): MatchResult => ({
  cacheBinding: { username: '', linkRevision: 0, credential: 'c' },
  raw: { brewery: 'Br', name: 'B' },
  matched_beer: { id: 1, name: 'B', brewery: 'Br', rating_global: 3.9, untappd_id: 101 },
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
  source: 'exact',
  searched: true,
  ...over,
});

describe('buildHadIndex (#924 §5)', () => {
  it('keeps the rating of the newest rated check-in of a beer', () => {
    const index = buildHadIndex([
      row(7, '2026-01-01T10:00:00.000Z', 3.5),
      row(7, '2026-03-01T10:00:00.000Z', 4.25),
      row(7, '2026-02-01T10:00:00.000Z', null),
    ]);
    expect(index.get(7)).toBe(4.25);
  });

  it('takes an older rating when the newest check-in has none', () => {
    const index = buildHadIndex([row(7, '2026-01-01T10:00:00.000Z', 4), row(7, '2026-05-01T10:00:00.000Z', null)]);
    expect(index.get(7)).toBe(4);
  });

  it('stores null for a beer that was never rated', () => {
    const index = buildHadIndex([row(9, '2026-01-01T10:00:00.000Z', null)]);
    expect([index.has(9), index.get(9)]).toEqual([true, null]);
  });

  it('breaks a tie on check-in time by the larger check-in id', () => {
    const at = '2026-01-01T10:00:00.000Z';
    const index = buildHadIndex([row(7, at, 3, '100'), row(7, at, 5, '99')]);
    expect(index.get(7)).toBe(3);
  });

  it('is empty for no rows', () => {
    expect(buildHadIndex([]).size).toBe(0);
  });
});

describe('overlayHad / anonymous (#924 spec, test 6)', () => {
  const index = new Map<number, number | null>([[101, 4.25]]);

  it('exact and in the database: ✅ with the rating', () => {
    expect(overlayHad(result(), index)).toMatchObject({ is_drunk: true, drunk_uncertain: false, user_rating: 4.25 });
  });

  it('fuzzy and in the database: ❓ without a rating', () => {
    expect(overlayHad(result({ source: 'fuzzy' }), index)).toMatchObject({ is_drunk: false, drunk_uncertain: true, user_rating: null });
  });

  it('not in the database: the anonymous answer, whatever the input claimed', () => {
    const claimed = result({ matched_beer: { id: 2, name: 'X', brewery: 'Y', rating_global: null, untappd_id: 202 }, is_drunk: true, user_rating: 5 });
    expect(overlayHad(claimed, index)).toMatchObject({ is_drunk: false, drunk_uncertain: false, user_rating: null });
  });

  it('no matched beer: the anonymous answer', () => {
    expect(overlayHad(result({ matched_beer: null, source: null }), index)).toMatchObject({ is_drunk: false, drunk_uncertain: false, user_rating: null });
  });

  it('a matched beer without a bid: the anonymous answer', () => {
    const noBid = result({ matched_beer: { id: 1, name: 'B', brewery: 'Br', rating_global: 3.9, untappd_id: null } });
    expect(overlayHad(noBid, index)).toMatchObject({ is_drunk: false, drunk_uncertain: false, user_rating: null });
  });

  it('a rated beer that was had but never rated: ✅ with no rating', () => {
    expect(overlayHad(result(), new Map([[101, null]]))).toMatchObject({ is_drunk: true, user_rating: null });
  });

  it('does not change its input', () => {
    const input = result();
    const before = structuredClone(input);
    overlayHad(input, index);
    expect(input).toEqual(before);
  });

  it('anonymous resets only the three personal fields', () => {
    const personal = result({ is_drunk: true, drunk_uncertain: true, user_rating: 4 });
    expect(anonymous(personal)).toEqual({ ...result(), is_drunk: false, drunk_uncertain: false, user_rating: null });
  });
});

describe('hadIndex (cached, #924 §5)', () => {
  const writeRows = (rows: LocalCheckin[]) => inPageTx(async (tx) => { for (const r of rows) await tx.putCheckin(r); });

  beforeEach(async () => {
    await clearLocalDb();
    invalidateHadIndex();
  });

  it('is empty for an empty database', async () => {
    expect((await hadIndex()).size).toBe(0);
  });

  it('is built once and kept until invalidated', async () => {
    await writeRows([row(101, '2026-01-01T10:00:00.000Z', 4)]);
    expect([...(await hadIndex()).keys()]).toEqual([101]);
    await writeRows([row(202, '2026-01-02T10:00:00.000Z', null)]);
    expect([...(await hadIndex()).keys()]).toEqual([101]);
    invalidateHadIndex();
    expect([...(await hadIndex()).keys()].sort()).toEqual([101, 202]);
  });

  it('an unreadable database gives an empty index, and the next read tries again', async () => {
    // No open connection after Clear, so the read has to open the database — and the browser refuses.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      const req = {} as IDBOpenDBRequest;
      setTimeout(() => {
        Object.defineProperty(req, 'error', { value: new DOMException('blocked by the browser', 'UnknownError') });
        req.onerror?.call(req, new Event('error'));
      }, 0);
      return req;
    });
    expect((await hadIndex()).size).toBe(0);
    open.mockRestore();
    warn.mockRestore();
    await writeRows([row(303, '2026-01-01T10:00:00.000Z', null)]);
    expect([...(await hadIndex()).keys()]).toEqual([303]);
  });

  it('a build that started before an invalidation is not kept after it', async () => {
    await writeRows([row(101, '2026-01-01T10:00:00.000Z', 4)]);
    const building = hadIndex();
    invalidateHadIndex();
    await building;
    await writeRows([row(202, '2026-01-02T10:00:00.000Z', null)]);
    expect([...(await hadIndex()).keys()].sort()).toEqual([101, 202]);
  });
});
