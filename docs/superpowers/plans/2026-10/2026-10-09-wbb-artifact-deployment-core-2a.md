# Artifact deployment — Ядро-2а: довіра й публікація релізу на хості — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** перший шматок Ядра-2 зі спеки (§12 п.2): механізм, яким хост **приймає** artifact. Тобто довірений вибір run і artifact через GitHub API, перевірка ZIP і tar, root-private публікація незмінного дерева `releases/<sha>`, атомарний receipt і повторна перевірка дерева проти receipt. **Нічого не запускається з payload і нічого не активується.**

**Чому Ядро-2 ділиться на три плани.** Повне Ядро-2 (публікація, аудит, sandbox-проба й trial, активація з crash-матрицею та відкатом) — це понад десяток задач, і пізні задачі спираються на механізми, яких ще немає (CLAUDE.md, «велика зміна йде стадіями»). Тому:
- **2а** (цей план) — довіра й публікація. Це фундамент, на якому стоять receipt і `releases/<sha>`.
- **2б** — host audit, fixed `wbb-trial` sandbox, native probe, trial migrate.
- **2в** — controller: state v2, активація, crash/recovery-матриця §10b, локальний code+DB rollback.

Кожен наступний план пишеться після наскрізного рев'ю попереднього. Production activation заборонена до кінця 2в (спека §12): rollback — частина ядра, а не периферія, просто він іде останнім кроком ядра.

**Не входить у 2а:** sudoers, unit-и, встановлення helper-ів у `/usr/local`, створення користувачів і тек на хості — це обв'язка. Код 2а пише за шляхами, які передаються параметром. Фіксовані production-шляхи — константи, і тести їх не торкаються.

**Tech Stack:** Python ≥3.12 stdlib (`urllib`, `zipfile`, `tarfile`, `hashlib`, `os`). Вендорні модулі не використовуються, candidate-код не виконується.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md` — §4 TRUST-001 повністю, §2 (таблиця шляхів, receipt), §10a рядки «Root accepted receipt» і «releases/<sha> verified», §10b рядок `prepared / publish`.

## Наскрізне рев'ю Ядра-1 (2026-10-09) — вхідні дані

Рев'ю перечитало `deploy/release/*` і `ci.yml` проти спеки §3–§5 після першого зеленого `package` на `main` (run 37901278240: 45 с, artifact 30.7 MB, `expires_at` +30 днів). Два дефекти підтверджено живою пробою:
1. `tree_manifest.verify_tree` на **канонічному** маніфесті з entry без `path` кидає `KeyError`, а з нерядковим `path` — `AttributeError`, замість списку проблем. Причина: `_sorted` викликається до `check_entries`. Для CI це байдуже, бо маніфест пише сам CI. Але у 2а той самий код читає недовірені байти.
2. `verify_payload.check_checksum` приймає `.sha256` із зайвим `\n` у кінці, бо `$` у `re.match` збігається перед фінальним переводом рядка.

Інше рев'ю пройшло без знахідок:
- резолюція Node з розпакованої теки не досягає checkout;
- `ci`-агрегатор дає відмову на build-failure і на cancelled;
- caps рахуються;
- проби ловлять мутації (перевірено ще в Ядрі-1);
- `node_modules` через `$RUNNER_TEMP/prod` — сусідня тека, а не предок payload.

## Проба засновків (2026-10-09, до плану)

| Засновок | Проба | Результат |
|---|---|---|
| Run metadata дає ідентичність для §4 | `GET /actions/runs/37901278240` | `path=.github/workflows/ci.yml`, `event=push`, `head_branch=main`, `head_sha`, `run_attempt=1`, `repository` = `head_repository` = `ysilvestrov/warsaw-beer-bot`, `conclusion=success` |
| Висновки jobs того самого attempt | `GET /actions/runs/{id}/jobs` | `build (root)`, `build (extension)`, `package`, `ci` — кожен з `conclusion` і `run_attempt` |
| Run-scoped список артефактів має digest | `GET /actions/runs/{id}/artifacts` | один artifact з точним ім'ям, `digest: sha256:906bc06a…`, `expired:false`, `expires_at`, `workflow_run.head_sha` |
| Завантаження — redirect на чужий хост | `GET /actions/artifacts/{id}/zip` | `302` на `*.blob.core.windows.net` з підписаним URL (SAS, ~10 хв). Значить, токен не можна пересилати після redirect, а URL не можна логувати — як і вимагає спека |
| **`digest` = SHA256 байтів скачаного ZIP; будова ZIP** | гейт G1: `probe-artifact-zip.sh` на VPS (власник, 2026-10-09) | **ЗАКРИТО.** `API digest` = `sha256(zip)` = `906bc06a…0741`, розмір 30 716 029. Рівно два записи `runtime.tar.gz` (30 715 672) і `.sha256` (81): `method=0` (STORED — бо `compression-level: 0`), `mode=0o100644`, `flags=0x8` (data descriptor), `sys=3` (unix); `testzip` чистий, внутрішній checksum OK. Наслідок для Task 2: приймається лише STORED і лише `S_IFREG`; `0x8` дозволено, `0x1`/`0x40` — відмова; `compression-level: 0` закріплено тестом workflow |

## Global Constraints

- Довіра до походження (§4): репо `ysilvestrov/warsaw-beer-bot`, workflow `path` рівно `.github/workflows/ci.yml`, `event=push`, `head_branch=main`, `head_sha` = кандидат, `repository.full_name` = `head_repository.full_name` = репо, `status=completed`, `conclusion=success`. Jobs **того самого** `run_attempt`: `package=success` і `ci=success`. Відсутнє поле, інший тип або неоднозначність — відмова.
- Вибір run: `GET /repos/{repo}/actions/workflows/ci.yml/runs?head_sha=<sha>&event=push&branch=main&status=completed`. Кандидати — рівно ті, що проходять правило вище. Якщо їх 0 — відмова «немає довіреного run», якщо понад 1 — відмова «неоднозначно». «Останній зелений» не вибирається ніколи.
- Вибір artifact: лише `GET /actions/runs/{run_id}/artifacts`; ім'я рівно `wbb-release-<sha>-<run_id>-<run_attempt>`; рівно один; `expired=false`; `workflow_run.id` = run, `workflow_run.head_sha` = sha; `digest` відповідає `^sha256:[0-9a-f]{64}$`. Пошук за ім'ям по всьому репо заборонений.
- HTTP: `Authorization` лише на запити до `https://api.github.com`. Redirect на завантаженні не виконується автоматично: `Location` береться вручну й запитується **без** заголовків авторизації. URL, `Location` і токен не потрапляють у вивід і в тексти винятків. Таймаути на кожен запит; розмір JSON-відповіді ≤ 4 MiB.
- ZIP (§4): розмір ≤ 257 MiB; `sha256(zip)` = `digest`; рівно два regular-записи з іменами `runtime.tar.gz` і `runtime.tar.gz.sha256`; без тек, symlink-ів, шифрування (`flag_bits & 0x1`) і дублікатів; сума розпакованих ≤ 256 MiB + 1 KiB; checksum-файл ≤ 256 B. Кожен запис читається потоково з лічильником (фактичний розмір ≤ заявленого й рівний йому), CRC перевіряє `zipfile`. Метод стиснення — лише `STORED` (G1: так пакує CI з `compression-level: 0`).
- Tar: ті самі правила й caps, що в `verify_payload.extract` (Ядро-1). Функція переїжджає в спільний модуль, нова копія не пишеться.
- Публікація (§4 «Publication TOCTOU boundary»): вхідний архів оператора відкривається з `O_NOFOLLOW | O_NOCTTY`, має бути regular-файлом і копіюється обмеженим читанням у root-private scratch (`0700`) на тій самій ФС, що й `releases/`. Усі перевірки йдуть над копією. Дерево нормалізується: власник `root:root` (лише коли процес — root; у тестах це no-op), mode з маніфесту, теки `0755`. Далі `verify_tree` і перевірка `release.json` проти **довірених** метаданих (`sourceSha`, `runId`, `runAttempt`, `repo`, `workflow`). Після цього — атомарний `rename(scratch_tree, releases/<sha>)`. Існуючий `releases/<sha>` ніколи не перезаписується.
- Receipt `receipts/<sha>.json`, `0600`, canonical JSON: `formatVersion=1`, `repo`, `sourceSha`, `runId`, `runAttempt`, `artifactId`, `zipSha256`, `tarSha256`, `treeSha256`, `acceptedAt`. Запис: temp у тій самій теці → `fsync(file)` → `rename` → `fsync(dir)`. Receipt пишеться **після** rename дерева.
- Конфлікт (§4): якщо вже є receipt для sha з іншим `tarSha256` або `treeSha256` — відмова, нічого не переписується. З тими самими tar/tree, але іншим zip/run/attempt — no-op «вже прийнято».
- Реконсиляція (§10b `prepared / publish`): якщо є `releases/<sha>` без receipt — повна повторна перевірка проти нового довіреного завантаження, і лише після неї receipt. Невідповідність — відмова, дерево не чіпається; activation без receipt заборонена.
- `verify_release(sha)`: `tree_digest` маніфесту в `releases/<sha>` дорівнює receipt `treeSha256`, і `verify_tree` порожній. Мережі не торкається (потрібно для rollback, §8).
- Тести: `npm test -- <args>`; повний гейт кожної задачі — `npm test && npm run typecheck`. Python-тести лежать у `deploy/release/test_*.py` (обгортка `scripts/release.test.ts` уже є). GitHub API у тестах — фейковий transport (функція), мережі немає. Правила тестів CLAUDE.md діють.

---

### Task 0: дефекти з рев'ю Ядра-1

**Files:** modify `deploy/release/tree_manifest.py`, `deploy/release/verify_payload.py`, їхні тести.

- [ ] `verify_tree`: `check_entries` виконується **до** перевірки сортування. Entry без рядкового `path` дає проблему, а не виняток. Тести: канонічні байти з entry `{type,mode}` і з `path: 7` повертають точні рядки проблем.
- [ ] `check_checksum`: `re.fullmatch` над рядком без `$`-семантики (`\Z`), і файл понад 256 B — відмова. Тести: `…\n\n` і `…` без `\n` відхиляються.

### Task 1: `github_trust.py` — довірені метадані run і artifact

**Files:** create `deploy/release/github_trust.py`, `deploy/release/test_github_trust.py`.

- [ ] `select_run(runs_json, repo, sha)`, `check_jobs(jobs_json, attempt)` і `select_artifact(artifacts_json, repo, sha, run_id, attempt)` — чисті функції за Global Constraints. Повертають dataclass `Trusted(repo, sha, run_id, run_attempt, artifact_id, digest, workflow)`.
- [ ] `fetch_trusted(api, repo, sha)`: `api(path) -> dict` (інжектований transport). Реальний transport `GitHubApi(token)` на `urllib` з обмеженням розміру.
- [ ] `download_zip(api, artifact_id, dest_fd, cap)`: запит `/zip` без auto-redirect, далі `Location` без авторизації, потоково в fd з обмеженням. Тест через фейковий opener: на другий запит не йде `Authorization`, у тексті винятку немає URL.
- [ ] Тести відмов: PR- і fork-run (`head_repository` інший), інший `path`, `event=pull_request`, `head_branch` не main, `package` skipped, `ci` failure в тому ж attempt (а успіх лише в старшому), два кваліфіковані run, artifact з чужим ім'ям/attempt, expired, без digest, digest не hex.

### Task 2: `zip_admission.py` — ZIP → перевірений tar

**Files:** create `deploy/release/zip_admission.py`, `deploy/release/test_zip_admission.py`; extract спільного `safe_extract` з `verify_payload.py` у `deploy/release/safe_tar.py` (verify_payload імпортує його).

- [ ] `admit_zip(zip_path, digest, out_dir, caps)` за Global Constraints. Повертає `(tar_path, tar_sha256)`, а checksum-файл звіряється тією ж функцією, що й у Ядрі-1.
- [ ] Тести (ZIP-и генеруються в тесті): правильний; digest не той; третій запис; тека; symlink-запис (`external_attr` S_IFLNK); шифрований біт; дублікат імені; заявлений розмір менший за фактичний (підроблений header); пошкоджений CRC; межа expanded-cap (рівно — OK, +1 — відмова).
- [x] **Гейт G1:** звірено з виводом `probe-artifact-zip.sh` (2026-10-09); правила звужено під фактичну будову (див. таблицю проб).

### Task 3: `publish.py` — публікація, receipt, реконсиляція, повторна перевірка

**Files:** create `deploy/release/publish.py`, `deploy/release/test_publish.py`.

- [ ] `publish(sha, operator_zip, trusted, roots)`, де `roots` = `(releases, receipts, scratch)`: копія з O_NOFOLLOW → `admit_zip` → `safe_extract` у scratch → нормалізація → `verify_tree` → `release.json` проти `trusted` → rename → receipt. Результат — `accepted` / `already-accepted` / виняток з причиною.
- [ ] `verify_release(sha, roots)`.
- [ ] Тести: повний успіх (дерево й receipt на місці, receipt `0600`, точні поля); symlink замість operator-архіву — відмова; архів, змінений після digest (байт у копії оператора), — відмова, `releases/` порожня; `release.json` з чужим runId — відмова; повторна публікація того самого — `already-accepted`, `mtime` receipt не змінився; інший tar для того самого sha — відмова, старий receipt байт-у-байт незмінний; дерево без receipt (симуляція краху між rename і receipt) — повна перевірка й дописаний receipt; дерево без receipt, але змінене — відмова; `verify_release` ловить змінений файл у `releases/<sha>` і змінений receipt; скретч прибирається після відмови.

### Task 4: CLI і документи

**Files:** create `deploy/release/wbb_release.py` (CLI: `publish --sha <sha> --archive <zip>`, `verify --sha <sha>`; token — з файла `/etc/wbb-deploy/github.env`, ключ `WBB_GITHUB_TOKEN`; production-шляхи — константи), тест CLI на temp roots через env-override лише в тестах; modify `spec.md` §5.9 (абзац про runtime artifact: що на хості з'явився інструмент прийняття, але деплой його ще не використовує); статус у спеці.

## Після 2а

Наскрізне рев'ю 2а (довіра, TOCTOU, receipt-семантика). Далі план 2б: host audit по lockfile з `releases/<sha>`, fixed `wbb-trial` sandbox, native probe і trial migrate. Вони читають уже прийняте дерево.
