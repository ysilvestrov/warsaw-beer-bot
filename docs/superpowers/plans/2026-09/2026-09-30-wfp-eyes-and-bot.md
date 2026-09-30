# План 2/3 — WFP: очі й бот

> **Спека:** `docs/superpowers/specs/2026-09/2026-09-29-wfp-team-assistant-design.md` (далі **С**).
> **Ядро (план 1)** змерджено в `main` (#752): міграція 42, `parseCheckinFeedPage` з `author`/`venue_id`/
> `data-gregtime`, `parseVenueMenu` з `venueId`, `ingestFeedPage` / `applyMenu`, `POST /fest/feed`,
> `POST /fest/menu`, `computeTargets`, `tapStatus`, `rankSections`.
> **Мета плану 2:** після нього бот корисний на фесті без черги й друку: команда створюється в групі,
> меню й чекіни збираються з трьох джерел, `/fest` показує, куди йти.
> **Дедлайн:** змерджено до вт 06.10. План 3 (черга, «випито», алерти, друк, MCP) — після рев'ю цього.
> **Гейт кожної задачі:** `npm test && npm run typecheck`.

## Наскрізне рев'ю ядра (перед цим планом) — висновки

1. **Сервер не може дочитувати сторінки.** `createHttp.get(url)` не приймає заголовків, а
   `more_feed` без `X-Requested-With` віддає редирект. Це збігається з С §4.4: сервер бере лише
   сторінку 1. Пагінація — лише на ноуті.
2. **Скрипту ноута потрібен список локацій і вікон.** Хардкод розійдеться з БД, тому додаємо
   `GET /fest/config`.
3. **Повнота історії учасника.** С §7 обіцяє рядок «N чекінів у боті vs профіль». Джерело для
   «профілю» — `checkin_sync_state.profile_total`; воно є лише в тих, хто синкав розширенням. Де його
   немає, рядок пише «невідомо», а не нуль (С §10, «ніхто не пив»).
4. **Час у БД** — ISO з `toISOString()`, тож порівняння рядками в SQL коректні. Нові модулі мусять
   писати час тільки так.

---

## Задача 1 — модель читання `/fest`

**Файл:** `src/jobs/fest-view.ts` — єдине місце, де БД зустрічається з чистими функціями ядра.

`buildFestView(db, { festId, teamId, now }) → FestView`:
- `menu` — `menuFor` + `menuStats` (кількість, `lastSeenAt`);
- `members` — `members(teamId)`; для кожного `tried = triedBeerIds(db, telegram_id)` і повнота
  `{ inBot: countCheckins, profileTotal: checkin_sync_state.profile_total | null }`;
- `targets`, `unrated` — `computeTargets` з критеріями фесту й `overridesFor(teamId)`;
- `statusByBeer` — для кожного Target: `tapStatus` з `checkinsSince(venues, now − 60 хв)` і
  `coverageSince(venue, now − 60 хв)` по кожній локації. **bid, а не `beer_id`**: `venue_checkins`
  тримає Untappd bid, меню — `beers.id`; зіставлення через `beers.untappd_id` із `menuFor`;
- `ranking` — `rankSections`;
- `stands` — `fest_stands` за секцією.

**Тести** (БД у пам'яті, реальні модулі сховища):
- два учасники, один пив пиво A → A не Target; B з рейтингом 4.1 → Target;
- чекін B на стадіоні 10 хв тому + повне покриття трьох локацій → B `on_tap`, секція B перша;
- покриття лише двох локацій → Target без чекіну `unknown`;
- `profileTotal` відсутній → `null`, не `0`;
- пиво в меню без `untappd_id` (не може статися через `applyMenu`, але БД не забороняє) → не
  падає, статус `unknown`.

## Задача 2 — серверні джоби: сторінка 1 і меню

**Файли:**
- `src/domain/fest/schedule.ts` (чисте): `dueServerPoll(now, lastAt)` — раз на 10 хв у вікні
  опитування; `dueMenuRefresh(now, sessions, lastAt)` — раз на 6 год до першої сесії, у дні фесту за
  30 хв до сесії й раз на 2 год під час неї.
- `src/jobs/fest-poll.ts`: для активного фесту — `GET <feed_path>` фестивальної локації через
  наявний куковий `untappdHttp` → `ingestFeedPage(eye: 'server')`. Власний breaker
  `job_state.fest_poll_open_until`: 2 блоки поспіль відкривають його на 30 хв (С §4.4). Кука спільна
  з нічним `refreshAllUntappd`, тож рідкий каденс і breaker обов'язкові.
  `CookieExpiredError` → алерт адміну, breaker не чіпається.
- `src/jobs/fest-menu.ts`: головна сторінка локації меню → `parseVenueMenu` → звірка
  `venueId === menu_venue_id` → `applyMenu`. Спільний breaker із поллером.
- `src/index.ts`: один крон `* * * * *`, який викликає обидві джоби (вони самі вирішують, чи настав
  їхній тік; стан — `job_state.fest_poll_last_at`, `fest_menu_last_at`). Реєструється, лише коли є
  `untappdHttp`.

**Тести:** межі `dueServerPoll` (9:59 → ні, 10:00 → так, поза вікном → ні); `dueMenuRefresh` для
«за 6 днів», «за 31 хв до сесії», «посеред сесії через 2 год»; джоба з фейковим `Http`: блок → лічильник,
другий блок → breaker відкрито рівно на 30 хв; успіх скидає лічильник; `CookieExpiredError` → алерт.

## Задача 3 — око ноута

**Файли:**
- `GET /fest/config` (у `src/api/routes/fest.ts`): для учасника — поточний або наступний фест:
  `{ slug, sessions, pollMarginMs, venues: [{ venueId, feedPath }], menuVenuePath }`.
- `scripts/fest-eye.ts` + `playwright-core` у devDependencies. Запуск:
  `FEST_API=https://beer-api.ysilvestrov-ai.uk FEST_TOKEN=… npx tsx scripts/fest-eye.ts --profile <dir>`.
  Цикл:
  - `/fest/config` раз на годину;
  - у вікні опитування: локація фестивалю раз на 3 хв, дві інші раз на 6 хв;
  - `page.goto(feedPath)` → `page.content()` → `POST /fest/feed`;
  - якщо `stitched=false` — `page.evaluate(fetch(more_feed …, { headers: X-Requested-With }))` у
    контексті сторінки (сесія браузера) → `POST /fest/feed` з `cursor`, ≤ 3 сторінки за тік; на першому
    тіку сесії — до `start_at − 60 хв`, ≤ 5 сторінок;
  - меню — раз на 2 год → `POST /fest/menu`;
  - тайм-аут або помилка → лог і наступний тік; `502 blocked` → пауза 10 хв і звуковий сигнал.
- `scripts/fest-eye-schedule.ts` (чисте) — що робити на цьому тіку; тести на нього. Сам Playwright
  не тестується юніт-тестами — його перевіряє репетиція 10–11.10.

**Тести:** `/fest/config` для учасника / не-учасника / після фесту; розклад ока (межі 3/6 хв,
вікно, перший тік сесії).

## Задача 4 — бот: команда фесту й рейтинг

**Файли:** `src/bot/commands/fest.ts` (тонкий), `src/bot/commands/fest-format.ts` (чисте),
ключі i18n у `src/i18n/types.ts` і `locales/{uk,pl,en}.ts`.
- `/fest` у групі без команди → створює команду для `chat_id` і показує кнопку **«Я в команді»**.
- «Я в команді» → `addMember`; ініціали — з `first_name`/`last_name` Telegram. Без прив'язаного
  Untappd → відповідь «спершу /link» (у групі згадкою).
- `/fest` (у групі з командою або в DM учасника однієї команди) → рейтинг:
  `🍺 3 · ❔ 1 · PINTA · пов. 2 B14` + рядок «меню: N позицій, оновлено HH:MM». Кнопка на кожну секцію.
- Деталі секції (callback `fest:s:<hash>`) → Target-и зі статусом: `🟢 12 хв тому (4)` / `⚪ не
  бачили за годину` / `❔ невідомо`.
- `/fest` у приватному чаті, коли людина в кількох командах → вибір команди кнопками.

**Тести** (на `fest-format.ts`): точний текст рейтингу для трьох секцій зі всіма трьома статусами;
секція без стенда; порожнє меню → «меню ще не завантажене», а не порожній список; callback-дані
вкладаються в 64 байти для довгої назви секції (тому hash, а не назва).

## Задача 5 — бот: Target-и, стенди, меню; документація

- `/fest targets` → Target-и з причинами (`⭐ 4.1`, `🧪 стиль`, `✋ вручну`), окремий блок «без
  рейтингу», рядок повноти історії на кожного учасника (`YS: 12 709 / 12 709 ✅`, `OB: 3 201 / ?`).
  Кнопки `➖` на кожному; `/fest add <частина назви>` → збіги в меню → `➕`.
- `/fest stands` → документ CSV `секція;поверх;стенд` (`;`, UTF-8, перший рядок може бути
  заголовком) → `fest_stands`; відповідь — скільки оновлено й які секції меню досі без стенда.
- `/fest menu` → запускає `fest-menu` поза розкладом (з тим самим breaker).
- `spec.md`: розділ «Фестивальний режим — бот і очі»; `docs/USER-GUIDE.md`: розділ «Фестиваль».

**Тести:** парсер CSV (заголовок, порожні рядки, `;` у лапках → помилка рядка, невідома секція
→ приймається й показується як «не в меню»); формат `/fest targets` з неповною історією;
`/fest add` без збігів.

---

## Після плану 2

Наскрізне рев'ю (особливо: чи сервер і ноут справді дають безперервне покриття на фікстурах двох
тіків поспіль), cross-review, PR. Далі — план 3 проти змердженого коду.
