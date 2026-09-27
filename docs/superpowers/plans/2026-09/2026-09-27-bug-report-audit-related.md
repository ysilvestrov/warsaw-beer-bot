# /report audit + related issues — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Jev's raw answer on every bug report row and let the judge name up to 3 related candidate issues, rendered as «Схожі (оцінка агента)» in new issues.

**Architecture:** Migration v39 adds `jev_json` and `related_json` to `bug_reports`. The selector returns its raw response next to the numbers (and stops letting `none` eat a top-5 slot). The judge schema gains `related`; the validator filters it to shown candidates; the worker writes `jev_json` before the judge and `related_json` with `markDone`.

**Tech Stack:** Node/TypeScript, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-27-bug-report-audit-related-design.md`

## Global Constraints

- Worktree: `/home/ysi/wbb-audit`, branch `feat/bug-report-audit`. Commit ONLY there; run `git -C /home/ysi/wbb-audit branch --show-current` before every commit and stop if it is not `feat/bug-report-audit`.
- Full gate after every task: `npm test && npm run typecheck` (the whole suite, never a scoped run).
- Tests (CLAUDE.md): exact `toBe`/`toEqual`, no `toBeTruthy`/`toBeDefined`/`>=`; no `if`/early returns in tests; no tautologies; expected values are literals, never recomputed by test helpers.
- Mutation-check every new test: break the line it guards, see it fail, restore. Record each mutation in your report.
- Exactly one test pins the schema head (`schema.test.ts` "records every migration 1..N").
- The code beats this plan: if a quoted line differs from the file, follow the file and note it in the report. Stop only for a contradiction inside your own task.
- Task order is sequential: T1 → T2 → T3 → T4. Each task leaves the gate green.

---

### Task 1: Storage — v39 columns, `setJevResponse`, `related` on `markDone`

**Files:**
- Modify: `src/storage/schema.ts` (append migration after v38)
- Modify: `src/domain/bug-report-types.ts` (`BugReportRow`, `BugReportStore`)
- Modify: `src/storage/bug_reports.ts`
- Modify (callers): `src/jobs/bug-report-worker.ts`, `src/jobs/bug-report-worker.test.ts`, `src/jobs/daily-status.test.ts`, `src/storage/bug_reports.test.ts`, `src/bot/bug-report-media.test.ts`
- Test: `src/storage/schema.test.ts`, `src/storage/bug_reports.test.ts`

**Interfaces:**
- Produces:
  - `BugReportRow.jevJson: string | null`, `BugReportRow.related: number[] | null`
  - `BugReportStore.setJevResponse(db: DB, id: number, json: string): void` — only from `queued`, else throws `illegal transition <status> → jev_json`
  - `BugReportStore.markDone(db, id, v: { verdict; issueNumber; processedAt; related: number[] | null })`

- [ ] **Step 1: Migration test (failing).** In `src/storage/schema.test.ts`:
  - change the head test to `records every migration 1..39 …` with `{ length: 39 }`;
  - in the v38 test, the `bug_reports` column assert is v38's fact only — change it to `expect(columns('bug_reports').slice(0, 18)).toEqual([...the same 18 names...])`;
  - add:

```ts
  it('migration v39 records its version and appends the two audit columns to bug_reports', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 39').get())
      .toEqual({ version: 39 });
    const columns = (db.prepare('PRAGMA table_info(bug_reports)').all() as { name: string }[])
      .map((column) => column.name);
    expect(columns.slice(18)).toEqual(['jev_json', 'related_json']);
    db.close();
  });
```

- [ ] **Step 2:** `npx vitest run src/storage/schema.test.ts` — expect FAIL (no v39).

- [ ] **Step 3: Migration.** Append to `MIGRATIONS` in `src/storage/schema.ts`:

```ts
  {
    version: 39,
    // Audit of /report verdicts (spec 2026-09-27-bug-report-audit-related-design.md):
    // Jev's raw answer and the judge's validated related issues.
    sql: `
      ALTER TABLE bug_reports ADD COLUMN jev_json TEXT;
      ALTER TABLE bug_reports ADD COLUMN related_json TEXT;
    `,
  },
```

- [ ] **Step 4: Store tests (failing).** In `src/storage/bug_reports.test.ts` (reuse its `db`/insert helpers; read the file first and follow its fixture style):

```ts
test('a fresh report has no Jev response and no related issues', () => {
  const id = insertReport(db, report);
  expect(getReport(db, id)).toMatchObject({ jevJson: null, related: null });
});

test('setJevResponse stores the exact JSON on a queued report', () => {
  const id = insertReport(db, report);
  setJevResponse(db, id, '{"model":"jev","probabilities":{"i7":0.6,"none":0.4}}');
  expect(getReport(db, id)?.jevJson).toBe('{"model":"jev","probabilities":{"i7":0.6,"none":0.4}}');
});

test('setJevResponse refuses a report that is no longer queued', () => {
  const id = insertReport(db, report);
  markDone(db, id, { verdict: 'not_a_bug', issueNumber: null, processedAt: '2026-09-26T13:00:00.000Z', related: null });
  expect(() => setJevResponse(db, id, '{}')).toThrow('illegal transition done → jev_json');
});

test.each([
  [[539, 666], [539, 666]],
  [[], []],
  [null, null],
] as const)('markDone stores related %j and reads it back as %j', (related, expected) => {
  const id = insertReport(db, report);
  markDone(db, id, { verdict: 'new', issueNumber: 9, processedAt: '2026-09-26T13:00:00.000Z', related: related as number[] | null });
  expect(getReport(db, id)?.related).toEqual(expected);
});
```

  (`report` = the file's existing `NewBugReport` fixture; use its real name.)

- [ ] **Step 5: Types.** In `src/domain/bug-report-types.ts`:
  - `BugReportRow` add after `processedAt`:
    ```ts
    jevJson: string | null;         // Jev's raw answer on the last attempt (audit)
    related: number[] | null;       // judge's validated related issues; null = not_a_bug or unprocessed
    ```
  - `BugReportStore`: `markDone(db: DB, id: number, v: { verdict: Verdict; issueNumber: number | null; processedAt: string; related: number[] | null }): void;` and add `setJevResponse(db: DB, id: number, json: string): void;`

- [ ] **Step 6: Store.** In `src/storage/bug_reports.ts`:
  - `ReportDbRow` add `jev_json: string | null; related_json: string | null;`
  - `mapReport` add `jevJson: row.jev_json, related: row.related_json === null ? null : JSON.parse(row.related_json) as number[],`
  - `markDone`:
    ```ts
    export function markDone(
      db: DB, id: number,
      v: { verdict: Verdict; issueNumber: number | null; processedAt: string; related: number[] | null },
    ): void {
      const result = db.prepare(`UPDATE bug_reports
        SET status = 'done', verdict = ?, issue_number = ?, processed_at = ?, related_json = ?
        WHERE id = ? AND status IN ('queued', 'publishing')`)
        .run(v.verdict, v.issueNumber, v.processedAt, v.related === null ? null : JSON.stringify(v.related), id);
      assertChanged(db, id, 'done', result.changes);
    }
    ```
  - new, next to `setCandidatesTruncated`, and add it to the exported `bugReportStore` object:
    ```ts
    export function setJevResponse(db: DB, id: number, json: string): void {
      const result = db.prepare(`UPDATE bug_reports SET jev_json = ? WHERE id = ? AND status = 'queued'`)
        .run(json, id);
      assertChanged(db, id, 'jev_json', result.changes);
    }
    ```

- [ ] **Step 7: Callers.** Add `related: null` to every existing `markDone(...)` call in `daily-status.test.ts`, `bug_reports.test.ts`, `bug-report-worker.test.ts`, and to the three calls in `bug-report-worker.ts` (Task 4 replaces the `new`/duplicate ones with the real value). Add `jevJson: null, related: null` to the `BugReportRow` literal in `src/bot/bug-report-media.test.ts`. `grep -rn "markDone(" src scripts` must show no call without `related`.

- [ ] **Step 8: Gate.** `npm test && npm run typecheck` — PASS.

- [ ] **Step 9: Mutations** (each must fail a new test, then restore):
  1. `setJevResponse` without `AND status = 'queued'` → "refuses" test fails.
  2. `mapReport` maps `related_json` null to `[]` → the `null` case fails.
  3. `markDone` omits `related_json` → the `[539, 666]` case fails.
  4. Remove the v39 migration → v39 test and head test fail.

- [ ] **Step 10: Commit** `feat(/report audit): v39 jev_json and related_json on bug_reports`.

---

### Task 2: Selector — raw response and a real top-5

**Files:**
- Modify: `src/domain/bug-report-types.ts` (`IssueSelector`)
- Modify: `src/infra/openrouter-decisions.ts:69-75`
- Modify: `src/jobs/bug-report-worker.test.ts` (selector mocks)
- Test: `src/infra/openrouter-decisions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface JevResponse { model: string; probabilities: Record<string, number> }
  export interface SelectResult { numbers: number[]; truncated: boolean; response: JevResponse }
  // IssueSelector.select(input, candidates): Promise<SelectResult>
  ```
  `response.probabilities` is the object Jev returned, unmodified (keys `i<n>`, `none`, and any unknown key).

- [ ] **Step 1: Failing tests.** In `src/infra/openrouter-decisions.test.ts`:
  - the two existing `expect(result).toEqual({ numbers: …, truncated: false })` gain `response: { model: 'jev-model', probabilities: <the exact object that test's mock returned> }` (write the literal out; do not reference the mock variable);
  - add:

```ts
test('none ranked third does not cost a candidate: the top five are real issues', async () => {
  const candidates = [1, 2, 3, 4, 5, 6].map((number) => ({ ...open, number, title: `Issue ${number}` }));
  const fetchImpl = vi.fn().mockResolvedValue(response(200, {
    answers: { duplicate_of: { probabilities: {
      i1: 0.3, i2: 0.2, none: 0.15, i3: 0.12, i4: 0.1, i5: 0.08, i6: 0.05,
    } } },
  }));
  const result = await createJevSelector({ apiKey: 'secret', model: 'jev-model', fetchImpl })
    .select({ source: 'extension', category: 'no_badge', text: 'Badge missing' }, candidates);
  expect(result.numbers).toEqual([1, 2, 3, 4, 5]);
});
```

- [ ] **Step 2:** `npx vitest run src/infra/openrouter-decisions.test.ts` — expect FAIL (new test gets `[1, 2, 3, 4]`; old ones lack `response`).

- [ ] **Step 3: Types.** Add `JevResponse` and `SelectResult` (above) next to `IssueSelector`; change `select` to return `Promise<SelectResult>` and extend its comment: "`response` is Jev's raw answer, persisted for audit".

- [ ] **Step 4: Implementation.** Replace the `numbers` block in `createJevSelector`:

```ts
      // Drop `none` and unknown keys BEFORE taking five: otherwise `none` ranked in the top
      // five silently costs the judge a real candidate (probe on R-1, 2026-09-27).
      const numbers = Object.entries(probabilities)
        .filter(([key]) => key !== 'none' && Object.hasOwn(criteria, key))
        .sort(([aKey, a], [bKey, b]) => b - a || aKey.localeCompare(bKey))
        .slice(0, 5)
        .map(([key]) => Number(key.slice(1)));
      return { numbers, truncated, response: { model: cfg.model, probabilities } };
```

- [ ] **Step 5: Worker test mocks.** Every `selector.select` mock value in `src/jobs/bug-report-worker.test.ts` gains `response: { model: 'jev-test', probabilities: { i77: 0.6, none: 0.4 } }` (the worker ignores it until Task 4). Include the deferred-promise one near line 302.

- [ ] **Step 6: Gate.** `npm test && npm run typecheck` — PASS.

- [ ] **Step 7: Mutations:** (1) move `.slice(0, 5)` back before `.filter` → new test fails; (2) return `probabilities` filtered of `none` in `response` → an updated old test fails.

- [ ] **Step 8: Commit** `fix(/report audit): selector returns Jev's raw answer; none no longer takes a top-5 slot`.

---

### Task 3: Judge `related` — schema, prompt, parse, validation, render

**Files:**
- Modify: `src/domain/bug-report-types.ts` (`RawVerdict`, `ValidatedVerdict`)
- Modify: `src/infra/bug-report-llm.ts`
- Modify: `src/domain/bug-report-verdict.ts`
- Modify: `src/domain/bug-report-template.ts`
- Modify: `src/jobs/bug-report-worker.ts:141` (pass `value.related`), `src/jobs/bug-report-worker.test.ts` (fixture `raw` gains `related: []`)
- Test: `src/infra/bug-report-llm.test.ts`, `src/domain/bug-report-verdict.test.ts`, `src/domain/bug-report-template.test.ts`

**Interfaces:**
- Consumes: nothing from T1/T2.
- Produces:
  - `RawVerdict.related: number[]`
  - `ValidatedVerdict` `new` / `duplicate_open` / `duplicate_closed` gain `related: number[]`; `not_a_bug` unchanged
  - `renderIssueBody(f: TemplateFields, ctx: ReportContext, related: number[]): string` (third argument REQUIRED; `renderDuplicateComment` signature unchanged)

- [ ] **Step 1: Judge tests (failing).** In `src/infra/bug-report-llm.test.ts`:
  - `validOutput` gains `related: [12]`;
  - the required-list test appends `'related'` at the end of the expected array, and add `expect(VERDICT_SCHEMA.properties.related).toEqual({ type: 'array', items: { type: 'integer' } });`
  - the camel-case mapping test expects `related: [12]`;
  - the rejection `test.each` gains `['related of the wrong type', …{ ...validOutput, related: null }]` and `['a fractional related number', …{ ...validOutput, related: [1.5] }]` (same body shape as the neighbours);
  - add `test('the prompt defines related', () => { expect(VERDICT_SYSTEM_PROMPT).toContain('related: numbers of CANDIDATE ISSUES that are not the same defect'); });`

- [ ] **Step 2: Judge implementation.** In `src/infra/bug-report-llm.ts`:
  - append to `VERDICT_SYSTEM_PROMPT` (after the `For not_a_bug…` line, blank line between):

```
related: numbers of CANDIDATE ISSUES that are not the same defect but that a developer
fixing this report should read — the same feature or screen, the same symptom in another
place, or an earlier fix of a similar symptom that may have regressed or been incomplete.
At most 3. Never the issue_number itself. Empty when no candidate is genuinely related; do
not list a candidate just because it was shown to you.
```

  - `VERDICT_SCHEMA.required` appends `'related'`; `properties` adds `related: { type: 'array', items: { type: 'integer' } },`
  - `parseVerdict` `wrongType` chain appends
    `?? (Array.isArray(raw.related) && raw.related.every((n) => Number.isInteger(n)) ? undefined : 'related')`
    and the returned object adds `related: raw.related,`.

- [ ] **Step 3: Validator tests (failing).** In `src/domain/bug-report-verdict.test.ts`:
  - fixture `raw` gains `related: []`; every existing `toEqual` with `kind: 'new'` or a duplicate `kind` gains `related: []`;
  - add (candidates: `openIssue` is #12, `closedIssue` is #13 in this file — verify):

```ts
test('related keeps shown candidates only, without repeats, in model order, at most three', () => {
  const c14 = { ...openIssue, number: 14 };
  const c15 = { ...openIssue, number: 15 };
  expect(validateVerdict({ ...raw, related: [99, 13, 13, 12, 15, 14] }, [openIssue, closedIssue, c14, c15], 'bot'))
    .toMatchObject({ ok: true, value: { kind: 'new', related: [13, 12, 15] } });
});

test('related never repeats the duplicate target', () => {
  expect(validateVerdict({ ...raw, verdict: 'duplicate_open', issueNumber: 12, related: [12, 13] }, [openIssue, closedIssue], 'bot'))
    .toEqual({ ok: true, value: { kind: 'duplicate_open', issue: openIssue, fields, related: [13] } });
});
```

- [ ] **Step 4: Validator implementation.** In `src/domain/bug-report-verdict.ts`:

```ts
// `related` is a hint, not a verdict: a bad entry is dropped, never a reason to re-judge.
function relatedIssues(raw: RawVerdict, candidates: IssueDetail[]): number[] {
  const shown = new Set(candidates.map((candidate) => candidate.number));
  const result: number[] = [];
  for (const number of raw.related) {
    if (shown.has(number) && number !== raw.issueNumber && !result.includes(number)) result.push(number);
  }
  return result.slice(0, 3);
}
```

  `new` returns `{ kind: 'new', fields, labels, severity: raw.severity, effort: raw.effort, related: relatedIssues(raw, candidates) }`; the duplicate return becomes `{ kind: raw.verdict, issue: issue!, fields, related: relatedIssues(raw, candidates) }`.
  Types: `RawVerdict` gains `related: number[];` and the three `ValidatedVerdict` variants gain `related: number[]`.

- [ ] **Step 5: Template tests (failing).** In `src/domain/bug-report-template.test.ts`: every existing `renderIssueBody(x, ctx)` call becomes `renderIssueBody(x, ctx, [])` (expected strings unchanged — this is the "no line when empty" coverage). Add:

```ts
test('related issues render as one line right before the context section', () => {
  expect(renderIssueBody(fields, bot, [539, 666])).toBe(`## Симптом
Пиво показує чужий рейтинг

**Де:** Картка пива
**Об'єкти:** Броварня, Пиво
**Очікувано:** Рейтинг 4.2
**Фактично:** Рейтинг 3.1

## Кроки
1. Відкрити картку
2. Подивитися рейтинг

## Видно на скріншотах
- Видно 3.1

**Схожі (оцінка агента):** #539, #666

## Контекст
| Джерело | Категорія | Версія розширення | Місто | Мова |
|---|---|---|---|---|
| Бот | Не те пиво / чужий рейтинг | — | Варшава | uk |

Severity і effort — оцінка агента.
Скарга R-7 · медіа: немає
<!-- bug-report:7 -->`);
});
```

- [ ] **Step 6: Template implementation.** In `src/domain/bug-report-template.ts`: `issueSections(f, ctx, includeEstimate, related: number[])`; inside it

```ts
  const relatedLine = related.length > 0
    ? `\n\n**Схожі (оцінка агента):** ${related.map((number) => `#${number}`).join(', ')}` : '';
```

  and the text becomes `…**Фактично:** ${shown(f.actual)}${steps}${screens}${relatedLine}\n\n## Контекст…`.
  `renderIssueBody(f, ctx, related: number[])` → `issueSections(f, ctx, true, related)`; `renderDuplicateComment` → `issueSections(f, ctx, false, [])`.

- [ ] **Step 7: Worker compile.** `src/jobs/bug-report-worker.ts`: `renderIssueBody(value.fields, ctx, value.related)`. Worker test fixture `raw` gains `related: []`.

- [ ] **Step 8: Gate.** `npm test && npm run typecheck` — PASS.

- [ ] **Step 9: Mutations** (each fails a test): drop the `shown.has` check; drop `number !== raw.issueNumber`; drop `!result.includes`; drop `.slice(0, 3)`; drop `'related'` from the `wrongType` chain; render `relatedLine` when empty (`>= 0`).

- [ ] **Step 10: Commit** `feat(/report audit): judge names related candidates; new issues list them as «Схожі»`.

---

### Task 4: Worker — persist and log; spec.md

**Files:**
- Modify: `src/jobs/bug-report-worker.ts`
- Modify: `spec.md` (§3.18, §4 «Скарги на помилки»)
- Test: `src/jobs/bug-report-worker.test.ts`

**Interfaces:**
- Consumes: T1 `setJevResponse`, `markDone(... related)`, `BugReportRow.jevJson/related`; T2 `SelectResult.response`; T3 `ValidatedVerdict.related`.

- [ ] **Step 1: Failing tests** in `src/jobs/bug-report-worker.test.ts` (existing harness; the default selector mock returns `response: { model: 'jev-test', probabilities: { i77: 0.6, none: 0.4 } }`):

```ts
test("Jev's raw answer is on the row even when the judge fails for good", async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockRejectedValue(new Error('boom'));
  await run();
  expect(row(id)).toMatchObject({
    status: 'failed', jevJson: '{"model":"jev-test","probabilities":{"i77":0.6,"none":0.4}}',
  });
});

test("a retried report keeps Jev's answer from its latest attempt", async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockRejectedValueOnce(new HttpStatusError('unavailable', 503));
  await run();
  vi.mocked(deps.selector.select).mockResolvedValue({
    numbers: [77], truncated: false, response: { model: 'jev-test', probabilities: { i77: 0.9, none: 0.1 } },
  });
  await run();
  expect(row(id)).toMatchObject({
    status: 'done', jevJson: '{"model":"jev-test","probabilities":{"i77":0.9,"none":0.1}}',
  });
});

test('a new issue lists related issues and the row keeps them', async () => {
  const id = addReport();
  vi.mocked(deps.selector.select).mockResolvedValue({
    numbers: [77, 78], truncated: false, response: { model: 'jev-test', probabilities: { i77: 0.5, i78: 0.3, none: 0.2 } },
  });
  vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, related: [78, 77] });
  await run();
  expect(deps.github.createIssue).toHaveBeenCalledWith(expect.objectContaining({
    body: expect.stringContaining('**Схожі (оцінка агента):** #78, #77'),
  }));
  expect(row(id)).toMatchObject({ verdict: 'new', related: [78, 77] });
});

test('a duplicate keeps related on the row but never mentions it in the comment', async () => {
  const id = addReport();
  vi.mocked(deps.selector.select).mockResolvedValue({
    numbers: [77, 78], truncated: false, response: { model: 'jev-test', probabilities: { i77: 0.5, i78: 0.3, none: 0.2 } },
  });
  vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'duplicate_open', issueNumber: 77, related: [78] });
  await run();
  expect(deps.github.commentOnIssue).toHaveBeenCalledWith(77, expect.not.stringContaining('Схожі'));
  expect(row(id)).toMatchObject({ verdict: 'duplicate_open', related: [78] });
});

test('not a bug stores no related issues even when the model named some', async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'not_a_bug', related: [77] });
  await run();
  expect(row(id)).toMatchObject({ verdict: 'not_a_bug', related: null });
});

test('the worker logs the candidates and the verdict', async () => {
  const id = addReport();
  await run();
  expect(deps.log.info).toHaveBeenCalledWith({ reportId: id, top: [77], none: 0.4 }, 'Bug report candidates');
  expect(deps.log.info).toHaveBeenCalledWith(
    { reportId: id, verdict: 'new', issueNumber: null, related: [] }, 'Bug report verdict',
  );
});
```

  Check against the file: the retry test assumes a 503 from the judge is retried on the next `run()` (see the existing transient tests) — if the harness differs, follow it.

- [ ] **Step 2:** run the file — expect FAIL.

- [ ] **Step 3: Implementation** in `processReport`:
  - right after `const selected = await deps.selector.select(...)`:

```ts
      // Written before anything else can fail, so every verdict (or failure) can be audited
      // against what Jev actually ranked. A retry overwrites it with the latest answer.
      store.setJevResponse(db, report.id, JSON.stringify(selected.response));
      deps.log.info({
        reportId: report.id, top: selected.numbers, none: selected.response.probabilities.none ?? null,
      }, 'Bug report candidates');
```

  - right after `const value = judged.value;`:

```ts
      deps.log.info({
        reportId: report.id, verdict: value.kind,
        issueNumber: value.kind === 'duplicate_open' || value.kind === 'duplicate_closed' ? value.issue.number : null,
        related: value.kind === 'not_a_bug' ? null : value.related,
      }, 'Bug report verdict');
```

  - `markDone` for `new` and duplicates passes `related: value.related`; `not_a_bug` keeps `related: null`.

- [ ] **Step 4: spec.md.** §3.18 heading becomes `(v38, v39)`; add two rows after `issue_number`:

```
| `jev_json` | TEXT NULL | v39. Сира відповідь Jev останньої спроби: `{"model","probabilities"}` з ключами `i<номер>` і `none`; пишеться до виклику судді, для аудиту вердикту |
| `related_json` | TEXT NULL | v39. JSON-масив номерів споріднених issue від судді після валідації; `NULL` для `not_a_bug` і необроблених |
```

  In §4 «Скарги на помилки», after the verdict table, a new paragraph:

```
Для `new` і дублікатів модель може назвати до трьох споріднених кандидатів — не той
самий дефект, але те, що варто прочитати разом. Код лишає тільки показані їй кандидати,
без номера дубліката. Новий issue дістає рядок «Схожі (оцінка агента): #N»; коментар до
дубліката — ні. Відповідь кроку вибору кандидатів і споріднені issue зберігаються в
рядку скарги для аудиту вердикту.
```

- [ ] **Step 5: Gate.** `npm test && npm run typecheck` — PASS.

- [ ] **Step 6: Mutations:** move `setJevResponse` after the judge call → "judge fails for good" fails; pass `related: null` for `new` → "new issue lists related" fails; pass `related: []` for `not_a_bug` → "not a bug" fails; drop the candidates log → log test fails.

- [ ] **Step 7: Commit** `feat(/report audit): worker persists Jev's answer and related issues; spec.md`.
