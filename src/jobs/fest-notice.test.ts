import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { getJobState } from '../storage/job_state';
import { festNotice, festSessionOn } from './fest-notice';

// WFP22 seed: session 1 is 2026-10-15 14:00–22:00 UTC, session 2 starts 2026-10-16 12:00.
function setup(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('festNotice', () => {
  it('in a session it records the time under its key and says to stay quiet', () => {
    const db = setup();
    const now = new Date('2026-10-15T18:00:00.000Z');
    expect([festNotice(db, now, 'mcp_down'), getJobState(db, 'fest_notice_at:mcp_down')]).toEqual([true, now.toISOString()]);
  });

  it('a session bound is part of the session', () => {
    const db = setup();
    expect([festNotice(db, new Date('2026-10-15T14:00:00.000Z'), 'cookie'), festNotice(db, new Date('2026-10-15T22:00:00.000Z'), 'cookie')])
      .toEqual([true, true]);
  });

  it('in the polling margin and between sessions the alert goes out and nothing is recorded', () => {
    const db = setup();
    const r = [
      festNotice(db, new Date('2026-10-15T13:40:00.000Z'), 'cookie'),
      festNotice(db, new Date('2026-10-15T22:01:00.000Z'), 'cookie'),
      festNotice(db, new Date('2026-10-16T03:00:00.000Z'), 'cookie'),
    ];
    expect([r, getJobState(db, 'fest_notice_at:cookie')]).toEqual([[false, false, false], null]);
  });

  it('a failing database lets the alert go out', () => {
    const db = setup();
    db.close();
    expect(festNotice(db, new Date('2026-10-15T18:00:00.000Z'), 'mcp_login')).toBe(false);
  });
});

describe('festSessionOn', () => {
  it('names the session on now, and none after the fest', () => {
    const db = setup();
    expect([festSessionOn(db, new Date('2026-10-16T12:30:00.000Z'))!.session.session_no, festSessionOn(db, new Date('2026-10-18T12:00:00.000Z'))])
      .toEqual([2, null]);
  });
});
