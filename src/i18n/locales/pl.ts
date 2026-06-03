import type { Messages } from '../types';

export const pl: Messages = {
  // app
  'app.start': [
    'Cześć! Pomogę ułożyć trasę po warszawskich pubach i wypić coś nowego.',
    '',
    '1) /link <untappd-username> — żeby podciągnąć twoje check-iny.',
    '2) /import — wyślij CSV-eksport z Untappd dla pełnego backfillu historii.',
    '3) /newbeers [fragment nazwy pubu] — top niespróbowanych piw; z argumentem — tylko w dopasowanych pubach.',
    '4) /pubs — lista dostępnych pubów.',
    '5) /route N — trasa pokrywająca ≥ N niespróbowanych piw z minimalnym dystansem.',
    '6) /beers <pub> — debug: wszystkie krany pubu tak, jak rozpoznał je bot.',
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
  'newbeers.pub_not_found': 'Nie znaleziono pubu „{query}". /pubs pokaże dostępne.',

  // beers (debug)
  'beers.usage': 'Użycie: /beers <fragment nazwy pubu>. Argument wymagany.',
  'beers.header': '🍺 <b>{pub}</b>{address}\nKrany: {count}',
  'beers.pub_not_found': 'Pub „{query}" nie znaleziony. /pubs pokaże dostępne.',
  'beers.ambiguous': 'Pasuje kilka pubów — doprecyzuj zapytanie (np. dodaj ulicę):',
  'beers.ambiguous_item': '• {name} — {address}',
  'beers.empty': 'Pub „{pub}" nie ma teraz danych o kranach.',

  // pubs
  'pubs.header': 'Dostępne puby:',
  'pubs.empty': 'W bazie nie ma jeszcze pubów — najpierw musi się wykonać /refresh.',
  'pubs.hint': 'Podpowiedź: /newbeers <fragment nazwy> pokaże nowości tylko w dopasowanych pubach.',

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
  'filters.current':
    '🎛 Twoje filtry\nStyle: {styles}\nMoc: {abv}\nOcena: {rating}\n\nKliknij, aby włączyć/wyłączyć. ♻️ — zresetuj wszystko.',
  'filters.any': 'dowolna',
  'filters.rating_value': 'od {rating}',
  'filters.reset_done': 'Zresetowano',
  'filters.reset_button': '♻️ Zresetuj wszystko',

  // lang
  'lang.prompt': 'Wybierz język interfejsu:',
  'lang.changed': '✅ Zmieniono język na {name}.',
};
