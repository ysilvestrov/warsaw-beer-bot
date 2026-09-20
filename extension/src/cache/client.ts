import type { MatchResult } from '../api/types';

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (reply: T) => resolve(reply)));
}

export async function setCached(key: string, result: MatchResult): Promise<void> {
  await send({ type: 'cache:set', key, result });
}

export async function clearKeys(keys: string[]): Promise<void> {
  await send({ type: 'cache:clear-keys', keys });
}

export async function clearAll(): Promise<number> {
  return (await send<{ count: number }>({ type: 'cache:clear-all' })).count;
}

export async function setCachedIfMatching(
  key: string, expected: MatchResult, result: MatchResult,
): Promise<boolean> {
  return (await send<{ written: boolean }>({ type: 'cache:set-if-matching', key, expected, result })).written;
}
