import type { Messages } from '../types';

export const uk: Messages = {
  // app
  'app.start': [
    'Привіт! Я допоможу зібрати маршрут по варшавських пабах і випити щось нове.',
    '',
    '1) /link <untappd-username> — щоб підтягувати твої чекіни.',
    '2) /import — завантаж CSV-експорт зі свого Untappd для повного бекфілу історії.',
    '3) /newbeers [пiдрядок назви паба] — топ непитих пив; з аргументом — тільки в матчених пабах.',
    '4) /pubs — список доступних пабів.',
    '5) /route N — маршрут, що покриває ≥ N непитих пив із мінімальною пішою відстанню.',
    '6) /beers <паб> — діагностика: усі краны паба як їх розпарсив бот.',
  ].join('\n'),
  'app.no_data_in_snapshot': 'Наразі немає цікавих непитих пив.',

  // help / command catalog
  'help.intro': 'Команди бота:',
  'cmd.newbeers': 'топ непитих пив',
  'cmd.route': 'пішохідний маршрут',
  'cmd.pubs': 'список пабів',
  'cmd.filters': 'фільтри (стиль/рейтинг/ABV)',
  'cmd.link': "прив'язати Untappd",
  'cmd.import': 'імпорт історії (CSV/JSON/ZIP)',
  'cmd.beers': 'діагностика кранів паба',
  'cmd.refresh': 'оновити дані',
  'cmd.lang': 'мова інтерфейсу',
  'cmd.help': 'ця довідка',
  'cmd.start': 'почати',

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
  'newbeers.pub_not_found': 'Паб «{query}» не знайдено. /pubs покаже доступні.',

  // beers (debug)
  'beers.usage': 'Використання: /beers <частина назви паба>. Аргумент обовʼязковий.',
  'beers.header': '🍺 <b>{pub}</b>{address}\nКранів: {count}',
  'beers.pub_not_found': 'Паб «{query}» не знайдено. /pubs покаже доступні.',
  'beers.ambiguous': 'Підходить кілька пабів — уточни запит (напр. додай вулицю):',
  'beers.ambiguous_item': '• {name} — {address}',
  'beers.empty': 'У пабі «{pub}» зараз немає даних про крани.',

  // pubs
  'pubs.header': 'Доступні паби:',
  'pubs.empty': 'У базі ще нема пабів — спочатку має пройти /refresh.',
  'pubs.hint': 'Підказка: /newbeers <частина назви> покаже новинки тільки в матчених пабах.',

  // route
  'route.preparing': '⏳ Будую маршрут для ≥{count} нових пив…',
  'route.matrix_progress': '🗺 Матриця відстаней: {cached}/{total} зі збережених, {missing} нових',
  'route.fill_missing': '🗺 Догружаю незбережені пари: {done}/{total}',
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
  'filters.current':
    '🎛 Твої фільтри\nСтилі: {styles}\nМіцність: {abv}\nРейтинг: {rating}\n\nТисни, щоб увімкнути/вимкнути. ♻️ — скинути все.',
  'filters.any': 'будь-яка',
  'filters.family_other': 'Інше',
  'filters.rating_value': 'від {rating}',
  'filters.reset_done': 'Скинуто',
  'filters.reset_button': '♻️ Скинути все',

  // lang
  'lang.prompt': 'Оберіть мову інтерфейсу:',
  'lang.changed': '✅ Мову змінено на {name}.',
};
