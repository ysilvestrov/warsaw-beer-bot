import { Composer, Markup } from 'telegraf';
import type { BotContext } from '../index';
import { currentOrNextFest, currentOrNextFests, festSessions, getFest, type Fest } from '../../storage/fests';
import { createStation } from '../../storage/fest_print';
import {
  addMember, createTeam, isTeamMember, members, setOverride, teamById, teamByChat, teamsOfUser, type FestTeam,
} from '../../storage/fest_teams';
import { ensureProfile, getProfile } from '../../storage/user_profiles';
import { upsertStand } from '../../storage/fest_stands';
import { menuFor } from '../../storage/fest_menu';
import { buildFestView } from '../../jobs/fest-view';
import { buildQueueView, openGlassOf } from '../../jobs/fest-queue-view';
import { addPresence } from '../../storage/fest_presence';
import { markGlass, removeGlass, takeBeer, unmarkGlass } from '../../storage/fest_queue';
import { upsertBeerByBid, type BidBeerInput } from '../../storage/beers';
import { beerLinkOf } from '../../sources/untappd/beer-link';
import { buildBeerPageUrl } from '../../sources/untappd/beer-page';
import type { MenuPageResult } from '../../jobs/fest-ingest';
import { parseStandsCsv } from '../../domain/fest/stands-csv';
import {
  DRANK_BUTTONS, formatQueue, formatRanking, formatSection, formatTargets, hhmm, myOpenGlasses, queueLinks, searchMenu, sectionKey, TARGETS_SHOWN,
} from './fest-format';

// Festival mode in the bot (spec §7). The handlers only glue: the view is built by buildFestView
// and rendered by fest-format.ts.

export function initialsOf(from: { first_name?: string; last_name?: string; username?: string }): string {
  const parts = [from.first_name, from.last_name].filter((p): p is string => !!p && p.trim() !== '');
  const letters = parts.map((p) => [...p.trim()][0]).join('');
  if (letters) return letters.toUpperCase().slice(0, 3);
  return (from.username ?? '?').slice(0, 2).toUpperCase();
}

export interface FestCommandDeps {
  /** Server-side menu read (the cookie'd Untappd client); absent when the server has no cookie. */
  refreshMenu?: (fest: Fest, now: Date) => Promise<MenuPageResult | 'blocked' | 'wrong_page'>;
  downloadFile: (fileId: string) => Promise<Buffer>;
  /** The print station page as phones reach it (FEST_PRINT_BASE_URL + /fest-print). */
  printStationUrl: string;
  /** A short untp.beer link → the bid it redirects to; `not_beer`, or `failed` when untp.beer did not answer. */
  resolveShortLink?: (url: string) => Promise<number | 'not_beer' | 'failed'>;
  /** A beer the bot has never seen, from Untappd (MCP get_beer); absent without FEST_MCP_URL. */
  lookupBeer?: (bid: number) => Promise<BidBeerInput | null>;
}

const isGroup = (type: string | undefined): boolean => type === 'group' || type === 'supergroup';
export const RANKING_BUTTONS = 60;
const STANDS_CAPTION_RE = /^\/fest(?:@\w+)?\s+stands\b/i;
/** A document captioned this way is a stand map for /fest stands, not an export for /import. */
export const isStandsCaption = (caption: string | undefined): boolean => STANDS_CAPTION_RE.test(caption ?? '');

// «🟢 Почати день» / «🔴 Закінчити день» (spec 2026-10-15-fest-queue-reality-design.md §PR 2) in place
// of «🙋 Я в команді»: a keyboard in a group is the same for everyone, so starting the day also joins.
const dayButtons = (ctx: BotContext, teamId: number) => [
  Markup.button.callback(ctx.t('fest.day_start_button'), `fest:ps:${teamId}`),
  Markup.button.callback(ctx.t('fest.day_end_button'), `fest:pe:${teamId}`),
];

function dayKeyboard(ctx: BotContext, teamId: number) {
  return Markup.inlineKeyboard([dayButtons(ctx, teamId)]);
}

async function showRanking(ctx: BotContext, team: FestTeam): Promise<void> {
  const view = buildFestView(ctx.deps.db, { festId: team.fest_id, teamId: team.id, now: new Date() });
  // Telegram limits an inline keyboard to 100 buttons; the best-ranked sections are the ones worth a tap.
  const buttons = view.ranking.slice(0, RANKING_BUTTONS).map((r) => [Markup.button.callback(r.section.slice(0, 60), `fest:s:${team.id}:${sectionKey(r.section)}`)]);
  buttons.push(dayButtons(ctx, team.id));
  await ctx.replyWithHTML(formatRanking(ctx.t, view), Markup.inlineKeyboard(buttons));
}

const SUBS = ['targets', 'add', 'take', 'queue', 'drop', 'drank', 'start', 'end', 'stands', 'menu', 'printer'] as const;
/** The station page on the configured origin; any path, query or fragment of the base is dropped. */
export function festPrintUrl(base: string): string {
  return new URL('/fest-print', base).href;
}

/** A station keeps working for a day after the last session: labels for the last glasses. */
const STATION_GRACE_MS = 24 * 60 * 60 * 1000;
/** «Взяв» buttons under a section's details. */
export const TAKE_BUTTONS = 20;
type Sub = typeof SUBS[number] | '';

/**
 * Callback data for picking a team that re-runs `sub` (and its query) once picked. Telegram caps
 * callback data at 64 bytes, so the query is cut, whole code points only, to what fits.
 */
export function pickCallback(teamId: number, sub: Sub, query: string): string {
  const prefix = `fest:t:${teamId}:${sub}:`;
  let q = '';
  for (const ch of query) {
    if (Buffer.byteLength(prefix + q + ch) > 64) break;
    q += ch;
  }
  return prefix + q;
}

/**
 * A full beer link as the shortest one naming the same bid. The team picker carries the query in 64
 * bytes of callback data and cuts it: a full link cut there would keep a prefix of its bid — another beer.
 */
export function compactLinkQuery(query: string): string {
  const link = beerLinkOf(query);
  return link !== null && 'bid' in link ? `https://untappd.com/b/-/${link.bid}` : query;
}

/** The team a command refers to: the group's own team, or the caller's only team in a private chat. */
async function resolveTeam(ctx: BotContext & { from: { id: number } }, fest: Fest, sub: Sub = '', query = ''): Promise<FestTeam | null> {
  const db = ctx.deps.db;
  if (isGroup(ctx.chat?.type)) {
    const team = teamByChat(db, fest.id, ctx.chat!.id);
    if (team && isTeamMember(db, team.id, ctx.from.id)) return team;
    await ctx.reply(team ? ctx.t('fest.not_member') : ctx.t('fest.no_team'));
    return null;
  }
  const teams = teamsOfUser(db, fest.id, ctx.from.id);
  if (teams.length === 1) return teams[0];
  if (teams.length === 0) {
    await ctx.reply(ctx.t('fest.no_team'));
    return null;
  }
  await ctx.reply(ctx.t('fest.pick_team'), Markup.inlineKeyboard(
    teams.map((t) => [Markup.button.callback(`${fest.name} · ${t.chat_id}`, pickCallback(t.id, sub, query))]),
  ));
  return null;
}

/** `/fest drop 7` or `/fest drop №7`: the glass number, or null. */
export function glassNoOf(query: string): number | null {
  const m = /^[№#]?\s*(\d{1,9})$/.exec(query.trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : null;
}

// Cancelling a glass (spec: fest queue). A glass a check-in already closed was surely drunk, and
// without it closeQueue would hand that check-in to another glass of the beer — so it stays.
function dropGlass(ctx: BotContext, festId: number, teamId: number, glassNo: number): string {
  const db = ctx.deps.db;
  const item = buildQueueView(db, { festId, teamId }).items.find((i) => i.glassNo === glassNo);
  // A mark is someone's word that they had it: the glass stays for the same reason as a checked-in one.
  if (item && item.closedBy.some((c) => c.checkinId !== null)) return ctx.t('fest.drop_closed', { glass: glassNo });
  if (item && item.closedBy.some((c) => c.marked)) return ctx.t('fest.drop_marked', { glass: glassNo });
  const r = removeGlass(db, { teamId, glassNo, at: new Date().toISOString() });
  if (r.kind === 'already') return ctx.t('fest.drop_already', { glass: glassNo });
  if (r.kind === 'missing') return ctx.t('fest.drop_none', { glass: glassNo });
  return ctx.t(r.printed ? 'fest.dropped_printed' : 'fest.dropped_unprinted', { glass: glassNo, name: r.name });
}

/**
 * «Взяв»: the glass number, announced with its undo button — or, while an open glass of this beer is
 * still on the table, that glass's number and no second one (spec 2026-10-15-fest-queue-reality-design.md §PR 2).
 */
async function replyTaken(ctx: BotContext & { from: { id: number } }, team: FestTeam, beerId: number, name: string): Promise<void> {
  const db = ctx.deps.db;
  const at = new Date();
  const r = takeBeer(db, { teamId: team.id, beerId, addedBy: ctx.from.id, at: at.toISOString() }, {
    duplicateOf: () => openGlassOf(buildQueueView(db, { festId: team.fest_id, teamId: team.id }), beerId, at),
  });
  if (r.kind === 'duplicate') {
    await ctx.reply(ctx.t('fest.taken_duplicate', { glass: r.glassNo, name }));
    return;
  }
  const { glassNo } = r;
  const initials = members(db, team.id).find((m) => m.telegram_id === ctx.from.id)?.initials ?? '?';
  await ctx.reply(ctx.t('fest.taken', { glass: glassNo, name, initials }), Markup.inlineKeyboard([
    [Markup.button.callback(ctx.t('fest.undo_button', { glass: glassNo }), `fest:u:${team.id}:${glassNo}`)],
  ]));
}

const nameOf = (from: { first_name?: string; last_name?: string; username?: string }): string => from.first_name ?? initialsOf(from);

/** «🟢 Ю. почав день о 18:05» / «🔴 … закінчив день о 22:40». */
function dayAnnouncement(ctx: BotContext, kind: 'start' | 'end', at: Date): string {
  return ctx.t(kind === 'start' ? 'fest.day_started' : 'fest.day_ended', { name: ctx.from ? nameOf(ctx.from) : '?', time: hhmm(at.toISOString()) });
}

/** Joins the caller to the team; false (with the alert said) when they have no Untappd linked yet. */
async function joinTeam(ctx: BotContext & { from: { id: number; first_name?: string } }, team: FestTeam): Promise<boolean> {
  const db = ctx.deps.db;
  ensureProfile(db, ctx.from.id);
  if (!getProfile(db, ctx.from.id)?.untappd_username) {
    await ctx.answerCbQuery(ctx.t('fest.need_link'), { show_alert: true });
    return false;
  }
  addMember(db, team.id, ctx.from.id, initialsOf(ctx.from), new Date().toISOString());
  return true;
}

/**
 * /fest drank N and its button (spec 2026-10-15-fest-queue-reality-design.md §PR 2): the caller's own
 * ☑️ on a glass that waits for them — drunk without a check-in that closes it, or not drunk at all.
 */
async function replyMarked(ctx: BotContext & { from: { id: number } }, team: FestTeam, glassNo: number): Promise<void> {
  const db = ctx.deps.db;
  const item = buildQueueView(db, { festId: team.fest_id, teamId: team.id }).items.find((i) => i.glassNo === glassNo);
  const mine = item?.closedBy.find((c) => c.telegramId === ctx.from.id);
  if (!item) {
    await ctx.reply(ctx.t('fest.drop_none', { glass: glassNo }));
    return;
  }
  if (!mine) {
    await ctx.reply(ctx.t('fest.drank_not_yours', { glass: glassNo }));
    return;
  }
  if (mine.checkinId !== null) {
    await ctx.reply(ctx.t('fest.drank_already', { glass: glassNo }));
    return;
  }
  if (mine.marked) {
    await ctx.reply(ctx.t('fest.drank_already_marked', { glass: glassNo }));
    return;
  }
  markGlass(db, { queueId: item.id, telegramId: ctx.from.id, at: new Date().toISOString() });
  await ctx.reply(ctx.t('fest.drank_marked', { glass: glassNo, name: item.name }), Markup.inlineKeyboard([
    [Markup.button.callback(ctx.t('fest.unmark_button', { glass: glassNo }), `fest:du:${team.id}:${glassNo}`)],
  ]));
}

export function createFestCommand(deps: FestCommandDeps): Composer<BotContext> {
  const festCommand = new Composer<BotContext>();

  /** The team behind a member's button while its fest is current or ahead; null (answered) otherwise. */
  async function buttonTeam(ctx: BotContext & { from: { id: number } }, teamId: number): Promise<FestTeam | null> {
    const db = ctx.deps.db;
    const team = teamById(db, teamId);
    if (!team || !isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.not_member'));
      return null;
    }
    if (!currentOrNextFests(db, new Date()).some((f) => f.id === team.fest_id)) {
      await ctx.answerCbQuery(ctx.t('fest.no_fest'));
      return null;
    }
    return team;
  }

  // «☑️ №N» under /fest drank.
  festCommand.action(/^fest:d:(\d+):(\d{1,9})$/, async (ctx) => {
    const team = await buttonTeam(ctx, Number(ctx.match[1]));
    if (!team) return;
    await ctx.answerCbQuery();
    await replyMarked(ctx, team, Number(ctx.match[2]));
  });

  // «↩️ Зняти відмітку №N» under a mark: only the caller's own mark is taken back.
  festCommand.action(/^fest:du:(\d+):(\d{1,9})$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = await buttonTeam(ctx, Number(ctx.match[1]));
    if (!team) return;
    const glassNo = Number(ctx.match[2]);
    const item = buildQueueView(db, { festId: team.fest_id, teamId: team.id }).items.find((i) => i.glassNo === glassNo);
    const removed = item ? unmarkGlass(db, { queueId: item.id, telegramId: ctx.from.id }) : false;
    // The button is the marker's, and others see it too: it leaves the message only when it took a mark back.
    if (!removed) {
      await ctx.answerCbQuery(ctx.t('fest.unmark_none', { glass: glassNo }));
      return;
    }
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(ctx.t('fest.unmarked', { glass: glassNo }));
  });

  // «🟢 Почати день»: a member starts the day; someone with Untappd linked joins the team and starts it.
  festCommand.action(/^fest:ps:(\d+)$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[1]));
    if (!team) return ctx.answerCbQuery();
    if (!currentOrNextFests(db, new Date()).some((f) => f.id === team.fest_id)) {
      await ctx.answerCbQuery(ctx.t('fest.no_fest'));
      return;
    }
    const joined = !isTeamMember(db, team.id, ctx.from.id);
    if (joined && !(await joinTeam(ctx, team))) return;
    const now = new Date();
    addPresence(db, { teamId: team.id, telegramId: ctx.from.id, kind: 'start', at: now.toISOString() });
    await ctx.answerCbQuery();
    if (joined) await ctx.reply(ctx.t('fest.joined', { name: nameOf(ctx.from) }));
    await ctx.reply(dayAnnouncement(ctx, 'start', now));
  });

  // «🔴 Закінчити день»: members only.
  festCommand.action(/^fest:pe:(\d+)$/, async (ctx) => {
    const team = await buttonTeam(ctx, Number(ctx.match[1]));
    if (!team) return;
    const now = new Date();
    addPresence(ctx.deps.db, { teamId: team.id, telegramId: ctx.from.id, kind: 'end', at: now.toISOString() });
    await ctx.answerCbQuery();
    await ctx.reply(dayAnnouncement(ctx, 'end', now));
  });

  // /fest take <Untappd link> (spec 2026-10-15-fest-queue-reality-design.md §PR 1): the link names
  // the beer exactly, so it is taken at once — off the menu too, and in the version actually poured.
  async function takeByLink(ctx: BotContext & { from: { id: number } }, team: FestTeam, link: { bid: number } | { short: string }): Promise<void> {
    const db = ctx.deps.db;
    const bid = 'bid' in link ? link.bid : deps.resolveShortLink ? await deps.resolveShortLink(link.short) : 'failed';
    if (bid === 'not_beer' || bid === 'failed') {
      // A link untp.beer did not answer for may be fine: try again, not "wrong link".
      await ctx.reply(ctx.t(bid === 'failed' ? 'fest.take_link_unknown' : 'fest.take_link_bad'));
      return;
    }
    let beer = db.prepare('SELECT id, name FROM beers WHERE untappd_id = ?').get(bid) as { id: number; name: string } | undefined;
    if (!beer && deps.lookupBeer) {
      const found = await deps.lookupBeer(bid).catch((e: unknown) => {
        ctx.deps.log.warn({ bid, err: e instanceof Error ? e.message : String(e) }, 'fest take: get_beer failed');
        return null;
      });
      // Only the beer that was asked for: an answer about another bid is not this link's beer.
      if (found && found.untappd_id === bid) beer = { id: upsertBeerByBid(db, found), name: found.name };
    }
    if (!beer) {
      await ctx.reply(ctx.t('fest.take_link_unknown'));
      return;
    }
    await replyTaken(ctx, team, beer.id, beer.name);
  }

  async function runSub(ctx: BotContext, fest: Fest, team: FestTeam, sub: Sub, query: string): Promise<void> {
    const db = ctx.deps.db;
    const now = new Date();

    if (sub === 'targets') {
      const view = buildFestView(db, { festId: fest.id, teamId: team.id, now });
      const buttons = view.targets.slice(0, TARGETS_SHOWN).map((target) => [Markup.button.callback(
        ctx.t('fest.remove_button', { name: (view.beerNames.get(target.beerId)?.name ?? `#${target.beerId}`).slice(0, 50) }),
        `fest:r:${team.id}:${target.beerId}`,
      )]);
      await ctx.replyWithHTML(formatTargets(ctx.t, view), Markup.inlineKeyboard(buttons));
      return;
    }

    if (sub === 'add' || sub === 'take') {
      const take = sub === 'take';
      if (query.trim() === '') {
        await ctx.reply(ctx.t(take ? 'fest.take_usage' : 'fest.add_usage'));
        return;
      }
      const link = take ? beerLinkOf(query) : null;
      if (link !== null && ctx.from) {
        await takeByLink(ctx as BotContext & { from: { id: number } }, team, link);
        return;
      }
      const { found, total } = searchMenu(buildFestView(db, { festId: fest.id, teamId: team.id, now }), query);
      if (found.length === 0) {
        await ctx.reply(ctx.t(take ? 'fest.take_none' : 'fest.add_none', { query }));
        return;
      }
      const pick = ctx.t(take ? 'fest.take_pick' : 'fest.add_pick');
      const more = total > found.length ? `\n${ctx.t('fest.search_more', { shown: found.length, total })}` : '';
      await ctx.reply(pick + more, Markup.inlineKeyboard(
        found.map((f) => [Markup.button.callback(`${take ? '🍺' : '➕'} ${f.label.slice(0, 55)}`, `fest:${take ? 'q' : 'a'}:${team.id}:${f.beerId}`)]),
      ));
      return;
    }

    if (sub === 'queue') {
      const view = buildQueueView(db, { festId: fest.id, teamId: team.id });
      const scope = { now, all: query.trim().toLowerCase() === 'all' };
      const links = queueLinks(view, scope).map((l) => [Markup.button.url(
        ctx.t('fest.queue_link', { glass: l.glassNo, name: l.name.slice(0, 50) }), buildBeerPageUrl(l.bid),
      )]);
      await ctx.replyWithHTML(formatQueue(ctx.t, view, scope), Markup.inlineKeyboard(links));
      return;
    }

    if ((sub === 'start' || sub === 'end') && ctx.from) {
      addPresence(db, { teamId: team.id, telegramId: ctx.from.id, kind: sub, at: now.toISOString() });
      await ctx.reply(dayAnnouncement(ctx, sub, now));
      return;
    }

    if (sub === 'drank' && ctx.from) {
      const glassNo = glassNoOf(query);
      if (glassNo !== null) {
        await replyMarked(ctx as BotContext & { from: { id: number } }, team, glassNo);
        return;
      }
      if (query.trim() !== '') {
        await ctx.reply(ctx.t('fest.drank_usage'));
        return;
      }
      const mine = myOpenGlasses(buildQueueView(db, { festId: fest.id, teamId: team.id }), ctx.from.id);
      if (mine.length === 0) {
        await ctx.reply(ctx.t('fest.drank_none'));
        return;
      }
      const more = mine.length > DRANK_BUTTONS ? `\n${ctx.t('fest.drank_more', { count: mine.length - DRANK_BUTTONS })}` : '';
      await ctx.reply(ctx.t('fest.drank_pick') + more, Markup.inlineKeyboard(mine.slice(0, DRANK_BUTTONS).map((item) => [
        Markup.button.callback(ctx.t('fest.drank_button', { glass: item.glassNo, name: item.name.slice(0, 45) }), `fest:d:${team.id}:${item.glassNo}`),
      ])));
      return;
    }

    if (sub === 'drop') {
      const glassNo = glassNoOf(query);
      await ctx.reply(glassNo === null ? ctx.t('fest.drop_usage') : dropGlass(ctx, fest.id, team.id, glassNo));
      return;
    }

    if (sub === 'printer') {
      // The link carries the station's key, so it is only ever sent in a private chat.
      if (ctx.chat?.type !== 'private' || !ctx.from) {
        await ctx.reply(ctx.t('fest.printer_private'));
        return;
      }
      const lastEnd = festSessions(db, fest.id).reduce((max, s) => (s.end_at > max ? s.end_at : max), now.toISOString());
      const token = createStation(db, {
        teamId: team.id, createdBy: ctx.from.id, now: now.toISOString(),
        expiresAt: new Date(Date.parse(lastEnd) + STATION_GRACE_MS).toISOString(),
      });
      await ctx.reply(ctx.t('fest.printer_link', { url: `${deps.printStationUrl}#t=${token}` }));
      return;
    }

    if (sub === 'stands') {
      const sections = new Set(menuFor(db, fest.id).map((m) => m.section));
      const view = buildFestView(db, { festId: fest.id, teamId: team.id, now });
      const located = (section: string) => {
        const st = view.stands.get(section);
        return st !== undefined && (st.floor !== null || st.stand !== null);
      };
      const missing = [...sections].filter((section) => !located(section)).sort();
      await ctx.reply([
        ctx.t('fest.stands_usage'),
        missing.length ? ctx.t('fest.stands_missing', { sections: missing.join(', ') }) : ctx.t('fest.stands_complete'),
      ].join('\n\n'));
      return;
    }

    if (sub === 'menu') {
      if (!deps.refreshMenu) {
        await ctx.reply(ctx.t('fest.menu_unavailable'));
        return;
      }
      const r = await deps.refreshMenu(fest, now);
      await ctx.reply(r === 'blocked' ? ctx.t('fest.menu_blocked')
        : r === 'wrong_page' ? ctx.t('fest.menu_wrong_page')
        : r.stale ? ctx.t('fest.menu_stale')
        : ctx.t('fest.menu_refreshed', { count: r.items }));
      return;
    }

    await showRanking(ctx, team);
  }

  festCommand.command('fest', async (ctx) => {
    const db = ctx.deps.db;
    const fest = currentOrNextFest(db, new Date());
    if (!fest) {
      await ctx.reply(ctx.t('fest.no_fest'));
      return;
    }
    const [sub, ...rest] = ctx.message.text.split(/\s+/).slice(1);

    if (sub === undefined) {
      if (isGroup(ctx.chat.type)) {
        const team = teamByChat(db, fest.id, ctx.chat.id) ?? createTeam(db, fest.id, ctx.chat.id, new Date().toISOString());
        if (members(db, team.id).length === 0) {
          await ctx.reply(ctx.t('fest.team_created', { fest: fest.name }), dayKeyboard(ctx, team.id));
          return;
        }
        await showRanking(ctx, team);
        return;
      }
      const team = await resolveTeam(ctx, fest);
      if (team) await showRanking(ctx, team);
      return;
    }

    const known = (SUBS as readonly string[]).includes(sub) ? sub as Sub : '';
    const query = known === 'take' ? compactLinkQuery(rest.join(' ')) : rest.join(' ');
    const team = await resolveTeam(ctx, fest, known, query);
    if (!team) return;
    await runSub(ctx, fest, team, known, query);
  });

  // /fest stands with a CSV document: the caption carries the command.
  festCommand.on('document', async (ctx, next) => {
    if (!isStandsCaption(ctx.message.caption)) return next();
    const db = ctx.deps.db;
    const fest = currentOrNextFest(db, new Date());
    if (!fest) {
      await ctx.reply(ctx.t('fest.no_fest'));
      return;
    }
    const team = await resolveTeam(ctx, fest);
    if (!team) return;
    const csv = parseStandsCsv((await deps.downloadFile(ctx.message.document.file_id)).toString('utf8'));
    const at = new Date().toISOString();
    for (const row of csv.rows) upsertStand(db, fest.id, row, ctx.from.id, at);
    const sections = new Set(menuFor(db, fest.id).map((m) => m.section));
    const unknown = csv.rows.map((r) => r.section).filter((s) => !sections.has(s));
    const lines = [ctx.t('fest.stands_saved', { count: csv.rows.length })];
    if (csv.errors.length) lines.push(ctx.t('fest.stands_errors', { lines: csv.errors.map((e) => e.line).join(', ') }));
    if (unknown.length) lines.push(ctx.t('fest.stands_unknown', { sections: unknown.join(', ') }));
    await ctx.reply(lines.join('\n'));
  });

  festCommand.action(/^fest:j:(\d+)$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[1]));
    if (!team) return ctx.answerCbQuery();
    // The button of messages sent before «Почати день» replaced it (spec 2026-10-15-fest-queue-reality-design.md §PR 2).
    ensureProfile(db, ctx.from.id);
    if (getProfile(db, ctx.from.id)?.untappd_username && isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.already_member'));
      return;
    }
    if (!(await joinTeam(ctx, team))) return;
    await ctx.answerCbQuery();
    await ctx.reply(ctx.t('fest.joined', { name: nameOf(ctx.from) }));
  });

  festCommand.action(/^fest:t:(\d+)(?::([a-z]*):(.*))?$/s, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[1]));
    await ctx.answerCbQuery();
    const fest = team ? getFest(db, team.fest_id) : null;
    if (!team || !fest || !isTeamMember(db, team.id, ctx.from.id)) return;
    const sub = (SUBS as readonly string[]).includes(ctx.match[2] ?? '') ? ctx.match[2] as Sub : '';
    await runSub(ctx, fest, team, sub, ctx.match[3] ?? '');
  });

  festCommand.action(/^fest:s:(\d+):([0-9a-f]{10})$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[1]));
    if (!team || !getFest(db, team.fest_id)) return ctx.answerCbQuery();
    if (!isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.not_member'));
      return;
    }
    const now = new Date();
    const view = buildFestView(db, { festId: team.fest_id, teamId: team.id, now });
    const text = formatSection(ctx.t, view, ctx.match[2], now);
    const rank = view.ranking.find((r) => sectionKey(r.section) === ctx.match[2]);
    const take = (rank?.targets ?? []).slice(0, TAKE_BUTTONS).map((target) => [Markup.button.callback(
      ctx.t('fest.take_button', { name: (view.beerNames.get(target.beerId)?.name ?? `#${target.beerId}`).slice(0, 50) }),
      `fest:q:${team.id}:${target.beerId}`,
    )]);
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(text ?? ctx.t('fest.section_gone'), Markup.inlineKeyboard(take));
  });

  // «Взяв» (spec §7): the next glass number of the team and a queued print job, in one transaction.
  festCommand.action(/^fest:q:(\d+):(\d+)$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[1]));
    const beerId = Number(ctx.match[2]);
    if (!team || !isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.not_member'));
      return;
    }
    // A button outlives its fest: once the fest's last window has closed, it queues nothing.
    if (!currentOrNextFests(db, new Date()).some((f) => f.id === team.fest_id)) {
      await ctx.answerCbQuery(ctx.t('fest.no_fest'));
      return;
    }
    const beer = menuFor(db, team.fest_id).find((m) => m.beer_id === beerId);
    if (!beer) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await replyTaken(ctx, team, beerId, beer.name);
  });

  // «↩️ Скасувати №N» under «Взяв»: any member may cancel; the button leaves the message whatever the answer.
  // Like «Взяв» and /fest drop, it acts only while the fest is current or ahead: the queue of a fest
  // that is over is its record.
  festCommand.action(/^fest:u:(\d+):(\d{1,9})$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[1]));
    if (!team || !isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.not_member'));
      return;
    }
    if (!currentOrNextFests(db, new Date()).some((f) => f.id === team.fest_id)) {
      await ctx.answerCbQuery(ctx.t('fest.no_fest'));
      return;
    }
    const text = dropGlass(ctx, team.fest_id, team.id, Number(ctx.match[2]));
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(text);
  });

  // ➕ / ➖ a Target by hand (spec §5 overrides). Only a member of that team may change its list.
  festCommand.action(/^fest:([ar]):(\d+):(\d+)$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[2]));
    const beerId = Number(ctx.match[3]);
    if (!team || !isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.not_member'));
      return;
    }
    const beer = menuFor(db, team.fest_id).find((m) => m.beer_id === beerId);
    if (!beer) return ctx.answerCbQuery();
    const add = ctx.match[1] === 'a';
    setOverride(db, team.id, beerId, add ? 'add' : 'remove', ctx.from.id, new Date().toISOString());
    await ctx.answerCbQuery();
    await ctx.reply(ctx.t(add ? 'fest.added' : 'fest.removed', { name: beer.name }));
  });

  return festCommand;
}
