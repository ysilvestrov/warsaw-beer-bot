import { vi, beforeEach } from 'vitest';

const store = new Map<string, unknown>();
// #965: chrome.storage.session — gone with the browser, kept across worker restarts.
const sessionStore = new Map<string, unknown>();

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
        const isRecord = keys !== null && typeof keys === 'object' && !Array.isArray(keys);
        const ks: string[] = Array.isArray(keys)
          ? keys
          : typeof keys === 'string'
            ? [keys]
            : isRecord
              ? Object.keys(keys as Record<string, unknown>)
              : [...store.keys()];
        const out: Record<string, unknown> = {};
        for (const k of ks) {
          if (store.has(k)) out[k] = store.get(k);
          else if (isRecord) out[k] = (keys as Record<string, unknown>)[k];
          // truly-absent keys with no default are omitted, matching Chrome
        }
        return out;
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      }),
    },
    session: {
      get: vi.fn(async (keys?: string | string[]) => {
        const ks = keys === undefined ? [...sessionStore.keys()] : Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of ks) if (sessionStore.has(k)) out[k] = sessionStore.get(k);
        return out;
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) sessionStore.delete(k);
      }),
    },
  },
  // #934: the background worker registers the sync alarms at import.
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => true),
    get: vi.fn(async () => undefined),
    onAlarm: { addListener: vi.fn() },
  },
  // #965: onAdded — the worker starts the sync a closed popup could not.
  permissions: { contains: vi.fn(async () => false), onAdded: { addListener: vi.fn() } },
  action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  runtime: {
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    getManifest: vi.fn(() => ({ version: '9.9.9' })),
    sendMessage: vi.fn(),
    lastError: undefined,
  },
};

beforeEach(() => {
  store.clear();
  sessionStore.clear();
});
