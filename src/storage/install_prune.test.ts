import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { pruneInstallLedger } from './install_prune';
import { installDayStats } from './install_stats';

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

function install(d: ReturnType<typeof db>, id: string, lastSeen: string) {
  d.prepare(`INSERT INTO extension_installs (install_id, token_hash, created_at, last_seen_date)
             VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?)`).run(id, `h-${id}`, lastSeen);
}

function usage(d: ReturnType<typeof db>, id: string, date: string, shop: string, cols: Record<string, number> = {}) {
  d.prepare(`INSERT INTO install_usage_daily (date, install_id, shop, match_misses, enrich_links, enrich_rejected)
             VALUES (?, ?, ?, ?, ?, ?)`).run(date, id, shop, cols.misses ?? 0, cols.links ?? 0, cols.rejected ?? 0);
}

function miss(d: ReturnType<typeof db>, name: string, lastSeen: string) {
  d.prepare(`INSERT INTO match_misses (normalized_brewery, normalized_name, brewery, name, first_seen_at, last_seen_at, last_seen_date)
             VALUES ('b', ?, 'B', ?, 'x', 'x', ?)`).run(name, name, lastSeen);
}

const count = (d: ReturnType<typeof db>, table: string) =>
  (d.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe('pruneInstallLedger', () => {
  it('keeps a row dated exactly on the cut-off and drops the day before it, in every ledger', () => {
    const d = db();
    install(d, 'a', '2026-10-30');
    usage(d, 'a', '2026-08-01', 'kept.pl');
    usage(d, 'a', '2026-07-31', 'gone.pl');
    d.exec(`INSERT INTO install_registrations_daily (date, registrations) VALUES ('2026-08-01', 1), ('2026-07-31', 1)`);
    miss(d, 'kept', '2026-08-01');
    miss(d, 'gone', '2026-07-31');
    expect(pruneInstallLedger(d, { ledgerBefore: '2026-08-01', installsBefore: '2026-05-03' }))
      .toEqual({ installs: 0, usage: 1, registrations: 1, misses: 1 });
    expect(d.prepare('SELECT shop FROM install_usage_daily').all()).toEqual([{ shop: 'kept.pl' }]);
    expect(d.prepare('SELECT date FROM install_registrations_daily').all()).toEqual([{ date: '2026-08-01' }]);
    expect(d.prepare('SELECT name FROM match_misses').all()).toEqual([{ name: 'kept' }]);
  });

  it('deletes an install unseen past its cut-off with its usage, but leaves the misses journal', () => {
    const d = db();
    install(d, 'old', '2026-05-02');
    install(d, 'edge', '2026-05-03');
    usage(d, 'old', '2026-10-01', 'a.pl');
    miss(d, 'still', '2026-10-01');
    expect(pruneInstallLedger(d, { ledgerBefore: '2026-08-01', installsBefore: '2026-05-03' }))
      .toEqual({ installs: 1, usage: 0, registrations: 0, misses: 0 });
    expect(d.prepare('SELECT install_id FROM extension_installs').all()).toEqual([{ install_id: 'edge' }]);
    expect(count(d, 'install_usage_daily')).toBe(0);
    expect(count(d, 'match_misses')).toBe(1);
  });

  it('an empty database prunes nothing', () => {
    expect(pruneInstallLedger(db(), { ledgerBefore: '2026-08-01', installsBefore: '2026-05-03' }))
      .toEqual({ installs: 0, usage: 0, registrations: 0, misses: 0 });
  });
});

describe('installDayStats', () => {
  it('counts installs (not rows), sums misses and links, and counts a capped install once', () => {
    const d = db();
    install(d, 'a', '2026-10-05');
    install(d, 'b', '2026-10-05');
    usage(d, 'a', '2026-10-05', 'a.pl', { misses: 3, links: 1, rejected: 2 });
    usage(d, 'a', '2026-10-05', 'b.pl', { misses: 1, rejected: 1 });
    usage(d, 'b', '2026-10-05', 'a.pl', { misses: 0 });
    usage(d, 'b', '2026-10-04', 'a.pl', { misses: 9, links: 9, rejected: 9 });
    d.exec(`INSERT INTO install_registrations_daily (date, registrations, rejected) VALUES ('2026-10-05', 5, 2)`);
    expect(installDayStats(d, '2026-10-05')).toEqual({
      active: 2, misses: 4, enrichLinks: 1, registrations: 5, registrationsRejected: 2, enrichCapped: 1,
    });
  });

  it('zeros on a day with nothing', () => {
    expect(installDayStats(db(), '2026-10-05')).toEqual({
      active: 0, misses: 0, enrichLinks: 0, registrations: 0, registrationsRejected: 0, enrichCapped: 0,
    });
  });
});
