# Deploy

## One-time host setup (as root)

```bash
useradd -r -m -s /usr/sbin/nologin warsaw-beer-bot
install -d -o warsaw-beer-bot -g warsaw-beer-bot \
  /etc/warsaw-beer-bot /var/lib/warsaw-beer-bot /opt/warsaw-beer-bot
cp .env.example /etc/warsaw-beer-bot/.env
chmod 600 /etc/warsaw-beer-bot/.env
chown warsaw-beer-bot:warsaw-beer-bot /etc/warsaw-beer-bot/.env
# edit /etc/warsaw-beer-bot/.env — set TELEGRAM_BOT_TOKEN and
# DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db
```

The `-m` flag on `useradd` is important — npm needs a writable `$HOME`
for its cache and logs. `deploy.sh` also creates the home dir defensively
in case the user already exists without one.

### Node 24

Before starting a major-version change, hold the merge-deploy brake for the whole procedure — see
"Emergency stop" below — so no merge can deploy mid-flight while the host is between
runtimes:

```bash
mkdir -p ~/.local/state/wbb-autodeploy
touch ~/.local/state/wbb-autodeploy/PAUSED
```

Install system-wide (the systemd unit calls `/usr/bin/node`):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
apt-get install -y nodejs build-essential python3
```

Before changing the NodeSource major, download the current `.deb` first — rewriting
`/etc/apt/sources.list.d/nodesource.sources` removes the old major from the apt index, and there is
no local cache to fall back on:

    mkdir -p ~/nodejs-rollback && cd ~/nodejs-rollback && apt-get download nodejs=<current version>

`better-sqlite3` is a native addon compiled from source on this host, so it must be rebuilt against
the new ABI in the same sitting: stop `warsaw-beer-bot` (and `48-hours-trip`, which shares
`/usr/bin/node`), install the new major, then run `deploy/deploy.sh`, whose `npm ci` does the rebuild.
A restart in between comes up on the new interpreter with the old `.node` and fails to start.
(Flat, until the switchover session: after it the bot runs from its image, whose Node and native addons
come from CI, and the host's Node no longer runs the bot.)

`build-essential` + `python3` are needed for the `better-sqlite3` native build.

**If a previous move was rolled back**, `apt-mark hold nodejs` is still set — the rollback path pins
it deliberately, so an unattended `apt upgrade` cannot quietly re-attempt the move that was just
backed out of. Clear it before this procedure's `apt-get install`, or the install silently upgrades
nothing and the next version check fails with both services already stopped:

    apt-mark unhold nodejs

Release the brake only after both services are confirmed healthy on the new runtime:

```bash
rm ~/.local/state/wbb-autodeploy/PAUSED
```

### Operator sudo + journal access

The deploy script and routine maintenance commands run a fixed set of
privileged operations. To run them without a password prompt, install the
NOPASSWD sudoers fragment shipped in this repo and put the operator user in
the `systemd-journal` group:

```bash
# As root (one time per host). The visudo -cf check rejects malformed files,
# so an accidental edit can't lock you out of sudo.
visudo -cf deploy/sudoers.d/warsaw-beer-bot
install -m 0440 -o root -g root \
  deploy/sudoers.d/warsaw-beer-bot /etc/sudoers.d/warsaw-beer-bot

# `journalctl -u <unit>` works without sudo for members of systemd-journal.
usermod -aG systemd-journal ysi
# The new group takes effect on the next login (or `newgrp systemd-journal`).
```

The sudoers fragment is scoped to specific binaries with pinned arguments
(see `deploy/sudoers.d/warsaw-beer-bot` for the full list). It does not
grant the operator extra capability — the operator is already in the `sudo`
group — it only removes the password prompt for the scoped commands.

If the operator user is not `ysi`, edit `deploy/sudoers.d/warsaw-beer-bot`
and replace `ysi` with the correct username before installing.

## Deploy

### Operator test diagnostics and morning report

Test-directory inventory is diagnostic information in the morning report.
Directory appearance and disappearance send no separate Telegram notification.
Existing inode/disk warning, critical and recovery notifications keep their
thresholds. The report's count covers managed test runs only; it is not proof
that a directory is abandoned or safe to delete.

The operator's five-minute monitor exports a small snapshot to
`/var/tmp/wbb-resource-monitor/summary.json`. Its directory is operator-owned
0755 and its file is 0644 so the bot can read counters without access to the
private monitor state. The report marks snapshots older than 15 minutes as stale,
and missing/invalid data as unavailable. Busy, failed or truncated inventory
does not become zero. No bot environment key is needed.

Run the production monitor as `ysi`, the operator account in the shipped sudoers.
The reader checks the snapshot owner against that account's system UID, obtained
independently with `/usr/bin/id -u ysi`. An unrelated local account cannot supply
a trusted snapshot by creating a directory and file with matching owners. If
installing under another operator account, update this lookup together with the
sudoers account. Lookup or descriptor-close failures leave telemetry unavailable
and allow the rest of the morning report to send.

Changes to the installed monitor use `[deploy:hold]`. After merging, update a
clean operator checkout to `main`, then run as the operator:

```bash
bash deploy/install-resource-monitor.sh
```

This refreshes the immutable installed copies and managed cron, preserving
other jobs, private history and resource delivery acknowledgements. Verify the
managed cron includes `--summary-dir /var/tmp/wbb-resource-monitor`. Wait for its
next tick, or run the installed monitor once with `--notify none`, its existing
state/runs directories and that summary directory. None mode publishes the
snapshot without sending Telegram or acknowledging resource alerts.

Verify the actual service user can read the fresh snapshot, then release the
held deployment with `bash deploy/deploy.sh`. Check `/health` and render the
line locally as the bot user; this does not send a report:

```bash
sudo -n -u warsaw-beer-bot /usr/bin/bash -lc 'node -e '\''console.log(require("/opt/warsaw-beer-bot/dist/jobs/test-diagnostics.js").readTestDiagnosticsLine(new Date()))'\'''
```

Do not widen permissions on `.local/state/wbb-resource-monitor` or remove its
state to silence inventory notifications. Installing the new monitor is the
step that disables them; deploying bot code alone cannot update an old cron copy.

**Flat, until the switchover session.** What follows describes the previous flat `deploy.sh` (rsync
into `/opt`, build on the host), which the host's old installed tooling still is until the session;
since stage «в» `deploy/deploy.sh` in the repo is the image wrapper (Manual commands, below), and the
old script is in git history (`git show d8c7ff6^:deploy/deploy.sh`).

From a dev checkout:

```bash
./deploy/deploy.sh
```

`deploy.sh` copies only the build and runtime paths listed in
`deploy/rsync-filter`; `--delete-excluded` also removes anything outside that
allowlist from `/opt/warsaw-beer-bot`. The rsync command is pinned verbatim in
the sudoers fragment. When either the command or filter mechanism changes,
install the matching sudoers fragment **before** running the updated script:

```bash
sudo visudo -cf deploy/sudoers.d/warsaw-beer-bot
sudo install -m 0440 -o root -g root \
  deploy/sudoers.d/warsaw-beer-bot /etc/sudoers.d/warsaw-beer-bot
./deploy/deploy.sh
```

`deploy.sh` must run as the operator, never via `sudo` (it calls sudo itself,
per step). It waits up to 30 s for the merge-deploy lock and refuses while a
tick watches a rollback window.

Before any privileged command, under that lock, it also checks that HEAD
contains the recorded `DEPLOYED_SHA`. A backwards or divergent HEAD, or
a recorded commit missing from the checkout, refuses before touching `/opt`.
Update the checkout first. A missing/empty baseline permits a first deploy;
unreadable or duplicate baseline records refuse. This check uses local Git
history and does not fetch `origin/main`.

Admission proves ancestry of HEAD, not the contents of a dirty working tree.
Dirty deployments keep the existing behavior: they clear DEPLOYED_SHA because
the copied files cannot be identified by a commit. A subsequent empty-baseline
deploy can reseed it; the guard cannot prove ancestry in that case. Use clean
checkouts for deployments whose identity the tick must track.

For a **deliberate rollback or recovery**, `bash deploy/deploy.sh --force`
bypasses ancestry admission and logs both SHAs. Root refusal and locking
still apply. This flag does not restore the database or make old code
compatible with newer migrations: the automatic rollback restores its
snapshot separately before using the flag.

Subsequent deploys:

```bash
git pull
./deploy/deploy.sh
```

## Operate

```bash
systemctl status warsaw-beer-bot       # no sudo: status is unprivileged
journalctl -u warsaw-beer-bot -f       # no sudo: operator is in systemd-journal
sudo systemctl restart warsaw-beer-bot # NOPASSWD via /etc/sudoers.d/warsaw-beer-bot
```

Database maintenance commands run inside the bot's container after the switchover (stage «в»):
the same image, `.env` and data (spec §3.4). Until then, from the flat tree as the service user.

```bash
# after the switchover
sudo podman exec warsaw-beer-bot npm run rearm-matcher-bug-orphans
sudo podman exec warsaw-beer-bot npm run rearm-matcher-bug-orphans -- --apply
# until the switchover (flat tree)
sudo -n -u warsaw-beer-bot bash -lc \
  'cd /opt/warsaw-beer-bot && npm run rearm-matcher-bug-orphans'
```

## Merge-deploy (unattended deploy of `main`, as an image)

Designs: `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md` (the gates) and
`docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md` (the image, §4, §7).
A timer (`wbb-autodeploy.timer`, every 5 min, runs as the operator) deploys the head of
`origin/main` by itself. **A merge is the permission**: write access to `main` means production. The
host re-derives everything else, from its own clone in `~/.local/share/wbb-autodeploy/repo` (never
your checkout).

**Until the switchover session of stage «в»** the host still runs the installed copy of the previous
flat deployer (build on the host, rsync to `/opt`, code+DB rollback); its runbook is in git history
(`git show d8c7ff6^:deploy/README.md`). After the session, everything below holds.

### Switchover session (stage «в»)

**Between the merge and the switchover session.** The old timer keeps running the installed flat
deployer. It deploys nothing: its copy no longer matches `main`, so it waits and reports "the installed
deployer is out of date" once a day — ignore it until the session, and do not run the installer early.
The wrapper `bash deploy/deploy.sh` refuses (the installed copy is not this checkout's controller).
Production is frozen from the merge until the bootstrap, so merge at the start of the session.

The session is one sitting, in this order; each step says what to do when it refuses. Plan:
`docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md` ("Рішення" п.6–7). Work
in **one checkout of `main` on the host** (the one you run `deploy.sh` from), as the operator, inside
**tmux or screen**: the rehearsal (step 5) takes about an hour and uses the `sudo` ticket of that
terminal session — a dropped SSH session hangs it up, and `setsid`, `nohup` into a new session or cron
do not see the ticket at all.

**Abort rule.** Up to step 5, aborting is: `sudo systemctl enable --now wbb-autodeploy.timer` — the host
is back where it was before the session (the old timer, frozen production, nothing migrated). From
step 6 on the old timer must not run again (its `state.env` is a directory now): if you must stop
between step 6 and step 8, leave the timer **disabled** — the flat bot keeps running untouched — and
resume at the step you stopped on.

1. **Merge the stage «в» PR** (`[deploy:hold]`) at the start of the session, and wait for CI on the
   merge commit: the `image` job must have published and attested its image (step 4 checks it). Then
   in the checkout: `git switch main && git pull`.
2. **Stop the timer:** `sudo systemctl disable --now wbb-autodeploy.timer`. `disable` too, not only
   `stop`: a reboot during the session must not bring the old timer back.
3. **Wait for the running tick:** `systemctl is-active wbb-autodeploy.service` must say `inactive` (or
   `failed`) and `fuser -v ~/.local/state/wbb-autodeploy/lock` must show nobody. A flat tick that is
   watching a deploy window holds both for up to ~12 min; do not kill it.
4. **Preflight:** `sudo -v && bash scripts/ops/switchover-preflight.sh`. Read-only (no state, no lock,
   no git ref is written; `origin`'s head is read with `git ls-remote`). One line per check —
   `PASS`, `FAIL` with what to do, or the one `EXPECTED` — then
   `RESULT: PASS|FAIL (<n> PASS, <n> EXPECTED, <n> FAIL)`; exit 0 only without a `FAIL`:

   | Check | PASS when |
   |---|---|
   | `timer`, `service` | `wbb-autodeploy.timer` disabled and inactive, `wbb-autodeploy.service` inactive |
   | `lock` | the deploy lock is free (opened read-only; a missing file is free) |
   | `state` | `state.env` is a regular file the migration (step 6) accepts — its own key lists and rules — with no `WINDOW_*`/`ROLLBACK_STARTED` |
   | `deployed` | `DEPLOYED_SHA` is there and an ancestor of `origin/main` |
   | `image-state` | no `image-state.env` yet |
   | `helper` | `sudo bash deploy/install-image.sh --check` is clean. **`EXPECTED`** when its only difference is exactly `DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (content)` + `1 difference(s): …` — the installed helper predates this checkout's (`reset-failed` in `activate`), step 7 reinstalls it. Any other difference is a `FAIL` |
   | `gh` | `gh attestation verify --help` knows `--source-digest` and `--deny-self-hosted-runners` |
   | `checkout` | clean (`git status --porcelain` empty) and HEAD = `origin/main`'s head |
   | `image` | HEAD's tag resolves to a digest that passes `gh attestation verify` — the controller's own two calls, read from `deploy/autodeploy.sh` |
   | `quadlet` | no `/etc/containers/systemd/warsaw-beer-bot.container` |
   | `space` | ≥ 5 GiB free in `/var/lib/containers` and `/var/lib` |
   | `old-checkouts` | no copy of the repo under `~` or `/root` whose flat `deploy/deploy.sh` lacks the `state.env` guard (spec §8 п.3): such a copy would rsync the flat tree and reinstall the old unit over the Quadlet one. `git pull` or remove each it names; copies with the guard are listed for information |
   | `rehearsal` | nothing of `wbb-rehearsal` is left: `/var/lib/wbb-rehearsal`, its Quadlet file, `/etc/systemd/system/wbb-rehearsal.service`, the unit, the container |

   Without a sudo ticket it refuses before any check (`REFUSED: … run sudo -v first`). If `checkout`
   and `deployed` say "cannot read origin's main" and `git ls-remote origin main` prints
   `GitHub is temporarily limiting some unauthenticated downloads`, that is #583: wait and run it
   again. Fix every `FAIL` and run it again until `RESULT: PASS`.
5. **Rehearsal** (spec поправка 4; `scripts/ops/rehearsal/`): the checkout's controller and the
   checkout's helper go through the scenarios on a test unit `wbb-rehearsal`, against the real
   podman, systemd, GHCR and attestation, on a copy of the production database. Pick **S** and
   **D**, two commits of `main` with published images, S an ancestor of D, with different
   `wbb.content` and no `migration:contract`/`rollback:unsafe` PR between them (D = the head of
   `main` is a good choice; `git log --first-parent --format='%H %ad %s' --date=short origin/main`
   for S). Then, in tmux/screen:

   ```bash
   sudo -v
   bash scripts/ops/rehearsal/run.sh <S-sha> <D-sha>
   ```

   - **About an hour** (four 600 s windows plus pulls and trials). It keeps the ticket alive itself
     (`sudo -n -v` every minute); every `sudo` in it is `sudo -n`, so a lapsed ticket is a loud
     failure, never a password prompt.
   - Before it creates anything it refuses (`REFUSED: …`, nothing created) when a precondition does
     not hold: the timer or its service active, a leftover kit, production's Quadlet file present,
     the port in use, < 5 GiB, S/D not as above (no image, same `wbb.content`, a contract PR in the
     range). Pick other S/D or fix the cause, then run it again.
   - **The kit bot is a real bot on a copy:** its crons make real outbound requests (the same sites
     as production) and it writes only into the copy `/var/lib/wbb-rehearsal/data/bot.db`. Telegram is
     unreachable for it (`api.telegram.org` → 127.0.0.1, a fake token, no `.env`), and the
     controller's messages go to a file of the kit — nothing reaches Telegram.
   - **Firewall:** during the rehearsal the kit listens on **port 3917 on the host network**
     (`Network=host`, its `/health`). If the host firewall lets that port in from outside, close it
     for the hour.
   - **The summary** comes after the cleanup:
     `=== rehearsal summary ===`, `S=… D=…`, then `PASS|FAIL|SKIP` for each scenario —
     (а) bootstrap S, (б) deploy D, (в) a sick candidate rolled back, three (г) interruptions, (ґ) a
     unit that is not ours — then `PASS cleanup`, `PASS production unchanged`, the three **P3** lines
     and `RESULT: PASS (9/9)`. A failed scenario prints why and the end of the controller's output;
     the later ones are `SKIP`.
   - **P3** (`P3 pull: <n>s`, `P3 audit: <n>s`, `P3 trial: <n>s`, from (а)) is how long the first
     pull, audit and trial took on this host: the trial and the activation are the bootstrap's
     downtime (step 8). Keep the three lines for the session's record (spec P3).
   - **If it FAILs** (any scenario, `cleanup`, or `production unchanged`): **stop the session.** The
     timer stays disabled and production was not touched (that is what `production unchanged`
     states; a `!!! PRODUCTION CHANGED` banner means look at `warsaw-beer-bot` first). To abort:
     `sudo systemctl enable --now wbb-autodeploy.timer` (the abort rule above). `CLEANUP FAILED: <step>
     — <command>` lines and the recipe printed after them are the commands to remove what is left by
     hand; afterwards `bash scripts/ops/switchover-preflight.sh` must show `PASS rehearsal`.
6. **Migrate the state:** `bash deploy/migrate-state-to-image.sh` (Migrating the flat deployer's
   state, below — what it carries, its refusals, and the table for an interrupted run).
7. **Install, in this order**, from the same clean checkout:

   ```bash
   sudo bash deploy/install-image.sh            # reinstalls the helper (reset-failed in activate)
   sudo bash deploy/install-image.sh --check    # must say: every installed copy matches HEAD
   sudo bash deploy/install-autodeploy.sh       # the image controller and its copies
   sudo bash deploy/install-host-patch-collector.sh
   ```

   `install-image.sh` refuses on a dirty checkout or when `quadlet -dryrun` rejects the template
   (Root helper `wbb-image`, below); `install-autodeploy.sh` refuses unless `--check` is clean, and
   after installing it checks the copies with `wbb-installed-current` (Install / upgrade, below). Any
   refusal changes nothing: fix it and run that line again. The collector's installer is safe for the
   frozen flat bot: `summary.json` keeps its shape, the unit and the image go into a separate
   `image.json`; before the bootstrap `python3 -m json.tool /var/tmp/wbb-host-patch/image.json`
   shows `"unit": "foreign"` and `"deployed_digest": null`.
8. **Bootstrap:** `bash deploy/deploy.sh --bootstrap`, the printed root steps, then
   `bash deploy/deploy.sh --bootstrap` again — The first image release (bootstrap), below, with the
   way back on every refusal; a failed window is After a failed bootstrap, below.
9. **Start the timer:** `sudo systemctl enable --now wbb-autodeploy.timer`.
10. **Check the first tick and the status.** Within 5 min:
    `journalctl -u wbb-autodeploy.service -n 30` shows a tick that exited 0 (nothing to deploy: the
    bootstrapped HEAD is `main`); `wbb-autodeploy --check-state` → `STATE OK`;
    `sudo -n /usr/local/libexec/wbb-image current` → `unit=quadlet` and the bootstrapped digest. The
    host collector runs hourly (`sudo systemctl start wbb-host-patch.service` to run it now); the
    next daily status then carries the footer **`unit=quadlet · образ <12 hex> (= задеплоєного)`**.
    `≠ задеплоєного`, `⚠️ unit=foreign` or `unit=absent` there means production does not run what
    the controller recorded: compare `wbb-image current` with `DEPLOYED_DIGEST` in
    `~/.local/state/wbb-autodeploy/image-state.env` before anything else (Messages, below, for what
    the controller itself said).

### When a merge is deployed

Each tick, in this order (the controller is `deploy/autodeploy.sh`, installed as
`/usr/local/bin/wbb-autodeploy`; its state is parsed and validated, never sourced):

0. no open INCIDENT, the state is valid, PAUSED and the lock (below);
1. an open window is finished first (spec §7.2);
2. the observed production record has not regressed (below); production is an ancestor of `main`;
3. `main` has not moved for **10 minutes**;
4. the installed copies are current (`wbb-installed-current`: the controller, `read-env`,
   `db-snapshot`, `installed-current`, the helper and its template);
5. **no hold** in `DEPLOYED_SHA..main` (below);
6. CI concluded on **that exact commit**: `ci` and `image`, green, in one check suite.

Then: the tag `<sha>` resolves to a digest, `gh attestation verify` proves CI built it from `main`,
`wbb-image pull`. Equal `wbb.content` with what runs → **noop** (recorded, no restart). Otherwise:
`npm audit` in the image (high/critical → the SHA fails), the settled image is local, a DB snapshot
(`VACUUM INTO`), and the trial on a copy: migrate twice, start the candidate, then **compat** — the
settled image must start on the database the candidate migrated (`COMPAT FAILED` holds that pair for
a human: `bash deploy/deploy.sh --ack-incompatible`).

### Holds

A deploy that needs a human on the host is **held**, never attempted:

- the range changes a path that needs root or an install step: `deploy/sudoers.d/**`,
  `deploy/*.service` / `*.timer` (except `warsaw-beer-bot.service`), `deploy/litestream.*`,
  `deploy/install-*.sh`, `deploy/rsync-filter`, an installed copy (`deploy/autodeploy.sh`,
  `read-env.sh`, `db-snapshot.sh`, `installed-current.sh`), the helper `deploy/image/helper/**` or the
  Quadlet template;
- or a PR in the range carries `deploy:hold` (title starts with `[deploy:hold]`; the `deploy-hold` CI
  check flags a mismatch; the body lists the steps);
- or a PR carries `rollback:unsafe` / `migration:contract`: a code-only rollback is not proven safe,
  so only a human deploys it, without an automatic rollback (`--ack-incompatible`).

**Release:** do the steps, then run `bash deploy/deploy.sh` from a clean checkout of `main`. The run
is the acknowledgement; it deploys HEAD through the same gates and window (or records a noop).

### The rollback window

After `activate` the tick watches production for **10 minutes**: `/health` (with `releaseSha`),
`NRestarts` (0 right after the activation — a restart resets it, spec V14), the unit state and what
runs from the Quadlet file. A failure rolls back **code only**, to the last settled image; the
database is never restored automatically (two-step migrations, CLAUDE.md). The pre snapshot of a
failed window is kept (`mark-rollback`) until an incident is resolved. A rollback that cannot bring
the settled image back opens an **INCIDENT**: nothing deploys until `bash deploy/deploy.sh
--resolve-incident --settled <sha>` (or `--flat`, while nothing is settled).

Snapshots live in `/var/lib/warsaw-beer-bot/deploy-snapshots/`, owned by the bot user:
`<UTC>-<sha7>-pre.db` + `.sha256`. The newest 3 settled are kept; `*-rollback-pre.db` are kept until
a resolve returns them to ordinary retention (`db-snapshot.sh unmark`).

### Production moved backwards or diverged

Design: `docs/superpowers/specs/2026-10/2026-10-01-767-768-deploy-regression-design.md`. The tick
remembers the last deployed commit it observed (`LAST_SEEN_DEPLOYED_SHA`, written only for proven
forward motion). A record that went backwards (a `--force` downgrade) or diverged sends a separate
**production went BACKWARDS / DIVERGED** warning and holds unattended deploys. Deploy main by hand
(`bash deploy/deploy.sh`, `--force` if histories diverge) when it contains the original commit;
otherwise acknowledge a replacement baseline below.

### Operator acknowledgement of a replacement baseline

When ancestry cannot recover (a squash merge, a pruned observation), first deploy the intended main
and verify the bot, with no window open. Then accept the current record as the new observation. It
forgets the fence; it does not deploy, restore data or clear `LAST_FAILED_SHA`. The saved copy keeps
the previous state. Validate afterwards with `wbb-autodeploy --check-state`.

```bash
ack_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
flock -w 30 "$ack_state_dir/lock" bash -c '
  set -euo pipefail
  state=$1
  backup="$state.operator-ack-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -- "$state" "$backup"
  sed -i -e "/^LAST_SEEN_DEPLOYED_SHA=/d" \
    -e "/^REGRESSION_FROM_SHA=/d" -e "/^REGRESSION_TO_SHA=/d" \
    -e "/^LAST_HOLD_NOTICE=/d" "$state"
  echo "Operator acknowledged recorded production; prior state saved at $backup"
' bash "$ack_state_dir/image-state.env"
/usr/local/bin/wbb-autodeploy --check-state
```

### Messages (Telegram, sent by the deployer, not the bot)

| Message | Meaning | You do |
|---|---|---|
| ✅ `<sha>` is live and settled — #PRs | deployed, window clean | nothing |
| ⏸ … HELD | a hold is in the range | the steps, then `bash deploy/deploy.sh` |
| ⏸ … is HELD — the settled … does not start | `COMPAT FAILED`: no code-only rollback | `bash deploy/deploy.sh --ack-incompatible` (no automatic rollback) |
| ⛔ CI failed on `<sha>` | once per SHA | re-run the failed job; that releases it |
| ⛔ refused `<sha>`: audit / trial | recorded as `LAST_FAILED_SHA`, not retried | fix and merge again |
| ⚠️ … failed inside its window … rolling back | code-only rollback to the settled image | look at why; the pre is kept |
| 🔥 INCIDENT | rollback failed, a manual window failed, or the unit is not ours | restore production, then `--resolve-incident` |
| ⚠️ deploy lock held for N min | a stuck run blocks every tick | `fuser -v ~/.local/state/wbb-autodeploy/lock` |
| ⚠️ production went BACKWARDS / DIVERGED | the record lost ancestry; unattended deploys held | check whether deliberate; deploy main by hand |
| ⚠️ installed deployer is out of date | a merged fix is not live (before the switchover session: expected, see Switchover session) | `sudo bash deploy/install-image.sh`, then `sudo bash deploy/install-autodeploy.sh` |
| ⛔ there is no settled image yet | before the first image release | the bootstrap below |

Messages of a manual run carry `[manual]`.

### State

`~/.local/state/wbb-autodeploy/image-state.env` (spec §7.1): the gate keys (`DEPLOYED_SHA`,
`PREVIOUS_SHA`, `LAST_SEEN_DEPLOYED_SHA`, `LAST_FAILED_SHA` — delete the line to retry that exact
commit —, `MAIN_SEEN_*`, the fence `REGRESSION_*`), the images (`DEPLOYED_*`, `SETTLED_*`), the
window (`WINDOW_*`, written before production changes), `INCIDENT`, retained snapshots and once-a-day
markers. A damaged file stops everything with `STATE CORRUPT` (exit 3); check it any time with
`wbb-autodeploy --check-state`. The flat deployer's `state.env` becomes `state.env.flat` plus a
directory `state.env/` at the migration (below), so an old `deploy.sh` refuses before any `sudo`.

### Install / upgrade

```bash
sudo bash deploy/install-image.sh        # the root helper wbb-image + its sudoers
sudo bash deploy/install-autodeploy.sh   # refuses unless the helper is current; then the controller
```

Re-run after any merge that changes an installed copy; those merges are holds anyway, and the
deployer waits (and says so daily) while a copy is stale. Neither enables or disables the timer.
`install-autodeploy.sh` refuses, installing nothing, while the timer is active and the operator's
`image-state.env` is missing (a first tick of the new controller would write one of its own, and the
migration would then refuse for good); after installing it checks the copies with
`wbb-installed-current` and fails when they do not match HEAD.

### Migrating the flat deployer's state (once, at the switchover)

With the timer stopped and **before** `install-autodeploy.sh` (while the flat deployer is still the
installed one, so an unfinished flat window can still be finished by it):

```bash
bash deploy/migrate-state-to-image.sh
```

It carries the gate keys of `state.env` into `image-state.env` and validates the result with the
controller of **this checkout** (`deploy/autodeploy.sh --check-state`; only exit 0 with the exact line
`STATE OK — <path>` passes — the installed copy is still the flat deployer). Only then does it prepare
`state.env.new/` with a README and rename, back to back, `state.env` → `state.env.flat` and
`state.env.new` → `state.env`. Anything unexpected (an unknown key, an unfinished flat window or
rollback, a running timer, a held lock, a different `image-state.env`) refuses and changes nothing.

If a run is interrupted, what it leaves and what to do:

| Left behind | Do |
|---|---|
| `image-state.env.migrate.tmp`, nothing else | run it again (the file is rewritten) |
| `image-state.env` holding exactly the carried keys, `state.env` still a file (maybe `state.env.new/` too) | run it again: it sees its own file and finishes the renames |
| `state.env.flat` and `state.env.new/`, no `state.env` (killed between the two renames) | `mv ~/.local/state/wbb-autodeploy/state.env.new ~/.local/state/wbb-autodeploy/state.env` |
| `state.env/` (a directory), `state.env.flat`, `image-state.env` | done |

Then `sudo bash deploy/install-autodeploy.sh` and the first image release (bootstrap, below).

### Emergency stop — no password required

Arming the timer costs a password; stopping it must not. Any unprivileged process creates a file:

```bash
mkdir -p ~/.local/state/wbb-autodeploy
touch ~/.local/state/wbb-autodeploy/PAUSED
```

A tick checks it first and exits 0 quietly; a manual run refuses (exit 1) with an explanation. To
resume: `rm ~/.local/state/wbb-autodeploy/PAUSED`. PAUSED stops the **next** run, not one already
watching a window. The brake lives inside the script it brakes; the load-bearing stop is
`sudo systemctl stop wbb-autodeploy.timer`.

## Installing the release control plane (stage В core — switches nothing)

Plan: `docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md`.
From a **clean** checkout of `main` on the host:

```bash
sudo bash deploy/install-release.sh           # install / refresh; prints what it did, then a full check
sudo bash deploy/install-release.sh --check   # writes nothing; exit 1 lists every difference
```

| Repo | Installed | Owner / mode |
|---|---|---|
| `deploy/release/**` (no `test_*`, `fake_*`, `release_testkit.py`) | `/usr/local/lib/wbb-release/` | root:root 0644, dirs 0755; files it no longer installs are removed |
| `deploy/wbb-release.sh` | `/usr/local/libexec/wbb-release` (root helper, only via `sudo -n`) | root:root 0755 |
| `deploy/wbb-tick.sh` | `/usr/local/bin/wbb-tick` (operator) | root:root 0755 |
| `deploy/wbb-tick-failed.sh` | `/usr/local/libexec/wbb-tick-failed` | root:root 0755 |
| `deploy/sudoers.d/wbb-release` | `/etc/sudoers.d/wbb-release` | root:root 0440, `visudo -cf` on a dotted temp file before the rename |
| `deploy/wbb-tick.service`, `.timer`, `wbb-tick-failed.service` | `/etc/systemd/system/` | root:root 0644, then `daemon-reload` |

The sudoers file holds one rule per helper verb the adapters call through sudo (`audit` runs without root,
so it has none) plus `systemctl stop|start` of the bot and litestream.

It also creates the system user `wbb-trial` (nologin, no home, own group; an existing one is checked and
**never fixed** — a wrong one is a refusal) and the directories `/var/lib/wbb-trial` (root 0755, not
private: the parent of each run's 0700 `wbb-trial` scratch), and the root-private `/var/lib/wbb-deploy`,
`/var/lib/wbb-deploy/receipts` and `/etc/wbb-deploy` (all 0700). The GitHub token
`/etc/wbb-deploy/github.env` (root 0600, one `WBB_GITHUB_TOKEN=` — fine-grained, Actions: read on this repo)
is only checked; a missing one is reported, not an error (the transition needs it, this step does not).

What it deliberately does **not** do: enable, disable, start or stop anything (`wbb-tick.timer` stays
disabled; its state is only printed), write under `/opt` (still the flat tree — merge-deploy's
`rsync --delete` would wipe a `releases/` there), touch `.env`, or install files other installers own
(`/etc/sudoers.d/warsaw-beer-bot`, `warsaw-beer-bot.service`, `litestream.*`, `wbb-autodeploy.*` and
merge-deploy's `/usr/local/bin` copies, the host-patch and reboot-request files). Merge-deploy keeps
deploying as before.
It installs the bytes of HEAD's git objects (`git ls-tree` / `git cat-file`), never the worktree's files, and
prints the HEAD it installed; the checkout must still be clean, so what you see is what is installed. A symlink
or a submodule tracked where it installs is a refusal.
Run as root inside your checkout, it leaves nothing root-owned there: Python runs with `-I -B` (no
`__pycache__`), git with `--no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null` (no index
rewrite, no fsmonitor, no hook). The wrappers run the installed library with `-I -B` too.

Exit codes: 0 done / no difference; 1 a difference (`--check`, or one that remains after an install) or a
refused precondition (`REFUSED: …` on stderr: dirty checkout, unusable `wbb-trial`, `visudo` rejected the
file — the old one stays, a directory where a file goes, a symlink or submodule tracked in scope); 64 usage;
70 internal error (also a module of the installer that fails to import).

**Installed copies root must read.** `/etc/sudoers.d/*` is 0440, so the operator cannot compare it;
the tick asks `sudo -n /usr/local/libexec/wbb-release digest --path <installed path>`, which prints
`DIGEST <path> <sha256> uid <n> mode <0nnn>` (or `ABSENT <path>`) only for this repo's own sudoers files
(`installed.SUDOERS_FILES`: `/etc/sudoers.d/warsaw-beer-bot`, `/etc/sudoers.d/wbb-release`) or
`/etc/litestream.yml`, refusing symlinks. A copy the operator can read is never
sent to root.

**`publish` takes the ZIP on stdin.** The sudo rule is `publish --sha * --archive -`, and the helper refuses
any other `--archive` (exit 2): root never opens a path the operator names (a path would make root open
`/etc/shadow` or a device and answer about it). The tick opens its downloaded ZIP itself and pipes it in;
root copies at most the ZIP cap into its private staging and checks only that copy.

**Exit codes of the wrappers.** A library that is missing, an entry script that does not compile (checked by
the wrapper before it runs it) or a module that fails to import exits **70** (`wbb-release`)
or **71** (`wbb-tick`), never Python's default 1 — 1 is "bad candidate" for the helper and a success
(`SuccessExitStatus=0 1 2`) for the tick. `wbb-tick-failed.service` (the tick's `OnFailure=`) alerts the
admin through the Bot API only for failures the tick did not report itself: a timeout, a signal or a core
dump, exit 64, 71 or a code the tick does not define (3, 4, 70 it reports on its own) — once per UTC day
per text.

## Runtime image (built by CI; the host deploys it after the switchover session)

Design: `docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md`.
The `image` job in `.github/workflows/ci.yml` builds `deploy/image/Dockerfile` on every PR and
push, smokes it (`scripts/image-smoke.sh`: start to `/health` with the right `releaseSha`, trial,
payload probes, audit verdicts, read-only `/app`). On a push to `main` it pushes
`ghcr.io/ysilvestrov/warsaw-beer-bot:<sha>` and attests it; the run summary has
`IMAGE-DIGEST sha=… digest=… content=…`. Last, it audits the production dependencies from the
image: on a `main` push a high/critical advisory (or an audit that could not run) fails the job
after publication, so `ci` is red and merge-deploy does not deploy that SHA; on a PR it only
annotates (`::error::`) and the job does not fail. Until the switchover session nothing on the host
pulls it (the old flat tooling builds on the host); after it the merge-deploy tick deploys it.

Check an image from the host (as the operator, `gh` logged in):

```bash
gh attestation verify oci://ghcr.io/ysilvestrov/warsaw-beer-bot@<digest> \
  --repo ysilvestrov/warsaw-beer-bot \
  --signer-workflow ysilvestrov/warsaw-beer-bot/.github/workflows/ci.yml \
  --source-ref refs/heads/main --source-digest <sha> --deny-self-hosted-runners
```

`wbb.content` (label) = sha256 of the payload manifest without `release.json`, plus the runtime
base digest: equal labels mean the same runtime. The runtime base digest is a literal in the
Dockerfile's `FROM` (Dependabot `docker` bumps it); `scripts/image-base-digest.sh` reads it for the
build arg. Local build behind a TLS-intercepting proxy:
`docker build -f deploy/image/Dockerfile --secret id=ca,src=<ca-bundle> --build-arg RUNTIME_BASE_DIGEST="$(scripts/image-base-digest.sh deploy/image/Dockerfile)" --build-arg SOURCE_SHA=$(git rev-parse HEAD) .`

## Root helper `wbb-image`

Design: the spec above, §5; plan `docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md`.
`deploy/image/helper/wbb_image.py` is the only root step of the image deployer: the merge-deploy
controller (`deploy/autodeploy.sh`) calls it through `sudo -n` with the fixed rules of
`deploy/sudoers.d/wbb-image`. It takes no paths and no podman arguments from its caller — a full
SHA, `sha256:` digests and a pre-snapshot NAME, all checked — and works only on local images of
`ghcr.io/ysilvestrov/warsaw-beer-bot` with a `revision` label.

| Verb | Does | Verdict line |
|---|---|---|
| `pull --sha X --digest D` | refuses below 5 GiB free; `podman pull …@D`; checks `.Digest`, `RepoDigests`, `revision == X` | `PULLED <D> <image id> content=<wbb.content> revision=<X>` |
| `local --digest D` | `podman image inspect …@D` only — no network, no pull, no free-space check (the rollback target is checked before a trial) | `LOCAL <D> <image id> content=<wbb.content> revision=<X>`; or `NOT LOCAL <D>` with exit 3 (not here: the caller pulls it) |
| `audit --digest D` | `npm audit --omit=dev` → `audit-verdict-cli` inside D (`--network=host`, read-only, no `.env`, no volumes, bot UID) | `AUDIT CLEAN <D>` / `AUDIT ADVISORY <D>` |
| `trial --digest D --previous S --snapshot NAME` | on one copy of the pre snapshot: TRIAL (D migrates twice), START (D), COMPAT (S); every container `--network=none`, read-only, fake environment, no `.env` | `TRIAL OK`, `START OK`, `COMPAT OK <S>` — or `TRIAL FAILED` / `START FAILED` / `COMPAT FAILED` |
| `activate --digest D` | writes `/etc/containers/systemd/warsaw-beer-bot.container` from the template (atomic), `daemon-reload`, `restart` — only while the unit is ours (`SourcePath`/`FragmentPath`) or absent | `ACTIVATED <D>` |
| `current` | the Quadlet file's image, the running container's image and digest, the unit type | `CURRENT quadlet=… container-image=… container-digest=… unit=quadlet\|foreign\|absent` |
| `prune --keep D…` | removes our other images; never the Quadlet file's | `PRUNED <n> skipped <m> kept …` |

Exit: 0 done; 1 only with a verdict on the candidate (`TRIAL`/`START`/`COMPAT FAILED`, `AUDIT
ADVISORY`, `ACTIVATE FAILED` — a restart of D that systemd reports failed); 2 `REFUSED:` (an input or a
precondition, not a verdict); 3 `local` only, `NOT LOCAL <D>` (a normal answer, not an error); 64 usage; 70 internal error; 75 could not judge now, retry (podman, a
timeout, no registry, `START TIMEOUT` of D, `START KILLED` — the OOM killer, a snapshot whose sha256
does not match). Exit 1 covers both kinds of verdict the deployer must tell apart — a failed SHA
(`TRIAL`/`START FAILED`, `ACTIVATE FAILED`, `AUDIT ADVISORY`) and a hold (`COMPAT FAILED`) — so the
caller branches on the verdict line, never on the code alone. S that does not answer in time is
`COMPAT FAILED: START TIMEOUT …`: D has just started on the same copy under the same confinement.

START and COMPAT run `start-check --leave-running`: under this host's AppArmor no process in a
container may signal another one (spec §2 V11), so the check exits after its verdict and the end of
the container stops the bot. A previous image whose `start-check` predates the flag is refused as a
COMPAT target.

Install (and later check) from a clean checkout of `main` — nothing is enabled, started or activated:

```bash
sudo bash deploy/install-image.sh            # visudo -cf + quadlet -dryrun of the template first
sudo bash deploy/install-image.sh --check    # 0 when every installed copy matches this checkout
```

### Image controller (`deploy/autodeploy.sh`)

`deploy/autodeploy.sh` is the merge-deploy controller for images (spec
`docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md` §4, §7; plans
`docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md`,
`…/2026-10-21-wbb-image-transition-b2-core.md`, `…/2026-10-22-wbb-image-transition-b2-harness.md`).
Stage «в» moved it (and its wrapper `deploy/deploy.sh`) over the flat deployer's files. Until the
switchover session installs it, the timer still runs the old installed copy (the flat deployer). Its state is `~/.local/state/wbb-autodeploy/image-state.env`
(parsed and validated, never sourced; a damaged file stops it with `STATE CORRUPT`). It reads the
helper's verdict per action, never by exit code alone: `AUDIT ADVISORY`, `TRIAL FAILED`,
`START FAILED` and `ACTIVATE FAILED` mark the SHA failed (only main's head is recorded);
`COMPAT FAILED` holds that pair of images for a human (`deploy.sh --ack-incompatible`); `REFUSED`
from `trial` retries after an hour; anything else is "could not verify". Rollback is code only, to
the last settled image; the pre snapshot of any failed window is kept (`mark-rollback`) until an
incident is resolved.

### Manual commands (from stage «в»)

Run from a clean checkout of `main` on the host, as the operator (never root). Until the switchover
session the wrapper refuses every command: the installed controller is still the flat deployer, and
the wrapper runs only the installed copy that equals this checkout's controller byte for byte.

| Command | What it does |
|---|---|
| `bash deploy/deploy.sh [--force] [--ack-incompatible]` | Deploys HEAD through the tick's own gates and window, **in the foreground, ~10 min**. A path hold or `deploy:hold` is released by running it (as today). `--force`: a deliberate downgrade (the next tick fences it). `--ack-incompatible`: `COMPAT FAILED` or a `rollback:unsafe`/`migration:contract` PR in the range — deployed with **no automatic rollback**; a failure is an incident. To deploy another commit: `git checkout <sha>` first. |
| `bash deploy/deploy.sh --bootstrap` | The first image release (below). |
| `bash deploy/deploy.sh --resolve-incident --settled <sha>` | Closes an incident: `<sha>`'s image must already run from the Quadlet file and be healthy; a 10-min manual window then makes it the settled image and returns the retained snapshots to ordinary retention. |
| `bash deploy/deploy.sh --resolve-incident --flat` | Only while no image is settled: after a failed bootstrap, with the old flat unit restored and running, closes the incident and records the flat bot's SHA. Next step: `--bootstrap` again. |

Exit codes: 0 done (settled, noop, up to date), 1 refused (the reason is printed; nothing changed
unless it says so), 2 rolled back (code only), 3 incident, 4 the state could not be written, 64
usage. Interrupting a run (Ctrl-C, a lost SSH session) after its window opened is safe: the timer
finishes the window, in the same mode. Refusals before a window are printed only; anything that may
have changed production also goes to Telegram, marked `[manual]`.

### The first image release (bootstrap)

The Quadlet file `/etc/containers/systemd/warsaw-beer-bot.container` must **not** exist before it:
`activate` writes it. The gate keys (`DEPLOYED_SHA`) must already be in `image-state.env` (stage «в»).

1. `bash deploy/deploy.sh --bootstrap` while the old bot runs. It checks CI, resolves and attests
   the image, pulls it, audits it, and trials it dry on a snapshot of the live database (the
   snapshot is discarded). A bad release is refused here, with the bot still up. On success it
   prints the root steps and exits 1; nothing is recorded.
2. The printed root steps: `sudo systemctl stop warsaw-beer-bot`, `sudo systemctl disable
   warsaw-beer-bot`, `sudo mv /etc/systemd/system/warsaw-beer-bot.service
   /etc/systemd/system/warsaw-beer-bot.service.flat`, `sudo systemctl daemon-reload`.
3. `bash deploy/deploy.sh --bootstrap` again. The bot must be stopped (it refuses otherwise). It
   repeats the checks and the audit, snapshots the database at rest, trials, activates the image and
   watches a manual 10-minute window; then the image is the first settled one and the timer deploys
   `main` against it. **Downtime: ~3–5 min** from step 2 to the image's start.

If the second run stops before its window opens (a refusal or an interruption), the bot stays down
and the timer does not say so separately. Every refusal prints the way back:
`sudo mv /etc/systemd/system/warsaw-beer-bot.service.flat /etc/systemd/system/warsaw-beer-bot.service;
sudo systemctl daemon-reload; sudo systemctl enable warsaw-beer-bot; sudo systemctl start warsaw-beer-bot`.
A pending `[deploy:hold]` step or a `migration:contract` PR in the range is listed by both runs: they
do not block bootstrap, but a fallback to the flat tree after a contract PR needs the pre snapshot
restored.

### After a failed bootstrap

A failed bootstrap window is an incident; nothing is rolled back (there is no settled image). Either
fix forward (`sudo /usr/local/libexec/wbb-image pull --sha <sha> --digest <D>`, then
`sudo /usr/local/libexec/wbb-image activate --digest <D>`, then `--resolve-incident --settled <sha>`), or go back to the flat tree:

1. Remove what the failed attempt left: `sudo systemctl stop warsaw-beer-bot`,
   `sudo rm /etc/containers/systemd/warsaw-beer-bot.container`, `sudo podman rm -f warsaw-beer-bot`.
2. Put the old unit back (the way-back commands above).
3. `bash deploy/deploy.sh --resolve-incident --flat`, then, when the cause is fixed, bootstrap again.

## Runtime artifact (history: replaced by the image above)

Design: `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md`, superseded.
CI no longer publishes `wbb-release-*` artifacts; the host-side tools below stay in
`deploy/release/` until the image transition removes them.

The tools live in `deploy/release/` (Python 3.12+ stdlib):

- `package_runtime.py` — assembles the payload (`dist`, production `node_modules`,
  `src/api/fest-print/**`, the allowlisted TS ops commands and their imports), writes
  `release.json` + `tree-manifest.json`, packs a deterministic archive. CI only.
- `tree_manifest.py` — the manifest format and the exact tree check (`verify <root>`).
- `verify_payload.py` + `payload-probe.cjs` — unpacks into a new directory, checks the
  tree, then runs the read-only payload with an empty environment (SQLite, migrations
  twice, fest-print assets, every ops command loads, `dist/index.js` reaches `loadEnv`).
- The app's side (`src/release/identity.ts`): at startup the bot reads `release.json` from
  `realpath(dist/..)` once — `formatVersion` 1, `sourceSha` 40 hex, `platform.os/arch/libc` and `node.major`
  of this process — and `/health` answers `{ "ok": true, "releaseSha": <sha|null> }` with that frozen value
  (never re-read; a later switch of `current` does not change what a running process says). `.env`
  `WBB_RELEASE_REQUIRED=true` makes a missing or invalid file a startup failure with the reason; the default
  `false` (today's flat deploy has no `release.json`) gives `null`, with a warning only for an invalid file.
  The stage В installer turns it on together with the move to the artifact layout.

Host side, stage Ядро-2а (code only; nothing is installed on the host yet):

- `github_trust.py` — which CI run and artifact may stand for a SHA (trusted run metadata,
  same-attempt `package`/`ci`, run-scoped artifact with a `digest`); token only to api.github.com.
  A refusal is `Untrusted`; only its `RunFailed` (the run or a required job concluded unsuccessfully) is CI's
  verdict and `NoRunYet` "no run listed yet" — any other refusal (5xx, no token, partial listing) the tick
  reads as "cannot read CI", a wait.
- `zip_admission.py` — ZIP sha256 equals the trusted digest; exactly the two files; streamed sizes.
- `publish.py` / `wbb_release.py publish|verify` — private copy, checks, `releases/<sha>` by one
  rename, then the 0600 receipt; `verify` re-checks a tree against its receipt without network.

Host side, stage Ядро-2б (code only; the `wbb-trial` user and sudo rules come later):

- `audit_verdict.py` / `host_audit.py` — `wbb_release.py audit`: npm audit of the release's
  lockfile alone, as the operator; the verdict reads the JSON exactly like `audit-verdict.ts`.
- `sandbox.py` / `trial.py` — `wbb_release.py probe|trial`: the release's code runs only inside
  the fixed `systemd-run` sandbox (`wbb-trial`, no network, no secrets, read-only system,
  limits, whole-cgroup kill); `trial` migrates a private, checksum-verified copy of a pre snapshot.
  The unit runs a 0400 copy of `payload-probe.cjs` in the run's scratch, owned by `wbb-trial`; a probe
  that cannot be copied is 75, never a failed candidate.
- `trial --snapshot` takes a name (`<name>-pre.db`) in `/var/lib/warsaw-beer-bot/deploy-snapshots`,
  never a path. `probe`/`trial` print one verdict line and then `NODE <realpath> <sha256> <version> <abi>`;
  `audit` prints `AUDIT <KIND> <sha> tree <hex>` first and its details from the second line.
- Exit codes: 0 ok; 1 only a bad candidate, always with its `PROBE FAILED` / `TRIAL FAILED` /
  `AUDIT ADVISORY` line; 2 refused (input or precondition, `REFUSED:` on stderr — not a verdict);
  64 usage; 70 internal error (traceback on stderr); 75 could not judge now (retry — no `wbb-trial`
  user, no scratch, a unit systemd did not start, another `wbb-trial-*` unit loaded, no audit report).
  Only 1 with its verdict line may become a failed SHA.

Host side, stage Ядро-2в (code only; production activation stays off until the controller lands):

- `deploy_state.py` — controller state v2: one `deploy-state.json`, canonical JSON, `formatVersion: 2`,
  written temp → fsync → rename → fsync(dir). `phase`/`intent` record an action as *planned*, never as
  done (`settled`; `activating`: stop/switch/start; `observing`; `rolling-back`: stop-writers/save-post/
  restore-pre/switch-previous/start-baseline; `unverified`; `recovery-failed`). A missing file is the
  first run; an empty, non-JSON, other-version or schema-breaking file is an error, never a blank slate.
- `publish.py` `current_sha`/`switch` — `wbb_release.py switch --sha <sha>` (root): re-verifies the tree
  against its receipt, then points `current` at the relative `releases/<sha>` by symlink + one rename +
  fsync of the directory; prints `SWITCHED <sha> tree <hex>`, or `CURRENT <sha> tree <hex>` when it already
  pointed there (`tree`: the receipt's treeSha256, which the engine compares with its record). A
  `current` that is not exactly `releases/<40 hex>` (a directory, an absolute or foreign target) is refused,
  never replaced. `current` says where the next start runs from, not what is running now.
- `dbsnap.py post|restore` (bot user, writers stopped) — replaces `db-snapshot.sh post|restore` for the
  rollback. `post <db> <out>` copies db, -wal, -shm into `<out>.partial` with fsync, writes `post.json`
  (size + sha256 per file) and only then renames to `<out>`: an existing `<out>` is a complete post and is
  never rewritten (a repeat returns it; one without a valid `post.json` is refused). `restore <pre> <db>
  <post>` needs that complete post and a `pre` matching its `.sha256`; it first copies pre to
  `<db>.restore-partial` (fsync, sha256 checked) — a failed copy leaves the db and its WAL as they were —
  then drops -wal/-shm *before* the replace (a stale post-state WAL next to the restored pre would be
  replayed by SQLite), and renames the copy in. A repeat with nothing left to do (`post`'s existing
  complete post, `restore`'s `ALREADY`, `switch`'s `CURRENT`) still fsyncs the directory. Exit 0; 2 refused (nothing changed); 64 usage; 70 internal; 75 OS error.
- `activate.py` — the activation and rollback engine, over an injected state store and `Host` (the real
  sudo/systemctl/HTTP adapter and the tick come with the periphery). `begin` opens an activation only from
  `settled` with a settled baseline, never for the last failed or the settled SHA, and only when both the
  candidate's and the baseline's trees verify as the recorded digests (`Host.verify`); every switch's
  returned tree is compared again (a mismatch: the no-DB abort going in, `recovery-failed` going back). Every `step` persists the
  intent before acting and the next one only after reading the result back from the host, so `resume` at
  the start of a tick repeats the persisted intent. Window as merge-deploy: the candidate's own
  `releaseSha` healthy within 120 s, then a probe every 10 s until 600 s from the start; 3 failures in a row
  or an NRestarts change roll back (a probe with no answer is a failed probe, as in merge-deploy); a gap
  over 30 s, a clock that went back, a reboot or NRestarts never read → `unverified`.
  Rollback: lastFailedSha, stop bot + Litestream, `dbsnap` post, restore pre, `current` back to the
  settled release, start Litestream + bot, its `releaseSha` healthy within 120 s. Writers a reboot started
  again are stopped again, and every stop takes a post of its own (`-rollback-post`, `-rollback-post-2`, …;
  `posts` in the state, all named by the `rolled-back` event, `lostTo` = the last stop). A baseline that
  does not answer healthy leaves the rollback pending at `start-baseline` (retried next tick, Outcome
  `recovery-failed` for the alert). Every evidence event carries its `txn`; an ended transaction is kept
  as `lastTxn`, so its end is reported once. A candidate that never
  started (refused switch) goes back without touching the DB and without a verdict. A reboot while
  `activating` with `current` already on the candidate may have started it from the enabled unit: the
  engine logs `rebooted` and goes on to `start` (no restart of an active unit) and the normal window —
  never back to `switch` or the no-DB abort, and no verdict for the reboot itself. Outcomes: `continue`,
  `idle`, `blocked` (a host error — retried, never a verdict), `settled`, `unverified`, `rolled-back`,
  `aborted`, `recovery-failed`, `drift` (settled but another release runs — reported, nothing done).
- `fake_host.py` — the engine's test world (which release the running process serves, `current`, real DB
  files under real `dbsnap`, NRestarts, boot, clock) with crash injection before/after every host call and
  save; `test_crash_matrix.py` crashes the engine at every such point and checks the world after recovery.

Host side, periphery 2в stage A (code only; the real `Host`/`Helpers` adapters are stage Б, nothing is installed):

- `tick_state.py` — the tick's own `tick-state.json` next to `deploy-state.json` (same durable write; a
  broken file is an error, never a blank slate): `mainSeen` (first sighting of a head, for quiet), `noop`
  (`sha` and the `settledSha` whose payload it equals — a noop only while that release is settled), `abort` (SHA, aborts in a row, last time, the txn that counted it — once per txn),
  `notifiedTxn`, `ackThrough` (holds acknowledged up to this SHA: a noop reached through the holds gate, or
  any settle — holds are read from the newest of settled and `ackThrough` that the target contains), the
  regression fence (`lastSeenSettled`, `regression{from,to}`), `notices` (UTC day per notice
  key, kept 31 days), `blocked` (txn, step, first alert time, alerts sent — the bot-down alert) and
  `prepareRetry` (SHA, Transient preparations in a row, the last one's time; another SHA restarts it, any
  other end of a preparation clears it).
- `gates.py` — `admission(Inputs) -> Decision`: a pure function of facts the tick already read, by the
  spec §5 table for `timer` / `manual` / `force`. Kinds: `idle`, `wait`, `hold`, `refuse`, `admit`, and
  `need <field>` — a costly fact (ancestry, installed copies, the range's paths and PR labels, CI) is read
  only when its gate is reached. Quiet 600 s, the abort backoff (1 h doubling per abort in a row, at most
  24 h) and the prepare backoff (5 min doubling per Transient preparation in a row, at most 1 h) are the timer's; PAUSED stops only the timer. An idle timer (up to date, noop, last failed SHA)
  still reads the installed copies and reminds once a day when they are stale. Held paths: every installed
  copy, from ONE list `INSTALLED_COPIES` (`deploy/release/**`, `deploy/*.service|*.timer|*.path`,
  `deploy/sudoers.d/**`, `deploy/litestream.*`, `scripts/ops/host_patch_collect.py`,
  `scripts/ops/reboot_request.py`, merge-deploy's `autodeploy.sh`, `ships.sh`, `read-env.sh`,
  `installed-current.sh`, `db-snapshot.sh`, `trial-migrate.cjs`) — the same tuple the installed-current check
  gets — plus `HUMAN_STEPS` (`deploy/install-*.sh`, `.github/workflows/ci.yml`) and the `deploy:hold` label; by
  hand they pass only with `--ack-holds` equal to the shown keys (`path:<p>`, `pr:<n>`). A path or label that could not be read blocks and cannot be acknowledged. `observe` is the
  regression fence over the settled SHA; only a settled release containing `from` clears it.
- `helpers.py` — the `Helpers` interface the tick uses besides the engine's `Host` (git, GitHub, the
  `wbb_release.py` calls, pre snapshots, installed copies); a `wbb_release.py` call returns `Run(code, kind,
  text, tree)` as it came, and only the caller interprets it; `installed_stale(patterns)` gets
  `gates.INSTALLED_COPIES`. `is_ancestor` answers False for a commit the private clone does not have and
  raises only when git cannot answer; a raise there or in `installed_stale` is a daily "cannot assess" wait,
  never exit 70. `fake_helpers.py` is the scripted test double (and `Clone`, a history that keeps that contract).
- `prepare.py` — `prepare(helpers, sha, trusted, settled)`: verify the candidate — when its tree already
  verifies against its receipt (an earlier tick published it) it is neither downloaded nor published again,
  otherwise download → publish → verify — then verify settled → noop? → audit → probe → pre snapshot → trial → `Prepared(candidate, pre)`. Noop: both manifests are the
  bytes of their verified trees and their entries are equal without `release.json` — nothing is audited,
  probed or trialled. `Verdict` only for exit 1 with `AUDIT ADVISORY` / `PROBE FAILED` / `TRIAL FAILED` and the
  audited tree equal to the verified one; anything else (2, 70, 75, a word and a code that disagree, a helper
  exception, a tree that changed between steps) is `Transient`. A trial that did not pass discards its pre.
- `tree_manifest.parse_manifest` — the byte checks of `verify_tree` without a tree (used by the noop).
- `tick.py` — the controller: `tick.py timer` (the unit) and `tick.py deploy --target <sha> [--force] [--ack-holds
  KEY ...]` (`--target`: the checkout's HEAD, passed by the `deploy.sh` wrapper of stage Б-periphery); root is
  refused (64). Under the merge-deploy lock (`~/.local/state/
  wbb-autodeploy/lock`; the timer does not wait and reports a lock held over 35 min once a day, by hand it
  waits 30 s): `activate.resume` first (a pending phase is finished even under PAUSED), then PAUSED stops the
  timer, then drift (or `unreachable` — `/health` silent for 3 probes 10 s apart; a manual run goes on
  through both), `unverified` and `recovery-failed` are daily reminders, then fetch main and only then the
  regression fence over settled (nothing observed when the fetch failed), then `gates.admission`, `prepare`, the gates once more right before
  `begin` (main unmoved, PAUSED absent, the same holds), `begin` → `run`. The end of a transaction (settled,
  rolled back, aborted, unverified, recovery-failed) is notified once per txn from the engine's state against
  `notifiedTxn` (written only after a successful send, so a tick that dies first leaves it to the next one); a
  block with the bot down (`activating/switch|start`, `rolling-back/*`) is a critical alert at once and again
  after 15 min. `lastFailedSha` comes only from a prepare `Verdict` (written into the settled state) or the
  engine's rollback; CI `failed` only from `github_trust.RunFailed`; an uncaught exception (a broken
  `tick-state.json` too, but only after `resume` ran) is a critical notice with its type and text (once per UTC day per
  text) and exit 70. Exit: 0 idle/waiting/settled/noop, 1 refused or held (and a manual run not served), 2
  rolled back, 3 recovery failed or blocked with the bot down, 4 state not written, 64 usage/root, 70
  internal. Everything is injected (`tick.Env`: state dir, store, `Host`, `Helpers`, notify, clock, sleep);
  `tick.make_env(mode, target)` builds it from the real adapters below on ONE clock (`host.now()`, which stamps
  `abort.at`, is the tick's `clock`); if building fails, a critical notice (once per UTC day, when notify was
  built) and exit 70 without running.
- The operator's commands (never the timer), under the same lock (a busy lock: exit 1 after 30 s), as the
  operator: `tick.py rearm --sha <sha>` clears `lastFailedSha` only when it is that SHA, and that SHA's abort
  backoff (a verdict message still queued for it is kept, marked recorded, so no tick writes the SHA back;
  the cleared abort is not counted again); `tick.py ack-baseline --from <sha>` clears the regression fence
  only when its `from` is that SHA. Both refuse (exit 1, nothing changed) when nothing recorded names the SHA
  or while a transaction is open, print what they changed, and log a `rearm` / `ack-baseline` evidence event
  in `deploy-state.json`. Exit 4: a state not written; 70: internal (a broken `tick-state.json`).
- The real adapters (stage Б-core; nothing is installed yet — stage В). Every command goes through
  `bounded.run` with a timeout and a fixed argv; a SHA is a full lowercase SHA and a snapshot a `trial`
  snapshot name before it reaches one. `installed.py` holds every path once.

  | Who | Method | Command | As |
  |---|---|---|---|
  | `RealHost` | `bot_state` / `litestream_state` | `systemctl show -p ActiveState --value warsaw-beer-bot\|litestream` | operator |
  | | `stop_*` / `start_*` | `sudo -n systemctl stop\|start warsaw-beer-bot\|litestream` | root (existing rule) |
  | | `nrestarts` | `systemctl show -p NRestarts --value warsaw-beer-bot` (not a count → None) | operator |
  | | `verify` / `switch` | `sudo -n /usr/local/libexec/wbb-release verify\|switch --sha <sha>` | root helper |
  | | `post` / `restore` | `python3 -I -B /usr/local/lib/wbb-release/dbsnap.py post\|restore …` | bot user |
  | | `health` | `GET http://127.0.0.1:<API_PORT>/health`, 3 s, ≤ 64 KiB | operator |
  | | `current` | `publish.current_sha` (reads the `current` symlink) | operator |
  | | API_PORT (once per tick) | `wbb-read-env /etc/warsaw-beer-bot/.env API_PORT` (empty → 3000) | bot user |
  | `RealHelpers` | `fetch_main` | `git -C ~/.local/share/wbb-autodeploy/repo fetch -q --prune origin`, `rev-parse --verify origin/main^{commit}` | operator |
  | | `is_ancestor` | `git cat-file -e` each (exit 1 → False), then `git merge-base --is-ancestor` | operator |
  | | `changed_paths` / `commits` | `git -c core.quotePath=false diff --no-renames --name-only -z`, `git rev-list a..b` | operator |
  | | `pr_labels` | `gh api repos/<repo>/commits/<sha>/pulls?per_page=100` (a full page → error) | operator |
  | | `trusted` / `download` | `gh auth token` → `github_trust` (ZIP into `~/.local/share/wbb-autodeploy/artifacts/<sha>.zip`, 0700 dir) | operator |
  | | `publish` `verify` `probe` `trial` | `sudo -n /usr/local/libexec/wbb-release <verb> --sha <sha> […]` | root helper |
  | | `publish` | `… publish --sha <sha> --archive -`: the ZIP opened by the operator (no symlink, a regular file) and piped to root's stdin — root opens no operator path | operator → root helper |
  | | `audit` | `/usr/local/libexec/wbb-release audit --sha <sha>` | operator |
  | | `snapshot_pre` / `discard_pre` | `wbb-db-snapshot snapshot\|discard` (`<UTC>-<sha7>-pre.db` in the snapshot dir), `cat <pre>.sha256` | bot user |
  | | `manifest` | read `releases/<sha>/tree-manifest.json` (O_NOFOLLOW, ≤ 64 MiB) | operator |
  | | `installed_stale` | each installed copy (`installed.installed_path`) vs `git show origin/main:<path>` | operator |
  | `notify` | Telegram | `wbb-read-env` TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_ID, POST `sendMessage`, 10 s, no redirects | bot user / operator |

  "As bot user" is merge-deploy's `sudo -n -u warsaw-beer-bot bash -lc '"$0" "$@"' <argv>` (argv positional).
  A command past its timeout gets SIGTERM, then SIGKILL after `bounded.TERM_GRACE_S` (10 s): `sudo` relays
  SIGTERM to the root process it started but cannot relay SIGKILL, which would leave that process orphaned.
  Exit codes: the root helper's 0 is done and 2 is `Refused` (Host) or `Run(2, …)` (Helpers); exit 1 is a
  `Run` only with this verb's verdict line for this SHA (Helpers) — sudo exits 1 for its own failures, so 1
  without the line, 64, 70, 75 and anything else are `HostError`/`HelperError`, never a verdict. `/health`
  without a 2xx answer is `HostError` (a failed probe); `releaseSha` counts only as a full SHA. The GitHub
  and Telegram tokens never appear in argv, output or exception text.

To check a downloaded artifact by hand (no production access needed, any scratch directory):

```bash
python3 deploy/release/verify_payload.py --archive runtime.tar.gz \
  --checksum runtime.tar.gz.sha256 --sha <full-sha> --workdir /tmp/wbb-verify-<sha>
```

## Host patching (#469)

Spec: `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md`.

What patches what:

| Layer | Patched by | Restart |
|---|---|---|
| Ubuntu packages (`-security`, ESM via Ubuntu Pro) | unattended-upgrades | needrestart restarts services automatically |
| Kernel | unattended-upgrades to disk; Livepatch live (once enabled; coverage proven by probe P1) | a **reboot** only for what Livepatch cannot cover |
| Node (`nodesource`, `node_24.x` only) | unattended-upgrades (`52wbb-unattended-upgrades`) | needrestart restarts the bot |
| cloudflared (`pkg.cloudflare.com`) | unattended-upgrades (`52wbb-unattended-upgrades`) | needrestart restarts the tunnel |
| litestream | **nobody** — upgraded by hand (it writes the backup) | — |

There is no automatic reboot: a reboot kills code-server and every session in
it (the same reason as `/etc/needrestart/conf.d/90-code-server.conf`).

### One-time setup (as root)

1. Attach Ubuntu Pro (free personal tier; token from ubuntu.com/pro — it never
   goes into the repo or `.env`), then enable Livepatch:
   `sudo pro attach <token>` and `sudo pro enable livepatch`.
2. `sudo bash deploy/install-host-patching.sh` — refuses, changing nothing, if a
   needrestart rule names `warsaw-beer-bot`, `cloudflared`, `litestream` or
   `ssh`; if the needrestart restart mode is not `a` or a UI is configured (both
   leave services unrestarted under unattended-upgrades); if needrestart is not
   installed; or if Cloudflare's key has a different fingerprint or more than one
   primary key. It restarts the tunnel once: the cloudflared upgrade triggers
   needrestart. If it fails at `apt-get`, fix the cause and re-run it — the files it
   wrote are the final ones.
3. Check the origins: `sudo unattended-upgrade --dry-run -d 2>&1 | grep -E 'Allowed origins|nodejs|cloudflared'`
   must show the two patterns and treat `nodejs` as upgradable (or show it already at
   the newest 24.x).
4. Reboot once (`sudo systemctl reboot`) so the host runs the newest installed
   kernel, then `canonical-livepatch status` must show it as supported. On this host
   the reboot already happened on 2026-10-06 (6.8.0-142), so only the
   `canonical-livepatch status` check remains.
5. Stage 2 — the hourly collector (`[deploy:hold]` PR): `sudo bash deploy/install-host-patch-collector.sh`.
   It installs `wbb-host-patch.service`/`.timer`, creates `/var/tmp/wbb-host-patch` and runs the
   collector once. Check `python3 -m json.tool /var/tmp/wbb-host-patch/summary.json`: `livepatch`,
   `kernel`, `stale_services`, `unattended.security_pending` and the three `packages` must not be
   `null` (for `livepatch`, `null` means the snap CLI did not start in the unit — see spec C15).
   Only `reboot_required` and `unattended.last_run` may legitimately be `null`. Only then
   `bash deploy/deploy.sh`, which starts the bot reading it. After a merge that changes the
   collector or the units, re-run the installer (the PR will be held for it).
6. Stage 3 — the reboot button (`[deploy:hold]` PR): `sudo bash deploy/install-reboot-request.sh`.
   It installs `wbb-reboot-request.path`/`.service` and creates `/var/lib/wbb-host-patch` (0700,
   owned by `warsaw-beer-bot`). Prove the chain without rebooting: as the bot user write an invalid
   request (`sudo -u warsaw-beer-bot sh -c 'echo bogus > /var/lib/wbb-host-patch/reboot-request'`),
   then `journalctl -u wbb-reboot-request.service -n 5` must show the handler refusing it and the
   file must be gone. Only then `bash deploy/deploy.sh`. Re-run the installer after any merge that
   changes `scripts/ops/reboot_request.py` or the units.

The Інфраструктура row of the daily status reads that summary (reboot pending, Livepatch,
stale watched units, security backlog) and the upstream facts the bot fetches daily (Node 24
security releases and end of life, litestream releases). Thresholds: `src/domain/status/rules.ts`.
Re-run the installer after any merge that changes `scripts/ops/host_patch_collect.py` or the units.

Re-run step 2 after any merge that changes `deploy/install-host-patching.sh`.

## Backup: Litestream → Cloudflare R2

Streams SQLite WAL changes from `/var/lib/warsaw-beer-bot/bot.db` to an R2
bucket. Runs as a separate systemd service alongside the bot.

### One-time install (as root)

```bash
# 1. Install the litestream binary (latest .deb from upstream).
# Litestream's release assets use x86_64/arm64/armv7 — map from dpkg's naming.
case "$(dpkg --print-architecture)" in
  amd64) LS_ARCH=x86_64 ;;
  arm64) LS_ARCH=arm64 ;;
  armhf) LS_ARCH=armv7 ;;
  *) echo "unsupported arch"; exit 1 ;;
esac
TMP=$(mktemp -d)
URL=$(curl -s https://api.github.com/repos/benbjohnson/litestream/releases/latest \
  | grep -oE 'https://github.com/benbjohnson/litestream/releases/download/[^"]+-linux-'"${LS_ARCH}"'\.deb' \
  | head -1)
curl -fsSL "$URL" -o "$TMP/litestream.deb"
apt-get install -y "$TMP/litestream.deb"
rm -rf "$TMP"

# 2. Drop the config and systemd unit from this repo.
install -m 0644 deploy/litestream.yml      /etc/litestream.yml
install -m 0644 deploy/litestream.service  /etc/systemd/system/litestream.service

# 3. Seed the credentials file (must be owned root:root, mode 600 — systemd
#    reads it as root before dropping privileges to warsaw-beer-bot).
install -m 0600 -o root -g root \
  deploy/litestream.env.example /etc/warsaw-beer-bot/litestream.env

# 4. Edit /etc/warsaw-beer-bot/litestream.env and fill in:
#       R2_BUCKET             — your R2 bucket name
#       R2_ENDPOINT           — https://<accountid>.r2.cloudflarestorage.com
#       R2_ACCESS_KEY_ID      — from R2 API token (Object Read & Write)
#       R2_SECRET_ACCESS_KEY  — same token's secret

systemctl daemon-reload
systemctl enable --now litestream
```

### Operate

```bash
systemctl status litestream
journalctl -u litestream -f
```

A successful first run logs `replicating to: ...`. If you see
`InvalidAccessKeyId` / `SignatureDoesNotMatch`, the creds in
`/etc/warsaw-beer-bot/litestream.env` are wrong — fix and `systemctl restart litestream`.

### Restore (disaster recovery)

```bash
sudo systemctl stop warsaw-beer-bot
sudo -u warsaw-beer-bot litestream restore -config /etc/litestream.yml \
  -o /var/lib/warsaw-beer-bot/bot.db.restored \
  /var/lib/warsaw-beer-bot/bot.db
# inspect bot.db.restored, swap into place when satisfied, then:
sudo systemctl start warsaw-beer-bot
```

## Editing the prod `.env` safely

Edit `/etc/warsaw-beer-bot/.env` **additively** — never hand-rewrite the whole
file (that risks silently dropping a key, e.g. the 2026-06-27 `ADMIN_TELEGRAM_ID`
incident that disabled the daily digest). Use the upsert helper, which backs up
first and preserves every other line:

```bash
sudo -n -u warsaw-beer-bot bash -lc \
  '/opt/warsaw-beer-bot/scripts/set-env.sh ADMIN_TELEGRAM_ID 207079110 /etc/warsaw-beer-bot/.env'
sudo -n systemctl restart warsaw-beer-bot
```

`.env.example` (repo root) lists every key. On startup the bot logs a `warn` for
any expected-but-unset optional key, so a dropped key shows up in
`journalctl -u warsaw-beer-bot`.
