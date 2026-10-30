import { getSettings, setSettings } from '../shared/config';
import { deleteInstall, postInstall } from '../api/client';

// #923: the anonymous install token. It lets an install without Telegram use enrich and be counted
// in the usage statistics; it carries no identity, so every failure here is silent and the
// extension simply keeps working anonymously.

export function extensionVersion(): string {
  return chrome.runtime.getManifest().version;
}

/**
 * Brings the stored install state in line with the user's switch: first finishes a pending
 * deletion, then registers when statistics are on and there is neither a Telegram token nor an
 * install token. Returns the state it left behind, for the options page to show.
 */
export async function syncInstall(): Promise<'none' | 'registered' | 'deletion_pending'> {
  let s = await getSettings();
  if (s.installDeletionPending) {
    if (s.installToken && (await deleteInstall(s.baseUrl, s.installToken)) === 'retry') return 'deletion_pending';
    await setSettings({ installToken: '', installDeletionPending: false });
    s = await getSettings();
  }
  if (s.installToken) return 'registered';
  if (!s.installRegistration || s.token) return 'none';
  const token = await postInstall(s.baseUrl, extensionVersion());
  // The user may have switched statistics off or changed the server while the request was out.
  const latest = await getSettings();
  if (!latest.installRegistration || latest.installDeletionPending || latest.installToken || latest.baseUrl !== s.baseUrl) {
    await deleteInstall(s.baseUrl, token);
    return latest.installToken ? 'registered' : 'none';
  }
  await setSettings({ installToken: token });
  return 'registered';
}

let ensured: Promise<void> | null = null;

/** One attempt per service-worker lifetime: on install, on browser start and on the first message. */
export function ensureInstall(): Promise<void> {
  ensured ??= syncInstall().then(() => undefined, () => undefined);
  return ensured;
}

/**
 * The server answered 401 to this install token: it is gone (pruned or deleted). Forget it, unless
 * it has already been replaced; the next ensureInstall registers a fresh one.
 */
export async function forgetInstallToken(rejected: string): Promise<void> {
  if ((await getSettings()).installToken === rejected) await setSettings({ installToken: '' });
}
