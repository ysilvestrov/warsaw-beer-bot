import { createCircuitBreaker } from './untappd-circuit';

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
