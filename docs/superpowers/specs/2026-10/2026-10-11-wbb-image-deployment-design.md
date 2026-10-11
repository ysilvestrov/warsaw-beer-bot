# Warsaw Beer Bot: деплой OCI-образом і відкат лише коду

**Статус:** чернетка до рев'ю власника, 11.10.2026. Рішення власника 11.10: варіант Б (образ + Podman Quadlet, rootful з root-хелпером) і двокрокові міграції.
**Замінює:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md` як шлях до production. Змерджене за ним (Ядра 1–2в, обв'язка А–Б, етап В-ядро) лишається історією; що з нього переходить, а що видаляється — §9.
**Вхідні дані:**
- дослідження варіантів `docs/investigations/2026-10-11-deployment-options-evaluation.md` (spike, SHA `003f9c7`) і рев'ю до нього в сесії 11.10;
- preflight VPS 11.10 (план `docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md`, розділ «Preflight»);
- проба варіанта Б на VPS 11.10 (`wbb-oci-probe.sh`, образи CI-run 38171325392), §2.

**Мета:** прибрати збірку й `npm ci` з production — і з деплою, і з відкату — найменшою кількістю власного коду, зберігши гейти merge-deploy (мердж = деплой, holds, quiet main, CI exact SHA, failed-SHA, regression fence, вікно спостереження).

---

## 1. Рішення

1. **Що деплоїться.** OCI-образ, зібраний у CI на кожен push у `main`, у `ghcr.io/ysilvestrov/warsaw-beer-bot` (публічний пакет). Хост тягне його **за digest** і запускає через **Podman Quadlet** як той самий системний юніт `warsaw-beer-bot.service`. Код у контейнері read-only.
2. **Чому вірити образу.** `actions/attest-build-provenance` у CI; на хості `gh attestation verify` від оператора з `--repo`, `--signer-workflow …/ci.yml`, `--source-ref refs/heads/main`, `--source-digest <sha>`, `--deny-self-hosted-runners`. Плюс чинний гейт: `ci=success` саме на цьому SHA.
3. **Хто вирішує, коли деплоїти.** Чинний `deploy/autodeploy.sh` (bash, працює в production з 30.09). Змінюються лише його seam-и: збірка → pull+verify, деплой → активація образу, trial → контейнер, відкат → попередній образ. Python-контролер `deploy/release/` до production не доводиться (§9).
4. **Привілеї.** Podman rootful. Таймер працює від `ysi` і кличе root-хелпер `wbb-image` через `sudo -n`, по одному правилу sudoers на дію. Хелпер не приймає від оператора ні шляхів, ні довільних аргументів podman (§5). Rootless розглянуто й відкинуто (§11).
5. **Контракт відкату: лише код.** Автоматичний відкат — це запуск **останнього settled образу** на тій самій БД. БД автоматично не відновлюється ніколи. Це можливо, бо міграції йдуть у два кроки (expand/contract, §6), а перед кожним деплоєм хост перевіряє, що settled образ стартує на мігрованій копії (compat-перевірка, §6.3).
6. **Знімок БД перед деплоєм лишається** — як резервна копія для людини (відновлення після зламаної міграції), а не як крок автоматики.

## 2. Що вже доведено пробою на VPS (11.10)

| # | Питання | Результат |
|---|---|---|
| V1 | Мережа з VPS | GHCR, `tuf-repo-cdn.sigstore.dev`, `api.github.com` доступні |
| V2 | Pull за digest без логіна | 5–6,5 с на образ; образ 447 MB, два варіанти разом 660 MB на диску |
| V3 | Атестація через `gh` оператора | Наш образ проходить; чужий репо (404), чужий workflow і чужий ref (`expected SourceRepositoryRef to be refs/heads/main`) — відмова |
| V4 | Trial в образі | `TRIAL OK` на свіжому pre-знімку за 0,6 с; не видно `.env`, `/var/lib/warsaw-beer-bot`, `/etc/wbb-deploy`, `/home/ysi`; 0 змінних `*TOKEN`; `/app` read-only |
| V5 | Справжній бот з образу (реальний `.env`, `--network=none`, read-only, UID бота) | `releaseSha` правильний, усі стартові backfill-и, `bot launched`, `api listening`; жодних EROFS/EACCES |
| V6 | Quadlet під systemd 255 / Podman 4.9.3 | `Type=notify`; рестарт: TERM → EXIT → START (старий вийшов до старту нового), 1,8 с; зупинка 1,7 с; `NRestarts` росте після `kill -9` |
| V7 | Відкат без реєстру | Перехід на інший локальний образ із `Pull=never`, коли всі реєстри недоступні; контрольний pull через той самий проксі падає |
| V8 | Накладні витрати | conmon 2,6 MB RSS |

Не доведено пробою: 24-годинний цикл кронів у read-only контейнері (звіт preflight `finish`, §10 п.1); `sudo` + бінарний stdin більше не потрібен (хелпер не бере даних від оператора).

## 3. Архітектура

```
push у main ─► CI: build + test + image job ─► ghcr.io/…/warsaw-beer-bot@sha256:D  (+ атестація, тег <sha>)
                                                          │
таймер (ysi) ─► autodeploy.sh: quiet main, CI exact SHA, holds, fence, failed-SHA
                 ├─ resolve тег <sha> → digest D; gh attestation verify D (source X, main, ci.yml)
                 ├─ sudo wbb-image pull --sha X --digest D        (root: podman pull @D, label revision == X)
                 ├─ знімок pre (чинний db-snapshot.sh)
                 ├─ sudo wbb-image trial --digest D --previous S --snapshot <name>
                 │      TRIAL: кандидат мігрує копію двічі   COMPAT: S стартує на мігрованій копії
                 ├─ sudo wbb-image activate --digest D            (tag :current = D, restart юніта)
                 ├─ вікно 10 хв: health + releaseSha == X + NRestarts
                 └─ settled: S := D      | провал: sudo wbb-image activate --digest S  (БД не чіпаємо)
```

### 3.1 Образ

- Збирається в CI job `image` у `.github/workflows/ci.yml` після зелених перевірок. Build-stage — `node:24-bookworm` (better-sqlite3 13 компілюється з джерел), runtime — `node:24-bookworm-slim`; обидва за **digest**, з `mirror.gcr.io` (анонімний Docker Hub давав 429).
- Вміст `/app` — той самий payload, що збирає `package_runtime.py` (dist, production `node_modules`, ops-джерела з allowlist, `src/api/fest-print`, `release.json`, `tree-manifest.json`), плюс `deploy/trial-migrate.cjs` і скрипт compat-перевірки. Права `a-w`.
- Мітки: `org.opencontainers.image.revision=<sha>`, `org.opencontainers.image.source`.
- Тег `<sha>` — лише для пошуку digest-у; довіра — до digest-у через атестацію.
- Smoke образу в CI: старт з `--read-only --network=none`, `releaseSha`, trial на фікстурі, ops-команди резолвляться (те, що робить `payload-probe.cjs`).

### 3.2 Юніт

- `/etc/containers/systemd/warsaw-beer-bot.container` (Quadlet) генерує `warsaw-beer-bot.service`. Чинний `/etc/systemd/system/warsaw-beer-bot.service` видаляється при переході — інакше він перекриває згенерований.
- Ключі: `Image=localhost/warsaw-beer-bot:current`, `Pull=never`, `User=`/`Group=` бота, `ReadOnly=true`, `Tmpfs=/tmp`, `DropCapability=ALL`, `NoNewPrivileges=true`, `Network=host`, `EnvironmentFile=/etc/warsaw-beer-bot/.env`, `Volume=` за переліком нижче; `[Service] Restart=on-failure`, `TimeoutStopSec=20`.
- **Що бот бачить із хоста** (повний перелік абсолютних шляхів у `src/`, 11.10):
  - `/var/lib/warsaw-beer-bot` — rw (БД, медіа, логи тріажу, OAuth MCP);
  - `/var/lib/wbb-host-patch` — rw (запит перезавантаження, `src/jobs/reboot-request.ts`);
  - `/var/tmp/wbb-host-patch` — ro (підсумок збирача патчів, `src/jobs/host-patch.ts`);
  - `/var/tmp/wbb-resource-monitor` — ro (підсумок монітора ресурсів, `src/jobs/test-diagnostics.ts`).
  Новий абсолютний шлях у `src/` без відповідного `Volume=` — помилка, яку ловить smoke образу в CI (тест звіряє перелік).
- **UID оператора.** `test-diagnostics.ts` визначає довіреного власника підсумку через `/usr/bin/id -u ysi`; у контейнері користувача `ysi` немає. UID передається конфігом (новий необов'язковий ключ `.env`, напр. `WBB_OPERATOR_UID`), а `id` лишається запасним шляхом поза контейнером. Bind-mount у rootful Podman без userns зберігає числові UID, тож перевірка власника працює.
- Ім'я юніта й порт не змінюються, тож sudo-правила `systemctl stop/start warsaw-beer-bot`, `NRestarts`, збирач патчів хоста, cloudflared і Litestream працюють як є (Litestream лишається на хості, БД — той самий файл того самого UID).

### 3.3 Ops-команди

- Людина запускає їх у працюючому контейнері: `sudo podman exec warsaw-beer-bot npm run <cmd> …` (той самий образ, `.env` і дані). Обгортка `wbb-ops` — зручність, не межа довіри: оператор і так має `(ALL) ALL` з паролем.
- `cluster-triage` (потребує `gh`) і все, що потребує операторських креденшлів, запускається з checkout-у оператора, як зараз.
- Повний перелік ops-шляхів і runbook-ів (`cd /opt/warsaw-beer-bot …`) — план переходу.

## 4. Гейти й стан (`autodeploy.sh`)

Без змін лишаються: quiet main ≥10 хв, exact-SHA CI, holds за шляхами й міткою, failed-SHA/rearm, regression fence, `ships.sh` (зміни, що не доходять до production, не деплояться), PAUSED, lock, повідомлення, `installed_is_stale` для встановлених копій.

Змінюються:
- **CI-гейт** додатково вимагає `image=success` у тому самому run-і.
- **Аудит залежностей** на момент деплою — у контейнері кандидата (`npm audit --omit=dev --json` з мережею, вердикт тим самим `audit-verdict-cli.ts`), бо `node_modules` на хості більше немає. CI-аудит і щоденний `prod-audit.yml` лишаються.
- **Стан** (`state.env`) отримує `DEPLOYED_DIGEST`, `SETTLED_DIGEST`, `WINDOW_DIGEST`. `DEPLOYED_SHA`/`PREVIOUS_SHA` лишаються для гейтів.
- **Здоров'я**: `wait_healthy` перевіряє ще й `/health.releaseSha == X` (зараз — лише `ok:true`).
- **Відкат** у вікні: `wbb-image activate --digest $SETTLED_DIGEST` і очікування здоров'я з `releaseSha == settled`. Жодних `post`/`restore`/зупинки Litestream.
- **Ручний деплой** `deploy/deploy.sh` стає тонкою обгорткою над тим самим pipeline (`--target`, відмова на брудному checkout-і, `--ack-holds`, `--ack-incompatible` §6.3). Старий rsync/npm-шлях видаляється.
- **Reboot чи падіння посеред деплою**: systemd піднімає той образ, на який указує `:current`; наступний tick продовжує вікно за чинною R2-семантикою (`WINDOW_*` у стані). Активація ідемпотентна (тег + restart), тож повтор безпечний.

## 5. Root-хелпер `wbb-image`

Python stdlib, встановлюється root-owned у `/usr/local/libexec/wbb-image`. Таймер кличе його через `sudo -n`; sudoers — по рядку на дію. Межа довіри — сам хелпер: `*` у sudoers ловить і пробіли, тож хелпер парсить argv строго й відкидає все зайве.

| Дія | Що робить | Перевірки |
|---|---|---|
| `pull --sha X --digest D` | `podman pull ghcr.io/ysilvestrov/warsaw-beer-bot@D` | X — 40 hex, D — `sha256:` + 64 hex; після pull мітка `revision == X` |
| `trial --digest D --previous S --snapshot NAME` | Копія знімка NAME у приватну scratch-теку бота; TRIAL (кандидат D, двічі `migrate`); COMPAT (образ S стартує на мігрованій копії, §6.3) | NAME — ім'я з каталогу знімків, не шлях; D і S — локальні образи нашого репо; `--network=none --read-only --cap-drop=ALL --user <бот> --memory --pids-limit`; секрети не монтуються |
| `activate --digest D` | `podman tag D localhost/warsaw-beer-bot:current`; `systemctl restart warsaw-beer-bot` | D — локальний образ нашого репо |
| `current` | Digest під `:current` і image ID запущеного контейнера | — |
| `prune --keep D…` | Видаляє інші образи нашого репо | Ніколи не видаляє `:current` і передані `--keep` |
| `audit --digest D` | `npm audit` у контейнері D з мережею, без секретів | — |

Вихід — один рядок вердикту, коди як у `wbb_release.py` (0 / 1 лише з вердиктом / 2 `REFUSED:` / 64 / 70 / 75) — адаптер `autodeploy.sh` розрізняє «поганий кандидат» і «збій хоста».

«Образ нашого репо» = локальний образ, отриманий із `ghcr.io/ysilvestrov/warsaw-beer-bot@…` (RepoDigests), з міткою `revision`.

## 6. Міграції: expand/contract і compat-перевірка

### 6.1 Правило

- **Expand-міграція** (дозволена в будь-якому релізі): нова таблиця, нова колонка з `DEFAULT` або nullable, новий індекс, новий тригер, що не відкидає записів старого коду. Попередній код мусить працювати на новій схемі.
- **Contract-міграція** (`DROP`, `RENAME`, перебудова таблиці, `UPDATE`/`DELETE` наявних даних, зміна сенсу значень): лише після того, як реліз, що перестав користуватися старою формою, став **settled у production**. Перейменування = додати → писати в обидва / читати нове → прибрати старе, мінімум у двох релізах.
- **Інваріанти даних** забезпечують ідемпотентні стартові backfill-и (у `src/index.ts` їх уже п'ять), а не одноразові оновлення в міграції: рядки, які запише старий код після відкату, «долікує» наступний старт нового.
- `migrate()` уже мовчки пропускає версії, новіші за відомі коду (`src/storage/schema.ts`), — старий код стартує на новішій схемі.

### 6.2 Лінтер у CI

Новий чек: SQL нових міграцій з `DROP`, `RENAME`, `ALTER TABLE … RENAME`, `INSERT INTO … SELECT` (перебудова), `UPDATE`, `DELETE` вимагає мітки `migration:contract` на PR **і** `[deploy:hold]` (бо такий реліз деплоїть людина, §6.3). Розширює чинний `deploy-hold` чек. Хибний збіг лінтера — привід для мітки, а не для обходу.

### 6.3 Compat-перевірка на хості

У `trial` після міграції копії кандидатом хелпер запускає **settled образ S** на цій мігрованій копії: `--network=none`, read-only, той самий `.env` (без мережі секрети нікуди не дійдуть, V5), `DATABASE_PATH` на копію; чекає рядка `api listening` і відповіді `/health` зсередини контейнера; таймаут 60 с.

- `COMPAT OK` → деплой іде, відкат у вікні — лише коду.
- `COMPAT FAILED` → кандидат **не деплоїться автоматично** (як hold, не як failed-SHA): повідомлення адміну з причиною. Людина деплоїть його вручну `deploy.sh --ack-incompatible`; у такому вікні автоматичного відкату немає (старий код не стартує на новій схемі) — провал означає алерт і ручне відновлення з pre-знімка.
- Чого compat не ловить: семантичних розбіжностей даних (клас v22 — старий код пише рядки без нової семантики). Це закривають §6.1 (backfill-и) і §6.2 (лінтер).

### 6.4 Що прибирається з деплою

Автоматичні `post`/`restore`, зупинка Litestream при відкаті, `mark-rollback`/`mark-unverified` як кроки автоматики, повторні побічні ефекти після відновлення БД (повторний анонс розширення через `job_state.extension_announced_version`, повторні issue orphan-triage через `enrich_failures.issue_number`). `db-snapshot.sh snapshot|prune|restore` лишається для людини.

## 7. Перехід

Окремий план (після рев'ю ядра). Обриси:
1. Ядро (без hold): CI job `image` + атестація + smoke; лінтер міграцій; правило в `CLAUDE.md`. Хост не змінюється; образи публікуються, ніхто їх не тягне.
2. Хост (`[deploy:hold]`): `apt install podman`; хелпер `wbb-image` і sudoers; адаптовані seam-и `autodeploy.sh`; Quadlet-файл. Перший образ-реліз активує людина, при зупиненому таймері; відкату для нього немає (попередній — flat-дерево), лише flat-дерево й старий юніт як ручний fallback. Після 600 с спостереження він стає першим settled.
3. Прибирання: старий `deploy.sh`-шлях, `rsync-filter`, NOPASSWD-правила `rsync`/`chown /opt` у `/etc/sudoers.d/warsaw-beer-bot`, flat-дерево `/opt/warsaw-beer-bot`, встановлене з #834 (`/usr/local/lib/wbb-release`, обгортки, `sudoers.d/wbb-release`, юніти `wbb-tick*`, користувач `wbb-trial`, `/var/lib/wbb-trial`, `/var/lib/wbb-deploy`), код `deploy/release/` (§9).
4. Репетиція відкату на хості до прийняття: навмисно непрацездатний кандидат на окремому тестовому тезі → відкат на settled; без production-провокацій на живому боті — тестовий юніт з копією БД, як у пробі.

## 8. Retention і ресурси

- Локально тримаються: `:current`, settled, кандидат вікна; решта — `prune` після settled. ~0,45 GB на образ, спільні шари.
- Перед pull — `df` на `/var/lib/containers`; менше 5 GiB вільного → відмова з повідомленням (не тиха чистка).
- Pre-знімки — чинне правило (3 settled). GHCR для публічного пакета безкоштовний; політика видалення старих версій у GHCR — пізніше, не блокує.
- Свіжість Node/base: Dependabot `docker` для digest-ів base-образів; PR іде звичайним шляхом `dependabot-qualify`. Тижнева затримка security-патчу Node проти автоматичного unattended-upgrades — свідома ціна (§11).

## 9. Що з чинного коду переходить

| Що | Дія |
|---|---|
| `deploy/autodeploy.sh`, `ships.sh`, `read-env.sh`, `installed-current.sh`, `record-deployed.sh`, `db-snapshot.sh` | Лишаються; seam-и адаптуються (§4) |
| `deploy/trial-migrate.cjs` | Переїжджає в образ |
| `src/release/identity.ts`, `/health.releaseSha`, `WBB_RELEASE_REQUIRED` | Лишаються; у Quadlet `WBB_RELEASE_REQUIRED=true` |
| `deploy/release/package_runtime.py`, `tree_manifest.py`, `payload-probe.cjs` | Лишаються як CI-збирач payload; переносяться з `deploy/release/` у `scripts/release/`, щоб їх зміни не давали hold |
| Решта `deploy/release/*` (контролер, рушій, адаптери, publish/receipt, sandbox, інсталятор) і їхні тести; `wbb-release.sh`, `wbb-tick*`, `sudoers.d/wbb-release`, `install-release.sh` | Видаляються в плані переходу; що з них корисне як ідея (відкат до останнього settled, звірка `releaseSha`), переноситься в bash точково |
| Дизайн 2026-10-08 і його плани | Лишаються історією з позначкою «superseded» |

## 10. Відкриті пункти (до плану переходу)

1. Звіт preflight `finish` (≥24 год від 11.10 14:39 UTC): записи бота й кронів у дерево коду. У контейнері це EROFS — знайдене треба перенести в `/var/lib` до переходу.
2. Перелік ops-команд, які запускає не людина (агенти на хості, крони) з `/opt/warsaw-beer-bot`.
3. Старі checkout-и з `deploy.sh` (preflight): після переходу їхній `rsync --delete` у `/opt` нікому не шкодить (код там більше не живе), але NOPASSWD-правило треба прибрати.

## 11. Розглянуті й відкинуті альтернативи

- **Варіант А** (довести Python-деплоєр, 7,4 тис. рядків): найважча частина (перехід layout-у, legacy capture, репетиції) ще попереду, а кожна правка контролера — hold-крок. Порівняння й оцінки — у дослідженні.
- **Варіант В** (host Node + атестований tarball): лишає native-сумісність із хостовим Node назавжди й ~1,5 тис. рядків власного коду.
- **Docker Compose** замість Quadlet: друга система життєвого циклу поверх systemd і постійний демон.
- **Rootless Podman**: прибрав би root із деплою, але бот став би user-юнітом, і довелося б переробити sudo-правила `systemctl`, порядок із Litestream, збирач патчів, журнали й runbook-и; плюс subuid/subgid і linger. Оператор і так має `(ALL) ALL`, тож виграш малий.
- **Автоматичний code+DB відкат** (чинний контракт): втрачає записи вікна, повторює зовнішні побічні ефекти, потребує зупинки Litestream; з expand/contract і compat-перевіркою він не потрібен.

## 12. Заявка → доказ

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| Образ D — збірка CI коміту X з `main` | Байти D зібрав workflow `ci.yml` цього репо на hosted runner з коміту X гілки `main` | `gh attestation verify` з `--source-digest X --source-ref refs/heads/main --signer-workflow …/ci.yml --deny-self-hosted-runners`; негативні випадки V3 | сильний |
| CI зелений на X | Тести, збірка й образ пройшли саме на X | Чинний exact-SHA гейт + `image=success` у тому самому run-і | сильний |
| Запущено X | Процес бота стартував з образу, чий `release.json` каже X | `/health.releaseSha == X` (читається раз на старті з `/app/release.json`, V5) + image ID контейнера == D (`wbb-image current`) | сильний |
| Ціль відкату S запускається без мережі | Локальний образ S стартує з `Pull=never` | V7 | сильний |
| S працює на мігрованій БД | Старий код стартує й відповідає `/health` на копії, яку мігрував кандидат | Compat-перевірка в кожному деплої (§6.3) | **середній**: старт і health, не семантика даних — доповнюють §6.1 і §6.2 |
| Міграція кандидата проходить на production-даних | `migrate()` двічі на копії pre, цілісність | Чинний `trial-migrate.cjs`, тепер в образі (V4) | сильний |
| Trial не бачить секретів і мережі | Ізоляція контейнера | V4 | сильний |
| Бот бачить усі потрібні йому файли хоста | Кожен абсолютний шлях у `src/` має `Volume=` | Перелік §3.2 (grep 11.10) + тест у CI, що звіряє шляхи з Quadlet-файлом | сильний для шляхів-літералів; шляхи з `.env` покриває preflight (усі в `/var/lib/warsaw-beer-bot`) |
| Код не пишеться під час роботи | Бот і ops не пишуть у `/app` | `ReadOnly=true` робить запис помилкою (EROFS) замість тихої зміни; спостереження за добу — звіт `finish` (§10 п.1) | сильний як примус; доказ «нічого не зламається» — після `finish` |
| Pre-знімок — стан БД на момент T | `VACUUM INTO` + sha256 | Чинний `db-snapshot.sh` | сильний |
| Хелпер працює лише з нашими образами | Не тягне й не запускає чужого | Строгий argv, формати SHA/digest, перевірка RepoDigests і мітки `revision`; тести хелпера | сильний (у межах коду хелпера) |
| Свіжість Node/base | Security-патчі доходять | Dependabot `docker` + merge | **слабкий за природою** (процес, не механізм); свідома ціна §8 |
