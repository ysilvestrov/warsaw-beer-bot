import pino from 'pino';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile, setUntappdUsername } from '../storage/user_profiles';
import { getFestBySlug } from '../storage/fests';
import { addMember, createTeam } from '../storage/fest_teams';
import { upsertMenuItem } from '../storage/fest_menu';
import { insertVenueCheckins } from '../storage/venue_checkins';
import { mergeCheckin } from '../storage/checkins';
import { runFestAlerts } from './fest-alerts';

const NOW = new Date('2026-10-15T18:00:00.000Z'); // session 1: 14:00–22:00Z

function setup(): { db: DB; teamId: number; sent: [number, string][]; deps: Parameters<typeof runFestAlerts>[0] } {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  ensureProfile(db, 1);
  setUntappdUsername(db, 1, 'ysilvestrov');
  const teamId = createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id;
  addMember(db, teamId, 1, 'YS', '2026-10-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery, style, rating_global) VALUES
     (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew', 'IPA - American', 4.1),
     (12, 6000012, 'Charlie', 'Brew', 'charlie', 'brew', 'IPA - American', 4.3)`,
  ).run();
  upsertMenuItem(db, festId, 11, 'PINTA', '2026-10-15T10:00:00.000Z');
  upsertMenuItem(db, festId, 12, 'Verdant', '2026-10-15T10:00:00.000Z');
  const sent: [number, string][] = [];
  const deps = { db, log: pino({ level: 'silent' }), send: async (chatId: number, html: string) => { sent.push([chatId, html]); } };
  return { db, teamId, sent, deps };
}

// 35 alert lines of the long names below (~113 characters each) fit under 4000; a 36th would not.
const FIRST_FIT = 35;

const tap = (db: DB, checkinId: number, bid: number, at: string) =>
  insertVenueCheckins(db, [{ checkin_id: checkinId, venue_id: 2167060, bid, untappd_user: null, checkin_at: at }], 'laptop', at);

describe('runFestAlerts', () => {
  it('announces a fresh tap and one already pouring in one message to the group, once per session', async () => {
    const { db, sent, deps } = setup();
    tap(db, 501, 6000011, '2026-10-15T17:50:00.000Z');
    tap(db, 502, 6000012, '2026-10-15T17:10:00.000Z');
    tap(db, 503, 6000012, '2026-10-15T17:55:00.000Z');
    await runFestAlerts(deps, NOW);
    await runFestAlerts(deps, new Date(NOW.getTime() + 60_000));
    expect(sent).toEqual([[-100, [
      '🆕 З\'явилося на крані:',
      '• <b>Bravo</b> — Brew · PINTA · перший чекін 19:50',
      '',
      '🍺 Уже наливають:',
      '• <b>Charlie</b> — Brew · Verdant · перший чекін 19:10',
    ].join('\n')]]);
    expect(db.prepare('SELECT session_no, beer_id, checkin_id FROM fest_alerts_sent ORDER BY beer_id').all())
      .toEqual([{ session_no: 1, beer_id: 11, checkin_id: 501 }, { session_no: 1, beer_id: 12, checkin_id: 502 }]);
  });

  it('the next session announces the beer again', async () => {
    const { db, sent, deps } = setup();
    tap(db, 501, 6000011, '2026-10-15T17:50:00.000Z');
    await runFestAlerts(deps, NOW);
    tap(db, 601, 6000011, '2026-10-16T12:10:00.000Z');
    await runFestAlerts(deps, new Date('2026-10-16T12:15:00.000Z'));
    expect(sent.map(([, html]) => html.split('\n')[1])).toEqual([
      '• <b>Bravo</b> — Brew · PINTA · перший чекін 19:50',
      '• <b>Bravo</b> — Brew · PINTA · перший чекін 14:10',
    ]);
  });

  it('a message Telegram did not take is sent again on the next tick', async () => {
    const { db, sent, deps } = setup();
    tap(db, 501, 6000011, '2026-10-15T17:50:00.000Z');
    const outcomes = [() => Promise.reject(new Error('tg down')), () => Promise.resolve()];
    const flaky = { ...deps, send: async (chatId: number, html: string) => { await outcomes.shift()!(); sent.push([chatId, html]); } };
    await runFestAlerts(flaky, NOW);
    const afterFailure = db.prepare('SELECT COUNT(*) AS n FROM fest_alerts_sent').get();
    await runFestAlerts(flaky, new Date(NOW.getTime() + 60_000));
    expect([afterFailure, sent.length]).toEqual([{ n: 0 }, 1]);
  });

  it('a beer a member already drank is not a Target and is not announced', async () => {
    const { db, sent, deps } = setup();
    mergeCheckin(db, { checkin_id: '900', telegram_id: 1, beer_id: 11, user_rating: null, checkin_at: '2026-09-01T00:00:00Z', venue: null });
    tap(db, 501, 6000011, '2026-10-15T17:50:00.000Z');
    await runFestAlerts(deps, NOW);
    expect(sent).toEqual([]);
  });

  it("one team's failure does not stop the alert of another team", async () => {
    const { db, sent, deps } = setup();
    const festId = getFestBySlug(db, 'wfp22')!.id;
    const second = createTeam(db, festId, -200, '2026-10-02T00:00:00.000Z').id;
    addMember(db, second, 1, 'YS', '2026-10-02T00:00:00.000Z');
    tap(db, 501, 6000011, '2026-10-15T17:50:00.000Z');
    // Teams go in id order: the first (-100) is refused, the second (-200) accepted.
    const outcomes = [() => Promise.reject(new Error('bot was kicked')), () => Promise.resolve()];
    const picky = { ...deps, send: async (chatId: number, html: string) => { await outcomes.shift()!(); sent.push([chatId, html]); } };
    await runFestAlerts(picky, NOW);
    expect(sent.map(([chatId]) => chatId)).toEqual([-200]);
  });

  it('beers that did not fit into one message are announced on the next tick, not dropped', async () => {
    const { db, sent, deps } = setup();
    const festId = getFestBySlug(db, 'wfp22')!.id;
    const insert = db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery, style, rating_global)
                               VALUES (?, ?, ?, 'Brew', ?, 'brew', 'IPA - American', 4.5)`);
    for (let i = 0; i < 40; i++) {
      const id = 100 + i;
      insert.run(id, 7000000 + i, `Very Long Festival Special Edition Double Dry Hopped Beer Number ${i}`, `n${i}`);
      upsertMenuItem(db, festId, id, 'PINTA', '2026-10-15T10:00:00.000Z');
      tap(db, 1000 + i, 7000000 + i, '2026-10-15T17:55:00.000Z');
    }
    await runFestAlerts(deps, NOW);
    const first = (db.prepare('SELECT COUNT(*) AS n FROM fest_alerts_sent').get() as { n: number }).n;
    await runFestAlerts(deps, new Date(NOW.getTime() + 60_000));
    const total = (db.prepare('SELECT COUNT(*) AS n FROM fest_alerts_sent').get() as { n: number }).n;
    // Both messages stay within Telegram's limit; the first holds FIRST_FIT of the 40 lines (each
    // line of these names is ~100 characters), and every beer is announced once across the two ticks.
    expect([sent.map(([, html]) => html.length <= 4000), first, total]).toEqual([[true, true], FIRST_FIT, 40]);
  });

  it('outside every polling window it does nothing', async () => {
    const { db, sent, deps } = setup();
    tap(db, 501, 6000011, '2026-10-15T17:50:00.000Z');
    expect([await runFestAlerts(deps, new Date('2026-10-16T02:00:00.000Z')), sent]).toEqual([0, []]);
  });
});
