// Upstream facts for the host-patch traffic light (#469 stage 2): what the Node 24 line and
// litestream have published. Public JSON, no credentials — plain fetch, like ./cws-version.
// Parsers throw on any shape they do not understand: a guessed value would read as healthy.
import { compareVersions } from './cws-version';
import { parseIsoInstant } from '../domain/status/helpers';

export const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
export const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
export const LITESTREAM_LATEST_URL = 'https://api.github.com/repos/benbjohnson/litestream/releases/latest';
const NODE_MAJOR = 24;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date, not just its shape: '2026-02-30' is refused (Date.parse would roll it over). */
export function isCalendarDay(x: unknown): x is string {
  if (typeof x !== 'string' || !DAY.test(x)) return false;
  const t = Date.parse(`${x}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === x;
}
const TAG = /^v(\d+\.\d+\.\d+)$/;
type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Newest v24.* release flagged `security`, or null when the line has none. */
export function parseNodeSecurity(json: unknown): { version: string; date: string } | null {
  if (!Array.isArray(json)) throw new Error('node index: not an array');
  const line = json.filter((r): r is Rec => isRec(r) && typeof r.version === 'string'
    && r.version.startsWith(`v${NODE_MAJOR}.`));
  if (line.length === 0) throw new Error(`node index: no v${NODE_MAJOR}.x release`);
  let best: { version: string; date: string } | null = null;
  // "No security release" is a claim about every release in the line: an absent or non-boolean
  // flag makes it unknowable, and unknown must never read as healthy.
  if (line.some((r) => typeof r.security !== 'boolean')) throw new Error('node index: release without a boolean security flag');
  // Same for the version: a record that is not vX.Y.Z makes "no security release" unprovable.
  if (line.some((r) => !TAG.test(String(r.version)))) throw new Error('node index: a v24 record is not a version');
  for (const r of line.filter((x) => x.security === true)) {
    const version = TAG.exec(String(r.version))?.[1];
    if (version === undefined || !isCalendarDay(r.date)) {
      throw new Error(`node index: malformed security release ${String(r.version)}`);
    }
    if (best === null || compareVersions(version, best.version) > 0) best = { version, date: r.date };
  }
  return best;
}

/** `v24.end` of the release schedule, YYYY-MM-DD. */
export function parseNodeEnd(json: unknown): string {
  const line = isRec(json) ? json[`v${NODE_MAJOR}`] : undefined;
  const end = isRec(line) ? line.end : undefined;
  if (!isCalendarDay(end)) throw new Error(`node schedule: no v${NODE_MAJOR}.end`);
  return end;
}

/** The latest litestream release: the tag without its `v`, and its publish instant. */
export function parseLitestreamLatest(json: unknown): { version: string; publishedAt: string } {
  if (!isRec(json) || json.draft !== false || json.prerelease !== false) {
    throw new Error('litestream latest: not a published release');
  }
  const version = typeof json.tag_name === 'string' ? TAG.exec(json.tag_name)?.[1] : undefined;
  const at = json.published_at;
  if (version === undefined || typeof at !== 'string' || !Number.isFinite(parseIsoInstant(at))) {
    throw new Error('litestream latest: malformed tag or published_at');
  }
  return { version, publishedAt: at };
}

export type FetchJson = (url: string) => Promise<unknown>;

/** GET a public JSON document; throws on a non-2xx, a timeout or a body that is not JSON. */
export function jsonFetcher(fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): FetchJson {
  return async (url) => {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // GitHub's API rejects requests without a User-Agent.
      headers: { 'User-Agent': 'warsaw-beer-bot', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
}
