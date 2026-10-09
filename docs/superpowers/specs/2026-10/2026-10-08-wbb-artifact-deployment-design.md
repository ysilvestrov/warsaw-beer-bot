# Warsaw Beer Bot: deployment готових GitHub-артефактів

**Статус:** прийнята власником до реалізації 08.10.2026 (редакція 2). Реалізація поетапна (§12). Змерджено: Ядро-1 (CI-артефакт, план `docs/superpowers/plans/2026-10/2026-10-08-wbb-artifact-deployment-core-1.md`) і Ядро-2а (довіра й публікація, план `…/2026-10-09-wbb-artifact-deployment-core-2a.md`). У роботі Ядро-2б (аудит, sandbox-проба, trial; план `…/2026-10-09-wbb-artifact-deployment-core-2b.md`); далі 2в (активація, recovery, rollback). На хості нічого не встановлено.
**Дата:** 2026-10-08.
**Редакція:** 2; враховано review від 08.10.2026.
**Канонічний шлях у WBB:** цей файл. Копія в misc — дзеркало початкового обговорення.
**Мета:** прибрати встановлення залежностей і збірку з production VPS, зберігши чинні гарантії merge-deploy, перевірки production-БД та відкат коду разом із БД.
**Обсяг:** один проєкт warsaw-beer-bot. Переїзд VPS, OPDS, Cloudflare, пошта, Chrome Web Store та продуктові функції не змінюються цим документом.

## 1. Авторитет, контекст і вибір

Кореневий [spec.md](https://github.com/ysilvestrov/warsaw-beer-bot/blob/main/spec.md) лишається нормативним джерелом проєкту. Після приймання цього дизайну реалізація MUST оновити §5.9, deployment-документи та відповідні тести в тих самих PR. Цей файл — запропонована зміна, не твердження про вже встановлену інфраструктуру.

Джерела: первинні копії прочитано 08.10.2026; review додатково звірено з GitHub main `ef6d817d1b52c88fe983b7e8cb0fd93a546618ed` (цей SHA — відтворюваний baseline). Не вважати рухомий main незмінним доказом:
- `deploy/deploy.sh`: shared lock, ancestry admission, rsync allowlist, npm ci/build/prune, установлення unit, restart і запис baseline.
- `deploy/autodeploy.sh`, `deploy/README.md`, `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md`: quiet main, CI/holds, audit, snapshot, trial, 10-minute window та code+DB rollback.
- `deploy/trial-migrate.cjs`: openDb/migrate кандидата, дворазова міграція, integrity_check/foreign_key_check.
- `.github/workflows/ci.yml`: root/extension checks і stable required check `ci`; workflow сьогодні не пакує runtime-реліз.
- `src/api/index.ts`: `/health` сьогодні повертає лише `{ok:true}`.
- [OPDS spec](https://github.com/ysilvestrov/opds-proxy/blob/main/spec.md), DEPLOY-001/002: зразок перевіреного Linux artifact та незалежних releases; його cache-only rollback непридатний для БД бота.
- `CLAUDE.md`/`AGENTS.md`: таблиця «заявка → доказ», місячні каталоги документів, поетапні плани.
- `docs/superpowers/specs/2026-07/2026-07-20-ops-tools-prod-reachable-design.md`: має явний PREMISE INVALIDATED; компіляція ops-команд там не реалізована й не є прецедентом чинної поведінки.

Погоджений у попередньому обговоренні напрям: GitHub збирає `dist` і production dependencies, сервер отримує артефакт конкретного SHA, перевіряє його й міграцію на копії production-БД, активує та спостерігає.

Розглянуті варіанти:

| Варіант | Властивості | Рішення |
|---|---|---|
| Залишити поточні host builds | Мінімум змін; build/install двічі на VPS, rollback залежить від npm | Не відповідає меті |
| Передавати тільки dist; npm ci на VPS | Менший artifact; native install і registry залишаються на production | Не відповідає меті |
| Готовий Linux runtime artifact | Dist, production dependencies та ресурси перевірені разом; потребує platform/provenance gates | Обрано |

## 2. Архітектура та межі

`main → existing CI + package job → GitHub artifact → provenance/ZIP/tar verification → root-private verified tree → host audit → isolated native probe → snapshot/isolated trial → final admission → stop → current switch → start → watch → settled`.

GitHub SHALL не підключатися SSH до production й не отримувати Telegram/env/DB/OAuth/media/R2 credentials. Хост SHALL зберігати pull model, existing timer, оператора `ysi` і поточне правило «merge main означає дозвіл на звичайний application release».

Production SHALL не запускати `npm ci`, `npm install`, `npm prune`, TypeScript build, npm lifecycle scripts або checkout scripts для preparation/activation/rollback. Git clone MAY залишатися для ancestry, hold classification та читання історії, без node_modules і build artifacts.

### Control plane

Installed controller, GitHub/ZIP/tar/tree validators, audit verdict і publication/recovery helpers SHALL використовувати **Python >=3.12 stdlib**, без pip/npm dependencies. Bash допускається лише як entrypoint до installed tools; git/gh/curl/npm/systemctl — системні executables, не candidate binaries. Python `tarfile` SHALL використовувати data filter та власні перевірки caps/path/link/entry types; filter сам по собі не забезпечує весь contract.

Controller/state працюють як `ysi`; root-owned fixed helpers відповідають за root-private publication, validation і запуск fixed isolated probe/trial units. Helpers не приймають довільної shell, unit properties чи executable від оператора; payload path/DB scratch визначаються з валідованих IDs. Privileged helper ніколи не завантажує Python/Node модулі з candidate або operator checkout.

Probe/trial SHALL виконуватися як окремий system user `wbb-trial` (nologin, без sudo, GitHub token чи production config), через fixed systemd sandbox: PrivateNetwork=yes, ProtectHome=yes, NoNewPrivileges=yes, ProtectSystem=strict, PrivateTmp=yes, явні InaccessiblePaths для `/etc/warsaw-beer-bot`, `/etc/wbb-deploy`, production data й operator state. Доступ read-only лише до root-owned candidate та системного runtime; writable — приватна копія trial DB/scratch. Усі capabilities прибрані. Початкові ліміти: MemoryMax=768M, CPUQuota=100%, TasksMax=64; probe <=30s, trial <=120s. Timeout припиняє весь cgroup; перед publication/cleanup підтверджується його порожність. Production secrets не передаються в env/argv/fd.

Чинні runtime paths для env/data/media/OAuth не змінюються. Новий code layout:

| Шлях | Вміст і права |
|---|---|
| `/opt/warsaw-beer-bot/releases/<full-sha>/` | Незмінний перевірений runtime payload; service-user може читати, не писати |
| `/opt/warsaw-beer-bot/current` | Atomic symlink на активний локальний release |
| `/opt/warsaw-beer-bot/staging/` | Приватні downloaded archives і staging, недоступні runtime-user |
| `/etc/warsaw-beer-bot/.env` | Чинна конфігурація/credentials; окремо від releases |
| `/var/lib/warsaw-beer-bot/` | Чинні DB/media/OAuth/snapshots; поза release cleanup |
| `~ysi/.local/state/wbb-autodeploy/` | Existing shared lock/state/PAUSED плюс versioned activation metadata |
| `/var/lib/wbb-deploy/receipts/<full-sha>.json` | Root-owned 0600 provenance/ZIP/tar/tree digest receipt; controller має тільки fixed read interface |
| `/etc/wbb-deploy/github.env` | Root-only read token publication verifier; credentials не входять у runtime payload |

Runtime user MUST NOT змінювати releases/current, installed deployer/helpers чи sudoers. Installed infrastructure MUST бути root-owned і оновлюватись лише окремим operator install. Preparation робиться без root; privileged publication/switch/start/stop використовують вузькі reviewed helpers без довільної root shell або виконання candidate scripts як root.

Unit SHALL використовувати WorkingDirectory `/opt/warsaw-beer-bot/current` та ExecStart `/usr/bin/node /opt/warsaw-beer-bot/current/dist/index.js`. WorkingDirectory резолвиться через chdir, головний Node module — через realpath без preserve-symlinks-main. Код/ресурси MUST NOT залежати від старих абсолютних flat-layout шляхів. Перед перемиканням старий runtime зупиняється, щоб він не читав нові ресурси через current symlink під час роботи.

## 3. BUILD-001 — готовий runtime конкретного main SHA

Packaging SHALL бути job з ID/name **`package` у чинній `.github/workflows/ci.yml`**, `needs: [build]`, condition `github.event_name == 'push' && github.ref == 'refs/heads/main'`. Окремої workflow_run workflow немає. Artifact публікується тільки після успішних root/extension checks того самого commit. PR checks залишаються обов'язковими; skipped package дозволений тільки на PR.

Початковий packaging target SHALL бути явно `ubuntu-24.04`, x86_64/glibc і Node 24. CI package job записує Node patch/modules ABI/glibc та виконує native better-sqlite3 probe в розпакованому payload; хост окремо повторює compatibility probe. Не використовувати рухомий `ubuntu-latest` як неявний artifact platform contract. Наявні тестові jobs MAY зберігати свої платформи; package job має власний pinned OS contract. Node 24 — поточний явно підтримуваний major, а `engines >=24` не дозволяє автоматично збирати реліз на 26. Зміна major потребує нового reviewed platform contract; одночасно виправляється stale Node>=20 у таблиці стеку root spec (§2; §5.9 уже Node24).

GitHub artifact SHALL мати ім'я **`wbb-release-<full-sha>-<run-id>-<run-attempt>`**, містити тільки `runtime.tar.gz` і `runtime.tar.gz.sha256`. Re-run усієї CI workflow збільшує attempt і має нове ім'я, без overwrite попереднього artifact. Partial re-run лише package не є підтримуваною recovery процедурою; потрібні coherent checks повного нового attempt. Payload SHALL містити:
- `release.json` з `formatVersion=1`, repo, full source SHA, workflow/run ID і run attempt, Node version/major/modules ABI, arch/platform/libc baseline, package-lock SHA256;
- `tree-manifest.json`: canonical UTF-8 JSON, sorted relative paths, кожен regular file з mode/size/SHA256, directory з mode, symlink з exact target; без special bits. Inventory охоплює кожен payload entry крім самого tree-manifest.json. SHA256 raw canonical manifest є tree digest і зберігається лише у trusted host receipt після archive verification: release.json входить в inventory, circular self-hash немає;
- `dist` без тестів та development-only artifacts;
- повний closure production dependencies, включно з native modules;
- package.json/package-lock.json саме цього SHA;
- явно перелічені runtime assets: чинний route `src/api/routes/fest-print.ts` підключений у API main; `src/api/fest-print/index.html`, `src/api/fest-print/vendor/niimbluelib-0.47.0.min.js`, vendor license та README SHALL пакуватися в розташуванні, яке використовує runtime. Read-by-path assets копіюються build step, бо tsc їх не переносить;
- тільки потрібні operational CLI/resources, якщо вони є частиною підтримуваного production workflow.

**Обрано збереження TS operational commands:** `tsx` лишається production dependency; source у payload дозволений як input уже наявного TS runtime ops, не як production build input. Allowlist entrypoints: `alias-key`, `rearm-aliased-orphans`, `rearm-matcher-bug-orphans`, `adjudicate`, `close-orphan-issue`, `pin-match`, `repair-legacy-card`, `dispose-legacy-orphan`, `retire-resolved-orphans`, `cluster-triage` з package.json цього baseline. Включаються їхні scripts/*.ts entrypoints, транзитивні локальні TS/JSON/asset imports із scripts/src та dependencies, без *.test.*, fixtures, AI review/build/CWS tools. Native runtime `dist` і ці source imports походять з одного SHA. Зміна allowlist — reviewed packaging-contract change.

Build/prune/package відбуваються тільки в CI; `npm run` operational-команд на хості виконує існуючий tsx command, а не встановлення/tsc. Сумісність усіх перелічених команд перевіряється на disposable DB без production credentials; external-side-effect commands — у mock середовищі. Актуальні runbooks змінюються на `cd /opt/warsaw-beer-bot/current`; історичні design/evidence documents не переписуються заднім числом, але отримують link/notice про новий operational runbook. Compiled dist/scripts path без наявного entrypoint не заявляється працездатним.

Config/env/OAuth/DB/media/caches/test fixtures, installed privileged helpers і units MUST NOT потрапляти в application payload. Manifest MUST NOT містити credentials. Після prune/пакування CI SHALL перевірити залежності та startup/resource contract із розпакованого payload, без доступу до source checkout node_modules і без production token/network side effects.

### Сценарії
- **WHEN** root або extension checks failed/cancelled, **THEN** production artifact не публікується як готовий.
- **WHEN** source tree приховує відсутній runtime asset/dependency, **THEN** isolated unpacked-payload check падає до публікації.
- **WHEN** packaging має неправильний SHA або залишив .env/DB, **THEN** перевірка відмовляє.

## 4. TRUST-001 — admission та перевірка походження

До production mutation deployer MUST перевірити repo, exact full SHA, trusted workflow identity/path, main push event, successful required jobs і trusted run/artifact association. Artifact name або checksum окремо не доводять походження. Відсутні/неоднозначні metadata — refusal, без вибору «останнього зеленого» artifact.

SHA одного релізу має один accepted tar/tree digest: root publication helper атомарно записує `/var/lib/wbb-deploy/receipts/<sha>.json` після незалежної provenance/archive/tree verification і publication. Receipt містить repo/run/attempt/artifact ID, GitHub ZIP digest, tar digest, tree digest та formatVersion. Старий receipt з іншим tree/tar digest не переписується автоматично. Зміна ZIP wrapper metadata при re-run сама по собі не конфліктує, якщо tar/tree той самий. Не встановлений/не опублікований SHA MAY отримати artifact нового coherent attempt; після accepted publication різні tar/tree digest потребують explicit operator recovery або нового commit. Accepted не означає active чи settled.

Спершу вибирається trusted CI run/attempt для SHA, тоді artifact лише через `/actions/runs/{trusted_run_id}/artifacts` з matching ім'ям/ID та manifest attempt. Repository-wide name search заборонений; чужий PR artifact із тим самим ім'ям не впливає на вибір. Controller використовує operator gh read credentials для історії/CI/holds; root verifier має окремий fine-grained read token для цього repo з Actions:read та metadata read у `/etc/wbb-deploy/github.env`. Controller-token також потребує read доступу до Contents/Checks/Pull requests для чинних gates. Trial/runtime не отримують цих credentials. API redirect download авторизується тільки до GitHub API; token не пересилається на redirected storage, signed URL не логується. Root verifier заново отримує trusted metadata за fixed repo/run/artifact IDs, а не довіряє operator-written expected hash.

ZIP SHA256 MUST збігатися з GitHub artifact REST `digest` (`sha256:...`); absent/invalid digest блокує до підтримуваної operator recovery, не silent bypass. ZIP container <=257 MiB, рівно два regular entries з указаними іменами, жодних directories/links/encryption/duplicates; сумарні expanded ZIP bytes <=256 MiB+1 KiB, checksum file <=256 B. Tar archive <=256 MiB. CRC і фактичні streamed sizes перевіряються, не тільки headers. Обидва рівні перевіряються до payload execution.

Producer manifest і metadata GitHub MUST узгоджуватися. Архів checksum перевіряється до unpack. Якщо attestations доступні в поточному GitHub plan, їх MAY використовувати додатково; платна GitHub-функція не є передумовою цього дизайну. Довірена workflow/run перевірка обов'язкова й без attestations.

Node major=24, modules ABI і x86_64/Linux MUST відповідати хосту; glibc хоста не старіша за потребу native binary. Actual native SQLite open/query/close probe у staged payload обов'язковий; checksum/manifest не замінює виконувану сумісність. Несумісність блокує, без fallback build на production.

Node 24 — explicit deployment target цієї редакції; `engines >=24` не означає автоматичний дозвіл major 26. Зміна target потребує reviewed CI/host compatibility update. Controller фіксує realpath/hash/version/ABI host Node для probe та повторно звіряє перед stop/start. Node package upgrades SHALL серіалізуватися з deployment через shared lock (включно з unattended upgrade path); installer мусить це забезпечити або виключити Node з unattended upgrades та задати operator maintenance процедуру. Зміна binary після probe потребує нового isolated probe; невизначена сумісність блокує switch. Recovery так само перевіряє previous проти фактичного host Node.

Розпакування SHALL бути обмежене стисненим/розпакованим розміром, кількістю entries та вільним диском. Початкові admission caps: archive <=256 MiB, expanded regular file bytes <=1 GiB, entries <=100000; сумарні staging filesystem blocks контролюються окремо. Після preparation available disk SHALL бути >10 GiB та free inode >=100000. Caps перевіряються на реальному payload; їх зміна потребує spec update, не silent unlimited fallback.

Archive absolute/traversal/duplicate paths, device/FIFO/socket entries, hardlinks, symlink-parent traversal та links назовні MUST відхилятися. Внутрішні relative symlinks MAY бути дозволені лише після повної перевірки без виходу з payload; це потрібно для npm package bins. Existing staging path не розпаковувати поверх; не слідувати filesystem symlinks і не переходити на іншу FS.

**Publication TOCTOU boundary:** root helper відкриває operator archive без O_NOFOLLOW violations, копіює його через bounded FD read у свій root-private scratch, там перевіряє downloaded ZIP digest проти independently fetched trusted API metadata, tar digest і безпечно розпаковує. Усі checks виконуються над root-private bytes; operator manifest не є anchor. Після unpack і normalization ownership він незалежно перевіряє exact inventory, hashes/modes/targets, absence extra entries й tree digest, не запускаючи payload. Root-owned scratch атомарно rename у releases лише після цієї перевірки. Probe/trial запускаються вже з цього незмінного дерева. Receipt/release reconciliation при crash між rename і receipt write — повторна повна перевірка, без activation до receipt.

Перед activation і rollback root helper заново перевіряє tree digest проти root-owned receipt. Несумісні/змінені файли — blocked, без «immutable за припущенням». Доступність clean previous перевіряється до зупинки/відновлення DB; runtime user не може змінити дерево.

### Сценарії
- **WHEN** archive правильний за checksum, але походить із PR/fork/іншого workflow, **THEN** refusal без DB/current/restart mutations.
- **WHEN** ABI/glibc/native probe несумісні, **THEN** старий runtime працює, нічого не збирається на VPS.
- **WHEN** archive traversal/link bomb або admission cap порушено, **THEN** staging припиняється, production не змінюється.
- **WHEN** main змінився після download, **THEN** кандидат не активується; quiet/CI gates перевіряються для нового SHA.

## 5. GATE-001 — зберегти merge-deploy та актуальний audit

Поточні timer cadence, quiet main >=10 min для timer, exact-SHA required CI, hold paths/labels для timer, installed-current check, failed-SHA/rearm, ancestry/regression fence і notifications SHALL зберігатися. Різниця manual/timer задана таблицею нижче; PAUSED recovery — явна зміна в §7. Fetch failure означає відсутність доказу, не success.

Required checks policy SHALL вимагати stable `ci=success` та іменований `package=success` trusted CI run/attempt для exact SHA. skipped/neutral/missing package на main — blocked, навіть якщо нинішній ci_verdict трактує їх позитивно. `ci` aggregator SHALL needs build/package, always: на PR package skipped дозволений тільки з successful build; на main необхідні build+package success. Existing concurrency cancel-in-progress зберігається. Старі cancelled check runs іншого SHA/attempt не забруднюють verdict accepted successful re-run; required checks інших workflows залишаються за explicit policy, а не «будь-який green check».

### Гейти за шляхом

| Гейт | Timer forward | Manual | Manual --force | Internal rollback |
|---|---|---|---|---|
| Trusted origin/digests/tree/native compatibility | Так | Так | Так | Root receipt/tree/native, локально |
| Exact-SHA CI+package success | Так | Так | Так | Accepted local receipt, без online CI |
| Main head==candidate перед activation | Так, будь-який новий head відкладає | Target reachable у fresh main | Історичний trusted main-push дозволений | Не потрібно |
| Quiet 10 min | Так | Ні | Ні | Ні |
| Path/label hold | Блокує | Explicit acknowledgement після operator steps | Таке саме acknowledgement | Не блокує recovery |
| Installed infrastructure current | Так | Так | Так | Перевірена installed recovery compatibility |
| Ancestry / regression fence | Так | Ancestry так; fence не стирається | Ancestry bypass; fence не стирається | Expected local previous; explicit recovery |
| Current host audit | Так | Так | Так | Не потрібен: відновлюємо baseline |
| Snapshot+candidate trial | Так | Так | Так | Pre/post restore contract |
| Shared lock / activation window | Так | Так | Так | Так |
| LAST_FAILED_SHA | Відмова до rearm/new SHA | Explicit manual rearm, receipt | Так само | Не блокує повернення baseline |

Manual викликає trusted controller з явним `--ack-holds` для конкретних показаних hold reasons/target, коли такі holds є; без acknowledgement refusal. Це документована заміна нинішнього implicit ручного зняття hold. Wrapper SHALL передавати цей прапорець, а operator runbook — містити його; --force не означає --ack-holds. Timer цього прапорця не використовує. Explicit ручний deploy може обійти PAUSED admissions, але не незавершений recovery/shared lock; PAUSED не видаляється. Manual не очищає regression fence: recovery forward до FROM або explicit operator acknowledgement працюють за чинним контрактом.

Строгий timer head equality — новий freshness gate; навіть descendant main відкладає activation. Потенційне голодування за частих merges прийняте; quiet 10 min зменшує його, manual reachable target є явним operator-шляхом. Перевірка гейтів повторюється безпосередньо перед stop під lock; атомарність із наступним GitHub push не обіцяється.

Чинний deployable-range classifier MUST перейти з build-input rsync-filter на runtime-artifact contract. Зміни source/assets/package inputs мають бути deployable навіть без відповідного файла в installed payload; видалення runtime input теж є зміною. Workflow/package manifest/privileged helpers/unit/sudoers/install scripts і control-plane contract changes SHALL вимагати operator hold там, де потрібна установка/зміна довіри. Документація сама по собі не стає runtime release.

Security audit SHALL бути двічі:
1. CI перевіряє production dependency tree після build/prune та до публікації.
2. Перед новою activation хост отримує актуальний `npm audit --omit=dev --package-lock-only --json` для candidate lockfile без install/build/lifecycle scripts.

Audit SHALL використовувати lockfile перевіреного root-private payload у відокремленому non-root audit directory; Python stdlib JSON verdict — installed trusted tool, без candidate/checkout tsx. Explicit trusted registry/config і sanitized env не читають candidate .npmrc чи runtime secrets. **Audit завершено до native probe/trial — першого виконання candidate code.** High/critical — refuse/failed SHA як сьогодні; відсутній/некоректний звіт або registry outage — transient assessment failure, retry next tick, без LAST_FAILED_SHA. Сам exit code npm не є verdict. Audit report ephemeral і не містить env credentials.

### Сценарії
- **WHEN** у dependency з'явилася high advisory після CI, **THEN** host audit блокує нову activation.
- **WHEN** registry не повернув придатний JSON, **THEN** наступний tick може повторити assessment; SHA не позначений невиправно failed.
- **WHEN** змінено package/workflow або installed helper, **THEN** control-plane hold не обходиться application artifact.

## 6. DATA-001 — snapshot і trial із staged release

До зупинки healthy runtime deployer SHALL створити existing `pre` через штатний snapshot helper (`VACUUM INTO`, checksum, окремий snapshot directory). Новий deployer SHALL виконувати trial на окремій копії pre, використовуючи `openDb`/`migrate` саме з перевіреного staged candidate payload.

Trial SHALL запускати migrate двічі, перевіряти незмінність schema version другого запуску, foreign_key_check та integrity_check. Native modules trial — candidate modules; source clone node_modules відсутній. Trial використовує fixed wbb-trial sandbox §2; execution як ysi/service-user/root заборонене. Private DB copy передається через trusted helper у sandbox scratch, без доступу до live DB. Host audit пройдено до execution; після trial cgroup exited і scratch cleanup без доступу candidate до receipt/state.

Trial migration не доводить правильність усіх startup backfills/rewrites: чинна вимога hold і human preflight для небезпечних змін даних залишається. Snapshot online має той самий часовий розрив до activation, що нинішній merge-deploy; автоматичний відкат зберігає всі наступні записи в post для ручного зіставлення, не обіцяє їх автоматичного merge.

### Сценарії
- **WHEN** candidate trial падає або порушує цілісність, **THEN** production не зупиняється, current і DB не змінюються; pre не враховується як settled snapshot.
- **WHEN** trial намагається використати clone build/dependencies, **THEN** regression test це виявляє в середовищі без них.

## 7. ACTIVATE-001 — серіалізація, release identity і recovery

Manual і automatic paths SHALL використовувати один installed controller/shared lock із policy таблиці §5. `bash deploy/deploy.sh` лишається entrypoint wrapper до installed controller, із доданими explicit acknowledgement flags; HEAD визначає SHA, локальні незакомічені файли не деплояться. Dirty checkout відхиляється до mutation; baseline не стирається. Root invocation відхиляється.

**Свідомі operational обмеження:** non-main hotfix branch не деплоїться цим механізмом; спершу merge main та trusted CI artifact. Actions/API outage блокує новий forward admission, а accepted local rollback лишається доступним. Expired/missing artifact після довгого hold відновлюється повним re-run trusted main CI workflow того SHA (якщо дозволяє workflow context) або новим main commit, не local build. Якщо root receipt уже прийняв інший digest, новий commit або explicit reviewed requalification. Break-glass локальних збірок не вводиться.

`--force` SHALL лишатися explicit recovery для обходу ancestry; він MUST NOT обходити artifact provenance, native compatibility, archive safety, lock або current health identity. Автоматичний rollback використовує локально раніше перевірений release без вимоги, щоб його SHA досі був main чи green у GitHub.

State SHALL бути versioned і відрізняти prepared, activation pending, active observing, settled та rollback pending. Existing DEPLOYED_SHA семантику документувати: installed SHA після activation — не settled health proof; settled/window fields лишаються окремими. Перед зупинкою/pointer mutation recovery record атомарно зберігає candidate/previous SHA й digests, pre snapshot, phase і restart observation.

Activation: publish immutable candidate → persist pending → gracefully stop bot → atomic current switch → start bot → record installed SHA → watch. Pointer/current path не є доказом того, який process уже запущений.

`WBB_RELEASE_REQUIRED` — новий validated .env ключ (default false для dev; true обов'язково у production). При true startup читає release.json один раз від realpath application root, перевіряє format/SHA/platform, і відхиляє missing/invalid identity; runtime не доводить provenance самостійно. Unit/read-only release/root receipt забезпечують іншу частину доказу. Змінна SHALL бути додана до .env.example/config/root spec й additive operator update; це deploy:hold.

`GET /health` SHALL зберегти `ok:true` і додати `releaseSha` з identity, прочитаної при startup. Dev без manifest повертає releaseSha=null; production admission null не приймає. Endpoint публічний через existing tunnel: дизайн **явно дозволяє публічний commit SHA** відкритого repo; він не містить env/token/receipt. Remote address==127.0.0.1 не використовується як auth, бо cloudflared теж приходить з loopback. Це запропонований контракт на погодження, не твердження про секретність SHA.

Deployer SHALL перевіряти releaseSha==candidate, startup <=120 s, потім existing 600 s window, health кожні 10 s та NRestarts. Три consecutive failures або NRestarts change запускають rollback. Старий healthy process/порт із іншим SHA не є success. Existing UNVERIFIED semantics після невідстеженого window зберігаються; interrupted activation reconciles під lock, без нового release поверх невідомого state.

**Явна зміна PAUSED:** сьогодні paused tick завершується до lock/recovery; новий tick спершу під lock reconciles pending state, і тільки потім PAUSED блокує нові admissions. Idle+PAUSED лишається тихим; pending+PAUSED може виконати restart/rollback і надіслати recovery alert. «Повну тишу» забезпечує operator stop timer/deploy-service після визначення pending phase; це не healthy claim. Вимкнення systemctl client не вважається зупинкою deploy-service. Повторний tick/reboot читає phase/current/process identity; stale state не позначається settled.

### Сценарії
- **WHEN** старий process повертає ok:true після невдалого restart, **THEN** SHA mismatch блокує success і викликає recovery.
- **WHEN** ручний deployment і timer запускаються разом, **THEN** mutation робить лише один lock owner.
- **WHEN** crash стається між stop/switch/start/state update, **THEN** наступний tick узгоджує phase/current/health; DB snapshot та previous release збережені.
- **WHEN** оператор ставить PAUSED у pending phase, **THEN** controller не починає новий deploy, але не приховує recovery.

## 8. ROLLBACK-001 — локальний код і pre/post DB

До активації candidate старий exact runtime release SHALL бути доступний локально й перевірений; rollback MUST NOT потребувати GitHub/npm/build/network audit.

Rollback target SHALL бути **останній locally verified settled** release, не просто попередній current. UNVERIFIED release зберігається разом з evidence, але автоматично не стає rollback baseline; оператор може прийняти його лише після окремих tree/native/health identity та повного 600 s observation. Без known settled previous нова unattended activation блокується; initial operator install має явний first-release failure contract.

Rollback SHALL зберігати поточний контракт: persisted failed SHA/rollback phase → stop bot → stop Litestream → preserve post DB/WAL/SHM → validate/restore pre → switch current на previous verified release → start Litestream та bot → перевірити previous releaseSha і health. Заміна DB/WAL робиться тільки під чинним lock і після зупинки writers; штатна поведінка Litestream reset/restore лишається за перевіреним helper.

pre/post і інтервал потенційно втрачених writes MUST лишатися доступними оператору; ніякого автоматичного merge. DB snapshots не містять media/OAuth/env: deployment SHALL їх не відновлювати чи переписувати зі старого release. Нові application changes, що роблять такі дані несумісними, потребують окремого rollback design/hold.

Failed/interrupted rollback SHALL лишати phase/evidence та критичне повідомлення, не healthy baseline. First install без previous не обіцяє automatic rollback: unhealthy first release зупиняється/позначається failed, timer paused до recovery.

### Сценарії
- **WHEN** candidate падає на 9:59, **THEN** code+DB rollback спрацьовує з preserved post.
- **WHEN** failure на 10:01 після settled, **THEN** це звичайний incident, а не автоматичний destructive DB rollback.
- **WHEN** GitHub/npm недоступні під час rollback, **THEN** локальний previous release та snapshot достатні для відновлення.
- **WHEN** crash стається під час DB restore або pointer rollback, **THEN** state/evidence не видаляються і не позначаються settled.

## 9. RETAIN-001 — обмеження локального сховища

Обов'язково зберігати current, previous settled, candidate до кінця window і кожен release, на який посилається незавершений recovery/rollback. Непосилальні failed/orphan staging/release trees MAY прибиратися лише під lock після persisted settled/recovery result, з path/identity safeguards.

Поріг >10 GiB — консервативний **admission policy**, а не доведена потреба одного деплою. Warning monitor <=10 GiB і refusal нового deploy на цій межі навмисно узгоджені. До production rollout на фактичній FS вимірюються allocated bytes archive/root-private scratch/current/previous/snapshots і peak; якщо немає цього запасу, rollout blocked або бюджет/поріг переглядається через reviewed spec change. Знижувати поріг автоматично для 40 GB VPS не можна.

Newest 3 settled pre snapshots зберігаються за чинним контрактом. rollback/unverified snapshots та investigation evidence автоматично не видаляються. До нового admission враховувати їхній фактичний розмір; переповнення означає blocked/alert, а не silent cleanup.

GitHub artifact retention SHALL бути явно 30 days для початкового release workflow, у межах дозволеного repository policy. Missing/expired artifact для нового deploy — unavailable/blocked; fallback build немає. Previous local release не залежить від GitHub retention. GitHub Actions/storage витрати SHALL оцінюватися перед установленням workflow; автоматично купувати додаткові платні ресурси не можна.

## 10. TRANSITION-001 — введення на чинному VPS до переїзду

Перехід SHALL бути окремим reviewed PR/серією узгоджених PR із deploy:hold. Спершу CI публікує artifacts без зміни host activation; trusted workflow/package gates, installed helpers/unit/sudoers і state migration вводяться operator-кроком.

Перед operator installation: PAUSED/disabled timer, inactive deployment, завершений health window/rollback, shared lock, приватна backup installed config/unit/state. Installer SHALL перевірити фактичний старий layout, installed SHA та відсутність невідомого drift; не називати dirty tree exact SHA.

Перший перехід SHALL мати приватну **legacy byte capture** попереднього code tree, installed unit/config/state і coherent pre DB. Legacy capture receipt стверджує тільки «ці bytes захоплені з цього path/time, digest та старий health/PID спостережені». Він **не** доводить source SHA/provenance чи відтворюваність host npm install, не отримує releaseSha і не приймається звичайним artifact controller. Recorded legacy DEPLOYED_SHA зберігається лише як історичне metadata, не як attested identity.

Legacy capture потрібна лише operator rollback самого bootstrap: під stopped writers/lock повернути flat layout, старий unit/state/config та сумісну DB з pre/post evidence, перевірити legacy health. Rollout не вважається завершеним до new artifact settled; до цього failure означає operator-required transition recovery, а не вигаданий exact-SHA automatic rollback. First trusted artifact встановлюється operator-кроком із first-release failure contract; після 600 s observation він стає першим settled baseline. Наступний trusted artifact deployment і disposable code+DB rollback завершують acceptance.

Installer SHALL перенести legacy flat `/opt/warsaw-beer-bot` в новий layout під зупиненим bot і lock, атомарно мігрувати state, оновити unit та installed current predicate. Existing manual scripts у старих checkout MUST втратити privileged rsync/delete/unit-install commands через оновлену вузьку sudo policy. Просто оновити новий deploy.sh недостатньо: старий `rsync --delete` може знищити releases/current.

Обидва deployment entrypoints після переходу виконують тільки new controller. Installed privileged files не оновлюються з application archive. Старий host-build механізм не є automatic fallback; повернення до нього можливе лише окремою reviewed operator recovery.

Нова production env SHALL additive отримати WBB_RELEASE_REQUIRED=true. Existing `ysi ALL=(warsaw-beer-bot) NOPASSWD: /usr/bin/bash -lc *` лишається **свідомо збереженим operator maintenance trust**: він дає оператору writable service env/data і можливість запускати ops, але не root-owned release/control plane. «Немає довільної shell» стосується root publication/probe helpers, не цієї старої run-as-service привілеї. wbb-trial не має ні цього правила, ні доступу до service env/data. Acceptance перевіряє обидва боки effective sudo policy. Повне звуження operator maintenance доступу — окремий проєкт.

Перед планом host transition потрібен read-only preflight: audit code/resources на absolute flat `/opt` assumptions та writable cwd/cache/log paths, і спостереження file metadata/write activity за репрезентативний runtime+ops період. `find -newer startup` окремо недостатній — зміни deploy/npm також мають timestamp. Наявних live доказів у цій задачі немає; read-only-host проба залишається explicit gate, не «підтверджено read-only». Якщо програма пише в code tree, конкретні потрібні paths конфігуруються під /var/lib або private /tmp й тестуються без blanket release write permission. Runtime/ops smoke виконується з root-owned read-only release на disposable Ubuntu 24.04 VM.

Один справжній deployment на чинному VPS SHALL пройти exact payload install, trial, observation, scheduled same-main noop. Rollback/reboot/crash rehearsal виконується на **disposable Ubuntu 24.04 x86_64 VM із systemd та тими самими installed unit/helper/sudoers**, приватною копією/санітизованою DB, тестовими credentials і без production Telegram/OAuth/R2. Контейнер без повного systemd/privilege model не замінює ці докази. Production failure штучно не провокувати. Приймання завершується до переїзду VPS.

## 10a. Заявка → доказ

| Запис/заявка | Що саме стверджує | Доказ і межа |
|---|---|---|
| release.json | Identity, яку publisher заявив для payload | Trusted GitHub run/event/path/head_sha/job metadata + ZIP/tar anchors; manifest сам себе не доводить |
| Root accepted receipt | SHA прийнятий з конкретними archive/tree digest | Root verifier independently fetched run/artifact metadata, verified root-private bytes, exact tree; atomic receipt. Accepted != active |
| releases/<sha> verified | У цьому дереві ті самі bytes/modes/targets | Exact per-entry manifest+tree digest, root ownership і повторна перевірка перед activation/rollback; root compromise поза гарантією |
| Host audit PASS | Registry assessment цього lockfile не має high/critical на час перевірки | Valid JSON від trusted npm registry, installed verdict; це не доказ відсутності всіх vulnerabilities |
| TRIAL OK | Ця копія пройшла дві migrate та SQLite checks | Candidate openDb/migrate у isolated cgroup, exact version/results; не правильність усіх бізнес-перетворень |
| DEPLOYED_SHA | Runtime активовано з release identity X | Current resolved verified path + стартовий immutable identity/health SHA; settled доказ окремий |
| /health.releaseSha | Цей процес прочитав release identity X при startup | Frozen composition-root value від realpath file під WBB_RELEASE_REQUIRED; не перечитування current й не SHA source attestation саме по собі |
| Pending phase/substep | Цю дію заплановано, її completion може бути невідомий | Persisted before-action intent + observable unit/current/DB receipts; таблиця recovery нижче, не припущення «дія вже виконана» |
| settled | Runtime SHA X спостерігався 600 s без rollback trigger та evidence gaps | Persisted timed probe sequence, SHA та NRestarts, із чинним порогом 3 health failures; пропуск/boot change дає unverified, а не success |
| previous settled | Це останній прийнятий rollback baseline | Збережений settled receipt + доступний локальний tree/native verify; UNVERIFIED сам baseline не створює |
| rollback post/pre | Bytes після зупинки / snapshot до activation | Checksum coherent snapshots, stopped writer/replicator evidence, atomic marked receipt; не автоматичний merge writes |
| legacy byte capture | Захоплені bytes старого дерева | Path/time/tree hashes й operator receipt; **без** заявки відповідності Git SHA |
| Disk admission PASS | Після фактичного staging є policy reserve | statvfs/allocated-byte вимір під lock на реальній FS; 10 GiB — policy, не емпірична потреба |
| No host builds observed | У виміряному deployment interval відсутні заборонені execs | Exec-event trace у controller/helper/trial cgroups і їх descendants, тільки exe/time/cgroup; не inference за cache mtimes |

## 10b. Crash/recovery matrix

State version 2 SHALL мати transaction ID, boot_id, phase і action-intent substep. Для **кожного рядка** тести переривають: до persist intent, після persist/до дії, після дії/до completion write, після completion. Before-intent crash читає попередню phase; after-action gap не означає ані success, ані невиконання. Atomic rename/pointer, unit/process health, tree/pre/post receipts є незалежними observations. Збереження state/receipts використовує fsync file та parent dir там, де потрібна crash durability.

| Phase / intent перед дією | Що може побачити наступний tick | Рішення під shared lock |
|---|---|---|
| prepared / publish | Root-private scratch, або release без receipt | Повністю перевірити trusted bytes/tree й завершити receipt; без receipt activation заборонена; old bot працює |
| activation pending / stop | Old bot running/stopped; current=old | Idempotent stop old; за невизначеного стану не switch/start. Invalid candidate — abort до current change та restart old |
| activation pending / switch | Current=old або candidate; bot stopped | Перевірити обидва trees/receipts та intent; switch тільки до validated candidate. Інакше повернути old без DB restore, якщо candidate ще не запускався |
| activation pending / start | Candidate stopped або running, SHA відомий/невідомий | systemctl start, якщо inactive; не restart уже healthy matching process. Якщо start міг уже відбутися, new DB writes вважаються можливими; failure — preserved post/code+DB rollback |
| active observing | Matching candidate, timestamps/restart data цілі або втрачено | Продовжити watch лише за безперервного валідного evidence; при gap/reboot завершити unverified, retain pre/trees, alert/operator gate; не settled і не новий deploy |
| settled | Current/process SHA matching чи drift | No-op/retention лише matching receipt; drift — incident/hold, не destructive DB rollback |
| rollback pending / stop writers | Bot/Litestream running або stopped | Idempotent stop обох, verify exit; pre/post restore ще не починати без stopped evidence |
| rollback pending / save post | Post absent, temp incomplete або complete hash receipt | Створити atomic coherent post один раз; incomplete temp не є post. Complete receipt не переписувати новим станом |
| rollback pending / restore pre | DB old/new/incomplete; post complete | Verify immutable pre checksum та complete post; повторити atomic restore і remove stale WAL/SHM лише зі stopped writers |
| rollback pending / switch previous | Pointer candidate/old; writers stopped | Verify previous tree/native і switch old; невідповідність — failed recovery/alert, не запускати інший release |
| rollback pending / start baseline | Previous bot/Litestream inactive/running | Start fixed units без зайвого restart; verify previous SHA/health, тоді write completion. Fail — лишити pending/evidence й critical alert |

Спеціальний first-install intent не має known previous: failure лишає failed/paused, operator legacy transition recovery (§10). Existing paused tick без pending — silent no-op; pending tick застосовує цю матрицю до PAUSED admission gate. UNVERIFIED блокує наступну unattended activation до explicit observation/acknowledgement; автоматичний rollback після закінчення window не вводиться.

## 11. Приймання та доказові перевірки

Реалізація SHALL мати automated coverage:
1. CI root/extension failure/cancel/PR-main gates, unpacked artifact completeness й absence secrets.
2. Wrong SHA/workflow/event/run/digest; artifact expiry; same SHA conflicting digest.
3. Node ABI/architecture/glibc/native module mismatch; traversal/unsafe links/oversize/no disk.
4. Audit high/critical проти no-report/registry failure, без lifecycle/install.
5. Candidate trial двічі/погана DB/відсутні clone dependencies; snapshot retention.
6. Shared lock manual/timer, dirty checkout refusal, force boundaries, main moved і holds.
7. Exact health SHA, startup deadline, 3 failures, changed NRestarts, 9:59/10:01 boundary.
8. Crash на кожній persistent activation/rollback phase, PAUSED recovery та repeat idempotence.
9. Code+DB rollback без мережі, preserved post/media/OAuth, first install без previous.
10. Старий rsync command більше не дозволений effective sudo policy; installed infrastructure drift блокує.
11. ZIP limits/digest/run-scoped selection, attempted re-runs із unique names, skipped package на main, cancelled stale attempts.
12. Root-private TOCTOU: змінений operator archive/tree між verify і publication не приймається; rollback tree tamper refusal.
13. wbb-trial не читає service/operator/root secrets, не має мережі/sudo й не лишає descendants після timeout.
14. Усі allowlisted TS ops працюють із unpacked read-only release; старі absolute flat paths і cwd writes ловляться smoke.

Host acceptance SHALL підтвердити:
- встановлений manifest/digest/source SHA та process health SHA;
- відсутність install/build/lifecycle/test процесів під час host preparation/activation/rollback: bounded Linux exec-event trace з exe/time/cgroup для controller/helpers/trial та descendants, без args/env/secrets. Proc polling/npm-cache timestamps самі цього не доводять. Trace на disposable VM також перевіряє підкладений заборонений короткий exec; лише після цього той самий collector використовується на приймальному deployment;
- actual runtime assets і existing operational commands;
- actual scheduled tick/same-main noop без restart;
- RAM/disk/inode peak та час preparation/activation, без необґрунтованої обіцянки величини економії;
- Telegram/API/extension/MCP/festival read smoke зі збереженням credentials і user data;
- existing snapshot/Litestream restore contract та code+DB rollback на disposable environment.

**Завершено** означає: код/CI/tests/docs узгоджені з root spec, reviewed infrastructure встановлена, реальний artifact deployment прийнятий на старому VPS. Green CI або наявність archive самі по собі не є завершенням переходу.

## 12. Подальші дії

Канонічний документ має бути в WBB `docs/superpowers/specs/2026-10/`, поруч із project history; misc copy лишається дзеркалом. Review-response має поіменний статус A1–E. Наявні source/runtime-write/disk-cap live gates не видаються виконаними; вони потрібні до планування production transition.

**Одна специфікація, окремі поетапні плани:**
1. **Ядро-1:** package job, runtime/ops asset allowlist, manifest/tree inventory, isolated unpacked CI proof. На хості нічого не змінюється. Після реалізації — наскрізне review цього ядра.
2. **Ядро-2:** Python admission/publication/audit, isolated probe/trial, current activation **разом із crash recovery та local code+DB rollback**, claims evidence і phase matrix. Реалізація/acceptance тільки на disposable systemd VM; production ще не переключається. Rollback — частина ядра, не периферія. Після наскрізного review пишеться наступний план.
3. **Обв'язка:** installer/state/legacy layout transition, effective sudo changes, retention, runbooks/root spec updates і live operator rollout після preflight. Жодна production activation не дозволена до робочого rollback/recovery ядра.

Після погодження цієї редакції пишеться лише план ядра-1 у WBB monthly plans directory, із перечитуванням його інструкцій. Кореневий spec інтегрує вимоги звичайною українською, узгоджено з його стилем; IDs/сценарії лишаються трасованими. Новий production VPS створюється й переноситься після прийнятого artifact deployment.

Офіційні довідки для implementation verification: [GitHub artifact REST API](https://docs.github.com/en/rest/actions/artifacts), [upload-artifact](https://github.com/actions/upload-artifact). API download повертає ZIP redirect, fine-grained permission — Actions:read; run-scoped listing і digest використовуються за цим контрактом. Доступність API fields та behavior поточної версії upload action перевіряються package/admission integration tests.
