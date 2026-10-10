# Artifact deployment — обв'язка 2в, етап Б (периферія-1): releaseSha, rearm/ack, повтори підготовки — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** закрити те, що рушій і tick уже припускають, але чого ще немає: застосунок віддає `releaseSha` у `/health` (спека §7), оператор має CLI для `rearm` і підтвердження baseline/fence, tick не завантажує й не публікує заново вже прийнятий реліз і не повторює транзієнтну підготовку щохвилини, а кореневий процес під `sudo` не лишається сиротою після таймауту. Спека §5, §7, §8; розділи «Після Б-ядра» і «Наскрізне рев'ю Б-ядра» плану `…/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md`.

**Поділ.** Решта етапу Б — обгортка `deploy.sh`, retention, міграція state v1→v2 — прив'язана до переходу layout і встановлення (що лежить де на хості й коли перемикається), тож іде разом з етапом В, де ці рішення ухвалюються. Цей план — чотири незалежні від установки задачі.

**Tech Stack:** TypeScript (застосунок), Python ≥3.12 stdlib (control plane).

## Рішення

1. **`WBB_RELEASE_REQUIRED`** — новий необов'язковий ключ `.env`, `'true' | 'false'`, за замовчуванням `false`. **Без `[deploy:hold]`:** зі значенням за замовчуванням нічого не змінюється, а нинішній flat-деплой не має `release.json`, тож вмикати ключ до переходу на artifact-layout не можна й не треба. Вмикає його інсталятор етапу В разом із переходом (там і буде hold).
2. **Ідентичність релізу** читається **один раз** на старті з `release.json` у корені застосунку: `realpath(join(__dirname, '..'))` для `dist/…` (проба ядра 2в: `__dirname` — реальний шлях дерева, не `current`). Перевіряється `formatVersion`, `sourceSha` (40 hex), `platform.os/arch/libc`, `node.major` проти `process.versions.node`. Немає файлу або він невалідний: `WBB_RELEASE_REQUIRED=true` → старт падає з причиною; `false` → `releaseSha: null` і попередження в лог лише коли файл є, але невалідний. Значення заморожене: `/health` не перечитує файл (спека §10a, рядок `/health.releaseSha`).
3. **`/health`** → `{ ok: true, releaseSha: <sha|null> }`. Публічний commit SHA відкритого репо явно дозволено спекою §7.
4. **`tick.py rearm --sha <sha>`** знімає `lastFailedSha` (лише якщо він дорівнює `--sha`, інакше відмова) і очищає `abort` для цього SHA. **`tick.py ack-baseline --from <sha>`** знімає regression fence лише для тієї пари, яку показує tick-стан. Обидва — під тим самим lock, ручні, друкують, що змінили, і пишуть подію в evidence state v2. Таймер їх не викликає.
5. **Повтори підготовки:** якщо `wbb-release verify --sha` дає дерево (receipt є), download/publish пропускаються. Транзієнт підготовки — backoff у tick-стані `{sha, count, at}`: 5 хв × 2^(n−1), стеля 1 год, скидається новим SHA або успіхом.
6. **`bounded.run` за таймаутом:** SIGTERM, пауза `TERM_GRACE_S = 10`, потім SIGKILL. `sudo` передає SIGTERM дочірньому процесу; SIGKILL — ні.

## Таблиця «заявка → доказ»

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| `/health.releaseSha = X` | Цей процес стартував з дерева, чий `release.json` каже X | Читання один раз від `realpath(__dirname/..)` при старті; проба ядра 2в (realpath) | сильний; не атестація провенансу (спека §10a) |
| rearm X | Оператор свідомо дозволив повтор X | Явний CLI з `--sha`, рівним записаному; подія в evidence | сильний |
| receipt є → пропуск publish | Дерево вже прийняте й не змінене | `verify` у цьому tick (перевіряє дерево проти receipt) | сильний. Наслідок (рев'ю N1): правило конфлікту (§4) тепер розв'язується на користь раніше прийнятих байтів — новий trusted run того самого SHA з іншим digest не публікується й не відмовляє, активуються вже прийняті. Обходу немає: receipt пише лише `publish` з trusted run того самого SHA, CI-гейт exact SHA лишається. |
| `prepareRetry {sha,count,at}` | Підготовка цього SHA транзієнтно впала `count` разів підряд, востаннє в `at` | Записується лише з `Transient` від `prepare` у цьому tick; скидається будь-яким іншим результатом і новим SHA | сильний |
| `ack-baseline` | Оператор свідомо прийняв поточний settled після регресії | Явний CLI з `--from`, рівним fence; спостереження (`lastSeenSettled`) переходить на settled тим самим записом — інакше наступний tick побачить ту саму розбіжність (рев'ю S1) | сильний |

## Global Constraints

- TS: Vitest, правила тестів CLAUDE.md; `npm test && npm run typecheck`. `.env.example` і `EXPECTED_PROD_KEYS` — за правилом, що там записане (ключ необов'язковий, у prod-список не входить, поки не ввімкнений переходом).
- Python: як у попередніх етапах (`deploy/release/test_*.py`, `scripts/deploy-rsync.test.ts`).
- `spec.md` оновлюється в тому ж PR (§5.9 і розділ про `/health`).

---

### Task 1: `releaseSha` у застосунку

**Files:** `src/config/env.ts` (+ тест), новий `src/release/identity.ts` (+ тест), `src/api/index.ts` (+ тест `/health`), `src/index.ts` (читання на старті), `.env.example`.

- [x] Ключ і схема (Рішення п.1). Модуль ідентичності (п.2) з інжектованим коренем і `fs` для тестів; тести: валідний, відсутній, невалідний JSON, чужа платформа, інший major Node, `formatVersion` інший — у режимах required/не required.
- [x] `/health` повертає заморожене значення (п.3); тест, що зміна файлу після старту не міняє відповідь.

### Task 2: `tick.py rearm` і `ack-baseline`

**Files:** `deploy/release/tick.py`, `test_tick.py`.

- [x] За Рішенням п.4; тести: rearm на інший SHA — відмова без змін; rearm знімає `abort` того SHA; ack-baseline з парою, що не збігається, — відмова; обидва під lock (зайнятий lock — відмова з кодом 1).

### Task 3: пропуск download/publish і backoff транзієнтів

**Files:** `deploy/release/prepare.py`, `tick.py`, `tick_state.py`, `gates.py` + тести.

- [x] За Рішенням п.5. Тести: receipt є — `download`/`publish` не викликаються; транзієнт двічі — другий повтор лише через 10 хв; новий SHA скидає backoff; успіх скидає.

### Task 4: `bounded.run` — SIGTERM спершу; документи

**Files:** `deploy/release/bounded.py`, `test_bounded.py`; `spec.md` §5.9 і `/health`; `deploy/README.md`.

- [x] За Рішенням п.6. Тест: дочірній процес, що ловить SIGTERM і пише маркер, отримує його до SIGKILL; процес, що ігнорує SIGTERM, гине через `TERM_GRACE_S`.

---

## Після

Рев'ю. Далі етап В (одним планом із залишком Б): інсталятор, sudoers для кожного дієслова `wbb-release`, юніт tick-а, користувач `wbb-trial`, обгортка `deploy.sh`, retention, міграція state v1→v2, legacy transition з увімкненням `WBB_RELEASE_REQUIRED=true` (`[deploy:hold]`).
