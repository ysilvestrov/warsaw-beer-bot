// SQLite can return SQLITE_BUSY when a concurrent writer (here: the litestream
// replication process running a WAL checkpoint) holds the lock longer than the
// connection's busy_timeout. better-sqlite3 is synchronous, so we retry the
// whole operation with an async backoff that yields the event loop — giving the
// checkpoint time to finish before the next attempt. Safe because callers wrap
// idempotent work (upsertBeer/mergeCheckin key off UNIQUE columns).

export function isBusyError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'SQLITE_BUSY'
  );
}

interface Options {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withBusyRetry<T>(fn: () => T, opts: Options = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e)) throw e;
      lastError = e;
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastError;
}
