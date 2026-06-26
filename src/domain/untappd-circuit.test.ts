import { createCircuitBreaker, createPersistentCircuitBreaker } from './untappd-circuit';
import { getJobState, setJobState } from '../storage/job_state';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';

function mk() {
  const events: string[] = [];
  const cb = createCircuitBreaker({
    cooldownMs: 6 * 3600_000,
    onTrip: () => events.push('trip'),
    onRecover: () => events.push('recover'),
  });
  return { cb, events };
}
const T0 = new Date('2026-06-04T00:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);
const KEY = 'untappd_circuit_open_until';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function persistent(db = freshDb()) {
  const events: string[] = [];
  const cb = createPersistentCircuitBreaker({
    db,
    key: KEY,
    cooldownMs: 6 * 3600_000,
    onTrip: () => events.push('trip'),
    onRecover: () => events.push('recover'),
  });
  return { cb, db, events };
}

test('trips on block: open, canAttempt false within cooldown, single onTrip', () => {
  const { cb, events } = mk();
  expect(cb.canAttempt(at(0))).toBe(true);
  cb.onResult(true, at(0));
  expect(cb.state).toBe('open');
  expect(cb.canAttempt(at(1))).toBe(false);
  expect(events).toEqual(['trip']);
});

test('promotes to half_open after cooldown and recovers on probe success', () => {
  const { cb, events } = mk();
  cb.onResult(true, at(0));
  expect(cb.canAttempt(at(6))).toBe(true);
  expect(cb.state).toBe('half_open');
  cb.onResult(false, at(6));
  expect(cb.state).toBe('closed');
  expect(events).toEqual(['trip', 'recover']);
});

test('failed probe re-opens without a second trip alert', () => {
  const { cb, events } = mk();
  cb.onResult(true, at(0));
  cb.canAttempt(at(6));        // → half_open
  cb.onResult(true, at(6));    // re-open, no trip
  expect(cb.state).toBe('open');
  expect(events).toEqual(['trip']);
  expect(cb.canAttempt(at(7))).toBe(false); // cooldown restarted at 6h
});

test('success while closed is a no-op (no recover)', () => {
  const { cb, events } = mk();
  cb.onResult(false, at(0));
  expect(cb.state).toBe('closed');
  expect(events).toEqual([]);
});

test('persistent circuit: block writes open_until', () => {
  const { cb, db, events } = persistent();

  cb.onResult(true, at(0));

  expect(cb.state).toBe('open');
  expect(getJobState(db, KEY)).toBe('2026-06-04T06:00:00.000Z');
  expect(events).toEqual(['trip']);
});

test('persistent circuit: new breaker skips while persisted open_until is future', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(1))).toBe(false);

  expect(cb.state).toBe('open');
  expect(getJobState(db, KEY)).toBe('2026-06-04T06:00:00.000Z');
  expect(events).toEqual([]);
});

test('persistent circuit: expired open_until allows half-open probe and clears key', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(6))).toBe(true);

  expect(cb.state).toBe('half_open');
  expect(getJobState(db, KEY)).toBeNull();
  expect(events).toEqual([]);
});

test('persistent circuit: successful half-open probe clears key and emits recovery once', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(6))).toBe(true);
  cb.onResult(false, at(6));

  expect(cb.state).toBe('closed');
  expect(getJobState(db, KEY)).toBeNull();
  expect(events).toEqual(['recover']);
});

test('persistent circuit: malformed open_until is cleared and does not block', () => {
  const db = freshDb();
  setJobState(db, KEY, 'not-a-date');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(1))).toBe(true);

  expect(cb.state).toBe('closed');
  expect(getJobState(db, KEY)).toBeNull();
  expect(events).toEqual([]);
});

test('persistent circuit: failed half-open probe reopens and writes a new open_until without trip alert', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(6))).toBe(true);
  cb.onResult(true, at(6));

  expect(cb.state).toBe('open');
  expect(getJobState(db, KEY)).toBe('2026-06-04T12:00:00.000Z');
  expect(events).toEqual([]);
});

describe('blockThreshold', () => {
  const now = new Date('2026-06-26T00:00:00Z');
  function make(threshold: number, onTrip = () => {}) {
    return createCircuitBreaker({ cooldownMs: 3600_000, onTrip, onRecover: () => {}, blockThreshold: threshold });
  }

  test('default threshold 1 trips on the first block', () => {
    const b = createCircuitBreaker({ cooldownMs: 3600_000, onTrip: () => {}, onRecover: () => {} });
    b.onResult(true, now);
    expect(b.state).toBe('open');
  });

  test('threshold 3 stays closed for the first two blocks, opens on the third', () => {
    const b = make(3);
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('open');
  });

  test('a success resets the consecutive-block counter', () => {
    const b = make(3);
    b.onResult(true, now);
    b.onResult(true, now);
    b.onResult(false, now);   // reset
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('closed');
    b.onResult(true, now); expect(b.state).toBe('open');
  });

  test('onTrip fires once, only on the closed→open transition', () => {
    let trips = 0;
    const b = make(2, () => { trips++; });
    b.onResult(true, now);
    b.onResult(true, now);   // opens here
    expect(trips).toBe(1);
  });

  test('half_open re-opens on a single block regardless of threshold', () => {
    const b = make(3);
    b.onResult(true, now); b.onResult(true, now); b.onResult(true, now); // open
    const later = new Date(now.getTime() + 3600_000);
    expect(b.canAttempt(later)).toBe(true); // half_open
    b.onResult(true, later);
    expect(b.state).toBe('open');
  });
});
