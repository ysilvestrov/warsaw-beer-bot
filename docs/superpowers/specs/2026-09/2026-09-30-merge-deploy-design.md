# Merge is the deploy — the host deploys `main` by itself

Date: 2026-09-30
Status: design approved in brainstorming 2026-09-30; probes P1–P4 must run **before** the plan
Supersedes: the tag path of `2026-08/2026-08-16-435-dependency-security-autofix-design.md`
(`autodeploy-*` tags, the lockfile-only guard) and the drift episode of
`2026-08/2026-08-23-autodeploy-drift-signal-design.md` / `2026-08-24-491-497-…`
Spawned: external canary — separate spec (issue filed with this design)

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
| D5 | **Rollback window = 10 min** after restart. A failure inside it rolls back **code AND database** to `pre`, keeping a `post` snapshot for a human to reconcile | Code-only rollback: the old binary against a newer schema is exactly what #611's preflight forbids |
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
| "the migration works on production data" | pre-deploy gate | new `migrate()` on a **copy** of `pre`, run twice (idempotence), then `PRAGMA foreign_key_check` and `PRAGMA integrity_check` empty | strong for crashes and constraint breaks; **silent wrong rewrites are NOT covered**. That still needs a human preflight, and such a PR must carry `[deploy:hold]` |
| "`pre` is a consistent copy of production at T" | snapshot file + sha256 | SQLite backup API from a `mode=ro` connection while the bot runs in WAL | **weak until P1** |
| "restoring `pre` gives the old state, and Litestream does not replay stale WAL over it" | rollback | — | **weak until P2** |
| "the deploy is settled" | end of window, ✅ message | 10 min of `/health` ok **and** `NRestarts` of the unit unchanged since restart | medium: catches crash loops and hangs, not wrong answers. That is D6's accepted limit |
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
4. **Snapshot `pre`**: backup API → `/var/lib/warsaw-beer-bot/deploy-snapshots/<utc>-<sha7>-pre.db`
   plus a `.sha256`. The directory lies outside rsync's reach (`/var/lib`, not `/opt`) and is owned by
   `warsaw-beer-bot`. Write it as the bot user via the existing `bash -lc` rule; P3 confirms that no
   sudoers change is needed.
5. **Trial migration** on a copy of `pre`: `node -e` against the clone's
   `dist/storage/schema.js#migrate`, twice, then both pragmas. Record `schema_version` before/after in
   the journal. Failure → ⛔ + `LAST_FAILED_SHA=X`, and delete the copy (keep `pre` until pruning).
6. **Deploy**: `deploy.sh` from the clone, as today (`deploy_commit`). Record `DEPLOY_STARTED_S`.
7. **Watch window** (10 min): poll `/health` every 10 s and `systemctl show -p NRestarts
   warsaw-beer-bot`. Any failure → step 8. Clean window → `DEPLOYED_SHA=X`,
   `PREVIOUS_SHA=<old>`, ✅ message listing the merged PR numbers in the range.
8. **Rollback** (only inside the window):
   1. record `LAST_FAILED_SHA=X` first (as C3 today);
   2. stop `warsaw-beer-bot`, then `litestream`;
   3. snapshot `post`: copy `bot.db`, `bot.db-wal`, `bot.db-shm` as they are (the bot is stopped, so
      a file copy is consistent) → `<utc>-<sha7>-post/`;
   4. replace `bot.db` with `pre` after verifying its sha256; delete `-wal`/`-shm`; chown to the bot
      user;
   5. `deploy_commit <old DEPLOYED_SHA>`, start `litestream`, start the bot, check health (single
      60 s check, no second window);
   6. 🔥 message: the failing SHA and PRs, both snapshot paths, and the interval of writes that exist
      only in `post` (`pre` time → stop time). A human reconciles; nothing does it automatically.
   A failure inside the rollback → 🔥 ROLLBACK FAILED, as today, plus both snapshot paths.
9. **Prune** after a *settled* deploy: keep the newest 3 `pre` snapshots of settled deploys. A
   `pre`/`post` pair from a rollback is **never** deleted by the machine.

## Holds

**Autodetected paths** (a list in the deployer, tested; changing it is itself a hold path):
`deploy/sudoers.d/**`, `deploy/*.service` and `deploy/*.timer` except `deploy/warsaw-beer-bot.service`
(which `deploy.sh` installs), `deploy/litestream.*`, `deploy/install-*.sh`. Changes to
`deploy/autodeploy*.sh`, `ships.sh`, `read-env.sh` and `installed-current.sh` are already caught by
the staleness check, but they are listed as well, so that the PR-side check (below) warns the
**merger** instead of only the host.

**PR side**: a new CI job `deploy-hold` (not required at first) fails when:
- the title starts with `[deploy:hold]` but the label is missing, or the other way round;
- the diff touches an autodetected path and the title has no marker (the message names the paths).

Since the job is not required, the host does not rely on it. It exists so that whoever presses merge
sees the hold in the title. `CLAUDE.md`/`AGENTS.md` gain the rule: a PR that needs a root step, an
`.env` key or a preflight carries `[deploy:hold]`, and its body lists the steps.

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

## Probes before the plan

- **P1** — backup API from a `mode=ro` connection on the live WAL DB: run it twice, 30 s apart. The
  copies pass `integrity_check`, and a row written between them appears only in the second.
- **P2** — Litestream vs a replaced DB file, on a **throwaway DB path with its own litestream config
  and a local file replica**, never on production: replace the file while litestream is stopped and
  delete `-wal`/`-shm`, then start it. Does it start a new generation, and does a restore from the
  replica give the replaced content rather than the old one?
- **P3** — the timer's user can create `deploy-snapshots/` and write/replace `bot.db` as
  `warsaw-beer-bot` through the existing `bash -lc` rule, and `gh api` works from inside the systemd
  unit's environment (`HOME=/home/ysi`, not a login shell).
- **P4** — duration and peak RSS of `npm ci && npm run build` in the deployer's clone on this host,
  measured under `systemd-run --scope` so it is visible next to code-server's memory limits.

A probe that fails changes this design before a plan is written. It does not become a task in the
plan.

## Testing (for the plan)

`autodeploy.sh` keeps its seam discipline (I2): every external contact is a swappable command. New
seams: CI status, PR labels, snapshot, trial migration, restore, the clock of the watch window, and
`NRestarts`. Tests exercise every branch of the tick with stubs that return **visible** values (see
the stub-default lesson). They must include a rollback triggered at 9:59 and a failure at 10:01 that
does **not** roll back, CI absent vs pending vs failed, a hold introduced by a path and one by a
label, a GitHub API failure read as held, and pruning that never touches a rollback pair. The trial
migration gets one test against a real SQLite file with a real, deliberately broken migration.
