# #846 — відмова синхронізації чекінів має назву: і в popup, і в журналі

## Проблема

Синхронізація чекінів із розширення зупинилась у людини з текстом «Sync failed — check your
connection and token, then retry.» і при кожному повторі зупиняється там само. Ні людина, ні ми
не можемо сказати, що відмовило.

Розширення зводить у стан `error` чотири різні події:

| Подія | Де | Зараз |
|---|---|---|
| Untappd перенаправив `more_feed` або відповів не-2xx (крім 403/429) | `fetchFeed` у `background/index.ts` | `ApiError('server')` → `error` |
| сервер відхилив сторінку: `400 bad_cursor` | `postCheckinSyncPage` | `ApiError('server')` → `error` |
| мережа, тайм-аут, `401`, `5xx` сервера | обидва | `error` |
| відповідь без `nextCursor` (старий сервер) | `runCheckinSync` | `error` |

Текст про «з'єднання й токен» правдивий лише для третього рядка.

Сервер зі свого боку не пише в журнал жодної відмови `POST /checkins/sync`: `bad_cursor` (три
місця), `no_session`, `blocked` і три `409` повертаються мовчки; `api error` пишеться лише для
винятків.

## Доказ (проба до класифікації, 2026-10-12)

Прод-БД на читання й журнал, без ідентифікаторів: перша сторінка цього акаунта проходить при
кожній спробі (рядок `checkin_sync_state` оновлюється), `api error` за 26 годин — нуль, зупинка
детермінована на другому запиті (углиб стрічки). Інші акаунти пройшли тим самим шляхом 2029 і
1740 чекінів, а «Show More» у браузері вантажить стрічку й глибше. Отже відмова — це один із
перших двох рядків таблиці, і наявними засобами їх не розрізнити.

## Рішення

### Розширення: два нові термінальні стани

- `feed_unavailable` — Untappd не віддав стрічку: перенаправлення на `more_feed` або не-2xx,
  крім 403/429 (вони лишаються `blocked`). Рішення ухвалює чиста функція
  `feedFailure(isMoreFeed, { ok, status, redirected })` у `handle-checkin-sync.ts`, яка повертає
  `'blocked' | 'feed_unavailable' | null`; `fetchFeed` лише кидає `ApiError` з цим кодом. Того
  самого разу service worker пише `console.warn` зі статусом і ознакою перенаправлення — це
  єдине місце, де цей факт узагалі існує.
- `page_rejected` — сервер відповів `400` з `error: "bad_cursor"`. `postCheckinSyncPage` мапить
  саме цю пару в `ApiError('page_rejected')`; будь-який інший `400` лишається `server`.

`error` лишається для мережі, токена, `5xx` і старого сервера — там його текст доречний.

Тексти popup:

- `feed_unavailable`: «Untappd did not return your check-in feed — open untappd.com, make sure
  you are signed in to the linked account, then sync again.»
- `page_rejected`: «Untappd returned an unexpected page, so nothing was saved — try again
  later, or use /import in the bot.»

Обидва стани не є «повністю»: `complete` рахується як і для решти (збіг лічильників), нових
винятків немає.

### Сервер: рядок у журналі на кожну відмову

Кожна відмова `POST /checkins/sync` пише `log.warn({ code, reason?, pageSize?, hasCursor? },
'checkins sync refused')`:

| Відповідь | `code` | `reason` |
|---|---|---|
| `409` | `not_linked` / `account_changed` / `sync_context_required` | — |
| `502` | `blocked` | — |
| `400`, курсор не число | `bad_cursor` | `cursor_format` |
| `422` | `no_session` | `empty_above_known` |
| `400`, найстаріший елемент вище курсора | `bad_cursor` | `oldest_above_cursor` |
| `400`, лише найновіший вище курсора | `bad_cursor` | `newest_above_cursor` |

`pageSize` — скільки чекінів розпарсилося зі сторінки (там, де сторінку вже розпарсено);
`hasCursor` — чи був курсор у запиті.

**Чого в рядку немає.** Telegram id, імені акаунта, HTML — і **самих id чекінів та курсора**:
id чекіна відкривається на untappd.com як публічна сторінка з профілем людини, тож це той самий
ідентифікатор іншою дорогою. Для діагнозу досить відношення («вище курсора»), а не чисел.

Статуси й тіла відповідей не змінюються.

### Поза межами

- Щоденний звіт. Пункт 3 з issue (показувати відмови в «Каналах», як збої обробників після
  #836) потребує сховища й рядка статусу — це окрема стадія. Спершу журнал: він відповість, чи
  таких відмов узагалі буває стільки, щоб їх рахувати.
- Причина відмови саме в цієї людини. Після цієї зміни вона читається: або з popup
  (`feed_unavailable`), або з журналу (`reason`).
- Тайм-аут `postCheckinSyncPage` (10 с) і розділення `error` на мережу й токен.

## Заявка → доказ

Зміна нічого не записує як факт, який потім читають як істину: ні стану, ні курсора, ні
покриття. Рядок журналу — спостереження, а не заявка. Таблиця порожня.

## Сумісність

Старе розширення з новим сервером: відповіді ті самі, нічого не міняється. Нове розширення зі
старим сервером: `400 bad_cursor` уже існує — нове розширення покаже `page_rejected`.

## Тести

Сервер (`src/api/routes/checkins.test.ts`): для кожного рядка таблиці відмов — точний об'єкт,
переданий у `warn`, і точне повідомлення; успішна сторінка `warn` не викликає.

Розширення:

- `feedFailure`: 200 профілю → `null`; 200 `more_feed` без перенаправлення → `null`;
  перенаправлений `more_feed` → `feed_unavailable`; перенаправлена сторінка профілю з 200 →
  `null` (перенаправлення профілю законне); 500 → `feed_unavailable`; 403 і 429 → `blocked`.
- `runCheckinSync`: `fetchFeed` кидає `feed_unavailable` → стан `feed_unavailable`;
  `submitPage` кидає `page_rejected` → стан `page_rejected`; `server` в обох місцях лишається
  `error`.
- `postCheckinSyncPage`: `400 {error:"bad_cursor"}` → `page_rejected`; `400` з іншим тілом →
  `server`.
- `formatSyncStatus`: обидва нові тексти дослівно.

## Документи

`spec.md` (розділ `/checkins/sync` і абзац про стани popup), `docs/extension-install-uk.md` і
`docs/extension-install-en.md` (два нові повідомлення в описі кнопки), `extension/CHANGELOG.md`
(один рядок для людини).
