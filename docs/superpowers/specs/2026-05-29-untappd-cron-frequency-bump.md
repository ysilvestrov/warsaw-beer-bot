# PR-D-throughput-bump — Untappd cron at 3h frequency

**Date:** 2026-05-29
**Branch:** `feat/untappd-cron-frequency-bump`
**Relation:** Operational follow-up to PR-D2/D3 (merged ##47, #49). Master spec: `2026-05-26-untappd-lookup.md`.

## Background

Виявлено сьогодні (2026-05-29) під час діагностики, чому пиво «Bleat» від Browar Monsters не з'являється в `/newbeers` Piw Paw:

1. Real-world Untappd-каталог для нього існує: `bid 6621450`, `global_rating 3.984` (зараз 4.014).
2. `lookupBeer` симульований проти живого Untappd-html матчиться правильно.
3. У БД ж пиво лежить як **orphan** (`beers.id=412`, `untappd_id=NULL`, `untappd_lookup_count=1`, `lookup_at=2026-05-26T18:11`) — тобто PR-D2 inline-burst спробував один раз, отримав spurious `not_found` (catpcha, ймовірно — це той самий burst-катастрофа, що породив PR-D2.1).
4. Cron `enrich-orphans` з тих пір не дістав до beer 412, бо `ORDER BY untappd_lookup_count ASC` ставить ~181 orphan-ів з `count=0` першими, а cron бере по 20/run × 2/добу = 40/добу.

**SQL one-shot fix** (виконаний сьогодні) скинув spurious `lookup_at LIKE '2026-05-26T%' AND untappd_id IS NULL` → `count=0`, `lookup_at=NULL`. Тепер 181 orphan чекають на cron-черзі.

**Проблема залишається:** 181 orphan × 40/добу = **4.5 дні до 0**. Реалії юзера: «Bleat не показується» зачекати 4+ дні незручно. Спочатку планував `LIMIT=20 → 100` (бамп LIMIT-у), але це підвищує **burst sig** з 10s до 50s — патерн, до якого Untappd-сервер невідомо як ставиться. Юзер вірно зауважив: краще зберегти burst, а підняти частоту.

## Goals

- Збільшити throughput cron-ів `enrich-orphans` та `refresh-tap-ratings` без зміни burst-патерну.
- Backfill 287→0 за ~1.8 днів (vs поточних 7).
- Untappd «бачить» ту ж саму burst-сигнатуру (20 calls × 500ms = 10s), просто частіше — нуль новизни для rate-limit-логіки серверу.
- Ніяких змін у backoff-формулі, в kill switch, у sleep-у, у parser-і, у storage-helper-ах. Тільки cron-розклад.

## Non-goals

- **Підняття LIMIT.** Свідомо лишаємо 20 — burst signature незмінна.
- **Env-configurable частота/limit.** YAGNI; редеплой за хвилину. Якщо колись треба «boost mode» — додамо тоді.
- **Зміна backoff-розкладу** (0/24/72/168/336/720 h). Не повязано — backoff per-beer, частота cron-у глобальна.
- **Нові метрики.** Існуючий `log.info({processed, matched, not_found, transient, skipped})` достатній.
- **Інші cron-и** (`refreshOntap` 12h, `refreshAllUntappd` 24h) — не торкаємось.

## Architecture

### Зміна у `src/index.ts` — два рядки cron-розкладу

Поточний стан (post-PR-D3):

```ts
cron.schedule('0 6,18 * * *', () => {
  enrichOrphans({ db, log, http, lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED })
    .catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
}),
cron.schedule('0 9,21 * * *', () => {
  refreshTapRatings({ db, log, http, lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED })
    .catch((e) => log.error({ err: e }, 'refresh-tap-ratings cron'));
}),
```

Стає:

```ts
// enrich-orphans every 3h at xx:30 (offset to avoid the busy on-hour
// minute where ontap and untappd-had run). 8 runs/day × 20 limit =
// 160 lookups/day; backfill of 287 backlog in ~1.8 days, vs 7 days
// at the previous 12h frequency.
cron.schedule('30 */3 * * *', () => {
  enrichOrphans({ db, log, http, lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED })
    .catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
}),
// refresh-tap-ratings every 3h at xx:30 too, but offset by 1h so
// enrich and rating-refresh don't burst simultaneously against
// Untappd (separate 3h cycles, alternating every 1.5h).
cron.schedule('30 1,4,7,10,13,16,19,22 * * *', () => {
  refreshTapRatings({ db, log, http, lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED })
    .catch((e) => log.error({ err: e }, 'refresh-tap-ratings cron'));
}),
```

### Результуючий cron-розклад

Day-flow (UTC):

| Час | Job | Burst (orphan backlog) |
|---|---|---|
| 00:00 / 12:00 | refreshOntap | внутрішнє, fresh-orphans only |
| 00:30 / 03:30 / 06:30 / 09:30 / 12:30 / 15:30 / 18:30 / 21:30 | enrich-orphans | до 10s |
| 01:30 / 04:30 / 07:30 / 10:30 / 13:30 / 16:30 / 19:30 / 22:30 | refresh-tap-ratings | до 10s |
| 03:00 | refreshAllUntappd | per-user beers-page scrape |

Між будь-якими двома Untappd-cron-burst-ами — мінімум 1 година. На Untappd жодного нового burst-patterрну, лише 4× частіше.

### Throughput-математика

| Метрика | Status quo | After bump |
|---|---|---|
| enrich runs/day | 2 | 8 |
| Lookups/day per job | 40 | 160 |
| Daily HTTP volume (обидва job) | 80 | 320 |
| Backfill 287 orphan | 7.2 дні | 1.8 дні |
| Burst duration | 10s | 10s — без змін |
| Burst frequency | 12h | 3h |

Untappd-екскурс: денний обсяг росте 4×, але «burst sigature» лишається. У rate-limit-моделях зазвичай саме burst тригерить captcha, не denominator-у-добі. Тож ризик росте мінімально, а швидкість — у 4×.

### Чому 3h, не 4h чи 6h

Розглянуті альтернативи:

- **6h (4 runs/day = 80/day = 3.6 дні backfill).** Безпечніше, але юзеру некомфортно чекати ще тиждень майже.
- **4h (6 runs/day = 120/day = 2.4 дні).** Компроміс. Окей.
- **3h (8 runs/day = 160/day = 1.8 дні).** Швидкий backfill, помітна перевага.
- **2h (12 runs/day = 240/day = 1.2 дні).** Денний обсяг росте 6×, відчутно. Burst-частоти Untappd може почати помічати як «постійний шум».

3h найкращий компроміс «швидкість vs стриманість». Якщо Untappd таки почне rate-limit-ити — `transient`-метрика зросте у логах, і можна без поспіху dial-back до 6h або 12h.

### Master spec оновлення

Дві мінорні зміни в `2026-05-26-untappd-lookup.md`:

1. **PR-D2 секція**, абзац про «Cron `enrich-orphans` — backfill»:

> Раніше: «20×2 = 40 запитів/день. За тиждень backlog-кейс (286) закриється повністю.»
> Стає: «20×8 = 160 запитів/день, runs at xx:30 every 3h. Backlog ~287 закривається за ~1.8 днів. Бамп з 12h до 3h частоти виконаний у PR-D-throughput-bump (2026-05-29) після виявлення, що 7-денний backfill зашвидко не покриває реальний user-pain.»

2. **PR-D3 секція**, абзац про cron:

> Раніше: «09:00/21:00 — offset від D2».
> Стає: «runs at xx:30 every 3h, offset 1h від enrich-orphans (xx:30 на годинах 1, 4, 7, 10, 13, 16, 19, 22 UTC). Frequency bumped from 12h to 3h together with enrich-orphans (PR-D-throughput-bump 2026-05-29).»

3. **Новий buллet у Risks/Footguns:**

> **Throughput-tuning lesson.** Initial PR-D2 plan хардкодив `LIMIT=20` × 12h cron «з рукава», без розрахунку backlog-часу. На реальному 287-orphan backlog це дало 7-денний фікс, що неприйнятно для one-off bug-trace user-flow (`/newbeers Piw Paw` пропускав beer без rating). Bump до 3h cron-частоти (LIMIT незмінний) дає 1.8-денний backfill, зберігаючи burst-сигнатуру (10s × 20 calls), яку Untappd толерує. Якщо `transient` метрика colon-у logs почне рости — dial-back до 6h або 12h. Урок: коли LIMIT × cron-frequency визначає user-facing latency, рахуй backlog-time перед коммітом плану.

## Тести

- **Жодних нових тестів.** Зміна — два рядки cron-syntax-у в `src/index.ts`, що не покривається unit-тестами (їх немає для wire-up частини index.ts).
- **Існуючі тести лишаються зеленими** — `enrichOrphans` / `refreshTapRatings` мають свої unit-suite, які тестують логіку, а не cron-розклад.
- Перевіримо: `npm test` clean, `npm run typecheck`, `npm run build`.

## Post-deploy verification

1. Перевірити, що cron спрацював за перший добу:
   ```bash
   sudo journalctl -u warsaw-beer-bot --since today | grep -c "enrich-orphans done"
   ```
   Очікувано: 8 (або менше, якщо деплой пізно вдень).
2. Перевірити transient-count:
   ```bash
   sudo journalctl -u warsaw-beer-bot --since today | grep "enrich-orphans done" | grep -oE '"transient":[0-9]+' | sort | uniq -c
   ```
   Якщо transient > 2-3 на кожен run — сигнал rate-limit-у, dial-back.
3. Перевірити backlog count:
   ```sql
   SELECT COUNT(*) FROM beers b
   WHERE b.untappd_id IS NULL
     AND EXISTS (
       SELECT 1 FROM match_links ml
       JOIN taps t ON t.beer_ref = ml.ontap_ref
       JOIN tap_snapshots ts ON ts.id = t.snapshot_id
       JOIN (SELECT pub_id, MAX(snapshot_at) m FROM tap_snapshots GROUP BY pub_id) latest
         ON latest.pub_id = ts.pub_id AND latest.m = ts.snapshot_at
       WHERE ml.untappd_beer_id = b.id);
   ```
   День 0: ~267 (поточний). День 1: ~110-130. День 2: ~0-30. День 3: близько 0 (мінус справжні no-match-кейси).

## Risks / Footguns

- **Untappd таки помічає денний обсяг.** Малоймовірно за теорією rate-limit-у (burst-based), але можливо. Сигнал: `transient` спайки в логах. Mitigation: dial-back cron на 6h або 12h (один рядок змін у `src/index.ts`).
- **Конфлікт із refreshOntap (00/12).** refreshOntap робить власні HTTP проти ontap.pl (інший сервер) у власному pace. Не конфліктує з Untappd. Але SQLite — спільна. На in-memory DB конкуренція мінімальна; на проді SQLite з WAL-mode і `journal_mode = WAL` (вже налаштовано) дозволяє concurrent read + single writer. enrich-orphans і refreshOntap обидва пишуть → черга. Burst 10s + sweep 5min — не помітно.
- **«30 */3 * * *» minute-offset легко переплутати при майбутніх правках.** Один інженер може випадково додати ще одну cron-job на `0 6 * * *` і збитися. Mitigation: коментар прямо біля cron-schedules-у вибудовує day-flow.
- **PR-D2.1 «harmless guards» lesson** — застосовується? Не зовсім: тут немає hot loop із N>1000 iterations. Cron-burst чітко bounded LIMIT-ом=20.
