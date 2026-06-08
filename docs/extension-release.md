# Випуск нової версії розширення (для maintainer)

Передумова: приватний ключ підпису `~/warsaw-beer-extension-key.pem` уже існує
(публічний ключ зашитий у `extension/manifest.config.ts` як `key` — фіксує ID
розширення). Ключ генерується один раз і **не комітиться**.

1. Онови код розширення в `extension/`.
2. Підніми версію в `extension/package.json` (єдине місце) і додай секцію
   `## [x.y.z] - YYYY-MM-DD` у `extension/CHANGELOG.md`.
3. Збери і запиши реліз у БД бота:
   ```bash
   cd extension
   DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db npm run release
   ```
   `npm run release` = `vite build` → `dist/RELEASE_NOTES.txt` (тіло секції
   CHANGELOG) → `warsaw-beer-overlay-<version>.zip` → запис рядка
   `extension_releases` (version, notes, sha256). Якщо для версії немає секції в
   CHANGELOG — білд **впаде** (це навмисно).
   > Запис іде в живу БД бота. Якщо файл БД належить сервісному юзеру, запусти
   > крок запису під ним, напр.:
   > `sudo -u warsaw-beer-bot bash -lc 'cd <repo>/extension && DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db npm run release'`.
4. Перешли боту в приваті файл `extension/warsaw-beer-overlay-<version>.zip`.
   Бот звірить sha256 з останнім рядком і відповість
   «Прикріплено файл до v… 📣 Розіслати / Скасувати». Якщо хеш не збігся —
   бот відмовить (спершу зроби крок 3 саме для цього файлу).
5. Натисни **📣 Розіслати** — бот розішле zip усім власникам токенів
   (тим, хто колись робив `/extension`), кожному його мовою. У відповідь —
   підсумок «надіслано X, помилок Y».

Нові тестери отримують актуальний zip автоматично: `/extension` віддає і токен,
і останній прикріплений реліз.
