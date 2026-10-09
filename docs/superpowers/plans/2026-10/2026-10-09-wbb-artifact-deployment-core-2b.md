# Artifact deployment — Ядро-2б: host audit, ізольовані проба й пробна міграція — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** другий шматок Ядра-2 (спека §12 п.2). Над уже **прийнятим** деревом `releases/<sha>` (Ядро-2а) треба зробити три речі:
1. Отримати актуальний host audit його lockfile — **до** першого виконання candidate-коду.
2. Виконати native-пробу в ізольованому sandbox `wbb-trial`.
3. Пройти trial migrate на приватній копії `pre`-знімка в тому ж sandbox.

Результат кожного кроку — вердикт для контролера. **Нічого не активується:** current, unit-и, БД і стан деплою не змінюються. Активацію, crash/recovery і rollback робить Ядро-2в. Встановлення helper'ів, створення користувача `wbb-trial`, sudoers — це обв'язка.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md`:
- §2 «Control plane» (sandbox `wbb-trial`, його властивості й ліміти);
- §4 (native compatibility, host Node identity);
- §5 audit п.2;
- §6 DATA-001;
- §10a, рядки «Host audit PASS» і «TRIAL OK».

## Наскрізне рев'ю Ядра-2а (2026-10-09) — вхідні дані

2а пройшла рев'ю codex (власник). Дві знахідки виправлено до мерджу:
- строга перевірка прав і власника;
- `fsync` усього дерева до receipt.

Гейт G1 закрито живою пробою на VPS. Повторне читання змердженого коду нових дефектів не дало. Одна свідома межа: `publish` для вже прийнятого SHA щоразу заново качає й перевіряє артефакт, а не довіряє наявному дереву. Це ціна повної перевірки, і вона прийнятна.

Для 2б важливо одне: `verify_release(sha, roots)` уже дає строгу перевірку дерева без мережі. Тож 2б перед кожним виконанням payload викликає її, а не власну копію правил.

## Проба засновків (2026-10-09, до плану)

| Засновок | Проба | Результат |
|---|---|---|
| A1. Audit працює з голого lockfile, без `node_modules` і install | у теці лише `package.json` + `package-lock.json` (Node 24.21 / npm 11.19), `env -i`: `npm audit --omit=dev --package-lock-only --json --userconfig U --globalconfig G --registry https://registry.npmjs.org/ --ignore-scripts` | exit 0, 2 с, `metadata.dependencies.prod=175`, усі severity 0. Тека після запуску містить ті самі два файли: ні `node_modules`, ні install |
| A2. `.npmrc` у теці аудиту читається | у ту саму теку покладено `.npmrc` з `registry=https://evil.invalid/` | **Так, читається**: без `--registry` запит пішов на `evil.invalid`. З `--registry` у командному рядку звіт той самий, що й без `.npmrc`. Наслідок: тека аудиту створюється заново й містить **рівно два скопійовані файли**, а registry задається явно |
| A3. Той самий шлях для user- і global-конфігу | `--userconfig /dev/null --globalconfig /dev/null` | npm відмовляє (`double-loading config "/dev/null"`). Наслідок: два окремі порожні файли |
| A4. Недоступний registry | `--registry https://127.0.0.1:9/` | exit 1, JSON `{"message": "...ECONNREFUSED...", "error": {...}}`. За правилами `audit-verdict.ts` (#795) це `unrunnable`, а не `clean` |
| A5. Що аудит бачить у контейнері | без CA bundle проксі | TLS-помилка, бо `env -i` прибирає `NODE_EXTRA_CA_CERTS`. Це артефакт хмарного контейнера: на VPS проксі немає. На хості env аудиту = рівно `PATH` і `HOME`; додаткові змінні передаються лише явним параметром тестів |
| **G2.** systemd sandbox з властивостями §2 справді ізолює: немає мережі, `/home` і секретів, root FS read-only, scratch writable, capabilities нульові, `RuntimeMaxSec` вбиває всю cgroup разом із нащадком | з контейнера неможливо: тут немає systemd | **ВІДКРИТО — гейт G2.** Проба `probe-trial-sandbox.sh` передана власнику (тимчасові unit-и від `nobody`, без змін на хості). Задачі 3–4 не вважаються завершеними, доки G2 не дав відповіді. Список властивостей у коді звіряється з тим, що G2 показав робочим |

## Global Constraints

- **Порядок виконання** (§5, §6): `verify_release` → host audit (`clean`, інакше стоп) → `verify_release` → native probe → trial. До audit candidate-код не виконується **жодного разу**; перед кожним запуском payload ще раз `verify_release`.
- **Вердикт аудиту** — Python-порт `scripts/autodeploy/audit-verdict.ts` з тією самою семантикою: `clean`, `advisory` (high/critical) або `unrunnable` (порожньо, не JSON, не об'єкт, `error`, немає чи малформований `vulnerabilities`, невідома severity). Exit code npm не читається. Паритет із TS перевіряється тестом на тих самих фікстурах `scripts/autodeploy/fixtures/npm-audit/*.json` і на синтетичних випадках.
- **Аудит:**
  - нова тека `0700` у переданому workdir; `package.json` і `package-lock.json` копіюються з `releases/<sha>` з `O_NOFOLLOW` (лише regular, ≤ 16 MiB кожен);
  - порожні `user.npmrc` і `global.npmrc` — два окремі файли (A3);
  - env рівно `{PATH: '/usr/bin:/bin', HOME: <workdir>/home}`;
  - аргументи фіксовані (A1) з `--registry https://registry.npmjs.org/`;
  - таймаут 120 с, stdout ≤ 32 MiB;
  - запуск не від root: функція відмовляє, якщо `geteuid() == 0`;
  - тека видаляється після запуску.
- **Sandbox** (§2) — фіксований argv `systemd-run` без жодної властивості від оператора:
  - `--wait --pipe --collect --quiet`, `--unit wbb-trial-<kind>-<sha12>-<hex8>`;
  - `User=wbb-trial`, `Group=wbb-trial`;
  - `PrivateNetwork=yes`, `ProtectHome=yes`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `PrivateDevices=yes`;
  - `InaccessiblePaths=-` для `/etc/warsaw-beer-bot`, `/etc/wbb-deploy`, `/var/lib/warsaw-beer-bot`, `/var/lib/wbb-deploy`;
  - `ReadWritePaths=<scratch>`, `WorkingDirectory=<scratch>`;
  - `CapabilityBoundingSet=`, `AmbientCapabilities=`;
  - `MemoryMax=768M`, `CPUQuota=100%`, `TasksMax=64`;
  - `RuntimeMaxSec=30` для проби і `120` для trial, `KillMode=control-group`;
  - env рівно `PATH=/usr/bin:/bin`, `HOME=<scratch>`, `TMPDIR=<scratch>/tmp`, `WBB_PAYLOAD=<release>`, `DOTENV_CONFIG_PATH=/dev/null`.

  Команда: `<host node> <installed payload-probe.cjs> <mode> [args]`. Шляхи release і scratch виводяться з валідованого SHA та фіксованих коренів, а не з параметрів оператора.
- **Після sandbox:** `systemctl show -p ActiveState,SubState <unit>` має показати `inactive`/`dead` або unit не знайдено. Інакше відмова «cgroup не порожня» й scratch не прибирається.
- **Host Node identity** (§4): `{realpath, sha256, version, modules}` для `/usr/bin/node` фіксується до проби й повертається у вердикті. Контролер 2в звіряє його перед stop/start. Сумісність перевіряється до виконання: `release.json` проти identity (major 24, ABI, x64/glibc, glibc хоста не старіша). Використовується наявна `verify_payload.check_release`.
- **Trial** (§6):
  - знімок `pre` разом зі своїм `.sha256` (формат `db-snapshot.sh`: рядок з 64 hex) перевіряється до копіювання;
  - копія лягає в `<scratch>/trial.db` з власником `wbb-trial`, `0600`; scratch — `0700 wbb-trial`;
  - у sandbox `payload-probe.cjs migrate <db>`: openDb/migrate двічі на цій копії, версія не рухається, `foreign_key_check` порожній, `integrity_check` = ok;
  - результат — `TRIAL OK: schema <before> -> <after>` або `TRIAL FAILED: <причина>`;
  - живу БД sandbox не бачить (`InaccessiblePaths`).
- **Вердикт** кожного кроку — dataclass, який контролер 2в серіалізує в state. `transient` (audit `unrunnable`, systemd недоступний) **ніколи** не дорівнює `failed` (кандидат поганий) — це спека §5: `LAST_FAILED_SHA` лише для `failed`.
- **Тести:** `npm test -- <args>`; повний гейт кожної задачі `npm test && npm run typecheck`. systemd і npm у тестах — інжектований runner (функція), без мережі й без systemd. `payload-probe.cjs migrate <db>` тестується справжнім Node на справжній SQLite (як у Ядрі-1). Правила тестів CLAUDE.md діють.

---

### Task 1: `audit_verdict.py` — вердикт аудиту, паритет із TS

**Files:** create `deploy/release/audit_verdict.py`, `deploy/release/test_audit_verdict.py`; extend `scripts/release.test.ts` тестом паритету (TS `auditVerdict` і Python на тих самих входах дають той самий `kind`).

- [ ] Порт `parseAuditReport`/`auditVerdict` з тими самими текстами причин.
- [ ] Тести: чотири фікстури, порожньо, не JSON, масив, `error`, без `vulnerabilities`, невідома severity, `via` не масив, лише moderate → `clean`, high → `advisory` з назвою.

### Task 2: `host_audit.py` — аудит lockfile прийнятого релізу

**Files:** create `deploy/release/host_audit.py`, `deploy/release/test_host_audit.py`.

- [ ] `audit_release(release_dir, workdir, runner=subprocess.run, npm='/usr/bin/npm')` за Global Constraints. Повертає `AuditResult(kind, detail)`.
- [ ] Тести через фейковий runner:
  - точний argv і env;
  - тека аудиту містить рівно два файли й не містить `.npmrc`, навіть якщо в релізі він є;
  - symlink замість lockfile — відмова;
  - lockfile понад ліміт — відмова;
  - таймаут → `unrunnable`;
  - запуск від root → відмова;
  - тека прибрана після виконання і після винятку.
- [ ] Одна жива проба в цій сесії: справжній npm на lockfile репо дає `clean` (запис у PR, не тест, бо потрібна мережа).

### Task 3: `payload-probe.cjs migrate <db>` і `sandbox.py`

**Files:** modify `deploy/release/payload-probe.cjs` (необов'язковий аргумент DB у `migrate`, рядок `schema <before> -> <after>`); create `deploy/release/sandbox.py`, `deploy/release/test_sandbox.py`.

- [ ] `sandbox_argv(kind, sha, release, scratch, node, probe, args)` — точний список з Global Constraints; `kind ∈ {probe, trial}` задає `RuntimeMaxSec`.
- [ ] `run_sandboxed(...)`: runner для `systemd-run`, потім перевірка `systemctl show`. Повертає `(exit, stdout)` або піднімає `Transient` (systemd недоступний) чи `Refused` (cgroup не порожня).
- [ ] `node_identity(node)`.
- [ ] Тести:
  - argv дослівно для обох kind;
  - жодної властивості з параметрів, крім шляхів, виведених із SHA;
  - не порожня cgroup → відмова;
  - `systemd-run` відсутній → `Transient`;
  - `migrate <db>` справжнім Node на скопійованій фікстурній БД у Python-тесті (без systemd), включно з БД, що ламає `integrity_check`.
- [ ] **Гейт G2:** звірити список властивостей з виводом `probe-trial-sandbox.sh`. Розбіжність означає зупинку й правку плану.

### Task 4: `trial.py` — оркестрація кроків 2б і CLI

**Files:** create `deploy/release/trial.py`, `deploy/release/test_trial.py`; modify `deploy/release/wbb_release.py`: `audit --sha` (не root), `probe --sha`, `trial --sha --snapshot <path>` (root helper); modify `spec.md` §5.9, `deploy/README.md`, `scripts/deploy-rsync.test.ts`.

- [ ] `probe(sha, roots, ...)`: `verify_release` → `check_release` проти host identity → sandbox `native`. `trial(sha, snapshot, roots, ...)`: перевірка checksum знімка → копія в scratch → `verify_release` → sandbox `migrate <db>` → прибирання scratch.
- [ ] Тести через фейкові runner'и:
  - порядок викликів;
  - змінене дерево — відмова до будь-якого запуску;
  - ABI не той — відмова без запуску;
  - битий checksum знімка — відмова без копії;
  - `TRIAL FAILED` → `failed`, systemd відсутній → `transient`;
  - scratch прибраний і після успіху, і після відмови.

## Після 2б

Наскрізне рев'ю 2б. Далі план 2в: контролер (state v2, активація, crash/recovery-матриця §10b, локальний code+DB rollback) поверх `publish`/`verify_release` (2а) і `audit`/`probe`/`trial` (2б). Production activation, як і раніше, заборонена до кінця 2в. Acceptance sandbox і rollback — на disposable Ubuntu 24.04 VM (спека §10).
