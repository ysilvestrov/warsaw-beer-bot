# Handler Failures (#836) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a command handler fails, the person gets a one-line answer and the daily status shows the failure as a yellow reason under «Канали»; `/route` splits a long result and no longer fails silently.

**Architecture:** A new table `handler_failures` (migration v47) is the only record. `bot.catch` and the detached parts of `/route`, `/refresh`, `/import` write to it through one safe wrapper (`noteFailure`). The daily status reads the last 24 hours grouped by `(source, error)` and `evaluateChannels` turns a non-empty list into a yellow reason. `/route` packs its lines with `splitMessage` from #835.

**Tech Stack:** TypeScript, Telegraf, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-11-836-handler-failures-design.md`

## Global Constraints

- Every task ends with the FULL gate: `npm test && npm run typecheck`. Never a scoped run as the final check.
- Tests run only through `npm test -- <args>`. Never call vitest directly, never set `WBB_TEST_TMPDIR`.
- Test quality: exact asserts (`toBe`/`toEqual`), no `if`/early `return` inside a test, no tautologies, expected values are literals — never computed by repeating production logic.
- Nothing about the person is stored: no Telegram id, no message text, no command arguments.
- `error` is cut to **200** code points in storage; to **60** characters in the status line.
- The status window is **24 hours** back from `now`; the threshold is **one** failure; there is no red level.
- Ukrainian text says «пиво», never invented words.
- The code beats the plan: if a snippet here disagrees with a signature or helper that already exists in the file, follow the file and say so in the report.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Storage — `handler_failures` table and `failureSource`

**Files:**
- Modify: `src/storage/schema.ts` (append migration 47 after version 46)
- Create: `src/storage/handler_failures.ts`
- Create: `src/storage/handler_failures.test.ts`
- Create: `src/bot/failure-source.ts`
- Create: `src/bot/failure-source.test.ts`

**Interfaces:**
- Produces:
  - `recordHandlerFailure(db: DB, f: { at: string; source: string; error: string }): void`
  - `handlerFailuresSince(db: DB, sinceIso: string): HandlerFailureGroup[]` where `HandlerFailureGroup = { source: string; error: string; count: number }`
  - `pruneHandlerFailures(db: DB, beforeIso: string): void`
  - `FAILURE_ERROR_MAX = 200`
  - `failureSource(update: Update): string`

- [ ] **Step 1: Write the failing storage tests**

`src/storage/handler_failures.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { handlerFailuresSince, pruneHandlerFailures, recordHandlerFailure } from './handler_failures';

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const rows = (db: ReturnType<typeof emptyDb>) =>
  db.prepare('SELECT at, source, error FROM handler_failures ORDER BY id').all();

test('migration v47 records its version and creates the table with its index', () => {
  const db = emptyDb();
  expect(db.prepare('SELECT version FROM schema_version WHERE version = 47').get()).toEqual({ version: 47 });
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'handler_failures' ORDER BY name").all(),
  ).toEqual([{ name: 'handler_failures' }, { name: 'handler_failures_at' }]);
});

test('a failure is stored as given', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: '/beers', error: 'message is too long' });
  expect(rows(db)).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/beers', error: 'message is too long' }]);
});

test('the error text is cut at 200 code points: 199 and 200 stay whole, 201 loses one', () => {
  const db = emptyDb();
  for (const n of [199, 200, 201]) {
    recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: `n${n}`, error: 'x'.repeat(n) });
  }
  expect(
    db.prepare('SELECT source, length(error) AS len FROM handler_failures ORDER BY id').all(),
  ).toEqual([{ source: 'n199', len: 199 }, { source: 'n200', len: 200 }, { source: 'n201', len: 200 }]);
});

test('the cut never splits a surrogate pair: an emoji as the 200th code point is kept whole', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: 's', error: `${'x'.repeat(199)}🍺yz` });
  expect(rows(db)).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: 's', error: `${'x'.repeat(199)}🍺` }]);
});

test('an empty error text is stored as an empty string', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: '/pubs', error: '' });
  expect(rows(db)).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/pubs', error: '' }]);
});

test('groups by source and error, most frequent first, ties by source then error', () => {
  const db = emptyDb();
  const at = '2026-10-11T10:00:00.000Z';
  recordHandlerFailure(db, { at, source: '/route', error: 'b' });
  recordHandlerFailure(db, { at, source: '/beers', error: 'long' });
  recordHandlerFailure(db, { at, source: '/route', error: 'a' });
  recordHandlerFailure(db, { at, source: '/beers', error: 'long' });
  recordHandlerFailure(db, { at, source: '/beers', error: 'other' });
  expect(handlerFailuresSince(db, '2026-10-11T00:00:00.000Z')).toEqual([
    { source: '/beers', error: 'long', count: 2 },
    { source: '/beers', error: 'other', count: 1 },
    { source: '/route', error: 'a', count: 1 },
    { source: '/route', error: 'b', count: 1 },
  ]);
});

test('the window includes a row exactly at the boundary and excludes one a millisecond older', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-10T09:59:59.999Z', source: 'older', error: 'e' });
  recordHandlerFailure(db, { at: '2026-10-10T10:00:00.000Z', source: 'boundary', error: 'e' });
  expect(handlerFailuresSince(db, '2026-10-10T10:00:00.000Z')).toEqual([{ source: 'boundary', error: 'e', count: 1 }]);
});

test('no rows gives an empty list', () => {
  expect(handlerFailuresSince(emptyDb(), '2026-10-10T10:00:00.000Z')).toEqual([]);
});

test('prune deletes rows strictly older than the cutoff', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-07-13T09:59:59.999Z', source: 'old', error: 'e' });
  recordHandlerFailure(db, { at: '2026-07-13T10:00:00.000Z', source: 'kept', error: 'e' });
  pruneHandlerFailures(db, '2026-07-13T10:00:00.000Z');
  expect(rows(db)).toEqual([{ at: '2026-07-13T10:00:00.000Z', source: 'kept', error: 'e' }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/storage/handler_failures.test.ts`
Expected: FAIL — cannot resolve `./handler_failures`.

- [ ] **Step 3: Add the migration**

In `src/storage/schema.ts`, after the `version: 46` entry of `MIGRATIONS`:

```ts
  {
    version: 47,
    // #836: one row per handler failure. bot.catch used to only log it, so nobody saw it; the
    // daily status counts these rows. Nothing about the person is stored. Idempotent like v45.
    sql: `
      CREATE TABLE IF NOT EXISTS handler_failures (
        id     INTEGER PRIMARY KEY,
        at     TEXT NOT NULL,
        source TEXT NOT NULL,
        error  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS handler_failures_at ON handler_failures(at);
    `,
  },
```

- [ ] **Step 4: Write the storage module**

`src/storage/handler_failures.ts`:

```ts
import type { DB } from './db';

// #836: what failed and with which error — never who asked or what they typed.
export const FAILURE_ERROR_MAX = 200;

export interface HandlerFailureGroup {
  source: string;
  error: string;
  count: number;
}

export function recordHandlerFailure(db: DB, f: { at: string; source: string; error: string }): void {
  // Code points, not UTF-16 units: a cut must not leave half a surrogate pair in the status report.
  const error = [...f.error].slice(0, FAILURE_ERROR_MAX).join('');
  db.prepare('INSERT INTO handler_failures (at, source, error) VALUES (?, ?, ?)').run(f.at, f.source, error);
}

// `at` is always Date.toISOString(), so string order is time order.
export function handlerFailuresSince(db: DB, sinceIso: string): HandlerFailureGroup[] {
  return db.prepare(
    `SELECT source, error, COUNT(*) AS count FROM handler_failures
     WHERE at >= ? GROUP BY source, error ORDER BY count DESC, source, error`,
  ).all(sinceIso) as HandlerFailureGroup[];
}

export function pruneHandlerFailures(db: DB, beforeIso: string): void {
  db.prepare('DELETE FROM handler_failures WHERE at < ?').run(beforeIso);
}
```

- [ ] **Step 5: Run the storage tests**

Run: `npm test -- src/storage/handler_failures.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Write the failing `failureSource` tests**

`src/bot/failure-source.test.ts`:

```ts
import type { Update } from '@telegraf/types';
import { failureSource } from './failure-source';

const text = (t: string) => ({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, text: t } }) as unknown as Update;

test('a command gives its name without arguments', () => {
  expect(failureSource(text('/beers piw paw'))).toBe('/beers');
});
test('a command addressed to the bot loses the @botname', () => {
  expect(failureSource(text('/route@WarsawBeerBot 12'))).toBe('/route');
});
test('a command is lower-cased', () => {
  expect(failureSource(text('/Beers'))).toBe('/beers');
});
test('plain text is "text" — what the person typed is not kept', () => {
  expect(failureSource(text('piw paw'))).toBe('text');
});
test('a slash in the middle of a text is not a command', () => {
  expect(failureSource(text('see /beers'))).toBe('text');
});
test('a button press is "callback"', () => {
  expect(failureSource({ update_id: 1, callback_query: { id: 'q', data: 'rb:now:1' } } as unknown as Update)).toBe('callback');
});
test('a message without text (a document) is named by its update type', () => {
  const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, document: { file_id: 'f' } } };
  expect(failureSource(update as unknown as Update)).toBe('message');
});
test('any other update is named by its update type', () => {
  expect(failureSource({ update_id: 1, my_chat_member: {} } as unknown as Update)).toBe('my_chat_member');
});
test('an update with nothing but its id is "unknown"', () => {
  expect(failureSource({ update_id: 1 } as unknown as Update)).toBe('unknown');
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npm test -- src/bot/failure-source.test.ts`
Expected: FAIL — cannot resolve `./failure-source`.

- [ ] **Step 8: Write `failureSource`**

`src/bot/failure-source.ts`:

```ts
import type { Update } from '@telegraf/types';

// #836: names WHAT failed for the status report. Command arguments and message text are what the
// person typed, so they are deliberately not part of the name.
export function failureSource(update: Update): string {
  if ('callback_query' in update) return 'callback';
  if ('message' in update && 'text' in update.message) {
    const command = /^\/([A-Za-z0-9_]+)/.exec(update.message.text);
    return command ? `/${command[1].toLowerCase()}` : 'text';
  }
  return Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
}
```

- [ ] **Step 9: Run, then mutation-check**

Run: `npm test -- src/bot/failure-source.test.ts` → PASS, 9 tests.

Mutations (apply, run the named file, see the named test FAIL, revert):
1. `handler_failures.ts`: `.slice(0, FAILURE_ERROR_MAX)` on the string instead of on `[...f.error]` → the surrogate-pair test fails.
2. `handler_failures.ts`: `WHERE at > ?` → the boundary test fails.
3. `handler_failures.ts`: `DELETE … WHERE at <= ?` → the prune test fails.
4. `failure-source.ts`: drop `.toLowerCase()` → the lower-case test fails.
5. `failure-source.ts`: regexp without `^` → the "slash in the middle" test fails.

- [ ] **Step 10: Full gate and commit**

Run: `npm test && npm run typecheck`
Expected: all pass. If a test elsewhere pins the schema head at 46, it is the one test allowed to — update that number to 47 and name the test in the report.

```bash
git add src/storage/schema.ts src/storage/handler_failures.ts src/storage/handler_failures.test.ts src/bot/failure-source.ts src/bot/failure-source.test.ts
git commit -m "feat(#836): handler_failures table (v47) and failureSource — a failure becomes a row that names what failed, not who asked"
```

---

### Task 2: `bot.catch` answers the person and records the failure

**Files:**
- Create: `src/bot/handler-failure.ts`
- Create: `src/bot/handler-failure.test.ts`
- Modify: `src/bot/index.ts` (the `bot.catch` line)
- Modify: `src/i18n/types.ts`, `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts` (new key `app.handler_failed`)
- Modify: `spec.md`

**Interfaces:**
- Consumes: `recordHandlerFailure`, `failureSource` (Task 1).
- Produces:
  - `noteFailure(deps: { db: DB; log: pino.Logger }, source: string, err: unknown, now?: Date): void` — never throws.
  - `onHandlerFailure(deps: AppDeps, err: unknown, ctx: BotContext, now?: Date): Promise<void>` — never throws.

**Behaviour (spec §3.1–3.2):**
1. Log `bot error` at `error` level with `{ err, update }` — exactly as today.
2. `noteFailure(deps, failureSource(ctx.update), err, now)`.
3. If `err` is Telegraf's handler timeout (`err instanceof Error && err.name === 'TimeoutError'`) — stop: the handler is still running in the background and may yet answer, so telling the person it failed could be false. The row is still written.
4. If the update has no chat (`ctx.chat === undefined`) — stop.
5. `await ctx.reply(t('app.handler_failed'))`, where `t` is `ctx.t`, or `createTranslator('en')` when `ctx.t` is missing (the i18n middleware itself failed; `'en'` is that middleware's own default).
6. A failing reply is logged at `warn` (`handler failure reply not sent`) and swallowed.

- [ ] **Step 1: Add the locale key**

`src/i18n/types.ts`, under `// app`:

```ts
  'app.handler_failed': string;
```

Locales, next to `app.no_data_in_snapshot`:

```ts
// uk
  'app.handler_failed': 'Не вдалося виконати команду. Спробуйте пізніше.',
// pl
  'app.handler_failed': 'Nie udało się wykonać polecenia. Spróbuj później.',
// en
  'app.handler_failed': 'The command failed. Please try again later.',
```

- [ ] **Step 2: Write the failing tests**

`src/bot/handler-failure.test.ts`. The harness follows `src/bot/commands/reboot.test.ts` (a real `Telegraf`, `bot.botInfo` set, `ctx.reply` replaced in a middleware, `bot.handleUpdate`); if that file's helpers differ from this snippet, follow the file.

```ts
import { describe, expect, it } from 'vitest';
import { Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import type { AppDeps, BotContext } from './index';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { createTranslator } from '../i18n';
import { noteFailure, onHandlerFailure } from './handler-failure';

const NOW = new Date('2026-10-11T10:00:00.000Z');
const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};
const message = (text: string): Update => ({
  update_id: 1,
  message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'U' }, text },
}) as unknown as Update;

function setup(opts: { fail: unknown; replyRejects?: boolean; locale?: 'uk' | 'pl' | 'en' | null } = { fail: new Error('boom') }) {
  const db = openDb(':memory:');
  migrate(db);
  const logged: { level: string; msg: string }[] = [];
  const log = {
    error: (_o: unknown, msg: string) => { logged.push({ level: 'error', msg }); },
    warn: (_o: unknown, msg: string) => { logged.push({ level: 'warn', msg }); },
  };
  const deps = { db, env: {}, log } as unknown as AppDeps;
  const replies: string[] = [];
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  bot.use((ctx, next) => {
    ctx.deps = deps;
    const locale = opts.locale === undefined ? 'uk' : opts.locale;
    if (locale !== null) { ctx.locale = locale; ctx.t = createTranslator(locale); }
    ctx.reply = (opts.replyRejects
      ? async () => { throw new Error('403: bot was blocked by the user'); }
      : async (m: string) => { replies.push(m); return { message_id: 9 }; }) as never;
    return next();
  });
  bot.on('message', () => { throw opts.fail; });
  bot.catch((err, ctx) => onHandlerFailure(deps, err, ctx, NOW));
  const rows = () => db.prepare('SELECT at, source, error FROM handler_failures ORDER BY id').all();
  return { bot, db, deps, replies, logged, rows };
}
```

Note: `if (locale !== null)` sits in the harness middleware, not in a test body — the rule about conditionals is about the assertion path of a test.

```ts
describe('onHandlerFailure', () => {
  it('answers the person in their locale and records what failed', async () => {
    const s = setup({ fail: new Error('400: Bad Request: message is too long') });
    await s.bot.handleUpdate(message('/beers piw paw'));
    expect(s.replies).toEqual(['Не вдалося виконати команду. Спробуйте пізніше.']);
    expect(s.rows()).toEqual([
      { at: '2026-10-11T10:00:00.000Z', source: '/beers', error: '400: Bad Request: message is too long' },
    ]);
    expect(s.logged).toEqual([{ level: 'error', msg: 'bot error' }]);
  });

  it('uses the Polish text for a Polish locale', async () => {
    const s = setup({ fail: new Error('boom'), locale: 'pl' });
    await s.bot.handleUpdate(message('/pubs'));
    expect(s.replies).toEqual(['Nie udało się wykonać polecenia. Spróbuj później.']);
  });

  it('falls back to English when the i18n middleware never ran', async () => {
    const s = setup({ fail: new Error('boom'), locale: null });
    await s.bot.handleUpdate(message('/pubs'));
    expect(s.replies).toEqual(['The command failed. Please try again later.']);
  });

  it('a thrown non-Error is recorded as its string form', async () => {
    const s = setup({ fail: 'plain string' });
    await s.bot.handleUpdate(message('hello'));
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: 'text', error: 'plain string' }]);
  });

  it('a handler timeout is recorded but the person is not told it failed', async () => {
    const timeout = Object.assign(new Error('Promise timed out after 90000 milliseconds'), { name: 'TimeoutError' });
    const s = setup({ fail: timeout });
    await s.bot.handleUpdate(message('/route'));
    expect(s.replies).toEqual([]);
    expect(s.rows()).toEqual([
      { at: '2026-10-11T10:00:00.000Z', source: '/route', error: 'Promise timed out after 90000 milliseconds' },
    ]);
  });

  it('a reply that fails is logged as a warning and does not throw', async () => {
    const s = setup({ fail: new Error('boom'), replyRejects: true });
    await expect(s.bot.handleUpdate(message('/pubs'))).resolves.toBeUndefined();
    expect(s.logged).toEqual([
      { level: 'error', msg: 'bot error' },
      { level: 'warn', msg: 'handler failure reply not sent' },
    ]);
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/pubs', error: 'boom' }]);
  });

  it('an update without a chat is recorded and nothing is sent', async () => {
    const s = setup({ fail: new Error('boom') });
    const ctx = { update: { update_id: 1, poll: {} }, chat: undefined, t: createTranslator('uk') } as unknown as BotContext;
    await onHandlerFailure(s.deps, new Error('boom'), ctx, NOW);
    expect(s.replies).toEqual([]);
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: 'poll', error: 'boom' }]);
  });

  it('a failing INSERT does not stop the answer', async () => {
    const s = setup({ fail: new Error('boom') });
    s.db.exec('DROP TABLE handler_failures');
    await s.bot.handleUpdate(message('/pubs'));
    expect(s.replies).toEqual(['Не вдалося виконати команду. Спробуйте пізніше.']);
    expect(s.logged).toEqual([
      { level: 'error', msg: 'bot error' },
      { level: 'error', msg: 'handler failure not recorded' },
    ]);
  });
});

describe('noteFailure', () => {
  it('writes one row with the given source', () => {
    const s = setup({ fail: new Error('unused') });
    noteFailure(s.deps, '/route', new Error('fetch failed'), NOW);
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/route', error: 'fetch failed' }]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- src/bot/handler-failure.test.ts`
Expected: FAIL — cannot resolve `./handler-failure`.

- [ ] **Step 4: Write the module**

`src/bot/handler-failure.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { AppDeps, BotContext } from './index';
import { recordHandlerFailure } from '../storage/handler_failures';
import { createTranslator } from '../i18n';
import { failureSource } from './failure-source';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Telegraf wraps every handler in p-timeout (handlerTimeout, 90 s). The handler is NOT cancelled —
// it keeps running — so "failed" would be a claim we cannot make to the person.
const isHandlerTimeout = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError';

/** #836: records a failure for the daily status. Bookkeeping must never break the answer, so it never throws. */
export function noteFailure(
  deps: { db: DB; log: pino.Logger },
  source: string,
  err: unknown,
  now: Date = new Date(),
): void {
  try {
    recordHandlerFailure(deps.db, { at: now.toISOString(), source, error: errorText(err) });
  } catch (e) {
    deps.log.error({ err: e, source }, 'handler failure not recorded');
  }
}

/** #836: everything a handler did not catch itself ends here. Never throws. */
export async function onHandlerFailure(deps: AppDeps, err: unknown, ctx: BotContext, now: Date = new Date()): Promise<void> {
  deps.log.error({ err, update: ctx.update }, 'bot error');
  noteFailure(deps, failureSource(ctx.update), err, now);
  if (isHandlerTimeout(err) || ctx.chat === undefined) return;
  // ctx.t is missing when the i18n middleware itself failed; 'en' is that middleware's own default.
  const t = ctx.t ?? createTranslator('en');
  try {
    await ctx.reply(t('app.handler_failed'));
  } catch (e) {
    deps.log.warn({ err: e }, 'handler failure reply not sent');
  }
}
```

In `src/bot/index.ts` replace the `bot.catch` line:

```ts
  bot.catch((err, ctx) => onHandlerFailure(deps, err, ctx));
```

and add `import { onHandlerFailure } from './handler-failure';`.

- [ ] **Step 5: Run, then mutation-check**

Run: `npm test -- src/bot/handler-failure.test.ts` → PASS, 9 tests.

Mutations:
1. Remove the `isHandlerTimeout(err) ||` half → the timeout test fails (a reply appears).
2. Remove the `try/catch` around `ctx.reply` → the "reply that fails" test fails.
3. Remove the `try/catch` in `noteFailure` → the "failing INSERT" test fails.
4. `createTranslator('uk')` as the fallback → the English-fallback test fails.

- [ ] **Step 6: Update `spec.md`**

Find where `spec.md` describes the bot's error handling (search `bot.catch`, `bot error`; if neither is present, add the paragraph at the end of the section that introduces the bot commands). Add:

```markdown
**Збій обробника (#836).** Усе, що обробник не зловив сам, потрапляє в `bot.catch`
(`onHandlerFailure`, `src/bot/handler-failure.ts`): запис у журнал `bot error`, рядок у
`handler_failures` і відповідь людині `app.handler_failed` її локаллю («Не вдалося виконати
команду. Спробуйте пізніше.»). У рядку — мить, назва того, що впало (`/beers` без аргументів,
`callback`, `text` або тип оновлення), і перші 200 символів помилки; ідентифікатор людини й текст
її повідомлення не зберігаються. Таймаут обробника Telegraf (90 с) записується, але людині не
відповідають: обробник далі працює у фоні й може ще відповісти сам. Збій запису або відповіді
лише логується — `bot.catch` не кидає.
```

In the schema section, next to the other tables, add `handler_failures` (v47): columns `id`, `at` (ISO UTC), `source`, `error`; index on `at`; rows older than 90 days are pruned by the daily status.

- [ ] **Step 7: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/bot/handler-failure.ts src/bot/handler-failure.test.ts src/bot/index.ts src/i18n spec.md
git commit -m "feat(#836): bot.catch answers the person and records the failure instead of only logging it"
```

---

### Task 3: The daily status shows handler failures under «Канали»

**Files:**
- Modify: `src/domain/status/types.ts` (`StatusInputs.handlerFailures`)
- Modify: `src/domain/status/test-inputs.ts` (`greenInputs` default)
- Modify: `src/domain/status/evaluate.ts` (`evaluateChannels`)
- Modify: `src/domain/status/evaluate.test.ts`
- Modify: `src/jobs/status-inputs.ts`, `src/jobs/status-inputs.test.ts`
- Modify: `src/jobs/daily-status.ts`, `src/jobs/daily-status.test.ts` (prune)
- Modify: `spec.md`

**Interfaces:**
- Consumes: `handlerFailuresSince`, `pruneHandlerFailures`, `HandlerFailureGroup` (Task 1).
- Produces: `StatusInputs.handlerFailures: Avail<HandlerFailureGroup[]>`.

- [ ] **Step 1: Type and fixture**

`src/domain/status/types.ts`, in `StatusInputs` after `bugReports`:

```ts
  handlerFailures: Avail<HandlerFailureGroup[]>; // #836: last 24 h, most frequent first
```

with `import type { HandlerFailureGroup } from '../../storage/handler_failures';`.

`src/domain/status/test-inputs.ts`, in `greenInputs` after `bugReports: null,`:

```ts
    handlerFailures: { ok: true, value: [] },
```

- [ ] **Step 2: Write the failing evaluator tests**

Append to `src/domain/status/evaluate.test.ts` (import `evaluateChannels` and `greenInputs` if the file does not already):

```ts
describe('evaluateChannels — handler failures (#836)', () => {
  it('no failures leaves the subsystem green', () => {
    expect(evaluateChannels(greenInputs())).toEqual({ subsystem: 'channels', colour: 'green', reasons: [] });
  });

  it('one group is a yellow reason with its count and error', () => {
    const i = greenInputs({ handlerFailures: { ok: true, value: [
      { source: '/beers', error: '400: Bad Request: message is too long', count: 6 },
    ] } });
    expect(evaluateChannels(i)).toEqual({
      subsystem: 'channels', colour: 'yellow',
      reasons: ['збої команд за добу: 6 — /beers ×6 (400: Bad Request: message is too long)'],
    });
  });

  it('a single failure is already yellow', () => {
    const i = greenInputs({ handlerFailures: { ok: true, value: [{ source: '/route', error: 'fetch failed', count: 1 }] } });
    expect(evaluateChannels(i).reasons).toEqual(['збої команд за добу: 1 — /route ×1 (fetch failed)']);
  });

  it('three groups are all shown, without a remainder', () => {
    const i = greenInputs({ handlerFailures: { ok: true, value: [
      { source: '/beers', error: 'a', count: 3 },
      { source: '/route', error: 'b', count: 2 },
      { source: 'callback', error: 'c', count: 1 },
    ] } });
    expect(evaluateChannels(i).reasons).toEqual(['збої команд за добу: 6 — /beers ×3 (a), /route ×2 (b), callback ×1 (c)']);
  });

  it('beyond three groups the rest is summed as "+N інших"', () => {
    const i = greenInputs({ handlerFailures: { ok: true, value: [
      { source: '/beers', error: 'a', count: 5 },
      { source: '/route', error: 'b', count: 4 },
      { source: 'callback', error: 'c', count: 3 },
      { source: '/pubs', error: 'd', count: 2 },
      { source: 'text', error: 'e', count: 1 },
    ] } });
    expect(evaluateChannels(i).reasons).toEqual([
      'збої команд за добу: 15 — /beers ×5 (a), /route ×4 (b), callback ×3 (c) +3 інших',
    ]);
  });

  it('an error text of 60 characters is shown whole, 61 is cut to 59 plus an ellipsis', () => {
    const i = greenInputs({ handlerFailures: { ok: true, value: [
      { source: 'a', error: 'x'.repeat(60), count: 1 },
      { source: 'b', error: 'y'.repeat(61), count: 1 },
    ] } });
    expect(evaluateChannels(i).reasons).toEqual([
      `збої команд за добу: 2 — a ×1 (${'x'.repeat(60)}), b ×1 (${'y'.repeat(59)}…)`,
    ]);
  });

  it('an empty error text shows no brackets', () => {
    const i = greenInputs({ handlerFailures: { ok: true, value: [{ source: '/pubs', error: '', count: 2 }] } });
    expect(evaluateChannels(i).reasons).toEqual(['збої команд за добу: 2 — /pubs ×2']);
  });

  it('an unreadable table is "нема даних", never green', () => {
    const i = greenInputs({ handlerFailures: { ok: false, reason: 'таблицю не прочитано' } });
    expect(evaluateChannels(i)).toEqual({
      subsystem: 'channels', colour: 'yellow', reasons: ['нема даних: збої команд — таблицю не прочитано'],
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- src/domain/status/evaluate.test.ts`
Expected: the new cases with failures FAIL (reasons are `[]`).

- [ ] **Step 4: Implement in `evaluateChannels`**

In `src/domain/status/evaluate.ts`, add above `evaluateChannels`:

```ts
// #836. A text cut for the report line; the stored text is already capped at 200 code points.
const FAILURE_GROUPS_SHOWN = 3;
const FAILURE_ERROR_SHOWN = 60;
function handlerFailureFindings(input: StatusInputs['handlerFailures']): Finding[] {
  if (!input.ok) return [yellow(`нема даних: збої команд — ${input.reason}`)];
  const groups = input.value;
  if (groups.length === 0) return [];
  const sum = (gs: typeof groups) => gs.reduce((n, g) => n + g.count, 0);
  const shown = groups.slice(0, FAILURE_GROUPS_SHOWN).map((g) => {
    const chars = [...g.error];
    const error = chars.length > FAILURE_ERROR_SHOWN ? `${chars.slice(0, FAILURE_ERROR_SHOWN - 1).join('')}…` : g.error;
    return `${g.source} ×${g.count}${error === '' ? '' : ` (${error})`}`;
  });
  const rest = sum(groups.slice(FAILURE_GROUPS_SHOWN));
  return [yellow(`збої команд за добу: ${sum(groups)} — ${shown.join(', ')}${rest > 0 ? ` +${rest} інших` : ''}`)];
}
```

and inside `evaluateChannels`, just before `return evaluation('channels', f);`:

```ts
  f.push(...handlerFailureFindings(i.handlerFailures));
```

- [ ] **Step 5: Collect the input — failing test first**

Append to `src/jobs/status-inputs.test.ts`:

```ts
test('handlerFailures: the last 24 hours from now, grouped; a row a millisecond older is out', () => {
  const db = emptyDb();
  // NOW is 2026-10-06T07:00:00.000Z, so the window starts at 2026-10-05T07:00:00.000Z.
  recordHandlerFailure(db, { at: '2026-10-05T06:59:59.999Z', source: '/old', error: 'e' });
  recordHandlerFailure(db, { at: '2026-10-05T07:00:00.000Z', source: '/beers', error: 'long' });
  recordHandlerFailure(db, { at: '2026-10-06T06:00:00.000Z', source: '/beers', error: 'long' });
  expect(collectStatusInputs(db, NOW, DATE, missing).handlerFailures).toEqual({
    ok: true, value: [{ source: '/beers', error: 'long', count: 2 }],
  });
});

test('handlerFailures: an unreadable table is a value, not an exception', () => {
  const db = emptyDb();
  db.exec('DROP TABLE handler_failures');
  expect(collectStatusInputs(db, NOW, DATE, missing).handlerFailures).toEqual({
    ok: false, reason: 'таблицю збоїв не прочитано',
  });
});
```

with `import { recordHandlerFailure } from '../storage/handler_failures';`.

Run: `npm test -- src/jobs/status-inputs.test.ts` → the two new tests FAIL.

- [ ] **Step 6: Implement the collection**

In `src/jobs/status-inputs.ts`:

```ts
// #836: a table that cannot be read colours «Канали» yellow instead of taking the report down.
function readHandlerFailures(db: DB, now: Date): StatusInputs['handlerFailures'] {
  try {
    return { ok: true, value: handlerFailuresSince(db, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()) };
  } catch {
    return { ok: false, reason: 'таблицю збоїв не прочитано' };
  }
}
```

and in the object `collectStatusInputs` returns, after `bugReports`:

```ts
    handlerFailures: readHandlerFailures(db, now),
```

with `import { handlerFailuresSince } from '../storage/handler_failures';`.

- [ ] **Step 7: Prune — failing test first**

Append to `src/jobs/daily-status.test.ts` (use the file's existing way of building a db and calling `buildDailyReport`; if its helper names differ, follow the file):

```ts
test('building the report prunes handler failures older than 90 days', () => {
  const db = emptyDb();
  // The report date is 2026-10-06; 90 days back is 2026-07-08.
  recordHandlerFailure(db, { at: '2026-07-07T23:59:59.999Z', source: '/old', error: 'e' });
  recordHandlerFailure(db, { at: '2026-07-08T00:00:00.000Z', source: '/kept', error: 'e' });
  buildDailyReport(db, new Date('2026-10-06T07:00:00.000Z'), '2026-10-06', missing);
  expect(db.prepare('SELECT source FROM handler_failures ORDER BY id').all()).toEqual([{ source: '/kept' }]);
});
```

In `src/jobs/daily-status.ts`, right after the `pruneStatusSnapshots(...)` line of `buildDailyReport`:

```ts
  pruneHandlerFailures(db, `${shiftDate(dateKey, -STATUS_RULES.snapshotRetentionDays)}T00:00:00.000Z`);
```

- [ ] **Step 8: Run, then mutation-check**

Run: `npm test -- src/domain/status src/jobs/status-inputs.test.ts src/jobs/daily-status.test.ts` → PASS.

Mutations:
1. `FAILURE_GROUPS_SHOWN = 4` → the "+N інших" test fails.
2. `chars.length >= FAILURE_ERROR_SHOWN` → the 60/61 test fails.
3. Drop the `f.push(...handlerFailureFindings(...))` line → every failure test fails.
4. `23 * 60 * 60 * 1000` in `readHandlerFailures` → the window test fails.
5. Remove the `pruneHandlerFailures` line → the prune test fails.

- [ ] **Step 9: Update `spec.md`**

In the `dailyStatus` row of the cron table, after the sentence that lists the subsystems, add:

```markdown
«Канали» дістають 🟡 `збої команд за добу: N — <що> ×<скільки> (<помилка>)…` (#836), якщо за останні 24 години в `handler_failures` є хоч один рядок: до трьох найчастіших груп, решта — ` +N інших`, текст помилки до 60 символів. Це збої, що **дійшли до запису**; місця, які свідомо ковтають помилку редагування прогрес-повідомлення, сюди не потрапляють, тож 🟢 не означає «жодна команда не зламалася». Нечитабельна таблиця — `нема даних: збої команд — …`. Той самий прогін видаляє рядки, старші за 90 днів.
```

- [ ] **Step 10: Full gate and commit**

Run: `npm test && npm run typecheck`
(Any other place that builds a `StatusInputs` literal will fail typecheck until it gets `handlerFailures` — add `{ ok: true, value: [] }` there and list the files in the report.)

```bash
git add src/domain/status src/jobs/status-inputs.ts src/jobs/status-inputs.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts spec.md
git commit -m "feat(#836): the daily status shows handler failures of the last 24 hours as a yellow reason under Канали"
```

---

### Task 4: `/route` splits a long result; `/route`, `/refresh`, `/import` record their failures

**Files:**
- Modify: `src/bot/commands/route-format.ts`, `src/bot/commands/route-format.test.ts`
- Create: `src/bot/commands/route-send.ts`, `src/bot/commands/route-send.test.ts`
- Modify: `src/bot/commands/route.ts`
- Modify: `src/bot/commands/refresh.ts`, `src/bot/commands/refresh.test.ts`
- Modify: `src/bot/commands/import.ts`
- Modify: `src/i18n/locales/uk.ts`, `pl.ts`, `en.ts` (`route.failed`, `refresh.failed`)
- Modify: `spec.md`

**Interfaces:**
- Consumes: `noteFailure` (Task 2), `splitMessage` (`src/bot/commands/message-split.ts`, exists on main).
- Produces:
  - `formatRouteResult(opts): { head: string[]; lines: string[] }`
  - `sendRouteResult(messages: string[], io: RouteResultIo): Promise<void>`

- [ ] **Step 1: `formatRouteResult` returns lines — tests first**

In `src/bot/commands/route-format.test.ts` every existing test reads `out` as a string. Add once, below the imports:

```ts
const text = (r: { head: string[]; lines: string[] }): string => [...r.head, ...r.lines].join('\n');
```

and wrap each existing call: `const out = text(formatRouteResult({ … }));`. The existing assertions stay untouched — that is the proof the text did not change. Add:

```ts
  test('the header is the head; every pub starts with a blank line', () => {
    const out = formatRouteResult({ N: 3, distanceMeters: 1500, pubsInOrder: [beerBones, cuda], locale: 'uk', t: stubT });
    expect(out.head).toEqual([
      'Знайдено маршрут для <b>3</b> (чи більше) нових пив, відстань ≈ <b>1,5 км</b>, пабів у маршруті: <b>2</b>.',
    ]);
    expect(out.lines).toEqual([
      '',
      '<b>1. Beer &amp; Bones</b>',
      '     • <b>Pinta Atak Chmielu</b> • IPA  ⭐ 4.12 • 6,1%',
      '     • <b>Browar Stu Mostów Salamander</b>  ⭐ — • 4,5%',
      '',
      '<b>2. Cuda na Kiju</b>',
      '     • <b>AleBrowar IPA</b> • Double IPA  ⭐ 3.9 • 6%',
    ]);
  });
```

The literals above for distance, rating and ABV are what the existing tests in this file already assert piecewise; if the first run shows a different rendering of `1,5 км` / ` • 6,1%`, take the exact strings from the failure output, check each against an existing assertion in the file, and say so in the report — do not change production formatting.

In `route-format.ts`:

```ts
export function formatRouteResult(opts: FormatRouteOpts): { head: string[]; lines: string[] } {
  const { N, distanceMeters, pubsInOrder, locale, t } = opts;
  const km = fmtKm(locale, distanceMeters);
  const lines: string[] = [];
  pubsInOrder.forEach((p, i) => {
    lines.push('');
    lines.push(`<b>${i + 1}. ${escapeHtml(p.name)}</b>`);
    for (const beer of p.beers) {
      lines.push(
        `     • <b>${escapeHtml(beer.display)}</b>${fmtStyle(beer.style)}  ${fmtRating(beer.rating)}${fmtAbv(locale, beer.abv)}`,
      );
    }
  });
  return { head: [t('route.header', { count: N, km, pubs: pubsInOrder.length })], lines };
}
```

- [ ] **Step 2: `sendRouteResult` — failing tests**

`src/bot/commands/route-send.test.ts`:

```ts
import { sendRouteResult } from './route-send';

const KB = { inline_keyboard: [[{ text: 'Maps', url: 'https://maps.example/x' }]] };

function io(failOn?: string) {
  const calls: { via: 'edit' | 'send'; text: string; keyboard: unknown }[] = [];
  const act = (via: 'edit' | 'send') => async (text: string, keyboard?: unknown) => {
    calls.push({ via, text, keyboard: keyboard ?? null });
    return failOn === text ? Promise.reject(new Error('400: Bad Request')) : undefined;
  };
  return { calls, io: { edit: act('edit'), send: act('send') } };
}
```

(`failOn === text ? … : …` is in the stub, not in a test body.)

```ts
test('one message: it replaces the status message and carries the keyboard', async () => {
  const s = io();
  await sendRouteResult(['only'], { ...s.io, keyboard: KB });
  expect(s.calls).toEqual([{ via: 'edit', text: 'only', keyboard: KB }]);
});

test('three messages: the first is an edit, the rest are sent in order, the keyboard is under the last', async () => {
  const s = io();
  await sendRouteResult(['a', 'b', 'c'], { ...s.io, keyboard: KB });
  expect(s.calls).toEqual([
    { via: 'edit', text: 'a', keyboard: null },
    { via: 'send', text: 'b', keyboard: null },
    { via: 'send', text: 'c', keyboard: KB },
  ]);
});

test('without a keyboard nothing carries one', async () => {
  const s = io();
  await sendRouteResult(['a', 'b'], s.io);
  expect(s.calls).toEqual([
    { via: 'edit', text: 'a', keyboard: null },
    { via: 'send', text: 'b', keyboard: null },
  ]);
});

test('a failing first message rejects and sends nothing after it', async () => {
  const s = io('a');
  await expect(sendRouteResult(['a', 'b'], { ...s.io, keyboard: KB })).rejects.toThrow('400: Bad Request');
  expect(s.calls).toEqual([{ via: 'edit', text: 'a', keyboard: null }]);
});

test('a failing second message rejects and sends nothing after it', async () => {
  const s = io('b');
  await expect(sendRouteResult(['a', 'b', 'c'], { ...s.io, keyboard: KB })).rejects.toThrow('400: Bad Request');
  expect(s.calls).toEqual([
    { via: 'edit', text: 'a', keyboard: null },
    { via: 'send', text: 'b', keyboard: null },
  ]);
});

test('no messages sends nothing', async () => {
  const s = io();
  await sendRouteResult([], { ...s.io, keyboard: KB });
  expect(s.calls).toEqual([]);
});
```

Run: `npm test -- src/bot/commands/route-send.test.ts` → FAIL, module missing.

- [ ] **Step 3: Write `sendRouteResult`**

`src/bot/commands/route-send.ts`:

```ts
// #836: a /route result may need several messages (#835's splitMessage). The first replaces the
// «шукаю маршрут…» status message, the rest follow in order, and the Maps button sits under the
// LAST one so it is next to where the person finishes reading. The first failure stops the rest
// and propagates — the caller tells the person and records it.
export interface RouteResultIo<K = unknown> {
  edit: (text: string, keyboard?: K) => Promise<unknown>;
  send: (text: string, keyboard?: K) => Promise<unknown>;
  keyboard?: K;
}

export async function sendRouteResult<K>(messages: string[], io: RouteResultIo<K>): Promise<void> {
  for (const [i, message] of messages.entries()) {
    const deliver = i === 0 ? io.edit : io.send;
    await deliver(message, i === messages.length - 1 ? io.keyboard : undefined);
  }
}
```

Run the test file → PASS, 6 tests.

- [ ] **Step 4: Wire `/route`**

In `src/bot/commands/route.ts` capture `const db = ctx.deps.db;` is already there; inside the detached block replace everything from `const text = formatRouteResult({` through the `.catch((err) => log.warn({ err }, 'route result edit failed'));` with:

```ts
      const { head, lines } = formatRouteResult({
        N,
        distanceMeters: result.distanceMeters,
        pubsInOrder,
        locale,
        t,
      });
      const coords = result.pubIds.map((id) => {
        const p = pubsById.get(id)!;
        return { lat: p.lat!, lon: p.lon! };
      });
      const mapsUrl = googleMapsWalkingUrl(coords);
      const keyboard = mapsUrl
        ? Markup.inlineKeyboard([[Markup.button.url(t('route.open_in_maps'), mapsUrl)]]).reply_markup
        : undefined;
      type Keyboard = typeof keyboard;
      const extra = (kb: Keyboard) => ({ parse_mode: 'HTML' as const, ...(kb ? { reply_markup: kb } : {}) });
      // No .catch here: a rejected result must reach the catch below, which tells the person and
      // records it. It used to be a warn in the journal and «шукаю маршрут…» forever (#836).
      await sendRouteResult<Keyboard>(splitMessage(head, lines), {
        edit: (text, kb) => telegram.editMessageText(chatId, messageId, undefined, text, extra(kb)),
        send: (text, kb) => telegram.sendMessage(chatId, text, extra(kb)),
        keyboard,
      });
```

and the `catch` of the same block becomes:

```ts
    } catch (e) {
      log.error({ err: e }, 'route failed');
      noteFailure({ db, log }, '/route', e);
      await notify(t('route.failed'), { force: true });
    } finally {
```

Imports: `splitMessage` from `./message-split`, `sendRouteResult` from `./route-send`, `noteFailure` from `../handler-failure`.

- [ ] **Step 5: `/refresh` records — failing tests first**

`runRefreshPipeline` gains one optional argument, `onFailure?: (err: unknown) => void`. Append to the `runRefreshPipeline` block of `src/bot/commands/refresh.test.ts` (reuse the file's `makeNotify`, `tStub`, `silentLog`):

```ts
  test('a failing run reports it through onFailure, once, with the error', async () => {
    const { notify } = makeNotify();
    const failures: unknown[] = [];
    const boom = new Error('ontap down');
    await runRefreshPipeline({
      run: async () => { throw boom; },
      notify, t: tStub, log: silentLog,
      onFailure: (e) => { failures.push(e); },
    });
    expect(failures).toEqual([boom]);
  });

  test('a failing postRun reports it through onFailure too', async () => {
    const { notify } = makeNotify();
    const failures: unknown[] = [];
    const boom = new Error('send failed');
    await runRefreshPipeline({
      run: async () => {},
      notify, t: tStub, log: silentLog,
      postRun: async () => { throw boom; },
      onFailure: (e) => { failures.push(e); },
    });
    expect(failures).toEqual([boom]);
  });

  test('a successful run never calls onFailure', async () => {
    const { notify } = makeNotify();
    const failures: unknown[] = [];
    await runRefreshPipeline({ run: async () => {}, notify, t: tStub, log: silentLog, onFailure: (e) => { failures.push(e); } });
    expect(failures).toEqual([]);
  });
```

In `refresh.ts`: add `onFailure?: (err: unknown) => void;` to `RunRefreshPipelineArgs`, destructure it, and call `onFailure?.(e);` right after each of the two `log.error` lines (`refresh post-run failed`, `refresh failed`). At the call site in the command:

```ts
          onFailure: (e) => noteFailure({ db, log }, '/refresh', e),
```

- [ ] **Step 6: `/import` records and stops re-throwing**

Today the `catch` in `src/bot/commands/import.ts` tells the person `import.failed` and then re-throws, which lands in `bot.catch`. With Task 2 that would answer the person twice and name the row `message` (the upload is a document, not a command). Replace the tail of that `catch`:

```ts
    await report(ctx.t('import.failed', { total, message: (e as Error).message }));
    // Not re-thrown (#836): bot.catch would answer the person a second time and record the
    // failure under the update type instead of the command.
    ctx.deps.log.error({ err: e, total }, 'import failed');
    noteFailure(ctx.deps, '/import', e);
```

`src/bot/commands/import.test.ts` exists: read it. If it has a test that drives the document handler into this branch and expects a rejection, change that expectation to: the handler resolves, the last progress text is `import.failed`, and `SELECT source FROM handler_failures` equals `[{ source: '/import' }]`. If it has no such test, add one with the harness that file already uses. Report which of the two happened.

- [ ] **Step 7: Locale texts**

```ts
// uk
  'route.failed': '❌ Не вдалося побудувати маршрут. Спробуйте пізніше.',
  'refresh.failed': '❌ Не вдалося оновити. Спробуйте пізніше.',
// pl
  'route.failed': '❌ Nie udało się zbudować trasy. Spróbuj później.',
  'refresh.failed': '❌ Nie udało się odświeżyć. Spróbuj później.',
// en
  'route.failed': '❌ Could not build a route. Please try again later.',
  'refresh.failed': '❌ Refresh failed. Please try again later.',
```

If a test pins the old strings, update the literal.

- [ ] **Step 8: Mutation-check**

1. `route-send.ts`: `i === 0 ? io.keyboard : undefined` → the three-message test fails.
2. `route-send.ts`: wrap the `await deliver(...)` in `try {} catch {}` → both failure tests fail.
3. `refresh.ts`: remove `onFailure?.(e)` after `refresh post-run failed` → the postRun test fails.
4. `route-format.ts`: move the header back into `lines` → the head/lines test fails.

- [ ] **Step 9: Update `spec.md`**

In the `/route` section add:

```markdown
**Довгий маршрут і відмова надсилання (#836).** Рядки результату пакуються тим самим
`splitMessage`, що й `/beers` (#835): перше повідомлення замінює «шукаю маршрут…», решта йдуть
по черзі окремими повідомленнями, кнопка «Відкрити в Maps» стоїть під останнім. Якщо Telegram
відхиляє будь-яке з них, надсилання зупиняється, людина бачить `route.failed`, а збій
записується в `handler_failures` як `/route` — так само, як і збій побудови маршруту.
```

In the sections of `/refresh` and `/import` add one sentence each: a failure (for `/refresh` also a failure of the step after a successful refresh) is recorded in `handler_failures` under the command's name; `/import` no longer re-throws after telling the person.

- [ ] **Step 10: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/bot/commands src/i18n/locales spec.md
git commit -m "fix(#836): /route splits a long result and a rejected one is no longer silent; /route, /refresh, /import record their failures"
```

---

## Self-review notes

- Spec §3.1 → Task 2; §3.2 → Tasks 1, 2, 4; §3.3 → Task 3; §3.4 → Task 4; §6 tests → each task; §7 `spec.md` → Tasks 2, 3, 4.
- Two points were settled while reading the code and are written back into the spec: a handler timeout is recorded but not answered (the handler is still running); `/import` stops re-throwing (otherwise the person is answered twice).
- Not covered by a test: the wiring inside the detached block of `/route` (that `sendRouteResult` is called with `splitMessage(head, lines)` and that the `catch` calls `noteFailure`). `route.ts` has no handler-level test today; the parts are tested separately and the final review reads the wiring.
