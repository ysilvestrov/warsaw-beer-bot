# host-upstream fixtures (#469 stage 2 periphery)

Captured 2026-10-08 with plain `curl` and trimmed to the fields the parsers read:
- `node-index.json` — https://nodejs.org/dist/index.json: the 2 newest v26 releases, the 8 newest v24, the newest v22 security release.
- `node-schedule.json` — https://raw.githubusercontent.com/nodejs/Release/main/schedule.json: `v22`, `v24`, `v26`.
- `litestream-latest.json` — https://api.github.com/repos/benbjohnson/litestream/releases/latest.
