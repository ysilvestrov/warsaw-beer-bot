import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';

// Accepts a bare username, or an untappd.com profile URL with or without the scheme and
// with or without `www.` — the three forms spec.md §`/link` promises, `link.usage` tells
// the user to send, and `link.success` echoes back at them (#609: the scheme used to be
// mandatory inside the optional URL group, so the schemeless form every one of those three
// advertises was rejected).
//
// The scheme is optional; the HOST is not. Widening this to arbitrary hosts would let a
// lookalike URL link the user to a username parsed out of somebody else's profile.
const LINK_ARG =
  /^(?:(?:https?:\/\/)?(?:www\.)?untappd\.com\/user\/)?([A-Za-z0-9_.-]{2,30})\/?$/;

export function parseLinkArgs(raw: string): { username: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(LINK_ARG);
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
