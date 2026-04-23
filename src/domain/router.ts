export interface RoutePub {
  id: number;
  lat: number;
  lon: number;
  interesting: Set<number>;
}

export interface RouteResult {
  pubIds: number[];
  coveredCount: number;
  distanceMeters: number;
}

export interface RouteOpts {
  distance: (a: [number, number], b: [number, number]) => number;
}

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]); const la2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function buildRoute(pubs: RoutePub[], N: number, opts: RouteOpts): RouteResult {
  const selected = greedySetCover(pubs, N);
  const improved = localSwapForDistance(selected, pubs, N, opts);
  const tour = openTsp(improved, opts);
  return {
    pubIds: tour.order.map((p) => p.id),
    coveredCount: union(improved).size,
    distanceMeters: tour.distance,
  };
}

function union(pubs: RoutePub[]): Set<number> {
  const s = new Set<number>();
  for (const p of pubs) for (const x of p.interesting) s.add(x);
  return s;
}

function greedySetCover(pubs: RoutePub[], N: number): RoutePub[] {
  const picked: RoutePub[] = []; const covered = new Set<number>(); const remaining = [...pubs];
  while (covered.size < N && remaining.length) {
    let bestIdx = -1; let bestGain = -1;
    for (let i = 0; i < remaining.length; i++) {
      let gain = 0;
      for (const x of remaining[i].interesting) if (!covered.has(x)) gain++;
      if (gain > bestGain) { bestGain = gain; bestIdx = i; }
    }
    if (bestGain <= 0) break;
    const chosen = remaining[bestIdx];
    picked.push(chosen);
    for (const x of chosen.interesting) covered.add(x);
    remaining.splice(bestIdx, 1);
  }
  return picked;
}

function localSwapForDistance(
  selected: RoutePub[], all: RoutePub[], N: number, opts: RouteOpts,
): RoutePub[] {
  let best = selected; let bestDist = openTsp(best, opts).distance;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length; i++) {
      for (const cand of all) {
        if (best.some((p) => p.id === cand.id)) continue;
        const trial = [...best]; trial[i] = cand;
        if (union(trial).size < N) continue;
        const d = openTsp(trial, opts).distance;
        if (d < bestDist) { best = trial; bestDist = d; improved = true; }
      }
    }
  }
  return best;
}

function openTsp(pubs: RoutePub[], opts: RouteOpts): { order: RoutePub[]; distance: number } {
  if (pubs.length <= 1) return { order: pubs, distance: 0 };
  const n = pubs.length;
  const dist: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i !== j) dist[i][j] = opts.distance([pubs[i].lat, pubs[i].lon], [pubs[j].lat, pubs[j].lon]);
  }
  const SIZE = 1 << n;
  const dp: number[][] = Array.from({ length: SIZE }, () => Array(n).fill(Infinity));
  const parent: number[][] = Array.from({ length: SIZE }, () => Array(n).fill(-1));
  for (let i = 0; i < n; i++) dp[1 << i][i] = 0;
  for (let mask = 0; mask < SIZE; mask++) {
    for (let u = 0; u < n; u++) {
      if (!(mask & (1 << u)) || dp[mask][u] === Infinity) continue;
      for (let v = 0; v < n; v++) {
        if (mask & (1 << v)) continue;
        const nm = mask | (1 << v);
        const nd = dp[mask][u] + dist[u][v];
        if (nd < dp[nm][v]) { dp[nm][v] = nd; parent[nm][v] = u; }
      }
    }
  }
  const full = SIZE - 1;
  let best = Infinity; let bestEnd = 0;
  for (let i = 0; i < n; i++) if (dp[full][i] < best) { best = dp[full][i]; bestEnd = i; }
  const order: number[] = []; let cur = bestEnd; let mask = full;
  while (cur !== -1) { order.unshift(cur); const p = parent[mask][cur]; mask ^= 1 << cur; cur = p; }
  return { order: order.map((i) => pubs[i]), distance: best };
}

export function createOsrmDistance(base: string, fetchImpl: typeof fetch = fetch) {
  return async (a: [number, number], b: [number, number]): Promise<number> => {
    const url = `${base}/route/v1/foot/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const body = (await res.json()) as { routes?: { distance: number }[] };
    return body.routes?.[0]?.distance ?? haversineMeters(a, b);
  };
}
