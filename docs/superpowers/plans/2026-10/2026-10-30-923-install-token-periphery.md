# План (обв'язка): enrich з перевіркою, дайджест, прибирання, клієнт і документи (#923)

Спека: `docs/superpowers/specs/2026-10/2026-10-30-923-install-token-design.md` (затверджено 30.10).
Ядро: план `2026-10-30-923-install-token-core.md`, змерджено PR #930 (`0a28cbdb`). Цей план
спирається на те, що ядро **вже є** в `main`: `Principal`, `resolveBearer`, `extension_installs`,
`install_usage_daily` (колонки `enrich_*` створені, але не пишуться), `recordInstallUsage`,
`touchInstall`, `INSTALL_TOKEN_PREFIX`.

Гейт: `npm test && npm run typecheck` у корені **і** `npm test && npm run typecheck` в
`extension/` для задач 5–6. Тести — лише через `npm test -- <args>`. `spec.md` правиться в тій
задачі, що вводить поведінку.

**Два PR, не один.** Сервер (задачі 1–4) виходить першим і сам по собі нічого не відкриває для
старих клієнтів. Клієнт і документи (задачі 5–6) — другий PR; його мердж ≠ реліз розширення, але
реліз без правила WAF (§Розкатка спеки) не виходить. Так рев'ю серверної перевірки не тоне в
диффі розширення, а політика приватності змінюється в тому ж PR, що й клієнт, який почне слати
дані.

## Поправки при плануванні (вносяться в спеку в задачі 3)

Знайдено при читанні коду, якого спека не описувала:

1. **Веб-фолбек (Brave) установці не вмикається.** `/enrich/result` сьогодні проганяє
   `lookupWithFallback(…, deps.webFallback)`: на 0 кандидатів сервер платно питає Brave
   (`WEB_SEARCH_DAILY_CAP`). Для установки це означало б, що будь-хто без Telegram витрачає нашу
   денну квоту фолбеку — ціль «гроші» з `docs/issue-severity.md`. Шлях установки викликає
   `lookupBeer` напряму, без фолбеку. Втрата: картку, яку знайшов би лише Brave, установка не
   знайде; її й далі знайде крон.
2. **Гідрація — один раз на запит.** `lookupBeer` кличе `search()` у кількох місцях
   (`src/domain/untappd-lookup.ts`: пошук на щаблях і повторні запити звуженої назви); адаптер установки гідратує список `bid` один раз і віддає ту саму
   відповідь на кожен виклик. Інакше один `/enrich/result` коштував би кілька `getObjects`.
3. **Брейкер читається, а не ведеться.** Спека каже «гейти брейкера діють»; у `/enrich/result`
   сьогодні жодного гейта нема, бо сервер Algolia там не кличе. Шлях установки перевіряє
   `isCircuitOpen(db, 'untappd_circuit_open_until', now)` (read-only, `src/domain/untappd-circuit.ts`)
   і `env.UNTAPPD_LOOKUP_ENABLED`; блок гідрації брейкер **не** відкриває — його веде крон зі своєю
   канаркою, а один збій чужого запиту не є доказом бану.
4. **Що рахує ліміт 200.** `enrich_results` = прийняті до перевірки `/enrich/result` установки
   (після валідації тіла, до гідрації); `enrich_links` = відповіді `matched`; `enrich_rejected` =
   відмови `429`. Ліміт — сума `enrich_results` установки за варшавську добу по всіх `shop`.
   `shop` для enrich = hostname `pageUrl`, `''` без нього.
5. **«Нові установки» — лічильник реєстрацій, не `created_at`.** `created_at` — ISO UTC, і рахувати
   за ним варшавську добу означало б різати час біля півночі (та сама пастка, що з
   `match_misses`). `install_registrations_daily.registrations` за вчора — той самий факт, уже за
   варшавською датою; він включає й установки, видалені того ж дня, і це правильно для «нових».

## Задача 1 — паритет `alias_alt` у гідратованому записі

`src/sources/untappd/algolia.ts`, `parseHydratedBeer`: додати `alias_alt: strList(h.alias_alt)`.
`HydratedBeer` (`search.ts`) лишається як є — поле вже є в `SearchResult`. Адитивно:
`hydrate-ratings` і `resolveByBid` його не читають.

Тест (`algolia.test.ts`): **один** сирий Algolia-об'єкт (фікстура з непорожніми `alias_alt` і
`brewery_alias`, рядковим `beer_abv`, `rating_count`) через `parseAlgoliaResponse({hits:[raw]})[0]`
і через `parseHydratedBeer(raw)` дає рівні значення для `bid`, `beer_name`, `brewery_name`,
`style`, `abv`, `global_rating`, `brewery_alias`, `alias_alt`, `rating_count` — асерт проти
**виписаного** очікуваного об'єкта, не одного парсера проти другого (CLAUDE.md, (в)).

Дрібна (повний код, 1 файл + тест) — інлайн.

## Задача 2 — `/enrich/*` пускає установку; `/enrich/candidates` для неї лише читає

**Доступ.** `authMiddleware(db, { allowInstall?: boolean })`: з `allowInstall` установка
проходить з `principal` установки й без `telegramId`. `src/api/index.ts`: `/enrich/*` →
`authMiddleware(deps.db, { allowInstall: true })`. `/checkins/*`, `/fest/*`, `/mcp` — без змін
(`403`). Тест в `index.test.ts` з ядра (`it.each` 403) втрачає `/enrich/candidates` і
`/enrich/result`; натомість окремий тест: `wbi_` на `/enrich/candidates` → `200`.

**Розщеплення `ensureBeerRow`** (`src/api/routes/enrich.ts`):

- `findBeerRow(db, brewery, name, facts) → (BeerRow & { viaAlias }) | null` — той самий ланцюжок
  (аліас → пара нормалізованих назв з фільтром диспозицій/ABV/стилю → `pickRowByDigits`), **без
  жодного запису**.
- `ensureBeerRow` = `findBeerRow` → якщо знайдено: `fillOrphanFacts` + `rearmLookup` як зараз;
  інакше `ensureOrphan`. Поведінка Telegram-шляху побайтово та сама — наявні 91 тест
  `enrich.test.ts` мусять пройти без змін.

**`/enrich/candidates` для `principal.kind === 'install'`:** `findBeerRow` замість `ensureBeerRow`;
`bid` картки відкидається до будь-якого читання (`contradicts = false`). Рядка нема →
`eligible: true` (без `linked`). Рядок є → та сама формула придатності (бекоф, `not_a_beer`,
`RECURRING_CLASSES`), лише без гілки «суперечливий bid». Картка з активною диспозицією → як зараз.

Тести (`enrich.test.ts`, новий `describe` «install»):
- 200 вигаданих карток → `beers` не змінилася ні кількістю рядків, ні вмістом (знімок
  `SELECT * FROM beers ORDER BY id` до й після), `enrich_failures` порожня;
- наявна сирота з `abv IS NULL`, картка з `abv` → `abv` сироти лишився `NULL`, бекоф не скинуто
  (`rearmLookup` не викликано);
- картка без рядка → `{eligible: true}` без `linked`; злінкований рядок → `linked: true`;
- `bid`, що суперечить збереженому лінку, → для установки `eligible: false` (`linked: true`), для
  Telegram-токена — `eligible: true` (регресія #384);
- Telegram-токен на тій самій вигаданій картці створює сироту (регресія).

`spec.md` §4 `/enrich/candidates`: абзац «для установки — лише читання».

## Задача 3 — `/enrich/result` для установки: перевірка, лише позитивний запис, ліміт

Гілка `principal.kind === 'install'` на початку хендлера (Telegram-шлях не чіпається):

1. `html` у тілі → `400 {error: 'algolia_required'}`. `bid`/`bidSlug`/`brand` відкидаються.
2. Активна диспозиція картки → `{status:'not_found'}` (як зараз, без запису).
3. **Ліміт:** `installEnrichToday(db, installId, date)` (сума `enrich_results`) ≥ 200 →
   `recordInstallUsage(… enrichRejected: 1)` і `429 {error:'enrich_limit'}`. Інакше
   `recordInstallUsage(… enrichResults: 1)` — **до** гідрації, щоб збій гідрації теж рахувався.
4. `row = findBeerRow(...)`; `row?.untappd_id != null` → `{status:'matched', untappd_id, rating_global}`
   (те саме, що Telegram-шлях на злінкованому рядку; запису нема).
5. `!env.UNTAPPD_LOOKUP_ENABLED || isCircuitOpen(...) || !deps.hydrateByBid` → `{status:'not_found'}`.
6. `bids = parseAlgoliaResponse(algolia).map(h => h.bid).slice(0, ALGOLIA_HITS_PER_PAGE)`;
   адаптер `verifiedSearch(bids, deps.hydrateByBid)` — гідратує один раз (мемо-проміс), повертає
   записи в порядку `bids`, без `null`/відсутніх.
7. `outcome = await lookupBeer({ brewery, name, abv: row?.abv ?? sanitizeAbv(abv), style: row?.style ?? style ?? null, search })`
   у `try`; виняток (збій гідрації) → `{status:'not_found'}`. **Без** `lookupWithFallback`.
8. `outcome.kind !== 'matched'` → `{status:'not_found'}`, **жодного** запису.
9. `matched` → в одній транзакції `ensureBeerRow(...)` (тепер створює сироту, якщо треба) і
   `applyLookupOutcome(..., outcome, nowIso, { brewery, name, abv: rowAbv, sourceUrl: pageUrl })`;
   `withRelayQuery` — як у Telegram-шляху. `matched`/`merged` → `recordInstallUsage(… enrichLinks: 1)`
   і `{status:'matched', untappd_id, rating_global}`; `skipped` → `not_found`.

Облік (`recordInstallUsage`, `src/storage/install_usage.ts`) отримує `enrichResults?`,
`enrichLinks?`, `enrichRejected?` — ті самі UPSERT-інкременти з `busy_timeout = 0`; збій обліку —
`log.warn`, відповідь не ламає (крім кроку 3: якщо лічильник не прочитався, — `503`, бо без нього
ліміт не діє). `installEnrichToday` — новий читач у тому ж файлі.

Тести (`enrich.test.ts`, `describe` «install /enrich/result»; `hydrateByBid` — фейк із мапою):
- `html` → `400`;
- **підробка:** релей має хіт із `bid` 46157 і назвою, переписаною під картку; гідрація повертає
  справжній запис (інша назва) → `not_found`, `beers` без змін;
- чесний хіт → `matched`, сирота створена й злінкована (`untappd_id_source = 'search'`), рядок у
  `install_usage_daily` з `enrich_results = 1, enrich_links = 1`;
- `not_found` → знімок `beers` і `enrich_failures` не змінився, `untappd_lookup_at/count` наявної
  сироти не зсунулись;
- гідрація кидає → `not_found`, без записів; `hydrateByBid` викликано **рівно раз** на запит;
- брейкер відкритий (`job_state`) → `not_found`, `hydrateByBid` не викликано;
- `webFallback`-фейк передано в deps → для установки не викликано жодного разу;
- shop-published `bid` іншого пива тієї ж броварні + `brand` → ігнорується, лінк не змінено;
- 200 запитів → 201-й `429`, `enrich_rejected = 1`; наступного варшавського дня — знову `200`;
- Telegram-токен: релей приймається без гідрації, як досі (регресія).

`spec.md` §4 `/enrich/result`: гілка установки; спека #923 §2.5–2.6: поправки 1–5 вище
(розділ «Поправки при плануванні периферії»).

## Задача 4 — дайджест і прибирання

**Метрики** (`src/storage/stats.ts`, `StatusMetrics` + `NUMBER_KEYS` у `status_snapshots.ts`):
`installsActive` (distinct `install_id` у `install_usage_daily` за вчора), `installMisses`,
`installEnrichLinks` (суми колонок за вчора), `installRegistrations`,
`installRegistrationsRejected` (з `install_registrations_daily`), `installsEnrichCapped`
(distinct `install_id` з `enrich_rejected > 0`). «Вчора» — `previousDate(warsawDateAndHour(now).date)`,
як для `extMatch*`. «Нові» в рядку — це `installRegistrations` (поправка 5).

**Рядки** (`buildUserLines`, `src/jobs/daily-status.ts`), після рядка `розширення /match`:

```
установки (вчора): <активні> активних · <нові> нових · <промахи> промахів · <лінки> лінків з enrich
ліміти установок (вчора): <реєстр.>/2000 реєстрацій · <відмов> відмов · enrich: <n> установок уперлись у 200
```

Регістр — як у сусідніх рядків (з малої; спека писала з великої до перевірки коду). Перший — коли
`installsActive > 0`; другий — коли `installRegistrations + installRegistrationsRejected +
installsEnrichCapped > 0`.

**Прибирання** — у `buildDailyReport` поруч із `pruneHandlerFailures`, той самий `try/catch`:
`pruneInstallLedger(db, { usageBefore, missesBefore, installsBefore })` у новому
`src/storage/install_prune.ts`: `install_usage_daily.date < D-90`, `install_registrations_daily.date
< D-90`, `match_misses.last_seen_date < D-90`, `extension_installs.last_seen_date < D-180` (каскад
прибирає їхній облік). Повертає кількості — у лог.

Тести: обидва рядки з точними числами на засіяних даних; без активності — жодного; 3 відмови
однієї установки → `<n> = 1`; межа 90 днів (рядок на D-90 лишається, на D-91 зникає) і 180 для
установок; прибирання установки прибирає її `install_usage_daily`, але не `match_misses`.
`spec.md` §3.16.1–3.16.4 (терміни зберігання) і розділ дайджесту.

**PR 1** — задачі 1–4: рібейс, гейт, cross-review, PR.

## Задача 5 — клієнт

`extension/src/shared/config.ts`: `Settings` + `installToken: string` (`''`),
`installRegistration: boolean` (дефолт `true` — читається як `s.installRegistration !== false`),
`installDeletionPending: boolean`. Хелпер `authToken(s) = s.token || (s.installDeletionPending ? '' : s.installToken)`.

`extension/src/api/client.ts`: `postInstall(baseUrl, version) → token`, `deleteInstall(baseUrl,
token) → 'deleted' | 'retry'` (`204`/`401` → `deleted`, мережа/`5xx` → `retry`); `postMatch`
отримує `client: { version, shop }` у тілі.

`extension/src/background/index.ts`:
- `ensureInstall()` на `chrome.runtime.onInstalled`, `onStartup` і на першому повідомленні після
  пробудження SW (один проміс на життя SW): спершу довести висяче видалення
  (`installDeletionPending` → `deleteInstall`), потім — якщо `installRegistration && !token &&
  !installToken` — `postInstall`. Будь-яка невдача тиха.
- `handleMatch`, `handleEnrich*`: заголовок з `authToken(settings)`; `401` при запиті з
  `installToken` (а не з `token`) → стерти `installToken`, повторити **той самий** запит анонімно
  (для `/match`; enrich — повернути порожньо), перереєстрація — при наступному `ensureInstall`.
- Enrich-гейт: `!enrichEnabled || !authToken(settings)`.
- `currentCacheBinding` **не** міняється: відповідь установці побайтово анонімна (тест ядра), тож
  кеш бейджів лишається прив'язаним лише до Telegram-токена.

`extension/src/options/*`: секція «Anonymous usage statistics» з галочкою `installRegistration` і
текстом про те, що рахується (за §4 спеки), включно з межею: з Telegram-токеном промахи пишуться
незалежно від галочки. Зняття: `installDeletionPending = true` → `deleteInstall` → `deleted` —
стерти токен і прапорець; `retry` — показати «Deletion not finished yet — will retry». Повторне
ставлення: дочекатися видалення, потім `ensureInstall`.

`extension/src/popup/token-state.ts`: `tokenStateView(hasToken, hasInstall)`; для установки
підпис стану «Works without Telegram», `Get a token` — `btn-secondary`, синхронізація чекінів і далі
вимкнена (чекіни лише з Telegram-токеном).

Тести (`config.test.ts`, `client.test.ts`, `handle-match.test.ts`, `handle-enrich.test.ts`,
`options.test.ts`, `token-state.test.ts`): реєстрація лише за `installRegistration && !token &&
!installToken`; `token` має пріоритет; `401` з `installToken` стирає його й відповідає анонімно;
`401` з Telegram-токеном — як досі (`unauthorized`); зняття галочки → `DELETE`, мережева помилка
→ токен лишається, запити йдуть без нього, повтор на старті; `401` на `DELETE` → стерто;
enrich-гейт пускає з `installToken`; `/match` шле `client.shop = location.hostname` вкладки.

## Задача 6 — документи

- `site/privacy/index.html`: розділ про анонімну статистику (псевдонімний ідентифікатор
  установки, що рахується, 90 днів, вимикач і видалення, IP не зберігається); рядок «no tracking of
  your browsing» лишається.
- `docs/cws-data-usage.md`: «User activity — NO» з поясненням власника; «Website content — YES»
  покриває назви пив і домен.
- `docs/extension-install-uk.md`: режим без Telegram, галочка статистики, як видалити.
- `extension/CHANGELOG.md`: користувацький рядок (enrich без Telegram, вимикач статистики).
- `spec.md` §6 (клієнт розширення): поля налаштувань, реєстрація, пріоритет токенів, видалення.

**PR 2** — задачі 5–6. Опис перелічує крок для людини перед релізом розширення: правило WAF на
`POST /installs` і перевірка `429` серією з однієї адреси.

## Після обох PR

«Фактично» в оцінці спеки; #929 (перегляд лімітів через ~30 днів після релізу розширення).
