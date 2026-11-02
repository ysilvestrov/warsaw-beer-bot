# Перехід на `detent cross-review`: план реалізації

> **Для виконавців:** виконується інлайн за `superpowers:executing-plans`. Кроки позначені чекбоксами.

**Мета:** замінити власний `scripts/cross-review/` на dev-залежність `@ysilvestrov/detent`.

**Архітектура:** `npm run cross-review` лишається псевдонімом бінарника; блок і скіли оновлює `detent install`; проєктне
в промптах переїжджає в `reviewContext`.

**Спека:** `docs/superpowers/specs/2026-11/2026-11-02-detent-cross-review-migration-design.md`

## Глобальні обмеження

- Версія точно `0.3.0`, не `^0.3.0`.
- Блок detent і `detent-*` скіли руками не правляться, лише через `detent install`.
- Видалення поіменно через `git rm <файл>`, без рекурсії.
- Гейт і рев'ю — у WSL-копії; файли між копіями лише через git.
- PR без `[deploy:hold]`; мерджить власник.

## На що дивитися при рев'ю

1. `detent install` без Superpowers у `HOME` втрачає рядок про `detent-dev-cycle`: перевірити diff блоку.
2. CRLF/LF на Windows: diff блоку й скілів не повинен містити змін лише через кінці рядків.
3. Лишилося посилання на видалені `scripts/cross-review/…` або `docs/spec-format.md` поза історією й фікстурами.
4. `npm run cross-review` без `--author` дає exit 2, а не тихий успіх.
5. Живе рев'ю завершилося не exit 0: PR зупиняється.

---

### Задача 1: Підключити пакет

**Файли:** `package.json`, `package-lock.json`, `detent.json`, `.github/dependabot.yml`, блок і скіли, `.detent/manifest.json`.

- [ ] `npm i -D -E @ysilvestrov/detent@0.3.0 --package-lock-only`; у `package.json` `scripts.cross-review` = `detent cross-review`.
- [ ] `npx -y @ysilvestrov/detent install --claude --agents` із реальним `HOME`; у виводі немає `Superpowers not found`.
- [ ] `reviewContext`: дописати текст зі спеки, розділ «`reviewContext`».
- [ ] `.github/dependabot.yml`: у `ignore` кореневого npm `- dependency-name: "@ysilvestrov/detent"` з коментарем: бамп іде разом із `detent install`, якого Dependabot не запускає.
- [ ] Перевірити: `git diff --stat` не містить файлів поза списком; `package-lock.json` лише додає рядки.
- [ ] Коміт.

### Задача 2: Прибрати власну реалізацію

**Файли:** `scripts/cross-review/{cli.ts,core.ts,core.test.ts,prompt.md,prompt-spec.md}`, `docs/spec-format.md`, `tsconfig.scripts.json`, `.codex/rules/default.rules`.

- [ ] `git rm` кожного з шести файлів поіменно.
- [ ] `tsconfig.scripts.json`: прибрати коментар `// cross-review: …` і рядок `"scripts/cross-review/**/*",`.
- [ ] `.codex/rules/default.rules`: префікс не чіпати; коментар і `justification` перевірити на посилання на видалене.
- [ ] Перевірити: `git grep -n -E 'scripts/cross-review|docs/spec-format' -- . ':!docs/superpowers'` дає лише фікстури в `scripts/ai-pr-review.test.ts` і `scripts/ai-review/incremental.test.ts`.
- [ ] Коміт.

### Задача 3: Правила й доказ

**Файли:** `CLAUDE.md`, `AGENTS.md` поза блоком; спека («Фактично» після мерджу).

- [ ] Переписати пункти, названі в спеці, розділ «Правила», дзеркально в обох файлах.
- [ ] Коміт, пуш; у WSL `npm ci`, `npm test`, окремо `npm run typecheck`. Очікування: ті самі 5 падінь базлайну, `typecheck` exit 0.
- [ ] Рібейс на `origin/main`, якщо зрушив, і повтор гейту.
- [ ] У фоні `npm run cross-review -- --author claude`. Приймання: exit 0. Exit 5 зупиняє PR.
- [ ] Перевірити: `npm run cross-review` без `--author` → exit 2.
- [ ] Розібрати знахідки, відкрити PR із маркером і таблицею рішень.
