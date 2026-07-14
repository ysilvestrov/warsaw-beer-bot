# Triage empty-verdicts guard + raw I/O archive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daily orphan-triage job from silently doing nothing when the LLM returns an empty verdict set, and archive every run's raw LLM I/O for diagnosis.

**Architecture:** `analyze()` now returns a `TriageExchange { analysis, raw }` so the job can see the raw response and `stop_reason`. The job retries once on empty verdicts, escalates a persistent zero to the digest as an error, warns on partial shortfall, and writes every run's exchanges to a rotating file archive (new `triage-archive.ts`, dir from `TRIAGE_LOG_DIR`, disabled when unset).

**Tech Stack:** Node.js, TypeScript, Vitest, zod, pino, `@anthropic-ai/sdk`, SQLite (better-sqlite3).

**Spec:** `docs/superpowers/specs/2026-07/2026-07-14-triage-empty-verdicts-guard-design.md`

---

## File Structure

- `src/config/env.ts` — add optional `TRIAGE_LOG_DIR`.
- `src/infra/triage-llm.ts` — `analyze` returns `TriageExchange`; both providers populate `raw`.
- `src/infra/triage-llm.test.ts` — update happy-path assertions, assert `raw`.
- `src/infra/triage-archive.ts` — **new** rotating JSON archive (best-effort).
- `src/infra/triage-archive.test.ts` — **new** tests.
- `src/jobs/orphan-triage.ts` — retry/zero-error/shortfall logic; `archive` dep; archive write.
- `src/jobs/orphan-triage.test.ts` — update `llm` helper to return exchanges; new behaviour tests.
- `src/index.ts` — build `triageArchive`, pass to both call sites.
- `spec.md` — §5.11 behaviour + config note.
- `.env.example` — document `TRIAGE_LOG_DIR` (if the file lists optional keys).

**Notes for the implementer (zero codebase context assumed):**
- Run a single test file with `npx vitest run <path>`; the whole suite with `npm test`. Typecheck with `npm run typecheck`.
- `tsconfig.json` does **not** set `noUncheckedIndexedAccess`, so `array[i]` is typed as the element type (no `| undefined`).
- The bot is a single process; the triage job already has a module-level re-entrancy guard.
- Commit after every task. Branch is a worktree off `origin/main`; do all git in the worktree (verify with `git rev-parse --show-toplevel` before committing).

---

## Task 1: Add `TRIAGE_LOG_DIR` to env schema

**Files:**
- Modify: `src/config/env.ts:24-31`

- [ ] **Step 1: Add the optional key**

In the orphan-triage block of the zod schema (right after the `GITHUB_REPO` line, still inside `z.object({ ... })` ending at line 31), add:

```ts
  // Optional diagnostic archive of raw triage LLM I/O; unset ⇒ archive disabled.
  TRIAGE_LOG_DIR: z.string().optional(),
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "feat(triage): add optional TRIAGE_LOG_DIR env key"
```

---

## Task 2: `analyze()` returns `TriageExchange` (both providers)

**Files:**
- Modify: `src/infra/triage-llm.ts`
- Test: `src/infra/triage-llm.test.ts`

- [ ] **Step 1: Update the two happy-path tests to the new return shape**

The interface will change so `analyze` resolves `{ analysis, raw }` instead of a bare `Analysis`. Update the OpenAI happy-path test (currently lines 8-21) body assertions from `expect(out).toEqual(validAnalysis)` to:

```ts
  const out = await llm.analyze(input);
  expect(out.analysis).toEqual(validAnalysis);
  expect(out.raw.provider).toBe('openai');
  expect(out.raw.stopReason).toBe('stop');
  expect(typeof out.raw.prompt).toBe('string');
```

For that test to have a `finish_reason`, update its mocked response body (line 9-11) to:

```ts
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(validAnalysis) }, finish_reason: 'stop' }],
  }), { status: 200 }));
```

Update the Anthropic happy-path test (currently lines 53-69) assertion from `expect(out).toEqual(validAnalysis)` to:

```ts
  const out = await llm.analyze(input);
  expect(out.analysis).toEqual(validAnalysis);
  expect(out.raw.provider).toBe('anthropic');
  expect(out.raw.stopReason).toBe('tool_use');
```

Leave all the `rejects.toThrow(...)` tests unchanged — the throw paths are preserved.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/infra/triage-llm.test.ts`
Expected: FAIL — the two happy-path tests fail because `out.analysis` / `out.raw` are undefined (analyze still returns a bare Analysis).

- [ ] **Step 3: Add the exchange types and update the interface**

In `src/infra/triage-llm.ts`, replace the `TriageLlm` interface (currently lines 8-11) with:

```ts
export interface TriageRaw {
  prompt: string;                    // buildTriagePrompt(input) — what was sent
  response: unknown;                 // raw Anthropic message / OpenAI JSON body
  stopReason: string | null;
  provider: 'anthropic' | 'openai';
}

export interface TriageExchange {
  analysis: Analysis;
  raw: TriageRaw;
}

export interface TriageLlm {
  /** Throws on transport error, missing/invalid structured output. Empty
   * verdicts are NOT an error — they resolve normally; the job decides. */
  analyze(input: TriageInput): Promise<TriageExchange>;
}
```

- [ ] **Step 4: Populate `raw` in the Anthropic path**

In `createAnthropicTriageLlm`, replace the `analyze` body (currently lines 41-66) with:

```ts
    async analyze(input) {
      const prompt = buildTriagePrompt(input);
      const res = await client.messages.create({
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        tools: [{
          name: TOOL_NAME,
          description: 'Submit the triage verdicts for all orphans.',
          input_schema: ANALYSIS_TOOL_SCHEMA as never,
          strict: true,
        }],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: prompt }],
      });
      if (res.stop_reason === 'max_tokens') {
        throw new Error('triage LLM: response truncated (max_tokens)');
      }
      const block = res.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(`triage LLM: no tool_use block in response (stop_reason=${res.stop_reason})`);
      }
      return {
        analysis: parseAnalysis(block.input),
        raw: { prompt, response: res, stopReason: res.stop_reason ?? null, provider: 'anthropic' },
      };
    },
```

- [ ] **Step 5: Populate `raw` in the OpenAI path**

In `createOpenAiTriageLlm`, replace the `analyze` body (currently lines 79-111) with:

```ts
    async analyze(input) {
      const prompt = buildTriagePrompt(input);
      const res = await fetchImpl(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Respond with a single JSON object matching the requested shape: {"verdicts": [...], "new_issues": [...]}.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `triage LLM: OpenAI HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
      }
      const data = await res.json() as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('triage LLM: OpenAI response has no choices');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`triage LLM: response is not JSON: ${content.slice(0, 80)}`);
      }
      return {
        analysis: parseAnalysis(parsed),
        raw: { prompt, response: data, stopReason: data.choices?.[0]?.finish_reason ?? null, provider: 'openai' },
      };
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/infra/triage-llm.test.ts`
Expected: PASS (all tests, including the unchanged throw-path tests).

- [ ] **Step 7: Commit**

```bash
git add src/infra/triage-llm.ts src/infra/triage-llm.test.ts
git commit -m "feat(triage): analyze() returns TriageExchange with raw response + stop_reason"
```

---

## Task 3: Rotating raw-I/O archive

**Files:**
- Create: `src/infra/triage-archive.ts`
- Test: `src/infra/triage-archive.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/infra/triage-archive.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import pino from 'pino';
import { createTriageArchive } from './triage-archive';

const log = pino({ level: 'silent' });
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'triage-archive-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

test('returns null when dir is empty', () => {
  expect(createTriageArchive({ dir: '' }, log)).toBeNull();
  expect(createTriageArchive({ dir: '   ' }, log)).toBeNull();
});

test('writes a dated JSON file with the payload', async () => {
  const archive = createTriageArchive({ dir }, log)!;
  await archive.write('2026-07-14', { hello: 'world' });
  const content = await fsp.readFile(join(dir, '2026-07-14.json'), 'utf8');
  expect(JSON.parse(content)).toEqual({ hello: 'world' });
});

test('rotation keeps only the newest `keep` files by date name', async () => {
  const archive = createTriageArchive({ dir, keep: 3 }, log)!;
  for (const day of ['10', '11', '12', '13', '14']) {
    await archive.write(`2026-07-${day}`, { day });
  }
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  expect(files).toEqual(['2026-07-12.json', '2026-07-13.json', '2026-07-14.json']);
});

test('fs error is swallowed as a warn, never throws', async () => {
  const warn = vi.fn();
  const failingLog = { warn } as unknown as pino.Logger;
  const badFs = {
    mkdir: vi.fn().mockRejectedValue(new Error('disk full')),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
  };
  const archive = createTriageArchive({ dir }, failingLog, badFs as never)!;
  await expect(archive.write('2026-07-14', {})).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/infra/triage-archive.test.ts`
Expected: FAIL with "Cannot find module './triage-archive'".

- [ ] **Step 3: Implement the archive**

Create `src/infra/triage-archive.ts`:

```ts
import type pino from 'pino';
import { promises as fsp } from 'fs';
import { join } from 'path';

export interface TriageArchive {
  /** Best-effort: logs a warn and returns on any fs error; never throws. */
  write(dateKey: string, payload: unknown): Promise<void>;
}

type ArchiveFs = Pick<typeof fsp, 'mkdir' | 'writeFile' | 'readdir' | 'rm'>;

// dir empty/unset ⇒ null (archive disabled). One file per run/day, so a same-day
// retry-run overwrites its own file. Rotation keeps the newest `keep` by name —
// `YYYY-MM-DD.json` sorts lexicographically = chronologically.
export function createTriageArchive(
  cfg: { dir: string; keep?: number },
  log: pino.Logger,
  fs: ArchiveFs = fsp,
): TriageArchive | null {
  const dir = cfg.dir.trim();
  if (!dir) return null;
  const keep = cfg.keep ?? 30;
  return {
    async write(dateKey, payload) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, `${dateKey}.json`), JSON.stringify(payload, null, 2), 'utf8');
        const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
        for (const f of files.slice(0, Math.max(0, files.length - keep))) {
          await fs.rm(join(dir, f));
        }
      } catch (err) {
        log.warn({ err }, 'triage-archive: write failed');
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/infra/triage-archive.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infra/triage-archive.ts src/infra/triage-archive.test.ts
git commit -m "feat(triage): rotating raw-I/O archive (best-effort, disabled when dir unset)"
```

---

## Task 4: Job — retry on empty, zero-error, shortfall-warn, archive

**Files:**
- Modify: `src/jobs/orphan-triage.ts`
- Test: `src/jobs/orphan-triage.test.ts`

- [ ] **Step 1: Update the test `llm` helper + reentrancy test to the exchange shape, and add new behaviour tests**

In `src/jobs/orphan-triage.test.ts`:

Replace the `llm` helper (currently line 53) with an exchange-wrapping helper:

```ts
const exchange = (analysis: Analysis, stopReason: string | null = 'tool_use') => ({
  analysis,
  raw: { prompt: 'p', response: {}, stopReason, provider: 'anthropic' as const },
});
const llm = (analysis: Analysis) => ({ analyze: vi.fn().mockResolvedValue(exchange(analysis)) });
```

In the reentrancy test (currently lines 182-204), the deferred promise must resolve a `TriageExchange`, and to avoid triggering the new empty-verdicts retry, resolve a non-empty (quiet) verdict for the seeded orphan. Change the deferred type and its resolution:

```ts
  let resolveAnalyze!: (v: ReturnType<typeof exchange>) => void;
  const deferred = new Promise<ReturnType<typeof exchange>>((resolve) => { resolveAnalyze = resolve; });
```
and change the final resolution (currently `resolveAnalyze({ verdicts: [], new_issues: [] })`) to:
```ts
  resolveAnalyze(exchange({
    verdicts: [{ beer_id: 1, review_class: 'wontfix', review_note: 'x', issue_number: null, new_issue_key: null }],
    new_issues: [],
  }));
```

Now append these new tests at the end of the file:

```ts
test('empty verdicts: retries once; still empty → error line, run marked, nothing written', async () => {
  const d = db();
  seedOrphan(d, 1);
  const emptyEx = exchange({ verdicts: [], new_issues: [] }, 'end_turn');
  const analyze = vi.fn().mockResolvedValue(emptyEx);
  const github = gh();
  await orphanTriage({ db: d, log, llm: { analyze }, github, now: inWindow });

  expect(analyze).toHaveBeenCalledTimes(2);            // one retry
  expect(github.createIssue).not.toHaveBeenCalled();
  expect(github.commentOnIssue).not.toHaveBeenCalled();
  const cls = (d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = 1')
    .get() as { review_class: string | null }).review_class;
  expect(cls).toBeNull();                              // untriaged → re-enters tomorrow
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.line).toContain('помилка');
  expect(result.line).toContain('0 вердиктів');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('empty verdicts then non-empty retry: proceeds normally', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  const good = exchange({
    verdicts: [
      { beer_id: 1, review_class: 'matcher_bug', review_note: 'x', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'wontfix', review_note: 'y', issue_number: null, new_issue_key: null },
    ],
    new_issues: [],
  });
  const analyze = vi.fn()
    .mockResolvedValueOnce(exchange({ verdicts: [], new_issues: [] }, 'end_turn'))
    .mockResolvedValueOnce(good);
  const github = gh();
  await orphanTriage({ db: d, log, llm: { analyze }, github, now: inWindow });

  expect(analyze).toHaveBeenCalledTimes(2);
  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  const cls = (id: number) => (d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
    .get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBe('matcher_bug');
  expect(cls(2)).toBe('wontfix');
});

test('partial shortfall: fewer verdicts than batch → still processes, run marked', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  // Only beer_id 1 gets a verdict; beer_id 2 is uncovered (shortfall).
  const analyze = vi.fn().mockResolvedValue(exchange({
    verdicts: [{ beer_id: 1, review_class: 'wontfix', review_note: 'x', issue_number: null, new_issue_key: null }],
    new_issues: [],
  }));
  const github = gh();
  await orphanTriage({ db: d, log, llm: { analyze }, github, now: inWindow });

  expect(analyze).toHaveBeenCalledTimes(1);             // non-empty → no retry
  const cls = (id: number) => (d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
    .get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBe('wontfix');
  expect(cls(2)).toBeNull();                            // uncovered → re-enters tomorrow
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('archive: write called once with both exchanges', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analyze = vi.fn()
    .mockResolvedValueOnce(exchange({ verdicts: [], new_issues: [] }, 'end_turn'))
    .mockResolvedValueOnce(exchange({
      verdicts: [{ beer_id: 1, review_class: 'wontfix', review_note: 'x', issue_number: null, new_issue_key: null }],
      new_issues: [],
    }));
  const archive = { write: vi.fn().mockResolvedValue(undefined) };
  await orphanTriage({ db: d, log, llm: { analyze }, github: gh(), archive, now: inWindow });

  expect(archive.write).toHaveBeenCalledTimes(1);
  const [dateKey, payload] = archive.write.mock.calls[0];
  expect(dateKey).toBe('2026-07-05');
  expect((payload as { exchanges: unknown[] }).exchanges).toHaveLength(2);
  expect((payload as { batchSize: number }).batchSize).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: FAIL — the new tests fail (no retry happens yet, no error line for empty verdicts, `archive.write` never called). Some may also fail to compile until the helper is in place; the helper change in Step 1 keeps existing tests compiling.

- [ ] **Step 3: Update imports and `OrphanTriageDeps`**

In `src/jobs/orphan-triage.ts`:

Change the analysis import (line 10) to also import `Analysis`:
```ts
import type { Analysis, Verdict } from '../domain/triage-analysis';
```
Change the LLM import (line 7) to also import `TriageExchange`:
```ts
import type { TriageLlm, TriageExchange } from '../infra/triage-llm';
```
Add the archive import (below the github import, line 8):
```ts
import type { TriageArchive } from '../infra/triage-archive';
```
Add `archive` to `OrphanTriageDeps` (currently lines 71-77) — optional so existing call sites/tests compile unchanged:
```ts
export interface OrphanTriageDeps {
  db: DB;
  log: pino.Logger;
  llm: TriageLlm | null;
  github: GithubIssuesClient | null;
  archive?: TriageArchive | null;
  now?: () => Date;
}
```

- [ ] **Step 4: Implement retry / zero-error / shortfall / archive in the job**

In `orphanTriage`, replace the block from `let plan;` through `outcome.skipped = plan.skipped;` (currently lines 120-130) with:

```ts
    let plan;
    let analysis: Analysis;
    const exchanges: TriageExchange[] = [];
    try {
      const openIssues = await github.listOpenIssues(TRIAGE_LABEL);
      const ex1 = await llm.analyze({ orphans, openIssues });
      exchanges.push(ex1);
      // An empty verdict set on a non-empty batch is anomalous (the prompt asks
      // for a verdict per orphan). Retry once against the same open-issues set.
      if (ex1.analysis.verdicts.length === 0) {
        log.warn({ batch: orphans.length, stopReason: ex1.raw.stopReason },
          'orphan-triage: empty verdicts, retrying once');
        const ex2 = await llm.analyze({ orphans, openIssues });
        exchanges.push(ex2);
      }
      analysis = exchanges[exchanges.length - 1].analysis;
      plan = planTriageActions(analysis, openIssues.map((i) => i.number), [...byId.keys()]);
    } catch (e) {
      log.error({ err: e }, 'orphan-triage: analysis failed');
      await deps.archive?.write(dateKey, { dateKey, ranAt: nowIso, batchSize: orphans.length, exchanges });
      finish({ ...outcome, error: errMessage(e).slice(0, 120) });
      return;
    }

    // Every run with an LLM call is archived — the zero-verdict path most of all.
    await deps.archive?.write(dateKey, { dateKey, ranAt: nowIso, batchSize: orphans.length, exchanges });

    // Distinct in-batch beer_ids that actually got a verdict (ignores any
    // hallucinated foreign ids the model may echo from open-issue bodies).
    const covered = new Set(
      analysis.verdicts.map((v) => v.beer_id).filter((id) => byId.has(id)),
    ).size;
    if (covered === 0) {
      log.error({ batch: orphans.length, stopReasons: exchanges.map((e) => e.raw.stopReason) },
        'orphan-triage: zero verdicts after retry');
      finish({ ...outcome, error: `LLM повернув 0 вердиктів (${exchanges.length} спроб)` });
      return;
    }
    if (covered < orphans.length) {
      log.warn({ covered, batch: orphans.length }, 'orphan-triage: verdict shortfall');
    }
    outcome.skipped = plan.skipped;
```

- [ ] **Step 5: Run the job tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: PASS (existing tests + the 4 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(triage): retry on empty verdicts, escalate persistent zero, warn on shortfall, archive raw I/O"
```

---

## Task 5: Wire the archive in `index.ts`

**Files:**
- Modify: `src/index.ts:128`, `src/index.ts:246-248`, `src/index.ts:270-271`

- [ ] **Step 1: Import and build the archive**

Add the import next to the other infra imports (near `src/index.ts:41`):
```ts
import { createTriageArchive } from './infra/triage-archive';
```
After `const triageLlm = createTriageLlm(env);` (line 128), add:
```ts
  const triageArchive = createTriageArchive({ dir: env.TRIAGE_LOG_DIR ?? '' }, log);
```

- [ ] **Step 2: Pass `archive` at both call sites**

In the cron tick (line 247), change to:
```ts
      orphanTriage({ db, log, llm: triageLlm, github: triageGithub, archive: triageArchive })
        .catch((e) => log.error({ err: e }, 'orphan-triage cron'));
```
In the startup catch-up (line 270), change to:
```ts
  orphanTriage({ db, log, llm: triageLlm, github: triageGithub, archive: triageArchive })
    .catch((e) => log.error({ err: e }, 'orphan-triage startup'));
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(triage): wire raw-I/O archive into the triage job"
```

---

## Task 6: Docs (spec.md + .env.example) and full verification

**Files:**
- Modify: `spec.md` §5.11 (around lines 1238-1243)
- Modify: `.env.example` (if present)

- [ ] **Step 1: Update spec.md §5.11**

After the quiet-classes bullet (ends at line 1239, "…не сирих помилок.") insert a new bullet:

```markdown
- **Порожні/неповні вердикти:** якщо LLM повертає **порожній** список вердиктів на
  непорожній батч — один негайний повтор `analyze`; якщо і він порожній (жоден
  orphan з батчу не покритий) — запуск завершується `error` у digest
  («Тріаж: помилка (LLM повернув 0 вердиктів …)»), orphans лишаються нетріаженими
  на завтра. Часткова нестача (покрито менше, ніж у батчі) — лише `warn`-лог, батч
  обробляється штатно.
```

In the config bullet (currently ends line 1243), append a sentence about the archive:

```markdown
  Опційний `TRIAGE_LOG_DIR` вмикає архів сирого LLM-I/O кожного запуску
  (`${TRIAGE_LOG_DIR}/<дата>.json`, ротація 30 файлів, best-effort); не заданий ⇒
  архів вимкнено.
```

- [ ] **Step 2: Document `TRIAGE_LOG_DIR` in `.env.example` (if the file exists and lists optional keys)**

Run: `grep -n "TRIAGE_LLM_PROVIDER\|GITHUB_TOKEN" .env.example` to find the triage block. Add after the triage keys:
```
# Optional: directory for the daily triage raw-I/O archive (rotates 30 files).
# Prod: /var/lib/warsaw-beer-bot/triage-logs. Unset = archive disabled.
TRIAGE_LOG_DIR=
```
If `.env.example` does not exist or has no such block, skip this step (note it in the commit body).

- [ ] **Step 3: Full test suite + typecheck**

Run: `npm test`
Expected: PASS (whole suite).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add spec.md .env.example
git commit -m "docs(triage): spec §5.11 empty-verdicts guard + TRIAGE_LOG_DIR archive"
```

---

## Post-implementation (outside this plan)

- **Prod `.env`:** add `TRIAGE_LOG_DIR=/var/lib/warsaw-beer-bot/triage-logs` as the bot user (dotenv edit, not bash-source) so the archive turns on. Guard behaviour (retry/error/shortfall) is active without it.
- **PR review loop:** open PR → wait for AI review → read + critically assess → fix valid comments before merge.
- **Deploy** via `deploy.sh` on this host; then watch the next 06:00–09:00 Warsaw triage run in the journal and confirm a `${date}.json` archive file appears under the prod dir.
```
