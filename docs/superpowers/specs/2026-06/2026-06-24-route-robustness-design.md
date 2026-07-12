# Design — `/route` robustness: bound TSP + interrupted-progress registry

**Date:** 2026-06-24
**Context:** Investigation of a "stuck `/route`" report (2026-06-24). Two distinct latent
bugs surfaced; neither was the user's actual symptom (that was orphaned progress messages
from a deploy), but both are real and worth fixing.

## Background (root causes)

1. **Exponential `buildRoute` blowup.** `buildRoute → openTsp` in `src/domain/router.ts` is
   exact Held-Karp, `O(2^|S|·n²)` time + `O(2^|S|·n)` memory, with **no cap on `|S|`** (the
   spec assumed `|S| ≤ ~8`; nothing enforces it). `greedySetCover` selects more pubs as `N`
   grows. Measured on prod data for a power-user (11501 tried beers → 198 distinct
   *interesting*/untried in Warszawa): `N=100 → |S|=10` (270 ms); `N=140 → |S|=17` (1.4 s);
   **`N≥160 → |S|≥18 →` minutes / GBs / OOM** (731 MB peak seen on a killed process).
   Triggered only by an explicit large argument (`/route 200`) — a latent DoS.

2. **Orphaned progress messages on deploy.** `/route` and `/refresh` run their heavy work
   as a detached fire-and-forget `void (async () => {…})()` that edits a progress message.
   A deploy (`systemctl restart` → SIGTERM) kills the in-flight background promise, so its
   progress message **freezes forever** at whatever stage it reached (`preparing` /
   `searching_tour` / refresh progress). The bot has a graceful-shutdown path
   (`src/shutdown.ts`) but does nothing about these messages.

## Decisions

### Bug 1 — bound the TSP (cap N=70 + heuristic fallback)

- **Command layer (`src/bot/commands/route.ts`):** after computing `N`, clamp it:
  `N = Math.min(Math.max(1, N), MAX_ROUTE_N)` with `MAX_ROUTE_N = 70`. Silent — the result
  header already shows the actual pub/beer counts; nobody crawls 70+ beers, so a clamp
  message is unnecessary (YAGNI).
- **Algorithm layer (`src/domain/router.ts`):** introduce `solveTour(pubs, opts)` that
  dispatches by size:
  - `pubs.length ≤ HELD_KARP_MAX (12)` → exact Held-Karp (the current `openTsp` logic, kept
    — optimal for small sets).
  - otherwise → **nearest-neighbour + 2-opt** heuristic (`O(|S|²)` per 2-opt sweep, a small
    bounded number of sweeps) — instant for any `|S|`, near-optimal in practice.
  - `buildRoute` and `localSwapForDistance` both call `solveTour` instead of `openTsp`
    directly, so every TSP evaluation is bounded.

  Cap N=70 alone is **not** sufficient (`|S| ≤ N`, so a pathological sparse-interesting
  distribution could still drive `|S|` past the safe Held-Karp range); the `solveTour`
  size guard is the actual safety net and makes a blowup impossible regardless of `N` or
  data. The N cap is a sane product limit on top.

  `HELD_KARP_MAX = 12`: at `|S|=12` exact DP is ~270 ms in the worst measured case; above
  that the heuristic takes over before the exponential bites.

### Bug 2 — interrupted-progress registry

- **New module `src/bot/active-progress.ts`** — a process-wide registry of in-flight
  progress messages:
  - Entry shape: `{ chatId: number; messageId: number; locale: Locale; lastText: string }`,
    stored in a `Map` keyed `${chatId}:${messageId}`.
  - `trackProgress(chatId, messageId, locale)` → handle `{ update(text: string): void; release(): void }`.
    `update` stores the latest progress text (so the interrupt notice can be appended to
    real context); `release` removes the entry.
  - `interruptActiveProgress(telegram, makeTranslator)` → for each remaining entry, edit the
    message to `lastText + '\n\n' + makeTranslator(locale)('common.interrupted_by_restart')`,
    best-effort (`.catch` swallow per edit), then clear the map. `telegram` is typed
    `Pick<Telegram, 'editMessageText'>`; `makeTranslator` is `createTranslator`.
- **Integration in `route.ts` and `refresh.ts`:** create
  `const tracker = trackProgress(chatId, messageId, locale)` right after `messageId`; in the
  `notify` send callback call `tracker.update(text)` before the edit; wrap the entire
  detached background body in `try { … } finally { tracker.release(); }` so the entry is
  always cleared on normal completion or error (only a hard kill leaves it for the shutdown
  sweep).
- **`src/shutdown.ts`:** add optional `interruptActiveProgress?: () => Promise<void>` to
  `ShutdownDeps`; in `shutdown()`, call it **early** (right after logging "shutdown
  initiated", before stopping cron jobs and the bot — the Telegram API client stays usable
  after `bot.stop()`, but doing it first maximises the window), wrapped in try/catch that
  logs but never throws.
- **`src/index.ts`:** wire
  `interruptActiveProgress: () => interruptActiveProgress(bot.telegram, createTranslator)`.
- **i18n:** new key `common.interrupted_by_restart`:
  - en: `⚠️ Interrupted by a restart — please re-run the command.`
  - uk: `⚠️ Перервано рестартом — повтори команду.`
  - pl: `⚠️ Przerwano przez restart — uruchom polecenie ponownie.`

## Out of scope / unchanged

- The orphaned messages that already exist from past deploys are not retroactively fixed
  (the bot has no record of them); this only prevents new orphans going forward.
- No change to OSRM usage, the distance cache, or the result format.
- The demo OSRM `/table` 100-coordinate cap is noted as a separate latent cliff (not hit
  per-city today, max Warszawa = 43 pubs) and is left for a future change.

## Testing (Vitest)

- `src/domain/router.test.ts`:
  - existing small-`n` optimality test stays (exact Held-Karp path, `|S| ≤ 12`).
  - new: `buildRoute`/`solveTour` on ~20 pubs completes near-instantly (no exponential),
    returns a tour that visits every selected pub exactly once with a finite distance.
- `src/bot/active-progress.test.ts` (next to the module):
  - `trackProgress` registers an entry; `update` changes `lastText`; `release` removes it.
  - `interruptActiveProgress` edits every active entry with the localized suffix appended to
    `lastText`, then clears the map; a released entry is never edited; a failing edit does
    not abort the others.

## Spec

Update `spec.md` `/route` section: N is clamped to ≤70; the tour solver is exact Held-Karp
for `≤12` pubs and a nearest-neighbour + 2-opt heuristic above that. Note the graceful
"interrupted by restart" handling of in-flight `/route` and `/refresh` progress messages.
