import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAuthState, saveAuthState, logoutUntappd, fetchUserProfileFromWeb } from './auth';

describe('Untappd Auth State', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('correctly distinguishes Unique beers from Badges and Total checkins', async () => {
    const mockHtml = `
      <div class="user-info"><h2>Anton Shapka</h2></div>
      <div class="stats">
        <a href="/user/66Ton99" data-href=":stats/general">
          <span class="stat">2,863</span>
          <span class="title">Total</span>
        </a>
        <a href="/user/66Ton99/beers" data-href=":stats/beerhistory">
          <span class="stat">2,809</span>
          <span class="title">Unique</span>
        </a>
        <a href="/user/66Ton99/badges" data-href=":stats/badges">
          <span class="stat">3,240</span>
          <span class="title">Badges</span>
        </a>
      </div>
    `;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    }));

    const profile = await fetchUserProfileFromWeb('66Ton99');
    expect(profile.name).toBe('Anton Shapka');
    expect(profile.totalCheckins).toBe(2863);
    expect(profile.totalBeers).toBe(2809); // NOT 3240 (which are badges!)
  });

  it('reads empty state when not authenticated', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const state = await getAuthState();
    expect(state.isLoggedIn).toBe(false);
    expect(state.user).toBeNull();
  });

  it('persists and removes auth state cleanly', async () => {
    let stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockImplementation((key: string) => Promise.resolve({ [key]: stored[key] })),
          set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
            stored = { ...stored, ...data };
            return Promise.resolve();
          }),
          remove: vi.fn().mockImplementation((key: string) => {
            delete stored[key];
            return Promise.resolve();
          }),
        },
      },
    });

    await saveAuthState({
      isLoggedIn: true,
      user: {
        username: 'ton',
        name: 'Anton',
        avatar: 'https://avatar.png',
        totalCheckins: 50,
        totalBeers: 45,
        authMethod: 'web_session',
      },
      lastChecked: Date.now(),
    });

    const state = await getAuthState();
    expect(state.isLoggedIn).toBe(true);
    expect(state.user?.username).toBe('ton');

    await logoutUntappd();
    const afterLogout = await getAuthState();
    expect(afterLogout.isLoggedIn).toBe(false);
  });
});
