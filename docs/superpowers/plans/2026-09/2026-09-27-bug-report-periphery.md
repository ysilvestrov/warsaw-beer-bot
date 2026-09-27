# /report — periphery plan (stage 2 of 2)

Spec: `docs/superpowers/specs/2026-09/2026-09-26-bug-report-design.md`
Core (done, merged on `feat/bug-report`): `docs/superpowers/plans/2026-09/2026-09-26-bug-report-core.md`,
contracts `src/domain/bug-report-types.ts`.

Same working mode as the core. Codex implements each task on `feat/bug-report-p<N>` in worktree
`../wbb-p<N>`, cut from `feat/bug-report`. The controller reviews, mutation-checks and merges. The
"Rules for every task" section of the core plan applies verbatim: testing rules, visible stubs, full
gate, the code beats the plan, touch only the listed files.

Order: **P1 and P3 in parallel → P2 (needs P1 merged) → P4 (needs P2 and P3 merged).**

Facts verified in code before writing this plan (2026-09-27). If any has changed, stop and report.

- `src/index.ts` registers composers in one `bot.use(cityGate, startCommand, linkCommand,
  importCommand, …)`. `importCommand` has `on('document')` that catches **every** document. A
  composer that must see image documents during a draft therefore goes **before**
  `importCommand` and after `cityGate`.
- Telegraf's `on('text')` also receives command messages (`/newbeers`). A text handler registered
  before other commands must pass `/…` text through, or an active draft would swallow every
  command.
- `src/bot/commands/city-gate.wiring.test.ts` is the house pattern for "registration order is an
  invariant": a real-Telegraf integration test plus a source-level guard on `src/index.ts`.
- `src/bot/commands/catalog.ts` is the single source of `/help` and the Telegram menu. Its tests use
  `COMMAND_CATALOG.length`, not a literal, so adding an entry breaks no test.
- i18n: `src/i18n/types.ts` `Messages` + `src/i18n/locales/{uk,pl,en}.ts`.
  `src/i18n/index.test.ts` asserts that all three locales have exactly the same keys.
- `ADMIN_TELEGRAM_ID` is `z.string().optional()` in `src/config/env.ts`.
  `EXPECTED_PROD_KEYS` tests use `toContain`, not a pinned list.
- The latest published extension version is `getJobState(db, ANNOUNCED_VERSION_KEY)` from
  `src/jobs/announce-release.ts` (live value `0.20.0`). `extension_releases` is retired (#267), so
  never read it.
- `buildStatusMessage(m, date, triageLine?, saturatedLine?, withheldLine?)` in
  `src/jobs/daily-status.ts` takes optional trailing lines, and 21 test call sites use it.
- The Telegram file download pattern (`ctx.telegram.getFileLink` + `fetch`) lives in
  `src/bot/commands/import.ts`.

---

## P1 — dialog state machine + drafts/bans storage (pure + storage)

Files: new `src/domain/bug-report-flow.ts` + test, new `src/storage/bug_report_drafts.ts` + test.
The tables already exist (v38).

### Types (export from `bug-report-flow.ts`)

```ts
export type DraftStep = 'source' | 'category' | 'text' | 'media' | 'confirm';
export interface DraftMedia { fileId: string; kind: MediaKind; fileSize: number | null; ext: string }
export interface Draft {
  step: DraftStep; source: ReportSource | null; category: ReportCategory | null;
  text: string | null; media: DraftMedia[]; updatedAt: string; // ISO
}
export type Keyboard =
  | { kind: 'sources' }
  | { kind: 'categories'; source: ReportSource }
  | { kind: 'media' }      // «Готово» / «Без медіа»
  | { kind: 'confirm' };   // «Надіслати» / «Скасувати»
export type ReplyParam = string | number | { t: string }; // { t } = translate this key
export interface Reply { key: string; params?: Record<string, ReplyParam>; keyboard?: Keyboard }
export type FlowEvent =
  | { type: 'start'; submittedToday: number; banned: boolean; available: boolean; privateChat: boolean }
  | { type: 'cancel' }
  | { type: 'pick_source'; source: ReportSource }
  | { type: 'pick_category'; category: ReportCategory }
  | { type: 'text'; text: string }
  | { type: 'media'; media: DraftMedia }
  | { type: 'media_done' }
  | { type: 'submit'; submittedToday: number };
export interface Submission { source: ReportSource; category: ReportCategory; text: string; media: DraftMedia[] }
export interface FlowResult {
  draft: Draft | null;        // null = delete the stored draft
  replies: Reply[];
  passThrough: boolean;       // true = not ours; the caller must call next()
  submission?: Submission;    // present only on a successful submit
}
export const DRAFT_TTL_MS = 30 * 60 * 1000;
export const MAX_MEDIA = 3;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MIN_TEXT = 10;
export const DAILY_USER_LIMIT = 3;
export function stepFlow(stored: Draft | null, event: FlowEvent, now: Date): FlowResult;
```

### Rules of `stepFlow`

- **Expiry first.** A stored draft whose `updatedAt` is **more than** `DRAFT_TTL_MS` before `now`
  counts as `null` (exactly `DRAFT_TTL_MS` old is still alive). When a non-`start` event meets no
  live draft, the result is: `draft: null`; replies `[{ key: 'report.expired' }]` for `pick_source`,
  `pick_category`, `media_done` and `submit` (button presses on a dead draft); no replies and
  `passThrough: true` for `text` and `media`; no replies and `passThrough: true` for `cancel`.
- `start`: checks in this order, each with `draft: null`:
  1. not a private chat → `report.private_only`;
  2. unavailable → `report.unavailable`;
  3. banned → `report.banned`;
  4. `submittedToday >= DAILY_USER_LIMIT` → `report.limit`.

  Otherwise a new draft `{ step: 'source', … }` (replacing any live one) and reply
  `report.ask_source` with the `sources` keyboard.
- `cancel` on a live draft → `draft: null`, reply `report.cancelled`.
- `pick_source` is accepted only at step `source`; at any other step the event is ignored (no
  replies, draft unchanged, `passThrough: false`). It sets the source, moves to `category` and replies
  `report.ask_category` with `{ kind: 'categories', source }`.
- `pick_category`: only at step `category`, and only for a category in
  `categoriesFor(draft.source)`; otherwise ignored. It moves to `text` and replies `report.ask_text`.
- `text`: only at step `text`. Text starting with `/` → `passThrough: true`, draft unchanged
  (commands must reach their handlers). Text at any other step also → `passThrough: true`, draft
  unchanged. Trimmed length `< MIN_TEXT` → reply `report.too_short`, stay. Otherwise store the
  trimmed text, move to `media`, reply `report.ask_media` with the `media` keyboard.
- `media`: only at step `media` (other steps → `passThrough: true`). `fileSize > MAX_MEDIA_BYTES` →
  `report.media_too_big`, stay. Already `MAX_MEDIA` items → `report.media_full`, stay. Otherwise
  append and reply `report.media_added` with `{ n: <new count>, max: 3 }`.
- `media_done`: only at step `media`. Moves to `confirm` and replies `report.confirm` with params
  `{ source: { t: 'report.source.<s>' }, category: { t: 'report.cat.<c>' }, text, media: <count> }`
  and the `confirm` keyboard.
- `submit`: only at step `confirm`. `submittedToday >= DAILY_USER_LIMIT` → `draft: null`, reply
  `report.limit`. This check repeats the one in `start` because the user may have parallel drafts
  or sent several reports meanwhile. Otherwise `draft: null`, `submission` filled, **no** replies:
  the caller sends `report.accepted` itself, because it needs that message's id.
- Every result that keeps a draft sets `updatedAt = now.toISOString()`.
- `passThrough` is `false` unless a rule above says `true`.

Tests: every rule above, each as its own test with literal expectations (`toEqual` on the whole
`FlowResult`). Boundaries: expiry at exactly 30 min vs 30 min + 1 ms; text of 9 vs 10 trimmed chars
(`'  123456789  '` is 9); media of `MAX_MEDIA_BYTES` vs `+1`; the 4th media item; `submittedToday`
2 vs 3 for both `start` and `submit`; a `bot`-source draft rejecting `pick_category('no_badge')`;
`/newbeers` at step `text` → passThrough with the draft unchanged.

### `storage/bug_report_drafts.ts`

`getDraft(db, telegramId): Draft | null`, `saveDraft(db, telegramId, d: Draft): void` (upsert),
`deleteDraft(db, telegramId): void`, `isBanned(db, telegramId): boolean`,
`setBan(db, telegramId, bannedAt: string): void` (idempotent), `clearBan(db, telegramId): void`.
`media_json` holds the `DraftMedia[]` array.

Tests: round trip with media, upsert overwrites, delete, a missing row → `null`, ban/unban/idempotent
ban, per-user isolation.

**Mutation checks (controller):** make the expiry use `>=`; drop the `/` passThrough; drop the
repeated limit check in `submit`; each must fail a named test.

---

## P2 — Telegram layer (needs P1 merged)

Files: new `src/bot/commands/report.ts` + `report.test.ts`; `src/i18n/types.ts`,
`src/i18n/locales/{uk,pl,en}.ts`; `src/bot/commands/catalog.ts` (one entry
`{ command: 'report', descKey: 'cmd.report' }` before `help`); new
`src/bot/bug-report-media.ts` + test.

### `createReportCommand(deps: ReportCommandDeps): Composer<BotContext>`

```ts
export interface ReportCommandDeps {
  available: boolean;                          // env fully configured (P4 decides)
  mediaDir: string | null;
  now: () => Date;
  triggerWorker: () => void;                   // fire-and-forget worker.runOnce()
  downloadFile: (fileId: string) => Promise<Buffer>; // wraps getFileLink + fetch
}
```

The composer handles:
- `command('report')` → event `start`. `submittedToday` = `countSubmittedSince(db, id,
  warsawDayStartUtc(now))`, `banned` = `isBanned`, `privateChat` = `ctx.chat.type === 'private'`.
- `command('cancel')` → event `cancel`; on `passThrough` call `next()`.
- `action(/^report:(src|cat|done|send|cancel):?(.*)$/)` → the matching event. Always
  `answerCbQuery()`. The callback data format is `report:src:bot`, `report:cat:wrong_beer`,
  `report:done`, `report:send`, `report:cancel`.
- `on('text')`, `on('photo')`, `on('video')`, `on('document')`. Build the event:
  - photo: largest size, `kind 'photo'`, `ext 'jpg'`;
  - document with `mime_type` starting `image/`: `kind 'photo'`, ext from the mime
    (`png`/`jpeg→jpg`/`webp`/otherwise the mime subtype);
  - video: `kind 'video'`, ext `mp4` (`video/quicktime` → `mov`);
  - **any other document → `next()` without calling the flow**, so `/import` gets its CSV/JSON.

  On `passThrough` call `next()`.
- Before calling the flow, load the draft with `getDraft`. After it, `saveDraft` or `deleteDraft`
  per `result.draft`, then send the replies.
- Reply rendering: `ctx.t(key, params)` with every `{ t }` param translated first. Keyboards are
  inline keyboards built from the `Keyboard` spec: sources = two buttons; categories =
  `categoriesFor(source)` one per row; media = done/no-media; confirm = send/cancel. Both «Готово»
  and «Без медіа» send `report:done`.
- **Submission** (when `result.submission` is present):
  1. `const msg = await ctx.reply(t('report.accepted'))`.
  2. `insertReport` with `statusMessageId: msg.message_id`, the locale, `city` =
     `getUserCity(db, id)` (never throws; returns a city slug or `outside-pl`), `createdAt = now`.
  3. For each media item, `saveReportMedia({ dir: mediaDir, reportId, idx, media, download })` from
     `bug-report-media.ts`, then `addMedia`.
  4. `triggerWorker()`.
- **Group chats:** only `/report` replies (`report.private_only`). The text, media and action
  handlers `next()` immediately when `ctx.chat.type !== 'private'`.

### `bug-report-media.ts`

`saveReportMedia({ dir, reportId, idx, media, download }): Promise<{ path: string; bytes: number }>`:
- `mkdir(<dir>/<reportId>, { recursive: true })`, write `<idx>.<ext>`, `fsync`, close.
- Return the real byte count.
- On **any** failure (download or write) → log-free `{ path, bytes: 0 }`. The row records that the
  file was not saved.

`createNotifier(deps: { telegram: Pick<Telegram, 'editMessageText' | 'sendMessage'>; repo: string })`
returns `(report: BugReportRow, outcome: ReportOutcome) => Promise<void>`:
- translator = `createTranslator(report.locale)`;
- text by outcome kind:
  - `created` → `report.done.created`;
  - `duplicate_open` → `report.done.duplicate_open`;
  - `duplicate_closed` → `report.done.duplicate_closed_fixed` when `fixed`, else
    `report.done.duplicate_closed`, with `date` = `closedAt.slice(0, 10)`;
  - `not_a_bug` / `deferred` / `needs_review` / `failed` → `report.done.<kind>`;
  - `url` = `https://github.com/<repo>/issues/<n>`;
- `editMessageText(chatId, statusMessageId, undefined, text)`, or `sendMessage(chatId, text)` when
  `statusMessageId` is null.
- Errors propagate; the worker already catches notify errors.

### `/reportban` (inside the same composer)

`command('reportban')`: only when `String(ctx.from.id) === env.ADMIN_TELEGRAM_ID` (read from
`ctx.deps.env`); otherwise `next()`, so it behaves like an unknown command.
- `/reportban <id>` → `setBan`, reply `reportban.banned`;
- `/reportban <id> off` → `clearBan`, reply `reportban.unbanned`;
- anything else → `reportban.usage`.

Not in `COMMAND_CATALOG`.

### i18n keys (uk given; write pl and en as faithful translations)

```
'cmd.report': 'поскаржитися на помилку в боті чи розширенні',
'report.ask_source': 'Де помилка?',
'report.source.bot': 'Бот', 'report.source.extension': 'Розширення',
'report.ask_category': 'Що саме не так?',
'report.cat.wrong_beer': 'Не те пиво / чужий рейтинг',
'report.cat.no_rating': 'Пиво без рейтингу',
'report.cat.had_status': 'Неправильно «пив / не пив»',
'report.cat.stale_data': 'Застарілі або хибні дані паба / кранів / крамниці',
'report.cat.route': 'Маршрут або карта',
'report.cat.no_badge': 'Позначка не з\'являється на сторінці крамниці',
'report.cat.ext_broken': 'Розширення не працює: вхід, встановлення, оновлення, меню',
'report.cat.bot_broken': 'Бот не відповідає, зависає або видає помилку',
'report.cat.text_ui': 'Текст, переклад, оформлення',
'report.cat.other': 'Інше',
'report.ask_text': 'Опиши, що сталося і що мало статися — щонайменше 10 символів.',
'report.too_short': 'Закоротко — напиши хоча б 10 символів.',
'report.ask_media': 'Можеш додати до 3 скріншотів чи відео (до 20 МБ) або одразу натиснути «Без медіа».',
'report.media_added': 'Додано ({n}/{max}).',
'report.media_full': 'Уже 3 файли — більше не можна. Натисни «Готово».',
'report.media_too_big': 'Файл більший за 20 МБ — бот не зможе його завантажити.',
'report.btn.done': 'Готово', 'report.btn.no_media': 'Без медіа',
'report.btn.send': 'Надіслати', 'report.btn.cancel': 'Скасувати',
'report.confirm': 'Перевір скаргу:\n{source} · {category}\n\n{text}\n\nМедіа: {media}\n\nОпис у переказі буде опубліковано публічно на GitHub. Скріншоти й відео публічними не будуть — їх бачать лише розробники на сервері. Не пиши в описі особистих даних.',
'report.accepted': 'Прийнято, аналізую…',
'report.cancelled': 'Скаргу скасовано.',
'report.expired': 'Ця чернетка вже неактуальна — почни знову: /report',
'report.limit': 'Сьогодні вже 3 скарги — це максимум на добу. Спробуй завтра.',
'report.banned': 'Скарги для тебе недоступні.',
'report.unavailable': 'Скарги тимчасово недоступні.',
'report.private_only': 'Скарги приймаються лише в особистому чаті з ботом.',
'report.done.created': 'Дякую! Створено issue: {url}',
'report.done.duplicate_open': 'Дякую! Це вже відомо й відкрито — додали твої дані: {url}',
'report.done.duplicate_closed_fixed': 'Це виправлено {date}. Якщо бачиш після оновлення — надішли скаргу ще раз: {url}',
'report.done.duplicate_closed': 'Це вже відомо (закрито {date}): {url}',
'report.done.not_a_bug': 'Схоже, це не помилка бота чи розширення.',
'report.done.deferred': 'Прийнято — відповім пізніше.',
'report.done.needs_review': 'Прийнято — розробник перевірить вручну.',
'report.done.failed': 'Не вдалося обробити скаргу — розробник подивиться.',
'reportban.usage': 'Використання: /reportban <telegram_id> [off]',
'reportban.banned': 'Скарги для {id} вимкнено.',
'reportban.unbanned': 'Скарги для {id} увімкнено.',
```

Check how `ctx.reply` is used for plain text elsewhere. These strings go out without `parse_mode`;
if the house style sends HTML, escape `{text}` (memory: Telegraf HTML mode breaks silently on
unescaped metavariables).

### Tests (`report.test.ts`, real Telegraf with `handleUpdate` like `city-gate.wiring.test.ts`, in-memory DB)

1. Full happy path: `/report` → `report:src:extension` → `report:cat:no_badge` → text → photo →
   `report:done` → `report:send`. Assert: exactly one `bug_reports` row with the fields; one media
   row with `bytes > 0` and the file on disk (tmp dir); `triggerWorker` called once; the draft
   deleted; the last reply is `report.accepted` in the user's locale.
2. A CSV document during step `media` → the composer calls `next()` (a downstream probe composer
   receives it) and the draft is unchanged.
3. `/newbeers` text during step `text` → reaches a downstream probe.
4. A `report:send` press on an expired draft → `report.expired`, no row.
5. Group chat `/report` → `report.private_only`; a group photo → reaches downstream.
6. `/reportban 123` from admin → ban row; from a non-admin → reaches downstream, no row.
7. A download failure → media row `bytes = 0`, the report is still inserted, the worker is still
   triggered.
8. `createNotifier`: each outcome kind → the exact text and URL (en locale, literal strings);
   `statusMessageId` null → `sendMessage`.

**Mutation checks (controller):** remove the non-image document early `next()`; remove the
private-chat guard on media; skip `triggerWorker`; each must fail a named test.

---

## P3 — worker pause signal, digest line, media pruning (parallel with P1)

Files: `src/jobs/bug-report-worker.ts` + test (pause state only), `src/jobs/daily-status.ts` + test,
new `src/jobs/bug-report-prune.ts` + test.

- **Pause signal.** Export `BUG_REPORT_PAUSED_KEY = 'bug_report_paused'`. On a credential refusal
  (the existing `isCredentialRefusal` branch), if the key is **not** set,
  `setJobState(key, JSON.stringify({ since: now ISO, status }))`; if it is already set, leave it
  (keep the original `since`). When `processReport` finishes any report without a credential
  refusal (every `return true` path), `deleteJobState(key)`. Tests: set on first refusal; `since`
  kept on a second refusal in a later run; cleared after the next successful report; a transient
  503 neither sets nor clears it.
- **Digest line.** New exported pure
  `buildBugReportLine(s: BugReportSummary, paused: { since: string; status: number } | null, repo: string): string | null`:
  - `null` when `processed = 0`, `queued = 0` and `paused` is null;
  - otherwise the spec's line: `скарги за добу: оброблено N (нових M, відкритих дублікатів K,
    закритих дублікатів C, не-баг L), у черзі Q, потребують перевірки P, збоїв F`;
  - then one line per `closedLinks` entry: `  R-<id> → https://github.com/<repo>/issues/<n>`;
  - then `  перевірити: R-<id>, …` when `needsReview` or `failed` is non-empty;
  - first, when `paused`: `⚠️ скарги на паузі з <since HH:MM UTC>: ключ відхилено (<status>)`.

  `dailyStatus` gets it from `summarizeSince(db, now − 24 h)` plus the paused key and passes it as a
  new optional trailing parameter `bugReportLine` of `buildStatusMessage` (rendered like the other
  optional lines). `dailyStatus` needs the repo: add optional `repo?: string` to its deps; with no
  repo the line is not built. Tests: each branch of `buildBugReportLine` with literal strings; one
  `dailyStatus` test showing the line in the sent message; the existing 21 call sites untouched.
- **Pruning.** `pruneBugReportMedia({ db, now, retentionDays = 180, unlink }): Promise<number>`:
  - `listPrunableMedia(now − retentionDays)`;
  - for each file, `unlink(path)`, where ENOENT counts as success and other errors are logged and
    skipped (the row stays unpruned);
  - `markMediaPruned`;
  - returns the number pruned.

  Tests: a 181-day-old file is removed and marked; a file exactly at the cutoff is kept; ENOENT is
  marked; EACCES is not marked.

**Mutation checks (controller):** overwrite `since` on a repeat refusal; build the line when
everything is zero; mark a row pruned after EACCES; each must fail a named test.

---

## P4 — wiring, env, docs (needs P2 and P3 merged)

Files: `src/config/env.ts` + test, `.env.example`, `src/index.ts`, new
`src/bot/commands/report.wiring.test.ts`, `spec.md`.

- **Env.**
  - Add to `Schema`:
    - `OPENROUTER_API_KEY` (optional);
    - `BUG_REPORT_SELECT_MODEL`, default `typesafe/jev-1.13`;
    - `BUG_REPORT_VERDICT_MODEL`, default `gpt-5.6-luna`;
    - `BUG_REPORT_MEDIA_DIR` (optional).
  - Add to `EXPECTED_PROD_KEYS` with `disables: '/report bug reports'`: `OPENROUTER_API_KEY`,
    `OPENAI_API_KEY` and `BUG_REPORT_MEDIA_DIR`.
  - `missingExpectedKeys` must not flag `OPENAI_API_KEY` twice or misleadingly. Keep the existing
    Anthropic special case intact.
  - Tests use `toContain`.
- **`src/index.ts`.**
  - `bugReportsAvailable` = all of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`,
    `BUG_REPORT_MEDIA_DIR` are non-empty.
  - When available, build the worker:
    - `createJevSelector`, `createOpenAiJudge`, `createGithubIssuesClient`;
    - `bugReportStore`;
    - `readFile` = `fs.promises.readFile`;
    - `notify` = `createNotifier({ telegram: bot.telegram, repo: env.GITHUB_REPO })`;
    - `latestExtensionVersion` = `() => getJobState(db, ANNOUNCED_VERSION_KEY)`;
    - `now`, `log`.
  - Register `createReportCommand({ available, mediaDir, now, triggerWorker: () => void
    worker?.runOnce().catch(log.error), downloadFile })` **immediately after `cityGate` and before
    `importCommand`** in the `bot.use(...)` list.
  - Crons (only when available):
    - `*/15 * * * *` → `worker.runOnce()`;
    - pruning inside a new `0 3 * * *` job that runs regardless of `untappdHttp`. Do not nest it in
      the existing untappd-only one.
  - Pass `repo: env.GITHUB_REPO` to both `dailyStatus` call sites.
- **Wiring test** (`report.wiring.test.ts`, modelled on `city-gate.wiring.test.ts`):
  - (a) a real-Telegraf test that, with the report composer before a stand-in import composer, an
    image document during a media-step draft reaches the report flow, a CSV reaches the stand-in,
    and with the order reversed the image is lost to the stand-in (proving order matters);
  - (b) a source guard that reads `src/index.ts` and asserts `createReportCommand(` appears after
    `cityGate,` and before `importCommand,` inside `bot.use(`.
- **`.env.example`**: the four keys with comments, in the style of the triage block.
- **`spec.md`** (the spec document's section "Зміни документів у тому ж PR"):
  - §3 — the four tables + the migration history row v38;
  - §4 — `/report`, `/reportban`, a "Скарги на помилки" subsection (flow, limits, privacy, the four
    verdicts, the credential pause);
  - the background jobs list — the worker cron + pruning;
  - §5.6 — the new keys.

  Write it in the style of the surrounding sections: Ukrainian, same table formats.

**Mutation checks (controller):** move `createReportCommand` after `importCommand` in
`src/index.ts` (guard b fails); reverse the order in test (a) (the "order matters" assertion
fails).

---

## After P4 (controller)

- Whole-branch review of the periphery, covering the inline fixes.
- Full gate.
- `git fetch origin main` + rebase + full gate again (CLAUDE.md).
- PR with the AI review loop.
- The ops prerequisites from the spec happen at deploy, not in this PR.
