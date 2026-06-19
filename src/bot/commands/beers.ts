import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildBeersMessage } from './beers-build';
import { getUserCity } from '../../storage/user_profiles';

export const beersCommand = new Composer<BotContext>();

beersCommand.command('beers', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const result = buildBeersMessage({
    db: ctx.deps.db,
    locale: ctx.locale,
    t: ctx.t,
    pubQuery: arg || undefined,
    city: getUserCity(ctx.deps.db, ctx.from.id),
  });
  switch (result.kind) {
    case 'ok':
      await ctx.replyWithHTML(result.html);
      return;
    case 'no_arg':
      await ctx.reply(ctx.t('beers.usage'));
      return;
    case 'pub_not_found':
      await ctx.reply(ctx.t('beers.pub_not_found', { query: result.query }));
      return;
    case 'ambiguous': {
      const items = result.pubs.map((p) =>
        ctx.t('beers.ambiguous_item', { name: p.name, address: p.address ?? '—' }),
      );
      await ctx.reply([ctx.t('beers.ambiguous'), ...items].join('\n'));
      return;
    }
    case 'empty':
      await ctx.reply(ctx.t('beers.empty', { pub: result.pub }));
      return;
    default:
      // exhaustiveness: if BeersResult grows a new arm, TS errors here
      result satisfies never;
  }
});
