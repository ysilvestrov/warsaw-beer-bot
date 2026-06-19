# Multi-city ontap sync + `/city` command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync pubs from multiple ontap.pl cities, tag each pub with its city, and let a user pick their active city via `/city` so `/pubs`, `/route`, `/newbeers`, `/beers` show only that city's pubs.

**Architecture:** Additive. A curated `cities.ts` constant drives both the scraper (loops city index pages, tags pubs) and the `/city` menu. Two new nullable/defaulted columns (`pubs.city`, `user_profiles.city`) carry the state; the four pub commands resolve the user's city and filter `listPubs(db, city)` at their single injection point. Untappd catalog, ratings, extension, and `/refresh` stay city-independent.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Telegraf. Test command: `npx vitest run <file> [-t <name>]`. Type check: `npm run build`.

**Spec:** `docs/superpowers/specs/2026-06-19-multi-city-ontap-design.md`

**Task order (dependencies):** 1 cities → 2 migration → 3 pub storage → 4 user storage → 5 scraper → 6 `/city` → 7 command scoping → 8 docs.

---

### Task 1: City config constant

**Files:**
- Create: `src/domain/cities.ts`
- Test: `src/domain/cities.test.ts`

- [ ] **Step 1: Write the failing test** — create `src/domain/cities.test.ts`:

```ts
import { CITIES, DEFAULT_CITY, isKnownCity, cityLabel } from './cities';

describe('cities', () => {
  test('DEFAULT_CITY is one of the configured cities', () => {
    expect(CITIES.some((c) => c.slug === DEFAULT_CITY)).toBe(true);
  });
  test('isKnownCity recognises configured slugs and rejects others', () => {
    expect(isKnownCity('warszawa')).toBe(true);
    expect(isKnownCity('krakow')).toBe(true);
    expect(isKnownCity('atlantis')).toBe(false);
    expect(isKnownCity('')).toBe(false);
  });
  test('cityLabel returns the label for a known slug, echoes unknown', () => {
    expect(cityLabel('warszawa')).toBe('Warszawa');
    expect(cityLabel('atlantis')).toBe('atlantis');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/cities.test.ts`
Expected: FAIL — cannot find module `./cities`.

- [ ] **Step 3: Write the implementation** — create `src/domain/cities.ts`:

```ts
export interface City {
  slug: string;
  label: string;
}

// Curated. `slug` is the ontap.pl city-index path segment (ontap.pl/<slug>).
// Confirm each slug against a captured page before launch — a wrong slug yields
// an empty index, not an error.
export const CITIES: readonly City[] = [
  { slug: 'warszawa', label: 'Warszawa' },
  { slug: 'krakow', label: 'Kraków' },
  { slug: 'wroclaw', label: 'Wrocław' },
  { slug: 'poznan', label: 'Poznań' },
  { slug: 'trojmiasto', label: 'Trójmiasto' },
  { slug: 'lodz', label: 'Łódź' },
  { slug: 'katowice', label: 'Katowice' },
];

export const DEFAULT_CITY = 'warszawa';

const SLUGS = new Set(CITIES.map((c) => c.slug));

export function isKnownCity(slug: string): boolean {
  return SLUGS.has(slug);
}

export function cityLabel(slug: string): string {
  return CITIES.find((c) => c.slug === slug)?.label ?? slug;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/cities.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/cities.ts src/domain/cities.test.ts
git commit -m "feat(cities): curated city constant + helpers (#146)"
```

---

### Task 2: Schema migration v14 (city columns)

**Files:**
- Modify: `src/storage/schema.ts` (append migration `version: 14` to the `MIGRATIONS` array, after the `version: 13` entry)
- Test: `src/storage/schema.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `src/storage/schema.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';

function cols(db: ReturnType<typeof openDb>, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

test('migration v14 adds city columns', () => {
  const db = openDb(':memory:');
  migrate(db);
  expect(cols(db, 'pubs').has('city')).toBe(true);
  expect(cols(db, 'user_profiles').has('city')).toBe(true);
});

test('existing pubs default to warszawa', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO pubs (slug, name) VALUES ('x', 'X')").run();
  const row = db.prepare("SELECT city FROM pubs WHERE slug = 'x'").get() as { city: string };
  expect(row.city).toBe('warszawa');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: FAIL — `pubs` has no column `city`.

- [ ] **Step 3: Add the migration** — in `src/storage/schema.ts`, add this object as the **last** element of the `MIGRATIONS` array (immediately after the `version: 13` entry, before the closing `];`):

```ts
  {
    version: 14,
    sql: `
      ALTER TABLE pubs ADD COLUMN city TEXT NOT NULL DEFAULT 'warszawa';
      ALTER TABLE user_profiles ADD COLUMN city TEXT;
      CREATE INDEX idx_pubs_city ON pubs(city);
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(schema): v14 city columns on pubs + user_profiles (#146)"
```

---

### Task 3: Pub storage — write + filter by city

**Files:**
- Modify: `src/storage/pubs.ts`
- Test: `src/storage/pubs.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `src/storage/pubs.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub, listPubs } from './pubs';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }
const base = { address: null, lat: null, lon: null };

test('upsertPub persists city on insert and update', () => {
  const db = fresh();
  const id = upsertPub(db, { slug: 'a', name: 'A', city: 'krakow', ...base });
  expect((listPubs(db).find((p) => p.id === id))?.city).toBe('krakow');
  upsertPub(db, { slug: 'a', name: 'A2', city: 'wroclaw', ...base });
  expect((listPubs(db).find((p) => p.id === id))?.city).toBe('wroclaw');
});

test('listPubs filters by city when given, returns all otherwise', () => {
  const db = fresh();
  upsertPub(db, { slug: 'w', name: 'W', city: 'warszawa', ...base });
  upsertPub(db, { slug: 'k', name: 'K', city: 'krakow', ...base });
  expect(listPubs(db).length).toBe(2);
  expect(listPubs(db, 'krakow').map((p) => p.slug)).toEqual(['k']);
  expect(listPubs(db, 'gdansk')).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/pubs.test.ts`
Expected: FAIL — `PubInput` has no `city` / TS error or insert ignores city.

- [ ] **Step 3: Implement** — in `src/storage/pubs.ts`:

  (a) Add `city` to the interface:
```ts
export interface PubInput {
  slug: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  city: string;
}
```

  (b) Update `upsertPub` to write `city` on both branches. Replace the function body's UPDATE and INSERT statements:
```ts
  if (existing) {
    db.prepare(
      `UPDATE pubs SET name = ?, address = COALESCE(?, address),
         lat = COALESCE(?, lat), lon = COALESCE(?, lon), city = ? WHERE id = ?`,
    ).run(p.name, p.address, p.lat, p.lon, p.city, existing.id);
    if (coordsChanged(existing, p)) clearForPub(db, existing.id);
    return existing.id;
  }
  const res = db.prepare(
    'INSERT INTO pubs (slug, name, address, lat, lon, city) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(p.slug, p.name, p.address, p.lat, p.lon, p.city);
  return Number(res.lastInsertRowid);
```

  (c) Update `listPubs` to accept an optional city filter:
```ts
export function listPubs(db: DB, city?: string): PubRow[] {
  if (city != null) {
    return db.prepare('SELECT * FROM pubs WHERE city = ? ORDER BY id').all(city) as PubRow[];
  }
  return db.prepare('SELECT * FROM pubs ORDER BY id').all() as PubRow[];
}
```

  (`PubRow extends PubInput` already, so it now includes `city` — no extra change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/pubs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/pubs.ts src/storage/pubs.test.ts
git commit -m "feat(pubs): store city + listPubs city filter (#146)"
```

---

### Task 4: User storage — get/set active city

**Files:**
- Modify: `src/storage/user_profiles.ts`
- Test: `src/storage/user-city.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `src/storage/user-city.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, getUserCity, setUserCity } from './user_profiles';
import { DEFAULT_CITY } from '../domain/cities';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

test('getUserCity returns DEFAULT_CITY when unset', () => {
  const db = fresh();
  ensureProfile(db, 1);
  expect(getUserCity(db, 1)).toBe(DEFAULT_CITY);
});

test('setUserCity round-trips a known city', () => {
  const db = fresh();
  ensureProfile(db, 1);
  setUserCity(db, 1, 'krakow');
  expect(getUserCity(db, 1)).toBe('krakow');
});

test('getUserCity falls back to default when stored slug is unknown', () => {
  const db = fresh();
  ensureProfile(db, 1);
  db.prepare("UPDATE user_profiles SET city = 'atlantis' WHERE telegram_id = 1").run();
  expect(getUserCity(db, 1)).toBe(DEFAULT_CITY);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/user-city.test.ts`
Expected: FAIL — `getUserCity` / `setUserCity` not exported.

- [ ] **Step 3: Implement** — in `src/storage/user_profiles.ts`:

  (a) Add the import at the top:
```ts
import { DEFAULT_CITY, isKnownCity } from '../domain/cities';
```

  (b) Add `city` to `ProfileRow`:
```ts
export interface ProfileRow {
  telegram_id: number;
  untappd_username: string | null;
  language: string | null;
  city: string | null;
  created_at: string;
}
```

  (c) Add the two functions (anywhere after `getProfile`):
```ts
export function getUserCity(db: DB, telegramId: number): string {
  const row = db
    .prepare('SELECT city FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { city: string | null } | undefined;
  const v = row?.city;
  return v != null && isKnownCity(v) ? v : DEFAULT_CITY;
}

export function setUserCity(db: DB, telegramId: number, slug: string): void {
  db.prepare('UPDATE user_profiles SET city = ? WHERE telegram_id = ?').run(slug, telegramId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/user-city.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/user_profiles.ts src/storage/user-city.test.ts
git commit -m "feat(profiles): get/set active city with default fallback (#146)"
```

---

### Task 5: Scraper — loop cities, tag pubs, inline-enrich budget

**Files:**
- Modify: `src/sources/ontap/index.ts` (rename `parseWarsawIndex` → `parseOntapCityIndex`)
- Modify: `src/sources/ontap/index.test.ts` (update import/usage to the new name)
- Modify: `src/jobs/refresh-ontap.ts`
- Test: `src/jobs/refresh-ontap.test.ts` (add a new `describe`)

- [ ] **Step 1: Rename the parser.** In `src/sources/ontap/index.ts`, rename the exported function `parseWarsawIndex` to `parseOntapCityIndex` (body unchanged). In `src/sources/ontap/index.test.ts`, replace every `parseWarsawIndex` with `parseOntapCityIndex`. Run the existing parser tests to confirm the rename is clean:

Run: `npx vitest run src/sources/ontap/index.test.ts`
Expected: PASS (unchanged behavior).

- [ ] **Step 2: Write the failing test** — add to `src/jobs/refresh-ontap.test.ts` (top-level, after the existing describes). It stubs `http` with a URL→HTML map for two city index pages and their pub pages:

```ts
import { CITIES } from '../domain/cities';
import { listPubs } from '../storage/pubs';

describe('refreshOntap multi-city', () => {
  const cityIndex = (slug: string) => `
    <div onclick="location.assign('https://${slug}pub.ontap.pl/')">
      <div class="panel-body">${slug} Pub 2 taps</div>
    </div>`;
  const pubPage = (name: string) => `
    <html><head><meta property="og:title" content="${name} / ontap.pl"></head>
    <body></body></html>`;

  function makeHttp(throwOn?: string) {
    const calls: string[] = [];
    const http = {
      async get(url: string): Promise<string> {
        calls.push(url);
        if (throwOn && url === `https://ontap.pl/${throwOn}`) throw new Error('boom');
        if (url === 'https://ontap.pl/warszawa') return cityIndex('warszawa');
        if (url === 'https://ontap.pl/krakow') return cityIndex('krakow');
        if (url.endsWith('.ontap.pl/')) return pubPage('Some Pub');
        return '';
      },
    };
    return { http, calls };
  }
  const geocoder = async () => null;
  const twoCities = CITIES.filter((c) => c.slug === 'warszawa' || c.slug === 'krakow');

  test('tags pubs with the city whose index they came from', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = makeHttp();
    await refreshOntap({ db, log: silentLog, http, geocoder, cities: twoCities, lookupEnabled: false });
    expect(listPubs(db, 'warszawa').map((p) => p.slug)).toEqual(['warszawapub']);
    expect(listPubs(db, 'krakow').map((p) => p.slug)).toEqual(['krakowpub']);
  });

  test('a city whose index fetch throws is skipped; others still scrape', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = makeHttp('warszawa');
    await refreshOntap({ db, log: silentLog, http, geocoder, cities: twoCities, lookupEnabled: false });
    expect(listPubs(db, 'warszawa')).toEqual([]);
    expect(listPubs(db, 'krakow').map((p) => p.slug)).toEqual(['krakowpub']);
  });

  test('inlineEnrichBudget 0 means no Untappd lookups fire', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http, calls } = makeHttp();
    await refreshOntap({
      db, log: silentLog, http, geocoder, cities: twoCities,
      lookupEnabled: true, inlineEnrichBudget: 0, lookupSleepMs: 0,
    });
    expect(calls.some((u) => u.includes('untappd.com'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts -t multi-city`
Expected: FAIL — `cities`/`inlineEnrichBudget` not accepted, pubs not city-tagged.

- [ ] **Step 4: Implement** — in `src/jobs/refresh-ontap.ts`:

  (a) Update imports: replace `import { parseWarsawIndex, type IndexPub } from '../sources/ontap/index';` with:
```ts
import { parseOntapCityIndex, type IndexPub } from '../sources/ontap/index';
import { CITIES, type City } from '../domain/cities';
```

  (b) Add two fields to the `Deps` interface:
```ts
  cities?: readonly City[];     // default CITIES
  inlineEnrichBudget?: number;  // default 20 — total inline Untappd enriches per run
```

  (c) Replace the **entire body** of `refreshOntap` (the function, not the helpers below it) with:
```ts
export async function refreshOntap(deps: Deps): Promise<void> {
  const {
    db, log, http, geocoder,
    onProgress = noopProgress,
    lookupEnabled = true,
    lookupSleepMs = 500,
    now = () => new Date(),
    cities = CITIES,
    inlineEnrichBudget = 20,
  } = deps;

  let enrichBudget = inlineEnrichBudget;

  for (const city of cities) {
    let indexPubs: IndexPub[];
    try {
      await onProgress(`🍻 ontap ${city.slug}: парсю індекс…`, { force: true });
      const indexHtml = await http.get(`https://ontap.pl/${city.slug}`);
      indexPubs = filterIndexBySlugs(parseOntapCityIndex(indexHtml), deps.pubSlugs);
    } catch (e) {
      log.warn({ err: e, city: city.slug }, 'ontap city index failed');
      continue;
    }
    log.info({ city: city.slug, n: indexPubs.length, scoped: deps.pubSlugs != null }, 'ontap index parsed');
    await onProgress(`🍻 ontap ${city.slug}: 0/${indexPubs.length} пабів`, { force: true });

    let i = 0;
    let ok = 0;
    for (const ip of indexPubs) {
      i++;
      try {
        const html = await http.get(`https://${ip.slug}.ontap.pl/`);
        const { pub, taps: parsedTaps } = parsePubPage(html);
        const taps = parsedTaps.filter((t) => !isOntapNonBeerTap(t));
        const droppedNonBeer = parsedTaps.length - taps.length;
        if (droppedNonBeer > 0) {
          log.info({ slug: ip.slug, droppedNonBeer }, 'ontap non-beer taps filtered');
        }

        let lat = pub.lat;
        let lon = pub.lon;
        if ((lat == null || lon == null) && pub.address) {
          const g = await geocoder(pub.address);
          if (g) { lat = g.lat; lon = g.lon; }
        }

        const pubId = upsertPub(db, {
          slug: ip.slug,
          name: pub.name || ip.name,
          address: pub.address,
          lat,
          lon,
          city: city.slug,
        });
        const snapshotId = createSnapshot(db, pubId, new Date().toISOString());
        insertTaps(db, snapshotId, taps);

        const catalog = listBeerCatalog(db);
        const prepared = prepareCatalog(catalog);
        for (const t of taps) {
          const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
          const m = matchPrepared({ brewery, name: t.beer_ref, abv: t.abv }, prepared);
          let beerId: number;
          let isFreshOrphan = false;
          if (m) {
            upsertMatch(db, t.beer_ref, m.id, m.confidence);
            beerId = m.id;
          } else {
            beerId = upsertBeer(db, {
              name: t.beer_ref,
              brewery,
              style: t.style,
              abv: t.abv,
              rating_global: t.u_rating,
              normalized_name: normalizeName(t.beer_ref),
              normalized_brewery: normalizeBrewery(brewery),
            });
            upsertMatch(db, t.beer_ref, beerId, 1.0);
            isFreshOrphan = true;
          }

          // Inline Untappd enrichment ONLY for freshly-created orphans, and only
          // while the per-run budget remains — the multi-city seeding burst is
          // otherwise drained by the rate-limited enrich-orphans cron (#146).
          if (lookupEnabled && isFreshOrphan && enrichBudget > 0) {
            const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
            if (outcome !== 'skipped') {
              enrichBudget--;
              if (lookupSleepMs > 0) {
                await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
              }
            }
          }
        }
        ok++;
      } catch (e) {
        log.warn({ err: e, slug: ip.slug }, 'ontap pub refresh failed');
      }
      await onProgress(`🍻 ontap ${city.slug}: ${i}/${indexPubs.length} — ${ip.slug}`);
    }
    await onProgress(`🍻 ontap ${city.slug}: ✓ ${ok}/${indexPubs.length} пабів`, { force: true });
  }
}
```

  (The helper functions `filterIndexBySlugs` and `listBeerCatalog` below the function are unchanged.)

- [ ] **Step 5: Run the new + existing scraper tests**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: PASS — the new multi-city describe **and** every pre-existing scraper test (the existing single-pub test passes its own `cities`? No — it omits `cities`, so it now loops the full 7-city `CITIES`. Its http stub only answers `mixed.ontap.pl`/its index URL; other cities' index GETs return `''` → 0 pubs, harmlessly skipped). If the existing test now fails because it asserts on a single Warsaw fetch, scope it by adding `cities: CITIES.filter((c) => c.slug === 'warszawa')` to its `refreshOntap(...)` call and point its index URL stub at `https://ontap.pl/warszawa`.

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/sources/ontap/index.ts src/sources/ontap/index.test.ts src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "feat(ontap): scrape multiple cities, tag pubs, cap inline enrich (#146)"
```

---

### Task 6: `/city` command

**Files:**
- Modify: `src/i18n/types.ts` (add 3 message keys)
- Modify: `src/i18n/locales/uk.ts`, `pl.ts`, `en.ts` (add the 3 keys)
- Modify: `src/bot/keyboards.ts` (add `cityKeyboard`)
- Create: `src/bot/commands/city.ts`
- Modify: `src/bot/commands/catalog.ts` (add `/city` to the catalog)
- Modify: `src/index.ts` (register `cityCommand`)
- Test: `src/bot/commands/city.test.ts` (create)

- [ ] **Step 1: Add the message keys to the type.** In `src/i18n/types.ts`, inside `interface Messages`, add next to the `cmd.*` block and a new section:
```ts
  'cmd.city': string;
  'city.prompt': string;                 // {name} = current city
  'city.changed': string;                // {name}
```

- [ ] **Step 2: Add translations.** Append these keys to each locale object.

`src/i18n/locales/uk.ts`:
```ts
  'cmd.city': 'обрати місто',
  'city.prompt': 'Поточне місто: {name}. Оберіть місто:',
  'city.changed': '✅ Місто змінено на {name}.',
```
`src/i18n/locales/pl.ts`:
```ts
  'cmd.city': 'wybierz miasto',
  'city.prompt': 'Aktualne miasto: {name}. Wybierz miasto:',
  'city.changed': '✅ Zmieniono miasto na {name}.',
```
`src/i18n/locales/en.ts`:
```ts
  'cmd.city': 'choose city',
  'city.prompt': 'Current city: {name}. Choose a city:',
  'city.changed': '✅ City changed to {name}.',
```

- [ ] **Step 3: Add `cityKeyboard`.** In `src/bot/keyboards.ts`, add the import and helper:
```ts
import { CITIES } from '../domain/cities';
```
```ts
export const cityKeyboard = (current: string) =>
  Markup.inlineKeyboard(
    CITIES.map((c) => [
      Markup.button.callback(
        c.slug === current ? `✓ ${c.label}` : c.label,
        `city:${c.slug}`,
      ),
    ]),
  );
```

- [ ] **Step 4: Add `/city` to the command catalog.** In `src/bot/commands/catalog.ts`, add to `COMMAND_CATALOG` (place after the `lang` entry):
```ts
  { command: 'city', descKey: 'cmd.city' },
```

- [ ] **Step 5: Write the failing test** — create `src/bot/commands/city.test.ts`:

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';
import { cityKeyboard } from '../keyboards';
import { applyCitySelection } from './city';

test('cityKeyboard marks the current city', () => {
  const kb = cityKeyboard('krakow') as any;
  const flat: any[] = kb.reply_markup.inline_keyboard.flat();
  const krakow = flat.find((b: any) => b.callback_data === 'city:krakow');
  const warszawa = flat.find((b: any) => b.callback_data === 'city:warszawa');
  expect(krakow.text).toBe('✓ Kraków');
  expect(warszawa.text).toBe('Warszawa');
});

// applyCitySelection is the action-handler core, extracted to be testable without Telegraf.
test('a known slug is stored, an unknown slug is ignored', () => {
  const db = openDb(':memory:'); migrate(db);
  ensureProfile(db, 7);
  expect(applyCitySelection(db, 7, 'krakow')).toBe(true);
  expect(getUserCity(db, 7)).toBe('krakow');
  expect(applyCitySelection(db, 7, 'atlantis')).toBe(false);
  expect(getUserCity(db, 7)).toBe('krakow');
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/bot/commands/city.test.ts`
Expected: FAIL — `./city` module / `applyCitySelection` missing.

- [ ] **Step 7: Implement the command** — create `src/bot/commands/city.ts`:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import type { DB } from '../../storage/db';
import { cityKeyboard } from '../keyboards';
import { ensureProfile, setUserCity, getUserCity } from '../../storage/user_profiles';
import { isKnownCity, cityLabel } from '../../domain/cities';

// Extracted for unit testing: store the slug only if it is a known city.
export function applyCitySelection(db: DB, telegramId: number, slug: string): boolean {
  if (!isKnownCity(slug)) return false;
  setUserCity(db, telegramId, slug);
  return true;
}

export const cityCommand = new Composer<BotContext>();

cityCommand.command('city', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const current = getUserCity(ctx.deps.db, ctx.from.id);
  await ctx.reply(ctx.t('city.prompt', { name: cityLabel(current) }), cityKeyboard(current));
});

cityCommand.action(/^city:([a-z-]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const telegramId = ctx.from!.id;
  ensureProfile(ctx.deps.db, telegramId);
  if (!applyCitySelection(ctx.deps.db, telegramId, slug)) {
    await ctx.answerCbQuery();
    return;
  }
  await ctx.editMessageText(ctx.t('city.changed', { name: cityLabel(slug) }));
  await ctx.answerCbQuery();
});
```

- [ ] **Step 8: Register the command.** In `src/index.ts`, add `cityCommand` to the `bot.use(...)` list (next to `langCommand`), and add the import:
```ts
import { cityCommand } from './bot/commands/city';
```
Place `cityCommand,` in the `bot.use(` argument list right after `langCommand,`.

- [ ] **Step 9: Run tests + type-check**

Run: `npx vitest run src/bot/commands/city.test.ts && npm run build`
Expected: PASS (2 tests) and no TS errors (all three locales now satisfy `Messages`).

- [ ] **Step 10: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/ src/bot/keyboards.ts src/bot/commands/city.ts src/bot/commands/catalog.ts src/index.ts src/bot/commands/city.test.ts
git commit -m "feat(bot): /city command to pick the active city (#146)"
```

---

### Task 7: Scope the four pub commands to the user's city

**Files:**
- Modify: `src/bot/commands/pubs-build.ts`, `src/bot/commands/pubs.ts`
- Modify: `src/bot/commands/beers-build.ts`, `src/bot/commands/beers.ts`
- Modify: `src/bot/commands/newbeers-build.ts`, `src/bot/commands/newbeers.ts`
- Modify: `src/bot/commands/route.ts`
- Modify: `src/bot/commands/refresh.ts` (pass `city` to the post-run newbeers)
- Test: `src/bot/commands/city-scoping.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `src/bot/commands/city-scoping.test.ts`. It seeds two pubs in different cities, each with a snapshot + an interesting tap, then asserts the build functions only surface the user's city:

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { buildPubsMessage } from './pubs-build';
import { buildBeersMessage } from './beers-build';
import { createTranslator } from '../../i18n';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }
const t = createTranslator('en');
const base = { address: null, lat: null, lon: null };

test('buildPubsMessage lists only the given city', () => {
  const db = fresh();
  upsertPub(db, { slug: 'wa', name: 'Pub WA', city: 'warszawa', ...base });
  upsertPub(db, { slug: 'kr', name: 'Pub KR', city: 'krakow', ...base });
  const msg = buildPubsMessage({ db, t, city: 'krakow' });
  expect(msg).toContain('Pub KR');
  expect(msg).not.toContain('Pub WA');
});

test('buildBeersMessage cannot find an out-of-city pub', () => {
  const db = fresh();
  upsertPub(db, { slug: 'wa', name: 'Pub WA', city: 'warszawa', ...base });
  upsertPub(db, { slug: 'kr', name: 'Pub KR', city: 'krakow', ...base });
  // user on krakow queries the warszawa pub by name → it's not in their city
  const res = buildBeersMessage({ db, locale: 'en', t, pubQuery: 'Pub WA', city: 'krakow' });
  expect(res.kind).toBe('pub_not_found');
});
```

> `/newbeers` and `/route` share the identical `listPubs(db, city)` injection point, so these two assertions are representative of all four commands without depending on beer-matching/tap-join machinery.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/commands/city-scoping.test.ts`
Expected: FAIL — `PubsDeps`/`BeersDeps` have no `city`; `buildPubsMessage` lists both cities.

- [ ] **Step 3: Add `city` to `pubs-build`.** In `src/bot/commands/pubs-build.ts`:
```ts
export interface PubsDeps {
  db: DB;
  t: Translator;
  city: string;
}
```
and change the first line of `buildPubsMessage`:
```ts
  const pubs = listPubs(deps.db, deps.city).sort((a, b) => a.name.localeCompare(b.name));
```

- [ ] **Step 4: Add `city` to `beers-build`.** In `src/bot/commands/beers-build.ts`:
```ts
export interface BeersDeps {
  db: DB;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
  city: string;
}
```
and change the `filterPubsByQuery(listPubs(db), q)` line in `buildBeersMessage` to:
```ts
  const matched = filterPubsByQuery(listPubs(db, deps.city), q);
```

- [ ] **Step 5: Add `city` to `newbeers-build`.** In `src/bot/commands/newbeers-build.ts`:
```ts
export interface NewbeersDeps {
  db: DB;
  telegramId: number;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
  city: string;
}
```
and change line 58 (`const pubs = new Map(listPubs(db).map(...))`) to:
```ts
  const pubs = new Map(listPubs(db, deps.city).map((p) => [p.id, p]));
```

- [ ] **Step 6: Resolve city in the three command handlers.**

  `src/bot/commands/pubs.ts` — replace the build call:
```ts
import { getUserCity } from '../../storage/user_profiles';
// ...
  const text = buildPubsMessage({ db: ctx.deps.db, t: ctx.t, city: getUserCity(ctx.deps.db, ctx.from.id) });
```

  `src/bot/commands/beers.ts` — add `city` to the deps object:
```ts
import { getUserCity } from '../../storage/user_profiles';
// ...
  const result = buildBeersMessage({
    db: ctx.deps.db,
    locale: ctx.locale,
    t: ctx.t,
    pubQuery: arg || undefined,
    city: getUserCity(ctx.deps.db, ctx.from.id),
  });
```

  `src/bot/commands/newbeers.ts` — add `city` to the deps object:
```ts
import { getUserCity } from '../../storage/user_profiles';
// ...
  const result = buildNewbeersMessage({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    locale: ctx.locale,
    t: ctx.t,
    pubQuery: arg || undefined,
    city: getUserCity(ctx.deps.db, ctx.from.id),
  });
```

- [ ] **Step 7: Scope `/route`.** In `src/bot/commands/route.ts`, add the import and scope the pub list:
```ts
import { getUserCity } from '../../storage/user_profiles';
```
Change `const pubsById = new Map(listPubs(db).map((p) => [p.id, p]));` to:
```ts
  const pubsById = new Map(listPubs(db, getUserCity(db, ctx.from.id)).map((p) => [p.id, p]));
```

- [ ] **Step 8: Pass `city` to the post-refresh newbeers.** In `src/bot/commands/refresh.ts`, add the import and include `city` in the `postRun({...})` call at the line that currently reads `const result = postRun({ db, telegramId, locale, t, pubQuery });`:
```ts
import { getUserCity } from '../../storage/user_profiles';
```
```ts
          const result = postRun({ db, telegramId, locale, t, pubQuery, city: getUserCity(db, telegramId) });
```

- [ ] **Step 9: Run the new test + full suite + type-check**

Run: `npx vitest run src/bot/commands/city-scoping.test.ts && npm run build`
Expected: PASS (2 tests), no TS errors. Then `npx vitest run` — all green (any other caller of these build functions now needs `city`; the type-check in `npm run build` surfaces them — there should be none beyond those edited here and tests).

- [ ] **Step 10: Commit**

```bash
git add src/bot/commands/
git commit -m "feat(bot): scope /pubs /beers /newbeers /route to the user's city (#146)"
```

---

### Task 8: Spec + help/docs

**Files:**
- Modify: `spec.md`
- (help text + command menu already update automatically via `COMMAND_CATALOG` from Task 6 — no separate edit)

- [ ] **Step 1: Update `spec.md`.** Find the ontap ingest section and the bot-commands section. Add the following, adjusting headings to match the file's style:

  (a) In the ontap ingest description, add a paragraph:
```markdown
**Багатомісто (#146).** `refreshOntap` проходить по курованому списку міст
(`src/domain/cities.ts`, `CITIES`) — для кожного `GET https://ontap.pl/<slug>`,
парсить індекс (`parseOntapCityIndex`, спільний DOM) і проставляє паба `pubs.city =
<slug>`. Невдале завантаження індексу міста логуються й пропускається (інші міста
скрейпляться далі). Інлайн-енрич свіжих орфанів обмежений **бюджетом на запуск**
(`inlineEnrichBudget`, дефолт 20) — решта добирається rate-limited `enrich-orphans`
кроном (захист від Untappd-бану). schema_version **14** додає `pubs.city`
(`NOT NULL DEFAULT 'warszawa'`) та `user_profiles.city` (nullable; NULL → `DEFAULT_CITY`).
```

  (b) In the commands section, add:
```markdown
**`/city`.** Inline-клавіатура курованих міст; вибір зберігається в
`user_profiles.city` (валідація `isKnownCity`; невідомий slug ігнорується). Команди
`/pubs`, `/route`, `/newbeers`, `/beers` фільтрують паби за активним містом користувача
(`getUserCity` → `listPubs(db, city)`); усі, хто не обрав місто (вкл. наявних
користувачів), бачать Варшаву. Каталог пива, рейтинги, drunk-статус і розширення/`/match`
лишаються глобальними (міста-незалежними).
```

- [ ] **Step 2: Full verification**

Run: `npx vitest run && npm run build`
Expected: entire suite green, no TS errors.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): multi-city ontap ingest + /city command (#146)"
```

---

## Notes for the implementer

- **No `extension/**` change** — `docs/extension-install-uk.md` is intentionally untouched (no new badge/option/shop/popup).
- **The `Messages` interface is exhaustive** — adding the three `city.*`/`cmd.city` keys requires editing `src/i18n/types.ts` **and all three** locale files (`uk`, `pl`, `en`) or `npm run build` fails. Task 6 does all four.
- **Existing-data safety:** `pubs.city` defaults to `'warszawa'`, so all current pubs become Warsaw pubs automatically; `user_profiles.city` is NULL for everyone → resolves to Warsaw. No user sees a behaviour change until they run `/city`.
- **`/refresh` is deliberately unchanged** (its evolution is #144). It now covers all cities purely because `refreshOntap` loops `CITIES`; no city logic was added to the refresh command itself.
- **Validate city slugs against real pages** before/at launch (capture each `ontap.pl/<slug>`). A wrong slug silently yields an empty index — the per-city try/catch keeps the run healthy, but that city would have zero pubs.
