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
  { command: 'extension', descKey: 'cmd.extension' },
  { command: 'beers', descKey: 'cmd.beers' },
  { command: 'refresh', descKey: 'cmd.refresh' },
  { command: 'lang', descKey: 'cmd.lang' },
  { command: 'city', descKey: 'cmd.city' },
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
