# Деплой образом — стадія «б2», ядро: база `NRestarts` після активації і ручний режим контролера — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** у контролері `deploy/image/autodeploy.sh` (досі ніде не встановленому):
- виправлена база `NRestarts` вікна за пробою V14;
- ручний режим `--manual` із трьома входами (деплой, закриття інциденту, перший образ-реліз). Вони пишуть той самий стан і проходять ті самі гейти й вікно, що й tick.

**Хост не змінюється.** Контролер не встановлюється, таймер і далі запускає старий `deploy/autodeploy.sh`. Єдиний крок на хості: `db-snapshot.sh` дістає нову дію `unmark` (зворотно сумісно), тож його встановлена копія застаріє, і старий таймер це помітить. Тому після мерджу треба `sudo bash deploy/install-autodeploy.sh`, потім `bash deploy/deploy.sh`.

Це **ядро «б2»**. Окремим планом, після наскрізного рев'ю ядра, іде обв'язка «б2»:
- `deploy/image/deploy.sh` — перевірки checkout-а і встановленої копії, виклик `--manual`;
- розділ оператора в `deploy/README.md`;
- статус спеки.

Далі — стадія «в».

Спека: `docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md`, поправка 3 (затверджена 21.10). Використані розділи:
- секція «Для власника»;
- V14, V15;
- §4.3; §6.3–6.4;
- §7.1 (`WINDOW_KIND`, прибраний `WINDOW_NRESTARTS_PRE`); §7.2 (нові рядки); §7.3; §7.4;
- §8 п.2; §14.

Попередній план: `docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md`. Його «Рішення» 1–18 і «Рішення власника» 1–8 діють.

**Tech Stack:**
- bash — контролер;
- TypeScript/Vitest — тести через симульований хост `scripts/autodeploy/image-autodeploy-harness.ts`. Справжні лише bash, git і `db-snapshot.sh`.

## Рішення (поправка 3 → код)

1. **Граматика.** Будь-що інше — вихід 64. `<sha>` — 40 hex у нижньому регістрі. `--target` обов'язковий: контролер не знає checkout-а людини, HEAD йому передає обгортка.
   ```
   autodeploy.sh                                              # таймер, як було
   autodeploy.sh --manual deploy --target <sha> [--force] [--ack-incompatible]
   autodeploy.sh --manual bootstrap --target <sha>
   autodeploy.sh --manual resolve-incident --settled <sha>
   ```
2. **Спільний пролог ручного запуску:**
   - PAUSED → вихід 1 з поясненням (tick виходить тихо з 0, людині ж потрібна відповідь);
   - lock через `flock -n`: зайнятий → вихід 1 «the deploy lock is held (a tick or another deploy.sh)». Облік `lock-busy-since` ручний запуск не чіпає;
   - `read_state || state_corrupt`, далі `retry_pending_marks`;
   - відкрите вікно (`WINDOW_PHASE` непорожній) → вихід 1 «a window of X is open — the timer finishes it».
3. **Інцидент:**
   - `deploy`/`bootstrap` при відкритому інциденті → вихід 1, повідомлення називає `--resolve-incident`;
   - `resolve-incident` без інциденту → вихід 1.
4. **Ціль на `main`:** після `git fetch`: `git merge-base --is-ancestor <sha> origin/main`, інакше вихід 1. Причина — атестація вимагає `refs/heads/main`, спека «На чому стоїть рішення».
5. **Повідомлення ручного запуску** — ті самі тексти з префіксом `[manual] `: `notify` додає його, коли `MANUAL=1`. Тексти tick-а не змінюються, отже його тести теж.
6. **Вихідні коди** — ті самі:
   - 0 — settled / noop / up to date;
   - 1 — відмова, будь-яка, зокрема зайнятий lock і відкрите вікно;
   - 2 — відкочено;
   - 3 — інцидент / `STATE CORRUPT`;
   - 4 — не вдалося записати стан;
   - 64 — usage.
7. **Гейти `deploy`** (таблиця §7.4):
   - quiet main, `candidate_held`, `candidate_retry` пропускаються;
   - CI, `installed_is_stale`, аудит, trial лишаються як у tick-а;
   - `DEPLOYED_SHA` має бути предком X, інакше вихід 1, крім `--force`;
   - fence регресії (#768) ручний деплой не зупиняє: «Deploy main by hand» — це і є його розв'язання;
   - `X == DEPLOYED_SHA` → «up to date», вихід 0.
8. **Holds у ручному запуску.** `scan_range` додатково заповнює `CONTRACT_PRS` (PR з `rollback:unsafe`/`migration:contract`) і `SCAN_UNREAD=1`, коли щось не вдалося прочитати. `HOLDS` і повідомлення tick-а не змінюються. Ручний `deploy`:
   - holds за шляхом і `deploy:hold` пропускає;
   - `CONTRACT_PRS` непорожній або `SCAN_UNREAD=1` без `--ack-incompatible` → вихід 1 з переліком;
   - з `--ack-incompatible` — далі.
9. **Режим вікна ручного `deploy`:** `manual`, якщо дано `--ack-incompatible`, інакше `auto`. Людина, яка дала прапорець без потреби, однаково відмовилась від автовідкату. `WINDOW_KIND=deploy`.
10. **Вердикти pipeline у ручному запуску:**
    - `TRIAL/START FAILED`, `AUDIT ADVISORY` → `refuse` (з `LAST_FAILED_SHA`, як tick);
    - `COMPAT FAILED` без прапорця → `CANDIDATE_HELD` (доведений факт) і вихід 1 з порадою `--ack-incompatible`;
    - `COMPAT FAILED` з прапорцем → далі, режим `manual`;
    - `trial REFUSED` → вихід 1 без `CANDIDATE_RETRY_*`, людина повторить сама;
    - noop → як у tick-а: саме так знімається hold за кроком хоста.
11. **Ручний запуск не пише `LAST_SEEN_DEPLOYED_SHA`.** Спостереження переходу лишається таймеру (#768): ручний даунгрейд з `--force` наступний tick побачить як «went BACKWARDS» і поставить fence, як зі старим `deploy.sh`. Виняток — `resolve-incident` (п.13): людина щойно назвала базу, тож fence там був би шумом.
12. **Успіх ручного вікна з `X == LAST_FAILED_SHA`** очищає `LAST_FAILED_SHA` у записі settled.
13. **`resolve-incident --settled S`:**
    - resolve + attest → D;
    - `local --digest D` має дати `LOCAL D I content=C revision=S`;
    - `current`: `quadlet=D`, `container-digest=D`, `container-image=I`, `unit=quadlet`;
    - `/health.releaseSha == S`;
    - будь-що інше → вихід 1 з тим, що не збіглося, стан не змінюється.

    Далі одним записом (`start_watching` без `compare`):
    - `INCIDENT=""`;
    - `WINDOW_KIND=resolve`, `WINDOW_MODE=manual`, `WINDOW_PHASE=watching`;
    - `WINDOW_SHA/DIGEST/ID/CONTENT` = S/D/I/C, `WINDOW_OLD=$DEPLOYED_SHA`, `WINDOW_PREV_DIGEST=$SETTLED_DIGEST` (може бути порожнім), `WINDOW_PRE=""`, `WINDOW_BOOT`.

    Settled:
    - `SETTLED_*`, `DEPLOYED_*`, `DEPLOYED_SHA`, `LAST_SEEN_DEPLOYED_SHA` = S;
    - кожен шлях `RETAINED_PRE` → `db-snapshot.sh unmark`; ім'я, яке надрукував скрипт, іде в лог. Успішні виходять зі списку, невдалі лишаються, і повідомлення їх називає.

    Провал вікна → `open_incident 0`: без вини, S не кандидат.
14. **`bootstrap --target X`.**
    - Передумови: `SETTLED_DIGEST` порожній, `DEPLOYED_SHA` непорожній (сіє стадія «в»), X на main, `DEPLOYED_SHA` предок X або рівний.
    - Далі CI → resolve → attest → pull → audit → `current`:
      - `unit=foreign` → друк кроків root (зупинити бота, перемістити `/etc/systemd/system/warsaw-beer-bot.service`, `daemon-reload`), вихід 1, стан не змінюється;
      - `unit=quadlet` → вихід 1 «a Quadlet unit exists but nothing is settled — check by hand»;
      - `unit=absent` → далі.
    - API port, boot id, pre-знімок (`PENDING_PRE`, як pipeline), `trial --digest D --previous D --snapshot` → очікується `OK D`.
    - Вікно: `WINDOW_KIND=bootstrap`, `WINDOW_MODE=manual`, `WINDOW_PREV_DIGEST=""`, `WINDOW_OLD=$DEPLOYED_SHA`, `WINDOW_PRE=pre`, далі `activate_candidate` і вікно.
    - Settled: `SETTLED_*` = D. Провал → інцидент з виною X (рішення власника 3).
15. **Валідація стану:**
    - `WINDOW_KIND` (`deploy|bootstrap|resolve`) обов'язковий при будь-якому вікні;
    - `bootstrap` і `resolve` ⇒ `WINDOW_MODE=manual`;
    - `WINDOW_PREV_DIGEST` порожній ⇔ `bootstrap`, або `resolve` без settled;
    - `WINDOW_PRE` порожній лише для `resolve`;
    - інакше `STATE CORRUPT`.
16. **Відновлення (§7.2, нові рядки):**
    - `bootstrap`/`activating`, `quadlet=none`, `unit=absent` → вікно скасовано з повідомленням «повтори `deploy.sh --bootstrap`». Pre — через `PENDING_PRE`/discard, як для скасованого вікна;
    - `bootstrap`/`activating`, Quadlet = D → рядки 2–3;
    - `resolve`/`watching` → рядки 4–5;
    - `retain_pre` з порожнім `WINDOW_PRE` нічого не робить.
17. **P4 (V14).**
    - `WINDOW_NRESTARTS_PRE` прибирається з allowlist, валідації і `deploy_pipeline` разом із читанням `restarts_pre`;
    - `start_watching compare`: прочитане `r > 0` → `window_failed "the candidate restarted during startup (NRestarts ${r} since its activation)"`; база вікна — `r`;
    - фейковий `activate` у harness ставить `nrestarts=0` (як `restart` за V14), `daemon-reload` у ньому лічильник не чіпає.

## Таблиця «заявка → доказ» (що записує це ядро)

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| `NRestarts > 0` на старті після активації = кандидат рестартував | лічильник рахує лише рестарти кандидата | `activate` завжди робить `restart` (`wbb_image.py`), `restart` скидає в 0 (V14) | сильний |
| `WINDOW_KIND` | звідки вікно, і що робити на settled/провалі | пишеться в тому ж записі, що й вікно, до будь-якої зміни production | сильний |
| `SETTLED_*` після ручного `deploy` | X працював 600 с чисто | той самий `watch_window` | сильний |
| Hold пройдено вручну | кроки хоста виконано | слово людини (п.8) | слабкий за природою — свідомо (§14) |
| `SETTLED_*` після `resolve` | S працював і був здоровий 600 с | вікно + `current`/`local`/`releaseSha` перед ним | сильний |
| `RETAINED_PRE` звільнено | людина закрила інцидент, доказ більше не потрібен | `unmark` лише після settled `resolve`; ім'я — з виводу скрипта | сильний |
| `SETTLED_*` після `bootstrap` | D працював 600 с на production | вікно `bootstrap`; compat нічого не доводить (нема S) | сильний як вікно |
| `CANDIDATE_HELD` з ручного запуску | `COMPAT FAILED` для пари | вердикт хелпера | сильний (як у tick-а) |
| `LAST_FAILED_SHA` знято | X, що провалився раніше, пройшов повне вікно | settled ручного вікна з X | сильний |

**Проби до реалізації.** Нових нема: V14 (P4) і V15 зроблено 21.10. P3 — у «в».

## Global Constraints

- Правила тестів CLAUDE.md. Гейт: `su tester -c 'cd /home/user/warsaw-beer-bot && npm test && npm run typecheck'` і від root `npm test -- scripts/release.test.ts`.
- `sudo`, `podman`, `systemctl`, `curl`, `gh` у тестах — лише seams. Справжні bash, git і `deploy/db-snapshot.sh`.
- Тести ручного режиму живуть у новому `scripts/autodeploy/image-autodeploy-manual.test.ts`. Harness дістає `manual(w, args, env?)` — той самий запуск, що `tick`, з аргументами.
- Точні асерти: лог подій, розібраний стан, тексти повідомлень, код виходу. Очікувані значення — літерали тесту.
- Не змінюються: `deploy/autodeploy.sh`, `deploy/deploy.sh`, `ships.sh`, `rsync-filter`, `record-deployed.sh`, `install-*.sh`, хелпер. `db-snapshot.sh` — лише нова дія `unmark`. Перед PR: `git diff --name-only origin/main`.
- PR: `[deploy:hold]` і мітка `deploy:hold`. Кроки людини: `sudo bash deploy/install-autodeploy.sh`, потім `bash deploy/deploy.sh`. Новий контролер не встановлюється.

---

### Task 1: P4 — база `NRestarts` після активації (дрібна, інлайн)

**Files:**
- `deploy/image/autodeploy.sh`;
- `scripts/autodeploy/image-autodeploy-harness.ts`;
- тести: `image-autodeploy-window.test.ts`, `image-autodeploy-recovery.test.ts`, `image-autodeploy-gates.test.ts`.

- [ ] Тести спершу:
  - (а) Старий реліз мав `nrestarts=5`. Кандидат після `activate` (harness → 0) один раз рестартує до першого опитування (`nrestarts=1`) → провал «the candidate restarted during startup (NRestarts 1 since its activation)», відкат, `LAST_FAILED_SHA=X`. Сьогодні контролер вважає це чистим стартом (`1 > 5` хибне), тож до фіксу тест червоний.
  - (б) Старий реліз мав 5, кандидат не рестартує → вікно з базою 0, settled.
  - (в) Рядок 3 відновлення («після рестарту, до `watching`»): seeded `activating`, працює D, `nrestarts=0` → `watching` з базою 0; з `nrestarts=2` → провал старту.
  - (г) Стан із `WINDOW_NRESTARTS_PRE` → `STATE CORRUPT` (невідомий ключ).
  - Тести «below it: new base» (`image-autodeploy-window.test.ts:676–691`) переписуються під (б)/(в), а не видаляються: їхній факт — «нижчий лічильник після активації не є провалом».
- [ ] Реалізація за п.17. Сиди стану в тестах без `WINDOW_NRESTARTS_PRE`.
- [ ] Мутація: повернути порівняння з лічильником до активації → червоні (а) і (в).
- [ ] Гейт, коміт («the window's NRestarts base is zero after an activation (V14)»).

### Task 2: `--manual deploy`

**Files:**
- `deploy/image/autodeploy.sh`, harness;
- новий `scripts/autodeploy/image-autodeploy-manual.test.ts`.

- [ ] Тести спершу. Кожен з точним логом подій, станом, повідомленнями й кодом.
  - (а) Usage: без підкоманди; невідома підкоманда; `deploy` без `--target`; короткий чи верхньорегістровий SHA; `--force` двічі; `--settled` у `deploy` → 64, нуль подій.
  - (б) Пролог: PAUSED → 1; lock зайнятий (тест тримає `flock` на `$STATE_DIR/lock`) → 1, `lock-busy-since` не створено; відкрите вікно → 1, вікно не змінено; інцидент → 1 з текстом про `--resolve-incident`; `STATE CORRUPT` → 3.
  - (в) Ціль не на `main` (коміт у бічній гілці) → 1, нуль викликів хелпера.
  - (г) Щасливий шлях: X на main, свіжий мердж (quiet main не минув), held шлях у діапазоні → без hold:
    - події `[… resolve, attest, pull, current, audit, local S, snapshot, trial, activate D, …опитування]`;
    - settled, вихід 0;
    - повідомлення з `[manual] `;
    - `WINDOW_KIND=deploy`, `WINDOW_MODE=auto` у стані на `activate`;
    - `LAST_SEEN_DEPLOYED_SHA` не змінено.
  - (ґ) Провал у вікні `auto` → відкат на S, вихід 2, `LAST_FAILED_SHA=X`.
  - (д) `CONTRACT_PRS` без прапорця → 1 з переліком PR, нуль викликів хелпера. З `--ack-incompatible` → деплой, `WINDOW_MODE=manual`; провал → інцидент (3), без `activate S`.
  - (е) `SCAN_UNREAD`: мітки нечитані → 1; з `--ack-incompatible` → деплой у `manual`.
  - (є) `COMPAT FAILED` без прапорця → `CANDIDATE_HELD` записано, 1, pre відкинуто. З прапорцем → вікно `manual`.
  - (ж) `trial REFUSED` → 1, `CANDIDATE_RETRY_*` порожні.
  - (з) Noop (рівний `wbb.content`) → `DEPLOYED_SHA=X`, 0, нуль `activate`: hold за кроком хоста знято.
  - (и) Не предок без `--force` → 1. З `--force` → деплой; наступний **tick** бачить «went BACKWARDS» і ставить fence (п.11).
  - (і) `X == DEPLOYED_SHA` → 0 «up to date».
  - (ї) `X == LAST_FAILED_SHA` → деплой; settled очищає `LAST_FAILED_SHA`.
  - (й) CI `image` відсутній → 1 (WAIT для людини — відмова з поясненням); `installed_is_stale` → 1.
  - (к) Переривання: `kill` контролера посеред вікна (`reply.*` = `kill`) → наступний **tick** доводить вікно до settled. Режим і `WINDOW_KIND` — зі стану.
  - (л) Регресія: усі тести tick-а без змін зелені. Тексти повідомлень tick-а без `[manual]`.
- [ ] Реалізація за п.1–12: розбір аргументів на початку; `MANUAL`, `ACK_INCOMPATIBLE`, `FORCE`, `TARGET`. Гейти tick-а у функції, щоб ручний шлях пропускав свої (п.7) без копіювання решти. `scan_range` → `CONTRACT_PRS`, `SCAN_UNREAD`. `WINDOW_KIND` в allowlist і валідації (п.15). `deploy_pipeline` бере режим зі змінної.
- [ ] Мутації — кожна з червоним тестом:
  - ручний шлях не пропускає holds → (г);
  - прапорець не дає `manual` → (д);
  - `LAST_SEEN_DEPLOYED_SHA` пишеться → (и);
  - `SCAN_UNREAD` ігнорується → (е);
  - зайнятий lock чекає → (б).
- [ ] Гейт, коміт.

### Task 3: `--manual resolve-incident` і `db-snapshot.sh unmark`

**Files:**
- `deploy/image/autodeploy.sh`, `deploy/db-snapshot.sh`;
- тести: `scripts/autodeploy/db-snapshot.test.ts`, `image-autodeploy-manual.test.ts`, `image-autodeploy-recovery.test.ts`.

- [ ] Тести спершу.
  - (а) `unmark`:
    - `…-rollback-pre.db` і `…-unverified-pre.db` (з `.sha256`) → `…-pre.db` + `.sha256`, друкує новий шлях, вихід 0;
    - незначений `…-pre.db`, нема файлу, нема checksum, ціль уже існує → `die`, нічого не перейменовано;
    - після `unmark` `prune` рахує файл серед звичайних.
  - (б) Відмови без зміни стану: інциденту нема; resolve/attest не пройшли; `local` дав іншу revision; `current` з іншим `quadlet` / `container-digest` / `unit=foreign`; `releaseSha ≠ S`. Кожна → 1 і повідомлення з тим, що не збіглося.
  - (в) Щасливий шлях:
    - одним записом `INCIDENT=""` і `WINDOW_KIND=resolve`, `MODE=manual`, `PHASE=watching`, `WINDOW_PRE=""` (стан у лог на першому опитуванні);
    - 600 с → `SETTLED_*` = `DEPLOYED_*` = S, `LAST_SEEN_DEPLOYED_SHA=S`;
    - два `RETAINED_PRE` справді `unmark`-нуті (справжній `db-snapshot.sh` у temp), список порожній, вихід 0;
    - нуль `activate`.
  - (г) Один `unmark` падає → він лишається в `RETAINED_PRE`, повідомлення його називає, settled однаково.
  - (ґ) Провал вікна → `INCIDENT` знову, `LAST_FAILED_SHA` не змінено, нуль `activate S`, вихід 3.
  - (д) Перерване вікно `resolve` → tick (гейт інциденту його не зупиняє: інциденту вже нема) доводить до settled з `unmark`.
  - (е) `resolve` без settled (інцидент на bootstrap): `WINDOW_PREV_DIGEST=""` валідний, settled дає перший `SETTLED_*`.
- [ ] Реалізація за п.13, 15, 16. `settle` гілкується за `WINDOW_KIND`; `window_failed` у `manual` для `resolve` — `open_incident 0`.
- [ ] Мутації:
  - `INCIDENT` знімається окремим записом після вікна → (д);
  - `unmark` до settled → (ґ);
  - `open_incident 1` для `resolve` → (ґ).
- [ ] Гейт, коміт.

### Task 4: `--manual bootstrap`

**Files:** `deploy/image/autodeploy.sh`, тести `image-autodeploy-manual.test.ts` і `image-autodeploy-recovery.test.ts`.

- [ ] Тести спершу (стан: `DEPLOYED_SHA` засіяний, `SETTLED_*` порожні; хост: `unit=foreign`, Quadlet-файлу нема).
  - (а) Перший запуск:
    - події `[resolve, attest, pull, audit, current]`;
    - вихід 1;
    - stdout з кроками root дослівно;
    - стан байт у байт той самий;
    - нуль `snapshot`/`trial`/`activate`.
  - (б) Другий запуск (`unit=absent`):
    - `snapshot`, `trial --digest D --previous D`, вікно `bootstrap`/`manual` з `WINDOW_PREV_DIGEST=""` у стані на `activate`;
    - 600 с → `SETTLED_*` = D, вихід 0;
    - далі tick з новим мерджем іде звичайним `auto`-шляхом проти S = D.
  - (в) Передумови: `SETTLED_DIGEST` є → 1; `DEPLOYED_SHA` порожній → 1; `unit=quadlet` → 1; X не нащадок `DEPLOYED_SHA` → 1.
  - (г) Провал вікна → інцидент з `LAST_FAILED_SHA=X`, нуль `activate S` (нема на що), pre утримано (`RETAINED_PRE`).
  - (ґ) Відновлення: `bootstrap`/`activating`, `quadlet=none`, `unit=absent` → вікно скасовано, pre відкинуто, повідомлення «повтори»; `bootstrap`/`activating`, Quadlet = D, працює D → `watching`.
  - (д) Валідація: `bootstrap` з `WINDOW_MODE=auto` або з непорожнім `WINDOW_PREV_DIGEST` → `STATE CORRUPT`.
- [ ] Реалізація за п.14–16.
- [ ] Мутації:
  - bootstrap пише стан до перевірки юніта → (а);
  - режим `auto` → (г);
  - рядок 1 порівнює `q` з порожнім `WINDOW_PREV_DIGEST` → (ґ).
- [ ] Гейт, коміт.

---

## Після: наскрізне рев'ю ядра → план обв'язки «б2» → «в»

- Наскрізне рев'ю Tasks 1–4. Task 1 інлайнова, тож вона обов'язково входить у пакет рев'ю.
- Cross-review codex; AI-рев'ю PR.
- **Обв'язка «б2»** (окремий план):
  - `deploy/image/deploy.sh` — брудний checkout, HEAD не на `origin/main`, встановлена копія ≠ `deploy/image/autodeploy.sh` checkout-а → відмова; інакше `exec` встановленої копії з `--manual …` і `--target HEAD`;
  - розділ оператора в `deploy/README.md`: три команди, bootstrap-кроки root, ручний fallback bootstrap;
  - статус спеки і «Фактично» після останнього PR.
- **«в»:**
  - перенесення гейтових ключів зі `state.env` у `image-state.env` (сіє `DEPLOYED_SHA` для bootstrap);
  - `git mv`; інсталятор; `unit=` у статусі; `TimeoutStartSec=125min`;
  - репетиція і P3 на тестовому юніті;
  - bootstrap;
  - прибирання: `wbb-release` → `/opt` → старі копії → NOPASSWD.
