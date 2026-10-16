import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile, setUntappdUsername } from '../storage/user_profiles';
import { getFestBySlug } from '../storage/fests';
import { addMember, createTeam } from '../storage/fest_teams';
import { upsertMenuItem } from '../storage/fest_menu';
import { mergeCheckin } from '../storage/checkins';
import { markGlass, takeBeer } from '../storage/fest_queue';
import { addPresence } from '../storage/fest_presence';
import { buildFestView } from './fest-view';
import { buildQueueView, isOpen, openGlassOf } from './fest-queue-view';

function setup(): { db: DB; festId: number; teamId: number } {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  for (const [id, name] of [[1, 'ysilvestrov'], [2, 'Nesh05']] as const) {
    ensureProfile(db, id);
    setUntappdUsername(db, id, name);
  }
  const team = createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z');
  addMember(db, team.id, 1, 'YS', '2026-10-01T00:00:00.000Z');
  addMember(db, team.id, 2, 'OB', '2026-10-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery, style, rating_global)
     VALUES (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew', 'IPA - American', 4.1)`,
  ).run();
  upsertMenuItem(db, festId, 11, 'PINTA', '2026-10-15T10:00:00.000Z');
  return { db, festId, teamId: team.id };
}

describe('buildQueueView', () => {
  it('keeps a beer in the queue after a member drank it, closed for that member only', () => {
    const { db, festId, teamId } = setup();
    addPresence(db, { teamId, telegramId: 1, kind: 'start', at: '2026-10-15T17:00:00.000Z' });
    takeBeer(db, { teamId, beerId: 11, addedBy: 2, at: '2026-10-15T18:00:00.000Z' });
    mergeCheckin(db, { checkin_id: '900', telegram_id: 1, beer_id: 11, user_rating: 4, checkin_at: '2026-10-15T18:05:00Z', venue: null });
    const now = new Date('2026-10-15T18:10:00.000Z');
    expect(buildFestView(db, { festId, teamId, now }).targets).toEqual([]);
    expect(buildQueueView(db, { festId, teamId }).items).toEqual([{
      id: 1, glassNo: 1, beerId: 11, name: 'Bravo', brewery: 'Brew', bid: 6000011, section: 'PINTA',
      takenBy: 'OB', addedAt: '2026-10-15T18:00:00.000Z',
      closedBy: [{ telegramId: 1, initials: 'YS', checkinId: '900', marked: false }, { telegramId: 2, initials: 'OB', checkinId: null, marked: false }],
    }]);
  });

  it('an empty queue is an empty view', () => {
    const { db, festId, teamId } = setup();
    expect(buildQueueView(db, { festId, teamId })).toEqual({ items: [] });
  });
});

describe('buildQueueView with presence and marks (spec 2026-10-15-fest-queue-reality-design.md §PR 2)', () => {
  it('a member who came after the glass left the table is not in its row; one who marked it shows ☑️', () => {
    const { db, festId, teamId } = setup();
    const glass = takeBeer(db, { teamId, beerId: 11, addedBy: 2, at: '2026-10-15T18:00:00.000Z' });
    addPresence(db, { teamId, telegramId: 1, kind: 'start', at: '2026-10-15T18:41:00.000Z' });
    markGlass(db, { queueId: glass.id, telegramId: 2, at: '2026-10-15T18:20:00.000Z' });
    const [item] = buildQueueView(db, { festId, teamId }).items;
    expect([item.closedBy, isOpen(item)]).toEqual([[{ telegramId: 2, initials: 'OB', checkinId: null, marked: true }], false]);
  });

  it('a member who came ten minutes after «Взяв» is waited for', () => {
    const { db, festId, teamId } = setup();
    takeBeer(db, { teamId, beerId: 11, addedBy: 2, at: '2026-10-15T18:00:00.000Z' });
    addPresence(db, { teamId, telegramId: 1, kind: 'start', at: '2026-10-15T18:10:00.000Z' });
    expect(buildQueueView(db, { festId, teamId }).items[0].closedBy.map((c) => c.initials)).toEqual(['YS', 'OB']);
  });
});

describe('openGlassOf', () => {
  it('finds an open glass of the beer while it is on the table, and nothing once it is closed, older or another beer', () => {
    const { db, festId, teamId } = setup();
    db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
                VALUES (12, 6000012, 'Charlie', 'Brew', 'charlie', 'brew')`).run();
    const glass = takeBeer(db, { teamId, beerId: 11, addedBy: 2, at: '2026-10-15T18:00:00.000Z' });
    const open = buildQueueView(db, { festId, teamId });
    markGlass(db, { queueId: glass.id, telegramId: 2, at: '2026-10-15T18:05:00.000Z' });
    const closed = buildQueueView(db, { festId, teamId });
    expect([
      openGlassOf(open, 11, new Date('2026-10-15T18:40:00.000Z')),
      openGlassOf(open, 11, new Date('2026-10-15T18:40:01.000Z')),
      openGlassOf(open, 12, new Date('2026-10-15T18:05:00.000Z')),
      openGlassOf(closed, 11, new Date('2026-10-15T18:05:00.000Z')),
    ]).toEqual([1, null, null, null]);
  });
});
