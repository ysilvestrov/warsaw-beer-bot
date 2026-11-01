# #934 автосинк — план ядра

Спека: `docs/superpowers/specs/2026-10/2026-10-31-934-auto-sync-design.md` (затверджено 2026-11-01).

Ядро — механізм, заради якого все робиться: сервер віддає `caughtUp`, крок синку перевіряє сесію
й уміє зупинитися після першої сторінки, планувальник тримає намір і веде кроки до кінця, перевірка
при старті/6 год. Обв'язка (віджет, бейдж, `spec.md`, інструкції, чейнджлог) — окремий план після
наскрізного рев'ю ядра.

Гейт кожної задачі: у WSL-копії `npm test && npm run typecheck` у корені й `npm test` у
`extension/` (через supervisor, без ручного `WBB_TEST_TMPDIR`).

## Задача 1. `isCaughtUp` і нові поля сервера та локального адаптера

Файли: `src/shared/checkin-sync/conclude.ts`, `src/api/routes/checkins.ts`,
`extension/src/local/sync.ts`, `extension/src/api/types.ts` + їхні тести.

1. `conclude.ts`: винести `export function isCaughtUp({count, profileTotal, ranges}): boolean` —
   той самий вираз, що зараз у `conclude`; `conclude` кличе його.
2. Тести `conclude.test.ts`: `profileTotal: null` → false; `count < total` → false; `count = total`
   і один діапазон → true; `count > total` і один діапазон → true; `count = total`, два діапазони
   → false.
3. Роут `POST /checkins/sync`: `caughtUp` у всіх трьох відповідях (порожня сторінка — з поточного
   покриття). `GET /checkins/sync/state`: `profileTotal` — збережений `profile_total`, плюс
   `caughtUp`. `complete` не чіпати.
4. `types.ts`: `caughtUp?: boolean` у `CheckinSyncState` і `CheckinSyncPageResult` (необов'язкове
   — старий сервер його не шле; відсутнє читається як `false`).
5. `local/sync.ts`: ті самі поля через `isCaughtUp` над локальною базою.
6. Таблиця сценаріїв `src/shared/checkin-sync/scenarios.ts` дістає очікуване `caughtUp` для кожного
   кроку, тож роут і локальний адаптер перевіряються однією таблицею.

Сумісність відкату: поля лише додаються, старий клієнт їх ігнорує, старий сервер їх не шле.

## Задача 2. Крок синку: сесія, сторінка Cloudflare, хуки бюджету

Файли: `extension/src/background/handle-checkin-sync.ts` + тест.

Нові необов'язкові залежності `CheckinSyncDeps`:
- `sessionOf?: (html: string) => string | null` — для першої сторінки кроку (`cursor === null`):
  `isBlockPage(html)` (з `src/shared/untappd/block.ts`) → `finish('blocked')`; `null` →
  `finish('no_session')` без `submitPage`; ім'я ≠ `state.username` (без регістру) →
  `finish('account_changed')`; збіг → далі. Глибокі сторінки не перевіряються.
- `beforeFetch?: () => Promise<void>` — викликається перед **кожним** `fetchFeed`; помилка з неї
  (бюджет вичерпано) → `finish('capped')`. Через нього планувальник резервує бюджет тихого синку
  до запиту.
- `afterPage?: (res, pages) => 'continue' | 'stop'` — після прийнятої сторінки, якщо
  `nextCursor !== null`; `stop` → новий статус `gap`.

`SyncStatus` дістає `'gap'`; `SyncOutcome` — `caughtUp: boolean` (з останньої відповіді чи стану,
відсутнє → false). `complete` лишається для старих читачів popup.

Тести: Cloudflare-сторінка з кодом 200 → `blocked`, `submitPage` не викликано; `sessionOf → null`
→ `no_session`, `submitPage` не викликано; інше ім'я → `account_changed`; регістр не важить;
друга сторінка `sessionOf` не кличе; `beforeFetch` викликано рівно стільки разів, скільки
`fetchFeed`, і її відмова дає `capped` без `fetchFeed`; `afterPage → stop` → `gap`; без нових
залежностей поведінка як була (наявні тести без змін).

## Задача 3. Модуль планувальника

Файл: `extension/src/background/sync-scheduler.ts` + тест. Без `chrome.*`: залежності через
параметри — `store` (get/set над `chrome.storage.local`), `alarms` (create/clear), `now()`,
`runStep(opts)` (обгортка `runCheckinSync`), `clearMatchCache()`, `hasUntappdPermission()`,
`hasToken()`.

Стан у сховищі: `syncIntent: SyncIntent | null`, `syncPause: { until: string } | null`,
`syncChecks: { date: string; count: number }`.

API:
- `startManual()` — знімає паузу, ставить/перетворює намір на `manual`, запускає цикл, якщо не йде.
- `stop()` — обриває поточний крок (AbortController) і знімає намір.
- `check()` — перевірка: умови 1–5 спеки §3, лічильник збільшується й пишеться **до** наміру;
  тоді намір `silent` і цикл.
- `resume()` — для старту процесу й будильника `wbb-sync-watchdog`: є намір і цикл не йде →
  дозвіл і токен є → цикл; інакше намір знімається зі станом `error`/`not_linked`.

Цикл: поки намір стоїть — `runStep` з `pageCap` 200 (тихий — `10 − silentPagesUsed`),
`beforeFetch` = прочитати намір, якщо тихий і `silentPagesUsed >= 10` — відмова, інакше записати
`+1` і чекати запису; `afterPage` для тихого — `need = ceil(max(0, profileTotal − serverCount) / 25)`,
`need > 10 − silentPagesUsed` → `stop`. Далі за таблицею спеки §2; `mergedThisRun > 0` →
`clearMatchCache()` раз на крок. `blocked` → пауза до наступної локальної півночі. Будильник
сторожа ставиться з наміром і знімається з ним. Повертає результат кроку для стану popup через
колбек `onOutcome`.

Тести (фейкові сховище/будильники/годинник, фейковий `runStep`):
- ручний на 450 сторінок — три кроки (`capped`, `capped`, `done`) без втручання, намір знято,
  будильник знято;
- новий екземпляр планувальника над тим самим сховищем + `resume()` → крок з першої сторінки
  (курсор у `runStep` не передається);
- тихий: сумарно `beforeFetch` пропускає рівно 10, зокрема коли перший екземпляр «помер» після
  резерву, але до відповіді — другий екземпляр бачить використаний пункт;
- `merged > 0` → `clearMatchCache` рівно раз; `merged = 0` → нуль разів;
- `afterPage` дає `gap` при `need` > залишку і `continue` при `need` ≤ залишку; рівні лічильники
  → `need = 0`;
- `blocked` → пауза до півночі за локальним часом (межа: 23:59 → наступний день 00:00); `check()`
  під паузою не ставить наміру; `startManual()` паузу знімає;
- п'ятий `check()` за добу не стартує; нова локальна дата скидає лічильник;
- без дозволу `check()` не викликає `runStep` (і не просить дозволу — такої залежності нема);
- `stop()` знімає намір; подальший `resume()` нічого не запускає.

## Задача 4. Підключення у фоновому процесі

Файли: `extension/src/background/index.ts`, `extension/manifest.config.ts` + тести
(`index.test.ts`).

- Маніфест: дозвіл `alarms`.
- Стан `checkinSync` переїжджає з `chrome.storage.session` у `chrome.storage.local`; нові поля
  `caughtUp`, `gapMissing`, `pausedUntil`, `quiet` (тихий `no_session`). Читач приймає старий запис
  без нових полів.
- `handleCheckinSyncStart` → `scheduler.startManual()`, `handleCheckinSyncStop` →
  `scheduler.stop()`; `runStep` будується з наявного тіла `beginCheckinSync` (fetch, submit,
  прив'язка, кеш) плюс `sessionOf: sessionUsername`. «Осиротілий» `running` у
  `handleCheckinSyncStatus` при наявному намірі не перетворюється на `error`: сторож його продовжить.
- Верхній рівень: `chrome.alarms.onAlarm` (`wbb-sync-watchdog` → `resume`, `wbb-sync-check` →
  `check`); `onStartup` і `onInstalled` створюють `wbb-sync-check` (360 хв), якщо його нема;
  `onStartup` → `check()`; кожен старт процесу → `resume()`.

Тести: повідомлення `checkin-sync:start/stop/status` поводяться як раніше для popup; будильник
`wbb-sync-check` створюється раз; старт процесу з наміром викликає крок; запис у
`chrome.storage.local`, не `session`.

## Рев'ю ядра

Наскрізне рев'ю (окремий агент, read-only) усіх чотирьох задач — усі чотири зроблено інлайн.

| № | Знахідка | Рішення | Що змінено |
|---|---|---|---|
| 1 | Sync під час тихого кроку не перетворював намір на ручний: `syncRunning` відповідав раніше за планувальник | виправлено | `handleCheckinSyncStart` кличе `startManual()` і тоді; тест у `index.test.ts` |
| 2 | Старт, записаний поки цикл завершує попередній намір, стирався `clearIntent` або лишався без циклу | виправлено | `id` наміру, зняття лише свого; усі read-modify-write наміру в одному ланцюжку; цикл після завершення читає намір наново, а кінець циклу підхоплює пізній запис; тест «keeps and runs a manual start…» |
| 3 | Звіт без кроку (зник токен) лишав `caughtUp: true` старого запису поруч із `not_linked` | виправлено | заміна результату скидає `caughtUp`/`gapMissing`/`pausedUntil`/`quiet`; тест |
| 4 | Тихий бюджет, витрачений на діру при рівних лічильниках, давав «0 new check-ins» і бейдж | виправлено | `gap` лише з `profileTotal − serverCount > 0`; рядок у таблиці §2 спеки; тест |
| 5 | Тест стопу нібито не завершується й не перевіряє `reports` | відхилено | другого старту в тесті немає, `reports` асертиться (`['cancelled']`), тест зелений у гейті |
| 6 | Відповідь на старт могла висіти, якщо цикл уже пройшов свій крок | виправлено | старт чекає або підтвердження кроку, або кінця циклу (`alreadyRunning: true`) |
| 7 | Після відкату й пізнього оновлення сторож продовжив би тижневий намір | виправлено | намір старший за добу знімається мовчки (§2 спеки); тести на межі |
| 8 | Порожня сторінка: `caughtUp` зі збереженого `profile_total`, а `profileTotal` відповіді — зі сторінки | відхилено | порожня сторінка нічого не записує; `caughtUp` мусить збігатися з `/state`, тож рахується зі збереженого |
| 9 | `reportGeneration` міг застаріти для звіту без кроку | виправлено | `afterStep` у звіті: без кроку — поточне покоління |
| 10 | `pages` у `afterPage` не використовується | відхилено | це API хука `runCheckinSync`, не планувальника; тест його фіксує |

Для обв'язки: `syncStatusReply` ще не віддає `caughtUp`/`gapMissing`/`pausedUntil`/`quiet`, а запис
стану не тримає `kind` — рядки §6 «no_session (тихий/ручний)» спиратимуться на `quiet`; «✓ Fully
synced» у popup досі з `complete` і мусить перейти на `caughtUp` до релізу.

## Після ядра

Наскрізне рев'ю ядра (задачі 1–4, з назвою кожної інлайнової задачі). Тоді — план обв'язки:
віджет §6 (чесний відсоток, «✓» лише з `caughtUp`), бейдж §5, `spec.md`,
`docs/extension-install-uk.md`/`-en.md`, `extension/CHANGELOG.md`.
