import { getSettings } from '../shared/config';
import { postMatch, ApiError } from '../api/client';
import type { MatchResult, RawBeer } from '../api/types';

export interface MatchMessage {
  type: 'match';
  cards: RawBeer[];
}

export type MatchReply =
  | { type: 'match:ok'; results: MatchResult[] }
  | { type: 'match:err'; code: 'unauthorized' | 'server' | 'network' | 'no-token' };

const MAX_PER_REQUEST = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function handleMatch(msg: MatchMessage): Promise<MatchReply> {
  const { token, baseUrl } = await getSettings();
  if (!token) return { type: 'match:err', code: 'no-token' };
  try {
    const results: MatchResult[] = [];
    for (const part of chunk(msg.cards, MAX_PER_REQUEST)) {
      results.push(...(await postMatch(baseUrl, token, part)));
    }
    return { type: 'match:ok', results };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'server';
    return { type: 'match:err', code };
  }
}

function isMatchMessage(x: unknown): x is MatchMessage {
  return !!x && typeof x === 'object' && (x as { type?: unknown }).type === 'match';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isMatchMessage(message)) return undefined;
  handleMatch(message).then(sendResponse);
  return true; // keep the message channel open for the async reply
});
