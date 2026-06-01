# Pub Query Disambiguation — дизайн-документ

> Статус: **spec approved, pending implementation**
> Дата: 2026-06-01

## 1. Проблема

В ontap.pl є два паби з однаковою назвою «PINTA Warszawa» на різних вулицях
(Chmielna та Nowogrodzka). Команда `/newbeers pinta nowogrodzka` має показувати
пиво тільки з одного паба, але зараз не може — `pubQuery` перевіряє лише
підрядок у назві, а обидва паби мають однакову назву.

## 2. Вимоги

| Запит | Очікуваний результат |
|---|---|
| `pinta` | обидва паби (стара поведінка збережена) |
| `pinta nowogrodzka` | тільки PINTA на Новогродзькій |
| `pinta chmielna` | тільки PINTA на Хмельній |
| `nowogrodzka` | паби де «nowogrodzka» є в адресі |
| унікальна назва (1 match) | цей один паб, адреса не перевіряється |
| невідомий запит | `pub_not_found` |

## 3. Дизайн

### 3.1 Нова чиста функція

```ts
export function filterPubsByQuery(pubs: Pub[], query: string): Pub[]
```

Розташування: `src/bot/commands/newbeers-build.ts` (named export).

**Алгоритм (два етапи):**

**Етап 1 — name-match:**
`nameMatches` = паби де `pub.name.toLowerCase()` містить `query` як підрядок.

- `nameMatches.length === 1` → повернути `[nameMatches[0]]` (адреса не потрібна)
- `nameMatches.length === 0` → перейти до address fallback (§ нижче)
- `nameMatches.length >= 2` → перейти до address tiebreaker (§ нижче)

**Address fallback (0 name-matches):**
Розбити `query` на слова (`/\s+/`). Повернути паби де кожне слово є в
`(pub.name + ' ' + (pub.address ?? '')).toLowerCase()`.
Порожній результат = `pub_not_found`.

**Address tiebreaker (2+ name-matches):**
Серед `nameMatches` залишити паби де кожне слово query є в `(name + ' ' + address)`.
- Звузилось до 1 → повернути його
- Інакше → повернути всі `nameMatches` (стара поведінка)

**Обґрунтування двох етапів:** якщо спочатку name-match не виконується,
слово запиту може збігтись з назвою іншого паба в його адресі і дати хибний
результат. Name-match має пріоритет над address-match.

### 3.2 Інтеграція в `buildNewbeersMessage`

Inline-логіку фільтрації пабів замінити на виклик `filterPubsByQuery`.
`pub_not_found` повертається якщо результат порожній при непорожньому запиті.

### 3.3 Тип `NewbeersResult` — без змін

```ts
type NewbeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'empty' }
  | { kind: 'pub_not_found'; query: string };
```

`BeerGroup` і `newbeers-format.ts` — без змін.

## 4. Тестування

Тести для `filterPubsByQuery` у `newbeers-build.test.ts`, з fixture-пабами
в пам'яті (без DB):

| Сценарій | Вхід | Очікуваний результат |
|---|---|---|
| Унікальний name-match | `'pinta chmielna unique'` | `[pubChmielna]` |
| 2 name-matches, tiebreaker → 1 | `'pinta nowogrodzka'` | `[pubNowogrodzka]` |
| 2 name-matches, tiebreaker → 1 | `'pinta chmielna'` | `[pubChmielna]` |
| 2 name-matches, tiebreaker → 2 | `'pinta warszawa'` | обидва |
| Address fallback → 1 | `'nowogrodzka'` | `[pubNowogrodzka]` |
| Address fallback → not found | `'xxxxxx'` | `[]` |

Існуючі тести `buildNewbeersMessage` на HTML-вміст — **без змін**.
Нові uncommitted тести з `out.groups` / `pub_ids` — **видалити**.

## 5. Зміни у файлах

| Файл | Дія |
|---|---|
| `src/bot/commands/newbeers-build.ts` | витягти `filterPubsByQuery`, замінити inline-логіку |
| `src/bot/commands/newbeers-build.test.ts` | видалити тести з `out.groups`, додати тести `filterPubsByQuery` |
| `src/bot/commands/newbeers-format.ts` | без змін |
| решта | без змін |
