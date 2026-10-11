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
