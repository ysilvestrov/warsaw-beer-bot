# Deploy

## One-time host setup (as root)

```bash
useradd -r -s /usr/sbin/nologin warsaw-beer-bot
install -d -o warsaw-beer-bot -g warsaw-beer-bot \
  /etc/warsaw-beer-bot /var/lib/warsaw-beer-bot /opt/warsaw-beer-bot
cp .env.example /etc/warsaw-beer-bot/.env
chmod 600 /etc/warsaw-beer-bot/.env
# edit /etc/warsaw-beer-bot/.env — set TELEGRAM_BOT_TOKEN and
# DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db
```

Node 20+ must be installed system-wide (the unit calls `/usr/bin/node`).

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
