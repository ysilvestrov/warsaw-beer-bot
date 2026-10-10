# Artifact deployment — обв'язка 2в, етап А: tick-контролер — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** контролер, який щохвилини (timer) або вручну (`deploy.sh`) вирішує, **чи** і **що** активувати, і веде кандидата від `main` до `activate.begin` — замість bash-ового `autodeploy.sh`. Спека §5 GATE-001 (таблиця «Гейти за шляхом»), §6 (pre snapshot і trial перед активацією), §7 (серіалізація, PAUSED, `--force`, `--ack-holds`), §10b (resume на старті кожного tick). Рушій активації й відкату (`activate.py`, ядро 2в, [#823](https://github.com/ysilvestrov/warsaw-beer-bot/pull/823)) лишається як є: tick його викликає й не дублює.

**Чому обв'язка 2в ділиться на етапи.** Повна обв'язка — це tick і гейти, справжній `Host` і helper-адаптери (sudo, systemctl, HTTP, `gh`), `/health.releaseSha` з `WBB_RELEASE_REQUIRED` (`[deploy:hold]`, новий ключ `.env`), обгортка `deploy.sh`, retention, міграція state v1→v2, інсталятор. Адаптери й інсталятор спираються на рішення tick-а (які команди, з якими кодами, у якому порядку), тож:
- **етап А** (цей план) — tick: lock, PAUSED, гейти admission, підготовка кандидата, виклик рушія, сповіщення. Усе через інжектовані інтерфейси (`Host` з ядра + новий `Helpers`), з фейками в тестах;
- **етап Б** (окремий план після рев'ю А) — справжні адаптери, `/health.releaseSha`, `deploy.sh`, retention, міграція state;
- **етап В** — інсталятор, sudoers, юніти, `wbb-trial`, legacy transition (спека §10, §12 п.3).

Production activation заборонена до кінця В.

**Tech Stack:** Python ≥3.12 stdlib. Нічого з candidate не виконується в процесі tick-а.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md`.

## Вхідні дані

- Перелік з розділу «Наскрізне рев'ю ядра 2в» плану `…/2026-10-09-wbb-artifact-deployment-core-2c.md`. Етап А бере: Ф3 (алерт і дедлайн для `blocked` з лежачим ботом), Ф6 (`unreachable` ≠ `drift`; повідомлення раз на `txn`), Ф7 (backoff після `aborted`), верхній catch без вироку, PAUSED після `resume`, перший settled baseline (контракт для operator-кроку). Решта — етап Б.
- Чинний `deploy/autodeploy.sh` — джерело поведінки, яку спека велить зберегти (§5 перше речення): quiet main 600 с, CI-статус exact SHA, holds за шляхами й мітками PR, installed-current, LAST_FAILED/rearm, ancestry і regression fence, повідомлення раз на добу для стійких станів.

## Рішення, які приймає цей план

1. **«Нічого не їде» визначає payload, а не rsync-filter** (спека §5: «classifier MUST перейти … на runtime-artifact contract»). Після публікації кандидата tick порівнює його `tree-manifest.json` з маніфестом settled-релізу **без запису `release.json`** (той несе `sourceSha` і різниться завжди). Збіг — кандидат нічого не змінює в runtime: активації нема, у tick-стані записується `noopSha`, щоб наступні tick-и не повторювали підготовку. Документація, тести, CI-зміни без впливу на payload так і не стають релізом. Ціна: кожен новий `main` з зеленим CI один раз завантажується й публікується (~30 MB); retention етапу Б прибирає такі дерева. **Напрям помилки безпечний:** рівність маніфестів доводить ідентичний runtime прямим порівнянням; якщо збірка десь недетермінована, рівності просто не буде й відбудеться звичайний деплой, а не пропуск. Засновок «по-SHA відрізняється лише `release.json`» перевірено за кодом (`package_runtime.py`: `sourceSha`, `runId`, `runAttempt` пишуться лише туди; tar із `mtime=0`, gzip `mtime=0`); живе порівняння двох artifact-ів із контейнера неможливе — проксі не пускає на blob-сховище, тож перший реальний noop на хості (етап Б) — це й перша жива проба.
2. **Окремий tick-стан** (`tick-state.json` поруч зі state v2): `mainSeen{sha,at}`, `noopSha`, `abort{sha,count,at}`, `notified{txn}`, маркери «раз на добу». State v2 рушія лишається тільки про активацію/відкат — його схема не міняється.
3. **Вердикт кандидату** — лише за кодом `1` разом із рядком вердикту `wbb_release.py` (audit `ADVISORY`, probe/trial `FAILED`) або за `rolled-back` рушія. `2`, `70`, `75`, збій sudo/мережі — ніколи не `lastFailedSha` (спека §5; ядро-2б Task 0).
4. **Holds за шляхами** — **кожна встановлена копія, один список**: `gates.INSTALLED_COPIES` — `deploy/release/**` (installed helpers), `deploy/*.service|*.timer|*.path`, `deploy/sudoers.d/**`, `deploy/litestream.*`, `scripts/ops/host_patch_collect.py`, `scripts/ops/reboot_request.py` і копії merge-deploy, доки вони встановлені (`deploy/autodeploy.sh`, `ships.sh`, `read-env.sh`, `installed-current.sh`, `db-snapshot.sh`, `trial-migrate.cjs`). Той самий кортеж tick передає перевірці installed-current (`Helpers.installed_stale(patterns)`), тож файл перевіряється на актуальність рівно тоді, коли його зміна тримає діапазон; новий встановлений файл додається в одне місце. Окремо (`gates.HUMAN_STEPS`) тримають те, що не копіюється, але потребує людини: `deploy/install-*.sh` і `.github/workflows/ci.yml` (зміна довіри до artifact). Тест звіряє список із тим, що копіюють `deploy/install-*.sh`. Мітка `deploy:hold` на будь-якому PR діапазону — так само. Manual знімає їх лише явним `--ack-holds` з переліком показаних причин (§5). *(Уточнено контролером під час Task 3: початковий перелік пропускав копії merge-deploy.)*

## Таблиця «заявка → доказ» цього плану

| Заявка (що tick записує) | Що стверджує | Доказ | Сила |
|---|---|---|---|
| `noopSha` | Payload цього SHA ідентичний settled | Посимвольна рівність записів двох `tree-manifest.json` без `release.json`; обидва дерева пройшли `verify_release` у цьому tick | сильний |
| `mainSeen.at` | `main` не рухався з цього моменту | Власний годинник tick-а при першому баченні SHA; той самий підхід, що в merge-deploy | сильний для quiet, не для «CI завершено» |
| CI pass | Довірений run exact SHA мав `package=success` і `ci=success` | `github_trust.fetch_trusted` (та сама перевірка, що в publish) | сильний |
| `abort.count` | Скільки разів підряд цей SHA впав до старту | Outcome `aborted` рушія, записаний цим tick | сильний |
| `notified.txn` | Підсумок транзакції вже надіслано | Записується **після** успішного notify; падіння між ними дає повтор, не втрату | сильний (дубль можливий, втрата — ні) |
| `lastFailedSha` | Кандидат поганий | Лише вердикт-рядок + код 1 або `rolled-back` | сильний |

## Global Constraints

- **Порядок tick-а** (кожен крок під shared lock `~/.local/state/wbb-autodeploy/lock`, той самий файл, що в merge-deploy):
  1. `activate.resume` (§7 «Явна зміна PAUSED»: незавершена фаза обробляється навіть під PAUSED). Outcome → повідомлення за правилами нижче. Будь-що, крім `idle`, завершує tick.
  2. PAUSED → тихий вихід.
  3. `drift`/`unreachable`, `unverified`, `recovery-failed` → нагадування раз на добу, вихід. `unreachable` — коли `resume` дав `drift`, а повторна проба `/health` (3 спроби по 10 с) не відповіла: це не інцидент про реліз, а недоступність.
  4. Немає settled baseline → «потрібне перше встановлення оператором», раз на добу, вихід.
  5. Fetch `main` (збій → нагадування, вихід). `main == settled.sha` або `main == noopSha` → вихід.
  6. Ancestry: settled — предок `main`, інакше нагадування (manual `--force` обходить, timer — ні). Regression fence — порт `observe_deployment`.
  7. `main == lastFailedSha` → вихід. `abort.sha == main` і backoff не минув (1 год × 2^(count−1), максимум 24 год) → вихід.
  8. Quiet 600 с від `mainSeen` (лише timer).
  9. Installed-current (порт `installed_is_stale`; список файлів — інжектований) → нагадування, вихід.
  10. Holds (шляхи діапазону `settled..main`, мітки PR) → нагадування з переліком, вихід; manual з `--ack-holds`, що дорівнює показаному переліку, проходить.
  11. CI: `fetch_trusted` для `main`; немає довіреного run → wait (нагадування після 60 хв); `Untrusted` з причиною провалу → повідомлення раз на SHA, вихід.
  12. Підготовка (Task 2) → `noop` / вердикт / transient / готовий кандидат.
  13. Повторна перевірка безпосередньо перед `begin`: `main` не рухався (timer), PAUSED нема, holds ті самі.
  14. `activate.begin` → `activate.run` → повідомлення.
- **Повідомлення** — через інжектований `notify(text) -> bool`. Підсумок транзакції (`settled`, `rolled-back`, `aborted`, `unverified`, `recovery-failed`) — раз на `txn` за `lastTxn`/evidence state v2 і `notified.txn` tick-стану, тож падіння між завершенням рушія й notify дає повідомлення наступним tick-ом. Стійкі стани — раз на добу на ключ. Довжина обрізається за символами (як `NOTIFY_LIMIT` merge-deploy).
- **Ф3:** `blocked` у фазі, де бот зупинено (`activating/switch|start`, `rolling-back/*`), — критичне повідомлення одразу (раз на `txn`+intent) і повторне критичне після 15 хв того самого `blocked`.
- **Верхній catch:** будь-який неперехоплений виняток — критичне повідомлення з типом і текстом, exit 70; ніколи не вердикт.
- **Коди виходу tick-а:** 0 нічого/чекаю/settled/noop, 1 відмова кандидату або hold, 2 відкочено, 3 recovery-failed, 4 state не записано, 70 внутрішня помилка. Узгоджено з `SuccessExitStatus` юніта merge-deploy.
- **Інтерфейси:** `Host` (ядро 2в) і новий `Helpers`: `fetch_main() -> sha`, `is_ancestor(a, b)`, `changed_paths(a, b)`, `pr_labels(sha) -> [(pr, labels)]`, `commits(a, b)`, `trusted(sha)` (обгортка `fetch_trusted`), `download(sha, trusted) -> zip path`, `publish(sha, zip)`, `verify(sha) -> tree`, `audit(sha) -> (kind, tree, text)`, `probe(sha) -> (kind, text)`, `snapshot_pre() -> Pre`, `discard_pre(pre)`, `trial(sha, pre_name) -> (kind, text)`, `manifest(sha) -> bytes`, `installed_stale() -> report|None`. Справжні реалізації — етап Б; тут фейки.
- Тести: `npm test -- <args>`; повний гейт кожної задачі — `npm test && npm run typecheck` (під непривілейованим користувачем у цьому контейнері). Нові `deploy/release/*.py` — у список `scripts/deploy-rsync.test.ts`. Правила тестів CLAUDE.md діють.

---

### Task 1: `tick_state.py` і `gates.py` — tick-стан і рішення admission

**Files:** create `deploy/release/tick_state.py`, `deploy/release/gates.py`, тести до обох.

- [x] `tick_state`: durable JSON (через `publish.write_atomic`), `load` → `None` для відсутнього, `StateError` для зіпсованого; поля з «Рішень» п.2.
- [x] `gates.admission(inputs) -> Decision(kind, reason, notice_key)`: чиста функція кроків 5–11 і 13 з Global Constraints. `kind ∈ {idle, wait, hold, refuse, admit}`; `inputs` — dataclass зі значеннями, які tick уже прочитав (без I/O). Окремо `mode ∈ {timer, manual, force}` і `ack_holds`.
- [x] Тести — по рядку таблиці «Гейти за шляхом» спеки §5 для кожного стовпця (timer / manual / force), плюс: backoff межі (рівно 1 год, 2 год після другого abort, стеля 24 год); `ack_holds`, що не збігається з показаним переліком, — hold; `noopSha == main` — idle; regression fence не стирається manual.

### Task 2: `prepare.py` — від довіреного run до готового кандидата

**Files:** create `deploy/release/prepare.py`, `deploy/release/test_prepare.py`.

- [x] `prepare(helpers, sha, settled) -> Prepared | Noop | Verdict | Transient`: download → publish → verify (tree) → noop-порівняння маніфестів → audit → probe → snapshot pre → trial (ім'я знімка) → `Prepared(candidate=Release(sha, tree), pre)`. Аудит до першого виконання коду кандидата (§5; рев'ю 2б N7) — тест перевіряє порядок викликів.
- [x] Мапа результатів helper-ів за «Рішеннями» п.3: `ADVISORY`/`FAILED` + код 1 → `Verdict`; `UNRUNNABLE`/`TRANSIENT`/2/70/75/виняток helper-а → `Transient` з причиною. Провал trial прибирає pre (`discard_pre`), транзієнт — теж.
- [x] Тести: кожен крок у кожному з результатів; noop не запускає audit/probe/trial; tree з `verify` ≠ tree з `audit` → `Transient` («дерево змінилося між кроками»).

### Task 3: `tick.py` — оркестрація, lock, PAUSED, повідомлення

**Files:** create `deploy/release/tick.py`, `deploy/release/test_tick.py`.

- [ ] `tick(env, mode, ack_holds) -> exit code` за порядком Global Constraints; lock — `fcntl.flock` неблокуючий для timer (зайнято → порт `lock-busy-since`/stall-повідомлення merge-deploy), з очікуванням 30 с для manual.
- [ ] Повідомлення: підсумок раз на `txn`; Ф3; стійкі стани раз на добу; верхній catch.
- [ ] CLI: `tick.py timer`, `tick.py deploy [--force] [--ack-holds <ключ>…]`; root — відмова.
- [ ] Тести (фейкові `Host` з ядра + `Helpers` + `notify`): щасливий шлях до settled з одним повідомленням; PAUSED з незавершеним відкатом — відкат іде, admission ні; PAUSED у спокої — тиша; падіння між `run` і notify → повідомлення наступним tick-ом, рівно одне; `blocked` із лежачим ботом — критичне одразу й через 15 хв, не частіше; `aborted` тричі — backoff; `drift` проти `unreachable`; виняток у helper-і → 70 і без `lastFailedSha`; зайнятий lock.

### Task 4: документи

**Files:** modify `spec.md` §5.9, `deploy/README.md`, `scripts/deploy-rsync.test.ts`; спека — рядки §10a для `noopSha` (доказ — рівність маніфестів).

- [ ] Абзац про tick у `spec.md` §5.9: порядок, «нічого не їде» за payload, holds і `--ack-holds`, backoff, повідомлення раз на транзакцію.

---

## Після етапу А

Наскрізне рев'ю tick-а. Далі план етапу Б: справжні `Host` і `Helpers` (sudo-виклики `wbb_release.py`, `dbsnap.py` від користувача бота, `systemctl`, `/health` з таймаутами ≪ `GAP_S`, `gh` для міток і завантаження artifact), `/health.releaseSha` + `WBB_RELEASE_REQUIRED` (`[deploy:hold]`), обгортка `deploy.sh`, retention (pre, усі post, дерева з посилань state/evidence), міграція state v1→v2 і контракт першого settled baseline, `TimeoutStartSec` deploy service, перелік подвійних падінь.
