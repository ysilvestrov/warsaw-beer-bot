import PQueue from 'p-queue';
import { ProxyAgent } from 'undici';

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
}

export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
  cookie?: string;
  redirect?: RequestRedirect;
  proxyUrl?: string;
}

// Webshare creds arrive as `user:pass@host:port` (no scheme). undici's
// ProxyAgent needs an absolute URL — prefix http:// when no scheme is present.
export function normalizeProxyUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 2000;
  const dispatcher = opts.proxyUrl ? new ProxyAgent(normalizeProxyUrl(opts.proxyUrl)) : undefined;
  let lastAt = 0;

  return {
    async get(url: string): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
        if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;

        const fetchOpts: RequestInit & { dispatcher?: unknown } = { headers };
        if (opts.redirect) fetchOpts.redirect = opts.redirect;
        if (dispatcher) fetchOpts.dispatcher = dispatcher;

        const res = await f(url, fetchOpts);
        lastAt = Date.now();

        // With redirect:'manual', any 3xx means the session cookie is invalid.
        // (Node fetch with redirect:'manual' returns opaque redirect responses
        // where headers are not exposed, so we use the option flag as the signal.)
        if (res.status >= 300 && res.status < 400) {
          if (opts.redirect === 'manual') throw new CookieExpiredError();
          throw new HttpError(res.status, url);
        }
        if (!res.ok) throw new HttpError(res.status, url);
        return res.text();
      }) as Promise<string>;
    },
  };
}
