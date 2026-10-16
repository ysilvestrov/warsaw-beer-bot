# План: `/fest/menu` приймає повну сторінку меню

Спека: `docs/superpowers/specs/2026-10/2026-10-16-fest-menu-body-limit-design.md`. Одна задача — ядро й є вся зміна.

## Задача 1 — власні ліміти `/fest/menu`

Файли: `src/api/middleware/payload-limit.ts`, `src/api/index.ts`, `src/api/routes/fest.ts`, тести
`src/api/index.test.ts`, `src/api/routes/fest.test.ts`, `spec.md`.

1. `payload-limit.ts`: `export const FEST_MENU_HTML_LIMIT_CHARS = 4 * MIB;` поруч із `CHECKINS_HTML_LIMIT_CHARS`.
2. `fest.ts`: `MenuBody.html` → `.max(FEST_MENU_HTML_LIMIT_CHARS)`; `FeedBody` без змін.
3. `index.ts`: route-ліміт `/fest/*` пропускає `/fest/menu` (лишається лише глобальний 4 MiB); коментар
   «same size class as /checkins/sync» виправити — для меню це хибно.
4. Тести (спершу червоні на `main`):
   - `fest.test.ts`: фікстура `venue-menu.html`, доповнена HTML-коментарем до 2 200 000 символів
     (≈ виміряна сторінка WFP22), → `200` з тим самим `items`, що й непаддингова фікстура (число —
     літерал із наявного тесту меню); `html` у `FEST_MENU_HTML_LIMIT_CHARS + 1` символів → `413`.
   - `index.test.ts`: `/fest/feed` у `it.each` route-ліміту з `CHECKINS_SYNC_BODY_LIMIT_BYTES`;
     `/fest/menu` з тілом 2 200 000 байт і хибним токеном → `401` (дійшло до auth, не `413`);
     `/fest/menu` понад `GLOBAL_BODY_LIMIT_BYTES` → `413`, `rejectionLayer: 'global'`.
5. `spec.md`: «Ліміти розміру запитів» і розділ `/fest/menu` — нові числа.
6. Гейт: `npm test && npm run typecheck`.
