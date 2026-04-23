import PQueue from 'p-queue';

export interface Http {
  get(url: string): Promise<string>;
}

export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
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
        const res = await f(url, { headers: { 'User-Agent': opts.userAgent } });
        lastAt = Date.now();
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
      }) as Promise<string>;
    },
  };
}
