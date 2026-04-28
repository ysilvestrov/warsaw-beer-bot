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
  'route.header': string;                // {count}, {km}, {pubs}

  // refresh
  'refresh.cooldown': string;
  'refresh.starting': string;
  'refresh.done': string;
  'refresh.failed': string;

  // filters
  'filters.current': string;             // {styles}, {min_rating}
  'filters.styles_changed': string;      // {styles}
  'filters.rating_changed': string;      // {rating}
  'filters.reset_done': string;
}

export type Translator = (
  key: keyof Messages,
  params?: Record<string, string | number>,
) => string;
