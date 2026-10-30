import { describe, it, expect, vi } from 'vitest';
import { authToken, wantsRegistration, getSettings, setSettings, DEFAULT_BASE_URL, SETUP_GUIDE_URL } from './config';

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
      installToken: '', installBaseUrl: 'http://localhost:3000', installRegistration: true, installDeletionPending: false,
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
  const S = 'https://api.test';
  const base = { token: '', baseUrl: S, installToken: 'wbi_1', installBaseUrl: S, installDeletionPending: false };

  it('the Telegram token wins over the install token', () => {
    expect(authToken({ ...base, token: 'tg' })).toBe('tg');
  });

  it('the install token stands in without a Telegram token', () => {
    expect(authToken(base)).toBe('wbi_1');
  });

  it('a pending deletion withholds the install token at once', () => {
    expect(authToken({ ...base, installDeletionPending: true })).toBe('');
  });

  it('a pending deletion does not touch the Telegram token', () => {
    expect(authToken({ ...base, token: 'tg', installDeletionPending: true })).toBe('tg');
  });

  it('the install token is never sent to a server other than the one that issued it', () => {
    expect(authToken({ ...base, baseUrl: 'https://other.test' })).toBe('');
  });

  it('no token at all is anonymous', () => {
    expect(authToken({ ...base, installToken: '' })).toBe('');
  });
});

describe('wantsRegistration', () => {
  it('is due with statistics on and no token of either kind', async () => {
    expect(wantsRegistration(await getSettings())).toBe(true);
  });

  it('is not due with a Telegram token, an install token, statistics off, or a pending deletion', async () => {
    const due = async (patch: Parameters<typeof setSettings>[0]) => {
      await chrome.storage.local.remove(['token', 'installToken', 'installRegistration', 'installDeletionPending']);
      await setSettings(patch);
      return wantsRegistration(await getSettings());
    };
    expect([
      await due({ token: 'tg' }),
      await due({ installToken: 'wbi_1' }),
      await due({ installRegistration: false }),
      await due({ installDeletionPending: true }),
    ]).toEqual([false, false, false, false]);
  });
});
describe('SETUP_GUIDE_URL', () => {
  it('points at the hosted English setup guide', () => {
    expect(SETUP_GUIDE_URL).toBe('https://ysilvestrov.github.io/warsaw-beer-bot/install/');
  });
});
