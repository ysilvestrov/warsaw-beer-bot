# winetime parser fixes (orphaned "Brewery" token + `янтарне`) — design

> **Стандарт:** OpenSpec (spec-driven). **Статус:** `DESIGN`.
> **Дата:** 2026-06-13. **Issue:** #136 (звужений). **Мотивація:** аналіз `enrich_failures`
> (прод 2026-06-12) — winetime-адаптер віддає криву назву для кількох рядків, через що валідний
> кандидат не матчиться. **Звіряти з:** `spec.md` §6 (Browser Extension Client).

## 1. Problem

Два дефекти парсингу в `extension/src/sites/winetime.ts` дають криву `name`, через що
downstream-матчинг провалюється на реальних пивах:

1. **Осиротілий токен `Brewery`/`Броварня`.** `cleanName` зрізає бренд-префікс, але лишає
   приклеєне до нього шумове слово пивоварні. Приклад `beer_id=26102`: title
   `Пиво ДІДЬКО Brewery Double Trouble`, `manufacturer="ДІДЬКО"` → після зрізання `ДІДЬКО`
   лишається `Brewery Double Trouble` (на Untappd — `Дідько Brewery — Double Trouble`, тобто
   назва `Double Trouble`). Також `26104`: `TEN MEN` → `Brewery RUBIS` (реальне `Ten Men Brewery — RUBIS`).
2. **Відсутній дескриптор `янтарне`.** `DESCRIPTOR_RE` (`winetime.ts:6`) не містить `янтарне`
   (бурштинове). Приклад `beer_id=26105`: `Femme Fatale янтарне` (De Leite) → дескриптор не
   зрізається, назва лишається з хвостом.

## 2. Scope / Non-goals

**Scope.** Лише `extension/src/sites/winetime.ts` (+ bespoke-тести). Дві зміни вище. Рідить
найближчий broadcast розширення.

**Non-goals.**
- **Порожня пивоварня** (sub-bug 1 з #136) — винесено в **#149** (matcher/сервер, не адаптер:
  бренд є нелідируючим токеном Untappd-пивоварні, тож жоден адаптерний фікс не пройде
  leading-prefix gate; FP-чутливо, перетинається з #120). Не входить сюди.
- Жодних змін матчера/сервера; жодних нових дескрипторів без доказів.

## 3. Decision

### 3.1 Осиротілий токен пивоварні (sub-bug 2)

Додати локальну константу та зрізати **один** лідируючий шумовий токен пивоварні з очищеної
назви, **після** циклу `breweryPrefixes` у `cleanName`:

```ts
const LEADING_BREWERY_NOISE_RE = /^(?:brewery|browary?|brewing|броварня|пивоварня)\s+/iu;
```

- Зрізання **безумовне** (не лише коли префікс було знято) — реальна назва пива не починається з
  голого `Brewery`/`Броварня`, тож FP-ризик мізерний; безумовний варіант простіший.
- Лише **один** провідний токен (не цикл) — щоб не з'їсти легітимні слова.
- Розширення — окремий пакет, тож тримаємо **локальний** список, а не імпорт серверного
  `normalize.ts BREWERY_NOISE`.

Відновлює `26102` (`Brewery Double Trouble`→`Double Trouble`), `26104` (`Brewery RUBIS`→`RUBIS`).

### 3.2 Дескриптор `янтарне` (sub-bug 3)

Додати `янтарне` до `DESCRIPTOR_RE`:

```ts
const DESCRIPTOR_RE =
  /\s+(?:світле|темне|напівтемне|нефільтроване|фільтроване|пастеризоване|безалкогольне|янтарне)$/iu;
```

Консервативно — лише `янтарне` (решта кольорів `світле/темне/напівтемне` вже є). Відновлює
`26105` (`Femme Fatale янтарне`→`Femme Fatale`).

**Назви-лише-дескриптор** (`26106` = `світле` саме по собі): **лишаємо як є** (поточний фолбек
`cleaned || name || original` повертає `світле`). НЕ скіпаємо картку — це втратило б реальне пиво
(`BUD світле`); маргінальний матч кращий за втрату беври. Тобто змін під цей кейс немає.

### 3.3 Порядок у `cleanName`

`Пиво`-префікс → бренд-префікси → одиниці об'єму/мл → `DESCRIPTOR_RE` (цикл) → бренд-суфікси →
**(нове)** лідируючий шумовий токен пивоварні. Лідируючий-шум зрізаємо **в кінці**, бо він з'являється
лише після зняття бренд-префікса.

## 4. Testing

Bespoke у `extension/src/sites/winetime.test.ts` (Vitest + jsdom):
- title `Пиво ДІДЬКО Brewery Double Trouble` + `manufacturer="ДІДЬКО"` → `{brewery:"ДІДЬКО", name:"Double Trouble"}`.
- title `Пиво TEN MEN Brewery RUBIS` + `manufacturer="TEN MEN"` → name `RUBIS`.
- title `Femme Fatale янтарне` → name `Femme Fatale`.
- **FP-гард:** нормальна назва, що НЕ починається з шумового токена (напр. `Brewdog Punk IPA`),
  не зрізається помилково (зокрема `Brewdog` ≠ `Brewery`/`Brewing` — переконатися, що
  `LEADING_BREWERY_NOISE_RE` вимагає `\s+` після слова й не чіпає `Brewdog`).

Існуючі winetime-тести лишаються зеленими; `npm test` + `npm run build` (з `extension/`).

## 5. Refs
- Issue #136 (звужений); split: #149 (порожня пивоварня, matcher); related #120.
- Код: `extension/src/sites/winetime.ts` (`cleanName`, `DESCRIPTOR_RE`).
- Джерело провалів: `enrich_failures` (прод 2026-06-12).
