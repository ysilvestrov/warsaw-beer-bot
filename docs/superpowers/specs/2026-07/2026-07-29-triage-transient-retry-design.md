# Тимчасові помилки в orphan-triage не з'їдають день (#316)

**Дата:** 2026-07-29
**Issue:** [#316](https://github.com/ysilvestrov/warsaw-beer-bot/issues/316) — `orphan-triage: transient LLM error (5xx/429/network) consumes the whole day's window`
**Статус:** design

## Проблема

`orphanTriage` виконує аналіз усередині одного `try/catch`; будь-яка помилка в ньому
йде через `finish()`, яка беззастережно пише `orphan_triage_last_run = <дата>`. Цей
ключ — і є ідемпотентність дня (`shouldRunTriage` пропускає тік, якщо
`lastRunDate === date`). Тобто **одна** транзієнтна помилка провайдера з'їдає весь
залишок вікна `[06:00, 09:00)` (≈11 тіків по 15 хв).

Реальний випадок 2026-07-19: о 06:03 `llm.analyze()` отримав HTTP 500 від Anthropic
(SDK вже зробив свої 2 ретраї), джоба закрила день, дайджест показав
`Тріаж: помилка (500 …)`. Даних не втрачено (запис `review_class` не відбувся,
orphans повертаються в завтрашній батч), але день витрачено даремно.

Другий, суміжний дефект: дайджест показує тріаж-рядок лише якщо
`parsed.date === dateKey` (`daily-status.ts`). Тож день, у якому тріаж так і не
дійшов до `finish()`, зник би з дайджесту **мовчки** — тобто «просто не закривати
день» без окремої публікації результату замінює гучний збій на тихий.

## Обмеження, які формують рішення

- Ретрай не безкоштовний: перед `llm.analyze()` йде `collectTriageProbes` (до
  `TRIAGE_PROBE_LIMIT` = 120 Untappd-пошуків), сам виклик — 50 orphan'ів у промпті і
  до 16k output-токенів. Наївне «не закривати день на помилці» дає до ~12 повних
  прогонів на день під час тривалої аварії провайдера.
- Помилки прилітають з трьох різних джерел і в трьох різних формах: Anthropic SDK
  кидає типізовані `APIError` (`.status`) / `APIConnectionError`; OpenAI-шлях у
  `triage-llm.ts` і `github-issues.ts` — звичайні `Error` зі статусом лише в тексті.
  Класифікувати регексом по тексту — крихко.
- Контракт «раз на варшавський день» ламати не можна: жодних ретраїв поза вікном,
  жодного другого повного прогону після успішного.

## Рішення

Класифікація помилок **плюс** лічильник спроб. Permanent-помилка закриває день
одразу (як зараз); transient — ретраїться наступним тіком у вікні, але не більше
**3 спроб на день**.

### 1. Класифікація — новий `src/domain/transient-error.ts`

```ts
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number);
}
export function isTransient(e: unknown): boolean;
```

`status` — обов'язковий аргумент конструктора, не опційне поле: `HttpStatusError` огортає
**кожну** не-2xx відповідь наших fetch-клієнтів, включно з permanent-класами
(403, 400 тощо), тож клас із назвою, що обіцяє ретрайність, був би неправильним —
рішення «ретраїти чи ні» ухвалює лише статус, а не факт, що це `HttpStatusError`.

`isTransient` повертає `true` для:

- будь-якого об'єкта з числовим `status` ∈ {408, 429} або `status >= 500` — це
  duck-typed перевірка, тож без імпорту SDK покриває і власний `HttpStatusError`, і
  Anthropic-івський `APIError`; окремої `instanceof`-гілки для `HttpStatusError` не
  потрібно;
- мережевих збоїв: ім'я класу ∈ {`APIConnectionError`, `APIConnectionTimeoutError`,
  `AbortError`, `TimeoutError`}, а також `TypeError` з непорожнім `cause` (форма
  `fetch failed` у Node).

  **Ім'я перевіряється і в `e.name`, і в `e.constructor.name`** — це не
  перестраховка. Заміри на встановленому `@anthropic-ai/sdk` (0.110.0) під час
  рев'ю:

  | клас | `status` | `e.name` | `e.constructor.name` |
  |---|---|---|---|
  | `InternalServerError` | 500 | `"Error"` | `InternalServerError` |
  | `RateLimitError` | 429 | `"Error"` | `RateLimitError` |
  | `APIConnectionError` | `undefined` | `"Error"` | `APIConnectionError` |
  | `APIConnectionTimeoutError` | `undefined` | `"Error"` | `APIConnectionTimeoutError` |

  SDK **не виставляє `name` взагалі**, тож перевірка лише по `e.name` пропускала б
  саме обрив з'єднання і таймаут — тобто ті два випадки, які SDK НЕ ретраїть
  усередині себе (5xx/429 він уже ретраїть двічі перед тим, як віддати нам).
  `e.name` лишається для не-SDK джерел (`fetch`/`AbortSignal` виставляють
  `err.name = 'AbortError'` на звичайному `Error`).

Усе інше — `false`. **Невідома помилка вважається permanent** свідомо: не палимо
бюджет probes+LLM на тому, чого не розпізнали. Наші власні помилки валідації
(`invalid response shape`, `response truncated (max_tokens)`, `no tool_use block`,
`0 вердиктів після ретраю`) — звичайні `Error` без `status`, тож автоматично
permanent.

Інфраструктура починає кидати типізоване замість голого `Error`:

- `src/infra/triage-llm.ts`, OpenAI-шлях: не-ok відповідь ⇒ `HttpStatusError` зі
  `status = res.status`;
- `src/infra/github-issues.ts`, `call()`: не-ok відповідь ⇒ `HttpStatusError` зі
  `status = res.status`.

Тексти повідомлень не змінюються — вони йдуть у дайджест (`slice(0, 120)`).
`isTransient` фільтрує за статусом, тож 4xx (крім 408/429) від GitHub чи OpenAI
лишаються permanent, як і слід.

**Свідомий побічний ефект:** `github.listOpenIssues` виконується всередині того ж
`try`, тож GitHub 5xx теж стає transient. Це правильно — це рівно той самий клас
«день втрачено на порожньому місці».

### 2. Лічильник спроб — `job_state`

Новий ключ `orphan_triage_attempts` зі значенням `<дата>:<n>` (напр. `2026-07-19:2`).
Дата всередині значення сама себе інвалідує: читання при іншій даті дає 0, окремого
прибирання не потрібно.

```ts
export const TRIAGE_ATTEMPTS_KEY = 'orphan_triage_attempts';
export const TRIAGE_MAX_ATTEMPTS = 3;
```

### 3. Розчеплення `finish()` у `src/jobs/orphan-triage.ts`

Зараз одна функція робить дві різні речі. Розділяємо:

- `publish(outcome)` — пише лише `orphan_triage_last_result` (що показати в
  дайджесті);
- `finish(outcome)` — `publish(outcome)` + `orphan_triage_last_run = dateKey`
  («день закрито»).

Усі наявні виклики `finish()` (disabled, порожній батч, `covered === 0`, успіх)
лишаються `finish()` — семантика не змінюється. Змінюється лише `catch` навколо
аналізу:

```ts
} catch (e) {
  const attempt = readAttempts(db, dateKey) + 1;
  const transient = isTransient(e);
  log.error({ err: e, attempt, transient }, 'orphan-triage: analysis failed');
  await deps.archive?.write(dateKey, { … });
  const error = errMessage(e).slice(0, 120);
  if (transient && attempt < TRIAGE_MAX_ATTEMPTS) {
    setJobState(db, TRIAGE_ATTEMPTS_KEY, `${dateKey}:${attempt}`);
    publish({ ...outcome, error, attempt });   // last_run НЕ виставлено
    return;
  }
  finish({ ...outcome, error, attempt: transient ? attempt : null });
  return;
}
```

Наслідки:

- transient о 06:03 ⇒ `last_run` порожній ⇒ наступний тік (06:15) ретраїть;
- 3-тя transient-помилка ⇒ `finish()` ⇒ день закрито, у дайджесті фінальна помилка;
- вікно закрилось раніше за 3 спроби ⇒ `last_run` так і не виставлено, але
  `last_result` уже містить сьогоднішню дату, тож дайджест о 09:00 чесно покаже
  останню тимчасову помилку; завтра джоба відпрацює штатно;
- успіх після transient ⇒ `finish()` перезаписує рядок нормальним результатом;
  застарілий лічильник із сьогоднішньою датою нікому не заважає (наступного дня він
  і так читається як 0).

Архів (`deps.archive?.write`) пишеться на кожній невдалій спробі, як і зараз; файл
іменується по `dateKey`, тож пізніша спроба перезаписує ранішу — прийнятно, це
діагностичний артефакт.

### 4. Рядок дайджесту

`TriageOutcome` отримує поле `attempt: number | null` (номер спроби; `null` —
неретрайна помилка або успіх). `buildTriageLine`:

| Ситуація | Рядок |
|---|---|
| transient, не остання спроба | `Тріаж: тимчасова помилка (500 …), спроба 1/3` |
| transient, вичерпано спроби | `Тріаж: помилка (500 …, 3 спроби)` |
| permanent | `Тріаж: помилка (…)` — без змін |
| успіх / вимкнено | без змін |

Правило в `buildTriageLine` однозначне і не залежить від того, хто його викликав:
`attempt !== null && attempt < TRIAGE_MAX_ATTEMPTS` ⇒ «тимчасова помилка …, спроба
n/3»; `attempt !== null && attempt >= TRIAGE_MAX_ATTEMPTS` ⇒ «помилка (…, n спроби)»;
`attempt === null` ⇒ наявний формат.

Бюджет 120 символів для `error` лишається; суфікс зі спробами додається поверх уже
обрізаного тексту.

### 5. Тести (Vitest)

`src/domain/transient-error.test.ts`:

- таблиця класифікації: `{status: 500}`, `{status: 429}`, `{status: 408}`,
  `{status: 400}`, `{status: 404}`, `HttpStatusError`, `TypeError('fetch failed')` з
  `cause`, іменований `APIConnectionError`, звичайний `Error`, рядок замість `Error`.

`src/jobs/orphan-triage.test.ts` (нові кейси):

- transient (LLM кидає `{status: 500}`) ⇒ `orphan_triage_last_run` не виставлено,
  `last_result` містить `спроба 1/3`, `orphan_triage_attempts = <дата>:1`;
- три transient підряд ⇒ на третій `last_run` виставлено, рядок містить `3 спроби`;
- permanent (`Error('boom')`) ⇒ `last_run` виставлено на першій же спробі,
  лічильник не пишеться;
- transient, далі успішний прогон ⇒ нормальний рядок результату, `last_run`
  виставлено;
- лічильник з учорашньою датою ігнорується (перша сьогоднішня transient-помилка =
  спроба 1);
- `github.listOpenIssues` кидає `HttpStatusError(502)` ⇒ поведінка як у transient;
- `covered === 0` ⇒ як і раніше permanent (день закрито).

### 6. `spec.md` §5.11

Додати пункт про транзієнтні помилки: класифікація (5xx/429/408/мережа vs усе
інше), 3 спроби на варшавський день у межах того самого вікна, невичерпані спроби
на межі вікна не переносяться на завтрашній день окремим механізмом (завтра —
звичайний новий день), формат рядка результату для обох випадків.

## Non-goals

- Не розширюємо вікно `[06:00, 09:00)`.
- Не додаємо власних негайних ретраїв поверх SDK-івських (`maxRetries: 2`) — ретрай
  — це наступний 15-хвилинний тік, який ще й дає аварії час минути.
- Не чіпаємо ретрай на порожні вердикти (`ex1.analysis.verdicts.length === 0`) — це
  окремий, уже наявний механізм.
- Не міняємо порядок GitHub-first-DB-second і не чіпаємо шляхи після аналізу
  (`createIssue`/`commentOnIssue` вже мають per-item `try/catch` і не валять запуск).
