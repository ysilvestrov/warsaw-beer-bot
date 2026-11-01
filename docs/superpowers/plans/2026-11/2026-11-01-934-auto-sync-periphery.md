# #934 автосинк — план обв'язки

Спека: `docs/superpowers/specs/2026-10/2026-10-31-934-auto-sync-design.md` (затверджено 2026-11-01).
Ядро: `docs/superpowers/plans/2026-11/2026-11-01-934-auto-sync-core.md` (зроблено, рев'ю пройдено).

Обв'язка спирається на те, що ядро вже пише в `chrome.storage.local.checkinSync`: `outcome`
(зокрема `gap`), `caughtUp`, `gapMissing`, `pausedUntil`, `quiet`, і на `syncIntent` поруч.
Тут — як це доходить до людини: відповідь статусу, бейдж, віджет §6, документи.

Гейт кожної задачі: у WSL-копії `npm test && npm run typecheck` у корені й `npm test` +
`npm run typecheck` у `extension/` (через supervisor, без ручного `WBB_TEST_TMPDIR`). Корінь має 5
відомих збоїв середовища (`sqlite3` CLI у WSL) у `scripts/` — гілка їх не чіпає.

## Задача 1. Відповідь статусу й бейдж

Файли: `extension/src/background/index.ts` + `index.test.ts` (і мок `chrome.action` у
`extension/tests/setup.ts`).

1. `syncStatusReply` додає `caughtUp: s.caughtUp === true`, `gapMissing: s.gapMissing ?? null`,
   `pausedUntil: s.pausedUntil ?? null`, `quiet: s.quiet === true`, `username: s.binding?.username
   ?? null` (лише ім'я — для рядка `account_changed` «Sign in as <username>»; токен і `baseUrl`
   лишаються у воркері, як і досі). Старий запис без нових полів дає `false`/`null`.
2. `running` у відповіді — `s.running || намір стоїть`. Між двома кроками ручного синку запис
   короткочасно каже `capped`, `running: false`; людина не повинна бачити «Synced 5 000 of 12 407»
   з **Sync again** на секунду між кроками (§6: «`capped` людина більше не бачить»). Намір є —
   віджет показує «Syncing…», і popup продовжує опитування.
3. Бейдж похідний від збереженого стану, а не окремий прапорець: `applySyncBadge(s)` —
   `outcome === 'gap' && !running` → `setBadgeText('!')` + `setBadgeBackgroundColor` бурштиновий;
   інакше `setBadgeText('')`. Кличеться після кожного запису стану в `enqueueSyncStatusPatch` і раз
   на старті процесу (верхній рівень, поруч із `resume()`) — так бейдж «відновлюється при старті
   фонового процесу» без окремого ключа. Рішення: похідне правило знімає бейдж на старті синку
   (`running: true`) і на будь-якому наступному результаті, не лише на `done` — це надмножина §5,
   і кожен наступний результат усе одно йде після старту синку. Помилка `chrome.action` не валить
   запис стану (`catch`, бо бейдж — показ).

Тести:
- відповідь несе `caughtUp`/`gapMissing`/`pausedUntil`/`quiet`/`username` із запису; старий запис
  без полів → `false`/`null`/`false`/`null`; токена у відповіді нема (наявний тест розширити);
- запис `capped` + намір → `running: true`; `capped` без наміру → `running: false`;
- звіт `gap` → `setBadgeText({ text: '!' })` і колір; наступний старт кроку → `{ text: '' }`;
- старт процесу з `gap` у сховищі → `'!'`; з `done` → `''`.

## Задача 2. Віджет §6

Файли: `extension/src/popup/popup.ts`, `popup.html`, `popup.css` + `popup.test.ts`.

1. `SyncStatusView` дістає поля з задачі 1. Чиста функція `syncWidgetView(s)` →
   `{ label, percent: number | null, detail: string | null, action: SyncAction | null,
   link: { text, href } | null, tone: 'neutral' | 'error' }`, де `SyncAction` —
   `{ kind: 'start' | 'stop', label }`. Вона замінює `formatSyncStatus` і `syncButtonLabel`
   (видалити обидві й їхні тести; таблиця нижче — їхня заміна).
2. `percent = profileTotal === null ? null : min(100, floor(serverCount / profileTotal × 100))`;
   `profileTotal === 0` — `null` (ділення на нуль — невизначена смужка, не 100 %). Числа з
   розділювачем тисяч вузьким пробілом (`12 407`), як у спеці; відсоток — `42 %`.
3. Рядки — точно таблиця §6 (мітка, смужка, дія). Що таблиця лишає відкритим:
   - `done` без `profileTotal` → `Synced 1 234`, смужки нема, **Sync again**;
   - `capped` (стан без наміру: тиха перевірка, що витратила бюджет на дірі при рівних лічильниках,
     або запис старої версії) — як `done` без `caughtUp`;
   - `gap` без `gapMissing` (неможливо за ядром, але тип дозволяє) → `New check-ins`, **Sync**;
   - `null` (синку ще не було) → мітки нема, **Sync my check-ins**;
   - `blocked` `detail` — `Resumes tomorrow`, лише коли `pausedUntil` у майбутньому відносно
     переданого `now`; інакше без `detail`. Дія **Try now** — це ручний старт, який знімає паузу
     (ядро вже це робить);
   - посилання `no_session` — `https://untappd.com/`; `not_linked` — текст `/link` без посилання
     (у бота нема URL, лише команда).
4. `tone: 'error'` — лише `error`, `page_rejected`, `feed_unavailable` (CSS-клас, червоний текст
   мітки); решта нейтральні.
5. `popup.html`: під кнопкою — `#syncLabel` (мітка), `#syncBar` (`<div role="progressbar">` з
   `aria-valuenow`, без `aria-valuenow` для невизначеної), `#syncDetail`, `#syncLink`; наявний
   `#syncStatus` лишається для повідомлень самого popup (`Starting…`, `Stopping…`, дозвіл
   untappd.com, `Sync interrupted…`) — їх таблиця §6 не покриває. Кнопка `#syncCheckins` бере
   `action.label`; `action === null` → кнопку сховати (`hidden`), не вимкнути. Без токена
   `applyTokenState` керує нею як і раніше — віджет рендериться лише з токеном.
6. Клік: `action.kind === 'stop'` → `checkin-sync:stop`; `'start'` → наявний шлях (дозвіл у
   жесті, `requestSyncStart`, опитування). Опитування — поки `running`.

Тести (`syncWidgetView`, по рядку на кожен рядок §6, точні об'єкти через `toEqual`):
- вимога issue: `done`, 12 407 / 12 407, `caughtUp: false` → `percent: 100`,
  `label: 'Synced 12 407 of 12 407'`, дія **Sync again**, не «✓»;
- `done` + `caughtUp` → `✓ Fully synced`, 100, `detail: '12 407 check-ins'`, `action: null`;
- лічильник понад загальну (12 500 / 12 407) → 100, не 100+;
- межі відсотка: 0 / 12 407 → 0; 12 406 / 12 407 → 99 (floor); `profileTotal: null` і `0` → `null`;
- `no_session` тихий і ручний — різні рядки; `blocked` з паузою в майбутньому / у минулому;
- `account_changed` з `username: 'bob'` → `Sign in as bob`;
- тон: три червоні статуси `error`, решта `neutral` (кожен рядок таблиці асертить свій `tone`).

## Задача 3. Документи

Файли: `spec.md`, `docs/extension-install-uk.md`, `docs/extension-install-en.md`,
`extension/CHANGELOG.md`.

- `spec.md` (розділ `GET /checkins/sync/state` / `POST /checkins/sync`, ~р. 2215–2345):
  `caughtUp` у трьох відповідях POST і в `state`, `profileTotal` у `state` — збережений;
  абзац «Обхід (клієнт)» переписати: синк іде кроками до кінця сам (намір у `chrome.storage.local`,
  сторож-будильник 1 хв, намір старший за добу знімається), «Continue — N left» зникає; тиха
  перевірка на старті браузера й кожні 6 год (≤ 4 на добу, бюджет 10 запитів, лише з дозволом
  untappd.com і токеном), `gap` і бейдж «!», пауза до локальної півночі після `blocked`, перевірка
  сесії на першій сторінці (`no_session`/`account_changed`/Cloudflare → `blocked`), скидання кешу
  `/match` після кроку з `merged > 0`, стан у `chrome.storage.local`, віджет §6 і «✓» лише з
  `caughtUp`. Посилання на дизайн-спеку.
- `docs/extension-install-uk.md` / `-en.md` (пункт «Sync my check-ins», ~р. 282 / 273): одне
  натискання доводить синк до кінця, навіть якщо закрити popup; тиха перевірка при старті браузера
  й кожні 6 год; бейдж «!» на іконці — нових чекінів більше, ніж підтягує тиха перевірка, натисни
  **Sync**; що означає кожна пауза (вхід на untappd.com, обмеження Untappd до завтра, інший
  акаунт); смужка і «✓ Fully synced» лише коли історія повна. Старі тексти статусів
  (`Syncing… 1200 / 8200`, `Continue — N left`) замінити новими.
- `extension/CHANGELOG.md` під `[Unreleased]`, один рядок для людини: Sync тепер сам доходить до
  кінця, а не зупиняється на «Continue»; нові чекіни підтягуються самі при старті браузера й
  протягом дня, і ✅ з'являється без натискання Sync; бейдж «!» підкаже, коли нових забагато;
  смужка показує, скільки історії вже є.

## Рішення під час реалізації

- `page_rejected`: дія — **Retry**, а «Try again later, or use /import in the bot» — у рядку
  деталей. Кнопка з підписом «Retry later», яка стартує синк одразу, казала б неправду про те,
  що робить.
- `account_changed`: мітка «Untappd account changed», деталь «Sign in as <username>, then Sync»,
  посилання на untappd.com і **Sync** (рядок §6 спеки оновлено). Причина — рев'ю обв'язки, №1 нижче.
- Тест будильника при старті браузера знімає дозвіл на untappd.com перед `onStartup()`: інакше
  справжня тиха перевірка, яку той запускає, переживала тест і перехоплювала старт синку в
  наступному.

## Рев'ю обв'язки

Наскрізне рев'ю (окремий агент, read-only) усіх трьох задач — усі три зроблено інлайн.

| № | Знахідка | Рішення | Що змінено |
|---|---|---|---|
| 1 | `account_changed` ховав кнопку Sync; стан зберігається й після перепривʼязки в боті, тож людина бачила «Another Untappd account is signed in», хоча браузер у правильному акаунті, і без кнопки чекала тихої перевірки | виправлено | мітка «Untappd account changed», деталь «…, then Sync», дія **Sync**; рядок §6 спеки, інструкції uk/en, тести |
| 2 | Після відкату `'!'` лишається до перезапуску браузера | прийнято як є | уже в плані; рядок в описі PR |
| 3 | Відкритий popup не помічає тихої перевірки, що стартувала | відхилено | кожне опитування статусу — запит до сервера (`getCheckinSyncState`); popup відкритий секунди, а натискання Sync під час тихого кроку й так робить його ручним |
| 4 | Тести бейджа залежали від порядку; розгалуження в моку `bootPopup`; `calls.some(...)` замість точного асерта | виправлено | тест будильника знімає дозвіл перед `onStartup()`; мок завжди відповідає; `toHaveBeenCalledWith` |

## Cross-review (codex @ 2efd7d8)

| № | Знахідка | Рішення | Що змінено |
|---|---|---|---|
| 1 | Stop, а за ним Sync до того, як скасований крок завершився: крок читав новий намір і знімав його як свій | виправлено | скасований крок, чий намір замінено, звітує `cancelled` і не чіпає нового; тест |
| 2 | `resume()` не відновлював сторожа: Chrome не обіцяє, що будильники переживуть перезапуск, і друга смерть процесу лишала намір без продовження | виправлено | `resume()` ставить `wbb-sync-watchdog` перед циклом; тест |
| 3 | Процес помер між прийнятою сторінкою й чисткою кешу `/match`; новий крок бачить ті чекіни відомими й кешу не чистить — ✅ застарілий до 8 год | виправлено | `resume()` раз чистить кеш перед циклом (§5а спеки, `spec.md`); тест |

## Після обв'язки

Наскрізне рев'ю обв'язки (окремий агент, read-only) з назвою кожної інлайнової задачі; тоді
`git fetch origin main` + рібейс, повний гейт наново, `npm run cross-review -- --reviewer codex`
у фоні, PR із маркером `Cross-review:`. Сумісність відкату: поля відповіді лише додаються, popup і
воркер їдуть одним пакетом. Стара версія бейджа не знає, тож `'!'`, поставлений новою, після
відкату лишиться до перезапуску браузера (Chrome не зберігає текст бейджа між запусками) —
прийнятно; записати в опис PR.
