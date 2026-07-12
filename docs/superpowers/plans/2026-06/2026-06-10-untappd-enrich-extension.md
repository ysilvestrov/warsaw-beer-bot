# Untappd Client-Enrichment — Phase 2: Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser extension, when opted in, search Untappd from the user's session for orphan beers it sees and feed results to the Phase-1 `/enrich/*` endpoints — showing a ⚪ badge for orphans and a loader while searching, resolving to ⭐ when enriched.

**Architecture:** Pure, DI-tested orchestration (`content/enrich.ts`) runs a throttled, page-cap-gated queue; the background service worker performs the cross-origin Untappd fetch + the `/enrich/*` API calls (gated on an opt-in setting + a runtime `untappd.com` permission); `badge.ts` gains ⚪/loader states; `runOverlay` hooks the orphans into the queue.

**Tech Stack:** TypeScript, Chrome MV3 (service worker, `chrome.permissions`, `chrome.storage`), vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-06-10-extension-untappd-client-enrichment-design.md` (Phase 1 server endpoints already merged + deployed: `/enrich/candidates`, `/enrich/result`).

---

## File structure

| File | Change |
| --- | --- |
| `extension/src/api/types.ts` (modify) | `EnrichCandidate`, `EnrichResult` types |
| `extension/src/api/client.ts` (modify) | `postEnrichCandidates`, `postEnrichResult` |
| `extension/src/shared/config.ts` (modify) | `enrichEnabled` setting (default false) |
| `extension/src/content/badge.ts` (modify) | extract `makeBadge`; add ⚪ orphan + `setSearching`/`setEnriched`/`setOrphan` |
| `extension/src/content/untappd-trim.ts` (create) | `trimSearchHtml(rawHtml): string` |
| `extension/src/content/enrich.ts` (create) | `runEnrichment(orphans, deps)` — throttled, page-cap-gated queue |
| `extension/src/background/index.ts` (modify) | SW handlers: `enrich:candidates`, `enrich:fetch`, `enrich:result` (gated) |
| `extension/src/content/index.ts` (modify) | collect orphans after badges, call `enrich?` |
| `extension/src/content/main.ts` (modify) | wire the real enrich deps (settings/permission gate + SW messages + badge fns) |
| `extension/src/options/options.ts` + `options.html` (modify) | enrich toggle + untappd permission request |

`optional_host_permissions: ['https://*/*']` already covers `untappd.com`, so **no manifest change** is needed — the toggle requests `https://untappd.com/*` at runtime.

---

## Task 1: API client — enrich endpoints

**Files:** Modify `extension/src/api/types.ts`, `extension/src/api/client.ts`. Test: `extension/src/api/client.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `extension/src/api/client.test.ts`:

```ts
import { postEnrichCandidates, postEnrichResult } from './client';

describe('postEnrichCandidates', () => {
  it('posts beers and returns candidates', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ candidates: [{ brewery: 'B', name: 'N', eligible: true, searchUrl: 'u' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await postEnrichCandidates('https://api', 'tok', [{ brewery: 'B', name: 'N' }]);
    expect(out[0]).toEqual({ brewery: 'B', name: 'N', eligible: true, searchUrl: 'u' });
    expect(calls[0].url).toBe('https://api/enrich/candidates');
    vi.unstubAllGlobals();
  });
});

describe('postEnrichResult', () => {
  it('posts html and returns the status payload', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'matched', untappd_id: 5001, rating_global: 3.9 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await postEnrichResult('https://api', 'tok', { brewery: 'B', name: 'N', html: '<x>' });
    expect(out).toEqual({ status: 'matched', untappd_id: 5001, rating_global: 3.9 });
    vi.unstubAllGlobals();
  });
});
```

Add `import { describe, it, expect, vi } from 'vitest';` if the file doesn't already import `vi`.

- [ ] **Step 2: Run** `cd extension && npx vitest run src/api/client.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Add types** — append to `extension/src/api/types.ts`:

```ts
export interface EnrichCandidate {
  brewery: string;
  name: string;
  eligible: boolean;
  searchUrl: string;
}

export interface EnrichResult {
  status: 'matched' | 'not_found' | 'blocked' | 'transient' | 'skipped';
  untappd_id?: number;
  rating_global?: number | null;
}
```

- [ ] **Step 4: Add client functions** — append to `extension/src/api/client.ts` (it already has `trimBase`, `fetchWithTimeout`, `ApiError`, `DEFAULT_TIMEOUT_MS`):

```ts
import type { EnrichCandidate, EnrichResult } from './types';

export async function postEnrichCandidates(
  baseUrl: string,
  token: string,
  beers: { brewery: string; name: string }[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnrichCandidate[]> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/enrich/candidates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers }),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return ((await res.json()) as { candidates: EnrichCandidate[] }).candidates;
}

export async function postEnrichResult(
  baseUrl: string,
  token: string,
  payload: { brewery: string; name: string; html: string },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnrichResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/enrich/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return (await res.json()) as EnrichResult;
}
```

(Move the `import type { EnrichCandidate, EnrichResult }` to the top with the other imports rather than mid-file.)

- [ ] **Step 5: Run** `cd extension && npx vitest run src/api/client.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/api/types.ts extension/src/api/client.ts extension/src/api/client.test.ts
git commit -m "feat(extension): enrich API client (postEnrichCandidates/postEnrichResult)"
```

---

## Task 2: Config — `enrichEnabled` setting

**Files:** Modify `extension/src/shared/config.ts`. Test: `extension/src/shared/config.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `extension/src/shared/config.test.ts`:

```ts
it('defaults enrichEnabled to false and round-trips it', async () => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (patch: Record<string, unknown>) => { Object.assign(store, patch); },
    } },
  });
  const { getSettings, setSettings } = await import('./config');
  expect((await getSettings()).enrichEnabled).toBe(false);
  await setSettings({ enrichEnabled: true });
  expect((await getSettings()).enrichEnabled).toBe(true);
  vi.unstubAllGlobals();
});
```

(Match the existing config.test.ts style; ensure `vi` is imported.)

- [ ] **Step 2: Run** `cd extension && npx vitest run src/shared/config.test.ts` → FAIL (`enrichEnabled` undefined).

- [ ] **Step 3: Implement** — update `extension/src/shared/config.ts`:

```ts
export interface Settings {
  token: string;
  baseUrl: string;
  enrichEnabled: boolean;
}

export const DEFAULT_BASE_URL = 'https://beer-api.ysilvestrov-ai.uk';

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['token', 'baseUrl', 'enrichEnabled']);
  return {
    token: typeof s.token === 'string' ? s.token : '',
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : DEFAULT_BASE_URL,
    enrichEnabled: s.enrichEnabled === true,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
```

- [ ] **Step 4: Run** `cd extension && npx vitest run src/shared/config.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/config.ts extension/src/shared/config.test.ts
git commit -m "feat(extension): enrichEnabled setting (default off)"
```

---

## Task 3: Badge — ⚪ orphan + loader/enriched states

**Files:** Modify `extension/src/content/badge.ts`. Test: `extension/src/content/badge.test.ts`.

- [ ] **Step 1: Write the failing tests** — append to `extension/src/content/badge.test.ts` (the `el()` helper and `BADGE_MARKER` are already defined there):

```ts
import { setSearching, setEnriched, setOrphan } from './badge';

const orphan: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Orphan' },
  matched_beer: { id: 3, name: 'Orphan', brewery: 'PINTA', rating_global: null, untappd_id: null },
  is_drunk: false,
  user_rating: null,
};

describe('orphan + enrichment badge states', () => {
  it('renders ⚪ for a not-drunk orphan (matched, no untappd_id)', () => {
    const host = el();
    renderBadge(host, orphan);
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('⚪');
  });

  it('setSearching replaces the badge with a loading glyph; setEnriched swaps to ⭐ + opens Untappd', () => {
    const host = el();
    setOrphan(host);
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('⚪');

    setSearching(host);
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('⏳');
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`).length).toBe(1);

    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    setEnriched(host, 222, 3.9);
    const badge = host.querySelector(`[${BADGE_MARKER}]`)!;
    expect(badge.textContent).toContain('⭐');
    expect(badge.textContent).toContain('3.9');
    (badge as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
  });
});
```

- [ ] **Step 2: Run** `cd extension && npx vitest run src/content/badge.test.ts` → FAIL (`setSearching` etc. not exported; ⚪ not rendered).

- [ ] **Step 3: Refactor `extension/src/content/badge.ts`** — extract a `makeBadge` builder, add ⚪ to `badgeText`, and add the three state setters. Replace the file body from `untappdUrl` downward with:

```ts
function untappdUrl(untappdId: number): string {
  return `https://untappd.com/beer/${untappdId}`;
}

// Builds the styled badge element. Clickable (opens Untappd) when untappdId is set.
function makeBadge(text: string, untappdId: number | null): HTMLElement {
  const badge = document.createElement('div');
  badge.setAttribute(BADGE_MARKER, '');
  badge.textContent = text;
  Object.assign(badge.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    zIndex: '2147483647',
    background: 'rgba(20,20,20,0.82)',
    color: '#fff',
    font: '600 12px/1 system-ui, sans-serif',
    padding: '3px 6px',
    borderRadius: '6px',
    pointerEvents: untappdId != null ? 'auto' : 'none',
    cursor: untappdId != null ? 'pointer' : 'default',
  } as Partial<CSSStyleDeclaration>);
  if (untappdId != null) {
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(untappdUrl(untappdId), '_blank', 'noopener');
    });
  }
  return badge;
}

function attach(host: HTMLElement, badge: HTMLElement): void {
  host.querySelector(`[${BADGE_MARKER}]`)?.remove();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}

// drunk → ✅ (+ personal rating); not-drunk with a bid + global rating → ⭐; not-drunk
// matched orphan (no bid) → ⚪; truly unmatched (matched_beer null) → no badge.
function badgeFor(result: MatchResult): HTMLElement | null {
  if (result.is_drunk) {
    return makeBadge(result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅', null);
  }
  const m = result.matched_beer;
  if (!m) return null;
  if (m.untappd_id != null && m.rating_global != null) {
    return makeBadge(`⭐ ${m.rating_global.toFixed(1)}`, m.untappd_id);
  }
  if (m.untappd_id == null) return makeBadge('⚪', null);
  return null;
}

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  if (host.querySelector(`[${BADGE_MARKER}]`)) return; // idempotent for the /match path
  const badge = badgeFor(result);
  if (badge) attach(host, badge);
}

/** Show the ⚪ orphan badge (used by enrichment before/around a search). */
export function setOrphan(host: HTMLElement): void {
  attach(host, makeBadge('⚪', null));
}

/** Replace the badge with a loading glyph while an Untappd search is in flight. */
export function setSearching(host: HTMLElement): void {
  attach(host, makeBadge('⏳', null));
}

/** Swap the badge to ⭐ + global rating once the beer is enriched. */
export function setEnriched(host: HTMLElement, untappdId: number, ratingGlobal: number | null): void {
  attach(host, makeBadge(ratingGlobal != null ? `⭐ ${ratingGlobal.toFixed(1)}` : '⭐', untappdId));
}
```

Keep the existing `BADGE_MARKER`, `SEEN_MARKER`, `markSeen`, `isSeen`, and the `import type { MatchResult }` at the top. Remove the old `badgeText` and the old `renderBadge` body (replaced above).

- [ ] **Step 4: Run** `cd extension && npx vitest run src/content/badge.test.ts` → PASS (existing ✅/⭐/unmatched cases + the new ⚪/loader/enriched).

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts
git commit -m "feat(extension): ⚪ orphan badge + searching/enriched states"
```

---

## Task 4: Untappd HTML trim

**Files:** Create `extension/src/content/untappd-trim.ts`. Test: `extension/src/content/untappd-trim.test.ts`.

- [ ] **Step 1: Write the failing test** — create `extension/src/content/untappd-trim.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { trimSearchHtml } from './untappd-trim';

const raw = `<!doctype html><html><head><style>.x{}</style></head>
<body>
  <nav>huge nav</nav>
  <div class="results-container">
    <div class="beer-item"><p class="name"><a href="/b/x/5001">Beer A</a></p></div>
    <script>tracking()</script>
  </div>
  <footer>huge footer</footer>
  <script>more()</script>
</body></html>`;

describe('trimSearchHtml', () => {
  it('keeps only the results container and drops scripts/styles', () => {
    const out = trimSearchHtml(raw);
    expect(out).toContain('/b/x/5001');
    expect(out).toContain('Beer A');
    expect(out).not.toContain('huge nav');
    expect(out).not.toContain('huge footer');
    expect(out).not.toContain('tracking()');
    expect(out).not.toContain('.x{}');
    expect(out.length).toBeLessThan(raw.length);
  });

  it('falls back to the body (sans scripts/styles) when no results container is present', () => {
    const out = trimSearchHtml('<html><body><div class="beer-item">x</div><script>y()</script></body></html>');
    expect(out).toContain('beer-item');
    expect(out).not.toContain('y()');
  });
});
```

- [ ] **Step 2: Run** `cd extension && npx vitest run src/content/untappd-trim.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `extension/src/content/untappd-trim.ts`:

```ts
// Untappd's search page is ~500 KB of boilerplate; the results list is tiny. Parse the
// raw HTML in a detached document (scripts never execute), strip <script>/<style>, and
// keep just the results container so we relay ~10–30 KB to the server's parseSearchPage.
const RESULTS_SELECTORS = ['.results-container', '#results-container', '.search-results'];

export function trimSearchHtml(rawHtml: string): string {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  doc.querySelectorAll('script, style, noscript, link, svg').forEach((n) => n.remove());
  const container =
    RESULTS_SELECTORS.map((sel) => doc.querySelector(sel)).find((n) => n) ?? doc.body;
  return container ? container.outerHTML : rawHtml;
}
```

- [ ] **Step 4: Run** `cd extension && npx vitest run src/content/untappd-trim.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/untappd-trim.ts extension/src/content/untappd-trim.test.ts
git commit -m "feat(extension): trim Untappd search HTML to the results container"
```

---

## Task 5: Enrichment orchestration (queue)

**Files:** Create `extension/src/content/enrich.ts`. Test: `extension/src/content/enrich.test.ts`.

- [ ] **Step 1: Write the failing tests** — create `extension/src/content/enrich.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runEnrichment, PAGE_NO_ID_CAP, type EnrichDeps } from './enrich';

function deps(over: Partial<EnrichDeps> = {}): EnrichDeps {
  return {
    getCandidates: vi.fn(async (beers) =>
      beers.map((b) => ({ brewery: b.brewery, name: b.name, eligible: true, searchUrl: `u:${b.name}` })),
    ),
    fetchSearch: vi.fn(async () => '<raw>'),
    trim: vi.fn(() => '<small>'),
    submitResult: vi.fn(async () => ({ status: 'matched', untappd_id: 7, rating_global: 4.0 })),
    setSearching: vi.fn(),
    setEnriched: vi.fn(),
    setOrphan: vi.fn(),
    sleep: vi.fn(async () => {}),
    delayMs: 4000,
    ...over,
  };
}

const beers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `k${i}`, brewery: 'B', name: `N${i}` }));

describe('runEnrichment', () => {
  it('does nothing when the page has >= PAGE_NO_ID_CAP orphans', async () => {
    const d = deps();
    await runEnrichment(beers(PAGE_NO_ID_CAP), d);
    expect(d.getCandidates).not.toHaveBeenCalled();
  });

  it('searches eligible beers, throttling between them, and resolves matched → setEnriched', async () => {
    const d = deps();
    await runEnrichment(beers(2), d);
    expect(d.getCandidates).toHaveBeenCalledTimes(1);
    expect(d.fetchSearch).toHaveBeenCalledTimes(2);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', '<small>');
    expect(d.setSearching).toHaveBeenCalledTimes(2);
    expect(d.setEnriched).toHaveBeenCalledWith('k0', 7, 4.0);
    expect(d.sleep).toHaveBeenCalledTimes(1); // between the two
  });

  it('skips ineligible beers', async () => {
    const d = deps({
      getCandidates: vi.fn(async (bs) => bs.map((b) => ({ ...b, eligible: false, searchUrl: 'u' }))),
    });
    await runEnrichment(beers(2), d);
    expect(d.fetchSearch).not.toHaveBeenCalled();
  });

  it('on not_found, clears the loader back to ⚪ and does not enrich', async () => {
    const d = deps({ submitResult: vi.fn(async () => ({ status: 'not_found' })) });
    await runEnrichment(beers(1), d);
    expect(d.setEnriched).not.toHaveBeenCalled();
    expect(d.setOrphan).toHaveBeenCalledWith('k0');
  });
});
```

- [ ] **Step 2: Run** `cd extension && npx vitest run src/content/enrich.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `extension/src/content/enrich.ts`:

```ts
import type { EnrichResult } from '../api/types';

export const PAGE_NO_ID_CAP = 20;
export const DEFAULT_DELAY_MS = 4000;

export interface OrphanBeer {
  key: string;
  brewery: string;
  name: string;
}

export interface EnrichDeps {
  getCandidates: (
    beers: { brewery: string; name: string }[],
  ) => Promise<{ brewery: string; name: string; eligible: boolean; searchUrl: string }[]>;
  fetchSearch: (searchUrl: string) => Promise<string | null>;
  trim: (rawHtml: string) => string;
  submitResult: (brewery: string, name: string, html: string) => Promise<EnrichResult>;
  setSearching: (key: string) => void;
  setEnriched: (key: string, untappdId: number, ratingGlobal: number | null) => void;
  setOrphan: (key: string) => void;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pairKey = (brewery: string, name: string) => `${brewery} ${name}`;

// Searches the page's orphan beers on Untappd (via deps) one at a time, throttled. Gated:
// if the page has >= PAGE_NO_ID_CAP orphans, abstains entirely (leave it to the server).
export async function runEnrichment(orphans: OrphanBeer[], deps: EnrichDeps): Promise<void> {
  if (orphans.length === 0 || orphans.length >= PAGE_NO_ID_CAP) return;

  const candidates = await deps.getCandidates(
    orphans.map((o) => ({ brewery: o.brewery, name: o.name })),
  );
  const byPair = new Map(orphans.map((o) => [pairKey(o.brewery, o.name), o]));
  const eligible = candidates.filter((c) => c.eligible);

  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < eligible.length; i++) {
    const cand = eligible[i];
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (!beer) continue;

    deps.setSearching(beer.key);
    try {
      const raw = await deps.fetchSearch(cand.searchUrl);
      const res = raw ? await deps.submitResult(cand.brewery, cand.name, deps.trim(raw)) : null;
      if (res && res.status === 'matched' && res.untappd_id != null) {
        deps.setEnriched(beer.key, res.untappd_id, res.rating_global ?? null);
      } else {
        deps.setOrphan(beer.key);
      }
    } catch {
      deps.setOrphan(beer.key);
    }

    if (i < eligible.length - 1) await sleep(delayMs);
  }
}
```

- [ ] **Step 4: Run** `cd extension && npx vitest run src/content/enrich.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/enrich.ts extension/src/content/enrich.test.ts
git commit -m "feat(extension): throttled, page-cap-gated enrichment queue"
```

---

## Task 6: Background SW enrich handlers

**Files:** Modify `extension/src/background/index.ts`. Test: `extension/src/background/handle-enrich.test.ts`.

- [ ] **Step 1: Write the failing test** — create `extension/src/background/handle-enrich.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEnrichFetch, handleEnrichCandidates, handleEnrichResult } from './index';

beforeEach(() => { vi.unstubAllGlobals(); });

describe('handleEnrichFetch', () => {
  it('returns null when the enrich toggle is off', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: false, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => true },
    });
    const out = await handleEnrichFetch({ type: 'enrich:fetch', url: 'https://untappd.com/search?q=x' });
    expect(out).toEqual({ type: 'enrich:fetch:ok', html: null });
  });

  it('fetches the URL when enabled + permission granted', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => true },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>raw</html>', { status: 200 })));
    const out = await handleEnrichFetch({ type: 'enrich:fetch', url: 'https://untappd.com/search?q=x' });
    expect(out).toEqual({ type: 'enrich:fetch:ok', html: '<html>raw</html>' });
  });

  it('returns null html when permission is absent', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => false },
    });
    const out = await handleEnrichFetch({ type: 'enrich:fetch', url: 'https://untappd.com/search?q=x' });
    expect(out.html).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `cd extension && npx vitest run src/background/handle-enrich.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Implement** — add to `extension/src/background/index.ts` (it already imports `getSettings`, `postMatch`, `ApiError` and has the `chrome.runtime.onMessage` listener):

Add imports at the top:

```ts
import { postEnrichCandidates, postEnrichResult } from '../api/client';
import type { EnrichCandidate, EnrichResult } from '../api/types';
```

Add the message types and handlers:

```ts
export interface EnrichFetchMessage { type: 'enrich:fetch'; url: string }
export interface EnrichCandidatesMessage { type: 'enrich:candidates'; beers: { brewery: string; name: string }[] }
export interface EnrichResultMessage { type: 'enrich:result'; brewery: string; name: string; html: string }

const UNTAPPD_ORIGIN = 'https://untappd.com/*';

async function enrichAllowed(): Promise<boolean> {
  const { enrichEnabled } = await getSettings();
  if (!enrichEnabled) return false;
  return chrome.permissions.contains({ origins: [UNTAPPD_ORIGIN] });
}

export async function handleEnrichFetch(msg: EnrichFetchMessage): Promise<{ type: 'enrich:fetch:ok'; html: string | null }> {
  if (!(await enrichAllowed())) return { type: 'enrich:fetch:ok', html: null };
  try {
    const res = await fetch(msg.url, { credentials: 'include' });
    if (!res.ok) return { type: 'enrich:fetch:ok', html: null };
    return { type: 'enrich:fetch:ok', html: await res.text() };
  } catch {
    return { type: 'enrich:fetch:ok', html: null };
  }
}

export async function handleEnrichCandidates(
  msg: EnrichCandidatesMessage,
): Promise<{ type: 'enrich:candidates:ok'; candidates: EnrichCandidate[] }> {
  const { token, baseUrl, enrichEnabled } = await getSettings();
  if (!enrichEnabled || !token) return { type: 'enrich:candidates:ok', candidates: [] };
  try {
    return { type: 'enrich:candidates:ok', candidates: await postEnrichCandidates(baseUrl, token, msg.beers) };
  } catch {
    return { type: 'enrich:candidates:ok', candidates: [] };
  }
}

export async function handleEnrichResult(
  msg: EnrichResultMessage,
): Promise<{ type: 'enrich:result:ok'; result: EnrichResult | null }> {
  const { token, baseUrl, enrichEnabled } = await getSettings();
  if (!enrichEnabled || !token) return { type: 'enrich:result:ok', result: null };
  try {
    const result = await postEnrichResult(baseUrl, token, { brewery: msg.brewery, name: msg.name, html: msg.html });
    return { type: 'enrich:result:ok', result };
  } catch {
    return { type: 'enrich:result:ok', result: null };
  }
}
```

Extend the existing `onMessage` listener to route the three new message types. Replace the existing listener with one that also handles them:

```ts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const t = (message as { type?: unknown }).type;
  if (t === 'match') { handleMatch(message as MatchMessage).then(sendResponse); return true; }
  if (t === 'enrich:fetch') { handleEnrichFetch(message as EnrichFetchMessage).then(sendResponse); return true; }
  if (t === 'enrich:candidates') { handleEnrichCandidates(message as EnrichCandidatesMessage).then(sendResponse); return true; }
  if (t === 'enrich:result') { handleEnrichResult(message as EnrichResultMessage).then(sendResponse); return true; }
  return undefined;
});
```

(Remove the old `isMatchMessage`-based listener.)

- [ ] **Step 4: Run** `cd extension && npx vitest run src/background/handle-enrich.test.ts` and the existing `src/background/handle-match.test.ts` → both PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/index.ts extension/src/background/handle-enrich.test.ts
git commit -m "feat(extension): SW enrich handlers (gated on toggle + untappd permission)"
```

---

## Task 7: Wire orphans into the overlay + options toggle

**Files:** Modify `extension/src/content/index.ts`, `extension/src/content/main.ts`, `extension/src/options/options.ts`, `extension/src/options/options.html`. Test: `extension/src/content/index.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `extension/src/content/index.test.ts` (it already constructs a fake adapter + sendMatch; mirror that style). This verifies `runOverlay` collects orphans and calls the optional `enrich` callback:

```ts
import { runOverlay } from './index';

it('passes not-drunk no-untappd_id beers to the enrich callback', async () => {
  document.body.innerHTML = '<div class="card">Orphan One</div>';
  const adapter = {
    id: 'fake', hostMatch: () => true,
    parseCards: (root: Document | HTMLElement) =>
      Array.from(root.querySelectorAll<HTMLElement>('.card')).map((el) => ({ el, brewery: 'B', name: el.textContent ?? '' })),
  } as never;
  const sendMatch = async () => [{
    raw: { brewery: 'B', name: 'Orphan One' },
    matched_beer: { id: 1, name: 'Orphan One', brewery: 'B', rating_global: null, untappd_id: null },
    is_drunk: false, user_rating: null,
  }];
  const enrich = vi.fn();
  await runOverlay(document, adapter, sendMatch, enrich);
  expect(enrich).toHaveBeenCalledTimes(1);
  expect(enrich.mock.calls[0][0][0]).toMatchObject({ brewery: 'B', name: 'Orphan One' });
});
```

(Ensure `vi` is imported in that test file.)

- [ ] **Step 2: Run** `cd extension && npx vitest run src/content/index.test.ts` → FAIL (`runOverlay` has no 4th param / doesn't call enrich).

- [ ] **Step 3: Hook orphans in `extension/src/content/index.ts`** — add an optional `enrich` param and collect orphans after badges. Change the signature and the post-results block:

```ts
export type EnrichOrphans = (
  orphans: { key: string; el: HTMLElement; brewery: string; name: string }[],
) => void;

export async function runOverlay(
  doc: Document,
  adapter: SiteAdapter,
  sendMatch: SendMatch,
  enrich?: EnrichOrphans,
): Promise<void> {
```

After the existing `results.forEach(...)` loop that renders badges (keep it as-is), add:

```ts
    if (enrich) {
      const orphans = results
        .map((result, i) => ({ result, miss: misses[i] }))
        .filter(
          (x) =>
            x.miss &&
            !x.result.is_drunk &&
            (x.result.matched_beer == null || x.result.matched_beer.untappd_id == null),
        )
        .map((x) => ({ key: x.miss!.key, el: x.miss!.el, brewery: x.miss!.raw.brewery, name: x.miss!.raw.name }));
      if (orphans.length) enrich(orphans);
    }
```

- [ ] **Step 4: Run** `cd extension && npx vitest run src/content/index.test.ts` → PASS.

- [ ] **Step 5: Wire the real enrich deps in `extension/src/content/main.ts`** — add an enrich function that gates on settings/permission and bridges `runEnrichment` to SW messages + badge setters, then pass it to `startOverlay`/`runOverlay`. Add:

```ts
import { runEnrichment, type OrphanBeer } from './enrich';
import { trimSearchHtml } from './untappd-trim';
import { setSearching, setEnriched, setOrphan } from './badge';
import { getSettings } from '../shared/config';

function sendBg<T>(message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (r: T) => resolve(r)));
}

const enrichOrphans: import('./index').EnrichOrphans = (orphans) => {
  void (async () => {
    const { enrichEnabled } = await getSettings();
    if (!enrichEnabled) return;
    const elByKey = new Map(orphans.map((o) => [o.key, o.el]));
    const beers: OrphanBeer[] = orphans.map((o) => ({ key: o.key, brewery: o.brewery, name: o.name }));
    await runEnrichment(beers, {
      getCandidates: async (bs) =>
        (await sendBg<{ candidates: { brewery: string; name: string; eligible: boolean; searchUrl: string }[] }>(
          { type: 'enrich:candidates', beers: bs },
        ))?.candidates ?? [],
      fetchSearch: async (url) =>
        (await sendBg<{ html: string | null }>({ type: 'enrich:fetch', url }))?.html ?? null,
      trim: trimSearchHtml,
      submitResult: async (brewery, name, html) =>
        (await sendBg<{ result: import('../api/types').EnrichResult | null }>(
          { type: 'enrich:result', brewery, name, html },
        ))?.result ?? { status: 'transient' },
      setSearching: (key) => { const el = elByKey.get(key); if (el) setSearching(el); },
      setEnriched: (key, id, r) => { const el = elByKey.get(key); if (el) setEnriched(el, id, r); },
      setOrphan: (key) => { const el = elByKey.get(key); if (el) setOrphan(el); },
    });
  })();
};
```

Then update the bottom of the file to pass it through. `startOverlay` currently calls `runOverlay(doc, adapter, send)`; thread `enrich` through:

```ts
export function startOverlay(
  doc: Document,
  adapter: SiteAdapter,
  send: SendMatch,
  opts?: ReRenderOptions,
  enrich?: import('./index').EnrichOrphans,
): () => void {
  const run = () => runOverlay(doc, adapter, send, enrich);
  // ...rest unchanged...
}

// bottom of file:
const adapter = pickAdapter(new URL(window.location.href));
if (adapter) startOverlay(document, adapter, sendMatch, undefined, enrichOrphans);
```

Run `cd extension && npm run typecheck` → exit 0. (The existing `main.test.ts` `startOverlay` calls pass `enrich` undefined, so they stay green; run `npx vitest run src/content/main.test.ts` to confirm.)

- [ ] **Step 6: Options toggle** — in `extension/src/options/options.html`, add (near the existing token/url fields) a checkbox + label:

```html
<label><input type="checkbox" id="enrichEnabled" /> Find missing beers via Untappd (uses your Untappd session)</label>
```

In `extension/src/options/options.ts`, inside `initOptionsPage`, after loading settings, wire the checkbox (request the untappd permission on enable, drop it on disable):

```ts
  const enrich = el<HTMLInputElement>('enrichEnabled');
  if (enrich) {
    enrich.checked = s.enrichEnabled;
    enrich.addEventListener('change', async () => {
      if (enrich.checked) {
        const granted = await chrome.permissions.request({ origins: ['https://untappd.com/*'] });
        enrich.checked = granted;
        await setSettings({ enrichEnabled: granted });
        status.textContent = granted ? 'Enrichment on.' : 'Permission denied.';
      } else {
        await chrome.permissions.remove({ origins: ['https://untappd.com/*'] });
        await setSettings({ enrichEnabled: false });
        status.textContent = 'Enrichment off.';
      }
    });
  }
```

(`s` is the already-loaded settings; `status` is the existing status element. `getSettings` already returns `enrichEnabled`.)

- [ ] **Step 7: Run the full extension suite + typecheck + build**

Run: `cd extension && npm test && npm run typecheck && npm run build`
Expected: all vitest green; `tsc --noEmit` 0; `vite build` + zip succeed.

- [ ] **Step 8: Commit**

```bash
git add extension/src/content/index.ts extension/src/content/index.test.ts extension/src/content/main.ts extension/src/options/options.ts extension/src/options/options.html
git commit -m "feat(extension): wire enrichment into the overlay + options opt-in toggle"
```

---

## Task 8: Spec/CHANGELOG note

**Files:** Modify `extension/CHANGELOG.md`.

- [ ] **Step 1: Add a CHANGELOG entry** — under `## [Unreleased]` in `extension/CHANGELOG.md`:

```markdown
- Orphan beers (no Untappd match yet) now show a ⚪ badge.
- Optional (off by default): find missing beers via Untappd search in your own session and contribute ratings back; enable it in the extension options.
```

- [ ] **Step 2: Commit**

```bash
git add extension/CHANGELOG.md
git commit -m "docs(extension): changelog for ⚪ orphan badge + opt-in Untappd enrichment"
```

---

## Self-review notes

- **Spec coverage:** opt-in toggle + runtime permission (T2 setting, T7 options), SW untappd fetch gated (T6), throttled + page-cap-gated queue (T5), HTML trim A1 (T4), `/enrich/*` client (T1), ⚪ orphan + loader→⭐ states (T3), orphans hooked from `runOverlay` (T7), uniform orphans (⚪ comes from `/match` matched_beer with untappd_id null — T3; the queue searches whatever `/enrich/candidates` says is eligible — T5). CHANGELOG (T8). Out-of-scope items (global off-page worker, static permission, manual button) untouched.
- **Type consistency:** `EnrichCandidate`/`EnrichResult` (T1) used by client (T1), SW (T6), orchestration (T5); `EnrichDeps`/`OrphanBeer` (T5) bridged in main.ts (T7); badge `setSearching/setEnriched/setOrphan(host)` (T3) called via key→el map (T7); `EnrichOrphans` type (T7 index.ts) imported in main.ts.
- **No placeholders:** every code/command step is complete.
- **Manual verification after merge:** load the 0.4.0+ build, enable the toggle (grant untappd.com), open a shop page with un-catalogued beers → ⚪ badges, loaders on the eligible few, resolving to ⭐; confirm no searches when the toggle is off.
- **Execution note:** Phase-1 endpoints are already deployed, so this extension half can be tested end-to-end against prod. Implement in a worktree; cherry-pick the spec + this plan commit per project convention. This change ships in a later extension release (version bump + `npm run release`).
```
