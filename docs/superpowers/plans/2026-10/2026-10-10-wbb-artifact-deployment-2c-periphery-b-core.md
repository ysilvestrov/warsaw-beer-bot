# Artifact deployment — обв'язка 2в, етап Б (ядро): справжні адаптери хоста — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** дати tick-у (`tick.py`, етап А, [#827](https://github.com/ysilvestrov/warsaw-beer-bot/pull/827)) і рушію (`activate.py`, [#823](https://github.com/ysilvestrov/warsaw-beer-bot/pull/823)) справжні руки: `Host` і `Helpers`, що працюють через sudo, systemctl, HTTP `/health`, git, `gh`, `wbb_release.py`, `dbsnap.py`, і `make_env`, який їх збирає. Після цього етапу `tick.py timer` здатен відпрацювати на хості, щойно інсталятор (етап В) покладе файли й правила sudo. **Нічого не встановлюється й не активується в цьому PR.**

**Чому етап Б ділиться.** Повний етап Б — це адаптери плюс `/health.releaseSha` з `WBB_RELEASE_REQUIRED` (зміна застосунку, `[deploy:hold]`), обгортка `deploy.sh`, CLI `rearm`/`ack-baseline`, retention, міграція state v1→v2. Решта спирається на те, як адаптери називають команди, шляхи й коди. Тому:
- **Б-ядро** (цей план) — адаптери, `make_env`, повідомлення в Telegram, один годинник;
- **Б-периферія** (окремий план після рев'ю ядра) — `/health.releaseSha`, `deploy.sh`, `rearm`/`ack-baseline`, retention, міграція state.

**Tech Stack:** Python ≥3.12 stdlib (`subprocess` через `bounded.run`, `urllib`, `json`, `time`). Candidate-код не виконується.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md` §2 (control plane, шляхи), §7 (health, releaseSha), §10a.

## Вхідні дані

- Розділ «Після етапу А» плану `…/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md`: транспортний контракт `Helpers.trusted`, явна мапа встановлених копій, винятки `make_env` → 70, один годинник epoch, `TimeoutStartSec`, коди 3/4/70.
- Merge-deploy (`deploy/autodeploy.sh`) — джерело перевірених на хості способів: `sudo systemctl stop|start warsaw-beer-bot|litestream` (рядки sudoers уже є), `systemctl show -p NRestarts --value`, `curl --max-time 3 http://127.0.0.1:$API_PORT/health`, `API_PORT` і токени Telegram через `wbb-read-env` від користувача бота, DB-хелпери через `sudo -u warsaw-beer-bot bash -lc`, мітки PR через `gh api …/commits/<sha>/pulls`.
- Завантаження artifact від імені оператора вже перевірено гейтом G1 (Ядро-2а, VPS): run-scoped API, redirect на blob без креденшлів (`github_trust.GitHubApi.download`).

## Рішення

1. **Шляхи встановлення — константи одного модуля** (`installed.py`): мапа «файл репо → встановлений шлях» для кожної копії з `gates.INSTALLED_COPIES` (і перевірка, що кожен шаблон має хоча б одну мапу — тест). `deploy/release/*.py` і `payload-probe.cjs` ставляться у `/usr/local/lib/wbb-release/` (root:root, 0755/0644), без `test_*.py` і `fake_*.py`; CLI-обгортки — `/usr/local/libexec/wbb-release` (root helper, через sudo) і `/usr/local/bin/wbb-tick` (оператор). Сам інсталятор — етап В; тут лише константи, які він і адаптери читатимуть однаково.
2. **Root helper викликається лише як `sudo -n /usr/local/libexec/wbb-release <subcommand> …`** з фіксованими аргументами; `audit` — без sudo (оператор, спека §5). Коди: 0 → успіх; 1 → `Run` як є (вердикт вирішує caller); 2 → `Refused` (для `Host`) або `Run(2, …)` (для `Helpers`); 64/70/75, збій sudo (`sudo: a password is required` → 1 від sudo без нашого рядка вердикту) → `HostError`/`HelperError`. **Ключ:** код 1 без рядка вердикту — це не вердикт (sudo теж повертає 1).
3. **`/health`** — `urllib` до `http://127.0.0.1:<API_PORT>/health`, таймаут 3 с (merge-deploy), тіло ≤ 64 KiB, JSON: `ok is True` → `Health(True, releaseSha)`, де `releaseSha` — 40 hex або `None`, якщо поля нема (сьогоднішній застосунок). Будь-яка помилка з'єднання → `HostError` (рушій рахує це проваленою пробою). `API_PORT` читається один раз на tick.
4. **`nrestarts`** — `systemctl show -p NRestarts --value warsaw-beer-bot` без sudo, таймаут 5 с; не число → `None`.
5. **Один годинник:** і `Host.now()`, і `Env.clock` — `time.time()` одного процесу (epoch). Тест: `abort.at` і `Inputs.now` з одного джерела.
6. **Повідомлення** — Telegram `sendMessage` напряму (не через бота: якщо деплой його поклав, він не повідомить), токен і chat id через `wbb-read-env` від користувача бота, таймаут 10 с; `False` при будь-якій помилці, текст токена ніколи не потрапляє у вивід чи виняток.
7. **Порядок розгортання (обмеження для етапу В, записується тут):** рушій на `start-baseline` чекає `releaseSha == previous`. Тому перший settled реліз, на який колись відкочуватиметься рушій, **мусить уже віддавати `releaseSha`** — `/health.releaseSha` (Б-периферія) має опинитися в production до першої активації artifact-ом. Адаптер при `releaseSha=None` повертає `Health(ok, None)`, і рушій чесно вважає таку пробу невдалою.

## Таблиця «заявка → доказ» цього плану

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| `bot_state()` = inactive | Бот не пише | `systemctl show -p ActiveState --value` | сильний (контракт systemd) |
| `Health(ok, X)` | Процес, що слухає порт, прочитав реліз X при старті | Тіло `/health` з `releaseSha` (Б-периферія), читане з realpath (проба ядра 2в) | сильний після Б-периферії; до неї `None` |
| `current()` = X | `current` → `releases/X` | `publish.current_sha` (без root: читається symlink) | сильний |
| `verify(X)` → tree | Дерево X дорівнює receipt | `sudo wbb-release verify`, рядок `VERIFIED … tree <hex>` | сильний |
| Telegram sent | Повідомлення прийнято API | HTTP 200 і `"ok":true` у відповіді | сильний для «прийнято», не для «прочитано» |

## Global Constraints

- Усі зовнішні команди — через `bounded.run` з таймаутом і точним argv (без shell, крім `bash -lc` для правила `warsaw-beer-bot`, де argv передається позиційно, як у merge-deploy `_as_bot`).
- Жодне значення з GitHub чи з оточення не потрапляє в argv без валідації (SHA — 40 hex, ім'я знімка — регулярний вираз trial).
- Тести: фейковий `run` (функція, що записує argv і повертає `CompletedProcess`), фейковий HTTP (локальний `http.server` на 127.0.0.1 у тесті або інжектований opener). Мережі й sudo немає. `npm test -- <args>`; повний гейт кожної задачі — `npm test && npm run typecheck` під непривілейованим користувачем; нові файли — у `scripts/deploy-rsync.test.ts`. Правила тестів CLAUDE.md діють.

---

### Task 1: `installed.py` і `host_adapter.py` — справжній `Host`

**Files:** create `deploy/release/installed.py`, `deploy/release/host_adapter.py`, тести до обох.

- [ ] `installed.py`: константи шляхів (Рішення п.1) і мапа копій; тест, що кожен шаблон `gates.INSTALLED_COPIES` покритий мапою, і що жоден `test_*.py`/`fake_*.py` не входить у мапу.
- [ ] `RealHost` реалізує протокол `activate.Host` за Рішеннями п.2–6: точний argv кожного виклику, мапа кодів (0/2/інше), `Health` з тіла `/health` (з `releaseSha` і без), `nrestarts` (число / не число / збій), `boot_id`, `current` через `publish.current_sha` з production-коренями.
- [ ] Тести: argv дослівно для кожного методу; `sudo` з кодом 1 без рядка `SWITCHED|CURRENT` → `HostError`; `switch` з кодом 2 → `Refused`; `/health` 500, таймаут, не JSON, `ok:false`, без `releaseSha`, з невалідним `releaseSha` (не 40 hex → `None`).

### Task 2: `helpers_adapter.py` — справжні `Helpers`

**Files:** create `deploy/release/helpers_adapter.py`, `deploy/release/test_helpers_adapter.py`.

- [ ] git у приватному клоні (`~/.local/share/wbb-autodeploy/repo`, як merge-deploy): `fetch_main`, `is_ancestor` (невідомий коміт → False: `git cat-file -e` перед `merge-base`), `changed_paths` (`--no-renames`, `-c core.quotePath=false`), `commits`.
- [ ] GitHub: токен — `gh auth token` (оператор); `trusted` = `github_trust.fetch_trusted(GitHubApi(token), REPO, sha)` без перетворення `RunFailed`/`NoRunYet`; `download` — `GitHubApi.download` у приватну теку оператора (0700), ім'я з SHA; `pr_labels` — `gh api repos/…/commits/<sha>/pulls`.
- [ ] `wbb_release` через Рішення п.2 → `Run(code, kind, text, tree)` (розбір першого рядка, `tree <hex>`); `audit` без sudo.
- [ ] `snapshot_pre(sha)` — `wbb-db-snapshot snapshot <db> <dir>/<UTC>-<sha7>-pre.db` від користувача бота → `Pre`; `discard_pre`; `manifest(sha)` — читання `releases/<sha>/tree-manifest.json` (≤ ліміту `tree_manifest`); `installed_stale(patterns)` — порівняння байтів кожного файлу мапи з `origin/main` у клоні (`git show`), звіт або `None`.
- [ ] Тести: argv; розбір `Run` для кожного виду рядка; `RunFailed`/`NoRunYet` проходять наскрізь; збій `gh auth token` → `HelperError`; невідомий коміт → False; `installed_stale` з однаковими/різними/відсутніми файлами.

### Task 3: `make_env`, Telegram, CLI

**Files:** modify `deploy/release/tick.py` (`main` використовує `make_env` за замовчуванням), create `deploy/release/notify_telegram.py`, тести.

- [ ] `make_env(mode)` збирає `RealHost`, `RealHelpers`, `notify`, `clock=time.time`, `sleep=time.sleep`, теку стану (`~/.local/state/wbb-autodeploy`), `target` = `HEAD` робочого checkout для ручного запуску (передається CLI-аргументом `--target`, обгортка `deploy.sh` — Б-периферія).
- [ ] Будь-який виняток під час `make_env` → критичне повідомлення (якщо notify зібрався) і exit 70 — тест.
- [ ] `notify_telegram`: Рішення п.6; тест на локальному HTTP-сервері: 200/ok, 200/`ok:false`, 500, таймаут, відсутній токен; токен не з'являється у виводі.

### Task 4: документи

**Files:** modify `spec.md` §5.9, `deploy/README.md`, `scripts/deploy-rsync.test.ts`; план етапу В отримує список шляхів і правил sudo, які цей етап припускає (у розділі «Після»).

- [ ] Абзац у `spec.md` §5.9: які команди й від чийого імені виконують адаптери; обмеження п.7 (порядок `/health.releaseSha` перед першою активацією).

---

## Після Б-ядра

Наскрізне рев'ю адаптерів. Далі план Б-периферії: `/health.releaseSha` + `WBB_RELEASE_REQUIRED` (`[deploy:hold]`), обгортка `deploy.sh` (брудний checkout, `--target`, `--ack-holds`), `tick.py rearm` і `ack-baseline`, retention (pre, усі post, дерева з посилань), міграція state v1→v2 (засіяти `lastSeenSettled`/`regression`, settled-коміт у клоні), пропуск download/publish за наявного receipt і backoff транзієнтної підготовки. Етап В — інсталятор (шляхи з `installed.py`, sudoers для `wbb-release`, юніт з `TimeoutStartSec` ≥ 30 хв і `SuccessExitStatus`, користувач `wbb-trial`, legacy transition).

**Що Б-ядро припускає про хост — вхід для плану етапу В** (константи — `deploy/release/installed.py`; таблиця команд — `deploy/README.md`, «The real adapters»):
- Бібліотека `/usr/local/lib/wbb-release/` (root:root, 0755/0644): кожен файл `deploy/release/` за `installed.installed_path` — без `test_*`, `fake_*` і `release_testkit.py`; її ж читає користувач бота (`dbsnap.py` та його імпорти через `python3 -I -B`).
- `/usr/local/libexec/wbb-release` (root:root, 0755) — обгортка `wbb_release.py`; виконувана й оператором (`audit` іде без sudo). `/usr/local/bin/wbb-tick` — обгортка `tick.py` для оператора (юніт і `deploy.sh`).
- Нове sudo-правило: оператор → root, `NOPASSWD`, лише `/usr/local/libexec/wbb-release` з дієсловами `publish --sha * --archive *`, `verify --sha *`, `switch --sha *`, `probe --sha *`, `trial --sha * --snapshot *` (аргументи валідує сам хелпер; `*` у sudoers ловить і пробіли — тому окремий рядок на дієслово й жодного іншого шляху). Наявні правила, на які спираються адаптери без змін: `WBB_SYSTEMCTL` (`stop|start warsaw-beer-bot|litestream`) і `(warsaw-beer-bot) NOPASSWD: /usr/bin/bash -lc *`. Усі виклики — `sudo -n`: правило, якого нема, дає збій хоста, а не очікування пароля.
- Наявні копії merge-deploy, які адаптери викликають як є: `/usr/local/bin/wbb-db-snapshot` (pre-знімок, discard), `/usr/local/bin/wbb-read-env` (API_PORT, токен і чат Telegram). Теки: приватний клон `${XDG_DATA_HOME:-~/.local/share}/wbb-autodeploy/repo`, ZIP-и в `…/wbb-autodeploy/artifacts` (0700), стан і lock у `${XDG_STATE_HOME:-~/.local/state}/wbb-autodeploy` — юніт не має міняти XDG-змінні відносно merge-deploy.
- Оператор має читати symlink `/opt/warsaw-beer-bot/current` і `releases/<sha>/tree-manifest.json` (пошук у `/opt/warsaw-beer-bot` — перевірити права на хості).
- **Відкрите питання для В:** `installed_stale` читає встановлені копії від оператора, а `/etc/sudoers.d/*` — 0440 root:root, тобто нечитабельні: з мапою `deploy/sudoers.d/** → /etc/sudoers.d/` перевірка «не може оцінити» щодня й тримає таймер. Варіанти: ставити sudoers 0444 (перевірити `visudo -c` і поведінку sudo на хості — sudo вимагає лише «не писабельний іншими»?), або порівнювати sudoers через root-хелпер, або винести sudoers з мапи (тоді hold на шлях лишається, а installed-current його не бачить). Рішення — у спеці етапу В.

**Б-периферія успадковує від ядра:** `deploy.sh` мусить передати `tick.py deploy --target <HEAD>` (тепер обов'язковий, 40 hex); ZIP-и в `…/artifacts` накопичуються (до 257 MiB кожен) — retention; знімок, що впав на таймауті, може лишити `*.partial` бота — retention; `/health.releaseSha` (п.7 вище) — до першої активації.
