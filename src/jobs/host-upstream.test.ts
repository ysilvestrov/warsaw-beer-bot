import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { getJobState, setJobState } from '../storage/job_state';
import { HOST_UPSTREAM_KEY, hostUpstream, readHostUpstream } from './host-upstream';
import { LITESTREAM_LATEST_URL, NODE_INDEX_URL, NODE_SCHEDULE_URL } from '../sources/host-upstream';

/** #469 stage 2 — fixtures captured 2026-10-08. */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures/host-upstream', name), 'utf8'));
const log = pino({ level: 'silent' });
const NOW = new Date('2026-10-08T06:50:00.000Z');
const HOUR = 3_600_000;

const ALL: Record<string, unknown> = {
  [NODE_INDEX_URL]: fixture('node-index.json'),
  [NODE_SCHEDULE_URL]: fixture('node-schedule.json'),
  [LITESTREAM_LATEST_URL]: fixture('litestream-latest.json'),
};
/** A fetcher serving `table`; a URL mapped to an Error throws it. It records each URL it was asked for. */
function fetcher(table: Record<string, unknown>, asked: string[] = []) {
  return async (url: string): Promise<unknown> => {
    asked.push(url);
    const out = table[url];
    if (out instanceof Error) throw out;
    return out;
  };
}

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

const FRESH = {
  nodeSecurity: { ok: true, value: { version: '24.18.1', date: '2026-07-28' } },
  nodeEnd: { ok: true, value: '2028-04-30' },
  litestream: { ok: true, value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' } },
};

describe('hostUpstream + readHostUpstream', () => {
  it('stores all three sources and reads them back', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    expect(readHostUpstream(db, NOW)).toEqual(FRESH);
  });

  it('a failing source keeps its previous value and leaves the others fresh', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    const later = new Date(NOW.getTime() + 21 * HOUR);
    await hostUpstream({ db, log, now: () => later,
      fetchJson: fetcher({ ...ALL, [LITESTREAM_LATEST_URL]: new Error('HTTP 503') }) });
    expect(readHostUpstream(db, later)).toEqual(FRESH);
  });

  it('does not refetch a source refreshed less than 20 hours ago', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    const asked: string[] = [];
    await hostUpstream({ db, log, now: () => new Date(NOW.getTime() + 20 * HOUR - 1), fetchJson: fetcher(ALL, asked) });
    expect(asked).toEqual([]);
  });

  it('refetches a source at exactly 20 hours', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    const asked: string[] = [];
    await hostUpstream({ db, log, now: () => new Date(NOW.getTime() + 20 * HOUR), fetchJson: fetcher(ALL, asked) });
    expect(asked).toEqual([NODE_INDEX_URL, NODE_SCHEDULE_URL, LITESTREAM_LATEST_URL]);
  });

  it('a source never fetched is "ще не завантажено"', () => {
    expect(readHostUpstream(db, NOW)).toEqual({
      nodeSecurity: { ok: false, reason: 'безпекові релізи Node ще не завантажено' },
      nodeEnd: { ok: false, reason: 'графік підтримки Node ще не завантажено' },
      litestream: { ok: false, reason: 'релізи litestream ще не завантажено' },
    });
  });

  it('a value older than 48 hours is stale; exactly 48 hours is not', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    expect(readHostUpstream(db, new Date(NOW.getTime() + 48 * HOUR)).nodeEnd).toEqual({ ok: true, value: '2028-04-30' });
    expect(readHostUpstream(db, new Date(NOW.getTime() + 48 * HOUR + 1)).nodeEnd)
      .toEqual({ ok: false, reason: 'графік підтримки Node застарів (понад 48 год)' });
  });

  it('a stored value that does not parse is "пошкоджено", per source', () => {
    setJobState(db, HOST_UPSTREAM_KEY, JSON.stringify({
      nodeEnd: { value: 'April', at: NOW.toISOString() },
      litestream: { value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' }, at: NOW.toISOString() },
    }));
    expect(readHostUpstream(db, NOW)).toEqual({
      nodeSecurity: { ok: false, reason: 'безпекові релізи Node ще не завантажено' },
      nodeEnd: { ok: false, reason: 'графік підтримки Node: збережений стан пошкоджено' },
      litestream: FRESH.litestream,
    });
  });

  it('an unparsable job_state blanks every source but does not throw', () => {
    setJobState(db, HOST_UPSTREAM_KEY, '{');
    expect(readHostUpstream(db, NOW).nodeSecurity)
      .toEqual({ ok: false, reason: 'безпекові релізи Node: збережений стан пошкоджено' });
  });

  it('a timestamp from the future is "пошкоджено", never fresh', () => {
    setJobState(db, HOST_UPSTREAM_KEY, JSON.stringify({
      nodeEnd: { value: '2028-04-30', at: new Date(NOW.getTime() + 2 * 60_000).toISOString() },
    }));
    expect(readHostUpstream(db, NOW).nodeEnd)
      .toEqual({ ok: false, reason: 'графік підтримки Node: збережений стан пошкоджено' });
  });

  it('a "no security release" null survives the round trip', async () => {
    const noSecurity = [{ version: 'v24.21.0', date: '2026-09-07', security: false }];
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher({ ...ALL, [NODE_INDEX_URL]: noSecurity }) });
    expect(readHostUpstream(db, NOW).nodeSecurity).toEqual({ ok: true, value: null });
  });

  it('refetches a source whose stored timestamp is in the future, and repairs it', async () => {
    setJobState(db, HOST_UPSTREAM_KEY, JSON.stringify({
      nodeEnd: { value: '2028-04-30', at: new Date(NOW.getTime() + 365 * 24 * HOUR).toISOString() },
    }));
    const asked: string[] = [];
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL, asked) });
    expect(asked).toContain(NODE_SCHEDULE_URL);
    expect(readHostUpstream(db, NOW).nodeEnd).toEqual({ ok: true, value: '2028-04-30' });
  });

  it('refetches a source whose fresh entry holds an invalid value, and repairs it', async () => {
    setJobState(db, HOST_UPSTREAM_KEY, JSON.stringify({ nodeEnd: { value: 'April', at: NOW.toISOString() } }));
    const asked: string[] = [];
    const later = new Date(NOW.getTime() + HOUR);
    await hostUpstream({ db, log, now: () => later, fetchJson: fetcher(ALL, asked) });
    expect(asked).toContain(NODE_SCHEDULE_URL);
    expect(readHostUpstream(db, later).nodeEnd).toEqual({ ok: true, value: '2028-04-30' });
  });

  it('a stored value of the wrong type (a one-element array) is "пошкоджено"', () => {
    setJobState(db, HOST_UPSTREAM_KEY, JSON.stringify({ nodeEnd: { value: ['2028-04-30'], at: NOW.toISOString() } }));
    expect(readHostUpstream(db, NOW).nodeEnd)
      .toEqual({ ok: false, reason: 'графік підтримки Node: збережений стан пошкоджено' });
  });

  it('writes one job_state row', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    expect(JSON.parse(getJobState(db, HOST_UPSTREAM_KEY)!)).toEqual({
      nodeSecurity: { value: { version: '24.18.1', date: '2026-07-28' }, at: NOW.toISOString() },
      nodeEnd: { value: '2028-04-30', at: NOW.toISOString() },
      litestream: { value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' }, at: NOW.toISOString() },
    });
  });
});
