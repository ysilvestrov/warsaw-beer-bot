import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import {
  REGISTRATIONS_PER_DAY,
  deleteInstall,
  findInstallByHash,
  registerInstall,
  touchInstall,
} from './extension_installs';
import { recordInstallUsage } from './install_usage';

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

const DAY = '2026-10-30';
const AT = '2026-10-30T10:00:00.000Z';

function counter(d: ReturnType<typeof db>, date = DAY) {
  return d.prepare('SELECT registrations, rejected FROM install_registrations_daily WHERE date = ?').get(date);
}

// Fills the day's counter to the cap without inserting 2000 installs one by one.
function fillToCap(d: ReturnType<typeof db>, date = DAY) {
  d.prepare('INSERT INTO install_registrations_daily (date, registrations) VALUES (?, ?)').run(date, REGISTRATIONS_PER_DAY);
}

describe('registerInstall', () => {
  it('stores the given hash and counts the registration', () => {
    const d = db();
    const out = registerInstall(d, { date: DAY, at: AT, version: '0.23.0', tokenHash: 'h1' });
    expect(out.kind).toBe('ok');
    expect(d.prepare('SELECT token_hash, created_at, last_seen_date, ext_version, telegram_id FROM extension_installs').all())
      .toEqual([{ token_hash: 'h1', created_at: AT, last_seen_date: DAY, ext_version: '0.23.0', telegram_id: null }]);
    expect(counter(d)).toEqual({ registrations: 1, rejected: 0 });
  });

  it('refuses at the cap, counts the refusal and inserts nothing', () => {
    const d = db();
    fillToCap(d);
    expect(registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h1' })).toEqual({ kind: 'capped' });
    expect(registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h2' })).toEqual({ kind: 'capped' });
    expect(counter(d)).toEqual({ registrations: REGISTRATIONS_PER_DAY, rejected: 2 });
    expect(d.prepare('SELECT COUNT(*) AS c FROM extension_installs').get()).toEqual({ c: 0 });
  });

  it('the cap is per Warsaw day', () => {
    const d = db();
    fillToCap(d, '2026-10-29');
    expect(registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h1' }).kind).toBe('ok');
  });

  it('deleting installs does not give registrations back (register → delete loops cannot pass the cap)', () => {
    const d = db();
    d.prepare('INSERT INTO install_registrations_daily (date, registrations) VALUES (?, ?)').run(DAY, REGISTRATIONS_PER_DAY - 1);
    const last = registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h1' });
    expect(last.kind).toBe('ok');
    expect(deleteInstall(d, (last as { installId: string }).installId)).toBe(true);
    expect(registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h2' })).toEqual({ kind: 'capped' });
  });
});

describe('findInstallByHash / touchInstall', () => {
  it('finds by hash and returns null for an unknown hash', () => {
    const d = db();
    registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h1' });
    expect(findInstallByHash(d, 'h1')).toEqual({
      installId: expect.stringMatching(/^[0-9a-f-]{36}$/), lastSeenDate: DAY, extVersion: '1',
    });
    expect(findInstallByHash(d, 'nope')).toBeNull();
  });

  it('writes only when the date or the version changed', () => {
    const d = db();
    registerInstall(d, { date: '2026-10-29', at: AT, version: '1', tokenHash: 'h1' });
    const row = findInstallByHash(d, 'h1')!;
    expect(touchInstall(d, row, { date: '2026-10-29', version: '1' })).toBe(false);
    expect(touchInstall(d, row, { date: '2026-10-29' })).toBe(false);
    expect(touchInstall(d, row, { date: DAY, version: '1' })).toBe(true);
    expect(touchInstall(d, findInstallByHash(d, 'h1')!, { date: DAY, version: '2' })).toBe(true);
    expect(findInstallByHash(d, 'h1')).toEqual({ installId: row.installId, lastSeenDate: DAY, extVersion: '2' });
  });
});

describe('deleteInstall', () => {
  it('removes the install and its usage rows, and reports a second delete as a no-op', () => {
    const d = db();
    const out = registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h1' }) as { installId: string };
    recordInstallUsage(d, { date: DAY, installId: out.installId, shop: 'beerfreak.pl', matchRequests: 1 });
    expect(deleteInstall(d, out.installId)).toBe(true);
    expect(d.prepare('SELECT COUNT(*) AS c FROM install_usage_daily').get()).toEqual({ c: 0 });
    expect(deleteInstall(d, out.installId)).toBe(false);
  });
});

describe('recordInstallUsage', () => {
  it('accumulates per (date, install, shop) and keeps shops apart', () => {
    const d = db();
    const { installId } = registerInstall(d, { date: DAY, at: AT, version: '1', tokenHash: 'h1' }) as { installId: string };
    recordInstallUsage(d, { date: DAY, installId, shop: 'a.pl', matchRequests: 1, matchBeers: 10, matchMisses: 2 });
    recordInstallUsage(d, { date: DAY, installId, shop: 'a.pl', matchRequests: 1, matchBeers: 5, matchMisses: 0 });
    recordInstallUsage(d, { date: DAY, installId, shop: '', matchRequests: 1, matchBeers: 1 });
    expect(d.prepare(
      `SELECT shop, match_requests, match_beers, match_misses, enrich_results, enrich_links, enrich_rejected
         FROM install_usage_daily ORDER BY shop`,
    ).all()).toEqual([
      { shop: '', match_requests: 1, match_beers: 1, match_misses: 0, enrich_results: 0, enrich_links: 0, enrich_rejected: 0 },
      { shop: 'a.pl', match_requests: 2, match_beers: 15, match_misses: 2, enrich_results: 0, enrich_links: 0, enrich_rejected: 0 },
    ]);
  });

  it('restores busy_timeout even when the write throws', () => {
    const d = db();
    const before = d.pragma('busy_timeout', { simple: true });
    // No such install: the foreign key rejects the row.
    expect(() => recordInstallUsage(d, { date: DAY, installId: 'missing', shop: '', matchRequests: 1 })).toThrow();
    expect(d.pragma('busy_timeout', { simple: true })).toBe(before);
  });
});
