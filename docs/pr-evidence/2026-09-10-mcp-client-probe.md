# Жива проба MCP-клієнтів — Claude Code і Codex CLI

**Дата:** 2026-09-10
**Що перевіряли:** задача 5 плану `docs/superpowers/plans/2026-09/2026-09-10-mcp-match-core.md`.
Спека лишила відкритим один факт про **чужі** клієнти: чи прочитає клієнт голий `401` як
«немає токена», чи піде шукати OAuth-метадані й покаже користувачеві помилку не про те.
Вгадати це неможливо — тільки підключити.

## Стенд

Повний `dist/index.js` **не** запускали: він піде в Telegram long-polling і битиметься з живим
продакшн-ботом за той самий токен. Замість цього — одноразовий харнес `tmp/mcp-probe-server.ts`
(не комітиться), який піднімає **лише** `createApiApp` / `createApiServer` на тимчасовій
SQLite-БД, `127.0.0.1:3999`.

Сид (навмисно асиметричний, щоб половини профілю були розрізнимі):

| Пиво | Стан у сиді |
|------|-------------|
| Trzech Kumpli / Pan IPAni | чекін з оцінкою **4.5** |
| PINTA / Atak Chmielu | `markHad` — випите, **без** оцінки |
| Artezan / Rowing Jack | у каталозі, не випите |

Токен: `probe-token-abcdef` → `telegram_id 4242`.

## Версії клієнтів

- Claude Code: `claude` з `~/.local/bin` (модель проби — haiku)
- Codex CLI: `codex-cli 0.153.3` (модель `gpt-6-astra`)

## Прийнятний шлях — обидва клієнти

**Claude Code.** Реєстрація:

```
claude mcp add --transport http warsaw-beer-probe http://127.0.0.1:3999/mcp \
  --header "Authorization: Bearer probe-token-abcdef"
```

`claude mcp list` → `warsaw-beer-probe: http://127.0.0.1:3999/mcp (HTTP) - ✔ Connected`

Виклик тули (print-режим, `--allowedTools "mcp__warsaw-beer-probe__match_beers"`) повернув:

```
Profile: {"checkins_known":1,"untappd_had_known":1,
          "latest_checkin_at":"2026-08-01 19:30:00","drunk_set_empty":false}

Trzech Kumpli / Pan IPAni — status: drunk,     confidence: exact, your rating: 4.5
PINTA / Atak Chmielu      — status: drunk,     confidence: exact, your rating: —
Artezan / Rowing Jack     — status: not_drunk, confidence: exact, your rating: —
```

**Codex CLI.** Реєстрація:

```
codex mcp add warsaw-beer-probe --url http://127.0.0.1:3999/mcp \
  --bearer-token-env-var WARSAW_BEER_TOKEN
```

Той самий запит повернув ті самі три статуси і той самий блок `profile`.

**Що це доводить.** Обидва CLI-клієнти приймають статичний Bearer без жодного OAuth — рішення
«v1 тільки CLI» тримається. Дводжерельна drunk-модель теж підтверджена наскрізь: `Atak Chmielu`
приїхав як `drunk` **без** оцінки — тобто з `untappd_had`, не з `checkins`, і тула не вигадала
оцінку там, де її нема.

Одна деталь Codex, не пов'язана з нашим сервером: за замовчуванням виклик MCP-тули потребує
підтвердження, і при `approval: never` він падає з `MCP tool call requires approval`. Це політика
клієнта, а не наша відповідь.

## Проба 401 — обидва клієнти без токена

**Claude Code — сценарій 2 зі спеки, підтверджено:**

```
warsaw-beer-notoken: http://127.0.0.1:3999/mcp (HTTP)
  - ✘ Failed to connect — Dynamic Client Registration rejected (HTTP 404): 404 Not Found
```

Тобто користувач, який просто забув токен, бачить помилку про **Dynamic Client Registration**.
Слова «401», «unauthorized» чи «token» у повідомленні немає взагалі.

**Codex — сценарій 3:** у стандартний потік помилок лягає точний рядок

```
ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed,
  when UnexpectedServerResponse("HTTP 401: {\"error\":\"unauthorized\"}")
```

але **моделі** видно лише «the tool is unavailable in this session». Тобто діагноз є в лозі й
відсутній там, де його прочитає людина через агента.

## Перевірка `WWW-Authenticate` — і чому його НЕ додано

Спека передбачала: якщо клієнт іде в OAuth-discovery, додати заголовок
`WWW-Authenticate: Bearer realm="warsaw-beer", error="invalid_token"`, повторити пробу й
подивитися, чи змінилося повідомлення.

Зробили саме це — тимчасовим мідлваром на `/mcp`. Заголовок підтверджено на дроті:

```
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer realm="warsaw-beer", error="invalid_token"
```

Повторний health-check Claude Code дав **байт у байт те саме повідомлення**:
`Dynamic Client Registration rejected (HTTP 404): 404 Not Found`.

**Висновок: заголовок не змінює нічого й тому не комітиться.** Повний шлях за
MCP-специфікацією — `WWW-Authenticate: Bearer resource_metadata="…/.well-known/
oauth-protected-resource"` — вимагав би реального OAuth-ресурсу, який ми свідомо не будуємо
(рішення «v1 тільки CLI»); вказувати туди, де нічого нема, було б рівно тією заявкою без доказу,
проти якої написана вся ця гілка. Тимчасовий мідлвар знято, робоче дерево чисте.

## Що з цього випливає для стадії обв'язки

`docs/mcp-uk.md` **зобов'язана** назвати симптом забутого токена дослівно, для кожного клієнта:

- у Claude Code це `Dynamic Client Registration rejected (HTTP 404)` — і це означає «немає або
  неправильний токен», а не проблему з OAuth;
- у Codex це «тула недоступна», а справжня причина (`HTTP 401 unauthorized`) видима лише в
  стандартному потоці помилок.

Без цього абзацу кожен, хто помилиться з токеном, піде шукати неіснуючу OAuth-проблему.
