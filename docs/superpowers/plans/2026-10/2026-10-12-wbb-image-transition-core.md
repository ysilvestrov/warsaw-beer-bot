# Деплой образом — перехід, ядро: root-хелпер `wbb-image` і START без сигналів — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** У репо є root-хелпер `wbb-image` (спека §5) з тестами, його інсталятор і sudoers-файл; `start-check` вміє не зупиняти бота сигналом (`--leave-running`), а шаблон Quadlet дає podman-у той самий тайм-аут зупинки, що й systemd. **Хост не змінюється**: хелпер ніде не встановлений, merge-deploy і далі деплоїть flat-дерево. Це ядро стадії «перехід» (спека §8: стадії а → б → в); `autodeploy.sh` під образи (б) і перемикання хоста (в) — окремими планами після рев'ю цього.

Спека: `docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md` — §3.2 (шаблон, перевірка юніта), §3.3 (ідентичність), §5 (хелпер), §6.3 (compat, `--leave-running`), §9 (місце перед pull, `prune`), V9–V13 у §2.

**Tech Stack:** Python 3.12 stdlib (хелпер; Ubuntu 24.04 на хості, `ubuntu-latest` у CI), Node 24 CommonJS (`start-check`), bash (інсталятор), Vitest (тести TS і запуск Python-набору).

## Рішення

1. **START без сигналів у контейнері (V11).** `start-check.cjs` отримує прапор `--leave-running`: після вердикту не кличе `child.kill`, а одразу `process.exit(code)`. У контейнері він PID 1, тож його вихід розбирає PID-простір, і ядро вбиває бота SIGKILL-ом (його AppArmor не перевіряє). Без прапора — чинна поведінка (SIGTERM → 20 с → SIGKILL): на хості тестів дочірній процес інакше став би сиротою. Прапор, а не автодетект `process.pid === 1`, — щоб поведінку можна було перевірити тестом і щоб хелпер явно казав, чого хоче.
2. **Таймаут старту — окремий вердикт.** Спека §6.3: таймаут START (D) — «не вдалося перевірити», не провал кандидата. `start-check` друкує `START TIMEOUT: no "api listening" within <N>s` і виходить **75** (решта кодів: 0 `START OK`, 1 `START FAILED`, 64 usage). Smoke у CI вимагає 0, тож для нього нічого не змінюється, крім прапора.
3. **COMPAT (S) запускає `start-check` з образу S**, тому S мусить знати `--leave-running`. Старий `start-check` на невідомий прапор відповідає 64 → хелпер дає `REFUSED: previous image <S> predates start-check --leave-running` (вихід 2, не 75: повтор нічого не змінить). Перший образ-реліз активує людина без compat (спека §8 п.2) — він уже з поправкою.
4. **`PodmanArgs=--stop-timeout=20`** у шаблоні: Quadlet-ключа `StopTimeout=` у podman 4.9 нема (dry-run дає `unsupported key`), а згенерований `ExecStop=podman rm -v -f -i` чекає тайм-аут контейнера (10 с за замовчуванням), тож без цього `TimeoutStopSec=20` нічого не давав би. Інсталятор перевіряє шаблон `quadlet -dryrun` на хості (Task 4).
5. **Де живе хелпер.** `deploy/image/helper/`: `wbb_image.py` (вся логіка), `bounded.py` (копія `deploy/release/bounded.py` з її тестом — `deploy/release/` видаляється на стадії «в», тож хелпер не імпортує нічого звідти), `wbb-image.sh` (обгортка як `deploy/wbb-release.sh`: `python3 -I -B`, перевірка компіляції, 70 без бібліотеки), тести `test_*.py`. На хості: `/usr/local/lib/wbb-image/{wbb_image.py,bounded.py,warsaw-beer-bot.container}`, `/usr/local/libexec/wbb-image`, `/var/lib/wbb-image` (root, 0700; scratch для trial).
6. **Межа довіри — argv.** `argparse` з підкомандами й `required=True`; `--sha` — 40 hex у нижньому регістрі; `--digest`, `--previous`, `--keep` — `sha256:` + 64 hex; `--snapshot` — ім'я `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}-pre\.db$` у `SNAPSHOT_ROOT` (не шлях; відкривається `O_NOFOLLOW`, мусить бути звичайним файлом). Жодних шляхів і довільних аргументів podman від оператора. Усе, що залежить від хоста (шляхи, `podman`/`systemctl`, UID бота, місце на диску), — у датакласі `Host`, який `main()` отримує параметром: тести підставляють фейки без monkeypatch.
7. **«Образ нашого репо»** (спека §5): `podman image inspect <ref> --format json` → `RepoDigests` містить `ghcr.io/ysilvestrov/warsaw-beer-bot@<D>` і є мітка `org.opencontainers.image.revision` (40 hex). Посилання на локальний образ — завжди `ghcr.io/ysilvestrov/warsaw-beer-bot@<D>` з `--pull=never` (V10: так працює і `run`, і Quadlet).
8. **Контейнери trial/audit** мають ім'я `wbb-image-<дія>-<pid>-<крок>`: на тайм-аут `bounded.run` зупиняє клієнт `podman`, а контейнер може пережити його — `finally` робить `podman rm -f -i <ім'я>`. Ізоляція trial (спека §5, §6.3): `--rm --pull=never --network=none --read-only --tmpfs /tmp --cap-drop=ALL --security-opt=no-new-privileges --user <uid>:<gid> --memory=1g --pids-limit=256 -v <scratch>:/data`, підставне оточення як у `scripts/image-smoke.sh` (`TELEGRAM_BOT_TOKEN=123456:abcdefghij`, `OSRM_BASE_URL=http://x`, `NOMINATIM_USER_AGENT=x`, `DATABASE_PATH=/data/app.db`, `WBB_RELEASE_REQUIRED=true`, `API_PORT=3000`); `.env` не монтується. Audit — те саме, але `--network=host`, без томів і без `DATABASE_PATH` (спека §5: мережа потрібна npm-реєстру, bridge-мережа rootful podman на хості не перевірена).
9. **Перевірка юніта** (спека §3.2, V10): `systemctl show warsaw-beer-bot.service -p LoadState,SourcePath,FragmentPath` → `quadlet`, якщо `SourcePath` = `/etc/containers/systemd/warsaw-beer-bot.container` і `FragmentPath` починається з `/run/systemd/generator/`; `absent`, якщо `LoadState=not-found`; інакше `foreign`. `activate` дозволений при `quadlet` і `absent` (перша активація після видалення старого юніта), `foreign` → `REFUSED`. Після запису файлу й `daemon-reload` — та сама перевірка ще раз; не `quadlet` → `REFUSED` (файл лишається, рестарту нема).
10. **Hold.** Нові `deploy/install-image.sh` і `deploy/sudoers.d/wbb-image` збігаються з hold-шаблонами, тож PR несе `[deploy:hold]` + мітку `deploy:hold`. Кроку на хості **немає** (нічого не встановлюється) — лише `bash deploy/deploy.sh` після мерджу. `path_is_held` для `deploy/image/helper/**` і шаблону додає стадія «б», яка й так переписує `autodeploy.sh` (зміна `autodeploy.sh` тут вимагала б перевстановлення його копії — справжній крок на хості без жодної користі, доки хелпер не встановлений).

## Таблиця «заявка → доказ» (що записує це ядро)

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| `PULLED <D> <I> …` | Локальний образ I — це D з нашого репо, коміт X | `.Digest == D`, `RepoDigests` ∋ `ghcr.io/…@D`, мітка `revision == X` після pull; атестацію перевіряє оператор до pull (стадія б) | сильний; тест хелпера на кожну розбіжність → `REFUSED` |
| `TRIAL OK` / `START OK` / `COMPAT OK` | Міграції D, старт D і старт S на тій самій копії pre | Вердикти `trial-migrate`/`start-check` з образів; ізоляція п.8 | як у спеці §14 (середній для сумісності) |
| `START TIMEOUT` → 75 | Не вердикт про кандидата | Окремий код `start-check`; тест таймауту | сильний |
| `ACTIVATED <D>` | Quadlet-файл указує на D, активний юніт — наш, рестарт виконано | Атомарний запис, `SourcePath`/`FragmentPath` до і після `daemon-reload` | сильний на момент перевірки; здоров'я — вікно стадії б |
| `CURRENT …` | Що в Quadlet-файлі і з якого образу контейнер | `.Image`/`.ImageDigest` (V10) | сильний |
| `PRUNED` | Видалено лише наші образи поза `--keep` і поза Quadlet-файлом | Тест: образ із Quadlet-файлу лишається навіть без `--keep` | сильний |

## Global Constraints

- Правила тестів CLAUDE.md. Гейт: `su tester -c 'cd /home/user/warsaw-beer-bot && npm test && npm run typecheck'` плюс `npm test -- scripts/release.test.ts` від root; перед гейтом прибрати `__pycache__` у `deploy/release` і `deploy/image/helper`.
- `podman` і `systemctl` у тестах не викликаються: хелпер отримує фейковий runner (записує argv, повертає заскриптований `CompletedProcess`). Справжній podman — репетиція на хості (стадія в).
- Python-набір хелпера має вкладатися в 60 с (окремий `describe` у `scripts/release.test.ts`, свій тайм-аут).
- PR з `[deploy:hold]` і міткою `deploy:hold`; у описі: «кроку на хості немає; після мерджу — `bash deploy/deploy.sh`».

---

### Task 1: `start-check --leave-running`, `START TIMEOUT`, шаблон

Дрібна за CLAUDE.md (код нижче повний, два файли + тести, рішень не лишилося) — контролер робить інлайн; входить у review-пакет Task 2.

**Files:** `deploy/image/start-check.cjs`, `scripts/image-smoke.sh`, `deploy/image/warsaw-beer-bot.container`; тести `scripts/image-start-check.test.ts`, `scripts/image-smoke.test.ts`, `scripts/image-volumes.test.ts`.

- [ ] Тести спершу (`image-start-check.test.ts`):
  (а) `--leave-running` і здоровий фейковий бот, що пише свій PID у файл і живе вічно (`setInterval`): вихід 0, перший рядок `START OK <sha>`, процес із PID із файлу **живий** після виходу (`process.kill(pid, 0)` не кидає; тест сам вбиває його в `afterEach`), а маркер SIGTERM бота **не** записаний;
  (б) `--leave-running` і `/health` з `ok:false`: вихід 1, `START FAILED: /health answered …`, бот живий;
  (в) без прапора — чинний тест «then stopped» лишається зеленим (маркер SIGTERM записаний);
  (г) таймаут: вихід **75**, перший рядок `START TIMEOUT: no "api listening" within 1s` (було `START FAILED`, exit 1);
  (ґ) `--leave-running` з зайвим значенням (`--leave-running x`) → 64.
- [ ] `start-check.cjs`: `parseArgs` приймає булевий `--leave-running` (без значення; цикл по argv більше не крокує по 2 — розібрати явно); `main` повертає `{ code, leave }`; після друку вердикту: `leave` → `process.exit(code)` без `stop()`; інакше `await stop(child)` як зараз. Таймаут: `console.log(\`START TIMEOUT: no "${READY}" within ${opts.timeoutS}s\`)`, хвіст виводу, код 75. Шапка файлу: прапор, чому (V11) і що його використовують лише як PID 1 контейнера.
- [ ] `scripts/image-smoke.sh`: `node deploy/image/start-check.cjs --leave-running` (у контейнері CI він теж PID 1); `image-smoke.test.ts` — очікуваний argv виклику з прапором.
- [ ] Шаблон: `PodmanArgs=--stop-timeout=20` у `[Container]` з коментарем (Рішення п.4); `image-volumes.test.ts` (або сусідній тест шаблону) — точний рядок присутній.
- [ ] Мутації: прибрати `process.exit` у гілці `leave` (тест (а) зависне до тайм-ауту тесту → червоний); повернути таймауту код 1 → (г) червоний.
- [ ] Гейт, коміт.

### Task 2: хелпер — каркас, ідентичність образу: `pull`, `current`, `prune`

**Files:** нові `deploy/image/helper/wbb_image.py`, `deploy/image/helper/bounded.py` (копія `deploy/release/bounded.py`), `deploy/image/helper/test_bounded.py` (копія), `deploy/image/helper/test_wbb_image.py`, `deploy/image/helper/wbb-image.sh`; `scripts/release.test.ts` (другий `describe`, що запускає `python3 -B -m unittest discover -s deploy/image/helper -p 'test_*.py' -v`).

- [ ] Каркас: `Host` (dataclass, frozen): `podman`, `systemctl` (шляхи до бінарів), `run` (callable як `bounded.run`), `quadlet_path`, `template_path`, `snapshot_root`, `scratch_root`, `containers_root` (для місця), `free_bytes` (callable), `bot_ids` (callable → `(uid, gid)` з `pwd.getpwnam('warsaw-beer-bot')`), `now`/`pid` за потреби. `PRODUCTION = Host(...)`. `main(argv, host=PRODUCTION) -> int`; коди 0 / 1 / 2 (`REFUSED:` у stderr) / 64 / 70 (traceback) / 75 (`TEMPFAIL:` у stderr) — як у `wbb_release.py`, той самий захист імпорту на рівні модуля (70, не 1).
- [ ] Валідатори (Рішення п.6) — окремі функції з тестами на межі: SHA з великими літерами, 39/41 символ, `sha256:` з 63/65 hex, ім'я знімка з `/`, `..`, без `-pre.db`.
- [ ] `pull --sha X --digest D`: `free_bytes(containers_root) < 5 GiB` → `REFUSED` (спека §9: відмова з повідомленням, не тиха чистка); `podman pull ghcr.io/…@D` (тайм-аут 600 с; ненульовий вихід → 75 з хвостом stderr); `image inspect` → `.Digest == D`, `RepoDigests` ∋ `…@D`, `revision == X` — інакше `REFUSED` (з тим, що побачили); друк `PULLED <D> <I> content=<wbb.content> revision=<X>`.
- [ ] `current`: Quadlet-файл (рядок `Image=ghcr.io/ysilvestrov/warsaw-beer-bot@sha256:…`; файлу нема → `none`; інший формат → `REFUSED`), `podman container inspect warsaw-beer-bot --format '{{.Image}} {{.ImageDigest}}'` (контейнера нема → `none none`), тип юніта (Рішення п.9) → `CURRENT quadlet=<D|none> container-image=<I|none> container-digest=<D'|none> unit=quadlet|foreign|absent`.
- [ ] `prune --keep D [--keep D2 …]` (`action='append'`, щонайменше один): `podman images --filter reference=ghcr.io/ysilvestrov/warsaw-beer-bot --format '{{.Id}} {{.Digest}}'`; видалити (`podman rmi <id>`) кожен, чий digest не в `--keep` і не в Quadlet-файлі; помилка `rmi` (образ у використанні) — не фатальна, рахується в `skipped`. Друк `PRUNED <n> skipped <m> kept <digests…>`.
- [ ] Тести (фейковий runner, тимчасові каталоги для `quadlet_path` і т.п.): точні argv кожного виклику podman/systemctl; кожна розбіжність `pull` → 2 і нуль подальших викликів; брак місця → 2 і **жодного** `podman pull`; збій pull → 75; `current` у трьох станах юніта і без контейнера; `prune` ніколи не видаляє образ із Quadlet-файлу, навіть коли його нема в `--keep`; невідома підкоманда/зайвий аргумент → 64; виняток усередині → 70 з traceback.
- [ ] `wbb-image.sh`: як `deploy/wbb-release.sh` (шлях `/usr/local/lib/wbb-image/wbb_image.py`, повідомлення `sudo bash deploy/install-image.sh`); тест у `release.test.ts` (як для `wbb-release.sh`, якщо він там є; інакше — новий): без бібліотеки → 70, з бібліотекою, що не компілюється, → 70.
- [ ] Мутації: прибрати перевірку `revision` → тест розбіжності червоний; прибрати виняток Quadlet-образу з `prune` → червоний; поміняти 75 на 1 для збою pull → червоний.
- [ ] Гейт, коміт.

### Task 3: хелпер — `trial`, `audit`, `activate`

**Files:** `deploy/image/helper/wbb_image.py`, `deploy/image/helper/test_wbb_image.py`.

- [ ] `trial --digest D --previous S --snapshot NAME` (S може дорівнювати D — перша ручна перевірка):
  1. обидва — «образи нашого репо» (п.7), інакше `REFUSED`; знімок за п.6, нема → 75 (`TEMPFAIL: no snapshot`; спека §6.3);
  2. scratch: `tempfile.mkdtemp(dir=scratch_root)`, `chown` на UID/GID бота, `0700`; копія знімка в `<scratch>/app.db` (з дескриптора, відкритого `O_NOFOLLOW`), `chown`, `0600`; `finally` — `shutil.rmtree` і `podman rm -f -i` контейнерів кроку;
  3. TRIAL: `node deploy/trial-migrate.cjs /app /data/app.db` в образі D (тайм-аут 180 с): 0 → далі; 1 → `TRIAL FAILED: …` (перший рядок виводу), вихід 1; інше / тайм-аут / OOM → 75;
  4. START (D): `node deploy/image/start-check.cjs --leave-running --timeout 90` (тайм-аут контейнера 150 с): 0 і рядок `START OK <X>`, де X — `revision` D → далі; 0 з іншим SHA → `REFUSED`; 1 → `START FAILED: …`, вихід 1; 75 → 75; 64 → 70 (наш власний образ не знає прапора — внутрішня помилка); інше → 75;
  5. COMPAT (S): той самий виклик в образі S: 0 і `START OK <revision S>` → `COMPAT OK <S>` (вихід 0); 1 → `COMPAT FAILED: <рядок S>` + хвіст, вихід 1; 64 → `REFUSED: previous image … predates start-check --leave-running` (Рішення п.3); 75 / інше → 75.
  Вивід: по рядку на крок (`TRIAL OK: …`, `START OK …`, `COMPAT OK …`), останній — вердикт. Хвости виводу контейнерів — у stderr, обрізані `bounded`.
- [ ] `audit --digest D`: образ нашого репо; контейнер з п.8 (`--network=host`), команда як у CI-кроці аудиту (`sh -c 'cd /app && npm audit --omit=dev --json | node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts'`), тайм-аут 300 с: 0 → `AUDIT CLEAN <D>`; 10 → `AUDIT ADVISORY <D>` + вивід вердикту, вихід 1; інше → 75.
- [ ] `activate --digest D`: образ нашого репо; тип юніта (п.9) `foreign` → `REFUSED`; шаблон із `template_path` (мусить містити рівно по одному `@@DIGEST@@`, `@@UID@@`, `@@GID@@`, інакше `REFUSED`) → підстановка → запис у `<quadlet>.tmp` у тому ж каталозі (`0644`, root), `fsync`, `rename`, `fsync` каталогу; `systemctl daemon-reload`; повторна перевірка типу (не `quadlet` → `REFUSED`, без рестарту); `systemctl restart warsaw-beer-bot.service`; друк `ACTIVATED <D>`. Ненульовий `daemon-reload`/`restart` → 75 (повтор безпечний: спека §7.2 «повторити activate»).
- [ ] Тести: повна послідовність argv успішного `trial` (точні прапори ізоляції п.8 і оточення — тест фіксує їх, бо це межа безпеки); кожен вихід кожного кроку → свій вердикт і код (таблиця в тесті, без умовної логіки — по тесту на рядок або `it.each`-подібний `subTest`); scratch видалений після успіху, провалу й винятку; `podman rm -f -i` викликаний для кожного запущеного кроку; копія знімка через симлінк → `REFUSED`; `activate` при `foreign` — нуль записів і нуль викликів `systemctl`; файл після `activate` — точний текст шаблону з підставленими D/UID/GID; `foreign` після `daemon-reload` → `REFUSED` і жодного `restart`; шаблон без `@@GID@@` → `REFUSED`.
- [ ] Мутації: переплутати START і COMPAT у мапі «1 → вердикт» → червоний; прибрати `--network=none` з trial → тест argv червоний; прибрати повторну перевірку юніта → червоний; `rmtree` лише на успіху → тест винятку червоний.
- [ ] Гейт, коміт.

### Task 4: інсталятор, sudoers, документи

**Files:** нові `deploy/install-image.sh`, `deploy/sudoers.d/wbb-image`; тест `scripts/install-image.test.ts`; `deploy/README.md`; рядок статусу спеки (якщо змінилося щось, що там названо).

- [ ] `deploy/sudoers.d/wbb-image` (шапка як у `wbb-release`: хто ставить, `visudo -cf`, «`*` ловить пробіли — межа довіри в хелпері»):
  ```
  ysi ALL=(root) NOPASSWD: /usr/local/libexec/wbb-image pull --sha * --digest *, \
      /usr/local/libexec/wbb-image audit --digest *, \
      /usr/local/libexec/wbb-image trial --digest * --previous * --snapshot *, \
      /usr/local/libexec/wbb-image activate --digest *, \
      /usr/local/libexec/wbb-image current, \
      /usr/local/libexec/wbb-image prune --keep *
  ```
- [ ] `deploy/install-image.sh [--check]` (root; з чистого checkout-у `main`): `install -d -m 0755 /usr/local/lib/wbb-image`; `wbb_image.py`, `bounded.py`, шаблон — `0644 root:root`; `wbb-image.sh` → `/usr/local/libexec/wbb-image` `0755`; `install -d -m 0700 /var/lib/wbb-image`; sudoers — `visudo -cf` на тимчасовій копії, потім `install -m 0440`; шаблон з підставленими фіктивним digest і UID/GID бота — `/usr/libexec/podman/quadlet -dryrun` у тимчасовому каталозі (`QUADLET_UNIT_DIRS`), ненульовий вихід або `unsupported key` у stderr → відмова до будь-якого запису. `--check`: нічого не пише; `cmp` кожної копії й режими; вихід 1 з переліком відмінностей. Ніколи не вмикає/не стартує юнітів і не чіпає `/etc/containers/systemd`. Для тестів — `WBB_IMAGE_DESTDIR` (префікс усіх цільових шляхів; тоді без `-o root`, а `visudo`/`quadlet` беруться з `PATH`).
- [ ] `scripts/install-image.test.ts` (з `DESTDIR` у temp і stub-ами `visudo`/`quadlet` у `PATH`, що пишуть свої argv у файл і виходять із кодом зі змінної): (а) встановлює всі файли з точними режимами; (б) `--check` після встановлення → 0; (в) змінена копія → 1 і її шлях у виводі; (г) `visudo` = 1 → sudoers не встановлено, вихід ≠ 0; (ґ) `quadlet` пише `unsupported key` → нічого не встановлено.
- [ ] `deploy/README.md`: розділ «Root helper `wbb-image` (не встановлений до стадії перемикання)» — дії й вердикти, коди виходу, ізоляція trial/audit, як установити й перевірити (`sudo bash deploy/install-image.sh --check`), що репетиція — на стадії «в».
- [ ] Гейт, коміт.

## Після: вхід для стадії «б» (`autodeploy.sh` під образи)

- Наскрізне рев'ю цього ядра; AI-рев'ю PR.
- Контракт хелпера (вердикти, коди) — вхід для гілок `autodeploy.sh`: «поганий кандидат» / «відмова» / «повторити» (спека §5), стан `image-state.env` і таблиця §7.2.
- `path_is_held` + `isHoldPath`: `deploy/image/helper/**`, `deploy/image/warsaw-beer-bot.container`.
- Ще відкрите для стадії «в»: перелік ops-шляхів, які запускає не людина (спека §12 п.2), старі checkout-и, репетиція (спека §8 п.5).
