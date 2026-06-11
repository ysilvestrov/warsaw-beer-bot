# Orphan enrich-failure logging — design

> **Стандарт:** OpenSpec (spec-driven). **Статус:** `DESIGN`.
> **Дата:** 2026-06-11. **Мотивація:** дебаг матчингу (#117, #124) вимагав ручного
> відтворення кейсів — зберегти вхід + сторінку пошуку Untappd і причепити до ішьюзу.
> **Звіряти з:** `spec.md` §3 (схема), §4 (`/enrich/*`, фонові джоби), §5.2 (інваріанти).

## 1. Problem

Коли пиво не енричиться (лишається orphan), зараз немає сліду **чому**. Щоб
дебажити, доводилося просити користувача відтворити пошук, зберегти HTML і причепити
до GitHub-ішьюзу (#117, #124) — повільно й не масштабується.

**Ключове спостереження (перевірено з прод-хоста, 2026-06-11):** пошук Untappd
(`untappd.com/search?q=…&type=beer`) **доступний без кукі/логіна** — HTTP 200, реальні
результати в `.results-container .beer-item`, які `parseSearchPage` парсить. Серверне
«блокування» (через яке зроблено client-relay) — інтермітентне/rate-based (тригерить
circuit breaker під автоматичним батчем), не абсолютне. Тож **HTML зберігати не треба**:
достатньо залогувати `searchUrl`, і його можна відкрити в браузері або перетягнути
`curl`-ом для відтворення.

## 2. Goals / Non-goals

**Goals.** Запитувана таблиця провалів енричу: для кожного orphan'а, що дав `not_found`
або `blocked`, зберегти вхід (`brewery`/`name`), `searchUrl`, результат і **короткий
summary кандидатів** (скільки повернув пошук і топ-3 `brewery — name`), щоб «чому» було
видно одразу або однокліково відтворювалося. Обидва канали енричу. Self-cleaning.

**Non-goals.** Не логуємо `matched` (успіх) і `transient` (тимчасова мережа, не сигнал
матчингу). Не зберігаємо HTML. Не будуємо `/orphans`-команду бота (тривіальна добавка
згодом — YAGNI). Не чіпаємо `/match`-оверлей (read-only, інший шлях).

## 3. Design

### 3.1 Дані (міграція v10)

Нова таблиця `enrich_failures` — **один рядок на пиво**, upsert на кожному провалі,
видаляється коли пиво нарешті матчиться. Розмір обмежений поточним набором orphan'ів.

| Поле | Тип | Опис |
|------|-----|------|
| `beer_id` | INTEGER | PK → `beers(id)` **ON DELETE CASCADE** |
| `brewery` | TEXT NOT NULL | сирий вхід (як прийшов) |
| `name` | TEXT NOT NULL | сирий вхід |
| `search_url` | TEXT NOT NULL | побудований запит (перша brewery-частина) — відкрити для відтворення |
| `outcome` | TEXT NOT NULL CHECK IN (`not_found`,`blocked`) | результат |
| `candidates_count` | INTEGER NOT NULL | скільки кандидатів повернув пошук (0 = зашумлений запит) |
| `candidates_summary` | TEXT NOT NULL | топ-3 `"<brewery> — <name>"`, `;`-joined (порожньо для blocked) |
| `fail_count` | INTEGER NOT NULL DEFAULT 1 | скільки разів провалився (++ на upsert) |
| `last_at` | TEXT NOT NULL | час останнього провалу (ISO) |

Запит дебагу: `SELECT brewery, name, outcome, candidates_count, candidates_summary,
search_url, fail_count, last_at FROM enrich_failures ORDER BY last_at DESC;`
«0 кандидатів» → запит зашумлений (як #124 Track); «N, але not_found» → brewery-gate
або name-fuzzy відсікли (видно по їхніх brewery/name, як #117).

### 3.2 Прокидання діагностики з `lookupBeer`

Розширити `LookupOutcome` (`domain/untappd-lookup.ts`) — діагностика вже є всередині
(URL'и будуються, результати парсяться), просто повертаємо її:
```ts
| { kind: 'not_found'; searchUrls: string[]; candidates: SearchResult[] }
| { kind: 'blocked'; searchUrl: string }
```
- `not_found`: `searchUrls` — усі спробувані brewery-частини; `candidates` — об'єднання
  розпарсених результатів (може бути порожнім).
- `blocked`: `searchUrl` — той, що дав блок.
- `matched`/`transient` — без змін.

### 3.3 Логування в спільному хуку

`applyLookupOutcome` (`domain/lookup-outcome.ts`) — спільний для серверного крона
(`enrichOneOrphan`) і client-relay (`/enrich/result`), тож обидва канали логуються
однаково. Сигнатура отримує вхід `input: { brewery: string; name: string }`:
- `outcome.kind === 'not_found'` → `recordEnrichFailure(...)` (`outcome: 'not_found'`,
  `search_url = searchUrls[0]`, summary з `candidates`), потім наявний `recordLookupNotFound`.
- `outcome.kind === 'blocked'` → `recordEnrichFailure(...)` (`outcome: 'blocked'`,
  `candidates_count: 0`), нічого більше (блок не мутує backoff — інваріант §5.2).
- `outcome.kind === 'matched'` → `clearEnrichFailure(db, beerId)` ПІСЛЯ `recordLookupSuccess`
  (пиво більше не провал). Merge-гілка (UNIQUE-клеш → повертає `'not_found'`) — це
  **успіх**, тож теж чистить, НЕ логує провал (гейтимо по `outcome.kind`, не по return).

### 3.4 Storage-модуль

`storage/enrich_failures.ts` (один модуль на таблицю): `recordEnrichFailure(db, row)`
(upsert по `beer_id`, `fail_count = fail_count + 1` на конфлікті), `clearEnrichFailure(db,
beerId)` (`DELETE`). Summary будує хелпер: топ-3 `r.brewery_name — r.beer_name`, `; `-joined.

## 4. Testing

- **schema.test.ts:** міграція до v10 створює `enrich_failures`; ідемпотентна.
- **enrich_failures.test.ts:** upsert створює/оновлює (++`fail_count`, новий `last_at`);
  `clearEnrichFailure` видаляє; CASCADE при видаленні beer'а.
- **lookup-outcome.test.ts:** `not_found` пише рядок (`outcome`, `search_url`, count,
  summary); `blocked` пише (count 0); `matched` чистить; merge-гілка (`matched`+UNIQUE)
  чистить і НЕ лишає провалу.
- **untappd-lookup.test.ts:** `not_found` повертає `searchUrls`+`candidates`; `blocked`
  повертає `searchUrl`. Summary: «0 кандидатів» (зашумлений запит) і «N кандидатів, але
  not_found» (gate/fuzzy відсік) — на синтетичних фікстурах.

## 5. Spec impact (`spec.md`)

- §3: нова таблиця `enrich_failures` (v10) + рядок у §3.15 (історія міграцій).
- §4 (`/enrich/*` + фонові джоби): нотатка, що `not_found`/`blocked` логуються в
  `enrich_failures` (обидва канали), self-cleaning на `matched`.
- §5.2: «блок не мутує backoff» лишається — логування провалу backoff не змінює.

## 6. Rollout
Без впливу на користувача. Міграція v10 — ідемпотентний `CREATE TABLE`. Таблиця
наповнюється з наступного енричу (крон або client-relay).
