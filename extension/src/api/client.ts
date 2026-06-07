import type { MatchResponse, MatchResult, RawBeer } from './types';

export type ApiErrorCode = 'unauthorized' | 'server' | 'network';

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export async function postMatch(
  baseUrl: string,
  token: string,
  beers: RawBeer[],
): Promise<MatchResult[]> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(baseUrl)}/match`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers }),
    });
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  const data = (await res.json()) as MatchResponse;
  return data.results;
}

export async function getHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${trimBase(baseUrl)}/health`);
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
