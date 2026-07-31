# Випуск нової версії розширення (для maintainer)

## Одноразовий сетап (раз на хост, під root)

Передумови: приватний ключ підпису `~/warsaw-beer-extension-key.pem` уже існує
(публічний ключ зашитий у `extension/manifest.config.ts` як `key`). Встанови
привілейований applier і sudoers-правило (дають `ysi` беспарольно застосувати
**лише** фіксований release-row upsert як `warsaw-beer-bot`):

```bash
sudo install -o root -g root -m 0755 deploy/bin/apply-extension-release.sh /usr/local/bin/apply-extension-release.sh
sudo install -o root -g root -m 0440 deploy/sudoers.d/warsaw-beer-extension-release /etc/sudoers.d/warsaw-beer-extension-release
sudo visudo -c   # має вивести: /etc/sudoers.d/warsaw-beer-extension-release: parsed OK
```

## Випуск (одна команда)

1. Онови код розширення в `extension/`, підніми версію в `extension/package.json` і
   додай секцію `## [x.y.z] - YYYY-MM-DD` у `extension/CHANGELOG.md` (білд впаде без неї).
2. Збери, запиши рядок у прод-БД і застейдж zip однією командою:

   ```bash
   cd extension
   DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db npm run release
   ```

   `npm run release` = `vite build` → `dist/RELEASE_NOTES.txt` →
   `warsaw-beer-overlay-<version>.zip` (детермінований) → запис рядка
   `extension_releases` (in-process якщо БД писабельна, інакше через привілейований
   applier) → копія zip у `~/extension-releases/`. У кінці друкує шлях, sha256 і
   готовий `scp`-однорядок.
3. Перешли боту в приваті застейджений файл
   `~/extension-releases/warsaw-beer-overlay-<version>.zip` (за потреби забери його
   `scp`-командою з виводу). Бот звірить sha256 з рядком і відповість
   «Прикріплено до v… 📣 Розіслати / Скасувати».
4. Натисни **📣 Розіслати** — бот розішле zip усім власникам токенів, кожному його
   мовою. У відповідь — підсумок «надіслано X, помилок Y».

Нові тестери отримують актуальний zip автоматично через `/extension`.

> Запис іде в живу БД бота. Детермінований zip означає, що повторний `npm run release`
> тієї ж версії безпечний (той самий sha → upsert-no-op). Не редагуй застейджений zip
> вручну — бот матчить саме його sha.

## Chrome Web Store channel (#266)

Store releases are a separate command from the off-store bot channel:

```bash
npm run release:store     # package:store → upload → submit for review
npm run release:store -- --dry-run   # credentials + preflight only, no mutation
```

The version must be bumped in `extension/package.json` first; the preflight refuses to
re-upload a version the store draft already carries.

### One-time OAuth setup

1. Google Cloud project → enable **Chrome Web Store API**.
2. OAuth consent screen → **External**, then **publish it** so the status is
   **In production**. In *Testing* mode Google expires refresh tokens after 7 days.
3. Credentials → OAuth client ID → **Desktop app** → copy the client id/secret into
   `.env` as `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET`.
4. `npm run cws:auth` → open the printed URL (also written to `./tmp/cws-auth-url.txt`),
   grant access, then copy the `CWS_REFRESH_TOKEN=…` line from `./tmp/cws-env.txt` into
   `.env`. If the browser cannot reach `http://127.0.0.1:8976`, paste the `code=` value
   from the address bar: `npm run cws:auth -- --code <value>`.
5. `npm run cws:auth -- --verify` must print an `OK — item …` line.

`invalid_grant` later on means the token was revoked or the consent screen slipped back
to *Testing* — redo step 4.
