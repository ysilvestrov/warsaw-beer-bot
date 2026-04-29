# EN translations review

**Status:** draft (draft → reviewed-by-user → reviewed-by-llm → final)

Source of truth during review: this markdown. After `Status: final`, runtime
authority shifts to `src/i18n/locales/en.ts`.

## app

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `app.start` | Привіт! Я допоможу зібрати маршрут… (6-line welcome) | Hi! I'll help you build a route through Warsaw pubs and try something new.<br><br>1) /link <untappd-username> — to pull your check-ins.<br>2) /import — upload your Untappd CSV/JSON/ZIP export to backfill history.<br>3) /newbeers — top untried beers on current taps.<br>4) /route N — a route covering ≥ N untried beers with the shortest walking distance. | "untried" = непитий |
| `app.no_data_in_snapshot` | Немає цікавих непитих пив у поточному snapshot. | No interesting untried beers in the current snapshot. | |

## link

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `link.usage` | Використання: /link <username> (або повний URL untappd.com/user/<username>) | Usage: /link <username> (or full URL untappd.com/user/<username>) | |
| `link.success` | ✅ Прив'язано до untappd.com/user/{username} | ✅ Linked to untappd.com/user/{username} | |

## import

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `import.prompt` | Надішли експорт з Untappd: CSV, JSON або ZIP (до 20 MB)… | Send your Untappd export: CSV, JSON or ZIP (up to 20 MB). Supporter → Account → Download History. A big JSON is best zipped. | |
| `import.unsupported_format` | Формат не підтримується. Очікую .csv, .json або .zip. | Unsupported format. Expected .csv, .json or .zip. | |
| `import.too_large` | Файл > 20 MB — Telegram не дасть боту його скачати. Запакуй JSON у ZIP… | File > 20 MB — Telegram will not let the bot download it. Zip the JSON (compresses ≈10×) and try again. | |
| `import.fetch_failed` | Не вдалось отримати файл з Telegram. | Could not fetch the file from Telegram. | |
| `import.starting` | ⏳ Починаю імпорт… | ⏳ Starting import… | |
| `import.progress` | ⏳ Імпортовано {total}… | ⏳ Imported {total}… | |
| `import.done` | ✅ Імпортовано {total} чекінів ({format}). | ✅ Imported {total} check-ins ({format}). | |
| `import.failed` | ❌ Помилка після {total} рядків: {message} | ❌ Failed after {total} rows: {message} | |

## newbeers

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `newbeers.empty` | Нічого цікавого — спробуй /refresh. | Nothing interesting — try /refresh. | |
| `newbeers.more_pubs_suffix` | ` +{extra} інших` | ` +{extra} more` | |

## route

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `route.preparing` | ⏳ Будую маршрут для ≥{count} нових пив… | ⏳ Building a route for ≥{count} new beers… | |
| `route.matrix_progress` | 🗺 Матриця відстаней: {cached}/{total} з кешу, {missing} нових | 🗺 Distance matrix: {cached}/{total} cached, {missing} new | |
| `route.fill_missing` | 🗺 Догружаю пари без кешу: {done}/{total} | 🗺 Fetching uncached pairs: {done}/{total} | |
| `route.searching_tour` | 🧠 Шукаю найкоротший обхід… | 🧠 Searching for the shortest tour… | |
| `route.failed` | ❌ Не вдалось побудувати маршрут — подивись логи. | ❌ Could not build a route — check the logs. | |
| `route.header` | Знайдено маршрут для <b>{count}</b> (чи більше) нових пив, відстань ≈ <b>{km}</b>, пабів у маршруті: <b>{pubs}</b>. | Found a route for <b>{count}</b> (or more) new beers, distance ≈ <b>{km}</b>, pubs on the route: <b>{pubs}</b>. | `{km}` уже відформатований через fmtKm — translator не додає "km". "pubs" мн. — для `{pubs}=1` буде "pubs on the route: 1" що мляво, але "(or more)" пом'якшує. |

## refresh

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `refresh.cooldown` | ⏱ Занадто часто — спробуй за кілька хвилин. | ⏱ Too often — try again in a few minutes. | |
| `refresh.starting` | ⏳ Оновлюю… | ⏳ Refreshing… | |
| `refresh.done` | ✅ Готово. | ✅ Done. | |
| `refresh.failed` | ❌ Не вдалось — подивись логи. | ❌ Failed — check the logs. | |

## filters

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `filters.current` | Поточні: styles={styles}, min_rating={min_rating} | Current: styles={styles}, min_rating={min_rating} | технічні key=value не локалізуються |
| `filters.styles_changed` | styles={styles} | styles={styles} | callback-answer, технічна форма |
| `filters.rating_changed` | min_rating={rating} | min_rating={rating} | технічна форма |
| `filters.reset_done` | Скинуто | Reset | минулий час від reset |
| `filters.reset_button` | Скинути | Reset | імператив; в EN такий самий рядок як `filters.reset_done` (різниця в UA/PL) |

## lang

| Key | Source (uk) | Draft (en) | Notes |
|-----|-------------|------------|-------|
| `lang.prompt` | Оберіть мову інтерфейсу: | Choose interface language: | |
| `lang.changed` | ✅ Мову змінено на {name}. | ✅ Language switched to {name}. | `{name}` = native name (`English`/`Polski`/`Українська`) |

## Декоратори / форматери

- ABV separator: `.` (запис `6.1%`)
- Distance unit: `km`
- Distance separator: `.` (запис `14.4 km`)
- Plural forms: EN використовує `one/other` через `Intl.PluralRules('en')`. Plural-форм у словнику нема — `route.header` приймає неточність для `{pubs}=1`.

## Невирішені питання для перевірки

1. "untried" vs "unticked"/"new-to-me" для непитих пив — обрав "untried" як більш природне в beer-context.
2. "tour" в `route.searching_tour` — TSP-термінологія. Альтернатива: "shortest path"/"shortest order". "Tour" коректне для open-TSP.
3. "uncached pairs" в `route.fill_missing` — суто технічний рядок, користувач не розбирається в pair-cache. Варіант: "Fetching new distances".
4. `filters.reset_done` = `filters.reset_button` = "Reset" в EN — це нормально (на відміну від UA/PL), але варто переконатися, що користувач не бачить "Reset" як callback answer і думає, що нічого не сталось. Можна змінити на "Cleared" чи "Filters reset" для callback answer.
