import type { DB } from '../storage/db';
import { loadCatalog } from '../storage/beers';
import { catalogVersion } from '../storage/catalog-version';
import { prepareBeer, makePreparedCatalog, type PreparedCatalog } from './matcher';
import { yieldToEventLoop, type CatalogBeerWithRating } from './match-list';

// ~0.027 ms/row on the prod catalog → 2000 rows ≈ ≤60 ms of normalization per chunk.
const PREP_CHUNK = 2000;
const DEFAULT_TTL_MS = 5 * 60_000;

export interface CachedCatalog {
  prepared: PreparedCatalog;
  byId: Map<number, CatalogBeerWithRating>;
}

export interface CatalogCache {
  // Returns the shared catalog (possibly stale), triggering a background rebuild
  // when the version has moved or the TTL has expired (stale-while-revalidate).
  get(): Promise<CachedCatalog>;
  // Resolves when no background rebuild is in flight. Test seam to await SWR completion.
  idle(): Promise<void>;
}

export interface CatalogCacheOptions {
  getVersion?: () => number;                                        // default: catalogVersion
  load?: () => CatalogBeerWithRating[];                             // default: loadCatalog(db)
  prepare?: (rows: CatalogBeerWithRating[]) => Promise<PreparedCatalog>; // default: chunked
  now?: () => number;                                               // default: Date.now
  ttlMs?: number;                                                   // default: 5 min
}

// Builds PreparedBeer[] in chunks, yielding to the event loop between chunks so the
// long-poll bot keeps processing updates during the ~1.2 s CPU burst, then assembles
// the catalog. Moved here from match-list.ts — the cache is now its only caller.
export async function prepareCatalogChunked(
  catalog: CatalogBeerWithRating[],
  yield_: () => Promise<void> = yieldToEventLoop,
): Promise<PreparedCatalog> {
  const beers = [];
  for (let i = 0; i < catalog.length; i += PREP_CHUNK) {
    const end = Math.min(i + PREP_CHUNK, catalog.length);
    for (let j = i; j < end; j++) beers.push(prepareBeer(catalog[j]));
    await yield_();
  }
  return makePreparedCatalog(beers);
}

export function createCatalogCache(db: DB, opts: CatalogCacheOptions = {}): CatalogCache {
  const getVersion = opts.getVersion ?? catalogVersion;
  const load = opts.load ?? (() => loadCatalog(db));
  const prepare = opts.prepare ?? ((rows) => prepareCatalogChunked(rows));
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  let current: { value: CachedCatalog; version: number; builtAt: number } | null = null;
  let rebuilding: Promise<void> | null = null;

  function rebuild(): Promise<void> {
    // Single-flight: a rebuild already running is reused, never doubled.
    if (rebuilding) return rebuilding;
    // Capture the version BEFORE load: a write landing mid-rebuild leaves
    // current.version < getVersion(), so the next get() re-triggers (no lost update).
    const version = getVersion();
    rebuilding = (async () => {
      const rows = load();
      const prepared = await prepare(rows);
      const byId = new Map(rows.map((r) => [r.id, r]));
      current = { value: { prepared, byId }, version, builtAt: now() };
    })().finally(() => { rebuilding = null; });
    return rebuilding;
  }

  return {
    async get() {
      if (current === null) {
        await rebuild();
        return current!.value;
      }
      const stale = current.version !== getVersion() || now() - current.builtAt > ttlMs;
      if (stale && !rebuilding) void rebuild();
      return current.value;
    },
    idle() {
      return rebuilding ?? Promise.resolve();
    },
  };
}
