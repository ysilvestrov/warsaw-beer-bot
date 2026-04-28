import type { Messages } from '../types';

export const uk: Messages = {
  // app
  'app.start': [
    'Привіт! Я допоможу зібрати маршрут по варшавських пабах і випити щось нове.',
    '',
    '1) /link <untappd-username> — щоб підтягувати твої чекіни.',
    '2) /import — завантаж CSV-експорт зі свого Untappd для повного бекфілу історії.',
    '3) /newbeers — топ непитих пив на поточних кранах.',
    '4) /route N — маршрут, що покриває ≥ N непитих пив із мінімальною пішою відстанню.',
  ].join('\n'),
  'app.no_data_in_snapshot': 'Немає цікавих непитих пив у поточному snapshot.',

  // link
  'link.usage': 'Використання: /link <username> (або повний URL untappd.com/user/<username>)',
  'link.success': "✅ Прив'язано до untappd.com/user/{username}",

  // import
  'import.prompt':
    'Надішли експорт з Untappd: CSV, JSON або ZIP (до 20 MB).\n' +
    'Supporter → Account → Download History. Великий JSON краще запакувати в ZIP.',
  'import.unsupported_format': 'Формат не підтримується. Очікую .csv, .json або .zip.',
  'import.too_large':
    'Файл > 20 MB — Telegram не дасть боту його скачати. ' +
    'Запакуй JSON у ZIP (стискається ≈10×) і надішли ще раз.',
  'import.fetch_failed': 'Не вдалось отримати файл з Telegram.',
  'import.starting': '⏳ Починаю імпорт…',
  'import.progress': '⏳ Імпортовано {total}…',
  'import.done': '✅ Імпортовано {total} чекінів ({format}).',
  'import.failed': '❌ Помилка після {total} рядків: {message}',

  // newbeers
  'newbeers.empty': 'Нічого цікавого — спробуй /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} інших',

  // route
  'route.preparing': '⏳ Будую маршрут для ≥{count} нових пив…',
  'route.matrix_progress': '🗺 Матриця відстаней: {cached}/{total} з кешу, {missing} нових',
  'route.fill_missing': '🗺 Догружаю пари без кешу: {done}/{total}',
  'route.searching_tour': '🧠 Шукаю найкоротший обхід…',
  'route.failed': '❌ Не вдалось побудувати маршрут — подивись логи.',
  'route.header':
    'Знайдено маршрут для <b>{count}</b> (чи більше) нових пив, відстань ≈ <b>{km}</b>, пабів у маршруті: <b>{pubs}</b>.',

  // refresh
  'refresh.cooldown': '⏱ Занадто часто — спробуй за кілька хвилин.',
  'refresh.starting': '⏳ Оновлюю…',
  'refresh.done': '✅ Готово.',
  'refresh.failed': '❌ Не вдалось — подивись логи.',

  // filters
  'filters.current': 'Поточні: styles={styles}, min_rating={min_rating}',
  'filters.styles_changed': 'styles={styles}',
  'filters.rating_changed': 'min_rating={rating}',
  'filters.reset_done': 'Скинуто',
};
