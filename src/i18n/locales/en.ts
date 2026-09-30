import type { Messages } from '../types';

export const en: Messages = {
  // app
  'app.no_data_in_snapshot': 'No interesting untried beers right now.',

  // common
  'common.interrupted_by_restart': '⚠️ Interrupted by a restart — please re-run the command.',

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
  'city.outside': '🌍 Outside Poland',
  'city.blocked': 'This command only works for cities in Poland. Pick a city: /city',
  'help.city_hint':
    'A few more commands (pubs, route, top beers) unlock once you pick a city — /city',
  'cmd.help': 'this help',
  'cmd.start': 'start',
  'cmd.extension': 'browser-extension access token',
  'cmd.announce': 'extension release announcements',
  'cmd.status': 'your status & settings',

  // link
  'link.usage': 'Usage: /link <username> (or full URL untappd.com/user/<username>)',
  'link.success': "✅ Linked to untappd.com/user/{username}. Showing this account’s history. Use “Sync my check-ins” in the extension or /import to update it.",
  'link.switched': "✅ Linked to untappd.com/user/{username}. Showing this account’s history; the previous account’s history is saved separately. Use “Sync my check-ins” in the extension or /import to update it.",

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
  'import.account_changed': '⏹ Import for {username} stopped because the account changed. Saved {total} rows; start a new import for the current account.',
  'import.unlinked': 'unlinked history',
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
  'status.profile_total_hint': 'Untappd total is the last known value.',
  'status.last_sync': 'Last sync activity: {date} UTC',
  'status.no_sync': 'No extension sync yet.',
  'status.had_without_checkins': 'Beers known to the server without imported check-ins: {count}. Run “Sync my check-ins” in the extension.',
  'status.distinct_beers': 'Distinct beers had: {count}',
  'status.last_checkin': 'Last check-in: {date}',
  'status.no_checkins': 'No check-ins yet — try /import or the extension.',

  // extension
  'extension.success':
    'Your access token for the browser extension. Add it to the extension ' +
    "settings (the \"API Token\" field). Any previous token has been revoked.\n" +
    'API URL: {url}',
  'extension.store':
    'Install the extension: {url}\n' +
    'If you see "Item not available", sign in to your Google account and reload ' +
    '(the extension is flagged 18+ because it is about beer).',
  'extension.mcp':
    'The same token also works over MCP — ask from Claude Code or Codex which beers ' +
    'on a list you have already had, and how you rated them where the match is certain: {url}',

  // announce (#379)
  'announce.released':
    '🍺 The extension has been updated to version {version} — Chrome will pick it up on its own shortly.',
  'announce.changelog': "What's new: {url}",
  'announce.opt_out_hint': "Don't want these — send /announce off.",
  'announce.status_on': 'Release announcements: on. Turn off with /announce off',
  'announce.status_off': 'Release announcements: off. Turn on with /announce on',
  'announce.turned_on': "Done — I'll tell you about new extension versions.",
  'announce.turned_off': "Done — I won't bother you again. Turn back on with /announce on",
  'announce.no_token':
    'Announcements only go to extension token holders, though — get one with /extension.',

  // bug reports
  'cmd.report': 'report a bug in the bot or extension',
  'report.ask_source': 'Where is the bug?',
  'report.source.bot': 'Bot',
  'report.source.extension': 'Extension',
  'report.ask_category': 'What is wrong?',
  'report.cat.wrong_beer': 'Wrong beer / someone else\'s rating',
  'report.cat.no_rating': 'Beer without a rating',
  'report.cat.had_status': 'Incorrect had / not had status',
  'report.cat.stale_data': 'Outdated or wrong pub / taps / shop data',
  'report.cat.route': 'Route or map',
  'report.cat.no_badge': 'Badge missing on a shop page',
  'report.cat.ext_broken': 'Extension broken: sign-in, install, update, menu',
  'report.cat.bot_broken': 'Bot does not respond, freezes, or shows an error',
  'report.cat.text_ui': 'Text, translation, appearance',
  'report.cat.other': 'Other',
  'report.ask_text': 'Describe what happened and what should have happened — at least 10 characters.',
  'report.too_short': 'Too short — write at least 10 characters.',
  'report.ask_media': 'You can add up to 3 screenshots or videos (up to 20 MB), or tap “No media”.',
  'report.media_added': 'Added ({n}/{max}).',
  'report.media_full': 'Already 3 files — no more can be added. Tap “Done”.',
  'report.media_too_big': 'This file is over 20 MB — the bot cannot download it.',
  'report.btn.done': 'Done',
  'report.btn.no_media': 'No media',
  'report.btn.send': 'Send',
  'report.btn.cancel': 'Cancel',
  'report.confirm': 'Review your report:\n{source} · {category}\n\n{text}\n\nMedia: {media}\n\nA summary of your description will be published publicly on GitHub. Screenshots and videos will not be public — only developers can see them on the server. Do not include personal information in your description.',
  'report.accepted': 'Received, analyzing…',
  'report.retry': 'The report could not be accepted — press “Send” again.',
  'report.cancelled': 'Report cancelled.',
  'report.expired': 'This draft has expired — start again with /report',
  'report.limit': 'You have already sent 3 reports today, the daily maximum. Try tomorrow.',
  'report.banned': 'Reports are unavailable for you.',
  'report.unavailable': 'Reports are temporarily unavailable.',
  'report.private_only': 'Reports are accepted only in a private chat with the bot.',
  'report.done.created': 'Thank you! Created issue: {url}',
  'report.done.duplicate_open': 'Thank you! This is already known and open — your details were added: {url}',
  'report.done.duplicate_closed_fixed': 'This was fixed on {date}. If you still see it after updating, report it again: {url}',
  'report.done.duplicate_closed': 'This was already reported (closed on {date}): {url}',
  'report.done.not_a_bug': 'This does not look like a bug in the bot or extension.',
  'report.done.deferred': 'Received — I will respond later.',
  'report.done.needs_review': 'Received — a developer will review this manually.',
  'report.done.failed': 'The report could not be processed — a developer will look into it.',
  'reportban.usage': 'Usage: /reportban <telegram_id> [off]',
  'reportban.banned': 'Reports disabled for {id}.',
  'reportban.unbanned': 'Reports enabled for {id}.',

  // WFP festival mode
  'fest.no_fest': 'There is no festival to join right now.',
  'fest.team_created': 'A team for “{fest}” was created for this chat. Press the button to join.',
  'fest.join_button': '🙋 I’m in the team',
  'fest.joined': '✅ {name} joined the team.',
  'fest.already_member': 'You are already in the team.',
  'fest.need_link': 'First link Untappd in a private chat with the bot: /link <username>',
  'fest.no_team': 'You are not in any festival team. Send /fest in your team’s group chat.',
  'fest.pick_team': 'Pick a team:',
  'fest.not_member': 'This is for team members — press “I’m in the team”.',
  'fest.menu_empty': 'The festival menu has not been loaded yet.',
  'fest.menu_line': 'Beers on the menu: {count}, updated at {time}.',
  'fest.no_targets': 'There are no Targets in the menu for this team.',
  'fest.legend': '🍺 — Targets being poured now · ❔ — we cannot see',
  'fest.stand': 'floor {floor}, {stand}',
  'fest.stand_floor_only': 'floor {floor}',
  'fest.status_on_tap': '🟢 checked in {mins} min ago ({count})',
  'fest.status_not_seen': '⚪ not seen in the last hour',
  'fest.status_unknown': '❔ unknown — we did not see the whole hour',
  'fest.section_gone': 'That section is no longer ranked — send /fest again.',
};
