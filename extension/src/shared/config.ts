export interface Settings {
  token: string;
  baseUrl: string;
  enrichEnabled: boolean;
  /** #923: the anonymous install token (`wbi_…`) the server issued; '' when there is none. */
  installToken: string;
  /** #923: the API server that issued `installToken` — the only one it is sent to or deleted on. */
  installBaseUrl: string;
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
    'token', 'baseUrl', 'enrichEnabled', 'installToken', 'installBaseUrl', 'installRegistration', 'installDeletionPending',
  ]);
  const baseUrl = typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : DEFAULT_BASE_URL;
  return {
    token: typeof s.token === 'string' ? s.token : '',
    baseUrl,
    enrichEnabled: s.enrichEnabled === true,
    installToken: typeof s.installToken === 'string' ? s.installToken : '',
    installBaseUrl: typeof s.installBaseUrl === 'string' && s.installBaseUrl ? s.installBaseUrl : baseUrl,
    installRegistration: s.installRegistration !== false,
    installDeletionPending: s.installDeletionPending === true,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/**
 * #923: the bearer a request carries. A Telegram token always wins; the install token stands in
 * only without one, never while its deletion is pending — the user asked to stop being counted —
 * and never to a server other than the one that issued it (a 401 there would lose the token
 * needed to delete the install where it lives).
 */
export function authToken(
  s: Pick<Settings, 'token' | 'baseUrl' | 'installToken' | 'installBaseUrl' | 'installDeletionPending'>,
): string {
  if (s.token) return s.token;
  return s.installDeletionPending || s.installBaseUrl !== s.baseUrl ? '' : s.installToken;
}

/** #923: a registration would happen now — statistics on, nothing pending, no token of either kind. */
export function wantsRegistration(s: Settings): boolean {
  return s.installRegistration && !s.installDeletionPending && !s.token && !s.installToken;
}
