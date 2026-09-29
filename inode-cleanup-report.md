# Inode cleanup: warsaw-beer-bot, 2026-09-29

Очищено **63,668** підтверджених тестових roots; видалено
**1,680,248 inode** (794,532 dirs, 885,716 files).
Пропущено 0 кандидатів. Production продовжує працювати; код не деплоївся.

## Файлова система до/після

Хост `ysi-ubuntu-8gb-nbg1-1`; root `/dev/sda1`, ext4, 4 862 256 inode,
80 307 429 376 B диска. Порівняння нижче — безпосередньо до і після видалення,
до повного test gate.

| Показник | До | Після |
|---|---:|---:|
| Зайняті inode | 4,820,256 | 3,140,008 |
| Вільні inode | 42,000 | 1,722,248 |
| Inode зайнято | 99.14% | 64.58% |
| Зайнятий диск, B | 51,732,406,272 | 44,760,399,872 |
| Доступний диск, B | 25,252,409,344 | 32,224,415,744 |

Фактичний net приріст: **1,680,248** вільних inode та
**6,972,006,400 B** доступного диска
(6.49 GiB).
Дерева маніфесту мали 7,004,372,992 B виділених блоків і
3,798,645,804 B logical size. Net bytes відрізняються від ledger (inode збігаються точно):
на сервері одночасно працює development середовище, а ledger сам займає файл.
Початковий знімок діагностики: 4 818 934 used / 43 322 free inode,
25 328 750 592 B доступно; створення worktree та проміжна активність вплинули
на counters перед початком видалення.

`/boot/efi` — окрема vfat; /run та /dev — tmpfs. Додаткові sandbox bind/tmpfs
mounts у /tmp не зараховувалися до root ext4. Обходи — nice 19, ionice idle,
послідовні з лімітами. Кореневий обхід 90 s та кандидатний обхід /tmp 600 s
були частковими. Проміжний du був зупинений, щоб залишити один повний обхід.
**Повний розмір /tmp не встановлено**, неврахований простір не приписано /tmp.

Доступні дерева поза /tmp обійдено за 17,22 s; 35 permission errors означають
невиміряні піддерева. Наведені числа — для доступної частини, не нулі за
закриті дані. Files/dirs — типи записів; unique inode — (dev, ino);
allocated bytes — st_blocks × 512; logical — st_size, включно з dirs.

| Дерево | Files | Dirs | Унікальні inode | Блоки, B | Logical, B |
|---|---:|---:|---:|---:|---:|
| /home | 122 036 | 27 282 | 148 406 | 9 737 240 576 | 9 411 299 395 |
| /usr | 55 446 | 7 966 | 69 293 | 3 013 599 232 | 2 877 591 394 |
| /opt | 9 875 | 1 114 | 10 996 | 122 662 912 | 95 809 581 |
| /var | 4 042 | 325 | 4 374 | 4 588 175 360 | 5 347 135 695 |
| /swapfile | 1 | 0 | 1 | 4 294 971 392 | 4 294 967 296 |

Symlink/other entries входять в inode, але не files/dirs. /tmp підтверджено
як головне джерело тестового накопичення; це не твердження, що весь зайнятий
диск є тимчасовими файлами.

## Причина та фактично видалені групи

Тести створювали mkdtempSync ресурси без cleanup hook: shared fixtures у
collection/beforeAll і per-test setup накопичувалися навіть після успішних
запусків. Replay до виправлення: 19 успішних qualify-cli тестів залишили
п'ять wbb-qualify roots. SIGKILL не потрібен для відтворення цього витоку.

Початковий верхній рівень: ad-bin/ad-home по 24 454, drift-remote/drift-seed
по 16 909 каталогів. Усі підтверджені wbb roots належать uid 1000 (ysi), mode
0700; вікові межі груп приблизно від 1,2 години до 44 днів на початковий знімок.
Вік не використовувався як самостійний дозвіл на видалення.

| Видалена група | Roots | Dirs | Files |
|---|---:|---:|---:|
| wbb-ad-bin | 22,546 | 22,546 | 85,086 |
| wbb-ad-home | 2,130 | 69,036 | 10,077 |
| wbb-ad-seed | 978 | 25,486 | 24,008 |
| wbb-cur-bin | 831 | 831 | 1,968 |
| wbb-cur-repo | 838 | 16,747 | 19,920 |
| wbb-drift-nofilter-seed | 666 | 17,270 | 21,786 |
| wbb-drift-seed | 15,579 | 516,424 | 580,299 |
| wbb-env | 660 | 660 | 660 |
| wbb-guard | 892 | 49,036 | 50,099 |
| wbb-guard-addedfilter | 674 | 15,457 | 21,698 |
| wbb-guard-narrow | 671 | 19,403 | 25,523 |
| wbb-guard-nofilter | 705 | 14,072 | 19,932 |
| wbb-guard-silent | 661 | 661 | 646 |
| wbb-guard-stub | 687 | 687 | 661 |
| wbb-guard-wrongpaths | 672 | 672 | 663 |
| wbb-qualify | 4,359 | 4,359 | 3,254 |
| wbb-ships-dst | 679 | 4,074 | 5,184 |
| wbb-ships-filter | 5,862 | 5,862 | 5,862 |
| wbb-ships-src | 32 | 672 | 32 |
| wbb-state | 3,341 | 6,682 | 2,618 |
| wbb-verify-gitbody | 205 | 3,895 | 5,740 |

Джерела: ad-/drift- → scripts/autodeploy/autodeploy.test.ts;
guard- → guard.test.ts; cur- → installed-current.test.ts;
ships- → ships.test.ts; qualify → qualify-cli.test.ts;
env → read-env.test.ts; state → record-deployed.test.ts;
verify-gitbody → scripts/ai-review/verify-corpus-run.test.ts.

## Що залишено

Без змін: 35 559 roots, виключених через hardlinked file; 659 із захищеним
suffix; 1 985 без очікуваної bare-git структури; 282 з невідповідним filter
shape; 194 з невідповідним env shape; 12 невідомих груп та roots, не охоплені
600-секундним лімітом. Це причини первинного виключення, не нові вимірювання
їхнього поточного стану. Symlink, БД, backups, rollback-артефакти, sockets,
робочі checkout, browser profiles/rehearsal та сторонні temp не видалялися.
Hardlink trees потребують окремого inode/link manifest й дозволу; поточний
allowlist не розширювався. Змінені/сумнівні roots записуються в skip-ledger.

Vitest 5.0.1 також лишає випадковий transform-cache каталог: приватний
успішний replay залишає один framework root навіть після виправлення фікстур.
Історичні кеші Vitest не входять у дозволений список і не очищалися.
Окремі аварійні запуски/перервані hooks також можуть залишати ресурси.

## Перевірки та безпека видалення

Користувач явно дозволив exact archive: 63 668 roots, до 1 680 248 inode,
включно з тестовими home/bin/env/state та git-фікстурами. Перша спроба перед
цим дозволом була відхилена автоматичною перевіркою і нічого не видалила.
Після дозволу cleaner перевірив archive count/unique paths та верхню межу inode.

Перед кожним видаленням: absolute /tmp path, dev/ino/uid/mode/mtime/ctime та
повторний fingerprint усіх descendants. Обхід через directory fd/O_NOFOLLOW;
без переходу symlink або іншої FS. Новий hardlink/невірний type/owner/device
виключає root. Перевірений root атомарно переходив у приватний 0700 staging
й одразу видалявся symlink-resistant fd-based rmtree. Сам перенос inode
не звільняє; реальне видалення підтверджене ledger і counters.

Партії максимум 100 roots / поріг 10 000 entries; після кожної — inode,
service activity, API health і process audit. На старті першого запуску після
трьох roots виник KeyError підрахунку empty tree без files; counts виправлено,
очищення відновлено лише за ledger, без повторного видалення. Змінені або
сумнівні pre-mutation кандидати пропускаються; health/activity failure зупиняє
весь поточний запуск. Невідповідність identity після staging вимагає огляду,
а не подальшого видалення.

Процеси перевірялися поза sandbox. Довгоживучі Node — code-server.
cwd/fd/maps для uid 1000 та uid 999 перевірялися без помилок і без wbb refs;
cmdline всіх uid перевірявся на Vitest/npm test, але не публікувався.
Root-service fd без root-привілеїв недоступні. Додаткові докази неактивності:
0700, підтверджений тестовий shape/local git origin, відсутність активних
тестів, відсутність discovery/reuse старих paths у коді. Нові тести використовують
унікальні mkdtemp paths поза замороженим manifest; не можуть потрапити під
wildcard очищення. Mtime/lsof самі по собі не були доказом.

## Виправлення і verification

scripts/test-temp.ts реєструє ресурс одразу після mkdtemp, до caller setup.
Root afterAll прибирає всі зареєстровані paths після завершення файлу, включно
з assertion/setup failure; shared fixtures живуть до кінця suite. При collection
failure Vitest пропускає hooks: резервний cleanup викликає вузький TestRunner subclass
у onAfterRunFiles; process exit listeners не використовуються. Невдалі paths
зберігаються після afterAll для однієї lifecycle-спроби. Постійна помилка
містить конкретний path і провалює запуск; права доступу не змінюються. Cleanup
пробує всі paths і агрегує помилки. Одинадцять suite мігровані; наявні коректні
finally/afterEach в інших тестах не змінено. Префікси з path separator та
`.`/`..` відхиляються. У production код не деплоївся.

Цільові replay: 184 тести в усіх 11 suite успішні, власних temp roots 0;
десять child-Vitest сценаріїв: success, assertion failure, beforeAll failure,
beforeEach failure, collection failure, shared lifetime, invalid prefixes і
постійна/тимчасова cleanup failure, а також 12 collection failures у reused worker.
Кожна allocation перевіряє абсолютний parent та існування
ресурсу. Exact remaining resource set перевіряється разом з exit status і
специфічним failure marker. Mock removal failure підтверджує спробу
очищення всіх ресурсів і lifecycle retry лише невдалого root. Постійна помилка
залишає лише відомий blocked root і видимий збій; тимчасова прибирається retry.
Allocation count точний; reused worker не залишає ресурсів чи listener warnings.
Framework cache відокремлено в scratch tree. На початковій версії helper
mutation check із вимкненим hook спричинив 5 failures через owned/shared
leftovers; hook відновлено. Подальші regressions перевіряють runner fallback.
Повний gate і pre-PR review фіксуються нижче після фактичного завершення.

## Аварійні запуски, Vitest cache та alert

SIGKILL/VM crash і різке переривання тестів не гарантують hooks/finally.
Наступний крок: приватний 0700 run-root із TMPDIR/TMP/TEMP для launcher і
workers, metadata boot_id/PID/starttime/root identity та held kernel flock;
звичайне завершення видаляє лише цей run-root у finally. Так root міститиме
також framework transform cache. Аварійне очищення — exclusive lock плюс
перевірка всіх workers/cgroup і cwd/fd/maps, не PID/mtime alone: worker може
пережити launcher. За невизначеності потрібне узгоджене вікно 5–10 хв без
тестів усіх development сесій; production-сервіси продовжують працювати.
Автоматичного cron за віком або цього wrapper у межах задачі не встановлено.

Warning ≥80% inode протягом 15 хв; critical ≥90% або <100 000 free inode.
Перевірка кожні 5 хв, додатково приріст і прогноз вичерпання за 24 години.

## Evidence

Локально, поза git/PR: inode-cleanup-evidence/inode-candidates.json.gz,
початкові top manifests/group ages, partial surveys, before-execution.json,
after-execution.json, deletion-ledger.jsonl, optional skip-ledger.jsonl,
execution-summary.json, cleaner.py та reference-audit.py. Evidence містить
metadata/випадкові paths; вміст env, БД та особисті дані не публікувалися.

## Стан сервісів і повний gate після очищення

warsaw-beer-bot active/running, MainPID 3521195, NRestarts 0 — без змін від
початкового знімка. cloudflared (PID 121172), litestream (PID 2019010),
code-server@ysi (PID 316945) і 48-hours-trip (PID 3348312) active/running.
Перевірений /health повернув {ok:true}. Жоден сервіс не зупиняли/перезапускали.

`npm test && npm run typecheck`: 218 test files успішні, 1 skipped;
4201 tests успішні, 1 skipped; exit 0. Тривалість тестів 39,30 s.
Обидві TypeScript перевірки успішні. `git diff --check` успішний.
origin/main перевірено перед PR; на момент цього gate він збігався з базою
1425182. Claude cross-review коміту 22caab4 спочатку було заблоковано через
відсутність явного дозволу на передачу коду. Після дозволу користувача рев'ю
успішно виконано: 4 findings, усі виправлені. Доданий regression довів collection
leak до lifecycle fallback; посилені allocation assertions і cleanup-error перевірка;
уточнені byte counters та статус рев'ю. Evidence/env/БД не передавалися.
GitHub AI review додатково виявив втрату невдалих paths і ризик process-global
exit listeners. Обидва виправлені через runner lifecycle registry; transient
removal regression спочатку впав і пройшов після виправлення. Worker-exit
fallback замінений, бо після hook failure його виклик не підтвердився.
GitHub CI/AI review залишаються обов'язковими.
Код та звіт підготовлені в fix/test-temp-cleanup; деплою в production немає.
