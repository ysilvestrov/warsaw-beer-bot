# #431 Saturation As State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daily triage job discarding correct, in-scope verdicts because their target issue is full; report saturation as a standing state of an issue instead.

**Architecture:** Guard 4 is deleted from the pure planner `planTriageActions`, which removes a refusal that was decided by a fact about the *issue* rather than the *row*. The same constant (12) is retained as `SATURATION_ALERT_ROWS`, a reporting threshold: the planner emits a `saturated` list over every open triage issue, the job reconciles a `saturated` GitHub label against it, and the daily digest gains a line naming the top five.

**Tech Stack:** TypeScript (nodenext), Vitest, better-sqlite3, GitHub REST v3 via plain `fetch`, Telegraf (HTML parse mode).

**Spec:** `docs/superpowers/specs/2026-08/2026-08-19-431-saturation-as-state-design.md`

## Global Constraints

- **Guard deletion must not weaken guard 2.** After removing guard 4, scope is the only check on the `hasIssue` path. Task 1 carries an explicit regression test for this; it may not be dropped.
- **`SATURATION_ALERT_ROWS = 12`**, unchanged in value from `MAX_ROWS_PER_ISSUE`. It blocks nothing.
- **Never `PUT` the full label set.** Labels are mutated only by `POST .../labels` (add) and `DELETE .../labels/{name}` (remove), so human-applied labels (`priority/tier-2`, `extension-bug`) survive.
- **Label reconciliation is best-effort and runs last** — after every comment and every DB write, each issue in its own `try`. A labelling failure logs and continues; it must never cost a verdict.
- **`planTriageActions` stays pure.** No I/O may be added to `src/domain/`.
- **Every test is mutation-proven**: delete the line of implementation it covers, watch it go red, restore. A test that stays green is a plan failure, not a passing test. (Four empty-but-green tests were shipped in one session before this rule.)
- **Digest strings are Ukrainian** and land in Telegram HTML parse mode. `Насичені: #405 (21)` contains no HTML metacharacters; do not introduce `<`, `>` or `&` into this line.
- Run the full suite with `npm test` before each commit. Do **not** deploy — the user merges PRs and deploys are a separate step.

---

### Task 1: The planner stops refusing, starts reporting

**Files:**
- Modify: `src/domain/triage-plan.ts`
- Test: `src/domain/triage-plan.test.ts`

**Interfaces:**
- Consumes: `ScopedIssue { number, scope, postCreationRows }` (already exists in this file); `Verdict` from `./triage-analysis`.
- Produces:
  - `export interface SaturatedIssue { issueNumber: number; rows: number }`
  - `export const SATURATION_ALERT_ROWS = 12`
  - `TriagePlan.saturated: SaturatedIssue[]`
  - `GuardReason` narrowed to `'illegal_scope' | 'scope_violation' | 'unprobed_absence'`
  - `MAX_ROWS_PER_ISSUE` is **removed** — Task 3 must not import it.

- [ ] **Step 1: Write the failing tests**

`src/domain/triage-plan.test.ts` already defines the helpers these tests need — `v()`
(verdict), `row()`/`rows()` (batch rows), `open()` (a `ScopedIssue`, whose default
`COHORT` scope covers beer_ids 1-5, 998, 999) and `noProbes`. Use them; do not invent
parallel fixtures. Add `SATURATION_ALERT_ROWS` to the **existing** import on line 1:

```ts
import { planTriageActions, SATURATION_ALERT_ROWS, type ScopedIssue } from './triage-plan';
```

Then append:

```ts
// --- #431: saturation reports, it does not refuse -------------------------------

test('#431: an in-scope row for a saturated issue is commented, not skipped', () => {
  const issues = [open(900, { postCreationRows: SATURATION_ALERT_ROWS + 5 })];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 900 })], new_issues: [] };
  const plan = planTriageActions(a, issues, rows(1), noProbes, new Set());
  expect(plan.skipped).toBe(0);
  expect(plan.comments[0].verdicts).toHaveLength(1);
});

// The regression test for the deletion: guard 2 is now the ONLY check on this path.
test('#431 REGRESSION: scope still refuses, even far under the threshold', () => {
  const issues = [open(900, { scope: { beer_ids: [1, 2], where: [] }, postCreationRows: 1 })];
  const a: Analysis = { verdicts: [v({ beer_id: 3, issue_number: 900 })], new_issues: [] };
  const plan = planTriageActions(a, issues, rows(3), noProbes, new Set());
  expect(plan.comments).toHaveLength(0);
  expect(plan.guardHits.scope_violation).toBe(1);
  expect(plan.skipped).toBe(1);
});

// not_a_beer needed a carve-out only while a gate existed. Pinned as behaviour so a
// future reader does not "restore" one.
test('#431: not_a_beer on a saturated issue gets its comment (no exception exists)', () => {
  const issues = [open(900, { postCreationRows: SATURATION_ALERT_ROWS })];
  const a: Analysis = {
    verdicts: [v({ beer_id: 2, review_class: 'not_a_beer', issue_number: 900 })],
    new_issues: [],
  };
  const plan = planTriageActions(a, issues, rows(2), noProbes, new Set());
  expect(plan.comments[0].verdicts[0].review_class).toBe('not_a_beer');
});

test('#431: saturated is a STATE — an issue this run never touched is listed', () => {
  const issues = [open(900, { postCreationRows: 21 }), open(901, { postCreationRows: 3 })];
  const plan = planTriageActions({ verdicts: [], new_issues: [] }, issues, [], noProbes, new Set());
  expect(plan.saturated).toEqual([{ issueNumber: 900, rows: 21 }]);
});

test('#431: ties break by issue number ascending, so output is deterministic', () => {
  const issues = [
    open(902, { postCreationRows: 12 }),
    open(900, { postCreationRows: 12 }),
    open(901, { postCreationRows: 30 }),
  ];
  const plan = planTriageActions({ verdicts: [], new_issues: [] }, issues, [], noProbes, new Set());
  expect(plan.saturated.map((s) => s.issueNumber)).toEqual([901, 900, 902]);
});
```

(The sixth spec test — rows accepted in this run counting toward the total — is covered
by converting an existing test in Step 7 rather than writing a new one.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: FAIL. The first test fails on `plan.skipped` being 1 rather than 0; the four `saturated` tests fail with `plan.saturated` being `undefined`; the `SATURATION_ALERT_ROWS` import fails to resolve.

- [ ] **Step 3: Narrow `GuardReason` and rename the constant**

In `src/domain/triage-plan.ts`:

```ts
export type GuardReason = 'illegal_scope' | 'scope_violation' | 'unprobed_absence';
```

Update the comment above it — the sentence "three of the guards end in `skipped`" is now two, and the sentence about recirculating rows forever should be replaced, because that failure is what this change removes:

```ts
// Why a verdict was refused. Counted rather than logged here (this is a pure function),
// so the job can surface them in one line. Every reason here is a fact about the ROW —
// a hallucinated scope, a row that contradicts its target, an absence nobody probed —
// which is what makes retrying it tomorrow worthwhile: a different model call can give a
// different answer. Saturation was once in this list and is not a fact about the row
// (#431), so it no longer refuses anything.
```

Replace the `MAX_ROWS_PER_ISSUE` declaration and its comment block wholesale:

```ts
// Rows attached AFTER creation, not lifetime rows — #405 was opened carrying 15
// enumerated rows, so a lifetime count would misread the very shape (a narrow issue
// split out of a magnet) this whole area exists to encourage. Measured on prod
// 2026-08-14: issues nobody complains about sit at <= 7 rows, while the magnets ran to
// 36 (#347) and 90 (#254), so any threshold in 10-15 separates them.
//
// #431: this used to be a GATE. It is now purely a reporting threshold — being wrong
// about it costs a mislabelled issue, never a discarded row.
export const SATURATION_ALERT_ROWS = 12;

// An issue carrying enough evidence that the next move is a fix, not more triage.
export interface SaturatedIssue {
  issueNumber: number;
  rows: number;
}
```

Add to the `TriagePlan` interface, after `guardHits`:

```ts
  // #431: a STATE computed over every open issue, not an event counted for the ones
  // this run touched — an issue sitting at 21 rows is saturated on a day it receives
  // nothing, and that is exactly the day someone needs to be told.
  saturated: SaturatedIssue[];
```

- [ ] **Step 4: Delete guard 4**

In `planTriageActions`, inside `if (hasIssue) {`, delete this entire block — the comment, the `accepted` line, and the `if`:

```ts
      // Guard 4: a saturated issue stops accepting rows. #347 took 36 rows across 18
      // comment batches in 19 days and shipped nothing — the pile itself was the
      // signal, and nothing was watching it.
      // Rows already accepted for this issue in THIS run count too, or a batch could
      // walk an issue sitting at 11 straight past the limit: each verdict would see
      // 11 >= 12 as false and all of them would land in one comment.
      const accepted = byIssue.get(verdict.issue_number!)?.length ?? 0;
      if (target.postCreationRows + accepted >= MAX_ROWS_PER_ISSUE) {
        guardHits.saturated += 1;
        skipped++;
        continue;
      }
```

Guard 2 (`if (target.scope === null || ...)`) now directly follows `if (!target) { skipped++; continue; }`. **This deletion is the ordering fix**: a row can no longer be refused before it has been scope-checked.

Also drop `saturated: 0,` from the `guardHits` initializer near the top of the function.

- [ ] **Step 5: Compute the saturated list**

Immediately before the `return` at the end of `planTriageActions`, after `comments` is built:

```ts
  // Computed over ALL open issues, including those this run never touched: saturation
  // is a property of the issue's accumulated evidence, not of today's batch. Rows
  // accepted in this run are added because they are about to be attached — the label
  // and the digest must describe the world after this run, not before it.
  // An issue CREATED by this run never appears here: postCreationRows counts rows
  // attached after creation, and a new issue's founding rows land at creation.
  const saturated: SaturatedIssue[] = openIssues
    .map((i) => ({
      issueNumber: i.number,
      rows: i.postCreationRows + (byIssue.get(i.number)?.length ?? 0),
    }))
    .filter((i) => i.rows >= SATURATION_ALERT_ROWS)
    .sort((a, b) => b.rows - a.rows || a.issueNumber - b.issueNumber);
```

And add `saturated` to the returned object.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: PASS, including every pre-existing test in the file except the two named in Step 7.

- [ ] **Step 7: Convert the `#408 guard 4` test section**

`src/domain/triage-plan.test.ts` has a `--- #408 guard 4 ---` section with three tests.
Do **not** delete the section wholesale — two of them still carry meaning.

1. `a saturated issue refuses further attachment` (~line 293) — **delete**. It asserts
   exactly the behaviour this task removes.
2. `an issue born with a large cohort but no post-creation rows still accepts`
   (~line 303) — **keep**, it proves the `postCreationRows` semantics. Replace its last
   line `expect(plan.guardHits.saturated).toBe(0);` with:

```ts
  expect(plan.saturated).toEqual([]);
```

3. `rows accepted earlier in the same run count toward saturation` (~line 317) —
   **convert**. All three rows now land, and the issue reports 14. Replace its two
   assertions with:

```ts
  expect(plan.comments[0].verdicts).toHaveLength(3);
  expect(plan.saturated).toEqual([{ issueNumber: 347, rows: 14 }]);
```

Rename the section header to `--- #431 saturation as a reported state ---`.

- [ ] **Step 8: Typecheck and run the whole suite**

Run: `npx tsc --noEmit && npm test`
Expected: `src/jobs/orphan-triage.ts` FAILS to compile — it reads `guardHits.saturated` in its initializer and `TriageOutcome`. That is Task 3's job. Confirm the failure is confined to that file and its test; if any other file breaks, stop and report before continuing.

- [ ] **Step 9: Commit**

```bash
git add src/domain/triage-plan.ts src/domain/triage-plan.test.ts
git commit -m "feat(#431): saturation stops refusing rows, starts reporting a state

Guard 4 refused a row for a fact about the issue, not the row: the verdict was
correct and in scope, and it was discarded for a condition that will still hold
tomorrow. Deleting it also fixes the guard ordering for free — scope is now the
only check on the hasIssue path, so nothing is refused before it has proven it
belongs."
```

---

### Task 2: The GitHub client can add and remove one label

**Files:**
- Modify: `src/infra/github-issues.ts`
- Test: `src/infra/github-issues.test.ts`

**Interfaces:**
- Consumes: the existing private `call<T>(url, init)` helper in this file.
- Produces, on `GithubIssuesClient`:
  - `addLabel(issueNumber: number, label: string): Promise<void>`
  - `removeLabel(issueNumber: number, label: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `src/infra/github-issues.test.ts`, matching the `fetchImpl` stub style already used there:

```ts
test('#431 addLabel POSTs one label and never replaces the set', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify([{ name: 'saturated' }]), { status: 200 });
  }) as unknown as typeof fetch;
  const c = createGithubIssuesClient({ token: 't', repo: 'o/r', fetchImpl });

  await c.addLabel(405, 'saturated');

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.github.com/repos/o/r/issues/405/labels');
  expect(calls[0].init.method).toBe('POST');
  // A PUT with the full set would erase human labels; assert the additive shape.
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ labels: ['saturated'] });
});

test('#431 removeLabel DELETEs the single named label, url-encoded', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof fetch;
  const c = createGithubIssuesClient({ token: 't', repo: 'o/r', fetchImpl });

  await c.removeLabel(405, 'needs triage');

  expect(calls[0].url).toBe('https://api.github.com/repos/o/r/issues/405/labels/needs%20triage');
  expect(calls[0].init.method).toBe('DELETE');
});

test('#431 a failing label call throws HttpStatusError like every other call', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
  const c = createGithubIssuesClient({ token: 't', repo: 'o/r', fetchImpl });
  await expect(c.addLabel(405, 'saturated')).rejects.toMatchObject({ status: 403 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/infra/github-issues.test.ts`
Expected: FAIL — `c.addLabel is not a function`.

- [ ] **Step 3: Extend the interface**

In `src/infra/github-issues.ts`:

```ts
export interface GithubIssuesClient {
  listOpenIssues(label: string): Promise<OpenIssue[]>;
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<number>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
  // #431: additive label mutation only. GitHub also offers PUT .../labels, which
  // REPLACES the whole set — that would silently erase labels a human applied
  // (priority/tier-2, extension-bug) every time the triage job reconciled.
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
}
```

- [ ] **Step 4: Implement both methods**

In the returned object, after `commentOnIssue`:

```ts
    async addLabel(issueNumber, label) {
      await call(`${base}/issues/${issueNumber}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: [label] }),
      });
    },
    async removeLabel(issueNumber, label) {
      // 404 when the label is already gone. The caller only removes a label it just
      // read as present, and reconciliation is per-issue try/catch, so a lost race
      // logs and self-corrects on the next run.
      await call(`${base}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      });
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/infra/github-issues.test.ts`
Expected: PASS (3 new tests).

- [ ] **Step 6: Mutation-prove the encoding test**

Temporarily change `encodeURIComponent(label)` to `label` and re-run. The `needs%20triage` test MUST fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/infra/github-issues.ts src/infra/github-issues.test.ts
git commit -m "feat(#431): additive label add/remove on the GitHub issues client

Deliberately not PUT .../labels: that replaces the whole set and would erase
labels a human applied every time the triage job reconciled."
```

---

### Task 3: The job reconciles the label and publishes the state

**Files:**
- Modify: `src/jobs/orphan-triage.ts`
- Test: `src/jobs/orphan-triage.test.ts`

**Interfaces:**
- Consumes: `SaturatedIssue`, `SATURATION_ALERT_ROWS` (unused here, but the type is), `GuardReason` from Task 1; `addLabel` / `removeLabel` from Task 2; `OpenIssue` from `../domain/triage-analysis`.
- Produces: `export const SATURATED_LABEL = 'saturated'`; `TriageOutcome.saturated: SaturatedIssue[]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/jobs/orphan-triage.test.ts`. Note the local `gh()` helper must gain the two new mocks — update the helper itself so every existing test keeps a complete client:

```ts
// in the gh() helper, alongside createIssue/commentOnIssue:
  addLabel: vi.fn().mockResolvedValue(undefined),
  removeLabel: vi.fn().mockResolvedValue(undefined),
```

Then the tests:

```ts
// --- #431 label reconciliation --------------------------------------------------
// countRowsForIssue counts enrich_failures rows whose reviewed_at is later than the
// issue's createdAt, so pushing issue 228 over the line means seeding that many
// REVIEWED rows.
//
// The names must be word-distinct. `insertBeer`/`BEER_WORDS` in this file only covers
// six, and normalization strips numeric suffixes — so `Beer 7`..`Beer 18` would all
// normalize identically and upsertBeer would collapse twelve seeds into ONE row. The
// count would then sit at 1, the threshold would never be crossed, and the test would
// be asserting nothing. Hence a separate word list, and a non-vacuity assertion at the
// end that is the real point of this helper.
const LABEL_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf',
  'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november'];

function seedReviewedRows(d: ReturnType<typeof db>, issueNumber: number, count: number) {
  expect(count).toBeLessThanOrEqual(LABEL_WORDS.length);
  for (let i = 0; i < count; i++) {
    const word = LABEL_WORDS[i];
    const name = `Beer ${word}`;
    const brewery = `Craft ${word}`;
    // Use the id upsertBeer RETURNS — never a guessed sequential id, which silently
    // aliases onto whatever the other seeds already inserted.
    const beerId = upsertBeer(d, {
      untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
      normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
    });
    recordEnrichFailure(d, {
      beer_id: beerId, brewery, name, search_url: 'u', source_url: '',
      outcome: 'not_found', candidates_count: 0, candidates_summary: '',
      at: '2026-07-04T00:00:00.000Z',
    });
    const written = setEnrichFailureReview(
      d, beerId, 'matcher_bug', 'seed', '2026-07-04T12:00:00.000Z', issueNumber,
      { absenceProved: false },
    );
    // A guarded write that silently no-ops leaves a green test asserting nothing.
    expect(written).toBe('written');
  }
  // The seed is only meaningful if it produced `count` DISTINCT rows.
  const seeded = d.prepare(
    'SELECT COUNT(*) AS c FROM enrich_failures WHERE issue_number = ?',
  ).get(issueNumber) as { c: number };
  expect(seeded.c).toBe(count);
}

test('#431: label added when an issue crosses the threshold', async () => {
  const d = db();
  seedReviewedRows(d, 228, 12);
  [1].forEach((n) => seedOrphan(d, n));
  const github = gh();
  await orphanTriage({
    db: d, log, now: inWindow, github,
    llm: llm({ verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'n', issue_number: null, new_issue_key: null }], new_issues: [] }),
  });
  expect(github.addLabel).toHaveBeenCalledWith(228, 'saturated');
  expect(github.removeLabel).not.toHaveBeenCalled();
});

test('#431: label removed when an issue drops below the threshold', async () => {
  const d = db();
  seedReviewedRows(d, 228, 2);
  [1].forEach((n) => seedOrphan(d, n));
  const github = gh({
    listOpenIssues: vi.fn().mockResolvedValue([
      { number: 228, title: 't', body: SCOPED_BODY, labels: ['saturated'], createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
  });
  await orphanTriage({
    db: d, log, now: inWindow, github,
    llm: llm({ verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'n', issue_number: null, new_issue_key: null }], new_issues: [] }),
  });
  expect(github.removeLabel).toHaveBeenCalledWith(228, 'saturated');
  expect(github.addLabel).not.toHaveBeenCalled();
});

test('#431: no label request at all when the state already matches', async () => {
  const d = db();
  seedReviewedRows(d, 228, 12);
  [1].forEach((n) => seedOrphan(d, n));
  const github = gh({
    listOpenIssues: vi.fn().mockResolvedValue([
      { number: 228, title: 't', body: SCOPED_BODY, labels: ['saturated'], createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
  });
  await orphanTriage({
    db: d, log, now: inWindow, github,
    llm: llm({ verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'n', issue_number: null, new_issue_key: null }], new_issues: [] }),
  });
  expect(github.addLabel).not.toHaveBeenCalled();
  expect(github.removeLabel).not.toHaveBeenCalled();
});

test('#431: a label failure neither aborts the run nor loses the DB write', async () => {
  const d = db();
  seedReviewedRows(d, 228, 12);
  [1].forEach((n) => seedOrphan(d, n));
  const github = gh({ addLabel: vi.fn().mockRejectedValue(new Error('403')) });
  await orphanTriage({
    db: d, log, now: inWindow, github,
    llm: llm({ verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'n', issue_number: null, new_issue_key: null }], new_issues: [] }),
  });
  // The day still closed, and beer 1's verdict still landed.
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  const row = d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = 1').get() as { review_class: string };
  expect(row.review_class).toBe('unidentifiable');
});
```

Add `setEnrichFailureReview` to the existing `../storage/enrich_failures` import in the test file (it currently imports only `recordEnrichFailure`).

Note why these tests still work: every seeded row already carries a `review_class`, so `listUntriagedFailures` never selects it and the batch is just beer 1. The seeds exist purely to move `countRowsForIssue`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: FAIL — the file does not compile yet, because `guardHits.saturated` was removed in Task 1. Fix compilation as part of Step 3-5; the four new tests must still fail on assertions afterwards, not on compilation.

- [ ] **Step 3: Update the outcome type and initializer**

In `src/jobs/orphan-triage.ts`, import `SaturatedIssue`:

```ts
import { planTriageActions, type ScopedIssue, type GuardReason, type SaturatedIssue } from '../domain/triage-plan';
```

Add the label constant beside the other exported constants near `TRIAGE_LABEL`:

```ts
// #431: applied and removed by this job. An issue wearing it has enough evidence that
// the next move is a fix, not more triage.
export const SATURATED_LABEL = 'saturated';
```

Add to `TriageOutcome`, after `guardHits`:

```ts
  // #431: standing state of every open triage issue, not a tally of this run.
  saturated: SaturatedIssue[];
```

In the initial `outcome` object (the one that currently reads `guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 }`), drop the `saturated: 0` key from `guardHits` and add a sibling `saturated: []`:

```ts
      guardHits: { illegal_scope: 0, scope_violation: 0, unprobed_absence: 0 },
      saturated: [],
```

- [ ] **Step 4: Publish the state and reconcile the label**

Beside `outcome.guardHits = plan.guardHits;` (which sits above the `covered === 0` early return, deliberately, per #432), add:

```ts
    outcome.saturated = plan.saturated;
```

Then add this function at module scope, below `reportGuardAnomalies`:

```ts
// #431: the label mirrors plan.saturated, and nothing else. Issued only on a
// difference, so a steady state costs zero requests. Best-effort by design: it runs
// after every comment and every DB write, so a GitHub failure here can no longer cost
// a verdict that was already earned — it logs and the next run reconciles.
async function reconcileSaturatedLabels(
  github: GithubIssuesClient,
  log: pino.Logger,
  openIssues: OpenIssue[],
  saturated: SaturatedIssue[],
): Promise<void> {
  const isSaturated = new Set(saturated.map((s) => s.issueNumber));
  for (const issue of openIssues) {
    const has = issue.labels.includes(SATURATED_LABEL);
    const should = isSaturated.has(issue.number);
    if (has === should) continue;
    try {
      if (should) await github.addLabel(issue.number, SATURATED_LABEL);
      else await github.removeLabel(issue.number, SATURATED_LABEL);
    } catch (e) {
      log.error({ err: e, issue: issue.number, should }, 'orphan-triage: label reconcile failed');
    }
  }
}
```

Import `OpenIssue` as a type from `../domain/triage-analysis` (that import line already exists for `Analysis` and `Verdict`).

Call it in the run body, after the `for (const v of plan.quiet)` loop and **before** `finish(outcome)`:

```ts
    await reconcileSaturatedLabels(github, log, openIssues, plan.saturated);

    finish(outcome);
```

`openIssues` is already in scope in that function — confirm the binding name by reading the surrounding code before wiring it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: PASS. Pre-existing tests that construct a full `TriageOutcome` literal will need `saturated: []` added and `saturated: 0` removed from their `guardHits`; there are three such literals around lines 240-247.

- [ ] **Step 6: Mutation-prove the failure-isolation test**

Remove the `try`/`catch` around the label calls in `reconcileSaturatedLabels` and re-run. `a label failure neither aborts the run nor loses the DB write` MUST fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(#431): reconcile the saturated label, publish the standing state

Runs after every comment and DB write, per issue, in its own try — a labelling
failure logs and self-corrects next run rather than costing an earned verdict."
```

---

### Task 4: The digest names the queue

**Files:**
- Modify: `src/jobs/orphan-triage.ts` (the `buildSaturatedLine` function and the `publish` payload)
- Modify: `src/jobs/daily-status.ts`
- Test: `src/jobs/orphan-triage.test.ts`, `src/jobs/daily-status.test.ts`

**Interfaces:**
- Consumes: `TriageOutcome.saturated` from Task 3.
- Produces: `export function buildSaturatedLine(o: TriageOutcome): string | null`; `job_state` payload shape `{ date: string; line: string; saturated: string | null }`; `buildStatusMessage(m, date, triageLine?, saturatedLine?)`.

- [ ] **Step 1: Write the failing tests**

In `src/jobs/orphan-triage.test.ts`, add `buildSaturatedLine` to the existing
`./orphan-triage` import and `type TriageOutcome` alongside it:

```ts
import {
  orphanTriage, shouldRunTriage, buildTriageLine, buildSaturatedLine, reportGuardAnomalies,
  TRIAGE_LAST_RUN_KEY, TRIAGE_LAST_RESULT_KEY, TRIAGE_ATTEMPTS_KEY, TRIAGE_MAX_ATTEMPTS,
  type TriageOutcome,
} from './orphan-triage';
```

Then append:

```ts
// --- #431 the saturated digest line ---------------------------------------------
const outcomeWith = (saturated: { issueNumber: number; rows: number }[]): TriageOutcome => ({
  total: 0, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0,
  causeStripped: 0, noTarget: 0,
  guardHits: { illegal_scope: 0, scope_violation: 0, unprobed_absence: 0 },
  saturated, skipped: 0, unverified: 0, error: null, attempt: null, disabledReason: null,
});

test('#431 line: nothing saturated → no line at all', () => {
  expect(buildSaturatedLine(outcomeWith([]))).toBeNull();
});

test('#431 line: three saturated → all three, descending', () => {
  expect(buildSaturatedLine(outcomeWith([
    { issueNumber: 405, rows: 21 }, { issueNumber: 427, rows: 15 }, { issueNumber: 334, rows: 12 },
  ]))).toBe('Насичені: #405 (21), #427 (15), #334 (12) — усього 3');
});

test('#431 line: seven saturated → top five plus the total', () => {
  const line = buildSaturatedLine(outcomeWith(
    [21, 15, 12, 11, 8, 7, 6].map((rows, i) => ({ issueNumber: 400 + i, rows })),
  ));
  expect(line).toBe('Насичені: #400 (21), #401 (15), #402 (12), #403 (11), #404 (8) — усього 7');
  expect(line).not.toContain('#405');
});
```

In `src/jobs/daily-status.test.ts`, matching the two existing `dailyStatus:` tests
(~line 185) exactly — same `emptyDb()`, `silentLog`, `now` and `notifyAdmin` shape:

```ts
test('#431: the saturated line rides beside the triage line', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z'); // 09:30 Warsaw
  setJobState(db, TRIAGE_LAST_RESULT_KEY, JSON.stringify({
    date: '2026-07-05', line: 'Тріаж: 50 нових',
    saturated: 'Насичені: #405 (21) — усього 1',
  }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).toContain('• Тріаж: 50 нових');
  expect(sent[0]).toContain('• Насичені: #405 (21) — усього 1');
});

// Forward compatibility is not theoretical here: the payload written by the run on the
// morning of the deploy has no `saturated` key, and the digest reads it that same day.
test('#431: a payload written before this change reads as no saturated line', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z');
  setJobState(db, TRIAGE_LAST_RESULT_KEY,
    JSON.stringify({ date: '2026-07-05', line: 'Тріаж: 50 нових' }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).toContain('• Тріаж: 50 нових');
  expect(sent[0]).not.toContain('Насичені');
});

test('#431: buildStatusMessage omits the bullet when the saturated line is null', () => {
  expect(buildStatusMessage(base, '2026-07-05 09:00', 'Тріаж: 1 нових', null))
    .not.toContain('Насичені');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/orphan-triage.test.ts src/jobs/daily-status.test.ts`
Expected: FAIL — `buildSaturatedLine is not defined`, and the digest contains no `Насичені`.

- [ ] **Step 3: Build the line**

In `src/jobs/orphan-triage.ts`, directly below `buildTriageLine`:

```ts
// #431: deliberately its own line rather than another comma in buildTriageLine — it
// answers a different question (what should be FIXED, not what this run DID). Ordered
// descending, so the first entry is the answer to "what next": the line is a report and
// a work queue at once.
export const SATURATED_LINE_LIMIT = 5;

export function buildSaturatedLine(o: TriageOutcome): string | null {
  if (o.saturated.length === 0) return null;
  const top = o.saturated
    .slice(0, SATURATED_LINE_LIMIT)
    .map((s) => `#${s.issueNumber} (${s.rows})`)
    .join(', ');
  return `Насичені: ${top} — усього ${o.saturated.length}`;
}
```

- [ ] **Step 4: Widen the job_state payload**

In the `publish` closure:

```ts
    const publish = (outcome: TriageOutcome): void => {
      setJobState(db, TRIAGE_LAST_RESULT_KEY, JSON.stringify({
        date: dateKey,
        line: buildTriageLine(outcome),
        saturated: buildSaturatedLine(outcome),
      }));
    };
```

- [ ] **Step 5: Render it in the digest**

In `src/jobs/daily-status.ts`, widen the builder signature and emit a second bullet:

```ts
export function buildStatusMessage(
  m: StatusMetrics, date: string,
  triageLine?: string | null, saturatedLine?: string | null,
): string {
```

and, immediately after the existing `...(triageLine ? [\`• ${triageLine}\`] : []),`:

```ts
    ...(saturatedLine ? [`• ${saturatedLine}`] : []),
```

Then read both fields out of `job_state`, tolerating a payload written before this change:

```ts
  let triageLine: string | null = null;
  let saturatedLine: string | null = null;
  const rawTriage = getJobState(db, TRIAGE_LAST_RESULT_KEY);
  if (rawTriage) {
    try {
      const parsed = JSON.parse(rawTriage) as { date: string; line: string; saturated?: string | null };
      if (parsed.date === dateKey) {
        triageLine = parsed.line;
        // `?? null`: a payload written before #431 has no such key.
        saturatedLine = parsed.saturated ?? null;
      }
    } catch { /* malformed state — ignore */ }
  }
  const text = buildStatusMessage(metrics, warsawStamp(now), triageLine, saturatedLine);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts src/jobs/daily-status.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation-prove the top-five cap**

Change `.slice(0, SATURATED_LINE_LIMIT)` to `.slice(0, 6)` and re-run. `top five plus the total` MUST fail on the `#405` assertion. Restore.

- [ ] **Step 8: Full suite and typecheck**

Run: `npx tsc --noEmit && npm test`
Expected: all green. This is the first point in the plan where that is true.

- [ ] **Step 9: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/daily-status.ts src/jobs/orphan-triage.test.ts src/jobs/daily-status.test.ts
git commit -m "feat(#431): the digest names the saturated queue

Its own line, not another comma in the triage line: it answers what should be
fixed, not what the run did. Descending, so entry one is the next thing to fix."
```

---

### Task 5: The runbook

**Files:**
- Create: `docs/orphan-triage-issues-runbook.md`
- Modify: `docs/debug-orphan-matching.md` (add a cross-link near the top)

**Interfaces:**
- Consumes: `SATURATED_LABEL` and the digest line from Tasks 3-4 (named in prose, not imported).
- Produces: nothing code depends on.

- [ ] **Step 1: Write the runbook**

Create `docs/orphan-triage-issues-runbook.md` in Ukrainian, matching the register of `docs/debug-orphan-matching.md` (read its first 40 lines first). It must contain these five sections, with the SQL exactly as given:

**1. Що це і чим відрізняється від `debug-orphan-matching.md`** — that runbook goes from one beer's symptom to a root cause; this one operates the queue of issues.

**2. Знайти роботу.** Three entry points, cheapest first:
- the `Насичені:` line in the daily digest — top five, first entry is the next candidate;
- GitHub: `is:open label:orphan-triage label:saturated`;
- SQL, with the warning that it counts differently from the label:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' "
  SELECT issue_number, COUNT(*) AS rows_lifetime
    FROM enrich_failures
   WHERE issue_number IS NOT NULL
   GROUP BY issue_number
   ORDER BY rows_lifetime DESC;"
```

> `COUNT(*)` тут — лічильник **за весь час**, а мітка `saturated` відображає `postCreationRows`, тобто рядки, дописані **після** створення issue. Для issue, народжених із перелічених рядків (як #405, що з'явився з 15), числа законно розходяться. Мітка не помиляється — вони міряють різне.

And the inverse check, because the table advertises work that shipped fixes already killed:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT COUNT(*) FROM enrich_failures WHERE issue_number = <N>;"
```

> `0` означає, що дефект більше не має живих рядків — issue закривається як зроблений, без коду.

**3. Перед фіксом — реплей.** Project policy: reproduce the issue's own examples against live Untappd before writing code. #340, #303 and #350 were each refuted this way, and one of them would have made matching worse. State that a spike like this leaves no committed code and needs no spec.

**4. Декомпозиція — перемапити рядки в тому ж кроці.** Write out the rule with its reasoning:

```bash
sudo -u warsaw-beer-bot bash -lc \
  "sqlite3 /var/lib/warsaw-beer-bot/bot.db \
   \"UPDATE enrich_failures SET issue_number = <під-issue> WHERE beer_id IN (34852, 34901)\""
```

Verify with a fresh read-only read:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT beer_id, issue_number, review_class FROM enrich_failures WHERE beer_id IN (34852, 34901);"
```

Four rules, each with its why:
- only rows you can name, listed by `beer_id`;
- **never** `WHERE issue_number = <батько>` onto one child — a row you cannot assign stays on the parent, because a wrong link is worse than a missing one: it will unlock on someone else's fix;
- `review_class` is not touched — the class says what kind of defect it is, the issue number says who fixes it; changing both at once destroys the evidence for the verdict;
- read back with `?mode=ro`, never `immutable=1`, which reads only the main db file and cannot see the WAL, so it will show a stale snapshot of the write you just made.

**5. Закриття issue.** What fires by itself:
- **такт 1** — `unlock-fixed-orphans` sees the issue leave the open set, stamps `unlocked_at`, resets the backoff counter;
- **такт 2** — the next failed retry clears `review_class`/`review_note`/`reviewed_at`/`unlocked_at` and returns the row to the triage queue, **keeping `issue_number`** as the record that this fix was tried and did not cover the row.

Snapshot the cohort **before** closing, because a matched row deletes itself from `enrich_failures` (#127) and cannot be counted afterwards:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT beer_id FROM enrich_failures WHERE issue_number = <N>;" > ./tmp/cohort-<N>.txt
```

Then after the unlock run:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT COUNT(*) FROM enrich_failures WHERE issue_number = <N> AND unlocked_at IS NOT NULL;"
```

> «Розімкнуто» саме по собі **нічого не доводить**. Перший такий прогін (2026-08-16) розімкнув 152 рядки, з яких 91 були поза будь-яким досяжним пулом — тобто крон до них просто не доходить. Рахуй те, що зматчилось за тиждень: рядки з когорти, яких більше немає в `enrich_failures`.

**6. Мітка `saturated`.** Machine-managed by the triage job: it is added when post-creation rows reach 12 and removed when they drop below. Setting it by hand is pointless — the next run reconciles it. A **closed** issue keeps the label forever, because the job lists open issues only; every query in this runbook filters `is:open`, so it does not matter.

- [ ] **Step 2: Cross-link from the existing runbook**

In `docs/debug-orphan-matching.md`, inside the existing blockquote about automatic triage (around line 6-11), append one sentence:

```markdown
> Робота з самою **чергою** `orphan-triage` issues — знайти наступний, перемапити
> рядки при декомпозиції, перевірити наслідки закриття — у
> [`orphan-triage-issues-runbook.md`](./orphan-triage-issues-runbook.md).
```

- [ ] **Step 3: Verify every command in the runbook actually runs**

This is not optional and not a review step — run each read-only command against prod and paste nothing that errors:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' "SELECT issue_number, COUNT(*) AS rows_lifetime FROM enrich_failures WHERE issue_number IS NOT NULL GROUP BY issue_number ORDER BY rows_lifetime DESC LIMIT 5;"
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' "SELECT COUNT(*) FROM enrich_failures WHERE issue_number = 405;"
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' "SELECT COUNT(*) FROM enrich_failures WHERE issue_number = 405 AND unlocked_at IS NOT NULL;"
```

Do **not** run the `UPDATE`. Confirm its syntax by reading `CLAUDE.md`, which carries the same command shape.

- [ ] **Step 4: Commit**

```bash
git add docs/orphan-triage-issues-runbook.md docs/debug-orphan-matching.md
git commit -m "docs(#431): runbook for operating the orphan-triage issue queue"
```

---

### Task 6: `spec.md`

**Files:**
- Modify: `spec.md` (§5.11 around lines 1805-1840; the `issue_number` row around line 391; the `dailyStatus` inventory around line 1276)

**Interfaces:** none.

- [ ] **Step 1: Rewrite the guard list in §5.11**

Change **«Чотири детерміновані гейти вердикту»** to **«Три детерміновані гейти вердикту»**. Delete item 4 (`**Насичення:** issue, що набрала MAX_ROWS_PER_ISSUE (12) рядків...`) and replace it with a paragraph placed after the numbered list:

```markdown
- **Насичення — стан, не гейт (#431).** Issue, що набрала `SATURATION_ALERT_ROWS` (12)
  рядків **після свого створення**, отримує мітку `saturated` і потрапляє в стрічку
  «Насичені» денного дайджесту. Вона **не перестає приймати рядки**: гейт, який робив
  саме це, відхиляв правильний, у-scope вердикт за фактом про issue, а не про рядок, і
  рядок повертався назавтра з тим самим вердиктом — 23 із 50 на прогоні 2026-08-19.
  Рахуються саме післястворені рядки: #405 народилася з 15 перелічених, тож підрахунок
  за весь час відкидав би саме ту вузьку форму, заради якої все й робиться.
  Мітка звіряється щопрогону (додати/зняти, ніколи не `PUT` усього набору) **після** всіх
  коментарів і записів у БД, по одному issue в своєму `try`.
```

In the paragraph above the list, delete `` і `saturated` (це стан issue, а не подія, #431) `` from the sentence about which guards do not raise the `guard anomaly` warn — the counter no longer exists. Keep the `unprobed_absence` clause.

- [ ] **Step 2: Fix the `issue_number` column description**

Line ~391 reads `Читає гейт насичення (#408) через countRowsForIssue(db, issue, sinceIso)`. Replace with:

```markdown
Читає звіт про насичення (#431) через `countRowsForIssue(db, issue, sinceIso)`, який рахує рядки, дописані **після** створення issue
```

- [ ] **Step 3: Add the digest line to the `dailyStatus` inventory**

In the `dailyStatus` row of the cron table (~line 1276), after the sentence describing the triage line, add:

```markdown
Одразу під рядком тріажу — рядок **«Насичені»** (#431): `#<issue> (<рядків>)` для issue, що набрали ≥ `SATURATION_ALERT_ROWS` рядків після створення, за спаданням, топ-5 плюс «усього N». Рядок відсутній, коли насичених немає. Це водночас звіт і черга робіт: перший у списку — наступний кандидат на фікс.
```

- [ ] **Step 4: Check nothing else in spec.md still describes the gate**

Run: `grep -n "MAX_ROWS_PER_ISSUE\|насичен\|saturat" spec.md`
Expected: every remaining hit describes a state or a label, none describes a refusal. Fix any that do.

- [ ] **Step 5: Commit**

```bash
git add spec.md
git commit -m "docs(#431): spec — saturation is a labelled state, not a fourth gate"
```

---

## Final verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` fully green
- [ ] `grep -rn "MAX_ROWS_PER_ISSUE" src/ spec.md` returns nothing
- [ ] `grep -rn "guardHits.saturated\|'saturated'" src/domain/` returns nothing (the string literal now lives only in `src/jobs/orphan-triage.ts` as `SATURATED_LABEL`)
- [ ] Open the PR and wait for the AI review; verify each comment against the code and push back on the wrong ones. Green tests are not "done".
- [ ] Do **not** merge and do **not** deploy — the user does both.
