import type { Messages } from '../types';

export const en: Messages = {
  // app
  'app.start': [
    "Hi! I'll help you build a route through Warsaw pubs and try something new.",
    '',
    '1) /link <untappd-username> — to pull your check-ins.',
    '2) /import — upload your Untappd CSV/JSON/ZIP export to backfill history.',
    '3) /newbeers — top untried beers on current taps.',
    '4) /route N — a route covering ≥ N untried beers with the shortest total walking distance.',
  ].join('\n'),
  'app.no_data_in_snapshot': 'No interesting untried beers right now.',

  // link
  'link.usage': 'Usage: /link <username> (or full URL untappd.com/user/<username>)',
  'link.success': '✅ Linked to untappd.com/user/{username}',

  // import
  'import.prompt':
    'Send your Untappd export: CSV, JSON or ZIP (up to 20 MB).\n' +
    'Supporter → Account → Download History. A big JSON is best zipped.',
  'import.unsupported_format': 'Unsupported format. Expected .csv, .json or .zip.',
  'import.too_large':
    'File > 20 MB — Telegram will not let the bot download it. ' +
    'Zip the JSON (compresses ≈10×) and try again.',
  'import.fetch_failed': 'Could not fetch the file from Telegram.',
  'import.starting': '⏳ Starting import…',
  'import.progress': '⏳ Imported {total}…',
  'import.done': '✅ Imported {total} check-ins ({format}).',
  'import.failed': '❌ Failed after {total} records: {message}',

  // newbeers
  'newbeers.empty': 'Nothing interesting — try /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} more',

  // route
  'route.preparing': '⏳ Building a route for ≥{count} new beers…',
  'route.matrix_progress': '🗺 Distance matrix: {cached}/{total} saved, {missing} new',
  'route.fill_missing': '🗺 Fetching unsaved pairs: {done}/{total}',
  'route.searching_tour': '🧠 Searching for the shortest tour…',
  'route.failed': '❌ Could not build a route — check the logs.',
  'route.header':
    'Found a route for <b>{count}</b> (or more) untried beers, distance ≈ <b>{km}</b>, pubs on the route: <b>{pubs}</b>.',

  // refresh
  'refresh.cooldown': '⏱ Too often — try again in a few minutes.',
  'refresh.starting': '⏳ Refreshing…',
  'refresh.done': '✅ Done.',
  'refresh.failed': '❌ Failed — check the logs.',

  // filters
  'filters.current': 'Current: styles={styles}, min_rating={min_rating}',
  'filters.styles_changed': 'styles={styles}',
  'filters.rating_changed': 'min_rating={rating}',
  'filters.reset_done': 'Filters reset',
  'filters.reset_button': 'Reset',

  // lang
  'lang.prompt': 'Choose interface language:',
  'lang.changed': '✅ Language switched to {name}.',
};
