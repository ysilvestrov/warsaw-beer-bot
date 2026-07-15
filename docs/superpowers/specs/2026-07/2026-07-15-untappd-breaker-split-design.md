# Розділення Untappd circuit breaker: Algolia-пошук vs проксі-профіль-скрейп

- **Issue**: #221
- **Дата**: 2026-07-15
- **Пов'язане**: #298 (residential-egress для HTML-скрейпу — фікс самого 403), #219 (Algolia-міграція), #200/#222 (WebShare rotate-on-block)

## Проблема

`untappdBreaker` — один **спільний** persistent circuit breaker на весь Untappd-трафік (`blockThreshold = UNTAPPD_BLOCK_THRESHOLD = 3` consecutive, `cooldownMs = 6 год`, ключ `untappd_circuit_open_until` у `job_state`). Після Algolia-міграції (#219) транспорти розійшлися:

- **enrich / refresh-ontap** ходять в **Algolia API** (`9WBO4RQ3HO-dsn.algolia.net`) напряму — надійний шлях, `200`.
- **refresh-tap-ratings / refresh-untappd** скрейплять **HTML** (`/b/*`, `/user/*`) через WebShare-проксі / cookie'd-сесію — Untappd 403'ить датацентрові IP (див. #298).

403-и HTML-шляху годують той самий breaker, що гейтить здоровий Algolia-enrich. Наслідок — у логах `enrich-orphans skipped (untappd circuit open)`, і робочий enrich періодично стоїть дарма (осциляція ~кожні 6 год: enrich-проба відновлює breaker → наступний HTML-скрейп ловить 3×403 → breaker знову open).

## Мета

Розділити на **два незалежні persistent-breaker'и**, щоб блок на HTML-скрейпі не зупиняв Algolia-enrich і навпаки.

## Дизайн

Зміна суто у **wiring'у** (`src/index.ts`). Модуль `src/domain/untappd-circuit.ts` (`createPersistentCircuitBreaker`) **не змінюється** — його реалізація вже все підтримує; просто інстанціюємо два екземпляри з різними ключами.

### Два breaker'и

| Breaker | `job_state` ключ | Споживачі | Транспорт |
|---|---|---|---|
| `algoliaBreaker` | `untappd_circuit_open_until` *(існуючий, без змін)* | `refreshOntap` (manual `/refresh` + 12h cron), `enrichOrphans` (3h cron) | Algolia API (`algoliaSearch`) |
| `profileHttpBreaker` | `untappd_profile_http_open_until` *(новий)* | `refreshAllUntappd` (manual `/refresh` + 03:00 cron), `refreshTapRatings` (3h cron) | HTML через WebShare (`untappdSearchHttp`) / cookie'd (`untappdHttp`) |

Обидва breaker'и: `cooldownMs = 6 * 60 * 60 * 1000`, `blockThreshold = env.UNTAPPD_BLOCK_THRESHOLD`, `db` — той самий. Дефолти без змін.

**Чому Algolia-breaker лишається на старому ключі:** `src/storage/stats.ts` читає `untappd_circuit_open_until` напряму (`untappdSearchHealthy = canaryOk && !circuitOpen`). Залишивши Algolia-breaker на цьому ключі, ми (1) не чіпаємо `stats.ts` взагалі, (2) зберігаємо коректну семантику `untappdSearchHealthy` (це саме search/Algolia-шлях), (3) не втрачаємо живе значення breaker'а при деплої. Новий breaker бере новий ключ.

### Алерти (окремі, з мітками — варіант b)

`onTrip` / `onRecover` кожного breaker'а шлють адмін-нотифікацію через `adminAlert`, з **різними мітками**, щоб з повідомлення було ясно, який шлях впав:

- **algoliaBreaker** (він і є «енрич») — існуючий текст:
  - trip: `⚠️ Untappd Algolia: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.`
  - recover: `✅ Untappd Algolia: доступ відновлено, енрич продовжено.`
- **profileHttpBreaker** (новий текст):
  - trip: `⚠️ Untappd профіль-скрейп: 403/блок — скрейп профілів/рейтингів призупинено на ~6 год.`
  - recover: `✅ Untappd профіль-скрейп: доступ відновлено.`

> Примітка: за #298 HTML-шлях наразі постійно 403'иться, тож `profileHttpBreaker` очікувано триптиме/фейлитиме пробу ~кожні 6 год і слатиме алерт. Це свідомий вибір (варіант b) — бачити стан кожного шляху окремо; шум прибереться, коли #298 полагодить egress.

### Міграція `job_state`

Не потрібна. `algoliaBreaker` успадковує наявний ключ `untappd_circuit_open_until` разом із його поточним значенням. `untappd_profile_http_open_until` створюється лениво на перший блок HTML-шляху. Старих осиротілих ключів не лишається.

## Тестування (Vitest)

- **Новий тест ізоляції breaker'ів**: на одній in-memory БД створити два `createPersistentCircuitBreaker` з ключами `untappd_circuit_open_until` та `untappd_profile_http_open_until` і `blockThreshold = 1`. Заблокувати `profileHttpBreaker` (`onResult(true, now)`) до trip; переконатися, що:
  - `algoliaBreaker.canAttempt(now) === true` (не зачеплений);
  - у `job_state` є `untappd_profile_http_open_until`, але немає `untappd_circuit_open_until`;
  - і симетрично навпаки.
- Наявні `src/domain/untappd-circuit.test.ts` **не змінюються** (реалізація breaker'а незмінна).

## Поза скоупом

- Фікс самого 403 на HTML-ендпоінтах (residential/mobile-egress, browser-fingerprint, оновлення `UNTAPPD_SESSION_COOKIE`) — окремий issue #298.
- Зміна threshold/cooldown, окрема конфігурація per-breaker — YAGNI; лишаємо спільні дефолти.

## Критерії готовності (з #221)

- [x] Окремі breaker'и з власними `*_open_until` ключами в `job_state`.
- [x] `daily-status` `untappdSearchHealthy` лишається коректним (відображає Algolia-шлях).
- [x] Тест на ізоляцію breaker'ів.
