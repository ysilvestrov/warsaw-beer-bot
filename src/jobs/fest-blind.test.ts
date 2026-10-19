import pino from 'pino';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { addCoverage } from '../storage/fest_coverage';
import { runFestBlindCheck } from './fest-blind';

// WFP22 seed: session 2 is 2026-10-16 12:00–22:00 UTC; the main venue is 11142155.
const MAIN = 11142155;
const at = (hhmm: string, day = '16') => new Date(`2026-10-${day}T${hhmm}:00.000Z`);

function setup() {
  const db: DB = openDb(':memory:');
  migrate(db);
  const alerts: string[] = [];
  const deps = { db, log: pino({ level: 'silent' }), notifyAdmin: async (m: string) => { alerts.push(m); } };
  return { db, deps, alerts };
}
const cover = (db: DB, from: string, to: string, venue = MAIN) =>
  addCoverage(db, venue, { from_at: at(from).toISOString(), to_at: at(to).toISOString() }, 'laptop', at(to).toISOString());

describe('runFestBlindCheck', () => {
  it('nine minutes uncovered is nothing; eleven alerts once; half an hour later it does not repeat', async () => {
    const { db, deps, alerts } = setup();
    cover(db, '12:00', '14:00');
    const results = [
      await runFestBlindCheck(deps, at('14:09')),
      await runFestBlindCheck(deps, at('14:11')),
      await runFestBlindCheck(deps, at('14:41')),
    ];
    expect([results, alerts]).toEqual([
      [null, 11, 41],
      ['Фест: бот не бачить головну локацію жодним оком 11 хв — алерти й статуси кранів зараз неправдиві'],
    ]);
  });

  it('the first minutes of a session after a night of no coverage are not blindness', async () => {
    const { db, deps, alerts } = setup();
    addCoverage(db, MAIN, { from_at: at('20:00', '15').toISOString(), to_at: at('22:00', '15').toISOString() }, 'laptop', at('22:00', '15').toISOString());
    expect([await runFestBlindCheck(deps, at('12:05')), alerts]).toEqual([null, []]);
  });

  it('no coverage at all counts from the session start', async () => {
    const { deps } = setup();
    expect(await runFestBlindCheck(deps, at('12:11'))).toBe(11);
  });

  it('within the polling margin around a session, and between sessions, nothing is checked', async () => {
    const { deps, alerts } = setup();
    expect([await runFestBlindCheck(deps, at('11:45')), await runFestBlindCheck(deps, at('22:20')), alerts]).toEqual([null, null, []]);
  });

  it('coverage of another venue does not count for the main one', async () => {
    const { db, deps } = setup();
    cover(db, '12:00', '14:00', 2167060);
    expect(await runFestBlindCheck(deps, at('12:20'))).toBe(20);
  });
});
