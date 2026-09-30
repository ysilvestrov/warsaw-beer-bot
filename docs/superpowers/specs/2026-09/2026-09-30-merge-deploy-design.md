# Merge is the deploy — the host deploys `main` by itself

Date: 2026-09-30
Status: design approved in brainstorming 2026-09-30; probes P1–P4 ran 2026-09-30. P1 **refuted** the
snapshot mechanism and changed step 4; P2–P4 passed (results under "Probes")
Supersedes: the tag path of `2026-08/2026-08-16-435-dependency-security-autofix-design.md`
(`autodeploy-*` tags, the lockfile-only guard) and the drift episode of
`2026-08/2026-08-23-autodeploy-drift-signal-design.md` / `2026-08-24-491-497-…`
Spawned: #758 — external canary, separate spec

## Why

Features are now written in cloud sessions and on a laptop that cannot reach the server. PR #752 and
#753 (festival mode, schema v42) were merged at 08:04 and 09:39 UTC on 2026-09-30, and production
reached them only because a session **on this host** ran `deploy/deploy.sh`. Nobody else can.

Whether to deploy a merge is not an open question. Since #435, a merge that ships and is not deployed
blocks every security deploy (drift, see #490/#527). So every merge has to be deployed anyway. What is
missing is only the actor.

## The rule this design rests on

> Production runs what was merged into `main` (by a human, or by the Dependabot qualifier's
> auto-merge, D3), after CI passed **on that exact commit**, unless the merge says out loud, in its
> PR title, that a human must be present.

This **replaces** #435's rule ("our own code cannot reach production unattended"). It changes the
threat model on purpose, and the change must be read as such: **write access to `main` now means
production.** Previously, a merge only produced a signal (a tag), and the host re-derived from that
signal whether the change was a lockfile-only remedy. From now on the merge itself is the permission.
The host still re-derives everything it can check locally: ancestry, CI conclusion, holds, build, and
migration.

Pull, not push: the host polls `origin/main`, as the #435 timer already polls tags. No inbound access,
no host credentials in GitHub.

## Decisions

| # | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | Target = the head of `origin/main`, deployed after **10 min of quiet** since the last push | One deploy per merge: today's two festival PRs would have caused two restarts 95 min apart for no gain |
| D2 | The tag path is **deleted** (tags, `autodeploy-tag.yml`, the lockfile allowlist in the guard, drift episodes) | Keeping both: two deployers with different threat models sharing one `DEPLOYED_SHA` |
| D3 | Dependabot qualification **stays**, but its only effect is auto-merge; the merge then deploys by the common path | — it already decides who may merge unattended; that is still a real decision |
| D4 | Before every deploy: DB snapshot `pre` + trial migration of a **copy** of `pre` with the new build | Deploy blind and trust `/health` |
| D5 | **Rollback window = 10 min** after restart. A failure inside it — the bot not healthy within **120 s** of the restart, **3 consecutive** failed `/health` polls, or a change in `NRestarts` — rolls back **code AND database** to `pre`, keeping a `post` snapshot for a human to reconcile (R6) | Code-only rollback: the old binary against a newer schema is exactly what #611's preflight forbids |
| D6 | After the window a deploy is **settled**. Any later failure is an ordinary incident, not a rollback | Unbounded window: a crash at hour 3 is not evidence against the deploy, and the data loss grows with the window |
| D7 | Holds come from **two independent sources**: path autodetection (the host computes it) and a `[deploy:hold]` title marker with a matching `deploy:hold` label | Label only: whoever merges does not see it. Paths only: `.env` keys and preflight steps have no path |
| D8 | A hold is released **by a deploy**, not by editing labels: once `DEPLOYED_SHA` descends from the held commit, the hold is behind us | Unlabel to release: a second bookkeeping step that someone forgets, and the host would have to trust GitHub for it |
| D9 | External canary is **out of scope** (separate spec). This design notes the dependency: the 🔥 messages here are sent by the host that may be failing | Folding it in: the canary covers every cause of failure, not just deploys, and has its own choice (external pinger vs dead-man switch) |

## Claim → evidence

Every place where the system **records something as fact** and later reads it as truth:

| Claim written | Where | What proves it | Strength |
|---|---|---|---|
| `DEPLOYED_SHA=X`: `/opt` holds the tree of X | `state.env`, written by `deploy.sh` | `deploy.sh` rsyncs a clean checkout of X; the deployer's clone is `git clean -xdff` before it (existing I5) | strong — unchanged from #435 |
| "CI passed on X" | read, never stored | GitHub check-runs **on SHA X**: every run completed, none `failure`/`cancelled`/`timed_out`, and the required `ci` present with `success` | strong. The absence of `ci` means **wait**, never pass |
| "X is held" | derived per tick, never stored | (a) paths from `diff(DEPLOYED_SHA, X)` matched by the hold list (computed locally), (b) any PR returned by `commits/<sha>/pulls` for a commit in `DEPLOYED_SHA..X` carries `deploy:hold` | (a) strong; (b) as strong as GitHub's API. If the API is unreachable, treat as **held** (fail closed) |
| "the migration works on production data" | pre-deploy gate | new `migrate()` on a **copy** of `pre`, opened through the **clone's own `openDb`** (so `foreign_keys = ON`, as production, R1), run twice (idempotence), then `PRAGMA foreign_key_check` and `PRAGMA integrity_check` empty. The startup rewrites that run beside `migrate()` in `src/index.ts` (backfills, alias dedupe, ontap cleanup) are **not** trialled | strong for crashes and constraint breaks; **silent wrong rewrites are NOT covered**. That still needs a human preflight, and such a PR must carry `[deploy:hold]` |
| "`pre` is a consistent copy of production at T" | snapshot file + sha256 | `VACUUM INTO` from a `mode=ro` connection: one read transaction, so one point in time (P1) | strong — measured under a concurrent writer and on the production file |
| "restoring `pre` gives the old state, and Litestream does not replay stale WAL over it" | rollback | P2: litestream 0.5.11 (the production version) on a throwaway DB with a file replica | strong for the mechanism; measured once, small DB, file replica rather than R2 |
| "the deploy is settled" | end of window, ✅ message | 10 min without 3 consecutive failed `/health` polls, **and** `NRestarts` read at least once and unchanged from its first successful read (R3). A window the tick did not watch to its end is **never** settled: it ends as ⚠️ unverified (R2) | medium: catches crash loops and hangs, not wrong answers. That is D6's accepted limit |
| `LAST_FAILED_SHA=X` | `state.env` | written only after a failed gate or a rollback, before anything else | strong |

## The tick

The timer stays: `wbb-autodeploy.timer`, every 5 min, runs as `ysi`, own clone in
`~/.local/share/wbb-autodeploy/repo`, lock, `PAUSED` brake. It is renamed in text only; the unit
names stay, so no re-arming is needed.

1. **Fetch** `origin/main` → `X`. If `X = DEPLOYED_SHA`, or nothing in `diff(DEPLOYED_SHA, X)` ships
   (`wbb-ships`, union of both filters, as in #527), stop quietly. A classification failure is
   *cannot assess*: report it once a day, never read it as "nothing ships".
2. **Qualify**, all local except where noted:
   - `X` descends from `DEPLOYED_SHA` (no downgrade; the existing guard check, kept);
   - `X ≠ LAST_FAILED_SHA`;
   - `origin/main` has not moved for ≥ 10 min (D1). The measure is the first tick that saw `X`
     (`MAIN_SEEN_SHA`/`MAIN_SEEN_S` in state), not committer time, which rebase/squash merges set
     but a manual push need not; otherwise wait;
   - CI on `X` as in the evidence table: pending → wait, failed → one ⛔ message per SHA and
     **no** `LAST_FAILED_SHA`. CI is re-read every tick, so re-running a flaky job releases the
     commit by itself;
   - no hold in `DEPLOYED_SHA..X` (D7): held → idle, with a once-a-day message naming the PR(s) and
     what the human must do;
   - the installed deployer is current (`wbb-installed-current`, existing): stale → refuse, as today.
3. **Build in the deployer's clone**, before `/opt` is touched: `npm ci && npm run build`, then
   `npm audit --omit=dev --audit-level=high` (moved here from the tag path; exit 1 = refuse, any other
   non-zero = refuse with "could not verify", as I3 today). A failure leaves production untouched →
   ⛔ + `LAST_FAILED_SHA=X`.
4. **Snapshot `pre`**: `VACUUM INTO` from a `mode=ro` connection (**not** the backup API, P1) → `/var/lib/warsaw-beer-bot/deploy-snapshots/<utc>-<sha7>-pre.db`
   plus a `.sha256`. The directory lies outside rsync's reach (`/var/lib`, not `/opt`) and is owned by
   `warsaw-beer-bot`. Write it as the bot user via the existing `bash -lc` rule (P3: no sudoers
   change). The snapshot is written in `journal_mode=delete`; that is harmless, because litestream
   and the bot's `openDb` both switch it to WAL (P2).
5. **Trial migration** on a copy of `pre`: `wbb-trial-migrate` opens it with the clone's
   `dist/storage/db.js#openDb` and runs `dist/storage/schema.js#migrate` twice, then both pragmas.
   Record `schema_version` before/after in the journal. Failure → ⛔ + `LAST_FAILED_SHA=X`; delete the
   copy **and** discard `pre` (R9: it recorded no deploy, and prune must not count it).
6. **Deploy**: first record the window in state (`WINDOW_SHA=X`, `WINDOW_OLD=<old>`,
   `WINDOW_PRE=<pre>`, `WINDOW_START=<now>`, R2), then `deploy.sh` from the clone with
   `WBB_TICK_HOLDS_LOCK=1` (R4). `deploy.sh` itself records `DEPLOYED_SHA=X`.
7. **Watch window** (10 min): wait up to 120 s for the first healthy `/health`, then poll `/health`
   and `systemctl show -p NRestarts warsaw-beer-bot` every 10 s. Rollback (step 8) on 3 consecutive
   failed polls or on a changed `NRestarts`. An unreadable `NRestarts` poll is neither a change nor a
   pass; if no poll ever read it, the window ends ⚠️ unverified (R3). Clean window → `DEPLOYED_SHA=X`,
   `PREVIOUS_SHA=<old>`, window cleared, ✅ message listing the merged PR numbers in the range.
7a. **Interrupted window** (R2). A tick that finds `WINDOW_SHA` in state knows a previous tick died
   inside the window (reboot, OOM, `TimeoutStartSec`, `systemctl stop`). If `DEPLOYED_SHA =
   WINDOW_SHA` and the window has time left, it watches the **rest** of it and then settles or rolls
   back to `WINDOW_OLD`. If the window is over, it marks `pre` as `-unverified-pre.db` (kept like a
   rollback pair) and sends ⚠️ "X is live but its window was not watched to the end". If `DEPLOYED_SHA
   ≠ WINDOW_SHA`, `deploy.sh` never finished: ⚠️ "deploy of X was interrupted before it completed".
   In both cases the window is cleared and the ordinary tick continues.
8. **Rollback** (only inside the window):
   1. record `LAST_FAILED_SHA=X` first (as C3 today);
   2. stop `warsaw-beer-bot`, then `litestream`;
   3. snapshot `post`: copy `bot.db`, `bot.db-wal`, `bot.db-shm` as they are (the bot is stopped, so
      a file copy is consistent) → `<utc>-<sha7>-post/`;
   4. as the bot user: verify `pre`'s sha256, copy it to a temp file next to `bot.db`, `mv -f` over
      `bot.db`, delete `-wal`/`-shm` (P3: atomic, no chown needed). Do **not** run `litestream reset`:
      P2 shows litestream detects the replaced file by itself;
   5. start `litestream`, `deploy_commit <old>` (whose `deploy.sh` restarts the bot and re-records
      `DEPLOYED_SHA=<old>`), check health (a single 120 s check, no second window);
   6. 🔥 message: the failing SHA and PRs, both snapshot paths, and the interval of writes that exist
      only in `post` (`pre` time → stop time). A human reconciles; nothing does it automatically.
      A third copy of the `post` state stays in R2's history: P2 restored it with
      `litestream restore -txid <before the replace>`.
   A failure inside the rollback → 🔥 ROLLBACK FAILED, as today, plus both snapshot paths.
9. **Prune** after a *settled* deploy: keep the newest 3 `pre` snapshots of settled deploys. A
   `pre`/`post` pair from a rollback, and an `-unverified-pre.db`, are **never** deleted by the
   machine.

## Holds

**Autodetected paths** (a list in the deployer, tested; changing it is itself a hold path):
`deploy/sudoers.d/**`, `deploy/*.service` and `deploy/*.timer` except `deploy/warsaw-beer-bot.service`
(which `deploy.sh` installs), `deploy/litestream.*`, `deploy/install-*.sh`, and
**`deploy/rsync-filter`** (R5). Changes to
`deploy/autodeploy*.sh`, `ships.sh`, `read-env.sh` and `installed-current.sh` are already caught by
the staleness check, but they are listed as well, so that the PR-side check (below) warns the
**merger** instead of only the host.

**PR side**: a new CI job `deploy-hold` (not required at first) fails when:
- the title starts with `[deploy:hold]` but the label is missing, or the other way round;
- the diff touches an autodetected path and the title has no marker (the message names the paths).

Since the job is not required, the host does not rely on it. It exists so that whoever presses merge
sees the hold in the title. `CLAUDE.md`/`AGENTS.md` gain the rule: a PR that needs a root step, an
`.env` key or a preflight carries `[deploy:hold]`, and its body lists the steps.

**Manual deploys and the tick exclude each other** (R4): `deploy.sh` takes the tick's lock
(`~/.local/state/wbb-autodeploy/lock`, waiting up to 30 s) unless it was started by the tick itself
(`WBB_TICK_HOLDS_LOCK=1`). While a tick watches a window, a manual deploy refuses and says until when.

**Release**: the human does the steps on the host, then runs `bash deploy/deploy.sh` from the main
checkout (it records `DEPLOYED_SHA`). The next tick finds no hold in the range and continues.

## Notifications (Telegram, not via the bot — unchanged principle)

| Event | Message | Cadence |
|---|---|---|
| settled | ✅ `<sha7>` live — PRs #a #b | per deploy |
| gate refused (CI red, build, audit, migration trial) | ⛔ with the gate and its output (truncated as I6) | once per SHA |
| held | ⏸ production is behind `main`: held by #n — `<steps from PR body>` | once a day |
| cannot assess | ⚠️ as today's #527 text | once a day |
| rollback done | 🔥 with snapshots and the loss interval | per event |
| rollback failed | 🔥 ROLLBACK FAILED | per event |
| stale deployer | ⚠️ as today | once a day |
| window not watched to its end (R2) or `NRestarts` never readable (R3) | ⚠️ X is live but unverified; `pre` kept as `-unverified-pre.db` | per event |

The drift episode (`DRIFT_SINCE`, 15-min grace, "✅ caught up") is deleted. Drift is now either work
in progress, or one of the rows above, which say why it is not.

## What is deleted

- `.github/workflows/autodeploy-tag.yml` and every `autodeploy-*` tag on origin (the last is
  `autodeploy-20260825T073442Z`, which is also #498's permanent `LAST_FAILED_SHA` residue; the new
  state file is written without it).
- The lockfile-only allowlist in `autodeploy-guard.sh`. The ancestry, downgrade and resolve checks
  (C1) stay, whether in the guard or folded into the deployer; the plan decides where.
- `report_drift_once`, `DRIFT_SINCE`, `LAST_DRIFT_NOTICE`.
- In `dependabot-qualify.yml`: the comments and the label semantics that refer to the tag. The label
  `autodeploy` is renamed `automerge` (plan: check nothing else reads it).
- #498 and #499 become moot; close them referencing this design.

`deploy.sh` stays **unchanged**: it is still the manual path, and it is what releases a hold.

## `spec.md` and docs

`spec.md` gains a short "Deployment" subsection: the rule above, holds, rollback window, snapshots.
`deploy/README.md`'s #435 section is rewritten. `CLAUDE.md` and `AGENTS.md` gain the `[deploy:hold]`
rule.

## Rollout

The PR implementing this is itself `[deploy:hold]`: it changes `deploy/*.sh` and the units. After the
merge a human runs `sudo bash deploy/install-autodeploy.sh` and `bash deploy/deploy.sh`. The first
merge after that is the live test, **pre-registered**: before it, write down the expected journal
lines and messages, as #527's live test did.

## Amendments after the core review (2026-09-30)

An end-to-end review of the implemented core (Tasks 1–5) found defects no test caught. Each one
changed the design above as follows. The original wording is replaced inline; the reasons live here.

- **R1 — the trial ran with foreign keys OFF, production runs them ON.** `openDb` sets
  `foreign_keys = ON` before `migrate()`; the trial used a bare connection. A table rebuild with child
  rows pointing at it passed the trial and would crash-loop production (reproduced by the reviewer).
  The trial now opens the copy with the clone's own `openDb`.
- **R2 — a tick killed inside the window settled silently.** `deploy.sh` records `DEPLOYED_SHA=X`
  before the window, so the next tick saw "up to date": no ✅, no rollback, `pre` unmarked (prune
  would delete it). The window is now state (`WINDOW_*`), and the next tick finishes or reports it
  (step 7a).
- **R3 — an unreadable `NRestarts` either disabled the restart check for the whole window (empty
  baseline) or rolled back on one failed read.** Now the baseline is the first successful read, an
  unreadable poll is skipped, and a window with no read at all is not settled.
- **R4 — a manual `deploy.sh` during the window was not deferred to** (the comment said it was; the
  lock never covered `deploy.sh`). The tick could restore the DB and redeploy `old` over a human's
  release. `deploy.sh` now takes the same lock.
- **R5 — `deploy/rsync-filter` was not a hold path.** Under #435 a narrowing filter was "ships →
  BLOCKED, tell a human"; under merge-deploy the same union logic meant "ships → deploy". With
  `--delete --delete-excluded`, a narrowing empties `/opt` or silently drops `scripts/`. The filter is
  the operand of a root command pinned in sudoers, so it is held like sudoers.
- **R6 — one failed `/health` probe (3 s timeout) rolled back the database.** A 3-s event-loop stall
  would rewind production. Now 3 consecutive failures (~30 s). The startup limit rose from 60 s to
  120 s, because the API listens only after `registerCommandMenu`, a Telegram call.
- **R7 — "could not resolve API_PORT" was unreachable.** A failed read fell back to 3000. A failed
  read now refuses the deploy; an empty value is still the application default 3000.
- **R9 — a trial refusal left an unmarked `pre`** that prune counted as a settled deploy. It is now
  discarded.
- **Not changed (R8):** after a failed rollback, state says `DEPLOYED_SHA=<old>` while `/opt` may
  hold X. The 🔥 message goes to a human in either case, and any "more correct" value would be a
  guess.

## Probes (run 2026-09-30, before the plan)

**P1 — snapshot consistency. The backup API is REFUTED; `VACUUM INTO` is confirmed.**
- A throwaway WAL DB with a writer inserting balanced row pairs (`+i`, `-i`) in transactions for 20 s,
  and `.backup` from a `mode=ro` connection started 2 s into the run. `.backup` **took 18 462 ms**:
  it finished only when the writer stopped, and all 12 copies held the writer's *final* state. The
  backup API restarts on every foreign write, so against a bot that writes steadily it can wait
  indefinitely. That rules it out for a step inside a deploy tick.
- `VACUUM INTO` from `mode=ro` under the same writer: 5 copies at 246–1354 ms, **during** the writes,
  with counts growing 47 752 → 349 046, every copy `sum(v) = 0` and `integrity_check = ok`. Each is
  one consistent point in time.
- On the production file (`mode=ro`, into scratch): 789 ms, 19.9 MB, `integrity_check = ok`, sorted
  dumps identical to the live DB (the unsorted dump differs only in DDL order), and `rowid,*` equal in
  all 41 rowid tables. `VACUUM` may renumber the implicit rowids of tables without an `INTEGER PRIMARY
  KEY`; none of our code reads `rowid` (only `beers.id`), so a renumbering could not be observed
  anyway.
- The production DB received no writes during the 15-min probe window, so "a row written between two
  snapshots appears only in the second" was proven on the throwaway DB, not on production.

**P2 — litestream vs a replaced DB file: PASS.** litestream 0.5.11 (the production version), file
replica, scratch paths only. The sequence: 100 `base` rows, replicate, `VACUUM INTO pre`, 50 `post`
rows replicated (txid 2), stop, replace the file with `pre`, delete `-wal`/`-shm`, start, insert 1
`after` row, stop. `litestream restore` (latest) → `base 100 + after 1`, **no `post` rows**; `restore
-txid 0000000000000002` → `base 100 + post 50`. So litestream picks up the replaced file without
`reset`, and the pre-rollback history remains restorable. Not covered: an R2 replica, or a DB of
production size.

**P3 — privileges: PASS.** As `warsaw-beer-bot` via the existing `bash -lc` rule: create a directory
in `/var/lib/warsaw-beer-bot`, `VACUUM INTO` there, `mv -f` a copy over a DB file with `-wal`/`-shm`
present, delete them, verify sha256 — exit 0, no password (probe directory removed). `sudo -n -l`
lists `stop/start litestream` and `warsaw-beer-bot` as NOPASSWD. `gh api …/check-runs` under
`env -i HOME=/home/ysi PATH=/usr/local/bin:/usr/bin:/bin` (the unit's environment) → `["success"]`.
Snapshots come out `0644`, the same exposure as `bot.db` itself (world-readable today). Tightening
both is a separate question and is not changed here.

**P4 — build cost: PASS.** In a clone at `2f6a25c`: `npm ci` 5 s / peak 421 MB RSS (process tree,
sampled at 0.5 s; warm `~/.npm` cache, which the deployer's user keeps), `npm run build` (`tsc`) 2 s /
616 MB, `npm audit` 2 s / 104 MB. 5.6 GB available. `systemd-run --user` is unavailable for `ysi` (no
user manager), so this was measured by sampling rather than by a cgroup.
**Bonus, trial migration:** the new build's `migrate()` on a copy of the real `bot.db.pre-v22` file:
v21 → v42 in 450 ms, the second call 0 ms, `foreign_key_check` empty, `integrity_check = ok`. On the
current snapshot (already v42) it is a no-op. The step-5 mechanism works as written.

## Testing (for the plan)

`autodeploy.sh` keeps its seam discipline (I2): every external contact is a swappable command. New
seams: CI status, PR labels, snapshot, trial migration, restore, the clock of the watch window, and
`NRestarts`. Tests exercise every branch of the tick with stubs that return **visible** values (see
the stub-default lesson). They must include a rollback triggered at 9:59 and a failure at 10:01 that
does **not** roll back, CI absent vs pending vs failed, a hold introduced by a path and one by a
label, a GitHub API failure read as held, and pruning that never touches a rollback pair. The trial
migration gets one test against a real SQLite file with a real, deliberately broken migration.
