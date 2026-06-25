# VPS-wide Untappd circuit — design

> **Стандарт:** OpenSpec (spec-driven). **Статус:** `DESIGN`.
> **Дата:** 2026-06-25. **Мотивація:** після Untappd block на одному VPS-шляху бот
> має тимчасово зупиняти всі server-originated Untappd-запити, а не лише окремий cron.
> **Звіряти з:** `spec.md` §4, §5.10; `docs/superpowers/specs/2026-06-04-untappd-ban-protection-design.md`.

## 1. Problem

Поточний in-memory `untappdBreaker` гейтить тільки `enrichOrphans` і
`refreshTapRatings`. Це залишає два VPS-originated Untappd-шляхи поза cooldown:

- `refreshOntap` inline enrich свіжих orphan-ів;
- `refreshAllUntappd` profile scrape через cookie-клієнт.

Інцидент 2026-06-25 показав практичну діру: profile scrape отримав `HTTP 403`, потім
inline enrich у `refreshOntap` отримав block, але наступний `enrich-orphans` cron все
одно спробував Untappd, бо breaker не знав про inline block.

## 2. Goals / Non-goals

**Goals.**
- Один shared cooldown для всіх Untappd-запитів, які йдуть з VPS.
- Перший `403` / `429` / captcha-block на будь-якому VPS-шляху відкриває circuit.
- Поки circuit open, жоден VPS-job не робить Untappd HTTP.
- Ontap scraping продовжується, але без inline enrich.
- `blocked` не мутує `untappd_lookup_at` / `untappd_lookup_count`.

**Non-goals.**
- Не гейтимо browser/extension relay. Блок користувацького браузера не є сигналом для
  серверного IP.
- Не робимо persistent DB-backed circuit у цій зміні. Поточний circuit лишається
  in-memory і скидається на restart.
- Не змінюємо matcher, backoff schedule, cron frequency або `/match`.

## 3. Design

### 3.1 Shared VPS circuit

`src/index.ts` лишається composition root для одного `untappdBreaker`. Цей breaker
передається в усі server-side Untappd callers:

- `refreshOntap`;
- `enrichOrphans`;
- `refreshTapRatings`;
- `refreshAllUntappd`.

Cooldown і alert semantics не змінюються: 6 год, half-open probe, alert лише на trip
і recovery.

### 3.2 `refreshOntap` inline enrich

`refreshOntap` отримує optional `breaker?: CircuitBreaker`.

Перед inline enrich свіжого orphan-а:

1. якщо `lookupEnabled === false`, inline enrich не запускається;
2. якщо `breaker.canAttempt(now()) === false`, inline enrich не запускається;
3. якщо `enrichOneOrphan(...)` повертає `blocked`, job викликає
   `breaker.onResult(true, now())`, зупиняє inline enrich на решту поточного ontap run,
   але продовжує ontap scraping / snapshots / matching;
4. для non-block результатів job викликає `breaker.onResult(false, now())`.

Це не має перетворювати тимчасовий Untappd block на failed ontap refresh: дані кранів
залишаються важливішими і не залежать від Untappd.

### 3.3 `enrichOrphans` and `refreshTapRatings`

Поточна breaker-поведінка зберігається:

- skip whole job while circuit open;
- first `blocked` trips breaker and stops the batch;
- success in half-open closes breaker.

Тести мають лишитись зеленими без зміни публічного контракту, крім можливих уточнень
очікувань навколо shared circuit.

### 3.4 `refreshAllUntappd`

`refreshAllUntappd` отримує optional `breaker?: CircuitBreaker`.

На старті job:

- якщо breaker open, job логує skip і не ходить в Untappd;
- якщо breaker closed або half-open, job починає scrape.

Під час per-user scrape:

- `HttpError` зі статусом `403` або `429` трипить breaker і зупиняє решту loop;
- HTML block page, якщо такий буде повернений як `200`, теж трипить breaker;
- `CookieExpiredError` лишається окремим cookie/session станом: alert admin і break, але
  це не обов'язково IP-ban signal і не має сам по собі трипити VPS circuit;
- інші transient помилки лишаються per-user warning, як сьогодні.

Після успішної half-open спроби breaker закривається через `onResult(false, now())`.
Успіхом для profile scrape вважається нормально отримана й розпарсена сторінка користувача.

### 3.5 Extension relay boundary

`/enrich/candidates`, `/enrich/result`, browser-side Untappd search, and extension check-in
sync не отримують цей breaker. Якщо користувацький браузер бачить captcha/block, це
не повинно зупиняти VPS jobs і не повинно відкривати server circuit.

## 4. Error handling

- Block detection is a controlled outcome, not an uncaught job error.
- `blocked` rows in `enrich_failures` remain diagnostic and do not affect lookup backoff.
- Ontap refresh continues after inline enrich is disabled by a block.
- Telegram alert failures stay swallowed inside breaker callbacks.

## 5. Testing

- `refresh-ontap.test.ts`: inline enrich block trips breaker and prevents later inline
  Untappd calls in the same run while still writing ontap data.
- `refresh-ontap.test.ts`: open breaker skips inline enrich without failing ontap refresh.
- `refresh-untappd.test.ts`: open breaker skips the whole profile scrape job.
- `refresh-untappd.test.ts`: profile scrape `403` / `429` trips breaker and stops remaining
  users.
- `refresh-untappd.test.ts`: cookie-expired handling remains separate and does not trip
  the VPS circuit by itself.
- Existing `enrich-orphans` / `refresh-tap-ratings` breaker tests stay green.

## 6. Rollout / Verification

After deploy, verify from logs:

```bash
journalctl -u warsaw-beer-bot --since today --no-pager |
  rg "untappd circuit|skipped \\(untappd circuit open\\)|blocked|HTTP 403|HTTP 429"
```

Expected behavior: after the first VPS block, subsequent `refreshOntap` inline enrich,
`enrich-orphans`, `refresh-tap-ratings`, and `refreshAllUntappd` produce skip/no-Untappd
behavior until the cooldown allows a half-open probe.
