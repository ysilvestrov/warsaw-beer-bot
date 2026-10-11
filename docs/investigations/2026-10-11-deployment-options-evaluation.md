# Дослідження: найдешевший у підтримці спосіб деплою WBB

**Дата:** 2026-10-11 · **SHA дослідження:** `003f9c700385d49520a60aa3bfbfc396734ec577` (`origin/main`).
**Тип:** spike. Документ нічого не змінює ні в коді, ні на production, і не дозволяє реалізацію. Рішення ухвалює власник.
**Як оцінювати числа:** години активного часу власника — це **оцінки**, і там, де немає вимірів, так і написано. Рядки коду показують, скільки поверхні треба підтримувати. Вони не міряють зроблену роботу і не означають, що вона змарнована.

---

## 0. Коротко

**Рекомендація: варіант Б.** Перейти на OCI-образ у GHCR, запускати його через **Podman Quadlet** і перевіряти стандартною атестацією GitHub. Перевірену в production логіку merge-deploy (`deploy/autodeploy.sh`) зберегти й замінити в ній лише кроки збірки, активації та пробної міграції. Python control plane з `deploy/release/` (≈7,4 тис. рядків коду й ≈10,7 тис. рядків тестів) до production не доводити.

Причини:
1. **До прийнятого переходу у варіанті А лишається найважча частина.** Це перехід layout-у з legacy capture, міграція стану, звуження sudo, репетиція crash/reboot/rollback на окремій VM, exec-trace і перший реальний контакт 7,4 тис. рядків нового коду з хостом. Нічого з цього ще не запускалося.
2. **Кожен фікс control plane у варіанті А — це ручний крок на хості.** `deploy/release/**` і `.github/workflows/ci.yml` входять у `INSTALLED_COPIES`/`HUMAN_STEPS` (`deploy/release/gates.py:137-153`). Тож будь-яка правка контролера чи CI дає hold, і поки людина не встановить нову версію, app-деплої стоять. За останні 30 днів 7 із 10 PR з `deploy:hold` змінювали саму деплой-інфраструктуру.
3. **У варіанті Б стандартні інструменти забирають більшість власного коду,** а саме ту частину, яка стоїть між «CI зібрав» і «процес запущено»: довіру, ZIP/tar, receipt, публікацію, sandbox і layout. Специфіку WBB (гейти, знімок і відкат БД) вже реалізовано в коді, що працює в production.
4. **Проби в цій сесії не знайшли блокера для Б** (§4). Лишається кілька невідомих, які перевіряються лише на VPS. Їх перевіряє перший обмежений етап (§10).

---

## 1. Фактичний стан

### 1.1 Що змерджено

| PR | Дата | Що зроблено |
|---|---|---|
| [#812](https://github.com/ysilvestrov/warsaw-beer-bot/pull/812) | 08–09.10 | Ядро-1: job `package` у `ci.yml`, `release.json`, `tree-manifest.json`, перевірка розпакованого payload |
| [#815](https://github.com/ysilvestrov/warsaw-beer-bot/pull/815) | 09.10 | Ядро-2а: довіра до run/artifact, ZIP/tar, root-публікація, receipt |
| [#817](https://github.com/ysilvestrov/warsaw-beer-bot/pull/817) | 09.10 | Ядро-2б: host audit, sandbox `wbb-trial`, native probe, trial |
| [#823](https://github.com/ysilvestrov/warsaw-beer-bot/pull/823) | 09.10 | Ядро-2в: state v2, рушій активації й code+DB rollback, crash-матриця |
| [#827](https://github.com/ysilvestrov/warsaw-beer-bot/pull/827) | 10.10 | Обв'язка А: tick-контролер (гейти, підготовка, сповіщення) |
| [#828](https://github.com/ysilvestrov/warsaw-beer-bot/pull/828) | 10.10 | Б-ядро: справжні адаптери Host/Helpers, Telegram |
| [#829](https://github.com/ysilvestrov/warsaw-beer-bot/pull/829) | 10–11.10 | `/health.releaseSha`, `rearm`/`ack-baseline`, backoff |
| [#834](https://github.com/ysilvestrov/warsaw-beer-bot/pull/834) | 11.10, 14:36 UTC | `[deploy:hold]` етап В-ядро: інсталятор control plane, «нічого не перемикає»; +3068/−152 |

### 1.2 Що встановлено на VPS

**Доступу до хоста в цій сесії немає**, тож усе нижче взято з документів, а не перевірено.
- Шапка дизайну (до #834) каже: «На хості нічого не встановлено». Preflight від 11.10 у плані етапу В: `wbb-trial` не існує, `/usr/local/lib/wbb-release` не існує.
- Гейти G1/G2/G3 (завантаження artifact, systemd-sandbox, `ProtectProc=invisible`) на VPS **виміряли пробами**, але нічого не встановили.
- **Чи виконано кроки hold з #834 (`install-release.sh`, `deploy.sh`) — невідомо.** Від цього залежить, чи стоять зараз app-деплої (§10, крок 0).

### 1.3 Що реально використано й перевірено в production

- **Деплоїть і досі merge-deploy** (`deploy/autodeploy.sh` + `deploy.sh`, з 30.09, [#760](https://github.com/ysilvestrov/warsaw-beer-bot/pull/760)): `rsync` → `npm ci` → `build` → `prune` на VPS. Відкат коду в ньому знову запускає `deploy.sh` на старому checkout-і (`deploy/autodeploy.sh:677-679`), тобто **викликає `npm ci` з мережею під час відкату**. Саме цю слабкість і мав прибрати новий дизайн.
- CI **реально публікує артефакти**. Наприклад, run 38164477053: `wbb-release-003f9c7…-1`, 30,7 MB, `digest sha256:8738fce4…`, діє до 10.11. **Жоден споживач їх не читає.**
- `/health.releaseSha` уже в main, але flat-деплой не має `release.json`, тож у production там `null` (рішення плану Б2).
- Чи спрацьовував хоч раз відкат merge-deploy у production — **невідомо** (потрібні журнали хоста).

### 1.4 Що не завершено (дизайн §9–§11)

- План переходу (§10) ще не написано.
- Retention.
- Обгортка `deploy.sh`.
- Міграція `state.env` → v2.
- Legacy byte capture, перенесення flat-дерева в `releases/`/`current`.
- Звуження `/etc/sudoers.d/warsaw-beer-bot` і огорожа старих checkout-ів (їх на хості п'ять).
- `WBB_RELEASE_REQUIRED=true`, перемикання таймерів.
- Runbooks (`cd …/current`).
- Звіт preflight `finish` (≥24 год).
- **Репетиція rollback/reboot/crash на окремій Ubuntu 24.04 VM.**
- Exec-trace collector — нового коду ще немає.
- Сім пунктів host acceptance з §11.
- Перший settled baseline.

### 1.5 Обсяг (поверхня підтримки)

| Що | Рядків |
|---|---|
| `deploy/release/*` — код (27 файлів, Python + 1 `.cjs`) | **7 384** |
| `deploy/release/test_*`, фейки, testkit | **10 711** |
| Обгортки, юніти, sudoers етапу В | 357 |
| `src/release/identity.ts` + тест, `scripts/release.test.ts` | 100 + 96 + 186 |
| Job `package` у `ci.yml` | ≈60 |
| Дизайн 2026-10-08 + 8 планів | 332 + 952 |
| *Для порівняння:* merge-deploy, що працює (bash) | 1 618 |
| *Для порівняння:* `scripts/autodeploy` TS — код / тести | 742 / 4 342 |
| *Для порівняння:* `deploy/README.md` | 834 |

Самі найбільші модулі: `tick.py` 986, `activate.py` 616, `installer.py` 534, `deploy_state.py` 442, `helpers_adapter.py` 387, `gates.py` 361.

**Історія ремонтів того, що вже працює.** Bash-деплоєр за 7 тижнів (16.08–07.10) мав щонайменше 10 bug-issue:
- [#470](https://github.com/ysilvestrov/warsaw-beer-bot/issues/470), [#473](https://github.com/ysilvestrov/warsaw-beer-bot/issues/473), [#490](https://github.com/ysilvestrov/warsaw-beer-bot/issues/490), [#491](https://github.com/ysilvestrov/warsaw-beer-bot/issues/491), [#497](https://github.com/ysilvestrov/warsaw-beer-bot/issues/497);
- [#498](https://github.com/ysilvestrov/warsaw-beer-bot/issues/498), [#499](https://github.com/ysilvestrov/warsaw-beer-bot/issues/499), [#527](https://github.com/ysilvestrov/warsaw-beer-bot/issues/527), [#767](https://github.com/ysilvestrov/warsaw-beer-bot/issues/767), [#768](https://github.com/ysilvestrov/warsaw-beer-bot/issues/768), [#798](https://github.com/ysilvestrov/warsaw-beer-bot/issues/798).

Ще за 30 днів до 11.10: 137 змерджених PR, з них 10 із `deploy:hold`, і 7 із цих 10 — сама деплой-інфраструктура. Це єдині реальні дані про частоту. На них спирається §6. Нових частот я не вигадую.

---

## 2. Гарантії окремо від механізмів

«Чинна» — це те, що діє в production зараз (merge-deploy). «Дизайн» — те, що додав прийнятий дизайн 2026-10-08 і чого в production ще немає.

| Вимога | Яку проблему вирішує | Доказ потреби | Чи обов'язково зберігати | Стандартний спосіб |
|---|---|---|---|---|
| Без збірки й `npm ci` на VPS | Деплой і **відкат** залежать від npm-реєстру й компілятора на prod; native-збірка на хості | `autodeploy.sh:677-679` (відкат через `deploy.sh`), мета дизайну §0 | **Так**: відкат без мережі — ключова мета | Образ, зібраний у CI; `podman pull` за digest; запуск із локального сховища |
| Походження й ідентичність релізу | Не запустити чужий, PR- чи fork-код; знати, який SHA працює | Дизайн §4, §10a; публічний репо | **Так** | `actions/attest-build-provenance` + `gh attestation verify oci://… --signer-workflow --source-digest --source-ref --deny-self-hosted-runners`; label `org.opencontainers.image.revision`; `/health.releaseSha` |
| Жодних prod-секретів у CI | Компрометація CI не дає Telegram/R2/OAuth | Дизайн §2 | **Так** | Pull-модель: секрети лише в `/etc/warsaw-beer-bot/.env` на хості, `EnvironmentFile=` |
| Pull-деплой без SSH із CI | CI не має доступу до хоста | Дизайн §2, чинний таймер | **Так** | Таймер на хості тягне образ із GHCR. Варіант без жодного коду — `podman auto-update`, але він не має гейтів WBB, тож лишається власний tick |
| Holds, quiet main, failed-SHA, rearm, regression fence | Мердж = деплой; людина має зупинити те, що потребує root або preflight | `CLAUDE.md`, #767/#768, #498 | **Так**, це політика WBB | Стандарту немає. Лишається **чинний** `autodeploy.sh`, а не його Python-переписування |
| Trial міграції | Міграція падає або ламає цілісність до зупинки prod | merge-deploy, `trial-migrate.cjs` | **Так**: дешево й ловить реальні класи | `podman run --network=none --read-only --cap-drop=ALL` з копією знімка; секрети не монтуються |
| 10-хвилинне спостереження | Падіння після старту → автоматичний відкат | merge-deploy | **Так** | Лишається чинна логіка health/NRestarts, плюс звірка `releaseSha` |
| Автоматичний відкат коду разом із БД | Нова міграція чи запис ламає стару версію | merge-deploy, дизайн §8 | **Так, поки не ухвалено §5** | Код: попередній digest локально (`Pull=never`). БД: чинний `db-snapshot.sh` |
| Відновлення після падіння контролера чи reboot | Деплой обірвався посередині | дизайн §10b (11 фаз, `boot_id`) | Саму потребу — **так**; дизайн §10b — це механізм | Активація стає двома ідемпотентними кроками (retag + `systemctl restart`); стан відкату БД лишається таким, як у merge-deploy (R2) |
| Пропуск деплою за однакового payload | Документація не рестартить бот | дизайн §10a «noop» | Бажано | Чинний `ships.sh` (класифікатор шляхів) уже це робить; додатково можна порівнювати digest образів |
| Перевірка встановлених інфраструктурних файлів | Змерджений фікс деплоєра не діє, поки його не встановлено | #461, `installed_stale` | **Так** | `ansible-playbook --check --diff` (проба: ловить drift режиму) плюс чинний `installed_is_stale` для копій деплоєра |
| Host audit перед активацією | Advisory, що з'явилися після CI | дизайн §5 | Так, як у чинному | Чинний аудит у клоні того самого SHA (`autodeploy.sh:86`), щоденний `prod-audit.yml` |

**Що з дизайну — механізм, а не вимога:** Python замість bash; root-receipt; ZIP/tar caps і TOCTOU-публікація (з'являються лише тому, що артефакт — ZIP з Actions); `wbb-trial` як окремий користувач; layout `releases/`/`current`; legacy byte capture (потрібна лише тому, що перехід переносить flat-дерево); exec-trace як доказ «не збирали на хості» (у контейнерному варіанті npm на шляху деплою немає зовсім).

---

## 3. Три варіанти

### А. Завершити поточний deployer

- **Стандартний інструмент робить:** майже нічого. systemd, sudo, `tarfile` stdlib.
- **Лишається власного коду:** усі 7,4 тис. рядків коду й 10,7 тис. рядків тестів, плюс код переходу, retention і exec-trace (ще не написані). Merge-deploy видаляється після переходу.
- **Нові обов'язки:**
  - root-control plane з власним інсталятором;
  - fine-grained токен `/etc/wbb-deploy/github.env`, у якого спливає термін;
  - окрема VM для репетицій;
  - hold-крок на кожну зміну `deploy/release/**` і `ci.yml`, зокрема на Dependabot-бампи actions;
  - Node-контракт: зміна major — окремий reviewed процес; хостовий Node автоматично оновлюється (#469), і native probe ловить це.
- **Гарантії:** усі з дизайну, найсильніший набір. Але жодна з них ще не працювала на хості.

### Б. OCI-образ + GHCR + Podman Quadlet (рекомендовано)

**Podman Quadlet чи Docker Compose — обираю Podman Quadlet:**

| Критерій | Podman Quadlet | Docker Compose |
|---|---|---|
| Пакет на Ubuntu 24.04 | `podman` 4.9.3 з archive (перевірено `apt` у цій сесії); оновлює вже налаштований unattended-upgrades | `docker.io` або окремий репо Docker CE; постійний `dockerd` + `containerd` |
| Інтеграція з systemd | Юніт **той самий** `warsaw-beer-bot.service` (generator). Тож `sudo systemctl stop/start warsaw-beer-bot`, `NRestarts`, `OnFailure`, sudoers лишаються як є | Друга система життєвого циклу (restart policies) поверх systemd. Health і `NRestarts` з autodeploy довелося б переписати |
| Зупинити старий → запустити новий | `systemctl restart` одного юніта: стоп, потім старт | Перевірено: `compose up -d` зупиняє старий (чекає graceful exit 3 с), тоді стартує новий |
| Що ще в системі | Litestream, таймери, cloudflared уже systemd | Те саме, але Compose керував би лише ботом |

Compose не дає цьому VPS нічого, чого не дає systemd, і додає демон.

- **Стандартні інструменти роблять:**
  - збирають і публікують образ: `docker/build-push-action`;
  - підписують походження: `actions/attest-build-provenance` з `push-to-registry`;
  - перевіряють походження: `gh attestation verify oci://…`;
  - зберігають і перевіряють шари за digest: containers-storage;
  - ізолюють trial: `--network=none --read-only --cap-drop=ALL --user --memory --pids-limit`;
  - керують процесом: Quadlet;
  - налаштовують хост: Ansible `-c local` на самому VPS, без SSH із CI.
- **Лишається власного коду (оцінка):**
  - `Dockerfile` ≈40;
  - CI job ≈50;
  - заміна трьох seam-ів у `autodeploy.sh` (`BUILD_CMD` → pull+verify, `DEPLOY_CMD` → retag+restart, `TRIAL_CMD` → `podman run`) ≈100–150 bash плюс тести;
  - обгортка ops-команд `wbb-ops` ≈20;
  - playbook ≈150 YAML.
  - Разом ≈350–450 рядків замість 7,4 тис.
  - Без змін лишаються `autodeploy.sh`, `ships.sh`, `db-snapshot.sh`, `trial-migrate.cjs` (тепер усередині образу), `src/release/identity.ts`.
- **Нові залежності й обов'язки:**
  - Podman;
  - GHCR (для публічних пакетів безкоштовний);
  - доступність Sigstore TUF і GitHub API з VPS;
  - **оновлення Node і base-образу перестають бути автоматичними через unattended-upgrades.** Потрібні Dependabot `docker` (digest у `FROM`) і merge — або щотижневий rebuild;
  - prune старих образів;
  - базове знання Quadlet.
- **Гарантії:** більшість зберігається. Зміни — у §8.

### В. Host Node/systemd + стандартна доставка

- **Стандартні інструменти роблять:** атестують tarball (`attest-build-provenance` на `runtime.tar.gz`) і перевіряють його (`gh attestation verify <файл>`). Встановлення — `.deb` (dpkg веде інвентар, `--allow-downgrades` для відкату) або ≈50 рядків «розпакувати в `releases/<sha>`, symlink, restart». Хост — через Ansible.
- **Лишається власного коду:**
  - CI-частина Ядра-1: `package_runtime.py`, `tree_manifest.py`, `safe_tar.py`, `verify_payload.py`, `payload-probe.cjs` — ≈900 рядків;
  - native probe на хості при кожному релізі: хостовий Node ≠ CI Node patch, і unattended-upgrades змінює його під працюючим релізом;
  - sandbox для trial: `systemd-run` з `DynamicUser=yes` замість користувача `wbb-trial`;
  - завантаження tar з Actions (fine-grained токен) або публікація як release asset;
  - `autodeploy.sh` з тими самими seam-ами.
  - Разом ≈1,2–1,8 тис. рядків.
- **Обов'язки:** сумісність native-модулів із хостовим Node лишається назавжди. `.deb` вносить maintainer-скрипти, які запускаються від root. Тобто В — це «Б без контейнера», але з більшою частиною власного коду.
- **Гарантії:** як у Б, плюс ризик drift-у Node на хості.

---

## 4. Проби

Середовище: контейнер Ubuntu 24.04, Docker 29.8 (запущений тут демон), Podman 4.9.3 з archive Ubuntu, Litestream v0.3.13, ansible-core. Образ зібрано з `git archive 003f9c7`. Dockerfile проби — у додатку. Паралельну систему не будував: кожна проба відповідає на одне питання.

| # | Питання | Критерій успіху | Результат |
|---|---|---|---|
| P1 | Чи збирається Node 24 + `better-sqlite3` 13 в образі? | Образ зібрано; native-модуль відкриває БД | **Так.** Збірка 1 хв 38 с; образ 140 MB (стиснений вміст), на диску 642 MB разом із base 332 MB. **Знахідка:** `better-sqlite3` 13 компілюється з джерел (`node-gyp`), бо на `-slim` нема python/g++. Build-stage мусить бути `node:24-bookworm`, runtime — `-slim`. **Знахідка:** анонімний Docker Hub дав `429 Too Many Requests` — base треба пінити digest-ом і тягнути з дзеркала (`mirror.gcr.io`) або GHCR |
| P2 | Чи працюють assets і всі ops-команди з образу? | `/health`, `/fest-print`, бібліотека; 10 команд з allowlist резолвляться і доходять до своєї логіки | **Так.** `/health` 200, `/fest-print` 200 (9 381 B), `niimbluelib.min.js` 200 (120 008 B). 9/10 команд відпрацювали (usage або dry-run проти БД). **`cluster-triage` потребує `gh` CLI** (`/bin/sh: gh: not found`) — це операторський інструмент, і він має лишитися на хості в checkout-і, а не в образі. `npm run` у контейнері потребує `HOME=/tmp` |
| P3 | Чи працює застосунок із read-only кодом і даними поза образом? | Старт до мережі, `release.json` читається, БД створюється у volume | **Так.** `--read-only --tmpfs /tmp --cap-drop ALL`: `releaseSha` = `003f9c7…` за `WBB_RELEASE_REQUIRED=true`, `migrate()` і всі 5 стартових backfill-ів пройшли. Процес завершився на `getaddrinfo api.telegram.org` (`--network none`). Поведінка та сама, що на хості без мережі, з контейнером не пов'язана. Записів у дерево коду за старт і ops-команди нема — інакше read-only дав би `EROFS`. 24-годинного циклу крон-задач це **не** покриває |
| P4 | Чи працює trial без мережі, секретів і живої БД? | `TRIAL OK` на копії; немає `.env`, data-шляху, токенів | **Так.** `--network none --read-only --memory 768m --pids-limit 64 --user 10001`: `TRIAL OK: schema 47 -> 47`, 0,4 с. Навмисно зіпсована копія (видалені рядки `schema_version`) → `TRIAL FAILED: duplicate column name`. Усередині: нема `/etc/warsaw-beer-bot/.env`, нема `/var/lib/warsaw-beer-bot`, 0 змінних `*TOKEN` |
| P5 | Чи сумісні права файлів із SQLite і Litestream на хості? | Хостовий Litestream під тим самим UID реплікує WAL, який пише контейнер; restore цілий | **Так.** Контейнер `--user 10001` записав 589 рядків за 12 с. Хостовий `litestream replicate` під UID 10001 без помилок, `restore` → 589 рядків, `integrity_check = ok`. Умова: **UID у контейнері = UID `warsaw-beer-bot` на хості** |
| P6 | Старий процес зупиняється до запуску нового? | Порядок `SIGTERM → EXIT → START` | **Так (Compose).** `A SIGTERM 19:39:50.323 → A EXIT 19:39:53.324 → B START 19:39:53.625`. Quadlet: один `warsaw-beer-bot.service`, `ExecStart=podman run --replace --name=warsaw-beer-bot …`. Генератор перевірено, `systemctl restart` під справжнім systemd — **ні** (§9) |
| P7 | Чи можна відкотитися до локального попереднього образу без registry? | Старт старого образу з `--pull never` | **Так.** Перехід B→A з `--pull never`. Образ за digest (`node@sha256:d6aa…`) з `--pull never --network none` стартує. Podman: образ із `docker save` → `podman load` → `--pull never` працює; без `--pull never` Podman пробує мережу й падає закрито |
| P8 | Як перевірити SHA саме запущеного процесу? | Збіг трьох джерел | **Так.** `inspect` контейнера дає `.Image = sha256:dd40d5…` (= ID образу) і label `revision = 003f9c7…`; процес друкує `releaseSha` у лог і `/health`. Найсильніша звірка: `/health.releaseSha` == SHA кандидата, а ID образу контейнера == прийнятий digest |
| P9 | Quadlet на Podman 4.9 (версія VPS) | Генератор приймає потрібні ключі | **Так.** `quadlet -dryrun` згенерував `ExecStart=… --read-only --user=999:999 --cap-drop=all --security-opt=no-new-privileges --env-file … --pull never …@sha256:…`, `Type=notify`, `KillMode=mixed`. **Обмеження 4.9:** нема `Notify=healthy` (з'явився пізніше) — юніт стає active на старті контейнера, а не на health. Для WBB це не важливо: health і так перевіряє контролер |
| P10 | Атестація: чи можна на поточному плані перевірити digest, repo, workflow, SHA? | `gh attestation verify` з прапорцями | **Частково.** За документацією attestations доступні для **публічних** репо на всіх поточних планах; репо публічне. `gh` 2.89 має `--repo`, `--signer-workflow`, `--source-digest`, `--source-ref`, `--deny-self-hosted-runners`, `--bundle-from-oci`. **Живу перевірку виконати не вдалося:** мережева політика цієї сесії блокує `tuf-repo-cdn.sigstore.dev` («no valid Sigstore verifiers»). Це перша проба на VPS (§10) |
| P11 | Яку частину інсталятора замінює декларативний опис? | Та сама операція — 4 дії | **Більшість.** ≈25 рядків Ansible: system user `nologin`, тека `0700`, sudoers з `validate: visudo -cf %s`, unit, `daemon_reload` (тут недоступний: немає systemd як PID 1). Повтор: `changed=0`. Drift `chmod 0644` → `--check` показав `changed=1`. Зламаний sudoers → `failed to validate`, живий файл побайтно незмінний |

**P10 — що атестація не замінює:**
- exact-SHA `ci=success` (атестація лише каже, що job підпису дійшов до кроку `attest`);
- holds, quiet main, failed-SHA, regression fence, ancestry;
- аудит advisories на момент деплою;
- trial і health window.

Тому `autodeploy.sh` лишається.

**P11 — що лишається власним, якщо замінити `installer.py` (534 рядки) на Ansible:**
- **відмова** замість виправлення чужого `wbb-trial` (Ansible конвергує стан, тобто «виправить» оболонку). У Б цей користувач не потрібен;
- перевірка symlink-ів у батьківських теках (Ansible її не робить);
- «встановлювати лише git-об'єкти HEAD чистого checkout-у» — один `assert` на `git status --porcelain`;
- видалення файлів, яких репо вже не ставить (`find` + `file state=absent`).

Тобто ≈30 рядків YAML замість ≈500 Python.

---

## 5. Ціна автоматичного відкату БД

### 5.1 Факти з коду

- `migrate()` (`src/storage/schema.ts:1042`) **мовчки нічого не робить**, якщо версія БД новіша за ту, яку знає код. Отже, старий код **стартує** на мігрованій БД. Нижче — чи працює він там правильно.
- 47 міграцій. Класифікація за SQL:
  - **37 суто адитивні:** `CREATE TABLE` / `ADD COLUMN` / `INDEX`;
  - **5 перейменовують або перебудовують таблиці:** v20, v24, v33, v41, v44 — старий код ламається одразу;
  - **5 переписують дані:** v7, v22, v31, v36 (тригер), v46;
  - тобто **10 з 47 (21%)** не є чисто адитивними. Проєкт живе з 22.04 (≈6 місяців), отже приблизно **1,7 таких міграції на місяць**.
- П'ять стартових backfill-ів (`src/index.ts:99-103`) запускаються на **кожному** старті й ідемпотентні: рядки, записані старим кодом, вони «долікують» при наступному старті нового.
- Маркери зовнішніх побічних ефектів живуть **у БД**:
  - `job_state.extension_announced_version` (`src/jobs/announce-release.ts:127-196`) — розсилка анонсів власникам токенів;
  - `enrich_failures.issue_number` — GitHub issues від orphan-triage.

### 5.2 Коли попередній код працює з новою БД

**Схема:** лише тоді, коли міграції діапазону суто адитивні **і** нові `NOT NULL`-колонки мають `DEFAULT`, а нові `CHECK` не забороняють значень, які пише старий код.

**Дані — небезпечніше за схему:**
- **v22.** Старий код вставляє `beers` без `untappd_id_source`. Після повторного відкату вперед `migrate()` уже не повторить backfill, і нові рядки читаються як «машинні, перезаписувані». Це той самий тихий відкат #343, про який попереджає коментар міграції.
- **Тригер v36** працює і на записах старого коду.

Висновок: сумісність SQL-схеми **не** доводить безпеку відкату лише коду.

### 5.3 Що справді потребує відновлення snapshot

- Перейменування й перебудови таблиць (бо старий код падає).
- Міграції, які змінюють сенс наявних значень (v24 — перейменування класу вердикту, v46 — канонізація).
- Нові інваріанти, які забезпечує лише одноразовий backfill у міграції (v22, v23).

### 5.4 Чи можна перевіряти сумісність попереднього релізу з мігрованою копією

Так, і в Б це дешево:

```
podman run --network=none --read-only <prev-digest> \
  node smoke.cjs <копія після trial>
```

Smoke відкриває БД, проганяє read-шляхи `/match`, `/beers` і робить запис у тимчасову таблицю.

- **Оцінка:** 1 скрипт ≈100–200 рядків і корпус запитів.
- **Чого це не ловить:** семантичних розбіжностей даних (v22) і побічних ефектів.

### 5.5 Що потребує політика expand/contract

- Правило в `CLAUDE.md` і чек у CI: міграція з `RENAME`/`DROP`/rebuild/`UPDATE` мусить мати мітку `migration:contract` і `[deploy:hold]`.
- Перейменування розбивається на два релізи: додати → писати в обидва → прибрати.
- Одноразові backfill-и, від яких залежить інваріант, переносяться в ідемпотентні стартові.

**Оцінка:** 1 PR на правило й чек плюс постійна дисципліна. Близько 1,7 міграції на місяць стають двоетапними, тобто +1 PR на кожну.

### 5.6 Код recovery, який можна прибрати лише після зміни політики

- Збереження post / відновлення pre: `db-snapshot.sh restore`, `dbsnap.py`.
- Зупинка Litestream перед заміною БД.
- Фази `rollback pending / save post / restore pre` у стані.

У Б без зміни політики цей код **лишається** — це чинний `db-snapshot.sh`.

### 5.7 Два контракти

| | 1. Автоматичний code+DB rollback (чинний) | 2. Сумісні — лише код; небезпечні міграції під hold |
|---|---|---|
| Втрата даних при відкаті | Записи вікна (≤10 хв) переходять у `post`, автоматичного злиття немає | Немає для сумісних |
| Побічні ефекти | **Відкат БД може їх повторити:** анонс релізу (маркер повертається до старого), повторний GitHub issue (зникає `issue_number`) | Не повторюються |
| Тихе псування даних | Ні | **Так**, якщо класифікація помилкова (v22) |
| Потреба людини | Лише на відкаті | Hold на ≈1,7 міграції на місяць (зараз частина з них і так іде з hold) |
| Код | `db-snapshot.sh` + стан відкату (вже в prod) | Плюс класифікатор міграцій, smoke попереднього релізу, правило expand/contract |
| Що прибирається | — | Нічого з recovery не можна прибрати, доки бодай одна міграція може бути небезпечною |

**Рекомендація:** **лишити контракт 1** в обох варіантах. Він уже працює і в Б нічого не коштує. Контракт 2 — окреме рішення (§8, п.8). Окремо варто виправити повтор побічних ефектів при відкаті БД: це дефект і чинного контракту, незалежно від варіанта.

---

## 6. Майбутня вартість підтримки

Припущення:
- Власник працює через агентів: агент пише PR, власник рев'юїть, мерджить і виконує кроки на хості.
- «Активний час» — це лише хвилини власника, без CI і агентів.
- Усі числа — **оцінка** з наведених фактів (розмір PR, кількість hold-кроків, історія issue).

### 6.1 Сценарії

**А — завершений deployer:**

| Сценарій | Дії оператора | Власний код для зміни | Перевірки | Активний час | Невизначеність |
|---|---|---|---|---|---|
| Звичайний реліз | Нічого | — | Авто: CI, trial, вікно | 0 | Низька після shakedown |
| Оновлення Node/native | Major: reviewed platform contract + hold | `package_runtime`, probe, `installed`, spec | Native probe, trial | 2–4 год | Середня |
| Термінове security-оновлення | Merge; якщо зачіпає `deploy/release` — hold-крок | Залежить від місця | Host audit | 0,2–1 год | Середня |
| Невдалий старт / rollback | Прочитати сповіщення, evidence | — | Авто code+DB rollback | 0,3–1 год | Середня: код відкату ще не працював у prod |
| Reboot посеред деплою | Прочитати стан v2, можливо `ack-baseline` | — | Матриця §10b | 0,5–2 год | Висока: 11 фаз × 4 точки, лише unit-тести |
| Недоступний GitHub | Чекати; відкат локальний | — | — | 0–0,3 год | Низька |
| Прострочений токен / нема artifact | Новий fine-grained токен у `/etc/wbb-deploy`; re-run CI | — | — | 0,3–1 год | Середня: токен спливає за політикою GitHub |
| Переповнений диск | Retention (ще не написаний) | retention | Admission 10 GiB | 0,5–2 год | Висока |
| Чистий VPS | Інсталятор + перехід + legacy + токен + `wbb-trial` | — | Acceptance §11 | 4–8 год | Висока |
| Діагностика через кілька місяців | Читати 7,4 тис. рядків, стан v2, receipts | — | — | 1–4 год | Висока |

**Б — образ + Podman Quadlet:**

| Сценарій | Дії оператора | Власний код для зміни | Перевірки | Активний час | Невизначеність |
|---|---|---|---|---|---|
| Звичайний реліз | Нічого | — | CI, attestation, trial, вікно | 0 | Низька |
| Оновлення Node/native | Merge Dependabot-PR base digest | `Dockerfile` (1 рядок) | Збірка, smoke у CI | 0,1–0,3 год | Низька: runtime = CI |
| Термінове security-оновлення | Merge; rebuild образу | — | CI audit + аудит у клоні | 0,1–0,5 год | Низька |
| Невдалий старт / rollback | Прочитати сповіщення | — | Авто: retag попереднього digest + `db-snapshot` | 0,2–0,7 год | Низька: retag тривіальний, DB-частина вже є в prod |
| Reboot посеред деплою | Перевірити, який digest під `wbb:current` | — | Ідемпотентний retag/restart | 0,2–1 год | Середня (R2 як сьогодні) |
| Недоступний GitHub/registry | Чекати; відкат з локального сховища | — | — | 0–0,3 год | Низька (P7) |
| Прострочений токен / нема artifact | Публічний GHCR — токен на pull не потрібен; `gh` оператора для атестації | — | — | 0–0,5 год | Низька |
| Переповнений диск | `podman image prune` (зберігати N за label) | 1 команда в tick | `df` перед pull | 0,1–0,5 год | Низька |
| Чистий VPS | `apt install ansible-core` + playbook + `.env` + знімок БД | — | `--check` = 0 | 1–3 год | Середня |
| Діагностика через кілька місяців | `systemctl status`, `podman ps/inspect`, журнал; `autodeploy.sh` уже знайомий | — | — | 0,5–1,5 год | Низька–середня |

**В — host Node + атестований tar:**

| Сценарій | Дії оператора | Власний код для зміни | Перевірки | Активний час | Невизначеність |
|---|---|---|---|---|---|
| Звичайний реліз | Нічого | — | Як Б + native probe | 0 | Низька |
| Оновлення Node/native | Major: синхронізувати nodesource і CI | probe, CI | Native probe | 1–3 год | Середня |
| Термінове security-оновлення | Merge | — | Аудит | 0,1–0,5 год | Низька |
| Невдалий старт / rollback | Як Б, symlink | — | — | 0,2–0,7 год | Низька–середня |
| Reboot посеред деплою | Перевірити symlink | — | — | 0,2–1 год | Середня |
| Недоступний GitHub | Чекати | — | — | 0–0,3 год | Низька |
| Прострочений токен / нема artifact | Токен Actions або release asset | — | — | 0,3–1 год | Середня |
| Переповнений диск | Retention тек | retention | — | 0,3–1 год | Середня |
| Чистий VPS | Ansible + Node | — | — | 1–3 год | Середня |
| Діагностика через кілька місяців | ≈1,5 тис. рядків свого коду | — | — | 0,7–2 год | Середня |

### 6.2 12 місяців: залишок + перехід + обслуговування + інциденти

Позначення: f — кількість інцидентів на місяць, що потребують людини (деплоєр не впорався або впорався з алертом). Частоту я **не знаю** — тому три сценарії.

| Компонент (год власника, оцінка) | А | Б | В |
|---|---|---|---|
| Залишок / перехід | **10–25.** План переходу й 3–6 PR (рев'ю 3–6), VM-репетиція 4–10, перехід і acceptance 2–4, preflight 0,5 | **7–14.** Проба на VPS 1–2, 3–4 PR (рев'ю 3–6), перемикання й репетиція відкату 3–6 | **8–16** |
| Фіксоване за рік | **2–6.** Hold на Dependabot-бампи actions у `ci.yml`, ротація токена, Node major | **3–6.** Dependabot base digest ≈52 PR × 2–5 хв, якщо не автоматизувати через `dependabot-qualify` | **2–5** |
| Вартість одного інциденту | 1–3 + hold на фікс 0,25–0,75 | 0,5–1,5 | 0,75–2 |
| f = 0,5 на місяць (6 на рік) | 7,5–23 | 3–9 | 4,5–12 |
| f = 1 на місяць (12 на рік) | 15–45 | 6–18 | 9–24 |
| f = 2 на місяць (24 на рік) | 30–90 | 12–36 | 18–48 |
| **Разом за f = 1** | **27–76** | **16–38** | **19–45** |

**Точка окупності Б проти А:**
- Найгірший для Б випадок (Б-перехід 14, А-залишок 10, фіксоване +1) дає ≈5 год різниці на старті. Їх повертає вища вартість інциденту в А: за серединами діапазонів ≈2,5 год проти ≈1 год, тобто ≈1,5 год на кожен. Це **≈3–4 інциденти**, тобто f ≈ 0,3 на місяць протягом року. Якщо взяти крайні значення (А дешеве, Б дороге), різниця на інцидент зникає, і тоді Б окупається лише меншою частотою інцидентів.
- У середньому випадку Б дешевша вже на старті (≈10,5 проти ≈17,5).
- Для порівняння: bash-деплоєр у перші 7 тижнів мав ≈1,4 bug-issue на тиждень. Навіть якщо новий код буде в 4–5 разів надійнішим на рядок, Б окупиться в першому кварталі.
- Висновок не залежить від того, що f у Б однакова з А. Насправді вона, найімовірніше, нижча: власного коду в ≈15–20 разів менше.

### 6.3 Гроші й ліміти (перевірено 11.10.2026)

- **Repo публічний:**
  - GitHub-hosted runners для public repo — безкоштовно;
  - GHCR для публічних пакетів — безкоштовно (сховище й трафік);
  - artifact attestations для public repo — на всіх поточних планах.
- **Actions artifacts:** зараз 30,7 MB на push × 30 днів. Чи рахується це в квоту для public repo, документація прямо не каже. Завантаження проходять, тож практичного обмеження немає. У Б артефакти Actions не потрібні.
- **Docker Hub:** анонімний pull дав `429` (P1). Base треба пінити digest-ом і тягнути з `mirror.gcr.io` або GHCR.
- **VPS:** вільно 45 GB (preflight 11.10). Образ ≈140 MB стиснений; 5 релізів < 2 GB.
- **Окрема VM** для А (вимога дизайну §10): кілька євро за години хмарної VM, оцінка. Для Б — за бажанням.
- **AI-рев'ю:** кожен великий деплой-PR проходив 2–4 платні проходи рев'ю. Менший diff у Б зменшує цю статтю, але чисел я не маю.

---

## 7. Карта модулів (варіант Б)

| Модуль | Рядки | Дія | Пояснення |
|---|---|---|---|
| `deploy/autodeploy.sh`, `ships.sh`, `read-env.sh`, `installed-current.sh`, `record-deployed.sh` | ≈1 300 | **Залишити** | Перевірені в prod гейти: quiet main, CI, holds, failed-SHA, rearm, fence, вікно |
| `deploy/autodeploy.sh` seam-и `BUILD_CMD`, `DEPLOY_CMD`, `TRIAL_CMD`, гілка відкату коду | ≈150 | **Адаптувати** | pull+verify / retag+restart / `podman run` trial / retag попереднього settled digest замість `deploy.sh` на старому checkout-і |
| `deploy/db-snapshot.sh` | 143 | **Залишити** | Знімок і відкат БД (контракт 1) |
| `deploy/trial-migrate.cjs` | 56 | **Залишити**, переїжджає в образ | Trial запускається з образу кандидата |
| `deploy/deploy.sh`, `deploy/rsync-filter` | 109 + — | **Замінити** | Ручний шлях = `autodeploy.sh --manual` з тим самим pull/retag |
| `deploy/warsaw-beer-bot.service` | 23 | **Замінити** | `warsaw-beer-bot.container` (Quadlet), той самий ім'я юніта |
| `deploy/install-autodeploy.sh` та інші `install-*.sh` | 445 | **Замінити поступово** | Ansible-playbook; на першому етапі не обов'язково |
| `deploy/sudoers.d/warsaw-beer-bot` | 48 | **Адаптувати** | Прибрати `rsync`/`chown /opt`, додати `podman pull/tag/run` для fixed-аргументів |
| `deploy/litestream.*` | — | **Залишити** | Litestream лишається на хості (P5) |
| `src/release/identity.ts`, `/health.releaseSha` | 100 | **Залишити** | Працює з образу (P3) |
| `.github/workflows/ci.yml` job `package` | ≈60 | **Замінити** | Job `image`: build, smoke, push за digest, attest |
| `deploy/release/payload-probe.cjs` | 115 | **Адаптувати** | Smoke образу в CI (SQLite, двічі migrate, fest-print, ops-команди) — те саме, що P2–P4 |
| `deploy/release/package_runtime.py`, `verify_payload.py`, `tree_manifest.py`, `safe_tar.py` | 786 | **Видалити** | Замінює OCI-шари з content-addressing |
| `github_trust.py`, `zip_admission.py`, `publish.py`, `wbb_release.py` | 903 | **Видалити** | `gh attestation verify` + `podman pull @digest` |
| `host_audit.py`, `audit_verdict.py` | 291 | **Видалити** | Дублікат чинного аудиту в клоні (`scripts/autodeploy/audit-verdict.ts`) |
| `sandbox.py`, `trial.py` | 517 | **Видалити** | Ізоляцію дає контейнер (P4); користувач `wbb-trial` не потрібен |
| `dbsnap.py` | 277 | **Видалити** (або портувати fsync-покращення в `db-snapshot.sh`) | Дублікат чинного helper-а |
| `activate.py`, `deploy_state.py`, `tick.py`, `tick_state.py`, `gates.py`, `prepare.py`, `helpers*.py`, `host_adapter.py`, `installed.py`, `bounded.py`, `notify_telegram.py` | ≈3 900 | **Видалити** | Python-переписування `autodeploy.sh`. Корисні ідеї переносяться точково: звірка `releaseSha` у health, відкат до останнього settled, а не просто попереднього |
| `installer.py`, `install-release.sh`, `wbb-release.sh`, `wbb-tick*.{sh,service,timer}`, `sudoers.d/wbb-release` | ≈900 | **Видалити** | Не активовані. Якщо #834 вже встановлено на хості — прибрати playbook-ом |
| Тести `deploy/release/test_*`, фейки | 10 711 | **Видалити** разом із модулями | — |
| Дизайн 2026-10-08 і 8 планів | 1 284 | **Залишити як історію** | Додати в шапку посилання «superseded by …» |
| `spec.md` §5.9 (абзаци про Ядро-1/2а/…) | — | **Переписати** | У тому ж PR, що й нова реалізація |

---

## 8. Зміни гарантій, що потребують рішення власника

Кожен пункт нижче — **окреме** рішення. Варіант Б за замовчуванням пропонує те, що написано в стовпці «Б».

| # | Гарантія з дизайну 2026-10-08 | Б | Чи послаблення |
|---|---|---|---|
| 1 | Root-receipt, і дерево перехешовується перед кожною активацією та відкатом | Content-addressed шари при pull; `inspect` digest перед retag; без повторного хешування шарів | **Так, незначне.** Захищає лише від локальної підміни з root, а root дизайн і так виводить за межі гарантій |
| 2 | Окремий користувач `wbb-trial` + sandbox systemd (`ProtectProc=invisible`, `InaccessiblePaths`) | Контейнер: окремі pid/net/mount namespace, `--network=none`, `--read-only`, `--cap-drop=ALL`, секрети не змонтовано | Ні, ізоляція не слабша; але її треба переміряти на VPS |
| 3 | Довіра: точний run/attempt + `package=success` | Атестація: repo, workflow, ref `main`, source SHA, hosted runner; плюс чинний exact-SHA гейт CI | Ні (атестація підписана), **але** потребує, щоб VPS бачив Sigstore TUF |
| 4 | Host audit lockfile-у з root-private payload | Чинний аудит у клоні того самого SHA (як у prod) | Ні проти prod; так проти дизайну |
| 5 | Node патчиться автоматично через unattended-upgrades (#469) | Node і base оновлюються лише rebuild-ом образу | **Так, за свіжістю.** Потрібен Dependabot `docker` + щотижневий merge або автоматичний qualify. Рішення: чи прийнятно |
| 6 | Crash/recovery v2: 11 фаз, `boot_id`, PAUSED звіряє pending-стан | Семантика R2 merge-deploy + ідемпотентний retag/restart | **Так проти дизайну**, ні проти prod |
| 7 | Строга рівність голови `main` перед активацією; UNVERIFIED блокує наступну активацію; відкат до останнього settled | Чинна поведінка; «останній settled» додати дешево (тег `wbb:settled`) | Частково. Рекомендую лишити лише «останній settled» |
| 8 | Автоматичний code+DB rollback на кожен невдалий реліз (§5) | Без змін (контракт 1) | Ні. Перехід на контракт 2 — окреме рішення, зараз **не** рекомендую |
| 9 | Ops-команди через `npm run` у `/opt/.../current` | `wbb-ops <cmd>` = `podman run` того самого образу з тим самим `.env` і data; `cluster-triage` — з checkout-у оператора (потребує `gh`) | Зміна runbook-ів, не гарантій |
| 10 | Legacy byte capture і перенесення flat-дерева | Не потрібні: контейнер не торкається `/opt/warsaw-beer-bot`. Старий юніт і дерево лишаються fallback-ом, доки перехід не прийнято | Спрощення |

---

## 9. Невідомі, що можуть змінити рекомендацію

1. **Чи бачить VPS `tuf-repo-cdn.sigstore.dev` і GitHub attestations API.** Якщо ні, Б лишається, але походження доводиться pin-ом digest-у з CI плюс чинним exact-SHA гейтом (послаблення п.3) або offline-bundle з `--custom-trusted-root`.
2. **Rootful Podman 4.9 під справжнім systemd на VPS.**
   - Під systemd тут не перевірено: `Type=notify`, `--sdnotify=conmon`, `KillMode=mixed`, `TimeoutStopSec=20`, журнал у journald, `NRestarts` на юніті-генераторі.
   - Також: як `Network=host` і cloudflared бачать порт `127.0.0.1:API_PORT`.
3. **RAM VPS.** Не виміряно. Накладні витрати conmon малі, але точних чисел для цього VPS немає.
4. **24-годинний цикл крон-задач у read-only образі.** Звіт preflight `finish` ще не існує. P3 покрив лише старт і ops-команди.
5. **Чи виконано кроки hold з #834 на хості, і чи стоять зараз app-деплої.**
6. **Чи спрацьовував коли-небудь відкат merge-deploy у production** (журнали хоста). Якщо ні, його DB-частину варто відрепетирувати один раз у будь-якому варіанті.
7. **Чи прийнятна для власника ручна свіжість Node-патчів (§8 п.5).** Якщо ні й автоматизація через `dependabot-qualify` неможлива, варіант В стає ближчим.

---

## 10. Перший обмежений етап

**Крок 0 — сьогодні, операційний, без коду.** Якщо hold з #834 ще не знято, а рішення про Б ухвалено, `install-release.sh` можна **не** запускати: нічого з того, що він ставить, не використовується. Hold знімає лише `bash deploy/deploy.sh` (статус перевірити за повідомленням `wbb-autodeploy`). Якщо інсталятор уже запущено, видалити встановлене буде дешевим кроком наступного етапу.

**Етап 1 — spike на VPS, без змін production (за `CLAUDE.md` spike не лишає закомміченого коду в main).**

Підготовка:
- одна тимчасова гілка з workflow, що збирає образ і пушить його в GHCR з атестацією;
- на VPS — `apt install podman` і один тимчасовий Quadlet-юніт `wbb-probe` з іншою назвою й портом, копією знімка БД і фейковим токеном.

**Критерій приймання** — усі пункти виконано, кожен підтверджено виводом:
1. `podman pull ghcr.io/…@sha256:<d>` і `gh attestation verify oci://…@sha256:<d> --repo ysilvestrov/warsaw-beer-bot --signer-workflow …/ci.yml --source-digest <sha> --deny-self-hosted-runners` проходять. Перевірка образу з іншого репо чи іншого workflow **падає**.
2. `systemctl start/stop/restart wbb-probe`:
   - стоп ≤ `TimeoutStopSec`;
   - у журналі видно `SIGTERM → exit → start`;
   - `NRestarts` росте після `kill -9` процесу в контейнері;
   - `/health.releaseSha` == `<sha>`.
3. Trial із тимчасового образу на копії свіжого знімка в контейнері `--network=none`: `TRIAL OK`, `.env` недоступний.
4. Retag на попередній digest і restart з `Pull=never` при заблокованому `ghcr.io` (`/etc/hosts`) стартує попередній образ.
5. Виміряно: RAM процесу і conmon, диск сховища, час pull.
6. Прибирання: юніт, образи й тимчасова гілка видалені; production і merge-deploy не торкалися.

**Що далі за результатом:**
- **Пункти 1–4 пройшли** → повний цикл за `CLAUDE.md`: brainstorming → спека Б з таблицею «заявка → доказ» → план ядра (CI-образ + seam-и `autodeploy.sh`) → рев'ю → окремий план переходу й видалення `deploy/release`.
- **Пункт 1 не пройшов через мережу** → рішення власника щодо §8 п.3, далі той самий цикл.
- **Пункт 2 не пройшов** → варіант В.

---

## Додаток: файли проби (не для коміту в код)

Ключові рядки Dockerfile проби:

```dockerfile
FROM node:24-bookworm AS build              # better-sqlite3 13 збирається node-gyp: потрібні python3/g++
WORKDIR /ctx
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx tsc -p tsconfig.release.json --outDir /out/dist
RUN mkdir /prod && cp package.json package-lock.json /prod/ && cd /prod && npm ci --omit=dev

FROM node:24-bookworm-slim
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision=$SOURCE_SHA
WORKDIR /app
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /ctx/package.json /ctx/package-lock.json ./
COPY --from=build /ctx/src ./src             # fest-print assets + ops-джерела для tsx
COPY --from=build /ctx/scripts ./scripts
COPY --from=build /ctx/deploy/trial-migrate.cjs ./deploy/trial-migrate.cjs
RUN node -e "…write release.json…" && chmod -R a-w /app
USER 10001:10001                             # на VPS — UID warsaw-beer-bot
CMD ["node","dist/index.js"]
```

Quadlet проби (`quadlet -dryrun` на Podman 4.9.3):

```ini
[Container]
Image=ghcr.io/ysilvestrov/warsaw-beer-bot@sha256:…
ContainerName=warsaw-beer-bot
Pull=never
User=<uid warsaw-beer-bot>
ReadOnly=true
Tmpfs=/tmp
DropCapability=ALL
NoNewPrivileges=true
Network=host
EnvironmentFile=/etc/warsaw-beer-bot/.env
Volume=/var/lib/warsaw-beer-bot:/var/lib/warsaw-beer-bot
[Service]
Restart=on-failure
TimeoutStopSec=20
```

Ansible проби — 5 задач:
- `user` (system, nologin);
- `file` 0700;
- `copy` sudoers з `validate: /usr/sbin/visudo -cf %s`;
- `copy` unit;
- `systemd_service: daemon_reload`.

Результати: повтор `changed=0`; drift → `--check changed=1`; зламаний sudoers → `failed to validate`, живий файл незмінний.

Джерела про плани й ціни:
- [GitHub Docs — artifact attestations](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds)
- [GitHub Docs — use artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub Docs — billing for GitHub Packages](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
- [GitHub Docs — introduction to GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages)
