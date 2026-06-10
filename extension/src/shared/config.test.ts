import { describe, it, expect, vi } from 'vitest';
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
    expect(s).toEqual({ token: 'abc', baseUrl: 'http://localhost:3000', enrichEnabled: false });
  });

  it('falls back to default baseUrl when stored baseUrl is blank', async () => {
    await setSettings({ token: 'abc', baseUrl: '' });
    expect((await getSettings()).baseUrl).toBe(DEFAULT_BASE_URL);
  });

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
});
