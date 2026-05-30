import PQueue from 'p-queue';

export class CookieExpiredError extends Error {
  constructor() {
    super('Untappd session cookie expired');
    this.name = 'CookieExpiredError';
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
}

export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 2000;
  let lastAt = 0;

  return {
    async get(url: string): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
        if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;

        const fetchOpts: RequestInit = { headers };
        if (opts.redirect) fetchOpts.redirect = opts.redirect;

        const res = await f(url, fetchOpts);
        lastAt = Date.now();

        // With redirect:'manual', any 3xx means the session cookie is invalid.
        // (Node fetch with redirect:'manual' returns opaque redirect responses
        // where headers are not exposed, so we use the option flag as the signal.)
        if (res.status >= 300 && res.status < 400) {
          if (opts.redirect === 'manual') throw new CookieExpiredError();
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
      }) as Promise<string>;
    },
  };
}
