# Artifact deployment — Ядро-2в: активація, crash recovery і локальний code+DB rollback — Implementation Plan (ядро)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** останній шматок Ядра-2 (спека §12 п.2) — механізм, заради якого все робиться: **перемкнути production на прийнятий реліз і повернути код разом із БД, якщо він не витримав вікна**, так, щоб падіння процесу в будь-якій точці лишало стан, який наступний tick доводить до кінця. Спека §7 ACTIVATE-001, §8 ROLLBACK-001, §10b crash/recovery matrix, §10a рядки DEPLOYED_SHA, Pending phase/substep, settled, previous settled, rollback post/pre.

**Чому 2в ділиться на ядро й обв'язку.** Повний controller — це state v2, рушій активації й відкату, плюс перенесення всіх гейтів `autodeploy.sh` (lock, PAUSED, CI, holds, quiet main, ancestry/regression fence, LAST_FAILED, notifications), `/health.releaseSha`, sudo-адаптер хоста, обгортка `deploy.sh`, retention. Пізні частини спираються на рушій, якого ще немає (CLAUDE.md, «велика зміна йде стадіями»). Тому:
- **2в-ядро** (цей план) — state v2, два хостові примітиви (перемикання `current`, durable post/restore БД) і рушій активації/відкату з resume за матрицею §10b. Рушій працює проти інжектованого `Host`; справжнього хоста не торкається.
- **2в-обв'язка** (окремий план після наскрізного рев'ю ядра) — tick: lock, PAUSED, гейти §5, виклики `wbb_release.py publish/audit/probe/trial`, pre snapshot, справжній `Host` через sudo/systemctl/HTTP, notifications, `/health.releaseSha` і `WBB_RELEASE_REQUIRED` (`[deploy:hold]`, новий ключ `.env`), `deploy.sh`, retention і prune з урахуванням state, міграція state v1→v2.

Production activation, як і раніше, заборонена до кінця 2в. Інсталятор, sudoers, юніти, користувачі — обв'язка всього Ядра-2 (спека §12 п.3).

**Tech Stack:** Python ≥3.12 stdlib. Candidate-код не виконується; рушій не читає нічого з `releases/<sha>`, крім того, що вже перевіряє `verify_release`.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md`.

## Вхідні дані

### Наскрізне рев'ю Ядра-2б (2026-10-09)

_Заповнюється з висновків рев'ю перед стартом Task 1._

### Проба засновків (2026-10-09, до плану)

| Засновок | Проба | Результат |
|---|---|---|
| Запущений процес прив'язаний до дерева, з якого стартував, а не до `current` | Node 24, `cd current && node <abs>/current/dist/index.js`, де `current → releases/aaa` | `__filename`, `require.main.filename` і `process.cwd()` — **реальні** шляхи `releases/aaa/...`; `release.json` читається від realpath. Отже, перемикання `current` не змінює того, що бачить уже запущений процес, і `releaseSha`, прочитаний при старті від `__dirname`, — це дерево процесу. Підтверджує спеку §2 (realpath main, chdir) |
| `db-snapshot.sh post` придатний для рядка §10b `save post` | читання коду | **Ні.** Копіює просто в цільову теку без receipt і без fsync; після падіння на півдорозі повтор відмовляє «refusing to overwrite», а неповна тека виглядає як готовий post. Тому post/restore переходять у Python-модуль цього плану (Task 2) |
| `db-snapshot.sh restore` безпечний при падінні | читання коду | **Ні.** Спершу `mv` нової БД на місце, потім `rm -wal/-shm`. Падіння між ними лишає відновлену `pre` поруч зі **старим WAL пост-стану**, який SQLite застосує при відкритті. Новий restore прибирає WAL/SHM **до** заміни і робить fsync |

## Таблиця «заявка → доказ» цього плану

Кожне місце, де рушій записує щось як факт:

| Заявка (що пишеться) | Що стверджує | Доказ | Сила |
|---|---|---|---|
| `phase`/`intent` у state | Цю дію заплановано; виконання невідоме | Durable запис (fsync файлу й теки) **до** дії. Не доводить, що дію виконано: resume перевіряє спостереженням | сильний — інжекція падіння в кожну точку (Task 4) |
| `current = X` | Новий старт піде з дерева X | `readlink(current)` дорівнює рівно `releases/<X>` + `verify_release(X)` у root helper безпосередньо перед rename | сильний |
| `bot stopped` | Старий процес більше не пише | `ActiveState ∈ {inactive, failed}` після `stop`; інше — крок не завершено | сильний (контракт systemd) |
| процес працює X | Відповідає саме процес із дерева X | `health().releaseSha == X` — **заявка обв'язки** (`/health.releaseSha`); у ядрі це інтерфейс `Host`. Засновок realpath — проба вище | сильний за умови обв'язки |
| `settled` | X спостерігався 600 с без тригера відкату | Persisted вибірки: кожна в тому самому `bootId`, проміжок між сусідніми ≤ `GAP_S`; від старту ≥ `WINDOW_S`; підряд невдач < 3; `NRestarts` прочитано хоч раз і він не мінявся | сильний |
| `previous settled` | Цей реліз — базова лінія для відкату | Тільки перехід у `settled` після повного вікна; `unverified` його не створює | сильний |
| post complete | Байти БД після зупинки writers | Тека, атомарно перейменована з `.partial`, з `post.json` (розмір і sha256 кожного файлу), записаним після fsync файлів | сильний |
| БД відновлено з pre | Живий `bot.db` — це pre | `sha256(bot.db) == pre.sha256` і немає `-wal`/`-shm`; робиться лише після complete post | сильний |

Рядків із лічильником чи припущенням про зовнішній файл тут немає. Єдина залежність від обв'язки — `releaseSha` — позначена явно.

## Global Constraints

- **State v2** — один JSON-файл `deploy-state.json` у теці state, canonical JSON, `formatVersion: 2`. Запис: temp у тій самій теці → `fsync(file)` → `rename` → `fsync(dir)`. Читання: відсутній файл → `None` (перший запуск); зіпсований, невідома версія або порушена схема → `StateError`, **ніколи** не «чистий аркуш».
- Поля: `txn` (hex, нова на кожну активацію; `null` у спокої), `phase`, `intent`, `bootId` (boot, у якому записано поточний phase/intent), `candidate`/`previous` (`{sha, treeSha256}`), `pre` (`{path, sha256, takenAt}`), `post` (шлях або `null`), `observe` (`{startedAt, bootId, nrestarts0, lastSampleAt, fails}`), `settled` (`{sha, treeSha256, settledAt}` — останній settled, тобто baseline відкату), `lastFailedSha`, `unverified` (`{sha, reason, pre}` або `null`), `evidence` (список подій останньої транзакції: що, коли, результат).
- **Phase / intent** (§10b):
  - `settled` — спокій; `intent=null`.
  - `activating`: `stop` → `switch` → `start`. Після завершення `start` — `observing`.
  - `observing` — вікно; `intent=null`.
  - `rolling-back`: `stop-writers` → `save-post` → `restore-pre` → `switch-previous` → `start-baseline`. Якщо candidate ще **не стартував** (`start` не було persisted), відкат іде без БД: `switch-previous` → `start-baseline` (§10b рядок `switch`: «повернути old без DB restore»).
  - `unverified` — вікно не доведено (gap, reboot, `NRestarts` жодного разу не прочитано). Нова unattended activation заблокована до явного ack; відкату немає (§8, §10b).
  - `recovery-failed` — відкат не вдався; evidence лишається, нової активації немає.
- **Порядок кожного кроку:** persist `intent` → дія → спостереження → persist наступний `intent` (це і є completion). Кожна дія ідемпотентна й перевіряється спостереженням, тому resume просто повторює поточний `intent`.
- **Константи** (з чинного merge-deploy і §7): `STARTUP_S = 120`, `WINDOW_S = 600`, `POLL_S = 10`, `HEALTH_FAILS_MAX = 3`, `GAP_S = 30` (три пропущені опитування — це вже не безперервне спостереження).
- **Health** — невдача: не ok **або** `releaseSha != candidate` (старий процес на порту — не успіх, §7).
- **Host** — протокол (класи з методами), який рушій отримує параметром: `bot_state()`, `stop_bot()`, `start_bot()`, `litestream_state()`, `stop_litestream()`, `start_litestream()`, `current()`, `switch(sha)`, `health()`, `nrestarts()`, `boot_id()`, `post(dir)`, `restore(pre)`, `now()`, `sleep(s)`. Ядро постачає лише фейк для тестів і справжні `switch`/`post`/`restore` (Task 2); решта справжнього адаптера — обв'язка.
- **Шляхи** — константи (`/opt/warsaw-beer-bot/current`, теки state і БД) лише в CLI; функції беруть їх параметром, тести production-шляхів не чіпають.
- Тести: `npm test -- <args>`; повний гейт кожної задачі — `npm test && npm run typecheck`. Python-тести — `deploy/release/test_*.py`, кожен новий файл додається в `scripts/deploy-rsync.test.ts`. Правила тестів CLAUDE.md діють; crash-тести перевіряють **стан світу** (процес, pointer, файли БД), а не лише state-файл.

---

### Task 1: `deploy_state.py` — versioned state v2

**Files:** create `deploy/release/deploy_state.py`, `deploy/release/test_deploy_state.py`.

- [ ] `load(path) -> State | None` і `save(path, state)` за Global Constraints; `State` — frozen dataclass з валідацією в конструкторі (дозволені пари phase/intent, SHA — 40 hex, обов'язкові поля для кожного phase).
- [ ] `new_txn()`, `read_boot_id(path='/proc/sys/kernel/random/boot_id')`.
- [ ] Тести:
  - round-trip кожного phase;
  - відсутній файл → `None`; порожній, не JSON, `formatVersion: 1`, невідомий phase, `activating` без `candidate`, intent з чужого phase → `StateError` з причиною;
  - `save` не лишає temp при успіху; при збої `rename` (мок) старий файл цілий;
  - запис робить `fsync` файлу й теки (мок `os.fsync` фіксує порядок: файл, потім тека після rename).

### Task 2: хостові примітиви — `current` і durable post/restore

**Files:** modify `deploy/release/publish.py` (`current_path`, `current_sha`), `deploy/release/wbb_release.py` (`switch --sha`, root); create `deploy/release/dbsnap.py`, `deploy/release/test_dbsnap.py`; extend `test_publish.py`, `test_wbb_release.py`.

- [ ] `current_sha(roots)`: `readlink(<dirname(releases)>/current)`; рівно `releases/<40 hex>` → SHA; відсутній → `None`; будь-що інше (не symlink, абсолютна чи чужа ціль) → `Refused`.
- [ ] `switch(sha, roots)`: `verify_release(sha)` → symlink `current.tmp-<rand>` → `releases/<sha>` (відносна ціль) → `os.replace` → `fsync(dir)`. Уже вказує на sha → no-op. CLI: `switch --sha`, exit 0/1/64; рядок `SWITCHED <sha>` або `CURRENT <sha>`.
- [ ] `dbsnap.post(db, out_dir)`: якщо `out_dir/post.json` валідний і файли йому відповідають → повернути його (ідемпотентно). Інакше прибрати `out_dir.partial`, скопіювати `db`, `-wal`, `-shm` (наявні) з fsync, записати `post.json` (`{files: {name: {size, sha256}}}`) з fsync, `rename` → `out_dir`, `fsync(parent)`. `out_dir` існує без валідного `post.json` → `Refused` (не переписуємо те, чого не розуміємо).
- [ ] `dbsnap.restore(pre, db, post_dir)`: вимагає валідний complete post; sha256 `pre` дорівнює його `.sha256`. Якщо `db` уже дорівнює pre і немає `-wal`/`-shm` → no-op. Інакше: прибрати `-wal`, `-shm` (**до** заміни — коментар із причиною), копія `pre` → `db.restore-partial` з fsync → `rename` → `fsync(dir)`.
- [ ] CLI `dbsnap.py post|restore` (exit 0/1/64) — його запускатиме обв'язка від користувача бота.
- [ ] Тести:
  - `current_sha`: symlink на реліз, відсутній, звичайна тека, абсолютна ціль, `releases/../x`;
  - `switch` на неприйнятий SHA → відмова, `current` не змінено; повторний switch → no-op;
  - post: повтор після готового post нічого не переписує (mtime/inode); залишений `.partial` прибирається; WAL і SHM потрапляють; `out_dir` без `post.json` → відмова;
  - restore: без post → відмова; зіпсований pre → відмова, БД ціла; **сценарій старого WAL**: справжня SQLite, яка після restore відкривається й містить рівно дані pre;
  - restore після падіння між прибиранням WAL і rename (мок) → повтор доводить до кінця.

### Task 3: `activate.py` — активація і вікно

**Files:** create `deploy/release/activate.py`, `deploy/release/fake_host.py`, `deploy/release/test_activate.py`.

- [ ] `begin(store, host, candidate, pre)`: лише з `settled` з baseline (`settled` не `null`), `candidate.sha != lastFailedSha`, `candidate.sha != settled.sha`; інакше `Refused` без запису. Записує `activating/stop`, `previous = settled`.
- [ ] `step(store, host) -> Outcome`: виконує поточний `intent` і повертає `continue | settled | unverified | rolled-back | recovery-failed | blocked`:
  - `stop`: `stop_bot()`; не `inactive/failed` → `blocked` (стан не змінюємо, наступний tick повторить).
  - `switch`: `switch(candidate)`; `current() != candidate` → відкат без БД.
  - `start`: якщо бот активний і `health().releaseSha == candidate` — не перезапускати; інакше `start_bot()`. Далі `observing` з `observe.startedAt = now`, `bootId`.
  - `observing`: опитування кожні `POLL_S`, кожне persisted. Startup: ok з правильним SHA до `STARTUP_S`, інакше відкат. Далі до `WINDOW_S`: 3 невдачі підряд або зміна `NRestarts` → відкат; кінець вікна без жодного прочитаного `NRestarts` → `unverified`; інакше `settled` (`settled = candidate`, `txn = null`).
- [ ] `run(store, host)`: `step` до термінального Outcome.
- [ ] `FakeHost`: світ (стан бота й litestream, який SHA реально запущений, `current`, файли БД у tmp-теці, `NRestarts`, годинник), сценарії health, і **точки падіння**: кожен метод `Host` і кожен `save` state може кинути `Crash` до або після дії.
- [ ] Тести: щасливий шлях до `settled`; старий процес відповідає ok з іншим SHA → відкат; невдача на 9:59 → відкат; 3 невдачі не підряд → `settled`; зміна `NRestarts` → відкат; `NRestarts` ніколи не прочитано → `unverified`; `begin` з `lastFailedSha`, без baseline, з `unverified` → `Refused`.

### Task 4: відкат і resume за матрицею §10b

**Files:** modify `deploy/release/activate.py`, `deploy/release/test_activate.py`; create `deploy/release/test_crash_matrix.py`.

- [ ] Кроки `rolling-back` за Global Constraints: `stop-writers` (бот і litestream, обидва підтверджено зупиненими), `save-post` (`post` у state після complete), `restore-pre`, `switch-previous`, `start-baseline` (litestream, потім бот; `releaseSha == previous` до `STARTUP_S`). Успіх → `settled` на `previous`, `lastFailedSha = candidate`, `evidence` з pre, post і проміжком втрачених записів. Невдача кроку, що не лікується повтором, → `recovery-failed` з evidence.
- [ ] `resume(store, host)` на старті tick: `None`/`settled` → нічого; `activating`/`rolling-back` → повторити `intent`; `observing` → якщо `boot_id()` змінився або `now - lastSampleAt > GAP_S` → `unverified` (pre лишається, `settled` не рухається), інакше продовжити вікно; `unverified`/`recovery-failed` → нічого не робити, повернути Outcome для повідомлення. `settled` із `current()` чи `releaseSha`, що не дорівнює `settled.sha` → Outcome `drift` без жодної дії (§10b рядок settled).
- [ ] **Crash-матриця** (`test_crash_matrix.py`): для сценаріїв «успіх», «відкат у startup», «відкат на 9:59», «відкат без БД (switch не вдався)» пройти повний прогін, перелічити всі точки падіння (кожен виклик Host і кожен `save` — до і після), і для **кожної** точки: прогін до `Crash` → новий рушій → `resume`/`run` до термінального Outcome. Інваріанти після кожного:
  - бот запущений рівно з того SHA, який state називає (`settled.sha`), або state у `recovery-failed`/`unverified` з evidence;
  - `settled` ніколи не вказує на SHA, чиє вікно не завершилось повністю;
  - complete post ніколи не переписано; restore не почався без complete post;
  - якщо candidate стартував і пішов відкат — БД дорівнює pre; якщо не стартував — БД не чіпали;
  - `lastFailedSha` встановлено тоді й лише тоді, коли candidate відкочено;
  - падіння в `observing` через reboot (зміна `boot_id`) → `unverified`, не `settled`.
  Кількість точок друкується в назві subTest, щоб нова дія в рушії автоматично додавала нові падіння.
- [ ] `spec.md` §5.9 — абзац про рушій (state v2, phase/intent, resume), `deploy/README.md` — опис модулів; `scripts/deploy-rsync.test.ts` — нові файли.

---

## Після ядра

Наскрізне рев'ю ядра 2в (рушій, crash-матриця, примітиви). Далі план обв'язки 2в: tick (lock, PAUSED: спершу `resume`, потім гейт admission — спека §7 «Явна зміна PAUSED»), гейти §5 з таблиці «Гейти за шляхом», виклики `wbb_release.py`, pre snapshot, справжній `Host`, notifications, `/health.releaseSha` + `WBB_RELEASE_REQUIRED` (`[deploy:hold]`), `deploy.sh`, retention/prune із захистом pre/post, на які посилається state, міграція state v1→v2. Acceptance рушія на справжньому systemd — на disposable VM (спека §10).
