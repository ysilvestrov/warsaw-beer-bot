# Artifact deployment — Ядро-1: runtime artifact у CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ядро-1 зі спеки (§12 п.1): CI на push у `main` збирає готовий Linux runtime payload конкретного SHA, описує його `release.json` + `tree-manifest.json`, пакує детермінований `runtime.tar.gz`, доводить працездатність **розпакованого** payload без checkout `node_modules` і публікує GitHub artifact. **На хості нічого не змінюється:** deployer, unit, sudoers, `deploy.sh`, `autodeploy.sh` не чіпаються; host admission/publication/trial/activation/rollback — Ядро-2, план на нього пишеться після наскрізного рев'ю цього ядра.

**Architecture:** Інструменти пакування й перевірки дерева — Python ≥3.12 stdlib у `deploy/release/` (спека §2 «Control plane»): той самий `tree_manifest.py` у Ядрі-2 стане host verifier, тому формат і перевірка пишуться один раз. Node-проба payload — один CommonJS-файл, що запускається **з** розпакованого payload і завантажує все звідти. Workflow — job `package` у чинному `.github/workflows/ci.yml`; stable required check `ci` тепер `needs: [build, package]`.

**Tech Stack:** Python 3.12+ stdlib (`unittest`), Node 24 / CommonJS, GitHub Actions, Vitest (обгортка python-тестів і контракт workflow).

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md` — §3 BUILD-001 повністю; з §4 — лише caps (рахуються вже в CI на реальному payload) і безпечна форма дерева (traversal/links); з §5 — `ci`-агрегатор і CI-аудит (пункт 1); §9 retention 30 днів.

## Проба засновків (spike, 2026-10-08, до плану)

| Засновок | Проба | Результат |
|---|---|---|
| `dist` збирається без тестів | `tsc` з `exclude: **/*.test.ts, **/*.testing.ts`, `types: ["node"]` | BUILD OK, 231 `.js`. Жоден production-модуль не імпортує `*.testing.ts` чи `src/domain/status/test-inputs.ts` (grep) — останній є фікстурою без суфікса й виключається явно |
| Замикання TS ops-команд | `tsc --listFilesOnly` по 10 entrypoints проти esbuild metafile | 64 файли; esbuild — 62 (не бачить двох type-only імпортів). Беремо `tsc`: надмножина, резолюція самого компілятора. Динамічних `import()` у `src/`/`scripts/` немає |
| Production `node_modules` | `npm ci --omit=dev` у чистій теці | 175 пакетів, 106 MB, 9 814 записів; symlinks лише відносні в `node_modules/.bin`, абсолютних нема; `.env*`/`*.db` нема. Під caps §4 (1 GiB / 100 000) із запасом |
| Read-by-path assets | grep `readFileSync`/`__dirname` у `src/` | Лише `src/api/routes/fest-print.ts` → `<root>/src/api/fest-print/` (резолвиться і з `src/`, і з `dist/`) |
| Ops entrypoints не запускають `main` при `require` | grep | 8 із 10 мають `require.main === module`; `cluster-triage-issues.ts` перевіряє `process.argv[1]`; `adjudicate-runner.ts` викликає `main` безумовно — додаємо стандартну охорону (Task 4) |

## Global Constraints

- Payload top-level, рівно: `release.json`, `tree-manifest.json`, `package.json`, `package-lock.json`, `dist/`, `node_modules/`, `src/`, `scripts/`. `src/` містить лише ops-замикання + `src/api/fest-print/**`; `scripts/` — лише ops-замикання.
- Ops allowlist (спека §3), рівно: `alias-key`, `rearm-aliased-orphans`, `rearm-matcher-bug-orphans`, `adjudicate`, `close-orphan-issue`, `pin-match`, `repair-legacy-card`, `dispose-legacy-orphan`, `retire-resolved-orphans`, `cluster-triage`. Entrypoint береться з `package.json` і мусить мати форму рівно `tsx scripts/<name>.ts`; інша форма — відмова пакування.
- Заборонено в payload: будь-який файл `.env`/`.env.*` (крім `.env.example` усередині `node_modules`), `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite*`; поза `node_modules` — `*.test.*`, `*.testing.*`, `tests/`, `fixtures/`.
- `tree-manifest.json` = canonical UTF-8 JSON: `json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`, без кінцевого `\n`. Об'єкт: `{"formatVersion":1,"entries":[...]}`; entries відсортовані за UTF-8 байтами `path`. Entry: файл `{"path","type":"file","mode","size","sha256"}`, тека `{"path","type":"dir","mode"}`, symlink `{"path","type":"symlink","target"}`. `mode` — ціле: `0o644`/`0o755` для файлів (`0o755` якщо в джерелі є будь-який exec-біт), `0o755` для тек. Інвентар охоплює все, крім самого `tree-manifest.json`. Tree digest = SHA256 raw canonical bytes; у payload він **не** пишеться (спека: лише в host receipt).
- Symlink: target відносний, без порожніх компонентів; лексично й через symlink-компоненти маніфесту резолвиться всередині payload (≤40 переходів) у наявний entry. Інакше — відмова.
- `release.json`: `formatVersion=1`, `repo`, `sourceSha` (40 hex), `workflow` (path), `runId`, `runAttempt`, `node{version,major,modules}`, `platform{os:"linux",arch:"x64",libc:"glibc",glibcVersion}`, `packageLockSha256`.
- Archive: `runtime.tar.gz` — ustar/pax, entries у порядку маніфесту, `mtime=0`, `uid=gid=0`, порожні `uname/gname`, gzip `mtime=0`; `runtime.tar.gz.sha256` — `"<hex>  runtime.tar.gz\n"`. Однаковий вхід → однакові байти.
- Caps (спека §4) перевіряються вже при пакуванні: archive ≤256 MiB, сума regular-файлів ≤1 GiB, entries ≤100 000.
- Artifact: ім'я `wbb-release-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}`, рівно два файли, `retention-days: 30`, `if-no-files-found: error`.
- Job `package`: `runs-on: ubuntu-24.04`, Node 24, `needs: [build]`, `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, `permissions: contents: read`. Без secrets.
- `ci`: `needs: [build, package]`, `if: always()`; success ⇔ build=success **і** (package=success **або** (подія не push у main **і** package=skipped)).
- Тести: `npm test -- <args>`; повний гейт кожної задачі `npm test && npm run typecheck`. Python-тести — `unittest` у `deploy/release/test_*.py`, запускаються з Vitest-обгортки `scripts/release.test.ts` (прецедент `scripts/ops.test.ts`). Правила тестів CLAUDE.md: точні асерти, без умов, без тавтологій, межі й помилки покриті.

---

### Task 1: `tree_manifest.py` — інвентар, canonical bytes, перевірка дерева

**Files:** create `deploy/release/tree_manifest.py`, `deploy/release/test_tree_manifest.py`, `scripts/release.test.ts`.

- [ ] `build_manifest(root) -> dict`: обхід `os.scandir` без слідування symlinks; не-UTF-8 імена, special files (FIFO/socket/device), hardlink (`st_nlink>1` для файла) — `ManifestError`. Нормалізація mode за Global Constraints.
- [ ] `canonical_bytes(manifest) -> bytes`, `tree_digest(manifest) -> str`.
- [ ] `check_symlinks(entries)`: правила symlink із Global Constraints.
- [ ] `verify_tree(root, manifest_bytes) -> list[str]` (порожній список = OK): manifest bytes мусять бути canonical (перекодування дає ті самі байти), formatVersion=1, шляхи безпечні (не абсолютні, без `.`/`..`/порожніх), без дублікатів; дерево на диску (без `tree-manifest.json`) рівно збігається: зайвий/відсутній entry, тип, mode, size, sha256, target — кожна розбіжність окремим рядком.
- [ ] CLI: `python3 -I tree_manifest.py build <root>` пише `<root>/tree-manifest.json`; `verify <root>` друкує проблеми, exit 1 при них.
- [ ] Тести: canonical форма на рукописному очікуваному байтовому рядку; mode-нормалізація; зміна байта/mode/target, зайвий і відсутній файл — кожен ловиться; symlink назовні (`../../x`), абсолютний, через symlink-компонент, dangling — відмова; `.bin`-подібний відносний link — OK; FIFO і hardlink — відмова; non-canonical manifest — відмова.
- [ ] Обгортка `scripts/release.test.ts` запускає `python3 -B -m unittest discover -s deploy/release -p 'test_*.py'`.

### Task 2: `package_runtime.py` — збирання payload і архіву

**Files:** create `deploy/release/package_runtime.py`, `deploy/release/test_package_runtime.py`, `tsconfig.release.json`.

- [ ] `tsconfig.release.json`: extends `tsconfig.json`, `types: ["node"]`, exclude `src/**/*.test.ts`, `src/**/*.testing.ts`, `src/domain/status/test-inputs.ts`.
- [ ] `ops_entrypoints(package_json) -> list[str]`: за allowlist, сувора форма скрипта.
- [ ] `ops_closure(repo, entrypoints, tsc)`: тимчасовий tsconfig у scratch (`files` = entrypoints, `types: []`), `tsc --listFilesOnly`, лише файли під `repo/src` і `repo/scripts`, поза `node_modules`; `*.test.*` у замиканні — відмова.
- [ ] `assemble(repo, dist, prod_modules, out, identity)`: копіює (без слідування symlinks у source tree, крім `node_modules`, де symlinks копіюються як symlinks) усі частини, пише `release.json`, застосовує policy (top-level, заборонені імена, caps), будує manifest.
- [ ] `write_archive(payload, out_dir)`: детермінований tar.gz + `.sha256`.
- [ ] CLI `package_runtime.py --repo . --dist <d> --modules <nm> --out <dir> --repo-slug ... --sha ... --workflow ... --run-id ... --run-attempt ...`; Node-факти з `node -p` (version, modules), glibc з `os.confstr('CS_GNU_LIBC_VERSION')`.
- [ ] Тести на маленькому синтетичному repo: allowlist/форма скрипта; policy (`.env`, `x.db`, `dist/a.test.js`, зайвий top-level) — відмова з назвою шляху; caps на межі (рівно ліміт — OK, +1 — відмова) через параметризовані ліміти; двічі той самий вхід → однакові байти архіву; `release.json` має точні поля.

### Task 3: `payload-probe.cjs` + `verify_payload.py` — ізольований доказ розпакованого payload

**Files:** create `deploy/release/payload-probe.cjs`, `deploy/release/verify_payload.py`, `deploy/release/test_verify_payload.py`.

- [ ] `verify_payload.py <archive> <sha256-file> <workdir>`: checksum до розпакування; розпаковує у **нову** теку (`tarfile` з `filter='data'` + власні перевірки: тип entry, шлях, link); `verify_tree`; `release.json` проти очікуваного SHA (`--sha`); далі Node-проби з `env -i PATH=/usr/bin:/bin HOME=<scratch>`, `cwd` = payload, `NODE_PATH` порожній.
- [ ] `payload-probe.cjs` (копіюється у scratch, не в payload; усе вантажить з payload root, переданого аргументом): `native` — better-sqlite3 `:memory:` open/`select sqlite_version()`/close; `migrate` — `dist/storage/db.js` `openDb` + `dist/storage/schema.js` `migrate` двічі на temp DB, версія не рухається, `foreign_key_check` порожній, `integrity_check` ok; `assets` — `hono` payload + `dist/api/routes/fest-print.js`: `GET /fest-print` і `/fest-print/niimbluelib.min.js` → 200 і тіло побайтово рівне файлам payload; `ops` — для кожного entrypoint `require` через `node_modules/tsx/dist/cjs/index.cjs` (шлях передається через env, не argv, бо `cluster-triage` дивиться на `argv[1]`).
- [ ] Startup: `node dist/index.js` з порожнім env у порожній `cwd` мусить завершитися non-zero з ZodError про `TELEGRAM_BOT_TOKEN` — це доводить, що весь статичний граф `dist/index.js` завантажився, і бот не дійшов до мережі.
- [ ] Тести (python, без Node-проб): зіпсований checksum, traversal-entry у tar, підмінений файл після manifest — відмова до виконання payload.

### Task 4: охорона `main` у `adjudicate-runner.ts`

**Files:** modify `scripts/adjudicate-runner.ts`.

- [ ] `if (require.main === module) { main(...)... }` як в інших ops-скриптах; `loadOperatorEnv()` лишається на верхньому рівні (лише читає `.env`). `npm run adjudicate` без аргументів далі друкує usage з exit 2.

### Task 5: job `package` і агрегатор `ci`

**Files:** modify `.github/workflows/ci.yml`; create `scripts/release-workflow.test.ts`.

- [ ] Кроки `package`: checkout → setup-node 24 (cache npm) → `npm ci` → `npx tsc -p tsconfig.release.json --outDir $RUNNER_TEMP/dist` → production install у `$RUNNER_TEMP/prod` (`npm ci --omit=dev` з копії package.json/lock) → CI-аудит `npm audit --omit=dev --json` у `$RUNNER_TEMP/prod` | `tsx scripts/autodeploy/audit-verdict-cli.ts` (exit ≠0 — job red) → `package_runtime.py` → `verify_payload.py` → `actions/upload-artifact` з іменем/retention із Global Constraints.
- [ ] `ci` за Global Constraints.
- [ ] Контракт-тест (рядковий, як `workflow-node-version.test.ts`): job `package` існує з точними `runs-on`, `needs`, `if`, ім'ям artifact, `retention-days: 30`; `ci` має `needs: [build, package]` і формулу з точними рядками. `workflow-node-version.test.ts` має пройти без змін (новий setup-node пінить 24).

### Task 6: `spec.md` і документи

**Files:** modify `spec.md`, `deploy/README.md`.

- [ ] `spec.md` §2: стек Node ≥24 (стара `>=20`); §5.9: абзац «CI публікує runtime artifact» — що в ньому, ім'я, retention, що хост його **поки не використовує** (Ядро-2), і що `ci` на `main` тепер вимагає `package`.
- [ ] `deploy/README.md`: короткий розділ про artifact і локальну перевірку `verify_payload.py`.

## Після ядра

Наскрізне рев'ю Ядра-1 (формат manifest, policy, проби). Лише потім — план Ядра-2 (host admission/publication/audit/probe/trial/activation/rollback) проти вже існуючого `tree_manifest.py`.
