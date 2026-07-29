// Retry classification for jobs whose idempotency key must NOT be consumed by a
// blip (#316). Transient = the upstream might succeed on the next tick; anything
// we do not recognise is treated as permanent, because retrying is not free
// (orphan-triage re-runs its whole probe budget and up to two LLM calls per
// attempt — see TRIAGE_MAX_ATTEMPTS for the exact accounting).

// HTTP statuses worth another attempt: 408 request timeout, 429 rate limit,
// and every 5xx.
function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// Network-level failure names: the Anthropic SDK's connection errors (matched
// via `constructor.name`, since the SDK never sets `e.name` — see isTransient)
// plus the standard abort/timeout names used by fetch and AbortSignal (matched
// via `e.name`).
const NETWORK_ERROR_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'AbortError',
  'TimeoutError',
]);

/** Non-2xx response from one of our fetch-based clients, carrying the status so
 * isTransient() does not have to parse the message text. Being an HttpStatusError
 * says nothing about retriability — the status decides. Distinct from (and
 * unrelated to) src/sources/http.ts's own `HttpError`, which carries the same
 * kind of numeric `status` — isTransient() classifies it correctly too, via the
 * same duck-typed check below. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

export function isTransient(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // Duck-typed `status` covers our own HttpStatusError, src/sources/http.ts's
  // HttpError, and the Anthropic SDK's APIError, without importing the SDK.
  const { status, name, cause, constructor } = e as {
    status?: unknown; name?: unknown; cause?: unknown; constructor?: unknown;
  };
  if (typeof status === 'number' && isRetriableStatus(status)) return true;
  // The Anthropic SDK leaves `name` as 'Error' on every error it throws, so the
  // class identity only shows up in the constructor name. Checking both keeps
  // plain `err.name = 'AbortError'` (fetch/AbortSignal) working too.
  const ctorName = typeof constructor === 'function' ? constructor.name : undefined;
  if (typeof name === 'string' && NETWORK_ERROR_NAMES.has(name)) return true;
  if (ctorName !== undefined && NETWORK_ERROR_NAMES.has(ctorName)) return true;
  // undici reports a dropped connection as TypeError('fetch failed') + cause.
  return e instanceof TypeError && cause !== undefined && cause !== null;
}
