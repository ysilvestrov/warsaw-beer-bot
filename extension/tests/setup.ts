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
