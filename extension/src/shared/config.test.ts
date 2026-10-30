import { describe, it, expect, vi } from 'vitest';
import { authToken, getSettings, setSettings, DEFAULT_BASE_URL, SETUP_GUIDE_URL } from './config';

describe('config', () => {
  it('returns empty token + default baseUrl when nothing stored', async () => {
    const s = await getSettings();
    expect(s.token).toBe('');
    expect(s.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('persists and reads back token + baseUrl', async () => {
    await setSettings({ token: 'abc', baseUrl: 'http://localhost:3000' });
    const s = await getSettings();
    expect(s).toEqual({
      token: 'abc', baseUrl: 'http://localhost:3000', enrichEnabled: false,
      installToken: '', installRegistration: true, installDeletionPending: false,
    });
  });

  it('statistics are on unless explicitly switched off', async () => {
    await setSettings({ installRegistration: false });
    expect((await getSettings()).installRegistration).toBe(false);
    await setSettings({ installRegistration: true });
    expect((await getSettings()).installRegistration).toBe(true);
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

describe('authToken', () => {
  it('the Telegram token wins over the install token', () => {
    expect(authToken({ token: 'tg', installToken: 'wbi_1', installDeletionPending: false })).toBe('tg');
  });

  it('the install token stands in without a Telegram token', () => {
    expect(authToken({ token: '', installToken: 'wbi_1', installDeletionPending: false })).toBe('wbi_1');
  });

  it('a pending deletion withholds the install token at once', () => {
    expect(authToken({ token: '', installToken: 'wbi_1', installDeletionPending: true })).toBe('');
  });

  it('a pending deletion does not touch the Telegram token', () => {
    expect(authToken({ token: 'tg', installToken: 'wbi_1', installDeletionPending: true })).toBe('tg');
  });

  it('no token at all is anonymous', () => {
    expect(authToken({ token: '', installToken: '', installDeletionPending: false })).toBe('');
  });
});

describe('SETUP_GUIDE_URL', () => {
  it('points at the hosted English setup guide', () => {
    expect(SETUP_GUIDE_URL).toBe('https://ysilvestrov.github.io/warsaw-beer-bot/install/');
  });
});
