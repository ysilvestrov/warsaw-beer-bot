import { getSettings } from '../shared/config';
import { postMatch, postEnrichCandidates, postEnrichResult, ApiError } from '../api/client';
import type { EnrichCandidate, EnrichResult, MatchResult, RawBeer } from '../api/types';

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

export interface EnrichFetchMessage { type: 'enrich:fetch'; url: string }
export interface EnrichCandidatesMessage { type: 'enrich:candidates'; beers: { brewery: string; name: string }[] }
export interface EnrichResultMessage { type: 'enrich:result'; brewery: string; name: string; html: string; pageUrl?: string }

const UNTAPPD_ORIGIN = 'https://untappd.com/*';

async function enrichAllowed(): Promise<boolean> {
  const { enrichEnabled } = await getSettings();
  if (!enrichEnabled) return false;
  return chrome.permissions.contains({ origins: [UNTAPPD_ORIGIN] });
}

export async function handleEnrichFetch(
  msg: EnrichFetchMessage,
): Promise<{ type: 'enrich:fetch:ok'; html: string | null }> {
  if (!(await enrichAllowed())) return { type: 'enrich:fetch:ok', html: null };
  try {
    const res = await fetch(msg.url, { credentials: 'include' });
    if (!res.ok) return { type: 'enrich:fetch:ok', html: null };
    return { type: 'enrich:fetch:ok', html: await res.text() };
  } catch {
    return { type: 'enrich:fetch:ok', html: null };
  }
}

export async function handleEnrichCandidates(
  msg: EnrichCandidatesMessage,
): Promise<{ type: 'enrich:candidates:ok'; candidates: EnrichCandidate[] }> {
  const { token, baseUrl, enrichEnabled } = await getSettings();
  if (!enrichEnabled || !token) return { type: 'enrich:candidates:ok', candidates: [] };
  try {
    return { type: 'enrich:candidates:ok', candidates: await postEnrichCandidates(baseUrl, token, msg.beers) };
  } catch {
    return { type: 'enrich:candidates:ok', candidates: [] };
  }
}

export async function handleEnrichResult(
  msg: EnrichResultMessage,
): Promise<{ type: 'enrich:result:ok'; result: EnrichResult | null }> {
  const { token, baseUrl, enrichEnabled } = await getSettings();
  if (!enrichEnabled || !token) return { type: 'enrich:result:ok', result: null };
  try {
    const result = await postEnrichResult(baseUrl, token, { brewery: msg.brewery, name: msg.name, html: msg.html, pageUrl: msg.pageUrl });
    return { type: 'enrich:result:ok', result };
  } catch {
    return { type: 'enrich:result:ok', result: null };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const t = (message as { type?: unknown }).type;
  if (t === 'match') { handleMatch(message as MatchMessage).then(sendResponse); return true; }
  if (t === 'enrich:fetch') { handleEnrichFetch(message as EnrichFetchMessage).then(sendResponse); return true; }
  if (t === 'enrich:candidates') { handleEnrichCandidates(message as EnrichCandidatesMessage).then(sendResponse); return true; }
  if (t === 'enrich:result') { handleEnrichResult(message as EnrichResultMessage).then(sendResponse); return true; }
  return undefined;
});
