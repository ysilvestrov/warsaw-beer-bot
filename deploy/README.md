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

Database maintenance commands run from the deployed checkout as the service user.
They automatically load `/etc/warsaw-beer-bot/.env` and remain available after
`npm prune --omit=dev`:

```bash
sudo -n -u warsaw-beer-bot bash -lc \
  'cd /opt/warsaw-beer-bot && npm run rearm-matcher-bug-orphans'
sudo -n -u warsaw-beer-bot bash -lc \
  'cd /opt/warsaw-beer-bot && npm run rearm-matcher-bug-orphans -- --apply'
```

## Merge-deploy (unattended deploy of `main`)

Design: `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md`.
A timer (`wbb-autodeploy.timer`, every 5 min, runs as the operator) deploys
the head of `origin/main` by itself. **A merge is the permission**: write
access to `main` means production. The host re-derives everything else, from
its own clone in `~/.local/share/wbb-autodeploy/repo` (never your checkout).

### When a merge is deployed

All of these, checked in this order each tick:

0. the observed production record has not regressed (below);
1. production (`DEPLOYED_SHA`) is an ancestor of `main` (no downgrade), and
   something in the diff actually ships (`deploy/rsync-filter`, both sides);
2. `main` has not moved for **10 minutes** (serial merges → one restart);
3. the installed deployer is current (`wbb-installed-current`);
4. **no hold** in `DEPLOYED_SHA..main` (below);
5. CI concluded on **that exact commit**, the required `ci` check is present
   and green, nothing failed or was cancelled.

Then, still before production is touched: `npm ci && npm run build` and
`npm audit --omit=dev --audit-level=high` in the clone; a DB snapshot
(`VACUUM INTO`, one point in time); the new build's `migrate()` run twice on a
copy of it. Only then `deploy/deploy.sh`.

### Holds

A deploy that needs a human on the host is **held**, never attempted:

- the range changes a path that needs root or an install step: `deploy/sudoers.d/**`,
  `deploy/*.service` / `*.timer` (except `warsaw-beer-bot.service`),
  `deploy/litestream.*`, `deploy/install-*.sh`, `deploy/rsync-filter`, or an
  installed copy of the deployer;
- or a PR in the range carries the `deploy:hold` label. Its title then starts
  with `[deploy:hold]` (the `deploy-hold` CI check flags a mismatch) and
  its body lists the steps.

**Release:** do the steps, then run `bash deploy/deploy.sh` from the main
checkout. It records `DEPLOYED_SHA`, the held commit is behind production, and
the next tick carries on by itself.

### The rollback window

For **10 minutes** after the restart the tick watches production:
`/health` every 10 s and the unit's `NRestarts`. The bot must be healthy within
120 s; **3 consecutive** failed polls or a changed `NRestarts` roll back **code
AND database**: the bot and litestream are stopped, the live DB is copied to a
`post` directory, the pre-deploy snapshot is restored, the old commit is
deployed. Nothing merges the two: **a human reconciles** the writes that exist
only in `post` (the 🔥 message names the interval). R2 history also keeps the
post state (`litestream restore -txid …`).

The automatic rollback explicitly passes `--force` and records its own
observation, so the next tick does not mistake it for a new manual rollback.

After the window a deploy is settled; a later failure is an ordinary incident.

Snapshots live in `/var/lib/warsaw-beer-bot/deploy-snapshots/`, owned by the
bot user: `<UTC>-<sha7>-pre.db` + `.sha256`. The newest 3 of settled deploys
are kept. `*-rollback-pre.db` + `*-rollback-post/` (a rollback) and
`*-unverified-pre.db` (a window nobody watched to its end) are **never**
deleted by the machine.

### Production moved backwards or diverged

Design: `docs/superpowers/specs/2026-10/2026-10-01-767-768-deploy-regression-design.md`.
Each tick remembers the last resolved `DEPLOYED_SHA` it observed. If the next
record is an ancestor of that commit, it sends a separate **production went
BACKWARDS** warning; unrelated histories say **production DIVERGED**. The
warning names both SHAs and counts commits no longer reachable from the new
record, plus distinct PRs returned for them (unknown if an API lookup fails).
These counts describe Git history; they do not prove which features were lost.

The tick **does not auto-redeploy** over that change: a deliberate rollback
must be respected. It persists a recovery hold before sending the warning.
The daily HELD message mentions the regression and any ordinary holds in the
deployable range. Further merges and partial forward recovery cannot release
it: production must contain the original pre-regression commit again. Deploy
current main manually to recover when it contains that commit; use `--force`
if the current production history diverges from main. If main does not contain
the recovery point, use the operator acknowledgement below.

### Operator acknowledgement of a replacement baseline

Sometimes ancestry cannot recover: a feature commit deployed before a squash
merge never becomes an ancestor of main, or an earlier observation is removed
from the private clone after its branch is deleted and Git garbage collection
runs. The tick keeps that evidence and refuses to guess that newer code replaced
it correctly. Repeatedly deploying main cannot clear such an observation.

First diagnose the change, deploy the intended clean current main (with
`--force` if necessary), and verify the bot is healthy. Finish any interrupted
rollback/window handling before acknowledgement. Then, as the operator,
explicitly accept the current recorded production as the new observation.
This forgets the recovery fence; it does not deploy, restore data, clear
LAST_FAILED_SHA or assert that production is healthy. The saved state file
keeps the previous observation for diagnosis.

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
' bash "$ack_state_dir/state.env"
```

The next tick seeds its observation from the resolved DEPLOYED_SHA, just as
on first installation. Do not use this procedure to hide an unexplained
rollback or to bypass build, CI or migration failures.

A failed warning delivery remains pending for the next tick; after successful
delivery it is not repeated on unchanged observations. A crash between sending
and saving that success may repeat a message. A missing commit blocks assessment
without erasing the prior observation. The first tick seeds observation without
inventing history; changes between ticks and rollbacks before first observation
may be invisible. Old copies of deploy.sh do not enforce the ancestry guard.

### Messages (Telegram, sent by the deployer, not the bot)

| Message | Meaning | You do |
|---|---|---|
| ✅ `<sha>` is live and settled — #PRs | deployed, window clean | nothing |
| ⏸ … HELD | a hold is in the range | the steps, then `bash deploy/deploy.sh` |
| ⛔ CI failed on `<sha>` | once per SHA | re-run the failed job; that releases it |
| ⛔ refused `<sha>`: build / audit / trial migration | recorded as `LAST_FAILED_SHA`, not retried | fix and merge again (the next merge is tried) |
| ⚠️ … UNVERIFIED | live, but its window was not watched to the end | check the bot; the `-unverified-pre.db` is kept |
| 🔥 ROLLED BACK | code and DB went back to `pre` | reconcile `post` |
| 🔥 ROLLBACK FAILED / INTERRUPTED | production state unknown | intervene now |
| ⚠️ deploy lock held for N min | a stuck `deploy.sh` blocks every tick | `fuser -v ~/.local/state/wbb-autodeploy/lock` |
| ⚠️ production went BACKWARDS / DIVERGED | observed deployed record lost ancestry; automatic deployments held | check whether deliberate; deploy current main manually to recover |
| ⚠️ installed deployer is out of date | a merged fix is not live | `sudo bash deploy/install-autodeploy.sh` |

### State

`~/.local/state/wbb-autodeploy/state.env`: `DEPLOYED_SHA` (written by
`deploy.sh` too) / `PREVIOUS_SHA`, `LAST_FAILED_SHA` (delete the line to retry that
exact commit), `MAIN_SEEN_*` (the quiet clock), `WINDOW_*` and
`ROLLBACK_STARTED` (a window or rollback in progress — a tick that finds them
finishes or reports it), and once-a-day markers `LAST_*_NOTICE`.

`LAST_SEEN_DEPLOYED_SHA` records the last resolved deployed observation.
`REGRESSION_FROM_SHA` keeps the original recovery point and
`REGRESSION_TO_SHA` the most recent observed regression target. Manual
`record-deployed.sh` preserves these keys; only the tick updates/clears them
from its Git evidence. They are not proof of runtime health.

`deploy.sh` and a tick exclude each other through the same lock: a manual
deploy waits up to 30 s and refuses while a tick watches a window.

### Install / upgrade

```bash
sudo bash deploy/install-autodeploy.sh   # copies into /usr/local/bin + units
sudo systemctl daemon-reload
```

Re-run after any merge that changes an installed copy; those merges are holds
anyway, and the deployer waits (and says so daily) while its copy is stale.

For #767/#768, update **every checkout used for manual deploys** to current
main, then run the install above and `bash deploy/deploy.sh` from current main.
Installing the tick cannot update an old manual script in another checkout.

### Emergency stop — no password required

Arming the timer costs a password (`systemctl enable --now wbb-autodeploy.timer`,
and `sudoers` pins `systemctl` to the `warsaw-beer-bot` and `litestream` units,
not to `wbb-autodeploy`) — so stopping it must not, or the brake is
unavailable exactly when the operator is asleep.

To pause, any unprivileged process — the operator, a script, a future
watchdog — creates a file:

```bash
mkdir -p ~/.local/state/wbb-autodeploy
touch ~/.local/state/wbb-autodeploy/PAUSED
```

Every run of `wbb-autodeploy` checks for this file first, before touching
git, the lock, or anything else, and if it exists exits 0 with a single
journal line — no Telegram message. The timer itself keeps ticking every 5
minutes; each tick just does almost nothing while the file exists.

To resume:

```bash
rm ~/.local/state/wbb-autodeploy/PAUSED
```

PAUSED stops the **next** tick, not one that is already watching a window.

**Stated plainly:** this brake lives *inside* the script it brakes, so it
cannot help against a deployer that is broken before it reaches that check
(e.g. a corrupted script, or a `set -e` bug earlier in the file). It is a
first line of defense, not the only one — the privileged `sudo systemctl
stop wbb-autodeploy.timer` (or disabling the timer) remains the real, load-bearing
stop.

## Runtime artifact (CI only, not used by the host yet)

Design: `docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md`.
Stage Ядро-1 is CI only: every push to `main` runs the `package` job in
`.github/workflows/ci.yml`, which publishes `wbb-release-<sha>-<run_id>-<attempt>`
(`runtime.tar.gz` + `runtime.tar.gz.sha256`, kept 30 days). Nothing on the host reads
it yet; `deploy.sh` and the merge-deploy tick still build on the host as described above.

The tools live in `deploy/release/` (Python 3.12+ stdlib):

- `package_runtime.py` — assembles the payload (`dist`, production `node_modules`,
  `src/api/fest-print/**`, the allowlisted TS ops commands and their imports), writes
  `release.json` + `tree-manifest.json`, packs a deterministic archive. CI only.
- `tree_manifest.py` — the manifest format and the exact tree check (`verify <root>`).
- `verify_payload.py` + `payload-probe.cjs` — unpacks into a new directory, checks the
  tree, then runs the read-only payload with an empty environment (SQLite, migrations
  twice, fest-print assets, every ops command loads, `dist/index.js` reaches `loadEnv`).

Host side, stage Ядро-2а (code only; nothing is installed on the host yet):

- `github_trust.py` — which CI run and artifact may stand for a SHA (trusted run metadata,
  same-attempt `package`/`ci`, run-scoped artifact with a `digest`); token only to api.github.com.
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
  fsync of the directory; prints `SWITCHED <sha>`, or `CURRENT <sha>` when it already pointed there. A
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
  `settled` with a settled baseline, never for the last failed or the settled SHA. Every `step` persists the
  intent before acting and the next one only after reading the result back from the host, so `resume` at
  the start of a tick repeats the persisted intent. Window as merge-deploy: the candidate's own
  `releaseSha` healthy within 120 s, then a probe every 10 s until 600 s from the start; 3 failures in a row
  or an NRestarts change roll back; a gap over 30 s, a reboot or NRestarts never read → `unverified`.
  Rollback: lastFailedSha, stop bot + Litestream, `dbsnap` post once, restore pre, `current` back to the
  settled release, start Litestream + bot, its `releaseSha` healthy within 120 s. A candidate that never
  started (refused switch) goes back without touching the DB and without a verdict. Outcomes: `continue`,
  `idle`, `blocked` (a host error — retried, never a verdict), `settled`, `unverified`, `rolled-back`,
  `aborted`, `recovery-failed`, `drift` (settled but another release runs — reported, nothing done).
- `fake_host.py` — the engine's test world (which release the running process serves, `current`, real DB
  files under real `dbsnap`, NRestarts, boot, clock) with crash injection before/after every host call and
  save; `test_crash_matrix.py` crashes the engine at every such point and checks the world after recovery.

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
