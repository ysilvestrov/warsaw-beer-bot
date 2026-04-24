import { Composer } from 'telegraf';
import { Readable } from 'node:stream';
import type { BotContext } from '../index';
import {
  iterExport,
  detectFormat,
  type Checkin,
  type ExportFormat,
} from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { ensureProfile } from '../../storage/user_profiles';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

const BATCH_SIZE = 500;
const PROGRESS_INTERVAL_MS = 2000;
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export const importCommand = new Composer<BotContext>();

importCommand.command('import', async (ctx) => {
  await ctx.reply(
    'Надішли експорт з Untappd: CSV, JSON або ZIP (до 20 MB).\n' +
      'Supporter → Account → Download History. Великий JSON краще запакувати в ZIP.',
  );
});

importCommand.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const name = doc.file_name ?? '';

  let format: ExportFormat;
  try {
    format = detectFormat(name);
  } catch {
    await ctx.reply('Формат не підтримується. Очікую .csv, .json або .zip.');
    return;
  }

  if (doc.file_size && doc.file_size > TG_DOWNLOAD_LIMIT) {
    await ctx.reply(
      'Файл > 20 MB — Telegram не дасть боту його скачати. ' +
        'Запакуй JSON у ZIP (стискається ≈10×) і надішли ще раз.',
    );
    return;
  }

  ensureProfile(ctx.deps.db, ctx.from.id);

  const link = await ctx.telegram.getFileLink(doc.file_id);
  const res = await fetch(link.toString());
  if (!res.ok || !res.body) {
    await ctx.reply('Не вдалось отримати файл з Telegram.');
    return;
  }
  const stream = Readable.fromWeb(res.body as never);

  const progress = await ctx.reply('⏳ Починаю імпорт…');
  const db = ctx.deps.db;
  const telegramId = ctx.from.id;

  const flushBatch = db.transaction((rows: Checkin[]) => {
    for (const r of rows) {
      const beerId = upsertBeer(db, {
        untappd_id: r.bid ?? null,
        name: r.beer_name,
        brewery: r.brewery_name,
        style: r.beer_type,
        abv: r.beer_abv,
        rating_global: null,
        normalized_name: normalizeName(r.beer_name),
        normalized_brewery: normalizeBrewery(r.brewery_name),
      });
      mergeCheckin(db, {
        checkin_id: r.checkin_id,
        telegram_id: telegramId,
        beer_id: beerId,
        user_rating: r.rating_score,
        checkin_at: r.created_at,
        venue: r.venue_name,
      });
    }
  });

  let total = 0;
  let batch: Checkin[] = [];
  let lastReport = Date.now();

  const report = async (text: string) => {
    await ctx.telegram
      .editMessageText(ctx.chat.id, progress.message_id, undefined, text)
      .catch(() => {});
  };

  try {
    for await (const row of iterExport(stream, format)) {
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        flushBatch(batch);
        total += batch.length;
        batch = [];
        if (Date.now() - lastReport > PROGRESS_INTERVAL_MS) {
          lastReport = Date.now();
          await report(`⏳ Імпортовано ${total}…`);
        }
      }
    }
    if (batch.length) {
      flushBatch(batch);
      total += batch.length;
    }
    await report(`✅ Імпортовано ${total} чекінів (${format.toUpperCase()}).`);
  } catch (e) {
    await report(`❌ Помилка після ${total} рядків: ${(e as Error).message}`);
    throw e;
  }
});
