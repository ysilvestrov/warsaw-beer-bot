# План 3/4 — WFP: черга, «випито», алерти

> **Спека:** `docs/superpowers/specs/2026-09/2026-09-29-wfp-team-assistant-design.md` (далі **С**),
> доповнена в цьому ж коміті (§4.5, §6.4, §6.5, §9, §10) за висновками нижче.
> **Змерджено:** ядро (#752), очі й бот (#753).
> **Мета плану 3:** команда на фесті веде спільну чергу келихів, бачить, хто вже зачекінив кожне
> пиво, і отримує в групу алерт, коли Target з'являється на крані.
> **План 4** (пишеться після наскрізного рев'ю цього): MCP-клієнт і friend feed, станція друку й PNG,
> документація користувача.
> **Дедлайн:** план 3 змерджено до пт 02.10, план 4 — до вт 06.10, репетиція 10–11.10.
> **Гейт кожної задачі:** `npm test && npm run typecheck`.

## Наскрізне рев'ю плану 2 і проби (перед цим планом) — висновки

1. **Стрічка друзів не містить власних чекінів власника** (жива проба `get_my_friend_feed`
   2026-09-30: три записи — троє друзів). Для плану 4: власник читається окремо
   `get_user_checkins`. Для плану 3: закриття не може покладатися на friend feed як на єдине
   джерело — С §6.4 тепер явно називає обидва.
2. **«HTML-фолбек» закриття в С не був визначений** (С §4.5 посилалася на «нижче», а нижче нічого
   не було). Визначено: авторські рядки `venue_checkins`, без скрейпу профілів — кука спільна з очима.
3. **Target зникає, щойно його хтось випив** (`triedBeerIds` учасника). Черга мусить читати пиво
   через `fest_queue.beer_id` і `menuFor` / `beers`, а не через `view.targets`, інакше позиція
   зникне з черги в момент, коли її закриває перший учасник.
4. **Регістр імен.** `checkins.account_key` зберігає `lower(untappd_username)`, а `untappd_user` у
   `venue_checkins` — як на сайті. Порівняння — лише через `lower()`.
5. **Детектор «дірки» для алертів не потрібен.** Замість «перший тік сесії / тік після дірки»
   (С §6.5 до правки) — правило за часом першого чекіну: не старший за 15 хв → `🆕`, інакше блок
   «вже наливають». Чисте, тестоване, і покриває простій бота, запізніле око й початок сесії
   одним механізмом.
6. **`@modelcontextprotocol/sdk` 1.30.0 уже в залежностях кореня** (`package.json`), тож план 4 не
   торкається lock-файлу. Форма відповіді `get_my_friend_feed` зафіксована в С §4.5.
7. **Деталі секції відповідають без клавіатури** (`fest:s:` у `src/bot/commands/fest.ts`). Кнопки
   «Взяв» додаються туди; простір callback-ів — `fest:q:<team>:<beerId>` (≤ 64 байти).
8. **Крон алертів не повинен залежати від `untappdHttp`**: наявний крон фесту реєструється лише з
   куковим клієнтом, а око ноута може бути єдиним джерелом.

---

## Задача 1 — черга й закриття (сховище + чисте ядро)

**Файли:**
- `src/storage/fest_queue.ts`:
  - `takeBeer(db, { teamId, beerId, addedBy, at }) → { id, glassNo }` — одна
    `.immediate()`-транзакція: `glass_no = COALESCE(MAX(glass_no), 0) + 1` для команди, рядок у
    `fest_queue`, рядок `fest_print_jobs (status 'queued', attempts 0, updated_at = at)`;
  - `queueFor(db, teamId) → QueueRow[]` (`id, glass_no, beer_id, added_by, added_at`), за `glass_no`;
  - `memberBeerCheckins(db, { members: { telegramId, untappdUsername }[], beerIds, sinceIso })
    → MemberCheckin[]` (`telegramId, beerId, checkinId, checkinAt`): з `checkins` учасника
    (активний власник історії, як `checkinsForUser`) і з `venue_checkins` через
    `lower(untappd_user) = lower(username)` та `beers.untappd_id = venue_checkins.bid`.
- `src/domain/fest/closure.ts` (чисте):
  - `CLOSE_SLACK_MS = 10 * 60 * 1000`;
  - `closeQueue(items: { id, beerId, addedAt }[], memberIds: number[], checkins: MemberCheckin[])
    → Map<queueId, Map<telegramId, string | null>>` — `checkinId` найранішого чекіну з
    `beerId = item.beerId` і `checkinAt ≥ addedAt − 10 хв`, або `null` («⏳»).
- `src/jobs/fest-queue-view.ts`: `buildQueueView(db, { festId, teamId }) → QueueView` —
  рядки черги з назвою/броварнею/bid (з `beers`), секцією (з `fest_menu`, перша), ініціалами того,
  хто взяв, і мапою закриття по учасниках.

**Тести:**
- `takeBeer` двічі → №1, №2; друга команда того ж фесту починає з №1; рядок print job `queued`;
- закриття: чекін рівно за 10 хв до `added_at` закриває, за 10 хв 1 с — ні; чекін іншого пива — ні;
  два чекіни → найраніший `checkin_id`; учасник без чекіну → `null`;
- `memberBeerCheckins`: рядок локації з автором `JohnDoe` закриває для `johndoe`; рядок без автора
  не закриває нікого; чекін іншого власника історії (`account_key`) не рахується;
- `buildQueueView`: після того як учасник випив пиво (воно вже не Target), позиція лишається в черзі
  з `✅` для нього.

## Задача 2 — бот: «Взяв», `/fest take`, `/fest queue`

**Файли:** `src/bot/commands/fest.ts`, `src/bot/commands/fest-format.ts`, i18n (uk/pl/en).
- Деталі секції (`fest:s:`) отримують клавіатуру: кнопка `🍺 <назва>` на кожен Target секції,
  щонайбільше 20 (`TAKE_BUTTONS`), callback `fest:q:<team>:<beerId>`.
- `fest:q:` — член команди (інакше `fest.not_member`), пиво є в меню фесту команди →
  `takeBeer` → відповідь у чат, де натиснули: `🍺 Келих №7 — <пиво> · <ініціали>`.
- `/fest take <запит>` — `searchMenu` (як `/fest add`), кнопки `fest:q:` на знайдене; без запиту —
  підказка. Додається в `SUBS` і в `pickCallback`.
- `/fest queue` — `formatQueue(t, view)`: рядок на позицію
  `№7 <пиво> (<секція>) · взяв Ю.С. · ✅ Ю.С. ⏳ О.Б.`; спершу незакриті всіма, далі закриті;
  `fitMessage`. URL-кнопки на сторінку пива в Untappd (`buildBeerPageUrl(bid)`) для перших 20
  незакритих.

**Тести:** `formatQueue` — порядок (незакриті першими), ✅/⏳ по учасниках, позиція без bid без
кнопки; `fest:q:` не-учасником не створює рядка; `pickCallback(…, 'take', …)` вміщається в 64 байти.

## Задача 3 — алерти в групу

**Файли:**
- `src/domain/fest/alerts.ts` (чисте):
  - `ALERT_FRESH_MS = 15 * 60 * 1000`;
  - `planAlerts({ onTap: { beerId, firstAt, firstCheckinId }[], sent: Set<beerId>, now })
    → { fresh: AlertItem[], pouring: AlertItem[] }` — лише ще не надіслані; `fresh`, якщо
    `now − firstAt ≤ ALERT_FRESH_MS`.
- `src/storage/venue_checkins.ts`: `firstCheckinSince(db, venueIds, bid, sinceIso)` → найраніший
  (`checkin_id`, `checkin_at`).
- `src/storage/fest_alerts.ts`: `sentFor(db, teamId, sessionNo) → Set<beerId>`,
  `recordSent(db, rows)` (`INSERT OR IGNORE`).
- `src/bot/commands/fest-format.ts`: `formatAlert(t, view, plan)` — `🆕 <пиво> — <броварня> ·
  <секція/стенд> · перший чекін HH:MM`, далі блок «вже наливають:» тими ж рядками.
- `src/jobs/fest-alerts.ts`: `runFestAlerts({ db, send(chatId, html) }, now)` — для кожного
  `activeFests(now)`: сесія `pollingSessionAt`; для кожної команди — `buildFestView`, Target-и зі
  статусом `on_tap` → `firstCheckinSince(start_at сесії)` → `planAlerts` → одне повідомлення →
  **після** успішного `send` — `recordSent`.
- `src/index.ts`: окремий крон `* * * * *` з in-flight guard, **незалежно від `untappdHttp`**;
  `send` = `bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' })`.

**Тести:**
- `planAlerts`: 15:00 рівно — свіжий, 15:01 — «вже наливають»; надісланий не повторюється;
- джоба: перший тік → одне повідомлення, рядки записано; другий тік тієї ж сесії → нічого;
  наступна сесія → знову алерт; `send` кидає → рядків немає, наступний тік шле знову;
  Target, який учасник уже випив, → алерту немає.

---

## Після плану

Наскрізне рев'ю плану 3 → план 4 (MCP + friend feed, друк, документація) → PR.
