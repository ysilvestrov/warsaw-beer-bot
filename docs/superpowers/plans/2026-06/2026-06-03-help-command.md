# /help command + shared command reference + native menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/help` command that shows a short reference of all bot commands, make `/start` share the same text, and populate Telegram's native `/` menu (localized uk/pl/en).

**Architecture:** A single ordered command catalog (`catalog.ts`) drives two pure builders — `buildHelpText` (the `/help` and `/start` message) and `buildCommandMenu` (Telegram `setMyCommands` array). Command descriptions are i18n keys, so both outputs are localized from one source. A startup helper registers the menu per language.

**Tech Stack:** Node.js, TypeScript, Telegraf, Jest. Existing i18n: `createTranslator(locale)` → `Translator = (key: keyof Messages, params?) => string`.

---

## File structure

- `src/bot/commands/catalog.ts` (new) — catalog + `buildHelpText` + `buildCommandMenu`.
- `src/bot/commands/catalog.test.ts` (new) — builder + translation-completeness tests.
- `src/bot/commands/help.ts` (new) — `/help` handler.
- `src/bot/commands/start.ts` (modify) — reply with shared help text.
- `src/bot/register-command-menu.ts` (new) — `registerCommandMenu(bot, log)`.
- `src/bot/register-command-menu.test.ts` (new).
- `src/i18n/types.ts` (modify) — add `help.intro` + `cmd.*` keys; remove `app.start`.
- `src/i18n/locales/{uk,pl,en}.ts` (modify) — add strings; remove `app.start`.
- `src/index.ts` (modify) — register `helpCommand`; call `registerCommandMenu`.
- `spec.md` (modify) — document the command.

---

### Task 1: Add i18n description keys (config — added directly, verified by tsc)

**Files:**
- Modify: `src/i18n/types.ts` (the `Messages` interface)
- Modify: `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts`

- [ ] **Step 1: Add keys to the `Messages` interface**

In `src/i18n/types.ts`, inside `export interface Messages {`, just after the `// app` block (after `'app.no_data_in_snapshot': string;`), add:

```ts
  // help / command catalog
  'help.intro': string;
  'cmd.newbeers': string;
  'cmd.route': string;
  'cmd.pubs': string;
  'cmd.filters': string;
  'cmd.link': string;
  'cmd.import': string;
  'cmd.beers': string;
  'cmd.refresh': string;
  'cmd.lang': string;
  'cmd.help': string;
  'cmd.start': string;
```

- [ ] **Step 2: Add the Ukrainian strings**

In `src/i18n/locales/uk.ts`, right after the `'app.no_data_in_snapshot': ...` line, add (note: use double quotes for `cmd.link` — it contains an apostrophe):

```ts
  // help / command catalog
  'help.intro': 'Команди бота:',
  'cmd.newbeers': 'топ непитих пив',
  'cmd.route': 'пішохідний маршрут',
  'cmd.pubs': 'список пабів',
  'cmd.filters': 'фільтри (стиль/рейтинг/ABV)',
  'cmd.link': "прив'язати Untappd",
  'cmd.import': 'імпорт історії (CSV/JSON/ZIP)',
  'cmd.beers': 'діагностика кранів паба',
  'cmd.refresh': 'оновити дані',
  'cmd.lang': 'мова інтерфейсу',
  'cmd.help': 'ця довідка',
  'cmd.start': 'почати',
```

- [ ] **Step 3: Add the Polish strings**

In `src/i18n/locales/pl.ts`, after its `'app.no_data_in_snapshot': ...` line, add:

```ts
  // help / command catalog
  'help.intro': 'Komendy bota:',
  'cmd.newbeers': 'top niepitych piw',
  'cmd.route': 'trasa piesza',
  'cmd.pubs': 'lista pubów',
  'cmd.filters': 'filtry (styl/ocena/ABV)',
  'cmd.link': 'połącz Untappd',
  'cmd.import': 'import historii (CSV/JSON/ZIP)',
  'cmd.beers': 'diagnostyka kranów pubu',
  'cmd.refresh': 'odśwież dane',
  'cmd.lang': 'język interfejsu',
  'cmd.help': 'ta pomoc',
  'cmd.start': 'start',
```

- [ ] **Step 4: Add the English strings**

In `src/i18n/locales/en.ts`, after its `'app.no_data_in_snapshot': ...` line, add:

```ts
  // help / command catalog
  'help.intro': 'Bot commands:',
  'cmd.newbeers': 'top untried beers',
  'cmd.route': 'walking route',
  'cmd.pubs': 'list of pubs',
  'cmd.filters': 'filters (style/rating/ABV)',
  'cmd.link': 'link Untappd',
  'cmd.import': 'import history (CSV/JSON/ZIP)',
  'cmd.beers': 'pub taps diagnostics',
  'cmd.refresh': 'refresh data',
  'cmd.lang': 'interface language',
  'cmd.help': 'this help',
  'cmd.start': 'start',
```

- [ ] **Step 5: Verify tsc passes (all locales satisfy the new interface)**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors. (A missing key in any locale would be a TS error here.)

- [ ] **Step 6: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts
git commit -m "i18n(help): add help.intro + cmd.* command descriptions (uk/pl/en)"
```

---

### Task 2: Command catalog + builders (TDD)

**Files:**
- Create: `src/bot/commands/catalog.ts`
- Test: `src/bot/commands/catalog.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/bot/commands/catalog.test.ts`:

```ts
import { COMMAND_CATALOG, buildHelpText, buildCommandMenu } from './catalog';
import { createTranslator } from '../../i18n';
import type { Locale } from '../../i18n/types';

const LOCALES: Locale[] = ['uk', 'pl', 'en'];

describe('buildHelpText', () => {
  test('includes the intro and one line per command, each starting with /command', () => {
    const t = createTranslator('en');
    const text = buildHelpText(t);
    expect(text).toContain(t('help.intro'));
    for (const e of COMMAND_CATALOG) {
      expect(text).toContain(`/${e.command} — ${t(e.descKey)}`);
    }
    const cmdLines = text.split('\n').filter((l) => l.startsWith('/'));
    expect(cmdLines).toHaveLength(COMMAND_CATALOG.length);
  });
});

describe('buildCommandMenu', () => {
  test('one entry per command; lowercase, no slash, <=32 chars; non-empty descriptions', () => {
    const menu = buildCommandMenu(createTranslator('uk'));
    expect(menu).toHaveLength(COMMAND_CATALOG.length);
    for (const c of menu) {
      expect(c.command).toMatch(/^[a-z]+$/);
      expect(c.command.length).toBeLessThanOrEqual(32);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe('catalog translations are complete', () => {
  test('every descKey + help.intro resolve to non-empty, placeholder-free strings in all locales', () => {
    for (const loc of LOCALES) {
      const t = createTranslator(loc);
      expect(t('help.intro').length).toBeGreaterThan(0);
      for (const e of COMMAND_CATALOG) {
        const s = t(e.descKey);
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toContain('{');
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/bot/commands/catalog.test.ts`
Expected: FAIL — `Cannot find module './catalog'`.

- [ ] **Step 3: Write the catalog and builders**

Create `src/bot/commands/catalog.ts`:

```ts
import type { Messages, Translator } from '../../i18n/types';

export interface CommandEntry {
  command: string;
  descKey: keyof Messages;
}

// Single source of truth for both the /help text and the native Telegram menu.
export const COMMAND_CATALOG: CommandEntry[] = [
  { command: 'newbeers', descKey: 'cmd.newbeers' },
  { command: 'route', descKey: 'cmd.route' },
  { command: 'pubs', descKey: 'cmd.pubs' },
  { command: 'filters', descKey: 'cmd.filters' },
  { command: 'link', descKey: 'cmd.link' },
  { command: 'import', descKey: 'cmd.import' },
  { command: 'beers', descKey: 'cmd.beers' },
  { command: 'refresh', descKey: 'cmd.refresh' },
  { command: 'lang', descKey: 'cmd.lang' },
  { command: 'help', descKey: 'cmd.help' },
  { command: 'start', descKey: 'cmd.start' },
];

export function buildHelpText(t: Translator): string {
  const lines = COMMAND_CATALOG.map((e) => `/${e.command} — ${t(e.descKey)}`);
  return [t('help.intro'), '', ...lines].join('\n');
}

// Shape is structurally compatible with Telegraf's BotCommand[] — no type import needed.
export function buildCommandMenu(t: Translator): { command: string; description: string }[] {
  return COMMAND_CATALOG.map((e) => ({ command: e.command, description: t(e.descKey) }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/bot/commands/catalog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/catalog.ts src/bot/commands/catalog.test.ts
git commit -m "feat(help): command catalog + buildHelpText/buildCommandMenu builders"
```

---

### Task 3: `/help` handler + `/start` shares the text + remove `app.start`

**Files:**
- Create: `src/bot/commands/help.ts`
- Modify: `src/bot/commands/start.ts`
- Modify: `src/i18n/types.ts`, `src/i18n/locales/{uk,pl,en}.ts` (remove `app.start`)

- [ ] **Step 1: Create the `/help` handler**

Create `src/bot/commands/help.ts`:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildHelpText } from './catalog';

export const helpCommand = new Composer<BotContext>();

helpCommand.command('help', async (ctx) => {
  await ctx.reply(buildHelpText(ctx.t));
});
```

- [ ] **Step 2: Point `/start` at the shared help text**

Replace the body of `src/bot/commands/start.ts` with:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile } from '../../storage/user_profiles';
import { buildHelpText } from './catalog';

export const startCommand = new Composer<BotContext>();

startCommand.command('start', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  await ctx.reply(buildHelpText(ctx.t));
});
```

- [ ] **Step 3: Confirm nothing else references `app.start`**

Run: `grep -rn "app.start" src/`
Expected: no matches (only the now-replaced start.ts used it). If any remain, stop and reconcile before removing the key.

- [ ] **Step 4: Remove the `app.start` key**

- In `src/i18n/types.ts`: delete the `'app.start': string;` line from `Messages`.
- In `src/i18n/locales/uk.ts`, `pl.ts`, `en.ts`: delete each `'app.start': [...]`/`'app.start': '...'` entry (multi-line array in uk).

- [ ] **Step 5: Verify tsc + full test suite**

Run: `npx tsc --noEmit && npx jest`
Expected: tsc exit 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/help.ts src/bot/commands/start.ts src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts
git commit -m "feat(help): /help command; /start shares the command reference; drop app.start"
```

---

### Task 4: Register the native command menu + wire into startup (TDD)

**Files:**
- Create: `src/bot/register-command-menu.ts`
- Test: `src/bot/register-command-menu.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/bot/register-command-menu.test.ts`:

```ts
import pino from 'pino';
import { registerCommandMenu } from './register-command-menu';

const silent = pino({ level: 'silent' });

test('registers a localized menu per language (uk/pl/en) plus a default scope', async () => {
  const calls: { opts?: { language_code?: string } }[] = [];
  const bot = {
    telegram: {
      setMyCommands: jest.fn(async (_cmds: unknown, opts?: { language_code?: string }) => {
        calls.push({ opts });
      }),
    },
  };
  await registerCommandMenu(bot as never, silent);
  expect(bot.telegram.setMyCommands).toHaveBeenCalledTimes(4);
  expect(calls.slice(0, 3).map((c) => c.opts?.language_code)).toEqual(['uk', 'pl', 'en']);
  expect(calls[3].opts).toBeUndefined(); // default scope: no language_code
});

test('swallows a setMyCommands failure (logs, does not throw)', async () => {
  const bot = {
    telegram: { setMyCommands: jest.fn(async () => { throw new Error('network'); }) },
  };
  await expect(registerCommandMenu(bot as never, silent)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/bot/register-command-menu.test.ts`
Expected: FAIL — `Cannot find module './register-command-menu'`.

- [ ] **Step 3: Write the menu registration helper**

Create `src/bot/register-command-menu.ts`:

```ts
import type { Telegraf } from 'telegraf';
import type pino from 'pino';
import type { BotContext } from './index';
import type { Locale } from '../i18n/types';
import { createTranslator } from '../i18n';
import { buildCommandMenu } from './commands/catalog';

const MENU_LOCALES: Locale[] = ['uk', 'pl', 'en'];
const DEFAULT_LOCALE: Locale = 'en'; // mirrors detectLocale's fallback

export async function registerCommandMenu(
  bot: Telegraf<BotContext>,
  log: pino.Logger,
): Promise<void> {
  try {
    for (const loc of MENU_LOCALES) {
      await bot.telegram.setMyCommands(buildCommandMenu(createTranslator(loc)), {
        language_code: loc,
      });
    }
    // Default scope for clients whose language isn't uk/pl/en.
    await bot.telegram.setMyCommands(buildCommandMenu(createTranslator(DEFAULT_LOCALE)));
    log.info('command menu registered');
  } catch (e) {
    log.warn({ err: e }, 'setMyCommands failed — native command menu not updated');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/bot/register-command-menu.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `src/index.ts`**

Add imports next to the other command imports (after `import { langCommand } from './bot/commands/lang';`):

```ts
import { helpCommand } from './bot/commands/help';
import { registerCommandMenu } from './bot/register-command-menu';
```

Add `helpCommand,` to the `bot.use(...)` list (e.g. right after `langCommand,`).

Immediately before `bot.launch();` (line ~122), add:

```ts
  await registerCommandMenu(bot, log);
```

(`bot.launch()` is not awaited — its promise resolves only on stop — so register the menu before it. `registerCommandMenu` catches its own errors, so the await never throws.)

- [ ] **Step 6: Verify tsc + full suite**

Run: `npx tsc --noEmit && npx jest`
Expected: tsc exit 0; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/bot/register-command-menu.ts src/bot/register-command-menu.test.ts src/index.ts
git commit -m "feat(help): register localized native command menu on startup"
```

---

### Task 5: Update `spec.md` (OpenSpec source of truth, per CLAUDE.md)

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document the command**

In the commands section of `spec.md`, add a `/help` subsection and note the shared text + native menu. Suggested content (place near `/start` / the other command subsections; match surrounding heading style):

```markdown
### `/help` та `/start` — довідник команд
Обидві команди віддають **один спільний** короткий список усіх команд бота
(`buildHelpText` з `src/bot/commands/catalog.ts` — єдине джерело істини).
`/start` додатково створює профіль (`ensureProfile`). Локалізовано (uk/pl/en).

Нативне меню Telegram («/») заповнюється на старті через `registerCommandMenu`
(`setMyCommands` для uk/pl/en + дефолтний англійський scope), з того ж каталогу.
```

- [ ] **Step 2: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document /help, shared command reference, native menu"
```

---

## Self-review

- **Spec coverage:** catalog + builders (Task 2) ✓; `/help` handler (Task 3) ✓; `/start` shares text (Task 3) ✓; `app.start` removed (Task 3) ✓; localized native menu uk/pl/en + default (Task 4) ✓; startup wiring (Task 4) ✓; i18n keys all locales (Task 1) ✓; error handling/log.warn (Task 4 test) ✓; tests incl. completeness guard (Task 2) ✓; spec.md (Task 5) ✓.
- **Placeholders:** none — all code and locale strings are concrete.
- **Type consistency:** `Translator = (key: keyof Messages, params?) => string`; `buildHelpText(t)`/`buildCommandMenu(t)` used identically in catalog, help.ts, start.ts, register-command-menu.ts; `COMMAND_CATALOG` entries use `descKey: keyof Messages` and every key is added in Task 1; `registerCommandMenu(bot, log)` signature matches its call in index.ts.
```
