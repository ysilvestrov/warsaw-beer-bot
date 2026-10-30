import type { MatchResult } from '../api/types';
import { normalizeKey } from '../shared/normalize';

export interface UserHadBeer {
  bid: number;
  name: string;
  brewery: string;
  rating: number | null;
  checkinDate?: string;
  count?: number;
  normalizedKey: string;
}

export interface CatalogBeer {
  bid: number;
  name: string;
  brewery: string;
  abv?: number;
  style?: string;
  ratingGlobal: number | null;
  normalizedKey: string;
  cachedAt: number;
}

export interface CardMatchRecord {
  cardKey: string;
  result: MatchResult;
  updatedAt: number;
}

const DB_NAME = 'UntappdBrowserOverlayDB';
const DB_VERSION = 1;

const STORE_USER_HAD = 'user_had';
const STORE_CATALOG = 'beers_catalog';
const STORE_CARD_MATCHES = 'card_matches';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openLocalDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    // In service worker / browser environment indexedDB is available on globalThis
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }

    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_USER_HAD)) {
        const hadStore = db.createObjectStore(STORE_USER_HAD, { keyPath: 'bid' });
        hadStore.createIndex('by_normalizedKey', 'normalizedKey', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_CATALOG)) {
        const catStore = db.createObjectStore(STORE_CATALOG, { keyPath: 'bid' });
        catStore.createIndex('by_normalizedKey', 'normalizedKey', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_CARD_MATCHES)) {
        db.createObjectStore(STORE_CARD_MATCHES, { keyPath: 'cardKey' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

export async function saveUserHadBatch(beers: Omit<UserHadBeer, 'normalizedKey'>[]): Promise<void> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_USER_HAD, 'readwrite');
    const store = tx.objectStore(STORE_USER_HAD);

    for (const b of beers) {
      const record: UserHadBeer = {
        ...b,
        normalizedKey: normalizeKey(b.brewery, b.name),
      };
      store.put(record);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getUserHadByBid(bid: number): Promise<UserHadBeer | null> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_USER_HAD, 'readonly');
    const store = tx.objectStore(STORE_USER_HAD);
    const req = store.get(bid);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function findUserHadByName(brewery: string, name: string): Promise<UserHadBeer | null> {
  const db = await openLocalDB();
  const key = normalizeKey(brewery, name);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_USER_HAD, 'readonly');
    const store = tx.objectStore(STORE_USER_HAD);
    const index = store.index('by_normalizedKey');
    const req = index.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function countUserHad(): Promise<number> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_USER_HAD, 'readonly');
    const store = tx.objectStore(STORE_USER_HAD);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clearUserHad(): Promise<void> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_USER_HAD, 'readwrite');
    const store = tx.objectStore(STORE_USER_HAD);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function saveCatalogBeer(beer: Omit<CatalogBeer, 'normalizedKey' | 'cachedAt'>): Promise<void> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CATALOG, 'readwrite');
    const store = tx.objectStore(STORE_CATALOG);
    const record: CatalogBeer = {
      ...beer,
      normalizedKey: normalizeKey(beer.brewery, beer.name),
      cachedAt: Date.now(),
    };
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function saveCatalogBeerBatch(beers: Omit<CatalogBeer, 'normalizedKey' | 'cachedAt'>[]): Promise<void> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CATALOG, 'readwrite');
    const store = tx.objectStore(STORE_CATALOG);
    const now = Date.now();
    for (const b of beers) {
      store.put({
        ...b,
        normalizedKey: normalizeKey(b.brewery, b.name),
        cachedAt: now,
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function findCatalogBeer(brewery: string, name: string): Promise<CatalogBeer | null> {
  const db = await openLocalDB();
  const key = normalizeKey(brewery, name);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CATALOG, 'readonly');
    const store = tx.objectStore(STORE_CATALOG);
    const index = store.index('by_normalizedKey');
    const req = index.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getCardMatch(cardKey: string): Promise<MatchResult | null> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CARD_MATCHES, 'readonly');
    const store = tx.objectStore(STORE_CARD_MATCHES);
    const req = store.get(cardKey);
    req.onsuccess = () => {
      const rec = req.result as CardMatchRecord | undefined;
      resolve(rec ? rec.result : null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveCardMatch(cardKey: string, result: MatchResult): Promise<void> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CARD_MATCHES, 'readwrite');
    const store = tx.objectStore(STORE_CARD_MATCHES);
    const record: CardMatchRecord = {
      cardKey,
      result,
      updatedAt: Date.now(),
    };
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllLocalDB(): Promise<void> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_USER_HAD, STORE_CATALOG, STORE_CARD_MATCHES], 'readwrite');
    tx.objectStore(STORE_USER_HAD).clear();
    tx.objectStore(STORE_CATALOG).clear();
    tx.objectStore(STORE_CARD_MATCHES).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function countCatalogBeers(): Promise<number> {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CATALOG, 'readonly');
    const store = tx.objectStore(STORE_CATALOG);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
