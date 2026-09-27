# /report — core plan (stage 1 of 2)

Spec: `docs/superpowers/specs/2026-09/2026-09-26-bug-report-design.md`
Contracts: `src/domain/bug-report-types.ts` (committed with this plan; do not change it without
telling the controller — a contract change is a plan change).
Branch: `feat/bug-report`. Each task is implemented on its own branch cut from `feat/bug-report`
(`feat/bug-report-t<N>`) and merged back by the controller after review.

**Who does what.** Tasks 1–4 are implemented by Codex from the briefs in `./tmp/codex-t<N>.md`.
The controller (Claude) reviews each task diff against this plan and the spec, mutation-checks the
guards named in "Mutation checks", runs the full gate, and merges. After Task 4: an end-to-end review
of the core, then a separate periphery plan (dialog, middleware, media download, `/reportban`,
digest, env registry, `spec.md`, `/help`).

**Rules for every task** (from `CLAUDE.md`, binding):

- Vitest. No weak asserts (`toBeTruthy`, `toBeDefined`, `toBeGreaterThanOrEqual` where an exact
  value is known). No `if`/early `return` in tests; one deterministic path per test. No tautological
  tests (`expect(f(a)).toBe(f(b))`), no asserting on a mock's own state instead of the code's
  output. Boundaries, empty inputs and errors are covered, not only the happy path. Expected values
  are literals, never recomputed by re-implementing the production logic in the test.
- Stubs return **visible, distinct values** (never `null`/`[]` defaults that would make "ignored"
  and "used" indistinguishable).
- Functional style, one module per concern, match the surrounding code's comment density and idiom.
- Full gate after the task: `npm test && npm run typecheck` — the whole suite, not a scoped run.
- **The code beats this plan.** If an existing signature, file or behaviour contradicts what the plan
  says, stop and report the contradiction instead of working around it.
- Do not edit files outside the task's list. Do not touch `spec.md` (the periphery stage does).

---

## Task 1 — pure domain

Files (new unless noted), each with a sibling `*.test.ts`:

- `src/domain/bug-report-categories.ts`
- `src/domain/bug-report-redact.ts`
- `src/domain/bug-report-template.ts`
- `src/domain/bug-report-verdict.ts`
- `src/domain/warsaw-time.ts` (modify: add one export) + `warsaw-time.test.ts` (add cases)

### 1a. Categories

`export const CATEGORIES: readonly CategoryDef[]` — exactly the spec table, in its order:

| key | sources | hintLabel |
|---|---|---|
| wrong_beer | bot, extension | matcher-bug |
| no_rating | bot, extension | matcher-bug |
| had_status | bot, extension | bug |
| stale_data | bot, extension | parser-bug |
| route | bot | bug |
| no_badge | extension | extension-bug |
| ext_broken | extension | extension-bug |
| bot_broken | bot | bug |
| text_ui | bot, extension | bug |
| other | bot, extension | bug |

`export function categoriesFor(source: ReportSource): CategoryDef[]` — table order preserved.

Tests: the exact key list for `bot` (8 keys) and for `extension` (8 keys), in order; `hintLabel`
of `other` is `bug`; every key of `REPORT_CATEGORIES` appears in `CATEGORIES` exactly once.

### 1b. Redaction

`export function redact(text: string): string` replaces each match with `[приховано]`:

1. Untappd profile URLs: `untappd.com/user/<name>` with or without scheme and `www.`, including any
   trailing path.
2. Emails.
3. Handles: `@` followed by 3+ of `[A-Za-z0-9_]`, not preceded by a word character (so the `@` of an
   email is handled by rule 2, which runs first).
4. Phone numbers: an optional `+`, then digits with optional single separators from
   `space - ( ) .` between them, **9 to 15 digits in total**, **except** strings that are an ISO date
   `YYYY-MM-DD` optionally followed by a time. Rules 1–3 run before 4.

`export function redactFields(f: TemplateFields): TemplateFields` applies `redact` to every string
and every array item.

Tests — redacted (exact output asserted):
`+48 123 456 789`, `123-456-789`, `(22) 123 45 67`, `+380501234567`, `ivan.k@gmail.com`,
`@ivan_hops_1987`, `https://untappd.com/user/ivan_hops`, `untappd.com/user/ivan/beers`,
`www.untappd.com/user/x_y`.

Tests — unchanged (asserted equal to input): `ABV 6.5%`, `рейтинг 4.12`, `2026`, `bid 6172824`,
`Przekład #9 16°`, `0.33л`, `Kronenbourg 1664`, `95 ₴`, `2026-09-26`, `2026-09-26 12:30`,
`a @ b`, `@ab` (2 chars), `https://untappd.com/b/volta-anima/123456` (a beer, not a user),
`12345678` (8 digits).

A mixed sentence containing a handle, an email and a beer name → only the two personal parts
replaced.

### 1c. Template

Limits (characters, counted with `[...s].length`): title 100, summary 300, where 200, subjects
5 items × 100, expected 200, actual 200, steps 5 × 150, screenEvidence 5 × 150, newEvidence 300.

`export function clampFields(f: TemplateFields): TemplateFields`:

- every string is trimmed; internal newlines in single-line fields (`title`, `where`, `expected`,
  `actual`, each array item) become one space; `summary` and `newEvidence` keep newlines;
- a string longer than its limit becomes its first `limit - 1` characters + `…` (so the result is
  exactly `limit` long);
- arrays: items trimmed, empty items dropped, then only the first 5 kept, each clamped;
- `<` and `>` in any field become `&lt;` / `&gt;` (the body is GitHub-rendered markdown; this
  keeps an LLM field from injecting HTML or forging the `<!-- bug-report:… -->` marker).

`export function renderIssueBody(f: TemplateFields, ctx: ReportContext): string` and
`export function renderDuplicateComment(f: TemplateFields, ctx: ReportContext): string` — the exact
layout in the spec's "Шаблон issue" section. Inputs are assumed already clamped and redacted (the
validator does it). Details:

- empty string → `—`; `subjects` joined with `, ` (empty array → `—`);
- `## Кроки` section: numbered `1.`…; omitted entirely (heading included) when `steps` is empty;
  `## Видно на скріншотах` likewise for `screenEvidence`;
- context table columns: `Джерело` (`Бот` | `Розширення`), `Категорія` (the Ukrainian label from the
  spec table), `Версія розширення`, `Місто` (`—` when null), `Мова` (`ctx.locale`);
- `Версія розширення`: source `bot` → `—`; source `extension` → `невідома (остання опублікована:
  X)` or `невідома` when `latestExtensionVersion` is null;
- media line: `медіа: немає` when stored + failed = 0; `медіа: N файл(и), лише на сервері:
  \`bug-reports/{id}/\`` when stored > 0; append `, не збережено: M` when failed > 0; `медіа: не
  збережено (M)` when stored = 0 and failed > 0;
- line `Severity і effort — оцінка агента.` only in the issue body, not in the comment;
- the comment has no title and starts with `**Нове в цій скарзі:** {newEvidence}` (`—` when empty);
- both end with `<!-- bug-report:{id} -->`.

The Ukrainian category labels live in `bug-report-template.ts` (one map keyed by `ReportCategory`);
the bot's i18n is a periphery concern and does not feed the GitHub body.

Tests: full exact-string snapshot-free assertions (`toBe` on the whole rendered string) for
(a) bot source, all fields filled, 2 steps, 1 screen line, no media;
(b) extension source, version known, empty steps and screenEvidence (both sections absent),
stored 2 failed 0; (c) extension, version null, stored 0 failed 1; (d) the duplicate comment with
empty `newEvidence`. `clampFields`: a 100-char title unchanged, 101-char title → 100 chars ending in
`…`; 6 subjects → 5; `['', '  ', 'x']` → `['x']`; `a\nb` in `where` → `a b`, in `summary` kept;
`<!-- x -->` escaped; an emoji-containing string counted by code points, not UTF-16 units.

### 1d. Verdict validation

`export function validateVerdict(raw: RawVerdict, candidates: IssueDetail[], source: ReportSource): ValidationResult`

Order of checks (first failure wins, `reason` is a short English sentence naming the rule):

1. `raw.verdict` is one of `VERDICTS` (runtime check — the value came from JSON).
2. `issueNumber !== null` ⟺ verdict is `duplicate_open` or `duplicate_closed`.
3. For duplicates: `issueNumber` is one of `candidates[].number`.
4. `duplicate_open` requires that candidate's `state === 'open'`; `duplicate_closed` requires
   `'closed'` (GitHub's state, not the model's claim).
5. For `new`: `severity` ∈ `SEVERITIES`, `effort` ∈ `EFFORTS`, and the title is non-empty after
   `clampFields`.

On success, fields are `redactFields(clampFields(raw))` (template fields only). For `new`, `labels`
is: the raw labels filtered to `AREA_LABELS` and de-duplicated; plus `extension-bug` when `source ===
'extension'`; plus `bug` when none of the four remain; ordered as in `AREA_LABELS`; then
`USER_REPORT_LABEL` last. Unknown raw labels are dropped silently, never a failure.

Tests: one failing case per rule 1–5 (assert `ok: false` and the exact `reason`); success for each
verdict kind; labels: `['matcher-bug','wontfix']` bot → `['matcher-bug','user-report']`;
`[]` bot → `['bug','user-report']`; `[]` extension → `['extension-bug','user-report']`;
`['extension-bug','bug','bug']` extension → `['bug','extension-bug','user-report']`; a duplicate's
returned `issue` is the candidate object from the input; a phone number in `summary` comes back
redacted.

### 1e. Warsaw day start

`export function warsawDayStartUtc(now: Date): string` — the UTC ISO string (`toISOString()`) of
00:00 Europe/Warsaw on the Warsaw calendar date of `now`.

Tests (literal expectations): `2026-09-26T21:59:59.000Z` → `2026-09-25T22:00:00.000Z`;
`2026-09-26T22:00:00.000Z` → `2026-09-26T22:00:00.000Z`; `2026-01-15T10:00:00.000Z` →
`2026-01-14T23:00:00.000Z`; DST start day `2026-03-29T12:00:00.000Z` → `2026-03-28T23:00:00.000Z`;
DST end day `2026-10-25T12:00:00.000Z` → `2026-10-24T22:00:00.000Z`.

**Mutation checks (controller):** drop rule 3 or 4 of the validator; drop the ISO-date exception;
drop `<` escaping; each must fail a named test.

---

## Task 2 — migration v38 + storage

Files: `src/storage/schema.ts` (append migration 38), `src/storage/schema.test.ts`, new
`src/storage/bug_reports.ts` + `bug_reports.test.ts`.

Changes to `schema.test.ts` (amended 2026-09-27 after Codex stopped on a contradiction — the plan had
assumed the head was pinned in one test only):

1. Bump the single schema-head test (commented "The ONLY assertion on the schema head") to 38.
2. Fix the v37 test `upgrades an already-recorded v36 database with a distinct observation
   generation` (#711), which breaks the CLAUDE.md rule twice: it pins the head
   (`MAX(version) = 37`) and rewinds with `DELETE … WHERE version = 37`. With v38 present,
   `migrate()` compares against `MAX(version) = 38` and would skip v37, so the test would pass
   while asserting nothing. Replace the head assertion with the test's own fact — `SELECT version
   FROM schema_version WHERE version = 37` equals `{ version: 37 }` — and rewind with
   `WHERE version >= 37`, like the v22/v23 tests do. After the second `migrate()`, assert that
   the v37 columns (`real_failure_count`, `rescued_real_failure_count`) exist again. This proves
   the test re-applies v37. The current version never checks that.
3. Add a v38 test that asserts `WHERE version = 38` is recorded and the four tables' columns.

A second head pin (`scripts/dispose-legacy-orphan.test.ts`, `schemaVersion: 37`) was removed on
`feat/bug-report` by the controller (commit after `d94155e`); merge `feat/bug-report` into the task
branch before running the gate.

Every rewind test (`DELETE … WHERE version >= N`) re-runs v38. That is why v38 uses
`IF NOT EXISTS` for every table and index, as v29/v32/v34/v35 do.

### Migration 38

```sql
CREATE TABLE IF NOT EXISTS bug_report_drafts (
  telegram_id INTEGER PRIMARY KEY,
  step        TEXT NOT NULL,
  source      TEXT,
  category    TEXT,
  text        TEXT,
  media_json  TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bug_reports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id           INTEGER NOT NULL,
  chat_id               INTEGER NOT NULL,
  status_message_id     INTEGER,
  locale                TEXT NOT NULL,
  city                  TEXT,
  source                TEXT NOT NULL CHECK (source IN ('bot','extension')),
  category              TEXT NOT NULL CHECK (category IN ('wrong_beer','no_rating','had_status','stale_data','route','no_badge','ext_broken','bot_broken','text_ui','other')),
  text                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','publishing','done','failed','needs_review')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  candidates_truncated  INTEGER NOT NULL DEFAULT 0,
  deferred_notified     INTEGER NOT NULL DEFAULT 0,
  verdict               TEXT CHECK (verdict IS NULL OR verdict IN ('new','duplicate_open','duplicate_closed','not_a_bug')),
  issue_number          INTEGER,
  created_at            TEXT NOT NULL,
  processed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_user_created ON bug_reports(telegram_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_bug_reports_processed ON bug_reports(processed_at);
CREATE TABLE IF NOT EXISTS bug_report_media (
  report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('photo','video')),
  path      TEXT NOT NULL,
  bytes     INTEGER NOT NULL,
  pruned_at TEXT,
  PRIMARY KEY (report_id, idx)
);
CREATE TABLE IF NOT EXISTS bug_report_bans (
  telegram_id INTEGER PRIMARY KEY,
  banned_at   TEXT NOT NULL
);
```

### `storage/bug_reports.ts`

Named exports implementing every method of `BugReportStore`, plus
`export const bugReportStore: BugReportStore` bundling them. Row mapping: snake_case → the
`BugReportRow` fields; `candidates_truncated`/`deferred_notified` → booleans.

Status transitions are **guarded in SQL** (`UPDATE … WHERE id = ? AND status IN (…)`), and a guarded
update that changes 0 rows **throws** `Error('bug_report <id>: illegal transition <from?> → <to>')`.
This is load-bearing for idempotency: a second `markPublishing` must not silently succeed.

| method | allowed from | sets |
|---|---|---|
| `markPublishing` | `queued` | status |
| `markDone` | `queued`, `publishing` | status, verdict, issue_number, processed_at |
| `markFailed` | `queued` | status, last_error, processed_at |
| `markNeedsReview` | `publishing` | status, processed_at |

`recordAttemptError` increments `attempts`, sets `last_error`, returns the new count (only for
`queued` rows; otherwise throws as above). `countSubmittedSince` counts all statuses by
`created_at >= since` for one user. `countProcessedSince` counts `processed_at >= since`.
`summarizeSince(since)`: `processed` = rows with `processed_at >= since`; `byVerdict` counts `done`
rows processed since, all four keys present (0 when none); `queued` = all rows currently `queued`
(any age); `needsReview`/`failed` = ids of rows in that status processed since, ascending;
`closedLinks` = `done` + `duplicate_closed` processed since, ascending by report id.
`listPrunableMedia(before)`: media rows with `bytes > 0`, `pruned_at IS NULL`, whose report's
`created_at < before`.

Tests: insert/get round trip with every field; each allowed transition; **each disallowed
transition throws** (e.g. `markPublishing` twice; `markDone` on `failed`; `markNeedsReview` on
`queued`); `recordAttemptError` returns 1 then 2; `countSubmittedSince` at the boundary
(`created_at` equal to `since` counts, one ms earlier does not) and per-user isolation;
`summarizeSince` on a seeded mix with every verdict and status, asserted with `toEqual` on the whole
object; `listPrunableMedia` excludes `bytes = 0`, already pruned, and reports created exactly at
`before`; `ON DELETE CASCADE` removes media.

**Mutation checks (controller):** remove the status guard from `markPublishing`; make
`countSubmittedSince` use `>`; each must fail a named test.

---

## Task 3 — infra clients

Files: new `src/infra/openrouter-decisions.ts`, new `src/infra/bug-report-llm.ts`, modify
`src/infra/github-issues.ts`; tests beside each. All HTTP goes through an injectable `fetchImpl`;
non-2xx → `HttpStatusError(message, status)` from `src/domain/transient-error.ts`, the same way
`github-issues.ts` does it. No retries inside the clients — the worker owns retry policy.

### 3a. `createJevSelector(cfg: { apiKey: string; model: string; fetchImpl?: typeof fetch; maxTokens?: number }): IssueSelector`

- `export function candidateCriteria(c: IssueCandidate[]): Record<string, string>` — key `i<N>`,
  value `#N [state] <labels without Severity-* and effort/*, comma-joined> — <title>`; plus
  `none: 'None of the listed issues describes this same problem.'`.
- `export function fitCandidates(c: IssueCandidate[], maxTokens: number): { kept: IssueCandidate[]; truncated: boolean }`
  — estimate = total characters of all criteria keys + values / 2.5. While over `maxTokens`, drop
  the closed candidate with the oldest `closedAt`; when no closed ones remain, the open one with the
  oldest `createdAt`. Default `maxTokens` 28 000.
- Request: `POST https://openrouter.ai/api/alpha/decisions`, `Authorization: Bearer`, body
  `{ model, state: { source, category, report: text }, questions: { duplicate_of: { type: 'choice',
  instructions: 'Which existing GitHub issue describes the same defect as the user report? Titles
  are developer-facing and may use technical terms for the symptom the user describes.', criteria } } }`.
- Response: `answers.duplicate_of.probabilities` sorted by probability desc (ties: key ascending),
  first 5 keys, `none` and keys not in `criteria` removed, `i<N>` → `N`. Missing
  `answers.duplicate_of.probabilities` → throw `Error` (not `HttpStatusError`: it is not transient).

Tests: criteria strings for an open and a closed candidate with Severity/effort labels stripped;
`fitCandidates` drops exactly the oldest closed first, then oldest open, and reports `truncated`
(and `false` when nothing dropped); top-5 with `none` in 3rd place → 4 numbers; tie ordering;
unknown key ignored; request body asserted with `toEqual` on the parsed JSON; 429 → `HttpStatusError`
with status 429; malformed body → `Error`.

### 3b. `createOpenAiJudge(cfg: { apiKey: string; model: string; endpoint?: string; fetchImpl?: typeof fetch; maxCompletionTokens?: number }): VerdictJudge`

- `POST {endpoint ?? 'https://api.openai.com/v1'}/chat/completions` with `model`,
  `max_completion_tokens` (default 8 000), `response_format: { type: 'json_schema', json_schema:
  { name: 'bug_report_verdict', strict: true, schema } }`. **No** `temperature`, **no**
  `max_tokens` (both rejected on gpt-5.x — see `scripts/ai-review/openai.ts`).
- `export const VERDICT_SCHEMA` — snake_case, `additionalProperties: false`, every property
  required: `verdict` (enum `VERDICTS`), `issue_number` (`integer | null`), `title`, `summary`,
  `where`, `subjects` (string array), `expected`, `actual`, `steps` (string array),
  `screen_evidence` (string array), `new_evidence`, `labels` (array of enum `AREA_LABELS`),
  `severity` (enum), `effort` (enum). Descriptions carry the length limits from Task 1c.
- Messages: `system` = `VERDICT_SYSTEM_PROMPT` (below, verbatim); `user` = content array: one text
  part `renderJudgeInput(input)` then one `{ type: 'image_url', image_url: { url:
  'data:<mime>;base64,<b64>' } }` per image.
- `export function renderJudgeInput(i: JudgeInput): string`:

  ```
  USER REPORT
  source: <bot|extension>
  category: <key>
  latest published extension version: <X | unknown>     (line present only for source extension)
  text: <text>

  CANDIDATE ISSUES
  ### #<n> [<state><, closed YYYY-MM-DD, reason <stateReason> when closed>] <title>
  Labels: <comma list>

  <body, first 6000 chars>

  --- comment <YYYY-MM-DD>:
  <body, first 1500 chars>
  ```
  With zero candidates the section reads `CANDIDATE ISSUES\n(none)`.
- Parse `choices[0].message.content` as JSON, map snake → camel into `RawVerdict`. Any of: HTTP
  2xx without `choices[0].message.content`, `finish_reason === 'length'`, invalid JSON, a missing
  required key → throw `InvalidVerdictOutputError` with a short reason. Non-2xx → `HttpStatusError`.

`VERDICT_SYSTEM_PROMPT` (use verbatim):

```
You process one user bug report for the Warsaw Beer Telegram bot and its browser extension.

Decide exactly one verdict:
- duplicate_open / duplicate_closed: the report describes the same defect (same symptom in the same
  place) as one of the CANDIDATE ISSUES. issue_number must be that candidate. Use the candidate's
  real state: duplicate_open for open, duplicate_closed for closed.
- new: a real defect that none of the candidates describes. issue_number null.
- not_a_bug: a question, a recommendation request, a feature wish, spam or abuse. issue_number null.
Judge by the full bodies, not by titles alone: titles often name the internal mechanism, the body
names the symptom.

Fill every text field in Ukrainian. Keep beer, brewery, pub and shop names, and text shown by our
product on screen, exactly as written.
Hard rules:
- Never include personal data: names, nicknames, Untappd usernames, e-mails, phone numbers, ids.
- Never quote the user's own words verbatim; describe them.
- Record the symptom only. Never guess the cause or the mechanism, not even in new_evidence.
- Leave a field empty ("" or []) when the report gives no data for it. Never invent steps.
- screen_evidence: only what the screenshots show that is relevant to the defect.
- new_evidence (duplicates only): what this report adds to the existing issue — another shop,
  another beer, "still reproduces". Empty for new and not_a_bug.

labels: the defect area — extension-bug (seen in the browser extension), matcher-bug (wrong beer or
missing rating although the beer exists on Untappd), parser-bug (wrong or non-beer data taken from a
pub or shop page), bug (anything else in the bot).
severity (1 = worst), judged only against a correct answer to the user and money:
- Severity-1: the main scenario is broken for everyone (no replies, empty or massively wrong
  recommendations).
- Severity-2: a WRONG answer for a class of beers or users (someone else's rating, "had" when not
  had, a tap linked to the wrong beer).
- Severity-3: a MISSING answer (beer without a rating, stale data, a failure with a workaround).
- Severity-4: cosmetics, wording, convenience.
effort: S = likely a small local fix, M = needs design, L = cause unclear. This is an estimate.
For not_a_bug, set severity Severity-4 and effort effort/S; they are ignored.
```

Tests: request body asserted with `toEqual` (model, `max_completion_tokens`, strict schema,
message shapes, one image part per image, no `temperature`/`max_tokens` keys); `renderJudgeInput`
exact string for (a) bot, no candidates; (b) extension with version null → `unknown`, one closed
candidate with 2 comments, body over 6 000 chars truncated; snake→camel mapping of a full valid
response; each `InvalidVerdictOutputError` trigger; 500 → `HttpStatusError` 500.

**Live probe (controller, not Codex):** before merging Task 3, the controller runs the implemented
judge once against the real OpenAI API with a screenshot (throwaway script under `./tmp`). It is the
first direct call carrying `image_url` with our key.

### 3c. `github-issues.ts` additions

Implement `listIssuesByLabels(labels)` and `getIssueWithComments(n, lastComments)`, matching
`BugReportGithub`. **Do not add them to the `GithubIssuesClient` interface** (amended 2026-09-27: typed
`GithubIssuesClient` stubs in `orphan-triage.test.ts`, `unlock-fixed-orphans.test.ts` and others
would stop compiling). Leave that interface unchanged. Change the return type of
`createGithubIssuesClient` to `GithubIssuesClient & BugReportGithub` (import the type from
`../domain/bug-report-types`). The orphan-triage consumers keep their narrower type; the worker
depends only on `BugReportGithub`.

- `listIssuesByLabels`: GitHub's `labels=` filter is **AND** for a comma list, so query **each
  label separately** with `state=all&per_page=100`, follow pagination until a page returns fewer
  than 100 items, drop items that have `pull_request`, union by number (order: number descending).
- `getIssueWithComments`: `GET /issues/{n}` (gives `comments` count, `state_reason`, `closed_at`);
  then fetch only the page(s) of `/issues/{n}/comments?per_page=100&page=…` that contain the last
  `lastComments` comments; return them oldest first. Zero comments → no comments request.

Tests: two labels with an overlapping issue → one entry; a PR item dropped; a 100-item page followed
by a 3-item page → both fetched (assert the requested URLs); 101 comments with `lastComments = 3` →
comments 99–101 from pages 1 and 2 (assert the URLs and the returned bodies); 0 comments → exactly
one request; `state_reason` and `closed_at` mapped.

**Mutation checks (controller):** send all labels in one `labels=` query; drop the PR filter;
`fitCandidates` dropping the newest closed; each must fail a named test.

---

## Task 4 — worker

File: new `src/jobs/bug-report-worker.ts` + `bug-report-worker.test.ts`.
`export function createBugReportWorker(deps: BugReportWorkerDeps): BugReportWorker`.
Uses Task 1–3 modules only through `deps` and the pure functions of Task 1.

### Algorithm of `runOnce()`

0. If a run is in flight, return immediately (module-local flag inside the closure; set before the
   first `await`, cleared in `finally`).
1. **Crash recovery.** Every row in `publishing` → `markNeedsReview(now)` → `notify(row,
   { kind: 'needs_review' })`. No GitHub call of any kind for these rows.
2. For each `queued` row, oldest first:
   1. **Cap.** If `countProcessedSince(warsawDayStartUtc(now)) >= dailyCap`: for every remaining
      queued row with `deferredNotified = false`, `notify(deferred)` then `markDeferredNotified`;
      stop the run.
   2. **Candidates.** `github.listIssuesByLabels(AREA_LABELS)`, cached in the worker closure for
      `candidateCacheTtlMs` (clock = `deps.now()`).
   3. **Select.** `selector.select({ source, category, text }, candidates)`; if `truncated`,
      `setCandidatesTruncated`.
   4. **Details.** `github.getIssueWithComments(n, 3)` for each selected number, sequentially, in
      selector order.
   5. **Images.** Media rows of kind `photo`, `bytes > 0`, `prunedAt === null`, idx order →
      `readFile(path)` → base64; mime by extension (`.jpg`/`.jpeg` → `image/jpeg`, `.png`,
      `.webp`; other extensions skipped). A read error skips that image with `log.warn`.
   6. **Judge + validate.** `judge(...)` then `validateVerdict(raw, details, source)`. An
      `InvalidVerdictOutputError` or `ok: false` → call `judge` **once more** with the same input;
      a second invalid result → `markFailed({ error: reason, processedAt })` + `notify(failed)`;
      next row.
   7. **Publish.**
      - `not_a_bug` → `markDone({ verdict, issueNumber: null })` → `notify(not_a_bug)`.
      - `new` → `markPublishing` → `createIssue({ title: fields.title, body: renderIssueBody(fields,
        ctx), labels: [...labels, severity, effort] })` → `markDone({ verdict: 'new', issueNumber })`
        → drop the candidate cache → `notify(created)`.
      - duplicates → `markPublishing` → `commentOnIssue(n, renderDuplicateComment(fields, ctx))` →
        `markDone` → `notify(duplicate_open)` or `notify(duplicate_closed, { closedAt: issue.closedAt,
        fixed: issue.stateReason === 'completed' })`.
      - `ctx`: `reportId`, `source`, `category`, `locale`, `city` from the row;
        `latestExtensionVersion` = `deps.latestExtensionVersion()` for `extension`, `null` for `bot`;
        `mediaStored` / `mediaFailed` from the media rows (`bytes > 0` / `bytes = 0`).
3. **Errors.**
   - An error thrown **after** `markPublishing` (the GitHub write itself, or anything up to
     `markDone`) → `markNeedsReview` + `notify(needs_review)`; next row. Never retried: the write may
     have happened.
   - An error thrown **before** `markPublishing` (steps 2.2–2.6) → `attempts =
     recordAttemptError(msg)`. If `!isTransient(e)` or `attempts >= maxAttempts` → `markFailed` +
     `notify(failed)` and continue with the next row; otherwise leave it `queued` and **stop the run**
     (an upstream is down; the 15-min cron retries).
   - `notify` errors are caught and `log.warn`-ed; they never change a status or stop the run.

### Tests (all required; stubs return visible distinct values; `now` fixed)

Name each test after the behaviour. Use a real in-memory DB with `migrate` and the real
`bugReportStore`; stub `github`, `selector`, `judge`, `readFile`, `notify`, `log`.

1. `new` verdict: `createIssue` called once with the rendered title/body and labels
   `[..., 'user-report', 'Severity-3', 'effort/M']`; row `done` with the returned number;
   `notify` got `{ kind: 'created', issueNumber }`.
2. `duplicate_open`: `commentOnIssue(n, body)` once, no `createIssue`; outcome `duplicate_open`.
3. `duplicate_closed` with `stateReason: 'completed'` → `fixed: true` and the issue's `closedAt`;
   with `'not_planned'` → `fixed: false`.
4. `not_a_bug`: no GitHub write at all; row `done`, `issue_number` null.
5. **Crash recovery:** a row seeded in `publishing` → after `runOnce`, status `needs_review`, `notify`
   got `needs_review`, and **zero** calls to `createIssue`, `commentOnIssue`, `selector.select`,
   `judge`.
6. **Failure after the write started:** `createIssue` throws a transient 503 → row `needs_review`,
   `createIssue` called exactly once, `attempts` unchanged (0).
7. Transient error before publishing (selector throws `HttpStatusError(503)`): attempts 1, row still
   `queued`, the next queued row was **not** processed (stop the run).
8. Third transient failure (row seeded with `attempts = 2`) → `failed`, `notify(failed)`.
9. Non-transient error before publishing (`HttpStatusError(400)`) → `failed` on the first attempt,
   and the next queued row **is** processed.
10. Invalid judge output once, valid second → processed normally; `judge` called 2 times.
11. Invalid twice → `failed`, `judge` called exactly 2 times, no GitHub write.
12. **Cap:** 19 rows processed today + 2 queued → exactly one processed, the other gets `deferred`
    and `deferredNotified = true`; a second `runOnce` does **not** notify it again. Boundary: a row
    processed at `warsawDayStartUtc(now)` minus 1 ms does not count toward the cap.
13. **Cache:** two queued rows, first verdict `duplicate_open` → `listIssuesByLabels` called once;
    first verdict `new` → called twice (cache dropped). TTL: advancing `now` by
    `candidateCacheTtlMs + 1` between runs → refetched; by exactly `candidateCacheTtlMs` → not.
14. Truncated selection → `candidates_truncated` set on that row.
15. Images: photo rows `.png` and `.jpg` with bytes > 0 → two images with the right mime in
    `judge`'s input; a `video`, a `bytes = 0` photo, a pruned photo and a `.gif` → excluded; a
    `readFile` rejection → that image skipped, run continues.
16. Extension source → `latestExtensionVersion` passed to judge and into the body; bot source →
    `null` in both.
17. Re-entrancy: calling `runOnce()` twice without awaiting the first → the second resolves without
    processing (selector called once per row, not twice).
18. `notify` throwing → status still final, next row processed.

**Mutation checks (controller):** remove the crash-recovery step; retry after `markPublishing`;
count the cap with `>`; keep the cache after `new`; each must fail a named test above.

---

**Amended at review (2026-09-27):** 401/402/403 before `publishing` pause the queue instead of
failing the row (spec § Ідемпотентність, п. 6). Controller commit on `feat/bug-report`. Test 9 keeps
400 as the permanent-failure case.

## After Task 4 — end-to-end review of the core (controller)

Whole-branch diff against the spec; the four tasks' mutation checks re-run on the merged branch;
full gate; the live judge probe result recorded in the PR description. Only then the periphery plan
is written.
