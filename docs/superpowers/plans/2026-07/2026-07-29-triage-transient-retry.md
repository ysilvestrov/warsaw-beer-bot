# Transient-помилки в orphan-triage не з'їдають день (#316) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Транзієнтна помилка (5xx/429/408/мережа) під час денного тріажу більше не закриває варшавський день — джоба ретраїть наступним 15-хвилинним тіком у вікні `[06:00, 09:00)`, максимум 3 спроби на день; permanent-помилка закриває день одразу, як і зараз.

**Architecture:** Нова доменна функція `isTransient(e)` + клас `HttpStatusError` класифікують помилку без розбору тексту повідомлення. Інфраструктура (`triage-llm.ts` OpenAI-шлях, `github-issues.ts`) кидає `HttpStatusError` зі `status`. У `orphan-triage.ts` одна функція `finish()` розчеплюється на `publish()` (пише лише рядок для дайджесту) і `finish()` (`publish` + `orphan_triage_last_run`); лічильник спроб живе в `job_state` під ключем `orphan_triage_attempts` зі значенням `<дата>:<n>`, яке само себе інвалідує зі зміною дати.

**Tech Stack:** Node.js, TypeScript, Vitest, better-sqlite3 (`job_state`), Anthropic SDK.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-29-triage-transient-retry-design.md`

**Verification commands (використовуються в багатьох задачах):**
- один файл тестів: `npx vitest run <path>`
- уся сюїта: `npm test`
- типи: `npm run typecheck`

---

## File Structure

| Файл | Відповідальність | Дія |
|---|---|---|
| `src/domain/transient-error.ts` | `HttpStatusError` + `isTransient(e)` — єдине місце, де вирішується «варто ретраїти?» | створити |
| `src/domain/transient-error.test.ts` | таблиця класифікації | створити |
| `src/infra/triage-llm.ts` | OpenAI-шлях кидає `HttpStatusError` зі `status` | змінити |
| `src/infra/github-issues.ts` | `call()` кидає `HttpStatusError` зі `status` | змінити |
| `src/jobs/orphan-triage.ts` | `publish`/`finish`, лічильник спроб, гілка transient у `catch` | змінити |
| `src/jobs/orphan-triage.test.ts` | нові кейси ретраю | змінити |
| `spec.md` §5.11 | контракт транзієнтних помилок | змінити |

---

### Task 1: Класифікатор `isTransient`

**Files:**
- Create: `src/domain/transient-error.ts`
- Test: `src/domain/transient-error.test.ts`

- [ ] **Step 1: Write the failing test**

Створити `src/domain/transient-error.test.ts`:

```ts
import { expect, test } from 'vitest';
import { HttpStatusError, isTransient } from './transient-error';

test('HttpStatusError carries the status and is transient', () => {
  const e = new HttpStatusError('GitHub GET …: 502 bad gateway', 502);
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(502);
  expect(e.message).toContain('502');
  expect(isTransient(e)).toBe(true);
});

test('duck-typed status: 5xx / 429 / 408 are transient, other 4xx are not', () => {
  // Shape of the Anthropic SDK's APIError — recognised without importing the SDK.
  expect(isTransient({ status: 500, name: 'InternalServerError' })).toBe(true);
  expect(isTransient({ status: 503 })).toBe(true);
  expect(isTransient({ status: 429 })).toBe(true);
  expect(isTransient({ status: 408 })).toBe(true);
  expect(isTransient({ status: 400 })).toBe(false);
  expect(isTransient({ status: 401 })).toBe(false);
  expect(isTransient({ status: 404 })).toBe(false);
  expect(isTransient({ status: '500' })).toBe(false);
});

test('network-level failures are transient', () => {
  const conn = new Error('Connection error.');
  conn.name = 'APIConnectionError';
  expect(isTransient(conn)).toBe(true);

  const timeout = new Error('Request timed out.');
  timeout.name = 'APIConnectionTimeoutError';
  expect(isTransient(timeout)).toBe(true);

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  expect(isTransient(abort)).toBe(true);

  // Node's undici surfaces a network failure as TypeError('fetch failed') + cause.
  expect(isTransient(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }))).toBe(true);
});

test('our own validation errors and non-Error throws are permanent', () => {
  expect(isTransient(new Error('triage LLM: invalid response shape: verdicts: required'))).toBe(false);
  expect(isTransient(new Error('triage LLM: response truncated (max_tokens)'))).toBe(false);
  expect(isTransient(new TypeError('x is not a function'))).toBe(false);  // no cause
  expect(isTransient('raw string failure')).toBe(false);
  expect(isTransient(null)).toBe(false);
  expect(isTransient(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/transient-error.test.ts`
Expected: FAIL — `Failed to resolve import "./transient-error"`.

- [ ] **Step 3: Write minimal implementation**

Створити `src/domain/transient-error.ts`:

```ts
// Retry classification for jobs whose idempotency key must NOT be consumed by a
// blip (#316). Transient = the upstream might succeed on the next tick; anything
// we do not recognise is treated as permanent, because retrying is not free
// (orphan-triage re-runs up to 120 Untappd probes plus a 50-orphan LLM call).

// HTTP statuses worth another attempt: 408 request timeout, 429 rate limit,
// and every 5xx.
function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// Network-level failure names: the Anthropic SDK's connection errors plus the
// standard abort/timeout names used by fetch and AbortSignal.
const NETWORK_ERROR_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'AbortError',
  'TimeoutError',
]);

/** Non-2xx response from one of our fetch-based clients, carrying the status so
 * isTransient() does not have to parse the message text. Being an HttpStatusError says
 * nothing about retriability — the status decides. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

export function isTransient(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // Duck-typed `status` covers both our own HttpStatusError and the Anthropic SDK's
  // APIError, without importing the SDK.
  const { status, name, cause } = e as { status?: unknown; name?: unknown; cause?: unknown };
  if (typeof status === 'number' && isRetriableStatus(status)) return true;
  if (typeof name === 'string' && NETWORK_ERROR_NAMES.has(name)) return true;
  // undici reports a dropped connection as TypeError('fetch failed') + cause.
  return e instanceof TypeError && cause !== undefined && cause !== null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/transient-error.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/transient-error.ts src/domain/transient-error.test.ts
git commit -m "feat(#316): transient-vs-permanent error classification"
```

**Correction during execution:** shipped code renames the class above to
`HttpStatusError`, and `status` is a **required** constructor argument (no
`instanceof HttpStatusError` branch in `isTransient` — the duck-typed `status` check
already covers it). Reason: the class wraps **every** non-2xx response our
fetch-based clients see, including permanent ones (403, 400, …), so a name that
promises retriability was misleading — only the status decides, never the class
itself.

---

### Task 2: Інфраструктура кидає `HttpStatusError` зі статусом

**Files:**
- Modify: `src/infra/github-issues.ts` (функція `call`, ~L28-38)
- Modify: `src/infra/triage-llm.ts` (OpenAI-шлях, гілка `if (!res.ok)`)
- Test: `src/infra/github-issues.test.ts`, `src/infra/triage-llm.test.ts`

- [ ] **Step 1: Write the failing tests**

У `src/infra/github-issues.test.ts` додати імпорт та новий тест (наявний тест
`non-2xx throws with status and response body text` не чіпати — він і далі має
проходити, бо текст повідомлення не змінюється):

```ts
import { isTransient } from '../domain/transient-error';

test('5xx is classified transient, 4xx is not', async () => {
  await expect(client(stubFetch(502, { message: 'bad gateway' })).listOpenIssues('orphan-triage'))
    .rejects.toSatisfy(isTransient);
  await expect(client(stubFetch(403, { message: 'forbidden' })).listOpenIssues('orphan-triage'))
    .rejects.toSatisfy((e: unknown) => !isTransient(e));
});
```

У `src/infra/triage-llm.test.ts` додати:

```ts
import { isTransient } from '../domain/transient-error';

test('openai: 5xx/429 are transient, 400 is not', async () => {
  const llmWith = (status: number, body = 'x') => createOpenAiTriageLlm({
    apiKey: 'k',
    model: 'gpt-4o-mini',
    fetchImpl: vi.fn().mockResolvedValue(new Response(body, { status })),
  });
  await expect(llmWith(500).analyze(input)).rejects.toSatisfy(isTransient);
  await expect(llmWith(429).analyze(input)).rejects.toSatisfy(isTransient);
  await expect(llmWith(400).analyze(input)).rejects.toSatisfy((e: unknown) => !isTransient(e));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/infra/github-issues.test.ts src/infra/triage-llm.test.ts`
Expected: FAIL — обидва нові тести падають на 5xx/429 (кидається голий `Error` без `status`, `isTransient` повертає `false`). `toSatisfy` підтримується встановленим Vitest 4.1.10.

- [ ] **Step 3: Write minimal implementation**

У `src/infra/github-issues.ts` — імпорт і заміна кидка в `call()`:

```ts
import { HttpStatusError } from '../domain/transient-error';
```

```ts
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Typed so the caller (orphan-triage) can tell a retriable 5xx from a
      // permanent 4xx without parsing this message. Text is unchanged: it goes
      // into the daily digest.
      throw new HttpStatusError(
        `GitHub ${init?.method ?? 'GET'} ${url}: ${res.status}${text ? ` ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
```

У `src/infra/triage-llm.ts` — імпорт і заміна кидка в OpenAI-шляху:

```ts
import { HttpStatusError } from '../domain/transient-error';
```

```ts
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpStatusError(
          `triage LLM: OpenAI HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
          res.status,
        );
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/infra/github-issues.test.ts src/infra/triage-llm.test.ts`
Expected: PASS — включно з наявними тестами про текст повідомлення (`/403.*forbidden/s`, `/429.*rate limited/`).

- [ ] **Step 5: Commit**

```bash
git add src/infra/github-issues.ts src/infra/triage-llm.ts src/infra/github-issues.test.ts src/infra/triage-llm.test.ts
git commit -m "feat(#316): typed HTTP failures in triage LLM and GitHub clients"
```

---

### Task 3: Формат рядка дайджесту для спроб

**Files:**
- Modify: `src/jobs/orphan-triage.ts` (`TriageOutcome`, `buildTriageLine`, нові константи)
- Test: `src/jobs/orphan-triage.test.ts`

Ця задача — суто чиста функція; логіка ретраю приходить у Task 4.

- [ ] **Step 1: Write the failing test**

У `src/jobs/orphan-triage.test.ts` розширити імпорт з `./orphan-triage`:

```ts
import {
  orphanTriage, shouldRunTriage, buildTriageLine,
  TRIAGE_LAST_RUN_KEY, TRIAGE_LAST_RESULT_KEY, TRIAGE_ATTEMPTS_KEY, TRIAGE_MAX_ATTEMPTS,
} from './orphan-triage';
```

і додати тест:

```ts
test('buildTriageLine: transient attempts vs final failure', () => {
  const base = {
    total: 5, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
    skipped: 0, unverified: 0, error: null as string | null, disabledReason: null as string | null,
    attempt: null as number | null,
  };
  expect(buildTriageLine({ ...base, error: '500 Internal server error', attempt: 1 }))
    .toBe('Тріаж: тимчасова помилка (500 Internal server error), спроба 1/3');
  expect(buildTriageLine({ ...base, error: '500 Internal server error', attempt: TRIAGE_MAX_ATTEMPTS }))
    .toBe('Тріаж: помилка (500 Internal server error, 3 спроби)');
  // Permanent errors keep the pre-#316 wording.
  expect(buildTriageLine({ ...base, error: 'invalid json', attempt: null }))
    .toBe('Тріаж: помилка (invalid json)');
  expect(buildTriageLine({ ...base, disabledReason: 'нема ключа LLM', attempt: null }))
    .toBe('Тріаж: вимкнено (нема ключа LLM)');
  expect(buildTriageLine({ ...base, attempt: null })).toContain('5 нових');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/orphan-triage.test.ts -t 'buildTriageLine'`
Expected: FAIL — немає експорту `TRIAGE_MAX_ATTEMPTS` / `TRIAGE_ATTEMPTS_KEY` (помилка імпорту або `undefined`), а `attempt` не існує в `TriageOutcome` (помилка типів).

- [ ] **Step 3: Write minimal implementation**

У `src/jobs/orphan-triage.ts` додати константи біля наявних експортів (після `TRIAGE_LABEL`):

```ts
export const TRIAGE_ATTEMPTS_KEY = 'orphan_triage_attempts';
// Transient upstream failures (5xx/429/network) do not consume the Warsaw day —
// the next 15-min tick inside [06:00,09:00) retries. Bounded at 3 because each
// attempt costs a full probe budget (up to 120 Untappd searches) plus a
// 50-orphan LLM call; the window itself would allow ~12 (#316).
export const TRIAGE_MAX_ATTEMPTS = 3;
```

Розширити `TriageOutcome` полем (одразу після `error`):

```ts
  error: string | null;
  // Attempt number for a retriable failure (1-based); null for success,
  // disabled runs and permanent errors.
  attempt: number | null;
  disabledReason: string | null;
```

Оновити `buildTriageLine`:

```ts
export function buildTriageLine(o: TriageOutcome): string {
  if (o.disabledReason) return `Тріаж: вимкнено (${o.disabledReason})`;
  if (o.error) {
    if (o.attempt === null) return `Тріаж: помилка (${o.error})`;
    return o.attempt < TRIAGE_MAX_ATTEMPTS
      ? `Тріаж: тимчасова помилка (${o.error}), спроба ${o.attempt}/${TRIAGE_MAX_ATTEMPTS}`
      : `Тріаж: помилка (${o.error}, ${o.attempt} спроби)`;
  }
  const parts: string[] = [
```

(решта тіла функції без змін)

Додати `attempt: null` в об'єкт `empty` всередині `orphanTriage`:

```ts
    const empty: TriageOutcome = {
      total: 0, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
      skipped: 0, unverified: 0, error: null, attempt: null, disabledReason: null,
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts && npm run typecheck`
Expected: PASS — усі наявні тести файлу + новий; typecheck без помилок.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(#316): attempt-aware triage digest line"
```

---

### Task 4: Ретрай транзієнтних помилок у джобі

**Files:**
- Modify: `src/jobs/orphan-triage.ts` (`finish`/`publish`, читання лічильника, гілка `catch` ~L206-211)
- Test: `src/jobs/orphan-triage.test.ts`

- [ ] **Step 1: Write the failing tests**

У `src/jobs/orphan-triage.test.ts` додати імпорти зверху:

```ts
import { setJobState } from '../storage/job_state';
import { HttpStatusError } from '../domain/transient-error';
```

(рядок `import { getJobState } from '../storage/job_state';` замінити на
`import { getJobState, setJobState } from '../storage/job_state';`)

і додати тести в кінець файлу:

```ts
// #316: a transient upstream failure must not consume the Warsaw day.
const transientLlm = () => ({
  analyze: vi.fn().mockRejectedValue(new HttpStatusError('triage LLM: OpenAI HTTP 500: oops', 500)),
});

test('transient LLM failure: day stays open, attempt counter and soft line written', async () => {
  const d = db();
  seedOrphan(d, 1);
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });

  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();      // day NOT consumed
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.date).toBe('2026-07-05');                       // visible in today's digest
  expect(result.line).toContain('тимчасова помилка');
  expect(result.line).toContain('спроба 1/3');
});

test('transient failures: the third attempt closes the day', async () => {
  const d = db();
  seedOrphan(d, 1);
  const theLlm = transientLlm();
  for (let i = 0; i < TRIAGE_MAX_ATTEMPTS; i += 1) {
    await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  }
  expect(theLlm.analyze).toHaveBeenCalledTimes(TRIAGE_MAX_ATTEMPTS);
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('3 спроби');

  // A fourth tick in the same window is skipped by the idempotency check.
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  expect(theLlm.analyze).toHaveBeenCalledTimes(TRIAGE_MAX_ATTEMPTS);
});

test('transient then success: normal result line, day closed', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'wontfix', review_note: 'y', issue_number: null, new_issue_key: null }],
    new_issues: [],
  };
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });
  await orphanTriage({ db: d, log, llm: llm(analysis), github: gh(), now: inWindow });

  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  const line = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line;
  expect(line).toContain('1 нових');
  expect(line).not.toContain('помилка');
});

test('permanent LLM failure: day is consumed on the first attempt', async () => {
  const d = db();
  seedOrphan(d, 1);
  await orphanTriage({
    db: d, log, github: gh(), now: inWindow,
    llm: { analyze: vi.fn().mockRejectedValue(new Error('triage LLM: invalid response shape')) },
  });
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBeNull();
  const line = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line;
  expect(line).toContain('помилка');
  expect(line).not.toContain('спроба');
});

test('attempt counter from an earlier date does not count against today', async () => {
  const d = db();
  seedOrphan(d, 1);
  setJobState(d, TRIAGE_ATTEMPTS_KEY, '2026-07-04:2');
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });

  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('спроба 1/3');
});

test('transient GitHub failure on listOpenIssues is retried too', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh({
    listOpenIssues: vi.fn().mockRejectedValue(new HttpStatusError('GitHub GET …: 502 bad gateway', 502)),
  });
  await orphanTriage({ db: d, log, llm: llm({ verdicts: [], new_issues: [] }), github, now: inWindow });

  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: FAIL — нові тести падають на `expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull()` (отримано `'2026-07-05'`), бо `catch` і далі закриває день на будь-якій помилці.

- [ ] **Step 3: Write minimal implementation**

У `src/jobs/orphan-triage.ts` додати імпорт:

```ts
import { isTransient } from '../domain/transient-error';
```

Розчепити `finish` (замінити наявне визначення):

```ts
    // Two separate facts, deliberately split (#316): what the digest shows, and
    // whether the Warsaw day is done. A transient failure publishes without
    // closing the day, so the next in-window tick retries.
    const publish = (outcome: TriageOutcome): void => {
      setJobState(db, TRIAGE_LAST_RESULT_KEY,
        JSON.stringify({ date: dateKey, line: buildTriageLine(outcome) }));
    };
    const finish = (outcome: TriageOutcome): void => {
      setJobState(db, TRIAGE_LAST_RUN_KEY, dateKey);
      publish(outcome);
      log.info({ outcome, dateKey }, 'orphan-triage finished');
    };
    // `<date>:<n>`; a value from any other date reads as 0, so the counter needs
    // no cleanup job.
    const attemptsToday = (): number => {
      const raw = getJobState(db, TRIAGE_ATTEMPTS_KEY);
      if (!raw) return 0;
      const [date, n] = raw.split(':');
      const parsed = Number(n);
      return date === dateKey && Number.isFinite(parsed) ? parsed : 0;
    };
```

Замінити гілку `catch` навколо аналізу:

```ts
    } catch (e) {
      const attempt = attemptsToday() + 1;
      const transient = isTransient(e);
      log.error({ err: e, attempt, transient }, 'orphan-triage: analysis failed');
      await deps.archive?.write(dateKey, { dateKey, ranAt: nowIso, batchSize: orphans.length, exchanges });
      const error = errMessage(e).slice(0, 120);
      if (transient && attempt < TRIAGE_MAX_ATTEMPTS) {
        setJobState(db, TRIAGE_ATTEMPTS_KEY, `${dateKey}:${attempt}`);
        publish({ ...outcome, error, attempt });
        return;
      }
      finish({ ...outcome, error, attempt: transient ? attempt : null });
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts && npm run typecheck`
Expected: PASS — усі тести файлу, включно з наявними
`LLM failure: nothing written except error result line` (permanent `Error` ⇒ день закрито)
і `LLM rejecting with a non-Error (plain string)` (не-Error ⇒ permanent ⇒ день закрито).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — жодного регресу в інших файлах.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "fix(#316): transient triage failures retry within the window instead of consuming the day"
```

---

### Task 5: Оновити `spec.md`

**Files:**
- Modify: `spec.md` §5.11 (пункт про порожні/неповні вердикти і пункт про результат запуску)

- [ ] **Step 1: Додати пункт про транзієнтні помилки**

Вставити новий буліт одразу **після** пункту «**Порожні/неповні вердикти:** …» у §5.11:

```markdown
- **Тимчасові збої не з'їдають день (#316):** помилка аналізу класифікується як
  transient (HTTP 5xx/429/408 або мережевий збій — від LLM-провайдера чи GitHub)
  або permanent (усе інше: невалідна схема відповіді, `max_tokens`, 0 вердиктів
  після повтору, невідомі помилки). Transient **не** виставляє
  `orphan_triage_last_run`, тож наступний 15-хвилинний тік у тому ж вікні
  `[06:00, 09:00)` повторює запуск; максимум **3 спроби на варшавський день**
  (лічильник `job_state.orphan_triage_attempts` = `<дата>:<n>`, який
  інвалідується зміною дати). Кожна спроба одразу пише рядок результату з
  сьогоднішньою датою, тож навіть день, який упёрся в межу вікна з невичерпаними
  спробами, видно в дайджесті; невичерпані спроби на завтра не переносяться.
  Permanent-помилка закриває день на першій же спробі. Вартість повтору
  ненульова (повний бюджет проб + LLM-виклик), тому невідома помилка свідомо
  вважається permanent.
```

- [ ] **Step 2: Оновити пункт про рядок результату**

Замінити наявний буліт:

```markdown
- Результат запуску — рядок у daily-status digest (через `job_state`,
  ключ `orphan_triage_last_result`): «Тріаж: 7 нових → 2 до #228, 1 нова #232,
  3 not_on_untappd, 1 пропущено», або «помилка (…)» / «вимкнено (…)».
```

на:

```markdown
- Результат запуску — рядок у daily-status digest (через `job_state`,
  ключ `orphan_triage_last_result`): «Тріаж: 7 нових → 2 до #228, 1 нова #232,
  3 not_on_untappd, 1 пропущено», або «помилка (…)» / «вимкнено (…)».
  Для транзієнтних збоїв — «тимчасова помилка (…), спроба 1/3» доки спроби
  лишились, і «помилка (…, 3 спроби)» після їх вичерпання.
```

- [ ] **Step 3: Перевірити, що інші згадки не суперечать**

Run: `grep -n "orphan_triage_last_run\|orphan_triage_attempts\|тимчасова помилка" spec.md`
Expected: нові згадки в §5.11 і жодного місця, де сказано, що будь-яка помилка закриває день.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(#316): spec — transient triage failures retry within the window"
```

---

### Task 6: Фінальна верифікація

- [ ] **Step 1: Уся сюїта**

Run: `npm test`
Expected: PASS, 0 failed.

- [ ] **Step 2: Типи**

Run: `npm run typecheck`
Expected: без виводу (успіх).

- [ ] **Step 3: Збірка**

Run: `npm run build`
Expected: успішно, `dist/` оновлено (артефакти збірки не комітяться — перевірити `git status`, що `dist/` не потрапив у stage).

- [ ] **Step 4: Перевірити, що в дифі немає зайвого**

Run: `git diff origin/main --stat`
Expected: лише `src/domain/transient-error.ts(+test)`, `src/infra/triage-llm.ts(+test)`, `src/infra/github-issues.ts(+test)`, `src/jobs/orphan-triage.ts(+test)`, `spec.md`, `docs/superpowers/**`.

---

## Non-goals (не робити в цьому плані)

- Не розширювати вікно `[06:00, 09:00)`.
- Не додавати власних негайних ретраїв поверх SDK-івських (`maxRetries: 2`).
- Не чіпати наявний повтор на порожні вердикти (`verdicts.length === 0`).
- Не чіпати `extension/**` (документація розширення не зачіпається).
