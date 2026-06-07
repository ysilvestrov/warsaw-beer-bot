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
