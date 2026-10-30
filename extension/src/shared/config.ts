export interface Settings {
  token: string;
  baseUrl: string;
  enrichEnabled: boolean;
  directUntappd: boolean;
}

export const DEFAULT_BASE_URL = 'https://api.untappd.com';

/** Hosted English install & setup guide, linked from the options page and no-token popup. */
export const SETUP_GUIDE_URL = 'https://untappd.com';

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['token', 'baseUrl', 'enrichEnabled', 'directUntappd']);
  return {
    token: typeof s.token === 'string' ? s.token : '',
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : DEFAULT_BASE_URL,
    enrichEnabled: s.enrichEnabled === true,
    directUntappd: s.directUntappd !== false, // default true (pure client mode)
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
