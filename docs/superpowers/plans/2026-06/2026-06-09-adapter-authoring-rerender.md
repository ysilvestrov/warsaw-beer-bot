# Adapter authoring + re-render robustness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make extension overlay re-render survive any in-shop client-side navigation by design, and cover every adapter with one registry-wide conformance test, plus a runbook for adding new shop adapters.

**Architecture:** `runOverlay` marks each processed card element with `data-beerseen`. `observeReRender` watches `document.body` and re-runs when any parsed card lacks that marker (no disconnect; a re-entrancy guard replaces it). `main.ts`'s side-effect body is extracted into a testable `startOverlay()` that always attaches the observer. A parametrized `conformance.test.ts` drives `startOverlay` over every adapter in the registry, synthesizing container replacement from each adapter's single HTML fixture.

**Tech Stack:** TypeScript (ESM), Vitest + jsdom, MV3 content script. Tests live under `extension/src/**/*.test.ts` (vitest `include`). Fixtures under `extension/tests/fixtures/`.

> All paths below are relative to the `extension/` directory unless noted. Run all `npm` commands from `extension/`.

---

## File Structure

- `src/sites/types.ts` — add required `id` to `SiteAdapter`; re-document `reRenderContainerSelector`.
- `src/sites/beerrepublic.ts`, `src/sites/onemorebeer.ts` — add `id`.
- `src/content/badge.ts` — export a `SEEN_MARKER` constant + `markSeen`/`isSeen` helpers (single home for the marker).
- `src/content/index.ts` (`runOverlay`) — mark each card processed.
- `src/content/rerender.ts` — new API `observeReRender(root, hasUnprocessed, onReRender, opts)`; seen-marker trigger; no disconnect; re-entrancy guard.
- `src/content/rerender.test.ts` — rewrite for the new API.
- `src/content/main.ts` — extract `startOverlay()`; thin bootstrap.
- `src/content/main.test.ts` — new: unit test for `startOverlay` wiring.
- `src/sites/conformance.test.ts` — new: parametrized contract test over `ADAPTERS`.
- `src/sites/beerrepublic.test.ts`, `src/sites/onemorebeer.test.ts` — drop the generic assertions now covered by conformance (keep quirks).
- `docs/adapter-authoring.md` (repo root `docs/`, NOT under `extension/`) — new runbook.
- `spec.md` (repo root) — update §6.

---

## Task 1: Add `id` to the adapter contract

**Files:**
- Modify: `src/sites/types.ts`
- Modify: `src/sites/beerrepublic.ts:8` (object literal start)
- Modify: `src/sites/onemorebeer.ts:28` (object literal start)
- Modify: `src/content/index.test.ts` (two `SiteAdapter` literals lack `id`)
- Test: `src/sites/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/sites/registry.test.ts` inside the existing `describe('pickAdapter', ...)` block (or a new `describe`):

```ts
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
// (these imports already exist at the top of the file)

describe('adapter ids', () => {
  it('every adapter has a unique non-empty id', () => {
    const ids = [beerrepublic, onemorebeer].map((a) => a.id);
    expect(ids).toEqual(['beerrepublic', 'onemorebeer']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/sites/registry.test.ts`
Expected: FAIL — `Property 'id' does not exist on type 'SiteAdapter'` (tsc) or `ids` is `[undefined, undefined]`.

- [ ] **Step 3: Add `id` to the interface**

In `src/sites/types.ts`, add `id` as the first member of `SiteAdapter` and reword the selector doc:

```ts
export interface SiteAdapter {
  /** Stable, unique adapter id; also the fixture name: tests/fixtures/<id>.html. */
  id: string;
  hostMatch(url: URL): boolean;
  parseCards(root: ParentNode): Card[];
  /** Optional: resolve once the (client-rendered) grid has painted cards. */
  waitForGrid?(root: ParentNode): Promise<void>;
  /**
   * Optional perf scope for the re-render check — narrows where cards are
   * re-parsed. Does NOT enable re-render (that is always on). Omit it freely.
   */
  reRenderContainerSelector?: string;
}
```

- [ ] **Step 4: Set `id` on each adapter**

In `src/sites/beerrepublic.ts`, add as the first property of the exported object:

```ts
export const beerrepublic: SiteAdapter = {
  id: 'beerrepublic',
  hostMatch: (url) => url.hostname === 'beerrepublic.eu' || url.hostname.endsWith('.beerrepublic.eu'),
```

In `src/sites/onemorebeer.ts`, add as the first property of the exported object:

```ts
export const onemorebeer: SiteAdapter = {
  id: 'onemorebeer',
  hostMatch: (url) => url.hostname === 'onemorebeer.pl' || url.hostname.endsWith('.onemorebeer.pl'),
```

- [ ] **Step 5: Fix existing adapter literals that now miss `id`**

`src/content/index.test.ts` builds two `SiteAdapter` object literals that will
fail tsc now that `id` is required. Add `id: 'test'` to both.

At `src/content/index.test.ts:27`:
```ts
  return { id: 'test', hostMatch: () => true, parseCards: () => cards };
```

At `src/content/index.test.ts:56` (the inline adapter literal), add `id: 'test',`
as the first property alongside the existing `hostMatch: () => true,`.

- [ ] **Step 6: Run test + typecheck to verify they pass**

Run: `npm test -- src/sites/registry.test.ts src/content/index.test.ts && npm run typecheck`
Expected: PASS; tsc clean (no "Property 'id' is missing" error).

- [ ] **Step 7: Commit**

```bash
git add src/sites/types.ts src/sites/beerrepublic.ts src/sites/onemorebeer.ts src/sites/registry.test.ts src/content/index.test.ts
git commit -m "feat(extension): add required id to SiteAdapter; reclassify reRenderContainerSelector as perf scope"
```

---

## Task 2: Seen-marker helpers in `badge.ts`

The marker lives next to the badge so all DOM-footprint constants are in one place.

**Files:**
- Modify: `src/content/badge.ts`
- Test: `src/content/badge.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/content/badge.test.ts`:

```ts
import { markSeen, isSeen, SEEN_MARKER } from './badge';

describe('seen marker', () => {
  it('marks and detects a processed element', () => {
    const el = document.createElement('div');
    expect(isSeen(el)).toBe(false);
    markSeen(el);
    expect(el.hasAttribute(SEEN_MARKER)).toBe(true);
    expect(isSeen(el)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/content/badge.test.ts`
Expected: FAIL — `markSeen`/`isSeen`/`SEEN_MARKER` not exported.

- [ ] **Step 3: Implement the helpers**

Add to the top of `src/content/badge.ts`, just after the existing `BADGE_MARKER` line:

```ts
export const SEEN_MARKER = 'data-beerseen';

/** Mark a card element as processed by the overlay (badged or not). */
export function markSeen(el: HTMLElement): void {
  el.setAttribute(SEEN_MARKER, '');
}

/** True if the overlay has already processed this card element. */
export function isSeen(el: HTMLElement): boolean {
  return el.hasAttribute(SEEN_MARKER);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/content/badge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/badge.ts src/content/badge.test.ts
git commit -m "feat(extension): add data-beerseen marker helpers"
```

---

## Task 3: `runOverlay` marks processed cards

**Files:**
- Modify: `src/content/index.ts`
- Test: `src/content/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/content/index.test.ts` (it already imports `runOverlay` and builds a fake adapter — match that file's existing helpers; the snippet below is self-contained):

```ts
import { runOverlay } from './index';
import { isSeen } from './badge';
import type { SiteAdapter } from '../sites/types';
import type { MatchResult } from '../api/types';

const res = (is_drunk: boolean, user_rating: number | null = null): MatchResult => ({
  raw: { brewery: 'X', name: '' }, matched_beer: null, is_drunk, user_rating,
});

describe('runOverlay marks cards seen', () => {
  it('marks every parsed card element, drunk or not', async () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    const a = document.getElementById('a') as HTMLElement;
    const b = document.getElementById('b') as HTMLElement;
    const adapter: SiteAdapter = {
      id: 'fake',
      hostMatch: () => true,
      parseCards: () => [
        { el: a, brewery: 'X', name: 'One' },
        { el: b, brewery: 'X', name: 'Two' },
      ],
    };
    const sendMatch = async () => [res(true, 4), res(false)];

    await runOverlay(document, adapter, sendMatch);

    expect(isSeen(a)).toBe(true);
    expect(isSeen(b)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/content/index.test.ts`
Expected: FAIL — `isSeen(a)` is `false` (cards not marked yet).

- [ ] **Step 3: Mark cards in `runOverlay`**

In `src/content/index.ts`, import the helper and mark each card. Change the import line:

```ts
import { renderBadge, markSeen } from './badge';
```

Mark cache-hit cards and matched misses. Update the cache-hit branch and the results loop in `runOverlay`:

```ts
      const cached = await getCached(key);
      if (cached) {
        renderBadge(card.el, cached);
        markSeen(card.el);
      } else {
```

```ts
    results.forEach((result, i) => {
      const miss = misses[i];
      if (!miss) return;
      renderBadge(miss.el, result);
      markSeen(miss.el);
      void setCached(miss.key, result);
    });
```

Note: on a `sendMatch` rejection the function returns before this loop, so failed
misses stay unmarked and will be retried on the next observer tick — intended.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/content/index.test.ts && npm run typecheck`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/content/index.ts src/content/index.test.ts
git commit -m "feat(extension): runOverlay marks processed cards with data-beerseen"
```

---

## Task 4: Rewrite `observeReRender` (seen-marker trigger, no disconnect)

**Files:**
- Modify: `src/content/rerender.ts` (full rewrite)
- Test: `src/content/rerender.test.ts` (full rewrite)

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `src/content/rerender.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { observeReRender } from './rerender';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { document.body.innerHTML = ''; });

describe('observeReRender', () => {
  it('does not fire while hasUnprocessed stays false', async () => {
    const cb = vi.fn();
    const stop = observeReRender(document, () => false, cb, { debounceMs: 20 });
    document.body.innerHTML = '<div class="x"></div>';
    await tick(60);
    expect(cb).not.toHaveBeenCalled();
    stop();
  });

  it('fires once (debounced) when an unprocessed card appears', async () => {
    let unprocessed = false;
    const cb = vi.fn();
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 20 });
    unprocessed = true;
    document.body.appendChild(document.createElement('div'));
    document.body.appendChild(document.createElement('div'));
    await tick(60);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('fires after the grid is replaced with fresh (unprocessed) nodes', async () => {
    document.body.innerHTML = '<div class="grid"></div>';
    let unprocessed = false;
    const cb = vi.fn();
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 20 });
    unprocessed = true; // fresh nodes after a navigation are unmarked
    document.body.innerHTML = '<div class="grid"><div></div></div>';
    await tick(60);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not re-trigger from DOM writes made inside the callback', async () => {
    // callback writes badge nodes (not cards) -> hasUnprocessed flips false after run
    let unprocessed = true;
    const cb = vi.fn(() => {
      unprocessed = false; // overlay marked the cards seen
      document.body.appendChild(document.createElement('span')); // badge write
    });
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 20 });
    document.body.appendChild(document.createElement('div')); // external trigger
    await tick(100);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('re-checks after an async run and fires again if work arrived mid-run', async () => {
    let unprocessed = true;
    let resolveRun: (() => void) | undefined;
    const cb = vi.fn(() => {
      // first run: simulate navigation arriving during the async call
      return new Promise<void>((r) => { resolveRun = () => { r(); }; });
    });
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 10 });
    document.body.appendChild(document.createElement('div'));
    await tick(30);                       // run started, awaiting
    document.body.appendChild(document.createElement('div')); // nav during run
    await tick(30);
    resolveRun?.();                       // finish the first run; cards still unprocessed
    await tick(40);
    expect(cb).toHaveBeenCalledTimes(2);  // re-entrancy guard re-ran
    stop();
  });

  it('stops firing after the disposer is called', async () => {
    const cb = vi.fn();
    const stop = observeReRender(document, () => true, cb, { debounceMs: 20 });
    stop();
    document.body.appendChild(document.createElement('div'));
    await tick(40);
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/content/rerender.test.ts`
Expected: FAIL — old signature `observeReRender(root, selector, cb, opts)` rejects a function as the 2nd arg / behaviour mismatch.

- [ ] **Step 3: Rewrite `rerender.ts`**

Replace the entire contents of `src/content/rerender.ts` with:

```ts
export interface ReRenderOptions {
  debounceMs?: number;
}

/**
 * Re-run `onReRender` whenever the shop renders fresh, unprocessed cards
 * (navigation, SPA re-mount, infinite scroll). Watches `document.body` for child
 * mutations, debounced, and gates each run on `hasUnprocessed()`.
 *
 * No disconnect during the callback: the overlay's own badge writes are not
 * cards and do not flip `hasUnprocessed`, so they never self-trigger; navigation
 * arriving mid-run is caught by the re-entrancy guard. Returns a disposer.
 */
export function observeReRender(
  root: ParentNode,
  hasUnprocessed: () => boolean,
  onReRender: () => unknown,
  opts: ReRenderOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 250;
  const target =
    (root as Document).body ?? (root instanceof Element ? root : (root as Document).documentElement);
  if (!target) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let pending = false;

  const run = async () => {
    running = true;
    try {
      await onReRender();
    } finally {
      running = false;
      if (!stopped && pending) {
        pending = false;
        check();
      }
    }
  };

  const check = () => {
    if (stopped) return;
    if (running) { pending = true; return; }
    if (hasUnprocessed()) void run();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(target, { childList: true, subtree: true });

  return () => {
    stopped = true;
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/content/rerender.test.ts && npm run typecheck`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/content/rerender.ts src/content/rerender.test.ts
git commit -m "feat(extension): observeReRender triggers on unprocessed cards, no disconnect, re-entrancy guard"
```

---

## Task 5: Extract `startOverlay` from `main.ts`

**Files:**
- Modify: `src/content/main.ts`
- Test: `src/content/main.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/content/main.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startOverlay } from './main';
import { isSeen } from './badge';
import type { SiteAdapter } from '../sites/types';
import type { MatchResult } from '../api/types';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { document.body.innerHTML = ''; });

const drunk = (): MatchResult => ({
  raw: { brewery: 'B', name: '' }, matched_beer: null, is_drunk: true, user_rating: 4.2,
});

function fakeAdapter(over: Partial<SiteAdapter> = {}): SiteAdapter {
  return {
    id: 'fake',
    hostMatch: () => true,
    parseCards: (root) =>
      Array.from(root.querySelectorAll<HTMLElement>('.card')).map((el) => ({
        el, brewery: 'B', name: el.textContent ?? '',
      })),
    ...over,
  };
}

describe('startOverlay', () => {
  it('badges the first pass and re-badges after the grid is replaced', async () => {
    document.body.innerHTML = '<div class="grid"><div class="card">One</div></div>';
    const sendMatch = vi.fn(async () => [drunk()]);

    const stop = startOverlay(document, fakeAdapter(), sendMatch, { debounceMs: 10 });
    await tick(0); // let the first async pass resolve
    expect(document.querySelector('.card [data-beerbadge]')).not.toBeNull();

    // simulate AJAX navigation: replace the grid with fresh, unmarked nodes
    document.body.innerHTML = '<div class="grid"><div class="card">One</div></div>';
    expect(isSeen(document.querySelector('.card') as HTMLElement)).toBe(false);
    await tick(40);
    expect(document.querySelector('.card [data-beerbadge]')).not.toBeNull();
    expect(sendMatch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('attaches the observer even when reRenderContainerSelector is absent', async () => {
    document.body.innerHTML = '<div class="card">One</div>';
    const sendMatch = vi.fn(async () => [drunk()]);
    const stop = startOverlay(document, fakeAdapter(), sendMatch, { debounceMs: 10 });
    await tick(0);
    document.body.innerHTML = '<div class="card">One</div>';
    await tick(40);
    expect(sendMatch).toHaveBeenCalledTimes(2); // re-ran without a selector
    stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/content/main.test.ts`
Expected: FAIL — `startOverlay` is not exported from `./main`.

- [ ] **Step 3: Extract `startOverlay` and slim the bootstrap**

Replace the entire contents of `src/content/main.ts` with:

```ts
import { pickAdapter } from '../sites/registry';
import { runOverlay, type SendMatch } from './index';
import { observeReRender, type ReRenderOptions } from './rerender';
import { isSeen } from './badge';
import type { SiteAdapter } from '../sites/types';
import type { MatchReply, MatchMessage } from '../background/index';
import type { MatchResult, RawBeer } from '../api/types';

const sendMatch: SendMatch = (cards: RawBeer[]) =>
  new Promise<MatchResult[]>((resolve, reject) => {
    const message: MatchMessage = { type: 'match', cards };
    chrome.runtime.sendMessage(message, (reply: MatchReply | undefined) => {
      if (chrome.runtime.lastError || !reply) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'no reply'));
        return;
      }
      if (reply.type === 'match:ok') resolve(reply.results);
      else reject(new Error(reply.code));
    });
  });

/**
 * Run the overlay once, then keep it in sync across in-shop navigation. Returns
 * a disposer that detaches the re-render observer.
 */
export function startOverlay(
  doc: Document,
  adapter: SiteAdapter,
  send: SendMatch,
  opts?: ReRenderOptions,
): () => void {
  const run = () => runOverlay(doc, adapter, send);

  const hasUnprocessed = () => {
    const scope = adapter.reRenderContainerSelector
      ? doc.querySelector(adapter.reRenderContainerSelector) ?? doc
      : doc;
    return adapter.parseCards(scope).some((card) => !isSeen(card.el));
  };

  let dispose: () => void = () => {};
  // First pass awaits waitForGrid, so the grid exists before we observe.
  void run().then(() => {
    dispose = observeReRender(doc, hasUnprocessed, run, opts);
  });

  return () => dispose();
}

const adapter = pickAdapter(new URL(window.location.href));
if (adapter) startOverlay(document, adapter, sendMatch);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/content/main.test.ts && npm run typecheck`
Expected: PASS; tsc clean.

> If the `parseCards` scope argument trips a type error because the adapter
> signature expects `ParentNode`, note `doc.querySelector(...)` returns
> `Element | null` and `?? doc` widens to `ParentNode` — already compatible.

- [ ] **Step 5: Commit**

```bash
git add src/content/main.ts src/content/main.test.ts
git commit -m "refactor(extension): extract testable startOverlay; observer always attached"
```

---

## Task 6: Conformance test over the registry

**Files:**
- Create: `src/sites/conformance.test.ts`

- [ ] **Step 1: Write the conformance test**

Create `src/sites/conformance.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADAPTERS } from './registry';
import { startOverlay } from '../content/main';
import type { MatchResult, RawBeer } from '../api/types';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixturePath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.html`);

// Load a fixture's <body> into the live jsdom document so MutationObserver works.
function mountFixture(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

// Mark the first beer of each request drunk so badges appear deterministically.
const sendMatch = (cards: RawBeer[]): Promise<MatchResult[]> =>
  Promise.resolve(
    cards.map((raw, i) => ({
      raw: { brewery: raw.brewery, name: raw.name },
      matched_beer: null,
      is_drunk: i === 0,
      user_rating: i === 0 ? 4 : null,
    })),
  );

beforeEach(() => { document.body.innerHTML = ''; });

describe.each(ADAPTERS.map((a) => [a.id, a] as const))('adapter contract: %s', (id, adapter) => {
  it('has a fixture at tests/fixtures/<id>.html', () => {
    expect(existsSync(fixturePath(id))).toBe(true);
  });

  it('parses at least one well-formed card from its fixture', () => {
    const parsed = new DOMParser().parseFromString(readFileSync(fixturePath(id), 'utf8'), 'text/html');
    const cards = adapter.parseCards(parsed);
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.el).toBeInstanceOf(HTMLElement); // global; jsdom shares one realm
    }
  });

  it('reRenderContainerSelector, when set, matches a node in the fixture', () => {
    if (!adapter.reRenderContainerSelector) return;
    const parsed = new DOMParser().parseFromString(readFileSync(fixturePath(id), 'utf8'), 'text/html');
    expect(parsed.querySelector(adapter.reRenderContainerSelector)).not.toBeNull();
  });

  it('re-badges after the grid is replaced with fresh nodes', async () => {
    const html = readFileSync(fixturePath(id), 'utf8');
    mountFixture(html);
    const stop = startOverlay(document, adapter, sendMatch, { debounceMs: 10 });
    await tick(20);
    expect(document.querySelector('[data-beerbadge]')).not.toBeNull();

    // synthesize AJAX navigation: identical content, fresh badge-less nodes
    mountFixture(html);
    expect(document.querySelector('[data-beerbadge]')).toBeNull();
    await tick(50);
    expect(document.querySelector('[data-beerbadge]')).not.toBeNull();
    stop();
  });
});
```

- [ ] **Step 2: Export `ADAPTERS` from the registry**

The test imports `ADAPTERS`. In `src/sites/registry.ts`, change:

```ts
const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer];
```
to:
```ts
export const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer];
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm test -- src/sites/conformance.test.ts && npm run typecheck`
Expected: PASS for both `beerrepublic` and `onemorebeer` across all four cases; tsc clean.

> If `re-badges after replacement` fails for an adapter, the cause is real: the
> fixture's first beer must be parseable as a card whose `el` is the badge host.
> Both existing fixtures satisfy this. Do NOT weaken the assertion.

- [ ] **Step 4: Commit**

```bash
git add src/sites/registry.ts src/sites/conformance.test.ts
git commit -m "test(extension): registry-wide adapter conformance test (parse + selector + re-render on replacement)"
```

---

## Task 7: Trim the now-duplicated bespoke adapter tests

The conformance test now owns parse-well-formedness, selector validity, and re-render. Keep only shop-specific quirks.

**Files:**
- Modify: `src/sites/beerrepublic.test.ts`
- Modify: `src/sites/onemorebeer.test.ts`

- [ ] **Step 1: Edit `beerrepublic.test.ts`**

Remove the now-redundant cases and keep the brewery/name split quirk. Delete these two `it` blocks:

```ts
  it('extracts a non-empty name and an element for every card', () => { ... });
```
```ts
  it('defines a re-render container for AJAX collection updates', () => {
    expect(beerrepublic.reRenderContainerSelector).toBe('section[data-section-type="collection"]');
  });
```

Keep `parses many cards from the SSR grid`, `splits brewery (vendor) from name (title)`, and `does not define waitForGrid (SSR)`.

- [ ] **Step 2: Edit `onemorebeer.test.ts`**

Keep only the shop quirks: the `°`-is-Plato handling (abv omitted / name trimming) and brewery/name extraction. Remove any generic "every card has a name and an element" assertion that merely duplicates conformance (leave the count assertion if it documents the fixture's expected size).

- [ ] **Step 3: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS, no reduction in real coverage (the removed assertions now live in `conformance.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/sites/beerrepublic.test.ts src/sites/onemorebeer.test.ts
git commit -m "test(extension): trim bespoke adapter tests now covered by conformance"
```

---

## Task 8: Adapter-authoring runbook

**Files:**
- Create: `docs/adapter-authoring.md` (repo root `docs/`, NOT under `extension/`)

- [ ] **Step 1: Write the runbook**

Create `docs/adapter-authoring.md`:

```markdown
# Як додати адаптер нового магазину

Адаптер — це опис, як розпарсити сітку товарів конкретного магазину й де
накладати бейджі. Re-render при навігації працює **автоматично** для будь-якого
магазину — окремо вмикати його не треба.

> Ментальна модель: будь-який магазин з AJAX-навігацією (Shopify, Nuxt тощо)
> потребує re-render незалежно від того, SSR початковий рендер чи ні.
> **SSR ≠ «спостерігач не потрібен».**

## Кроки

1. **Зняти фікстуру сторінки колекції** → `extension/tests/fixtures/<id>.html`,
   де `<id>` — короткий стабільний ідентифікатор магазину.
   - SSR-магазин: `curl -A 'Mozilla/5.0' '<url колекції>' > extension/tests/fixtures/<id>.html`
   - SPA-магазин: дамп після рендеру (див. `extension/scripts/capture-omb-fixture.ts`
     як приклад headless-Playwright захоплення зі scroll).

2. **Реалізувати `SiteAdapter`** у `extension/src/sites/<id>.ts`:
   - обов'язкові: `id` (= ім'я фікстури), `hostMatch(url)`, `parseCards(root)`;
   - опційний `waitForGrid(root)` — лише для SPA, де сітка домальовується;
   - опційний `reRenderContainerSelector` — **тільки** звуження скоупу re-parse
     на шумних сторінках. Він НЕ вмикає re-render. Лиши порожнім, якщо сумніваєшся.

3. **Зареєструвати** адаптер у `extension/src/sites/registry.ts` (масив `ADAPTERS`).

4. **Прогнати конформанс-тест:** `cd extension && npm test -- src/sites/conformance.test.ts`.
   Він автоматично перевіряє парс, валідність селектора і **re-render після
   заміни сітки**. Червоний через відсутню фікстуру = нагадування зробити крок 1.

5. **Додати bespoke-тест** `extension/src/sites/<id>.test.ts` тільки на квірки
   магазину (одиниці виміру, формат назв тощо). Загальний контракт уже покрито
   конформансом — не дублюй його.

6. **Перевірити в реальному браузері** на 1–2 сторінках магазину: бейджі
   з'являються при першому завантаженні і **лишаються після пагінації/фільтра**.

## Manifest

Хости в `extension/manifest`-конфізі (content-script `matches`) мають включати
домен нового магазину — інакше content script туди не інжектиться.
```

> Verify the `capture-omb-fixture.ts` path and the manifest `matches` location
> before finalizing wording: run `ls extension/scripts/` and
> `grep -rn "matches" extension/` and adjust the two references if the repo
> differs. Fix the doc to match reality; do not invent paths.

- [ ] **Step 2: Commit**

```bash
git add docs/adapter-authoring.md
git commit -m "docs: runbook for adding a new shop adapter"
```

---

## Task 9: Update `spec.md §6`

**Files:**
- Modify: `spec.md` (repo root), §6 around lines 707–725

- [ ] **Step 1: Update the adapter + tests bullets**

In `spec.md §6`:

- In the **Per-site адаптери** bullet, note that each adapter has a stable `id`
  (= fixture name) and that `reRenderContainerSelector` is an optional re-parse
  scope, not a re-render enabler.
- In the **Потік** bullet, replace the "`beerrepublic` — матч на кожне
  завантаження; `onemorebeer` — re-render observer на контейнері" wording with:
  re-render is uniform across adapters — the overlay marks processed cards
  (`data-beerseen`) and a `document.body` observer re-runs `runOverlay` whenever a
  parsed card is unmarked (navigation / SPA re-mount / infinite scroll); the
  optional `reRenderContainerSelector` only narrows the re-parse scope.
- In the **Тести** bullet, replace the per-adapter description with: the adapter
  **contract is covered by a registry-wide conformance test**
  (`src/sites/conformance.test.ts`) — fixture presence, parse, selector validity,
  and re-render after grid replacement — while bespoke per-adapter tests cover
  only shop quirks. Reference the runbook `docs/adapter-authoring.md`.

Make these edits as prose consistent with the surrounding Ukrainian text; do not
restructure unrelated parts of §6.

- [ ] **Step 2: Sanity-check the spec reads coherently**

Run: `grep -n "data-beerseen\|conformance\|adapter-authoring\|reRenderContainerSelector" spec.md`
Expected: the new references are present and the old "observer only on onemorebeer / selector enables re-render" framing is gone.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): §6 uniform seen-marker re-render + registry conformance test + adapter runbook"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite + typecheck + build**

Run (from `extension/`): `npm test && npm run typecheck && npm run build`
Expected: all tests pass; tsc clean; `vite build` succeeds.

- [ ] **Step 2: Confirm the forcing function works (throwaway check, revert after)**

Temporarily add a dummy adapter with `id: 'zzz-nofixture'` to `ADAPTERS`, run
`npm test -- src/sites/conformance.test.ts`, and confirm the "has a fixture"
case **fails red**. Then revert the dummy.

Run: `npm test -- src/sites/conformance.test.ts`
Expected: with the dummy present → FAIL on `adapter contract: zzz-nofixture › has a fixture`; after revert → PASS.

- [ ] **Step 3: No commit** (verification only; the revert leaves the tree clean)

---

## Self-Review notes (already reconciled)

- **Spec coverage:** §1 → Tasks 2–4; §2 → Task 6; §3 → Task 5; §4 → Tasks 8–9. `id` (§2) → Task 1.
- **Type consistency:** `observeReRender(root, hasUnprocessed, onReRender, opts)` used identically in Tasks 4, 5, 6; `SEEN_MARKER`/`markSeen`/`isSeen` defined in Task 2 and consumed in Tasks 3, 5; `ADAPTERS` exported in Task 6 and consumed by the conformance test; `startOverlay` signature identical in Tasks 5 and 6.
- **Behavioral guard:** failed `sendMatch` leaves misses unmarked (Task 3) → retried next tick (Task 4 re-entrancy), consistent with the design's await-window handling.
```