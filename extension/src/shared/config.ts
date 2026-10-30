export interface Settings {
  token: string;
  baseUrl: string;
  enrichEnabled: boolean;
  /** #923: the anonymous install token (`wbi_…`) the server issued; '' when there is none. */
  installToken: string;
  /** #923: the user's "Anonymous usage statistics" switch. On unless switched off. */
  installRegistration: boolean;
  /** #923: the user switched statistics off and the server has not confirmed the deletion yet. */
  installDeletionPending: boolean;
}

export const DEFAULT_BASE_URL = 'https://beer-api.ysilvestrov-ai.uk';

/** Hosted English install & setup guide, linked from the options page and no-token popup. */
export const SETUP_GUIDE_URL = 'https://ysilvestrov.github.io/warsaw-beer-bot/install/';

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get([
    'token', 'baseUrl', 'enrichEnabled', 'installToken', 'installRegistration', 'installDeletionPending',
  ]);
  return {
    token: typeof s.token === 'string' ? s.token : '',
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : DEFAULT_BASE_URL,
    enrichEnabled: s.enrichEnabled === true,
    installToken: typeof s.installToken === 'string' ? s.installToken : '',
    installRegistration: s.installRegistration !== false,
    installDeletionPending: s.installDeletionPending === true,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/**
 * #923: the bearer a request carries. A Telegram token always wins; the install token stands in
 * only without one, and never while its deletion is pending — the user asked to stop being counted.
 */
export function authToken(s: Pick<Settings, 'token' | 'installToken' | 'installDeletionPending'>): string {
  return s.token || (s.installDeletionPending ? '' : s.installToken);
}
