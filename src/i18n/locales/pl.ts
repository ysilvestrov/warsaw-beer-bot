import type { Messages } from '../types';

export const pl: Messages = {
  // app
  'app.start': [
    'Cześć! Pomogę zaplanować trasę po warszawskich pubach i spróbować czegoś nowego.',
    '',
    '1) /link <untappd-username> — żeby pobrać twoje check-iny.',
    '2) /import — wyślij eksport Untappd (CSV/JSON/ZIP), by uzupełnić historię.',
    '3) /newbeers — top niespróbowanych piw z aktualnych kranów.',
    '4) /route N — trasa pokrywająca ≥ N niespróbowanych piw z najkrótszą trasą pieszą.',
  ].join('\n'),
  'app.no_data_in_snapshot': 'Aktualnie brak ciekawych niespróbowanych piw.',

  // link
  'link.usage': 'Użycie: /link <username> (lub pełny URL untappd.com/user/<username>)',
  'link.success': '✅ Powiązano z untappd.com/user/{username}',

  // import
  'import.prompt':
    'Wyślij eksport z Untappd: CSV, JSON lub ZIP (do 20 MB).\n' +
    'Supporter → Account → Download History. Duży JSON lepiej spakować w ZIP.',
  'import.unsupported_format': 'Nieobsługiwany format. Oczekuję .csv, .json lub .zip.',
  'import.too_large':
    'Plik > 20 MB — Telegram nie pozwoli botowi go pobrać. ' +
    'Spakuj JSON do ZIP (kompresuje się ≈10×) i wyślij ponownie.',
  'import.fetch_failed': 'Nie udało się pobrać pliku z Telegrama.',
  'import.starting': '⏳ Rozpoczynam import…',
  'import.progress': '⏳ Zaimportowano {total}…',
  'import.done': '✅ Zaimportowano {total} check-inów ({format}).',
  'import.failed': '❌ Błąd po {total} wpisach: {message}',

  // newbeers
  'newbeers.empty': 'Nic ciekawego — spróbuj /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} innych',

  // route
  'route.preparing': '⏳ Buduję trasę dla ≥{count} nowych piw…',
  'route.matrix_progress': '🗺 Macierz dystansów: {cached}/{total} z zapisanych, {missing} nowych',
  'route.fill_missing': '🗺 Pobieram brakujące pary: {done}/{total}',
  'route.searching_tour': '🧠 Szukam najkrótszej trasy…',
  'route.failed': '❌ Nie udało się zbudować trasy — sprawdź logi.',
  'route.header':
    'Znaleziono trasę dla <b>{count}</b> (lub więcej) nowych piw, dystans ≈ <b>{km}</b>, liczba pubów na trasie: <b>{pubs}</b>.',

  // refresh
  'refresh.cooldown': '⏱ Za często — spróbuj za kilka minut.',
  'refresh.starting': '⏳ Aktualizuję…',
  'refresh.done': '✅ Gotowe.',
  'refresh.failed': '❌ Nie udało się — sprawdź logi.',

  // filters
  'filters.current': 'Aktualne: styles={styles}, min_rating={min_rating}',
  'filters.styles_changed': 'styles={styles}',
  'filters.rating_changed': 'min_rating={rating}',
  'filters.reset_done': 'Zresetowano',
  'filters.reset_button': 'Resetuj',

  // lang
  'lang.prompt': 'Wybierz język interfejsu:',
  'lang.changed': '✅ Zmieniono język na {name}.',
};
