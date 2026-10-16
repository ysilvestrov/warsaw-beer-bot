import { closeQueue, CLOSE_SLACK_MS } from './closure';

const ITEM = { id: 7, beerId: 11, addedAt: '2026-10-15T18:00:00.000Z', expected: [1, 2], marked: [] as number[] };
const at = (ms: number) => new Date(Date.parse(ITEM.addedAt) + ms).toISOString();

describe('closeQueue', () => {
  it('a check-in exactly 10 minutes before the item was queued closes it; one second earlier does not', () => {
    const r = closeQueue([ITEM], [1, 2], [
      { telegramId: 1, beerId: 11, checkinId: 'a', checkinAt: at(-CLOSE_SLACK_MS) },
      { telegramId: 2, beerId: 11, checkinId: 'b', checkinAt: at(-CLOSE_SLACK_MS - 1000) },
    ]);
    expect([...r.get(7)!]).toEqual([[1, { checkinId: 'a' }], [2, null]]);
  });

  it('a check-in of another beer does not close the item', () => {
    const r = closeQueue([ITEM], [1], [{ telegramId: 1, beerId: 12, checkinId: 'a', checkinAt: at(60_000) }]);
    expect(r.get(7)!.get(1)).toBeNull();
  });

  it('of two closing check-ins the earliest proves it', () => {
    const r = closeQueue([ITEM], [1], [
      { telegramId: 1, beerId: 11, checkinId: 'late', checkinAt: at(20 * 60_000) },
      { telegramId: 1, beerId: 11, checkinId: 'early', checkinAt: at(5 * 60_000) },
    ]);
    expect(r.get(7)!.get(1)).toEqual({ checkinId: 'early' });
  });

  it("another member's check-in closes nothing for this member", () => {
    const r = closeQueue([ITEM], [1, 2], [{ telegramId: 2, beerId: 11, checkinId: 'b', checkinAt: at(0) }]);
    expect([...r.get(7)!]).toEqual([[1, null], [2, { checkinId: 'b' }]]);
  });

  it('an empty queue gives an empty map', () => {
    expect(closeQueue([], [1], []).size).toBe(0);
  });
});

describe('closeQueue with two glasses of one beer', () => {
  const second = { ...ITEM, id: 8, addedAt: '2026-10-15T18:02:00.000Z' };

  it('one check-in closes only the first glass', () => {
    const r = closeQueue([ITEM, second], [1], [{ telegramId: 1, beerId: 11, checkinId: 'a', checkinAt: at(60_000) }]);
    expect([r.get(7)!.get(1), r.get(8)!.get(1)]).toEqual([{ checkinId: 'a' }, null]);
  });

  it('two check-ins close both, in queue order', () => {
    const r = closeQueue([second, ITEM], [1], [
      { telegramId: 1, beerId: 11, checkinId: 'b', checkinAt: at(9 * 60_000) },
      { telegramId: 1, beerId: 11, checkinId: 'a', checkinAt: at(60_000) },
    ]);
    expect([r.get(7)!.get(1), r.get(8)!.get(1)]).toEqual([{ checkinId: 'a' }, { checkinId: 'b' }]);
  });
});

describe('closeQueue with the same check-in from two sources', () => {
  it('one check-in id closes one glass even when it arrives twice', () => {
    const second = { ...ITEM, id: 8, addedAt: '2026-10-15T18:02:00.000Z' };
    const twice = [
      { telegramId: 1, beerId: 11, checkinId: '501', checkinAt: at(60_000) },
      { telegramId: 1, beerId: 11, checkinId: '501', checkinAt: at(60_000) },
    ];
    const r = closeQueue([ITEM, second], [1], twice);
    expect([r.get(7)!.get(1), r.get(8)!.get(1)]).toEqual([{ checkinId: '501' }, null]);
  });
});

describe('closeQueue with presence and marks (spec 2026-10-15-fest-queue-reality-design.md §PR 2)', () => {
  const second = { ...ITEM, id: 8, addedAt: '2026-10-15T18:02:00.000Z' };
  const checkin = { telegramId: 1, beerId: 11, checkinId: 'a', checkinAt: at(60_000) };

  it('a member’s own mark closes the glass for them alone', () => {
    const r = closeQueue([{ ...ITEM, marked: [1] }], [1, 2], []);
    expect([...r.get(7)!]).toEqual([[1, { marked: true }], [2, null]]);
  });

  it('a marked glass takes no check-in: it goes to the member’s next glass of that beer', () => {
    const r = closeQueue([{ ...ITEM, marked: [1] }, second], [1], [checkin]);
    expect([r.get(7)!.get(1), r.get(8)!.get(1)]).toEqual([{ marked: true }, { checkinId: 'a' }]);
  });

  it('a glass that does not wait for a member shows nothing for them and takes none of their check-ins', () => {
    const r = closeQueue([{ ...ITEM, expected: [2] }, second], [1, 2], [checkin]);
    expect([[...r.get(7)!], r.get(8)!.get(1)]).toEqual([[[2, null]], { checkinId: 'a' }]);
  });
});
