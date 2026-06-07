import { randomBytes } from 'crypto';
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import type { Translator } from '../../i18n/types';
import type { DB } from '../../storage/db';
import { ensureProfile } from '../../storage/user_profiles';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { escapeHtml } from './newbeers-format';

// Public hostname served via the Cloudflare tunnel → 127.0.0.1:API_PORT.
const API_URL = 'https://beer-api.ysilvestrov-ai.uk/match';

// Mints a fresh raw token, stores only its hash (1:1 rotation), returns the raw.
export function generateAndStoreToken(db: DB, telegramId: number, at: string): string {
  const raw = randomBytes(32).toString('hex');
  rotateToken(db, telegramId, hashToken(raw), at);
  return raw;
}

// HTML message: escaped instructions + raw token in a copy-friendly <code> block.
// The token is hex, so it needs no escaping; instructions go through escapeHtml
// (locale strings may contain & or angle brackets).
export function buildExtensionMessage(t: Translator, token: string, url: string): string {
  return `${escapeHtml(t('extension.success', { url }))}\n\n<code>${token}</code>`;
}

export const extensionCommand = new Composer<BotContext>();

extensionCommand.command('extension', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const token = generateAndStoreToken(ctx.deps.db, ctx.from.id, new Date().toISOString());
  await ctx.replyWithHTML(buildExtensionMessage(ctx.t, token, API_URL));
});
