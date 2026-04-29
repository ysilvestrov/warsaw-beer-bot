export type Locale = 'uk' | 'pl' | 'en';

export type PluralForms = {
  one?: string;
  few?: string;
  many?: string;
  other: string; // обов'язковий
};

export interface Messages {
  // app
  'app.start': string;
  'app.no_data_in_snapshot': string;

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
  'filters.current': string;             // {styles}, {min_rating}
  'filters.styles_changed': string;      // {styles}
  'filters.rating_changed': string;      // {rating}
  'filters.reset_done': string;          // callback answer after reset
  'filters.reset_button': string;        // inline-keyboard button label

  // lang
  'lang.prompt': string;
  'lang.changed': string;                // {name} = native name of newly chosen locale
}

export type Translator = (
  key: keyof Messages,
  params?: Record<string, string | number>,
) => string;
