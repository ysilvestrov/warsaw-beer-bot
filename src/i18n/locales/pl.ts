import type { Messages } from '../types';

export const pl: Messages = {
  // app
  'app.no_data_in_snapshot': 'Aktualnie brak ciekawych niespróbowanych piw.',

  // help / command catalog
  'help.intro': 'Komendy bota:',
  'cmd.newbeers': 'top niepitych piw',
  'cmd.route': 'trasa piesza',
  'cmd.pubs': 'lista pubów',
  'cmd.filters': 'filtry (styl/ocena/ABV)',
  'cmd.link': 'połącz Untappd',
  'cmd.import': 'import historii (CSV/JSON/ZIP)',
  'cmd.beers': 'diagnostyka kranów pubu',
  'cmd.refresh': 'odśwież dane',
  'cmd.lang': 'język interfejsu',
  'cmd.help': 'ta pomoc',
  'cmd.start': 'start',
  'cmd.extension': 'token dla rozszerzenia przeglądarki',

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
  'filters.family_other': 'Inne',
  'filters.rating_value': 'od {rating}',
  'filters.reset_done': 'Zresetowano',
  'filters.reset_button': '♻️ Zresetuj wszystko',

  // lang
  'lang.prompt': 'Wybierz język interfejsu:',
  'lang.changed': '✅ Zmieniono język na {name}.',

  // extension
  'extension.success':
    'Twój token dostępu do rozszerzenia przeglądarki. Dodaj go w ustawieniach ' +
    'rozszerzenia (pole „API Token"). Poprzedni token, jeśli istniał, przestał działać.\n' +
    'Adres API: {url}',
  'extension.download': 'Aktualna wersja rozszerzenia: v{version} (plik poniżej).',
  'extrel.no_match':
    'Ten plik nie odpowiada ostatniemu wydaniu w tabeli. Najpierw uruchom npm run release, potem wyślij ten zip.',
  'extrel.attached': 'Dołączono plik do v{version}. Otrzyma {n} testerów.',
  'extrel.btn_send': '📣 Roześlij',
  'extrel.btn_cancel': 'Anuluj',
  'extrel.sending': 'Wysyłam v{version}…',
  'extrel.broadcast_done': 'Gotowe. Wysłano {sent}, błędów {failed}.',
  'extrel.cancelled': 'Anulowano, nie wysłano.',
  'extrel.new_version': '🔔 Nowa wersja rozszerzenia v{version}',
  'extrel.how_to_update':
    'Jak zaktualizować: rozpakuj zip do tego samego folderu i kliknij ↻ na karcie rozszerzenia w chrome://extensions. Token i ustawienia zostaną zachowane.',
};
