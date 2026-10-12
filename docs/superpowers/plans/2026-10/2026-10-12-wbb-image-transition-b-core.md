# Деплой образом — перехід, стадія «б», ядро: контролер під образи — стан, вікно, таблиця відновлення — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Статус:** чернетка; проби P1–P2 з VPS пройдені 12.10 (нижче); чекає рішень за «Відкритими питаннями» (власник віддав їх на зовнішнє рев'ю).

**Goal:** у репо є новий контролер merge-deploy під образи — `deploy/image/autodeploy.sh`:
- гейти перенесені без змін; CI-гейт додатково вимагає `image=success`; новий гейт — відкритий інцидент;
- ланцюжок до production: резолв `<sha>` → D, `gh attestation verify`, `wbb-image pull`, noop за `wbb.content`, `audit`, pre-знімок, `trial`;
- стан `image-state.env` з ключами §7.1; вікно записане **до** будь-якої зміни production;
- `activate`, вікно спостереження, settled / відкат лише коду / інцидент;
- кожен рядок таблиці §7.2 — окремий тест.

**Хост не змінюється.** Новий контролер ніде не встановлений. Таймер і далі запускає встановлену копію старого `deploy/autodeploy.sh`, а та деплоїть flat-дерево. Старі `deploy/autodeploy.sh`, `deploy/deploy.sh`, `ships.sh`, `rsync-filter` і `record-deployed.sh` у цій стадії не змінюються й не видаляються.

Це **ядро стадії «б»**. Окремим планом після наскрізного рев'ю цього ядра йде обв'язка «б»:
- ручний вхід `deploy.sh` (`--target`, `--ack-holds`, `--ack-incompatible`, `--resolve-incident --settled`);
- bootstrap першого образ-релізу;
- документи для оператора.

Перемикання хоста — стадія «в».

Спека: `docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md`. Використані розділи:
- §1 п.2–3; §3.3;
- §4 (гейти, §4.1 content-noop, §4.2 аудит);
- §5 (контракт хелпера);
- §6.3 (вердикти compat), §6.4 (manual);
- §7.1–7.3; §8; §9; §14.

Хелпер: `deploy/image/helper/wbb_image.py` (план стадії «а»: `docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md`).

**Tech Stack:**
- bash — контролер, у тому ж стилі seams, що й `deploy/autodeploy.sh`;
- TypeScript/Vitest — тести, які ганяють справжній bash і справжній git проти фейкового хелпера;
- `curl` — анонімний registry API GHCR;
- `gh` оператора — CI, мітки PR, атестація.

## Рішення

1. **Новий файл, а не переписування на місці: мердж стадії «б» нічого не перемикає.**
   - Будь-яка зміна `deploy/autodeploy.sh` — hold-шлях і вимагає перевстановити копію. На хості перевстановлення переписаного файлу **і є** перемиканням production на образи.
   - Hold після мерджу відпускає лише `bash deploy/deploy.sh`.
   - Тому стадія «б» живе в нових файлах: `deploy/image/autodeploy.sh` (контролер) і, в обв'язці, `deploy/image/deploy.sh`. Старий контролер про них не знає: його `path_is_held` їх не ловить, `installed_is_stale` їх не перелічує, а rsync кладе їх у `/opt/deploy/image/`, де їх ніхто не запускає.
   - Стадія «в» робить `git mv` нових файлів поверх `deploy/autodeploy.sh` і `deploy/deploy.sh`. Так назви зі спеки (§4, §11), runbook-ів і правила CLAUDE.md лишаються чинними.
   - **Відкинуто:** переписати на місці з `[deploy:hold]` і відкласти крок на хості до «в». Між «б» і «в» кожен мердж у `main` стояв би на hold, а ручного flat-деплою вже не було б.

2. **Hold стадії «б».** `deploy/image/autodeploy.sh` — у hold-списках (п.12), тож PR несе `[deploy:hold]` і мітку `deploy:hold`.
   - Кроку на хості немає: після мерджу людина запускає `bash deploy/deploy.sh` (flat, як після «а»).
   - Між «б» і «в» PR зі змінами `deploy/image/helper/**` чи шаблону Quadlet теж носять hold без кроку на хості. Це свідома ціна.

3. **Стан — `image-state.env` у тому ж `STATE_DIR`; він розбирається, а не виконується через `.`.**
   - Розбір: `while IFS= read -r line` → ключ з allowlist `STATE_KEYS`, значення — решта рядка. Причина: `INCIDENT=<sha> <digest> <причина>` містить пробіли (§7.1), і `. "$STATE"` виконав би другий токен як команду.
   - `write_state` відмовляє на значенні з `\n` (exit 4).
   - `state.env` новий контролер не читає й не пише.
   - Lock той самий (`$STATE_DIR/lock`): старий `deploy.sh` і новий контролер виключають одне одного.

4. **Ключі стану:** §7.1 плюс сім нових (жирним), бо без них заявкам нема на що спертися.

   | Група | Ключі |
   |---|---|
   | гейтові | `DEPLOYED_SHA`, `PREVIOUS_SHA`, `LAST_SEEN_DEPLOYED_SHA`, `REGRESSION_FROM_SHA`, `REGRESSION_TO_SHA`, `LAST_FAILED_SHA`, `MAIN_SEEN_SHA`, `MAIN_SEEN_S`, `LAST_CI_NOTICE_SHA`, `LAST_HOLD_NOTICE`, `LAST_STALE_NOTICE`, `LAST_ASSESS_NOTICE`, **`LAST_INCIDENT_NOTICE`** |
   | образні | `DEPLOYED_DIGEST`, `DEPLOYED_ID`, **`DEPLOYED_CONTENT`**, `SETTLED_SHA`, `SETTLED_DIGEST`, `SETTLED_ID`, **`SETTLED_CONTENT`** |
   | вікно | `WINDOW_SHA`, `WINDOW_DIGEST`, **`WINDOW_ID`**, **`WINDOW_CONTENT`**, **`WINDOW_OLD`**, `WINDOW_PREV_DIGEST`, `WINDOW_MODE`, `WINDOW_PHASE`, `WINDOW_PRE`, `WINDOW_START`, `WINDOW_BOOT`, `WINDOW_NRESTARTS`, **`WINDOW_REASON`** |
   | hold кандидата | **`CANDIDATE_HELD`**, **`CANDIDATE_HELD_WHY`** |
   | інцидент | `INCIDENT` |

   Семантика:
   - `DEPLOYED_SHA` — гейтова база («production еквівалентний X»).
   - `DEPLOYED_DIGEST/ID/CONTENT` — що запущено.
   - `SETTLED_*` — ціль відкату; міняється лише після повного вікна.
   - `SETTLED_SHA` — мітка `revision` образу `SETTLED_DIGEST`.
   - `WINDOW_OLD` — гейтова база до вікна.

   Спека §7.1 доповнюється в цьому ж PR.

5. **Seams:** кожен контакт зі світом — змінна `WBB_*_CMD` з реальним дефолтом.
   - Перенесені: `CLOCK`, `SLEEP`, `NOTIFY`, `READ_ENV`, `API_PORT`, `CHECKS`, `PR_LABELS`, `RESTARTS`, `SNAPSHOT`, `PRUNE`, `MARK`, `DISCARD`, `INSTALLED_CHECK`.
   - Нові:
     - `WBB_IMAGE_CMD` (`sudo -n /usr/local/libexec/wbb-image "$@"`);
     - `WBB_RESOLVE_CMD` (п.6);
     - `WBB_ATTEST_CMD` (`gh attestation verify oci://ghcr.io/ysilvestrov/warsaw-beer-bot@$1 --repo … --signer-workflow …/ci.yml --source-ref refs/heads/main --source-digest $2 --deny-self-hosted-runners`);
     - `WBB_BOOT_ID_CMD`.
   - `WBB_HEALTH_CMD` друкує `releaseSha`; не `ok` або не 40 hex → вихід 1.
   - Зникають `BUILD`, `AUDIT` (npm), `DEPLOY`, `TRIAL`, `SERVICE`, `POST`, `RESTORE`, `MARK_UNVERIFIED`, `SHIPS`, `checkout_clean`.
   - Приватний clone лишається лише для git-гейтів, без checkout.

6. **Тег → D — анонімно через registry API GHCR, без довіри до відповіді.**
   - Токен з `https://ghcr.io/token?scope=repository:ysilvestrov/warsaw-beer-bot:pull`, потім `curl -sSI` на `/v2/ysilvestrov/warsaw-beer-bot/manifests/<sha>` з `Accept` OCI/Docker manifest → заголовок `docker-content-digest`.
   - Вихід: 0 і `sha256:<64 hex>`; 3 — тегу нема (404); інше — не вдалося прочитати.
   - Довіру дають атестація (D зібрав `ci.yml` з X на `main`) і `pull` (`.Digest == D`, `revision == X`).
   - Проба з хмарної пісочниці 12.10: `fe42fa3` → 200 з `docker-content-digest`, неіснуючий тег → 404. З VPS — P1.
   - `gh api …/packages/…` відкинуто: потребує `read:packages`.

7. **Noop за `wbb.content` (§4.1) — після гейтів і `pull`, до `audit`.**
   - Holds ідуть **до** noop. Інакше PR лише зі `sudoers.d/*` тихо пройшов би як noop.
   - Умови noop: `PULLED … content=C`, `C == DEPLOYED_CONTENT` **і** `current` показує `quadlet == container-digest == DEPLOYED_DIGEST`, `container-image == DEPLOYED_ID`, `unit=quadlet`. Розбіжність — не noop: assess раз на добу, вихід 0.
   - Noop робить `DEPLOYED_SHA = LAST_SEEN_DEPLOYED_SHA = X` і `prune --keep DEPLOYED_DIGEST --keep SETTLED_DIGEST`, без повідомлень.
   - Просування `DEPLOYED_SHA` обов'язкове: інакше hold, знятий ручним деплоєм noop-коміту, ніколи б не відпускався.

8. **CI-гейт: `ci=success` і `image=success` з одного check suite.**
   - `CHECKS_CMD` дає колонку `.check_suite.id`.
   - `image` відсутній або в іншому suite → `WAIT`; `image` неуспішний → `FAIL` (повідомлення раз на SHA).

9. **Розгалуження за вердиктом хелпера — за парою (код, точний рядок), ніколи за кодом.**
   - Рядок вердикту — останній рядок stdout; формат перевіряється регексом.
   - Комбінація поза таблицею (зокрема вихід 1 без рядка — так `sudo -n` відповідає на відсутнє правило) → «не вдалося перевірити», ніколи failed-SHA.

   | Дія | Вердикт | Контролер |
   |---|---|---|
   | `pull` X D | 0 + `PULLED D I content=C revision=X` (саме ті D і X) | далі |
   | `pull` | 2 / 75 / інше | assess, без failed-SHA |
   | `audit` D | 0 `AUDIT CLEAN D` | далі |
   | `audit` | 1 `AUDIT ADVISORY D` | за відповіддю на питання 2 (рекомендовано: refuse → `LAST_FAILED_SHA`) |
   | `audit` | 75 / інше | assess, повтор |
   | `trial` | 1 `TRIAL FAILED:` / `START FAILED:` | `discard` pre, refuse → `LAST_FAILED_SHA` |
   | `trial` | 1 `COMPAT FAILED: …` | `discard` pre, `CANDIDATE_HELD=X`, `CANDIDATE_HELD_WHY`, ⏸ з порадою `deploy.sh --ack-incompatible`; **без** `LAST_FAILED_SHA` |
   | `trial` | 2 `REFUSED:` | `discard` pre, `CANDIDATE_HELD=X`, ⏸ з текстом |
   | `trial` | 0, останній рядок `COMPAT OK <S>` | далі |
   | `trial` | 75 / 70 / інше | `discard` pre, assess, повтор |
   | `activate` D | 0 `ACTIVATED D` | `PHASE=watching` |
   | `activate` D | 1 `ACTIVATE FAILED:` | провал вікна (auto → відкат, manual → інцидент) |
   | `activate` D | 75 | `PHASE` лишається `activating`, ⚠️; наступний tick — рядки 1–2 §7.2 |
   | `activate` D | 2 | `current`: `unit=foreign` → інцидент; інакше вікно скасоване, assess |

   `CANDIDATE_HELD == X` → тихо, нагадування раз на добу. Новий head скидає ключ.

10. **Ціль відкату S мусить бути локальною до trial.**
    - Перед pre: `pull --sha SETTLED_SHA --digest SETTLED_DIGEST`; `I ≠ SETTLED_ID` → assess без деплою.
    - Відкат тоді не залежить від реєстру (V7).
    - Немає `SETTLED_DIGEST` — автоматика не деплоїть («перший образ-реліз — руками», раз на добу).

11. **Вікно, 600 с, опитування кожні 10 с:** health → `releaseSha`; `NRestarts`; `wbb-image current`.
    - Провал:
      - 3 поспіль невдалі health (контейнер `none` теж рахується як невдалий);
      - `releaseSha ≠ X`;
      - `container-image ≠ WINDOW_ID` або `quadlet ≠ WINDOW_DIGEST`;
      - `NRestarts > WINDOW_NRESTARTS`.
    - `unit=foreign` → інцидент.
    - Нечитане опитування — ні провал, ні прохід. Settled вимагає повністю прочитаного й чистого опитування на t ≥ 600; інакше вікно лишається `watching`, і наступний tick його довершує.
    - Старт: після `ACTIVATED` до `STARTUP_S=120` чекати на health з `releaseSha == X` (Quadlet `Type=notify` сигналить про контейнер, не про застосунок). Таймаут → провал.

12. **Hold-списки.**
    - `path_is_held` нового контролера = старий список + `deploy/image/autodeploy.sh` + `deploy/image/helper/*` + `deploy/image/warsaw-beer-bot.container`.
    - `deploy/image/deploy.sh` не held.
    - `isHoldPath` у TS — те саме.
    - Тест паритету: спільні рядки — проти обох bash-предикатів; нові — проти нового й TS.
    - `scan_range` ловить мітки `rollback:unsafe` / `migration:contract` → hold «потрібен ручний деплой з `--ack-incompatible`» (§6.4).

13. **Відкат лише коду й інцидент.**
    - Провал у `auto`:
      1. **першим записом** `LAST_FAILED_SHA=X`, `WINDOW_PHASE=rolling-back`, `WINDOW_REASON`;
      2. ⚠️;
      3. `activate SETTLED_DIGEST`;
      4. до `STARTUP_S` чекати health з `releaseSha == SETTLED_SHA` і `current` з `container-image == SETTLED_ID`, `quadlet == SETTLED_DIGEST`;
      5. ок → `DEPLOYED_* = SETTLED_*`, `DEPLOYED_SHA = LAST_SEEN = WINDOW_OLD`, вікно очищено, 🔥 «rolled back (code only, DB untouched)», вихід 2.
    - `activate S` → 75: одна повторна спроба через 30 с; друге 75, або 1, або 2 → інцидент.
    - Провал у `manual`:
      - без відкату;
      - `mark-rollback WINDOW_PRE`;
      - `INCIDENT=X D <причина>`;
      - 🔥 з інструкцією, вихід 3;
      - `LAST_FAILED_SHA` — за відповіддю на питання 3.
    - `INCIDENT` блокує все, крім PAUSED і lock, ще до `resume_window` і `git fetch`. Нагадування раз на добу, вихід 0.

14. **Утримання (§9).**
    - Settled → `prune --keep D` і `prune` знімків (keep 3).
    - Noop → `prune --keep DEPLOYED --keep SETTLED`.
    - Провал trial → `discard` pre.
    - Провал `auto` → pre не позначається й не видаляється (питання 5).
    - Інцидент / провал `manual` → `mark-rollback`.
    - Зняття утримання (`db-snapshot.sh unmark`) — стадія «в»: зміна `db-snapshot.sh` зробила б застарілою копію старого контролера.

15. **Встановлені копії (`installed_is_stale`) нового контролера:**
    - `deploy/image/autodeploy.sh=$0`, `read-env.sh`, `db-snapshot.sh`, `installed-current.sh`;
    - копії хелпера: `wbb_image.py`, `bounded.py`, `wbb-image.sh`, шаблон.
    - Усі читаються оператором (0644/0755); sudoers (0440) не перевіряється.

16. **Коди виходу tick-а:**

    | Код | Що сталося |
    |---|---|
    | 0 | idle / settled / wait / noop |
    | 1 | refused |
    | 2 | rolled back |
    | 3 | інцидент відкрито |
    | 4 | збій запису стану |

    Вони збігаються з `SuccessExitStatus=0 1 2` чинного юніта.
    - Гірший бюджет tick-а перевищує `TimeoutStartSec=30min`: pull 600 + audit 300 + trial 480 + activate 180 + старт 120 + вікно 600 + відкат 180 + 120.
    - Вбивство tick-а в такому разі покриває §7.2, але питання 6 — підняти до 45 хв на стадії «в».

## Таблиця «заявка → доказ» (що записує це ядро)

| Заявка | Що стверджує | Доказ | Сила |
|---|---|---|---|
| Резолв тегу → D (не факт) | нічого; лише кандидат | довіру дають два рядки нижче | n/a; P1 пройдена: з VPS під таймером 200 + digest для main, 404 → вихід 3 |
| Атестація пройшла (без неї `pull` не викликається) | D зібрав `ci.yml` з X на `main`, hosted runner | `gh attestation verify` з `--source-digest X`; V3/V9; P2 під таймером: 0 на справжньому (~4,5 с), 1 з `expected SourceRepositoryDigest …` на чужому, без мережі — `no valid Sigstore verifiers could be initialized` (ненульовий; будь-який ненульовий = «не вдалося перевірити», п.9) | сильний |
| CI зелений | тести, збірка й образ пройшли на X | `ci` і `image` success з одного suite | сильний |
| `PULLED …` → `WINDOW_ID/CONTENT` | локальний I — це D з `revision == X` | перевірки хелпера; контролер звіряє D і X у рядку з запитаними | сильний |
| `DEPLOYED_SHA = X` після noop | runtime X == запущений runtime | `wbb.content` рівні (CI-тест §4.1) + `current` = DEPLOYED + мітка з атестованого образу | сильний для перелічених випадків; зміни поза образом — hold-шляхи, вони зупиняються до noop |
| `*_CONTENT` | мітка запущеного / settled образу | рядок `PULLED` того образу | сильний |
| `WINDOW_*`, `PHASE=activating` | зараз почнеться зміна production і в якому режимі | `write_state` до `activate`; тест: фейковий `activate` друкує стан у лог | сильний |
| `DEPLOYED_DIGEST/ID = D/I` при `ACTIVATED` | Quadlet указує на D, юніт наш, рестарт пройшов | вердикт хелпера | сильний на момент; здоров'я — вікно |
| `SETTLED_* = D` | D працював 600 с чисто | `watch_window`; фінальне опитування прочитане | сильний |
| `WINDOW_NRESTARTS`, `WINDOW_BOOT` | база для «бот падав, поки ніхто не дивився» | `systemctl show -p NRestarts`; `boot_id` | **середній**: P4 (чи `daemon-reload` регенерованого юніта зберігає лічильник) |
| `LAST_FAILED_SHA = X` | X поганий | лише рядки `TRIAL`/`START`/`ACTIVATE FAILED`, `AUDIT ADVISORY` з кодом 1, або провал вікна з причиною | сильний |
| `CANDIDATE_HELD = X` | X потребує людини | `COMPAT FAILED` (позитивний контроль START (D)) / `REFUSED` з trial | сильний для COMPAT; консервативний для REFUSED |
| `INCIDENT` | production потребує людини | відкат не довів S; провал у `manual`; `unit=foreign` | сильний (консервативний) |
| Pre утримано | доказ стану БД до X не зникне | `mark-rollback` + `prune` його пропускає; для `auto` — за побудовою, тест | сильний |
| Тривалість tick-а | вікно вкладається в `TimeoutStartSec` | V2, V9, V13 | **слабкий**: P3 |

**Проби до реалізації** (spike, нічого не комітять). Результат 12.10 (`wbb-stage-b-probe.sh`, від `ysi` через `systemd-run --uid=ysi -p Environment=HOME=/home/ysi`, main `423ff56`, digest `sha256:62b75e45…`):
- P1: 200 + `docker-content-digest` для main; 404 → вихід 3 для неіснуючого тегу.
- P2: `gh` оператора залогінений (`hosts.yml`, scopes `repo`, `workflow`, `read:org`, `gist`); verify 0 на справжньому, 1 на чужому `--source-digest` з причиною в stderr; без мережі — помилка ініціалізації Sigstore (код виходу проба не зловила — помилка самої проби; рішення п.9 від нього не залежить); кеш `~/.cache/gh` 1,7 MB.

Опис проб:
- **P1.** З VPS від `ysi` в оточенні юніта (`systemd-run --uid=ysi --wait --pipe`) резолв п.6: для свіжого main-SHA очікуємо 200 і digest, для вигаданого — 404.
- **P2.** Там само `gh attestation verify`:
  - вихід 0 на справжньому;
  - вихід і stderr на чужому `--source-digest`;
  - поведінка без мережі;
  - де з'являється TUF-кеш.
  
  Якщо «відмова» й «мережа» мають один код, обидва лишаються «не вдалося перевірити» — п.9 це передбачає.
- **P3** (після встановлення хелпера, стадія «в»): час `pull`, `audit`, `trial` на свіжому pre.

## Global Constraints

- Правила тестів CLAUDE.md. Гейт: `su tester -c 'cd /home/user/warsaw-beer-bot && npm test && npm run typecheck'` плюс `npm test -- scripts/release.test.ts` від root.
- `sudo`, `podman`, `systemctl`, `curl`, `gh` у тестах не викликаються — лише seams. Справжні тільки bash і git (bare-origin на тест, як `autodeploy.test.ts`).
- Фейковий хелпер — **симульований хост** (`scripts/autodeploy/image-autodeploy-harness.ts`):
  - файли `quadlet`, `container`, `unit`, `running_sha`, `nrestarts`, `boot_id` і реєстр `digest → id sha content`;
  - `activate D` пише стан хоста, якщо digest не позначено «хворим»;
  - `current`, health і `NRestarts` читають ті самі файли;
  - перевизначення відповіді — файл `reply.<дія>.<digest>` (`код|рядок` або `kill`);
  - кожен виклик пишеться в лог подій;
  - сетап не повторює логіку контролера: очікувані значення — літерали тесту.
- `deploy/autodeploy.sh`, `deploy/deploy.sh`, `ships.sh`, `rsync-filter`, `db-snapshot.sh`, `record-deployed.sh`, `install-*.sh` — **без змін**. Перед PR перевірити: `git diff --name-only origin/main` не містить жодного з них.
- PR: `[deploy:hold]` + мітка `deploy:hold`. В описі: «кроку на хості немає; новий контролер не встановлюється; після мерджу — `bash deploy/deploy.sh`».

---

### Task 1: каркас контролера — стан, гейти, CI з `image`, інцидент-гейт, резолв/атестація/pull/noop

**Files:** нові `deploy/image/autodeploy.sh`, `scripts/autodeploy/image-autodeploy-harness.ts`, `scripts/autodeploy/image-autodeploy-gates.test.ts`.

- [ ] Тести спершу. У кожному тесті точні: лог подій, розібраний стан і тексти повідомлень.
  - (а) Чинні гейти перенесено. Перенести відповідні тести з `autodeploy.test.ts` на нову обв'язку:
    - quiet 599/600 с;
    - `LAST_FAILED_SHA`;
    - PAUSED;
    - lock-stall;
    - fence #768;
    - ancestry;
    - stale-копії з переліком п.15;
    - hold за шляхом і міткою, fail-closed;
    - `exit 4`.
  - (б) CI:
    - `ci` без `image` → WAIT;
    - `image=failure` → FAIL раз на SHA;
    - інший suite → WAIT;
    - обидва success в одному suite → далі.
  - (в) мітки `rollback:unsafe` / `migration:contract` → hold з текстом про `--ack-incompatible`.
  - (г) `INCIDENT` → нуль викликів хелпера, `git fetch` і CI; нагадування раз на добу, вихід 0.
  - (ґ) нема `SETTLED_DIGEST` → «перший образ-реліз — руками» раз на добу, нуль викликів хелпера.
  - (д) резолв 3 / помилка → assess, без `LAST_FAILED_SHA`, без `attest`.
  - (е) атестація ≠ 0 → ⛔ раз на добу, нуль `pull`, без `LAST_FAILED_SHA`.
  - (є) `pull`: 2, 75, 1 без рядка, `PULLED` з чужим D чи revision → assess, нуль `audit`.
  - (ж) noop: стан рівно з `DEPLOYED_SHA=X`, `LAST_SEEN_DEPLOYED_SHA=X`; події `[…, pull, current, prune --keep D_dep --keep D_settled]`; нуль повідомлень.
  - (з) noop при дрейфі `current` → не noop, assess.
  - (и) docs-only коміт з held шляхом → hold, нуль викликів хелпера.
  - (і) Стійкість стану:
    - `state.env` ігнорується;
    - `$(touch <файл>)` у значенні не виконується;
    - невідомий ключ відкидається.
- [ ] Реалізація:
  - перенести lock, PAUSED, stall, `notify`, `once_a_day`, `refuse`, `observe_deployment`, `report_regression_hold`, `scan_range`, `ci_verdict`, `installed_is_stale` (зі змінами п.3, 5, 8, 12, 15);
  - `read_state`/`write_state`;
  - `resolve_digest`, `attest`, `image_pull`, `noop_or_continue`.
  - Не-noop гілка поки що закінчується `exit 70` без тесту; Task 2 її замінює.
- [ ] Мутації — кожна має зробити червоним свій тест:
  - noop без `current` → (з);
  - holds після noop → (и);
  - `. "$STATE"` замість розбору → (і);
  - CI-вердикт без suite → (б);
  - INCIDENT після `git fetch` → (г).
- [ ] Гейт, коміт.

### Task 2: шлях до production — audit, S локально, pre, trial, стан вікна, activate, вікно, settled, відкат, інцидент

**Files:** `deploy/image/autodeploy.sh`; новий `scripts/autodeploy/image-autodeploy-window.test.ts`; harness.

- [ ] Тести спершу:
  - (а) Щасливий шлях — точні події:
    - `checks X` → `resolve X` → `attest D X` → `image pull X D` → `image current` → `image audit D`;
    - `image pull S_sha S` → `snapshot …-pre.db` → `image trial D S …` → `image activate D`;
    - опитування → `image prune --keep D` → `prune`.
    
    Стан: `DEPLOYED_*` = `SETTLED_*` = X/D/I/C, `PREVIOUS_SHA=base`, без `WINDOW_*`.
  - (б) **Стан до production**: `kill-before` на `activate D` → стан рівно з усіма `WINDOW_*` і `PHASE=activating`, а Quadlet = S.
  - (в) Таблиця вердиктів п.9 — `it.each` на дію. Кожен рядок фіксує:
    - `LAST_FAILED_SHA` і `CANDIDATE_HELD`;
    - `discard` pre;
    - чи був `activate`;
    - код виходу;
    - перший рядок повідомлення.
  - (г) `CANDIDATE_HELD == X` → тихо; новий head скидає ключ.
  - (ґ) `pull S` дає I ≠ `SETTLED_ID` → assess, нуль `snapshot`.
  - (д) Вікно:
    - здоровий → settled рівно через 600 с;
    - 3 поспіль невдалі health → провал, 2 → settled;
    - `NRestarts` → провал;
    - чужий `releaseSha` → провал;
    - чужий I → провал;
    - нечитане останнє опитування → `watching`, наступний tick → settled.
  - (е) Старт без health за 120 с → провал.
  - (є) Відкат `auto`:
    - фейковий `activate S` бачить у стані вже `LAST_FAILED_SHA=X` і `PHASE=rolling-back`;
    - після нього `DEPLOYED_*=S…`, `DEPLOYED_SHA=WINDOW_OLD`, вихід 2;
    - **нуль** `restore`/`post`/Litestream;
    - наступний tick не повторює X.
  - (ж) `ACTIVATE FAILED` → відкат.
  - (з) `activate S`: 75, потім 0 → відкат успішний; 75 двічі → інцидент.
  - (и) S не піднявся → `INCIDENT`, 🔥, вихід 3.
  - (і) `manual` → без `activate S`, `mark-rollback`, `INCIDENT`, вихід 3.
  - (ї) Утримання:
    - settled → `prune --keep D` + `prune` знімків;
    - `auto`-провал → pre лишається.
- [ ] Реалізація: `deploy_pipeline`, `begin_window`, `activate_candidate`, `watch_window`, `settle`, `roll_back_code`, `open_incident`, утримання.
- [ ] Мутації — кожна має зробити червоним свій тест:
  - стан вікна після `activate` → (б);
  - `LAST_FAILED_SHA` після `activate S` → (є);
  - `COMPAT FAILED` → `LAST_FAILED_SHA` → (в);
  - settled без прочитаного опитування → (д);
  - `discard` pre на `auto` → (ї);
  - відкат у `manual` → (і).
- [ ] Гейт, коміт.

### Task 3: відновлення після обриву — кожен рядок §7.2 окремим тестом

**Files:** `deploy/image/autodeploy.sh` (`resume_window`); новий `scripts/autodeploy/image-autodeploy-recovery.test.ts`; harness.

Стан і симульований хост засіваються літералами. Кожен рядок — свій `it`. Наскрізний `kill`-варіант для рядків 2 і 7 доводить, що справжній обрив лишає саме той стан, який засівають інші тести.

- [ ] Тести спершу (номери — рядки §7.2):
  1. `activating`, Quadlet = S, працює S → вікно скасоване, без `LAST_FAILED_SHA`, нуль `activate`. Наступний tick проходить trial і `activate D` наново.
  2. `activating`, Quadlet = D, працює S (і окремий `it`: контейнера нема) → один `activate D`, вікно від зараз. Наскрізний варіант: `kill-after-write`.
  3. `activating`, працює D → нуль `activate`; `PHASE=watching`, `WINDOW_START=зараз`, `WINDOW_NRESTARTS` = поточне; на +599 ще `watching`.
  4. `watching`, той самий boot → вікно продовжується від записаного `WINDOW_START`. Окремий `it`: `NRestarts` вищий за записаний → провал → відкат.
  5. Reboot у вікні (інший `boot_id`, `NRestarts` скинутий) → без провалу; нова база; повне вікно.
  6. Провал після resume, `auto` → відкат, вихід 2.
  7. Обрив під час відкату — `it.each`: Quadlet = S і Quadlet = D → `activate S` + перевірка, вихід 2, `LAST_FAILED_SHA` = X. Наскрізний варіант: `kill-after-write` на S.
  8. Відкат не підняв S після resume → `INCIDENT`, далі нуль дій.
  9. `manual` після «reboot» → не відкат, інцидент.
  10. `unit=foreign` — `it.each` на три фази → нуль `activate`/`prune`, `INCIDENT`, вихід 3.
- [ ] Ще: невідома `WINDOW_PHASE` або вікно без обов'язкових ключів → інцидент, не здогадка.
- [ ] Реалізація: `resume_window` — функція рішення від (`PHASE`, `MODE`, `current`, `boot_id`, health, `NRestarts`) до дії.
- [ ] Мутації — кожна має зробити червоним свій рядок:
  - рядок 3: повторний `activate`;
  - рядок 4: `WINDOW_START=now`;
  - рядок 5: стара база `NRestarts`;
  - рядок 1: `LAST_FAILED_SHA=X`;
  - рядок 9: `manual` → відкат.
- [ ] Гейт, коміт.

### Task 4: hold-списки, паритет, спека

Дрібна, якщо Task 1 уже дав `path_is_held` нового контролера: тоді контролер робить її інлайн, і вона входить у пакет наскрізного рев'ю.

**Files:**
- `scripts/autodeploy/deploy-hold-check.ts` (+ тест);
- спека 2026-10-11 (§7.1 — ключі п.4; рядок статусу; §14 — «noop просуває `DEPLOYED_SHA`», «база `NRestarts`»);
- `deploy/README.md` (абзац про контролер стадії «б» і вердикт `AUDIT ADVISORY`).

- [ ] Тести спершу:
  - `TABLE_COMMON` — проти `isHoldPath` і обох `path_is_held`.
  - `TABLE_IMAGE` — проти `isHoldPath` і нового `path_is_held`:
    - `deploy/image/autodeploy.sh`, `deploy/image/helper/*`, шаблон → `true`;
    - `deploy/image/deploy.sh`, `Dockerfile`, `start-check.cjs` → `false`.
- [ ] `isHoldPath`: префікс `deploy/image/helper/` + точні `deploy/image/autodeploy.sh` і `deploy/image/warsaw-beer-bot.container`.
- [ ] Мутації: прибрати рядок з bash-предиката чи з TS → таблиця червона.
- [ ] Перевірити, що diff не чіпає старих файлів.
- [ ] Гейт, коміт, rebase, cross-review, PR з `[deploy:hold]`.

## Після: вхід для обв'язки «б» і стадії «в»

- Наскрізне рев'ю ядра; AI-рев'ю PR.
- **Обв'язка «б»** — `deploy/image/deploy.sh`:
  - оператор, чистий checkout;
  - `--target`, `--force`, `--ack-holds`;
  - `--ack-incompatible` → `WINDOW_MODE=manual`;
  - `--resolve-incident --settled <sha>`;
  - bootstrap першого образ-релізу (`trial --previous D`, manual);
  - README для оператора.
- **Стадія «в»:**
  - `git mv` нових файлів поверх старих;
  - `install-autodeploy.sh` ставить новий контролер;
  - видалення `ships.sh`, `rsync-filter`, rsync/npm-шляху й NOPASSWD-правил;
  - `state.env` → каталог; перенесення гейтових ключів;
  - `db-snapshot.sh unmark`;
  - `TimeoutStartSec`;
  - репетиція §8 п.5;
  - проби P3/P4;
  - ops-шляхи (§12 п.2) і старі checkout-и.

## Відкриті питання до власника

1. **Імена:** нові файли в `deploy/image/` до «в», потім `git mv` поверх старих (рекомендовано) — чи нові імена назавжди з правкою спеки й CLAUDE.md.
2. **`AUDIT ADVISORY`:** failed-SHA, як каже спека §4.2 «як зараз» (рекомендовано: виправлення приходить новим мерджем-бампом), чи hold, як писав README хелпера.
3. **Провал у `manual`** теж пише `LAST_FAILED_SHA=X`? Рекомендовано так, щоб після `--resolve-incident` tick знову не взяв X.
4. **75 від `activate S` у відкаті:** одна повторна спроба, потім інцидент (рекомендовано) — чи повтор на кожному tick-у до N.
5. **Pre `auto`-провалу:** лишити непозначеним, щоб доживав серед трьох останніх (рекомендовано), — чи `mark-rollback` назавжди.
6. **`TimeoutStartSec`:** 45 хв на стадії «в» (рекомендовано) — чи прийняти kill + resume у гіршому випадку.
7. **`isHoldPath` для `deploy/image/helper/**` уже в «б»** (рекомендовано) — чи лише в «в».
8. **`deploy.sh` → встановлена копія контролера чи копія з checkout-у** (обв'язка; впливає на CLI manual-режиму).
