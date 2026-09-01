# Popup Feedback and Destructive-Action Safety Design

**Date:** 2026-09-01
**Issues:** #518, #517, #524
**Release:** extension 0.16.0

## Goal

Every popup action reports next to the control that performed it, and the one irreversible action states what it is about to destroy before it destroys it.

The three issues are one defect seen from three angles, which is why they are designed together: a single shared `#status` element is written by three unrelated handlers, so feedback lands away from its button, an unrelated click erases the only explanation on screen, and the screen reader hears two queued announcements that name no control.

## Current behaviour (measured 2026-09-01)

`extension/src/popup/popup.ts` writes `#status` from three places: the disabled-Refresh reason at init (line 103), the refresh result (line 137), and the clear-cache result (line 145). `clearAll()` (`extension/src/cache/store.ts:33`) computes `ours.length` and discards it — the function returns `Promise<void>`, so a single click destroys every `mc2:` key across all ten supported shops and reports two words. `popup.html` carries three `aria-live="polite"` regions (`#syncStatus`, `#status`, `#authNote`), two of which are written in the same init tick on the no-token path.

`initPopup()` is not covered by any test. `popup.test.ts` exercises only pure functions; the defects above all live inside the uncovered wiring.

## Design

### One caption per control

`#status` becomes `#refreshStatus` and belongs to `#refresh` alone. It carries **either** the disabled reason **or** the result of the last refresh; the two are mutually exclusive, because a disabled button cannot be clicked. `#clearAll` gains its own `#clearStatus` in the footer, beside it. `#syncStatus` is unchanged.

`#authNote` loses `aria-live`. It is static text present when the popup opens, and it is the second of the two announcements #524 names.

**`aria-describedby` is deliberately not restored.** #518 expects it to become correct once the disabled reason has its own element. It does not: `<button disabled>` is outside the tab order, so the description is unreachable in the only state where it would matter, and pairing a description with a live region on the same node is what produced the double-speak that `94deadc` removed. The caption sits adjacent to its control and announces on change; that is the whole contract.

### Live regions are armed after init

Each caption receives `aria-live="polite"` **after** initialization has written its initial text, so nothing is announced when the popup opens and every later change — always the result of a user action — is announced once, next to the action. The one exception is `#syncStatus`: its first text arrives from `poll()`'s asynchronous callback, which resolves after arming completes, so a sync already in progress when the popup opens can still be announced on open.

### Two-step clear, counted lazily

`Clear all cache` is a three-state control:

| state | label | on click |
|---|---|---|
| idle | `Clear all cache` | count entries; `N > 0` → armed, `N = 0` → write `Nothing to clear.`, stay idle |
| armed | `Clear cache for N entries?` (danger tint) | clear; write `Cleared N entries.`; return to idle |

The count is taken on the first click, not when the popup opens: counting reads the whole of `chrome.storage.local`, and charging every popup open — including the ones that only sync check-ins — for a number nobody is looking at is the wrong trade. The number appears exactly when it informs a decision.

There is no timer. The armed state persists until the second click or until the popup closes, which happens on blur anyway. Nothing else disarms it: using Refresh or opening the shop list in between leaves the button armed, and the label says so in full. A timed revert would add a timing assumption to the test suite of the same kind #468 had to remove, and "armed until you decide" is a more honest offer than "decide within three seconds".

Reported counts are the counts actually removed, not the count shown when arming; they can differ if a page cached more in between, and the report must describe what happened.

### Copy

| situation | text |
|---|---|
| refresh cleared nothing | `Nothing to refresh — no beers found on this page.` |
| refresh cleared N | `Refreshed — N beers will be rechecked.` |
| refresh could not reach the page | unchanged |
| refresh content script reported failure | `Refresh failed — reload the page and try again.` |
| refresh unavailable (disabled) | unchanged: `Open a supported shop page to refresh it.` |
| clear, empty cache | `Nothing to clear.` |
| clear, N removed | `Cleared N entries.` |
| clear, rejected | `Could not clear the cache — try again.` |

`Refreshed (0 cleared).` is literally true and reads as failure; it is the message a user gets when everything is already correct.

**Refuted 2026-09-01 (fix round 1, task 4 review):** the row above is wrong about what `cleared` counts. `refreshCards` (`extension/src/content/refresh.ts:9-16`) pushes one cache key per **parsed card** found on the page, and the content-script reply (`extension/src/content/main.ts:115`) returns `cleared: keys.length` — a count of cards, not of cache hits. So `cleared === 0` means the adapter found no beer cards on this page, never "the cache was already warm"; a page full of already-cached beers reports the card count, not zero. #524's framing above ("the message a user gets when everything is already correct") is refuted by the code it describes. The copy changed to `Nothing to refresh — no beers found on this page.` / `Refreshed — N beers will be rechecked.`, and the result noun changed from cache-entries (`entries()`) to beers (`beers()`, `popup/popup.ts`) to match what is actually being counted.

### Headings

#524 also proposes an `<h2>` between the action groups. It is dropped: in a 284px surface with three controls, each of which now carries its own caption, heading navigation gains a stop and no information.

## Structure

The wiring is where the defects live, so the wiring becomes testable rather than the tests becoming DOM-shaped around it. The pattern already exists in this codebase: `popup/supported-shops.ts` renders DOM through injected dependencies and is unit-tested in jsdom.

- `cache/store.ts`: `clearAll(): Promise<number>` returns what it removed (the count is already computed), and a new `countAll(): Promise<number>` answers the arming question without destroying anything.
- `popup/clear-cache.ts` (new): a pure state reducer for the three-state control, plus `wireClearButton(button, statusEl, { count, clear })` taking its effects as injected dependencies — no `chrome.*` reference inside the module.
- Result strings are pure exported functions beside the wiring that uses them: the refresh strings in `popup/popup.ts`, the clear strings in `popup/clear-cache.ts`.
- A small `armLiveRegions(...)` helper in `popup/popup.ts` attaches `aria-live` once initial text is in place.
- `initPopup()` shrinks to composition: find nodes, inject the `chrome.*`-backed dependencies.

### Contrast

The armed state is the popup's first danger tint. The token pair must clear 4.5:1 against its background in **both** themes and be verified with the same detector that measured the options page at 2.9:1 — the brand amber `#d9822b` is 2.93:1 on white and a saturated red is as easy to get wrong.

## Tests and evidence

Every test must be mutation-proven: delete the line it covers and watch it go red.

- The reducer: idle → armed → cleared, and the empty-cache path that never arms.
- `wireClearButton` in jsdom: two clicks perform exactly one count and one clear; label and caption text at each step; a second popup session starts idle.
- Result strings, including the zero cases.
- An accessibility guard: no caption carries `aria-live` before init and each carries it after; `#authNote` never does.

Each plan task runs the full extension suite plus typecheck, not a scoped subset — a scoped gate let a regression survive four reviews on #527.

## Documentation

In the same change: the popup sections of `docs/extension-install-uk.md` and `docs/extension-install-en.md` (the two-step clear, the counts, the new copy), the popup contract in `spec.md` (which today describes `Clear all cache` as a single click that clears every `mc2:` key), and `extension/CHANGELOG.md` under `[Unreleased]`.

## Out of scope

#519 and #522 (no-token action tiering, guide-link visibility), #521 (state-first popup), #523 (options-page parity). No new permissions, no manifest change, no store-listing consequence.
