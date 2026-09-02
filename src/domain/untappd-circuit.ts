import type { DB } from '../storage/db';
import { deleteJobState, getJobState, setJobState } from '../storage/job_state';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreaker {
  canAttempt(now: Date): boolean;
  onResult(blocked: boolean, now: Date): void;
  readonly state: CircuitState;
}

export interface CircuitOptions {
  cooldownMs: number;
  onTrip: () => void;
  onRecover: () => void;
  blockThreshold?: number; // consecutive blocks before tripping; default 1
}

export interface PersistentCircuitOptions extends CircuitOptions {
  db: DB;
  key: string;
}

export function createCircuitBreaker(opts: CircuitOptions): CircuitBreaker {
  let state: CircuitState = 'closed';
  let openedAt = 0;
  const threshold = opts.blockThreshold ?? 1;
  let consecutiveBlocks = 0;

  return {
    get state() { return state; },
    canAttempt(now: Date): boolean {
      if (state === 'open' && now.getTime() - openedAt >= opts.cooldownMs) {
        state = 'half_open';
      }
      return state !== 'open';
    },
    onResult(blocked: boolean, now: Date): void {
      if (blocked) {
        consecutiveBlocks++;
        if (state === 'half_open' || consecutiveBlocks >= threshold) {
          if (state === 'closed') opts.onTrip();
          state = 'open';
          openedAt = now.getTime();
        }
      } else {
        if (state !== 'closed') opts.onRecover();
        state = 'closed';
        openedAt = 0;
        consecutiveBlocks = 0;
      }
    },
  };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// #576 I1: a genuinely read-only check, for callers (the adjudicate probe) that must consult the
// shared circuit without being able to mutate it. `createPersistentCircuitBreaker.canAttempt` is
// NOT that: it calls `deleteJobState` on a malformed value and again on an expired one, so a tool
// wired to it can trip `job_state` clean on a read alone (found live on #576's own runner: an
// expired `untappd_circuit_open_until` was gone after one probe run, though nothing in that tool
// ever calls `onResult`). This function reads `job_state`, parses with the exact same
// `parseTimestamp`, and deletes nothing — an expired or malformed entry is simply treated as
// "not open" and left on disk for whichever writer (a cron's `onResult`) actually owns it.
export function isCircuitOpen(db: DB, key: string, now: Date): boolean {
  const openUntil = parseTimestamp(getJobState(db, key));
  return openUntil != null && openUntil > now.getTime();
}

export function createPersistentCircuitBreaker(opts: PersistentCircuitOptions): CircuitBreaker {
  let state: CircuitState = 'closed';
  let openedAt = 0;
  const threshold = opts.blockThreshold ?? 1;
  let consecutiveBlocks = 0;

  return {
    get state() { return state; },
    canAttempt(now: Date): boolean {
      const persisted = getJobState(opts.db, opts.key);
      const openUntil = parseTimestamp(persisted);
      if (persisted && openUntil == null) {
        deleteJobState(opts.db, opts.key);
      }
      if (openUntil != null) {
        if (openUntil > now.getTime()) {
          state = 'open';
          openedAt = openUntil - opts.cooldownMs;
          return false;
        }
        deleteJobState(opts.db, opts.key);
        state = 'half_open';
        openedAt = openUntil - opts.cooldownMs;
        return true;
      }

      if (state === 'open' && now.getTime() - openedAt >= opts.cooldownMs) {
        state = 'half_open';
      }
      return state !== 'open';
    },
    onResult(blocked: boolean, now: Date): void {
      if (blocked) {
        consecutiveBlocks++;
        if (state === 'half_open' || consecutiveBlocks >= threshold) {
          if (state === 'closed') opts.onTrip();
          state = 'open';
          openedAt = now.getTime();
          setJobState(opts.db, opts.key, new Date(now.getTime() + opts.cooldownMs).toISOString());
        }
      } else {
        if (state !== 'closed') opts.onRecover();
        state = 'closed';
        openedAt = 0;
        consecutiveBlocks = 0;
        deleteJobState(opts.db, opts.key);
      }
    },
  };
}

// No-op breaker: always attempts, never alerts. Default when a job is called
// without a breaker (existing tests / non-gated callers).
export const noopBreaker: CircuitBreaker = {
  canAttempt: () => true,
  onResult: () => {},
  state: 'closed',
};
