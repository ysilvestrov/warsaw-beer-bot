# Bidirectional slash-alias dedup (any-spacing, any-side)

**Date:** 2026-05-25
**Branch:** `feat/slash-alias-bidirectional`
**Relation to prior work:** Extends `2026-05-10-paren-alias-and-had-list.md` (PR-A landed paren-alias dedup; this is **PR-C** — slash-alias bidirectional dedup).

## Background

Bug report: `/newbeers` показав *Sady/Beer Bacon and Liberty Brewery
Midnight Mass* (`⭐ —, 10.9%`), хоча юзер це пиво пив (зафіксовано в
`untappd_had` 2026-05-25T19:17 під canonical `beer_id=12286`,
`untappd_id=6645648`, broварня `Browar Sady`, рейтинг 3.92).

Розбір показав класичний catalog-dedup gap: `beers` має дві рядки для
того ж пива:

| id | untappd_id | brewery | normalized_brewery | rating |
|---|---|---|---|---|
| 12276 | NULL | `Sady/Beer Bacon and Liberty Brewery` | `sady beer bacon and liberty` | NULL |
| 12286 | 6645648 | `Browar Sady` | `sady` | 3.92 |

`match_links` для `ontap_ref='Midnight Mass'` вказує на orphan 12276.
`untappd_had`-запис юзера — на canonical 12286. `triedBeerIds` повертає
`{12286, …}`, `tapsForSnapshotWithBeer` повертає `beer_id=12276` →
`filterInteresting` пропускає пиво в `/newbeers`.

**Аудит проді** (production DB, `/var/lib/warsaw-beer-bot/bot.db`,
2026-05-25): такого типу пар у БД **17 унікальних orphan-рядків**
(23 candidate-пари до alias-overlap фільтрації). Більшість — польські
slash-form colab-и: `Nieczajna/Szałpiw/Same Krafty/Smaki Piwa/…`,
`Brofaktura/Same Krafty/Okonapiwo Brewery`, `Stu Mostów/ Ophiussa
Brewery`, `Magic Road/Kraft Box Brewery` тощо.

## Корінь проблеми

Дві окремі помилки в одному концептуальному припущенні («slash-form
завжди має пробіли навколо `/` і завжди знаходиться на canonical-боці
пари»):

1. **`src/domain/matcher.ts:31`** — `breweryAliases` розщеплює тільки
   на літерал `' / '` (з обома пробілами). `Sady/Beer Bacon...` (без
   пробілів) і `Nieczajna/ Monsters` (тільки з правим пробілом)
   повертаються одним alias-ом, не розщеплюються.

2. **`src/jobs/dedupe-brewery-aliases.ts`** — SQL шукає компаунд-форму
   тільки на **канонічному** `a`-боці пари: `a.brewery LIKE '% / %'`.
   Орфан-side компаунд не ловиться, плюс той самий spaced-only-pattern.

Через (1) майбутні ontap-scrape-и не знаходять існуючий Untappd-row і
`upsertBeer`-ять новий orphan з некомпатибельним `normalized_brewery`.
Через (2) `dedupeBreweryAliases` (startup-cleanup) не схлопує orphan-и
постфактум.

## Goals

- `breweryAliases` повертає всі компоненти slash-form незалежно від
  пробілів навколо `/`. Інші форми (єдина назва, paren-form `X (Y)`)
  поведінка незмінна.
- `dedupeBreweryAliases` SQL ловить compound-форму на **обох** боках
  пари (canonical OR orphan) і обчислює aliases від тієї сторони, яка
  має компаунд.
- Після деплою + `systemctl restart` існуючі 17 orphan-рядків
  автоматично змерджаться у відповідні canonical-и (через існуючий
  виклик `dedupeBreweryAliases(db, log)` у `src/index.ts:29`).
- Майбутні ontap-scrape-и більше не створюють orphan-дублі цього
  типу — matcher тепер їх знаходить.

## Non-goals

- **Нові розділювачі** (`X & Y`, `X | Y`, `X + Y`). YAGNI — у проді
  таких форм у broварних назв немає.
- **Окремий backfill-скрипт.** Існуючий `dedupeBreweryAliases` уже
  викликається при кожному `main()`; restart post-deploy достатньо.
- **Метрики/моніторинг** для dedupe-job. Існуючий `log.info({pairs})`
  достатній.
- **UI для ручного merge** orphan-кандидатів, у яких aliases не
  перекриваються з жодним canonical. Якщо такі будуть — окрема
  ітерація.
- **Перейменування** `dedupeBreweryAliases` чи перенесення в інший
  модуль. Назва й так загальна, не фіксована на «slash».

## Architecture

### 1. `src/domain/matcher.ts` — slash regex

Зміна одного рядка (поточний рядок 31):

```ts
// before
const slashParts = brewery.includes(' / ') ? brewery.split(' / ') : [brewery];

// after
const slashRegex = /\s*\/\s*/;
const slashParts = slashRegex.test(brewery) ? brewery.split(slashRegex) : [brewery];
```

Обробляє всі форми: `X/Y`, `X / Y`, `X/ Y`, `X /Y`. Trailing
`Brewery`-суфікс на останньому слайсі вже обробляється
`normalizeBrewery` (воно strip-ує цей суфікс), тож додатково нічого
робити не треба.

Коментар на рядках 21-25 оновлюється — не фіксує «X / Y» як єдиний
spaced-form, описує slash-form загально.

`matchBeer` нічого не міняє: він уже викликає `breweryAliases`
симетрично на обох боках (`input.brewery` і кожен `c.brewery` у
catalog) — `brewerySetsOverlap(breweryAliases(c.brewery),
inputAliases)`. Тобто виправлення `breweryAliases` автоматично:
- виправляє exact-match гілку (рядки 61-67),
- виправляє fuzzy fallback pool (рядки 82-85).

### 2. `src/jobs/dedupe-brewery-aliases.ts` — симетричний SQL + side-вибір у JS

**SQL.** Замінити WHERE:

```sql
-- before:
WHERE a.untappd_id IS NOT NULL
  AND b.untappd_id IS NULL
  AND (a.brewery LIKE '% / %'
       OR (a.brewery LIKE '%(%' AND a.brewery LIKE '%)%'))

-- after:
WHERE a.untappd_id IS NOT NULL
  AND b.untappd_id IS NULL
  AND (
    a.brewery LIKE '%/%'
    OR (a.brewery LIKE '%(%' AND a.brewery LIKE '%)%')
    OR b.brewery LIKE '%/%'
    OR (b.brewery LIKE '%(%' AND b.brewery LIKE '%)%')
  )
```

`'%/%'` без пробілів — ловить spaced і unspaced slash однаково. Парен-
форма без змін.

**Структура `PairCandidate`.** Додаємо `orphan_brewery` (raw, не
нормалізована) у SQL SELECT:

```ts
interface PairCandidate {
  canonical_id: number;
  canonical_brewery: string;
  orphan_id: number;
  orphan_brewery: string;         // ← новий
  orphan_norm_brewery: string;
}
```

SQL SELECT отримує додатковий `b.brewery AS orphan_brewery`.

**JS overlap-логіка.** Замінити цикл, що обчислює aliases лише від
canonical-side:

```ts
// before:
for (const c of candidates) {
  const aliases = new Set(breweryAliases(c.canonical_brewery));
  if (!aliases.has(c.orphan_norm_brewery)) continue;
  if (!pairsByOrphan.has(c.orphan_id)) pairsByOrphan.set(c.orphan_id, c);
}

// after:
for (const c of candidates) {
  // Compute aliases from both sides — compound form can be on either:
  // canonical (PR-A: 'Kemker (Brauerei J. Kemker)') or orphan
  // (PR-C: 'Sady/Beer Bacon and Liberty Brewery').
  const canonicalAliases = new Set(breweryAliases(c.canonical_brewery));
  const orphanAliases = breweryAliases(c.orphan_brewery);
  const overlap = orphanAliases.some((x) => canonicalAliases.has(x));
  if (!overlap) continue;
  if (!pairsByOrphan.has(c.orphan_id)) pairsByOrphan.set(c.orphan_id, c);
}
```

Симетрична overlap-перевірка: пара мерджиться лише якщо `breweryAliases`
обох сторін перетинаються хоча б одним елементом. Ця перевірка
автоматично відфільтровує ambiguous кейси (orphan 399 з aliases
`['miejski stargard', 'nieczajna']` не має overlap з жодним з 4
canonical-кандидатів за `normalized_name='grodziskie'` — Genys, Nepo,
Sady, Lubrow — тому лишається не змерджений).

`pairsByOrphan.set(...) if not in map` гарантує — навіть якщо SQL
повертає кілька canonical-кандидатів для одного orphan, у map
потрапляє перший за id (детерміновано).

### 3. `matchBeer` (insert-time prevention)

Жодних окремих змін. `matchBeer` уже використовує
`breweryAliases` симетрично, тож фікс §1 автоматично робить:

```
input.brewery = "Sady/Beer Bacon and Liberty Brewery"
  → inputAliases = {'sady beer bacon and liberty', 'sady', 'beer bacon and liberty'}

catalog candidate 12286: brewery = "Browar Sady"
  → aliases = {'sady'}

brewerySetsOverlap → true → exact match → return id=12286
```

Тобто наступний ontap-scrape, що бачить `Sady/Beer Bacon and Liberty
Brewery Midnight Mass`, знаходить canonical 12286 і НЕ створює новий
orphan. Це закриває джерело проблеми, а dedupe-job чистить історичний
backlog.

### 4. Backfill — автоматичний

`dedupeBreweryAliases(db, log)` уже викликається на старті в
`src/index.ts:29`. Після `git pull && ./deploy/deploy.sh` (`deploy.sh`
сам робить `systemctl restart warsaw-beer-bot`) існуючі 17 orphan-
рядків автоматично змерджаться при першому boot. Очікуваний лог:

```
dedupe-brewery-aliases: merged N orphan ontap rows into canonical Untappd rows
```

де N ≤ 17 (деякі orphan-и з ambiguity-кейсу 399-style можуть
лишитись).

Безпека: операції в транзакції; orphan-рядки не мають `untappd_id`,
тому втрата інформації нульова (`match_links` і `checkins` переносяться
на canonical).

## Тести (Jest)

### `src/domain/matcher.test.ts` — нові кейси

1. **`breweryAliases` на bare-slash**: input
   `'Sady/Beer Bacon and Liberty Brewery'` → результат містить `'sady'`
   і `'beer bacon and liberty'` (після `normalizeBrewery`). Повний
   normalized теж присутній як index 0.
2. **`breweryAliases` на mixed-spacing**: input
   `'Nieczajna/ Monsters Brewery'` (slash з правим пробілом, без
   лівого) → `['nieczajna', 'monsters']` після нормалізації.
3. **`breweryAliases` регресія для spaced-form**: input
   `'AleBrowar / Poppels Bryggeri'` → той самий результат, що до
   зміни.
4. **`matchBeer` integration**: catalog містить canonical
   `{brewery: 'Browar Sady', name: 'Midnight Mass'}`; input
   `{brewery: 'Sady/Beer Bacon and Liberty Brewery', name: 'Midnight Mass'}`
   → exact match на canonical (підтверджує що insert-time prevention
   працює).

### `src/jobs/dedupe-brewery-aliases.test.ts` — нові кейси

1. **Compound-on-orphan, unspaced slash** (PR-C основний сценарій):
   canonical = `Browar Sady` + `untappd_id=X`, orphan =
   `Sady/Beer Bacon and Liberty Brewery` без `untappd_id`, обидва з
   `normalized_name='midnight mass'`. Перед dedupe — `match_links`
   вказує на orphan. Після — `match_links`, `checkins` перенаправлені
   на canonical; orphan видалений; `pairsMerged: 1`.
2. **Compound-on-orphan, mixed-spacing**: orphan
   `Nieczajna/ Monsters Brewery`, canonical `Browar Monsters` — той
   самий мерж-патерн, перевіряє що `'%/%'` SQL ловить без жорсткої
   фіксації на пробіли.
3. **Ambiguity / no overlap**: orphan з aliases, що не перекриваються
   з жодним canonical-кандидатом за тим самим `normalized_name`.
   Orphan лишається — `pairsMerged: 0`.
4. **Регресія PR-A**: compound-on-canonical (Kemker form) сценарій
   далі мерджиться правильно (поточний PR-A test уже це покриває; не
   видаляти).

### Незмінні тести

`refresh-untappd.test.ts`, `refresh-ontap.test.ts`, `filters.test.ts`,
`newbeers-build.test.ts`, `pubs-build.test.ts`, `refresh.test.ts`,
storage-тести — не торкаємось.

## File-level зміни (summary)

| Файл | Тип |
|---|---|
| `src/domain/matcher.ts` | модифікація: regex split + оновлений коментар |
| `src/domain/matcher.test.ts` | додати 4 кейси (bare-slash, mixed, регресія spaced, matchBeer integration) |
| `src/jobs/dedupe-brewery-aliases.ts` | модифікація: SQL WHERE, `PairCandidate.orphan_brewery`, alias-overlap логіка |
| `src/jobs/dedupe-brewery-aliases.test.ts` | додати 3 кейси (orphan-compound spaced/unspaced + ambiguity); зберегти PR-A регресію |
| `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` | додати буллет у §10 footguns про bare-slash assumption (master spec) |

Сумарно ~80 LOC включно з тестами. Без міграцій, без storage-helper-
ів, без локалізації, без cron-впливу.

## Risks / Footguns

- **Regex `/\s*\/\s*/` ловить URL-подібні рядки в назвах броварних.**
  Малоймовірно для крафтових пивних брендів. Якщо колись з'явиться
  паб з `brewery = 'http://example.com'` — фікс окремо (negative
  lookbehind).
- **Імена типу `AC/DC Brewing`**: розщепляться на `AC` + `DC`. Обидва
  короткі — теоретично false-positive overlap з іншими broварнями
  (`browar ac` etc.). Поточних таких немає в БД (перевірено). Якщо
  з'явиться — додати мінімальний `length >= 3` filter в
  `breweryAliases` post-split.
- **Backfill при boot мерджить ≤17 рядків.** Це безпечно (транзакція),
  але varto спостерігати лог першого старту post-deploy. Якщо лог
  скаже `pairs: 0` коли очікуємо 17 — мати інструкцію перевірити
  matcher unit-test пройшов і `breweryAliases('Sady/...')`-стиль
  справді повертає split.
- **Master spec §10 footgun bullet** про bare-slash assumption треба
  додати в `2026-04-22-warsaw-beer-bot-design.md` (master design,
  поряд з PR-A paren-alias bullet і PR-B two-source drunk model
  bullet). Це частина плану.
