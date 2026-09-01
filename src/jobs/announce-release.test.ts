import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile, setUserLanguage } from '../storage/user_profiles';
import { hashToken, rotateToken } from '../storage/api_tokens';
import { setAnnounceOptOut } from '../storage/announce';
import { getJobState, setJobState } from '../storage/job_state';
import {
  ANNOUNCED_VERSION_KEY,
  CHANGELOG_URL,
  announceRelease,
  buildAnnouncement,
  classifySendFailure,
  inSendWindow,
} from './announce-release';
import { createTranslator } from '../i18n';

const silent = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as unknown as import('pino').Logger;

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function withToken(db: DB, id: number): void {
  ensureProfile(db, id);
  rotateToken(db, id, hashToken(`raw-${id}`), '2026-09-01T00:00:00Z');
}

// 2026-09-01 is CEST (UTC+2), so 07:00Z is 09:00 Warsaw.
const inWindowNow = new Date('2026-09-01T09:00:00Z');   // 11:00 Warsaw
const nightNow = new Date('2026-09-01T01:00:00Z');      // 03:00 Warsaw

interface Sent { id: number; html: string }

function deps(db: DB, over: Partial<Parameters<typeof announceRelease>[0]> = {}) {
  const sent: Sent[] = [];
  const base = {
    db,
    log: silent,
    now: () => inWindowNow,
    fetchVersion: async () => '0.16.0',
    send: async (id: number, html: string) => { sent.push({ id, html }); },
    sleep: async () => {},
    ...over,
  };
  return { deps: base as Parameters<typeof announceRelease>[0], sent };
}

describe('inSendWindow', () => {
  test.each([
    ['2026-09-01T06:59:00Z', false], // 08:59 Warsaw
    ['2026-09-01T07:00:00Z', true],  // 09:00 Warsaw — inclusive start
    ['2026-09-01T19:59:00Z', true],  // 21:59 Warsaw
    ['2026-09-01T20:00:00Z', false], // 22:00 Warsaw — exclusive end
    ['2026-09-01T01:00:00Z', false], // 03:00 Warsaw
  ])('%s → %s', (iso, expected) => {
    expect(inSendWindow(new Date(iso as string))).toBe(expected);
  });

  test('the window follows Warsaw across DST, not UTC', () => {
    // 2026-12-01 is CET (UTC+1): 08:30Z is 09:30 Warsaw and inside the window,
    // while the same 08:30Z in CEST-summer would be 10:30 — also inside, so use
    // the boundary that actually differs: 07:30Z is 08:30 Warsaw in winter (out)
    // and 09:30 in summer (in).
    expect(inSendWindow(new Date('2026-12-01T07:30:00Z'))).toBe(false);
    expect(inSendWindow(new Date('2026-07-01T07:30:00Z'))).toBe(true);
  });
});

describe('classifySendFailure', () => {
  test.each([
    [{ code: 403 }, 'blocked', null],
    [{ response: { error_code: 403 } }, 'blocked', null],
    [{ code: 429, parameters: { retry_after: 7 } }, 'rate_limited', 7],
    [{ response: { error_code: 429, parameters: { retry_after: 12 } } }, 'rate_limited', 12],
    [{ code: 429 }, 'rate_limited', null],
    [new Error('socket hang up'), 'other', null],
    ['a string', 'other', null],
    [undefined, 'other', null],
    [{ code: 400 }, 'other', null],
  ])('%o → %s / %s', (err, kind, retryAfterSec) => {
    expect(classifySendFailure(err)).toEqual({ kind, retryAfterSec });
  });
});

describe('buildAnnouncement', () => {
  test('carries the version and the changelog URL', () => {
    const html = buildAnnouncement(createTranslator('en'), '0.16.0', CHANGELOG_URL);
    expect(html).toContain('0.16.0');
    expect(html).toContain(CHANGELOG_URL);
    expect(html).toContain('/announce off');
  });

  test('escapes angle brackets coming from a locale string', () => {
    const t = ((key: string, params?: Record<string, string>) =>
      key === 'announce.released' ? `<b>${params!.version}</b>` : 'x') as never;
    const html = buildAnnouncement(t, '0.16.0', CHANGELOG_URL);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('announceRelease', () => {
  test('outside the window it returns early and never touches the network', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    let polled = false;
    const { deps: d, sent } = deps(db, {
      now: () => nightNow,
      fetchVersion: async () => { polled = true; return '0.16.0'; },
    });
    const r = await announceRelease(d);
    expect(r.outcome).toBe('outside_window');
    expect(polled).toBe(false);
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('an unreadable version is "unavailable" and leaves the state alone', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d, sent } = deps(db, { fetchVersion: async () => null });
    const r = await announceRelease(d);
    expect(r.outcome).toBe('unavailable');
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('a thrown fetch is "unavailable", not a crash', async () => {
    const db = freshDb();
    const { deps: d } = deps(db, { fetchVersion: async () => { throw new Error('ENOTFOUND'); } });
    await expect(announceRelease(d)).resolves.toMatchObject({ outcome: 'unavailable' });
  });

  test('first ever run seeds the marker and announces nothing', async () => {
    const db = freshDb();
    withToken(db, 1);
    const { deps: d, sent } = deps(db, { fetchVersion: async () => '0.15.0' });
    const r = await announceRelease(d);
    expect(r.outcome).toBe('seeded');
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('the same version announces nothing', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.16.0');
    const { deps: d, sent } = deps(db);
    expect((await announceRelease(d)).outcome).toBe('unchanged');
    expect(sent).toEqual([]);
  });

  test('a lower version records the rollback but announces nothing', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.16.0');
    const { deps: d, sent } = deps(db, { fetchVersion: async () => '0.15.0' });
    expect((await announceRelease(d)).outcome).toBe('rollback');
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('a higher version reaches every opted-in token holder, in their language', async () => {
    const db = freshDb();
    withToken(db, 1); setUserLanguage(db, 1, 'uk');
    withToken(db, 2); setUserLanguage(db, 2, 'en');
    withToken(db, 3); setAnnounceOptOut(db, 3, true);
    ensureProfile(db, 4); // no token
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');

    const { deps: d, sent } = deps(db);
    const r = await announceRelease(d);

    expect(r).toMatchObject({ outcome: 'announced', version: '0.16.0', sent: 2 });
    expect(sent.map((s) => s.id)).toEqual([1, 2]);
    expect(sent[0].html).toBe(buildAnnouncement(createTranslator('uk'), '0.16.0', CHANGELOG_URL));
    expect(sent[1].html).toBe(buildAnnouncement(createTranslator('en'), '0.16.0', CHANGELOG_URL));
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.16.0');
  });

  test('a recipient with no language falls back to English', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d, sent } = deps(db);
    await announceRelease(d);
    expect(sent[0].html).toBe(buildAnnouncement(createTranslator('en'), '0.16.0', CHANGELOG_URL));
  });

  test('failures are counted by reason and do not stop the rest of the run', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2); withToken(db, 3);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d } = deps(db, {
      send: async (id: number) => {
        if (id === 1) throw { code: 403 };
        if (id === 2) throw new Error('socket hang up');
      },
    });
    const r = await announceRelease(d);
    expect(r).toMatchObject({
      outcome: 'announced',
      sent: 1,
      failed: { blocked: 1, rate_limited: 0, other: 1 },
    });
  });

  test('a 429 with retry_after is retried exactly once, then counted if it fails again', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const attempts: number[] = [];
    const slept: number[] = [];
    const { deps: d } = deps(db, {
      sleep: async (ms: number) => { slept.push(ms); },
      send: async (id: number) => {
        attempts.push(id);
        if (id === 1 && attempts.filter((a) => a === 1).length === 1) {
          throw { code: 429, parameters: { retry_after: 3 } };
        }
        if (id === 2) throw { code: 429, parameters: { retry_after: 1 } };
      },
    });
    const r = await announceRelease(d);
    // id 1: fails once, retried, succeeds. id 2: fails twice, counted once.
    expect(attempts).toEqual([1, 1, 2, 2]);
    expect(r).toMatchObject({ sent: 1, failed: { blocked: 0, rate_limited: 1, other: 0 } });
    expect(slept).toContain(3000);
  });

  test('a 429 without retry_after is not retried', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const attempts: number[] = [];
    const { deps: d } = deps(db, {
      send: async (id: number) => { attempts.push(id); throw { code: 429 }; },
    });
    const r = await announceRelease(d);
    expect(attempts).toEqual([1]);
    expect(r.failed.rate_limited).toBe(1);
  });

  test('the marker is written only after the last send', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const order: string[] = [];
    const { deps: d } = deps(db, {
      send: async (id: number) => {
        order.push(`send:${id} state=${getJobState(db, ANNOUNCED_VERSION_KEY)}`);
      },
    });
    await announceRelease(d);
    // Every send happened while the marker still held the OLD version.
    expect(order).toEqual(['send:1 state=0.15.0', 'send:2 state=0.15.0']);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.16.0');
  });

  test('a failure reading recipients propagates and leaves the marker untouched', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    db.exec('DROP TABLE api_tokens');
    const { deps: d } = deps(db);
    await expect(announceRelease(d)).rejects.toThrow();
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('the admin summary reports sent and failures by reason', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const alerts: string[] = [];
    const { deps: d } = deps(db, {
      notifyAdmin: (m: string) => { alerts.push(m); },
      send: async (id: number) => { if (id === 2) throw { code: 403 }; },
    });
    await announceRelease(d);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('0.16.0');
    expect(alerts[0]).toContain('sent=1');
    expect(alerts[0]).toContain('blocked=1');
  });

  test('no admin summary when nothing was announced', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.16.0');
    const alerts: string[] = [];
    const { deps: d } = deps(db, { notifyAdmin: (m: string) => { alerts.push(m); } });
    await announceRelease(d);
    expect(alerts).toEqual([]);
  });

  test('every delivery classified "other" holds the marker for a retry', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d } = deps(db, {
      send: async () => { throw new Error('socket hang up'); },
    });
    const r = await announceRelease(d);
    expect(r).toMatchObject({
      outcome: 'announced',
      sent: 0,
      failed: { blocked: 0, rate_limited: 0, other: 2 },
    });
    // Held, not advanced: a future tick still has a shot at delivering 0.16.0.
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('every delivery classified "blocked" still advances the marker (permanent, not transient)', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d } = deps(db, {
      send: async () => { throw { code: 403 }; },
    });
    const r = await announceRelease(d);
    expect(r).toMatchObject({
      outcome: 'announced',
      sent: 0,
      failed: { blocked: 2, rate_limited: 0, other: 0 },
    });
    // Not held: retrying forever against two permanently-blocked recipients buys nothing.
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.16.0');
  });

  test('zero recipients (everyone opted out) still advances the marker', async () => {
    const db = freshDb();
    withToken(db, 1);
    setAnnounceOptOut(db, 1, true);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d } = deps(db);
    const r = await announceRelease(d);
    expect(r).toMatchObject({ outcome: 'announced', sent: 0, failed: { blocked: 0, rate_limited: 0, other: 0 } });
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.16.0');
  });

  test('the rate-limit retry sleep is capped at 60s even when retry_after asks for longer', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const slept: number[] = [];
    const { deps: d } = deps(db, {
      sleep: async (ms: number) => { slept.push(ms); },
      send: async (id: number) => {
        if (id === 1 && slept.length === 0) throw { code: 429, parameters: { retry_after: 900 } };
      },
    });
    await announceRelease(d);
    // 900s reported by Telegram must not appear verbatim in the sleep call — capped to 60s.
    expect(slept).toContain(60000);
    expect(slept).not.toContain(900000);
  });
});
