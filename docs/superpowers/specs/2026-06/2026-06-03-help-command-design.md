# Design: `/help` command + shared command reference + native command menu

**Date:** 2026-06-03
**Status:** approved (brainstorming) → ready for implementation plan

## Goal

Add a `/help` command that shows a short reference of **all** bot commands.
`/start` and `/help` share the **same** text. Additionally populate Telegram's
native `/` command menu (`setMyCommands`), localized for all three supported
languages (uk/pl/en).

## Context

- All commands are public (even `/refresh` — not admin-gated).
- `/start` currently replies with an onboarding-flavored `app.start` string that
  lists only some commands. This is replaced by the shared reference text.
- `setMyCommands` is never called today, so the native `/` menu is empty.
- i18n: three locales (`uk`/`pl`/`en`), each a `Messages` object;
  `createTranslator(locale)` builds a `Translator` for any locale.
  `detectLocale` defaults unknown languages to `en`.

## Approach

**Single command catalog** (chosen over hard-coding the help text + a separate
menu array, which would duplicate the command list across locales and drift).
One ordered list drives both the `/help` text and the native menu. Pure builder
functions are unit-testable, matching the project's functional/modular style and
the CLAUDE.md testing requirement.

## Components

1. **`src/bot/commands/catalog.ts`** — single source of truth:
   - `interface CommandEntry { command: string; descKey: keyof Messages }`
   - `COMMAND_CATALOG: CommandEntry[]` (ordered, see below).
   - `buildHelpText(t: Translator): string` — `help.intro`, then one line per
     entry: `/{command} — {t(descKey)}`.
   - `buildCommandMenu(t: Translator): { command: string; description: string }[]`
     — maps the catalog to Telegram `BotCommand[]`.

2. **`src/bot/commands/help.ts`** — `helpCommand` Composer: `/help` →
   `ctx.reply(buildHelpText(ctx.t))`.

3. **`src/bot/commands/start.ts`** — reply with `buildHelpText(ctx.t)` (keeps its
   `ensureProfile` side effect). The old `app.start` string is removed.

4. **`src/bot/register-command-menu.ts`** —
   `registerCommandMenu(bot, log)`: for each locale in `['uk','pl','en']`, call
   `bot.telegram.setMyCommands(buildCommandMenu(createTranslator(loc)), { language_code: loc })`;
   plus a default scope (no `language_code`) using `en` (matches `detectLocale`'s
   fallback). Wrapped in try/catch → `log.warn` on failure; startup continues.

5. **`src/index.ts`** — register `helpCommand` in the `bot.use(...)` list; after
   `createBot`, `await registerCommandMenu(bot, log)`.

6. **i18n** — add to `Messages` type and all three locales:
   - `help.intro` — one-line intro shown above the command list.
   - `cmd.start`, `cmd.help`, `cmd.link`, `cmd.import`, `cmd.newbeers`,
     `cmd.pubs`, `cmd.route`, `cmd.beers`, `cmd.filters`, `cmd.lang`,
     `cmd.refresh` — short descriptions (used by both the `/help` text and the
     native menu; keep each well under Telegram's 256-char limit).

## Command catalog (order)

1. `/newbeers` — топ непитих пив
2. `/route` — пішохідний маршрут
3. `/pubs` — список пабів
4. `/filters` — фільтри (стиль/рейтинг/ABV)
5. `/link` — прив'язати Untappd
6. `/import` — імпорт історії (CSV/JSON/ZIP)
7. `/beers` — діагностика кранів паба
8. `/refresh` — оновити дані
9. `/lang` — мова інтерфейсу
10. `/help` — ця довідка
11. `/start` — почати

## Data flow

- `/help` or `/start` → `buildHelpText(ctx.t)` → `reply`.
- Bot startup → `registerCommandMenu` → 3 localized `setMyCommands` calls +
  1 default-scope call.

## Error handling

`setMyCommands` is a network call to Telegram; on failure log at `warn` and
continue startup (the menu is a nicety, not a hard dependency).

## Testing

`catalog.test.ts`:
- `buildHelpText`: includes the intro; one line per catalog entry; each line
  starts with `/{command}`; uses the given locale's description text.
- `buildCommandMenu`: one entry per catalog command; commands are lowercase,
  carry no leading slash, and are ≤32 chars; descriptions are non-empty.
- **Completeness guard:** every `descKey` in the catalog resolves to a non-empty
  string in **all three** locales (catches a missing translation).

## Out of scope

- Per-topic grouping of the help text (flat list only).
- Admin-only command hiding (all commands are public).
- `spec.md` (OpenSpec source of truth) will be updated in the implementation PR
  per CLAUDE.md.
