import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canRefresh, initPopup } from './popup';

const html = readFileSync(resolve(__dirname, 'popup.html'), 'utf-8');

describe('canRefresh', () => {
  it('true on a supported shop URL', () => {
    expect(canRefresh('https://beerfreak.org/some/page')).toBe(true);
    expect(canRefresh('https://winetime.com.ua/x')).toBe(true);
    expect(canRefresh('https://beerrepublic.eu/beers')).toBe(true);
  });

  it('false on an unsupported URL', () => {
    expect(canRefresh('https://example.com/')).toBe(false);
  });

  it('false on a malformed or empty URL', () => {
    expect(canRefresh('not a url')).toBe(false);
    expect(canRefresh('')).toBe(false);
  });
});

describe('popup markup', () => {
  it('has direct Untappd branding', () => {
    expect(html).toContain('Direct Untappd & Local DB');
  });

  it('declares user profile block elements', () => {
    expect(html).toContain('id="userProfileBlock"');
    expect(html).toContain('id="userAvatar"');
    expect(html).toContain('id="userName"');
    expect(html).toContain('id="userStats"');
    expect(html).toContain('id="dbCount"');
    expect(html).toContain('id="logoutBtn"');
  });

  it('declares secure session-based Untappd login elements without password fields', () => {
    expect(html).toContain('id="loginBlock"');
    expect(html).toContain('id="detectSessionBtn"');
    expect(html).toContain('id="openLoginBtn"');
    expect(html).not.toContain('id="loginForm"');
    expect(html).not.toContain('id="loginUsername"');
    expect(html).not.toContain('id="loginPassword"');
    expect(html).not.toContain('id="submitLoginBtn"');
    expect(html).not.toContain('or sign in with credentials');
  });

  it('declares check-in sync and clear-db controls', () => {
    expect(html).toContain('id="syncSection"');
    expect(html).toContain('id="syncCheckins"');
    expect(html).toContain('id="syncStatus"');
    expect(html).toContain('id="clearAll"');
    expect(html).toContain('id="clearStatus"');
  });
});

describe('initPopup', () => {
  beforeEach(() => {
    document.body.innerHTML = html;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((msg: { type: string }, cb?: (res: unknown) => void) => {
          if (msg.type === 'auth:get-state' && cb) {
            cb({
              auth: {
                isLoggedIn: true,
                user: {
                  username: 'tester',
                  name: 'Craft Tester',
                  avatar: 'https://example.com/avatar.jpg',
                  totalBeers: 320,
                  totalCheckins: 500,
                },
              },
              hadCount: 320,
              catCount: 1200,
            });
          }
        }),
      },
      tabs: {
        query: vi.fn(async () => [{ url: 'https://beerfreak.org/beers', id: 1 }]),
        sendMessage: vi.fn(async () => {}),
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders user profile when authenticated', async () => {
    initPopup();

    // Allow async handlers to update DOM
    await Promise.resolve();

    const profileBlock = document.getElementById('userProfileBlock')!;
    const userName = document.getElementById('userName')!;
    const dbCount = document.getElementById('dbCount')!;

    expect(profileBlock.style.display).toBe('block');
    expect(userName.textContent).toBe('Craft Tester');
    expect(dbCount.textContent).toContain('320');
  });
});
