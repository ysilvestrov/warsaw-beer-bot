# Daily status as a traffic light

## Request and scope

The administrator reads the morning report (`dailyStatus`, 09:00 Warsaw) and today
mostly sees green ticks; the parts actually read are the triage line and the
extension/MCP request counts. On 2026-10-06 the report missed an incident: the
enrich canary failed at 05:30, Telegram got an alert, the next run at 08:30 passed,
and the 09:00 report showed `пошук ✅` because it reads only the **latest** canary
state. The same report carried `Тести: дані монітора недоступні`, which could not be
told apart from a broken monitor (it was a race, #785).

The report is rebuilt around a traffic light. Agreed with the user in brainstorming:

1. **Traffic light first** — one overall colour and one per subsystem.
   🟢 everything measured and fine, no explanation; 🟡 degradation, an incident in
   the last 24 h, a broken audit rule, or **missing data** — explained where and why;
   🔴 something breaks answers to people right now and will not pass by itself —
   needs a reaction. There is **no fourth colour**: "no data" is 🟡 with "нема даних:
   <source>" as the reason. The mechanism-audit lines (`Печатки`, `Замок`, …) stop
   being standing lines and become the reasons for 🟡/🔴.
2. **Events of the day** — what happened, which issues closed, what was deployed.
3. **Live users** — extension `/match`, MCP, bug reports, bot usage; empty when
   nothing happened.
4. **Trends** — only what changed; nothing when nothing changed.

Staging agreed: stage **(a)** is fully deterministic (this spec). Stage **(b)** puts a
cheap LLM over the *renderer only* — code decides colours and selects facts, the model
turns them into prose, with the template as fallback; it gets its own spec after real
reports exist. **Money** (LLM/web-search/proxy spend vs the $20–40 budget) is a
separate stage, #786. Out of scope here: #783 (canary failure reason), #784 (canary
recovery alert) and #785 (monitor race) are separate light-path fixes; this design
consumes their effects but does not depend on them landing first.

## Evidence obtained before planning (2026-10-06)

- **Today's incident, from the journal.** `enrich-orphans canary failed` at 05:30:10
  Warsaw; `untappd_search_canary = {"ok":true,"at":"2026-10-06T06:30:00Z"}` afterwards;
  `daily-status sent` at 09:00:01. Nothing in the DB recorded the failure: a state
  snapshot cannot see an incident that ended before the snapshot.
- **No history exists.** `collectStatus` computes every number live; no table keeps a
  past day. Week-over-week anything needs a new store.
- **`/match` usage is counted only after validation.** `recordMatchUsage` runs inside
  the handler, after `optionalAuthMiddleware`, both body limits and `zValidator`. 401,
  413, 400 and 500 are invisible today.
- **A prefix middleware sees every status (probe).** A Hono app with a first-registered
  `app.use('/match', …)` that reads `c.res.status` after `await next()` observed
  `200, 401 (auth middleware), 400 (handler), 500 (thrown, mapped by onError)`.
- **MCP failures are HTTP 200.** `@modelcontextprotocol/sdk` `McpServer` wraps both a
  thrown tool handler and an input-validation failure into `{ isError: true }`
  (`dist/cjs/server/mcp.js`, `createToolError`); only transport/auth failures change the
  HTTP status. An MCP error counter must read the JSON-RPC response body. The route
  runs with `enableJsonResponse: true`, so the reply is a JSON body, not SSE.
- **Volumes are tiny.** `api_usage`, last 21 days: extension `/match` 1–65 requests/day
  (median ≈ 3), MCP 0 every day. Bug reports: 1 in 21 days. New `user_profiles`: 0 in
  30 days. `enrich_failures.last_at` touched 3–80 rows/day; enrich matches 4–73/day.
  Scrape: 115–116 of 123 pubs every day, two snapshots per pub (12 h cron).
  Consequence: percentage-of-median rules on **daily flows** would fire on noise; see
  *Trends*.
- **Deploy outcomes live outside the bot.** `deploy/autodeploy.sh` already sends its own
  Telegram messages (live, refused, UNVERIFIED, hold) and keeps only the current state
  in `~/.local/state/wbb-autodeploy/state.env` (current/previous sha, last hold-notice
  date) — no history of outcomes. The bot process runs as `warsaw-beer-bot` and has no
  view of it.
- **The published-snapshot pattern works.** The test-diagnostics design
  (`2026-10-01-test-diagnostics-digest-design.md`) proved that a file owned by the
  operator in a 0755 directory under `/var/tmp`, mode 0644, is readable by the bot, and
  `readTestDiagnosticsLine` is the hardened reader.

## Subsystems

Six subsystems in stage (a); money joins with #786.

| Subsystem | Covers |
|---|---|
| **Крани** | ontap scrape |
| **Untappd** | Algolia search canary + breaker, enrich-orphans, hydrate-ratings, refresh-untappd (profiles, proxy rotation) |
| **Сироти** | orphan triage + the mechanism audits (`Печатки`, `Замок`, saturation, withheld-after-close). **Capped at 🟡**: an orphan is "rating unknown", never a wrong answer |
| **Канали** | the paths people use: Telegram bot, extension `/match`, MCP, bug-report worker. The light says whether a channel *works*; how much it was used goes to *Live users* |
| **Фест** | festival menu poll + MCP keep-alive. Shown **while a fest is current or ahead** (`currentOrNextFests` non-empty — its last polling window has not closed). Not `activeFests`: that is true only inside a session's polling window, and sessions are in the afternoon, so at 09:00 it would hide the subsystem every day |
| **Інфраструктура** | disk, inodes, test monitor, DB size, deploy state, GitHub reachability |

Overall colour = the worst subsystem colour.

## Colour rules (initial values)

General rules, applied to every subsystem:

- 🔴 only for "answers to people are broken now and will not recover alone".
- 🟡 for: a degradation against the usual level; **any incident event in the last
  24 h, even if already recovered**; a mechanism-audit rule that fired; **any input the
  evaluator needed but could not read** (reason `нема даних: <source>`).
- 🟢 only when every input was read and no rule fired.

| Subsystem | 🔴 | 🟡 |
|---|---|---|
| Крани | last scrape > 26 h (two missed 12 h cycles), or 0 pubs in the latest snapshots | last scrape > 14 h (today's threshold); pubs scraped in 24 h < 90 % of the 7-day median |
| Untappd | canary failed on the **latest** run, or the Algolia breaker is open now | profile-scrape breaker (`untappd_profile_http_open_until`) open now; any canary failure / breaker opening / aborted run in 24 h; `hydrate-ratings` blocked or failed; `refresh-untappd` failed or rotated; `ratingsMissing` above its 7-day median by the trend threshold |
| Сироти | — (capped) | triage did not run today; unlock job did not run today; `unlocked7d = 0` while ≥ 1 `orphan-triage` issue closed in 7 d (lock mechanism dead — **stage 2**, needs closed issues); `sealRetiredFalsified` grew vs yesterday; `unlockedUnadjudicated7d > 0`; withheld-after-close > 0; saturation present |
| Канали | bug-report worker paused (key rejected); `/match` or MCP: ≥ 3 errors **and** error share > 50 % (yesterday) | bug reports failed or needing review; `/match` or MCP: ≥ 3 errors **and** error share > 5 % |
| Фест | menu or MCP keep-alive not refreshed for > 4 of its own cycles | > 2 of its own cycles; never refreshed at all |
| Інфраструктура | free disk ≤ 5 GiB or free inodes < 100 000 (the monitor's own critical values); a deploy held for a regression (#768) | free disk ≤ 10 GiB (the monitor's warning value), or falling > 1 GiB/day over 7 d; a `deploy:hold` pending > 24 h; test monitor, deploy journal or GitHub unreadable |

**Error definitions.** `/match`: a response with status ≥ 400 except 405. MCP: status
≥ 400 except 405, **or** a JSON-RPC `error` member, **or** `result.isError === true`;
the denominator is `tools/call` requests (handshakes and `tools/list` are not matches,
same reasoning as `recordMatchUsage` today). The reason text names the status classes
(e.g. `3× 401, 1× 500`), because 4xx and 5xx point at different owners.

**Fest cycles** are read from the jobs' own constants, never duplicated in the evaluator:
the menu against `MENU_INTERVAL_RUN_UP_MS` (6 h — the longer of its two cadences, so a
09:00 report outside a session window never fires on the in-window 2 h cadence), the
keep-alive against `KEEPALIVE_EVERY_MS` (24 h).

**Inode percentages** (the monitor warns at 80 % used, criticises at 90 %) need
`inodes_total`, which the published summary does not carry. Stage 1 uses only the absolute
critical floor; adding `inodes_total` to the summary is a producer change and rides with the
deploy-journal change in stage 2.

**History-based rules before history exists.** Rules that compare with the past (pubs
vs 7-day median, `ratingsMissing` vs median, `sealRetiredFalsified` vs yesterday, disk
falling per day) need snapshots that the first days do not have. Such a rule is
**inactive**, not 🟡 and not silently 🟢: the report carries one footer line
`історія: N/7 днів — порівняльні правила ще не діють` until 7 snapshots exist, so a 🟢
in that week visibly claims less. Missing *current* data stays 🟡 as above; missing
*history* is a known, dated limitation.

**All thresholds live in one module** (`status-rules`), each with a comment naming what
it protects. They are initial values; a checkpoint after 14 days of snapshots re-measures
them against what actually fired (see *Verification*).

## Data

### `status_snapshots`

One row per Warsaw date: `date TEXT PRIMARY KEY, version INTEGER, metrics_json TEXT,
colours_json TEXT, created_at TEXT`. `metrics_json` is the full `StatusMetrics` object
plus the new counters; `colours_json` is the evaluator output (colour + reasons per
subsystem), kept so a later stage can compare "what we said" with "what happened".
Written **before** the Telegram send, so a failed send does not lose a day of history;
re-running on the same date overwrites (UPSERT). Retention: 90 days, pruned by the
same job.

### `ops_events`

`id, at TEXT, subsystem TEXT, level TEXT ('info'|'warn'|'error'), kind TEXT, text TEXT,
payload_json TEXT`. Written through one function `recordOpsEvent(db, …)` that **never
throws** into the caller (an ops log must not break the job it observes; failures go to
the pino log). Retention: 30 days.

Initial producers (stage 2 wiring):

| Producer | Events |
|---|---|
| `enrich-orphans` | canary failed (`error`), canary ok after a failure (`info`, reads the previous `untappd_search_canary`), run aborted by breaker (`warn`) |
| Algolia / profile breakers | opened (`warn`), closed (`info`) |
| `refresh-ontap` | scrape run failed (`error`) |
| `hydrate-ratings`, `refresh-untappd` | blocked / failed (`warn`), profile rotated (`warn`) |
| `orphan-triage` | run failed (`error`); the existing triage summary line becomes an `info` event |
| `bug-report-worker` | paused / resumed (`error` / `info`) |
| bot startup | `info` "started <sha>" — sha read from the deployed tree; absent sha is recorded as `unknown`, not skipped |
| `notifyAdmin` | **every** admin alert is also recorded (`warn`), subsystem given by the caller |

The last row is the safety net: anything that already wakes the administrator is, by
construction, an event of the day.

### Counters

- `api_usage` gains `match_errors`, `mcp_errors`, `mcp_tool_calls` and a small
  per-status breakdown (`errors_json`, `{"401":3,"500":1}`), keyed by Warsaw date like
  the existing columns. Counted by a middleware registered **first** on `/match` and
  `/mcp` (before body limits and auth), reading the final status after `await next()`;
  for `/mcp` it parses a clone of the JSON body. Counting never alters the response and
  never throws.
- `bot_command_usage(date, command, count)`: a Telegraf middleware registered first in
  the composition root counts updates whose message text starts with `/` (command name
  without `@botname`, lowercased). Telegraf updates run concurrently; the UPSERT is a
  single SQLite statement, so increments do not race.

### External sources read at report time

- **Closed issues**: GitHub REST `issues?state=closed&since=<now−24h>` through the
  existing `github-issues` client (pull requests filtered out). Failure → 🟡
  Інфраструктура, `нема даних: GitHub`.
- **Deploy journal**: `autodeploy.sh` appends each outcome (sha, outcome, reason, time)
  to a bounded JSON file `/var/tmp/wbb-autodeploy/journal.json` (operator-owned, 0755
  dir / 0644 file, last 50 entries, atomic replace), read with the same hardening as
  `readTestDiagnosticsLine`. This changes the installed deployer copy, so the PR
  carrying it is `[deploy:hold]`.
- **Test monitor**: the existing `readTestDiagnosticsLine` source, but returning a
  structured value (disk, inodes, pending runs, or `unavailable`) instead of a line.

## Report layout

```
🟡 Статус бота — 2026-10-06 09:00 · потребує уваги

🟢 Крани  🟡 Untappd  🟡 Сироти  🟢 Канали  🟢 Інфраструктура

🟡 Untappd
  • 05:30 канарка порожня, запуск enrich скасовано; о 08:30 відновилась
🟡 Сироти
  • утримано після закриття: 1 (#452 / beer 38770)

Події
  • 05:30 ⚠️ Untappd-пошук: канарка порожня
  • 08:30 ✅ Untappd-пошук відновився
  • 06:00 тріаж: 7 рядків → нове issue #782
  • закрито: #779, #781
  • деплой: без змін (38ea8c7 від 02.10)

Живі користувачі
  • розширення: 41 запит (12 анонім.), 230 пив
  • скарги: 1 нова → #780

Тренди
  • сиріт у черзі: 412 → 431 (+5 % за тиждень)
```

(Numbers illustrative.) Rules:

- Header: overall colour, Warsaw timestamp, and one word (`все гаразд` / `потребує
  уваги` / `потрібна реакція`).
- Light row: every evaluated subsystem, always (Фест only while active).
- Explanation blocks: only for 🟡/🔴 subsystems, one bullet per fired reason.
- **Події**: `ops_events` of the last 24 h, closed issues, deploy journal entries of the
  last 24 h; when nothing was deployed, one line `деплой: без змін (<sha> від <date>)`
  so the section is never empty and the running version is always stated.
- **Живі користувачі**: only non-zero lines — extension `/match` (requests, anonymous,
  beers, errors), MCP (tool calls, beers, errors), bug reports (the existing
  `buildBugReportLine` content), bot (commands by name, new profiles, new Untappd
  links). The whole section is omitted when every line is zero.
- **Тренди**: see below; omitted when nothing qualifies.
- Telegram limit: the message is cut at 4096 characters with `… (обрізано)`; explanation
  blocks and events come before users and trends, so truncation eats the least urgent
  part.

## Trends

The probe showed two kinds of metrics that need different rules:

- **Stocks** (a state that accumulates: orphans pending, relay queue, ratings missing,
  locked rows, catalog size, DB size, disk free). Shown when today vs the value 7 days
  ago moves by more than the metric's threshold — both a relative and an absolute floor
  (initially ±10 % **and** ±20 units; disk ±1 GiB) so that small bases do not trigger.
- **Flows** (per-day counts: `/match` requests, MCP calls, enrich matches/failures, new
  on tap, bot commands). Day-over-median is noise at these volumes, so flows compare
  **the last 7 days' sum with the previous 7 days'**, shown when the change exceeds
  ±50 % **and** ±10 units.

Trends are informational and never change a colour; a stock rule that matters for
health (ratings missing, disk) is expressed separately in the colour table. Without 7
(stocks) or 14 (flows) days of snapshots a trend is simply not computed — that is not
"missing data" and not 🟡, because no trend can exist yet.

## Errors in the report itself

- Every source (DB metrics, GitHub, monitor file, deploy journal, counters) is read
  separately; a failing source turns its subsystem 🟡 with `нема даних: <source>` and
  the report still goes out.
- If assembling the report throws as a whole, the administrator gets a minimal
  `🔴 Статус бота — звіт не зібрано: <error class>: <message>` instead of silence, and
  the delivery marker is **not** set, so the next tick in the window retries the full report; the fallback itself goes out at most once per Warsaw day (`job_state.daily_status_fallback_sent`), because the tick is every 15 minutes and a broken report would otherwise send twelve of them.
- `status_snapshots` is written before sending; a send failure keeps the day's history
  and keeps today's retry behaviour (marker set only on successful delivery).

## Claims and evidence

| Recorded fact | What it claims | Evidence |
|---|---|---|
| 🟢 on a subsystem | every input the evaluator needs was read and no rule fired | the evaluator returns 🟡 for any `unavailable` input — enforced by a table test per subsystem that feeds each input as missing |
| 🟢 Канали for `/match` | `/match` answered its callers | the first-registered prefix middleware observes the final status of every request reaching the app (probe above). **Not covered:** failures before the app (Cloudflare tunnel 502, bot down) — the report says "app-level", and a down bot sends no report at all |
| 🟢 Канали for MCP | tool calls succeeded | body-level count (`isError`, JSON-RPC `error`) because the SDK returns tool failures as HTTP 200 (source read above) |
| 🟢 Untappd | no search incident in the last 24 h | `ops_events` canary/breaker events — **only once stage 2 wires them**. Between the two deploys the evaluator judges the latest canary/breaker state only, and the footer says `події: ще не підключені` (same mechanism as the history footer), so stage 1 visibly claims less instead of turning 🟡 every day |
| `деплой: без змін (<sha>)` | production runs `<sha>` | the startup event's sha, read from the deployed tree. **Weak until probed:** whether the shipped tree carries its sha (rsync ships a tree, not a commit; `deploy.sh` clears `DEPLOYED_SHA` on a dirty tree). Probe P1 before the stage-2 plan; if the tree has no sha, the line says `версія невідома`, never a guessed sha |
| `закрито: #…` | these issues closed in the last 24 h | GitHub API response; failure → 🟡 `нема даних: GitHub`, never an empty list |
| Trend line | the metric moved | two stored snapshots 7 days apart (stocks) or two 7-day windows (flows); no snapshot → no line |
| `status_snapshots.colours_json` | what the report said that day | written in the same transaction as `metrics_json`, before sending |

## Probes still to run (before the stage-2 plan)

- **P1 — deployed sha.** Does `/opt/warsaw-beer-bot` contain anything that identifies the
  commit (a file written by `deploy.sh`/`autodeploy.sh`, `.git`, build metadata)? If not,
  the stage-2 plan adds writing one, and the deploy-journal entry is the source instead.
- **P2 — deploy journal producer.** Read every `notify` call in `autodeploy.sh` and list
  the outcomes; the journal must record the same set, so that "the report says nothing
  about deploys" can never coexist with "Telegram got a deploy alert".

## Implementation staging

Per CLAUDE.md (core plan → review → periphery plan):

1. **Core** (first plan): `status_snapshots` + migration; the six evaluators over the
   **existing** metrics (bug-report summary, triage/unlock state, test monitor as a
   structured value); the new renderer replacing `buildStatusMessage`; error handling of
   the report itself; trends computed from snapshots (dormant until history exists).
   `spec.md` gets the new report contract. End-to-end review.
2. **Periphery** (second plan, written after the core review): `ops_events` + producers;
   `/match`/MCP error counters; bot command counter; closed issues; deploy journal
   (`[deploy:hold]`, host step: reinstall the deployer copy);
   a Сироти rule for `sealUnidentifiable > 0` with `sealUnidentifiableReobserved = 0` (#377: the reachability mechanism is dead) — the field is already in the snapshot.
3. **Later, own specs:** LLM renderer (b); money (#786).

## Verification and rollout

- Unit: evaluator tables (every threshold edge, missing input → 🟡, Сироти never 🔴,
  overall = worst), renderer (empty sections omitted, no text under 🟢, truncation
  order), trend rules (stock/flow floors, no history → no line).
- Integration: middleware order on `/match`/`/mcp` and in the Telegraf composition root
  (counter registered first) — an integration test plus a source guard, per the
  composition-root rule.
- Prod-copy dry run: build the report from a byte copy of the prod DB and compare with
  today's old report — every fact in the old report is either present in the new one or
  deliberately folded into a 🟢 (listed in the PR).
- Checkpoint 14 days after the core deploy: count per subsystem how many days were
  🟡/🔴 and why; a reason that fired every day without a real problem has a wrong
  threshold and is fixed before stage (b).
