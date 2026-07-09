import type { AlgoliaResponse, CheckinSyncPageResult, CheckinSyncState, EnrichCandidate, EnrichResult, MatchResponse, MatchResult, RawBeer } from './types';

export type ApiErrorCode = 'unauthorized' | 'server' | 'network' | 'not_linked' | 'blocked';

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function postMatch(
  baseUrl: string,
  token: string,
  beers: RawBeer[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<MatchResult[]> {
  let res: Response;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/match`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ beers }),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  const data = (await res.json()) as MatchResponse;
  return data.results;
}

export async function postEnrichCandidates(
  baseUrl: string,
  token: string,
  beers: { brewery: string; name: string }[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnrichCandidate[]> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/enrich/candidates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers }),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return ((await res.json()) as { candidates: EnrichCandidate[] }).candidates;
}

export async function postEnrichResult(
  baseUrl: string,
  token: string,
  payload: { brewery: string; name: string; algolia: AlgoliaResponse; pageUrl?: string },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnrichResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/enrich/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return (await res.json()) as EnrichResult;
}

export async function getCheckinSyncState(
  baseUrl: string,
  token: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CheckinSyncState> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/checkins/sync/state`, {
      headers: { Authorization: `Bearer ${token}` },
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (res.status === 409) throw new ApiError('not_linked');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return (await res.json()) as CheckinSyncState;
}

export async function postCheckinSyncPage(
  baseUrl: string,
  token: string,
  html: string,
  maxId: string | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CheckinSyncPageResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/checkins/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, maxId }),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (res.status === 409) throw new ApiError('not_linked');
  if (res.status === 502) throw new ApiError('blocked');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return (await res.json()) as CheckinSyncPageResult;
}

export async function getHealth(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${trimBase(baseUrl)}/health`, {}, timeoutMs);
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
