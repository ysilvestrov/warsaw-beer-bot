import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { filtersKeyboard } from '../keyboards';
import { getFilters, setFilters, type Filters } from '../../storage/user_filters';
import { ensureProfile } from '../../storage/user_profiles';
import { currentTapStyles } from '../../storage/snapshots';
import { topStyleFamilies, ABV_PRESETS, bucketForRange, formatAbvRange } from '../../domain/filters';
import { OTHER_FAMILY } from '../../domain/style-family';
import type { DB } from '../../storage/db';
import type { Translator } from '../../i18n/types';

const emptyFilters = (): Filters => ({
  styles: [],
  min_rating: null,
  abv_min: null,
  abv_max: null,
  default_route_n: null,
});

function render(t: Translator, db: DB, f: Filters): { text: string; kb: ReturnType<typeof filtersKeyboard> } {
  const families = topStyleFamilies(currentTapStyles(db), f.styles, 10);
  const abvKey = bucketForRange(f.abv_min, f.abv_max);
  const stylesStr = f.styles.length
    ? f.styles.map((s) => (s === OTHER_FAMILY ? t('filters.family_other') : s)).join(', ')
    : t('filters.any');
  const abvStr = formatAbvRange(f.abv_min, f.abv_max) ?? t('filters.any');
  const ratingStr = f.min_rating != null ? t('filters.rating_value', { rating: f.min_rating }) : t('filters.any');
  const text = t('filters.current', { styles: stylesStr, abv: abvStr, rating: ratingStr });
  const kb = filtersKeyboard(t, { families, activeStyles: f.styles, abvKey, minRating: f.min_rating });
  return { text, kb };
}

// Telegram rejects an editMessageText that produces identical content with
// "message is not modified" — harmless here (e.g. reset while already empty).
async function safeEdit(ctx: BotContext, text: string, kb: ReturnType<typeof filtersKeyboard>): Promise<void> {
  try {
    await ctx.editMessageText(text, kb);
  } catch (e) {
    const msg = String((e as { description?: string; message?: string })?.description ?? (e as Error)?.message ?? '');
    if (!msg.includes('message is not modified')) throw e;
  }
}

export const filtersCommand = new Composer<BotContext>();

filtersCommand.command('filters', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const f = getFilters(ctx.deps.db, ctx.from.id) ?? emptyFilters();
  const { text, kb } = render(ctx.t, ctx.deps.db, f);
  await ctx.reply(text, kb);
});

filtersCommand.action(/style:(.+)/, async (ctx) => {
  const style = ctx.match[1];
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  const styles = f.styles.includes(style)
    ? f.styles.filter((s) => s !== style)
    : [...f.styles, style];
  const next = { ...f, styles };
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery();
});

filtersCommand.action(/abv:(.+)/, async (ctx) => {
  const key = ctx.match[1];
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  const cur = bucketForRange(f.abv_min, f.abv_max);
  const next =
    cur === key
      ? { ...f, abv_min: null, abv_max: null }
      : (() => {
          const b = ABV_PRESETS.find((x) => x.key === key)!;
          return { ...f, abv_min: b.min, abv_max: b.max };
        })();
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery();
});

filtersCommand.action(/rating:(.+)/, async (ctx) => {
  const r = parseFloat(ctx.match[1]);
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  const next = { ...f, min_rating: f.min_rating === r ? null : r };
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery();
});

filtersCommand.action('reset', async (ctx) => {
  const next = emptyFilters();
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery(ctx.t('filters.reset_done'));
});
