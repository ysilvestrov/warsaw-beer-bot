import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';

export function parseLinkArgs(raw: string): { username: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(?:https?:\/\/(?:www\.)?untappd\.com\/user\/)?([A-Za-z0-9_.-]{2,30})\/?$/);
  return m ? { username: m[1] } : null;
}

export const linkCommand = new Composer<BotContext>();

linkCommand.command('link', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ');
  const parsed = parseLinkArgs(arg);
  if (!parsed) {
    await ctx.reply(ctx.t('link.usage'));
    return;
  }
  ensureProfile(ctx.deps.db, ctx.from.id);
  setUntappdUsername(ctx.deps.db, ctx.from.id, parsed.username);
  await ctx.reply(ctx.t('link.success', { username: parsed.username }));
});
