# PR-D2 perf hotfix — inline lookup for fresh orphans only

**Date:** 2026-05-26
**Branch:** `feat/untappd-enrich-perf-hotfix`
**Relation:** Hotfix to PR-D2 (`feat/untappd-enrich-orphans`, merged as #47, commit on `main`). Master spec: `2026-05-26-untappd-lookup.md`.

## Background

Регресія, виявлена при першому деплої PR-D2:

> «Рефреш по відчуттях став на порядок повільнішим. За 10+ хвилин — тільки 28-й паб.»

Pre-PR-D2 sweep тривав ~5 хв на ~70 пабах. Після PR-D2 — 10+ хв на 28 пабах (~3x повільніше, можливо більше).

**Дві кореневі причини в `src/jobs/refresh-ontap.ts` (введені PR-D2):**

1. **Безумовний 500ms sleep після кожного тапа.** Цикл по тапах робить:
   ```ts
   if (lookupEnabled) {
     await enrichOneOrphan(...);
     if (lookupSleepMs > 0) {
       await new Promise(r => setTimeout(r, lookupSleepMs));   // ← завжди
     }
   }
   ```
   `enrichOneOrphan` повертає `'skipped'` для non-orphan-ів (більшість тапів — ~95%), без жодного HTTP. Sleep все одно спрацьовує. ~350 тапів × 500ms = ~3 хв пустого sleep-у.

2. **Inline обробляє ВЕСЬ backlog orphan-ів, не лише щойно створених.** `enrichOneOrphan` дивиться на стан рядка в БД (`untappd_id IS NULL`) — це true і для свіжо-створених, і для 287 існуючих on-tap orphan-ів. Кожен реальний lookup ≈ 2s HTTP + 500ms sleep = ~2.5s × 287 = +12 хв.

PR-D2 plan сам флагав sleep-стратегію як «harmless оптимізацію, бо більшість тапів non-orphan». Це було вірно у steady-state, але **катастрофічно невірно на першому деплої з backlog-ом 287**. Тобто помилка в плані, не в коді — реалізація точно слідувала спеці.

## Goals

- Inline-шлях у `refreshOntap` **обробляє ТІЛЬКИ fresh orphan-и** — пива, які `matchBeer` не знайшов у каталозі і `upsertBeer` створив у цьому ж sweep-і. Це 0-5 пив за типовий sweep — нові тапи.
- Sleep робиться **лише коли HTTP реально був** (`outcome !== 'skipped'`), щоб захиститись від подібних регресій якщо хтось у майбутньому розширить guard-логіку.
- Cron `enrich-orphans` лишається відповідальним за весь backlog (20×2/добу, ~7 днів до 0).
- Sweep-час повертається до pre-PR-D2 baseline (~5 хв) +2-3s оверхеду на fresh orphan-и.

## Non-goals

- **Per-sweep limit для inline.** YAGNI — fresh orphan-ів типово 0-5; ліміт не дасть нічого корисного. Якщо колись з'явиться 50-tap-нова-пивна — додамо.
- **Зменшення sleep до 100ms.** 500ms — політна пауза для Untappd. Для 0-5 calls це +2.5s максимум.
- **Інтеграційний тест для `refreshOntap`.** Він і так wire-up; повний integration-mock коштує більше за hotfix. Verification по логам після деплою.
- **Окрема таблиця для «коли beer було вперше створено»** — ми вже знаємо це in-process через `matchBeer === null` гілку.
- **Відкат PR-D2.** Cron-шлях працює правильно; інлайн — це сировинна regression, не загальний failure.

## Architecture

### Зміна в `src/jobs/refresh-ontap.ts`

Локалізована — тільки у внутрішньому циклі по тапах:

```ts
const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
let beerId: number;
let isFreshOrphan = false;
if (m) {
  upsertMatch(db, t.beer_ref, m.id, m.confidence);
  beerId = m.id;
} else {
  beerId = upsertBeer(db, {...});
  upsertMatch(db, t.beer_ref, beerId, 1.0);
  isFreshOrphan = true;        // ← тільки новостворені
}

// Inline lookup only for beers we just upserted as orphans. Existing
// orphans (untappd_id IS NULL but row already existed) are handled by
// the enrich-orphans cron — letting inline try them again every 12h
// multiplies HTTP+sleep across the full backlog. PR-D2.1 fix.
if (lookupEnabled && isFreshOrphan) {
  const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
  if (lookupSleepMs > 0 && outcome !== 'skipped') {
    await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
  }
}
```

Дві зміни:

1. **`isFreshOrphan` guard** — `enrichOneOrphan` викликається тільки якщо `matchBeer` повернув null (новий рядок). Існуючі orphan-и пропускаються inline; cron їх підбере.

2. **Conditional sleep** — `outcome !== 'skipped'` страхує від ситуації, коли `enrichOneOrphan` сам скіпне (наприклад: backoff не пройшов, або рядок вже не orphan через race condition). Без HTTP — без sleep.

### Master spec оновлення

`docs/superpowers/specs/2026-05-26-untappd-lookup.md`, секція «PR-D2 — wire-up `/search` lookup», параграф «### Inline в `refreshOntap`». Поточне формулювання:

> Після кожного `upsertBeer`/`findBeerByNormalized`, маємо `beer_id`. Якщо `untappd_id IS NULL` І `isEligible(now, lookup_at, count)`: …

Замінити на:

> Після `matchBeer`, якщо `matchBeer === null` І відбувся `upsertBeer` (тобто щойно створений orphan), викликаємо `enrichOneOrphan(beerId)`. Існуючі orphan-и (matchBeer повернув existing рядок без `untappd_id`) інлайн НЕ обробляє — вони підбираються cron-ом, щоб не множити HTTP×sleep на весь backlog у кожному sweep-і. Sleep 500ms тільки якщо outcome ≠ 'skipped'.

І додати буллет у «Risks / Footguns»:

> - **Inline must not process backlog.** PR-D2.1 hotfix (2026-05-26): початковий PR-D2 inline-шлях не розрізняв fresh orphan-ів від backlog-у, через що перший post-deploy sweep уповільнився на порядок (10+ хв на 28 пабах). Inline тепер дивиться на `matchBeer === null` як signal «свіжий», cron обробляє backlog. План-помилка («harmless sleep») коштувала 1 production-фікс.

### Тести

- **Жодних нових integration-тестів для `refreshOntap`** — wire-up, верифікація по логам.
- **`untappd-enrich.test.ts` лишається без змін** — helper працює правильно.
- **`enrich-orphans.test.ts` без змін** — cron logic некоректних змін не зазнав.
- Перевіримо: `npm test` зелено (повний suite), `npm run typecheck`, `npm run build`. Це capability+wire-up PR — на тестовому рівні зміна стосується одного рядка в одному handler-і.

## Post-deploy verification

1. Перевірити, що sweep-час повернувся до ~5 хв:
   ```bash
   sudo journalctl -u warsaw-beer-bot --since "1 hour ago" | grep "ontap.*пабів"
   ```
2. Перевірити, що cron 06:00/18:00 продовжує processing:
   ```bash
   sudo journalctl -u warsaw-beer-bot --since today | grep "enrich-orphans done"
   ```
3. Перевірити, що orphan-count повзе вниз тиждень за тижнем:
   ```bash
   sqlite3 /var/lib/warsaw-beer-bot/bot.db <<'SQL'
   SELECT COUNT(*) FROM beers b
   WHERE b.untappd_id IS NULL
     AND EXISTS (
       SELECT 1 FROM match_links ml
       JOIN taps t ON t.beer_ref = ml.ontap_ref
       JOIN tap_snapshots ts ON ts.id = t.snapshot_id
       JOIN (SELECT pub_id, MAX(snapshot_at) m FROM tap_snapshots GROUP BY pub_id) latest
         ON latest.pub_id = ts.pub_id AND latest.m = ts.snapshot_at
       WHERE ml.untappd_beer_id = b.id);
   SQL
   ```

Стартова точка після поточного sweep (який добиває весь backlog інлайнм): значно нижче 287, бо більшість пройшла lookup. Hotfix НЕ уповільнює backfill — backlog уже оброблений; hotfix лише запобігає повторам.

## Risks / Footguns

- **Гонитва hotfix-у з поточним sweep-ом.** Якщо deploy відбудеться поки попередній sweep ще не закінчив, можлива interleaving (старий код в пам'яті vs новий код на диску). `systemctl restart` чисто це вирішує — старий node-process гасне, новий стартує.
- **Свіжо створений orphan, що насправді не свіжий.** Edge case: `matchBeer` повернув null через незначну дрейф-нормалізацію, а beer вже існує в `beers` під іншою формою. `upsertBeer` тоді UPDATE-ить існуючий рядок (бо normalized-key збігається після нормалізації) і повертає той самий id. Ми позначаємо `isFreshOrphan=true` і робимо lookup — це нормально, бо `enrichOneOrphan` все одно перевірить `untappd_id IS NULL` всередині.
- **Ще одне «harmless» припущення.** План PR-D2 сам флагав це як known trade-off. Цей hotfix-spec явно фіксує, що такі припущення в hot loop-ах потребують реальної verification з прод-даними перед merge. Урок до пам'яті.
