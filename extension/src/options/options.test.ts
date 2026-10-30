import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as auth from '../untappd/auth';
import * as db from '../db/indexed-db';
import * as config from '../shared/config';
import { refreshOptionsUI } from './options';

describe('options UI', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="authStatusText"></div>
      <div id="dbStatsText"></div>
      <input type="checkbox" id="enrichEnabled" />
    `;
    vi.spyOn(config, 'getSettings').mockResolvedValue({
      baseUrl: 'https://api.untappd.com',
      token: '',
      enrichEnabled: true,
      lastCheckinSync: null,
    });
    vi.spyOn(db, 'countUserHad').mockResolvedValue(42);
    vi.spyOn(db, 'countCatalogBeers').mockResolvedValue(105);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders logged-in state correctly', async () => {
    vi.spyOn(auth, 'getAuthState').mockResolvedValue({
      isLoggedIn: true,
      user: {
        username: 'craft_lover',
        name: 'Beer Lover',
        avatarUrl: '',
        totalCheckins: 500,
        uniqueBeers: 450,
      },
    });

    await refreshOptionsUI();

    const authText = document.getElementById('authStatusText')!;
    expect(authText.innerHTML).toContain('craft_lover');
    expect(authText.innerHTML).toContain('500');

    const dbText = document.getElementById('dbStatsText')!;
    expect(dbText.innerHTML).toContain('42');
    expect(dbText.innerHTML).toContain('105');
  });

  it('renders logged-out state correctly', async () => {
    vi.spyOn(auth, 'getAuthState').mockResolvedValue({
      isLoggedIn: false,
      user: null,
    });

    await refreshOptionsUI();

    const authText = document.getElementById('authStatusText')!;
    expect(authText.innerHTML).toContain('Not signed in');
  });
});
