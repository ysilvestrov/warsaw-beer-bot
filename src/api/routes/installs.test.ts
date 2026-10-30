import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { REGISTRATIONS_PER_DAY } from '../../storage/extension_installs';
import { recordMisses } from '../../storage/match_misses';
import { recordInstallUsage } from '../../storage/install_usage';
import { warsawDateAndHour } from '../../domain/warsaw-time';
import { createApiApp } from '../index';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 555);
  rotateToken(db, 555, hashToken('tg-token'), '2026-06-07T00:00:00Z');
  const sent: string[] = [];
  const notifyAdmin = async (msg: string) => { sent.push(msg); };
  const app = createApiApp({ db, env: {} as never, log: pino({ level: 'silent' }), releaseSha: null, notifyAdmin });
  return { db, app, sent };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function register(app: ReturnType<typeof setup>['app']) {
  const res = await app.request('/installs', json({ version: '0.23.0' }));
  return { res, body: await res.json() as { install_id: string; token: string } };
}

function fillToCap(db: ReturnType<typeof setup>['db']) {
  db.prepare('INSERT INTO install_registrations_daily (date, registrations) VALUES (?, ?)')
    .run(warsawDateAndHour(new Date()).date, REGISTRATIONS_PER_DAY);
}

describe('POST /installs', () => {
  it('201 with a wbi_ token of 68 characters; only its hash is stored', async () => {
    const { app, db } = setup();
    const { res, body } = await register(app);
    expect(res.status).toBe(201);
    expect(body.token).toMatch(/^wbi_[0-9a-f]{64}$/);
    expect(body.token).toHaveLength(68);
    expect(db.prepare('SELECT install_id, token_hash, ext_version FROM extension_installs').all()).toEqual([
      { install_id: body.install_id, token_hash: hashToken(body.token), ext_version: '0.23.0' },
    ]);
  });

  it('two registrations get two different tokens', async () => {
    const { app } = setup();
    const a = await register(app);
    const b = await register(app);
    expect(a.body.token).not.toBe(b.body.token);
    expect(a.body.install_id).not.toBe(b.body.install_id);
  });

  it.each([[''], ['x'.repeat(33)]])('400 for version %j', async (version) => {
    const { app, db } = setup();
    const res = await app.request('/installs', json({ version }));
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS c FROM extension_installs').get()).toEqual({ c: 0 });
  });

  it('accepts a 32-character version (the upper bound)', async () => {
    const { app } = setup();
    expect((await app.request('/installs', json({ version: 'x'.repeat(32) }))).status).toBe(201);
  });

  it('429 at the daily cap, and two refusals in a row send exactly one admin alert', async () => {
    const { app, db, sent } = setup();
    fillToCap(db);
    expect((await app.request('/installs', json({ version: '1' }))).status).toBe(429);
    const second = await app.request('/installs', json({ version: '1' }));
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: 'registrations_capped' });
    expect(sent).toEqual([
      'Розширення: досягнуто стелі 2000 реєстрацій установок за добу — реєстрації відхиляються до кінця доби (Варшава)',
    ]);
  });
});

describe('DELETE /installs/me', () => {
  it('204 deletes the install and its usage; a repeat with the same token is 401; misses stay', async () => {
    const { app, db } = setup();
    const { body } = await register(app);
    const date = warsawDateAndHour(new Date()).date;
    recordInstallUsage(db, { date, installId: body.install_id, shop: 'a.pl', matchRequests: 1 });
    recordMisses(db, { at: new Date().toISOString(), date, shop: 'a.pl', cards: [{ brewery: 'B', name: 'N' }] });
    const auth = { method: 'DELETE', headers: { Authorization: `Bearer ${body.token}` } };

    expect((await app.request('/installs/me', auth)).status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS c FROM extension_installs').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM install_usage_daily').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM match_misses').get()).toEqual({ c: 1 });
    expect((await app.request('/installs/me', auth)).status).toBe(401);
  });

  it('401 without a token, and 401 for a Telegram token (it is not an install)', async () => {
    const { app, db } = setup();
    await register(app);
    expect((await app.request('/installs/me', { method: 'DELETE' })).status).toBe(401);
    const tg = await app.request('/installs/me', { method: 'DELETE', headers: { Authorization: 'Bearer tg-token' } });
    expect(tg.status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS c FROM extension_installs').get()).toEqual({ c: 1 });
  });
});
