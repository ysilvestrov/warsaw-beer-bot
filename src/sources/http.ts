import PQueue from 'p-queue';
import { fetch as undiciFetch } from 'undici';
import type { RotatingDispatcher } from './proxy-rotator';
import type { FetchInitLike, FetchLike, FetchResponseLike } from './fetch-like';

export { normalizeProxyUrl } from './proxy-rotator';

export class CookieExpiredError extends Error {
  constructor() {
    super('Untappd session cookie expired');
    this.name = 'CookieExpiredError';
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface HttpGetOpts {
  onRedirect?: (fromUrl: string, toUrl: string) => void;
}

export interface Http {
  get(url: string, opts?: HttpGetOpts): Promise<string>;
  /** Cumulative proxy rotations; 0 for non-proxied clients. */
  rotations?(): number;
}

export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: FetchLike;
  cookie?: string;
  redirect?: RequestRedirect;
  rotator?: RotatingDispatcher;
  isBlock?: (status: number, body: string | null) => boolean;
  /** Max rotate+retry attempts on a block before surfacing to the breaker. Default 1. */
  maxBlockRetries?: number;
  onRedirect?: (fromUrl: string, toUrl: string) => void;
}

export const MAX_REDIRECTS = 3;

export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  // #581: саме тут була поломка — глобальний `fetch` не приймає `dispatcher` з npm-undici.
  const f = opts.fetchImpl ?? undiciFetch;
  const gap = opts.minGapMs ?? 2000;
  let lastAt = 0;

  type Outcome =
    | { kind: 'ok'; body: string }
    | { kind: 'block'; reason: string; status: number }
    | { kind: 'redirect'; nextUrl: string; status: number };

  async function doFetch(url: string): Promise<FetchResponseLike> {
    const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
    if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;
    const fetchOpts: FetchInitLike = { headers };
    if (opts.redirect) fetchOpts.redirect = opts.redirect;
    const dispatcher = opts.rotator?.current();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const res = await f(url, fetchOpts);
    lastAt = Date.now();
    return res;
  }

  async function classify(url: string, res: FetchResponseLike): Promise<Outcome> {
    // Under redirect:'manual', inspect the Location header. Untappd redirects to /login
    // when session cookie expires. Other 3xx targets (e.g. venue slug changes) are safe redirects.
    if (res.status >= 300 && res.status < 400) {
      if (opts.redirect === 'manual') {
        const location = res.headers?.get('location');
        if (!location) throw new HttpError(res.status, url);
        let target: URL;
        let current: URL;
        try {
          target = new URL(location, url);
          current = new URL(url);
        } catch {
          throw new HttpError(res.status, url);
        }
        // Protect credentials: only follow HTTPS redirects on the same origin.
        if (target.protocol !== 'https:' || target.origin !== current.origin) {
          throw new HttpError(res.status, url);
        }
        if (target.pathname === '/login' || target.pathname.startsWith('/login/')) {
          throw new CookieExpiredError();
        }
        return { kind: 'redirect', nextUrl: target.href, status: res.status };
      }
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
    async get(url: string, getOpts?: HttpGetOpts): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        let currentUrl = url;
        let hops = 0;

        while (true) {
          let outcome = await classify(currentUrl, await doFetch(currentUrl));
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
              throw new HttpError(outcome.status === 429 ? 429 : 403, currentUrl);
            }
            opts.rotator!.rotate(outcome.reason);
            retries++;
            outcome = await classify(currentUrl, await doFetch(currentUrl));
          }

          if (outcome.kind === 'redirect') {
            if (hops >= MAX_REDIRECTS) {
              throw new HttpError(outcome.status, currentUrl);
            }
            currentUrl = outcome.nextUrl;
            hops++;
            continue;
          }

          if (currentUrl !== url) {
            opts.onRedirect?.(url, currentUrl);
            getOpts?.onRedirect?.(url, currentUrl);
          }

          return outcome.body;
        }
      }) as Promise<string>;
    },
  };
}
