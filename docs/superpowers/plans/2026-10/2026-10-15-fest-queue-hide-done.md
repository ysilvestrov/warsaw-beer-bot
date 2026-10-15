# План: `/fest queue` ховає келихи, випиті всіма

> **Спека:** `docs/superpowers/specs/2026-10/2026-10-15-fest-queue-hide-done-design.md`.
> **Гейт:** `npm test && npm run typecheck`.

## Задача 1 — `formatQueue` і лічильник

`src/bot/commands/fest-format.ts`: у `formatQueue` — `open = queueOrder(view).filter(isOpen)`,
`hidden = view.items.length - open.length`; tail `[t('fest.queue_done_hidden', { count: hidden })]`,
коли `hidden > 0`. Ключ `fest.queue_done_hidden` у `uk`/`pl`/`en`. Тести в `fest-format.test.ts`.

## Задача 2 — документи

`spec.md` (рядок `/fest queue`), `docs/USER-GUIDE.md` (`/fest queue`).
