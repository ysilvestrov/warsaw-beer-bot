import { vi, beforeEach } from 'vitest';

const store = new Map<string, unknown>();

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
  },
  runtime: {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
    lastError: undefined,
  },
};

beforeEach(() => {
  store.clear();
});
