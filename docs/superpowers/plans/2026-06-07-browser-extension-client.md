# Browser Extension Client (drunk-status overlay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only MV3 browser extension (`extension/`) that overlays the user's personal drunk-status + Untappd rating onto craft-beer store grids by calling the existing `POST /match` API.

**Architecture:** Standalone Vite + Vanilla-TS + `@crxjs/vite-plugin` package, isolated from the Node backend. A content script per supported store parses visible product cards via a per-site adapter, checks a short-TTL `chrome.storage.local` cache, and asks a background service worker (which holds the bearer token, never the page) to call `POST /match`. Results render as a corner badge on drunk beers. `beerrepublic.eu` is Shopify SSR (cards in HTML); `onemorebeer.pl` is a Nuxt client-rendered grid needing a one-shot render-wait. Spec: `docs/superpowers/specs/2026-06-07-browser-extension-client-design.md`.

**Tech Stack:** TypeScript (strict), Vite 5, `@crxjs/vite-plugin` (MV3), Vitest + jsdom, Playwright (fixture capture only), `chrome.*` extension APIs.

---

## File Structure

```
extension/
├── package.json                  # scripts: dev, build, test, typecheck, capture-omb
├── vite.config.ts                # crx({ manifest })
├── vitest.config.ts              # jsdom env, setupFiles, include src/**/*.test.ts
├── tsconfig.json                 # strict, bundler resolution, chrome types
├── manifest.config.ts            # MV3: content_scripts, background, options, permissions
├── scripts/
│   └── capture-omb-fixture.ts    # Playwright headless dump of onemorebeer rendered grid
├── tests/
│   ├── setup.ts                  # global.chrome mock (storage/runtime)
│   └── fixtures/
│       ├── beerrepublic-collection.html   # curl SSR dump
│       └── onemorebeer-piwa.html           # Playwright rendered dump
└── src/
    ├── shared/
    │   ├── config.ts             # getSettings/setSettings (token, baseUrl) + DEFAULT_BASE_URL
    │   └── normalize.ts          # normalizeKey(brewery, name) → cache key
    ├── cache/
    │   └── store.ts              # getCached/setCached over chrome.storage.local (TTL)
    ├── api/
    │   ├── types.ts              # RawBeer, MatchResult, MatchResponse (mirror spec §4)
    │   └── client.ts             # postMatch(), getHealth() + typed errors
    ├── sites/
    │   ├── types.ts              # Card, SiteAdapter
    │   ├── registry.ts           # pickAdapter(url)
    │   ├── beerrepublic.ts       # SSR adapter
    │   └── onemorebeer.ts        # client-rendered adapter (+ waitForGrid)
    ├── content/
    │   ├── grid-ready.ts         # waitForSelector(root, sel, {timeoutMs})
    │   ├── badge.ts              # renderBadge(el, result)
    │   ├── index.ts              # runOverlay(doc, adapter, sendMatch) orchestrator
    │   └── main.ts               # content entry: wire runOverlay + sendMessage
    ├── background/
    │   └── index.ts              # handleMatch() + onMessage listener
    └── options/
        ├── options.html
        ├── options.ts            # load/save settings + testConnection
        └── options.css
```

Plus root `.gitignore` (add `extension/dist`, `extension/node_modules`) and root `spec.md` (new `extension/` section).

**Build order:** scaffold → shared/cache/api primitives → site abstraction → beerrepublic adapter (unblocked) → render-gate → onemorebeer fixture+adapter → badge → worker → orchestrator → options → docs → final wiring.

---

## Task 1: Scaffold the `extension/` package

**Files:**
- Create: `extension/package.json`, `extension/tsconfig.json`, `extension/vite.config.ts`, `extension/vitest.config.ts`, `extension/manifest.config.ts`, `extension/tests/setup.ts`, `extension/src/shared/health.test.ts` (temporary smoke test)
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Create `extension/package.json`**

```json
{
  "name": "warsaw-beer-extension",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "capture-omb": "tsx scripts/capture-omb-fixture.ts"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run (from `extension/`):
```bash
cd extension
npm install -D vite@^5.4.0 @crxjs/vite-plugin@beta typescript@^5.5.0 \
  vitest@^2.1.0 jsdom@^25.0.0 @types/chrome@^0.0.270 tsx@^4.19.0 playwright@^1.47.0
```
Expected: `node_modules/` created, no peer-dep errors that abort install.

- [ ] **Step 3: Create `extension/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vitest/globals", "node"]
  },
  "include": ["src", "tests", "scripts", "manifest.config.ts", "vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Create `extension/manifest.config.ts`**

```ts
import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Warsaw Beer Overlay',
  description: 'Shows which beers you have already drunk + your rating on craft beer stores.',
  version: '0.1.0',
  permissions: ['storage'],
  host_permissions: ['https://beer-api.ysilvestrov-ai.uk/*'],
  optional_host_permissions: ['https://*/*'],
  options_page: 'src/options/options.html',
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: [
        'https://beerrepublic.eu/*',
        'https://onemorebeer.pl/*',
        'https://*.onemorebeer.pl/*',
      ],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
});
```

- [ ] **Step 5: Create `extension/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { target: 'es2022' },
});
```

- [ ] **Step 6: Create `extension/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 7: Create `extension/tests/setup.ts` (chrome mock)**

```ts
import { vi, beforeEach } from 'vitest';

const store = new Map<string, unknown>();

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
        const ks = Array.isArray(keys)
          ? keys
          : typeof keys === 'string'
            ? [keys]
            : keys
              ? Object.keys(keys)
              : [...store.keys()];
        const out: Record<string, unknown> = {};
        for (const k of ks) if (store.has(k)) out[k] = store.get(k);
        return out;
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      }),
    },
  },
  runtime: {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
    lastError: undefined,
  },
};

export function __resetChromeStore(): void {
  store.clear();
}

beforeEach(() => {
  store.clear();
});
```

- [ ] **Step 8: Create a temporary smoke test `extension/src/shared/health.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain smoke', () => {
  it('runs vitest in jsdom with chrome mock present', async () => {
    expect(typeof document).toBe('object');
    await chrome.storage.local.set({ smoke: 1 });
    const got = await chrome.storage.local.get('smoke');
    expect(got.smoke).toBe(1);
  });
});
```

- [ ] **Step 9: Run the smoke test**

Run: `cd extension && npm test`
Expected: PASS (1 test).

- [ ] **Step 10: Verify the build produces a loadable extension**

Run: `cd extension && npm run build`
Expected: build fails OR warns because `src/background/index.ts`, `src/content/main.ts`, `src/options/options.html` don't exist yet. That is acceptable at this step — only assert that Vite + crx plugin load and start (no "plugin not found"/config errors). If it errors solely on missing entry files, proceed; those are created in later tasks.

- [ ] **Step 11: Update root `.gitignore`**

Add these lines to `/home/ysi/warsaw-beer-bot/.gitignore`:
```
extension/node_modules/
extension/dist/
```

- [ ] **Step 12: Delete the temporary smoke test**

```bash
rm extension/src/shared/health.test.ts
```

- [ ] **Step 13: Commit**

```bash
git add extension/package.json extension/package-lock.json extension/tsconfig.json \
  extension/vite.config.ts extension/vitest.config.ts extension/manifest.config.ts \
  extension/tests/setup.ts .gitignore
git commit -m "chore(extension): scaffold Vite + crxjs + Vitest MV3 boilerplate"
```

---

## Task 2: `shared/config.ts` — settings (token + baseUrl)

**Files:**
- Create: `extension/src/shared/config.ts`
- Test: `extension/src/shared/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { getSettings, setSettings, DEFAULT_BASE_URL } from './config';

describe('config', () => {
  it('returns empty token + default baseUrl when nothing stored', async () => {
    const s = await getSettings();
    expect(s.token).toBe('');
    expect(s.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('persists and reads back token + baseUrl', async () => {
    await setSettings({ token: 'abc', baseUrl: 'http://localhost:3000' });
    const s = await getSettings();
    expect(s).toEqual({ token: 'abc', baseUrl: 'http://localhost:3000' });
  });

  it('falls back to default baseUrl when stored baseUrl is blank', async () => {
    await setSettings({ token: 'abc', baseUrl: '' });
    expect((await getSettings()).baseUrl).toBe(DEFAULT_BASE_URL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/shared/config.test.ts`
Expected: FAIL ("Cannot find module './config'").

- [ ] **Step 3: Write the implementation**

```ts
export interface Settings {
  token: string;
  baseUrl: string;
}

export const DEFAULT_BASE_URL = 'https://beer-api.ysilvestrov-ai.uk';

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['token', 'baseUrl']);
  return {
    token: typeof s.token === 'string' ? s.token : '',
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : DEFAULT_BASE_URL,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/shared/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/config.ts extension/src/shared/config.test.ts
git commit -m "feat(extension): settings store (token + editable baseUrl)"
```

---

## Task 3: `shared/normalize.ts` — cache key

**Files:**
- Create: `extension/src/shared/normalize.ts`
- Test: `extension/src/shared/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeKey } from './normalize';

describe('normalizeKey', () => {
  it('lowercases, strips diacritics and punctuation, collapses spaces', () => {
    expect(normalizeKey('PINTA', 'Hazy  Morning!')).toBe('pinta|hazy morning');
  });

  it('removes Polish diacritics', () => {
    expect(normalizeKey('Zakładowy', 'Pełne')).toBe('zakladowy|pelne');
  });

  it('is stable across surrounding whitespace', () => {
    expect(normalizeKey('  PINTA ', ' Hazy Morning ')).toBe(normalizeKey('PINTA', 'Hazy Morning'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/shared/normalize.test.ts`
Expected: FAIL ("Cannot find module './normalize'").

- [ ] **Step 3: Write the implementation**

```ts
function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeKey(brewery: string, name: string): string {
  return `${norm(brewery)}|${norm(name)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/shared/normalize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/normalize.ts extension/src/shared/normalize.test.ts
git commit -m "feat(extension): normalizeKey for cache keys"
```

---

## Task 4: `api/types.ts` + `cache/store.ts` — TTL cache

**Files:**
- Create: `extension/src/api/types.ts`, `extension/src/cache/store.ts`
- Test: `extension/src/cache/store.test.ts`

- [ ] **Step 1: Create `extension/src/api/types.ts` (shared types, no test)**

```ts
export interface RawBeer {
  brewery: string;
  name: string;
  abv?: number;
}

export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
}

export interface MatchResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  user_rating: number | null;
}

export interface MatchResponse {
  results: MatchResult[];
}
```

- [ ] **Step 2: Write the failing test for the cache**

```ts
import { describe, it, expect } from 'vitest';
import { getCached, setCached, CACHE_TTL_MS } from './store';
import type { MatchResult } from '../api/types';

const sample: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1 },
  is_drunk: true,
  user_rating: 4.0,
};

describe('cache/store', () => {
  it('returns null for a missing key', async () => {
    expect(await getCached('pinta|hazy morning')).toBeNull();
  });

  it('stores and reads back within TTL', async () => {
    const now = 1_000_000;
    await setCached('pinta|hazy morning', sample, now);
    expect(await getCached('pinta|hazy morning', now + 1000)).toEqual(sample);
  });

  it('treats entries older than TTL as misses', async () => {
    const now = 1_000_000;
    await setCached('pinta|hazy morning', sample, now);
    expect(await getCached('pinta|hazy morning', now + CACHE_TTL_MS + 1)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run src/cache/store.test.ts`
Expected: FAIL ("Cannot find module './store'").

- [ ] **Step 4: Write the implementation**

```ts
import type { MatchResult } from '../api/types';

export const CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const PREFIX = 'mc:';

interface Entry {
  result: MatchResult;
  expiresAt: number;
}

export async function getCached(key: string, now: number = Date.now()): Promise<MatchResult | null> {
  const storageKey = PREFIX + key;
  const got = await chrome.storage.local.get(storageKey);
  const entry = got[storageKey] as Entry | undefined;
  if (!entry || entry.expiresAt <= now) return null;
  return entry.result;
}

export async function setCached(
  key: string,
  result: MatchResult,
  now: number = Date.now(),
): Promise<void> {
  const entry: Entry = { result, expiresAt: now + CACHE_TTL_MS };
  await chrome.storage.local.set({ [PREFIX + key]: entry });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extension && npx vitest run src/cache/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add extension/src/api/types.ts extension/src/cache/store.ts extension/src/cache/store.test.ts
git commit -m "feat(extension): match result types + short-TTL cache"
```

---

## Task 5: `api/client.ts` — POST /match + GET /health

**Files:**
- Create: `extension/src/api/client.ts`
- Test: `extension/src/api/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMatch, getHealth, ApiError } from './client';
import type { MatchResult } from './types';

const result: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: null,
  is_drunk: false,
  user_rating: null,
};

afterEach(() => vi.restoreAllMocks());

describe('api/client', () => {
  it('postMatch posts beers with bearer auth and returns results', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [result] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await postMatch('https://api.test', 'tok', [{ brewery: 'PINTA', name: 'Hazy Morning' }]);

    expect(out).toEqual([result]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/match');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
  });

  it('postMatch throws ApiError code "unauthorized" on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(postMatch('https://api.test', 'bad', [{ brewery: 'X', name: 'Y' }]))
      .rejects.toMatchObject({ code: 'unauthorized' } as Partial<ApiError>);
  });

  it('postMatch throws ApiError code "server" on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(postMatch('https://api.test', 'tok', [{ brewery: 'X', name: 'Y' }]))
      .rejects.toMatchObject({ code: 'server' });
  });

  it('postMatch throws ApiError code "network" when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    await expect(postMatch('https://api.test', 'tok', [{ brewery: 'X', name: 'Y' }]))
      .rejects.toMatchObject({ code: 'network' });
  });

  it('getHealth returns true on { ok: true }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    expect(await getHealth('https://api.test')).toBe(true);
  });

  it('getHealth returns false when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    expect(await getHealth('https://api.test')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/api/client.test.ts`
Expected: FAIL ("Cannot find module './client'").

- [ ] **Step 3: Write the implementation**

```ts
import type { MatchResponse, MatchResult, RawBeer } from './types';

export type ApiErrorCode = 'unauthorized' | 'server' | 'network';

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export async function postMatch(
  baseUrl: string,
  token: string,
  beers: RawBeer[],
): Promise<MatchResult[]> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(baseUrl)}/match`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers }),
    });
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  const data = (await res.json()) as MatchResponse;
  return data.results;
}

export async function getHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${trimBase(baseUrl)}/health`);
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/api/client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/api/client.ts extension/src/api/client.test.ts
git commit -m "feat(extension): API client (postMatch/getHealth) with typed errors"
```

---

## Task 6: `sites/types.ts` + `sites/registry.ts`

**Files:**
- Create: `extension/src/sites/types.ts`, `extension/src/sites/registry.ts`
- Test: `extension/src/sites/registry.test.ts`

- [ ] **Step 1: Create `extension/src/sites/types.ts` (no test)**

```ts
export interface Card {
  el: HTMLElement;
  brewery: string;
  name: string;
  abv?: number;
}

export interface SiteAdapter {
  hostMatch(url: URL): boolean;
  parseCards(root: ParentNode): Card[];
  /** Optional: resolve once the (client-rendered) grid has painted cards. */
  waitForGrid?(root: ParentNode): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test for the registry**

```ts
import { describe, it, expect } from 'vitest';
import { pickAdapter } from './registry';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';

describe('pickAdapter', () => {
  it('selects beerrepublic for beerrepublic.eu', () => {
    expect(pickAdapter(new URL('https://beerrepublic.eu/collections/all'))).toBe(beerrepublic);
  });

  it('selects onemorebeer for onemorebeer.pl', () => {
    expect(pickAdapter(new URL('https://onemorebeer.pl/piwa'))).toBe(onemorebeer);
  });

  it('returns null for an unknown host', () => {
    expect(pickAdapter(new URL('https://example.com/'))).toBeNull();
  });
});
```

- [ ] **Step 3: Create minimal stub adapters so the registry compiles**

Create `extension/src/sites/beerrepublic.ts`:
```ts
import type { SiteAdapter } from './types';

export const beerrepublic: SiteAdapter = {
  hostMatch: (url) => url.hostname === 'beerrepublic.eu' || url.hostname.endsWith('.beerrepublic.eu'),
  parseCards: () => [],
};
```

Create `extension/src/sites/onemorebeer.ts`:
```ts
import type { SiteAdapter } from './types';

export const onemorebeer: SiteAdapter = {
  hostMatch: (url) => url.hostname === 'onemorebeer.pl' || url.hostname.endsWith('.onemorebeer.pl'),
  parseCards: () => [],
};
```

- [ ] **Step 4: Write `extension/src/sites/registry.ts`**

```ts
import type { SiteAdapter } from './types';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';

const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer];

export function pickAdapter(url: URL): SiteAdapter | null {
  return ADAPTERS.find((a) => a.hostMatch(url)) ?? null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extension && npx vitest run src/sites/registry.test.ts`
Expected: PASS (3 tests). (The adapters are stubs; real parsing comes in Tasks 7 and 10.)

- [ ] **Step 6: Commit**

```bash
git add extension/src/sites/types.ts extension/src/sites/registry.ts \
  extension/src/sites/beerrepublic.ts extension/src/sites/onemorebeer.ts \
  extension/src/sites/registry.test.ts
git commit -m "feat(extension): SiteAdapter interface + host registry"
```

---

## Task 7: `beerrepublic` adapter (SSR — concrete selectors)

**Files:**
- Modify: `extension/src/sites/beerrepublic.ts`
- Test: `extension/src/sites/beerrepublic.test.ts`
- Fixture: `extension/tests/fixtures/beerrepublic-collection.html`

- [ ] **Step 1: Capture the SSR fixture**

Run:
```bash
cd extension
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" \
  "https://beerrepublic.eu/collections/all" -o tests/fixtures/beerrepublic-collection.html
grep -c 'class="product-item product-item--vertical' tests/fixtures/beerrepublic-collection.html
```
Expected: a non-zero count (≈48). The grid cards are present because the site is SSR.

- [ ] **Step 2: Inspect one card to confirm the brewery/name nodes**

Run:
```bash
cd extension
grep -o 'product-item__vendor[^<]*</a>' tests/fixtures/beerrepublic-collection.html | head -2
grep -o 'product-item__title[^<]*</a>' tests/fixtures/beerrepublic-collection.html | head -2
```
Expected: vendor link text (brewery) and title link text (beer name). Note one concrete brewery+name pair shown — you will assert it in the test.

- [ ] **Step 3: Write the failing contract test**

Replace the contents of `extension/src/sites/beerrepublic.test.ts` with:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beerrepublic } from './beerrepublic';

const html = readFileSync(
  fileURLToPath(new URL('../../tests/fixtures/beerrepublic-collection.html', import.meta.url)),
  'utf8',
);

function parseFixture() {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return beerrepublic.parseCards(doc);
}

describe('beerrepublic adapter', () => {
  it('parses many cards from the SSR grid', () => {
    const cards = parseFixture();
    expect(cards.length).toBeGreaterThan(20);
  });

  it('extracts a non-empty brewery and name for every card', () => {
    for (const c of parseFixture()) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.el).toBeInstanceOf(HTMLElement);
    }
  });

  it('splits brewery (vendor) from name (title)', () => {
    const cards = parseFixture();
    const withBrewery = cards.filter((c) => c.brewery.length > 0);
    // The Shopify theme renders a vendor link on product cards.
    expect(withBrewery.length).toBeGreaterThan(0);
    expect(withBrewery[0].brewery).not.toEqual(withBrewery[0].name);
  });

  it('does not define waitForGrid (SSR)', () => {
    expect(beerrepublic.waitForGrid).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd extension && npx vitest run src/sites/beerrepublic.test.ts`
Expected: FAIL (stub `parseCards` returns `[]`, so "length greater than 20" fails).

- [ ] **Step 5: Implement the adapter**

Replace `extension/src/sites/beerrepublic.ts` with:
```ts
import type { Card, SiteAdapter } from './types';

function text(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

export const beerrepublic: SiteAdapter = {
  hostMatch: (url) => url.hostname === 'beerrepublic.eu' || url.hostname.endsWith('.beerrepublic.eu'),

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.product-item'))) {
      const name = text(el.querySelector('.product-item__title'));
      if (!name) continue;
      const brewery = text(el.querySelector('.product-item__vendor'));
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd extension && npx vitest run src/sites/beerrepublic.test.ts`
Expected: PASS (4 tests). If a selector assertion fails, re-check Step 2 output and adjust the selector to the exact class seen in the fixture.

- [ ] **Step 7: Commit**

```bash
git add extension/src/sites/beerrepublic.ts extension/src/sites/beerrepublic.test.ts \
  extension/tests/fixtures/beerrepublic-collection.html
git commit -m "feat(extension): beerrepublic SSR adapter + fixture contract test"
```

---

## Task 8: `content/grid-ready.ts` — render-readiness gate

**Files:**
- Create: `extension/src/content/grid-ready.ts`
- Test: `extension/src/content/grid-ready.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { waitForSelector } from './grid-ready';

describe('waitForSelector', () => {
  it('resolves true immediately when the selector already exists', async () => {
    document.body.innerHTML = '<div class="card"></div>';
    expect(await waitForSelector(document, '.card', { timeoutMs: 100 })).toBe(true);
  });

  it('resolves true once a matching node is added later', async () => {
    document.body.innerHTML = '<div id="grid"></div>';
    const p = waitForSelector(document, '.card', { timeoutMs: 1000 });
    setTimeout(() => {
      document.getElementById('grid')!.innerHTML = '<div class="card"></div>';
    }, 10);
    expect(await p).toBe(true);
  });

  it('resolves false after the timeout when nothing matches', async () => {
    document.body.innerHTML = '<div id="grid"></div>';
    expect(await waitForSelector(document, '.card', { timeoutMs: 30 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/content/grid-ready.test.ts`
Expected: FAIL ("Cannot find module './grid-ready'").

- [ ] **Step 3: Write the implementation**

```ts
export interface WaitOptions {
  timeoutMs?: number;
}

export function waitForSelector(
  root: ParentNode,
  selector: string,
  opts: WaitOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  if (root.querySelector(selector)) return Promise.resolve(true);

  const observeTarget =
    (root as Document).body ?? (root instanceof Element ? root : (root as Document).documentElement);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (root.querySelector(selector)) finish(true);
    });
    if (observeTarget) observer.observe(observeTarget, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/content/grid-ready.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/grid-ready.ts extension/src/content/grid-ready.test.ts
git commit -m "feat(extension): one-shot render-readiness gate (waitForSelector)"
```

---

## Task 9: Capture the onemorebeer rendered fixture (Playwright)

**Files:**
- Create: `extension/scripts/capture-omb-fixture.ts`
- Fixture (generated): `extension/tests/fixtures/onemorebeer-piwa.html`

> onemorebeer.pl is Nuxt client-rendered, so `curl` returns an empty grid. This script renders the page headlessly and dumps the populated grid. Run on the VPS — headless, no GUI needed.

- [ ] **Step 1: Install the Chromium browser for Playwright**

Run: `cd extension && npx playwright install chromium`
Expected: Chromium downloaded (or already present).

- [ ] **Step 2: Write the capture script**

```ts
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Candidate selectors that mark a rendered product card. The script tries each;
// the first that appears is used as the readiness signal and logged so the
// adapter (Task 10) can reuse it.
const CARD_CANDIDATES = [
  '[class*="product-tile"]',
  '[class*="product-card"]',
  '[class*="catalog-item"]',
  '[class*="product-item"]',
  'a[href*="/produkt"]',
  'a[href*="/p/"]',
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
  await page.goto('https://onemorebeer.pl/piwa', { waitUntil: 'networkidle', timeout: 60_000 });

  let used = '';
  for (const sel of CARD_CANDIDATES) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      used = sel;
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!used) throw new Error('No product-card selector matched; inspect the page manually.');
  console.log(`Rendered card selector that matched: ${used}`);

  const html = await page.content();
  const outDir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}onemorebeer-piwa.html`, html, 'utf8');
  console.log('Wrote tests/fixtures/onemorebeer-piwa.html');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Run the capture**

Run: `cd extension && npm run capture-omb`
Expected: prints the matched card selector and "Wrote tests/fixtures/onemorebeer-piwa.html". **Record the printed selector** — Task 10 uses it.

- [ ] **Step 4: Confirm the fixture now contains cards**

Run:
```bash
cd extension
grep -c -i 'producent' tests/fixtures/onemorebeer-piwa.html
wc -c tests/fixtures/onemorebeer-piwa.html
```
Expected: multiple "producent" hits (one per card) and a sizeable file — proof the grid rendered.

- [ ] **Step 5: Commit the script + fixture**

```bash
git add extension/scripts/capture-omb-fixture.ts extension/tests/fixtures/onemorebeer-piwa.html
git commit -m "chore(extension): Playwright capture script + onemorebeer rendered fixture"
```

---

## Task 10: `onemorebeer` adapter (client-rendered)

**Files:**
- Modify: `extension/src/sites/onemorebeer.ts`
- Test: `extension/src/sites/onemorebeer.test.ts`

> This is the one fixture-derived task: the exact card/title/Producent/Moc selectors come from the fixture captured in Task 9. Steps 1–2 derive them; Steps 3–6 lock them in with a test.

- [ ] **Step 1: Derive the per-card selectors from the fixture**

Run:
```bash
cd extension
# the card container = the selector printed by Task 9 Step 3
# inspect how Producent value and title sit inside one card:
grep -o -i '.\{0\}producent.\{160\}' tests/fixtures/onemorebeer-piwa.html | head -3
grep -o -i '.\{60\}moc (%).\{80\}' tests/fixtures/onemorebeer-piwa.html | head -3
```
From the output record: (a) `CARD_SELECTOR` (Task 9's matched selector), (b) how the brewery appears next to the `Producent` label, (c) the product-title element, (d) how `Moc (%)` value appears. Note one concrete `{brewery, name}` pair to assert.

- [ ] **Step 2: Write the failing contract test**

Replace `extension/src/sites/onemorebeer.test.ts` with (substitute the one real beer name you recorded into the marked assertion):
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { onemorebeer } from './onemorebeer';

const html = readFileSync(
  fileURLToPath(new URL('../../tests/fixtures/onemorebeer-piwa.html', import.meta.url)),
  'utf8',
);

function parseFixture() {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return onemorebeer.parseCards(doc);
}

describe('onemorebeer adapter', () => {
  it('parses multiple cards from the rendered grid', () => {
    expect(parseFixture().length).toBeGreaterThan(5);
  });

  it('extracts a non-empty brewery and name per card', () => {
    for (const c of parseFixture()) {
      expect(c.brewery.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it('parses ABV as a number when "Moc (%)" is present, omits it otherwise', () => {
    const cards = parseFixture();
    const withAbv = cards.filter((c) => c.abv !== undefined);
    for (const c of withAbv) {
      expect(typeof c.abv).toBe('number');
      expect(c.abv).toBeGreaterThan(0);
      expect(c.abv).toBeLessThan(30);
    }
  });

  it('defines waitForGrid (client-rendered)', () => {
    expect(typeof onemorebeer.waitForGrid).toBe('function');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run src/sites/onemorebeer.test.ts`
Expected: FAIL (stub returns `[]`).

- [ ] **Step 4: Implement the adapter**

Replace `extension/src/sites/onemorebeer.ts` with the following, setting the four `*_SELECTOR`/label constants to the values derived in Step 1:
```ts
import type { Card, SiteAdapter } from './types';
import { waitForSelector } from '../content/grid-ready';

// Derived from tests/fixtures/onemorebeer-piwa.html (Task 9/10 Step 1):
const CARD_SELECTOR = '__SET_FROM_FIXTURE__';   // e.g. '[class*="product-tile"]'
const TITLE_SELECTOR = '__SET_FROM_FIXTURE__';  // product name element within a card
const PRODUCENT_LABEL = 'producent';            // label text preceding the brewery value
const MOC_LABEL = 'moc';                         // label text preceding the ABV value

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? '';
}

/** Find the value rendered next to a label like "Producent:" / "Moc (%)" inside a card. */
function valueForLabel(card: Element, label: string): string {
  const lower = label.toLowerCase();
  for (const node of Array.from(card.querySelectorAll('*'))) {
    if (node.children.length > 0) continue; // leaf nodes only
    const t = text(node).toLowerCase();
    if (t.startsWith(lower)) {
      // value is either after a ':' in the same node, or in the next sibling element
      const inline = text(node).split(/[:：]/).slice(1).join(':').trim();
      if (inline) return inline;
      const sib = node.nextElementSibling;
      if (sib) return text(sib);
    }
  }
  return '';
}

function parseAbv(raw: string): number | undefined {
  const m = raw.replace(',', '.').match(/(\d+(\.\d+)?)/);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function stripBreweryPrefix(name: string, brewery: string): string {
  const b = brewery.trim();
  if (b && name.toLowerCase().startsWith(b.toLowerCase())) {
    return name.slice(b.length).trim() || name.trim();
  }
  return name.trim();
}

export const onemorebeer: SiteAdapter = {
  hostMatch: (url) => url.hostname === 'onemorebeer.pl' || url.hostname.endsWith('.onemorebeer.pl'),

  async waitForGrid(root) {
    await waitForSelector(root, CARD_SELECTOR, { timeoutMs: 8000 });
  },

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const brewery = valueForLabel(el, PRODUCENT_LABEL);
      const rawName = text(el.querySelector(TITLE_SELECTOR));
      const name = stripBreweryPrefix(rawName, brewery);
      if (!brewery || !name) continue;
      const abv = parseAbv(valueForLabel(el, MOC_LABEL));
      cards.push(abv !== undefined ? { el, brewery, name, abv } : { el, brewery, name });
    }
    return cards;
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extension && npx vitest run src/sites/onemorebeer.test.ts`
Expected: PASS (4 tests). If parsing returns 0 cards, the `CARD_SELECTOR`/`TITLE_SELECTOR` constants are wrong — re-inspect the fixture (Step 1) and adjust. If `valueForLabel` misses the brewery, log `el.outerHTML` for one card and adjust the label-matching to the real DOM shape.

- [ ] **Step 6: Commit**

```bash
git add extension/src/sites/onemorebeer.ts extension/src/sites/onemorebeer.test.ts
git commit -m "feat(extension): onemorebeer client-rendered adapter + render-wait"
```

---

## Task 11: `content/badge.ts` — render the badge

**Files:**
- Create: `extension/src/content/badge.ts`
- Test: `extension/src/content/badge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderBadge, BADGE_MARKER } from './badge';
import type { MatchResult } from '../api/types';

function el(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

const drunk = (userRating: number | null): MatchResult => ({
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1 },
  is_drunk: true,
  user_rating: userRating,
});

const notDrunk: MatchResult = {
  raw: { brewery: 'PINTA', name: 'New One' },
  matched_beer: { id: 2, name: 'New One', brewery: 'PINTA', rating_global: 3.9 },
  is_drunk: false,
  user_rating: null,
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('renderBadge', () => {
  it('adds a ✅ + rating badge for a drunk beer', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('✅');
    expect(badge!.textContent).toContain('4.0');
  });

  it('shows just ✅ when no personal rating', () => {
    const host = el();
    renderBadge(host, drunk(null));
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('✅');
  });

  it('renders nothing for a not-drunk beer (MVP)', () => {
    const host = el();
    renderBadge(host, notDrunk);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('is idempotent — does not double-render', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    renderBadge(host, drunk(4.0));
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/content/badge.test.ts`
Expected: FAIL ("Cannot find module './badge'").

- [ ] **Step 3: Write the implementation**

```ts
import type { MatchResult } from '../api/types';

export const BADGE_MARKER = 'data-beerbadge';

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  if (!result.is_drunk) return; // MVP: only drunk beers get a badge
  if (host.querySelector(`[${BADGE_MARKER}]`)) return;

  const badge = document.createElement('div');
  badge.setAttribute(BADGE_MARKER, '');
  badge.textContent =
    result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅';
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
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/content/badge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts
git commit -m "feat(extension): corner badge renderer (drunk-only, idempotent)"
```

---

## Task 12: `background/index.ts` — service worker

**Files:**
- Create: `extension/src/background/index.ts`
- Test: `extension/src/background/handle-match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { handleMatch } from './index';
import { setSettings } from '../shared/config';
import * as client from '../api/client';
import { ApiError } from '../api/client';
import type { MatchResult, RawBeer } from '../api/types';

function mkResult(name: string): MatchResult {
  return { raw: { brewery: 'B', name }, matched_beer: null, is_drunk: false, user_rating: null };
}

beforeEach(() => setSettings({ token: 'tok', baseUrl: 'https://api.test' }));
afterEach(() => vi.restoreAllMocks());

describe('handleMatch', () => {
  it('returns no-token error when no token is set', async () => {
    await setSettings({ token: '', baseUrl: 'https://api.test' });
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'no-token' });
  });

  it('calls postMatch and returns results on success', async () => {
    const spy = vi.spyOn(client, 'postMatch').mockResolvedValue([mkResult('X')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:ok', results: [mkResult('X')] });
    expect(spy).toHaveBeenCalledWith('https://api.test', 'tok', [{ brewery: 'B', name: 'X' }]);
  });

  it('chunks requests larger than 200 and concatenates results', async () => {
    const cards: RawBeer[] = Array.from({ length: 250 }, (_, i) => ({ brewery: 'B', name: `n${i}` }));
    const spy = vi
      .spyOn(client, 'postMatch')
      .mockImplementation(async (_b, _t, part) => part.map((p) => mkResult(p.name)));
    const reply = await handleMatch({ type: 'match', cards });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][2]).toHaveLength(200);
    expect(spy.mock.calls[1][2]).toHaveLength(50);
    expect(reply).toMatchObject({ type: 'match:ok' });
    if (reply.type === 'match:ok') expect(reply.results).toHaveLength(250);
  });

  it('maps ApiError code to a match:err reply', async () => {
    vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('unauthorized'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'unauthorized' });
  });

  it('maps an unknown throw to code server', async () => {
    vi.spyOn(client, 'postMatch').mockRejectedValue(new Error('boom'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'server' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/background/handle-match.test.ts`
Expected: FAIL ("Cannot find module './index'").

- [ ] **Step 3: Write the implementation**

```ts
import { getSettings } from '../shared/config';
import { postMatch, ApiError } from '../api/client';
import type { MatchResult, RawBeer } from '../api/types';

export interface MatchMessage {
  type: 'match';
  cards: RawBeer[];
}

export type MatchReply =
  | { type: 'match:ok'; results: MatchResult[] }
  | { type: 'match:err'; code: 'unauthorized' | 'server' | 'network' | 'no-token' };

const MAX_PER_REQUEST = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function handleMatch(msg: MatchMessage): Promise<MatchReply> {
  const { token, baseUrl } = await getSettings();
  if (!token) return { type: 'match:err', code: 'no-token' };
  try {
    const results: MatchResult[] = [];
    for (const part of chunk(msg.cards, MAX_PER_REQUEST)) {
      results.push(...(await postMatch(baseUrl, token, part)));
    }
    return { type: 'match:ok', results };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'server';
    return { type: 'match:err', code };
  }
}

function isMatchMessage(x: unknown): x is MatchMessage {
  return !!x && typeof x === 'object' && (x as { type?: unknown }).type === 'match';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isMatchMessage(message)) return undefined;
  handleMatch(message).then(sendResponse);
  return true; // keep the message channel open for the async reply
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/background/handle-match.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/index.ts extension/src/background/handle-match.test.ts
git commit -m "feat(extension): background worker (match handler + chunking + messaging)"
```

---

## Task 13: `content/index.ts` — orchestrator

**Files:**
- Create: `extension/src/content/index.ts`
- Test: `extension/src/content/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOverlay } from './index';
import { BADGE_MARKER } from './badge';
import { setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import type { SiteAdapter, Card } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';

function drunkResult(brewery: string, name: string): MatchResult {
  return {
    raw: { brewery, name },
    matched_beer: { id: 1, name, brewery, rating_global: 4.0 },
    is_drunk: true,
    user_rating: 4.2,
  };
}

function cardEl(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

beforeEach(() => { document.body.innerHTML = ''; });

function adapterFor(cards: Card[]): SiteAdapter {
  return { hostMatch: () => true, parseCards: () => cards };
}

describe('runOverlay', () => {
  it('matches uncached cards via sendMatch and badges drunk ones', async () => {
    const cards: Card[] = [{ el: cardEl(), brewery: 'PINTA', name: 'Hazy Morning' }];
    const sendMatch = vi.fn(async (_b: RawBeer[]) => [drunkResult('PINTA', 'Hazy Morning')]);

    await runOverlay(document, adapterFor(cards), sendMatch);

    expect(sendMatch).toHaveBeenCalledTimes(1);
    expect(cards[0].el.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
  });

  it('uses the cache and does not call sendMatch for cached cards', async () => {
    const card: Card = { el: cardEl(), brewery: 'PINTA', name: 'Hazy Morning' };
    await setCached(normalizeKey('PINTA', 'Hazy Morning'), drunkResult('PINTA', 'Hazy Morning'));
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapterFor([card]), sendMatch);

    expect(sendMatch).not.toHaveBeenCalled();
    expect(card.el.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
  });

  it('awaits waitForGrid before parsing when the adapter defines it', async () => {
    const order: string[] = [];
    const card: Card = { el: cardEl(), brewery: 'B', name: 'N' };
    const adapter: SiteAdapter = {
      hostMatch: () => true,
      waitForGrid: async () => { order.push('wait'); },
      parseCards: () => { order.push('parse'); return [card]; },
    };
    await runOverlay(document, adapter, async () => [drunkResult('B', 'N')]);
    expect(order).toEqual(['wait', 'parse']);
  });

  it('does not throw when sendMatch fails (graceful skip)', async () => {
    const card: Card = { el: cardEl(), brewery: 'B', name: 'N' };
    const sendMatch = vi.fn(async () => { throw new Error('offline'); });
    await expect(runOverlay(document, adapterFor([card]), sendMatch)).resolves.toBeUndefined();
    expect(card.el.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/content/index.test.ts`
Expected: FAIL ("Cannot find module './index'").

- [ ] **Step 3: Write the implementation**

```ts
import type { SiteAdapter } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';
import { getCached, setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import { renderBadge } from './badge';

export type SendMatch = (cards: RawBeer[]) => Promise<MatchResult[]>;

export async function runOverlay(
  doc: Document,
  adapter: SiteAdapter,
  sendMatch: SendMatch,
): Promise<void> {
  try {
    if (adapter.waitForGrid) await adapter.waitForGrid(doc);
    const cards = adapter.parseCards(doc);

    const misses: { el: HTMLElement; key: string; raw: RawBeer }[] = [];
    for (const card of cards) {
      const key = normalizeKey(card.brewery, card.name);
      const cached = await getCached(key);
      if (cached) {
        renderBadge(card.el, cached);
      } else {
        const raw: RawBeer =
          card.abv !== undefined
            ? { brewery: card.brewery, name: card.name, abv: card.abv }
            : { brewery: card.brewery, name: card.name };
        misses.push({ el: card.el, key, raw });
      }
    }
    if (misses.length === 0) return;

    let results: MatchResult[];
    try {
      results = await sendMatch(misses.map((m) => m.raw));
    } catch {
      return; // network/server error: leave the page untouched, retry next load
    }

    results.forEach((result, i) => {
      const miss = misses[i];
      if (!miss) return;
      renderBadge(miss.el, result);
      void setCached(miss.key, result);
    });
  } catch {
    // Any parsing/rendering failure must never break the host page.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/content/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/index.ts extension/src/content/index.test.ts
git commit -m "feat(extension): content orchestrator (cache → match → badge, graceful)"
```

---

## Task 14: `content/main.ts` — content entry wiring

**Files:**
- Create: `extension/src/content/main.ts` (no unit test — thin glue; verified at build/manual-load)

- [ ] **Step 1: Write the entry**

```ts
import { pickAdapter } from '../sites/registry';
import { runOverlay, type SendMatch } from './index';
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

const adapter = pickAdapter(new URL(window.location.href));
if (adapter) {
  void runOverlay(document, adapter, sendMatch);
}
```

- [ ] **Step 2: Typecheck the package**

Run: `cd extension && npm run typecheck`
Expected: PASS (no type errors across all modules so far).

- [ ] **Step 3: Commit**

```bash
git add extension/src/content/main.ts
git commit -m "feat(extension): content script entry wiring (sendMessage bridge)"
```

---

## Task 15: Options page (token, URL, Test connection)

**Files:**
- Create: `extension/src/options/options.html`, `extension/src/options/options.css`, `extension/src/options/options.ts`
- Test: `extension/src/options/options.test.ts`

- [ ] **Step 1: Write the failing test for the options logic**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testConnection } from './options';
import * as client from '../api/client';
import { ApiError } from '../api/client';

afterEach(() => vi.restoreAllMocks());

describe('testConnection', () => {
  it('ok when health passes and a probe match succeeds', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(true);
    vi.spyOn(client, 'postMatch').mockResolvedValue([]);
    expect(await testConnection('https://api.test', 'tok')).toEqual({ ok: true });
  });

  it('fails with reason "health" when health is down', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(false);
    expect(await testConnection('https://api.test', 'tok')).toEqual({ ok: false, reason: 'health' });
  });

  it('fails with reason "unauthorized" when the probe match is 401', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(true);
    vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('unauthorized'));
    expect(await testConnection('https://api.test', 'bad')).toEqual({ ok: false, reason: 'unauthorized' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/options/options.test.ts`
Expected: FAIL ("Cannot find module './options'").

- [ ] **Step 3: Write `extension/src/options/options.ts`**

```ts
import { getSettings, setSettings, DEFAULT_BASE_URL } from '../shared/config';
import { getHealth, postMatch, ApiError } from '../api/client';

export interface ConnectionResult {
  ok: boolean;
  reason?: 'health' | ApiError['code'];
}

export async function testConnection(baseUrl: string, token: string): Promise<ConnectionResult> {
  const healthy = await getHealth(baseUrl);
  if (!healthy) return { ok: false, reason: 'health' };
  try {
    await postMatch(baseUrl, token, [{ brewery: 'connection', name: 'check' }]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof ApiError ? e.code : 'server' };
  }
}

// --- DOM wiring (runs only in the options page, not under test) ---
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function initOptionsPage(): Promise<void> {
  const tokenInput = el<HTMLInputElement>('token');
  const urlInput = el<HTMLInputElement>('baseUrl');
  const status = el<HTMLElement>('status');
  if (!tokenInput || !urlInput || !status) return;

  const s = await getSettings();
  tokenInput.value = s.token;
  urlInput.value = s.baseUrl || DEFAULT_BASE_URL;

  el<HTMLButtonElement>('save')?.addEventListener('click', async () => {
    await setSettings({ token: tokenInput.value.trim(), baseUrl: urlInput.value.trim() });
    // Best-effort: request permission for a custom (non-default) host so the worker can fetch it.
    try {
      const origin = new URL(urlInput.value.trim()).origin + '/*';
      await chrome.permissions.request({ origins: [origin] });
    } catch {
      /* invalid URL or denied — surfaced by Test connection */
    }
    status.textContent = 'Saved.';
  });

  el<HTMLButtonElement>('test')?.addEventListener('click', async () => {
    status.textContent = 'Testing…';
    const r = await testConnection(urlInput.value.trim(), tokenInput.value.trim());
    status.textContent = r.ok ? '✅ Connected.' : `❌ Failed (${r.reason}).`;
  });
}

if (typeof document !== 'undefined' && document.getElementById('token')) {
  void initOptionsPage();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/options/options.test.ts`
Expected: PASS (3 tests). (The DOM-wiring branch is skipped under test because the options inputs aren't in the jsdom document.)

- [ ] **Step 5: Create `extension/src/options/options.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Warsaw Beer Overlay — Options</title>
    <link rel="stylesheet" href="./options.css" />
  </head>
  <body>
    <main class="card">
      <h1>Warsaw Beer Overlay</h1>
      <label for="token">Token (from the bot's <code>/extension</code> command)</label>
      <input id="token" type="password" autocomplete="off" placeholder="paste your token" />

      <label for="baseUrl">API URL</label>
      <input id="baseUrl" type="url" placeholder="https://beer-api.ysilvestrov-ai.uk" />

      <div class="row">
        <button id="save" type="button">Save</button>
        <button id="test" type="button">Test connection</button>
      </div>
      <p id="status" class="status" aria-live="polite"></p>
    </main>
    <script type="module" src="./options.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `extension/src/options/options.css`**

```css
body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f6f7; }
.card { max-width: 460px; margin: 0 auto; background: #fff; padding: 22px; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
h1 { font-size: 18px; margin: 0 0 16px; }
label { display: block; margin: 14px 0 4px; font-weight: 600; font-size: 13px; }
input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px; }
.row { display: flex; gap: 10px; margin-top: 16px; }
button { padding: 8px 14px; border: 0; border-radius: 8px; background: #d9822b; color: #fff; font-weight: 600; cursor: pointer; }
button:hover { background: #c2741f; }
.status { min-height: 20px; margin-top: 12px; font-size: 13px; }
```

- [ ] **Step 7: Add the `permissions` API type — verify typecheck**

Run: `cd extension && npm run typecheck`
Expected: PASS. (`@types/chrome` covers `chrome.permissions`. If `chrome.permissions` is reported missing, ensure `@types/chrome` is installed and listed in `tsconfig` `types`.)

- [ ] **Step 8: Commit**

```bash
git add extension/src/options/options.ts extension/src/options/options.test.ts \
  extension/src/options/options.html extension/src/options/options.css
git commit -m "feat(extension): options page (token, editable URL, test connection)"
```

---

## Task 16: Full build, manual-load smoke check, and `spec.md` update

**Files:**
- Modify: `spec.md` (repo root)

- [ ] **Step 1: Run the full test suite**

Run: `cd extension && npm test`
Expected: PASS — all suites green (config, normalize, cache, client, registry, beerrepublic, grid-ready, onemorebeer, badge, handle-match, content/index, options).

- [ ] **Step 2: Typecheck and build**

Run: `cd extension && npm run typecheck && npm run build`
Expected: typecheck clean; `vite build` writes `extension/dist/` with `manifest.json`, the background worker, the content script, and the options page — no unresolved-entry errors.

- [ ] **Step 3: Manual load smoke (documented — requires a Chromium browser)**

Document these steps in the commit body / PR description (run by the user, since the VPS has no GUI; can be done from any Chrome that can reach the built `dist/`):
1. `chrome://extensions` → enable Developer mode → "Load unpacked" → select `extension/dist`.
2. Open the extension Options, paste a token from the bot's `/extension` command, keep the default URL, click **Test connection** → expect ✅.
3. Visit `https://beerrepublic.eu/collections/all` → already-drunk beers show a ✅ badge.
4. Visit `https://onemorebeer.pl/piwa` → after the grid renders, drunk beers show a ✅ badge.

- [ ] **Step 4: Add the `extension/` section to root `spec.md`**

Append a new top-level section to `/home/ysi/warsaw-beer-bot/spec.md` (after §5, before the Appendix), summarizing the component. Use this content:
```markdown
## 6. Browser Extension Client (`extension/`)

> Read-only MV3 розширення (monorepo-lite): Vite + Vanilla-TS + `@crxjs/vite-plugin`,
> тести — Vitest. Накладає особистий drunk-статус + рейтинг на сітки крафт-магазинів,
> споживаючи `POST /match` (§4). Дизайн: `docs/superpowers/specs/2026-06-07-browser-extension-client-design.md`.

- **Per-site адаптери** (`src/sites/`): `beerrepublic` (Shopify SSR — `.product-item`/
  `__vendor`/`__title`), `onemorebeer` (Nuxt client-rendered — нода `Producent:`,
  тайтл, `Moc (%)`; має `waitForGrid` render-gate). `registry.pickAdapter(url)`.
- **Потік:** content script парсить видиму сітку → short-TTL кеш
  (`chrome.storage.local`) → промахи йдуть у background service worker, який
  тримає Bearer-токен (ніколи не в контексті сторінки) і б'є `POST /match` →
  бейдж ✅+оцінка на випитих. Класична пагінація обох магазинів → матч на
  кожне завантаження сторінки.
- **Auth:** токен з команди `/extension` зберігається в `chrome.storage.local`;
  base URL редагований (дефолт `https://beer-api.ysilvestrov-ai.uk`, §5.9);
  options-сторінка має Test connection (`GET /health` + 1-beer `/match`).
- **Read-only гарантія:** лише додає власні бейдж-ноди; будь-яка помилка
  парсингу/рендеру проковтується й не ламає сторінку магазину.
- **Тести:** контрактні тести адаптерів на HTML-фікстурах (`beerrepublic` — `curl`;
  `onemorebeer` — headless-Playwright рендер-дамп), unit-тести кеша/normalize/
  client/worker/badge.
```

- [ ] **Step 5: Verify the spec edit and run backend tests are unaffected**

Run: `cd /home/ysi/warsaw-beer-bot && npm test`
Expected: backend Jest suite still PASSES (the extension is isolated; root `npm test` does not pick up `extension/` Vitest files).

- [ ] **Step 6: Commit**

```bash
git add spec.md
git commit -m "docs(spec): add Browser Extension Client section (extension/)"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** scaffolding (§7→T1), config/auth (§1.4→T2,T15), cache (§1.6→T4), API client + contract (§4→T5), adapter abstraction (§3.1→T6), beerrepublic SSR (§1→T7), render-gate (§3.4→T8), onemorebeer client-render + fixture (§3.4,§6→T9,T10), badge (§3.3→T11), worker/token-isolation (§1.5,§3.2→T12,T14), orchestrator + error handling (§4,§5→T13), options + test-connection (§1.4→T15), docs (§7→T16).
- **The single fixture-dependent task is T10** (onemorebeer selectors). It is structured so the engineer derives 2 selector constants from the captured fixture in Step 1, with the contract test pinning real parsed values. This is inherent to scraping a client-rendered store, not a deferred placeholder.
- **Type consistency:** `MatchResult`/`RawBeer`/`MatchedBeer` (T4) are reused verbatim in T5, T11, T12, T13, T15. `SendMatch` (T13) matches `main.ts` bridge (T14). `MatchReply`/`MatchMessage` (T12) are imported by `main.ts` (T14).
- **Backend untouched:** the only repo-root changes are `.gitignore` (T1) and `spec.md` (T16). No `src/**` backend files are modified; the server `POST /match` contract is consumed as-is.
