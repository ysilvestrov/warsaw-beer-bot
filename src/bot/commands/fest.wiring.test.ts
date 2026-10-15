import { Markup, Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import { createTranslator } from '../../i18n';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { getFestBySlug } from '../../storage/fests';
import { addMember, createTeam, isTeamMember } from '../../storage/fest_teams';
import { upsertMenuItem } from '../../storage/fest_menu';
import { queueFor } from '../../storage/fest_queue';
import { stationTeam } from '../../storage/fest_print';
import { insertVenueCheckins } from '../../storage/venue_checkins';
import type { BotContext } from '../index';
import { compactLinkQuery, createFestCommand, pickCallback, type FestCommandDeps } from './fest';
import { beerLinkOf } from '../../sources/untappd/beer-link';

const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};

function callback(updateId: number, from: number, data: string) {
  return { update_id: updateId, callback_query: { id: `cb-${updateId}`, chat_instance: 'x', data,
    from: { id: from, is_bot: false, first_name: 'Test' },
    message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup' as const, title: 'Team' } } } };
}

function setup(extra: Partial<FestCommandDeps> = {}): {
  db: DB; bot: Telegraf<BotContext>; teamId: number; replies: string[]; answers: (string | undefined)[]; extras: unknown[];
  replyExtras: unknown[]; edits: unknown[];
} {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  ensureProfile(db, 7);
  setUntappdUsername(db, 7, 'member');
  const teamId = createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id;
  addMember(db, teamId, 7, 'YS', '2026-10-01T00:00:00.000Z');
  db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
              VALUES (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew')`).run();
  upsertMenuItem(db, festId, 11, 'PINTA', '2026-10-15T10:00:00.000Z');
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  const replies: string[] = [];
  const answers: (string | undefined)[] = [];
  const extras: unknown[] = [];
  const replyExtras: unknown[] = [];
  const edits: unknown[] = [];
  bot.use((ctx, next) => {
    ctx.deps = { db, env: {}, log: { warn: () => {} } } as never;
    ctx.locale = 'en';
    ctx.t = createTranslator('en');
    ctx.reply = (async (message: string, extra?: unknown) => { replies.push(message); replyExtras.push(extra); return { message_id: 1 }; }) as never;
    ctx.editMessageReplyMarkup = (async (markup: unknown) => { edits.push(markup); return true; }) as never;
    ctx.answerCbQuery = (async (text?: string, extra?: unknown) => { answers.push(text); extras.push(extra); return true; }) as never;
    return next();
  });
  bot.use(createFestCommand({ downloadFile: async () => Buffer.from(''), printStationUrl: 'https://beer-api.example/fest-print', ...extra }));
  return { db, bot, teamId, replies, answers, extras, replyExtras, edits };
}

describe('«Я в команді» (fest:j)', () => {
  it('someone without a linked Untappd is told so in an alert only they see, and is not added', async () => {
    const { db, bot, teamId, replies, answers, extras } = setup();
    await bot.handleUpdate(callback(1, 8, `fest:j:${teamId}`) as unknown as Update);
    expect([replies, answers, extras, isTeamMember(db, teamId, 8)]).toEqual([
      [], ['First link Untappd in a private chat with the bot: /link <username>'], [{ show_alert: true }], false,
    ]);
  });

  it('someone with a linked Untappd joins and is announced by name', async () => {
    const { db, bot, teamId, replies, answers } = setup();
    ensureProfile(db, 8);
    setUntappdUsername(db, 8, 'newcomer');
    await bot.handleUpdate(callback(1, 8, `fest:j:${teamId}`) as unknown as Update);
    expect([replies, answers, isTeamMember(db, teamId, 8)]).toEqual([['✅ Test joined the team.'], [undefined], true]);
  });

  it('a member who presses again is told so and nothing is posted', async () => {
    const { bot, teamId, replies, answers, extras } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:j:${teamId}`) as unknown as Update);
    expect([replies, answers, extras]).toEqual([[], ['You are already in the team.'], [undefined]]);
  });

  it('a button of a team that does not exist posts nothing and adds nobody', async () => {
    const { db, bot, teamId, replies, answers } = setup();
    await bot.handleUpdate(callback(1, 8, `fest:j:${teamId + 1}`) as unknown as Update);
    expect([replies, answers, isTeamMember(db, teamId, 8)]).toEqual([[], [undefined], false]);
  });
});

describe('«Взяв» (fest:q)', () => {
  it('a member gets a glass number, announced in the chat; a double tap gives the same glass', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    await bot.handleUpdate(callback(2, 7, `fest:q:${teamId}:11`) as unknown as Update);
    expect(queueFor(db, teamId).map((r) => [r.glass_no, r.beer_id, r.added_by])).toEqual([[1, 11, 7]]);
    expect(replies).toEqual(['🍺 Glass #1 — Bravo · YS', '🍺 Glass #1 — Bravo · YS']);
  });

  it('someone outside the team queues nothing and is told so', async () => {
    const { db, bot, teamId, replies, answers } = setup();
    await bot.handleUpdate(callback(1, 8, `fest:q:${teamId}:11`) as unknown as Update);
    expect([queueFor(db, teamId), replies, answers]).toEqual([[], [], ['This is for team members — press “I’m in the team”.']]);
  });

  it('a button pressed after the fest is over queues nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    try {
      const { db, bot, teamId, answers } = setup();
      await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
      expect([queueFor(db, teamId), answers]).toEqual([[], [createTranslator('en')('fest.no_fest')]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a beer that is not on the menu queues nothing', async () => {
    const { db, bot, teamId } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:999`) as unknown as Update);
    expect(queueFor(db, teamId)).toEqual([]);
  });
});

function command(updateId: number, from: number, chat: { id: number; type: 'private' | 'supergroup' }, text: string) {
  return { update_id: updateId, message: { message_id: updateId, date: 1, text,
    entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    chat: chat.type === 'private' ? { id: chat.id, type: 'private' as const, first_name: 'T' } : { id: chat.id, type: 'supergroup' as const, title: 'Team' },
    from: { id: from, is_bot: false, first_name: 'Test' } } };
}

const GROUP = { id: -100, type: 'supergroup' as const };
const glasses = (db: DB, teamId: number) => queueFor(db, teamId).map((r) => [r.glass_no, r.beer_id]);
const CAROTENES = {
  untappd_id: 7230846, name: 'Carotenes', brewery: 'Magic Road', style: 'IPA', abv: 6, rating_global: 3.9,
  normalized_name: 'carotenes', normalized_brewery: 'magic road', untappd_id_source: 'checkin' as const,
};

describe('/fest take <Untappd link>', () => {
  it('a beer the bot knows is taken at once by its full link, off the menu or not', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(command(1, 7, GROUP, '/fest take https://untappd.com/b/brew-bravo/6000011') as unknown as Update);
    expect([glasses(db, teamId), replies]).toEqual([[[1, 11]], ['🍺 Glass #1 — Bravo · YS']]);
  });

  it('a short link is resolved, and a beer the bot has never seen is read from Untappd and stored', async () => {
    const asked: unknown[] = [];
    const { db, bot, teamId, replies } = setup({
      resolveShortLink: async (url) => { asked.push(url); return 7230846; },
      lookupBeer: async (bid) => { asked.push(bid); return CAROTENES; },
    });
    await bot.handleUpdate(command(1, 7, GROUP, '/fest take https://untp.beer/q5a8n') as unknown as Update);
    const beer = db.prepare('SELECT id, name, brewery FROM beers WHERE untappd_id = 7230846').get() as { id: number; name: string; brewery: string };
    expect([asked, beer.name, beer.brewery, glasses(db, teamId), replies]).toEqual([
      ['https://untp.beer/q5a8n', 7230846], 'Carotenes', 'Magic Road', [[1, beer.id]], ['🍺 Glass #1 — Carotenes · YS'],
    ]);
  });

  it('an unknown beer without the Untappd lookup, or one it cannot find, takes nothing and says so', async () => {
    const t = createTranslator('en');
    const without = setup();
    await without.bot.handleUpdate(command(1, 7, GROUP, '/fest take https://untappd.com/b/x/7230846') as unknown as Update);
    const failing = setup({ lookupBeer: async () => { throw new Error('mcp down'); } });
    await failing.bot.handleUpdate(command(1, 7, GROUP, '/fest take https://untappd.com/b/x/7230846') as unknown as Update);
    const other = setup({ lookupBeer: async () => ({ ...CAROTENES, untappd_id: 1 }) });
    await other.bot.handleUpdate(command(1, 7, GROUP, '/fest take https://untappd.com/b/x/7230846') as unknown as Update);
    expect([without, failing, other].map((s) => [glasses(s.db, s.teamId), s.replies])).toEqual([
      [[], [t('fest.take_link_unknown')]], [[], [t('fest.take_link_unknown')]], [[], [t('fest.take_link_unknown')]],
    ]);
  });

  it('a short link that does not lead to a beer takes nothing and says so', async () => {
    const { db, bot, teamId, replies } = setup({ resolveShortLink: async () => null });
    await bot.handleUpdate(command(1, 7, GROUP, '/fest take https://untp.beer/zzz') as unknown as Update);
    expect([glasses(db, teamId), replies]).toEqual([[], [createTranslator('en')('fest.take_link_bad')]]);
  });

  it('a full link fits the team picker whole, so the beer picked is the beer linked', () => {
    const query = compactLinkQuery('https://untappd.com/b/magic-road-carotenes-double-dry-hopped/7230846');
    const data = pickCallback(123456789, 'take', query);
    expect([query, data, beerLinkOf(data.slice('fest:t:123456789:take:'.length))]).toEqual([
      'https://untappd.com/b/-/7230846', 'fest:t:123456789:take:https://untappd.com/b/-/7230846', { bid: 7230846 },
    ]);
  });

  it('someone outside the team takes nothing by link', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(command(1, 8, GROUP, '/fest take https://untappd.com/b/brew-bravo/6000011') as unknown as Update);
    expect([glasses(db, teamId), replies]).toEqual([[], [createTranslator('en')('fest.not_member')]]);
  });
});

describe('/fest take <text> beyond eight matches (#873)', () => {
  const addMenu = (db: DB, n: number) => {
    const festId = getFestBySlug(db, 'wfp22')!.id;
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
                  VALUES (?, ?, ?, 'Wfp', ?, 'wfp')`).run(100 + i, 7000000 + i, `WFP ${i}`, `wfp ${i}`);
      upsertMenuItem(db, festId, 100 + i, 'WFP', '2026-10-15T10:00:00.000Z');
    }
  };

  it('says how many are shown of how many when more match than fit', async () => {
    const { db, bot, replies } = setup();
    addMenu(db, 9);
    await bot.handleUpdate(command(1, 7, GROUP, '/fest take wfp') as unknown as Update);
    expect(replies).toEqual(['Which beer did you get?\nShowing 8 of 9 — narrow the search.']);
  });

  it('says nothing more when every match is shown', async () => {
    const { db, bot, replies } = setup();
    addMenu(db, 8);
    await bot.handleUpdate(command(1, 7, GROUP, '/fest take wfp') as unknown as Update);
    expect(replies).toEqual(['Which beer did you get?']);
  });
});

describe('/fest printer', () => {
  it("in a private chat a member gets a station link whose token opens the team's print queue", async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(command(1, 7, { id: 7, type: 'private' }, '/fest printer') as unknown as Update);
    const token = /#t=([A-Za-z0-9_-]+)/.exec(replies[0])![1];
    expect([replies.length, replies[0].includes('https://beer-api.example/fest-print#t='), stationTeam(db, token, '2026-10-17T21:00:00.000Z')])
      .toEqual([1, true, teamId]);
  });

  it('in the group chat it sends no link, only where to ask', async () => {
    const { db, bot, replies } = setup();
    await bot.handleUpdate(command(1, 7, { id: -100, type: 'supergroup' }, '/fest printer') as unknown as Update);
    expect([replies, db.prepare('SELECT COUNT(*) AS n FROM fest_print_stations').get()])
      .toEqual([['The print station link is sent only in a private chat: message me /fest printer.'], { n: 0 }]);
  });

  it('the station stops working a day after the last session', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(command(1, 7, { id: 7, type: 'private' }, '/fest printer') as unknown as Update);
    const token = /#t=([A-Za-z0-9_-]+)/.exec(replies[0])![1];
    // The last WFP22 session ends 2026-10-17 22:00Z.
    expect([stationTeam(db, token, '2026-10-18T21:59:59.000Z'), stationTeam(db, token, '2026-10-18T22:00:00.000Z')])
      .toEqual([teamId, null]);
  });
});

describe('cancelling a glass (fest:u, /fest drop)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T18:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('the «Взяв» reply carries a cancel button for that glass', async () => {
    const { bot, teamId, replyExtras } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    expect(replyExtras).toEqual([Markup.inlineKeyboard([[Markup.button.callback('↩️ Cancel #1', `fest:u:${teamId}:1`)]])]);
  });

  it('the button cancels the glass, says so in the chat and takes itself off the message', async () => {
    const { db, bot, teamId, replies, answers, edits } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    await bot.handleUpdate(callback(2, 7, `fest:u:${teamId}:1`) as unknown as Update);
    expect([queueFor(db, teamId), replies[1], answers, edits]).toEqual([
      [], '↩️ Glass #1 (Bravo) cancelled. Its label will not be printed; if it comes out anyway, throw it away.',
      [undefined, undefined], [undefined],
    ]);
  });

  it('a button pressed after the fest is over cancels nothing and stays on the message', async () => {
    const { db, bot, teamId, replies, answers, edits } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    await bot.handleUpdate(callback(2, 7, `fest:u:${teamId}:1`) as unknown as Update);
    expect([queueFor(db, teamId).map((r) => r.glass_no), replies.length, answers[1], edits])
      .toEqual([[1], 1, 'There is no festival to join right now.', []]);
  });

  it('someone outside the team cancels nothing', async () => {
    const { db, bot, teamId, replies, answers, edits } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    await bot.handleUpdate(callback(2, 8, `fest:u:${teamId}:1`) as unknown as Update);
    expect([queueFor(db, teamId).map((r) => r.glass_no), replies.length, answers[1], edits])
      .toEqual([[1], 1, 'This is for team members — press “I’m in the team”.', []]);
  });

  it('/fest drop cancels by number; a printed label is to be thrown away', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    db.prepare("UPDATE fest_print_jobs SET status = 'printed'").run();
    await bot.handleUpdate(command(2, 7, { id: -100, type: 'supergroup' }, '/fest drop 1') as unknown as Update);
    expect([queueFor(db, teamId), replies[1]]).toEqual([[], '↩️ Glass #1 (Bravo) cancelled. Throw away label #1.']);
  });

  it('/fest drop answers a cancelled number, an unknown one, a missing one and a non-number', async () => {
    const { bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    const group = { id: -100, type: 'supergroup' as const };
    await bot.handleUpdate(command(2, 7, group, '/fest drop №1') as unknown as Update);
    await bot.handleUpdate(command(3, 7, group, '/fest drop 1') as unknown as Update);
    await bot.handleUpdate(command(4, 7, group, '/fest drop 5') as unknown as Update);
    await bot.handleUpdate(command(5, 7, group, '/fest drop') as unknown as Update);
    await bot.handleUpdate(command(6, 7, group, '/fest drop two') as unknown as Update);
    await bot.handleUpdate(command(7, 7, group, '/fest drop 0') as unknown as Update);
    expect(replies.slice(1)).toEqual([
      '↩️ Glass #1 (Bravo) cancelled. Its label will not be printed; if it comes out anyway, throw it away.',
      'Glass #1 is already cancelled.',
      'There is no glass #5 in the queue.',
      'Send the glass number: /fest drop 7 (numbers are in /fest queue).',
      'Send the glass number: /fest drop 7 (numbers are in /fest queue).',
      'Send the glass number: /fest drop 7 (numbers are in /fest queue).',
    ]);
  });

  it('a glass a check-in already closed is not cancelled', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    insertVenueCheckins(db, [
      { checkin_id: 501, venue_id: 2167060, bid: 6000011, untappd_user: 'member', checkin_at: '2026-10-15T18:05:00.000Z' },
    ], 'laptop', '2026-10-15T18:05:00.000Z');
    await bot.handleUpdate(command(2, 7, { id: -100, type: 'supergroup' }, '/fest drop 1') as unknown as Update);
    expect([queueFor(db, teamId).map((r) => r.glass_no), replies[1]])
      .toEqual([[1], 'Glass #1 is already checked in — it cannot be cancelled.']);
  });
});
