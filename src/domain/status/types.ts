import type { StatusMetrics } from '../../storage/stats';
import type { BugReportSummary } from '../bug-report-types';

// Daily status traffic light (spec 2026-10-06-daily-status-traffic-light-design.md).
export type Colour = 'green' | 'yellow' | 'red';
export type SubsystemId = 'taps' | 'untappd' | 'orphans' | 'channels' | 'fest' | 'infra';

export interface Evaluation {
  subsystem: SubsystemId;
  colour: Colour;
  reasons: string[]; // empty exactly when colour is green
}

// A source the report could not read is a value, not an exception: the evaluator turns it into
// 🟡 "нема даних: <reason>", so a 🟢 can only be produced from inputs that were actually read.
export type Avail<T> = { ok: true; value: T } | { ok: false; reason: string };

// What one day's snapshot stores. Disk fields are null when the monitor could not be read.
export interface SnapshotMetrics extends StatusMetrics {
  diskBytesAvailable: number | null;
  inodesFree: number | null;
}

export interface SnapshotRecord {
  date: string; // Warsaw YYYY-MM-DD
  metrics: SnapshotMetrics;
}

// What the root host-patch collector reports (#469 stage 2). Times are unix seconds.
// rebootRequired null = no reboot pending; every other null = the collector could not read it.
export interface HostPatchFacts {
  timestamp: number;
  kernel: { running: string; newestInstalled: string } | null;
  rebootRequired: { since: number; packages: string[] } | null;
  livepatch: { state: 'applied' | 'nothing-to-apply' | 'unsupported-kernel' | 'unknown'; upgradeRequiredDate: string | null } | null;
  staleServices: { unit: string; since: number }[] | null;
  unattended: { lastRun: number | null; securityPending: number | null };
  packages: { nodejs: string | null; cloudflared: string | null; litestream: string | null };
}

// Cycle lengths come from the fest jobs' own constants (filled in by the collector), so the
// evaluator never duplicates a schedule.
export interface FestInputs {
  menuLastAt: string | null;
  menuCycleMs: number;
  keepaliveLastAt: string | null;
  keepaliveCycleMs: number;
}

export interface StatusInputs {
  now: Date;
  dateKey: string;                 // Warsaw date of this report
  metrics: SnapshotMetrics;        // today
  history: SnapshotRecord[];       // earlier dates only (dateKey-13 .. dateKey-1), any subset
  canary: Avail<{ ok: boolean; at: string } | null>; // value null = the canary never ran
  algoliaOpenUntil: string | null;
  profileOpenUntil: string | null;
  triage: { ranToday: boolean; line: string | null; saturated: string | null; unreadable?: boolean }; // unreadable = today's result exists but cannot be parsed
  unlock: { ranToday: boolean; withheld: { beerId: number; issueNumber: number }[] | null };  // null = today's result exists but is unreadable
  bugReports: { summary: BugReportSummary; paused: { since: string; status: number } | null; pausedUnreadable?: boolean } | null; // null = no repo configured
  disk: Avail<{ bytesAvailable: number; inodesFree: number; pendingRuns: number | null }>;
  hostPatch: Avail<HostPatchFacts>; // #469 stage 2: the root collector's summary
  upstream: HostUpstream;           // #469 stage 2: Node/litestream releases, fetched daily
  fest: FestInputs | null;         // null = no current or upcoming fest
}

// Upstream facts the host is judged against (#469 stage 2), fetched daily by jobs/host-upstream.
// Each source is its own Avail: one failing fetch must not blank the others.
export interface HostUpstream {
  nodeSecurity: Avail<{ version: string; date: string } | null>; // null = the 24.x line has no security release
  nodeEnd: Avail<string>;                                       // YYYY-MM-DD
  litestream: Avail<{ version: string; publishedAt: string }>;  // publishedAt: ISO instant
}
