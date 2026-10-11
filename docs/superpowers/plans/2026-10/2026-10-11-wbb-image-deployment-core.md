# Деплой образом — ядро: образ у CI, правила сумісності, підготовка застосунку — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI на кожен push у `main` публікує атестований образ `ghcr.io/ysilvestrov/warsaw-beer-bot@sha256:…` з міткою `wbb.content`, перевірений smoke-ом; на PR той самий образ збирається й перевіряється без публікації. Правила двокрокових міграцій записані й підкріплені лінтером. Застосунок готовий працювати в контейнері (`WBB_OPERATOR_UID`, Node процесу в статусі). **Хост не змінюється:** merge-deploy і далі збирає на хості, образи ніхто не тягне.

Спека: `docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md` (редакція 2) — §3.1, §3.2 (перелік `Volume=`, UID оператора), §4.1, §4.2 (аудит в образі), §6.2, §6.5, §10, §8 п.1.

**Tech Stack:** GitHub Actions, Docker (buildx), `actions/attest-build-provenance`, Python ≥3.12 stdlib (пакувальник), TypeScript/Vitest.

## Рішення

1. **Job `image` замінює `package`.** Ті самі кроки збирання payload-у (`npm ci`, `tsc -p tsconfig.release.json`, production `npm ci`, CI-аудит, `package_runtime.py`, `verify_payload.py`) лишаються — але всередині build-stage `deploy/image/Dockerfile`, щоб native-модуль збирався під тим самим glibc, що й runtime (bookworm). Артефакт Actions (`wbb-release-*`) більше не публікується: споживача немає.
   - На PR: build + smoke, без push і атестації.
   - На push у `main`: build + smoke + push у GHCR (тег `<sha>`) + `actions/attest-build-provenance` з `push-to-registry: true`; digest — у логі й summary.
   - Агрегатор `ci` вимагає `image=success` завжди (раніше `package` міг бути `skipped` на PR).
2. **Один маніфест.** `docker buildx build --platform linux/amd64 --provenance=false --sbom=false` → digest — маніфест одного образу, не index (спека §1 п.1, §3.3). Атестація — окремо, через referrers.
3. **Base-образи за digest** з `mirror.gcr.io/library/node:24-bookworm@sha256:…` і `…-slim@sha256:…`. Dependabot `docker` для `deploy/image/` — окремий запис у `.github/dependabot.yml`.
4. **`wbb.content`** (спека §4.1) = sha256 від канонічного рядка: відсортовані `path type mode sha256` усіх записів `tree-manifest.json`, **крім** `release.json` (несе SHA, run, attempt), плюс рядок `base <digest runtime base-образу>`. `tree-manifest.json` сам у собі не перелічений. Функцію `content_digest(manifest, base_digest)` дає `tree_manifest.py`; `package_runtime.py` пише результат у `<out>/content-digest`. Мітку ставить CI другим шаром: `FROM <id>` + `LABEL wbb.content=…` (значення відоме лише після збирання payload-у).
5. **В образі** (`/app`): payload як є + `deploy/trial-migrate.cjs` + `scripts/autodeploy/audit-verdict.ts` і `audit-verdict-cli.ts` (через новий `EXTRA_SCRIPTS` у `package_runtime.py`, щоб вони пройшли той самий allowlist/manifest, а не окремим `COPY`) + `deploy/image/start-check.cjs` (§6.3 спеки: старт до `api listening`, `/health` зсередини). Права `a-w`, `HOME=/tmp`, `NODE_ENV=production`, `CMD ["node","dist/index.js"]`. `USER` не задаємо: UID дає Quadlet.
6. **Шаблон Quadlet** `deploy/image/warsaw-beer-bot.container` кладемо вже тепер — як джерело переліку `Volume=` для тесту (§3.2 спеки); на хост його ставить план переходу. Суфікс `.container` не потрапляє під hold-шаблони — і не повинен, доки файл ніде не встановлений.
7. **Лінтер міграцій** `scripts/migrations/contract-lint.ts` у workflow `deploy-hold`: міграції з версією > max версії бази PR; SQL з `DROP`, `RENAME`, `INSERT INTO … SELECT`, `UPDATE`, `DELETE` (регістронезалежно, поза коментарями) вимагає мітки `migration:contract`; мітка `migration:contract` або `rollback:unsafe` вимагає `[deploy:hold]` у заголовку й мітки `deploy:hold`. Повідомлення прямо каже, що лінтер — сигнал для рев'ю (§6.5).
8. **`WBB_OPERATOR_UID`** — необов'язковий ключ `.env`, ціле ≥ 0; передається як `testDiagnosticsUid`. Без нього — як зараз (`/usr/bin/id -u ysi`). До `EXPECTED_PROD_KEYS` не входить (на flat-хості не потрібен; план переходу додасть його в `.env`).
9. **Node у статусі** — версія процесу (`process.versions.node`), а не `packages.nodejs` хостового звіту. На flat-хості це те саме число; у контейнері — правильне. Хостовий збирач і його `packages` не змінюються в цьому плані (додати `podman` — план переходу).
10. **Перенесення пакувальника в `scripts/release/`** (спека §11) — у плані переходу, разом із видаленням решти `deploy/release/`: зараз його модулі імпортують одне одного, а зміни `deploy/release/**` hold не дають (`isHoldPath`/`path_is_held` їх не перелічують).

## Таблиця «заявка → доказ» (що записує це ядро)

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| Образ `<sha>` у GHCR + атестація | Байти зібрав `ci.yml` з коміту `<sha>` на `main` | `attest-build-provenance` (підпис Sigstore, Rekor); перевірка на хості — план переходу (V3 у спеці) | сильний |
| `image=success` | Образ зібрано й пройшов smoke | Smoke у job: старт read-only без мережі з `releaseSha`, trial на фікстурі, start-check, ops, audit-verdict на фікстурах | сильний для перелічених перевірок |
| `wbb.content` рівні ⇔ runtime той самий | Різниця у вмісті `/app` (крім `release.json`) чи в base-образі змінює мітку | Тест `content_digest` на 4 випадки спеки §4.1 + незмінність при різних SHA/run | сильний |
| Лінтер міграцій зелений | Нічого про сумісність | — | сигнал рев'ю (§6.5) |
| `Volume=` покриває шляхи-літерали | Кожен абсолютний шлях у `src/` (не тести) має `Volume=` у шаблоні | Vitest-тест, що звіряє | сильний для літералів |

## Global Constraints

- Правила тестів CLAUDE.md; гейт `npm test && npm run typecheck` від `tester`, `npm test -- scripts/release.test.ts` від root; Python-набір ≤90 с.
- `docker` у тестах гейту **не** використовується: образ перевіряє CI-job. Локально агент може зібрати образ для самоперевірки (CA для npm за проксі — `--secret id=ca`, як у пробі), але гейт від цього не залежить.
- PR **без** `[deploy:hold]`: жоден змінений шлях не встановлюється на хост, `.env` не потребує кроку.
- Мітки `migration:contract` і `rollback:unsafe` створює контролер у репо перед PR (операційний крок).

---

### Task 1: `content_digest` і додаткові скрипти в payload-і

**Files:** `deploy/release/tree_manifest.py` (+ `test_tree_manifest.py`), `deploy/release/package_runtime.py` (+ `test_package_runtime.py`), `scripts/deploy-rsync.test.ts` (якщо перелік файлів payload-у звіряється там).

- [ ] Тести спершу: `content_digest(manifest, base)`:
  (а) два маніфести, що відрізняються лише записом `release.json`, → однаковий;
  (б) зміна `base` → різний;
  (в) зміна sha256 одного файлу (asset) → різний;
  (г) видалення запису → різний;
  (ґ) зміна `mode` → різний;
  (д) порядок записів у вході не впливає;
  (е) точне значення для фіксованого маленького маніфесту (тест фіксує формат канонічного рядка — щоб зміна формату була свідомою).
- [ ] `package_runtime.py`: `EXTRA_SCRIPTS = ('scripts/autodeploy/audit-verdict.ts', 'scripts/autodeploy/audit-verdict-cli.ts')` потрапляють у payload і маніфест; `--base-digest` (обов'язковий, формат `sha256:`+64 hex) → `<out>/content-digest`. Тест: payload містить обидва файли; `content-digest` = `content_digest(manifest, base)`; кривий `--base-digest` → `PackagingError`.
- [ ] Мутації: включити `release.json` у content → (а) червоний; забути base → (б); сортування прибрати → (д).
- [ ] Гейт, коміт.

### Task 2: Dockerfile, start-check і шаблон Quadlet

**Files:** нові `deploy/image/Dockerfile`, `deploy/image/start-check.cjs`, `deploy/image/warsaw-beer-bot.container`, `.dockerignore`; тест `scripts/image-volumes.test.ts`.

- [ ] `Dockerfile`: build-stage `node:24-bookworm@sha256:…` (з `mirror.gcr.io`) — `npm ci`, `tsc -p tsconfig.release.json`, production `npm ci`, `package_runtime.py … --base-digest <runtime digest з ARG>`, `verify_payload.py`; runtime-stage `node:24-bookworm-slim@sha256:…` — `COPY payload/ /app/`, `trial-migrate.cjs`, `start-check.cjs`, `chmod -R a+rX,a-w /app`. `ARG SOURCE_SHA RUN_ID RUN_ATTEMPT`; мітки `revision`, `source`. Необов'язковий `--secret id=ca` для локальних збірок за TLS-проксі (як у пробі).
- [ ] `start-check.cjs`: запускає `node dist/index.js` дочірнім процесом з поточним оточенням, чекає рядка `api listening` (таймаут з аргументу, за замовчуванням 60 с), робить `GET http://127.0.0.1:$API_PORT/health`, друкує `START OK <releaseSha>` або `START FAILED <причина + хвіст stderr>`, зупиняє дочірній процес SIGTERM. Exit 0/1/64. Тест (Vitest) з фейковим «ботом» (маленький cjs, що друкує `api listening` і слухає порт / падає / мовчить): OK, падіння → FAILED з хвостом, таймаут → FAILED, `/health` не `ok` → FAILED.
- [ ] Шаблон `warsaw-beer-bot.container` за спекою §3.2 (з плейсхолдерами `@@DIGEST@@`, `@@UID@@`, `@@GID@@`; хелпер переходу підставлятиме їх).
- [ ] `scripts/image-volumes.test.ts`: збирає абсолютні шляхи-літерали (`'/var/…'`, `'/etc/…'`, `'/run/…'`, `'/home/…'`) з `src/**/*.ts` без тестів; кожен має префікс одного з `Volume=` шаблону, або в явному списку винятків із причиною (`/usr/bin/id` — бінарь образу; `/proc/...` — якщо з'явиться). Тест падає на новий шлях без `Volume=` (мутація: прибрати `Volume=/var/tmp/wbb-resource-monitor` → червоний).
- [ ] Гейт, коміт.

### Task 3: job `image` у CI, атестація, Dependabot

**Files:** `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/image-smoke.sh` (+ тести workflow-структури, якщо такі є в `scripts/*workflow*.test.ts`).

- [ ] Job `image` (needs `build`): `permissions` на рівні job — `contents: read`; на `main` додатково `packages: write`, `id-token: write`, `attestations: write` (job-level permissions однакові для обох подій; push/attest-кроки під `if:` main-push).
- [ ] Кроки: buildx build (`--platform linux/amd64 --provenance=false --sbom=false --load`) → `scripts/image-smoke.sh <image>` → витяг `content-digest` (`docker run --rm --network=none <id> cat /app/.content-digest`, або з `/app/tree-manifest.json` — як вирішить Task 1) → другий шар `LABEL wbb.content=…` → на main: push `ghcr.io/ysilvestrov/warsaw-beer-bot:<sha>`, digest з `docker buildx imagetools inspect`/`RepoDigests`, `attest-build-provenance` (`subject-name`, `subject-digest`, `push-to-registry: true`), рядок `IMAGE-DIGEST sha=<sha> digest=<d> content=<c>` у лог і summary.
- [ ] `scripts/image-smoke.sh` (усі кроки з `--read-only --network=none --tmpfs /tmp --user 999:999` і підставним оточенням — спека §6.3):
  1. `node deploy/image/start-check.cjs` → `START OK <sha>` з правильним `releaseSha`;
  2. trial: створити БД через `openDb`+`migrate` образу, потім `trial-migrate.cjs /app <db>` → `TRIAL OK`;
  3. `node deploy/release/payload-probe.cjs native|assets|ops …` з `WBB_PAYLOAD=/app` (як `verify_payload.py`);
  4. `audit-verdict-cli.ts` на фікстурах `scripts/autodeploy/fixtures/npm-audit/*` → очікувані коди 0/10/інше;
  5. `touch /app/x` → провал (read-only).
- [ ] Агрегатор `ci`: `needs: [build, image]`, вимагає `image=success` на будь-якій події.
- [ ] Видалити job `package` і `upload-artifact`.
- [ ] `.github/dependabot.yml`: `package-ecosystem: docker`, `directory: /deploy/image`, щотижня.
- [ ] Перевірка: PR-run (build+smoke зелені) у CI цього PR; push-частину перевіряє перший main-run після мерджу (опис PR каже, що дивитися).
- [ ] Гейт, коміт.

### Task 4: лінтер міграцій і правила

**Files:** нові `scripts/migrations/contract-lint.ts` (+ тест), `.github/workflows/deploy-hold.yml`, `CLAUDE.md`, `spec.md` (розділ про схему/міграції).

- [ ] `contract-lint.ts`: вхід — SQL нових міграцій (з `MIGRATIONS` поточного `src/storage/schema.ts`, версії > `--base-max`), мітки PR, заголовок. Вихід: `ok` / список проблем. Правила — Рішення п.7. Коментарі `--` і `/* */` вирізаються перед пошуком; слово всередині ідентифікатора (`updated_at`, `deleted`) не спрацьовує (межі слова). Тести: expand-міграція (`CREATE TABLE`, `ADD COLUMN … DEFAULT`, `CREATE INDEX`) → ок без міток; `DROP TABLE` без мітки → проблема; з `migration:contract` без `[deploy:hold]` → проблема; з обома → ок; `UPDATE` у коментарі → ок; колонка `updated_at` → ок; `rollback:unsafe` без hold → проблема; старі міграції (≤ base) не перевіряються.
- [ ] `--base-max`: workflow бере `git show HEAD^1:src/storage/schema.ts` і максимальну `version:` звідти (функція в тому ж скрипті, з тестом на рядку-фікстурі).
- [ ] Workflow `deploy-hold`: другий крок після чинного; повідомлення провалу каже «лінтер — сигнал для рев'ю».
- [ ] `CLAUDE.md`: пункт «Відкат лише коду: двокрокові міграції» — expand/contract, contract-дані без SQL (§6.2), `rollback:unsafe`, цільовий тест сумісності, що лінтер не доказ. `spec.md`: те саме коротко біля опису схеми.
- [ ] Гейт, коміт.

### Task 5: застосунок у контейнері — UID оператора і Node процесу

**Files:** `src/config/env.ts` (+ тест), `src/jobs/daily-status.ts` / місце, що будує `StatusInputOptions` (+ тест), `src/domain/status/host-upstream.ts` (+ тест), `.env.example`, `spec.md` (розділ статусу).

- [ ] `WBB_OPERATOR_UID`: `z.coerce.number().int().min(0).optional()`; доходить до `readTestDiagnostics(..., trustedUid)`. Тести: є → `id` не викликається (ін'єкція), значення доходить; немає → поведінка як зараз; `-1`/`abc` → помилка конфігу.
- [ ] Node у статусі: функція правил отримує `runtimeNode: string` (з `process.versions.node` у місці збирання входів) замість `packages.nodejs`; правило те саме (security-реліз старший за N днів → червоний). Тести: точні рядки для «актуальний», «старіший за безпековий < N днів», «> N днів»; `packages === null` більше не ховає Node-рядок. Litestream-рядок і далі з `packages`.
- [ ] Гейт, коміт.

### Task 6: документи

**Files:** `spec.md` §5.9 (абзац «Runtime artifact» → «Образ»: CI публікує атестований образ, хост ще не використовує), `deploy/README.md` (розділ «Runtime artifact» → «Runtime image (CI only)»: що в образі, як перевірити атестацію вручну: `gh attestation verify oci://ghcr.io/ysilvestrov/warsaw-beer-bot@<d> --repo … --signer-workflow … --source-ref refs/heads/main --source-digest <sha> --deny-self-hosted-runners`), рядок статусу в спеці 2026-10-11.

- [ ] Текст; гейт; коміт.

## Після: вхід для плану переходу

- Перший main-run після мерджу: digest, `wbb.content`, атестація — перевірити з хоста командою з README (це й закриває відкритий пункт §12 п.3 спеки частково: `.ImageDigest` після pull).
- Звіт preflight `finish`, перелік автоматичних ops-шляхів.
- Хелпер `wbb-image`, sudoers, переписаний `autodeploy.sh` (стан `image-state.env`, таблиця §7.2), Quadlet на хості, `WBB_OPERATOR_UID` у `.env`, `podman` у збирачі, перенесення пакувальника в `scripts/release/` і видалення решти `deploy/release/` та встановленого з #834.
