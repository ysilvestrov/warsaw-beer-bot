# #576 — раннер адюдикації: план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** дати правилу з #558 благословенну команду, і зробити так, щоб системний збій Untappd не міг перетворити прогін на масовий хибний вердикт.

**Architecture:** фаза проби і фаза застосування розділені. Проба робить живі запити під канаркою з обох боків, нічого не пише в БД і повертає набір вердиктів, який скрипт кладе у файл під `/tmp`. Застосування читає той файл, звіряє кожен вердикт із поточним станом рядка й пише маркери однією транзакцією, не торкаючись мережі.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, pino, tsx (звичайна залежність — `scripts/` запускається в проді).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-02-576-adjudication-runner-design.md`

## Global Constraints

- **Кожна задача проганяє ПОВНИЙ набір**: `npm test && npm run typecheck`. Не звужувати.
- **Кожен тест мутаційно доведений**: зламати → червоне з реальним виводом → відновити → зелене.
- **Семантика вердикту не переглядається.** Що є `rescued`/`unrescued`/`inconclusive` і залізне правило «`transient`/`blocked` не пишуть НІЧОГО» лишаються такими, як змерджено в #558. Змінюється лише *коли* відбувається запис.
- **Фаза проби не пише в БД взагалі.** Жодного `markUnrescued`, жодного руху `untappd_lookup_at`/`untappd_lookup_count`, жодного запису стану брейкера.
- **Брейкер читається, але не пишеться.** Коло відкрите → жодної проби. Прогін брейкер не оновлює.
- **Уся логіка в `src/`.** `scripts/` не покривається `npm test` (`tsconfig.scripts.json` — окремий проєкт із `noEmit`), тож логіка там поїде без тестів. Скрипт: розбір аргументів, композиція, файлові операції, друк.
- **`retired_at` не пишеться ніде в цій роботі.**
- Стиль коментарів: щільні «чому»-коментарі з номерами issue.

---

### Task 1: фаза проби — канарка з обох боків, брейкер, пейсинг, ліміт; жодних записів

**Files:**
- Modify: `src/jobs/adjudicate-issue-rows.ts`
- Test: `src/jobs/adjudicate-issue-rows.test.ts`

**Interfaces:**
- Consumes: `LookupOutcome` з `src/domain/untappd-lookup.ts` (`{kind:'matched';result} | {kind:'not_found';searchUrls;candidates} | {kind:'transient';error} | {kind:'blocked';searchUrl}`); `CircuitBreaker` з `src/domain/untappd-circuit.ts` (метод `canAttempt(now: Date): boolean`); `noopBreaker` звідти ж.
- Produces:
  ```ts
  export interface Verdict {
    beer_id: number; brewery: string; name: string;
    verdict: 'unrescued' | 'rescued' | 'inconclusive' | 'already_marked';
  }
  export interface VerdictFile {
    issue: number; probed_at: string; verdicts: Verdict[];
  }
  export type ProbeOutcome =
    | { status: 'ok'; file: VerdictFile }
    | { status: 'circuit_open' }
    | { status: 'canary_failed'; at: 'before' | 'after' };
  export async function probeIssueRows(
    deps: ProbeDeps, issueNumber: number,
  ): Promise<ProbeOutcome>;
  ```
  де `ProbeDeps` — `{ db; log; lookup; canary: () => Promise<boolean>; breaker?: CircuitBreaker; sleep?: (ms: number) => Promise<void>; sleepMs?: number; limit?: number; now?: () => Date }`.

Стара `adjudicateIssueRows` замінюється цією функцією: писати маркери під час проби більше не можна. `AdjudicateResult` зникає — його роль бере `VerdictFile`, а лічильники рахуються з нього при друці.

- [ ] **Step 1: Write the failing tests**

```ts
import { probeIssueRows } from './adjudicate-issue-rows';

const okCanary = async () => true;
const notFound = async () =>
  ({ kind: 'not_found', searchUrls: ['u'], candidates: [] }) as const;

it('writes NOTHING to the database during a probe', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  db.prepare('UPDATE beers SET untappd_lookup_count = 2, untappd_lookup_at = ? WHERE id = 1')
    .run('2026-08-01T00:00:00Z');

  const out = await probeIssueRows(
    { db, log, lookup: notFound, canary: okCanary, now: () => new Date('2026-09-02T10:00:00Z') },
    576,
  );

  expect(out.status).toBe('ok');
  const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
    .get() as { unrescued_at: string | null; unrescued_issue: number | null };
  expect(row.unrescued_at).toBeNull();
  expect(row.unrescued_issue).toBeNull();
  const beer = getBeer(db, 1)!;
  expect(beer.untappd_lookup_count).toBe(2);
  expect(beer.untappd_lookup_at).toBe('2026-08-01T00:00:00Z');
});

it('returns a verdict per row, carrying the exact input it probed', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  const out = await probeIssueRows(
    { db, log, lookup: notFound, canary: okCanary, now: () => new Date('2026-09-02T10:00:00Z') },
    576,
  );
  expect(out).toEqual({
    status: 'ok',
    file: {
      issue: 576,
      probed_at: '2026-09-02T10:00:00.000Z',
      verdicts: [{ beer_id: 1, brewery: 'b1', name: 'n1', verdict: 'unrescued' }],
    },
  });
});

it('refuses to probe at all when the closing canary fails', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  let calls = 0;
  const canary = async () => { calls += 1; return calls === 1; };   // before ok, after fails
  const out = await probeIssueRows({ db, log, lookup: notFound, canary }, 576);
  expect(out).toEqual({ status: 'canary_failed', at: 'after' });
});

it('does not probe a single row when the opening canary fails', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  const lookup = vi.fn(notFound);
  const out = await probeIssueRows({ db, log, lookup, canary: async () => false }, 576);
  expect(out).toEqual({ status: 'canary_failed', at: 'before' });
  expect(lookup).not.toHaveBeenCalled();
});

it('does not probe when the circuit is open, and does not touch the breaker', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  const lookup = vi.fn(notFound);
  const canary = vi.fn(okCanary);
  const out = await probeIssueRows(
    { db, log, lookup, canary, breaker: { canAttempt: () => false, onResult: () => { throw new Error('breaker must not be written'); } } },
    576,
  );
  expect(out).toEqual({ status: 'circuit_open' });
  expect(lookup).not.toHaveBeenCalled();
  expect(canary).not.toHaveBeenCalled();
});

it('sleeps between probes and honours the limit', async () => {
  const db = fresh();
  for (const id of [1, 2, 3]) orphanWithIssue(db, id, 576);
  const slept: number[] = [];
  const out = await probeIssueRows(
    { db, log, lookup: notFound, canary: okCanary, limit: 2,
      sleep: async (ms) => { slept.push(ms); }, sleepMs: 500 },
    576,
  );
  expect(out.status).toBe('ok');
  expect(out.status === 'ok' && out.file.verdicts).toHaveLength(2);
  expect(slept).toEqual([500, 500]);       // one per probed row, none skipped
});

it('reports an already-marked row without probing it again', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  markUnrescued(db, 1, 576, '2026-09-01T00:00:00Z');
  const lookup = vi.fn(notFound);
  const out = await probeIssueRows({ db, log, lookup, canary: okCanary }, 576);
  expect(out.status === 'ok' && out.file.verdicts[0].verdict).toBe('already_marked');
  expect(lookup).not.toHaveBeenCalled();     // a settled row costs no quota
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/adjudicate-issue-rows.test.ts`
Expected: FAIL — `probeIssueRows is not a function`.

- [ ] **Step 3: Implement the probe phase**

Замінити тіло `src/jobs/adjudicate-issue-rows.ts`, зберігши наявний блок коментарів про шов `lookup` і його контракт «не кидати»:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { LookupOutcome } from '../domain/untappd-lookup';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';

export interface Verdict {
  beer_id: number; brewery: string; name: string;
  verdict: 'unrescued' | 'rescued' | 'inconclusive' | 'already_marked';
}

export interface VerdictFile {
  issue: number;
  probed_at: string;
  verdicts: Verdict[];
}

// #576: проба або ціла, або її немає. Часткового результату не буває — тому ніякого
// `{status:'ok', partial:true}`.
export type ProbeOutcome =
  | { status: 'ok'; file: VerdictFile }
  | { status: 'circuit_open' }
  | { status: 'canary_failed'; at: 'before' | 'after' };

export interface ProbeDeps {
  db: DB;
  log: pino.Logger;
  lookup: (beer: { brewery: string; name: string; abv: number | null }) => Promise<LookupOutcome>;
  // #576: один пошук завідомо наявного пива. Системний збій (ротований ключ, перейменований
  // індекс, м'який IP-бан) віддає 200+порожньо НА ВСЕ, що для нас невідрізненне від чесного
  // not_found — і без цієї перевірки перетворилося б на маркер `unrescued` на КОЖНОМУ рядку
  // issue. Захист від transient/blocked (#316) цього не бачить: збій виглядає добропорядно.
  canary: () => Promise<boolean>;
  breaker?: CircuitBreaker;
  sleep?: (ms: number) => Promise<void>;
  sleepMs?: number;
  limit?: number;
  now?: () => Date;
}

export async function probeIssueRows(
  deps: ProbeDeps,
  issueNumber: number,
): Promise<ProbeOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const breaker = deps.breaker ?? noopBreaker;
  const sleepMs = deps.sleepMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // #576: брейкер ЧИТАЄМО, але не пишемо. Разова ручна команда не повинна поглиблювати
  // чужу аварію — і так само не повинна автоматично гальмувати фонові джоби.
  if (!breaker.canAttempt(now)) {
    deps.log.warn('adjudicate: circuit open, refusing to probe');
    return { status: 'circuit_open' };
  }

  if (!(await deps.canary())) {
    deps.log.error('adjudicate: opening canary failed — Untappd search looks broken');
    return { status: 'canary_failed', at: 'before' };
  }

  const rows = deps.db
    .prepare(
      `SELECT b.id, b.brewery, b.name, b.abv, ef.unrescued_at
         FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.issue_number = ?
          AND ef.retired_at IS NULL
          AND b.untappd_id IS NULL
        ORDER BY b.id`,
    )
    .all(issueNumber) as {
      id: number; brewery: string; name: string; abv: number | null; unrescued_at: string | null;
    }[];

  const selected = deps.limit === undefined ? rows : rows.slice(0, deps.limit);
  const verdicts: Verdict[] = [];

  for (const row of selected) {
    const base = { beer_id: row.id, brewery: row.brewery, name: row.name };
    // Уже вирішений рядок не варто пробувати вдруге — це чиста витрата квоти, а вердикт
    // від неї не зміниться (маркер знімає лише явний ре-арм).
    if (row.unrescued_at !== null) {
      verdicts.push({ ...base, verdict: 'already_marked' });
      continue;
    }
    const outcome = await deps.lookup({ brewery: row.brewery, name: row.name, abv: row.abv });
    await sleep(sleepMs);
    if (outcome.kind === 'matched') verdicts.push({ ...base, verdict: 'rescued' });
    else if (outcome.kind === 'not_found') verdicts.push({ ...base, verdict: 'unrescued' });
    else {
      deps.log.warn({ beerId: row.id, kind: outcome.kind }, 'adjudicate: inconclusive probe');
      verdicts.push({ ...base, verdict: 'inconclusive' });
    }
  }

  // #576: закривна канарка. Якщо Untappd зламався ПОСЕРЕДИНІ, хвіст прогону складається з
  // хибних `unrescued` — а оскільки досі нічого не записано, достатньо не віддати файл.
  if (!(await deps.canary())) {
    deps.log.error('adjudicate: closing canary failed — discarding the whole run');
    return { status: 'canary_failed', at: 'after' };
  }

  return {
    status: 'ok',
    file: { issue: issueNumber, probed_at: now.toISOString(), verdicts },
  };
}
```

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: зелене. Наявні тести цього файлу, що очікували запису маркера під час проби, треба переписати під нову семантику — вони описують поведінку, якої більше немає.

- [ ] **Step 5: Mutation-prove the guards**

Для кожної мутації: зламати, показати червоне з реальним виводом, відновити, показати зелене.
1. Прибрати закривну канарку (`return` одразу з файлом) → тест `canary_failed` / `at: 'after'` червоніє.
2. Прибрати перевірку брейкера → тест `circuit_open` червоніє.
3. Прибрати `slice(0, deps.limit)` → тест ліміту червоніє.
4. Прибрати гілку `already_marked` → її тест червоніє (`lookup` буде викликаний).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/adjudicate-issue-rows.ts src/jobs/adjudicate-issue-rows.test.ts
git commit -m "feat(#576): probe under a canary on both sides, and write nothing while probing"
```

---

### Task 2: фаза застосування — розбір файлу, перевірка проти поточного стану, транзакція

**Files:**
- Create: `src/jobs/adjudicate-apply.ts`
- Test: `src/jobs/adjudicate-apply.test.ts`

**Interfaces:**
- Consumes: `VerdictFile` і `Verdict` із `src/jobs/adjudicate-issue-rows.ts` (Task 1); `markUnrescued(db, beerId, issueNumber, atIso): boolean` із `src/storage/enrich_failures.ts`.
- Produces:
  ```ts
  export function parseVerdictFile(raw: unknown): VerdictFile;   // кидає на кривому вході
  export interface ApplyReport {
    marked: number;
    alreadyMarked: number;
    skipped: { beer_id: number; reason: 'not_orphan' | 'issue_moved' | 'retired' | 'input_changed' | 'missing' }[];
  }
  export function applyVerdicts(db: DB, file: VerdictFile, atIso: string): ApplyReport;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { parseVerdictFile, applyVerdicts } from './adjudicate-apply';

const fileFor = (verdicts: Verdict[]) => ({
  issue: 576, probed_at: '2026-09-02T10:00:00.000Z', verdicts,
});

it('marks only the unrescued verdicts', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  orphanWithIssue(db, 2, 576);
  const report = applyVerdicts(db, fileFor([
    { beer_id: 1, brewery: 'b1', name: 'n1', verdict: 'unrescued' },
    { beer_id: 2, brewery: 'b2', name: 'n2', verdict: 'rescued' },
  ]), '2026-09-02T11:00:00.000Z');
  expect(report).toEqual({ marked: 1, alreadyMarked: 0, skipped: [] });
  const one = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
    .get() as { unrescued_at: string; unrescued_issue: number };
  expect(one).toEqual({ unrescued_at: '2026-09-02T11:00:00.000Z', unrescued_issue: 576 });
  const two = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 2')
    .get() as { unrescued_at: string | null };
  expect(two.unrescued_at).toBeNull();
});

it('skips a row that matched since the probe, and still applies the rest', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  orphanWithIssue(db, 2, 576);
  db.prepare('UPDATE beers SET untappd_id = 999576 WHERE id = 1').run();
  const report = applyVerdicts(db, fileFor([
    { beer_id: 1, brewery: 'b1', name: 'n1', verdict: 'unrescued' },
    { beer_id: 2, brewery: 'b2', name: 'n2', verdict: 'unrescued' },
  ]), '2026-09-02T11:00:00.000Z');
  expect(report.marked).toBe(1);
  expect(report.skipped).toEqual([{ beer_id: 1, reason: 'not_orphan' }]);
});

it('skips a row re-triaged onto another issue — the marker must name the issue that proved it', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  db.prepare('UPDATE enrich_failures SET issue_number = 600 WHERE beer_id = 1').run();
  const report = applyVerdicts(db, fileFor([
    { beer_id: 1, brewery: 'b1', name: 'n1', verdict: 'unrescued' },
  ]), '2026-09-02T11:00:00.000Z');
  expect(report).toEqual({ marked: 0, alreadyMarked: 0, skipped: [{ beer_id: 1, reason: 'issue_moved' }] });
});

it('skips a row retired since the probe', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  expect(retireEnrichFailure(db, 1, 'resolved', '2026-09-02T10:30:00Z')).toBe(true);
  const report = applyVerdicts(db, fileFor([
    { beer_id: 1, brewery: 'b1', name: 'n1', verdict: 'unrescued' },
  ]), '2026-09-02T11:00:00.000Z');
  expect(report.skipped).toEqual([{ beer_id: 1, reason: 'retired' }]);
});

it('skips a row whose probed input no longer matches the stored row', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  db.prepare('UPDATE beers SET name = ? WHERE id = 1').run('a different split');
  const report = applyVerdicts(db, fileFor([
    { beer_id: 1, brewery: 'b1', name: 'n1', verdict: 'unrescued' },
  ]), '2026-09-02T11:00:00.000Z');
  expect(report.skipped).toEqual([{ beer_id: 1, reason: 'input_changed' }]);
});

it('reports a row that was already marked rather than counting it as new', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 576);
  markUnrescued(db, 1, 576, '2026-09-01T00:00:00Z');
  const report = applyVerdicts(db, fileFor([
    { beer_id: 1, brewery: 'b1', name: 'n1', verdict: 'unrescued' },
  ]), '2026-09-02T11:00:00.000Z');
  expect(report).toEqual({ marked: 0, alreadyMarked: 1, skipped: [] });
});

it('rejects a malformed file rather than applying part of it', () => {
  expect(() => parseVerdictFile({ issue: 576 })).toThrow();
  expect(() => parseVerdictFile({ issue: 576, probed_at: 'x', verdicts: [{ beer_id: 1 }] })).toThrow();
  expect(parseVerdictFile(fileFor([]))).toEqual(fileFor([]));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/adjudicate-apply.test.ts`
Expected: FAIL — модуля не існує.

- [ ] **Step 3: Implement the apply phase**

```ts
import type { DB } from '../storage/db';
import { markUnrescued } from '../storage/enrich_failures';
import type { Verdict, VerdictFile } from './adjudicate-issue-rows';

const VERDICTS = ['unrescued', 'rescued', 'inconclusive', 'already_marked'] as const;

// #576: файл приходить з диска, тобто з-поза межі типів. Розбираємо суворо: краще
// відмовитись цілком, ніж застосувати половину чогось незрозумілого.
export function parseVerdictFile(raw: unknown): VerdictFile {
  const f = raw as VerdictFile;
  if (!f || typeof f !== 'object') throw new Error('verdict file: not an object');
  if (!Number.isInteger(f.issue)) throw new Error('verdict file: `issue` must be an integer');
  if (typeof f.probed_at !== 'string') throw new Error('verdict file: `probed_at` must be a string');
  if (!Array.isArray(f.verdicts)) throw new Error('verdict file: `verdicts` must be an array');
  for (const v of f.verdicts) {
    if (!Number.isInteger(v?.beer_id)) throw new Error('verdict file: verdict without an integer `beer_id`');
    if (typeof v.brewery !== 'string' || typeof v.name !== 'string') {
      throw new Error(`verdict file: verdict ${v.beer_id} is missing the probed brewery/name`);
    }
    if (!VERDICTS.includes(v.verdict)) {
      throw new Error(`verdict file: verdict ${v.beer_id} has unknown verdict '${v.verdict}'`);
    }
  }
  return f;
}

export type SkipReason = 'not_orphan' | 'issue_moved' | 'retired' | 'input_changed' | 'missing';

export interface ApplyReport {
  marked: number;
  alreadyMarked: number;
  skipped: { beer_id: number; reason: SkipReason }[];
}

// #576: між пробою і застосуванням рядок міг зматчитись, перетріажитись, бути ретайреним,
// або йому могли переписати brewery/name. Записати вердикт наосліп означало б поставити
// `unrescued_issue`, який не дорівнює `issue_number` — рівно та поломка, яку виправляли як
// Critical у #575. Тому кожен вердикт звіряється з поточним рядком, а що зрушило —
// називається у звіті, а не ковтається.
export function applyVerdicts(db: DB, file: VerdictFile, atIso: string): ApplyReport {
  const report: ApplyReport = { marked: 0, alreadyMarked: 0, skipped: [] };
  const read = db.prepare(
    `SELECT b.brewery, b.name, b.untappd_id, ef.issue_number, ef.retired_at, ef.unrescued_at
       FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE ef.beer_id = ?`,
  );

  const run = db.transaction((verdicts: Verdict[]) => {
    for (const v of verdicts) {
      if (v.verdict !== 'unrescued') continue;
      const row = read.get(v.beer_id) as {
        brewery: string; name: string; untappd_id: number | null;
        issue_number: number | null; retired_at: string | null; unrescued_at: string | null;
      } | undefined;
      const skip = (reason: SkipReason) => report.skipped.push({ beer_id: v.beer_id, reason });
      if (!row) { skip('missing'); continue; }
      if (row.untappd_id !== null) { skip('not_orphan'); continue; }
      if (row.retired_at !== null) { skip('retired'); continue; }
      if (row.issue_number !== file.issue) { skip('issue_moved'); continue; }
      if (row.brewery !== v.brewery || row.name !== v.name) { skip('input_changed'); continue; }
      if (markUnrescued(db, v.beer_id, file.issue, atIso)) report.marked += 1;
      else report.alreadyMarked += 1;
    }
  });
  run(file.verdicts);
  return report;
}
```

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: зелене.

- [ ] **Step 5: Mutation-prove each validation branch**

По черзі прибрати кожну з чотирьох перевірок (`untappd_id`, `retired_at`, `issue_number`, `brewery`/`name`) — щоразу червоніє рівно її тест; відновити, показати зелене. Окремо: замінити `db.transaction(...)` на прямий цикл → перевірити, що тести лишаються зеленими, і **зазначити це у звіті** (наявні тести транзакційність не ловлять; це відомий факт, а не прихована дірка).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/adjudicate-apply.ts src/jobs/adjudicate-apply.test.ts
git commit -m "feat(#576): apply a verdict file only where the row still matches what was probed"
```

---

### Task 3: скрипт, npm-команда і ранбук

**Files:**
- Create: `scripts/adjudicate-runner.ts`
- Modify: `package.json` (новий npm-скрипт), `CLAUDE.md`, `AGENTS.md`, `spec.md`

**Interfaces:**
- Consumes: `probeIssueRows`, `VerdictFile` (Task 1); `parseVerdictFile`, `applyVerdicts` (Task 2); `loadOperatorEnv` із `scripts/operator-env.ts`; `loadEnv` із `src/config/env`; `openDb` із `src/storage/db`; `lookupBeer` із `src/domain/untappd-lookup`; `CANARY_QUERY` із `src/jobs/enrich-orphans`.
- Produces: команда `npm run adjudicate`.

- [ ] **Step 1: Write the script**

Скрипт логіки не містить — лише аргументи, композиція, файл, друк. Зразок структури — `scripts/rearm-matcher-bug-orphans.ts`.

```ts
import { writeFileSync, readFileSync } from 'node:fs';
import pino from 'pino';
import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';
import { loadOperatorEnv } from './operator-env';
import { probeIssueRows } from '../src/jobs/adjudicate-issue-rows';
import { parseVerdictFile, applyVerdicts } from '../src/jobs/adjudicate-apply';
import { lookupBeer } from '../src/domain/untappd-lookup';
import { CANARY_QUERY } from '../src/jobs/enrich-orphans';
import { ALGOLIA_DEFAULTS, createAlgoliaSearch } from '../src/sources/untappd/algolia';

loadOperatorEnv();

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i < 0 ? null : (argv[i + 1] ?? null);
}

async function main(argv: string[]): Promise<number> {
  const applyPath = arg(argv, '--apply');
  const issueRaw = arg(argv, '--issue');
  const limitRaw = arg(argv, '--limit');
  const log = pino({ level: 'info' });
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    if (applyPath) {
      const file = parseVerdictFile(JSON.parse(readFileSync(applyPath, 'utf8')));
      const report = applyVerdicts(db, file, new Date().toISOString());
      console.log(`marked ${report.marked}, already marked ${report.alreadyMarked}`);
      for (const s of report.skipped) console.log(`  skipped ${s.beer_id}: ${s.reason}`);
      return 0;
    }
    if (!issueRaw) { console.error('usage: --issue <n> [--limit <n>] | --apply <file>'); return 2; }
    const issue = parseInt(issueRaw, 10);
    const env = loadEnv();
    // Композиційний корінь (`src/index.ts:95`) додає сюди ще `refreshKeys`, який тягне свіжі
    // ключі зі сторінки пошуку. Тут він свідомо НЕ потрібен: прогін короткий і ручний, а
    // протухлий ключ проявляється як провал канарки — тобто саме як «нічого не пишемо», що
    // й є безпечним наслідком. Тягнути сюди `untappdSearchHttp` заради цього означало б
    // копіювати половину композиційного кореня в ops-скрипт.
    const search = createAlgoliaSearch({
      appId: env.UNTAPPD_ALGOLIA_APP_ID ?? ALGOLIA_DEFAULTS.appId,
      searchKey: env.UNTAPPD_ALGOLIA_SEARCH_KEY ?? ALGOLIA_DEFAULTS.searchKey,
      proxyUrl: env.WEBSHARE_PROXY,
    });
    const out = await probeIssueRows({
      db, log,
      lookup: (beer) => lookupBeer({ ...beer, search }),
      canary: async () => (await search.search(CANARY_QUERY)).length > 0,
      limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
    }, issue);

    if (out.status === 'circuit_open') { console.error('circuit open — refusing to probe'); return 1; }
    if (out.status === 'canary_failed') {
      console.error(`canary failed ${out.at} the run — nothing written`);
      return 1;
    }
    const path = `/tmp/adjudicate-${issue}-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(out.file, null, 2));
    for (const v of out.file.verdicts) console.log(`  ${v.beer_id}  ${v.verdict}  ${v.brewery} / ${v.name}`);
    console.log(`\nverdicts written to ${path}`);
    console.log(`apply with: npm run adjudicate -- --apply ${path}`);
    return 0;
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
```

- [ ] **Step 2: Add the npm script**

У `package.json`, поруч із `rearm-matcher-bug-orphans`:

```json
"adjudicate": "tsx scripts/adjudicate-runner.ts",
```

- [ ] **Step 3: Verify the command runs**

Run: `npm run adjudicate` (без аргументів)
Expected: друкує usage і виходить із кодом 2 — доказ, що модуль вантажиться, імпорти вирішуються й аргументи розбираються.

- [ ] **Step 4: Name the command in the runbook**

У `CLAUDE.md` — доповнити наявний буліт про адюдикацію так, щоб він називав **команду**, а не функцію:

```
Інструмент: `npm run adjudicate -- --issue <n>` (жива проба під канаркою з обох боків, нічого не пише; друкує файл вердиктів), далі `npm run adjudicate -- --apply <файл>` (мережі не торкається; звіряє кожен вердикт із поточним рядком і пише маркери однією транзакцією).
```

У `AGENTS.md` — у секції «Adjudicating an issue's rows» замінити опис функції на ті самі дві команди, прозою того файлу, і додати одне речення: прогін відкидається цілком, якщо канарка не зійшлася з будь-якого боку, тож часткових маркерів не буває.

У `spec.md` — у місці, де описано адюдикацію (шукай `adjudicateIssueRows`), назвати дві фази й файл вердиктів.

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: зелене. `typecheck` покриває `scripts/` через `tsconfig.scripts.json`, тож помилки в скрипті тут і спливуть.

- [ ] **Step 6: Commit**

```bash
git add scripts/adjudicate-runner.ts package.json CLAUDE.md AGENTS.md spec.md
git commit -m "feat(#576): give the adjudication rule a command, and name it in the runbook"
```

---

## Після всіх задач

- [ ] Відкрити PR і **дочекатися AI-рев'ю**, перевірити кожен коментар, відсікти хибні з доказом.
- [ ] Не мерджити самому — доповісти «готове до мерджу».
- [ ] Після мерджу задеплоїти й **перевірити на проді сухою пробою**: `npm run adjudicate -- --issue <закрита issue> --limit 2` з `/opt/warsaw-beer-bot` від користувача `warsaw-beer-bot`. Очікується: канарка проходить, дві проби, файл у `/tmp`, і **жодного** руху в `enrich_failures` (звірити `unrescued_at` до і після).
