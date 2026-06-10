export interface Settings {
  token: string;
  baseUrl: string;
  enrichEnabled: boolean;
}

export const DEFAULT_BASE_URL = 'https://beer-api.ysilvestrov-ai.uk';

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['token', 'baseUrl', 'enrichEnabled']);
  return {
    token: typeof s.token === 'string' ? s.token : '',
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : DEFAULT_BASE_URL,
    enrichEnabled: s.enrichEnabled === true,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
