# Ретайр off-store каналу дистрибуції — Implementation Plan (#267 Крок 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Прибрати off-store канал дистрибуції розширення (запис релізу в БД бота + прийом zip від адміна + розсилка тестерам), зберігши локальну збірку, яка й далі віддає один zip для скачування з сервера.

**Architecture:** Чисте видалення одного вертикального зрізу. Порядок задач такий, щоб репозиторій компілювався після **кожного** коміту: спершу відв'язуємо споживачів (`/extension`, реєстрація команди), потім видаляємо публікаційні скрипти, і лише тоді — storage-модуль, у якого вже не лишилось імпортерів. Таблиця `extension_releases` у схемі **лишається** (рішення 1 дизайну), тож `schema.ts` і `schema.test.ts` не чіпаємо.

**Tech Stack:** TypeScript (CommonJS, root tsconfig), Vitest (`npx vitest run <file>`), Telegraf, better-sqlite3. Розширення — окремий workspace у `extension/` (Vite, свій vitest). Типізація: `npm run typecheck` (root) і `npm run build`.

**Design:** `docs/superpowers/specs/2026-08/2026-08-08-retire-offstore-channel-design.md`

---

## File Structure

| Файл | Дія | Відповідальність після зміни |
|---|---|---|
| `src/bot/commands/extension.ts` | modify | `/extension` — мінтить токен, віддає токен + лінк на стор |
| `src/bot/commands/extension.test.ts` | modify | тести токена й побудови повідомлення (без релізів) |
| `src/bot/commands/extension-release.ts` (+`.test.ts`) | **delete** | — |
| `src/index.ts` | modify | без реєстрації `extensionReleaseCommand` |
| `scripts/publish-extension-release.ts` (+`.test.ts`) | **delete** | — |
| `deploy/bin/apply-extension-release.sh`, `scripts/apply-extension-release.test.ts` | **delete** | — |
| `src/storage/extension_releases.ts` (+`.test.ts`) | **delete** | — |
| `src/i18n/types.ts`, `locales/{uk,en,pl}.ts` | modify | без `extrel.*` і `extension.download`; новий `extension.store` |
| `extension/package.json` | modify | без `package` і `release`; `build`+`postbuild` дають zip |
| `extension/scripts/release-notes.ts` | **delete** | — |
| `extension/src/shared/release-notes.ts` (+`.test.ts`) | **delete** | — |
| `extension/scripts/zip-dist.py` | modify | лише докстрінг (без згадок каналу) |
| `docs/extension-install-uk.md`, `-en.md`, `docs/extension-release.md` | modify | store-only + дебажна збірка |
| `spec.md` | modify | §6.1 розчинено, §3.12 retired, §6.4 — єдина секція дистрибуції |

**Не чіпати:** `src/storage/schema.ts`, `src/storage/schema.test.ts`, `extension/src/build/zip-determinism.test.ts` (крім коментаря в Task 6), `scripts/publish-store-release.ts`, `package:store`, `release:store`.

---

## Task 1: `/extension` віддає лінк на стор замість zip

**Files:**
- Modify: `src/bot/commands/extension.ts`
- Modify: `src/bot/commands/extension.test.ts`
- Modify: `src/i18n/types.ts`, `src/i18n/locales/{uk,en,pl}.ts`

- [ ] **Step 1: Додати ключ `extension.store` у типи**

У `src/i18n/types.ts` одразу після рядка `'extension.download': string;` додати:

```ts
  'extension.store': string;     // {url} — Chrome Web Store listing link
```

(`extension.download` поки лишається — його приберемо в Task 5, щоб не ламати компіляцію `extension-release.ts`, який ще існує.)

- [ ] **Step 2: Додати рядок у три локалі**

`src/i18n/locales/uk.ts`, після `'extension.download': …`:

```ts
    'extension.store':
      'Встановити розширення: {url}\n' +
      'Якщо побачиш «Item not available» — залогінься в Google-акаунт і онови сторінку ' +
      '(розширення позначене 18+ через пивну тематику).',
```

`src/i18n/locales/en.ts`:

```ts
    'extension.store':
      'Install the extension: {url}\n' +
      'If you see "Item not available", sign in to your Google account and reload ' +
      '(the extension is flagged 18+ because it is about beer).',
```

`src/i18n/locales/pl.ts`:

```ts
    'extension.store':
      'Zainstaluj rozszerzenie: {url}\n' +
      'Jeśli zobaczysz „Item not available", zaloguj się na konto Google i odśwież stronę ' +
      '(rozszerzenie jest oznaczone 18+ ze względu na tematykę piwną).',
```

- [ ] **Step 3: Переписати тест під нову поведінку**

Замінити **весь** `src/bot/commands/extension.test.ts` на:

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { findTelegramIdByHash, hashToken } from '../../storage/api_tokens';
import { generateAndStoreToken, buildExtensionMessage, STORE_URL } from './extension';

describe('generateAndStoreToken', () => {
  it('mints a 64-hex token, stores its hash, and rotates 1:1', () => {
    const db = openDb(':memory:'); migrate(db);
    ensureProfile(db, 42);
    const first = generateAndStoreToken(db, 42, '2026-06-07T00:00:00Z');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(findTelegramIdByHash(db, hashToken(first))).toBe(42);

    const second = generateAndStoreToken(db, 42, '2026-06-07T01:00:00Z');
    expect(second).not.toBe(first);
    expect(findTelegramIdByHash(db, hashToken(first))).toBeNull(); // old revoked
    expect(findTelegramIdByHash(db, hashToken(second))).toBe(42);
  });
});

describe('buildExtensionMessage', () => {
  const t = ((key: string, params?: Record<string, string>) =>
    key === 'extension.success'
      ? `Use & enjoy: ${params?.url}`
      : key === 'extension.store'
        ? `Install: ${params?.url}`
        : key) as never;

  it('wraps the token in a <code> block and escapes the instructions', () => {
    const html = buildExtensionMessage(t, 'deadbeef', 'https://beer-api.example/match');
    expect(html).toContain('<code>deadbeef</code>');
    expect(html).toContain('Use &amp; enjoy:'); // & escaped
  });

  it('includes the Chrome Web Store link instead of shipping a zip', () => {
    const html = buildExtensionMessage(t, 'deadbeef', 'https://beer-api.example/match');
    expect(html).toContain(`Install: ${STORE_URL}`);
    expect(STORE_URL).toContain('fdelmnhijeiojadcaihfdpecfcldbndg');
  });
});
```

- [ ] **Step 4: Запустити тест — має впасти**

Run: `npx vitest run src/bot/commands/extension.test.ts`
Expected: FAIL — `STORE_URL` не експортується з `./extension`.

- [ ] **Step 5: Змінити `src/bot/commands/extension.ts`**

Прибрати імпорт `latestRelease`:

```ts
import { latestRelease } from '../../storage/extension_releases';
```

Додати константу поряд з `API_URL`:

```ts
// Chrome Web Store listing (#267). The store build's ID is assigned by CWS, not by our key.
export const STORE_URL =
  'https://chromewebstore.google.com/detail/fdelmnhijeiojadcaihfdpecfcldbndg';
```

Замінити `buildExtensionMessage` на:

```ts
// HTML message: escaped instructions + raw token in a copy-friendly <code> block,
// followed by the store link. The token is hex, so it needs no escaping; instructions
// go through escapeHtml (locale strings may contain & or angle brackets).
export function buildExtensionMessage(t: Translator, token: string, url: string): string {
  const intro = escapeHtml(t('extension.success', { url }));
  const store = escapeHtml(t('extension.store', { url: STORE_URL }));
  return `${intro}\n\n<code>${token}</code>\n\n${store}`;
}
```

Видалити функцію `latestDeliverableRelease` цілком і скоротити хендлер до:

```ts
extensionCommand.command('extension', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const token = generateAndStoreToken(ctx.deps.db, ctx.from.id, new Date().toISOString());
  await ctx.replyWithHTML(buildExtensionMessage(ctx.t, token, API_URL));
});
```

- [ ] **Step 6: Запустити тест — має пройти**

Run: `npx vitest run src/bot/commands/extension.test.ts`
Expected: PASS (3 тести).

- [ ] **Step 7: Комміт**

```bash
git add src/bot/commands/extension.ts src/bot/commands/extension.test.ts src/i18n
git commit -m "feat(#267): /extension links to the Chrome Web Store instead of sending a zip"
```

---

## Task 2: Прибрати бот-сторону каналу

**Files:**
- Delete: `src/bot/commands/extension-release.ts`, `src/bot/commands/extension-release.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Видалити файли**

```bash
git rm src/bot/commands/extension-release.ts src/bot/commands/extension-release.test.ts
```

- [ ] **Step 2: Прибрати реєстрацію**

У `src/index.ts` видалити рядок імпорту:

```ts
import { extensionReleaseCommand } from './bot/commands/extension-release';
```

і рядок `extensionReleaseCommand,` зі списку композерів (близько рядка 192).

- [ ] **Step 3: Перевірити компіляцію**

Run: `npm run typecheck`
Expected: exit 0, без помилок про `extension-release`.

- [ ] **Step 4: Комміт**

```bash
git add -A src/bot/commands src/index.ts
git commit -m "refactor(#267): drop the bot-side release intake and broadcast"
```

---

## Task 3: Прибрати публікаційні скрипти й applier

**Files:**
- Delete: `scripts/publish-extension-release.ts`, `scripts/publish-extension-release.test.ts`, `scripts/apply-extension-release.test.ts`, `deploy/bin/apply-extension-release.sh`

- [ ] **Step 1: Видалити файли**

```bash
git rm scripts/publish-extension-release.ts scripts/publish-extension-release.test.ts \
       scripts/apply-extension-release.test.ts deploy/bin/apply-extension-release.sh
```

- [ ] **Step 2: Переконатися, що store-шлях не зачеплено**

Run: `npx vitest run scripts/publish-store-release.test.ts`
Expected: PASS — `release:store` (#266) від видаленого коду не залежить.

- [ ] **Step 3: Комміт**

```bash
git commit -m "refactor(#267): remove the off-store publish scripts and privileged applier"
```

---

## Task 4: Видалити storage-модуль

**Files:**
- Delete: `src/storage/extension_releases.ts`, `src/storage/extension_releases.test.ts`

- [ ] **Step 1: Переконатися, що імпортерів не лишилось**

```bash
python3 - <<'PY'
import os
skip={'node_modules','.git','dist','.worktrees','tmp','coverage'}
for root,dirs,files in os.walk('.'):
    dirs[:]=[d for d in dirs if d not in skip]
    for f in files:
        if not f.endswith('.ts'): continue
        p=os.path.join(root,f)
        t=open(p,encoding='utf-8').read()
        if 'storage/extension_releases' in t: print(p)
PY
```

Expected: у виводі лише `src/storage/extension_releases.test.ts` (сам тест модуля). Якщо є щось інше — зупинитись і доробити попередні задачі.

- [ ] **Step 2: Видалити**

```bash
git rm src/storage/extension_releases.ts src/storage/extension_releases.test.ts
```

- [ ] **Step 3: Перевірити, що схема НЕ змінилась**

Run: `npx vitest run src/storage/schema.test.ts && npm run typecheck`
Expected: PASS + exit 0. Таблиця `extension_releases` лишається в `schema.ts` — це рішення 1 дизайну, тест схеми має бути зеленим **без правок**.

- [ ] **Step 4: Комміт**

```bash
git commit -m "refactor(#267): drop the extension_releases storage module (table stays)"
```

---

## Task 5: Прибрати i18n-рядки каналу

**Files:**
- Modify: `src/i18n/types.ts`, `src/i18n/locales/uk.ts`, `src/i18n/locales/en.ts`, `src/i18n/locales/pl.ts`

- [ ] **Step 1: Видалити ключі з типів**

У `src/i18n/types.ts` видалити рядок `'extension.download': string;` і всі дев'ять рядків `'extrel.*': string;`.

- [ ] **Step 2: Видалити ключі з трьох локалей**

У кожному з `uk.ts`, `en.ts`, `pl.ts` видалити `'extension.download': …` і всі записи `'extrel.*'` — це суцільний блок від `'extension.download'` до `'extrel.how_to_update'` включно (не орієнтуйся на номери рядків: Task 1 уже додав туди `'extension.store'`). Рядки `'extension.success'` і `'extension.store'` **лишаються**.

- [ ] **Step 3: Перевірити типізацію**

Run: `npm run typecheck`
Expected: exit 0. Інтерфейс `Messages` вичерпний, тож зайвий ключ у локалі або пропущений у типах впаде саме тут.

- [ ] **Step 4: Прогнати i18n-тести**

Run: `npx vitest run src/i18n`
Expected: PASS.

- [ ] **Step 5: Комміт**

```bash
git add src/i18n
git commit -m "chore(#267): remove i18n strings of the retired off-store channel"
```

---

## Task 6: Прибрати release-notes машинерію і скрипти `package`/`release`

**Files:**
- Delete: `extension/scripts/release-notes.ts`, `extension/src/shared/release-notes.ts`, `extension/src/shared/release-notes.test.ts`
- Modify: `extension/package.json`, `extension/scripts/zip-dist.py`

- [ ] **Step 1: Видалити файли**

```bash
git rm extension/scripts/release-notes.ts \
       extension/src/shared/release-notes.ts \
       extension/src/shared/release-notes.test.ts
```

- [ ] **Step 2: Прибрати скрипти `package` і `release`**

У `extension/package.json` видалити **два** рядки:

```json
    "package": "vite build && tsx scripts/release-notes.ts && python3 scripts/zip-dist.py",
    "release": "npm run package && cd .. && npx tsx scripts/publish-extension-release.ts",
```

`build`, `postbuild`, `build:store`, `package:store` **лишаються без змін**. `npm run build` уже віддає zip через хук `postbuild`.

- [ ] **Step 3: Оновити докстрінг `zip-dist.py`**

У `extension/scripts/zip-dist.py` замінити рядок 4:

```
Used by `npm run package`. Kept in Python because the host has no `zip` binary and
```

на:

```
Runs as the `postbuild` hook of `npm run build` (and inside `npm run package:store`).
Kept in Python because the host has no `zip` binary and
```

І замінити абзац про `CWS_BUILD` (рядки 12–14), прибравши згадку каналу:

```
When CWS_BUILD=1 (the Chrome Web Store build, invoked via `npm run package:store`),
the output gets a `-store` suffix so it cannot collide with / overwrite the dev build's
zip.
```

Так само в рядку 39 повідомлення про помилку замінити `(or use \`npm run package\`)` на `(it runs automatically as the postbuild hook)`.

- [ ] **Step 4: Оновити застарілий коментар у тесті детермінізму**

У `extension/src/build/zip-determinism.test.ts` знайти коментар з `extension_releases` (близько рядка 25) і замінити згадку на пояснення, що детермінізм тепер потрібен для відтворюваності збірки:

```ts
// holds real build zips; determinism keeps rebuilds byte-identical (reproducible builds).
```

- [ ] **Step 5: Перевірити, що `extractNotes` більше ніхто не імпортує**

```bash
python3 - <<'PY'
import os
skip={'node_modules','.git','dist','.worktrees','tmp','coverage','docs'}
for root,dirs,files in os.walk('.'):
    dirs[:]=[d for d in dirs if d not in skip]
    for f in files:
        if not f.endswith(('.ts','.json')): continue
        p=os.path.join(root,f)
        t=open(p,encoding='utf-8').read()
        if 'extractNotes' in t or 'release-notes' in t: print(p)
PY
```

Expected: порожній вивід.

- [ ] **Step 6: Перевірити збірку розширення й тести**

Run: `cd extension && npm run typecheck && npx vitest run && npm run build`
Expected: усе зелено; у `extension/` з'явився `warsaw-beer-overlay-<version>.zip`.

- [ ] **Step 7: Комміт**

```bash
git add -A extension
git commit -m "build(#267): retire release-notes + package script; npm run build emits the zip"
```

---

## Task 7: Докси

**Files:**
- Modify: `docs/extension-install-uk.md`, `docs/extension-install-en.md`, `docs/extension-release.md`

- [ ] **Step 1: Install-докси — встановлення зі стору**

У `docs/extension-install-uk.md` і `docs/extension-install-en.md` зробити встановлення з Chrome Web Store основним шляхом:
посилання `https://chromewebstore.google.com/detail/fdelmnhijeiojadcaihfdpecfcldbndg`,
нотатка «якщо бачиш *Item not available* — залогінься в Google-акаунт і онови сторінку; розширення позначене 18+ через пивну тематику»,
і згадка, що оновлення тепер автоматичні (zip від бота більше не приходить).

У блоці «зібрати самому» (uk рядки 129–130, en 140–141) прибрати згадку `npm run package` — лишити `npm run build`, додавши, що він одразу кладе `extension/warsaw-beer-overlay-<version>.zip`.

- [ ] **Step 2: Реліз-рунбук**

У `docs/extension-release.md` прибрати весь рунбук off-store каналу (пересилання zip боту, двокрокова розсилка 📣/Скасувати, applier, `npm run release`). Лишити `npm run release:store` як релізний шлях і додати короткий розділ:

```markdown
## Debug build (maintainer only)

`cd extension && npm run build` — the `postbuild` hook writes
`extension/warsaw-beer-overlay-<version>.zip`. Download that single archive from the
server, unzip it locally, and load it via chrome://extensions → Load unpacked.
No CHANGELOG entry is required, so unreleased versions build fine.
```

- [ ] **Step 3: Перевірити, що мертвих згадок не лишилось**

```bash
python3 - <<'PY'
import glob
for p in ['docs/extension-install-uk.md','docs/extension-install-en.md','docs/extension-release.md']:
    for i,l in enumerate(open(p,encoding='utf-8'),1):
        if any(k in l for k in ('npm run release"','npm run package','extension_releases','Розіслати','broadcast')):
            print(f'{p}:{i}: {l.rstrip()}')
PY
```

Expected: порожній вивід (згадки `release:store`/`package:store` — прийнятні, вони не матчаться).

- [ ] **Step 4: Комміт**

```bash
git add docs/extension-install-uk.md docs/extension-install-en.md docs/extension-release.md
git commit -m "docs(#267): install from the store; runbook covers release:store + debug build"
```

---

## Task 8: Спека

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: §6.1 — розчинити**

Перейменувати заголовок `### 6.1 Дистрибуція бета-версій (off-store, через бота)` на `### 6.1 Бейджі та збірка розширення`.

Видалити: legacy-банер (`> ⚠️ Legacy на час переходу (#247)…` разом з рештою цитатного блоку про приватну роздачу), бульєти **«Бот zip не парсить»**, **«Розсилка»**, **«Оновлення в тестера»**.

**Зберегти** бульєт **«Бейджі»** без змін.

Бульєт **«Збірка — єдине джерело метаданих»** переписати на:

```markdown
- **Збірка — єдине джерело метаданих.** Версія береться з `extension/package.json`
  (маніфест імпортує її). Реліз у стор: `npm run release:store` (§6.4). Дебажна збірка
  мейнтейнера: `npm run build` — хук `postbuild` кладе
  `extension/warsaw-beer-overlay-<v>.zip`, який власник качає з сервера й ставить через
  Load unpacked. Zip **детермінований** (сортовані записи, фіксований mtime), тож повторна
  збірка тієї ж версії байт-ідентична. Dev-збірка лишає `key` у маніфесті, що пінить
  extension ID, тож токен переживає переустановку.
```

- [ ] **Step 2: §3.12 — позначити retired**

Під заголовком `### 3.12 \`extension_releases\`…` додати першим рядком:

```markdown
> ⚠️ **RETIRED (#267, 2026-08-08).** Канал off-store дистрибуції прибрано; таблиця
> лишається в схемі разом з історичними рядками, але код у неї більше не пише й не читає.
```

- [ ] **Step 3: §6.4 — єдина секція дистрибуції**

Оновити: store ID лишається; версія — **0.13.0 live**; додати, що листинг позначено
**Mature Content**, тому він невидимий незалогіненим і не з'являється в пошуку по стору,
а прямий лінк працює для будь-кого залогіненого; `/extension` тепер віддає токен + лінк на
стор; off-store канал **ретайрено** (посилання на §6.1 як legacy прибрати).

Замінити блок «Міграційне повідомлення тестерам (чернетка…)» на фактичний розісланий текст
з `tmp/267-broadcast.md` (українська версія), під заголовком
**«Міграційне повідомлення тестерам (розіслано 2026-08-XX, #267)»**, і додати два уточнення
з дизайну: основний шлях — **перевикористати наявний токен** (він не прив'язаний до
extension ID, тож працює в обох копіях), а `/extension` — запасний, бо робить деструктивну
ротацію 1:1; стару копію треба прибрати, бо дві копії дублюють бейджі на сторінці.

- [ ] **Step 4: Перевірити, що битих посилань на §6.1 не лишилось**

```bash
python3 - <<'PY'
t=open('spec.md',encoding='utf-8').read()
for i,l in enumerate(t.splitlines(),1):
    if 'extension_releases' in l or '§6.1' in l or 'npm run release' in l:
        print(f'{i}: {l.strip()[:140]}')
PY
```

Expected: згадки `extension_releases` лише в §3.12 (retired-банер + опис таблиці) і в §3.17/§3.18 (ER/історія міграцій — історичні, лишаються); `npm run release` — лише як `release:store`.

- [ ] **Step 5: Комміт**

```bash
git add spec.md
git commit -m "docs(#267): spec — dissolve §6.1, mark extension_releases retired, §6.4 is the only distribution section"
```

---

## Task 9: Фінальна верифікація

- [ ] **Step 1: Повний сюїт + типи + білд (root)**

Run: `npm run typecheck && npm test && npm run build`
Expected: усе зелено, exit 0.

- [ ] **Step 2: Сюїт розширення**

Run: `cd extension && npm run typecheck && npx vitest run && npm run build`
Expected: усе зелено; `extension/warsaw-beer-overlay-<version>.zip` створено.

- [ ] **Step 3: Ключова регресія — дебажна збірка версії, якої нема в CHANGELOG**

Саме заради цього виймався `release-notes.ts`.

```bash
cd extension
cp package.json /tmp/pkg.bak
python3 - <<'PY'
import json
d=json.load(open('package.json')); d['version']='99.0.0'
json.dump(d, open('package.json','w'), indent=2, ensure_ascii=False)
PY
npm run build && ls -la warsaw-beer-overlay-99.0.0.zip
cp /tmp/pkg.bak package.json && rm -f warsaw-beer-overlay-99.0.0.zip /tmp/pkg.bak
```

Expected: збірка проходить і архів `warsaw-beer-overlay-99.0.0.zip` існує, **попри відсутність секції `99.0.0` у `CHANGELOG.md`**. До цієї зміни крок падав би на `extractNotes`.
Після перевірки `git status --short` має бути чистим (версію повернуто, архів прибрано).

- [ ] **Step 4: Переконатися, що нічого від каналу не лишилось**

```bash
python3 - <<'PY'
import os
skip={'node_modules','.git','dist','.worktrees','tmp','coverage','docs'}
needles=['extensionReleaseCommand','broadcastRelease','latestDeliverableRelease',
         'publish-extension-release','apply-extension-release','extrel.','extension.download',
         'extractNotes']
for root,dirs,files in os.walk('.'):
    dirs[:]=[d for d in dirs if d not in skip]
    for f in files:
        if not f.endswith(('.ts','.json','.py','.sh')): continue
        p=os.path.join(root,f)
        t=open(p,encoding='utf-8').read()
        hit=[n for n in needles if n in t]
        if hit: print(p, hit)
PY
```

Expected: порожній вивід.

- [ ] **Step 5: Комміт (якщо лишились правки) і фінальна перевірка дерева**

```bash
git status --short
git diff --check
```

Expected: чисто.

---

## Мердж-гейт

**PR не мерджиться, поки всі четверо тестерів не підтвердять, що поставили store-версію.** Ретайр не ламає вже встановлені unpacked-копії, але забирає єдиний спосіб щось їм доставити, якщо хтось спіткнеться. Автоматичного сигналу міграції нема (див. «Поза обсягом» у дизайні) — питати напряму.
