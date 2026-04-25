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
sudo systemctl status warsaw-beer-bot
sudo journalctl -u warsaw-beer-bot -f
sudo systemctl restart warsaw-beer-bot
```
