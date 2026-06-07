import type { Messages } from '../types';

export const en: Messages = {
  // app
  'app.no_data_in_snapshot': 'No interesting untried beers right now.',

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
  'cmd.extension': 'browser-extension access token',

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
  'newbeers.pub_not_found': 'Pub "{query}" not found. /pubs lists available ones.',

  // beers (debug)
  'beers.usage': 'Usage: /beers <pub name fragment>. Argument required.',
  'beers.header': '🍺 <b>{pub}</b>{address}\nTaps: {count}',
  'beers.pub_not_found': 'Pub "{query}" not found. /pubs lists available ones.',
  'beers.ambiguous': 'Several pubs match — narrow the query (e.g. add a street):',
  'beers.ambiguous_item': '• {name} — {address}',
  'beers.empty': 'Pub "{pub}" has no tap data right now.',

  // pubs
  'pubs.header': 'Available pubs:',
  'pubs.empty': 'No pubs in the database yet — wait for the first /refresh.',
  'pubs.hint': 'Tip: /newbeers <name fragment> shows new beers only in matching pubs.',

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
  'filters.current':
    '🎛 Your filters\nStyles: {styles}\nABV: {abv}\nRating: {rating}\n\nTap to toggle. ♻️ — reset all.',
  'filters.any': 'any',
  'filters.family_other': 'Other',
  'filters.rating_value': 'from {rating}',
  'filters.reset_done': 'Filters reset',
  'filters.reset_button': '♻️ Reset all',

  // lang
  'lang.prompt': 'Choose interface language:',
  'lang.changed': '✅ Language switched to {name}.',

  // extension
  'extension.success':
    'Your access token for the browser extension. Add it to the extension ' +
    "settings (the \"API Token\" field). Any previous token has been revoked.\n" +
    'API URL: {url}',
};
