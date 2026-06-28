import { ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';

// Webshare creds arrive as `user:pass@host:port` (no scheme). undici's
// ProxyAgent needs an absolute URL — prefix http:// when no scheme is present.
export function normalizeProxyUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

export type RotateMode = 'per-request' | 'on-block';

export interface RotatingDispatcher {
  /** The dispatcher to use for the next request. */
  current(): Dispatcher;
  /** Drop the current exit IP and count it; the next current() opens a fresh tunnel. */
  rotate(reason: string): void;
  /** Number of rotations so far (for the `rotated` metric). */
  rotations(): number;
  /** Close the current agent (shutdown). */
  close(): void;
}

export interface RotatingDispatcherOpts {
  proxyUrl: string;
  mode: RotateMode;
  onRotate?: (reason: string) => void;
  agentFactory?: (url: string) => Dispatcher;
}

export function createRotatingDispatcher(opts: RotatingDispatcherOpts): RotatingDispatcher {
  const make = opts.agentFactory ?? ((url: string) => new ProxyAgent(url));
  const url = normalizeProxyUrl(opts.proxyUrl);
  let agent: Dispatcher | null = null;
  let count = 0;

  // Best-effort, fire-and-forget. Safe to close eagerly: callers run requests
  // serially (PQueue concurrency 1), so a replaced agent has no in-flight work.
  function closeAgent(a: Dispatcher | null): void {
    if (a) Promise.resolve(a.close()).catch(() => {});
  }

  return {
    current(): Dispatcher {
      if (opts.mode === 'per-request') {
        closeAgent(agent);
        agent = make(url);
        return agent;
      }
      if (!agent) agent = make(url);
      return agent;
    },
    rotate(reason: string): void {
      closeAgent(agent);
      agent = null;
      count++;
      opts.onRotate?.(reason);
    },
    rotations(): number {
      return count;
    },
    close(): void {
      closeAgent(agent);
      agent = null;
    },
  };
}
