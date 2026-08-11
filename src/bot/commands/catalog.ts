import type { Messages, Translator } from '../../i18n/types';

export interface CommandEntry {
  command: string;
  descKey: keyof Messages;
  // #399: needs an active Polish city. Same flag feeds the /help filter and the
  // city gate (src/bot/commands/city-gate.ts) — one list, no drift.
  cityScoped?: true;
}

// Single source of truth for both the /help text and the native Telegram menu.
export const COMMAND_CATALOG: CommandEntry[] = [
  { command: 'newbeers', descKey: 'cmd.newbeers', cityScoped: true },
  { command: 'route', descKey: 'cmd.route', cityScoped: true },
  { command: 'pubs', descKey: 'cmd.pubs', cityScoped: true },
  { command: 'filters', descKey: 'cmd.filters' },
  { command: 'link', descKey: 'cmd.link' },
  { command: 'import', descKey: 'cmd.import' },
  { command: 'extension', descKey: 'cmd.extension' },
  { command: 'beers', descKey: 'cmd.beers', cityScoped: true },
  { command: 'refresh', descKey: 'cmd.refresh', cityScoped: true },
  { command: 'lang', descKey: 'cmd.lang' },
  { command: 'city', descKey: 'cmd.city' },
  { command: 'status', descKey: 'cmd.status' },
  { command: 'help', descKey: 'cmd.help' },
  { command: 'start', descKey: 'cmd.start' },
];

// `allowed` = the user has an active Polish city. When false, city-scoped commands are
// hidden and replaced by a single hint line (#399).
export function buildHelpText(t: Translator, allowed: boolean): string {
  const entries = allowed ? COMMAND_CATALOG : COMMAND_CATALOG.filter((e) => !e.cityScoped);
  const lines = entries.map((e) => `/${e.command} — ${t(e.descKey)}`);
  const tail = allowed ? [] : ['', t('help.city_hint')];
  return [t('help.intro'), '', ...lines, ...tail].join('\n');
}

// Shape is structurally compatible with Telegraf's BotCommand[] — no type import needed.
export function buildCommandMenu(t: Translator): { command: string; description: string }[] {
  return COMMAND_CATALOG.map((e) => ({ command: e.command, description: t(e.descKey) }));
}
