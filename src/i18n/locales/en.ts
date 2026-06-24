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
  'cmd.city': 'choose city',
  'city.prompt': 'Current city: {name}. Choose a city:',
  'city.changed': '✅ City changed to {name}.',
  'cmd.help': 'this help',
  'cmd.start': 'start',
  'cmd.extension': 'browser-extension access token',
  'cmd.status': 'your status & settings',

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
  'route.open_in_maps': '🗺 Open route in Google Maps',
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

  // status
  'status.title': '📊 Your status',
  'status.settings_header': '⚙️ Settings',
  'status.city': 'City: {name}',
  'status.language': 'Language: {name}',
  'status.language_auto': 'auto',
  'status.filters': 'Filters: {summary}',
  'status.filters_none': 'none',
  'status.filter_styles': 'styles: {list}',
  'status.filter_rating': 'min ★{rating}',
  'status.filter_abv': 'ABV {min}–{max}%',
  'status.filter_route': 'route {n}',
  'status.filters_edit': 'Edit via /filters',
  'status.untappd_header': '🍺 Untappd',
  'status.not_linked': 'Not linked. Use /link to connect, or /import your history.',
  'status.username': 'Account: {username}',
  'status.checkins': 'Check-ins synced: {synced}',
  'status.checkins_of': 'Check-ins synced: {synced} / {total}',
  'status.distinct_beers': 'Distinct beers had: {count}',
  'status.last_checkin': 'Last check-in: {date}',
  'status.no_checkins': 'No check-ins yet — try /import or the extension.',

  // extension
  'extension.success':
    'Your access token for the browser extension. Add it to the extension ' +
    "settings (the \"API Token\" field). Any previous token has been revoked.\n" +
    'API URL: {url}',
  'extension.download': 'Current extension version: v{version} (file below).',
  'extrel.no_match':
    'This file does not match the latest release row. Run npm run release first, then send that exact zip.',
  'extrel.attached': 'Attached the file to v{version}. {n} tester(s) will receive it.',
  'extrel.btn_send': '📣 Broadcast',
  'extrel.btn_cancel': 'Cancel',
  'extrel.sending': 'Broadcasting v{version}…',
  'extrel.broadcast_done': 'Done. Sent {sent}, failed {failed}.',
  'extrel.cancelled': 'Cancelled, not broadcast.',
  'extrel.new_version': '🔔 New extension version v{version}',
  'extrel.how_to_update':
    'How to update: unzip over the same folder and click ↻ on the extension card in chrome://extensions. Your token and settings are kept.',
};
