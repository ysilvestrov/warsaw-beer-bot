import { Composer, Markup } from 'telegraf';
import type { BotContext } from '../index';
import { currentOrNextFest, getFest, type Fest } from '../../storage/fests';
import {
  addMember, createTeam, isTeamMember, members, setOverride, teamById, teamByChat, teamsOfUser, type FestTeam,
} from '../../storage/fest_teams';
import { ensureProfile, getProfile } from '../../storage/user_profiles';
import { upsertStand } from '../../storage/fest_stands';
import { menuFor } from '../../storage/fest_menu';
import { buildFestView } from '../../jobs/fest-view';
import type { MenuPageResult } from '../../jobs/fest-ingest';
import { parseStandsCsv } from '../../domain/fest/stands-csv';
import { formatRanking, formatSection, formatTargets, searchMenu, sectionKey, TARGETS_SHOWN } from './fest-format';

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
}

const isGroup = (type: string | undefined): boolean => type === 'group' || type === 'supergroup';
const STANDS_CAPTION_RE = /^\/fest(?:@\w+)?\s+stands\b/i;

function joinKeyboard(ctx: BotContext, teamId: number) {
  return Markup.inlineKeyboard([[Markup.button.callback(ctx.t('fest.join_button'), `fest:j:${teamId}`)]]);
}

async function showRanking(ctx: BotContext, team: FestTeam): Promise<void> {
  const view = buildFestView(ctx.deps.db, { festId: team.fest_id, teamId: team.id, now: new Date() });
  const buttons = view.ranking.map((r) => [Markup.button.callback(r.section.slice(0, 60), `fest:s:${team.id}:${sectionKey(r.section)}`)]);
  if (isGroup(ctx.chat?.type)) buttons.push([Markup.button.callback(ctx.t('fest.join_button'), `fest:j:${team.id}`)]);
  await ctx.replyWithHTML(formatRanking(ctx.t, view), Markup.inlineKeyboard(buttons));
}

/** The team a command refers to: the group's own team, or the caller's only team in a private chat. */
async function resolveTeam(ctx: BotContext & { from: { id: number } }, fest: Fest): Promise<FestTeam | null> {
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
    teams.map((t) => [Markup.button.callback(`${fest.name} · ${t.chat_id}`, `fest:t:${t.id}`)]),
  ));
  return null;
}

export function createFestCommand(deps: FestCommandDeps): Composer<BotContext> {
  const festCommand = new Composer<BotContext>();

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
          await ctx.reply(ctx.t('fest.team_created', { fest: fest.name }), joinKeyboard(ctx, team.id));
          return;
        }
        await showRanking(ctx, team);
        return;
      }
      const team = await resolveTeam(ctx, fest);
      if (team) await showRanking(ctx, team);
      return;
    }

    const team = await resolveTeam(ctx, fest);
    if (!team) return;
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

    if (sub === 'add') {
      const query = rest.join(' ');
      if (query.trim() === '') {
        await ctx.reply(ctx.t('fest.add_usage'));
        return;
      }
      const found = searchMenu(buildFestView(db, { festId: fest.id, teamId: team.id, now }), query);
      if (found.length === 0) {
        await ctx.reply(ctx.t('fest.add_none', { query }));
        return;
      }
      await ctx.reply(ctx.t('fest.add_pick'), Markup.inlineKeyboard(
        found.map((f) => [Markup.button.callback(`➕ ${f.label.slice(0, 55)}`, `fest:a:${team.id}:${f.beerId}`)]),
      ));
      return;
    }

    if (sub === 'stands') {
      const sections = new Set(menuFor(db, fest.id).map((m) => m.section));
      const view = buildFestView(db, { festId: fest.id, teamId: team.id, now });
      const missing = [...sections].filter((s) => !view.stands.has(s)).sort();
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
  });

  // /fest stands with a CSV document: the caption carries the command.
  festCommand.on('document', async (ctx, next) => {
    if (!STANDS_CAPTION_RE.test(ctx.message.caption ?? '')) return next();
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
    ensureProfile(db, ctx.from.id);
    if (!getProfile(db, ctx.from.id)?.untappd_username) {
      await ctx.answerCbQuery();
      await ctx.reply(ctx.t('fest.need_link'));
      return;
    }
    if (isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.already_member'));
      return;
    }
    addMember(db, team.id, ctx.from.id, initialsOf(ctx.from), new Date().toISOString());
    await ctx.answerCbQuery();
    await ctx.reply(ctx.t('fest.joined', { name: ctx.from.first_name ?? initialsOf(ctx.from) }));
  });

  festCommand.action(/^fest:t:(\d+)$/, async (ctx) => {
    const team = teamById(ctx.deps.db, Number(ctx.match[1]));
    await ctx.answerCbQuery();
    if (!team || !isTeamMember(ctx.deps.db, team.id, ctx.from.id)) return;
    await showRanking(ctx, team);
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
    const text = formatSection(ctx.t, buildFestView(db, { festId: team.fest_id, teamId: team.id, now }), ctx.match[2], now);
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(text ?? ctx.t('fest.section_gone'));
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
