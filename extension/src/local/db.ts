import type { CoverageRange } from '../../../src/shared/checkin-sync/coverage';

// #924: the local check-in database of anonymous mode. History lives only here, in the
// browser; nothing in this module talks to our API.
export const LOCAL_DB_NAME = 'wbb-local';
const DB_VERSION = 1;
// Lives in chrome.storage.local, outside the database, so it survives deleteDatabase: every new
// database gets a new generation, and a page submitted for an old one is refused (spec §3).
export const GENERATION_KEY = 'localDbGeneration';

export interface LocalCheckin {
  checkin_id: string;
  bid: number;
  beer_name: string;
  brewery_name: string;
  user_rating: number | null;
  checkin_at: string;
}

export interface LocalMeta {
  username: string;
  generation: number;
  profileTotal: number | null;
  oldestId: number | null;
  updatedAt: string;
}

const CHECKINS = 'checkins';
const COVERAGE = 'coverage';
const META = 'meta';
const RANGES_KEY = 'ranges';
const STATE_KEY = 'state';

let opened: Promise<IDBDatabase> | null = null;

export function openLocalDb(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(CHECKINS, { keyPath: 'checkin_id' }).createIndex('bid', 'bid');
      db.createObjectStore(COVERAGE);
      db.createObjectStore(META);
    };
    req.onsuccess = () => {
      // Another context deleting the database must not be blocked by this connection.
      req.result.onversionchange = () => {
        req.result.close();
        opened = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      opened = null;
      reject(req.error);
    };
  });
  return opened;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function currentGeneration(): Promise<number> {
  const got = await chrome.storage.local.get(GENERATION_KEY);
  const n = got[GENERATION_KEY];
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** The stores of one page's work, all inside one readwrite transaction. */
export interface PageTx {
  meta(): Promise<LocalMeta | null>;
  putMeta(meta: LocalMeta): Promise<void>;
  ranges(): Promise<CoverageRange[]>;
  putRanges(ranges: CoverageRange[]): Promise<void>;
  checkin(id: string): Promise<LocalCheckin | null>;
  putCheckin(row: LocalCheckin): Promise<void>;
  count(): Promise<number>;
}

// Runs `work` in one readwrite transaction over all three stores. `work` may await only the
// PageTx methods (IndexedDB requests): any other await would let the transaction auto-commit
// half-way. A throw aborts the transaction, so nothing of a refused page is written.
export async function inPageTx<T>(work: (tx: PageTx) => Promise<T>): Promise<T> {
  const db = await openLocalDb();
  const tx = db.transaction([CHECKINS, COVERAGE, META], 'readwrite');
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('local db transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
  const checkins = tx.objectStore(CHECKINS);
  const coverage = tx.objectStore(COVERAGE);
  const meta = tx.objectStore(META);
  const api: PageTx = {
    meta: async () => ((await done(meta.get(STATE_KEY))) as LocalMeta | undefined) ?? null,
    putMeta: async (m) => { await done(meta.put(m, STATE_KEY)); },
    ranges: async () => ((await done(coverage.get(RANGES_KEY))) as CoverageRange[] | undefined) ?? [],
    putRanges: async (r) => { await done(coverage.put(r, RANGES_KEY)); },
    checkin: async (id) => ((await done(checkins.get(id))) as LocalCheckin | undefined) ?? null,
    putCheckin: async (row) => { await done(checkins.put(row)); },
    count: () => done(checkins.count()),
  };
  let result: T;
  try {
    result = await work(api);
  } catch (e) {
    try {
      tx.abort();
    } catch {
      // Already finished — nothing was left to undo.
    }
    committed.catch(() => undefined);
    throw e;
  }
  await committed;
  return result;
}

/** Every check-in, for the "had" index and Options stats. */
export async function allCheckins(): Promise<LocalCheckin[]> {
  const db = await openLocalDb();
  return done(db.transaction(CHECKINS, 'readonly').objectStore(CHECKINS).getAll()) as Promise<LocalCheckin[]>;
}

// Clear: stop the running sync, move to a new generation, then delete. A page that was in flight
// still carries the old generation and is refused even if the abort did not reach it in time.
export async function clearLocalDb(abortSync: () => void = () => undefined): Promise<void> {
  abortSync();
  await chrome.storage.local.set({ [GENERATION_KEY]: (await currentGeneration()) + 1 });
  const db = await opened?.catch(() => null);
  db?.close();
  opened = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // other connections close on versionchange; deletion completes after them
  });
}
