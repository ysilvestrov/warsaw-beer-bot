# Untappd Cloudflare-challenge retry budget

- **Issue**: #298
- **Дата**: 2026-07-15
- **Пов'язане**: #222/#225 (rotate-on-block + 1 retry — саме його тут піднімаємо), #221 (breaker split, SHIPPED), #200 (WebShare)

## Проблема

Untappd захищає content-сторінки (`/b/*`, `/user/*`) **Cloudflare Managed Challenge**. Прямі проби 2026-07-15 через WebShare (residential-egress, exit'и — реальні ISP, не датацентр):

- `/b` через проксі: **200-rate ≈ 33%** (реальний HTML на 200), решта — `403 cf-mitigated: challenge` («Just a moment…»). Challenge відсівається **на краю Cloudflare** — origin Untappd такий запит не бачить.
- `curl`/`undici` не виконують JS-challenge → 403; реальний браузер виконує → `cf_clearance` → 200. Частину residential-exit'ів Cloudflare пропускає без challenge (звідси 33%).

`http.ts` наразі робить **лише 1 ретрай** на свіжому IP (2 спроби × 33% ≈ **45% фейлів**). Per-request ротація дає щоразу свіжий IP без `cf_clearance` — кожна спроба це незалежна «лотерея» ~33%.

## Мета

Підняти retry-бюджет ротатора так, щоб `/b` проходив >90% (математика `0.67^N`: 6 ретраїв = 7 спроб ⇒ ~6% фейл). Переюзати наявний `RotatingDispatcher`; challenge-solver (FlareSolverr/headless) **не** вводити — overkill для обсягу ~0-6 `/b`-скрейпів/день.

### Чому обом клієнтам (не лише cookieless)

Ретраї **не** збільшують ризик бану акаунта на cookie'd-клієнті (`/user`): challenge-403 — це відсів на краю Cloudflare, запит не доходить до origin, тож застосунок Untappd **не бачить** cookie з заблокованих спроб. Account-takeover евристику (консистентність IP сесії) рахує origin, а він бачить cookie лише на **успішних** (challenge-passing) хітах — а їх мало в будь-якому разі (`/user` had-list ≈ 5 юзерів, 1×/день), і їхня кількість обмежена кількістю кандидатів, а не кількістю спроб. Бонус: `on-block` режим після знайденого passing-IP лишається на ньому (sticky між успішними). Тож бюджет застосовуємо **однаково обом** клієнтам — простіше (один конфіг, один код-шлях).

## Дизайн

### 1. `src/sources/http.ts` — одиночний ретрай → цикл до бюджету

Додати `maxBlockRetries?: number` до `HttpOpts`, **дефолт 1** (зберігає поточну поведінку `createHttp` і всі наявні тести, які цю опцію не задають). Замінити захардкоджений одиночний ретрай у `get()` циклом:

```ts
let outcome = await classify(url, await doFetch(url));
const budget = opts.maxBlockRetries ?? 1;
let retries = 0;
while (outcome.kind === 'block') {
  if (retries >= budget) {
    // Surface a status the jobs' isBlockStatus() recognises (403/429) so a
    // systemic block — including a 200 Cloudflare challenge page — reaches the breaker.
    throw new HttpError(outcome.status === 429 ? 429 : 403, url);
  }
  opts.rotator!.rotate(outcome.reason);
  retries++;
  outcome = await classify(url, await doFetch(url));
}
return outcome.body;
```

- При `budget=1` поведінка **ідентична** теперішній (1 ротація + 1 повтор, потім throw).
- `CookieExpiredError` на 3xx лишається в `classify()` **до** циклу — протухлий cookie (`307 → /login`) НЕ ретраїться (ротація не лікує expiry; це auth-, не IP-проблема).
- Ретраї йдуть back-to-back: throttle-gap (`minGapMs`) рахується один раз перед першою спробою, повтори його не чекають (як і зараз).
- `rotations()` метрика зростає природно (лічильник ротацій).

### 2. `src/config/env.ts` — новий env

```ts
UNTAPPD_BLOCK_RETRIES: z.coerce.number().int().min(1).default(6),
```

Дефолт 6 (⇒ 7 спроб, ~6% фейл). `min(1)` гарантує хоча б поточний один ретрай. Опційний (має дефолт) — прод-`.env` можна не чіпати.

### 3. `src/index.ts` — розводка обом клієнтам

Додати `maxBlockRetries: env.UNTAPPD_BLOCK_RETRIES` у `createHttp` обох клієнтів:
- `untappdSearchHttp` (cookieless, `per-request`, `/b`);
- `untappdHttp` (cookie'd, `on-block`, `/user`).

Algolia (`algoliaSearch`) не чіпаємо — основний query йде на `algolia.net` напряму; його `refreshKeys` через `untappdSearchHttp` виграє автоматично.

## Тестування (Vitest)

- **`src/sources/http.test.ts`** (наявний фейк `fetchImpl` + фейк `rotator` з лічильником):
  - block×3, далі ok, `maxBlockRetries: 6` → `get()` повертає body; `http.rotations() === 3`.
  - усі block, `maxBlockRetries: 3` → кидає block-`HttpError` (403/429) після рівно 3 ротацій.
  - наявний тест «rotates exactly once» (без опції, дефолт 1) — лишається зеленим.
- **`src/config/env.test.ts`**: `UNTAPPD_BLOCK_RETRIES` дефолт 6 + coercion рядок→число (за патерном тесту `UNTAPPD_BLOCK_THRESHOLD`).

## Оновлення документації (в тому ж PR)

- **`spec.md`** (§ #222 rotation strategy, ~рядок 1128): «один ретрай на свіжому IP» → «до `UNTAPPD_BLOCK_RETRIES` ротацій на свіжих IP (дефолт 6)»; зауважити, що це б'є Cloudflare Managed Challenge на `/b`/`/user`.
- **`.env.example`**: додати `UNTAPPD_BLOCK_RETRIES=6` (optional, поряд із `UNTAPPD_BLOCK_THRESHOLD`).

## Поза скоупом

- Challenge-solver (FlareSolverr/headless) — окремо, якщо ретраїв стане мало.
- Фікс cookie-expiry для `/user` (окрема auth-гігієна).
- Зміни circuit breaker / `proxy-rotator.ts` (лише переюз).

## Критерії готовності

- [ ] `maxBlockRetries` в `HttpOpts` (дефолт 1) + цикл у `get()`; `budget=1` ідентичний старому.
- [ ] `UNTAPPD_BLOCK_RETRIES` (дефолт 6) розведено обом Untappd-клієнтам.
- [ ] Тести: успіх після N блоків, вичерпання бюджету, дефолт-1 незмінний, env-дефолт.
- [ ] `spec.md` + `.env.example` оновлено.
