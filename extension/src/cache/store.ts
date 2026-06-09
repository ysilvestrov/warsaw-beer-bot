import type { MatchResult } from '../api/types';

export const CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const PREFIX = 'mc2:';

interface Entry {
  result: MatchResult;
  expiresAt: number;
}

export async function getCached(key: string, now: number = Date.now()): Promise<MatchResult | null> {
  const storageKey = PREFIX + key;
  const got = await chrome.storage.local.get(storageKey);
  const entry = got[storageKey] as Entry | undefined;
  if (!entry || entry.expiresAt <= now) return null;
  return entry.result;
}

export async function setCached(
  key: string,
  result: MatchResult,
  now: number = Date.now(),
): Promise<void> {
  const entry: Entry = { result, expiresAt: now + CACHE_TTL_MS };
  await chrome.storage.local.set({ [PREFIX + key]: entry });
}
