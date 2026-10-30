export interface UntappdUser {
  username: string;
  name: string;
  avatar: string;
  totalCheckins: number;
  totalBeers: number;
  authMethod: 'web_session' | 'token';
  token?: string;
}

export interface AuthState {
  isLoggedIn: boolean;
  user: UntappdUser | null;
  lastChecked: number;
  error?: string;
}

const AUTH_STORAGE_KEY = 'untappd_auth_state';

export async function getAuthState(): Promise<AuthState> {
  const got = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  const state = got[AUTH_STORAGE_KEY] as AuthState | undefined;
  if (!state || !state.isLoggedIn || !state.user) {
    return { isLoggedIn: false, user: null, lastChecked: Date.now() };
  }
  return state;
}

export async function saveAuthState(state: AuthState): Promise<void> {
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: state });
}

export async function logoutUntappd(): Promise<void> {
  await chrome.storage.local.remove(AUTH_STORAGE_KEY);
}

/**
 * Checks if the user has an active session on untappd.com by fetching the user home/profile.
 */
export async function checkUntappdWebSession(): Promise<AuthState> {
  try {
    const res = await fetch('https://untappd.com/home', {
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!res.ok || res.redirected && res.url.includes('/login')) {
      return { isLoggedIn: false, user: null, lastChecked: Date.now(), error: 'Not signed in on untappd.com' };
    }

    const html = await res.text();
    // Look for user profile links or elements in Untappd home page
    const userMatch = html.match(/href=["']\/user\/([^"'/?#]+)["']/i);
    if (!userMatch) {
      return { isLoggedIn: false, user: null, lastChecked: Date.now(), error: 'Could not detect user from untappd.com' };
    }

    const username = decodeURIComponent(userMatch[1]);
    const profile = await fetchUserProfileFromWeb(username);

    const state: AuthState = {
      isLoggedIn: true,
      user: {
        username,
        name: profile.name || username,
        avatar: profile.avatar || '',
        totalCheckins: profile.totalCheckins || 0,
        totalBeers: profile.totalBeers || 0,
        authMethod: 'web_session',
      },
      lastChecked: Date.now(),
    };

    await saveAuthState(state);
    return state;
  } catch (err) {
    return {
      isLoggedIn: false,
      user: null,
      lastChecked: Date.now(),
      error: err instanceof Error ? err.message : 'Network error checking web session',
    };
  }
}

/**
 * Fetches basic stats and profile info from public or authenticated user page.
 */
export async function fetchUserProfileFromWeb(username: string): Promise<{ name: string; avatar: string; totalCheckins: number; totalBeers: number }> {
  try {
    const res = await fetch(`https://untappd.com/user/${encodeURIComponent(username)}`, {
      credentials: 'include',
    });
    if (!res.ok) return { name: username, avatar: '', totalCheckins: 0, totalBeers: 0 };

    const html = await res.text();

    // Parse avatar
    const avatarMatch = html.match(/class=["'][^"']*user-avatar[^"']*["'][^>]*src=["']([^"']+)["']/i) ||
                        html.match(/<img[^>]+src=["']([^"']+)["'][^>]*class=["'][^"']*avatar[^"']*["']/i);
    const avatar = avatarMatch ? avatarMatch[1] : '';

    // Parse real name
    const nameMatch = html.match(/class=["'][^"']*user-info[^"']*["'][^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/i) ||
                      html.match(/<h2[^>]*>([^<]+)<\/h2>/i);
    const name = nameMatch ? nameMatch[1].trim() : username;

    // Parse stats
    // Untappd HTML markup puts the number inside span.stat BEFORE span.title:
    // <a href="/user/username" ...><span class="stat">2,863</span><span class="title">Total</span></a>
    // <a href="/user/username/beers" ...><span class="stat">2,809</span><span class="title">Unique</span></a>
    // <a href="/user/username/badges" ...><span class="stat">3,240</span><span class="title">Badges</span></a>
    let totalCheckins = 0;
    let totalBeers = 0;

    const totalCheckinsMatch =
      html.match(/<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>\s*<span[^>]*class=["'][^"']*title[^"']*["'][^>]*>\s*Total\s*<\/span>/i) ||
      html.match(/data-href=["']:stats\/general["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>/i) ||
      html.match(/href=["'][^"']*\/user\/[^"']+["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>\s*<span[^>]*class=["'][^"']*title[^"']*["'][^>]*>\s*Total\s*<\/span>/i);

    if (totalCheckinsMatch) {
      totalCheckins = parseInt(totalCheckinsMatch[1].replace(/[,\s]/g, ''), 10) || 0;
    }

    const uniqueBeersMatch =
      html.match(/<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>\s*<span[^>]*class=["'][^"']*title[^"']*["'][^>]*>\s*Unique\s*<\/span>/i) ||
      html.match(/data-href=["']:stats\/beerhistory["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>/i) ||
      html.match(/href=["'][^"']*\/beers["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>/i);

    if (uniqueBeersMatch) {
      totalBeers = parseInt(uniqueBeersMatch[1].replace(/[,\s]/g, ''), 10) || 0;
    }

    return { name, avatar, totalCheckins, totalBeers };
  } catch {
    return { name: username, avatar: '', totalCheckins: 0, totalBeers: 0 };
  }
}
