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

### Node 20

Install system-wide (the systemd unit calls `/usr/bin/node`):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt-get install -y nodejs build-essential python3
```

`build-essential` + `python3` are needed for the `better-sqlite3` native build.

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
