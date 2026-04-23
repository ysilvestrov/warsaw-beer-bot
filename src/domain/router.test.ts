import { buildRoute, haversineMeters } from './router';

const pubs = [
  { id: 1, lat: 0, lon: 0,    interesting: new Set([10, 11]) },
  { id: 2, lat: 0, lon: 0.01, interesting: new Set([12]) },
  { id: 3, lat: 0, lon: 0.02, interesting: new Set([13, 14]) },
  { id: 4, lat: 1, lon: 1,    interesting: new Set([10, 11, 12, 13, 14]) },
];

test('prefers single far pub when it covers everything with smaller tour', () => {
  const r = buildRoute(pubs, 5, { distance: haversineMeters });
  expect(r.pubIds).toEqual([4]);
  expect(r.coveredCount).toBeGreaterThanOrEqual(5);
});

test('handles partial coverage when N > union', () => {
  const r = buildRoute(pubs.slice(0, 3), 10, { distance: haversineMeters });
  expect(r.coveredCount).toBe(5);
});
