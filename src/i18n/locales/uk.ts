import type { Messages } from '../types';

export const uk: Messages = {
  // app
  'app.no_data_in_snapshot': 'Наразі немає цікавих непитих пив.',

  // common
  'common.interrupted_by_restart': '⚠️ Перервано рестартом — повтори команду.',

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
  'cmd.city': 'обрати місто',
  'city.prompt': 'Поточне місто: {name}. Оберіть місто:',
  'city.changed': '✅ Місто змінено на {name}.',
  'city.outside': '🌍 Поза Польщею',
  'city.blocked': 'Ця команда працює лише для міст Польщі. Обери місто: /city',
  'help.city_hint':
    'Ще кілька команд (паби, маршрут, топ пив) стануть доступними після вибору міста — /city',
  'cmd.help': 'ця довідка',
  'cmd.start': 'почати',
  'cmd.extension': 'токен для браузерного розширення',
  'cmd.status': 'твій статус і налаштування',
  'cmd.announce': 'анонси нових версій розширення',

  // link
  'link.usage': 'Використання: /link <username> (або повний URL untappd.com/user/<username>)',
  'link.success': "✅ Прив’язано до untappd.com/user/{username}. Показую історію цього акаунта. Щоб оновити її, натисніть “Sync my check-ins” у розширенні або скористайтеся /import.",
  'link.switched': "✅ Прив’язано до untappd.com/user/{username}. Показую історію цього акаунта; історію попереднього збережено окремо. Щоб оновити її, натисніть “Sync my check-ins” у розширенні або скористайтеся /import.",

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
  'import.account_changed': '⏹ Імпорт для {username} зупинено: акаунт змінився. Збережено {total} рядків; запустіть імпорт знову для поточного акаунта.',
  'import.unlinked': 'історії до прив’язки',
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
  'route.open_in_maps': '🗺 Маршрут у Google Maps',
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

  // status
  'status.title': '📊 Твій статус',
  'status.settings_header': '⚙️ Налаштування',
  'status.city': 'Місто: {name}',
  'status.language': 'Мова: {name}',
  'status.language_auto': 'авто',
  'status.filters': 'Фільтри: {summary}',
  'status.filters_none': 'немає',
  'status.filter_styles': 'стилі: {list}',
  'status.filter_rating': 'рейтинг від ★{rating}',
  'status.filter_abv': 'ABV {min}–{max}%',
  'status.filter_route': 'маршрут {n}',
  'status.filters_edit': 'Змінити: /filters',
  'status.untappd_header': '🍺 Untappd',
  'status.not_linked': 'Не прив’язано. Використай /link, або /import для історії.',
  'status.username': 'Акаунт: {username}',
  'status.checkins': 'Синхронізовано чекінів: {synced}',
  'status.checkins_of': 'Синхронізовано чекінів: {synced} / {total}',
  'status.profile_total_hint': 'Загальна кількість на Untappd — останнє відоме значення.',
  'status.last_sync': 'Остання активність синхронізації: {date} UTC',
  'status.no_sync': 'Синхронізація через розширення ще не запускалась.',
  'status.had_without_checkins': 'Пив, відомих серверу без імпортованих чекінів: {count}. Запусти «Sync my check-ins» у розширенні.',
  'status.distinct_beers': 'Унікального пива випито: {count}',
  'status.last_checkin': 'Останній чекін: {date}',
  'status.no_checkins': 'Ще немає чекінів — спробуй /import або розширення.',

  // extension
  'extension.success':
    'Ваш токен доступу для браузерного розширення. Додайте його в налаштування ' +
    'розширення (поле «API Token»). Старий токен, якщо був, більше не діє.\n' +
    'Адреса API: {url}',
  'extension.store':
    'Встановити розширення: {url}\n' +
    'Якщо побачиш «Item not available» — залогінься в Google-акаунт і онови сторінку ' +
    '(розширення позначене 18+ через пивну тематику).',
  'extension.mcp':
    'Цим самим токеном працює MCP — можна питати з Claude Code чи Codex, ' +
    'що з переліку пив у тебе вже випито (і з якою оцінкою — де збіг певний): {url}',

  // announce (#379)
  'announce.released':
    '🍺 Розширення оновилось до версії {version} — Chrome підтягне його сам найближчим часом.',
  'announce.changelog': 'Що нового: {url}',
  'announce.opt_out_hint': 'Не хочеш таких повідомлень — надішли /announce off.',
  'announce.status_on': 'Анонси нових версій розширення: увімкнені. Вимкнути — /announce off',
  'announce.status_off': 'Анонси нових версій розширення: вимкнені. Увімкнути — /announce on',
  'announce.turned_on': 'Готово — розповідатиму про нові версії розширення.',
  'announce.turned_off': 'Готово — більше не турбуватиму. Повернути — /announce on',
  'announce.no_token':
    'Втім, анонси йдуть лише власникам токена розширення — отримати його можна через /extension.',

  // bug reports
  'cmd.report': 'поскаржитися на помилку в боті чи розширенні',
  'report.ask_source': 'Де помилка?',
  'report.source.bot': 'Бот',
  'report.source.extension': 'Розширення',
  'report.ask_category': 'Що саме не так?',
  'report.cat.wrong_beer': 'Не те пиво / чужий рейтинг',
  'report.cat.no_rating': 'Пиво без рейтингу',
  'report.cat.had_status': 'Неправильно «пив / не пив»',
  'report.cat.stale_data': 'Застарілі або хибні дані паба / кранів / крамниці',
  'report.cat.route': 'Маршрут або карта',
  'report.cat.no_badge': 'Позначка не з\'являється на сторінці крамниці',
  'report.cat.ext_broken': 'Розширення не працює: вхід, встановлення, оновлення, меню',
  'report.cat.bot_broken': 'Бот не відповідає, зависає або видає помилку',
  'report.cat.text_ui': 'Текст, переклад, оформлення',
  'report.cat.other': 'Інше',
  'report.ask_text': 'Опиши, що сталося і що мало статися — щонайменше 10 символів.',
  'report.too_short': 'Закоротко — напиши хоча б 10 символів.',
  'report.ask_media': 'Можеш додати до 3 скріншотів чи відео (до 20 МБ) або одразу натиснути «Без медіа».',
  'report.media_added': 'Додано ({n}/{max}).',
  'report.media_full': 'Уже 3 файли — більше не можна. Натисни «Готово».',
  'report.media_too_big': 'Файл більший за 20 МБ — бот не зможе його завантажити.',
  'report.btn.done': 'Готово',
  'report.btn.no_media': 'Без медіа',
  'report.btn.send': 'Надіслати',
  'report.btn.cancel': 'Скасувати',
  'report.confirm': 'Перевір скаргу:\n{source} · {category}\n\n{text}\n\nМедіа: {media}\n\nОпис у переказі буде опубліковано публічно на GitHub. Скріншоти й відео публічними не будуть — їх бачать лише розробники на сервері. Не пиши в описі особистих даних.',
  'report.accepted': 'Прийнято, аналізую…',
  'report.retry': 'Не вдалося прийняти скаргу — натисни «Надіслати» ще раз.',
  'report.cancelled': 'Скаргу скасовано.',
  'report.expired': 'Ця чернетка вже неактуальна — почни знову: /report',
  'report.limit': 'Сьогодні вже 3 скарги — це максимум на добу. Спробуй завтра.',
  'report.banned': 'Скарги для тебе недоступні.',
  'report.unavailable': 'Скарги тимчасово недоступні.',
  'report.private_only': 'Скарги приймаються лише в особистому чаті з ботом.',
  'report.done.created': 'Дякую! Створено issue: {url}',
  'report.done.duplicate_open': 'Дякую! Це вже відомо й відкрито — додали твої дані: {url}',
  'report.done.duplicate_closed_fixed': 'Це виправлено {date}. Якщо бачиш після оновлення — надішли скаргу ще раз: {url}',
  'report.done.duplicate_closed': 'Це вже відомо (закрито {date}): {url}',
  'report.done.not_a_bug': 'Схоже, це не помилка бота чи розширення.',
  'report.done.deferred': 'Прийнято — відповім пізніше.',
  'report.done.needs_review': 'Прийнято — розробник перевірить вручну.',
  'report.done.failed': 'Не вдалося обробити скаргу — розробник подивиться.',
  'reportban.usage': 'Використання: /reportban <telegram_id> [off]',
  'reportban.banned': 'Скарги для {id} вимкнено.',
  'reportban.unbanned': 'Скарги для {id} увімкнено.',

  // WFP festival mode
  'fest.no_fest': 'Зараз немає фестивалю, до якого можна приєднатися.',
  'fest.team_created': 'Команду фестивалю «{fest}» створено для цього чату. Натисніть кнопку, щоб приєднатися.',
  'fest.join_button': '🙋 Я в команді',
  'fest.joined': '✅ {name} у команді.',
  'fest.already_member': 'Ви вже в команді.',
  'fest.need_link': 'Спершу прив’яжіть Untappd у приватному чаті з ботом: /link <username>',
  'fest.no_team': 'Ви не в жодній команді фестивалю. Напишіть /fest у груповому чаті команди.',
  'fest.pick_team': 'Оберіть команду:',
  'fest.not_member': 'Це для учасників команди — натисніть «Я в команді».',
  'fest.menu_empty': 'Меню фестивалю ще не завантажене.',
  'fest.menu_line': 'Позицій у меню: {count}, оновлено о {time}.',
  'fest.no_targets': 'У меню немає Target-ів для цієї команди.',
  'fest.legend': '🍺 — Target-и, що зараз наливають · ❔ — не можемо побачити',
  'fest.stand': '{floor} пов., {stand}',
  'fest.stand_floor_only': '{floor} пов.',
  'fest.status_on_tap': '🟢 чекін {mins} хв тому ({count})',
  'fest.status_not_seen': '⚪ не бачили за годину',
  'fest.status_unknown': '❔ невідомо — ми не бачили всю годину',
  'fest.section_gone': 'Ця секція вже не в рейтингу — надішліть /fest ще раз.',
  'fest.history_header': '<b>Повнота історії</b> (чекінів у боті / у профілі Untappd):',
  'fest.history_line': '{initials}: {inBot} / {total}',
  'fest.history_unknown': '? (синк розширенням не робився)',
  'fest.targets_header': '<b>Target-и: {count}</b>',
  'fest.targets_more': '…і ще {count}',
  'fest.unrated_header': '<b>Непите без рейтингу: {count}</b> (не Target, але й не відкинуте)',
  'fest.reason_rating': '⭐ {rating}',
  'fest.reason_style': '🧪 стиль',
  'fest.reason_manual': '✋ вручну',
  'fest.remove_button': '➖ {name}',
  'fest.add_usage': 'Напишіть частину назви пива або броварні: /fest add motueka',
  'fest.add_none': 'У меню нічого не знайдено за «{query}».',
  'fest.add_pick': 'Що додати в Target-и?',
  'fest.added': '➕ {name} — тепер Target.',
  'fest.removed': '➖ {name} прибрано з Target-ів.',
  'fest.stands_usage': 'Надішліть CSV-файл із підписом /fest stands. Рядок: секція;поверх;стенд (перший рядок може бути заголовком).',
  'fest.stands_saved': 'Стендів збережено: {count}.',
  'fest.stands_errors': 'Не прочитано рядки: {lines}.',
  'fest.stands_unknown': 'Цих секцій немає в меню (збережено, але поки не знадобляться): {sections}.',
  'fest.stands_missing': 'Секції меню без стенда: {sections}.',
  'fest.stands_complete': 'У всіх секцій меню є стенд.',
  'fest.menu_refreshed': 'Меню перечитано, позицій на сторінці: {count}.',
  'fest.menu_stale': 'Сторінка меню старша за вже збережене — нічого не змінено.',
  'fest.menu_blocked': 'Untappd зараз не віддає сторінку серверу — спробуйте пізніше або з ноута.',
  'fest.menu_wrong_page': 'Сторінка не схожа на меню фестивалю — нічого не змінено.',
  'fest.menu_unavailable': 'Серверне читання Untappd вимкнене (немає куки) — меню оновлює лише ноут.',
  'fest.lines_more': '…не вмістилося рядків: {count}',
  'fest.take_usage': 'Напишіть частину назви пива або броварні: /fest take motueka',
  'fest.take_none': 'У меню нічого не знайдено за «{query}».',
  'fest.take_pick': 'Яке пиво взяли?',
  'fest.take_button': '🍺 Взяв: {name}',
  'fest.taken': '🍺 Келих №{glass} — {name} · {initials}',
  'fest.queue_header': '<b>Черга келихів</b> (✅ зачекінив · ⏳ ще ні)',
  'fest.queue_empty': 'Черга порожня. Натисніть «🍺 Взяв» у деталях секції або /fest take <назва>.',
  'fest.queue_line': '№{glass} <b>{name}</b>{section} · взяв {taker}\n   {marks}',
  'fest.queue_link': '№{glass} {name} ↗',
};
