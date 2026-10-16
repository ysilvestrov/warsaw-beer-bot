# План: присутність, ручні відмітки, стіл і «моє» (PR 2, ядро)

Спека: `docs/superpowers/specs/2026-10/2026-10-15-fest-queue-reality-design.md` §PR 2 (з поправкою
16.10: келих чекає тих, чий інтервал присутності перетинає 40 хв після «Взяв»).

Гейт кожної задачі: `npm test && npm run typecheck` (25 відомих падінь середовища — 24 у `scripts/`,
1 у `src/jobs/host-patch.test.ts` — ідентичні на чистому `main`). Міграція — expand, без
`[deploy:hold]`: старий реліз нових таблиць не читає й працює як до PR.

## Модель

```
події присутності (явні start/end + неявний старт від своєї дії)
  → інтервали [від, до] на учасника
келих (added_at) → очікувані = ті, чий інтервал перетинає [added_at, added_at + 40 хв]
очікуваний закрив келих = свій чекін цього пива (як зараз) або свій ☑️
стіл      = added_at ≥ now − 40 хв і хтось очікуваний не закрив
queue all = хтось очікуваний не закрив
drank     = я очікуваний і я не закрив
```

## Задача 1 — міграція 51 і сховище

`src/storage/schema.ts` — v51 (`IF NOT EXISTS`, як v50):

```sql
CREATE TABLE IF NOT EXISTS fest_presence (
  team_id INTEGER NOT NULL REFERENCES fest_teams(id) ON DELETE CASCADE,
  telegram_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'end')),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fest_presence_team ON fest_presence (team_id, telegram_id, at);
CREATE TABLE IF NOT EXISTS fest_glass_marks (
  queue_id INTEGER NOT NULL REFERENCES fest_queue(id) ON DELETE CASCADE,
  telegram_id INTEGER NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (queue_id, telegram_id)
);
```

Голова схеми 51 — у тесті, що фіксує голову (один тест, як велить CLAUDE.md); `schema-v51.test.ts` —
версія 51 записана (`WHERE version = 51`), обидві таблиці, CHECK на `kind`, каскад марки з келихом.

`src/storage/fest_presence.ts`:

```ts
export interface PresenceEvent { telegramId: number; kind: 'start' | 'end'; at: string }
export function addPresence(db, p: { teamId; telegramId; kind; at }): void;
/** Явні події команди + неявні старти: свій fest_queue.added_at і свій авторський venue_checkins на локаціях фесту. */
export function presenceEvents(db, p: { festId; teamId; sinceIso }): PresenceEvent[];
```

`src/storage/fest_queue.ts`: `markGlass(db, { queueId, telegramId, at }): boolean` (`INSERT OR
IGNORE`, true — нова), `unmarkGlass(db, { queueId, telegramId }): boolean`, `glassMarks(db, teamId):
{ queueId; telegramId }[]`.

Тести: події обох видів і неявні старти з обох джерел (venue_checkins лише авторські, лише локації
фесту, лише цей учасник без урахування регістру); марка двічі — одна; зняти неіснуючу — false;
`removeGlass` прибирає марки каскадом.

## Задача 2 — домен: інтервали й закриття

`src/domain/fest/presence.ts`:

```ts
export const TABLE_MS = 40 * 60 * 1000;
export interface Interval { from: number; to: number }
/** Події учасника в часі: start/неявний старт відкриває (якщо закрито), end закриває; відкритий закривається кінцем сесії, в якій почався (перша сесія з end_at ≥ from), або в мить старту, якщо сесій далі нема. */
export function presenceIntervals(events: PresenceEvent[], sessions: FestSession[]): Map<number, Interval[]>;
/** Очікувані на келих: інтервал перетинає [addedAt, addedAt + TABLE_MS] (межі включно). */
export function expectedOn(intervals: Map<number, Interval[]>, addedAt: string): number[];
```

`src/domain/fest/closure.ts`: `ClosureItem` дістає `expected: number[]` і `marked: number[]`;
результат на учасника — `{ checkinId } | { marked: true } | null`, лише для очікуваних. Учасник,
який келих відмітив, чекіна на нього не витрачає (чекін іде наступному келиху того пива); келих, на
який учасник не очікуваний, його чекінів не бере.

Тести: start→end; два інтервали (повторний start); end без start — нічого; неявний старт усередині
відкритого — без змін; кінець сесії; старт після останньої сесії; прийшов через 10 хв після «Взяв» —
очікуваний; пішов до «Взяв» — ні; рівно на межі 40 хв — очікуваний. Закриття: марка; марка не
забирає чекін у наступного келиха; неочікуваний не забирає чекін; старі тести `closure.test.ts`
переписуються під нові поля без зміни їхніх тверджень.

## Задача 3 — вид черги, заборона дубля, скасування

`src/jobs/fest-queue-view.ts`: `buildQueueView(db, { festId, teamId })` — `closedBy` лише для
очікуваних, елемент `{ telegramId, initials, checkinId: string | null, marked: boolean }`. Експорт
`isOpen(item)` (переїжджає сюди з `fest-format.ts`) і `openGlassOf(view, beerId, at): number | null` —
номер незакритого келиха цього пива з `added_at ≥ at − TABLE_MS`.

`takeBeer(db, p, opts?: { duplicateOf?: () => number | null })`: `duplicateOf` викликається всередині
IMMEDIATE-транзакції після перевірки повтору тапу; не null → `{ kind: 'duplicate', glassNo }`, без
нового келиха й завдання друку. Повтор тапу лишається як є (той самий келих, `repeated: true`).

`dropGlass` (`fest.ts`): не скасовує келих, закритий чекіном **або** відміткою.

Тести (`fest-queue-view.test.ts`, `fest_queue.test.ts`): учасник, що прийшов пізніше за 40 хв, у
рядку відсутній; марка в `closedBy`; `openGlassOf` — відкритий у вікні / закритий / старший за вікно
/ інше пиво; `takeBeer` з `duplicateOf` — без нового рядка й завдання; паралельна гілка без
`duplicateOf` — як раніше.

## Задача 4 — бот, тексти, документи

- `SUBS` + `start`, `end`, `drank`. `/fest start|end` — `addPresence`, відповідь із часом
  (Europe/Warsaw).
- Кнопки під `/fest` (`showRanking` у групі й приватно, `fest.team_created`): «🟢 Почати день»
  `fest:ps:<team>` і «🔴 Закінчити день» `fest:pe:<team>` замість «🙋 Я в команді». `fest:ps`:
  учасник — `start`; не-учасник з `/link` — вступ (спільний хелпер із `fest:j`) + `start`; без
  `/link` — підказка `fest:j` в alert. `fest:pe`: учасник — `end`; не-учасник — `fest.not_member`.
  Відповідь у чат: «🟢 {name} почав день о HH:MM» / «🔴 {name} закінчив день о HH:MM». `fest:j`
  лишається. `/fest queue` — стіл; `/fest queue all` — усе. Рядок схованого:
  `fest.queue_hidden` «Сховано: зачекінено всіма — {done}; старше 40 хв — {old} (/fest queue all).»
  (частини з нулем не пишуться; для `all` — лише «зачекінено всіма», як зараз). Рядок келиха: `✅`
  чекін, `☑️` відмітка, `⏳` ні; неочікувані не показуються.
- `/fest drank` — мої незакриті келихи фесту, кнопки `☑️ №N <пиво>` (`fest:d:<team>:<glass>`, ≤ 20,
  решта — «і ще N»); `/fest drank N` — одразу. Відповідь `fest.drank_marked` з кнопкою
  `↩️ Зняти відмітку` (`fest:du:<team>:<glass>`). Неочікуваний на келих — `fest.drank_not_yours`;
  вже закрито чекіном — `fest.drank_already`; нема такого — `fest.drop_none`. Кнопки — лише учасник
  команди, лише поки фест поточний (як «Взяв»).
- «Взяв» і `/fest take` (обидва шляхи) передають `duplicateOf` = `openGlassOf(buildQueueView(…),
  beerId, at)`; дубль → `fest.taken_duplicate` «Уже в черзі: №{glass} — {name}.»
- i18n uk/pl/en + `types.ts`; `spec.md` (черга, «випито», скасування, нові команди),
  `docs/USER-GUIDE.md`.

Тести (`fest.wiring.test.ts`, `fest-format.test.ts`): start/end пишуть події; кнопки під `/fest`
— `fest:ps`/`fest:pe`, без `fest:j`; `fest:ps` новенького з `/link` — вступ і подія, без `/link` —
alert і нічого; `fest:pe` не-учасника — нічого; старий `fest:j` працює; стіл ховає старше
40 хв і рахує обидві причини; `queue all` показує старе; `drank` без аргументу — кнопки лише моїх;
`drank N` → `☑️` у черзі; зняти — знову `⏳`; неочікуваний / закритий / неіснуючий; дубль «Взяв» за
5 хв — той самий номер, без нового рядка; той самий через 41 хв — новий; `drop` відміченого — відмова.
