# /newbeers <pub> filter + /pubs discovery command

**Date:** 2026-05-25
**Branch:** `feat/newbeers-pub-filter`

## Background

Юзер часто хоче знати, що нового конкретно в одному пабі, без
скролу через агрегований топ-15. Сьогодні `/newbeers` приймає тільки
агреговану форму: усі останні snapshot-и по всіх пабах, групування по
beer-id, ранжування по rating, з показом до трьох пабів на групу.

Цей дизайн додає опціональний positional-параметр до `/newbeers`, що
фільтрує паби за підрядком назви, плюс discovery-команду `/pubs` зі
списком доступних назв. Без `/pubs` юзер не має надійного способу
дізнатись, що саме можна підставити після `/newbeers` (якщо під його
persistent-фільтри зараз порожньо, голий `/newbeers` поверне
`newbeers.empty` і не дасть жодних назв).

## Goals

- `/newbeers <substring>` повертає той самий формат, що сьогодні, але
  обмежений пабами, чия назва містить `<substring>` (case-insensitive,
  trim). Persistent user filters (rating/abv/styles) лишаються в силі.
- `/pubs` повертає компактний відсортований по алфавіту список усіх
  назв пабів у базі, плюс підказку про використання `/newbeers <name>`.
- На no-match `/newbeers <substring>` повертає чітке повідомлення з
  оригінальним query і вказівкою на `/pubs`.
- `/refresh` autorun лишається тим самим (агрегований), бо autorun не
  має аргументів.

## Non-goals

- **Inline-клавіатура з пабами.** Не запитували; positional substring
  достатньо.
- **Fuzzy match / Levenshtein-suggestions.** На no-match просто
  посилаємось на `/pubs`.
- **Slug як ідентифікатор.** Slug нікому не відображається; substring
  назви — єдиний UX-релевантний ключ.
- **Метадані в `/pubs`** (кількість тапів, age останнього snapshot).
  YAGNI — `/pubs` має лишатись discovery-командою, не дешбордом.
- **Filter-параметр у `/route`.** Не у скоупі цієї ітерації.
- **Зміни схеми, міграцій, storage-helper-ів.** Усе на read-side.

## Architecture

### 1. Розширений контракт `buildNewbeersMessage`

`src/bot/commands/newbeers-build.ts` сьогодні повертає `string | null`.
Розширюємо до union, щоб caller міг розрізнити «нічого під фільтр»
від «паб не знайдений»:

```ts
export type NewbeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'empty' }
  | { kind: 'pub_not_found'; query: string };

export interface NewbeersDeps {
  db: DB;
  telegramId: number;
  locale: Locale;
  t: Translator;
  pubQuery?: string;   // undefined = no filter; ' '/empty after trim = same
}

export function buildNewbeersMessage(deps: NewbeersDeps): NewbeersResult;
```

**Чому окремий `pub_not_found`-кейс:** `/newbeers cuda` коли «cuda» не
матчить нічого — це інша ситуація, ніж «всі паби, фільтри ок, але
ніяких нових пив». Перша — помилка вводу юзера, друга — стан світу.
Зливати в один `empty`-кейс приховало б фідбек про опечатку.

### 2. Логіка фільтрування у `buildNewbeersMessage`

Псевдокод інтеграції — змінюються тільки початок функції і
скіпування снапшотів у головному циклі:

```ts
const pubs = new Map(listPubs(db).map((p) => [p.id, p]));

const q = deps.pubQuery?.trim().toLowerCase();
let matchedIds: Set<number> | null = null;
if (q) {
  const matched = [...pubs.values()].filter(
    (p) => p.name.toLowerCase().includes(q),
  );
  if (matched.length === 0) {
    return { kind: 'pub_not_found', query: deps.pubQuery! };
  }
  matchedIds = new Set(matched.map((p) => p.id));
}

const candidates: CandidateTap[] = [];
for (const snap of latestSnapshotsPerPub(db)) {
  if (matchedIds && !matchedIds.has(snap.pub_id)) continue;
  const pub = pubs.get(snap.pub_id);
  if (!pub) continue;
  // ... існуючий цикл збору candidates без змін ...
}

const text = formatGroupedBeers(rankGroups(groupTaps(candidates)), locale, t);
return text ? { kind: 'ok', html: text } : { kind: 'empty' };
```

`trim().toLowerCase()` — мінімальна нормалізація; жодного нормалізатора
з `src/domain/normalize.ts`, бо тут різна доменна семантика (нам не
треба «згортати» Polish-ł у l, як для beer-name matching).

`pubQuery: ' '` (whitespace-only) після `trim()` стає порожнім рядком,
що falsy → інтерпретуємо як «нема фільтра». Це робить handler
`split(' ').slice(1).join(' ').trim()` безпечним без додаткових
guard-ів.

### 3. Handler `/newbeers`

`src/bot/commands/newbeers.ts` (зараз — тонкий wrapper на 12 рядків):

```ts
newbeersCommand.command('newbeers', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const result = buildNewbeersMessage({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    locale: ctx.locale,
    t: ctx.t,
    pubQuery: arg || undefined,
  });
  switch (result.kind) {
    case 'ok':
      await ctx.replyWithHTML(result.html);
      return;
    case 'empty':
      await ctx.reply(ctx.t('newbeers.empty'));
      return;
    case 'pub_not_found':
      await ctx.reply(ctx.t('newbeers.pub_not_found', { query: result.query }));
      return;
  }
});
```

Аргумент-парсинг той самий, що в `link.ts:15` (а не `split[1]` як у
`route.ts:36`, бо назви пабів містять пробіли — наприклад «Cuda na
Kiju»).

### 4. `/refresh` autorun: маленьке оновлення

Postrun-closure у `src/bot/commands/refresh.ts` сьогодні робить:

```ts
const text = postRun({ db, telegramId, locale, t });
if (text) { await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' }); }
```

Стає:

```ts
const result = postRun({ db, telegramId, locale, t });
if (result.kind === 'ok') {
  await telegram.sendMessage(chatId, result.html, { parse_mode: 'HTML' });
}
```

Autorun ніколи не передає `pubQuery` (поле опціональне), тож
`pub_not_found` із нього не утвориться — гілку `else` свідомо не
обробляємо. `empty` — мовчимо, як і сьогодні.

Сигнатура `postRun` у `createRefreshCommand` зміниться з
`(deps: NewbeersDeps) => string | null` на
`(deps: NewbeersDeps) => NewbeersResult`. `index.ts` передає
`buildNewbeersMessage` напряму — типи лягають без додаткових змін.

### 5. Команда `/pubs`

Новий модуль `src/bot/commands/pubs-build.ts` за тим самим патерном,
що `newbeers-build.ts` (pure-функція без `ctx`):

```ts
export interface PubsDeps { db: DB; t: Translator; }

export function buildPubsMessage(deps: PubsDeps): string {
  const pubs = listPubs(deps.db).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (pubs.length === 0) return deps.t('pubs.empty');
  const lines = pubs.map((p) => `• ${escapeHtml(p.name)}`);
  return [deps.t('pubs.header'), '', ...lines, '', deps.t('pubs.hint')].join('\n');
}
```

`escapeHtml` імпортуємо з `./newbeers-format.ts` (уже експортується,
рядок 75) — без копіювання.

Handler-обгортка `src/bot/commands/pubs.ts`:

```ts
export const pubsCommand = new Composer<BotContext>();

pubsCommand.command('pubs', async (ctx) => {
  const text = buildPubsMessage({ db: ctx.deps.db, t: ctx.t });
  await ctx.replyWithHTML(text);
});
```

`pubs.empty` потрібен для свіжо-задеплоєного інстансу до першого
`refreshOntap` — інакше юзер бачив би просто `Доступні паби:\n\n\n…`.

### 6. Локалізація

Нові ключі у `src/i18n/types.ts` (інтерфейс `Messages`):

```
'newbeers.pub_not_found': string;   // {query}
'pubs.header': string;
'pubs.empty': string;
'pubs.hint': string;
```

Реалізації в `src/i18n/locales/{uk,pl,en}.ts` (тексти готові до
імплементації; копія, звісно, відкрита до полірування у PR-рев'ю):

**uk**
- `newbeers.pub_not_found`: `Паб «{query}» не знайдено. /pubs покаже доступні.`
- `pubs.header`: `Доступні паби:`
- `pubs.empty`: `У базі ще нема пабів — спочатку має пройти /refresh.`
- `pubs.hint`: `Підказка: /newbeers <частина назви> покаже новинки тільки в матчених пабах.`

**pl**
- `newbeers.pub_not_found`: `Nie znaleziono pubu „{query}". /pubs pokaże dostępne.`
- `pubs.header`: `Dostępne puby:`
- `pubs.empty`: `W bazie nie ma jeszcze pubów — najpierw musi się wykonać /refresh.`
- `pubs.hint`: `Podpowiedź: /newbeers <fragment nazwy> pokaże nowości tylko w dopasowanych pubach.`

**en**
- `newbeers.pub_not_found`: `Pub "{query}" not found. /pubs lists available ones.`
- `pubs.header`: `Available pubs:`
- `pubs.empty`: `No pubs in the database yet — wait for the first /refresh.`
- `pubs.hint`: `Tip: /newbeers <name fragment> shows new beers only in matching pubs.`

Існуючий рядок `app.start` (uk/pl/en) уже перелічує команди — додаємо
`/pubs` як п'ятий пункт і згадуємо `<pub>` як опціональний аргумент
`/newbeers`. Це частина PR, не окремий цикл.

### 7. Реєстрація `/pubs`

`src/index.ts` — додати `import { pubsCommand }` і поставити в
`bot.use(...)` поряд із `newbeersCommand` (порядок не критичний, але
групуємо логічно).

## Тести (Jest)

### `src/bot/commands/newbeers-build.test.ts` — модифікація

Існуючі 4 тести лишаються концептуально, але оновлюємо expects:

- `null` → `{ kind: 'empty' }`.
- ненульовий рядок → `expect(result.kind).toBe('ok'); expect(result.html).toContain(...)`.

Додаємо 4 нових кейси для `pubQuery`:

1. **Substring case-insensitive match (один паб):** дві пабі (Pub A,
   Pub B), у кожній по новинці. `pubQuery: 'a'` → `kind: 'ok'`, html
   містить пиво з Pub A і НЕ містить пиво з Pub B.
2. **Substring матчить кілька пабів:** Pub A і Pub Alpha, обидва з
   одним і тим самим пивом. `pubQuery: 'Pub'` → `kind: 'ok'`, в групі
   обидва паби в `g.pubs`.
3. **No match:** `pubQuery: 'nonexistent'` → `{ kind: 'pub_not_found',
   query: 'nonexistent' }`.
4. **Whitespace-only query:** `pubQuery: '   '` → поведінка як без
   параметра (один із існуючих позитивних кейсів виконується). Регресія-
   захист на `trim()`.

### `src/bot/commands/refresh.test.ts` — мікро-оновлення

`runRefreshPipeline` сам не імпортує `NewbeersResult`; його стаб
`postRun: () => Promise<void>` лишається `Promise<void>`. Зміна типу
торкається тільки `createRefreshCommand`-публічної сигнатури, а не
тестів `runRefreshPipeline`. Тести лишаються без змін.

### `src/bot/commands/pubs-build.test.ts` — новий

Три кейси:

1. **Empty DB:** `listPubs` порожній → текст містить `pubs.empty`
   рядок.
2. **Several pubs sorted alphabetically:** додаємо `Cuda`, `Bar`,
   `Alfa`. Перевіряємо порядок у вихідному тексті (`'Alfa'`-рядок
   перед `'Bar'`-рядком перед `'Cuda'`-рядком), наявність `pubs.header`
   і `pubs.hint`.
3. **HTML-escape:** додаємо паб з назвою `Cuda & <Co>`. Перевіряємо,
   що у виводі присутнє `Cuda &amp; &lt;Co&gt;` (а не сирий `<`).

### Незмінні тести

`newbeers-format`, `route-format`, `refresh-untappd`, `dedupe`,
`matcher`, `lang`, всі storage-тести — не торкаємось.

## USER-GUIDE update

`docs/USER-GUIDE.md` — короткий додатковий абзац біля існуючої секції
`/newbeers`:

> `/newbeers <частина назви>` фільтрує вивід по пабах, чия назва
> містить вказаний підрядок (case-insensitive). `/pubs` показує
> повний список доступних назв.

## File-level зміни (summary)

| Файл | Тип |
|---|---|
| `src/bot/commands/newbeers-build.ts` | модифікація: `pubQuery?`, `NewbeersResult` |
| `src/bot/commands/newbeers-build.test.ts` | модифікація: апдейт 4 існуючих + 4 нових |
| `src/bot/commands/newbeers.ts` | модифікація: parse arg + switch на `result.kind` |
| `src/bot/commands/refresh.ts` | модифікація: postRun closure → `if kind === 'ok'`; типова сигнатура `postRun?` |
| `src/bot/commands/pubs.ts` | новий: thin command wrapper |
| `src/bot/commands/pubs-build.ts` | новий: pure `buildPubsMessage` |
| `src/bot/commands/pubs-build.test.ts` | новий: 3 кейси |
| `src/i18n/types.ts` | модифікація: +4 ключі в `Messages` |
| `src/i18n/locales/uk.ts` / `pl.ts` / `en.ts` | модифікація: +4 рядки кожен + апдейт `app.start` |
| `src/index.ts` | модифікація: реєстрація `pubsCommand` |
| `docs/USER-GUIDE.md` | модифікація: один абзац |

Без міграцій, без storage-helper-ів, без cron-впливу.

## Risks / Footguns

- **Підрядок-матч може давати несподівано широкі результати** (напр.
  `/newbeers a` матчить майже все). Це by design «фільтр-семантики»; на
  практиці юзер швидко звузить query побачивши, що повертається.
- **Назви пабів з пробілами в кінці.** `trim()` на pub-side не робимо —
  довіряємо, що `upsertPub` зберігає так, як прийшло. Якщо в БД
  раптом є запис із trailing space, substring-матч усе одно
  спрацює правильно (наш query теж trim-нутий).
- **`app.start` тепер довший.** На 5+ пунктах ще читабельно;
  переробляти у скорочений хелп-формат — окрема ітерація.
- **`/pubs` без metadata може здатись беззмістовним.** Якщо так — це
  YAGNI-call, і додати «(20 пабів, останній скан N годин тому)» — одна
  PR-ітерація пізніше.
