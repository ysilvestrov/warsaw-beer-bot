# План (ядро): статус бачить кожне око, живий алерт — лише коли бот сліпий (#885)

Спека: `docs/superpowers/specs/2026-10/2026-10-19-fest-status-eyes-design.md` (затверджено 19.10).
Обв'язка (заглушення чинних сповіщень у сесії — `festNotice`, документи) — окремим планом після рев'ю
ядра. Гейт: `npm test && npm run typecheck` (25 відомих падінь середовища).

## Задача 1 — домен `src/domain/fest/eye-health.ts`

```ts
export interface Window { from: number; to: number }
export interface Gap { ms: number; from: number }
/** Найдовший відрізок вікна, не покритий жодним спаном (спани можуть перетинатись і виходити за вікно). */
export function longestGap(spans: Span[], w: Window): Gap;
/** Сліпота головної в межах сесії: now − max(start, найпізніший to_at ≤ now); поза сесією — 0. */
export function blindMs(spans: Span[], session: Window, now: number): number;
export const EYE_GAP_MS = { mcp_venue: 15 * MIN, server: 30 * MIN, laptop: 15 * MIN };
export const BLIND_MS = 10 * MIN;
```

Тести: порожні спани — уся довжина вікна; перетин і вихід за межі; дірка на початку/кінці; рівно на порозі.
`blindMs`: до сесії — 0; перший тік без спанів — від `start`; після нічного спану — від `start`.

## Задача 2 — статус

- `src/storage/fests.ts`: `recentOrNextFests(db, now)` — як `currentOrNextFests`, ще 24 год після кінця.
- `src/jobs/status-inputs.ts` `readFest`: вікно сесії = поточна (до `now`) або остання, що закінчилась за
  24 год; спани кожного ока на головній (`menu_venue_id`) у вікні; `eyes: { mcp: boolean; server: boolean }`
  (з `StatusInputOptions.festEyes`, яке `dailyStatusEnvDeps` заповнює з `FEST_MCP_URL` і `UNTAPPD_SESSION_COOKIE`);
  ноутбук — увімкнений, якщо має хоч один спан у вікні.
- `src/domain/status/evaluate.ts` `evaluateFest`: 🟡 «<око> не покривало головну N хв (з HH:MM)» для
  увімкнених очей за `EYE_GAP_MS`; 🟡 «головну N хв не покривали ні MCP, ні ноутбук», якщо хоч одне з них
  увімкнене і дірка їхнього об'єднання > 30 хв; меню й keepalive як були. Без вікна сесії — лише меню/keepalive.

Тести (`evaluate.test.ts`, `status-inputs.test.ts`): WFP22-подібні спани — MCP 391 хв → рядок з 15:29;
вимкнене MCP — нічого; MCP без спанів у сесії — рядок на всю сесію; ноутбук без спанів — нічого;
фест через 23 / 25 год після кінця.

## Задача 3 — живий алерт

`src/jobs/fest-blind.ts` `runFestBlindCheck({ db, log, notifyAdmin }, now)`: для кожного фесту з
реальною сесією, що триває (`start ≤ now ≤ end`), `blindMs` спанів усіх очей на головній > `BLIND_MS` →
`sendThrottledAlert` (`fest_blind_alert_at`, раз на годину): «Фест: бот не бачить головну локацію жодним
оком N хв — алерти й статуси кранів зараз неправдиві». Виклик — у тому ж кроні, що `runFestAlerts`.

Тести: 9 хв — нічого; 11 — один; ще 30 хв — нічого; поза сесією й у ±30 хв — нічого; порожньо — від start.
