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
  triage: { ranToday: boolean; line: string | null; saturated: string | null };
  unlock: { ranToday: boolean; withheld: { beerId: number; issueNumber: number }[] };
  bugReports: { summary: BugReportSummary; paused: { since: string; status: number } | null } | null; // null = no repo configured
  disk: Avail<{ bytesAvailable: number; inodesFree: number; pendingRuns: number | null }>;
  fest: FestInputs | null;         // null = no current or upcoming fest
}
