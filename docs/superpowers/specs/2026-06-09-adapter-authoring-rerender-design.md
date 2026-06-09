# Adapter authoring + re-render robustness — design

- **Date:** 2026-06-09
- **Status:** approved (brainstorming)
- **Scope:** browser extension (`extension/`) — per-site adapters and the SPA re-render mechanism
- **Related spec:** `spec.md §6` (Browser Extension Client)

## Background

PR #96 fixed two *independent* root causes that both prevented overlay badges
from re-rendering after in-shop client-side ("AJAX") navigation:

1. **Deaf observer on container replacement** (`rerender.ts`). The
   `MutationObserver` was attached to the grid container node itself. Shops swap
   that node on navigation, detaching the observed node, after which the observer
   receives no further mutations. (#96 fixed this by observing `document.body` +
   a relevance filter + re-resolving the container after each run.)
2. **Observer never wired** (`beerrepublic.ts`). The adapter omitted
   `reRenderContainerSelector`, and `main.ts` attaches the observer only
   `if (adapter.reRenderContainerSelector)`. SSR initial render was wrongly
   assumed to mean "no re-render needed", but Shopify does AJAX pagination
   without a full reload, so badges never refreshed.

Both grow from one wrong mental model — **"SSR ⇒ full reload ⇒ no observer
needed"** — and both failed *silently* (no error, just stale badges). The #96
tests covered only the benign steady-state path (mutations inside a stable
container) and a string-equality assertion on the selector; neither exercised
container replacement nor verified the selector matches real DOM.

A residual risk #96 did not close: `run()` disconnects the observer for the
whole duration of the async `onReRender()` (a network `/match` call). Navigation
completing inside that window leaves no pending mutation to re-trigger → stale
badges.

## Goals

1. Make the bug class structurally impossible, not patched per-adapter.
2. Provide *non-isolated* coverage: one test that automatically applies to every
   registered adapter, and forces new adapters to be covered.
3. Close the await-window residual risk.
4. Document how to add a new shop adapter so the mental model that caused the
   bugs is stated explicitly.

## Design

### 1. Re-render mechanism — "any unprocessed card" as single source of truth

Replace "observe the container + relevance filter + disconnect during the async
callback" with **the presence of an unprocessed card as the single source of
truth** for whether to re-run. All three problems dissolve as a consequence.

`runOverlay` marks every card element it has processed with a `data-beerseen`
attribute. The observer re-runs whenever a parsed card lacks that marker — i.e.
whenever the shop has rendered fresh card nodes (navigation, SPA re-mount,
infinite-scroll append), regardless of whether the content differs. (A content
signature was considered and rejected: identical-content node replacement —
e.g. a browser-back SPA re-mount, and the conformance test's "clone the same
grid" synthesis — leaves a fresh, badge-less DOM with an unchanged signature, so
a signature would miss it. The seen-marker is also simpler.)

New module API (`content/rerender.ts`) — knows nothing about adapters:

```ts
observeReRender(
  root: ParentNode,
  hasUnprocessed: () => boolean,
  onReRender: () => unknown,
  opts?: { debounceMs?: number },
): () => void   // disposer
```

Behaviour:

- Observe **`document.body`** (`childList + subtree`), debounced (default 250 ms).
- On each debounced quiet period, call `hasUnprocessed()`. **Re-run `onReRender`
  only when it returns true.**
- `hasUnprocessed` is built by the caller from the adapter's own cards:
  `parseCards(scope).some(c => !c.el.hasAttribute('data-beerseen'))`.
- **No disconnect during the callback.** Our own badge nodes are not cards and do
  not clear the marker, so self-writes never re-trigger. Navigation during an
  in-flight `onReRender` still produces body mutations that get debounced and
  caught.
- **Re-entrancy guard** (replaces the disconnect): a `running` flag. A check that
  fires while a run is in flight sets `pending`; when the run finishes, if
  `pending`, re-check `hasUnprocessed` and run again if needed. Handles rapid
  back-to-back navigation correctly.

Removed: `isRelevant`, container tracking, the `observeTarget` heuristic. The
module is smaller and strictly more correct.

| Problem | Why it disappears |
|---|---|
| Deaf observer (replacement) | Observe `body`, not the container; cards re-parsed each check. |
| Forgotten selector | Trigger comes from `parseCards`, not a selector — nothing to forget. |
| Await-window | No disconnect; the marker distinguishes fresh cards from self-writes; mid-call nav still observed. |
| Identical-content re-mount | Fresh nodes lack the marker → re-run (a content signature would miss this). |

Trade-off accepted: on a noisy page we run `parseCards` once per quiet period
over the document. The optional `reRenderContainerSelector` (see §3) now only
*narrows the parse scope* as a perf optimization; it no longer gates whether the
mechanism runs.

### 2. Conformance test over the registry (non-isolated coverage)

`src/sites/conformance.test.ts` iterates the **`ADAPTERS` array imported from the
registry**, so a new adapter is automatically covered or CI fails.

Adapter→fixture binding: add a stable `id: string` to `SiteAdapter`
(e.g. `'beerrepublic'`). Convention: `tests/fixtures/${adapter.id}.html`.

For each adapter the test asserts:

1. **Fixture exists** — `readFileSync(tests/fixtures/${id}.html)`; a missing file
   **fails** (does not skip). This is the forcing function: registering an
   adapter without a fixture turns CI red.
2. **Parse** — `parseCards(fixtureDoc)` returns ≥1 card; each has a non-empty
   `name` and `el instanceof HTMLElement`.
3. **Selector validity** — if `reRenderContainerSelector` is set,
   `fixtureDoc.querySelector(selector)` is non-null (kills the "selector set but
   wrong/stale" failure mode that #96's string assertion missed).
4. **Re-render on container replacement** (synthesized from the single fixture):
   - load the fixture into a `document`;
   - `startOverlay(document, adapter, mockSendMatch, { debounceMs: 10 })` (mock
     returns drunk=true for some beers) → first pass applies badges;
   - programmatically **replace the grid with a clone of the same fixture**
     (fresh, badge-less, marker-less nodes) — reproduces AJAX navigation / bug 1.
     Content is intentionally identical: the seen-marker trigger fires on fresh
     nodes regardless of content (§1), so this is a valid synthesis;
   - wait for the debounce;
   - assert `onReRender` fired again **and** badges were applied to the new nodes.

`hasUnprocessed` is built with the same helper used in production (§3), so the
test exercises the real path, not a parallel imitation.

Bespoke per-adapter tests shrink to **shop-specific quirks only** (e.g.
onemorebeer's `°` = degrees Plato not ABV; brewery/name splitting). The generic
contract (parse + re-render + selector validity) moves to the conformance test.

### 3. Extract `startOverlay` (testability)

`content/main.ts` currently runs as an import side-effect, so it cannot be driven
from a test. Extract a pure function:

```ts
export function startOverlay(
  doc: Document,
  adapter: SiteAdapter,
  sendMatch: SendMatch,
  opts?: { debounceMs?: number },
): () => void   // disposer
```

It performs what `main.ts`'s body does today:

1. first pass `runOverlay(doc, adapter, sendMatch)` (awaits `waitForGrid` if present);
2. build `hasUnprocessed` from `adapter.parseCards`, scoped by the optional
   `reRenderContainerSelector` (set → `doc.querySelector(sel) ?? doc`; unset → `doc`);
3. **always** attach `observeReRender(doc, hasUnprocessed, () => runOverlay(...), opts)`
   — no `if (selector)` gate, so the forgotten-selector bug cannot recur;
4. return a disposer (for test teardown and clean shutdown).

`main.ts` becomes a thin bootstrap: `pickAdapter` → `startOverlay`. This is the
only structural refactor and it directly serves the goal — without it the
conformance test cannot honestly drive the production path.

### 4. Runbook + spec update

**`docs/adapter-authoring.md`** (Ukrainian, the project's language) — "How to add
a new shop adapter", aimed also at `good first issue` contributors (#87):

1. Capture a fixture → `tests/fixtures/<id>.html` (SSR: `curl`; SPA:
   headless-Playwright scroll dump — method already in `spec.md §6`).
2. Implement `SiteAdapter` in `src/sites/<id>.ts`: required `id`, `hostMatch`,
   `parseCards`; optional `waitForGrid` (SPA grids) and `reRenderContainerSelector`
   (**parse-scope optimization only** — it does NOT enable re-render, which is
   on by default).
3. Register in `registry.ts`.
4. Run the conformance test — it auto-covers parse + re-render + selector
   validity. Red due to a missing fixture is the reminder to do step 1.
5. Add a bespoke test only for shop-specific quirks.
6. Verify in a real browser on 1–2 shop pages.

State the mental model explicitly: **any shop with AJAX navigation (Shopify,
Nuxt, …) needs re-render regardless of whether the initial render is SSR.
SSR ≠ "no observer needed".**

**`spec.md §6` update (same PR — CLAUDE.md requirement):**

- Adapter contract: `id` required; re-render is the **default** seen-marker
  mechanism; `reRenderContainerSelector` reclassified from an enabler to an
  optional scope optimization.
- Tests section (~line 723): contract coverage is the **conformance test over the
  registry** (parse + container replacement + selector validity); bespoke tests
  remain only for quirks.
- Reference `docs/adapter-authoring.md`.

## Out of scope (YAGNI)

- A second "post-navigation" fixture per adapter (single fixture + synthesized
  replacement suffices to catch the bug class).
- Adapter codegen / scaffold template.
- Any refactor not serving these three problems.

## Summary

| # | Change | Closes |
|---|---|---|
| 1 | `rerender.ts` → `data-beerseen` marker ("any unprocessed card") as the single source of truth; observe `body`; no disconnect; re-entrancy guard | deaf observer, forgotten selector, await-window, identical-content re-mount |
| 2 | `conformance.test.ts` parametrized over `ADAPTERS`; container replacement synthesized from one fixture; `id` convention; selector validity | regression of all three + future adapters |
| 3 | Extract `startOverlay()`; `main.ts` → thin bootstrap; observer always attached | forgotten selector (structurally) + honest test |
| 4 | `docs/adapter-authoring.md` + `spec.md §6` update | the mental model that caused the bugs |
