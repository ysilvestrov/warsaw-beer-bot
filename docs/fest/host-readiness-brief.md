# Бриф для Codex на прод-сервері: готовність хоста до фестивалю (лише читання)

Як користуватися: за 1–3 дні до фесту і ще раз у день відкриття віддай цей файл Codex на хості.
Підстав `<SHA>` — голову `main`, яку очікуєш задеплоєною. Звіт порівняй із розділом «Очікування».
Основа — перевірка перед WFP22 (2026-10-02).

## Контекст

Проєкт `warsaw-beer-bot` (Node.js/TS, Telegraf, SQLite):

- код — `/opt/warsaw-beer-bot`, сервіс — `warsaw-beer-bot.service` від користувача `warsaw-beer-bot`;
- БД — `/var/lib/warsaw-beer-bot/bot.db`, env — `/etc/warsaw-beer-bot/.env`;
- хост сам деплоїть `main` після мерджу (`wbb-autodeploy.timer`, стан —
  `~ysi/.local/state/wbb-autodeploy/state.env`, ключ `DEPLOYED_SHA`).

Фестивальний режим має кілька очей: серверне HTML-око, MCP-око локацій і стрічку друзів через
сторонній Untappd MCP (`FEST_MCP_URL` + OAuth-файл), ноутбук. Ще в ньому є станція друку наліпок
(`FEST_PRINT_BASE_URL`).

Треба зібрати **факти**: чи задеплоєно очікуване, чи цілі міграції й дані, чи виконано ручні
кроки, чи живий MCP-шлях. Висновки не потрібні — лише виміри.

## Жорсткі обмеження

- **Лише читання.** Усі SQL-запити йдуть через `sqlite3 -readonly`. Не змінювати `/opt`, `/etc`,
  файл токена. Не перезапускати сервіс, не запускати `deploy.sh`, не робити `git` у `/opt`.
- **Секрети не друкувати ніколи.** З `.env` — лише **чи задано** ключ. З OAuth-файлу — лише `stat`,
  **без `cat`, `jq`, `head`**. У логах заміни на `[REDACTED]` усе, що схоже на токен.
- **Не викликати Untappd і MCP.** Ліміт 100 запитів на годину спільний для бота й конектора власника.
- Якщо команда потребує `sudo` без пароля і його нема, пропусти її з позначкою «не перевірено (sudo)».
  Три блокування поспіль — зупинись і напиши, що саме заблоковано.
- Звіт — один файл `/tmp/host-check-<UTC-час>.md`.

## Що перевірити

### 1. Деплой

1. `DEPLOYED_SHA` зі state-файлу автодеплою. Чи це `<SHA>` або його нащадок
   (`git merge-base --is-ancestor <SHA> <deployed>` у будь-якому чекауті; чекауту нема — лише значення).
2. `systemctl is-active warsaw-beer-bot`, `systemctl show -p ActiveEnterTimestamp warsaw-beer-bot`.
3. `journalctl -u wbb-autodeploy --since "-24h" --no-pager | tail -40`. Чи останній деплой пройшов,
   чи не стоїть на `deploy:hold`.

### 2. Схема й дані

Запити — `sudo -u warsaw-beer-bot sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db "<SQL>"`:

1. `SELECT MAX(version) FROM schema_version;` — голова схеми; порівняй із найбільшою `version` у
   `src/storage/schema.ts` на `<SHA>`.
2. `PRAGMA quick_check;` → `ok`.
3. Фест і сесії: `SELECT id, slug, name, menu_venue_id FROM fests;`,
   `SELECT fest_id, session_no, start_at, end_at FROM fest_sessions ORDER BY 1,2;`,
   `SELECT fest_id, venue_id, label FROM fest_venues ORDER BY 1,2;`.
4. Меню й стенди: `SELECT fest_id, COUNT(*) FROM fest_menu GROUP BY 1;`,
   `SELECT fest_id, COUNT(*) FROM fest_stands GROUP BY 1;`.
5. Команди: `SELECT t.id, t.fest_id, COUNT(m.telegram_id) FROM fest_teams t LEFT JOIN fest_team_members m ON m.team_id = t.id GROUP BY 1;`.

### 3. Ручні кроки (без друку значень)

1. `sudo grep -c '^FEST_MCP_URL=.\+' /etc/warsaw-beer-bot/.env` → лише число. Так само для
   `FEST_MCP_OAUTH_FILE` і `FEST_PRINT_BASE_URL`.
2. Шлях OAuth-файлу: значення `FEST_MCP_OAUTH_FILE`, інакше дефолт
   `/var/lib/warsaw-beer-bot/fest-mcp-oauth.json`. Шлях не секрет.
3. `sudo stat -c '%U:%G %a %s bytes, mtime %y' <шлях>`.

### 4. MCP-шлях (якщо `FEST_MCP_URL` задано)

1. Стан:
   ```sql
   SELECT key, value FROM job_state
    WHERE key LIKE 'fest_mcp_%' OR key LIKE 'fest_friend_feed_%' OR key LIKE 'fest_owner_feed_%'
    ORDER BY key;
   ```
2. Лог за добу:
   ```
   journalctl -u warsaw-beer-bot --since "-24h" --no-pager | grep -iE 'fest mcp|mcp (call|venue)|bad_shape|error' | tail -60
   ```
3. Окремо порахуй `bad_shape` за добу:
   `journalctl -u warsaw-beer-bot --since "-24h" --no-pager | grep -c bad_shape`.

## Очікування

| Що | Очікується |
|---|---|
| Деплой | `DEPLOYED_SHA` = `<SHA>` або нащадок; сервіс `active`; автодеплой без помилок і без hold |
| Схема | голова = найбільша `version` у коді; `quick_check` = `ok` |
| Фест | рядок фесту з правильними сесіями (UTC) і локаціями; меню не порожнє; стенди завантажені (якщо вже є CSV) |
| `.env` | `FEST_MCP_URL`, `FEST_PRINT_BASE_URL` = 1; `FEST_MCP_OAUTH_FILE` = 0 або 1 |
| OAuth-файл | є, власник `warsaw-beer-bot`, права `600` |
| MCP | `fest_mcp_keepalive_at` за останню добу; `fest_mcp_open_until` нема або в минулому |
| `bad_shape` | **0**. Будь-яке ненульове число — стоп, див. #884: на WFP22 стрічка власника падала так весь фест і тримала відкритим спільний breaker (#883) |

## Формат звіту

| # | Що перевіряли | Сирий результат (без секретів) | Очікування | Збіг: так / ні / не перевірено |
|---|---|---|---|---|

Під таблицею — дослівний вивід команд, якщо він потрібен, щоб пояснити «ні». Без висновків і порад.
