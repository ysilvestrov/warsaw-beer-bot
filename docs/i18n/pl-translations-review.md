# PL translations review

**Status:** final (draft → reviewed-by-user → reviewed-by-llm → final)

Source of truth during review: this markdown. After `Status: final`, runtime
authority shifts to `src/i18n/locales/pl.ts` (this markdown becomes a
historical record of the review cycle).

## app

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `app.start` | Привіт! Я допоможу зібрати маршрут… (6-line welcome) | Cześć! Pomogę zaplanować trasę po warszawskich pubach i spróbować czegoś nowego.<br><br>1) /link <untappd-username> — żeby pobrać twoje check-iny.<br>2) /import — wyślij eksport Untappd (CSV/JSON/ZIP), by uzupełnić historię.<br>3) /newbeers — top niespróbowanych piw z aktualnych kranów.<br>4) /route N — trasa pokrywająca ≥ N niespróbowanych piw z najkrótszą trasą pieszą. | "trasa" (нативніше за "marszruta"); "niespróbowane" = untried |
| `app.no_data_in_snapshot` | Наразі немає цікавих непитих пив. | Aktualnie brak ciekawych niespróbowanych piw. | прибрано технічне "snapshot" з тексту — користувачу нецікаво про DB-структуру; ключ лишається як є, бо це програмний ідентифікатор |

## link

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `link.usage` | Використання: /link <username> (або повний URL untappd.com/user/<username>) | Użycie: /link <username> (lub pełny URL untappd.com/user/<username>) | |
| `link.success` | ✅ Прив'язано до untappd.com/user/{username} | ✅ Powiązano z untappd.com/user/{username} | |

## import

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `import.prompt` | Надішли експорт з Untappd: CSV, JSON або ZIP (до 20 MB). Supporter → Account → Download History. Великий JSON краще запакувати в ZIP. | Wyślij eksport z Untappd: CSV, JSON lub ZIP (do 20 MB). Supporter → Account → Download History. Duży JSON lepiej spakować w ZIP. | |
| `import.unsupported_format` | Формат не підтримується. Очікую .csv, .json або .zip. | Nieobsługiwany format. Oczekuję .csv, .json lub .zip. | |
| `import.too_large` | Файл > 20 MB — Telegram не дасть боту його скачати. Запакуй JSON у ZIP (стискається ≈10×) і надішли ще раз. | Plik > 20 MB — Telegram nie pozwoli botowi go pobrać. Spakuj JSON do ZIP (kompresuje się ≈10×) i wyślij ponownie. | |
| `import.fetch_failed` | Не вдалось отримати файл з Telegram. | Nie udało się pobrać pliku z Telegrama. | "Telegrama" — польський родовий від Telegram |
| `import.starting` | ⏳ Починаю імпорт… | ⏳ Rozpoczynam import… | |
| `import.progress` | ⏳ Імпортовано {total}… | ⏳ Zaimportowano {total}… | |
| `import.done` | ✅ Імпортовано {total} чекінів ({format}). | ✅ Zaimportowano {total} check-inów ({format}). | "check-in" як англомовний термін Untappd |
| `import.failed` | ❌ Помилка після {total} рядків: {message} | ❌ Błąd po {total} wpisach: {message} | "wpis" (запис) природніше за "wiersz" для JSON/CSV-експорту |

## newbeers

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `newbeers.empty` | Нічого цікавого — спробуй /refresh. | Nic ciekawego — spróbuj /refresh. | |
| `newbeers.more_pubs_suffix` | ` +{extra} інших` | ` +{extra} innych` | suffix після списку пабів — родовий мн. |

## route

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `route.preparing` | ⏳ Будую маршрут для ≥{count} нових пив… | ⏳ Buduję trasę dla ≥{count} nowych piw… | |
| `route.matrix_progress` | 🗺 Матриця відстаней: {cached}/{total} зі збережених, {missing} нових | 🗺 Macierz dystansów: {cached}/{total} z zapisanych, {missing} nowych | прибрано технічне "cache" з тексту |
| `route.fill_missing` | 🗺 Догружаю незбережені пари: {done}/{total} | 🗺 Pobieram brakujące pary: {done}/{total} | "Doładowuję" асоціюється з поповненням рахунку телефону; "Pobieram" — стандарт для завантаження даних |
| `route.searching_tour` | 🧠 Шукаю найкоротший обхід… | 🧠 Szukam najkrótszej trasy… | |
| `route.failed` | ❌ Не вдалось побудувати маршрут — подивись логи. | ❌ Nie udało się zbudować trasy — sprawdź logi. | |
| `route.header` | Знайдено маршрут для <b>{count}</b> (чи більше) нових пив, відстань ≈ <b>{km}</b>, пабів у маршруті: <b>{pubs}</b>. | Znaleziono trasę dla <b>{count}</b> (lub więcej) nowych piw, dystans ≈ <b>{km}</b>, liczba pubów na trasie: <b>{pubs}</b>. | `{km}` приходить **уже відформатований** з fmtKm — НЕ додавати "km" самостійно. Конструкція "liczba pubów na trasie: {pubs}" уникає граматичного конфлікту для будь-якого числа (включно з 1). |

## refresh

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `refresh.cooldown` | ⏱ Занадто часто — спробуй за кілька хвилин. | ⏱ Za często — spróbuj za kilka minut. | |
| `refresh.starting` | ⏳ Оновлюю… | ⏳ Aktualizuję… | "Aktualizuję" замість "Odświeżam" — звучить більш по-польськи в IT-контексті |
| `refresh.done` | ✅ Готово. | ✅ Gotowe. | |
| `refresh.failed` | ❌ Не вдалось — подивись логи. | ❌ Nie udało się — sprawdź logi. | |

## filters

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `filters.current` | Поточні: styles={styles}, min_rating={min_rating} | Aktualne: styles={styles}, min_rating={min_rating} | технічні key=value лишаємо без перекладу |
| `filters.styles_changed` | styles={styles} | styles={styles} | технічна форма (callback answer) |
| `filters.rating_changed` | min_rating={rating} | min_rating={rating} | технічна форма |
| `filters.reset_done` | Скинуто | Zresetowano | callback answer "виконано скидання" |
| `filters.reset_button` | Скинути | Resetuj | імператив для кнопки |

## lang

| Key | Source (uk) | Draft (pl) | Notes |
|-----|-------------|------------|-------|
| `lang.prompt` | Оберіть мову інтерфейсу: | Wybierz język interfejsu: | |
| `lang.changed` | ✅ Мову змінено на {name}. | ✅ Zmieniono język na {name}. | `{name}` = native name (`Polski`/`Українська`/`English`) |

## Декоратори / форматери

- ABV separator: `,` (запис `6,1%`)
- Distance unit: `km` (без крапки/коми всередині)
- Distance separator: `,` (запис `14,4 km`)
- Plural forms: PL використовує `one/few/many/other` через `Intl.PluralRules('pl')`. Plural-форм у словнику нема — `route.header` переформульований через "liczba pubów na trasie: {pubs}", щоб уникнути конфлікту для count=1.

## Невирішені питання для перевірки

1. "check-in" / "check-inów" — підтвердити, що це загальноприйнята форма серед польських Untappd-юзерів.
2. "trasa" vs "marszruta" для `/route` — обрав "trasa" як більш повсякденне; підтвердити з носіями.
