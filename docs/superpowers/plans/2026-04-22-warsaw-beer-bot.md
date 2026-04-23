# Warsaw Beer Crawler Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an MVP Telegram bot that crosses live ontap.pl Warsaw tap data with a user's Untappd history and returns a walking route covering ≥ N untried beers with minimal distance.

**Architecture:** Pure-function `domain/*` sandwiched between `sources/*` (I/O: ontap HTML parser, Untappd CSV + public-profile scraper, Nominatim fallback) and `storage/*` (SQLite repos). `bot/*` on Telegraf, `jobs/*` on `node-cron`, single `.env` parsed by `zod`, logged via `pino`, hosted under systemd on Hetzner CX33.

**Tech Stack:** Node ≥ 20, TypeScript strict, Telegraf v4, `better-sqlite3`, `cheerio`, `csv-parse`, `fast-fuzzy`, `p-queue`, `zod`, `pino`, `node-cron`, Jest + `ts-jest`.

**Spec:** [`docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`](../specs/2026-04-22-warsaw-beer-bot-design.md)

---

## File Map

```
src/
├── config/env.ts                         TASK 1
├── storage/
│   ├── db.ts                             TASK 2  — connection + WAL
│   ├── schema.ts                         TASK 2  — DDL + migrate runner
│   ├── beers.ts                          TASK 3
│   ├── pubs.ts                           TASK 4
│   ├── snapshots.ts                      TASK 5  — tap_snapshots + taps
│   ├── checkins.ts                       TASK 6
│   ├── match_links.ts                    TASK 7
│   ├── user_profiles.ts                  TASK 8
│   └── user_filters.ts                   TASK 8
├── sources/
│   ├── http.ts                           TASK 9  — shared p-queue + fetch wrapper
│   ├── ontap/
│   │   ├── index.ts                      TASK 10 — parser of /warszawa
│   │   └── pub.ts                        TASK 11 — parser of <slug>.ontap.pl
│   ├── untappd/
│   │   ├── export.ts                     TASK 12 — CSV parser
│   │   └── scraper.ts                    TASK 13 — /user/<u>/beer parser
│   └── geocoder.ts                       TASK 14 — Nominatim fallback
├── domain/
│   ├── normalize.ts                      TASK 15 — shared string helpers
│   ├── matcher.ts                        TASK 16
│   ├── filters.ts                        TASK 17 — interesting(p), ranking
│   └── router.ts                         TASK 18 — set-cover + swap + open-TSP + OSRM
├── bot/
│   ├── index.ts                          TASK 19 — Telegraf bootstrap
│   ├── keyboards.ts                      TASK 19
│   └── commands/
│       ├── start.ts                      TASK 20
│       ├── link.ts                       TASK 20
│       ├── import.ts                     TASK 21
│       ├── newbeers.ts                   TASK 22
│       ├── route.ts                      TASK 22
│       ├── filters.ts                    TASK 23
│       └── refresh.ts                    TASK 23
├── jobs/
│   ├── refresh-ontap.ts                  TASK 24
│   └── refresh-untappd.ts                TASK 24
└── index.ts                              TASK 25 — composition root

tests/fixtures/
├── ontap/warszawa-index.html             TASK 10
├── ontap/beer-bones.html                 TASK 11
├── untappd/export.csv                    TASK 12 — csv fixture
├── untappd/export.json                   TASK 12 — json fixture
├── untappd/export.zip                    TASK 12 — zip wrapping json
└── untappd/user-beer.html                TASK 13

deploy/
├── warsaw-beer-bot.service               TASK 26
└── deploy.sh                             TASK 26
```

---

## Task 0: Bootstrap the project

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`, `jest.config.js`, `.env.example`, `src/index.ts` (stub)

- [ ] **Step 1: Install runtime and dev deps**

```bash
cd /root/warsaw-beer-bot
npm pkg set engines.node=">=20"
npm install telegraf better-sqlite3 cheerio csv-parse fast-fuzzy p-queue zod pino node-cron stream-json yauzl
npm install -D typescript ts-node tsx @types/node @types/better-sqlite3 @types/node-cron @types/yauzl jest ts-jest @types/jest
```

Expected: `package.json` lists all deps; `node_modules/` populated.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Write `jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
};
```

- [ ] **Step 4: Add npm scripts**

```bash
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="node dist/index.js"
npm pkg set scripts.dev="tsx watch src/index.ts"
npm pkg set scripts.test="jest"
npm pkg set scripts.typecheck="tsc --noEmit"
```

- [ ] **Step 5: Create `.env.example` with placeholders**

```
TELEGRAM_BOT_TOKEN=123456:replace-me
DATABASE_PATH=./bot.db
OSRM_BASE_URL=https://router.project-osrm.org
NOMINATIM_USER_AGENT=warsaw-beer-bot (contact@example.com)
LOG_LEVEL=info
DEFAULT_ROUTE_N=5
```

- [ ] **Step 6: Stub `src/index.ts`**

```ts
console.log('warsaw-beer-bot: bootstrap OK');
```

- [ ] **Step 7: Verify build and test harness**

```bash
npm run typecheck && npm test -- --passWithNoTests
```

Expected: typecheck passes; Jest prints "0 tests" without error.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json jest.config.js .env.example src/index.ts
git commit -m "chore: bootstrap typescript + jest toolchain"
```

---

## Task 1: `config/env.ts` — zod-validated env loader

**Files:**
- Create: `src/config/env.ts`
- Test: `src/config/env.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/config/env.test.ts
import { loadEnv } from './env';

describe('loadEnv', () => {
  it('parses a complete env map', () => {
    const env = loadEnv({
      TELEGRAM_BOT_TOKEN: 'abc:123',
      DATABASE_PATH: '/tmp/bot.db',
      OSRM_BASE_URL: 'https://osrm.example',
      NOMINATIM_USER_AGENT: 'ua',
      LOG_LEVEL: 'debug',
      DEFAULT_ROUTE_N: '7',
    });
    expect(env.DEFAULT_ROUTE_N).toBe(7);
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('rejects missing token', () => {
    expect(() => loadEnv({ DATABASE_PATH: '/tmp/x.db' } as any)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx jest src/config/env.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/config/env.ts
import { z } from 'zod';

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  DATABASE_PATH: z.string().min(1),
  OSRM_BASE_URL: z.string().url(),
  NOMINATIM_USER_AGENT: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  DEFAULT_ROUTE_N: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Schema.parse(source);
}
```

- [ ] **Step 4: Run and see it pass**

Run: `npx jest src/config/env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(config): zod-validated env loader"
```

---

## Task 2: `storage/db.ts` + `storage/schema.ts` — connection and migrations

**Files:**
- Create: `src/storage/db.ts`, `src/storage/schema.ts`
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/storage/schema.test.ts
import { openDb } from './db';
import { migrate } from './schema';

describe('schema migrations', () => {
  it('creates all tables in an empty db', () => {
    const db = openDb(':memory:');
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'beers', 'pubs', 'tap_snapshots', 'taps', 'checkins',
        'match_links', 'user_profiles', 'user_filters', 'schema_version',
      ]),
    );
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx jest src/storage/schema.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `db.ts`**

```ts
// src/storage/db.ts
import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 4: Implement `schema.ts`**

```ts
// src/storage/schema.ts
import type { DB } from './db';

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE beers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        untappd_id INTEGER UNIQUE,
        name TEXT NOT NULL,
        brewery TEXT NOT NULL,
        style TEXT,
        abv REAL,
        rating_global REAL,
        normalized_name TEXT NOT NULL,
        normalized_brewery TEXT NOT NULL
      );
      CREATE INDEX idx_beers_norm ON beers(normalized_brewery, normalized_name);

      CREATE TABLE pubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        address TEXT,
        lat REAL,
        lon REAL
      );

      CREATE TABLE tap_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pub_id INTEGER NOT NULL REFERENCES pubs(id),
        snapshot_at TEXT NOT NULL
      );
      CREATE INDEX idx_snapshot_pub_time ON tap_snapshots(pub_id, snapshot_at DESC);

      CREATE TABLE taps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES tap_snapshots(id) ON DELETE CASCADE,
        tap_number INTEGER,
        beer_ref TEXT NOT NULL,
        brewery_ref TEXT,
        abv REAL,
        ibu REAL,
        style TEXT,
        u_rating REAL
      );
      CREATE INDEX idx_taps_snapshot ON taps(snapshot_id);

      CREATE TABLE checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checkin_id TEXT NOT NULL,
        telegram_id INTEGER NOT NULL,
        beer_id INTEGER REFERENCES beers(id),
        user_rating REAL,
        checkin_at TEXT NOT NULL,
        venue TEXT,
        UNIQUE(telegram_id, checkin_id)
      );
      CREATE INDEX idx_checkins_user_beer ON checkins(telegram_id, beer_id);

      CREATE TABLE match_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ontap_ref TEXT NOT NULL UNIQUE,
        untappd_beer_id INTEGER REFERENCES beers(id),
        confidence REAL NOT NULL,
        reviewed_by_user INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE user_profiles (
        telegram_id INTEGER PRIMARY KEY,
        untappd_username TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE user_filters (
        telegram_id INTEGER PRIMARY KEY REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        styles TEXT,
        min_rating REAL,
        abv_min REAL,
        abv_max REAL,
        default_route_n INTEGER
      );
    `,
  },
];

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);`);
  const current =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    });
    tx();
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx jest src/storage/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/storage/db.ts src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(storage): sqlite connection + initial schema migration"
```

---

## Task 3: `storage/beers.ts`

**Files:**
- Create: `src/storage/beers.ts`
- Test: `src/storage/beers.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/storage/beers.test.ts
import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer, findBeerByNormalized } from './beers';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('upsertBeer inserts then updates by normalized key', () => {
  const db = fresh();
  const id1 = upsertBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA',
    abv: 6.1, rating_global: 3.9,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  const id2 = upsertBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA',
    abv: 6.2, rating_global: 3.95,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  expect(id1).toBe(id2);
  const row = findBeerByNormalized(db, 'pinta', 'atak chmielu');
  expect(row?.abv).toBeCloseTo(6.2);
});

test('findBeerByNormalized returns null when absent', () => {
  expect(findBeerByNormalized(fresh(), 'x', 'y')).toBeNull();
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx jest src/storage/beers.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/storage/beers.ts
import type { DB } from './db';

export interface BeerInput {
  untappd_id?: number | null;
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
}

export interface BeerRow extends BeerInput { id: number; }

export function upsertBeer(db: DB, b: BeerInput): number {
  const existing = db
    .prepare('SELECT id FROM beers WHERE normalized_brewery = ? AND normalized_name = ?')
    .get(b.normalized_brewery, b.normalized_name) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE beers SET untappd_id = COALESCE(?, untappd_id), name = ?, brewery = ?,
         style = ?, abv = ?, rating_global = ? WHERE id = ?`,
    ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null,
          b.abv ?? null, b.rating_global ?? null, existing.id);
    return existing.id;
  }

  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null, b.abv ?? null,
        b.rating_global ?? null, b.normalized_name, b.normalized_brewery);
  return Number(res.lastInsertRowid);
}

export function findBeerByNormalized(
  db: DB, normBrewery: string, normName: string,
): BeerRow | null {
  const row = db
    .prepare('SELECT * FROM beers WHERE normalized_brewery = ? AND normalized_name = ?')
    .get(normBrewery, normName) as BeerRow | undefined;
  return row ?? null;
}
```

- [ ] **Step 4: Pass**

Run: `npx jest src/storage/beers.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(storage): beers repo with upsert-by-normalized-key"
```

---

## Task 4: `storage/pubs.ts`

**Files:**
- Create: `src/storage/pubs.ts`
- Test: `src/storage/pubs.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/storage/pubs.test.ts
import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub, listPubs, setPubCoords } from './pubs';

function fresh() {
  const db = openDb(':memory:'); migrate(db); return db;
}

test('upsertPub inserts a new pub and updates metadata in place', () => {
  const db = fresh();
  const id = upsertPub(db, { slug: 'beer-bones', name: 'Beer & Bones', address: 'Żurawia 32/34', lat: 52.228, lon: 21.013 });
  expect(id).toBeGreaterThan(0);
  const id2 = upsertPub(db, { slug: 'beer-bones', name: 'Beer & Bones CB&M', address: 'Żurawia 32/34', lat: null, lon: null });
  expect(id2).toBe(id);
  const pubs = listPubs(db);
  expect(pubs[0].name).toBe('Beer & Bones CB&M');
  expect(pubs[0].lat).toBeCloseTo(52.228);  // not overwritten with null
});

test('setPubCoords fills missing coordinates', () => {
  const db = fresh();
  const id = upsertPub(db, { slug: 'x', name: 'X', address: 'A', lat: null, lon: null });
  setPubCoords(db, id, 1.0, 2.0);
  expect(listPubs(db)[0].lat).toBe(1.0);
});
```

- [ ] **Step 2: Fail** — Run: `npx jest src/storage/pubs.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/storage/pubs.ts
import type { DB } from './db';

export interface PubInput {
  slug: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
}

export interface PubRow extends PubInput { id: number; }

export function upsertPub(db: DB, p: PubInput): number {
  const existing = db.prepare('SELECT id FROM pubs WHERE slug = ?').get(p.slug) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE pubs SET name = ?, address = COALESCE(?, address),
         lat = COALESCE(?, lat), lon = COALESCE(?, lon) WHERE id = ?`,
    ).run(p.name, p.address, p.lat, p.lon, existing.id);
    return existing.id;
  }
  const res = db.prepare(
    'INSERT INTO pubs (slug, name, address, lat, lon) VALUES (?, ?, ?, ?, ?)',
  ).run(p.slug, p.name, p.address, p.lat, p.lon);
  return Number(res.lastInsertRowid);
}

export function listPubs(db: DB): PubRow[] {
  return db.prepare('SELECT * FROM pubs ORDER BY id').all() as PubRow[];
}

export function setPubCoords(db: DB, pubId: number, lat: number, lon: number): void {
  db.prepare('UPDATE pubs SET lat = ?, lon = ? WHERE id = ?').run(lat, lon, pubId);
}
```

- [ ] **Step 4: Pass** — Run: `npx jest src/storage/pubs.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/pubs.ts src/storage/pubs.test.ts
git commit -m "feat(storage): pubs repo"
```

---

## Task 5: `storage/snapshots.ts` — tap_snapshots + taps

**Files:**
- Create: `src/storage/snapshots.ts`
- Test: `src/storage/snapshots.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/storage/snapshots.test.ts
import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import { createSnapshot, latestSnapshot, insertTaps, tapsForSnapshot } from './snapshots';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const pubId = upsertPub(db, { slug: 'p', name: 'P', address: null, lat: null, lon: null });
  return { db, pubId };
}

test('createSnapshot + insertTaps roundtrip', () => {
  const { db, pubId } = setup();
  const snapId = createSnapshot(db, pubId, '2026-04-22T12:00:00Z');
  insertTaps(db, snapId, [
    { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA', abv: 6.1, ibu: 55, style: 'AIPA', u_rating: 3.9 },
    { tap_number: 2, beer_ref: 'Stu Mostów Buty', brewery_ref: 'Stu Mostów', abv: 5.0, ibu: null, style: 'Pils', u_rating: 3.7 },
  ]);
  const rows = tapsForSnapshot(db, snapId);
  expect(rows).toHaveLength(2);
  expect(rows[0].beer_ref).toBe('PINTA Atak Chmielu');
});

test('latestSnapshot returns most recent per pub', () => {
  const { db, pubId } = setup();
  createSnapshot(db, pubId, '2026-04-22T10:00:00Z');
  const s2 = createSnapshot(db, pubId, '2026-04-22T20:00:00Z');
  expect(latestSnapshot(db, pubId)?.id).toBe(s2);
});
```

- [ ] **Step 2: Fail** — `npx jest src/storage/snapshots.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/storage/snapshots.ts
import type { DB } from './db';

export interface TapInput {
  tap_number: number | null;
  beer_ref: string;
  brewery_ref: string | null;
  abv: number | null;
  ibu: number | null;
  style: string | null;
  u_rating: number | null;
}

export interface TapRow extends TapInput { id: number; snapshot_id: number; }
export interface SnapshotRow { id: number; pub_id: number; snapshot_at: string; }

export function createSnapshot(db: DB, pubId: number, at: string): number {
  const res = db.prepare(
    'INSERT INTO tap_snapshots (pub_id, snapshot_at) VALUES (?, ?)',
  ).run(pubId, at);
  return Number(res.lastInsertRowid);
}

export function insertTaps(db: DB, snapshotId: number, taps: TapInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO taps (snapshot_id, tap_number, beer_ref, brewery_ref, abv, ibu, style, u_rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((items: TapInput[]) => {
    for (const t of items) {
      stmt.run(snapshotId, t.tap_number, t.beer_ref, t.brewery_ref,
               t.abv, t.ibu, t.style, t.u_rating);
    }
  });
  tx(taps);
}

export function tapsForSnapshot(db: DB, snapshotId: number): TapRow[] {
  return db.prepare('SELECT * FROM taps WHERE snapshot_id = ? ORDER BY tap_number').all(snapshotId) as TapRow[];
}

export function latestSnapshot(db: DB, pubId: number): SnapshotRow | null {
  return (db.prepare(
    'SELECT * FROM tap_snapshots WHERE pub_id = ? ORDER BY snapshot_at DESC LIMIT 1',
  ).get(pubId) as SnapshotRow | undefined) ?? null;
}

export function latestSnapshotsPerPub(db: DB): SnapshotRow[] {
  return db.prepare(
    `SELECT s.* FROM tap_snapshots s
     INNER JOIN (
       SELECT pub_id, MAX(snapshot_at) AS m FROM tap_snapshots GROUP BY pub_id
     ) x ON x.pub_id = s.pub_id AND x.m = s.snapshot_at`,
  ).all() as SnapshotRow[];
}
```

- [ ] **Step 4: Pass** — `npx jest src/storage/snapshots.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/snapshots.ts src/storage/snapshots.test.ts
git commit -m "feat(storage): tap_snapshots + taps repo"
```

---

## Task 6: `storage/checkins.ts`

**Files:**
- Create: `src/storage/checkins.ts`
- Test: `src/storage/checkins.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/storage/checkins.test.ts
import { openDb } from './db';
import { migrate } from './schema';
import { mergeCheckin, checkinsForUser, hasBeenDrunk } from './checkins';
import { upsertBeer } from './beers';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const beerId = upsertBeer(db, {
    name: 'Atak', brewery: 'Pinta', style: 'IPA', abv: 6, rating_global: 3.9,
    normalized_name: 'atak', normalized_brewery: 'pinta',
  });
  return { db, beerId };
}

test('mergeCheckin is idempotent on (telegram_id, checkin_id)', () => {
  const { db, beerId } = setup();
  mergeCheckin(db, { checkin_id: 'c1', telegram_id: 10, beer_id: beerId,
    user_rating: 4.0, checkin_at: '2026-04-22T10:00:00Z', venue: 'Home' });
  mergeCheckin(db, { checkin_id: 'c1', telegram_id: 10, beer_id: beerId,
    user_rating: 4.5, checkin_at: '2026-04-22T10:00:00Z', venue: 'Home' });
  const all = checkinsForUser(db, 10);
  expect(all).toHaveLength(1);
  expect(all[0].user_rating).toBe(4.5);  // latest write wins
});

test('hasBeenDrunk ignores other users', () => {
  const { db, beerId } = setup();
  mergeCheckin(db, { checkin_id: 'c', telegram_id: 10, beer_id: beerId,
    user_rating: null, checkin_at: '2026-04-22T10:00:00Z', venue: null });
  expect(hasBeenDrunk(db, 10, beerId)).toBe(true);
  expect(hasBeenDrunk(db, 11, beerId)).toBe(false);
});
```

- [ ] **Step 2: Fail** — `npx jest src/storage/checkins.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/storage/checkins.ts
import type { DB } from './db';

export interface CheckinInput {
  checkin_id: string;
  telegram_id: number;
  beer_id: number | null;
  user_rating: number | null;
  checkin_at: string;
  venue: string | null;
}

export interface CheckinRow extends CheckinInput { id: number; }

export function mergeCheckin(db: DB, c: CheckinInput): void {
  db.prepare(
    `INSERT INTO checkins (checkin_id, telegram_id, beer_id, user_rating, checkin_at, venue)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id, checkin_id) DO UPDATE SET
       beer_id = excluded.beer_id,
       user_rating = excluded.user_rating,
       checkin_at = excluded.checkin_at,
       venue = excluded.venue`,
  ).run(c.checkin_id, c.telegram_id, c.beer_id, c.user_rating, c.checkin_at, c.venue);
}

export function checkinsForUser(db: DB, telegramId: number): CheckinRow[] {
  return db.prepare('SELECT * FROM checkins WHERE telegram_id = ? ORDER BY checkin_at DESC')
    .all(telegramId) as CheckinRow[];
}

export function hasBeenDrunk(db: DB, telegramId: number, beerId: number): boolean {
  const row = db.prepare(
    'SELECT 1 FROM checkins WHERE telegram_id = ? AND beer_id = ? LIMIT 1',
  ).get(telegramId, beerId);
  return !!row;
}

export function drunkBeerIds(db: DB, telegramId: number): Set<number> {
  const rows = db.prepare(
    'SELECT DISTINCT beer_id FROM checkins WHERE telegram_id = ? AND beer_id IS NOT NULL',
  ).all(telegramId) as { beer_id: number }[];
  return new Set(rows.map((r) => r.beer_id));
}
```

- [ ] **Step 4: Pass** — `npx jest src/storage/checkins.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/checkins.ts src/storage/checkins.test.ts
git commit -m "feat(storage): checkins repo with per-user idempotent merge"
```

---

## Task 7: `storage/match_links.ts`

**Files:**
- Create: `src/storage/match_links.ts`
- Test: `src/storage/match_links.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/storage/match_links.test.ts
import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { upsertMatch, getMatch, listUnreviewedBelow } from './match_links';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const id = upsertBeer(db, {
    name: 'X', brewery: 'B', style: null, abv: null, rating_global: null,
    normalized_name: 'x', normalized_brewery: 'b',
  });
  return { db, beerId: id };
}

test('upsertMatch upserts by ontap_ref', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'PINTA|atak', beerId, 0.9);
  upsertMatch(db, 'PINTA|atak', beerId, 1.0);
  const m = getMatch(db, 'PINTA|atak');
  expect(m?.confidence).toBe(1.0);
});

test('listUnreviewedBelow returns low-confidence, not yet reviewed', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'a', beerId, 0.7);
  upsertMatch(db, 'b', beerId, 0.95);
  expect(listUnreviewedBelow(db, 0.85).map((r) => r.ontap_ref)).toEqual(['a']);
});
```

- [ ] **Step 2: Fail** — run the test.

- [ ] **Step 3: Implement**

```ts
// src/storage/match_links.ts
import type { DB } from './db';

export interface MatchRow {
  id: number;
  ontap_ref: string;
  untappd_beer_id: number | null;
  confidence: number;
  reviewed_by_user: number;
}

export function upsertMatch(db: DB, ontapRef: string, beerId: number | null, confidence: number): void {
  db.prepare(
    `INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user)
       VALUES (?, ?, ?, 0)
     ON CONFLICT(ontap_ref) DO UPDATE SET
       untappd_beer_id = excluded.untappd_beer_id,
       confidence = excluded.confidence`,
  ).run(ontapRef, beerId, confidence);
}

export function getMatch(db: DB, ontapRef: string): MatchRow | null {
  return (db.prepare('SELECT * FROM match_links WHERE ontap_ref = ?').get(ontapRef) as MatchRow | undefined) ?? null;
}

export function listUnreviewedBelow(db: DB, threshold: number): MatchRow[] {
  return db.prepare(
    'SELECT * FROM match_links WHERE confidence < ? AND reviewed_by_user = 0 ORDER BY confidence',
  ).all(threshold) as MatchRow[];
}

export function markReviewed(db: DB, id: number, beerId: number | null): void {
  db.prepare(
    'UPDATE match_links SET untappd_beer_id = ?, confidence = 1.0, reviewed_by_user = 1 WHERE id = ?',
  ).run(beerId, id);
}
```

- [ ] **Step 4: Pass** — re-run.

- [ ] **Step 5: Commit**

```bash
git add src/storage/match_links.ts src/storage/match_links.test.ts
git commit -m "feat(storage): match_links repo"
```

---

## Task 8: `storage/user_profiles.ts` + `storage/user_filters.ts`

**Files:**
- Create: `src/storage/user_profiles.ts`, `src/storage/user_filters.ts`
- Test: `src/storage/user.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/storage/user.test.ts
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, setUntappdUsername, getProfile } from './user_profiles';
import { getFilters, setFilters } from './user_filters';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

test('ensureProfile is idempotent and setUntappdUsername sticks', () => {
  const db = fresh();
  ensureProfile(db, 42);
  ensureProfile(db, 42);
  setUntappdUsername(db, 42, 'yuriy');
  expect(getProfile(db, 42)?.untappd_username).toBe('yuriy');
});

test('filters round-trip styles array', () => {
  const db = fresh();
  ensureProfile(db, 42);
  setFilters(db, 42, { styles: ['IPA', 'Pils'], min_rating: 3.5, abv_min: 4, abv_max: 9, default_route_n: 7 });
  const f = getFilters(db, 42);
  expect(f?.styles).toEqual(['IPA', 'Pils']);
  expect(f?.default_route_n).toBe(7);
});
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement `user_profiles.ts`**

```ts
// src/storage/user_profiles.ts
import type { DB } from './db';

export interface ProfileRow {
  telegram_id: number;
  untappd_username: string | null;
  created_at: string;
}

export function ensureProfile(db: DB, telegramId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO user_profiles (telegram_id) VALUES (?)',
  ).run(telegramId);
}

export function setUntappdUsername(db: DB, telegramId: number, username: string): void {
  db.prepare('UPDATE user_profiles SET untappd_username = ? WHERE telegram_id = ?')
    .run(username, telegramId);
}

export function getProfile(db: DB, telegramId: number): ProfileRow | null {
  return (db.prepare('SELECT * FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as ProfileRow | undefined) ?? null;
}

export function allProfiles(db: DB): ProfileRow[] {
  return db.prepare('SELECT * FROM user_profiles').all() as ProfileRow[];
}
```

- [ ] **Step 4: Implement `user_filters.ts`**

```ts
// src/storage/user_filters.ts
import type { DB } from './db';

export interface Filters {
  styles: string[];
  min_rating: number | null;
  abv_min: number | null;
  abv_max: number | null;
  default_route_n: number | null;
}

interface Row {
  styles: string | null;
  min_rating: number | null;
  abv_min: number | null;
  abv_max: number | null;
  default_route_n: number | null;
}

export function getFilters(db: DB, telegramId: number): Filters | null {
  const r = db.prepare('SELECT styles, min_rating, abv_min, abv_max, default_route_n FROM user_filters WHERE telegram_id = ?')
    .get(telegramId) as Row | undefined;
  if (!r) return null;
  return {
    styles: r.styles ? JSON.parse(r.styles) : [],
    min_rating: r.min_rating,
    abv_min: r.abv_min,
    abv_max: r.abv_max,
    default_route_n: r.default_route_n,
  };
}

export function setFilters(db: DB, telegramId: number, f: Filters): void {
  db.prepare(
    `INSERT INTO user_filters (telegram_id, styles, min_rating, abv_min, abv_max, default_route_n)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       styles = excluded.styles, min_rating = excluded.min_rating,
       abv_min = excluded.abv_min, abv_max = excluded.abv_max,
       default_route_n = excluded.default_route_n`,
  ).run(telegramId, JSON.stringify(f.styles), f.min_rating, f.abv_min, f.abv_max, f.default_route_n);
}
```

- [ ] **Step 5: Pass** — run test.

- [ ] **Step 6: Commit**

```bash
git add src/storage/user_profiles.ts src/storage/user_filters.ts src/storage/user.test.ts
git commit -m "feat(storage): user_profiles + user_filters repos"
```

---

## Task 9: `sources/http.ts` — shared fetch with p-queue

**Files:**
- Create: `src/sources/http.ts`
- Test: `src/sources/http.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/sources/http.test.ts
import { createHttp } from './http';

test('createHttp serialises requests through the queue (concurrency 1)', async () => {
  let active = 0;
  let maxActive = 0;
  const fakeFetch: typeof fetch = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 10, fetchImpl: fakeFetch });
  await Promise.all([http.get('a'), http.get('b'), http.get('c')]);
  expect(maxActive).toBe(1);
});
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement**

```ts
// src/sources/http.ts
import PQueue from 'p-queue';

export interface Http {
  get(url: string): Promise<string>;
}

export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
}

export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 2000;
  let lastAt = 0;

  return {
    async get(url: string): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const res = await f(url, { headers: { 'User-Agent': opts.userAgent } });
        lastAt = Date.now();
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
      }) as Promise<string>;
    },
  };
}
```

- [ ] **Step 4: Pass** — run test.

- [ ] **Step 5: Commit**

```bash
git add src/sources/http.ts src/sources/http.test.ts
git commit -m "feat(sources): p-queue-backed http client with rate limit"
```

---

## Task 10: `sources/ontap/index.ts` — parse Warsaw index

**Files:**
- Create: `tests/fixtures/ontap/warszawa-index.html`, `src/sources/ontap/index.ts`
- Test: `src/sources/ontap/index.test.ts`

- [ ] **Step 1: Capture fixture**

```bash
curl -sL --compressed 'https://ontap.pl/warszawa' -o tests/fixtures/ontap/warszawa-index.html
```

Expected: file written, size > 5 KB.

- [ ] **Step 2: Failing test**

```ts
// src/sources/ontap/index.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { parseWarsawIndex } from './index';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/ontap/warszawa-index.html'),
  'utf8',
);

test('parses at least 20 pubs with slug + name', () => {
  const pubs = parseWarsawIndex(html);
  expect(pubs.length).toBeGreaterThanOrEqual(20);
  const first = pubs[0];
  expect(first.slug).toMatch(/^[a-z0-9-]+$/);
  expect(first.name.length).toBeGreaterThan(0);
});

test('every pub has a subdomain URL derivable from slug', () => {
  const pubs = parseWarsawIndex(html);
  for (const p of pubs) expect(p.slug).not.toContain('/');
});
```

- [ ] **Step 3: Fail** — `npx jest src/sources/ontap/index.test.ts`.

- [ ] **Step 4: Implement**

> Exact CSS selectors depend on `tests/fixtures/ontap/warszawa-index.html`. Open it,
> locate the repeating pub link element (each Warsaw pub is rendered as `<a href="https://<slug>.ontap.pl/">…</a>`),
> and adapt the selector below to match. Start with `a[href*=".ontap.pl"]` and narrow.

```ts
// src/sources/ontap/index.ts
import * as cheerio from 'cheerio';

export interface IndexPub {
  slug: string;
  name: string;
  taps: number | null;
}

export function parseWarsawIndex(html: string): IndexPub[] {
  const $ = cheerio.load(html);
  const pubs = new Map<string, IndexPub>();

  $('a[href*=".ontap.pl"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/^https?:\/\/([a-z0-9-]+)\.ontap\.pl\/?$/i);
    if (!m) return;
    const slug = m[1].toLowerCase();
    if (slug === 'www' || slug === 'ontap' || slug === '') return;

    const name = $(el).text().trim().replace(/\s+/g, ' ');
    if (!name) return;

    const tapText = $(el).closest('li, .pub, .tile, .card').text();
    const tapsMatch = tapText.match(/(\d+)\s*taps?/i);
    const taps = tapsMatch ? parseInt(tapsMatch[1], 10) : null;

    if (!pubs.has(slug)) pubs.set(slug, { slug, name, taps });
  });

  return Array.from(pubs.values());
}
```

- [ ] **Step 5: Pass** — run and iterate selectors until green.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/ontap/warszawa-index.html src/sources/ontap/index.ts src/sources/ontap/index.test.ts
git commit -m "feat(sources/ontap): parse Warsaw index page"
```

---

## Task 11: `sources/ontap/pub.ts` — parse a single pub page

**Files:**
- Create: `tests/fixtures/ontap/beer-bones.html`, `src/sources/ontap/pub.ts`
- Test: `src/sources/ontap/pub.test.ts`

- [ ] **Step 1: Capture fixture**

```bash
curl -sL --compressed 'https://beer-bones.ontap.pl/' -o tests/fixtures/ontap/beer-bones.html
```

- [ ] **Step 2: Failing test**

```ts
// src/sources/ontap/pub.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { parsePubPage } from './pub';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/ontap/beer-bones.html'),
  'utf8',
);

test('parses pub metadata', () => {
  const result = parsePubPage(html);
  expect(result.pub.name).toMatch(/beer.*bones/i);
  expect(result.pub.address).toMatch(/Żurawia/);
  expect(result.pub.lat).toBeCloseTo(52.228, 2);
  expect(result.pub.lon).toBeCloseTo(21.013, 2);
});

test('parses taps with beer_ref and abv', () => {
  const { taps } = parsePubPage(html);
  expect(taps.length).toBeGreaterThanOrEqual(10);
  const withAbv = taps.filter((t) => t.abv !== null);
  expect(withAbv.length).toBeGreaterThan(0);
  for (const t of taps) expect(t.beer_ref.length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Fail** — run test.

- [ ] **Step 4: Implement**

> Open the fixture, find the repeating tap row (typical ontap layout: `<div class="tap">` or `<tr>`),
> adjust selectors below. The coordinates live in a Google-Maps link like
> `href="https://maps.google.com/?q=52.228,21.013"` or `?ll=...`.

```ts
// src/sources/ontap/pub.ts
import * as cheerio from 'cheerio';

export interface ParsedPub {
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
}

export interface ParsedTap {
  tap_number: number | null;
  beer_ref: string;
  brewery_ref: string | null;
  abv: number | null;
  ibu: number | null;
  style: string | null;
  u_rating: number | null;
}

export interface ParsedPubPage {
  pub: ParsedPub;
  taps: ParsedTap[];
}

export function parsePubPage(html: string): ParsedPubPage {
  const $ = cheerio.load(html);

  const name = ($('h1').first().text() || $('title').text()).trim();
  const address = textNear($, /ul|addres|street|adres/i) ?? null;

  let lat: number | null = null;
  let lon: number | null = null;
  $('a[href*="maps.google"], a[href*="google.com/maps"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/([\-]?\d+\.\d+)[, ]+([\-]?\d+\.\d+)/);
    if (m) { lat = parseFloat(m[1]); lon = parseFloat(m[2]); }
  });

  const taps: ParsedTap[] = [];
  $('.tap, tr.tap, li.tap, [class*="tap-row"]').each((_, el) => {
    const row = $(el);
    const numTxt = row.find('[class*="tap-num"], .number').first().text();
    const tap_number = numTxt ? parseInt(numTxt.replace(/\D/g, ''), 10) || null : null;

    const nameBlock = row.find('[class*="beer"], .name').first().text().trim().replace(/\s+/g, ' ');
    if (!nameBlock) return;

    const rowText = row.text();
    const abvMatch = rowText.match(/(\d+(?:\.\d+)?)\s*%/);
    const ibuMatch = rowText.match(/\bIBU[:\s]*(\d+(?:\.\d+)?)/i);
    const ratingMatch = rowText.match(/u:\s*(\d+(?:\.\d+)?)/i);
    const styleMatch = rowText.match(/Style:\s*([^\n,]+)/i);

    const [brewery, ...rest] = nameBlock.split(/[—-]\s|:\s/);
    const beer_ref = nameBlock;
    const brewery_ref = rest.length ? brewery.trim() : null;

    taps.push({
      tap_number,
      beer_ref,
      brewery_ref,
      abv: abvMatch ? parseFloat(abvMatch[1]) : null,
      ibu: ibuMatch ? parseFloat(ibuMatch[1]) : null,
      style: styleMatch ? styleMatch[1].trim() : null,
      u_rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
    });
  });

  return { pub: { name, address, lat, lon }, taps };
}

function textNear($: cheerio.CheerioAPI, re: RegExp): string | null {
  let found: string | null = null;
  $('p, span, div').each((_, el) => {
    const classes = ($(el).attr('class') ?? '').toLowerCase();
    if (re.test(classes)) {
      const t = $(el).text().trim().replace(/\s+/g, ' ');
      if (t) { found = t; return false; }
    }
  });
  return found;
}
```

- [ ] **Step 5: Pass** — iterate on selectors until the two tests are green.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/ontap/beer-bones.html src/sources/ontap/pub.ts src/sources/ontap/pub.test.ts
git commit -m "feat(sources/ontap): parse pub subdomain page"
```

---

## Task 12: `sources/untappd/export.ts` — CSV/JSON/ZIP streaming parser

Untappd видає історію чекінів у CSV **або** JSON, причому файли бувають
великі (спостерігали 15 MB JSON / ~1.9 MB у ZIP). Отже парсер:

1. визначає формат за іменем файлу (`.csv` | `.json` | `.zip`);
2. якщо `.zip` — розпаковує перший `.csv`/`.json` всередині;
3. повертає **`AsyncIterable<Checkin>`** — жодного `JSON.parse` на весь файл
   і жодного `readFileSync` у пам'ять.

**Files:**
- Create: `tests/fixtures/untappd/export.csv`,
  `tests/fixtures/untappd/export.json`,
  `tests/fixtures/untappd/export.zip`,
  `src/sources/untappd/export.ts`
- Test: `src/sources/untappd/export.test.ts`

- [ ] **Step 1: Write tiny CSV fixture**

```csv
beer_name,brewery_name,beer_type,beer_abv,rating_score,created_at,venue_name,checkin_id,bid
Atak Chmielu,Pinta,American IPA,6.1,4.25,2024-03-01 20:12:00,Beer & Bones,1234,567
Buty Skejta,Stu Mostow,Pilsner,5.0,3.75,2024-03-10 19:55:00,,2345,890
```

- [ ] **Step 2: Write matching JSON fixture** (same two checkins — Untappd JSON is a flat array)

```json
[
  {
    "beer_name": "Atak Chmielu",
    "brewery_name": "Pinta",
    "beer_type": "American IPA",
    "beer_abv": 6.1,
    "rating_score": 4.25,
    "created_at": "2024-03-01 20:12:00",
    "venue_name": "Beer & Bones",
    "checkin_id": 1234,
    "bid": 567
  },
  {
    "beer_name": "Buty Skejta",
    "brewery_name": "Stu Mostow",
    "beer_type": "Pilsner",
    "beer_abv": 5.0,
    "rating_score": 3.75,
    "created_at": "2024-03-10 19:55:00",
    "venue_name": "",
    "checkin_id": 2345,
    "bid": 890
  }
]
```

Note: у реальному експорті Untappd `checkin_id` приходить числом у JSON і
рядком у CSV — парсер нормалізує обидва варіанти до `string`.

- [ ] **Step 3: Create ZIP fixture from JSON**

```bash
cd tests/fixtures/untappd
zip -j export.zip export.json
cd -
```

Фікстура — бінарна, але крихітна (~0.5 KB) і перевіряється в репо разом з
рештою. Якщо потрібно перегенерувати — команда вище детермінована.

- [ ] **Step 4: Failing test**

```ts
// src/sources/untappd/export.test.ts
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { iterExport, detectFormat } from './export';

const fx = (n: string) => path.join(__dirname, '../../../tests/fixtures/untappd', n);

async function collect(fmt: 'csv' | 'json' | 'zip', file: string) {
  const stream = Readable.from(fs.readFileSync(file));
  const out = [];
  for await (const r of iterExport(stream, fmt)) out.push(r);
  return out;
}

test('detectFormat maps extensions', () => {
  expect(detectFormat('x.CSV')).toBe('csv');
  expect(detectFormat('x.json')).toBe('json');
  expect(detectFormat('x.zip')).toBe('zip');
  expect(() => detectFormat('x.txt')).toThrow();
});

test('parses CSV fixture', async () => {
  const rows = await collect('csv', fx('export.csv'));
  expect(rows).toHaveLength(2);
  expect(rows[0].checkin_id).toBe('1234');
  expect(rows[0].beer_name).toBe('Atak Chmielu');
  expect(rows[0].rating_score).toBe(4.25);
  expect(rows[1].venue_name).toBeNull();
});

test('parses JSON fixture with same shape as CSV', async () => {
  const rows = await collect('json', fx('export.json'));
  expect(rows).toHaveLength(2);
  expect(rows[0].checkin_id).toBe('1234');
  expect(rows[0].bid).toBe(567);
  expect(rows[1].venue_name).toBeNull(); // empty string → null
});

test('parses ZIP fixture (unwraps inner json)', async () => {
  const rows = await collect('zip', fx('export.zip'));
  expect(rows).toHaveLength(2);
  expect(rows[0].beer_name).toBe('Atak Chmielu');
});
```

- [ ] **Step 5: Fail** — `npx jest src/sources/untappd/export.test.ts`.

- [ ] **Step 6: Implement**

```ts
// src/sources/untappd/export.ts
import { Readable } from 'node:stream';
import { parse as csvParse } from 'csv-parse';
import { parser as jsonParser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import yauzl from 'yauzl';

export interface Checkin {
  checkin_id: string;
  bid: number | null;
  beer_name: string;
  brewery_name: string;
  beer_type: string | null;
  beer_abv: number | null;
  rating_score: number | null;
  created_at: string;
  venue_name: string | null;
}

export type ExportFormat = 'csv' | 'json' | 'zip';

export function detectFormat(filename: string): ExportFormat {
  const n = filename.toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.json')) return 'json';
  if (n.endsWith('.csv')) return 'csv';
  throw new Error(`Unsupported export format: ${filename}`);
}

export async function* iterExport(
  input: Readable,
  format: ExportFormat,
): AsyncGenerator<Checkin> {
  if (format === 'zip') {
    const inner = await openInnerFromZip(input);
    yield* iterExport(inner.stream, inner.format);
    return;
  }
  if (format === 'csv') {
    const parser = input.pipe(csvParse({ columns: true, skip_empty_lines: true, trim: true }));
    for await (const r of parser) yield mapCsv(r as Record<string, string>);
    return;
  }
  const pipeline = input.pipe(jsonParser()).pipe(streamArray());
  for await (const chunk of pipeline as AsyncIterable<{ value: Record<string, unknown> }>) {
    yield mapJson(chunk.value);
  }
}

function mapCsv(r: Record<string, string>): Checkin {
  return {
    checkin_id: r['checkin_id'],
    bid: numOrNull(r['bid']),
    beer_name: r['beer_name'],
    brewery_name: r['brewery_name'],
    beer_type: blankNull(r['beer_type']),
    beer_abv: numOrNull(r['beer_abv']),
    rating_score: numOrNull(r['rating_score']),
    created_at: r['created_at'],
    venue_name: blankNull(r['venue_name']),
  };
}

function mapJson(r: Record<string, unknown>): Checkin {
  return {
    checkin_id: String(r['checkin_id']),
    bid: numOrNull(r['bid']),
    beer_name: String(r['beer_name'] ?? ''),
    brewery_name: String(r['brewery_name'] ?? ''),
    beer_type: blankNull(r['beer_type']),
    beer_abv: numOrNull(r['beer_abv']),
    rating_score: numOrNull(r['rating_score']),
    created_at: String(r['created_at'] ?? ''),
    venue_name: blankNull(r['venue_name']),
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function blankNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

async function streamToBuffer(rs: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of rs) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function openInnerFromZip(
  input: Readable,
): Promise<{ stream: Readable; format: 'csv' | 'json' }> {
  return streamToBuffer(input).then(
    (buf) =>
      new Promise((resolve, reject) => {
        yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
          if (err || !zip) return reject(err ?? new Error('bad zip'));
          zip.on('error', reject);
          zip.on('entry', (entry) => {
            if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
            const name = entry.fileName.toLowerCase();
            const fmt = name.endsWith('.json') ? 'json' : name.endsWith('.csv') ? 'csv' : null;
            if (!fmt) { zip.readEntry(); return; }
            zip.openReadStream(entry, (e, rs) => {
              if (e || !rs) return reject(e ?? new Error('zip entry unreadable'));
              resolve({ stream: rs, format: fmt });
            });
          });
          zip.on('end', () => reject(new Error('ZIP has no .csv or .json entry')));
          zip.readEntry();
        });
      }),
  );
}
```

- [ ] **Step 7: Pass** — re-run test.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/untappd/export.csv \
        tests/fixtures/untappd/export.json \
        tests/fixtures/untappd/export.zip \
        src/sources/untappd/export.ts \
        src/sources/untappd/export.test.ts
git commit -m "feat(sources/untappd): streaming CSV/JSON/ZIP export parser"
```

---

## Task 13: `sources/untappd/scraper.ts` — last 25 check-ins from public profile

**Files:**
- Create: `tests/fixtures/untappd/user-beer.html`, `src/sources/untappd/scraper.ts`
- Test: `src/sources/untappd/scraper.test.ts`

- [ ] **Step 1: Capture fixture** (use a known public profile, e.g. the one you'll test against)

```bash
curl -sL --compressed -A 'warsaw-beer-bot (contact@example.com)' \
  'https://untappd.com/user/REPLACE_ME/beer' \
  -o tests/fixtures/untappd/user-beer.html
```

If capture returns 0 bytes or a login wall, abort and consult the user — this confirms
the public-profile assumption for Q1.

- [ ] **Step 2: Failing test**

```ts
// src/sources/untappd/scraper.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { parseUserBeerPage } from './scraper';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/untappd/user-beer.html'),
  'utf8',
);

test('extracts at most 25 checkins with name + brewery + date', () => {
  const items = parseUserBeerPage(html);
  expect(items.length).toBeGreaterThan(0);
  expect(items.length).toBeLessThanOrEqual(25);
  for (const c of items) {
    expect(c.beer_name.length).toBeGreaterThan(0);
    expect(c.brewery_name.length).toBeGreaterThan(0);
    expect(c.checkin_id.length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 3: Fail** — run test.

- [ ] **Step 4: Implement**

> Inspect the captured HTML. Untappd renders each beer card with a data attribute such as
> `data-bid` or a unique `data-checkin-id`; the beer name is in `.beer-details .name a`,
> the brewery in `.brewery a`. Adjust selectors to what the real HTML shows.

```ts
// src/sources/untappd/scraper.ts
import * as cheerio from 'cheerio';

export interface ScrapedCheckin {
  checkin_id: string;
  beer_name: string;
  brewery_name: string;
  rating_score: number | null;
  checkin_at: string;
  bid: number | null;
}

export function parseUserBeerPage(html: string): ScrapedCheckin[] {
  const $ = cheerio.load(html);
  const out: ScrapedCheckin[] = [];

  $('[data-checkin-id], .item.beer-item, li.item, .checkin-row').each((_, el) => {
    const row = $(el);
    const checkin_id =
      row.attr('data-checkin-id') ??
      row.find('[data-checkin-id]').attr('data-checkin-id') ??
      row.find('a[href*="/c/"]').attr('href')?.split('/c/').pop() ?? '';
    if (!checkin_id) return;

    const beer_name = row.find('.beer-details .name a, .name a, .beer-name').first().text().trim();
    const brewery_name = row.find('.brewery a, .brewery').first().text().trim();
    const rating =
      row.find('[class*="rating"] .num, [class*="caps-"]').attr('data-rating') ??
      row.find('.rating .num').first().text().replace(/[()]/g, '');
    const rating_score = rating && !isNaN(parseFloat(rating)) ? parseFloat(rating) : null;
    const checkin_at =
      row.find('time').attr('datetime') ??
      row.find('.time, .date').first().text().trim();
    const bidAttr = row.attr('data-bid') ?? row.find('[data-bid]').attr('data-bid');
    const bid = bidAttr ? parseInt(bidAttr, 10) : null;

    if (!beer_name || !brewery_name) return;

    out.push({ checkin_id, beer_name, brewery_name, rating_score, checkin_at, bid });
    if (out.length >= 25) return false;
  });

  return out;
}
```

- [ ] **Step 5: Pass** — iterate selectors until green.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/untappd/user-beer.html src/sources/untappd/scraper.ts src/sources/untappd/scraper.test.ts
git commit -m "feat(sources/untappd): scrape last 25 checkins from public profile"
```

---

## Task 14: `sources/geocoder.ts` — Nominatim fallback

**Files:**
- Create: `src/sources/geocoder.ts`
- Test: `src/sources/geocoder.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/sources/geocoder.test.ts
import { createGeocoder } from './geocoder';

test('geocodes an address via injected fetch', async () => {
  const fakeFetch: typeof fetch = async (url) => {
    expect(String(url)).toMatch(/nominatim/);
    return new Response(JSON.stringify([{ lat: '52.23', lon: '21.01' }]), { status: 200 });
  };
  const geo = createGeocoder({ userAgent: 'ua', fetchImpl: fakeFetch });
  const coords = await geo('Żurawia 32, Warszawa');
  expect(coords).toEqual({ lat: 52.23, lon: 21.01 });
});

test('returns null on empty result', async () => {
  const fakeFetch: typeof fetch = async () => new Response('[]', { status: 200 });
  const geo = createGeocoder({ userAgent: 'ua', fetchImpl: fakeFetch });
  expect(await geo('nowhere')).toBeNull();
});
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement**

```ts
// src/sources/geocoder.ts
export interface Coords { lat: number; lon: number; }

export type Geocoder = (address: string) => Promise<Coords | null>;

export function createGeocoder(opts: { userAgent: string; fetchImpl?: typeof fetch }): Geocoder {
  const f = opts.fetchImpl ?? fetch;
  return async (address) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const res = await f(url, { headers: { 'User-Agent': opts.userAgent } });
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const body = (await res.json()) as { lat: string; lon: string }[];
    if (!body.length) return null;
    return { lat: parseFloat(body[0].lat), lon: parseFloat(body[0].lon) };
  };
}
```

- [ ] **Step 4: Pass** — re-run.

- [ ] **Step 5: Commit**

```bash
git add src/sources/geocoder.ts src/sources/geocoder.test.ts
git commit -m "feat(sources): nominatim geocoder fallback"
```

---

## Task 15: `domain/normalize.ts` — shared string helpers

**Files:**
- Create: `src/domain/normalize.ts`
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/domain/normalize.test.ts
import { normalizeName, normalizeBrewery } from './normalize';

test('lowercases and strips diacritics', () => {
  expect(normalizeName('Atak Chmielu — Imperial')).toBe('atak chmielu');
  expect(normalizeName('Łyso Pysk')).toBe('lyso pysk');
});

test('removes common style noise', () => {
  expect(normalizeName('Piwo IPA (session)')).toBe('piwo');
  expect(normalizeName('Double Dry Hopped NEIPA Hopinka')).toBe('hopinka');
});

test('normalizes brewery the same way, no style stripping', () => {
  expect(normalizeBrewery('Browar Stu Mostów')).toBe('stu mostow');
});
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement**

```ts
// src/domain/normalize.ts
const STYLE_WORDS = new Set([
  'ipa', 'apa', 'neipa', 'dipa', 'tipa', 'aipa', 'neneipa',
  'imperial', 'double', 'triple', 'session', 'dry', 'hopped', 'dh', 'ddh',
  'pils', 'pilsner', 'lager', 'stout', 'porter', 'weizen', 'wheat',
  'saison', 'sour', 'gose', 'lambic', 'barleywine', 'bock',
]);
const BREWERY_NOISE = new Set(['browar', 'brewery', 'brewing', 'co', 'company']);

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/gi, (m) => (m === 'Ł' ? 'L' : 'l'));
}

function baseNormalize(s: string): string {
  return stripDiacritics(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeName(s: string): string {
  const tokens = baseNormalize(s).split(' ').filter((t) => t && !STYLE_WORDS.has(t));
  return tokens.join(' ');
}

export function normalizeBrewery(s: string): string {
  const tokens = baseNormalize(s).split(' ').filter((t) => t && !BREWERY_NOISE.has(t));
  return tokens.join(' ');
}
```

- [ ] **Step 4: Pass** — iterate style list until tests go green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "feat(domain): string normalization helpers"
```

---

## Task 16: `domain/matcher.ts` — exact + fuzzy beer matching

**Files:**
- Create: `src/domain/matcher.ts`
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/domain/matcher.test.ts
import { matchBeer } from './matcher';

const catalog = [
  { id: 1, brewery: 'Pinta', name: 'Atak Chmielu' },
  { id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta' },
  { id: 3, brewery: 'Piwne Podziemie', name: 'Hopinka' },
];

test('exact normalized match is confidence 1', () => {
  const m = matchBeer({ brewery: 'PINTA', name: 'Atak Chmielu IPA' }, catalog);
  expect(m).toEqual({ id: 1, confidence: 1, source: 'exact' });
});

test('fuzzy match above threshold returns 0.85..1 confidence', () => {
  const m = matchBeer({ brewery: 'Stu Mostow', name: 'Buty Skejty' }, catalog);
  expect(m?.id).toBe(2);
  expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
  expect(m!.confidence).toBeLessThan(1);
});

test('no match below threshold returns null', () => {
  expect(matchBeer({ brewery: 'Random', name: 'Xyz' }, catalog)).toBeNull();
});
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement**

```ts
// src/domain/matcher.ts
import { Searcher } from 'fast-fuzzy';
import { normalizeName, normalizeBrewery } from './normalize';

export interface CatalogBeer { id: number; brewery: string; name: string; }
export interface MatchResult { id: number; confidence: number; source: 'exact' | 'fuzzy'; }

const FUZZY_THRESHOLD = 0.85;

export function matchBeer(
  input: { brewery: string; name: string },
  catalog: CatalogBeer[],
): MatchResult | null {
  const nb = normalizeBrewery(input.brewery);
  const nn = normalizeName(input.name);

  const exact = catalog.find(
    (c) => normalizeBrewery(c.brewery) === nb && normalizeName(c.name) === nn,
  );
  if (exact) return { id: exact.id, confidence: 1, source: 'exact' };

  const pool = catalog.filter((c) => normalizeBrewery(c.brewery) === nb);
  const candidates = pool.length ? pool : catalog;
  const searcher = new Searcher(candidates, {
    keySelector: (c) => `${normalizeBrewery(c.brewery)} ${normalizeName(c.name)}`,
    threshold: FUZZY_THRESHOLD,
    returnMatchData: true,
  });
  const results = searcher.search(`${nb} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}
```

- [ ] **Step 4: Pass** — re-run. If fuzzy doesn't hit on "Buty Skejty" → "Buty Skejta", lower threshold or switch to token-set ratio.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(domain): beer matcher — exact + fuzzy fallback"
```

---

## Task 17: `domain/filters.ts` — interesting(p) and ranking

**Files:**
- Create: `src/domain/filters.ts`
- Test: `src/domain/filters.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/domain/filters.test.ts
import { filterInteresting, rankByRating } from './filters';

const taps = [
  { beer_id: 1, style: 'IPA',   abv: 6.1, u_rating: 4.0 },
  { beer_id: 2, style: 'Pils',  abv: 5.0, u_rating: 3.5 },
  { beer_id: 3, style: 'IPA',   abv: 7.5, u_rating: 3.9 },
  { beer_id: null, style: 'x', abv: 4,   u_rating: 3.0 },
];
const drunk = new Set([1]);

test('filterInteresting respects checkins + style + rating + abv', () => {
  const out = filterInteresting(taps, drunk, {
    styles: ['IPA'], min_rating: 3.8, abv_min: 4, abv_max: 8,
  });
  expect(out.map((t) => t.beer_id)).toEqual([3]);
});

test('rankByRating sorts desc and breaks ties by beer_id', () => {
  const sorted = rankByRating([
    { beer_id: 1, u_rating: 3.5 }, { beer_id: 2, u_rating: 4.0 },
    { beer_id: 3, u_rating: 4.0 },
  ]);
  expect(sorted.map((t) => t.beer_id)).toEqual([2, 3, 1]);
});
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement**

```ts
// src/domain/filters.ts
export interface TapView {
  beer_id: number | null;
  style: string | null;
  abv: number | null;
  u_rating: number | null;
}

export interface FilterOpts {
  styles?: string[];
  min_rating?: number | null;
  abv_min?: number | null;
  abv_max?: number | null;
}

export function filterInteresting<T extends TapView>(
  taps: T[], drunk: Set<number>, opts: FilterOpts,
): T[] {
  return taps.filter((t) => {
    if (t.beer_id == null) return false;
    if (drunk.has(t.beer_id)) return false;
    if (opts.min_rating != null && (t.u_rating ?? 0) < opts.min_rating) return false;
    if (opts.abv_min != null && (t.abv ?? 0) < opts.abv_min) return false;
    if (opts.abv_max != null && (t.abv ?? 0) > opts.abv_max) return false;
    if (opts.styles && opts.styles.length) {
      const s = (t.style ?? '').toLowerCase();
      if (!opts.styles.some((x) => s.includes(x.toLowerCase()))) return false;
    }
    return true;
  });
}

export function rankByRating<T extends { beer_id: number | null; u_rating: number | null }>(
  taps: T[],
): T[] {
  return [...taps].sort(
    (a, b) => (b.u_rating ?? 0) - (a.u_rating ?? 0) || (a.beer_id ?? 0) - (b.beer_id ?? 0),
  );
}
```

- [ ] **Step 4: Pass** — re-run.

- [ ] **Step 5: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "feat(domain): interesting-filter + rating rank"
```

---

## Task 18: `domain/router.ts` — set-cover + local swap + open-TSP + distance matrix

**Files:**
- Create: `src/domain/router.ts`
- Test: `src/domain/router.test.ts`

- [ ] **Step 1: Failing test (set cover + TSP on a toy instance)**

```ts
// src/domain/router.test.ts
import { buildRoute, haversineMeters } from './router';

const pubs = [
  { id: 1, lat: 0, lon: 0,   interesting: new Set([10, 11]) },
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
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement**

```ts
// src/domain/router.ts
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
  const picked: RoutePub[] = []; const covered = new Set<number>(); let remaining = [...pubs];
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
```

- [ ] **Step 4: Pass** — re-run.

- [ ] **Step 5: Add distance provider with OSRM (new file, same module)**

```ts
// append to src/domain/router.ts
export function createOsrmDistance(base: string, fetchImpl: typeof fetch = fetch) {
  return async (a: [number, number], b: [number, number]): Promise<number> => {
    const url = `${base}/route/v1/foot/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const body = (await res.json()) as { routes?: { distance: number }[] };
    return body.routes?.[0]?.distance ?? haversineMeters(a, b);
  };
}
```

Note: `buildRoute` uses a synchronous distance fn. Pre-compute an N×N matrix
upstream (in the caller, `bot/commands/route.ts`) by calling OSRM or haversine
once per pair, then pass a closure `(a, b) => matrix[idx(a)][idx(b)]`.

- [ ] **Step 6: Commit**

```bash
git add src/domain/router.ts src/domain/router.test.ts
git commit -m "feat(domain): greedy set-cover + local-swap + open-TSP router"
```

---

## Task 19: `bot/index.ts` — Telegraf bootstrap + keyboards

**Files:**
- Create: `src/bot/index.ts`, `src/bot/keyboards.ts`

- [ ] **Step 1: Implement `keyboards.ts`**

```ts
// src/bot/keyboards.ts
import { Markup } from 'telegraf';

export const filtersKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('IPA', 'style:IPA'), Markup.button.callback('Pils', 'style:Pils')],
    [Markup.button.callback('Stout', 'style:Stout'), Markup.button.callback('Sour', 'style:Sour')],
    [Markup.button.callback('min 3.5', 'rating:3.5'), Markup.button.callback('min 3.8', 'rating:3.8')],
    [Markup.button.callback('Скинути', 'reset')],
  ]);
```

- [ ] **Step 2: Implement `bot/index.ts`**

```ts
// src/bot/index.ts
import { Telegraf, Context } from 'telegraf';
import type { DB } from '../storage/db';
import type { Env } from '../config/env';
import type pino from 'pino';

export interface AppDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
}

export interface BotContext extends Context { deps: AppDeps; }

export function createBot(deps: AppDeps): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(deps.env.TELEGRAM_BOT_TOKEN);
  bot.use((ctx, next) => { ctx.deps = deps; return next(); });
  bot.catch((err, ctx) => deps.log.error({ err, update: ctx.update }, 'bot error'));
  return bot;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/bot/index.ts src/bot/keyboards.ts
git commit -m "feat(bot): telegraf bootstrap + filters keyboard"
```

---

## Task 20: `bot/commands/start.ts` + `bot/commands/link.ts`

**Files:**
- Create: `src/bot/commands/start.ts`, `src/bot/commands/link.ts`
- Test: `src/bot/commands/link.test.ts` (logic only)

- [ ] **Step 1: Failing test for `link` username validation**

```ts
// src/bot/commands/link.test.ts
import { parseLinkArgs } from './link';

test('accepts a bare username', () => {
  expect(parseLinkArgs('yuriy')).toEqual({ username: 'yuriy' });
});
test('accepts a full URL', () => {
  expect(parseLinkArgs('https://untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
});
test('rejects empty or junk', () => {
  expect(parseLinkArgs('')).toBeNull();
  expect(parseLinkArgs('not a username!')).toBeNull();
});
```

- [ ] **Step 2: Fail** — run test.

- [ ] **Step 3: Implement `link.ts`**

```ts
// src/bot/commands/link.ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';

export function parseLinkArgs(raw: string): { username: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(?:https?:\/\/(?:www\.)?untappd\.com\/user\/)?([A-Za-z0-9_.-]{2,30})\/?$/);
  return m ? { username: m[1] } : null;
}

export const linkCommand = new Composer<BotContext>();

linkCommand.command('link', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ');
  const parsed = parseLinkArgs(arg);
  if (!parsed) {
    await ctx.reply('Використання: /link <username> (або повний URL untappd.com/user/<username>)');
    return;
  }
  ensureProfile(ctx.deps.db, ctx.from.id);
  setUntappdUsername(ctx.deps.db, ctx.from.id, parsed.username);
  await ctx.reply(`✅ Прив'язано до untappd.com/user/${parsed.username}`);
});
```

- [ ] **Step 4: Pass** — run test.

- [ ] **Step 5: Implement `start.ts`**

```ts
// src/bot/commands/start.ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile } from '../../storage/user_profiles';

export const startCommand = new Composer<BotContext>();

startCommand.command('start', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  await ctx.reply(
    [
      'Привіт! Я допоможу зібрати маршрут по варшавських пабах і випити щось нове.',
      '',
      '1) /link <untappd-username> — щоб підтягувати твої чекіни.',
      '2) /import — завантаж CSV-експорт зі свого Untappd для повного бекфілу історії.',
      '3) /newbeers — топ непитих пив на поточних кранах.',
      '4) /route N — маршрут, що покриває ≥ N непитих пив із мінімальною пішою відстанню.',
    ].join('\n'),
  );
});
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/start.ts src/bot/commands/link.ts src/bot/commands/link.test.ts
git commit -m "feat(bot): /start and /link commands"
```

---

## Task 21: `bot/commands/import.ts` — Untappd upload handler

Приймає CSV / JSON / ZIP-експорт з Untappd. Streaming-парсер з Task 12 +
батчинг у `db.transaction` + періодичний `editMessageText` для прогресу,
щоб великі імпорти (спостерігали 15 MB JSON / ~десятки тисяч чекінів)
не блокували event loop і не мовчали у чаті.

**Files:**
- Create: `src/bot/commands/import.ts`

Нотатки по обмеженнях Telegram Bot API:
- `getFile` віддає файли до **20 MB**. 15 MB JSON пролазить, але на межі —
  ZIP-ом набагато комфортніше.
- Якщо `file_size > 20 MB` — одразу просимо перезапакувати в ZIP.

- [ ] **Step 1: Implement**

```ts
// src/bot/commands/import.ts
import { Composer } from 'telegraf';
import { Readable } from 'node:stream';
import type { BotContext } from '../index';
import {
  iterExport, detectFormat, type Checkin, type ExportFormat,
} from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { ensureProfile } from '../../storage/user_profiles';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

const BATCH_SIZE = 500;
const PROGRESS_INTERVAL_MS = 2000;
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024; // Bot API getFile cap

export const importCommand = new Composer<BotContext>();

importCommand.command('import', async (ctx) => {
  await ctx.reply(
    'Надішли експорт з Untappd: CSV, JSON або ZIP (до 20 MB).\n' +
    'Supporter → Account → Download History. Великий JSON краще запакувати в ZIP.',
  );
});

importCommand.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const name = doc.file_name ?? '';

  let format: ExportFormat;
  try { format = detectFormat(name); }
  catch {
    await ctx.reply('Формат не підтримується. Очікую .csv, .json або .zip.');
    return;
  }

  if (doc.file_size && doc.file_size > TG_DOWNLOAD_LIMIT) {
    await ctx.reply(
      'Файл > 20 MB — Telegram не дасть боту його скачати. ' +
      'Запакуй JSON у ZIP (стискається ≈10×) і надішли ще раз.',
    );
    return;
  }

  ensureProfile(ctx.deps.db, ctx.from.id);

  const link = await ctx.telegram.getFileLink(doc.file_id);
  const res = await fetch(link.toString());
  if (!res.ok || !res.body) {
    await ctx.reply('Не вдалось отримати файл з Telegram.');
    return;
  }
  const stream = Readable.fromWeb(res.body as never);

  const progress = await ctx.reply('⏳ Починаю імпорт…');
  const db = ctx.deps.db;
  const telegramId = ctx.from.id;

  const flushBatch = db.transaction((rows: Checkin[]) => {
    for (const r of rows) {
      const beerId = upsertBeer(db, {
        untappd_id: r.bid ?? null,
        name: r.beer_name,
        brewery: r.brewery_name,
        style: r.beer_type,
        abv: r.beer_abv,
        rating_global: null,
        normalized_name: normalizeName(r.beer_name),
        normalized_brewery: normalizeBrewery(r.brewery_name),
      });
      mergeCheckin(db, {
        checkin_id: r.checkin_id,
        telegram_id: telegramId,
        beer_id: beerId,
        user_rating: r.rating_score,
        checkin_at: r.created_at,
        venue: r.venue_name,
      });
    }
  });

  let total = 0;
  let batch: Checkin[] = [];
  let lastReport = Date.now();

  const report = async (text: string) => {
    await ctx.telegram
      .editMessageText(ctx.chat.id, progress.message_id, undefined, text)
      .catch(() => {});
  };

  try {
    for await (const row of iterExport(stream, format)) {
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        flushBatch(batch);
        total += batch.length;
        batch = [];
        if (Date.now() - lastReport > PROGRESS_INTERVAL_MS) {
          lastReport = Date.now();
          await report(`⏳ Імпортовано ${total}…`);
        }
      }
    }
    if (batch.length) { flushBatch(batch); total += batch.length; }
    await report(`✅ Імпортовано ${total} чекінів (${format.toUpperCase()}).`);
  } catch (e) {
    await report(`❌ Помилка після ${total} рядків: ${(e as Error).message}`);
    throw e;
  }
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` → PASS.

- [ ] **Step 3: Manual smoke (after Task 25 wires the bot)**

Надіслати боту три окремих файли з тестової фікстури Untappd і підтвердити, що:
- `.csv` імпортується, прогрес оновлюється;
- `.json` дає той самий підсумок;
- `.zip` (json всередині) — так само;
- `.txt` → повідомлення «Формат не підтримується»;
- файл `> 20 MB` → повідомлення про ZIP, скачування не починається.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/import.ts
git commit -m "feat(bot): /import streaming handler for CSV/JSON/ZIP Untappd export"
```

---

## Task 22: `bot/commands/newbeers.ts` + `bot/commands/route.ts`

**Files:**
- Create: `src/bot/commands/newbeers.ts`, `src/bot/commands/route.ts`

- [ ] **Step 1: Implement `newbeers.ts`**

```ts
// src/bot/commands/newbeers.ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { latestSnapshotsPerPub, tapsForSnapshot } from '../../storage/snapshots';
import { drunkBeerIds } from '../../storage/checkins';
import { getMatch } from '../../storage/match_links';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting, rankByRating } from '../../domain/filters';
import { listPubs } from '../../storage/pubs';

export const newbeersCommand = new Composer<BotContext>();

newbeersCommand.command('newbeers', async (ctx) => {
  const db = ctx.deps.db;
  const drunk = drunkBeerIds(db, ctx.from.id);
  const filters = getFilters(db, ctx.from.id) ?? {
    styles: [], min_rating: null, abv_min: null, abv_max: null, default_route_n: null,
  };
  const pubs = new Map(listPubs(db).map((p) => [p.id, p]));

  const ranked: { pubName: string; beer: string; rating: number | null }[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    const taps = tapsForSnapshot(db, snap.id).map((t) => ({
      beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
      style: t.style, abv: t.abv, u_rating: t.u_rating,
      beer_ref: t.beer_ref,
    }));
    const good = filterInteresting(taps, drunk, filters);
    for (const t of rankByRating(good).slice(0, 3)) {
      ranked.push({ pubName: pubs.get(snap.pub_id)!.name, beer: t.beer_ref, rating: t.u_rating });
    }
  }

  ranked.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const head = ranked.slice(0, 15).map((r) => `• ${r.beer} — ${r.pubName} (${r.rating ?? '—'})`);
  await ctx.reply(head.length ? head.join('\n') : 'Нічого цікавого — спробуй /refresh.');
});
```

- [ ] **Step 2: Implement `route.ts`** (pre-computes OSRM distance matrix with haversine fallback)

```ts
// src/bot/commands/route.ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { listPubs } from '../../storage/pubs';
import { latestSnapshotsPerPub, tapsForSnapshot } from '../../storage/snapshots';
import { drunkBeerIds } from '../../storage/checkins';
import { getMatch } from '../../storage/match_links';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting } from '../../domain/filters';
import { buildRoute, haversineMeters, createOsrmDistance, RoutePub } from '../../domain/router';

export const routeCommand = new Composer<BotContext>();

routeCommand.command('route', async (ctx) => {
  const db = ctx.deps.db;
  const arg = ctx.message.text.split(' ')[1];
  const N = parseInt(arg ?? '', 10) ||
    getFilters(db, ctx.from.id)?.default_route_n ||
    ctx.deps.env.DEFAULT_ROUTE_N;

  const drunk = drunkBeerIds(db, ctx.from.id);
  const filters = getFilters(db, ctx.from.id) ?? { styles: [], min_rating: null, abv_min: null, abv_max: null, default_route_n: null };
  const pubsById = new Map(listPubs(db).map((p) => [p.id, p]));

  const routePubs: RoutePub[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    const pub = pubsById.get(snap.pub_id);
    if (!pub || pub.lat == null || pub.lon == null) continue;
    const taps = tapsForSnapshot(db, snap.id).map((t) => ({
      beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
      style: t.style, abv: t.abv, u_rating: t.u_rating,
    }));
    const interesting = filterInteresting(taps, drunk, filters)
      .map((t) => t.beer_id!) as number[];
    if (!interesting.length) continue;
    routePubs.push({ id: pub.id, lat: pub.lat, lon: pub.lon, interesting: new Set(interesting) });
  }

  if (!routePubs.length) {
    await ctx.reply('Немає цікавих непитих пив у поточному snapshot.');
    return;
  }

  // Precompute N×N walking-distance matrix: OSRM primary, haversine fallback per pair.
  const osrm = createOsrmDistance(ctx.deps.env.OSRM_BASE_URL);
  const n = routePubs.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const coordKey = (lat: number, lon: number) => `${lat},${lon}`;
  const idxByCoord = new Map(routePubs.map((p, i) => [coordKey(p.lat, p.lon), i]));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a: [number, number] = [routePubs[i].lat, routePubs[i].lon];
      const b: [number, number] = [routePubs[j].lat, routePubs[j].lon];
      let d: number;
      try { d = await osrm(a, b); }
      catch (e) { ctx.deps.log.warn({ err: e }, 'osrm failed, haversine'); d = haversineMeters(a, b); }
      matrix[i][j] = d; matrix[j][i] = d;
    }
  }

  const distance = (a: [number, number], b: [number, number]): number => {
    const ia = idxByCoord.get(coordKey(a[0], a[1]));
    const ib = idxByCoord.get(coordKey(b[0], b[1]));
    if (ia === undefined || ib === undefined) return haversineMeters(a, b);
    return matrix[ia][ib];
  };

  const result = buildRoute(routePubs, N, { distance });
  const km = (result.distanceMeters / 1000).toFixed(1);
  const header = `Маршрут: ≥${N} нових пив, покрито ${result.coveredCount}, ≈ ${km} км, ${result.pubIds.length} пабів`;
  const lines = result.pubIds.map((id, i) => `${i + 1}. ${pubsById.get(id)!.name}`);
  await ctx.reply([header, '', ...lines].join('\n'));
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/newbeers.ts src/bot/commands/route.ts
git commit -m "feat(bot): /newbeers and /route commands"
```

---

## Task 23: `bot/commands/filters.ts` + `bot/commands/refresh.ts`

**Files:**
- Create: `src/bot/commands/filters.ts`, `src/bot/commands/refresh.ts`

- [ ] **Step 1: Implement `filters.ts`**

```ts
// src/bot/commands/filters.ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { filtersKeyboard } from '../keyboards';
import { getFilters, setFilters } from '../../storage/user_filters';
import { ensureProfile } from '../../storage/user_profiles';

export const filtersCommand = new Composer<BotContext>();

filtersCommand.command('filters', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const f = getFilters(ctx.deps.db, ctx.from.id);
  await ctx.reply(
    `Поточні: styles=${(f?.styles ?? []).join(',') || '—'}, min_rating=${f?.min_rating ?? '—'}`,
    filtersKeyboard(),
  );
});

filtersCommand.action(/style:(.+)/, async (ctx) => {
  const style = ctx.match[1];
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? { styles: [], min_rating: null, abv_min: null, abv_max: null, default_route_n: null };
  const styles = f.styles.includes(style) ? f.styles.filter((s) => s !== style) : [...f.styles, style];
  setFilters(ctx.deps.db, ctx.from!.id, { ...f, styles });
  await ctx.answerCbQuery(`styles=${styles.join(',') || '—'}`);
});

filtersCommand.action(/rating:(.+)/, async (ctx) => {
  const r = parseFloat(ctx.match[1]);
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? { styles: [], min_rating: null, abv_min: null, abv_max: null, default_route_n: null };
  setFilters(ctx.deps.db, ctx.from!.id, { ...f, min_rating: r });
  await ctx.answerCbQuery(`min_rating=${r}`);
});

filtersCommand.action('reset', async (ctx) => {
  setFilters(ctx.deps.db, ctx.from!.id, { styles: [], min_rating: null, abv_min: null, abv_max: null, default_route_n: null });
  await ctx.answerCbQuery('Скинуто');
});
```

- [ ] **Step 2: Implement `refresh.ts`** (manual kick, with a per-user rate limit in-memory)

```ts
// src/bot/commands/refresh.ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';

const COOLDOWN_MS = 5 * 60 * 1000;
const lastCall = new Map<number, number>();

export function createRefreshCommand(run: () => Promise<void>) {
  const cmd = new Composer<BotContext>();
  cmd.command('refresh', async (ctx) => {
    const prev = lastCall.get(ctx.from.id) ?? 0;
    if (Date.now() - prev < COOLDOWN_MS) {
      await ctx.reply('⏱ Занадто часто — спробуй за кілька хвилин.');
      return;
    }
    lastCall.set(ctx.from.id, Date.now());
    await ctx.reply('Оновлюю…');
    try {
      await run();
      await ctx.reply('✅ Готово.');
    } catch (e) {
      ctx.deps.log.error({ err: e }, 'refresh failed');
      await ctx.reply('❌ Не вдалось — подивись логи.');
    }
  });
  return cmd;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/filters.ts src/bot/commands/refresh.ts
git commit -m "feat(bot): /filters with inline toggles and /refresh with cooldown"
```

---

## Task 24: `jobs/refresh-ontap.ts` + `jobs/refresh-untappd.ts`

**Files:**
- Create: `src/jobs/refresh-ontap.ts`, `src/jobs/refresh-untappd.ts`

- [ ] **Step 1: Implement `refresh-ontap.ts`**

```ts
// src/jobs/refresh-ontap.ts
import type { DB } from '../storage/db';
import type pino from 'pino';
import type { Http } from '../sources/http';
import { parseWarsawIndex } from '../sources/ontap/index';
import { parsePubPage } from '../sources/ontap/pub';
import { upsertPub, listPubs, setPubCoords } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import { matchBeer } from '../domain/matcher';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { upsertBeer } from '../storage/beers';
import type { Geocoder } from '../sources/geocoder';

export async function refreshOntap(deps: {
  db: DB; log: pino.Logger; http: Http; geocoder: Geocoder;
}): Promise<void> {
  const { db, log, http, geocoder } = deps;
  const indexHtml = await http.get('https://ontap.pl/warszawa');
  const indexPubs = parseWarsawIndex(indexHtml);
  log.info({ n: indexPubs.length }, 'ontap index parsed');

  for (const ip of indexPubs) {
    try {
      const html = await http.get(`https://${ip.slug}.ontap.pl/`);
      const { pub, taps } = parsePubPage(html);
      let lat = pub.lat; let lon = pub.lon;
      if ((lat == null || lon == null) && pub.address) {
        const g = await geocoder(pub.address);
        if (g) { lat = g.lat; lon = g.lon; }
      }
      const pubId = upsertPub(db, { slug: ip.slug, name: pub.name || ip.name, address: pub.address, lat, lon });
      const snapshotId = createSnapshot(db, pubId, new Date().toISOString());
      insertTaps(db, snapshotId, taps);

      const catalog = listBeerCatalog(db);
      for (const t of taps) {
        const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
        const m = matchBeer({ brewery, name: t.beer_ref }, catalog);
        if (m) {
          upsertMatch(db, t.beer_ref, m.id, m.confidence);
        } else {
          const beerId = upsertBeer(db, {
            name: t.beer_ref, brewery, style: t.style,
            abv: t.abv, rating_global: t.u_rating,
            normalized_name: normalizeName(t.beer_ref),
            normalized_brewery: normalizeBrewery(brewery),
          });
          upsertMatch(db, t.beer_ref, beerId, 1.0);
        }
      }
    } catch (e) {
      log.warn({ err: e, slug: ip.slug }, 'ontap pub refresh failed');
    }
  }
}

function listBeerCatalog(db: DB) {
  return db.prepare('SELECT id, brewery, name FROM beers').all() as { id: number; brewery: string; name: string }[];
}
```

- [ ] **Step 2: Implement `refresh-untappd.ts`**

```ts
// src/jobs/refresh-untappd.ts
import type { DB } from '../storage/db';
import type pino from 'pino';
import type { Http } from '../sources/http';
import { parseUserBeerPage } from '../sources/untappd/scraper';
import { allProfiles } from '../storage/user_profiles';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { mergeCheckin } from '../storage/checkins';
import { normalizeBrewery, normalizeName } from '../domain/normalize';

export async function refreshAllUntappd(deps: { db: DB; log: pino.Logger; http: Http }): Promise<void> {
  const { db, log, http } = deps;
  for (const p of allProfiles(db)) {
    if (!p.untappd_username) continue;
    try {
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beer`);
      const items = parseUserBeerPage(html);
      for (const it of items) {
        const nb = normalizeBrewery(it.brewery_name);
        const nn = normalizeName(it.beer_name);
        const existing = findBeerByNormalized(db, nb, nn);
        const beerId = existing?.id ?? upsertBeer(db, {
          untappd_id: it.bid ?? null, name: it.beer_name, brewery: it.brewery_name,
          style: null, abv: null, rating_global: it.rating_score,
          normalized_name: nn, normalized_brewery: nb,
        });
        mergeCheckin(db, {
          checkin_id: it.checkin_id, telegram_id: p.telegram_id,
          beer_id: beerId, user_rating: it.rating_score,
          checkin_at: it.checkin_at || new Date().toISOString(), venue: null,
        });
      }
    } catch (e) {
      log.warn({ err: e, user: p.untappd_username }, 'untappd scrape failed');
    }
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-untappd.ts
git commit -m "feat(jobs): ontap + untappd refresh jobs"
```

---

## Task 25: `src/index.ts` — composition root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace stub with full wiring**

```ts
// src/index.ts
import 'dotenv/config';
import cron from 'node-cron';
import pino from 'pino';
import { loadEnv } from './config/env';
import { openDb } from './storage/db';
import { migrate } from './storage/schema';
import { createHttp } from './sources/http';
import { createGeocoder } from './sources/geocoder';
import { createBot } from './bot';
import { startCommand } from './bot/commands/start';
import { linkCommand } from './bot/commands/link';
import { importCommand } from './bot/commands/import';
import { newbeersCommand } from './bot/commands/newbeers';
import { routeCommand } from './bot/commands/route';
import { filtersCommand } from './bot/commands/filters';
import { createRefreshCommand } from './bot/commands/refresh';
import { refreshOntap } from './jobs/refresh-ontap';
import { refreshAllUntappd } from './jobs/refresh-untappd';

async function main() {
  const env = loadEnv(process.env);
  const log = pino({ level: env.LOG_LEVEL });
  const db = openDb(env.DATABASE_PATH);
  migrate(db);

  const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });
  const geocoder = createGeocoder({ userAgent: env.NOMINATIM_USER_AGENT });

  const runOntap = () => refreshOntap({ db, log, http, geocoder });
  const runUntappd = () => refreshAllUntappd({ db, log, http });

  const bot = createBot({ db, env, log });
  bot.use(startCommand, linkCommand, importCommand, newbeersCommand, routeCommand, filtersCommand,
          createRefreshCommand(async () => { await runOntap(); await runUntappd(); }));

  cron.schedule('0 */12 * * *', () => { runOntap().catch((e) => log.error({ err: e }, 'ontap cron')); });
  cron.schedule('0 3 * * *',   () => { runUntappd().catch((e) => log.error({ err: e }, 'untappd cron')); });

  bot.launch();
  log.info('bot launched');

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Install dotenv**

```bash
npm install dotenv
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no TS errors.

- [ ] **Step 4: Local smoke (no real token needed — just check bot fails fast on bad token)**

```bash
TELEGRAM_BOT_TOKEN=xxxxxxxxxx \
DATABASE_PATH=/tmp/smoke.db \
OSRM_BASE_URL=https://router.project-osrm.org \
NOMINATIM_USER_AGENT='warsaw-beer-bot (test)' \
DEFAULT_ROUTE_N=5 \
node dist/index.js & sleep 2; kill %1 || true
```

Expected: "bot launched" log line (or Telegraf auth error — both confirm composition root runs).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts package.json package-lock.json
git commit -m "feat: composition root — wire bot, jobs, cron"
```

---

## Task 26: systemd unit + deploy script

**Files:**
- Create: `deploy/warsaw-beer-bot.service`, `deploy/deploy.sh`

- [ ] **Step 1: Write the unit**

```ini
# deploy/warsaw-beer-bot.service
[Unit]
Description=Warsaw Beer Crawler Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/warsaw-beer-bot
EnvironmentFile=/etc/warsaw-beer-bot/.env
ExecStart=/usr/bin/node /opt/warsaw-beer-bot/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
User=warsaw-beer-bot
Group=warsaw-beer-bot

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write `deploy.sh`**

```bash
# deploy/deploy.sh
#!/usr/bin/env bash
set -euo pipefail
APP=/opt/warsaw-beer-bot
DATA=/var/lib/warsaw-beer-bot
ENVDIR=/etc/warsaw-beer-bot

sudo install -d -o warsaw-beer-bot -g warsaw-beer-bot "$APP" "$DATA" "$ENVDIR"
sudo rsync -a --delete --exclude node_modules --exclude tests --exclude docs ./ "$APP"/
sudo -u warsaw-beer-bot bash -lc "cd $APP && npm ci --omit=dev && npm run build"
sudo install -m 0644 deploy/warsaw-beer-bot.service /etc/systemd/system/warsaw-beer-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now warsaw-beer-bot
sudo journalctl -u warsaw-beer-bot -n 30 --no-pager
```

- [ ] **Step 3: Mark executable and add README stub**

```bash
chmod +x deploy/deploy.sh
```

- [ ] **Step 4: First-run instructions (put into `deploy/README.md`)**

```markdown
# Deploy

One-time host setup (as root):

```bash
useradd -r -s /usr/sbin/nologin warsaw-beer-bot
install -d -o warsaw-beer-bot -g warsaw-beer-bot /etc/warsaw-beer-bot /var/lib/warsaw-beer-bot /opt/warsaw-beer-bot
cp .env.example /etc/warsaw-beer-bot/.env && chmod 600 /etc/warsaw-beer-bot/.env
# edit /etc/warsaw-beer-bot/.env and set DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db
```

Then from a dev checkout:

```bash
./deploy/deploy.sh
```

Subsequent deploys: `git pull && ./deploy/deploy.sh`.
```

- [ ] **Step 5: Commit**

```bash
git add deploy/
git commit -m "ops: systemd unit + deploy script for Hetzner CX33"
```

---

## Task 27: End-to-end smoke on the CX33 host

- [ ] **Step 1: One-time host prep** (follow `deploy/README.md`).

- [ ] **Step 2: Run deploy**

```bash
./deploy/deploy.sh
```

Expected: systemd shows the service `active (running)`.

- [ ] **Step 3: Manual bot check** — in Telegram: `/start`, `/link <you>`, `/refresh`, `/newbeers`, `/route 5`.

- [ ] **Step 4: Log check**

```bash
sudo journalctl -u warsaw-beer-bot -f
```

Expected: structured pino JSON; no error spam.

- [ ] **Step 5: Commit any runbook tweaks** if you adjusted selectors, envs, or the unit file during smoke.

```bash
git add -A && git commit -m "ops: post-smoke fixes" || echo "nothing to commit"
```

---

## Self-Review Summary

| Spec section | Covered by |
|---|---|
| §2 entities (Beer, Pub, Tap, Checkin, MatchLink, UserProfile, UserFilter) | Tasks 2–8 |
| §4.1 ontap flow | Task 24 (`refreshOntap`) |
| §4.2 untappd flows | Task 21 (CSV/JSON/ZIP streaming + batched import), Task 24 (`refreshAllUntappd`) |
| §4.3 `/newbeers` flow | Task 22 |
| §4.4 `/route N` flow | Task 22 (command) + Task 18 (router) |
| §5.1 ontap parser | Tasks 10, 11 |
| §5.2 Untappd CSV/JSON/ZIP export + scraper | Tasks 12, 13 |
| §5.3 Geocoder fallback | Task 14 |
| §6 Matcher | Tasks 15, 16 |
| §7 Router algorithm (set-cover + swap + open-TSP) | Task 18 |
| §8 Telegram commands (/start /import /link /newbeers /route /filters /refresh) | Tasks 19–23 |
| §9 SQLite schema + WAL + indexes | Task 2 |
| §10 Node 20 + TS strict + Jest + zod + pino + systemd + paths | Tasks 0, 1, 25, 26 |
| §11 p-queue + privacy | Task 9, Task 25 wiring |
| §13 Q1 (CSV + /beer scrape), Q2 (HTML), Q3 (N-cover + min dist, no caps), Q4 (multi-user, Hetzner systemd) | Tasks 12–13, 10–11, 18, 2–8 + 26 |
