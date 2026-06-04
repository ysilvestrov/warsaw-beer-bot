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
}

export function createCircuitBreaker(opts: CircuitOptions): CircuitBreaker {
  let state: CircuitState = 'closed';
  let openedAt = 0;

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
        if (state === 'closed') opts.onTrip();
        state = 'open';
        openedAt = now.getTime();
      } else {
        if (state !== 'closed') opts.onRecover();
        state = 'closed';
        openedAt = 0;
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
