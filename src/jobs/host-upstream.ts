import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Avail, HostUpstream } from '../domain/status/types';
import { getJobState, setJobState } from '../storage/job_state';
import { parseIsoInstant } from '../domain/status/helpers';
import {
  LITESTREAM_LATEST_URL, NODE_INDEX_URL, NODE_SCHEDULE_URL, jsonFetcher,
  parseLitestreamLatest, parseNodeEnd, parseNodeSecurity, type FetchJson,
} from '../sources/host-upstream';

// #469 stage 2: the upstream facts the host-patch rules compare against. The morning report is
// synchronous, so it never fetches; this job keeps job_state fresh and the report only reads.
export const HOST_UPSTREAM_KEY = 'host_upstream';
const HOUR = 3_600_000;
const REFRESH_MS = 20 * HOUR;   // once a day, with slack for an hourly tick
const STALE_MS = 48 * HOUR;     // two missed days → "нема даних"
const FUTURE_SKEW_MS = 60_000;

type SourceKey = keyof HostUpstream;
// `stale` agrees with `what` in gender and number: «графік … застарів», «релізи … застаріли».
const SOURCES: { key: SourceKey; url: string; parse: (json: unknown) => unknown; what: string; stale: string }[] = [
  { key: 'nodeSecurity', url: NODE_INDEX_URL, parse: parseNodeSecurity, what: 'безпекові релізи Node', stale: 'застаріли' },
  { key: 'nodeEnd', url: NODE_SCHEDULE_URL, parse: parseNodeEnd, what: 'графік підтримки Node', stale: 'застарів' },
  { key: 'litestream', url: LITESTREAM_LATEST_URL, parse: parseLitestreamLatest, what: 'релізи litestream', stale: 'застаріли' },
];
type Stored = Partial<Record<SourceKey, { value: unknown; at: string }>>;

function readStored(db: DB): Stored | undefined {
  const raw = getJobState(db, HOST_UPSTREAM_KEY);
  if (raw === null) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Stored) : undefined;
  } catch {
    return undefined;
  }
}

export interface HostUpstreamDeps {
  db: DB;
  log: pino.Logger;
  now?: () => Date;
  fetchJson?: FetchJson;
}

// Hourly tick: each source is fetched when its last success is ≥ 20 h old; a failure keeps the
// previous value (its own `at` ages it into "нема даних") and is retried on the next tick.
export async function hostUpstream(deps: HostUpstreamDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const fetchJson = deps.fetchJson ?? jsonFetcher();
  const next: Stored = { ...(readStored(deps.db) ?? {}) };
  for (const s of SOURCES) {
    const at = next[s.key] ? parseIsoInstant(next[s.key]!.at) : Number.NaN;
    if (Number.isFinite(at) && now.getTime() - at < REFRESH_MS) continue;
    try {
      next[s.key] = { value: s.parse(await fetchJson(s.url)), at: now.toISOString() };
    } catch (e) {
      deps.log.warn({ err: e, url: s.url }, 'host-upstream: fetch failed, keeping the previous value');
    }
  }
  setJobState(deps.db, HOST_UPSTREAM_KEY, JSON.stringify(next));
}

// Each source is validated again on read by its own parser's output shape: a stored value is a
// claim, and a corrupted one must read as "нема даних", never as healthy.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VER = /^\d+\.\d+\.\d+$/;
const VALID: Record<SourceKey, (v: unknown) => boolean> = {
  nodeSecurity: (v) => v === null || (typeof v === 'object' && v !== null
    && VER.test(String((v as Record<string, unknown>).version)) && DAY.test(String((v as Record<string, unknown>).date))),
  nodeEnd: (v) => typeof v === 'string' && DAY.test(v),
  litestream: (v) => typeof v === 'object' && v !== null
    && VER.test(String((v as Record<string, unknown>).version))
    && Number.isFinite(parseIsoInstant(String((v as Record<string, unknown>).publishedAt))),
};

export function readHostUpstream(db: DB, now: Date): HostUpstream {
  const stored = readStored(db);
  const one = <K extends SourceKey>(key: K): HostUpstream[K] => {
    const { what, stale } = SOURCES.find((s) => s.key === key)!;
    if (stored === undefined) return { ok: false, reason: `${what}: збережений стан пошкоджено` } as HostUpstream[K];
    const entry = stored[key];
    if (entry === undefined) return { ok: false, reason: `${what} ще не завантажено` } as HostUpstream[K];
    const at = typeof entry === 'object' && entry !== null ? parseIsoInstant(String(entry.at)) : Number.NaN;
    if (!Number.isFinite(at) || at > now.getTime() + FUTURE_SKEW_MS || !VALID[key](entry.value)) {
      return { ok: false, reason: `${what}: збережений стан пошкоджено` } as HostUpstream[K];
    }
    if (now.getTime() - at > STALE_MS) return { ok: false, reason: `${what} ${stale} (понад 48 год)` } as HostUpstream[K];
    return { ok: true, value: entry.value } as Avail<never> as HostUpstream[K];
  };
  return {
    nodeSecurity: one('nodeSecurity'),
    nodeEnd: one('nodeEnd'),
    litestream: one('litestream'),
  };
}
