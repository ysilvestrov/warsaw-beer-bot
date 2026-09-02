import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import type { Translator } from '../../i18n/types';
import type { DB } from '../../storage/db';
import { ensureProfile } from '../../storage/user_profiles';
import { hasApiToken } from '../../storage/api_tokens';
import { getAnnounceOptOut, setAnnounceOptOut } from '../../storage/announce';

export interface AnnounceArgs {
  db: DB;
  telegramId: number;
  /** The raw command text, e.g. "/announce off". */
  text: string;
  t: Translator;
  reply: (message: string) => void;
}

/**
 * The whole decision, free of Telegraf so it can be tested directly (#379).
 *
 * An unrecognized argument falls through to the status view rather than guessing: a
 * user who typed something we did not understand should learn the current state, not
 * have it changed.
 */
export function handleAnnounce(args: AnnounceArgs): void {
  const { db, telegramId, t, reply } = args;
  ensureProfile(db, telegramId);
  const arg = args.text.split(' ').slice(1).join(' ').trim().toLowerCase();

  if (arg === 'off' || arg === 'on') {
    setAnnounceOptOut(db, telegramId, arg === 'off');
    const lines = [t(arg === 'off' ? 'announce.turned_off' : 'announce.turned_on')];
    // Only 'on' makes a delivery promise ("I'll tell you about new versions"), and
    // without a token the bot cannot keep it — a store install is anonymous and this
    // user does not exist for delivery. 'off' promises nothing, so it stays as-is.
    if (arg === 'on' && !hasApiToken(db, telegramId)) lines.push(t('announce.no_token'));
    reply(lines.join('\n'));
    return;
  }

  const lines = [t(getAnnounceOptOut(db, telegramId) ? 'announce.status_off' : 'announce.status_on')];
  // "Announcements: on" is true and misleading for someone who has no token and will
  // therefore never receive one. Say so rather than let the setting imply delivery.
  if (!hasApiToken(db, telegramId)) lines.push(t('announce.no_token'));
  reply(lines.join('\n'));
}

export const announceCommand = new Composer<BotContext>();

announceCommand.command('announce', async (ctx) => {
  const replies: string[] = [];
  handleAnnounce({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    text: ctx.message.text,
    t: ctx.t,
    reply: (m) => { replies.push(m); },
  });
  for (const m of replies) await ctx.reply(m);
});
