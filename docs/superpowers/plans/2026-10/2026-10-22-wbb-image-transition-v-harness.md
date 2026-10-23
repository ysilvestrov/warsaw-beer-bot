# Деплой образом — стадія «в», обв'язка: набір для репетиції, `unit=` у статусі, перевірка перед сеансом, runbook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** все, що потрібно людині для сеансу перемикання хоста:
- **набір для репетиції** (поправка 4, рішення 1): справжній контролер і справжній хелпер на тестовому юніті `wbb-rehearsal`, без зміни production;
- **`unit=quadlet|foreign`** і образ, що працює, у щоденному статусі (рішення 3);
- **read-only перевірка перед сеансом**;
- **повний runbook** сеансу в README.

Ядро «в»: `docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md`, рішення 1–14, до `e9b2acf`; рішення 15 (23.10) — `reset-failed` в `activate` хелпера. Наскрізне рев'ю ядра пройдено, знахідки закрито. Спека: поправка 4 (затверджена 22.10), §6.3, §7.2, §8 п.2–5, §10.

## Рішення

1. **Набір для репетиції — `scripts/ops/rehearsal/`, не встановлюється.** Запускає оператор: `bash scripts/ops/rehearsal/run.sh <S-sha> <D-sha>`, де S — старіший коміт `main` з образом, D — новіший. Перед запуском береться `sudo -v`. Набір складається з частин:
   - **Shim хелпера** `wbb_image_rehearsal.py`. Він імпортує `wbb_image` **з checkout-а** (`deploy/image/helper/`) і кличе `wbb_image.main(argv, host=REHEARSAL)`, де `REHEARSAL` — свій `Host`:
     - `quadlet_path=/etc/containers/systemd/wbb-rehearsal.container`;
     - `template_path` — шаблон набору;
     - `snapshot_root=/var/lib/wbb-rehearsal/data/deploy-snapshots`, `scratch_root=/var/lib/wbb-rehearsal/scratch`.

     **Корінь набору фіксований** — `KIT_ROOT=/var/lib/wbb-rehearsal`, а не тимчасові каталоги (поправка з Task 1): шаблон не має плейсхолдера для шляхів, тож `DATABASE_PATH` і `Volume=` у ньому — літерали. `run.sh` створює корінь на початку й видаляє в прибиранні: `data/` і `data/deploy-snapshots/` належать боту, `scratch/` — root, 0700. Порт набору — `KIT_PORT=3917`. Єдине джерело обох — константи shim-а; тест тримає шаблон рівним їм, а `run.sh` читає їх через `wbb_image_rehearsal.py --kit-root` / `--kit-port` (друкує, вихід 0, хелперу не передається).

     Перед викликом shim підміняє константи модуля `CONTAINER='wbb-rehearsal'` і `UNIT='wbb-rehearsal.service'` (хелпер читає їх під час виклику) і обгортає `render_template` для «хворого» digest-а; після виклику все повертається. `prune` під shim-ом додає до `--keep` digest, який пінить Quadlet-файл **production**, коли той є: інакше хелпер тримає лише пін свого хоста (набору), і після перемикання `prune` набору видалив би образ production. Нечитаний Quadlet-файл production — `REFUSED`, нічого не запущено. Хелпер у `/usr/local/lib/wbb-image` і sudoers не змінюються. Shim запускається через `sudo python3 -I` під кешем `sudo -v`, без NOPASSWD.
   - **Шаблон** `wbb-rehearsal.container`: ті самі ключі, що в production (§3.2), окрім таких:
     - **без `EnvironmentFile`** — справжній `.env` не монтується. Замість нього підставне оточення §6.3 (фальшивий токен формату BotFather, `API_PORT=<порт набору>`, `DATABASE_PATH` на копію) і `NODE_OPTIONS=--require=/app/deploy/image/offline-telegram.cjs` (форма з `=`: systemd ділить значення `Environment=` на пробілі);
     - один `Volume=` — каталог копії БД;
     - `Network=host`, бо `/health` на порту набору;
     - `--add-host=api.telegram.org:127.0.0.1` у тому ж `PodmanArgs=`: з мережею `getMe` фальшивого токена отримав би від Telegram помилку, якої `offline-telegram.cjs` не терпить (він терпить лише `FetchError` node-fetch), і бот падав би навіть здоровим кандидатом. Відмовлене чи з чужим сертифікатом з'єднання — це `FetchError`. Що podman 4.9 приймає `--add-host` разом із host-мережею, не доведено — це перевіряє сценарій (а);
     - без `[Install]`: прибирання, вбите до видалення Quadlet-файлу, плюс перезавантаження не мусять підняти другого бота.

     Плейсхолдери ті самі, тож `render_template` хелпера працює без змін.
   - **Контролер з checkout-а** (`deploy/autodeploy.sh`) з тимчасовими `XDG_STATE_HOME`/`XDG_DATA_HOME` і такими seams:
     - `WBB_IMAGE_CMD` → shim;
     - `WBB_RESTARTS_CMD` і `WBB_UNIT_STATE_CMD` → `systemctl show wbb-rehearsal`;
     - `WBB_API_PORT_CMD` → порт набору;
     - `WBB_DB_PATH` і `WBB_SNAPSHOT_DIR` → копія;
     - `WBB_SNAPSHOT_CMD`, `WBB_MARK_CMD`, `WBB_UNMARK_CMD`, `WBB_DISCARD_CMD`, `WBB_PRUNE_CMD` → `deploy/db-snapshot.sh` з checkout-а під `sudo -u warsaw-beer-bot`;
     - `WBB_NOTIFY_CMD` → файл набору. У Telegram нічого не йде;
     - `WBB_INSTALLED_CHECK=''` — перевірку копій вимкнено, бо контролер не встановлений.

     Справжні лишаються CI, резолв і атестація (GitHub, GHCR).
   - **Копія БД:** свіжий `VACUUM INTO` production-БД від імені бота в тимчасовий каталог набору.
2. **Сценарії** (`run.sh` проганяє по черзі, кожен має очікуваний результат; після кожного — вердикт PASS/FAIL у підсумку):
   - **(а) bootstrap S** через `--manual bootstrap`. Набір сам «прибирає» старий юніт: для тестового юніта його нема, тож одразу другий запуск. Очікується: перший settled S. **P3** — набір логує час `pull`, `audit` і `trial` із подій.
   - **(б) деплой D через `--manual deploy` в `auto`** → settled D.
   - **(в) поганий кандидат → автовідкат.** Shim для digest-а, позначеного набором як «хворий» (env `REHEARSAL_SICK_DIGEST`), рендерить шаблон з `Exec=node -e "process.exit(1)"`. Кандидат стартує і падає, вікно провалюється, відкат на D. Очікується: відкат на D, вихід 2, працює D, `LAST_FAILED_SHA` записано. Як «хворий» кандидат іде образ S, новий для вікна, бо settled тепер D. `REHEARSAL_SICK_DIGEST` іде лише в цей сценарій і через `sudo REHEARSAL_SICK_DIGEST=… python3 -I …` (sudo скидає оточення). Ризик, який тут чекав живої проби, підтвердився й виправлений: проба 23.10 (спека, V16) показала, що хворий кандидат вичерпує ліміт стартів і `restart` відкату відмовляє; `activate` тепер спершу робить `reset-failed` (ядро, рішення 15). Набір імпортує хелпер **з checkout-а**, тож сценарій (в) перевіряє фікс ще до перевстановлення хелпера на кроці 7 runbook-у.
   - **(г) обриви за таблицею §7.2.** Набір запускає деплой S поверх D і вбиває контролер при `WINDOW_PHASE=activating`, потім при `watching`, кожен у окремому прогоні. Далі звичайний tick (з тим самим станом) має довести вікно за рядком таблиці: settled або скасування. Перед активацією очікується «вікно скасовано, повтор», після — «повне вікно від зараз».
   - **(ґ) рядок «юніт не наш»:** набір підміняє юніт (unit file у `/etc/systemd/system/wbb-rehearsal.service`), і `current` має сказати `foreign` → інцидент; потім прибирає.
3. **Прибирання — `trap` на EXIT/INT/TERM**, до і після кожного сценарію:
   - зупинити `wbb-rehearsal`;
   - видалити Quadlet-файл і `/etc/systemd/system/wbb-rehearsal.service`;
   - `daemon-reload`;
   - видалити контейнер `wbb-rehearsal`;
   - видалити тимчасові каталоги й копію БД;
   - образи S і D лишаються: це образи `main`, `prune` їх прибере;
   - перевірити, що `warsaw-beer-bot.service` і його Quadlet не змінились (тобто `current` production до і після однаковий) — інакше FAIL і гучне повідомлення.
4. **Набір не стосується production.** Перед стартом він відмовляє, коли:
   - `wbb-rehearsal` уже існує;
   - порт набору зайнятий;
   - `SUDO`-кешу нема;
   - S чи D не мають образу;
   - вільного місця менше за 5 GiB;
   - корінь набору `/var/lib/wbb-rehearsal` уже існує;
   - Quadlet-файл production існує (репетиція — до перемикання);
   - S і D мають однаковий `wbb.content`: деплой був би noop і нічого не перевірив би.

   Ім'я контейнера, юніта й Quadlet-файлу ніде не збігається з production (тест на це).
5. **`unit=` у статусі (рішення 3, §10).** `scripts/ops/host_patch_collect.py` (root, щогодинний таймер) додає в `summary.json` поле `image`:
   - `unit`: `quadlet|foreign|absent` — за правилом `unit_type` хелпера, через `systemctl show`;
   - `running_digest` з `podman container inspect warsaw-beer-bot`;
   - `deployed_digest` з `image-state.env` оператора: шлях задається аргументом збирача, а встановлювач збирача знає оператора.

   Те, що не вдалося прочитати, записується як `null`, а не як помилка. Немає `image-state.env` → `deployed_digest: null`. Бот у статусі показує `unit=… · образ <12 символів digest> (= / ≠ задеплоєного)`. До перемикання юніт `foreign` — це очікувано, і статус пише «flat (до перемикання)».

   Зміна збирача — встановлена копія, тож hold. Його інсталятор (`install-host-patch-collector.sh`) — частина кроків PR.
6. **Перевірка перед сеансом** `scripts/ops/switchover-preflight.sh`. Read-only, запускає оператор. Перевіряє:
   - таймер `disabled` і неактивний, `wbb-autodeploy.service` неактивний, lock вільний;
   - `state.env` звичайний файл без `WINDOW_*`/`ROLLBACK_STARTED`;
   - `DEPLOYED_SHA` є і є предком `origin/main`;
   - `image-state.env` нема;
   - `install-image.sh --check` чистий — з одним очікуваним винятком: до кроку 7 runbook-у встановлений хелпер старший за checkout (рішення 15 ядра). `--check` тоді виходить з 1 і друкує `DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (content)` і `1 difference(s): sudo bash deploy/install-image.sh`. Preflight такий результат — коли єдина розбіжність — це `(content)` саме `wbb_image.py` — показує як «очікується перевстановлення (крок 7)», не FAIL. Будь-яка інша розбіжність (`not installed`, `mode`, `owner`, інший файл, каталог) — FAIL;
   - `gh attestation verify --help` має `--source-digest` і `--deny-self-hosted-runners`;
   - checkout чистий на `origin/main`;
   - у HEAD є опублікований атестований образ (резолв і verify);
   - Quadlet-файлу нема;
   - вільно ≥ 5 GiB;
   - **старі копії репо без захисту `state.env`** (пошук §8 п.3).

   Друкує PASS/FAIL по кожному пункту і вихід 0 лише тоді, коли все PASS.
7. **Runbook у README** («Switchover session (stage «в»)»):
   1. мердж В1 на початку сеансу;
   2. `sudo systemctl disable --now wbb-autodeploy.timer`;
   3. чекати, поки звільняться сервіс і lock;
   4. `switchover-preflight.sh`;
   5. репетиція (`run.sh`) і прочитати підсумок + P3;
   6. `migrate-state-to-image.sh`;
   7. `sudo bash deploy/install-image.sh` (перевстановлює хелпер з рішенням 15 ядра), потім `sudo bash deploy/install-image.sh --check` — чистий, потім `install-autodeploy.sh`, потім `install-host-patch-collector.sh`;
   8. `bash deploy/deploy.sh --bootstrap` двічі, з кроками root між ними;
   9. `sudo systemctl enable --now wbb-autodeploy.timer`;
   10. перевірити перший tick і статус.

   До кожного кроку — що робити, якщо крок відмовив. До кроку 5: бот набору робить справжні вихідні запити (крони) і пише лише в копію БД; у Telegram нічого не йде.

## Таблиця «заявка → доказ»

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| Репетиція PASS | контролер і хелпер на цьому хості роблять те, що кажуть тести | ті самі файли з checkout-а, справжні podman/systemd/GHCR/attestation, сценарії (а)–(ґ) | сильний для перелічених сценаріїв; не доводить поведінки під справжнім `.env` |
| Production не зачеплено | репетиція не змінила бота | `current` production до/після однаковий; імена ніде не збігаються (тест) | сильний |
| P3 | тривалість pull/audit/trial на цьому хості | час подій репетиції на копії production-БД | сильний як замір |
| `unit=` у статусі | що працює і чим | `systemctl show` + `podman inspect` збирачем root | сильний на момент збору (щогодини) |
| Preflight PASS | передумови сеансу виконано | кожна перевірка — живе читання | сильний на момент запуску |

## Global Constraints

- Правила тестів CLAUDE.md. Гейт як у ядрі: повний прогін у фоні, тайм-аут ≥ 40 хв, плюс від root `release.test.ts`.
- Ніколи `chown`/`chmod` репо, крім режиму нових скриптів.
- Хелпер (`deploy/image/helper/**`) і sudoers не змінюються. Виняток — рішення 15 ядра (23.10): `reset-failed` перед `restart` в `activate`; через нього хелпер перевстановлюється на кроці 7 runbook-у.
- Набір тестується без root: shim — Python-тестом на фейковому `Host`, як `test_wbb_image.py`; `run.sh` — через seams (`REHEARSAL_SUDO`, `REHEARSAL_SYSTEMCTL`, `REHEARSAL_PODMAN`) і стаби; прибирання — тестом, що вбиває на кожному кроці.
- PR В1 (ядро + обв'язка): `[deploy:hold]` + мітка. Кроки — runbook. В описі:
  - production заморожений від мерджу до bootstrap;
  - щоденне «out of date» старого таймера ігнорувати;
  - зміна `deploy/release/test_gates.py` (лише тест).

---

### Task 1: shim хелпера і шаблон репетиції

**Files:** нові `scripts/ops/rehearsal/wbb_image_rehearsal.py`, `scripts/ops/rehearsal/wbb-rehearsal.container`, `scripts/ops/rehearsal/test_wbb_image_rehearsal.py`; підключення Python-тесту туди, де вже ганяються тести хелпера.

- [x] Тести спершу (фейковий `Host`, як у `test_wbb_image.py`):
  - `activate` пише лише `/etc/containers/systemd/wbb-rehearsal.container` (шлях із `REHEARSAL`);
  - `current` питає `wbb-rehearsal`;
  - шаблон без `EnvironmentFile`, з підставним оточенням і preload-ом;
  - «хворий» digest дає `Exec=…exit(1)`, інший — ні;
  - жодне ім'я, шлях чи юніт не збігається з production (порівняння з `PRODUCTION` хелпера).
- [x] Реалізація за п.1.
- [x] Мутації: shim без підміни `UNIT` → тест «питає `wbb-rehearsal`»; шаблон з `EnvironmentFile` → тест шаблону.
- [x] Гейт, коміт.

### Task 2: `run.sh` — сценарії, P3, прибирання

**Files:** новий `scripts/ops/rehearsal/run.sh`, новий `scripts/ops/rehearsal-run.test.ts` (стаби sudo/systemctl/podman/контролера).

- [x] Тести спершу:
  - передумови п.4: кожна → відмова, нічого не створено;
  - порядок сценаріїв і точний підсумок для стабів, що відповідають «як очікується»;
  - сценарій, що повернув не те, → FAIL у підсумку, вихід 1;
  - kill на кожному кроці (INT посеред сценарію) → прибирання виконано: виклики `stop`/`rm`/`daemon-reload` у лозі стабів;
  - «production змінився» (стаб `current` production відрізняється до/після) → FAIL і гучний текст;
  - P3 — рядки з тривалістю з подій контролера.
- [x] Реалізація за п.2–4.
- [x] Мутації: прибирання без `trap INT` → тест kill; без перевірки production до/після → тест «production змінився».
- [x] Гейт, коміт.

### Task 3: `unit=` у статусі

**Files:** `scripts/ops/host_patch_collect.py` (+ його тести), `deploy/install-host-patch-collector.sh` (аргумент шляху `image-state.env` оператора, якщо потрібен), `src/jobs/host-patch.ts`, `src/jobs/daily-status.ts` (+ тести).

- [x] Тести спершу:
  - збирач для кожного з `quadlet/foreign/absent` дає точне поле `image`;
  - podman чи `image-state.env` нечитані → `null`;
  - бот: `quadlet` з однаковими digest-ами → `=`, з різними → `≠`, `foreign` → «flat (до перемикання)», без поля `image` (старий `summary.json`) → рядка нема.
- [x] Реалізація за п.5. Бот читає нове поле лише тоді, коли воно є (старий збирач — без нього).
- [x] Гейт, коміт.

### Task 4: preflight і runbook

**Files:** новий `scripts/ops/switchover-preflight.sh` (+ тест зі стабами), `deploy/README.md`.

- [ ] Тести спершу: кожна перевірка п.6 — PASS/FAIL зі стабом; підсумок і код виходу; preflight нічого не пише (дерево стану до/після однакове).
- [ ] Реалізація за п.6, runbook за п.7.
- [ ] Гейт, коміт.

---

## Після

- Наскрізне рев'ю обв'язки разом із ядром.
- Рібейс, гейт, PR В1 з `[deploy:hold]`.
- **Сеанс на хості** за runbook-ом: репетиція, P3, перенесення, інсталятори, bootstrap, увімкнення таймера.
- **В2** (окремий план після першого settled і кількох автоматичних деплоїв):
  - прибрати `ships.sh`, `rsync-filter`, `record-deployed.sh`;
  - прибрати `deploy/release/**`, перенісши збирач payload у `scripts/release/`;
  - прибрати `wbb-release` з хоста;
  - прибрати `/opt/warsaw-beer-bot`;
  - прибрати старі копії репо;
  - прибрати NOPASSWD rsync/chown/install;
  - прибрати flat-тексти README і `spec.md`.
- **«Фактично»** в оцінці спеки.
