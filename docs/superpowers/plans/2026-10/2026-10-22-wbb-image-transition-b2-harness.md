# Деплой образом — стадія «б2», обв'язка: ручний вхід `deploy.sh`, runbook оператора, PR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** зробити ручний режим контролера, змерджений ядром «б2», придатним для людини. Для цього потрібні:
- обгортка `deploy/image/deploy.sh` — перевіряє checkout і кличе **встановлену** копію контролера з `--manual …`;
- розділ оператора в `deploy/README.md`;
- статус спеки;
- PR усієї гілки «б2».

**Хост не змінюється.** Обгортка не встановлюється: вона працює з checkout-а, як і сьогоднішній `deploy/deploy.sh`. До стадії «в» встановлена копія контролера (`/usr/local/bin/wbb-autodeploy`) — це старий flat-деплоєр. Тому на хості обгортка відмовлятиме завжди, і так задумано (рішення власника №8). Стадія «в» робить `git mv deploy/image/deploy.sh deploy/deploy.sh` разом з контролером.

Ядро: `docs/superpowers/plans/2026-10/2026-10-21-wbb-image-transition-b2-core.md`, рішення 1–38, гілка `claude/eager-clarke-sd54rk` до `bdc91f4`. Наскрізне рев'ю ядра пройдено: блокерів нема, усі знахідки закрито.

Спека: `docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md`, поправка 3. Власник затвердив її 21.10, а уточнення простою bootstrap (~3–5 хв, з повторним аудитом) — 22.10. Розділи: §4.3, §7.3, §7.4 (таблиця команд), §8 п.2–3.

**Tech Stack:** bash (обгортка), TypeScript/Vitest (тест обгортки зі справжнім git і заглушкою контролера).

## Рішення

1. **Граматика обгортки — людська, без `--manual`.** Кожна команда перекладається на виклик контролера. Будь-що інше — вихід 64 з usage.

   | Команда | Виклик контролера |
   |---|---|
   | `deploy.sh [--force] [--ack-incompatible]` | `--manual deploy --target <HEAD> [--force] [--ack-incompatible]` |
   | `deploy.sh --bootstrap` | `--manual bootstrap --target <HEAD>` |
   | `deploy.sh --resolve-incident --settled <sha>` | `--manual resolve-incident --settled <sha>` |
   | `deploy.sh --resolve-incident --flat` | `--manual resolve-incident --flat` |

   `--force`/`--ack-incompatible` поза `deploy`, `--settled` без `--resolve-incident` і подвійні прапорці відкидає вже обгортка. Остаточна граматика — у контролері; обгортка лише не передає те, чого він не прийме.
2. **Перевірки обгортки, у такому порядку** (кожна відмова — вихід 1 з поясненням):
   1. Не root (`id -u` ≠ 0, як у старого `deploy.sh`): стан і lock живуть у `$HOME` оператора.
   2. Скрипт лежить у git-checkout-і: `git -C "$(dirname "$0")" rev-parse --show-toplevel`.
   3. Для `deploy` і `bootstrap`:
      - checkout чистий, тобто `git status --porcelain --untracked-files=no` порожній (ціль — HEAD, і людина має знати, що деплоїть саме його);
      - `timeout 120 git fetch -q origin main` вдався;
      - `git merge-base --is-ancestor HEAD origin/main`.

      Для `resolve-incident` ціль задано явно (`--settled`) або її бере контролер (`--flat`), тож ці перевірки не виконуються.
   4. Встановлена копія контролера (`WBB_INSTALLED_CONTROLLER`, за замовчуванням `/usr/local/bin/wbb-autodeploy`) **байт у байт** дорівнює `autodeploy.sh` поруч із самою обгорткою (`$(dirname "$0")/autodeploy.sh`). Це працює для обох розкладок: `deploy/image/` до «в» і `deploy/` після `git mv`. Розбіжність → відмова з поясненням: «встановлена копія — не цей контролер; до стадії «в» так завжди; після — `sudo bash deploy/install-autodeploy.sh`».
   5. `exec` встановленої копії з перекладеними аргументами. Код виходу — контролера.
3. **Обгортка не бере lock і не читає стан.** Обидва належать контролеру. Подвійний lock із різними тайм-аутами дав би дві різні відмови на той самий факт.
4. **Seam-и для тесту:** `WBB_INSTALLED_CONTROLLER`, `WBB_UID_CMD` (типово `id -u`). Іншого обгортка ззовні не торкається, крім git.
5. **Hold.** `deploy/image/deploy.sh` (а після «в» — `deploy/deploy.sh`) запускається з checkout-а й не встановлюється, тож hold-шляхом не є. Чинний тест `deploy-hold-check.test.ts` це вже фіксує (`['deploy/image/deploy.sh', false]`). PR однаково несе `[deploy:hold]` через `deploy/image/autodeploy.sh` і `deploy/db-snapshot.sh`.

## Таблиця «заявка → доказ»

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| «Ручний запуск = код таймера» (§14) | контролер, який виконує ручну команду, — той самий, що встановлено під таймер | `cmp` встановленої копії з файлом checkout-а перед `exec` | сильний на момент запуску |
| Ціль ручного деплою — HEAD checkout-а з `main` | людина деплоїть те, що бачить | чистий checkout + `merge-base --is-ancestor HEAD origin/main` після fetch-у; контролер повторює перевірку проти свого клону | сильний |

Проб нема: обгортка не стверджує жодного факту про хост, а лише звіряє файли й git.

## Global Constraints

- Правила тестів CLAUDE.md. Гейт: `su tester -c 'cd /home/user/warsaw-beer-bot && npm test && npm run typecheck'` (дивитися справжній код виходу) і від root `npm test -- scripts/release.test.ts`.
- Не змінюються: контролер `deploy/image/autodeploy.sh`, `deploy/autodeploy.sh`, `deploy/deploy.sh`, `db-snapshot.sh`, `install-*.sh`, хелпер.
- Ніколи не `chown`/`chmod` репо.

---

### Task 1: обгортка `deploy/image/deploy.sh`

**Files:** новий `deploy/image/deploy.sh` і новий `scripts/autodeploy/image-deploy-wrapper.test.ts`.

- [ ] Тести спершу. Сетап: тимчасовий bare-origin і checkout зі справжнім git. У checkout копіюються обгортка і файл `deploy/image/autodeploy.sh`. «Встановлена» копія — заглушка, що пише свій argv у файл і виходить із заданим кодом. Асерти точні: argv заглушки (або «не викликана»), код виходу, stderr.
  - (а) Переклад кожного рядка таблиці п.1, HEAD — справжній SHA checkout-а. Код виходу заглушки (0, 1, 2, 3) повертається без змін.
  - (б) Usage → 64, заглушку не викликано:
    - без команди нічого не бракує (`deploy`);
    - `--settled` без `--resolve-incident`;
    - `--resolve-incident` без `--settled`/`--flat`;
    - обидва разом;
    - `--force` у `--bootstrap`;
    - невідомий прапорець;
    - `--force` двічі;
    - `--settled` з коротким SHA.
  - (в) root (`WBB_UID_CMD` друкує 0) → 1.
  - (г) Брудний checkout (змінений відстежуваний файл) → 1 для `deploy` і `--bootstrap`. Невідстежуваний файл — не брудний. Для `--resolve-incident` брудний checkout дозволено.
  - (ґ) HEAD не на `origin/main` (коміт у бічній гілці) → 1; fetch падає (origin недоступний) → 1.
  - (д) Встановлена копія відрізняється одним байтом або її нема → 1 з текстом п.2.4, заглушку не викликано.
  - (е) Обгортка, запущена з іншого cwd (`cd /`), знаходить свій checkout.
- [ ] Реалізація за п.1–4, у стилі `deploy/autodeploy.sh`: `set -euo pipefail`, коментарі пояснюють «чому».
- [ ] Мутації:
  - без перевірки байтів → (д);
  - перевірка чистоти й для `resolve` → (г);
  - `--target` береться з `origin/main` замість HEAD → (а);
  - `exec` без передачі коду → (а).
- [ ] Гейт, коміт.

### Task 2: runbook оператора і спека (дрібна, інлайн)

**Files:** `deploy/README.md`, спека.

- [ ] `deploy/README.md`: розділ «Image controller (stage «б»: in the repo, not installed)» переписати так, щоб він описував стан після ядра «б2».
  - Додати підрозділ **«Manual commands (from stage «в»)»**:
    - чотири команди таблиці п.1 і що кожна робить, з посиланнями на §7.4;
    - відмова обгортки до «в»;
    - вихідні коди.
  - Додати підрозділ **«The first image release (bootstrap)»**:
    - перший запуск із сухим trial;
    - кроки root, які друкує контролер: `systemctl stop`, `disable`, `mv …service.flat`, `daemon-reload`;
    - другий запуск і простій ~3–5 хв;
    - перерваний другий запуск лишає бота зупиненим;
    - як повернути старий юніт;
    - вимога, щоб Quadlet-файлу не було.
  - Додати підрозділ **«After a failed bootstrap»**:
    - `--resolve-incident --flat`;
    - прибрати залишений Quadlet-файл/контейнер.
  - Тексти — для оператора, з точними командами.
- [ ] Спека:
  - статус «поправка 3 затверджена 21.10; уточнення простою — 22.10»;
  - посилання на обидва плани «б2»;
  - §11 доповнити рядком про обгортку (`deploy/image/deploy.sh` → `deploy/deploy.sh` у «в»).
- [ ] `spec.md` (корінь) перевірити: описує merge-deploy flat-деплоєра, і до стадії «в» цей опис правдивий, тож не міняється. Записати це в описі PR.
- [ ] Гейт (лише doc-тести, якщо є), коміт.

### Task 3: PR гілки «б2»

- [ ] `git fetch origin main` → `git rebase origin/main` (`main` зрушив) → повний гейт наново → `git push --force-with-lease`.
- [ ] Cross-review: `npm run cross-review -- --reviewer codex` у фоні. Якщо в цьому середовищі codex нема (exit 5), маркер — `Cross-review: failed (<причина>)`.
- [ ] PR. Заголовок починається з `[deploy:hold]`, мітка `deploy:hold`. Опис:
  - що в «б2» (ядро + обв'язка, посилання на плани);
  - що на хості нічого не перемикається;
  - **кроки людини після мерджу**: `sudo bash deploy/install-autodeploy.sh` (оновлює встановлений `db-snapshot.sh`: нова дія `unmark`, без цього старий таймер вважатиме копію застарілою), далі `bash deploy/deploy.sh`;
  - про `spec.md`;
  - маркер cross-review.
- [ ] Підписатися на PR і довести його до зеленого.

---

## Після: стадія «в»

Окремий план, після мерджу «б2». Обриси — у плані ядра «б2», розділ «Після». Нове з ядра «б2»:
- перенести гейтові ключі зі `state.env` у `image-state.env` (сіє `DEPLOYED_SHA` для bootstrap);
- **не** встановлювати `warsaw-beer-bot.container` наперед;
- `git mv` обгортки разом з контролером;
- спершу репетиція і P3, потім bootstrap.
