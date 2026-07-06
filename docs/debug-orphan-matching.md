# Ранбук: дебаг орфанів (чому пиво не матчиться)

> Коли пиво показується як orphan (⚪ у розширенні / немає рейтингу) або «не те»
> пиво — цей ранбук веде від симптому до кореня **без** ручного відтворення.
> Працює і для людини, і для агента. Джерело істини по схемі — `spec.md` §3.13.

> **Автоматичний первинний тріаж (з 2026-07):** джоба `orphan-triage` щодня
> класифікує нові orphans (`review_class`/`review_note`) і створює/оновлює
> GitHub-issues з міткою `orphan-triage`. Цей ранбук лишається для глибших
> розслідувань, перевірки вердиктів агента та спірних випадків — але починати
> варто з відкритих `orphan-triage` issues, а не з сирої таблиці.

## TL;DR

```bash
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db \
  "SELECT brewery, name, outcome, candidates_count, candidates_summary, search_url, source_url, fail_count, last_at
   FROM enrich_failures WHERE review_class IS NULL ORDER BY last_at DESC LIMIT 30;"
```

Один рядок на пиво, що провалило енрич. **Рядок є = воно зараз провалюється**
(само-видаляється, коли матчиться). Далі — тріаж по `outcome` + `candidates_count`.
Вже розмічені рядки (`review_class IS NOT NULL`) відфільтровано — вони не потребують уваги.

Read-only запити до прод-БД запускай напряму як оператор (`ysi`): файл БД, WAL і SHM
доступні на читання. `sudo -u warsaw-beer-bot /usr/bin/bash -lc ...` потрібен тільки
для write-операцій (наприклад purge/delete), які мають іти під bot-користувачем.

---

## Крок 0. Підтвердити, що це проблема матчингу, а не транспорту

Якщо користувач бачить **500/502 від API** (не «orphan», а помилку) — це НЕ цей ранбук.
Сходи в `journalctl -u cloudflared` і шукай `use of closed network connection` →
keep-alive 502 (див. memory `reference_cloudflare_502_keepalive`, fix #125), не матчинг.

## Крок 1. Знайти пиво в `enrich_failures`

Звузити по назві/пивоварні:
```bash
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db \
  "SELECT * FROM enrich_failures WHERE name LIKE '%<частина>%' COLLATE NOCASE;"
```

**Рядка немає?** Тоді одне з:
- пиво ще не енричилось (backoff не настав або не було проходу) — перевір
  `beers.untappd_lookup_count`/`untappd_lookup_at`;
- **уже зматчене** (рядок само-видалився) — перевір `beers.untappd_id IS NOT NULL`;
- це orphan із доби до деплою логування (#127) — дочекайся наступного енричу.
```bash
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db \
  "SELECT id, untappd_id, brewery, name, untappd_lookup_count cnt, untappd_lookup_at
   FROM beers WHERE name LIKE '%<частина>%' COLLATE NOCASE;"
```

## Крок 2. Тріаж за `outcome` / `candidates_count`

| Сигнал | Що це означає | Корінь / куди дивитись |
|--------|---------------|------------------------|
| `candidates_count = 0`, `not_found` | пошук Untappd нічого не повернув → **запит зашумлений/надто специфічний** | пивоварня продубльована в `name`, рік, дескриптор, або обидві колаб-пивоварні в запиті. Дивись `search_url`. Класи: #124/#126 (brewery-in-name), #117-Omnipollo (`collab`). Код: `/enrich/candidates` searchUrl, `stripBreweryNoise` |
| `candidates_count = N`, `not_found` | пошук повернув пива, але **gate/fuzzy відсік** | глянь `candidates_summary` (топ-3 `brewery — name`). Підкласи нижче |
| `outcome = blocked` | Untappd трипнув circuit breaker у той момент | **транзитна інфра, не баг матчингу**. Перевір пізніше; не чіпай матчер |

### Підкласи `N, not_found` (дивись `candidates_summary`)
- **Brewery-gate: хвостовий токен** — ярлик магазину є *хвостовим*, а не провідним
  префіксом справжньої пивоварні (`Staropolski` ⋢ `Kultowy Browar Staropolski`).
  Brewery hard-gate ловить лише провідний префікс. Issue #120. Код:
  `matcher.ts breweryAliasesMatch`/`tokenPrefix`, `untappd-lookup.ts` Stage 1.
- **Brewery-gate: відомий alias** — це **та сама пивоварня під іншою назвою/написанням**,
  а НЕ токен-префікс/хвостовий варіант: `Nepomucen` vs `Nepo`, `Van Honsebrouck` vs
  `Kasteel Vanhonsebrouck`, `Starkaft` vs `Starkraft`. Фікс — додати пару в curated-список
  (див. «Як додати brewery-alias» нижче). Issue #202. Код: `matcher.ts`, `brewery-aliases.ts`.
- **Розбіжність назви / порядок / колаб / двомовність** — мали б покриватись
  `nameKeys` (#117): order-insensitive + `COLLAB_SEP`-split + brewery-dedup, потім
  fuzzy ≥ 0.85. Якщо валідний кандидат усе одно відсічений — дивись `nameKeys`/
  `nameTokensDiverge` у `matcher.ts` та Stage 2a/2b у `untappd-lookup.ts`.
- **Не-пиво (пак/сет/мерч/софт-дрінк)** — `name` є набором/паком/мерчем/софт-дрінком
  (`Brewery Pack`, `Сертифікат`, скло `SZKLANKA`, `KOMBUCHA`), якого на Untappd немає. Корінь —
  **адаптер не відфільтрував не-пиво**, а НЕ матчер. Лагодити фільтром адаптера
  (`isNonBeerName` / шоп-локальні токени / `isNonBeerPage`) + додати приклад у `<id>.nonbeer.html`.
  Наявні рядки видаляються разовим purge — див. нижче.

### `source_url` — сторінка магазину (тільки client-relay)

`source_url` заповнюється лише коли провал прийшов через `/enrich/result`
(розширення ретранслює пошук Untappd із browser-session'у користувача).
Серверний крон пише `''` — при його провалах URL сторінки магазину невідомий.

Коли `source_url != ''`, можна **відкрити сторінку магазину** і перевірити,
чи правильно адаптер розпарсив пивоварню та назву. Це вирішує ключову дихотомію:
- **Parser-баг** — адаптер прочитав назву/пивоварню криво; діагностується тільки
  з реальною сторінкою магазину. Лагодити в `extension/src/sites/<shop>.ts`.
- **Matcher-баг** — парсинг правильний, але brewery-gate або name-fuzzy відсік
  валідного кандидата; діагностується з `brewery`/`name`/`candidates_summary`
  без потреби у `source_url`. Лагодити в `src/domain/matcher.ts` / `untappd-lookup.ts`.

```sql
SELECT beer_id, brewery, name, source_url, candidates_count
FROM enrich_failures
WHERE outcome = 'not_found' AND source_url != ''
ORDER BY fail_count DESC;
```

## Крок 3. Відтворити (пошук Untappd публічний, без кукі)

Відкрий `search_url` у браузері **або** `curl`-ом — сторінка регенерується (сервер теж
її тягне; «блокування» інтермітентне/rate-based). `parseSearchPage` парсить саме її.
```bash
curl -sL -A "Mozilla/5.0" "<search_url>" -o /tmp/s.html
grep -c 'class="beer-item' /tmp/s.html      # скільки результатів (увага: трейлінг-пробіл у класі)
```
Локальний прогін матчера на цій HTML (даунлоад → `lookupBeer` з `fetch=()=>html`):
склади міні-`tsx`-скрипт як у `tmp/`-аналізах #117/#124 (parseSearchPage + lookupBeer),
щоб побачити gate-рішення на реальних кандидатах.

## Крок 4. Класифікувати корінь і де лагодити

| Шар | Симптом | Файл(и) |
|-----|---------|---------|
| **Адаптер (parse)** | пивоварня/назва спарсились криво (`Kykao` замість `Kykao - Handcrafted`) | `extension/src/sites/<shop>.ts` |
| **Побудова запиту** | `candidates_count = 0` через сміття в запиті | `src/api/routes/enrich.ts` (searchUrl), `src/domain/normalize.ts` (`stripBreweryNoise`) |
| **Матчер (name)** | є кандидати, але name відсічено | `src/domain/matcher.ts` (`nameKeys`, fuzzy), `src/domain/untappd-lookup.ts` Stage 2a/2b |
| **Brewery gate (хвостовий токен)** | brewery відсічено, ярлик — хвостовий, не провідний префікс | `src/domain/matcher.ts` (`breweryAliasesMatch`) — issue #120 |
| **Brewery gate (відомий alias)** | brewery відсічено, та сама пивоварня під іншою назвою/написанням | `src/domain/brewery-aliases.ts` (curated пари) — issue #202 |

Будь-яка зміна логіки матчингу йде повним циклом: brainstorming → spec → plan →
worktree, і звіряється зі `spec.md` (інваріанти §5.2).

## Як додати brewery-alias (#202)

Коли тріаж показав **Brewery-gate: відомий alias** (та сама пивоварня під іншою
назвою/написанням, не хвостовий токен) — фікс це один рядок даних, а не зміна логіки матчера:

1. Дістань нормалізовану пару з двох сирих ярликів (магазин + Untappd):
   ```bash
   npm run -s alias-key -- "<ярлик магазину>" "<ярлик Untappd>"
   # напр.:  npm run -s alias-key -- "Nepomucen Brewery" "Nepo Brewing"
   # друкує готовий до вставки рядок:  ['nepomucen', 'nepo'],
   ```
2. Встав пару в масив `ALIAS_PAIRS` у `src/domain/brewery-aliases.ts`.
3. Додай позитивний тест-приклад у `src/domain/matcher.test.ts`
   (блок `curated brewery-alias gate (#202)`).
4. Прогони `npx vitest run src/domain/matcher.test.ts src/domain/brewery-aliases.test.ts`
   і відкрий PR. Рядок `enrich_failures` познач `matcher_bug` як звичайно — він
   само-видалиться після наступного успішного енричу.

> Список **скінченний і явний**: жодного загального/fuzzy-матчингу пивоварень.
> Додавай тільки підтверджені тріажем пари, по одній перевіреній парі. Пари
> **симетричні й нетранзитивні** — спільний партнер не робить два інші форми
> еквівалентними (`van honsebrouck` і `bacchus` обидва під `kasteel vanhonsebrouck`,
> але між собою не матчаться).

## Крок 5. Розмітка тріажу (admin API)

Після того як знайшов корінь і або створив issue/PR, або вирішив нічого не робити —
позначити рядок, щоб він не спливав у наступному скані.

**Запит тріажу (лише не розмічені):**
```sql
SELECT beer_id, brewery, name, source_url, candidates_count, fail_count
FROM enrich_failures
WHERE review_class IS NULL
ORDER BY fail_count DESC;
```

**Класи розмітки:**

| `review_class` | Що означає | Де лагодити |
|----------------|------------|-------------|
| `parser_bug` | адаптер неправильно прочитав сторінку магазину (пивоварня або назва спотворені) | `extension/src/sites/<shop>.ts` |
| `matcher_bug` | парсинг правильний, але brewery-gate або name-fuzzy відсік валідного кандидата | `src/domain/matcher.ts` / `untappd-lookup.ts` |
| `not_on_untappd` | пиво справді відсутнє на Untappd (перевірено вручну) | — (норма) |
| `wontfix` | залишаємо без матчингу навмисно | — |

**Як позначити рядок:**

Потрібен `ADMIN_API_TOKEN` (змінна оточення на хості; якщо не задана — endpoint
повертає `503`).

```bash
curl -fsS -X POST "$API_BASE/admin/enrich-failures/review" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"beer_id":123,"review_class":"parser_bug","note":"beerfreak split brewery into name"}'
```

Поля: `beer_id` (обов'язково), `review_class` (один із чотирьох вище), `note` (опційно).
Відповіді: `200` — OK, `400` — невалідний клас, `401` — токен невалідний/відсутній,
`404` — `beer_id` відсутній у `enrich_failures`.

**Важливо:** якщо провал повторюється пізніше (наступний `recordEnrichFailure` на тому
самому пиві), рядок повертається в тріаж — `review_class`, `review_note`, `reviewed_at`
скидаються до `NULL`. Це нормально: новий провал означає, що ситуація змінилась.

---

## Purge наявних не-пив (разово, ПІСЛЯ broadcast)

Не-пиво-орфани безпечні до видалення (`untappd_id IS NULL`, без посилань у
`match_links`/`checkins`). **Спершу dry-run SELECT** напряму через `sqlite3 -readonly`,
очима звір список, потім DELETE під bot-користувачем через дозволений wrapper.

> ⚠️ Порядок: фільтри адаптера клієнтські → діють лише після broadcast розширення.
> Purge до broadcast = старі клієнти наповнять рядки назад через `/enrich/candidates`.
> Послідовність: merge → broadcast → purge.

> Патерни назв нижче покривають відомі типи не-пива (паки/сети/мерч/сертифікати) на момент
> написання — **розширюй список** під нові випадки з тріажу (dry-run завжди першим).

```bash
# DRY-RUN: подивитись, що буде видалено
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db "
  SELECT ef.beer_id, ef.brewery, ef.name
  FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
  WHERE b.untappd_id IS NULL
    AND (ef.name LIKE \"%brewery pack%\" OR ef.name LIKE \"%vertical set%\"
      OR ef.name LIKE \"%tasting%set%\" OR ef.name LIKE \"%Набір%\"
      OR ef.name LIKE \"%келих%\" OR ef.name LIKE \"%Collective%Pack%\"
      OR ef.name LIKE \"%anniversary vertical%\")
    AND NOT EXISTS (SELECT 1 FROM match_links m WHERE m.untappd_beer_id = ef.beer_id)
    AND NOT EXISTS (SELECT 1 FROM checkins  c WHERE c.beer_id          = ef.beer_id);"
```

Після звірки — той самий WHERE у DELETE під bot-користувачем через wrapper.
**`PRAGMA foreign_keys=ON` обовʼязковий** — sqlite3 CLI
тримає FK **вимкненими** за замовчуванням, тож без нього каскад на `enrich_failures` (FK
`ON DELETE CASCADE`) НЕ спрацює і лишить осиротілі рядки. `busy_timeout` — бо бот тримає БД відкритою (WAL).

```bash
sudo -u warsaw-beer-bot /usr/bin/bash -lc '
  sqlite3 /var/lib/warsaw-beer-bot/bot.db "
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    DELETE FROM beers WHERE id IN (
      SELECT ef.beer_id FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE b.untappd_id IS NULL
        AND (ef.name LIKE \"%brewery pack%\" OR ef.name LIKE \"%vertical set%\"
          OR ef.name LIKE \"%tasting%set%\" OR ef.name LIKE \"%Набір%\"
          OR ef.name LIKE \"%келих%\" OR ef.name LIKE \"%Collective%Pack%\"
          OR ef.name LIKE \"%anniversary vertical%\")
        AND NOT EXISTS (SELECT 1 FROM match_links m WHERE m.untappd_beer_id = ef.beer_id)
        AND NOT EXISTS (SELECT 1 FROM checkins  c WHERE c.beer_id          = ef.beer_id));"'
```

---

## Реарм орфанів після matcher-фіксу

Backoff lookup-ів (`src/domain/lookup-backoff.ts`) **термінальний**: пиво
ретраїться за розкладом `[0, 72h, 168h, 728h]`, а на `untappd_lookup_count >= 4`
стає **dormant назавжди**, поки хтось не скине лічильник.

Тому коли ти викочуєш matcher-покращення — найчастіше нову куровану brewery-alias
пару (див. «Як додати brewery-alias» вище) — орфани, які воно тепер закриває, **самі
не повертаються**:

- `ALIAS_PAIRS` читається на старті, тож задеплоєний alias нічого не робить, поки
  сервіс не **рестартнули**. Спроби в проміжку марно палять backoff проти старого бінаря.
- Орфани вже на `count >= 4` — dormant; cron їх більше ніколи не чіпатиме.

Після деплою фіксу **й рестарту сервісу** реарми пов'язані орфани:

```bash
npm run rearm-aliased-orphans            # dry-run: показує, кого буде реармлено
npm run rearm-aliased-orphans -- --apply # скидає untappd_lookup_count=0 / untappd_lookup_at=NULL
```

Таргетинг повністю похідний від курованого alias-списку (`hasCuratedAlias`): реармляться
орфани (`untappd_id IS NULL`), які вже пробували (`count > 0`) і чия броварня має
куровану alias-пару. Скрипт **не** ходить в Untappd — реальні lookup-и робить наступний
тік enrich-крону. `--apply` ідемпотентний (реармлені рядки падають у `count = 0` і
відсіюються наступного запуску).

> Які орфани взагалі варто реармити — дивись triage-колонки `enrich_failures`:
> `source_url` (секція [`source_url — сторінка магазину`](#source_url--сторінка-магазину))
> і `review_class` (секція [Крок 5. Розмітка тріажу](#крок-5-розмітка-тріажу)).
> `matcher_bug`, закритий новим alias, — головний кандидат на реарм.

---

## Довідка
- Схема таблиці: `spec.md` §3.13; механіка логування: §4 (`/enrich/*`).
- Read-only доступ до прод-БД: `sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db ...`
  напряму як оператор (`ysi`). `sudo -u warsaw-beer-bot /usr/bin/bash -lc ...` —
  лише для write-операцій через дозволений sudoers-wrapper.
- Прод у UTC; корелюй час напряму з `journalctl` (memory `reference_server_timezone`).
- `match_links.untappd_beer_id` — це ЛОКАЛЬНИЙ `beers.id` (заповнений і для орфанів);
  реальний статус матчингу — `beers.untappd_id IS NOT NULL` (memory `reference_matching_gotchas`).
