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

## Канал Chrome Web Store (#266)

Store-реліз — окрема команда від off-store bot-каналу вище:

```bash
npm run release:store                 # package:store → upload → submit for review
npm run release:store -- --dry-run    # лише креденшели + preflight, нічого не мутує
```

Спершу підніми версію в `extension/package.json`: preflight відмовиться перезаливати
версію, яку чернетка в сторі вже несе.

Store-збірка пишеться в **окремий** файл `warsaw-beer-overlay-<version>-store.zip` — вона
не той самий артефакт, що dev-zip (без `key`, вужчі дозволи), і не має його затирати.

### Одноразовий OAuth-сетап

1. Проєкт у Google Cloud → увімкнути **Chrome Web Store API**.
2. OAuth consent screen → **External**, далі **Publish app**, щоб статус став
   **In production**. У режимі *Testing* Google видає refresh-токени з життям 7 днів —
   автоматизація тихо помре між релізами.
3. Credentials → OAuth client ID → тип **Desktop app** → client id/secret у `.env` як
   `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET`.
4. `npm run cws:auth` → відкрий URL (він же у `./tmp/cws-auth-url.txt`), дай доступ, тоді
   перенеси рядок `CWS_REFRESH_TOKEN=…` з `./tmp/cws-env.txt` у `.env`. Якщо браузер не
   дістає до `http://127.0.0.1:8976` (напр. він на іншій машині), візьми значення `code=`
   з адресного рядка: `npm run cws:auth -- --code <значення>`.
5. `npm run cws:auth -- --verify` має надрукувати рядок `OK — item …`.

Пізніший `invalid_grant` означає або відкликаний доступ, або consent screen, що з'їхав
назад у *Testing* — повтори крок 4.
