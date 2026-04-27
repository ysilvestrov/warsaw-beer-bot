import { buildRoute, createOsrmTable, haversineMeters } from './router';

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

describe('createOsrmTable', () => {
  test('builds the /table URL with lon,lat ordering and parses N×N matrix', async () => {
    let captured = '';
    const fetchImpl = (async (url: string) => {
      captured = url;
      return {
        ok: true,
        json: async () => ({ distances: [[0, 100], [100, 0]] }),
      };
    }) as unknown as typeof fetch;

    const table = createOsrmTable('http://osrm', fetchImpl);
    const m = await table([[52.0, 21.0], [52.1, 21.1]]);

    expect(captured).toBe('http://osrm/table/v1/foot/21,52;21.1,52.1?annotations=distance');
    expect(m).toEqual([[0, 100], [100, 0]]);
  });

  test('falls back to haversine for null cells', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ distances: [[0, null], [null, 0]] }),
    })) as unknown as typeof fetch;

    const table = createOsrmTable('http://osrm', fetchImpl);
    const m = await table([[52.0, 21.0], [52.1, 21.0]]);

    expect(m[0][1]).toBeGreaterThan(0);
    expect(m[1][0]).toBe(m[0][1]);
  });

  test('throws on non-OK response so caller can fall back per-pair', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch;
    const table = createOsrmTable('http://osrm', fetchImpl);
    await expect(table([[0, 0], [1, 1]])).rejects.toThrow(/OSRM \/table HTTP 502/);
  });
});
