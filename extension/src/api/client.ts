import type { MatchResponse, MatchResult, RawBeer } from './types';

export type ApiErrorCode = 'unauthorized' | 'server' | 'network';

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
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/match`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
