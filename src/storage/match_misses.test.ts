import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { recordMisses } from './match_misses';

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

function rows(d: ReturnType<typeof db>) {
  return d.prepare(
    `SELECT brewery, name, abv, shop, first_seen_at, last_seen_at, last_seen_date, seen_days
       FROM match_misses ORDER BY normalized_brewery, normalized_name`,
  ).all();
}

describe('recordMisses', () => {
  it('inserts a first sighting with its raw text, shop and dates', () => {
    const d = db();
    const n = recordMisses(d, {
      at: '2026-10-30T10:00:00.000Z', date: '2026-10-30', shop: 'beerfreak.pl',
      cards: [{ brewery: 'Browar X', name: 'Hazy One', abv: 6.5 }],
    });
    expect(n).toBe(1);
    expect(rows(d)).toEqual([{
      brewery: 'Browar X', name: 'Hazy One', abv: 6.5, shop: 'beerfreak.pl',
      first_seen_at: '2026-10-30T10:00:00.000Z', last_seen_at: '2026-10-30T10:00:00.000Z',
      last_seen_date: '2026-10-30', seen_days: 1,
    }]);
  });

  it('a repeat the same Warsaw day moves last_seen_at but not seen_days; the next day counts', () => {
    const d = db();
    const card = { brewery: 'Browar X', name: 'Hazy One' };
    recordMisses(d, { at: '2026-10-30T10:00:00.000Z', date: '2026-10-30', shop: 'a.pl', cards: [card] });
    recordMisses(d, { at: '2026-10-30T20:00:00.000Z', date: '2026-10-30', shop: 'b.pl', cards: [card] });
    expect(rows(d)).toEqual([expect.objectContaining({ last_seen_at: '2026-10-30T20:00:00.000Z', seen_days: 1, shop: 'a.pl' })]);
    // 23:30 UTC on the 30th is already the 31st in Warsaw: the caller passes the Warsaw date.
    recordMisses(d, { at: '2026-10-30T23:30:00.000Z', date: '2026-10-31', shop: 'b.pl', cards: [card] });
    expect(rows(d)).toEqual([expect.objectContaining({ last_seen_date: '2026-10-31', seen_days: 2, first_seen_at: '2026-10-30T10:00:00.000Z' })]);
  });

  it('keys by the matcher normalizers, so a re-spelt card lands on the same row', () => {
    const d = db();
    recordMisses(d, { at: '2026-10-30T10:00:00.000Z', date: '2026-10-30', shop: '', cards: [{ brewery: 'Browar X', name: 'Hazy One' }] });
    recordMisses(d, { at: '2026-10-31T10:00:00.000Z', date: '2026-10-31', shop: '', cards: [{ brewery: 'BROWAR X', name: 'hazy one' }] });
    expect(rows(d)).toEqual([expect.objectContaining({ brewery: 'Browar X', name: 'Hazy One', seen_days: 2 })]);
  });

  it('keeps the first known ABV and fills it when the first sighting had none', () => {
    const d = db();
    recordMisses(d, { at: '2026-10-30T10:00:00.000Z', date: '2026-10-30', shop: '', cards: [{ brewery: 'B', name: 'N' }] });
    recordMisses(d, { at: '2026-10-30T11:00:00.000Z', date: '2026-10-30', shop: '', cards: [{ brewery: 'B', name: 'N', abv: 5 }] });
    recordMisses(d, { at: '2026-10-30T12:00:00.000Z', date: '2026-10-30', shop: '', cards: [{ brewery: 'B', name: 'N', abv: 7 }] });
    expect(rows(d)).toEqual([expect.objectContaining({ abv: 5 })]);
  });

  it('an empty list writes nothing and returns 0', () => {
    const d = db();
    expect(recordMisses(d, { at: '2026-10-30T10:00:00.000Z', date: '2026-10-30', shop: '', cards: [] })).toBe(0);
    expect(rows(d)).toEqual([]);
  });

  it('restores busy_timeout even when the write throws', () => {
    const d = db();
    d.exec('DROP TABLE match_misses');
    const before = d.pragma('busy_timeout', { simple: true });
    expect(() => recordMisses(d, { at: 'x', date: 'y', shop: '', cards: [{ brewery: 'B', name: 'N' }] })).toThrow();
    expect(d.pragma('busy_timeout', { simple: true })).toBe(before);
  });
});
