import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { filtersKeyboard } from '../keyboards';
import { getFilters, setFilters } from '../../storage/user_filters';
import { ensureProfile } from '../../storage/user_profiles';

const emptyFilters = () => ({
  styles: [] as string[],
  min_rating: null as number | null,
  abv_min: null as number | null,
  abv_max: null as number | null,
  default_route_n: null as number | null,
});

export const filtersCommand = new Composer<BotContext>();

filtersCommand.command('filters', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const f = getFilters(ctx.deps.db, ctx.from.id);
  await ctx.reply(
    `Поточні: styles=${(f?.styles ?? []).join(',') || '—'}, min_rating=${f?.min_rating ?? '—'}`,
    filtersKeyboard(),
  );
});

filtersCommand.action(/style:(.+)/, async (ctx) => {
  const style = ctx.match[1];
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  const styles = f.styles.includes(style)
    ? f.styles.filter((s) => s !== style)
    : [...f.styles, style];
  setFilters(ctx.deps.db, ctx.from!.id, { ...f, styles });
  await ctx.answerCbQuery(`styles=${styles.join(',') || '—'}`);
});

filtersCommand.action(/rating:(.+)/, async (ctx) => {
  const r = parseFloat(ctx.match[1]);
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  setFilters(ctx.deps.db, ctx.from!.id, { ...f, min_rating: r });
  await ctx.answerCbQuery(`min_rating=${r}`);
});

filtersCommand.action('reset', async (ctx) => {
  setFilters(ctx.deps.db, ctx.from!.id, emptyFilters());
  await ctx.answerCbQuery('Скинуто');
});
