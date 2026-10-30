import type { AlgoliaResponse, CheckinSyncPageResult, CheckinSyncState, EnrichCandidate, EnrichResult, MatchResponse, MatchResult, RawBeer } from './types';

export type ApiErrorCode = 'unauthorized' | 'server' | 'network' | 'not_linked' | 'blocked' | 'no_session' | 'account_changed' | 'sync_context_required' | 'feed_unavailable' | 'page_rejected';

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
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

/** #923: who is asking, for the server's per-install accounting. Never identifies a person. */
export interface MatchClient { version: string; shop?: string }

export async function postMatch(
  baseUrl: string,
  token: string,
  beers: RawBeer[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  client?: MatchClient,
): Promise<MatchResult[]> {
  let res: Response;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/match`, {
      method: 'POST',
      headers,
      body: JSON.stringify(client ? { beers, client } : { beers }),
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
  // #384: `bid` is the Untappd id the shop publishes on its own product page. The server
  // needs it here to see that a stored link is contradicted; the slug/brand it verifies
  // against are only sent with the result.
  beers: { brewery: string; name: string; abv?: number; style?: string; bid?: number }[],
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
  payload: {
    brewery: string;
    name: string;
    algolia: AlgoliaResponse;
    abv?: number;
    style?: string;
    // #384: the identity the shop publishes for this product, and the brand it publishes
    // it next to — the server's guard verifies one against the other before overriding.
    bid?: number;
    bidSlug?: string;
    brand?: string;
    /** #391: the ladder rung whose response `algolia` holds — the server records it as the failure search_url. */
    query?: string;
    pageUrl?: string;
  },
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
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  linkRevision?: number,
): Promise<CheckinSyncPageResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/checkins/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, maxId, linkRevision }),
      signal,
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (res.status === 409) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    const code = body?.error;
    if (code === 'not_linked' || code === 'account_changed' || code === 'sync_context_required') {
      throw new ApiError(code);
    }
    throw new ApiError('server');
  }
  if (res.status === 502) throw new ApiError('blocked');
  // #587: 422 контрадикторить наші власні дані (порожня сторінка вище найстарішого
  // check-in'у, що ми маємо) — сесія Untappd мертва, а не дно стрічки.
  if (res.status === 422) throw new ApiError('no_session');
  // #846: сервер відхилив сторінку як не той фрагмент, який просили. Це не збій з'єднання
  // й не токен, тож має власний код; будь-який інший 400 лишається 'server'.
  if (res.status === 400) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(body?.error === 'bad_cursor' ? 'page_rejected' : 'server', 'status 400');
  }
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return (await res.json()) as CheckinSyncPageResult;
}

/** #923: registers this install and returns its token. Any refusal (429 cap, 5xx) is 'server'. */
export async function postInstall(
  baseUrl: string,
  version: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/installs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status !== 201) throw new ApiError('server', `status ${res.status}`);
  const data = (await res.json()) as { token?: unknown };
  if (typeof data.token !== 'string' || !data.token) throw new ApiError('server', 'no token');
  return data.token;
}

/**
 * #923: deletes this install on the server. 401 means the server no longer knows the token —
 * there is nothing left to delete, so it counts as done. Anything else is retried later.
 */
export async function deleteInstall(
  baseUrl: string,
  token: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<'deleted' | 'retry'> {
  try {
    const res = await fetchWithTimeout(`${trimBase(baseUrl)}/installs/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }, timeoutMs);
    return res.status === 204 || res.status === 401 ? 'deleted' : 'retry';
  } catch {
    return 'retry';
  }
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
