// Retry classification for jobs whose idempotency key must NOT be consumed by a
// blip (#316). Transient = the upstream might succeed on the next tick; anything
// we do not recognise is treated as permanent, because retrying is not free
// (orphan-triage re-runs up to 120 Untappd probes plus a 50-orphan LLM call).

// HTTP statuses worth another attempt: 408 request timeout, 429 rate limit,
// and every 5xx.
function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// Network-level failure names: the Anthropic SDK's connection errors plus the
// standard abort/timeout names used by fetch and AbortSignal.
const NETWORK_ERROR_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'AbortError',
  'TimeoutError',
]);

/** HTTP failure raised by our own fetch-based clients, carrying the status so
 * isTransient() does not have to parse the message text. */
export class RetriableError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RetriableError';
    this.status = status;
  }
}

export function isTransient(e: unknown): boolean {
  if (e instanceof RetriableError) return true;
  if (typeof e !== 'object' || e === null) return false;
  // Duck-typed `status` covers the Anthropic SDK's APIError without importing it.
  const { status, name, cause } = e as { status?: unknown; name?: unknown; cause?: unknown };
  if (typeof status === 'number' && isRetriableStatus(status)) return true;
  if (typeof name === 'string' && NETWORK_ERROR_NAMES.has(name)) return true;
  // undici reports a dropped connection as TypeError('fetch failed') + cause.
  return e instanceof TypeError && cause !== undefined && cause !== null;
}
