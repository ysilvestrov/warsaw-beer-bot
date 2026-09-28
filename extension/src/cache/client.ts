import type { MatchResult } from '../api/types';

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (reply: T) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(reply);
  }));
}

export async function setCached(key: string, result: MatchResult): Promise<void> {
  const reply = await send<{ ok: boolean }>({ type: 'cache:set', key, result });
  if (!reply?.ok) throw new Error('Cache write failed');
}

export async function setCachedMany(entries: { key: string; result: MatchResult }[]): Promise<void> {
  const reply = await send<{ ok: boolean }>({ type: 'cache:set-many', entries });
  if (!reply?.ok) throw new Error('Cache write failed');
}

export async function clearKeys(keys: string[]): Promise<void> {
  const reply = await send<{ ok: boolean }>({ type: 'cache:clear-keys', keys });
  if (!reply?.ok) throw new Error('Cache clear failed');
}

export async function clearAll(): Promise<number> {
  const reply = await send<{ ok: boolean; count?: number }>({ type: 'cache:clear-all' });
  if (!reply?.ok || typeof reply.count !== 'number') throw new Error('Cache clear failed');
  return reply.count;
}

export async function setCachedIfMatching(
  key: string, expected: MatchResult, result: MatchResult,
): Promise<boolean> {
  return (await send<{ written: boolean }>({ type: 'cache:set-if-matching', key, expected, result })).written;
}

export async function getCachedMany(keys: string[]): Promise<(MatchResult | null)[]> {
  try {
    const reply = await send<{ results: (MatchResult | null)[] }>({ type: 'cache:get-many', keys });
    return reply?.results?.length === keys.length ? reply.results : keys.map(() => null);
  } catch {
    return keys.map(() => null);
  }
}

export async function getCached(key: string): Promise<MatchResult | null> {
  return (await getCachedMany([key]))[0] ?? null;
}
