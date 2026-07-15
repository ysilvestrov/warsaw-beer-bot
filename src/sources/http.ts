import PQueue from 'p-queue';
import type { RotatingDispatcher } from './proxy-rotator';

export { normalizeProxyUrl } from './proxy-rotator';

export class CookieExpiredError extends Error {
  constructor() {
    super('Untappd session cookie expired');
    this.name = 'CookieExpiredError';
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface Http {
  get(url: string): Promise<string>;
  /** Cumulative proxy rotations; 0 for non-proxied clients. */
  rotations?(): number;
}

export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
  cookie?: string;
  redirect?: RequestRedirect;
  rotator?: RotatingDispatcher;
  isBlock?: (status: number, body: string | null) => boolean;
  /** Max rotate+retry attempts on a block before surfacing to the breaker. Default 1. */
  maxBlockRetries?: number;
}

export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 2000;
  let lastAt = 0;

  type Outcome =
    | { kind: 'ok'; body: string }
    | { kind: 'block'; reason: string; status: number };

  async function doFetch(url: string): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
    if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;
    const fetchOpts: RequestInit & { dispatcher?: unknown } = { headers };
    if (opts.redirect) fetchOpts.redirect = opts.redirect;
    const dispatcher = opts.rotator?.current();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const res = await f(url, fetchOpts);
    lastAt = Date.now();
    return res;
  }

  async function classify(url: string, res: Response): Promise<Outcome> {
    // With redirect:'manual', any 3xx means the session cookie is invalid — an
    // auth problem, never an IP block (so it must not trigger rotation).
    if (res.status >= 300 && res.status < 400) {
      if (opts.redirect === 'manual') throw new CookieExpiredError();
      throw new HttpError(res.status, url);
    }
    if (!res.ok) {
      if (opts.rotator && opts.isBlock?.(res.status, null)) {
        return { kind: 'block', reason: 'block-status', status: res.status };
      }
      throw new HttpError(res.status, url);
    }
    const body = await res.text();
    if (opts.rotator && opts.isBlock?.(res.status, body)) {
      return { kind: 'block', reason: 'block-page', status: res.status };
    }
    return { kind: 'ok', body };
  }

  return {
    rotations: () => opts.rotator?.rotations() ?? 0,
    async get(url: string): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        let outcome = await classify(url, await doFetch(url));
        // Rotate to a fresh exit IP and retry, up to maxBlockRetries (default 1).
        // Untappd HTML pages sit behind a Cloudflare Managed Challenge that ~1/3 of
        // residential exit IPs pass, so retrying through fresh IPs beats the lottery.
        // safe: classify() only returns 'block' when opts.rotator is truthy. Retries
        // use a fresh IP each time, so no extra throttle gap is applied.
        const budget = opts.maxBlockRetries ?? 1;
        let retries = 0;
        while (outcome.kind === 'block') {
          if (retries >= budget) {
            // Surface a status the jobs' isBlockStatus() recognises (403/429) so a
            // systemic block — including a 200 Cloudflare challenge page — reaches
            // the circuit breaker. outcome.status may be 200 for a block page.
            throw new HttpError(outcome.status === 429 ? 429 : 403, url);
          }
          opts.rotator!.rotate(outcome.reason);
          retries++;
          outcome = await classify(url, await doFetch(url));
        }
        return outcome.body;
      }) as Promise<string>;
    },
  };
}
