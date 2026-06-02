# Enrichment search noise fix + orphan backfill + honest 🟢/⚪ icon

**Дата:** 2026-06-02
**Статус:** дизайн затверджено, чекає плану

## Мотивація

`/beers <паб>` показує матчені пива (🟢) **без рейтингу** (`—`), хоча на
Untappd пиво існує й має оцінку. Приклад: `1 • JBW Brewery Wocky Talky •
4.2% • — • 🟢`.

### Діагностика (відтворено на проді 2026-06-02)

1. **Рейтинг порожній, бо пиво — orphan.** `beers.id=12277` (`JBW Brewery /
   Wocky Talky`) має `untappd_id = NULL`, `rating_global = NULL`. У `/beers`
   рейтинг = `COALESCE(tap.u_rating, beers.rating_global)` — обидва NULL → `—`.

2. **Чому orphan не збагатився.** `lookupBeer` (`src/domain/untappd-lookup.ts:43`)
   будує Untappd-запит із **сирого** `${brewery} ${name}` = `"JBW Brewery
   Wocky Talky"`. Untappd-пошук робить AND по токенах; слово «Brewery» не
   зустрічається в реальній пивоварні «JBW Browar» → **0 результатів** →
   `not_found`. Перевірено напряму:

   | запит | результат |
   |---|---|
   | `Wocky Talky` | ✅ 1 (bid 6172039, «JBW Browar», ⭐3.18) |
   | `JBW Wocky Talky` | ✅ 1 |
   | `JBW Browar Wocky Talky` | ✅ 1 |
   | **`JBW Brewery Wocky Talky`** ← що шле enrichment | ❌ **0** |

   `normalizeBrewery` уже має `brewery/browar/brewing/co/company` у
   `BREWERY_NOISE`, але це застосовується лише до brewery hard-gate (аліаси),
   **не** до рядка пошуку.

3. **Узагальнюється.** `Trzech Kumpli Brewery …` → 0; `Trzech Kumpli …` → 1.
   `Pilsner Urquell Brewery …` повертає хибний «brewery tour» edition; без
   суфікса — правильний першим. **260 із 300** невдалих орфанів мають
   пивоварню з суфіксом « Brewery».

4. **Іконка бреше.** `/beers` показує 🟢, коли існує `match_links` рядок, а
   `match_links.untappd_beer_id` — це **локальний** `beers.id` (JOIN `ON
   ml.untappd_beer_id = b.id`), який ставиться навіть для орфанів (на власний
   id). Тож 🟢 з'являється для незбагачених орфанів, хоча реального Untappd-ID
   нема.

## Рішення

Три незалежні компоненти в одному PR.

### Компонент 1 — прибрати шумові слова з пошукового запиту

- Новий експортований хелпер у `src/domain/normalize.ts`:
  ```ts
  export function stripBreweryNoise(brewery: string): string
  ```
  Токенізує по пробілах, викидає токени, чий `toLowerCase()` ∈ `BREWERY_NOISE`,
  **зберігаючи регістр і діакритику** решти токенів. Приклади:
  - `"JBW Brewery"` → `"JBW"`
  - `"Trzech Kumpli Brewery"` → `"Trzech Kumpli"`
  - `"Gościszewo Brewery"` → `"Gościszewo"` (діакритика збережена)
  - `"Browar Pinta"` → `"Pinta"`
  - вся з шуму (`"Browar"`) → `""`

- `src/domain/untappd-lookup.ts` (рядок 43): будувати запит із очищеної
  пивоварні:
  ```ts
  html = await fetch(buildSearchUrl(`${stripBreweryNoise(part)} ${name}`.trim()));
  ```
  `.trim()` покриває порожню пивоварню → запит зводиться до самої назви
  (перевірено: пошук лише за назвою знаходить пиво). **Brewery hard-gate
  (Stage 1) і name-fuzzy (Stage 2) не змінюються** — вони вже працюють на
  нормалізованих аліасах і назвах.

- **Обмеження (свідомо):** порівняння токена робиться по `toLowerCase()` без
  зняття пунктуації, тож `"Co."` (з крапкою) не розпізнається як шум. Рідкісно;
  прийнятно для мінімального фіксу. Глибша нормалізація запиту (повний
  `normalizeBrewery`) — окреме дослідження на пізніше, **поза цим PR**.

- **Тести (Jest):**
  - `stripBreweryNoise`: суфікс «Brewery»; префікс «Browar»; діакритика
    збережена; вся-шум → `""`; без шуму → без змін.
  - `lookupBeer` з фейковим `fetch`: запит-URL більше не містить «Brewery»;
    коли фейкова сторінка пошуку містить кандидата з тим же brewery-аліасом і
    близькою назвою — outcome `matched`.

### Компонент 2 — бекфіл: скид backoff для орфанів

- `src/storage/schema.ts` — нова міграція `version: 7`:
  ```sql
  UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0
  WHERE untappd_id IS NULL;
  ```
- `migrate()` виконується на старті (`src/index.ts`), тож скид відбувається раз
  при деплої. Наявний enrich-orphans cron (LIMIT 20, кожні 3 год = ~160/добу) з
  **уже виправленим** запитом перебере ~260 орфанів за ~2 доби. Нового
  бурст-коду немає.
- Зматчені пива (`untappd_id IS NOT NULL`) не зачіпаються — їхній backoff/стан
  лишається.
- **Тест:** у `schema.test.ts` — на БД, мігрованій до v6, засіяти орфан
  (`untappd_id NULL`, `untappd_lookup_count=3`, `untappd_lookup_at` задано) і
  зматчене пиво (`untappd_id` задано, `untappd_lookup_count=2`); застосувати
  міграцію v7; перевірити: орфан → `count=0`, `at=NULL`; зматчене недоторкане.

### Компонент 3 — чесні 🟢/⚪ (реальний orphan-статус)

- `src/storage/snapshots.ts` — у `tapsForSnapshotWithBeer` додати
  `b.untappd_id AS untappd_id` до SELECT і поле `untappd_id: number | null` в
  інтерфейс `TapWithBeer`. **`beer_id` лишається без змін** (його використовує
  `newbeers-build.ts:78` для групування).
- `src/bot/commands/beers-build.ts` (рядок 64): іконку брати з реального
  Untappd-ID:
  ```ts
  const icon = tap.untappd_id != null ? '🟢' : '⚪';
  ```
  Правило: 🟢 — кран зматчено на рядок `beers` з `untappd_id` (реальна
  ідентичність на Untappd); ⚪ — orphan (`untappd_id IS NULL`) **або** взагалі
  без `match_link`.
- **Тести:** `beers-build.test.ts` — кран, зматчений на рядок з `untappd_id`
  → 🟢; зматчений на орфан (`untappd_id NULL`) → ⚪; без `match_link` → ⚪.
- USER-GUIDE: наявний опис («🟢 — пиво зматчено з Untappd-каталогом; ⚪ —
  orphan») тепер стає фактично правдивим — правок тексту не потребує (звірити
  при реалізації; за потреби — дрібне уточнення).

## Поведінка після деплою (приклад `JBW Brewery Wocky Talky`)

1. Одразу: `/beers` показує `⚪` + `—` (чесно — `untappd_id` порожній).
2. Протягом ~2 діб cron знаходить `bid=6172039`, заповнює `untappd_id` +
   `rating_global = 3.18`.
3. Далі: `/beers` показує `🟢` + `3.2`.

## Верифікація перед злиттям

- `npm run typecheck`, `npm run build`, `npm test` — зелені.
- Інструментований лукап (як у діагностиці, не-cookie fetch) для 2-3 уражених
  пивоварень (`JBW Brewery`, `Trzech Kumpli Brewery`) — підтвердити, що тепер
  outcome `matched` із непорожнім рейтингом.

## Не входить (YAGNI / на потім)

- Повна нормалізація запиту (lowercase + зняття діакритики, варіант B) —
  окреме дослідження пізніше.
- Зняття пунктуації при детекції шуму (`"Co."`).
- Зміна семантики `match_links` чи `newbeers` (orphan все ще отримує
  match_link на власний id — це поза скоупом).
- Прискорений бекфіл-бурст (одноразовий джоб) — обрано гентильний скид backoff
  + наявний cron.
