# Warsaw Beer Overlay

A personal, non-commercial project that helps craft-beer shoppers in Warsaw see which
beers they've already had. It has three parts:

- **Telegram bot** — links your Untappd account, imports your check-in history, and
  serves beer matches over an API.
- **Beer API** — matches shop beers against your Untappd history and global ratings.
- **Browser extension** — badges every beer on supported shop pages:
  ⭐ community rating · ✅ you've had it (with your rating) · ❓ probable match ·
  ⚪ known beer, not yet on Untappd.

Works on BeerRepublic, OneMoreBeer, BeerFreak, Bierloods22, WineTime, Hoptimaal,
Flasker, Piwne Mosty, and Funkyshop.

## Install & use

- Setup guide (English): https://ysilvestrov.github.io/warsaw-beer-bot/install/
- Інструкція встановлення (українською): https://ysilvestrov.github.io/warsaw-beer-bot/install-uk/
- [Privacy policy](https://ysilvestrov.github.io/warsaw-beer-bot/privacy/)

## Development

Stack: Node.js, TypeScript, Telegraf (Telegram), SQLite, Vitest.

- API keys and config are read from a `.env` file.
- Install deps: `npm install`
- Run tests: `npm test` (extension tests: `cd extension && npm test`)
- Run the bot locally: `npm run dev`

See [`spec.md`](./spec.md) for the canonical behavior specification.

---

Personal, non-commercial project by Yuriy Silvestrov.
