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

export async function clearKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await chrome.storage.local.remove(keys.map((k) => PREFIX + k));
}

async function ourKeys(): Promise<string[]> {
  const all = await chrome.storage.local.get();
  return Object.keys(all).filter((k) => k.startsWith(PREFIX));
}

/** How many cached match results are stored, without touching them (#517). */
export async function countAll(): Promise<number> {
  return (await ourKeys()).length;
}

/** Removes every cached match result and reports how many went (#517). */
export async function clearAll(): Promise<number> {
  const ours = await ourKeys();
  if (ours.length > 0) await chrome.storage.local.remove(ours);
  return ours.length;
}
