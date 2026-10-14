# Скасування келиха в черзі фесту — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** учасник команди скасовує помилково взятий келих — кнопкою `↩️ Скасувати №N` під «Взяв» або `/fest drop N`; номер не повертається в обіг.

**Architecture:** `removeGlass` в одній IMMEDIATE-транзакції видаляє рядок `fest_queue` і його `fest_print_jobs` та пише надгробок у нову таблицю `fest_glass_removed` (v50). `takeBeer` бере наступний номер як `MAX` по черзі й надгробках. Бот перевіряє через `buildQueueView`, що келих не закрито чекіном, і лише тоді скасовує.

**Tech Stack:** TypeScript, better-sqlite3, Telegraf, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-14-fest-queue-drop-design.md`

## Global Constraints

- Гейт кожної задачі — повний: `npm test && npm run typecheck`. Тести лише через `npm test -- <args>`.
- Тести: точні асерти (`toEqual`/`toBe`), жодних `if`/ранніх `return`, очікувані значення літералами, межі й помилки покриті. Кожен новий тест має падати, якщо відповідний рядок коду прибрати.
- Голову схеми (50) асертить **лише** `schema.test.ts` («records every migration 1..N»). Тест v50 асертить `WHERE version = 50`.
- Міграція — лише expand (`CREATE TABLE IF NOT EXISTS`); жодного `UPDATE`/`DELETE`/`DROP` у SQL.
- Особу не зберігати: у `fest_glass_removed` немає колонки «хто скасував».
- Тексти: «пиво», не вигадані слова. Ключі локалі й тексти uk — дослівно зі спеки.

---

### Task 1: ядро — надгробок, `removeGlass`, номер по двох таблицях

**Files:**
- Modify: `src/storage/schema.ts` (новий елемент `MIGRATIONS` після v49)
- Modify: `src/storage/fest_queue.ts` (`takeBeer`, нова `removeGlass`)
- Test: `src/storage/fest_queue.test.ts`, `src/storage/schema.test.ts`, `src/api/routes/fest-print.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RemoveGlassResult =
    | { kind: 'removed'; name: string; printed: boolean }
    | { kind: 'already' }
    | { kind: 'missing' };
  export function removeGlass(db: DB, p: { teamId: number; glassNo: number; at: string }): RemoveGlassResult;
  ```

- [ ] **Step 1: тести в `src/storage/fest_queue.test.ts`**

Імпорт: `import { memberBeerCheckins, queueFor, removeGlass, takeBeer } from './fest_queue';`. Додати в кінець файлу:

```ts
describe('removeGlass', () => {
  it('migration 50 is recorded', () => {
    const { db } = setup();
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 50').get()).toEqual({ version: 50 });
  });

  it('takes the glass and its print job out of the queue and tombstones its number', () => {
    const { db, teamA } = setup();
    takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: AT });
    const second = takeBeer(db, { teamId: teamA, beerId: 12, addedBy: 1, at: AT });
    expect(removeGlass(db, { teamId: teamA, glassNo: 1, at: '2026-10-15T18:01:00+02:00' }))
      .toEqual({ kind: 'removed', name: 'Bravo', printed: false });
    expect(queueFor(db, teamA).map((r) => r.glass_no)).toEqual([2]);
    expect(db.prepare('SELECT queue_id FROM fest_print_jobs').all()).toEqual([{ queue_id: second.id }]);
    expect(db.prepare('SELECT team_id, glass_no, removed_at FROM fest_glass_removed').all())
      .toEqual([{ team_id: teamA, glass_no: 1, removed_at: '2026-10-15T16:01:00.000Z' }]);
  });

  it('says whether the label was already printed', () => {
    const { db, teamA } = setup();
    const glass = takeBeer(db, { teamId: teamA, beerId: 12, addedBy: 1, at: AT });
    db.prepare("UPDATE fest_print_jobs SET status = 'printed' WHERE queue_id = ?").run(glass.id);
    expect(removeGlass(db, { teamId: teamA, glassNo: 1, at: AT })).toEqual({ kind: 'removed', name: 'Charlie', printed: true });
  });

  it('a cancelled number is already cancelled; a number never given, or given in another team, is missing', () => {
    const { db, teamA, teamB } = setup();
    takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: AT });
    removeGlass(db, { teamId: teamA, glassNo: 1, at: AT });
    takeBeer(db, { teamId: teamB, beerId: 11, addedBy: 1, at: AT });
    expect([
      removeGlass(db, { teamId: teamA, glassNo: 1, at: AT }),
      removeGlass(db, { teamId: teamA, glassNo: 7, at: AT }),
      removeGlass(db, { teamId: teamB, glassNo: 2, at: AT }),
    ]).toEqual([{ kind: 'already' }, { kind: 'missing' }, { kind: 'missing' }]);
    expect(queueFor(db, teamB).map((r) => r.glass_no)).toEqual([1]);
  });

  it('the number of a cancelled last glass is never given again, and the other team still starts at 1', () => {
    const { db, teamA, teamB } = setup();
    takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: AT });
    takeBeer(db, { teamId: teamA, beerId: 12, addedBy: 1, at: AT });
    removeGlass(db, { teamId: teamA, glassNo: 2, at: AT });
    removeGlass(db, { teamId: teamA, glassNo: 1, at: AT });
    expect([
      takeBeer(db, { teamId: teamA, beerId: 12, addedBy: 1, at: AT }).glassNo,
      takeBeer(db, { teamId: teamB, beerId: 12, addedBy: 1, at: AT }).glassNo,
    ]).toEqual([3, 1]);
  });

  it('the same tap again after a cancel is a new glass, not the cancelled one back', () => {
    const { db, teamA } = setup();
    takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: AT });
    removeGlass(db, { teamId: teamA, glassNo: 1, at: AT });
    const again = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: new Date(Date.parse(AT) + 5000).toISOString() });
    expect([again.glassNo, again.repeated]).toEqual([2, false]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fest_print_jobs').get()).toEqual({ n: 1 });
  });
});
```

У `src/storage/schema.test.ts` у тесті «records every migration 1..49» замінити `1..49` на `1..50` в назві і `length: 49` на `length: 50`.

У `src/api/routes/fest-print.test.ts` імпорт `import { removeGlass, takeBeer } from '../../storage/fest_queue';` і тест у `describe('print station API')`:

```ts
  it('a cancelled glass leaves the job list, and a late report on it is not found', async () => {
    const { db, app, station, glassId } = setup();
    const { team_id: teamId } = db.prepare('SELECT team_id FROM fest_queue WHERE id = ?').get(glassId) as { team_id: number };
    removeGlass(db, { teamId, glassNo: 1, at: '2026-10-15T18:01:00.000Z' });
    const list = await app.request('/fest-print/jobs', { headers: bearer(station) });
    const late = await app.request(`/fest-print/jobs/${glassId}/printed`, { method: 'POST', headers: bearer(station) });
    expect([await list.json(), late.status]).toEqual([{ jobs: [] }, 404]);
  });
```

- [ ] **Step 2: прогнати — мають впасти**

Run: `npm test -- src/storage/fest_queue.test.ts src/storage/schema.test.ts src/api/routes/fest-print.test.ts`
Expected: FAIL — `removeGlass` не експортується / версія 50 відсутня.

- [ ] **Step 3: міграція v50 у `src/storage/schema.ts`** (після елемента `version: 49`)

```ts
  {
    version: 50,
    // A cancelled glass (spec: fest queue): its number, so the next glass never takes it again — a
    // label with that number may already be out. The queue row and its print job are deleted; who
    // cancelled is not stored. A table, not a column on fest_queue: a code-only rollback then sees
    // the queue without the cancelled glasses instead of printing them again. Idempotent.
    sql: `
      CREATE TABLE IF NOT EXISTS fest_glass_removed (
        team_id    INTEGER NOT NULL REFERENCES fest_teams(id) ON DELETE CASCADE,
        glass_no   INTEGER NOT NULL,
        removed_at TEXT NOT NULL,
        PRIMARY KEY (team_id, glass_no)
      );
    `,
  },
```

- [ ] **Step 4: `src/storage/fest_queue.ts`**

У `takeBeer` замінити рядок з `COALESCE(MAX(glass_no), 0) + 1` на:

```ts
    // A cancelled glass keeps its number (fest_glass_removed): the next one never reuses it.
    const { next } = db.prepare(
      `SELECT MAX(COALESCE((SELECT MAX(glass_no) FROM fest_queue WHERE team_id = ?), 0),
                  COALESCE((SELECT MAX(glass_no) FROM fest_glass_removed WHERE team_id = ?), 0)) + 1 AS next`,
    ).get(p.teamId, p.teamId) as { next: number };
```

Оновити коментар над `takeBeer`: «Glass numbers are per team and never reused» → «Glass numbers are per team and never reused, a cancelled one included».

Після `queueFor` додати:

```ts
export type RemoveGlassResult =
  | { kind: 'removed'; name: string; printed: boolean }
  | { kind: 'already' }
  | { kind: 'missing' };

// A glass taken by mistake (spec: cancelling a glass): the queue row and its print job go, its number
// is tombstoned so takeBeer never gives it again. `printed` is the label's state at this moment — a
// station may still be printing it. Whether a check-in already closed the glass is the caller's check.
export function removeGlass(db: DB, p: { teamId: number; glassNo: number; at: string }): RemoveGlassResult {
  const at = new Date(p.at).toISOString();
  return db.transaction((): RemoveGlassResult => {
    const row = db.prepare(
      `SELECT q.id, b.name, j.status FROM fest_queue q
         JOIN beers b ON b.id = q.beer_id
         LEFT JOIN fest_print_jobs j ON j.queue_id = q.id
        WHERE q.team_id = ? AND q.glass_no = ?`,
    ).get(p.teamId, p.glassNo) as { id: number; name: string; status: string | null } | undefined;
    if (!row) {
      const gone = db.prepare('SELECT 1 FROM fest_glass_removed WHERE team_id = ? AND glass_no = ?').get(p.teamId, p.glassNo);
      return gone ? { kind: 'already' } : { kind: 'missing' };
    }
    db.prepare('DELETE FROM fest_print_jobs WHERE queue_id = ?').run(row.id);
    db.prepare('DELETE FROM fest_queue WHERE id = ?').run(row.id);
    db.prepare('INSERT INTO fest_glass_removed (team_id, glass_no, removed_at) VALUES (?, ?, ?)').run(p.teamId, p.glassNo, at);
    return { kind: 'removed', name: row.name, printed: row.status === 'printed' };
  }).immediate();
}
```

- [ ] **Step 5: повний гейт**

Run: `npm test && npm run typecheck`
Expected: PASS. Мутаційна перевірка вручну (і повернути назад): прибрати другий `COALESCE` у `takeBeer` → падає «never given again»; прибрати `DELETE FROM fest_print_jobs` → падає перший тест `removeGlass` і тест станції.

- [ ] **Step 6: коміт**

```bash
git add src/storage/schema.ts src/storage/fest_queue.ts src/storage/fest_queue.test.ts src/storage/schema.test.ts src/api/routes/fest-print.test.ts
git commit -m "feat(fest): a glass can be cancelled — removeGlass deletes it with its print job and tombstones its number (v50 fest_glass_removed)"
```

---

### Task 2: бот — кнопка під «Взяв» і `/fest drop`

**Files:**
- Modify: `src/bot/commands/fest.ts`
- Modify: `src/i18n/types.ts`, `src/i18n/locales/uk.ts`, `src/i18n/locales/en.ts`, `src/i18n/locales/pl.ts`
- Test: `src/bot/commands/fest.wiring.test.ts`

**Interfaces:**
- Consumes: `removeGlass(db, { teamId, glassNo, at }): RemoveGlassResult` з Task 1; `buildQueueView(db, { festId, teamId })` — `items[].glassNo`, `items[].closedBy[].checkinId`.
- Produces: callback `fest:u:<teamId>:<glassNo>`; підкоманда `drop`.

- [ ] **Step 1: ключі локалі**

`src/i18n/types.ts` — поряд із `'fest.taken': string;`:

```ts
  'fest.undo_button': string;
  'fest.drop_usage': string;
  'fest.drop_none': string;
  'fest.drop_already': string;
  'fest.drop_closed': string;
  'fest.dropped_printed': string;
  'fest.dropped_unprinted': string;
```

`uk.ts`:

```ts
  'fest.undo_button': '↩️ Скасувати №{glass}',
  'fest.drop_usage': 'Вкажіть номер келиха: /fest drop 7 (номери — у /fest queue).',
  'fest.drop_none': 'Келиха №{glass} у черзі немає.',
  'fest.drop_already': 'Келих №{glass} уже скасовано.',
  'fest.drop_closed': 'Келих №{glass} уже зачекінено — його не скасувати.',
  'fest.dropped_printed': '↩️ Келих №{glass} ({name}) скасовано. Наліпку №{glass} викиньте.',
  'fest.dropped_unprinted': '↩️ Келих №{glass} ({name}) скасовано. Наліпку не друкуватимемо; якщо вона все ж вийде — викиньте.',
```

`en.ts`:

```ts
  'fest.undo_button': '↩️ Cancel #{glass}',
  'fest.drop_usage': 'Send the glass number: /fest drop 7 (numbers are in /fest queue).',
  'fest.drop_none': 'There is no glass #{glass} in the queue.',
  'fest.drop_already': 'Glass #{glass} is already cancelled.',
  'fest.drop_closed': 'Glass #{glass} is already checked in — it cannot be cancelled.',
  'fest.dropped_printed': '↩️ Glass #{glass} ({name}) cancelled. Throw away label #{glass}.',
  'fest.dropped_unprinted': '↩️ Glass #{glass} ({name}) cancelled. Its label will not be printed; if it comes out anyway, throw it away.',
```

`pl.ts`:

```ts
  'fest.undo_button': '↩️ Anuluj nr {glass}',
  'fest.drop_usage': 'Podaj numer kufla: /fest drop 7 (numery są w /fest queue).',
  'fest.drop_none': 'W kolejce nie ma kufla nr {glass}.',
  'fest.drop_already': 'Kufel nr {glass} jest już anulowany.',
  'fest.drop_closed': 'Kufel nr {glass} ma już check-in — nie można go anulować.',
  'fest.dropped_printed': '↩️ Kufel nr {glass} ({name}) anulowany. Naklejkę nr {glass} wyrzuć.',
  'fest.dropped_unprinted': '↩️ Kufel nr {glass} ({name}) anulowany. Naklejki nie wydrukujemy; jeśli jednak wyjdzie — wyrzuć ją.',
```

- [ ] **Step 2: тести в `src/bot/commands/fest.wiring.test.ts`**

Сетап: імпорти `import { Markup } from 'telegraf';`, `import { insertVenueCheckins } from '../../storage/venue_checkins';`. У `setup()` додати масиви `replyExtras: unknown[]` і `edits: unknown[]`, повертати їх; мок `reply` записує другий аргумент, додати мок `editMessageReplyMarkup`:

```ts
    ctx.reply = (async (message: string, extra?: unknown) => { replies.push(message); replyExtras.push(extra); return { message_id: 1 }; }) as never;
    ctx.editMessageReplyMarkup = (async (markup: unknown) => { edits.push(markup); return true; }) as never;
```

Тип повернення `setup()` доповнити `replyExtras: unknown[]; edits: unknown[]`.

Новий блок (під фестом — фіксований час, щоб тест не залежав від дати прогону):

```ts
describe('cancelling a glass (fest:u, /fest drop)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T18:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('the «Взяв» reply carries a cancel button for that glass', async () => {
    const { bot, teamId, replyExtras } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    expect(replyExtras).toEqual([Markup.inlineKeyboard([[Markup.button.callback('↩️ Cancel #1', `fest:u:${teamId}:1`)]])]);
  });

  it('the button cancels the glass, says so in the chat and takes itself off the message', async () => {
    const { db, bot, teamId, replies, answers, edits } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    await bot.handleUpdate(callback(2, 7, `fest:u:${teamId}:1`) as unknown as Update);
    expect([queueFor(db, teamId), replies[1], answers, edits]).toEqual([
      [], '↩️ Glass #1 (Bravo) cancelled. Its label will not be printed; if it comes out anyway, throw it away.',
      [undefined, undefined], [undefined],
    ]);
  });

  it('someone outside the team cancels nothing', async () => {
    const { db, bot, teamId, replies, answers, edits } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    await bot.handleUpdate(callback(2, 8, `fest:u:${teamId}:1`) as unknown as Update);
    expect([queueFor(db, teamId).map((r) => r.glass_no), replies.length, answers[1], edits])
      .toEqual([[1], 1, 'This is for team members — press “I’m in the team”.', []]);
  });

  it('/fest drop cancels by number; a printed label is to be thrown away', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    db.prepare("UPDATE fest_print_jobs SET status = 'printed'").run();
    await bot.handleUpdate(command(2, 7, { id: -100, type: 'supergroup' }, '/fest drop 1') as unknown as Update);
    expect([queueFor(db, teamId), replies[1]]).toEqual([[], '↩️ Glass #1 (Bravo) cancelled. Throw away label #1.']);
  });

  it('/fest drop answers a cancelled number, an unknown one, a missing one and a non-number', async () => {
    const { bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    const group = { id: -100, type: 'supergroup' as const };
    await bot.handleUpdate(command(2, 7, group, '/fest drop №1') as unknown as Update);
    await bot.handleUpdate(command(3, 7, group, '/fest drop 1') as unknown as Update);
    await bot.handleUpdate(command(4, 7, group, '/fest drop 5') as unknown as Update);
    await bot.handleUpdate(command(5, 7, group, '/fest drop') as unknown as Update);
    await bot.handleUpdate(command(6, 7, group, '/fest drop two') as unknown as Update);
    await bot.handleUpdate(command(7, 7, group, '/fest drop 0') as unknown as Update);
    expect(replies.slice(1)).toEqual([
      '↩️ Glass #1 (Bravo) cancelled. Its label will not be printed; if it comes out anyway, throw it away.',
      'Glass #1 is already cancelled.',
      'There is no glass #5 in the queue.',
      'Send the glass number: /fest drop 7 (numbers are in /fest queue).',
      'Send the glass number: /fest drop 7 (numbers are in /fest queue).',
      'Send the glass number: /fest drop 7 (numbers are in /fest queue).',
    ]);
  });

  it('a glass a check-in already closed is not cancelled', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    insertVenueCheckins(db, [
      { checkin_id: 501, venue_id: 2167060, bid: 6000011, untappd_user: 'member', checkin_at: '2026-10-15T18:05:00.000Z' },
    ], 'laptop', '2026-10-15T18:05:00.000Z');
    await bot.handleUpdate(command(2, 7, { id: -100, type: 'supergroup' }, '/fest drop 1') as unknown as Update);
    expect([queueFor(db, teamId).map((r) => r.glass_no), replies[1]])
      .toEqual([[1], 'Glass #1 is already checked in — it cannot be cancelled.']);
  });
});
```

Примітка для виконавця: `command()` оголошено нижче за блок «Взяв» у файлі — новий `describe` став **після** неї (наприкінці файлу). `2167060` — локація фесту `wfp22` із сиду.

- [ ] **Step 3: прогнати — мають впасти**

Run: `npm test -- src/bot/commands/fest.wiring.test.ts`
Expected: FAIL — немає кнопки, `fest:u` не обробляється, `drop` не відома.

- [ ] **Step 4: `src/bot/commands/fest.ts`**

Імпорт: `import { removeGlass, takeBeer } from '../../storage/fest_queue';`.

`SUBS`: `['targets', 'add', 'take', 'queue', 'drop', 'stands', 'menu', 'printer'] as const`.

Над `createFestCommand` додати:

```ts
/** `/fest drop 7` or `/fest drop №7`: the glass number, or null. */
export function glassNoOf(query: string): number | null {
  const m = /^[№#]?\s*(\d{1,9})$/.exec(query.trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : null;
}

// Cancelling a glass (spec: fest queue). A glass a check-in already closed was surely drunk, and
// without it closeQueue would hand that check-in to another glass of the beer — so it stays.
function dropGlass(ctx: BotContext, festId: number, teamId: number, glassNo: number): string {
  const db = ctx.deps.db;
  const item = buildQueueView(db, { festId, teamId }).items.find((i) => i.glassNo === glassNo);
  if (item && item.closedBy.some((c) => c.checkinId !== null)) return ctx.t('fest.drop_closed', { glass: glassNo });
  const r = removeGlass(db, { teamId, glassNo, at: new Date().toISOString() });
  if (r.kind === 'already') return ctx.t('fest.drop_already', { glass: glassNo });
  if (r.kind === 'missing') return ctx.t('fest.drop_none', { glass: glassNo });
  return ctx.t(r.printed ? 'fest.dropped_printed' : 'fest.dropped_unprinted', { glass: glassNo, name: r.name });
}
```

У `runSub` перед `if (sub === 'printer')`:

```ts
    if (sub === 'drop') {
      const glassNo = glassNoOf(query);
      await ctx.reply(glassNo === null ? ctx.t('fest.drop_usage') : dropGlass(ctx, fest.id, team.id, glassNo));
      return;
    }
```

У обробнику `fest:q` замінити останній `ctx.reply`:

```ts
    await ctx.reply(ctx.t('fest.taken', { glass: glassNo, name: beer.name, initials }), Markup.inlineKeyboard([
      [Markup.button.callback(ctx.t('fest.undo_button', { glass: glassNo }), `fest:u:${team.id}:${glassNo}`)],
    ]));
```

Після обробника `fest:q`:

```ts
  // «↩️ Скасувати №N» under «Взяв»: any member may cancel; the button leaves the message whatever the answer.
  festCommand.action(/^fest:u:(\d+):(\d{1,9})$/, async (ctx) => {
    const db = ctx.deps.db;
    const team = teamById(db, Number(ctx.match[1]));
    if (!team || !isTeamMember(db, team.id, ctx.from.id)) {
      await ctx.answerCbQuery(ctx.t('fest.not_member'));
      return;
    }
    const text = dropGlass(ctx, team.fest_id, team.id, Number(ctx.match[2]));
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(text);
  });
```

- [ ] **Step 5: повний гейт**

Run: `npm test && npm run typecheck`
Expected: PASS. Мутації (повернути назад): прибрати перевірку `closedBy` → падає «checked in»; прибрати `editMessageReplyMarkup` → падає тест кнопки; прибрати `isTeamMember` у `fest:u` → падає «outside the team».

- [ ] **Step 6: коміт**

```bash
git add src/bot/commands/fest.ts src/bot/commands/fest.wiring.test.ts src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/en.ts src/i18n/locales/pl.ts
git commit -m "feat(fest): «↩️ Скасувати №N» under «Взяв» and /fest drop N cancel a glass; a checked-in glass stays"
```

---

### Task 3: документи

**Files:**
- Modify: `spec.md`, `docs/USER-GUIDE.md`

- [ ] **Step 1: `spec.md`, § «Фестивальний режим — черга, «випито», алерти»**

У пункті «Черга келихів» речення «`glass_no = MAX + 1` у межах команди (номери не перевикористовуються й збігаються з наперед надрукованими наліпками)» замінити на «`glass_no = MAX + 1` у межах команди по черзі **й** скасованих номерах (`fest_glass_removed`) — номери не перевикористовуються й збігаються з наперед надрукованими наліпками». Відповідь на «Взяв» несе кнопку `↩️ Скасувати №N`. Після пункту «Черга келихів» новий пункт:

```markdown
- **Скасування келиха**: кнопка `↩️ Скасувати №N` (`fest:u:<team>:<glass>`) під відповіддю «Взяв» або
  `/fest drop <№>`; будь-який учасник команди, без обмеження в часі. `removeGlass` в одній
  IMMEDIATE-транзакції видаляє рядок `fest_queue` і його `fest_print_jobs` і пише номер у
  `fest_glass_removed` — номер у обіг не повертається, а повтор «Взяв» шукає лише в черзі, тож тап
  після скасування дає новий келих. Келих, який уже закрив чекін (`closeQueue`), не скасовується:
  без нього чекін перейшов би на інший келих того ж пива. Відповідь у чат називає пиво і, якщо
  наліпку вже надруковано, просить її викинути; інакше — «не друкуватимемо; якщо вийде — викиньте»
  (станція могла вже взяти завдання; її пізній `printed` дістає 404). Кнопка знімається з повідомлення.
  Хто скасував — не зберігається.
```

- [ ] **Step 2: `spec.md`, таблиця міграцій** — після рядка `| 47 | …`:

```markdown
| 48 | `fests.target_min_abv` (REAL, NULL — правила нема) — Target за міцністю |
| 49 | `fests.target_name_patterns` (JSON-масив, `'[]'`, CHECK) — Target за назвою |
| 50 | `fest_glass_removed` (team_id, glass_no, removed_at) — номери скасованих келихів; ідемпотентна |
```

- [ ] **Step 3: `docs/USER-GUIDE.md`, пункт 6 «Черга келихів»** — після рядка про номер келиха («Номер пиши на келих або клей наліпку з тим самим номером.») додати підпункт:

```markdown
   - **Ткнув не туди?** Під відповіддю `🍺 Келих №7 …` є кнопка **«↩️ Скасувати №7»**; пізніше —
     `/fest drop 7`. Номер №7 більше нікому не дістанеться; якщо наліпку вже надруковано — викинь її.
     Келих, у якого вже є чекін, не скасовується.
```

- [ ] **Step 4: повний гейт і коміт**

Run: `npm test && npm run typecheck` — PASS.

```bash
git add spec.md docs/USER-GUIDE.md
git commit -m "docs(fest): spec.md and the user guide — cancelling a glass, v48–v50 in the migration table"
```
