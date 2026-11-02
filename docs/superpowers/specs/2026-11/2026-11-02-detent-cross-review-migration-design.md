# Перехід на `detent cross-review`: прибрати власний скрипт рев'ю

Дата: 2026-11-02
Статус: затверджено 2026-11-02
Spec-review: codex/gpt-6.1-sol @ 10accb4 (author: claude) — 1 findings: 1 fixed, 0 rejected

## Для власника

**Мета.** У репо лишається одна реалізація перехресного рев'ю, та сама, що в інших проєктах на
detent. Виправлення рецензентів приходять новою версією пакета, і їх не треба переносити в цей репо
вручну. Для людини, яка питає про пиво, і для бюджету нічого не змінюється.

**Що зміниться для тебе.**
- Мердж цього PR, найімовірніше, один раз передеплоїть бота, хоча код бота не зміниться. Кроків на
  хості немає, `[deploy:hold]` не потрібен.
- Оновлення detent роблять вручну: `npm i -D -E @ysilvestrov/detent@<версія>`, потім `detent install`,
  потім PR. Dependabot його не пропонує.
- Рев'ю тепер запускається з `--author`: `npm run cross-review -- --author claude`.
- Якщо перший рецензент впаде, detent спробує наступного з `detent.json`. Раніше був один рецензент.
- Цей PR не мерджиться з маркером `failed (…)`: живе рев'ю тут єдиний доказ, що заміна працює.
- Локальний гейт у WSL уже зараз дає 5 падінь, не пов'язаних із цією зміною. Гілка йде далі, лише якщо
  падіння ті самі 5, а `typecheck` окремо зелений. CI на PR їх не приховує: там свій повний прогін.
- Незворотного нічого: відкат — це revert PR.

**На чому стоїть рішення.**
1. Інструмент підключено як dev-залежність, а `npm run cross-review` лишається. `[вимога власника]`
2. detent ставиться з npm як `@ysilvestrov/detent`, публікацію вже зроблено. `[вимога власника]`
3. Пакет ставиться однаково на npm 11 і npm 12, без GitHub і без SSH-ключа. `[проба]` (П-1)
4. У прод detent не потрапляє, а аудит хоста його не бачить. `[проба]` (П-1)
5. У цьому репо команда з правил detent і `npm run cross-review` запускають той самий локальний бінарник. `[проба]` (П-2)
6. Промпти й формат спеки detent покривають наші; втрачається лише те, що переноситься в
   `reviewContext`. `[проба]` (П-3)
7. Жоден код не читає маркери `Cross-review:` і `Spec-review:`, тож зміна їхнього формату нічого не
   ламає. `[проба]` (П-3)
8. Реальний рецензент працює через detent у цьому репо. `[проба]` (П-4)
9. Мердж передеплоїть бота, бо lock входить у payload релізу. Окремо не перевіряв. `[виведення]`

**Ключові рішення.**
1. Dev-залежність із реєстру, версія закріплена точно. Відкинуто: залежність із git, бо на npm 12 вона
   ламає весь `npm ci` (П-5), а деплоєр на хості відмовляє такому коміту. Відкинуто: `^`, бо
   бінарник і встановлені скіли мусять рухатися разом.
2. `npm run cross-review` лишається псевдонімом `detent cross-review`. Відкинуто: лише форма
   `npx -y @ysilvestrov/detent`. Вона вимагала б нового дозволу Codex на мережу.
3. Dependabot ігнорує `@ysilvestrov/detent`. Відкинуто: автоматичні бампи. Бамп без `detent install`
   розводить бінарник і встановлені скіли, а Dependabot `install` не запускає.
4. Власний промпт не переноситься в `.detent/prompts/`. Проєктне йде в `reviewContext`. Відкинуто:
   копія промпта, яка розійдеться з detent при першому ж оновленні.
5. Живе рев'ю цього PR обов'язково має завершитися exit 0. Відкинуто: звичайне правило, за яким збій
   рецензента PR не блокує, бо стара реалізація видаляється в цьому ж PR.

Розглянуто стандартне: лишити власний скрипт і не переходити — відкинуто, бо дві реалізації вже
розходяться, а виправлення довелося б переносити вручну.

**Що стане гірше.**
- Зникає своя страховка на промпти: зміна промпта в detent змінить рев'ю тут після оновлення версії.
- Вимога читати правило Testing доходить до рецензента слабше: через `reviewContext`, а не через сам промпт.
- З'являється нова dev-залежність, опублікована з одного акаунта. Компрометація акаунта дала б код, який
  виконують агенти. Точна версія й `integrity` у lock обмежують це: нова версія приходить лише через PR.
- У `CLAUDE.md` і `AGENTS.md` лишається рядок про `npm run`, бо блок і скіл називають іншу форму команди.

**Оцінка.** Власник: M. Автор: S (один PR, план ≤ 4 задачі). Розбіжність в один розмір, зупинка не
потрібна. Розклад: залежність, `detent install`, конфігурація 30%; видалення скрипта й
`docs/spec-format.md` 10%; правила в `CLAUDE.md` і `AGENTS.md` 40%; живе рев'ю 20%. Дешевшого варіанта,
який би щось заощадив, немає: виклик через `npx` без залежності економить лише один рядок у `package.json`.

**Питання до власника.** Немає.

## Дизайн

### Що змінюється

| Файл | Зміна |
|---|---|
| `package.json`, `package-lock.json` | `devDependencies["@ysilvestrov/detent"]` = `0.3.0` (точно); `scripts.cross-review` = `detent cross-review` |
| блок detent у `CLAUDE.md` і `AGENTS.md`, `.claude/skills/detent-*`, `.agents/skills/detent-*`, `.detent/manifest.json` | оновлює `detent install --claude --agents`, руками не правити |
| `scripts/cross-review/` | видаляються всі 5 файлів: `cli.ts`, `core.ts`, `core.test.ts`, `prompt.md`, `prompt-spec.md` |
| `tsconfig.scripts.json` | прибрати коментар і рядок `scripts/cross-review/**/*` |
| `docs/spec-format.md` | видаляється; чинний формат — `spec-format.md` у скілі `detent-design-spec` |
| `detent.json` | дописати `reviewContext` (нижче) |
| `.github/dependabot.yml` | `ignore` для `@ysilvestrov/detent` у секції кореневого npm, з коментарем чому |
| `.codex/rules/default.rules` | лише посилання в коментарі, якщо воно стане хибним; префікс `npm run cross-review` не змінюється |
| `CLAUDE.md`, `AGENTS.md` поза блоком | нижче |

Не змінюються: `spec.md` (про cross-review там нічого немає), рядки `scripts/cross-review/…` у
`scripts/ai-pr-review.test.ts` і `scripts/ai-review/incremental.test.ts` (це лише фікстури зі шляхами,
файл читати їм не потрібно), старі спеки й плани, які згадують `docs/spec-format.md`: це історія, чотири
документи, git її зберігає.

Видаляти поіменно через `git rm <файл>`, без рекурсії.

`detent install` запускати з реальним `HOME`, щоб він бачив Superpowers: у пробі з порожнім `HOME` він
написав `Superpowers not found`, і рядок про `detent-dev-cycle` залежить від цього. Перевірити diff блоку
й скілів перед комітом.

### `reviewContext`

Дописати до наявного тексту, англійською, як і решта рядка:

> Besides the detent block, CLAUDE.md holds this project's rules: read them, the Testing bullet above
> all. The platform: systemd, litestream, sqlite.

Перше замінює вказівку нашого промпта читати Testing у `CLAUDE.md`. Друге замінює перелік інструментів у
перевірці на велосипед, який у промпті detent загальний. Обмеження про хост, бюджет і мейнтейнера вже є в
`detent.json`.

### Правила

`CLAUDE.md`:
- пункт «Workflow»: команда оновлення блоку й скілів стає процедурою бампу: `npm i -D -E
  @ysilvestrov/detent@<версія>`, потім `npx --no-install detent install --claude --agents`, потім PR;
  форма `npx github:…` прибирається, бо на npm 12 вона падає (П-5);
- пункт «Спека: проєктні уточнення»: рев'ю спеки — `npm run cross-review -- --author claude --spec <файл>`
  у фоні; «власним скриптом» прибрати;
- пункт «Перехресне рев'ю»: прибрати застереження про власний скрипт; лишити те, чого нема у скілі
  `detent-cross-review`, — у цьому репо це `npm run cross-review -- --author claude` у WSL-копії, виміряна
  причина й дизайн. Те, що дублює скіл (exit-коди, триаж, маркер, «раз на PR»), прибрати. Модель Sol
  тепер у `detent.json`, згадку про `DEFAULT_MODEL` замінити на це. `--reviewer` не передавати.

`AGENTS.md`: те саме дзеркально, з `--author codex`, тайм-аутом команди не менш ніж 16 хв і посиланням на
правило `.codex/rules/default.rules`.

Формулювання «у цьому репо» потрібне, бо блок і скіл кажуть `npx -y @ysilvestrov/detent cross-review`, а
дозвіл Codex на мережу виданий на `npm run cross-review`. Для Claude обидві форми рівнозначні (П-2).

### Перевірка

Гейт у WSL-копії: `npm test` і окремо `npm run typecheck`, не через `&&`, бо падіння тестів інакше
пропускає `typecheck`. Базлайн `npm test` має 5 падінь, не пов'язаних із цією зміною:
`db-snapshot.test.ts` ×3, `trial-migrate.test.ts` ×1 (у WSL немає `sqlite3`), `release.test.ts` ×1. Гілка
проходить, якщо список падінь той самий, а `typecheck` завершився з exit 0.

Приймання: рев'ю перед PR іде через `npm run cross-review -- --author claude` з гілки, де стару реалізацію
вже видалено, і завершується exit 0. Exit 5 зупиняє PR: розбираємо причину, виправляємо в detent або
повторюємо. Маркер і таблиця рішень — в описі PR.

CI: джоб `image` доводить збірку образу, `deploy-hold` — що маркер hold не потрібен.

## Проби

**П-1. Опублікований пакет на клоні цього репо** (голова 537ba11, WSL, node 24.22.2, порожній `HOME`,
`GIT_SSH_COMMAND=false`, без токенів, npm 11.19.1 і 12.2.1).

```
npm view @ysilvestrov/detent → 0.3.0, latest; bin detent → dist/cli.js; без install/prepare у метаданих
npm view detent              → E404
npm i -D -E … --package-lock-only → лише package.json (+1) і package-lock.json (+14, нічого не видалено)
"resolved": "https://registry.npmjs.org/@ysilvestrov/detent/-/detent-0.3.0.tgz", є "integrity"
npm 11 і 12: ci                → exit 0, detent --version → 0.3.0
npm 11 і 12: ci --ignore-scripts → exit 0, detent --version → 0.3.0
npm 11 і 12: ci --omit=dev     → exit 0, node_modules/@ysilvestrov немає
npm audit --omit=dev --package-lock-only --json --ignore-scripts (форма host_audit) → exit 0, 0 вразливостей, detent у звіті немає
```

**П-2. Бінарник у цьому репо.**

```
npx --no-install detent --version → 0.3.0
npx -y @ysilvestrov/detent --version → 0.3.0
detent cross-review --author claude --spec nope.md → exit 2: --spec must name a .md file under docs/superpowers/specs/<YYYY-MM>/
detent cross-review --author claude --base HEAD   → exit 2: empty diff (те саме через npm run cross-review)
detent install --claude --agents --dry-run → update: скіли в обох теках, CLAUDE.md, AGENTS.md, .detent/manifest.json; detent.json і .gitignore без змін
```

Друге й третє показують, що `detent.json` цього репо читається, а `npm run` передає аргументи.

**П-3. Порівняння й пошук.**
- `scripts/cross-review/prompt.md` і `prompts/review-diff.md` detent: ті самі чотири категорії й той самий
  рядок результату. Відмінність: наш читає Testing із `CLAUDE.md`, detent — блок конституції.
- `prompt-spec.md` і `review-spec.md`: ті самі шість перевірок. Відмінність: наш перелічує systemd,
  litestream, sqlite у перевірці на велосипед.
- `docs/spec-format.md` і `spec-format.md` скіла: ті самі поля й шкала. Проєктне «мета міряється на людину,
  яка питає про пиво» вже стоїть у `CLAUDE.md`.
- `git grep` по `Cross-review:`, `Spec-review:`, `CROSS_REVIEW_ACTIVE`, `CROSS-REVIEW-RESULT` поза
  `scripts/cross-review`, скілами, файлами правил і спеками: нічого.

**П-4. Рев'ю цієї спеки через detent 0.3.0.** Запускається через `npx -y @ysilvestrov/detent cross-review
--author claude --spec <цей файл>`, а не через власний скрипт, як поки каже `CLAUDE.md`: це відхилення
навмисне, бо перевіряє реального рецензента до плану. Результат: exit 0, рецензент `codex/gpt-6.1-sol`,
звіт у `tmp/cross-review-spec-codex-…/report.md`, одна знахідка. Режим рев'ю гілки ще не перевірявся: його
доводить приймання цього PR.

**П-5. Чому не git** (npm 12.2.1, той самий стенд).

```
npm config get allow-git → none (npm 11.19.1: all)
npm ci із залежністю github:ysilvestrov/detent#v0.2.1 → exit 1, EALLOWGIT, Fetching packages of type "git" have been disabled
npx -y github:ysilvestrov/detent#v0.2.1 --version     → exit 1, EALLOWGIT
```

Деплоєр на хості виконує `npm ci` у своєму клоні (`deploy/autodeploy.sh:75`), а збій збірки йде в `refuse`:
сповіщення, `LAST_FAILED_SHA`, вихід. Яка версія npm на хості, не перевіряв; з реєстровою залежністю це
більше не впливає на рішення, бо обидві версії ставлять її однаково.

## Заявка → доказ

| Заявка | Де записано | Що доводить | Сила |
|---|---|---|---|
| Рев'ю відбулося на цьому SHA | маркер `Cross-review:` / `Spec-review:` | CLI друкує його після запуску рецензента на цьому SHA; автор копіює вручну. Самозвіт, нічого не вмикає | Як і раніше: достатньо, бо жоден код його не читає (П-3) |
| Встановлено саме цю версію detent | `version`, `integrity` у lock | `npm ci` перевіряє хеш тарболу (П-1) | Сильна |
| Встановлені скіли відповідають бінарнику | `.detent/manifest.json` | Записує `detent install`; збіг із залежністю тримається на рішенні 3 і на процедурі бампу | Середня: автоматично це не перевіряється. Розбіжність шкодить лише тексту правил, не деплою |

## Рев'ю спеки

| № | Перевірка | Рішення | Причина / що змінено |
|---|---|---|---|
| 1 | [1] Тіло → виклад | виправлено | Виняток із гейту (5 падінь базлайну) не було у викладі, а `&&` пропускав `typecheck` після падіння тестів. Виняток додано в «Що зміниться для тебе», `typecheck` тепер запускається окремо й мусить бути зеленим |
