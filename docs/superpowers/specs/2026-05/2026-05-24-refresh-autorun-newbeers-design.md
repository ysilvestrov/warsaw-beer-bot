# /refresh auto-runs /newbeers on success

**Date:** 2026-05-24
**Branch:** `feat/refresh-autorun-newbeers`

## Background

Сьогодні щоб дізнатись, що нового з'явилось на кранах після оновлення
даних, юзер мусить руками викликати дві команди підряд: `/refresh`
(чекати кілька хвилин), потім `/newbeers`. Це передбачуваний наступний
крок у 100% випадків, коли refresh був успішний — рутинне UX-тертя,
яке можна прибрати.

`/refresh` запускає у background-блоці послідовно `refreshOntap` та
`refreshAllUntappd` (див. `src/index.ts:44-47`). Обидва sweeps впливають
на те, що покаже `/newbeers`: `refreshOntap` оновлює `taps`/`snapshots`
(вхід для кандидатів), `refreshAllUntappd` оновлює `untappd_had`
(вхід для `triedBeerIds`, який виключає вже пробите). Отже саме після
**успішного** завершення refresh релевантно показати свіжі новинки.

## Goals

- Після успішного `/refresh` бот автоматично шле користувачу той самий
  HTML, який повернула б ручна `/newbeers`, окремим повідомленням після
  `refresh.done`.
- Якщо новинок під поточні фільтри юзера немає — автозапуск **мовчить**
  (статус `refresh.done` уже є; другий «нічого нового» був би шумом).
- Якщо `/refresh` впав (`refresh.failed`) — автозапуск **не виконується**:
  юзер бачить помилку і вирішує сам.
- Логіка `/newbeers` лишається в одному місці; ручний виклик і автозапуск
  ділять той самий код.

## Non-goals

- **Cron-варіанти refresh** (`src/index.ts:51-56`). Вони не мають чату
  юзера й не проходять через `createRefreshCommand` — автозапуск їх не
  торкається.
- **Per-user opt-out/setting.** Не запитували; додамо лише якщо буде
  фідбек, що автозапуск заважає.
- **Об'єднання `refresh.done` із порожнім newbeers в одне повідомлення.**
  Свідомо обрано «мовчати на порожньо», а не модифікувати рядок
  `refresh.done`.
- **Локалізаційні зміни.** Жодних нових ключів у `src/i18n/locales/*` не
  додаємо — авто-повідомлення використовує існуючу логіку форматування
  newbeers.

## Architecture

### 1. Новий чистий модуль: `src/bot/commands/newbeers-build.ts`

Витягуємо тіло хендлера `/newbeers` (`src/bot/commands/newbeers.ts:19-51`)
у pure-функцію без залежності від `ctx`:

```ts
import type Database from 'better-sqlite3';
import type { Locale, Translator } from '../../i18n/types';

export interface NewbeersDeps {
  db: Database.Database;
  telegramId: number;
  locale: Locale;
  t: Translator;
}

export function buildNewbeersMessage(deps: NewbeersDeps): string | null;
```

**Контракт повернення:**

- `string` — готовий HTML-блок (як зараз будує `formatGroupedBeers(...)`),
  непорожній. Caller шле його як є з `parse_mode: 'HTML'`.
- `null` — під поточні фільтри юзера немає жодного кандидата. Caller
  вирішує, що з цим робити (див. §2 і §4).

Тіло — той самий пайплайн, що зараз у хендлері: `triedBeerIds → getFilters
→ listPubs → latestSnapshotsPerPub → tapsForSnapshotWithBeer →
filterInteresting → groupTaps → rankGroups → formatGroupedBeers`. Жодних
змін у самих storage/domain-функціях.

**Сигнал «порожньо»** — `null`, коли результат `formatGroupedBeers(...)`
falsy (порожній рядок). Це точне дзеркало поточної fallback-умови в
`newbeers.ts:52` (`text || ctx.t('newbeers.empty')`), щоб ручна
поведінка лишилася побайтово ідентичною. Реалізація — `return text ||
null;` після `formatGroupedBeers`.

### 2. Рефактор `src/bot/commands/newbeers.ts`

Хендлер стає тонкою обгорткою:

```ts
import { buildNewbeersMessage } from './newbeers-build';

newbeersCommand.command('newbeers', async (ctx) => {
  const text = buildNewbeersMessage({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    locale: ctx.locale,
    t: ctx.t,
  });
  await ctx.replyWithHTML(text ?? ctx.t('newbeers.empty'));
});
```

Поведінка ручного `/newbeers` лишається побайтово ідентичною: при
порожньому результаті йде `newbeers.empty`, при непорожньому — той
самий рендер, що й сьогодні.

### 3. Розширення `createRefreshCommand`

Сигнатура в `src/bot/commands/refresh.ts:25` отримує опціональний
другий параметр:

```ts
import type { NewbeersDeps } from './newbeers-build';

export function createRefreshCommand(
  run: (notify: ProgressFn) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => string | null,
) { ... }
```

`refresh.ts` свідомо **не** імпортує `buildNewbeersMessage` напряму —
модуль refresh не повинен знати про конкретну команду. Композиція
відбувається у `src/index.ts`:

```ts
createRefreshCommand(
  async (notify) => {
    await refreshOntap({ db, log, http, geocoder, onProgress: notify });
    await refreshAllUntappd({ db, log, http, onProgress: notify });
  },
  buildNewbeersMessage,
)
```

### 4. Background-блок refresh

До detach (зараз у `refresh.ts:36-40` захоплюються
`chatId, messageId, telegram, log, t`) додаємо ще три захоплення:
`db = ctx.deps.db`, `telegramId = ctx.from.id`, `locale = ctx.locale`.
Це необхідно з тієї ж причини, з якої вже захоплюється все інше: ctx
живе менше, ніж background-проміс.

Success-гілка в `refresh.ts:54-62`:

```ts
try {
  await run(notify);
  await notify(t('refresh.done'), { force: true });

  if (postRun) {
    try {
      const text = postRun({ db, telegramId, locale, t });
      if (text) {
        await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      }
    } catch (e) {
      log.error({ err: e }, 'refresh post-run failed');
    }
  }
} catch (e) {
  log.error({ err: e }, 'refresh failed');
  await notify(t('refresh.failed'), { force: true });
}
```

**Порядок:** `refresh.done` редагується **перед** post-run, щоб статусне
повідомлення відразу переключилось на «готово», а перелік новинок
прийшов окремою відповіддю нижче.

**Best-effort семантика post-run:** вкладений `try/catch` локалізує
будь-яку помилку всередині `buildNewbeersMessage` чи `sendMessage`. Лог
пишемо, але користувача не турбуємо — refresh вже формально успішний,
і ламати UX через збій авто-додатку було б непропорційно. Outer
`catch (e)` лишається лише для збоїв самого `run(notify)`.

### 5. Cron-ізоляція

Cron-callsites (`src/index.ts:51-56`) звертаються до `refreshOntap` /
`refreshAllUntappd` напряму, минаючи `createRefreshCommand`, тож вони
автоматично поза скоупом. Жодних ризиків відправити повідомлення
«нікому».

## Тести (Jest)

### `src/bot/commands/newbeers-build.test.ts` (новий)

- **Empty case:** in-memory DB без снапшотів → `buildNewbeersMessage`
  повертає `null`. Це контракт, від якого залежить «мовчання на порожньо»
  у автозапуску.
- **Non-empty case:** in-memory DB зі снапшотом і хоч одним підходящим
  тапом → повертає ненульовий рядок, що містить очікувану броварню/назву.

Фікстури — той самий шаблон, що в `src/jobs/refresh-untappd.test.ts`
(in-memory `Database`, ручні `INSERT`, виклик функції).

### `src/bot/commands/refresh.test.ts` (розширити)

Поточний файл тестує лише `makeThrottledProgress`. Додаємо опис
`createRefreshCommand` із моком Telegraf-ctx, fake `telegram`,
`run`-стабом і `postRun`-стабом:

1. **`run` resolves + `postRun` повертає рядок** → `editMessageText` для
   `refresh.done` викликано ДО `sendMessage`; `sendMessage` викликано
   рівно один раз із цим рядком і `parse_mode: 'HTML'`.
2. **`postRun` повертає `null`** → `editMessageText` для `refresh.done`
   викликано; `sendMessage` НЕ викликано взагалі.
3. **`postRun` кидає виняток** → лог записано, status лишається
   `refresh.done`, ніяких додаткових повідомлень.
4. **`run` rejects** → `refresh.failed` надіслано, `postRun` НЕ
   викликано.
5. **`postRun === undefined`** → поведінка тотожна сьогоднішній
   (backward-compat).

### Незмінні тести

`route-format`, `newbeers-format`, `refresh-untappd`, `dedupe`,
`matcher` — не торкаємось. `/newbeers` handler-теста не існує сьогодні
(вкриті тільки форматери), тому нічого «переписувати» з нього не треба.

## File-level зміни (summary)

| Файл | Тип |
|---|---|
| `src/bot/commands/newbeers-build.ts` | новий |
| `src/bot/commands/newbeers-build.test.ts` | новий |
| `src/bot/commands/newbeers.ts` | рефактор: тонкий wrapper |
| `src/bot/commands/refresh.ts` | додати `postRun?` параметр + capture `db/telegramId/locale` + post-run блок |
| `src/bot/commands/refresh.test.ts` | додати describe для `createRefreshCommand` |
| `src/index.ts` | передати `buildNewbeersMessage` другим аргументом у `createRefreshCommand` |

Жодних змін у міграціях, локалях, storage- чи domain-шарах.

## Risks / Footguns

- **Подвійне «вітання» при `refresh.done` + великий список.** Telegram
  іноді редагує статусне повідомлення з помітною затримкою порівняно
  з новим `sendMessage`. Це косметика, не функціональна проблема —
  обидва повідомлення прийдуть, порядок збережеться завдяки `await`
  перед `sendMessage`.
- **Race з cron-refresh поки юзерський /refresh у польоті.** Cron може
  модифікувати ту саму DB між `await run(notify)` і `postRun(...)`.
  Це нешкідливо: `buildNewbeersMessage` — pure read, отримає
  найсвіжіший стан, що насправді бажано.
- **Якщо `postRun` колись зробити async** — наразі sync (повертає
  `string | null` напряму). Не змінюємо це передчасно; якщо в
  майбутньому з'явиться async-варіант, сигнатуру розширимо тоді.
- **5-хвилинний cooldown `/refresh` не змінюється.** Автозапуск — це
  додаткове повідомлення в межах того ж виклику, не окрема команда;
  жодних змін у `COOLDOWN_MS`/`lastCall` логіці.
