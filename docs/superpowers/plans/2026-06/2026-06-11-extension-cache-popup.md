# Extension cache-control popup (#3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-action popup with two buttons — "Refresh this page" (re-fetch badges for the beers on the open supported-shop tab) and "Clear all cache".

**Architecture:** Cache keys are site-independent (`normalizeKey(brewery, name)`), so "per-site" is implemented as "refresh the open page". The popup messages the active tab's content script with `{type:'refresh-page'}`; the content script resets the visible cards (removes badge + seen marker — required because `renderBadge` is idempotent), drops their cache keys, and re-runs the overlay so badges refresh live. "Clear all" removes every `mc2:` key directly from the popup.

**Tech Stack:** TypeScript, Chrome MV3 (manifest via `@crxjs/vite-plugin`), Vitest + jsdom.

**Order:** PR #3 of the batch. Server-independent — can be built in parallel with #1/#2, but kept last by agreement.

**Worktree:** Create via `superpowers:using-git-worktrees` (branches from `origin/main`; cherry-pick the doc commits if needed — `reference_worktree_docs_cherrypick`). All commands below run from `extension/`.

---

### Task 1: `clearKeys` + `clearAll` in the cache store

**Files:**
- Modify: `extension/src/cache/store.ts`
- Test: `extension/src/cache/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `extension/src/cache/store.test.ts` (extend the import on line 2 to include `clearKeys, clearAll`):

```typescript
it('clearKeys removes only the given keys', async () => {
  await setCached('a|x', sample);
  await setCached('b|y', sample);
  await clearKeys(['a|x']);
  expect(await getCached('a|x')).toBeNull();
  expect(await getCached('b|y')).toEqual(sample);
});

it('clearKeys is a no-op for an empty list', async () => {
  await setCached('a|x', sample);
  await clearKeys([]);
  expect(await getCached('a|x')).toEqual(sample);
});

it('clearAll removes every cached entry', async () => {
  await setCached('a|x', sample);
  await setCached('b|y', sample);
  await clearAll();
  expect(await getCached('a|x')).toBeNull();
  expect(await getCached('b|y')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cache/store.test.ts`
Expected: FAIL (`clearKeys` / `clearAll` not exported).

- [ ] **Step 3: Implement**

Append to `extension/src/cache/store.ts`:

```typescript
export async function clearKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await chrome.storage.local.remove(keys.map((k) => PREFIX + k));
}

export async function clearAll(): Promise<void> {
  const all = await chrome.storage.local.get();
  const ours = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (ours.length > 0) await chrome.storage.local.remove(ours);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cache/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/cache/store.ts extension/src/cache/store.test.ts
git commit -m "feat(extension): clearKeys + clearAll cache helpers (#3)"
```

---

### Task 2: `resetCard` in badge.ts

**Files:**
- Modify: `extension/src/content/badge.ts`
- Test: `extension/src/content/badge.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `extension/src/content/badge.test.ts` (import `resetCard`, `BADGE_MARKER`, `markSeen`, `isSeen`, `renderBadge` as needed):

```typescript
it('resetCard removes the badge and the seen marker', () => {
  const host = document.createElement('div');
  renderBadge(host, { is_drunk: true, user_rating: 4, raw: { brewery: 'b', name: 'n' }, matched_beer: null });
  markSeen(host);
  expect(host.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
  expect(isSeen(host)).toBe(true);

  resetCard(host);
  expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  expect(isSeen(host)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/content/badge.test.ts -t resetCard`
Expected: FAIL (`resetCard` not exported).

- [ ] **Step 3: Implement**

Add to `extension/src/content/badge.ts` (after `isSeen`):

```typescript
/** Undo the overlay's marks on a card so the next run re-processes it from scratch. */
export function resetCard(el: HTMLElement): void {
  el.querySelector(`[${BADGE_MARKER}]`)?.remove();
  el.removeAttribute(SEEN_MARKER);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/content/badge.test.ts -t resetCard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts
git commit -m "feat(extension): resetCard to clear badge + seen marker (#3)"
```

---

### Task 3: `refreshCards` — reset visible cards, return their keys

**Files:**
- Create: `extension/src/content/refresh.ts`
- Test: `extension/src/content/refresh.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/content/refresh.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { refreshCards } from './refresh';
import { renderBadge, markSeen, isSeen, BADGE_MARKER } from './badge';
import { normalizeKey } from '../shared/normalize';
import type { SiteAdapter } from '../sites/types';

function cardEl(): HTMLElement {
  const el = document.createElement('div');
  renderBadge(el, { is_drunk: true, user_rating: 4, raw: { brewery: 'x', name: 'y' }, matched_beer: null });
  markSeen(el);
  return el;
}

describe('refreshCards', () => {
  it('resets every parsed card and returns its cache key', () => {
    const a = cardEl();
    const b = cardEl();
    const adapter = {
      id: 'fake',
      hostMatch: () => true,
      parseCards: () => [
        { el: a, brewery: 'PINTA', name: 'Atak Chmielu' },
        { el: b, brewery: 'Track', name: 'Sonoma' },
      ],
    } as unknown as SiteAdapter;

    const keys = refreshCards(document, adapter);

    expect(keys).toEqual([normalizeKey('PINTA', 'Atak Chmielu'), normalizeKey('Track', 'Sonoma')]);
    expect(a.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(a)).toBe(false);
    expect(isSeen(b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/content/refresh.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `extension/src/content/refresh.ts`:

```typescript
import { normalizeKey } from '../shared/normalize';
import { resetCard } from './badge';
import type { SiteAdapter } from '../sites/types';

// Resets every parsed card on the page (removes badge + seen marker) and returns
// the cache keys for those cards, so the caller can drop them from the cache before
// re-running the overlay to fetch fresh results. Site-independent keys mean this is
// the "refresh the open page" primitive behind the popup's per-site button.
export function refreshCards(doc: Document, adapter: SiteAdapter): string[] {
  const keys: string[] = [];
  for (const card of adapter.parseCards(doc)) {
    keys.push(normalizeKey(card.brewery, card.name));
    resetCard(card.el);
  }
  return keys;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/content/refresh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/refresh.ts extension/src/content/refresh.test.ts
git commit -m "feat(extension): refreshCards resets visible cards + returns keys (#3)"
```

---

### Task 4: Content-script `refresh-page` message handler

**Files:**
- Modify: `extension/src/content/main.ts`
- Test: covered by Task 3 (`refreshCards`) — the listener itself is thin glue; verify manually in Task 8.

- [ ] **Step 1: Add imports**

In `extension/src/content/main.ts`, add to the imports:

```typescript
import { runOverlay, startOverlay } from './index'; // adjust the existing line: keep startOverlay, add runOverlay
import { refreshCards } from './refresh';
import { clearKeys } from '../cache/store';
```

Note: `startOverlay` is defined in `main.ts` itself, and `runOverlay` is already imported from `./index` (see the existing top imports). Only add the `refreshCards` and `clearKeys` imports; ensure `runOverlay` stays imported.

- [ ] **Step 2: Register the listener at the bottom**

Replace the final two lines of `extension/src/content/main.ts`:

```typescript
const adapter = pickAdapter(new URL(window.location.href));
if (adapter) startOverlay(document, adapter, sendMatch, undefined, enrichOrphans);
```

with:

```typescript
const adapter = pickAdapter(new URL(window.location.href));
if (adapter) {
  startOverlay(document, adapter, sendMatch, undefined, enrichOrphans);
  // Popup → "Refresh this page": drop the visible cards' cache entries and re-run
  // the overlay so badges reflect fresh server state without waiting out the TTL.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as { type?: unknown }).type !== 'refresh-page') return undefined;
    void (async () => {
      const keys = refreshCards(document, adapter);
      await clearKeys(keys);
      await runOverlay(document, adapter, sendMatch, enrichOrphans);
      sendResponse({ ok: true, cleared: keys.length });
    })();
    return true; // keep the message channel open for the async sendResponse
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add extension/src/content/main.ts
git commit -m "feat(extension): content script handles refresh-page message (#3)"
```

---

### Task 5: Popup decision helper + UI

**Files:**
- Create: `extension/src/popup/popup.ts`
- Create: `extension/src/popup/popup.html`
- Create: `extension/src/popup/popup.css`
- Test: `extension/src/popup/popup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/popup/popup.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { canRefresh } from './popup';

describe('canRefresh', () => {
  it('true on a supported shop URL', () => {
    expect(canRefresh('https://beerfreak.org/some/page')).toBe(true);
    expect(canRefresh('https://winetime.com.ua/x')).toBe(true);
  });
  it('false on an unsupported URL', () => {
    expect(canRefresh('https://example.com/')).toBe(false);
  });
  it('false on a malformed or empty URL', () => {
    expect(canRefresh('not a url')).toBe(false);
    expect(canRefresh('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/popup/popup.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `popup.ts`**

Create `extension/src/popup/popup.ts`:

```typescript
import { pickAdapter } from '../sites/registry';
import { clearAll } from '../cache/store';

// True when the URL belongs to a supported shop, so "Refresh this page" can act.
export function canRefresh(url: string): boolean {
  try {
    return pickAdapter(new URL(url)) != null;
  } catch {
    return false;
  }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function initPopup(): Promise<void> {
  const refreshBtn = el<HTMLButtonElement>('refresh');
  const clearBtn = el<HTMLButtonElement>('clearAll');
  const status = el<HTMLElement>('status');
  if (!refreshBtn || !clearBtn || !status) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  refreshBtn.disabled = !canRefresh(url);
  if (refreshBtn.disabled) status.textContent = 'Open a supported shop page to refresh it.';

  refreshBtn.addEventListener('click', () => {
    if (tab?.id == null) return;
    status.textContent = 'Refreshing…';
    chrome.tabs.sendMessage(tab.id, { type: 'refresh-page' }, (reply?: { cleared?: number }) => {
      status.textContent = chrome.runtime.lastError
        ? 'Could not reach the page — reload it and retry.'
        : `Refreshed (${reply?.cleared ?? 0} cleared).`;
    });
  });

  clearBtn.addEventListener('click', async () => {
    await clearAll();
    status.textContent = 'Cache cleared.';
  });
}

if (typeof document !== 'undefined' && document.getElementById('refresh')) {
  void initPopup();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/popup/popup.test.ts`
Expected: PASS (the `initPopup` guard is false under jsdom — no `#refresh` element — so `chrome.tabs` is never touched).

- [ ] **Step 5: Create the HTML + CSS**

Create `extension/src/popup/popup.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Warsaw Beer Overlay</title>
    <link rel="stylesheet" href="./popup.css" />
  </head>
  <body>
    <main class="card">
      <h1>Warsaw Beer Overlay</h1>
      <div class="row">
        <button id="refresh" type="button">Refresh this page</button>
        <button id="clearAll" type="button">Clear all cache</button>
      </div>
      <p id="status" class="status" aria-live="polite"></p>
    </main>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

Create `extension/src/popup/popup.css`:

```css
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; }
.card { min-width: 240px; padding: 12px; }
h1 { font-size: 15px; margin: 0 0 8px; }
.row { display: flex; flex-direction: column; gap: 8px; }
button { padding: 8px; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.5; }
.status { margin: 10px 0 0; color: #444; min-height: 1.2em; }
```

- [ ] **Step 6: Commit**

```bash
git add extension/src/popup/
git commit -m "feat(extension): cache-control popup (refresh page / clear all) (#3)"
```

---

### Task 6: Wire the popup + permissions into the manifest

**Files:**
- Modify: `extension/manifest.config.ts`
- Test: `extension/src/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

In `extension/src/manifest.test.ts`, extend the `manifest` cast to include `action` and `permissions`:

```typescript
const manifest = manifestExport as {
  version: string;
  key: string;
  permissions: string[];
  action?: { default_popup?: string };
  content_scripts: Array<{ matches: string[] }>;
};
```

Add tests:

```typescript
it('exposes a popup action', () => {
  expect(manifest.action?.default_popup).toBe('src/popup/popup.html');
});

it('requests activeTab + tabs permissions for the popup', () => {
  expect(manifest.permissions).toContain('activeTab');
  expect(manifest.permissions).toContain('tabs');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manifest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `extension/manifest.config.ts`, change the `permissions` line and add an `action` key:

```typescript
  permissions: ['storage', 'activeTab', 'tabs'],
  host_permissions: ['https://beer-api.ysilvestrov-ai.uk/*'],
  optional_host_permissions: ['https://*/*'],
  action: { default_popup: 'src/popup/popup.html' },
  options_page: 'src/options/options.html',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.config.ts extension/src/manifest.test.ts
git commit -m "feat(extension): register popup action + activeTab/tabs permissions (#3)"
```

---

### Task 7: Build + full extension suite

**Files:** none (verification).

- [ ] **Step 1: Full test + typecheck + build**

Run (from `extension/`):
```bash
npx vitest run && npx tsc --noEmit && npm run build
```
Expected: all tests green, no type errors, build succeeds and emits `dist/manifest.json` containing `"action": { "default_popup": ... }`, `"permissions": ["storage","activeTab","tabs"]`, and a popup asset.

- [ ] **Step 2: Confirm the built manifest**

Run: `node -e "const m=require('./dist/manifest.json'); console.log(m.action, m.permissions)"`
Expected: shows the popup action and the three permissions.

---

### Task 8: Manual verification in Chrome

**Files:** none.

- [ ] **Step 1: Load + smoke test**

Load `extension/dist` as an unpacked extension. On a supported shop page (e.g. beerfreak.org): the toolbar icon opens the popup; "Refresh this page" is enabled, clears the page's cached entries and re-renders badges; on a non-shop tab the button is disabled with the hint. "Clear all cache" empties the cache (verify in DevTools → Application → Storage that `mc2:` keys are gone). The host page never breaks.

---

### Task 9: Version bump + release + spec.md

**Files:**
- Modify: `extension/package.json` (version)
- Modify: `extension/CHANGELOG.md`
- Modify (if needed): `spec.md`

- [ ] **Step 1: Bump version + changelog**

Bump `extension/package.json` `version` to `0.6.0` (new user-facing feature). Add a `CHANGELOG.md` entry: "0.6.0 — popup to refresh the current page's badges or clear the whole cache."

- [ ] **Step 2: spec.md review**

If `spec.md` documents the extension's UI surfaces / permissions, add the popup + `activeTab`/`tabs`. Otherwise note no change in the commit body.

- [ ] **Step 3: Commit**

```bash
git add extension/package.json extension/CHANGELOG.md spec.md
git commit -m "chore(extension): release 0.6.0 — cache-control popup (#3)"
```

- [ ] **Step 4: Release + broadcast (after merge)**

Per `reference_extension_release_ops_gotchas`: run `npm run release` (build → DB row → stage zip), then forward the produced zip to the bot so it hash-matches and broadcasts 📣. (Note: the pending 0.5.2 broadcast in `project_shipped_2026_06` is separate — do not conflate.)

---

## Self-Review Checklist (run before opening the PR)

- [ ] `cd extension && npx vitest run` green; `npx tsc --noEmit` clean; `npm run build` succeeds.
- [ ] Built `dist/manifest.json` has the popup action + `activeTab`/`tabs`.
- [ ] Manual smoke test (Task 8) done: refresh re-renders, clear-all empties, disabled state on non-shop tabs, host page never breaks.
- [ ] Follow the PR review loop (`feedback_pr_review_loop`): open PR → wait for AI review → assess each comment.
