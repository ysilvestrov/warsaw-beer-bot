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

Before starting a major-version change, hold the #435 autodeploy brake for the whole procedure — see
"Emergency stop" below — so no unattended security tag can land mid-flight while the host is between
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

## Unattended security autodeploy (#435)

A timer checks for an `autodeploy-*` tag and deploys it only if the change
touches nothing but the root `package.json` and `package-lock.json`. See
`docs/superpowers/specs/2026-08/2026-08-16-435-dependency-security-autofix-design.md`.

One-time install (as root):

```bash
sudo bash deploy/install-autodeploy.sh
```

It installs the scripts to fixed paths rather than running them from the
operator's working tree — that tree is rsynced wholesale by `deploy.sh` and may
hold uncommitted work at any moment. They are **copies, not symlinks**, so the
running deployer cannot change under a `git checkout`.

**Re-run it after every merge that touches `deploy/*.sh`.** The same property
that protects the running deployer means a merged fix is not a live fix until
it is installed. You no longer have to remember this on your own: the deployer
compares its installed copies against `origin/main` and says so once a day
while idle — and **refuses to deploy at all** while it is stale, because
deploying production on safety logic known to be out of date is the risk the
whole mechanism exists to manage.

Re-run the three script `install` lines whenever any of them changes — they are copies,
not symlinks, deliberately: the running deployer must not change under a
`git checkout`.

### The deployed baseline

`deploy.sh` records the commit it deployed into
`~/.local/state/wbb-autodeploy/state.env`. This is not bookkeeping — the guard
computes its diff **from that commit**, so a stale baseline does not merely
mislead, it BLOCKS autodeploy: every undeployed merge adds paths to the diff
until it leaves the allowlist, and then every security tag is refused. A
refusal looks exactly like the guard working correctly, which is what makes it
dangerous.

If the working tree is dirty when you deploy, the baseline is **cleared**
instead of recorded: `rsync` ships a tree, not a commit, so `HEAD` would be a
lie. Autodeploy then refuses until you reseed it:

```bash
./deploy/record-deployed.sh "$(git rev-parse HEAD)"
```

`autodeploy.sh` also reports drift on its idle path — once a day, not once a
tick — if production has fallen behind `main` in ways that would block it.

The timer stays **disabled** until the mechanism has been exercised by hand:

```bash
# dry run — the guard refuses anything that is not a lockfile-only change
/usr/local/bin/wbb-autodeploy

# arm it
systemctl enable --now wbb-autodeploy.timer
systemctl list-timers wbb-autodeploy.timer
```

The first run refuses with "no recorded baseline". Seed it with the commit
currently deployed:

```bash
mkdir -p ~/.local/state/wbb-autodeploy
printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=\n' "$(git -C /home/ysi/warsaw-beer-bot rev-parse origin/main)" \
  > ~/.local/state/wbb-autodeploy/state.env
```

### A failed tag is remembered, not retried

If a tag fails — the guard refuses it, `npm audit` still reports an advisory,
the deploy comes up unhealthy, or the rollback itself fails — the run writes
`LAST_FAILED_SHA=<that commit>` into `~/.local/state/wbb-autodeploy/state.env`
alongside the existing `DEPLOYED_SHA`/`PREVIOUS_SHA` lines. On every later
tick, a tag whose commit matches `LAST_FAILED_SHA` is skipped immediately —
exit 0, one journal line, **no Telegram message**. This is deliberate: the
operator was already paged when the failure was first recorded, and design
§7 calls for one attempt, then a human, not a message every 5 minutes
forever.

To retry a tag by hand (after fixing whatever made it fail, or if the
failure was a known-transient blip), clear the memory:

```bash
# delete the whole line …
sed -i '/^LAST_FAILED_SHA=/d' ~/.local/state/wbb-autodeploy/state.env
# … or just delete the file (loses DEPLOYED_SHA/PREVIOUS_SHA too — see
# "seed it" above to restore the baseline afterward)
rm ~/.local/state/wbb-autodeploy/state.env
```

The next timer tick then treats it as a fresh tag and goes through the
guard/audit/deploy sequence again.

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

**Stated plainly:** this brake lives *inside* the script it brakes, so it
cannot help against a deployer that is broken before it reaches that check
(e.g. a corrupted script, or a `set -e` bug earlier in the file). It is a
first line of defense, not the only one — the privileged `sudo systemctl
stop wbb-autodeploy.timer` (or disabling the timer) remains the real, load-bearing
stop.

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
