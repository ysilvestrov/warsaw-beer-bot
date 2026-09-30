import { Composer, Markup } from 'telegraf';
import type { BotContext } from '../index';
import { currentOrNextFest, getFest } from '../../storage/fests';
import { addMember, createTeam, isTeamMember, members, teamById, teamByChat, teamsOfUser, type FestTeam } from '../../storage/fest_teams';
import { ensureProfile, getProfile } from '../../storage/user_profiles';
import { buildFestView } from '../../jobs/fest-view';
import { formatRanking, formatSection, sectionKey } from './fest-format';

// Festival mode in the bot (spec §7). The handlers only glue: the view is built by buildFestView
// and rendered by fest-format.ts.

export function initialsOf(from: { first_name?: string; last_name?: string; username?: string }): string {
  const parts = [from.first_name, from.last_name].filter((p): p is string => !!p && p.trim() !== '');
  const letters = parts.map((p) => [...p.trim()][0]).join('');
  if (letters) return letters.toUpperCase().slice(0, 3);
  return (from.username ?? '?').slice(0, 2).toUpperCase();
}

const isGroup = (type: string | undefined): boolean => type === 'group' || type === 'supergroup';

function joinKeyboard(ctx: BotContext, teamId: number) {
  return Markup.inlineKeyboard([[Markup.button.callback(ctx.t('fest.join_button'), `fest:j:${teamId}`)]]);
}

async function showRanking(ctx: BotContext, team: FestTeam): Promise<void> {
  const view = buildFestView(ctx.deps.db, { festId: team.fest_id, teamId: team.id, now: new Date() });
  const buttons = view.ranking.map((r) => [Markup.button.callback(r.section.slice(0, 60), `fest:s:${team.id}:${sectionKey(r.section)}`)]);
  if (isGroup(ctx.chat?.type)) buttons.push([Markup.button.callback(ctx.t('fest.join_button'), `fest:j:${team.id}`)]);
  await ctx.replyWithHTML(formatRanking(ctx.t, view), Markup.inlineKeyboard(buttons));
}

export const festCommand = new Composer<BotContext>();

festCommand.command('fest', async (ctx) => {
  const db = ctx.deps.db;
  const fest = currentOrNextFest(db, new Date());
  if (!fest) {
    await ctx.reply(ctx.t('fest.no_fest'));
    return;
  }
  if (isGroup(ctx.chat.type)) {
    let team = teamByChat(db, fest.id, ctx.chat.id);
    if (!team) {
      team = createTeam(db, fest.id, ctx.chat.id, new Date().toISOString());
      await ctx.reply(ctx.t('fest.team_created', { fest: fest.name }), joinKeyboard(ctx, team.id));
      return;
    }
    if (members(db, team.id).length === 0) {
      await ctx.reply(ctx.t('fest.team_created', { fest: fest.name }), joinKeyboard(ctx, team.id));
      return;
    }
    await showRanking(ctx, team);
    return;
  }
  const teams = teamsOfUser(db, fest.id, ctx.from.id);
  if (teams.length === 0) {
    await ctx.reply(ctx.t('fest.no_team'));
    return;
  }
  if (teams.length === 1) {
    await showRanking(ctx, teams[0]);
    return;
  }
  await ctx.reply(ctx.t('fest.pick_team'), Markup.inlineKeyboard(
    teams.map((t) => [Markup.button.callback(`${fest.name} · ${t.chat_id}`, `fest:t:${t.id}`)]),
  ));
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
