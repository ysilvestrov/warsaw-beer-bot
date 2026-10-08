import type { HostPatchFacts, HostUpstream, SnapshotMetrics, SnapshotRecord, StatusInputs } from './types';
import { GIB_BYTES } from './rules';
import { shiftDate } from './helpers';

// Shared fixture for the status tests: every value is inside every threshold, so a test that
// overrides one field sees exactly that field's rule fire.
export const NOW = new Date('2026-10-06T07:00:00.000Z');
export const DATE = '2026-10-06';

export const GREEN_METRICS: SnapshotMetrics = {
  lastScrapeHoursAgo: 6.9, pubsScraped24h: 115, beersTotal: 30_000, beersMatched: 25_000,
  orphansPending: 400, orphansRelayQueue: 900, ratingsMissing: 100, ratingsChecked30d: 20_000,
  snapshots: 2_000, taps: 50_000, dbSizeMb: 300, usersTotal: 10, usersLinked: 6,
  onTapDistinct: 900, onTapPubs: 110, newOnTap24h: 30, enrichMatched24h: 10, enrichFailures24h: 20,
  untappdSearchHealthy: true, extMatchRequests: 3, extMatchAnon: 1, extMatchBeers: 200,
  mcpMatchRequests: 0, mcpMatchBeers: 0, sealUnidentifiable: 50, sealUnidentifiableReobserved: 10,
  sealNotABeer: 30, sealNotABeer7d: 1, sealRetiredFalsified: 2, lockedRows: 40, unlocked7d: 1,
  verdictsOutlived7d: 0, unrescuedRows: 3, unlockedUnadjudicated7d: 0,
  diskBytesAvailable: 32 * GIB_BYTES, inodesFree: 2_000_000,
};

const T = NOW.getTime() / 1000;
export const GREEN_HOST_PATCH: HostPatchFacts = {
  timestamp: T - 600,
  kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-142-generic' },
  rebootRequired: null,
  livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
  staleServices: [{ unit: 'code-server@ysi.service', since: T - 30 * 86_400 }],
  unattended: { lastRun: T - 3600, securityPending: 0 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' },
};
export const GREEN_UPSTREAM: HostUpstream = {
  nodeSecurity: { ok: true, value: { version: '24.18.1', date: '2026-07-28' } },
  nodeEnd: { ok: true, value: '2028-04-30' },
  litestream: { ok: true, value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' } },
};

export function greenInputs(overrides: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW,
    dateKey: DATE,
    metrics: GREEN_METRICS,
    history: [],
    canary: { ok: true, value: { ok: true, at: '2026-10-06T06:30:00.000Z' } },
    algoliaOpenUntil: null,
    profileOpenUntil: null,
    triage: { ranToday: true, line: 'Тріаж: 7 рядків', saturated: null },
    unlock: { ranToday: true, withheld: [] },
    bugReports: null,
    disk: { ok: true, value: { bytesAvailable: 32 * GIB_BYTES, inodesFree: 2_000_000, pendingRuns: 0 } },
    hostPatch: { ok: true, value: GREEN_HOST_PATCH },
    upstream: GREEN_UPSTREAM,
    fest: null,
    ...overrides,
  };
}

// Snapshots for DATE-1 .. DATE-n, each GREEN_METRICS with `patch` applied.
export function pastDays(n: number, patch: Partial<SnapshotMetrics> = {}): SnapshotRecord[] {
  return Array.from({ length: n }, (_, k) => ({
    date: shiftDate(DATE, -(k + 1)),
    metrics: { ...GREEN_METRICS, ...patch },
  }));
}
