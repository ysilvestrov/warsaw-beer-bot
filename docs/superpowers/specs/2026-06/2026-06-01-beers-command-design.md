# `/beers` — команда дебаг-дампу кранів паба — дизайн-документ

> Статус: **spec approved, pending implementation**
> Дата: 2026-06-01

## 1. Проблема / мотивація

`/newbeers` показує лише *нові й цікаві* пива: відкидає вже пробувані (Untappd
«had») і ті, що не проходять персональні фільтри користувача (стиль/рейтинг/ABV),
групує однакові пива між пабами й ранжує.

Потрібен **діагностичний** інструмент: побачити, **що саме бот розпарсив** зі
сторінки конкретного паба — повний сирий список кранів, без жодних відсіювань.
Це команда для дебагу власником бота, а не «гарна» фіча для кінцевого юзера.

## 2. Вимоги

| Сценарій | Очікуваний результат |
|---|---|
| `/beers` (без аргументу) | повідомлення-підказка використання (аргумент обов'язковий) |
| `/beers <запит>`, 0 збігів пабів | `pub_not_found` |
| `/beers <запит>`, рівно 1 паб | повний список кранів цього паба |
| `/beers <запит>`, 2+ пабів | помилка «неоднозначно» з переліком **перших 3** кандидатів (назва + адреса) |
| паб знайдено, але немає snapshot / кранів | `empty` |

**Семантика «всі пива»:** усі краны останнього snapshot паба, у порядку
`tap_number`. **Без** фільтрації по «had»-списку. **Без** персональних фільтрів.
Включно з orphan-пивами (незматченими) і вже пробуваними.

## 3. Дизайн

### 3.1 Перевикористання наявного коду

- Пошук паба: наявна `filterPubsByQuery(pubs, q)` з `newbeers-build.ts`
  (name-first, address-tiebreaker — див. `2026-06-01-pub-query-disambiguation-design.md`).
- Дані кранів: наявна `tapsForSnapshotWithBeer(db, snapshotId)` — повертає
  `tap_number, beer_ref, brewery_ref, abv, u_rating (coalesced), beer_id`.
- Список пабів: `listPubs(db)`; останній snapshot: `latestSnapshot(db, pubId)`.

**Чому окрема функція, а не прапорець `debug` у `buildNewbeersMessage`:**
семантика принципово інша (нема tried/filters/групування/ранжування). Окрема
чиста функція простіша для читання й тестів; уникаємо розгалужень у гарячій
функції `/newbeers`.

### 3.2 Нова чиста функція

Розташування: новий файл `src/bot/commands/beers-build.ts`
(формат рядка — у тому ж файлі, бо тривіальний).

```ts
export interface BeersDeps {
  db: DB;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
}

export type BeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'no_arg' }
  | { kind: 'pub_not_found'; query: string }
  | { kind: 'ambiguous'; pubs: { name: string; address: string | null }[] } // ≤3
  | { kind: 'empty'; pub: string }; // паб знайдено, але немає snapshot / кранів

export function buildBeersMessage(deps: BeersDeps): BeersResult;
```

**Алгоритм:**
1. `q = pubQuery?.trim()`. Якщо порожній → `{ kind: 'no_arg' }`.
2. `filtered = filterPubsByQuery(listPubs(db), q)`.
   - `length === 0` → `{ kind: 'pub_not_found', query: q }`
   - `length >= 2` → `{ kind: 'ambiguous', pubs: filtered.slice(0,3).map(name+address) }`
   - `length === 1` → продовжити.
3. `snap = latestSnapshot(db, pub.id)`. Якщо немає → `{ kind: 'empty' }`.
4. `taps = tapsForSnapshotWithBeer(db, snap.id)` (вже відсортовані по `tap_number`).
   Якщо порожньо → `{ kind: 'empty' }`.
5. Зібрати HTML (заголовок + рядки) → `{ kind: 'ok', html }`.

### 3.3 Формат виводу (HTML)

Рядки локалізованих текстів escape-аються всередині білдера (HTML-режим
Telegram — див. конвенцію проєкту з locale-рядками).

**Заголовок:** `beers.header` з `{pub}`, `{address}`, `{count}`
(назва паба + адреса + кількість кранів).

**Рядок крана:**
```
{tap_#} • {Brewery Beer} • {ABV}% • {rating} • ({status})
```
- `tap_#`: `tap_number` або `—`, якщо `null`
- `{Brewery Beer}`: `brewery_ref + ' ' + beer_ref` (trim), або тільки `beer_ref`,
  якщо `brewery_ref` порожній — **сирі** значення, як розпарсив бот
- `{ABV}`: `{n}%` або `—`, якщо `null`
- `{rating}`: coalesced `u_rating`, 1 знак після коми, або `—`, якщо `null`
- `{status}`: іконка матчингу — `🟢`, якщо `beer_id != null` (matched),
  інакше `⚪` (orphan). Фіксовані символи, **не** через `t()` (однакові в усіх локалях)
- розділювач скрізь — `•` (U+2022)

### 3.4 Командний хендлер

Новий файл `src/bot/commands/beers.ts` — тонкий, за зразком `newbeers.ts`:
читає аргумент, викликає `buildBeersMessage`, `switch` по `result.kind` з
exhaustiveness-перевіркою (`result satisfies never`).

- `ok` → `replyWithHTML(result.html)`
- `no_arg` → `reply(t('beers.usage'))`
- `pub_not_found` → `reply(t('beers.pub_not_found', { query }))`
- `ambiguous` → `reply(...)` з переліком пабів (формат елемента — `beers.ambiguous_item`)
- `empty` → `reply(t('beers.empty'))`

Зареєструвати композер у `src/bot/index.ts` поряд з `newbeersCommand`.

### 3.5 i18n

Нові ключі (типізувати в `src/i18n/types.ts`, додати в `en.ts`/`pl.ts`/`uk.ts`):

| Ключ | Плейсхолдери | Призначення |
|---|---|---|
| `beers.usage` | — | підказка: аргумент обов'язковий |
| `beers.header` | `{pub}`, `{address}`, `{count}` | заголовок дампу |
| `beers.pub_not_found` | `{query}` | паб не знайдено |
| `beers.ambiguous` | — | вступний рядок помилки неоднозначності |
| `beers.ambiguous_item` | `{name}`, `{address}` | один паб у переліку кандидатів |
| `beers.empty` | `{pub}` | паб знайдено, кранів немає |

Статус матчингу — **не** в i18n (фіксовані іконки `🟢`/`⚪` у білдері).

Додати рядок опису `/beers` у help/start-текст усіх трьох локалей
(масив у `*.ts`, поряд з описом `/newbeers`).

## 4. Тестування (Jest)

`src/bot/commands/beers-build.test.ts`, fixture-DB у пам'яті:

| Сценарій | Очікуваний результат |
|---|---|
| порожній `pubQuery` | `{ kind: 'no_arg' }` |
| невідомий запит | `{ kind: 'pub_not_found' }` |
| 2+ збіги пабів | `{ kind: 'ambiguous' }`, `pubs.length <= 3` |
| 1 збіг, є краны | `{ kind: 'ok' }`; HTML містить **усі** краны (включно з orphan і вже-пробуваними — підтвердити, що фільтрації нема) |
| 1 збіг, немає snapshot | `{ kind: 'empty' }` |
| 1 збіг, snapshot без кранів | `{ kind: 'empty' }` |
| формат рядка | matched `🟢` vs orphan `⚪`; `null` ABV/rating/tap_# → `—`; сирі brewery+beer |

## 5. Зміни у файлах

| Файл | Дія |
|---|---|
| `src/bot/commands/beers-build.ts` | новий — `buildBeersMessage` + формат |
| `src/bot/commands/beers.ts` | новий — командний хендлер |
| `src/bot/commands/beers-build.test.ts` | новий — тести |
| `src/bot/index.ts` | зареєструвати `beersCommand` |
| `src/i18n/types.ts` | додати ключі `beers.*` |
| `src/i18n/locales/{en,pl,uk}.ts` | додати переклади `beers.*` + опис у help |
| `src/bot/commands/newbeers-build.ts` | без змін (реекспортуємо `filterPubsByQuery`) |
