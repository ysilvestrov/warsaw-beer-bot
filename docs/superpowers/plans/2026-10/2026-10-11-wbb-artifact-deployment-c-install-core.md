# Artifact deployment — етап В, ядро: встановлення control plane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** покласти на хост усе, що потрібно tick-у й рушію, **не перемикаючи нічого**: бібліотеку `deploy/release` у `/usr/local/lib/wbb-release`, дві обгортки (`wbb-release` для root, `wbb-tick` для оператора), правила sudo для кожної дієслова root-хелпера, системного користувача `wbb-trial`, root-приватні каталоги receipts/trial і юніти tick-а — **вимкненими**. Після цього PR і кроку інсталятора merge-deploy працює як і раніше; перехід layout, міграція стану, звуження старих правил sudo й увімкнення таймера tick-а — окремий план «перехід» (спека §10), який пишеться після рев'ю цього ядра й звіту `finish` preflight-у.

Спека: `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md` §2 (control plane, layout, wbb-trial), §5 (installed infrastructure current), §10 (transition), §12 п.3. Вхід: розділи «Після Б-ядра» плану `…/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md` і «Після» плану `…/2026-10-10-wbb-artifact-deployment-2c-periphery-b2.md`.

**Tech Stack:** Python ≥3.12 stdlib (інсталятор і control plane), sh-обгортки, systemd, sudoers.

## Preflight (спека §9, §10) — що виміряно 11.10.2026

`wbb-preflight.sh start` + `extra` на production VPS (звіти в сесії, не в репо):

| Факт | Значення | Що з нього випливає |
|---|---|---|
| ОС / systemd / Python / sudo / Node | Ubuntu 24.04.4, systemd 255, Python 3.12.3, sudo 1.9.15p5, `/usr/bin/node` v24.21.0 | Усе, що припускали ядра 2а–2в, на місці; G2/G3 міряли той самий systemd |
| Диск `/` | 80 GB, вільно 45 GB; inodes 8 % | Поріг admission ≤10 GiB (§9) виконується з запасом; flat-дерево 127 MB (node_modules 111 MB), снапшот ~20 MB, клон оператора 259 MB |
| Шляхи даних у `.env` | `DATABASE_PATH`, `TRIAGE_LOG_DIR`, `BUG_REPORT_MEDIA_DIR` — усі в `/var/lib/warsaw-beer-bot` | Жоден запис застосунку не спрямований у `/opt` конфігом |
| Процес бота | cwd `/opt/warsaw-beer-bot`; відкриті на запис лише `bot.db`, `-wal`, `-shm` | Записів у дерево коду в момент проби немає. **Повна відповідь — звіт `finish` (≥24 год)**: він вхід для плану переходу, не цього ядра |
| `/etc/sudoers.d/*` | `root:root 0440`, оператор не бачить навіть списку | Відкрите питання Б-ядра закривається рішенням п.3 нижче |
| Ефективний sudo оператора | `(ALL : ALL) ALL` з паролем + NOPASSWD-правила merge-deploy, серед них `rsync --delete … /opt/warsaw-beer-bot/` | Див. «Після»: звуження правила не зупиняє старий `deploy.sh`, якщо людина введе пароль |
| `wbb-trial` | не існує | Створює інсталятор (п.4) |
| `/usr/local/lib/wbb-release` | не існує | Ставить інсталятор |
| Старі checkout-и з `deploy/deploy.sh` | `~/warsaw-beer-bot` (8705e8b), `~/warsaw-agy-bb` (deabec7) і його worktree `cluster-triage` (99992d9), `~/warsaw-bb-codex`, `~/wbb-sol-default` (коміти поза main), плюс чужий проєкт `48-hours-trip` | Вхід плану переходу |

## Рішення

1. **Нічого не перемикається.** Інсталятор не чіпає `/opt/warsaw-beer-bot` (там досі flat-дерево, і `rsync --delete --delete-excluded` merge-deploy знищив би будь-які `releases/`/`current` усередині), не вмикає й не вимикає жоден таймер, не змінює `/etc/sudoers.d/warsaw-beer-bot` і `.env`. `releases/`, `staging/`, увімкнення `wbb-tick.timer`, вимкнення `wbb-autodeploy.timer`, `WBB_RELEASE_REQUIRED=true` — план переходу.
2. **Інсталятор — Python stdlib** (`deploy/release/installer.py`), точка входу для людини — `deploy/install-release.sh` (`sudo bash deploy/install-release.sh`; шлях підпадає під `HUMAN_STEPS` `deploy/install-*.sh`). Запускається з **чистого** checkout-у (жодних змін у `git status --porcelain`), друкує `HEAD`; ідемпотентний; кожен файл пишеться в тимчасовий у тій самій теці (ім'я з крапкою — sudo такі ігнорує), `fchown 0:0`, `fchmod`, `fsync`, `rename`. Порядок — залежності першими (як `install-autodeploy.sh`, M2 #527): бібліотека → обгортки → sudoers → юніти → `daemon-reload`. Файли в `LIB_DIR`, яких репо більше не ставить, видаляються (та сама мапа, що й у `installed_stale._orphans`). Є режим `--check`: нічого не пише, друкує розбіжності (те саме порівняння, що робить tick).
3. **Встановлені копії, які оператор не може прочитати, звіряє root.** Новий дієслово root-хелпера `wbb-release digest --path <installed path>`: дозволено лише шлях, який `installed.installed_path` дає для якогось файлу репо **і** який лежить у `SUDOERS_DIR` (ім'я `[A-Za-z0-9_-]+`) або дорівнює `/etc/litestream.yml`; друкує `DIGEST <path> <sha256> uid <n> mode <octal>` або `ABSENT <path>`; `lstat` + `O_NOFOLLOW`, symlink → `REFUSED`. `installed_stale` на `EACCES` для такого призначення питає хелпер і порівнює sha256 із `git show origin/main:<path>`, власника 0 і відсутність group/other write — ту саму умову, що для читабельних копій. Права sudoers лишаються 0440 (`visudo` і рекомендація sudo), «не може оцінити» щодня зникає.
4. **`wbb-trial`**: `useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group wbb-trial`. Якщо користувач уже є — інсталятор перевіряє оболонку nologin, відсутність додаткових груп і що UID < `SYS_UID_MAX`; інакше відмова (не «виправляє» чужого користувача мовчки). Каталоги: `/var/lib/wbb-trial` `root:root 0755` (кожен прогін — свій `0700 wbb-trial`, `trial._scratch`), `/var/lib/wbb-deploy` і `…/receipts` `root:root 0700`, `/etc/wbb-deploy` `root:root 0700`. Токен `/etc/wbb-deploy/github.env` інсталятор **не створює** — лише перевіряє (`root`, `0600`, рівно один `WBB_GITHUB_TOKEN=`) і друкує, якщо його немає; без нього `publish` відмовить, а це потрібно лише переходу.
5. **Обгортки** (у репо — `deploy/wbb-release.sh`, `deploy/wbb-tick.sh`; мапа `installed.COPIES`):
   - `/usr/local/libexec/wbb-release` — `exec /usr/bin/python3 -I /usr/local/lib/wbb-release/wbb_release.py "$@"`; якщо файлу немає — повідомлення в stderr і **exit 70** (Python сам вийшов би з 2, а 2 у хелпера означає «відмова», рішення Б-ядра).
   - `/usr/local/bin/wbb-tick` — те саме для `tick.py`, без файлу — exit 71.
   - `-I`: без `PYTHONPATH`, user site і каталогу запуску в `sys.path`; модулі шукаються лише через `sys.path.insert(0, dirname(__file__))`, який уже є в кожному модулі.
6. **Збій імпорту не маскується під вердикт.** Python виходить з 1 при винятку на рівні модуля, а 1 — це «поганий кандидат» у `wbb_release` і «успіх» (`SuccessExitStatus=0 1 2`) у tick-а. Тож: `wbb_release.py` імпортує свої модулі в `try`, збій → traceback і **70**; `tick.py` — те саме, збій → **71** («не стартував, нікому не сказав»). `_start_failed` без notify теж повертає **71**, а не 70.
7. **Юніти tick-а** (`deploy/wbb-tick.service`, `deploy/wbb-tick.timer`, `deploy/wbb-tick-failed.service`), встановлені **вимкненими**:
   - service: `Type=oneshot`, `User=ysi`, `Environment=HOME=/home/ysi`, `ExecStart=/usr/local/bin/wbb-tick timer`, `TimeoutStartSec=30min` (рушій: стоп + старт + вікно спостереження не вкладаються в стандартні 90 с), `SuccessExitStatus=0 1 2`, `OnFailure=wbb-tick-failed.service`. **Без** `NoNewPrivileges` (tick працює через sudo), без жодного `Environment=*_proxy` (адаптер `/health` і так ігнорує проксі, але юніт не повинен їх вносити).
   - timer: копія розкладу `wbb-autodeploy.timer` (`OnActiveSec=5min`, `OnUnitActiveSec=5min`, `RandomizedDelaySec=60`, `Persistent=true`, коментар #798).
   - `wbb-tick-failed.service`: `Type=oneshot`, `User=ysi`, `ExecStart=/usr/local/libexec/wbb-tick-failed`, — bash, не Python (повідомити має й тоді, коли Python-бібліотека зламана): токен і chat id через `wbb-read-env` як користувач бота, `curl` до Bot API без проксі. Надсилає, **якщо tick сам не сказав**: `MONITOR_SERVICE_RESULT != exit-code` (timeout, signal, core) або `MONITOR_EXIT_STATUS ∈ {64, 71}` чи будь-який, якого tick не знає. 3/4/70 tick уже повідомив сам — їх не дублює. Раз на UTC-добу на текст (файл у `${XDG_STATE_HOME}/wbb-autodeploy/tick-failed-notice`).
8. **Sudoers** — новий файл `deploy/sudoers.d/wbb-release` (не правка `warsaw-beer-bot`), рядок на кожне використання адаптерами:
   ```
   ysi ALL=(root) NOPASSWD: /usr/local/libexec/wbb-release publish --sha * --archive *, \
       /usr/local/libexec/wbb-release verify --sha *, /usr/local/libexec/wbb-release switch --sha *, \
       /usr/local/libexec/wbb-release probe --sha *, /usr/local/libexec/wbb-release trial --sha * --snapshot *, \
       /usr/local/libexec/wbb-release digest --path *, \
       /usr/bin/systemctl stop warsaw-beer-bot, /usr/bin/systemctl start warsaw-beer-bot, \
       /usr/bin/systemctl stop litestream, /usr/bin/systemctl start litestream
   ```
   `*` у sudoers ловить і пробіли — тому межа довіри — сам хелпер (argparse відкидає зайві аргументи, `--sha` — повний SHA, `--snapshot` — ім'я, `--path` — п.3), а не шаблон. `audit` у файлі **немає** (працює без root, рішення 2б). systemctl stop/start дублюють рядки старого файлу навмисно: перехід зможе скоротити `warsaw-beer-bot` до maintenance-правил, не ламаючи tick. Перед `rename` — `visudo -cf <tmp>`; збій → відмова, старий файл лишається.

## Таблиця «заявка → доказ»

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| `installed_stale` = None | Кожна встановлена копія побайтно дорівнює `origin/main`, root-owned, закрита для запису group/other | Читабельні — `O_NOFOLLOW` + `fstat` від оператора; нечитабельні — `digest` від root (`lstat`, `O_NOFOLLOW`, sha256 того ж fd) | сильний |
| `DIGEST <path> …` | Root прочитав саме цей файл і порахував його sha256 | Шлях обмежено мапою репо + двома каталогами; symlink відкидається | сильний; хелпер не бачить репо, тож порівнює контролер |
| Інсталятор: «встановлено» | Файли на місці з правами п.2 | Повторне читання після `rename` + `--check` у кінці | сильний на момент установки; дрейф далі ловить `installed_stale` |
| `wbb-trial` придатний | nologin, без додаткових груп, системний UID | Перевірка інсталятора; ізоляцію в роботі доводить кожен `probe` (sandbox) | сильний |
| tick-юніт «вимкнений» | Нічого нового не деплоїть після цього PR | Інсталятор не викликає `enable`; `--check` друкує `is-enabled`; тест на відсутність `enable` у коді інсталятора | сильний |
| Повідомлення про збій tick-а | Кожен збій юніта, про який tick не сказав сам, доходить до адміна раз на добу | Таблиця `MONITOR_*` у `wbb-tick-failed`, тест на кожен рядок; Telegram «прийнято», не «прочитано» (як `notify_telegram`) | сильний для доставки в API |

## Global Constraints

- Python: `deploy/release/test_*.py` через наявний запуск (`scripts/release.test.ts` / `npm test`), stdlib only. Інсталятор тестується з **префіксом кореня** (усі абсолютні шляхи — від параметра `root`), без справжнього root: `chown` — ін'єктована функція, `useradd`/`visudo`/`systemctl` — ін'єктований runner (`fake_run`). Жодного тесту, що потребує sudo.
- Shell: `bash -n`, поведінкові тести `wbb-tick-failed` через підставлений `PATH` (фейкові `wbb-read-env`, `curl`), як у `scripts/deploy-*.test.ts`.
- `gates.INSTALLED_COPIES` і `installed.COPIES` доповнюються новими файлами; тест «кожен шаблон має хоча б одну мапу» (Б-ядро) ловить пропуск.
- Правила тестів CLAUDE.md; гейт `npm test && npm run typecheck` від `tester`.
- PR — `[deploy:hold]` + мітка: змінює `deploy/sudoers.d/**`, юніти, `deploy/release/**`, `deploy/install-*.sh`. Кроки для людини — у кінці плану.

---

### Task 1: обгортки, коди виходу при зламаному імпорті, мапа

**Files:** нові `deploy/wbb-release.sh`, `deploy/wbb-tick.sh`; `deploy/release/wbb_release.py`, `deploy/release/tick.py` (імпорти в `try`, `_start_failed` → 71, docstring кодів виходу); `deploy/release/installed.py` (`COPIES` += обидві обгортки й `deploy/wbb-tick-failed.sh → /usr/local/libexec/wbb-tick-failed`); `deploy/release/gates.py` (`INSTALLED_COPIES` += `deploy/wbb-*.sh`); тести `test_wbb_release.py`, `test_tick.py`, `test_installed.py`, новий `scripts/deploy-wrappers.test.ts` (або python-тест, що запускає sh).

- [ ] Тести спершу: (а) обгортка без цільового файлу → 70/71 і рядок у stderr, з файлом — передає argv і код виходу без змін (тимчасовий `LIB_DIR` через змінну лише в тесті? — **ні**: обгортка без параметрів; тест копіює її з підставленим шляхом через `sed` у temp, як `deploy-rsync.test.ts` робить із фільтром); (б) `wbb_release.main` з модулем, що падає на імпорті (subprocess із temp-копією, де один модуль — `raise ImportError`) → 70, не 1; (в) те саме для `tick.py` → 71; (г) `_start_failed` без notify → 71; (ґ) `installed_path('deploy/wbb-tick.sh') == '/usr/local/bin/wbb-tick'`.
- [ ] Реалізація; мутації: прибрати `try` навколо імпортів → тест (б)/(в) червоний; повернути 70 у `_start_failed` → (г) червоний.
- [ ] Гейт, коміт.

### Task 2: `wbb-release digest` і `installed_stale` через root

**Files:** `deploy/release/wbb_release.py` (дієслово `digest --path`), новий невеликий модуль або функція в `installed.py` (`digestable(path)` — п.3), `deploy/release/helpers_adapter.py` (`installed_stale`: `EACCES` → `_release('digest', …)`-подібний виклик без `--sha`), тести `test_wbb_release.py`, `test_helpers_adapter.py`, `test_installed.py`.

- [ ] Тести: `digest` для дозволеного шляху друкує рядок із sha256/uid/mode (temp-корінь, шлях-префікс як у тестах `publish`); відсутній → `ABSENT`, exit 0; symlink → `REFUSED`, 2; шлях поза мапою або з `..`/крапкою в імені → 2; `installed_stale`: нечитабельна копія (фейковий `os.open` → `EACCES`) з однаковим digest-ом → не stale; інший digest → stale; uid≠0 або mode із group-write → stale; хелпер вийшов 70/75 → `HelperError` («не може оцінити», не «свіжий»); читабельна копія хелпер **не** викликає.
- [ ] Реалізація; мутації: прийняти symlink; не перевіряти mode у гілці digest; викликати хелпер для всіх шляхів.
- [ ] Гейт, коміт.

### Task 3: sudoers, юніти, `wbb-tick-failed`

**Files:** нові `deploy/sudoers.d/wbb-release`, `deploy/wbb-tick.service`, `deploy/wbb-tick.timer`, `deploy/wbb-tick-failed.service`, `deploy/wbb-tick-failed.sh`; тест `deploy/release/test_host_units.py` (або `scripts/deploy-units.test.ts` — за звичаєм сусідніх тестів юнітів) і `scripts/deploy-tick-failed.test.ts`.

- [ ] Тести на текст: кожен виклик `sudo -n …` в `helpers_adapter.py`/`host_adapter.py` має рядок у `deploy/sudoers.d/wbb-release` (тест збирає дієслова з коду адаптерів, а не з копії списку); `audit` у файлі немає; жодного `ALL` у списку команд, жодного `bash`/`sh`; `visudo -cf`, **якщо** `visudo` є в системі — інакше крок не пропускається мовчки, а тест розбирає синтаксис власним мінімальним парсером рядків `Cmnd`. Юніт: `ExecStart`, `User`, `TimeoutStartSec=30min`, `SuccessExitStatus=0 1 2`, `OnFailure=wbb-tick-failed.service`, відсутність `NoNewPrivileges` і `proxy`; таймер збігається з `wbb-autodeploy.timer` у `[Timer]`.
- [ ] Поведінкові тести `wbb-tick-failed.sh` (фейкові `wbb-read-env`/`curl` у `PATH`, temp `XDG_STATE_HOME`): timeout → надсилає; exit 3 → ні; exit 71 → так; той самий текст удруге за добу → ні; `wbb-read-env` впав → exit ≠0 і рядок у stderr, без токена в argv/stdout.
- [ ] Реалізація; мутації: пропустити `MONITOR_SERVICE_RESULT`-гілку; прибрати дедуп.
- [ ] Гейт, коміт.

### Task 4: інсталятор

**Files:** новий `deploy/release/installer.py`, новий `deploy/install-release.sh`, тест `deploy/release/test_installer.py`.

- [ ] Тести з `root=<tmp>` і фейковими `run`/`chown`: (а) свіжа установка створює все з п.2/п.4 з правильними режимами, власником (записаним фейковим `chown`) і вмістом; (б) повтор — нуль змін, вихід 0; (в) orphan у `LIB_DIR` видаляється, а файл поза `LIB_DIR` (`/etc/...`) — ніколи; (г) `visudo` повернув ≠0 → старий sudoers-файл не змінено, відмова, юніти **не** встановлено (залежності першими: бібліотека й обгортки вже стоять, і це нормально); (ґ) брудний checkout → відмова до першого запису; (д) наявний `wbb-trial` з оболонкою `/bin/bash` → відмова; (е) у коді інсталятора немає `enable`/`disable`/`start`/`stop` (тест на виклики фейкового runner-а, не grep); (є) `--check` нічого не пише й повертає ≠0 на розбіжність; (ж) нічого не пишеться під `/opt`.
- [ ] `deploy/install-release.sh`: `cd` у корінь репо, перевірка root, `exec /usr/bin/python3 -I deploy/release/installer.py "$@"`.
- [ ] Реалізація; мутації: пропустити `visudo`; писати без тимчасового файлу; не видаляти orphan.
- [ ] Гейт, коміт.

### Task 5: документи

**Files:** `deploy/README.md` (розділ «Installing the release control plane»: що ставить `install-release.sh`, що свідомо **не** робить, `--check`), `spec.md` §5.9 (одне-два речення: control plane встановлено окремим кроком, таймер tick-а ще вимкнений), план переходу отримує вхід (розділ «Після» нижче), статус у шапці спеки.

- [ ] Текст; гейт; коміт.

## Кроки для людини (опис PR, `[deploy:hold]`)

1. На хості, у свіжому чистому клоні `main`: `sudo bash deploy/install-release.sh` → вивід `installed`; потім `sudo bash deploy/install-release.sh --check` → 0.
2. Покласти токен: `/etc/wbb-deploy/github.env` (`root:root 0600`, `WBB_GITHUB_TOKEN=<fine-grained, Actions: read на цей репо>`) — потрібен переходу, не цьому PR.
3. `bash deploy/deploy.sh` — знімає hold звичайним шляхом merge-deploy.

## Після: вхід для плану переходу

- **Старі checkout-и з `deploy.sh`.** Звуження NOPASSWD не захищає `releases/`: у оператора `(ALL) ALL` з паролем, і старий `deploy.sh` (`sudo rsync --delete --delete-excluded … ./ /opt/warsaw-beer-bot/`) після введення пароля знищить `releases/` і `current`. Огорожа, що діє на версії 8705e8b, deabec7 і поточну (виміряно читанням коду): вони відмовляють **до першого `sudo`**, коли `$STATE_DIR/state.env` існує, але не є звичайним файлом. Перехід, мігрувавши state у `deploy-state.json`, ставить на місце `state.env` каталог (з `README` усередині). Версії без цієї перевірки (99992d9 і старші) огорожа не зупиняє — їх перелічено в preflight; план переходу вимагає їх оновити або видалити до кроку, і `--check` інсталятора їх шукає.
- Звіт `finish` (≥24 год) — записи в `/opt` від бота, cron-ів і ops-команд.
- Retention (`staging/` ZIP-и, `.partial`, дерева, pre/posts), обгортка `deploy.sh` (`--target HEAD`, відмова на брудному checkout-і, `--ack-holds`), міграція `state.env` → `deploy-state.json` v2, legacy byte capture, перенесення flat-дерева, звуження `/etc/sudoers.d/warsaw-beer-bot` (без `rsync`/`chown -R /opt`), `WBB_RELEASE_REQUIRED=true`, перемикання таймерів.
