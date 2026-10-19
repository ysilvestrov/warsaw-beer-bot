# План: `bad_shape` не відкриває MCP-breaker (#883)

Спека: `docs/superpowers/specs/2026-10/2026-10-19-fest-mcp-shape-breaker-design.md`.
Гейт: `npm test && npm run typecheck` (25 відомих падінь середовища).

1. **`McpShapeError` і `alertShape`** (`src/jobs/fest-friend-feed.ts`). `readStream` кидає `McpShapeError` на `bad_shape`. Кожна стрічка `runFestFriendFeed` йде у своєму `try`: збій форми → `log.warn` + `alertShape`, цикл триває. Будь-яка інша помилка поводиться, як і раніше. Тести — у `fest-friend-feed.test.ts`.
2. **Око локацій** (`src/jobs/fest-mcp-venues.ts`). `McpShapeError` на `bad_shape`. Збій форми не позначає тік як `failed`, лише `log.warn` + `alertShape`. Тести — у `fest-mcp-venues.test.ts`, серед них `half_open` + `bad_shape` у стрічці → око читає на тому ж тіку.
3. **`spec.md`** — речення в розділах про breaker стрічки й збої ока локацій.
