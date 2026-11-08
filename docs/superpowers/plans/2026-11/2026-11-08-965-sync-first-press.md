# План: перше натискання Sync стартує синк після закриття попапа (#965)

> Виконання: native (`superpowers:executing-plans`) — обидві задачі дрібні за `detent-pr-slicing`
> (повний код у тексті, ≤ 2 файли + тести, без нових рішень).

**Мета:** після першого натискання «Sync my check-ins», яке питає дозвіл на untappd.com, синк
стартує сам, хоча Chrome закрив попап.

**Архітектура:** попап до запиту дозволу без `await` шле `checkin-sync:awaiting-permission`;
фоновий процес пише позначку в `chrome.storage.session`; `chrome.permissions.onAdded` з
untappd.com і позначкою ≤ 120 с → `handleCheckinSyncStart()`.

**Спека:** `docs/superpowers/specs/2026-11/2026-11-08-965-sync-first-press-design.md`.

## Глобальні обмеження

- Ключ позначки `syncAwaitingPermissionAt`, ISO-час; вікно 120 000 мс.
- Origin — рівно `https://untappd.com/*`.
- «Clear and sync» і Stop позначки не ставлять.
- Позначку знімає кожен `checkin-sync:start` і `checkin-sync:not-starting`.

## Фокус рев'ю

1. Порядок: `awaiting-permission` надіслано до `permissions.request` (жест не витрачено, бо без `await`).
2. Подвійний старт (подія + попап, що вижив) → один синк, відповідь «вже біжить».
3. Прострочена позначка або позначка з невалідним часом не стартує синк і видаляється.
4. Подія лише з algolia (`*.algolia.net`) синк не стартує.
5. Збій читання `storage.session` → синку немає, без винятку назовні.

---

### Задача 1 — фоновий процес

**Файли:** `extension/src/background/index.ts`, `extension/src/background/index.test.ts`,
`extension/tests/setup.ts`.

**Інтерфейси (Produces):** `AWAITING_PERMISSION_KEY`, `AWAITING_PERMISSION_MS`,
`handleAwaitingPermission(): Promise<void>`, `handleNotStarting(): Promise<void>`,
`handleUntappdPermissionAdded(origins: readonly string[] | undefined): Promise<boolean>`
(true — синк стартовано); повідомлення `checkin-sync:awaiting-permission`, `checkin-sync:not-starting`.

- [x] **Крок 1: стаби.** `tests/setup.ts`: `chrome.storage.session` (get/set/remove на окремій
  `Map`, очищення в `beforeEach`), `chrome.permissions.onAdded = { addListener: vi.fn() }`.
- [x] **Крок 2: тести** (`describe('#965 the first Sync press survives the closed popup')`):
  - позначка + `onAdded(['https://untappd.com/*'])` → `true`, синк стартував (статус `running`
    або intent `manual`), позначки немає;
  - без позначки → `false`, intent не з'явився;
  - позначка 121 с тому (`vi.setSystemTime`) → `false`, позначку видалено;
  - позначка `'not-a-date'` → `false`, видалено;
  - лише `['https://*.algolia.net/*']` → `false`, позначка лишилась;
  - `handleNotStarting()` після позначки → наступний `onAdded` → `false`;
  - `handleCheckinSyncStart()` знімає позначку;
  - `storage.session.get` кидає → `false`;
  - тихий крок біжить (`onAlarm(CHECK_ALARM)`), позначка, `onAdded` → intent `manual`, fetch один;
  - зареєстрований слухач: `vi.mocked(chrome.permissions.onAdded.addListener).mock.calls[0][0]`
    з позначкою стартує синк.
- [x] **Крок 3: реалізація** в `index.ts` поруч із `handleCheckinSyncStart`:

```ts
// #965: Chrome's permission prompt closes the popup, so the code after its permissions.request
// never runs. The popup marks the press before asking; the grant event starts the sync.
export const AWAITING_PERMISSION_KEY = 'syncAwaitingPermissionAt';
export const AWAITING_PERMISSION_MS = 120_000;
const UNTAPPD_ORIGIN = 'https://untappd.com/*';

export async function handleAwaitingPermission(): Promise<void> {
  await chrome.storage.session.set({ [AWAITING_PERMISSION_KEY]: new Date().toISOString() });
}

export async function handleNotStarting(): Promise<void> {
  await chrome.storage.session.remove(AWAITING_PERMISSION_KEY).catch(() => undefined);
}

export async function handleUntappdPermissionAdded(origins: readonly string[] | undefined): Promise<boolean> {
  if (!origins?.includes(UNTAPPD_ORIGIN)) return false;
  let at: unknown;
  try {
    at = (await chrome.storage.session.get(AWAITING_PERMISSION_KEY))[AWAITING_PERMISSION_KEY];
  } catch {
    return false;
  }
  if (at === undefined) return false;
  await handleNotStarting();
  const age = Date.now() - (typeof at === 'string' ? Date.parse(at) : NaN);
  if (!(age >= 0 && age <= AWAITING_PERMISSION_MS)) return false;
  await handleCheckinSyncStart();
  return true;
}
```

  `handleCheckinSyncStart` першим рядком — `void handleNotStarting();` (без `await`: інакше два
  одночасні старти обидва пройдуть перевірку `syncStartPromise`). Слухачі на верхньому рівні:
  `chrome.permissions.onAdded.addListener((p) => { void handleUntappdPermissionAdded(p.origins); });`
  і дві гілки в `onMessage`, що відповідають `{ ok: true | false }`.
- [x] **Крок 4:** гейт розширення, коміт.

### Задача 2 — попап і документи

**Файли:** `extension/src/popup/popup.ts`, `extension/src/popup/popup.test.ts`; документи.

- [x] **Крок 1: тести попапа:** звичайне натискання шле `{type:'checkin-sync:awaiting-permission'}`
  раніше за `permissions.request` (`invocationCallOrder`); відмова (`request → false`) шле
  `checkin-sync:not-starting` і текст «Allow access…»; «Clear and sync» не шле
  `awaiting-permission` (наявний тест порядку `['local-db:clear', 'checkin-sync:start']` лишається).
- [x] **Крок 2: реалізація** в обробнику кнопки, перед `await chrome.permissions.request`:

```ts
// #965: the permission prompt can close the popup before the start below runs; the worker
// starts the sync itself when access is granted. Not for Clear and sync: deleting needs the
// question, and only a live popup can ask it.
if (!clearFirst) chrome.runtime.sendMessage({ type: 'checkin-sync:awaiting-permission' }, () => { void chrome.runtime.lastError; });
```

  У гілці `!granted` першим рядком — те саме з `checkin-sync:not-starting`.
- [x] **Крок 3: документи:**
  - `spec.md` §2 після абзацу про повтор start: перше натискання без дозволу, позначка 2 хв, старт
    фоновим процесом; «Clear and sync» без позначки (друге натискання питає); виняток із пошуком.
  - `docs/extension-install-uk.md` / `-en.md`: синк почнеться сам після дозволу (попап закриється —
    відкрий, щоб бачити прогрес); прибрати обіцянку тексту після відмови.
  - `extension/CHANGELOG.md` `[Unreleased]`: рядок про перше натискання.
- [x] **Крок 4:** гейт розширення, коміт.

## Рішення під час реалізації

- Тести, що стартують синк, чекають його кінця (`outcome: 'done'`): інакше незавершений крок
  лишався в модулі й наступний тест (тихий крок) не стартував.
- Cross-review codex @ 5f64140, 2 знахідки, обидві виправлено:
  1. P2 — гонка: обробник дозволу чекав на видалення позначки, а popup, що пережив вікно, за цей
     час стартував і завершив синк; обробник стартував другий. Тепер кожен старт збільшує лічильник
     `syncStarts`, і обробник нічого не робить, якщо той зрушив. Тест із затриманим `remove`;
     мутація (без перевірки лічильника) його валить.
  2. P3 — тест «keeps the mark» порівнював тип, не значення; тепер точна рівність.
- Мутації: усі сім із плану й лічильник ловляться своїми тестами; без реєстрації `onAdded` тестовий
  файл падає ще на зборі.
