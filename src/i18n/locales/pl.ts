import type { Messages } from '../types';

export const pl: Messages = {
  // app
  'app.no_data_in_snapshot': 'Aktualnie brak ciekawych niespróbowanych piw.',

  // common
  'common.interrupted_by_restart': '⚠️ Przerwano przez restart — uruchom polecenie ponownie.',

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
  'cmd.city': 'wybierz miasto',
  'city.prompt': 'Aktualne miasto: {name}. Wybierz miasto:',
  'city.changed': '✅ Zmieniono miasto na {name}.',
  'city.outside': '🌍 Poza Polską',
  'city.blocked': 'Ta komenda działa tylko dla miast w Polsce. Wybierz miasto: /city',
  'help.city_hint':
    'Kilka dodatkowych komend (puby, trasa, top piw) pojawi się po wyborze miasta — /city',
  'cmd.help': 'ta pomoc',
  'cmd.start': 'start',
  'cmd.extension': 'token dla rozszerzenia przeglądarki',
  'cmd.announce': 'ogłoszenia o nowych wersjach rozszerzenia',
  'cmd.status': 'twój status i ustawienia',

  // link
  'link.usage': 'Użycie: /link <username> (lub pełny URL untappd.com/user/<username>)',
  'link.success': "✅ Powiązano z untappd.com/user/{username}. Pokazuję historię tego konta. Aby ją zaktualizować, użyj “Sync my check-ins” w rozszerzeniu lub /import.",
  'link.switched': "✅ Powiązano z untappd.com/user/{username}. Pokazuję historię tego konta; historia poprzedniego jest zapisana osobno. Aby ją zaktualizować, użyj “Sync my check-ins” w rozszerzeniu lub /import.",

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
  'import.account_changed': '⏹ Import dla {username} zatrzymano, bo konto się zmieniło. Zapisano {total} wierszy; rozpocznij nowy import dla bieżącego konta.',
  'import.unlinked': 'historii sprzed połączenia',
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
  'route.open_in_maps': '🗺 Trasa w Google Maps',
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

  // status
  'status.title': '📊 Twój status',
  'status.settings_header': '⚙️ Ustawienia',
  'status.city': 'Miasto: {name}',
  'status.language': 'Język: {name}',
  'status.language_auto': 'auto',
  'status.filters': 'Filtry: {summary}',
  'status.filters_none': 'brak',
  'status.filter_styles': 'style: {list}',
  'status.filter_rating': 'min ★{rating}',
  'status.filter_abv': 'ABV {min}–{max}%',
  'status.filter_route': 'trasa {n}',
  'status.filters_edit': 'Zmień: /filters',
  'status.untappd_header': '🍺 Untappd',
  'status.not_linked': 'Brak powiązania. Użyj /link, lub /import dla historii.',
  'status.username': 'Konto: {username}',
  'status.checkins': 'Zsynchronizowane meldunki: {synced}',
  'status.checkins_of': 'Zsynchronizowane meldunki: {synced} / {total}',
  'status.profile_total_hint': 'Łączna liczba na Untappd to ostatnia znana wartość.',
  'status.last_sync': 'Ostatnia aktywność synchronizacji: {date} UTC',
  'status.no_sync': 'Synchronizacja przez rozszerzenie nie została jeszcze uruchomiona.',
  'status.had_without_checkins': 'Piwa znane serwerowi bez zaimportowanych check-inów: {count}. Uruchom „Sync my check-ins” w rozszerzeniu.',
  'status.distinct_beers': 'Unikalne wypite piwa: {count}',
  'status.last_checkin': 'Ostatni meldunek: {date}',
  'status.no_checkins': 'Brak meldunków — spróbuj /import lub rozszerzenia.',

  // extension
  'extension.success':
    'Twój token dostępu do rozszerzenia przeglądarki. Dodaj go w ustawieniach ' +
    'rozszerzenia (pole „API Token"). Poprzedni token, jeśli istniał, przestał działać.\n' +
    'Adres API: {url}',
  'extension.store':
    'Zainstaluj rozszerzenie: {url}\n' +
    'Jeśli zobaczysz „Item not available", zaloguj się na konto Google i odśwież stronę ' +
    '(rozszerzenie jest oznaczone 18+ ze względu na tematykę piwną).',
  'extension.mcp':
    'Ten sam token działa też przez MCP — z Claude Code lub Codex możesz zapytać, ' +
    'które piwa z listy masz już wypite (i z jaką oceną — tam, gdzie dopasowanie jest pewne): {url}',

  // announce (#379)
  'announce.released':
    '🍺 Rozszerzenie zaktualizowano do wersji {version} — Chrome pobierze je sam w najbliższym czasie.',
  'announce.changelog': 'Co nowego: {url}',
  'announce.opt_out_hint': 'Nie chcesz takich wiadomości — wyślij /announce off.',
  'announce.status_on': 'Ogłoszenia o nowych wersjach: włączone. Wyłącz — /announce off',
  'announce.status_off': 'Ogłoszenia o nowych wersjach: wyłączone. Włącz — /announce on',
  'announce.turned_on': 'Gotowe — będę informować o nowych wersjach rozszerzenia.',
  'announce.turned_off': 'Gotowe — nie będę więcej przeszkadzać. Przywróć — /announce on',
  'announce.no_token':
    'Ogłoszenia trafiają jednak tylko do posiadaczy tokenu rozszerzenia — po token: /extension.',

  // bug reports
  'cmd.report': 'zgłoś błąd bota lub rozszerzenia',
  'report.ask_source': 'Gdzie jest błąd?',
  'report.source.bot': 'Bot',
  'report.source.extension': 'Rozszerzenie',
  'report.ask_category': 'Co dokładnie jest nie tak?',
  'report.cat.wrong_beer': 'Nie to piwo / cudza ocena',
  'report.cat.no_rating': 'Piwo bez oceny',
  'report.cat.had_status': 'Nieprawidłowy status „piłem / nie piłem”',
  'report.cat.stale_data': 'Nieaktualne lub błędne dane pubu / kranów / sklepu',
  'report.cat.route': 'Trasa lub mapa',
  'report.cat.no_badge': 'Brak oznaczenia na stronie sklepu',
  'report.cat.ext_broken': 'Rozszerzenie nie działa: logowanie, instalacja, aktualizacja, menu',
  'report.cat.bot_broken': 'Bot nie odpowiada, zawiesza się lub pokazuje błąd',
  'report.cat.text_ui': 'Tekst, tłumaczenie, wygląd',
  'report.cat.other': 'Inne',
  'report.ask_text': 'Opisz, co się stało i co powinno się stać — co najmniej 10 znaków.',
  'report.too_short': 'Za krótko — napisz co najmniej 10 znaków.',
  'report.ask_media': 'Możesz dodać do 3 zrzutów ekranu lub filmów (do 20 MB) albo nacisnąć „Bez mediów”.',
  'report.media_added': 'Dodano ({n}/{max}).',
  'report.media_full': 'Masz już 3 pliki — więcej nie można dodać. Naciśnij „Gotowe”.',
  'report.media_too_big': 'Plik ma ponad 20 MB — bot nie może go pobrać.',
  'report.btn.done': 'Gotowe',
  'report.btn.no_media': 'Bez mediów',
  'report.btn.send': 'Wyślij',
  'report.btn.cancel': 'Anuluj',
  'report.confirm': 'Sprawdź zgłoszenie:\n{source} · {category}\n\n{text}\n\nMedia: {media}\n\nStreszczenie opisu zostanie opublikowane publicznie na GitHub. Zrzuty ekranu i filmy nie będą publiczne — zobaczą je tylko programiści na serwerze. Nie wpisuj danych osobowych w opisie.',
  'report.accepted': 'Przyjęto, analizuję…',
  'report.retry': 'Nie udało się przyjąć zgłoszenia — naciśnij „Wyślij” jeszcze raz.',
  'report.cancelled': 'Zgłoszenie anulowane.',
  'report.expired': 'Ten szkic wygasł — zacznij ponownie: /report',
  'report.limit': 'Dziś wysłano już 3 zgłoszenia — to dzienny limit. Spróbuj jutro.',
  'report.banned': 'Zgłoszenia są dla ciebie niedostępne.',
  'report.unavailable': 'Zgłoszenia są tymczasowo niedostępne.',
  'report.private_only': 'Zgłoszenia są przyjmowane tylko w prywatnym czacie z botem.',
  'report.done.created': 'Dziękuję! Utworzono issue: {url}',
  'report.done.duplicate_open': 'Dziękuję! To znany, otwarty problem — dodano twoje informacje: {url}',
  'report.done.duplicate_closed_fixed': 'Naprawiono to {date}. Jeśli nadal widzisz problem po aktualizacji, zgłoś go ponownie: {url}',
  'report.done.duplicate_closed': 'To już zgłoszono (zamknięto {date}): {url}',
  'report.done.not_a_bug': 'To nie wygląda na błąd bota ani rozszerzenia.',
  'report.done.deferred': 'Przyjęto — odpowiem później.',
  'report.done.needs_review': 'Przyjęto — programista sprawdzi to ręcznie.',
  'report.done.failed': 'Nie udało się przetworzyć zgłoszenia — programista to sprawdzi.',
  'reportban.usage': 'Użycie: /reportban <telegram_id> [off]',
  'reportban.banned': 'Zgłoszenia dla {id} wyłączone.',
  'reportban.unbanned': 'Zgłoszenia dla {id} włączone.',

  // WFP festival mode
  'fest.no_fest': 'Teraz nie ma festiwalu, do którego można dołączyć.',
  'fest.team_created': 'Utworzono drużynę festiwalu „{fest}” dla tego czatu. Naciśnij przycisk, aby dołączyć.',
  'fest.join_button': '🙋 Jestem w drużynie',
  'fest.joined': '✅ {name} w drużynie.',
  'fest.already_member': 'Już jesteś w drużynie.',
  'fest.need_link': 'Najpierw połącz Untappd w prywatnym czacie z botem: /link <username>',
  'fest.no_team': 'Nie należysz do żadnej drużyny festiwalu. Napisz /fest w czacie grupowym drużyny.',
  'fest.pick_team': 'Wybierz drużynę:',
  'fest.not_member': 'To dla członków drużyny — naciśnij „Jestem w drużynie”.',
  'fest.menu_empty': 'Menu festiwalu nie zostało jeszcze pobrane.',
  'fest.menu_line': 'Pozycji w menu: {count}, zaktualizowane o {time}.',
  'fest.no_targets': 'W menu nie ma celów dla tej drużyny.',
  'fest.legend': '🍺 — cele nalewane teraz · ❔ — nie widzimy',
  'fest.stand': '{floor} piętro, {stand}',
  'fest.stand_floor_only': '{floor} piętro',
  'fest.status_on_tap': '🟢 check-in {mins} min temu ({count})',
  'fest.status_not_seen': '⚪ nie widziano w ciągu godziny',
  'fest.status_unknown': '❔ nie wiadomo — nie widzieliśmy całej godziny',
  'fest.section_gone': 'Tej sekcji nie ma już w rankingu — wyślij /fest ponownie.',
  'fest.history_header': '<b>Kompletność historii</b> (check-inów w bocie / w profilu Untappd):',
  'fest.history_line': '{initials}: {inBot} / {total}',
  'fest.history_unknown': '? (brak synchronizacji rozszerzeniem)',
  'fest.targets_header': '<b>Cele: {count}</b>',
  'fest.targets_more': '…i jeszcze {count}',
  'fest.unrated_header': '<b>Niepite bez oceny: {count}</b> (nie cel, ale nie odrzucone)',
  'fest.reason_rating': '⭐ {rating}',
  'fest.reason_style': '🧪 styl',
  'fest.reason_manual': '✋ ręcznie',
  'fest.remove_button': '➖ {name}',
  'fest.add_usage': 'Napisz część nazwy piwa lub browaru: /fest add motueka',
  'fest.add_none': 'W menu nic nie znaleziono dla „{query}”.',
  'fest.add_pick': 'Co dodać do celów?',
  'fest.added': '➕ {name} — teraz cel.',
  'fest.removed': '➖ {name} usunięto z celów.',
  'fest.stands_usage': 'Wyślij plik CSV z podpisem /fest stands. Wiersz: sekcja;piętro;stoisko (pierwszy wiersz może być nagłówkiem).',
  'fest.stands_saved': 'Zapisano stoisk: {count}.',
  'fest.stands_errors': 'Nie odczytano wierszy: {lines}.',
  'fest.stands_unknown': 'Tych sekcji nie ma w menu (zapisane, ale na razie niepotrzebne): {sections}.',
  'fest.stands_missing': 'Sekcje menu bez stoiska: {sections}.',
  'fest.stands_complete': 'Wszystkie sekcje menu mają stoisko.',
  'fest.menu_refreshed': 'Menu odczytane ponownie: pozycji na stronie: {count}.',
  'fest.menu_stale': 'Strona menu jest starsza niż zapisane — nic nie zmieniono.',
  'fest.menu_blocked': 'Untappd teraz nie oddaje strony serwerowi — spróbuj później lub z laptopa.',
  'fest.menu_wrong_page': 'Strona nie wygląda na menu festiwalu — nic nie zmieniono.',
  'fest.menu_unavailable': 'Odczyt Untappd z serwera jest wyłączony (brak ciasteczka) — menu aktualizuje tylko laptop.',
  'fest.lines_more': '…nie zmieściło się wierszy: {count}',
};
