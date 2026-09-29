# Моніторинг ресурсів і тимчасові каталоги тестів

Стан на 2026-09-29 14:26 UTC. Історичних видалень у цій задачі: **0**.
Моніторинг і окрема команда запуску встановлені на сервері. Зміни звичайного
`npm test` у root/extension оформлені в [PR #745](https://github.com/ysilvestrov/warsaw-beer-bot/pull/745);
код бота не деплоївся.

## Реалізовано й активовано

- Монітор кожні 5 хвилин у crontab оператора, одна managed-секція.
  Наявні записи збережено; приватні before/previous backups лежать у
  `$HOME/.local/state/wbb-resource-monitor/`. Production units не змінені.
- Встановлені копії: `$HOME/.local/lib/wbb-ops/e2ac7389a59a5f8f/`.
  Ідентифікатор — перші 16 hex SHA256 двох Python-скриптів у визначеному порядку.
  Git checkout не змінює виконувані копії.
- Warning inode: зайнято >=80% безперервно 15 хвилин; critical: >=90%
  або <100000 вільних inode. Disk warning: <=10 GiB протягом 15 хвилин;
  critical: <=5 GiB. На початку диск 74,79 GiB, використано 41,76 GiB, доступно 29,94 GiB.
  Поріг 10 GiB більший за попередній temp-інцидент 6,49 GiB; 5 GiB — резерв
  до заповнення, без припущення про швидкість накопичення.
- До 864 samples (три доби при штатній частоті), JSON <=1 MiB; місцевий log
  64 KiB плюс одна ротація. Переходи/відновлення й зміни списку аварійних roots
  сповіщаються через наявні TELEGRAM_BOT_TOKEN/ADMIN_TELEGRAM_ID, як autodeploy.
  Ні значення ключів, ні дані каналів у state/log не записуються.
- Read-only getChat підтвердив доступність операційного каналу. Штучних
  повідомлень у Telegram не надсилали. На здорових реальних samples повідомлень немає.
- Реальні samples: 13:59:50 і 14:25:51 вручну; **14:00–14:25 кожні 5 хвилин через cron**.
  Обидва ресурси normal. Для прогнозу даних ще недостатньо. Мінімум: 13
  послідовних samples за >=1 годину, gap <=450s, додатне споживання без cleanup.
  Часове вікно враховує startup jitter cron. Локальний `--notify none` не
  підтверджує доставку й не приглушує наступний Telegram alert.
- `$HOME/.local/bin/wbb-test` установлена для запуску зі старого checkout.
  Перевірка `wbb-test scripts/autodeploy/qualify-cli.test.ts --cache=false`
  на старому checkout: 19 passed; керований base після запуску порожній.
  `--cache=false` також запобігає запису results-cache у чужий checkout.

## Підготовлено в PR

Звичайні `npm test` обох пакетів запускають supervisor перед Node/Vitest.
TMPDIR/TMP/TEMP і NODE_COMPILE_CACHE передаються процесу та descendants;
Vite/results/fsModuleCachePath теж спрямовані у його payload. Root і payload
мають 0700. Існуючий cleanup #744 залишається для ресурсів окремих suites.
Npm-процес, який запускає wrapper, може мати власний спільний compile cache
поза payload; він не є випадковим кешем трансформацій Vitest і не очищався.

На Linux supervisor стає child subreaper: kernel усиновлює осиротілих
descendants, навіть після detached/setsid. Видалення власного root дозволяє
лише waitpid ECHILD після отримання exit status початкової команди.
Exit code команди зберігається; SIGINT/SIGTERM дають 130/143 після завершення
процесів. Root publication/removal узгоджені directory-flock з inventory;
busy snapshot не дає помилкового recovery. Нормальне видалення fd-based,
без переходу symlink і без іншої FS. Підміна root або помилка залишають його.

Обрано subreaper без нових пакетів чи root-інфраструктури. Cgroup був би
сильніший після SIGKILL самого supervisor, але user-systemd тут відсутній,
а passwordless delegation cgroup недоступна. На інших OS немає прихованого
небезпечного fallback; тести потребують Linux/Python 3.12+.
Механізм adoption описаний у [Linux man-pages](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).

Після SIGKILL supervisor каталоги цього boot **завжди залишаються**, навіть
якщо поточний proc audit не знаходить references. Boot_id/PID/starttime,
UUID/root inode identity і live lease дозволяють відрізнити справжній активний
supervisor від повторно використаного PID. Видимі descendants позначаються
observed_processes; їх відсутність не доказ завершення. Після reboot старі
процеси закінчилися, але root усе одно retained до окремого погодженого audit.
Inventory ніколи не видаляє знайдене. Загального age-sweeper для /tmp немає.

## Основна гілка й активні checkout

`origin/main` 7d87cba містить #744 (rebased c87dcbe, 7229b29, 7d87cba) і
runner cleanup. Новий worktree розпочато від цього head; звичайні тести його
використовують, десять регресій #744 залишаються green.

| Відкритий checkout | HEAD на початку | #744 локально | Ризик |
|---|---|---|---|
| warsaw-bb-codex, local main | 62bb97f | Немає | Старий npm test лишає fixtures/cache |
| warsaw-beer-bot | 1425182 | Немає | Відкриті Claude/editor/shell sessions |
| warsaw-agy-bb | becdad1 | Немає | Відкрита agent/shell session |

Tracked files були clean, але відкриті чужі sessions не перемикалися й не
оновлювалися. Активних тестів у початковому та фінальному cache-аудиті не
було. Усі ці checkout можуть знову накопичувати, якщо запускати їхній старий
`npm test` замість установленої `wbb-test`.

## Вимірювання root FS

Root — `/dev/sda1`, ext4, rw. Mount ro у sandbox не є станом сервера.
Усього 4862256 inode, 80307429376 bytes диска.

| Метрика | 13:22:15, до роботи | 14:25:56, після активації/перевірок |
|---|---:|---:|
| Використано inode | 3142710 | 3142865 |
| Вільно inode | 1719546 | 1719391 |
| Зайнятість inode | 64,63% | 64,64% |
| Використано bytes диска | 44840271872 | 44847874048 |
| Доступно bytes диска | 32144543744 | 32136941568 |

Різниця — одночасна активність FS та нові worktree/evidence/monitor artifacts,
не історичне очищення. Повного розміру /tmp не встановлено; неврахований
простір root не приписується /tmp.

## Історичні залишки: один обмежений огляд

Один nice19/ionice-idle послідовний scanner: 207,22s, до 900 MiB memory cap
(спостережений RSS ~505 MiB). Ліміти cache/wbb/інші: 150/180/60s. Не проходив
symlink або чужу FS, не виводив cached code, env, БД чи персональні дані.
Блоки рахувалися як st_blocks*512; логічний розмір окремо як st_size.

| Група/походження | Обсяг огляду | Унікальні inode | Виділено / логічно | Неактивність і можливість очищення |
|---|---|---:|---|---|
| Vitest transform cache: random nonce, ssr/client/node, hash-файли | 2392 roots, повністю; 4902 dirs + 227501 files | 232403 | 5907787776 / 5450692278 B | 2145 roots мають footer/id-hash доказ Vitest 5 і відоме repository source; cache створюється з новим nonce, не reuse старих roots. Пропозиція нижче, ще не дозволено видаляти |
| Старі wbb fixtures, насамперед autodeploy Git clones із hardlink objects | 47518 top roots; 11367 повністю, 9397 з hardlinked files; частковий ліміт | >=718499 спостережених | >=2978234368 / >=1667866757 B | Source allocation відомий; старі checkout активні. Немає повного all-links/activity доказу для цього набору; не ввійшли в пропозицію |
| setenv/cws-auth-bootstrap/wrap/zip/ai-review-symlink patterns | 18452 roots, повністю; 21600 dirs +15469 files +1208 symlinks | 38277 | 151834624 / 89499666 B | Ймовірні старі тестові утиліти; env/backup/невизначені структури захищені. Не включено |
| Інші/сторонні й unknown random dirs | 546 top roots, без глибокого обходу | Не визначено | Не визначено | Походження не доведене; залишено, профілі/робочі дерева не обстежувалися глибоко |

Для hardlink entries не дорівнюють inode: у частковому wbb-огляді 732553
directory/file entries, але 718499 унікальних inode. Розмір дубльованих paths
3035799552 B більший за унікально виділені 2978234368 B. Без обліку всіх nlink
немає обґрунтованої оцінки повного звільнення; один inode звільниться лише
після останнього link і закриття відкритих handles.

## Новий маніфест: лише пропозиція

Ignored evidence `tmp/resource-evidence/inode-followup-candidates.json.gz`:
**2145 cache roots, 4408 dirs +212013 files =216421 унікальних inode**.
Усі files nlink=1; upper bound виділених blocks **5490323456 B (5,11 GiB)**,
логічно 5064267805 B. Hardlink-дерев, Git-fixtures, env/DB/backup/profile/
working checkout у цьому manifest немає. Ідентичність path/dev/inode/uid/type/
mode/mtime/ctime й subtree digest записані для кожного root.

SHA256 gzip: `232e1f524d4c035a916218ed21c82925b350390a99929a23b0a675c56d5e2729`.
Окремі current UID1000 та bot UID999 audits: 23/3 процеси, жодних candidate
references у cwd/fd/maps/temp-env, жодних active tests чи audit errors.
Це snapshot, не достатній сам по собі дозвіл. Root-UID file descriptors не
були доступні; перед очищенням потрібні новий audit і identity/digest перевірка.

Потрібне погодження саме цього маніфесту, без розширення. Для видалення:
5–10 хвилин без тестів у всіх старих sessions; production залишається працювати.
Перевірити root-UID можливих користувачів кешів, усі процеси й незмінність
кожного кандидата, пропускати невизначені; controlled batches із df-i/health.
247 інших cache-shaped roots не пройшли source/header доказ і не включені.
Неповний hardlink-набір потребує окремого адресного огляду links/components.

## Перевірки й здоров’я production

- 39 Python regressions: thresholds/boundaries/15min, gap/clock/FS reset,
  bounded history/forecast, delivery failure/retry, transition/recovery, busy
  inventory, installer preservation/idempotence, success/failure, signals,
  parallel runs, detached child, SIGKILL survivor, PID reuse, reboot,
  symlink/changed-root refusal, реальний Vitest cache через звичайний npm test.
  Додатково: locked lease з неправильним/правильним starttime живого PID,
  сигнали adopted detached child, interruption перед spawn, spawn failure 127,
  Telegram ok:false/HTTP error без витоку token, точна cron command і відмова
  при сторонньому monitor або concurrent crontab edit.
- У cache probe один конкретний transformed module справді лежав у payload
  перед success/failure; після обох roots/fixtures/cache відсутні.
- Root full gate після GitHub review: 4203 passed, 1 skipped, typecheck green.
  Extension: 836 passed, typecheck green. diff-check green.
- Claude cross-review @b11e364: 7 findings, 7 fixed, 0 rejected. Дві помилки
  відтворено RED (false acknowledgement і jitter forecast), виправлено GREEN;
  решта зауважень посилили докази тестів. Після змін full gate повторно green.
- Перше GitHub AI-review: два findings. Timeout Python bridge виправлено
  через SIGKILL і цільовий RED/GREEN із процесом, що ігнорує SIGTERM.
  Вимогу Linux/Python 3.12+ додано до README: guard усередині Vitest не
  відновив би інші ОС, бо managed launcher виконується раніше. CI та обидві
  збірки першого head green; оновлений head має пройти ті самі GitHub checks.
- Production health `{ok:true}`. Bot PID3521195/NRestarts0, cloudflared
  PID121172/0, litestream PID2019010/0, 48-hours-trip PID3348312/0 незмінні;
  code-server PID316945/NRestarts1 — попередній стан, без нового restart.

Рішення користувача: merge PR та оновлення старих sessions після завершення
їхньої роботи (або використання wbb-test); окремий дозвіл на cache manifest;
наступний обмежений hardlink-аудит. Автоматичне видалення аварійних roots
цього boot не вмикалось і не пропонується без сильнішого доказу неактивності.
