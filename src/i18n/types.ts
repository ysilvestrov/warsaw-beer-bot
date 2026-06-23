export type Locale = 'uk' | 'pl' | 'en';

export type PluralForms = {
  one?: string;
  few?: string;
  many?: string;
  other: string; // обов'язковий
};

export interface Messages {
  // app
  'app.no_data_in_snapshot': string;

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
  'cmd.city': string;
  'city.prompt': string;                 // {name} = current city
  'city.changed': string;                // {name}
  'cmd.help': string;
  'cmd.start': string;
  'cmd.extension': string;
  'cmd.status': string;

  // link
  'link.usage': string;
  'link.success': string;                // {username}

  // import
  'import.prompt': string;
  'import.unsupported_format': string;
  'import.too_large': string;
  'import.fetch_failed': string;
  'import.starting': string;
  'import.progress': string;             // {total}
  'import.done': string;                 // {total}, {format}
  'import.failed': string;              // {total}, {message}

  // newbeers
  'newbeers.empty': string;
  'newbeers.more_pubs_suffix': string;   // {extra}
  'newbeers.pub_not_found': string;      // {query}

  // beers (debug: raw tap dump for one pub)
  'beers.usage': string;
  'beers.header': string;          // {pub}, {address}, {count}
  'beers.pub_not_found': string;   // {query}
  'beers.ambiguous': string;
  'beers.ambiguous_item': string;  // {name}, {address}
  'beers.empty': string;           // {pub}

  // pubs
  'pubs.header': string;
  'pubs.empty': string;
  'pubs.hint': string;

  // route
  'route.preparing': string;             // {count}
  'route.matrix_progress': string;       // {cached}, {total}, {missing}
  'route.fill_missing': string;          // {done}, {total}
  'route.searching_tour': string;
  'route.failed': string;
  // {count}=number, {km}=pre-formatted string from fmtKm() (e.g. "14,4 км"
  // in uk, "14.4 km" in en) — translators must NOT append the unit themselves,
  // {pubs}=number
  'route.header': string;

  // refresh
  'refresh.cooldown': string;
  'refresh.starting': string;
  'refresh.done': string;
  'refresh.failed': string;

  // filters
  'filters.current': string;             // {styles}, {abv}, {rating} — multi-line summary
  'filters.any': string;                 // value shown when a filter is unset
  'filters.family_other': string;        // localized label for the Other style bucket
  'filters.rating_value': string;        // {rating} — e.g. "from 3.8"
  'filters.reset_done': string;          // callback answer after reset
  'filters.reset_button': string;        // inline-keyboard button label

  // lang
  'lang.prompt': string;
  'lang.changed': string;                // {name} = native name of newly chosen locale

  // extension (browser-extension API token)
  'extension.success': string;   // {url} — instructional text; token sent separately in <code>
  'extension.download': string;  // {version} — caption for the latest release zip

  // status (/status — per-user freshness + settings)
  'status.title': string;
  'status.settings_header': string;
  'status.city': string;              // {name}
  'status.language': string;          // {name}
  'status.language_auto': string;
  'status.filters': string;           // {summary}
  'status.filters_none': string;
  'status.filter_styles': string;     // {list}
  'status.filter_rating': string;     // {rating}
  'status.filter_abv': string;        // {min}, {max}
  'status.filter_route': string;      // {n}
  'status.filters_edit': string;
  'status.untappd_header': string;
  'status.not_linked': string;
  'status.username': string;          // {username}
  'status.checkins': string;          // {synced}
  'status.checkins_of': string;       // {synced}, {total}
  'status.distinct_beers': string;    // {count}
  'status.last_checkin': string;      // {date}
  'status.no_checkins': string;

  // extension release / distribution (admin-facing + broadcast)
  'extrel.no_match': string;
  'extrel.attached': string;          // {version}, {n}
  'extrel.btn_send': string;
  'extrel.btn_cancel': string;
  'extrel.sending': string;           // {version}
  'extrel.broadcast_done': string;    // {sent}, {failed}
  'extrel.cancelled': string;
  'extrel.new_version': string;       // {version}
  'extrel.how_to_update': string;
}

export type Translator = (
  key: keyof Messages,
  params?: Record<string, string | number>,
) => string;
