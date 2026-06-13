# Ранбук: дебаг орфанів (чому пиво не матчиться)

> Коли пиво показується як orphan (⚪ у розширенні / немає рейтингу) або «не те»
> пиво — цей ранбук веде від симптому до кореня **без** ручного відтворення.
> Працює і для людини, і для агента. Джерело істини по схемі — `spec.md` §3.13.

## TL;DR

```bash
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db \
  "SELECT brewery, name, outcome, candidates_count, candidates_summary, search_url, source_url, fail_count, last_at
   FROM enrich_failures WHERE review_class IS NULL ORDER BY last_at DESC LIMIT 30;"
```

Один рядок на пиво, що провалило енрич. **Рядок є = воно зараз провалюється**
(само-видаляється, коли матчиться). Далі — тріаж по `outcome` + `candidates_count`.
Вже розмічені рядки (`review_class IS NOT NULL`) відфільтровано — вони не потребують уваги.

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
- **Хвостовий токен пивоварні** — ярлик магазину є *хвостовим*, а не провідним
  префіксом справжньої пивоварні (`Staropolski` ⋢ `Kultowy Browar Staropolski`).
  Brewery hard-gate ловить лише провідний префікс. Issue #120. Код:
  `matcher.ts breweryAliasesMatch`/`tokenPrefix`, `untappd-lookup.ts` Stage 1.
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
| **Brewery gate** | є кандидати, але brewery відсічено (хвостовий токен) | `src/domain/matcher.ts` (`breweryAliasesMatch`) — issue #120 |

Будь-яка зміна логіки матчингу йде повним циклом: brainstorming → spec → plan →
worktree, і звіряється зі `spec.md` (інваріанти §5.2).

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
`match_links`/`checkins`). **Спершу dry-run SELECT**, очима звір список, потім DELETE. Запуск під
bot-користувачем (звичайний `sudo -u warsaw-beer-bot` не працює — лише через дозволений wrapper):

> ⚠️ Порядок: фільтри адаптера клієнтські → діють лише після broadcast розширення.
> Purge до broadcast = старі клієнти наповнять рядки назад через `/enrich/candidates`.
> Послідовність: merge → broadcast → purge.

> Патерни назв нижче покривають відомі типи не-пива (паки/сети/мерч/сертифікати) на момент
> написання — **розширюй список** під нові випадки з тріажу (dry-run завжди першим).

```bash
# DRY-RUN: подивитись, що буде видалено
sudo -u warsaw-beer-bot /usr/bin/bash -lc '
  sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db "
    SELECT ef.beer_id, ef.brewery, ef.name
    FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
    WHERE b.untappd_id IS NULL
      AND (ef.name LIKE \"%brewery pack%\" OR ef.name LIKE \"%vertical set%\"
        OR ef.name LIKE \"%tasting%set%\" OR ef.name LIKE \"%Набір%\"
        OR ef.name LIKE \"%келих%\" OR ef.name LIKE \"%Collective%Pack%\"
        OR ef.name LIKE \"%anniversary vertical%\")
      AND NOT EXISTS (SELECT 1 FROM match_links m WHERE m.untappd_beer_id = ef.beer_id)
      AND NOT EXISTS (SELECT 1 FROM checkins  c WHERE c.beer_id          = ef.beer_id);"'
```

Після звірки — той самий WHERE у DELETE (каскадить enrich_failures):

```bash
sudo -u warsaw-beer-bot /usr/bin/bash -lc '
  sqlite3 /var/lib/warsaw-beer-bot/bot.db "
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

## Довідка
- Схема таблиці: `spec.md` §3.13; механіка логування: §4 (`/enrich/*`).
- Read-only доступ до прод-БД: memory `reference_prod_deploy_and_db_ops`
  (`/var/lib/warsaw-beer-bot/bot.db`; `sudo -u warsaw-beer-bot` НЕ працює).
- Прод у UTC; корелюй час напряму з `journalctl` (memory `reference_server_timezone`).
- `match_links.untappd_beer_id` — це ЛОКАЛЬНИЙ `beers.id` (заповнений і для орфанів);
  реальний статус матчингу — `beers.untappd_id IS NOT NULL` (memory `reference_matching_gotchas`).
