# Warsaw Beer Bot: деплой OCI-образом і відкат лише коду

Дата: 2026-10-11 (поправка 3 — 2026-10-21)
Статус: редакція 2 затверджена 11.10.2026; поправка 3 (ручний режим, P4) затверджена 21.10.2026; план ядра «б2» — `docs/superpowers/plans/2026-10/2026-10-21-wbb-image-transition-b2-core.md`
Spec-review: failed (reviewer did not run to completion: ENOENT) — поправка 3, @ 52629e8; codex CLI нема в хмарному середовищі

## Для власника — поправка 3 (21.10): ручний режим контролера і лічильник перезапусків

**Мета.** Дати людині один ручний вхід у той самий контролер, що працює під таймером: ручний деплой,
перший образ-реліз (bootstrap) і закриття інциденту йдуть через той самий стан, ті самі гейти й те
саме 10-хвилинне вікно, а не через окремий скрипт. І виправити вікно: воно пропускало падіння
кандидата на старті.

**Що зміниться для тебе.**
- До стадії «в» — нічого: контролер ще ніде не встановлений, а `deploy/image/deploy.sh` на хості
  відмовлятиме, поки встановлена копія контролера не збігається з checkout-ом.
- Після «в» ручний деплой — та сама команда `bash deploy/deploy.sh` (hold знімається так само, як
  зараз, без нового прапорця). Але вона тепер **триває до 10 хв**: після активації вона сама дивиться
  вікно; перервеш її — вікно доведе таймер.
- Несумісний реліз (`COMPAT FAILED`, мітки `rollback:unsafe`/`migration:contract`) — лише з
  `--ack-incompatible`, і без автоматичного відкату: провал у такому вікні відкриває інцидент.
- Інцидент закривається не одним рядком у стані, а контрольованим вікном: `--resolve-incident
  --settled <sha>` 10 хв дивиться, що вказаний образ справді працює й здоровий; лише тоді він стає
  базою відкату, а утриманий знімок звільняється.
- Перший образ-реліз: `bash deploy/deploy.sh --bootstrap`. Скрипт тягне й перевіряє образ, а коли
  все готово — просить тебе зупинити старий юніт і прибрати його файл; тоді повторний запуск
  активує образ. Простій бота — від зупинки старого юніта до старту образу (~1 хв).

**На чому стоїть рішення.**
- Ручний вхід кличе встановлену копію контролера, розбіжність з checkout-ом — відмова `[вимога
  власника]` (рішення №8, 12.10).
- `systemctl restart` скидає `NRestarts` у 0, `daemon-reload` його не чіпає, навіть коли файл
  юніта змінився `[проба]` (V14, 21.10).
- Хелпер `activate` завжди робить `restart` `[виведення]` (код `wbb_image.py`): тож після активації
  лічильник рахує лише перезапуски самого кандидата.
- Людина, що запускає `deploy.sh`, сама засвідчує, що кроки hold-у виконано — як зараз `[вимога
  власника]` (CLAUDE.md «Hold знімається тим, що людина виконує кроки й запускає `bash deploy/deploy.sh`»).
- Атестація образу вимагає `refs/heads/main`, тож ручна ціль — лише коміт із `main` `[виведення]` (§1 п.2).
- Ніщо, крім юніта бота, sudoers і невикористаного `wbb-release`, не звертається до
  `/opt/warsaw-beer-bot` `[проба]` (V15).

**Ключові рішення.**
1. **Ручний режим — у самому контролері** (`autodeploy.sh --manual …`), `deploy.sh` лише перевіряє
   checkout і кличе встановлену копію. Відкинуто: окремий ручний скрипт з власним станом (два місця,
   що пишуть стан, розходяться — саме від цього тікали з flat-деплоєра) і дешевший варіант «людина
   кличе `wbb-image` за runbook-ом» (помилку оператора ловить лише наступний tick).
2. **`--ack-holds` не буде**: запуск `deploy.sh` і є підтвердженням hold-у, як сьогодні.
   Окремий прапорець вимагається лише там, де людина бере на себе відсутній автовідкат
   (`--ack-incompatible`). Відкинуто: прапорець на кожен hold — змінив би правило CLAUDE.md і
   повідомлення таймера без нового захисту.
3. **Ручний запуск дивиться вікно сам, на передньому плані**, а не віддає його таймеру. Відкинуто:
   «активувати й вийти» — людина пішла б, думаючи, що деплой готовий, за 9 хв до вердикту.
4. **Закриття інциденту — через вікно в режимі `manual`.** Відкинуто: запис `SETTLED` за словом людини
   (рев'ю Codex 12.10: образ, який ніхто не дивився, ставав би ціллю відкату).
5. **База `NRestarts` після активації — нуль**, а не значення до активації. Відкинуто: порівняння
   з лічильником старого контейнера (так в ядрі «б») — пропускає падіння на старті, коли старий
   реліз хоч раз перезапускався.
- Розглянуто стандартне: `InvocationID` як ознака рестарту — відкинуто, бо проба не довела, що
  автоматичний рестарт його міняє, а `NRestarts` доведено.

**Що стане гірше.**
- Ручний деплой довший: ~10 хв замість ~2 (вікно на передньому плані).
- Bootstrap — два запуски з ручним кроком root між ними (прибрати старий юніт) і ~1 хв простою.
- Контролер росте (~+400 рядків) — більше коду під hold.
- До стадії «в» ручний вхід на хості не працює взагалі; перевіряє його лише harness.

**Оцінка.** Власник: M (на кроки 1–3 плану продовження, 21.10). Автор: L — «б2» M (ручний режим ~70%:
чотири входи, кожен із рядками §7.2 і тестами; фікс P4 ~10%; `deploy.sh`, `db-snapshot.sh unmark`,
README ~20%) + «в» M (кроки на хості, репетиція). Розбіжність — один розмір, не зупинка. Дешевший
варіант (M разом): без ручних входів, крім `--resolve-incident`; власник 21.10 вибрав повний ручний режим.

**Питання до власника.** Немає.

---

**Історія статусу:** редакція 2, затверджена власником 11.10.2026; у роботі ядро (план `docs/superpowers/plans/2026-10/2026-10-11-wbb-image-deployment-core.md`: образ у CI, правила сумісності, підготовка застосунку). Уточнення з реалізації ядра: `start-check` передзавантажує в бота `offline-telegram.cjs`, що терпить лише відмову `bot.launch()` на `api.telegram.org` (без мережі вона інакше вбиває процес); будь-яка інша необроблена відмова — `START FAILED` — це стосується START (D) і COMPAT (S) §6.3; `verify_payload.py` в образі не працює (Python 3.11 bookworm без tar-фільтра), його проби робить smoke готового образу; `trial-migrate.cjs` і `start-check.cjs` лежать поза маніфестом і не входять у `wbb.content`; runtime-digest — літерал у `FROM` (Dependabot), build-arg береться з нього. Ядро змерджене (PR #842, `4bb79e8`); проби 12.10 на справжньому образі (V9–V13 у §2) закрили §12 п.1 і п.3 і дали дві поправки: START не шле сигналів усередині контейнера (§6.3, AppArmor хоста) і `PodmanArgs=--stop-timeout=20` у шаблоні (§3.2); план ядра переходу — `docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md` (змерджено, PR #858); ядро стадії «б» (новий контролер `deploy/image/autodeploy.sh`, ще не встановлений) — `docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md`. Рішення власника 11.10: варіант Б (образ + Podman Quadlet, rootful з root-хелпером) і двокрокові міграції. Редакція 2 враховує зовнішнє рев'ю (Codex, на `fa9ceca`): межа compat-перевірки, режим вікна в стані, таблиця відновлення, джерело «що деплоїться» замість `rsync-filter`, старі checkout-и, ланцюжок digest → ID, аудит в образі, Node у моніторингу, підставне оточення, Quadlet-ключі, утримання знімків.
**Замінює:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md` як шлях до production. Змерджене за ним (Ядра 1–2в, обв'язка А–Б, етап В-ядро) лишається історією; що з нього переходить, а що видаляється — §11.
**Вхідні дані:**
- дослідження варіантів `docs/investigations/2026-10-11-deployment-options-evaluation.md` (spike, SHA `003f9c7`) і рев'ю до нього в сесії 11.10;
- preflight VPS 11.10 (план `docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md`, розділ «Preflight»);
- проба варіанта Б на VPS 11.10 (`wbb-oci-probe.sh`, образи CI-run 38171325392), §2.

**Мета:** прибрати збірку й `npm ci` з production — і з деплою, і з відкату — найменшою кількістю власного коду, зберігши гейти merge-deploy (мердж = деплой, holds, quiet main, CI exact SHA, failed-SHA, regression fence, вікно спостереження).

---

## 1. Рішення

1. **Що деплоїться.** OCI-образ (один маніфест `linux/amd64`, не index), зібраний у CI на кожен push у `main`, у `ghcr.io/ysilvestrov/warsaw-beer-bot` (публічний пакет). Хост тягне його **за digest** і запускає через **Podman Quadlet** як той самий системний юніт `warsaw-beer-bot.service`. Код у контейнері read-only.
2. **Чому вірити образу.** `actions/attest-build-provenance` у CI; на хості `gh attestation verify` від оператора з `--repo`, `--signer-workflow …/ci.yml`, `--source-ref refs/heads/main`, `--source-digest <sha>`, `--deny-self-hosted-runners`. Плюс чинний гейт: `ci=success` саме на цьому SHA.
3. **Хто вирішує, коли деплоїти.** `deploy/autodeploy.sh` (bash, працює в production з 30.09). Гейти лишаються; збірка, класифікація «чи змінилося те, що деплоїться», деплой, trial, вікно й відкат переписуються під образи (§4, §7). Python-контролер `deploy/release/` до production не доводиться (§11).
4. **Привілеї.** Podman rootful. Таймер працює від `ysi` і кличе root-хелпер `wbb-image` через `sudo -n`, по одному правилу sudoers на дію. Хелпер не приймає від оператора ні шляхів, ні довільних аргументів podman (§5). Rootless розглянуто й відкинуто (§13).
5. **Контракт відкату: лише код.** Автоматичний відкат — це запуск **останнього settled образу** на тій самій БД. БД автоматично не відновлюється ніколи. Це спирається на двокрокові міграції (§6) і compat-перевірку перед кожним деплоєм (§6.3), а там, де автоматика сумісності не доводить, — на ручний деплой без автоматичного відкату (§6.4).
6. **Знімок БД перед деплоєм лишається** — як резервна копія для людини (відновлення після зламаної міграції чи інциденту), а не як крок автоматики.

## 2. Що вже доведено пробою на VPS (11.10)

| # | Питання | Результат |
|---|---|---|
| V1 | Мережа з VPS | GHCR, `tuf-repo-cdn.sigstore.dev`, `api.github.com` доступні |
| V2 | Pull за digest без логіна | 5–6,5 с на образ; образ 447 MB, два варіанти разом 660 MB на диску |
| V3 | Атестація через `gh` оператора | Наш образ проходить; чужий репо (404), чужий workflow і чужий ref (`expected SourceRepositoryRef to be refs/heads/main`) — відмова |
| V4 | Trial в образі | `TRIAL OK` на свіжому pre-знімку за 0,6 с; не видно `.env`, `/var/lib/warsaw-beer-bot`, `/etc/wbb-deploy`, `/home/ysi`; 0 змінних `*TOKEN`; `/app` read-only |
| V5 | Справжній бот з образу (`--network=none`, read-only, UID бота) | `releaseSha` правильний, усі стартові backfill-и, `bot launched`, `api listening`; жодних EROFS/EACCES |
| V6 | Quadlet під systemd 255 / Podman 4.9.3 | `Type=notify`; рестарт: TERM → EXIT → START (старий вийшов до старту нового), 1,8 с; зупинка 1,7 с; `NRestarts` росте після `kill -9` |
| V7 | Відкат без реєстру | Перехід на інший локальний образ із `Pull=never`, коли всі реєстри недоступні; контрольний pull через той самий проксі падає |
| V8 | Накладні витрати | conmon 2,6 MB RSS |
| V9 | Справжній образ CI (12.10, `4bb79e8`, `sha256:5da35885…`) | Pull за digest без логіна; `.Digest == D`, мітки `revision == X` і `wbb.content` == `/app/.content-digest`; `gh attestation verify` з `--source-digest X` проходить, а чужий SHA (`expected SourceRepositoryDigest`), чужий ref і чужий workflow — відмова; trial на свіжому pre прод-БД: схема 46 → 47 за 0,5 с; образ 341 MB |
| V10 | Ланцюжок §3.3 і юніт §3.2 під Quadlet | `podman container inspect`: `.Image` == ID I з `image inspect`, `.ImageDigest` == D, `.ImageName`/`.Config.Image` == `ghcr.io/…@D`; `systemctl show`: `SourcePath` = наш `.container`, `FragmentPath` = `/run/systemd/generator/<unit>.service`, `UnitFileState=generated`; `quadlet -dryrun` на справжньому шаблоні без помилок |
| V11 | Сигнали під AppArmor хоста (Ubuntu 24.04, podman 4.9.3, crun 1.14.1, профіль `containers-default-0.57.4-apparmor1`) | Усі процеси контейнера мають мітку `containers-default-…//&crun (mixed)`, і **процес у контейнері не може надіслати сигнал іншому процесу того самого контейнера** (`kill` → EACCES, `apparmor="DENIED" operation="signal"`; і з node, і з `sh`); з `apparmor=unconfined` — може. Сигнали **ззовні** доходять: справжній бот під Quadlet (офлайн, копія БД) на `systemctl stop` пише `shutdown initiated` → `shutdown done`, зупинка 0,2 с, `ExecMainStatus=0`, двічі; відмов ядра при цьому немає |
| V12 | Записи в дерево коду (звіт preflight `finish`, 12.10) | Після останнього старту бота (18 год, що покривають кожен розклад cron у `src/index.ts`, найрідший — раз на добу) — 0 записів у `/opt/warsaw-beer-bot` і 0 EACCES/EROFS/EPERM/ENOENT із `/opt` у журналі бота |
| V13 | Старт справжнього бота на копії прод-БД | `api listening` за ~21 с (з них ~18 с — `dedupe-brewery-aliases`); ліміт START/COMPAT 90 с має запас учетверо |
| V14 | `NRestarts` Quadlet-юніта (21.10, `wbb-host-probe.sh`, тимчасовий юніт `wbb-p4-probe` з busybox, що падає кожні 4 с) | Після трьох автоматичних рестартів 3; `daemon-reload` без змін — 3; змінений `.container` + `daemon-reload` без рестарту — 3; `systemctl restart` — **0**, `InvocationID` інший; далі автоматичний рестарт — 1; послідовність `activate` (змінений файл + `daemon-reload` + `restart`) — **0**. Тож лічильник скидає лише рестарт, а не перегенерація юніта |
| V15 | Хто користується `/opt/warsaw-beer-bot` (21.10, та сама проба) | Юніт `/etc/systemd/system/warsaw-beer-bot.service`, процес бота, `/etc/sudoers.d/warsaw-beer-bot` і встановлений `/usr/local/lib/wbb-release/wbb_release.py` (типові `releases`/`staging` у `/opt`; таймер `wbb-tick` не ввімкнений — конвеєр не працює). Cron (лише `resource_monitor`), інші таймери, `/usr/local/bin`, домашні скрипти — ні. Копії репо без захисту `state.env` у `deploy.sh`: worktree `~/warsaw-agy-bb/.worktrees/cluster-triage`, `~/wbb-sol-default` і п'ять копій у `/root` (квітень–травень, частина з незакоміченими змінами). Хелпер `wbb-image` встановлено того ж дня після проби |

Проба V5 ішла з реальним `.env` (без мережі); у робочій схемі compat і trial отримують підставне оточення (§6.3). Пункти, що лишалися недоведеними після 11.10, закриті 12.10: цикл кронів — V12, ланцюжок §3.3 — V10. V11 змінив механізм START (§6.3): чинний `start-check` зупиняв бота сигналом зсередини контейнера й на цьому хості не проходив би ніколи.

## 3. Архітектура

```
push у main ─► CI: build + test + job image ─► ghcr.io/…/warsaw-beer-bot@sha256:D (+ атестація, тег <sha>, мітка content)
                                                         │
таймер (ysi) ─► autodeploy.sh: quiet main, CI exact SHA, holds, fence, failed-SHA, incident
                 ├─ resolve тег <sha> → D; gh attestation verify D (source X, main, ci.yml)
                 ├─ sudo wbb-image pull --sha X --digest D       (root: pull @D; revision == X; ID I)
                 ├─ content(D) == content(deployed)? → noop, без рестарту (§4.1)
                 ├─ sudo wbb-image audit --digest D
                 ├─ знімок pre (db-snapshot.sh)
                 ├─ sudo wbb-image trial --digest D --previous S --snapshot <name>   → TRIAL, COMPAT (§6.3)
                 ├─ стан: WINDOW_* з режимом auto|manual (§7) ─► sudo wbb-image activate --digest D
                 ├─ вікно 10 хв: health, releaseSha == X, NRestarts, образ запущеного контейнера == I
                 └─ settled: S := D  │ провал (auto): activate S, БД не чіпаємо │ провал (manual): інцидент (§7.3)
```

### 3.1 Образ

- Збирається в CI job `image` у `.github/workflows/ci.yml` після зелених перевірок, `--platform linux/amd64`, без вкладених buildx-атестацій (щоб digest був маніфестом одного образу, а не index-ом). Build-stage — `node:24-bookworm` (better-sqlite3 13 компілюється з джерел), runtime — `node:24-bookworm-slim`; обидва за **digest**, з `mirror.gcr.io` (анонімний Docker Hub давав 429).
- Вміст `/app` — payload, який збирає `package_runtime.py` (dist, production `node_modules`, ops-джерела з allowlist, `src/api/fest-print`, `release.json`, `tree-manifest.json`), плюс `deploy/trial-migrate.cjs`, скрипт start-перевірки (§6.3) і `scripts/autodeploy/audit-verdict*.ts` (§4.2). Права `a-w`.
- Мітки: `org.opencontainers.image.revision=<sha>`, `org.opencontainers.image.source`, `wbb.content=<sha256>` (§4.1).
- Тег `<sha>` — лише для пошуку digest-у; довіра — до digest-у через атестацію.
- Smoke образу в CI: старт з `--read-only --network=none` і підставним оточенням, `releaseSha`, trial на фікстурі, ops-команди резолвляться, `audit-verdict-cli` на фікстурах (0 / 10 / інше), відповідність абсолютних шляхів у `src/` переліку `Volume=` (§3.2).

### 3.2 Юніт

- `/etc/containers/systemd/warsaw-beer-bot.container` (Quadlet) генерує `warsaw-beer-bot.service`. Його пише лише хелпер (`activate`), з фіксованого шаблону, атомарно, з `Image=ghcr.io/ysilvestrov/warsaw-beer-bot@<D>` — без тегів.
- Ключі: `ContainerName=warsaw-beer-bot` (інакше Quadlet дає `systemd-warsaw-beer-bot`, а `podman exec` і `inspect` у цій спеці звертаються на ім'я); `Pull=never`; `User=<uid>`, `Group=<gid>` бота **числами**; `ReadOnly=true`; `Tmpfs=/tmp`; `DropCapability=ALL`; `NoNewPrivileges=true`; `Network=host`; `EnvironmentFile=/etc/warsaw-beer-bot/.env`; `Environment=WBB_RELEASE_REQUIRED=true`; `Volume=` за переліком нижче; `PodmanArgs=--stop-timeout=20` (Quadlet-ключ `StopTimeout=` у 4.9 ще не підтримується, а `ExecStop=podman rm -f`, який генерує Quadlet, чекає власний тайм-аут контейнера — за замовчуванням 10 с — і лише потім SIGKILL, тож без цього `TimeoutStopSec` нічого не давав би); `[Service] Restart=on-failure`, `TimeoutStopSec=20`; `[Install] WantedBy=multi-user.target` (згенерований юніт не вмикається `systemctl enable` — автозапуск дає саме `[Install]` у Quadlet-файлі).
- Чинний `/etc/systemd/system/warsaw-beer-bot.service` при переході видаляється: юніт у `/etc/systemd/system` перекриває згенерований. Хелпер у `current` і перед кожною активацією перевіряє, що активний юніт згенерований саме з Quadlet-файлу (`systemctl show -p SourcePath,FragmentPath`: `SourcePath` = наш `.container`, `FragmentPath` у `/run/systemd/generator`), інакше `REFUSED` (§8).
- **Що бот бачить із хоста** (усі абсолютні шляхи-літерали в `src/`, 11.10):
  - `/var/lib/warsaw-beer-bot` — rw (БД, медіа, логи тріажу, OAuth MCP);
  - `/var/lib/wbb-host-patch` — rw (запит перезавантаження, `src/jobs/reboot-request.ts`);
  - `/var/tmp/wbb-host-patch` — ro (підсумок збирача патчів, `src/jobs/host-patch.ts`);
  - `/var/tmp/wbb-resource-monitor` — ro (підсумок монітора ресурсів, `src/jobs/test-diagnostics.ts`).
  Smoke у CI звіряє цей перелік із шаблоном Quadlet-файлу; новий шлях-літерал без `Volume=` червонить CI.
- **UID оператора.** `test-diagnostics.ts` визначає довіреного власника підсумку через `/usr/bin/id -u ysi`; у контейнері користувача `ysi` немає. UID передається конфігом (новий необов'язковий ключ `.env` `WBB_OPERATOR_UID`), `id` лишається запасним шляхом поза контейнером. Bind-mount у rootful Podman без userns зберігає числові UID.
- Ім'я юніта й порт не змінюються, тож sudo-правила `systemctl stop/start warsaw-beer-bot`, `NRestarts`, cloudflared і Litestream працюють як є (Litestream лишається на хості; БД — той самий файл того самого UID).

### 3.3 Ідентичність: digest → ID → контейнер

- **D** — registry digest маніфесту (`sha256:…`), той, що перевірила атестація.
- `pull` тягне `ghcr.io/…@D`, перевіряє `podman image inspect … --format '{{.Digest}}' == D` і мітку `revision == X` і повертає локальний **image ID I**.
- `activate` пише в Quadlet `Image=ghcr.io/…@D` (не тег), тож systemd стартує рівно D.
- Перевірка запущеного: `podman inspect warsaw-beer-bot --format '{{.Image}} {{.ImageDigest}}'` дає `I` і `D`; плюс `/health.releaseSha == X`. Стан зберігає і D, і I.

### 3.4 Ops-команди

- Людина запускає їх у працюючому контейнері: `sudo podman exec warsaw-beer-bot npm run <cmd> …` (той самий образ, `.env` і дані). Обгортка `wbb-ops` — зручність, не межа довіри: оператор і так має `(ALL) ALL` з паролем.
- `cluster-triage` (потребує `gh`) і все, що потребує операторських креденшлів, запускається з checkout-у оператора, як зараз.
- Повний перелік ops-шляхів і runbook-ів (`cd /opt/warsaw-beer-bot …`) — план переходу.

## 4. Гейти (`autodeploy.sh`)

Без змін лишаються: quiet main ≥10 хв, exact-SHA CI, holds за шляхами й міткою, failed-SHA/rearm, regression fence, PAUSED, lock, повідомлення, `installed_is_stale` для встановлених копій. CI-гейт додатково вимагає `image=success` у тому самому run-і. Новий гейт: **відкритий інцидент** (§7.3) блокує будь-який деплой.

### 4.1 Що деплоїться: content-мітка замість `rsync-filter`

`ships.sh` і `shipping_paths()` класифікують шляхи за `deploy/rsync-filter` із двох комітів — для образу це неправильне питання. Нове джерело — сам образ:

- CI обчислює **`wbb.content`** = sha256 від (tree-digest payload-у без `release.json` і без поля source-SHA у `tree-manifest.json`) + (digest runtime base-образу) + (sha256 Quadlet-шаблону, якщо він їде в образі) і пише міткою.
- Хост порівнює `wbb.content` кандидата з міткою задеплоєного образу. Рівні → **noop**: записати, що бачили X, без trial і рестарту (як нинішній «не доходить до production»). Різні → деплой.
- Тест у CI (на парах збірок) для кожного випадку:
  - зміна лише digest-у base-образу → мітка різна (деплой);
  - зміна пакувальника чи runtime-asset (`src/api/fest-print`) → різна;
  - видалення runtime-файлу → різна;
  - зміна лише документації (`docs/**`, `*.md` поза payload) → **однакова** (noop).
- `ships.sh`, `deploy/rsync-filter` і `shipping_paths()` видаляються разом із переходом. Holds за шляхами (`gates`/`deploy-hold`) — окремий механізм, вони лишаються.

### 4.2 Аудит залежностей на момент деплою

- `wbb-image audit --digest D`: у контейнері D з мережею (без секретів і без даних) `npm audit --omit=dev --json` → `node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts` (обидва в образі, §3.1; `tsx` — production-залежність).
- Вердикт зберігає чинну відмінність: `0` чисто → далі; `10` advisory high/critical → відмова кандидату (як зараз); будь-що інше (реєстр недоступний, npm упав) → «не вдалося перевірити», повтор на наступному tick-у, не failed-SHA.
- CI-аудит і щоденний `prod-audit.yml` лишаються.

### 4.3 Ручний деплой

`deploy/deploy.sh` стає тонкою обгорткою над ручним режимом самого контролера (§7.4): перевіряє checkout і кличе встановлену копію контролера. Старий rsync/npm-шлях видаляється. (Поправка 3: `--ack-holds`, який називала редакція 2, не вводиться — §7.4.)

## 5. Root-хелпер `wbb-image`

Python stdlib, root-owned `/usr/local/libexec/wbb-image`. Таймер кличе його через `sudo -n`; sudoers — по рядку на дію. Межа довіри — сам хелпер: `*` у sudoers ловить і пробіли, тож хелпер парсить argv строго й відкидає все зайве.

| Дія | Що робить | Перевірки |
|---|---|---|
| `pull --sha X --digest D` | `podman pull ghcr.io/ysilvestrov/warsaw-beer-bot@D`; друкує `PULLED D I content=<…>` | X — 40 hex, D — `sha256:` + 64 hex; `.Digest == D`, мітка `revision == X`; перед pull — ≥5 GiB вільного |
| `audit --digest D` | §4.2, у контейнері з `--network=host` (мережа потрібна npm-реєстру; bridge-мережа rootful podman на хості не перевірена, а host — так, V10), read-only, без `.env`, без томів, UID бота | Образ нашого репо |
| `trial --digest D --previous S --snapshot NAME` | §6.3: TRIAL, START (кандидат), COMPAT (S) на одній копії | NAME — ім'я з каталогу знімків, не шлях; D і S — локальні образи нашого репо; `--network=none --read-only --cap-drop=ALL --user <uid>:<gid> --memory --pids-limit`; підставне оточення, без `.env` |
| `activate --digest D` | Перевірка юніта (§3.2); атомарний запис Quadlet-файлу з `Image=…@D`; `daemon-reload`; юніт після нього не наш → попередній файл відновлюється, `REFUSED`; `systemctl restart warsaw-beer-bot`: ненульовий вихід — `ACTIVATE FAILED` (вихід 1: вердикт про D у production, вікно вважає це провалом), тайм-аут — 75 | Образ нашого репо |
| `current` | `CURRENT quadlet=<D> container-image=<I> container-digest=<D'> unit=quadlet|foreign|absent` (`absent` — юніта нема: перша активація після видалення старого) | — |
| `prune --keep D…` | Видаляє інші образи нашого репо | Ніколи — образ із Quadlet-файлу й `--keep` |

Вихід — один рядок вердикту; коди як у `wbb_release.py`: 0; 1 лише разом із вердиктом про кандидата (`TRIAL FAILED`, `START FAILED`, `COMPAT FAILED`, `AUDIT ADVISORY`, `ACTIVATE FAILED` — `autodeploy.sh` розгалужується за рядком, не за кодом: failed-SHA і hold обидва мають 1); 2 `REFUSED:` (вхід чи передумова); 64; 70 (виняток); **75 — не вдалося перевірити** (podman/OOM/таймаут/нема реєстру). `autodeploy.sh` розрізняє «поганий кандидат», «відмова» і «повторити».

«Образ нашого репо» = локальний образ, у якого `RepoDigests` містить `ghcr.io/ysilvestrov/warsaw-beer-bot@…` і є мітка `revision`.

## 6. Сумісність для відкату лише коду

### 6.1 Що має бути сумісним

Попередній settled реліз S мусить коректно працювати на БД після **усього**, що з нею робить кандидат D:
1. міграції D (`migrate()`);
2. стартові перетворення D (backfill-и, дедуплікація, очищення в `src/index.ts`);
3. записи D під час роботи (нові рядки, нові значення, нові формати JSON у колонках).

### 6.2 Правила для авторів змін

- **Схема.** Expand (нова таблиця; колонка з `DEFAULT` чи nullable; індекс; тригер, що не відкидає записів старого коду) — у будь-якому релізі. Contract (`DROP`, `RENAME`, перебудова таблиці, `UPDATE`/`DELETE` наявних даних, зміна сенсу значень) — лише після того, як реліз, що перестав користуватися старою формою, став settled. Перейменування = додати → писати в обидва / читати нове → прибрати старе, мінімум у двох релізах.
- **Дані.** Зміна формату чи сенсу того, що код **пише** (нове значення enum/класу, новий формат JSON, нова семантика колонки), — це теж contract, навіть без жодного SQL. Такий PR або несе цільовий тест сумісності (старий формат читання/запису лишається валідним: тест на тому, що новий код пише дані, які приймає читач старого формату, і сам приймає старі), або позначається `rollback:unsafe`.
- **Інваріанти** забезпечують ідемпотентні стартові backfill-и, а не одноразові оновлення в міграції. Ідемпотентність потрібна для повторних стартів; зворотної сумісності вона **не** дає — це окрема вимога вище.
- `migrate()` мовчки пропускає версії, новіші за відомі коду (`src/storage/schema.ts`), — старий код стартує на новішій схемі.

### 6.3 Compat-перевірка на хості (межа автоматики)

`wbb-image trial` на одній копії pre-знімка, у трьох кроках, кожен в окремому контейнері з `--network=none`, read-only кодом і **підставним оточенням** (обов'язкові несекретні ключі з фіксованими значеннями — `TELEGRAM_BOT_TOKEN` формату BotFather, але фальшивий, `OSRM_BASE_URL`, `NOMINATIM_USER_AGENT`, `DATABASE_PATH` на копію, `WBB_RELEASE_REQUIRED=true`; решта необов'язкових ключів відсутні — функції вимкнені; реальний `.env` не монтується):

1. **TRIAL**: D мігрує копію двічі, цілісність (чинний `trial-migrate.cjs`).
2. **START (D)**: D стартує на копії до рядка `api listening` і завершення стартових backfill-ів, відповідає `/health` зсередини контейнера. Це **позитивний контроль**: середовище здатне стартувати бота — і водночас застосовує до копії стартові перетворення D (§6.1 п.2). Бота **не зупиняють сигналом**: процес у контейнері не може сигналити іншому процесу того самого контейнера (V11). `start-check --leave-running` друкує вердикт і виходить; він — PID 1 контейнера, тож його вихід розбирає PID-простір, і ядро вбиває бота (SIGKILL ядра AppArmor не перевіряє). Копія після цього не закрита чисто — для WAL-копії, яку наступний крок відкриває заново, це штатно.
3. **COMPAT (S)**: S стартує на тій самій копії й відповідає `/health` (`releaseSha == S`) за 90 с — тим самим `start-check --leave-running`, але **з образу S**. Тож S мусить знати `--leave-running`: образи до цієї поправки ціллю відкату бути не можуть. Перший образ-реліз активує людина без compat (§8 п.2), і він уже з поправкою — далі кожен settled її має.

Вердикти:
- `COMPAT OK` — S стартує після міграцій і стартових перетворень D. Деплой автоматичний, відкат у вікні — лише коду.
- `COMPAT FAILED` — **доведена несумісність**: START (D) пройшов, а S на тій самій копії вийшов із помилкою або не відповів. Кандидат не деплоїться автоматично (як hold, не failed-SHA); повідомлення з причиною й хвостом логу S; людина може задеплоїти вручну (§6.4).
- Не вдалося перевірити (вихід 75: podman, OOM — `START KILLED`, бо в контейнері SIGKILL боту шле лише ядро, V11; таймаут START (D); нема знімка чи його sha256 не збігся) — повтор на наступному tick-у; `--ack-incompatible` **не** пропонується. Таймаут S — це «не відповів», тобто `COMPAT FAILED`: D щойно стартував на тій самій копії в тій самій ізоляції.

Чого автоматика не перевіряє: записів D під час роботи (§6.1 п.3) і семантики даних, яку старий код прочитає без помилки, але неправильно (клас v22). Це закривають правила §6.2, цільові тести й рев'ю.

### 6.4 Коли сумісність не доведена — ручний деплой без автовідкату

Деплой лише людиною, `deploy.sh --ack-incompatible`, якщо: `COMPAT FAILED`; або в діапазоні є PR з міткою `rollback:unsafe` чи `migration:contract`. Такі PR несуть `[deploy:hold]` (автоматика їх і так не деплоїть), а режим вікна — `manual` (§7).

### 6.5 Лінтер у CI — сигнал для рев'ю, не доказ

Чек на SQL нових міграцій (`DROP`, `RENAME`, `UPDATE`, `DELETE`, `REPLACE INTO`, `INSERT OR REPLACE`, `CREATE UNIQUE INDEX`; перебудову таблиці ловлять її `DROP`/`RENAME`, тож окремого правила на `INSERT INTO … SELECT` нема — воно давало хибні спрацювання на сидах нових таблиць, як v42; подія тригера — не оператор, тіло тригера — так) вимагає мітки `migration:contract` + `[deploy:hold]`. Зміни даних у TypeScript він не бачить — тому він лише піднімає питання на рев'ю, а гарантією сумісності не вважається ніде в цій спеці. Розширює чинний `deploy-hold` чек.

### 6.6 Що прибирається з деплою

Автоматичні `post`/`restore`, зупинка Litestream при відкаті, повторні побічні ефекти після відновлення БД (повторний анонс розширення через `job_state.extension_announced_version`, повторні issue orphan-triage через `enrich_failures.issue_number`). `db-snapshot.sh snapshot|prune|restore|mark-rollback` лишається для людини й утримання (§9).

## 7. Стан і відновлення

### 7.1 Стан

Файл стану переїжджає з `state.env` у `image-state.env` (той самий каталог; причина — §8). Ключі:
- чинні гейтові: `DEPLOYED_SHA`, `PREVIOUS_SHA`, `LAST_SEEN_DEPLOYED_SHA`, `LAST_FAILED_SHA`, `MAIN_SEEN_*`, fence-ключі;
- образні: `DEPLOYED_DIGEST`/`DEPLOYED_ID`, `SETTLED_SHA`/`SETTLED_DIGEST`/`SETTLED_ID`;
- вікно (пишеться **до** будь-якої зміни production): `WINDOW_SHA`, `WINDOW_DIGEST`, `WINDOW_PREV_DIGEST` (ціль відкату = settled на момент старту вікна), `WINDOW_MODE=auto|manual`, `WINDOW_PHASE=activating|watching|rolling-back`, `WINDOW_PRE` (знімок), `WINDOW_START`, `WINDOW_BOOT` (boot_id), `WINDOW_NRESTARTS`;
- `INCIDENT=<sha> <digest> <причина>` — відкритий інцидент.

Доповнено ядром стадії «б» (план `docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md`, рішення 3–4):
- `DEPLOYED_CONTENT`/`SETTLED_CONTENT` — мітка `wbb.content` запущеного/settled образу (noop §4.1);
- вікно: `WINDOW_ID`, `WINDOW_CONTENT`, `WINDOW_OLD` (гейтова база до вікна), `WINDOW_FAILS` (поспіль невдалі health), `WINDOW_LAST_READ` (час останнього повністю прочитаного опитування), `WINDOW_REASON`, `ROLLBACK_ATTEMPTS` (пишеться до кожного `activate S`);
- `CANDIDATE_HELD=<X> <D> <S>`/`CANDIDATE_HELD_WHY` — доведена `COMPAT FAILED` для цієї пари образів; `CANDIDATE_RETRY_X`/`CANDIDATE_RETRY_AT` — `trial REFUSED`, повтор через годину;
- `RETAINED_PRE` — позначені `mark-rollback` знімки провальних вікон (імена, які надрукував скрипт);
- `LAST_INCIDENT_NOTICE`;
- `ACTIVATE_ATTEMPTS` — спроби `activate D` у цьому вікні (пишеться до кожної; після трьох — інцидент без вини X);
- `PENDING_PRE` — pre-знімок, зроблений до запису вікна (обрив під час trial): наступний tick без вікна його видаляє;
- `PENDING_MARK` — pre провального вікна, який `mark-rollback` не позначив: кожен tick спершу повторює позначку (щонайбільше дві за tick), **ще до гейту інциденту** — позначка лише утримує доказ і production не змінює, а під час інциденту доказ потрібен найбільше; поки ключ є, `prune` знімків не виконується;
- імена знімків у `WINDOW_PRE`, `PENDING_PRE`, `PENDING_MARK`, `RETAINED_PRE` — абсолютні шляхи `^/[A-Za-z0-9._/-]+-pre[.]db$` (списки — через один пробіл), інакше `STATE CORRUPT`;
- ~~`WINDOW_NRESTARTS_PRE`~~ — прибрано поправкою 3: V14 показав, що `restart` у `activate` скидає лічильник у 0, тож значення до активації (лічильник старого контейнера) нічого не каже про кандидата. На старті спостереження після активації `NRestarts` > 0 — кандидат рестартував під час старту, провал вікна; база вікна — це прочитане значення (тобто 0).
- `WINDOW_KIND=deploy|bootstrap|resolve` (поправка 3, §7.4) — звідки вікно: деплой кандидата (таймер чи ручний), перший образ-реліз, закриття інциденту. `bootstrap` і `resolve` завжди `WINDOW_MODE=manual`; у `bootstrap` `WINDOW_PREV_DIGEST` порожній (відкочуватися нема на що).

Порядок інциденту: перший запис — `INCIDENT` (і `LAST_FAILED_SHA`, коли винен X) **разом із вікном**; потім `mark-rollback`; другим записом — `RETAINED_PRE` і очищення вікна. Вину X (`LAST_FAILED_SHA`) несуть лише провал вікна (зокрема «не вдалося спостерігати»), провал відкату, провал `manual` і `ACTIVATE FAILED`; чужий юніт, Quadlet-файл, що не називає ні S, ні D, і вичерпані спроби активації — інцидент без вини.

Файл розбирається (ніколи не виконується), і перед будь-якою дією перевіряються формат, дублікати й узгодженість полів; пошкоджений файл — `STATE CORRUPT` (вихід 3, нуль дій), ніколи не перший запуск. Запис атомарний із `fsync`.

Режим вікна записаний у стані, тож після reboot чи падіння tick-а він той самий: `manual` ніколи не стає автоматичним відкатом.

### 7.2 Таблиця відновлення

Наступний tick (після падіння tick-а, reboot чи `kill`) читає стан і живі факти (`wbb-image current`: образ у Quadlet-файлі, образ і digest запущеного контейнера, тип юніта; `/health.releaseSha`; `NRestarts`; boot_id):

| Обрив | Що бачимо | Що робимо | Деплої далі |
|---|---|---|---|
| Після запису вікна, до `activate` | `PHASE=activating`, Quadlet = S, працює S | Вікно скасовано; без failed-SHA; кандидат пробує заново наступний tick | Так |
| Після запису Quadlet-файлу, до/під час рестарту | `activating`, Quadlet = D, працює S (або нічого) | Повторити `activate D` (рестарт S → D; D ще не стартував, тож повтор нічого не дублює) і почати вікно | Так |
| Після рестарту, до запису `watching` | `activating`, працює D | `PHASE=watching`, `WINDOW_START=now`, `WINDOW_NRESTARTS` = поточне — повне вікно від зараз, без повторного рестарту | Так |
| Падіння tick-а у вікні, той самий boot | `watching`, працює D | Продовжити вікно; `NRestarts` > записаного → провал (бот падав, поки ніхто не дивився) | Так |
| Reboot у вікні | `watching`, boot_id інший, працює D (systemd підняв Quadlet = D) | Повне вікно від зараз з новою базою `NRestarts` (reboot сам є рестартом, тож старий лічильник нічого не каже) | Так |
| Провал у вікні, `auto` | — | `LAST_FAILED_SHA=X` **першим**; `PHASE=rolling-back`; `activate S`; чекати health з `releaseSha == S`; ок → вікно закрито, повідомлення | Так, кандидат X — лише після `rearm` |
| Обрив під час відкату | `rolling-back`, Quadlet = S або D | Повторити `activate S` і перевірку (відкат лише коду, тож повтор безпечний) | Після успіху — так |
| Відкат не підняв S | — | `INCIDENT`, повідомлення 🔥 з причиною | **Ні**, до `--resolve-incident` |
| Провал у вікні, `manual` | — | Без відкату; `INCIDENT`, знімок `WINDOW_PRE` утримується (§9), повідомлення: ручне відновлення | **Ні** |
| Юніт не з Quadlet (`unit=foreign`) | Будь-яка фаза | Нічого не робити; `INCIDENT` | **Ні** |
| `activating`, Quadlet-файл не називає ні S, ні D | — | `INCIDENT` (хтось інший змінив Quadlet; ядро «б» не вгадує) | **Ні** |
| `current` чи порт API нечитані | будь-яка | Чекати, нічого не міняти; повідомлення раз на добу | Так, після прочитаного |
| `watching`, останнє повне опитування ≥ 300 с тому (tick-и не дивились) | — | Нове повне вікно від зараз з новою базою `NRestarts`, ⚠️ «nobody watched for N s» — ні прохід, ні провал | Так |
| `rolling-back`, `ROLLBACK_ATTEMPTS ≥ 1` | факти нечитані або S ще стартує | Чекати до `STARTUP_S`, не витрачаючи спроби; далі нечитане — інцидент | Після успіху — так |
| `activating`, `activate D` → `REFUSED` | Quadlet = D | Вікно лишається `activating`; наступний tick активує знову (`ACTIVATE_ATTEMPTS`) | Так |
| Ручний запуск перервано (Ctrl-C, обрив SSH) у будь-якій фазі | вікно в стані | Те саме, що для обриву tick-а: наступний tick доводить вікно за цією таблицею; режим і `WINDOW_KIND` — зі стану | Як у відповідному рядку |
| `bootstrap`, `activating`, Quadlet-файлу нема (`quadlet=none`), юніт `absent` | — | Вікно скасовано (активації не було), повідомлення: «повтори `deploy.sh --bootstrap`» | Ні (нема settled) |
| `bootstrap`, `activating`, Quadlet = D | працює D або нічого | Як рядки 2–3: активувати знову чи почати вікно | — |
| `resolve`, `watching` | працює вказаний образ | Як рядки 4–5; провал — знову `INCIDENT` (режим `manual`) | Після settled — так |

**Unverified більше немає.** Чинний R2 позначав реліз `unverified`, бо без вікна неможливо було знати, чи вже стартував новий код поверх напівзаписаного `/opt`. Тут кожен обрив або повторюється, або дивиться вікно заново — образ незмінний. Реліз стає базою (`SETTLED_*`) лише після повного вікна; ціль відкату — завжди `SETTLED_DIGEST`, ніколи «попередній задеплоєний».

### 7.3 Інцидент

`INCIDENT` блокує таймер і ручний деплой (без `--resolve-incident`). Людина з'ясовує стан (відновлює БД з утриманого pre, вручну активує потрібний образ через `wbb-image activate`, чи лагодить вперед) і виконує `deploy.sh --resolve-incident --settled <sha>`.

Поправка 3 (рев'ю Codex 12.10): закриття — не запис, а **контрольоване вікно**. Контролер визначає digest образу `<sha>` (тег → digest, атестація, як для кандидата), і `current` має показати саме його: Quadlet-файл, запущений контейнер, `unit=quadlet`; `/health.releaseSha == <sha>`. Тоді **одним записом** `INCIDENT` знімається і відкривається вікно `WINDOW_KIND=resolve`, `WINDOW_MODE=manual`, одразу в `watching` (активації нема — образ уже працює). Повне вікно 600 с → `SETTLED_*`/`DEPLOYED_*` = цей образ, `RETAINED_PRE` звільняється (`db-snapshot.sh unmark`, що повертає знімок до звичайного утримання). Провал вікна — знову `INCIDENT` без вини (`LAST_FAILED_SHA` не пишеться: це не кандидат). Інцидент знімається в тому ж записі, що й вікно, щоб перерване закриття доводив таймер (гейт інциденту стоїть перед `resume_window`).

### 7.4 Ручний режим (поправка 3)

Один вхід — встановлена копія контролера з `--manual`; `deploy/deploy.sh` (до «в» — `deploy/image/deploy.sh`) відмовляє на брудному checkout-і, коли checkout не на коміті з `origin/main`, і коли встановлена копія контролера не збігається байт у байт із `deploy/image/autodeploy.sh` checkout-а (рішення власника №8). Контролер бере той самий lock; зайнятий lock чи відкрите вікно — відмова (вихід 1) з поясненням, без очікування.

| Команда | Що робить |
|---|---|
| `deploy.sh [--target <sha>] [--force] [--ack-incompatible]` | Деплой X (типово HEAD checkout-а) тим самим pipeline, що й tick (§4, §6.3, §7) |
| `deploy.sh --bootstrap [--target <sha>]` | Перший образ-реліз (§8 п.2) |
| `deploy.sh --resolve-incident --settled <sha>` | Закриття інциденту через вікно (§7.3) |

Гейти ручного деплою проти tick-а:

| Гейт | Tick | Ручний |
|---|---|---|
| Інцидент, `PAUSED`, lock, `STATE CORRUPT` | блокує | блокує (інцидент — лише `--resolve-incident`) |
| Відкрите вікно | доводить його | відмова: «дочекайся вікна X» |
| Quiet main 10 хв | так | ні — людина поруч |
| CI exact-SHA + `image` | так | так (без образу деплоїти нічого) |
| `X` нащадок `DEPLOYED_SHA` | так | так, крім `--force` (свідомий даунгрейд; ціль відкату — той самий settled) |
| `LAST_FAILED_SHA == X` | чекає наступного мерджу | дозволено (людина явно); успіх знімає його |
| Holds: шлях, `deploy:hold` | hold | **пропуск**: запуск і є підтвердженням (як зараз) |
| `rollback:unsafe`, `migration:contract` у діапазоні | hold | лише з `--ack-incompatible`, вікно `manual` |
| Встановлені копії застарілі | чекає | відмова |
| Noop за `wbb.content` | noop | noop — так hold за кроком хоста знімається без рестарту |
| Аудит, trial | як §4.2, §6.3 | так само; `COMPAT FAILED` — відмова, з `--ack-incompatible` — деплой у `manual` |
| Вікно | у tick-у | на передньому плані до вердикту; перерване — доводить tick (§7.2) |

Вихідні коди — ті самі (§7.1, план «б»). Повідомлення в Telegram — ті самі, що й з tick-а, з позначкою «manual».

**Bootstrap.** Передумови: `SETTLED_DIGEST` порожній, `DEPLOYED_SHA` засіяний (перенесенням гейтових ключів зі `state.env`, стадія «в»), інциденту й вікна нема, X нащадок `DEPLOYED_SHA`. Перший запуск: CI, тег → digest, атестація, pull, аудит; якщо юніт ще `foreign` (старий `/etc/systemd/system/warsaw-beer-bot.service`) — нічого не записує, друкує кроки root (зупинити бота, прибрати файл юніта, `daemon-reload`) і виходить 1. Повторний запуск (юніт `absent`, бот зупинений): pre-знімок на БД у спокої, trial з `--previous D` (compat проти себе: позитивний контроль START, compat не доводить нічого — §8 п.2), вікно `bootstrap`/`manual` з порожнім `WINDOW_PREV_DIGEST`, `activate D`, вікно 600 с → `SETTLED_*` = D. Провал — `INCIDENT`; ручний fallback — повернути старий юніт і flat-дерево (runbook README).

**Стан ручного запуску** нічим не відрізняється від стану tick-а, крім `WINDOW_KIND` і `WINDOW_MODE`: так перерваний ручний запуск доводить таймер, а не людина.

Уточнення після рев'ю коду (21.10; викладу власника не змінюють):
- «Діапазон» для contract-міток при `--force`-даунгрейді — це й коміти, які відкат прибирає (`X..DEPLOYED_SHA`): старий код на БД нового — саме відкат, про який ці мітки.
- `LAST_FAILED_SHA` і `CANDIDATE_HELD` записуються лише для кандидата, що є головою `main`: провал ручного деплою старішого коміту не переписує запис про провалену голову.
- `--resolve-incident` не перевіряє застарілість встановлених копій (рядок таблиці вище): контролер прив'язаний побайтовою звіркою `deploy.sh`, а застарілий `db-snapshot.sh` лише лишає знімки утриманими й названими.
- `LAST_SEEN_DEPLOYED_SHA` (#768) пишеться лише як доведений рух уперед (settled чи noop нащадка); активація, відкат і ручний запуск його не пишуть — так перерваний ручний даунгрейд, який доведе таймер, однаково дасть fence.

## 8. Перехід і старі checkout-и

Плани переходу йдуть стадіями (CLAUDE.md): **(а) ядро переходу** — root-хелпер `wbb-image`, його інсталятор і sudoers, `start-check --leave-running`, `--stop-timeout` у шаблоні; нічого не встановлює й не перемикає (`docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md`); **(б)** `autodeploy.sh` і `deploy.sh` під образи зі станом §7 — пишеться після рев'ю (а); **(в)** перемикання хоста, старі checkout-и, прибирання й репетиція — після (б). Обриси:
1. **Ядро (без hold).** CI job `image` + атестація + smoke (§3.1) + `wbb.content`; лінтер міграцій; правила §6.2 у `CLAUDE.md`; `WBB_OPERATOR_UID`; Node у статусі (§10). Хост не змінюється; образи публікуються, ніхто їх не тягне.
2. **Хост (`[deploy:hold]`).** `apt install podman`; хелпер `wbb-image` і sudoers; новий `autodeploy.sh`; Quadlet-файл. Перший образ-реліз активує людина при зупиненому таймері, у режимі `manual` (попередній — flat-дерево, відкату на образ немає; ручний fallback — старий юніт і flat-дерево). Після 600 с спостереження він стає першим settled. Механіка — `deploy.sh --bootstrap` (§7.4, поправка 3).
3. **Старі entrypoint-и.** Старий `deploy.sh` після rsync **встановлює `/etc/systemd/system/warsaw-beer-bot.service`, робить `daemon-reload` і `restart`** — це перекрило б Quadlet. Тому:
   - `state.env` замінюється каталогом (з `README`) — версії `deploy.sh` 8705e8b, deabec7 і новіші відмовляють до першого `sudo`, коли `state.env` існує, але не є звичайним файлом (preflight 11.10);
   - старіші checkout-и оновлюються чи видаляються до кроку 2. Перелік 21.10 (V15): без захисту — worktree `cluster-triage` у `~/warsaw-agy-bb` (99992d9), `~/wbb-sol-default` і п'ять копій у `/root`; із захистом — `~/warsaw-bb-codex`, `~/warsaw-agy-bb`, worktree `848-piwnemosty-kategoria-tymczasowa`. План «в» повторює пошук перед кроком 2;
   - NOPASSWD-правила `rsync`/`chown /opt`/`install … warsaw-beer-bot.service` у `/etc/sudoers.d/warsaw-beer-bot` видаляються;
   - хелпер перевіряє, що активний юніт згенерований Quadlet-ом (§3.2), і відмовляє інакше; щоденний статус показує це ж.
   Це захист від випадкового запуску старої команди, не від адміністратора з root.
4. **Прибирання.** flat-дерево `/opt/warsaw-beer-bot`, `rsync-filter`, `ships.sh`, встановлене з #834 (`/usr/local/lib/wbb-release`, обгортки, `sudoers.d/wbb-release`, юніти `wbb-tick*`, користувач `wbb-trial`, `/var/lib/wbb-trial`, `/var/lib/wbb-deploy`), код `deploy/release/` (§11).
5. **Репетиція до прийняття:** тестовий юніт із копією БД (як у пробі) — навмисно непрацездатний кандидат → автоматичний відкат на settled; обрив tick-а в кожній фазі таблиці §7.2 (kill між кроками) → очікувана дія з таблиці. Production-бот навмисно не ламаємо.

## 9. Retention і ресурси

- Локально тримаються: образ із Quadlet-файлу, `SETTLED_DIGEST`, `WINDOW_PREV_DIGEST` і кандидат відкритого вікна; решта — `prune` після settled. ~0,45 GB на образ, спільні шари. Перед pull — ≥5 GiB вільного, інакше відмова з повідомленням (не тиха чистка).
- **Pre-знімки**: тримаються 3 останні settled. Pre вікна, що закінчилося інцидентом (`INCIDENT`) чи провалом у `manual`, позначається `mark-rollback` (чинне позначення «доказ для людини», `prune` його не чіпає) і утримується до `--resolve-incident`, незалежно від кількості settled. Pre провалу в `auto` — теж утримується до наступного settled (раптом відкат лише коду виявиться недостатнім).
- GHCR для публічного пакета безкоштовний; політика видалення старих версій у GHCR — пізніше, не блокує.
- Свіжість Node/base: Dependabot `docker` для digest-ів base-образів; PR іде звичайним шляхом `dependabot-qualify`. Зміна base-digest дає нову `wbb.content` і реліз (§4.1). Тижнева затримка security-патчу Node проти unattended-upgrades — свідома ціна.

## 10. Моніторинг після контейнеризації

- **Node.** `host-upstream`/статус оцінює security-версію Node за `packages.nodejs` із хостового звіту (`scripts/ops/host_patch_collect.py`). Після переходу хостовий Node до бота стосунку не має. Версію бере сам бот: `process.versions.node` процесу в контейнері — її й порівнює статус із безпековими релізами Node.
- **Хост.** Збирач лишає Ubuntu, cloudflared, Litestream і додає `podman` (оновлюється unattended-upgrades). needrestart не перезапускає контейнер через хостові бібліотеки — бібліотеки образу оновлюються лише перезбіркою (§9).
- **Юніт.** Статус показує `unit=quadlet|foreign` (§3.2) і образ запущеного контейнера проти `DEPLOYED_DIGEST`.

## 11. Що з чинного коду переходить

| Що | Дія |
|---|---|
| `deploy/autodeploy.sh` | Лишається як основа: гейти без змін; збірка, класифікація, деплой, trial, вікно й відкат переписуються (§4, §7) |
| `deploy/ships.sh`, `deploy/rsync-filter` | Видаляються; замість них `wbb.content` (§4.1) |
| `read-env.sh`, `installed-current.sh`, `record-deployed.sh`, `db-snapshot.sh` | Лишаються |
| `deploy/trial-migrate.cjs`, `scripts/autodeploy/audit-verdict*.ts` | Їдуть в образі |
| `src/release/identity.ts`, `/health.releaseSha`, `WBB_RELEASE_REQUIRED` | Лишаються; у Quadlet `WBB_RELEASE_REQUIRED=true` |
| `deploy/release/package_runtime.py`, `tree_manifest.py`, `payload-probe.cjs` | Лишаються як CI-збирач payload; переносяться з `deploy/release/` у `scripts/release/`, щоб їх зміни не давали hold |
| Решта `deploy/release/*` (контролер, рушій, адаптери, publish/receipt, sandbox, інсталятор) і їхні тести; `wbb-release.sh`, `wbb-tick*`, `sudoers.d/wbb-release`, `install-release.sh` | Видаляються в плані переходу; ідеї (відкат до останнього settled, звірка `releaseSha`, коди виходу 0/1/2/75) переносяться |
| Дизайн 2026-10-08 і його плани | Лишаються історією з позначкою «superseded» |

## 12. Відкриті пункти (до плану переходу)

1. ~~Звіт preflight `finish`~~ — закрито 12.10 (V12): записів у дерево коду немає.
2. ~~Перелік ops-команд, які запускає не людина, з `/opt/warsaw-beer-bot`~~ — закрито 21.10 (V15): лише юніт бота, sudoers і невикористаний `wbb-release`; прибирання §8 п.4 видаляє `wbb-release` раніше за flat-дерево.
3. ~~Проба `podman inspect` і `SourcePath`~~ — закрито 12.10 (V10).

## 13. Розглянуті й відкинуті альтернативи

- **Варіант А** (довести Python-деплоєр, 7,4 тис. рядків): найважча частина (перехід layout-у, legacy capture, репетиції) ще попереду, а кожна правка контролера — hold-крок. Порівняння й оцінки — у дослідженні.
- **Варіант В** (host Node + атестований tarball): лишає native-сумісність із хостовим Node назавжди й ~1,5 тис. рядків власного коду.
- **Docker Compose** замість Quadlet: друга система життєвого циклу поверх systemd і постійний демон.
- **Rootless Podman**: прибрав би root із деплою, але бот став би user-юнітом, і довелося б переробити sudo-правила `systemctl`, порядок із Litestream, збирач патчів, журнали й runbook-и; плюс subuid/subgid і linger. Оператор і так має `(ALL) ALL`, тож виграш малий.
- **Автоматичний code+DB відкат** (чинний контракт): втрачає записи вікна, повторює зовнішні побічні ефекти, потребує зупинки Litestream.
- **Тег `:current` як точка активації**: неоднозначний (`podman tag` локального ID vs registry digest); Quadlet-файл з `Image=…@D` однозначний.
- **Універсальний аналізатор сумісності**: не будується. Межа автоматики — §6.3; решта — правила, тести й ручний деплой.

## 14. Заявка → доказ

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| Образ D — збірка CI коміту X з `main` | Байти D зібрав workflow `ci.yml` цього репо на hosted runner з коміту X гілки `main` | `gh attestation verify` з `--source-digest X --source-ref refs/heads/main --signer-workflow …/ci.yml --deny-self-hosted-runners`; негативні випадки V3 | сильний |
| CI зелений на X | Тести, збірка й образ пройшли саме на X | Exact-SHA гейт + `image=success` у тому самому run-і | сильний |
| Запущено D (X) | Контейнер бота з образу D, процес стартував з `release.json` X | `podman inspect`: `.ImageDigest == D`, `.Image == I` (I з pull за D); `/health.releaseSha == X`; Quadlet-файл з `Image=…@D` (§3.3) | сильний; поля підтверджені пробою V10 |
| Активний юніт — наш Quadlet | Ніщо не перекрило згенерований юніт | `SourcePath`/`FragmentPath` перед кожною активацією й у статусі | сильний на момент перевірки |
| Ціль відкату S запускається без мережі | Локальний образ S стартує з `Pull=never` | V7 | сильний |
| S працює після міграцій і стартових перетворень D | Старий код стартує й відповідає `/health` на копії, яку D мігрував і на якій D стартував | Compat §6.3, з позитивним контролем START (D) | **середній**: не покриває записів D під час роботи й семантики даних — це правила §6.2, цільові тести, рев'ю; де не доведено — ручний режим §6.4 |
| `COMPAT FAILED` = несумісність | Не збій середовища | START (D) на тій самій копії пройшов; збої середовища — вихід 75 | сильний |
| Зупинка бота при деплої чиста | SIGTERM доходить, бот закриває БД і виходить 0 до SIGKILL | V11: `systemctl stop` під Quadlet → `shutdown done` за 0,2 с, `ExecMainStatus=0`; `--stop-timeout=20` у шаблоні | сильний (офлайн-бот; з мережею `shutdown` ще перериває активні прогреси в Telegram — у межах 20 с) |
| START не залежить від сигналів у контейнері | Вердикт START/COMPAT не ламається від AppArmor хоста | `--leave-running`: жодного `kill` усередині; бота вбиває розбір PID-простору; smoke у CI і репетиція на хості | сильний після репетиції |
| Лінтер міграцій | Нічого не стверджує про сумісність | — | сигнал для рев'ю, не доказ |
| Режим вікна переживає reboot | `manual` не стає автоматичним відкатом | `WINDOW_MODE` записується до активації; таблиця §7.2; репетиція §8 п.5 | сильний |
| Що деплоїться | Різна `wbb.content` ⇔ різний runtime | Тест на 4 випадки §4.1 | сильний для перелічених випадків |
| Міграція кандидата проходить на production-даних | `migrate()` двічі на копії pre, цілісність | `trial-migrate.cjs` в образі (V4) | сильний |
| Trial і compat не бачать секретів і мережі | Ізоляція контейнера, підставне оточення | V4; реальний `.env` не монтується | сильний |
| Аудит на момент деплою | Advisory ≠ «не вдалося перевірити» | `audit-verdict-cli` в образі, smoke на фікстурах | сильний |
| Код не пишеться під час роботи | Бот і ops не пишуть у `/app` | `ReadOnly=true` (EROFS замість тихої зміни); звіт `finish` (V12): 0 записів за 18 год, що покривають усі розклади cron | сильний |
| Бот бачить потрібні файли хоста | Кожен шлях-літерал у `src/` має `Volume=` | Перелік §3.2 + smoke у CI | сильний для літералів; шляхи з `.env` — preflight (усі в `/var/lib/warsaw-beer-bot`) |
| Статус показує Node бота | Версія Node, на якій працює бот | `process.versions.node` у контейнері | сильний |
| Pre-знімок — стан БД на момент T | `VACUUM INTO` + sha256 | `db-snapshot.sh` | сильний |
| Noop просуває `DEPLOYED_SHA` | Гейтова база X еквівалентна запущеному runtime | `wbb.content` рівні + `current` = запущений `DEPLOYED_DIGEST/ID` + holds перевірені **до** noop; фізична identity (`DEPLOYED_DIGEST/ID/CONTENT`, `SETTLED_*`) не змінюється | сильний для перелічених випадків |
| База `NRestarts` вікна | Рестарт, що стався, поки ніхто не дивився, буде видно | Після активації лічильник рахує лише рестарти кандидата: `activate` завжди робить `restart`, а `restart` скидає лічильник у 0 (V14), тож на старті спостереження > 0 — провал; база вікна — прочитане значення; нижча за базу в тому ж boot чи годинник назад — нове вікно, не прохід | сильний (V14); `daemon-reload` лічильник не чіпає |
| Ручний деплой пройшов hold | Кроки hold-у на хості виконано | Слово людини, що запустила `deploy.sh` (як зараз) | **слабкий за природою** — свідомо: людина присутня; автоматика не перевіряє кроків хоста |
| Ручний вхід = код таймера | Ручний запуск і tick пишуть стан однією реалізацією | `deploy.sh` порівнює встановлену копію з checkout-ом байт у байт перед викликом | сильний на момент запуску |
| Закритий інцидент → settled | Образ, що став ціллю відкату, працював і був здоровий повне вікно | Вікно `resolve` 600 с з тими самими опитуваннями; `current` і `releaseSha` перед ним | сильний (як вікно деплою) |
| Перший образ-реліз settled | D працював повне вікно на production | Вікно `bootstrap` 600 с; compat не доводить нічого (нема S) | сильний як вікно; сумісності з flat-кодом не стверджує |
| Знімок інциденту не зникає | Pre незакритого інциденту утримується | `mark-rollback` + `prune` його пропускає (чинне) | сильний |
| Хелпер працює лише з нашими образами | Не тягне й не запускає чужого | Строгий argv, формати SHA/digest, `RepoDigests` і мітка `revision`; тести хелпера | сильний (у межах коду хелпера) |
| Свіжість Node/base | Security-патчі доходять | Dependabot `docker` + merge | **слабкий за природою** (процес, не механізм); свідома ціна §9 |

## Рев'ю спеки

| № | Перевірка | Рішення | Причина / що змінено |
|---|---|---|---|
| — | `cross-review --spec --reviewer codex` на поправці 3 (`52629e8`) | збій рецензента (exit 5, ENOENT) | codex CLI не встановлено в хмарному середовищі; спеку це не блокує (`docs/spec-format.md`). Власник може запустити рев'ю локально до затвердження |
