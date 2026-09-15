# Ключ лінку крана — пара «броварня + назва крана» (#632) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** лінк крана (`match_links`) ключується парою точного тексту броварні крана й назви крана, тож кран однієї
броварні більше не переписує лінк і не стирає штамп злиття крана іншої броварні з тією самою назвою, а паб показує пиво
своєї броварні.

**Architecture:** міграція v33 перебудовує `match_links` з `UNIQUE (ontap_ref, brewery_ref)` і розкладає наявні лінки
на пари за броварнями зі збережених знімків (одна броварня — пара з піном і доведеним штампом; кілька — копія на пару
без штампа й піна; жодної — видалення). `getMatch`/`upsertMatch` приймають броварню першим аргументом, `refresh-ontap`
передає `t.brewery_ref`. Показ крана і визначення «на крані» (#486) з'єднують кран із лінком за парою. Піни знімаються й
перелічуються за парою.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-15-632-ontap-pair-key-design.md`

## Global Constraints

- **Ключ — точний текст.** Жодної канонізації (NFC, регістр) і жодного нормалізатора для `brewery_ref`/`ontap_ref`.
  Єдине перетворення — `NULL` броварні крана → `''` (`tapBreweryKey`).
- **Коментарі українською, ідентифікатори англійською.**
- **Повний гейт після КОЖНОЇ задачі:** `npm test && npm run typecheck`.
- **Кожен новий тест мутаційно доведений** (`scratchpad/mutate.py <spec.json>` з попередньої сесії або вручну: видалити
  рядок фіксу → тест червоний → повернути).
- **Код важить більше за план:** якщо рядок, назва чи сигнатура в коді відрізняються від плану — слідувати коду й
  назвати розбіжність у звіті.
- **Розмір задач:** Task 1 — диспатч імплементера (понад два файли: схема, сховище, інжест і механічне оновлення
  викликів у тестах); Task 2–4 — інлайн (≤2 файли коду + тести). Імплементер Task 1 комітить **лише у worktree**
  `/home/ysi/warsaw-beer-bot/.claude/worktrees/632-ontap-pair-key` (гілка `fix/632-ontap-pair-key`), ніколи в основному
  checkout.

---

### Task 1: ключ пари в схемі, сховищі й інжесті (диспатч)

**Files:**
- Modify: `src/storage/schema.ts` — нова міграція `version: 33` наприкінці `MIGRATIONS`
- Modify: `src/storage/match_links.ts` — `tapBreweryKey`, `MatchRow.brewery_ref`, `upsertMatch`, `getMatch`
- Modify: `src/jobs/refresh-ontap.ts:112,124,145` — передати `t.brewery_ref`
- Test: `src/storage/schema.test.ts`, `src/storage/match_links.test.ts`, `src/jobs/refresh-ontap.test.ts`
- Test (механічно, лише нова сигнатура): `src/bot/commands/beers-build.test.ts`, `src/bot/commands/newbeers-build.test.ts`,
  `src/jobs/dedupe-brewery-aliases.test.ts`, `src/jobs/enrich-orphans.test.ts`, `src/storage/stats.test.ts`,
  `src/storage/beers.test.ts`, `src/storage/snapshots.test.ts`, `src/domain/pin-match.test.ts`

**Interfaces:**
- Produces:
  - `export function tapBreweryKey(breweryRef: string | null | undefined): string`
  - `export interface MatchRow { id: number; ontap_ref: string; brewery_ref: string; untappd_beer_id: number | null; confidence: number; reviewed_by_user: number; merged_at: string | null }`
  - `export function upsertMatch(db: DB, breweryRef: string | null, ontapRef: string, beerId: number | null, confidence: number): void`
  - `export function getMatch(db: DB, breweryRef: string | null, ontapRef: string): MatchRow | null`

- [ ] **Step 1: Тест петлі #632.** `src/jobs/refresh-ontap.test.ts`, наприкінці `describe('refreshOntap multi-city')`
  (там уже є `oneCity`, `geocoder`, `beerCount`, `panel`):

```ts
  test('#632: the same tap name of two breweries in two pubs never re-merges on the next cycle', async () => {
    const db = openDb(':memory:'); migrate(db);
    // Прод 2026-09-15: паб A (Friedenfelser) влучає у свою сироту, паб B (Rittmayer) промахується повз канонічний
    // рядок і доходить до нього лише злиттям. До #632 обидва крани ділили лінк `Hefeweizen`: паб A стирав штамп, і паб B
    // щоцикла створював і зливав сироту заново.
    const friedenfelser = seedBeer(db, {
      name: 'Hefeweizen', brewery: 'Friedenfelser Brewery', style: null, abv: 5.2, rating_global: null,
      normalized_name: normalizeName('Hefeweizen'), normalized_brewery: normalizeBrewery('Friedenfelser Brewery'),
    });
    const rittmayer = seedBeer(db, {
      untappd_id: 129947, name: 'Hallerndorfer Hefeweizen', brewery: 'Brauerei Rittmayer Hallerndorf',
      style: null, abv: 5.0, rating_global: 3.8,
      normalized_name: normalizeName('Hallerndorfer Hefeweizen'),
      normalized_brewery: normalizeBrewery('Brauerei Rittmayer Hallerndorf'),
    });
    const index = `
      <div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>
      <div onclick="location.assign('https://pubb.ontap.pl/')"><div class="panel-body">B 1 taps</div></div>`;
    const page = (brewery: string, h4: string) =>
      `<html><head><meta property="og:title" content="P / ontap.pl"></head><body>${panel(1, brewery, h4, 'Hefeweizen')}</body></html>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/') return page('Friedenfelser Brewery', 'Hefeweizen 5,2%');
        if (url === 'https://pubb.ontap.pl/') return page('Brauerei Rittmayer Hallerndorf Brewery', 'Hefeweizen 5%');
        return '';
      },
    };
    let searches = 0;
    const search: BeerSearch = {
      search: async () => {
        searches++;
        return [{
          bid: 129947, beer_name: 'Hallerndorfer Hefeweizen', brewery_name: 'Brauerei Rittmayer Hallerndorf',
          style: null, abv: 5, global_rating: 3.8,
        }];
      },
    };
    const run = () => refreshOntap({
      db, log: silentLog, http, search, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 5, lookupSleepMs: 0,
    });
    const RITTMAYER = 'Brauerei Rittmayer Hallerndorf Brewery';

    await run();
    // Передумова: перший цикл пройшов механізм #632 — паб A влучив без пошуку, паб B злив свою сироту в Rittmayer.
    expect(db.prepare('SELECT DISTINCT brewery_ref, beer_ref FROM taps ORDER BY brewery_ref').all()).toEqual([
      { brewery_ref: RITTMAYER, beer_ref: 'Hefeweizen' },
      { brewery_ref: 'Friedenfelser Brewery', beer_ref: 'Hefeweizen' },
    ]);
    expect(searches).toBe(1);
    expect(getMatch(db, RITTMAYER, 'Hefeweizen')?.untappd_beer_id).toBe(rittmayer);
    expect(getMatch(db, RITTMAYER, 'Hefeweizen')?.merged_at).not.toBeNull();

    await run();

    expect(searches).toBe(1);
    expect(beerCount(db)).toBe(2);
    expect(getMatch(db, 'Friedenfelser Brewery', 'Hefeweizen')?.untappd_beer_id).toBe(friedenfelser);
    expect(getMatch(db, RITTMAYER, 'Hefeweizen')?.untappd_beer_id).toBe(rittmayer);
    expect(getMatch(db, RITTMAYER, 'Hefeweizen')?.merged_at).not.toBeNull();
  });
```

  (Ключі перевірено пробою `parsePubPage` 2026-09-15: `["Friedenfelser Brewery","Hefeweizen",5.2]`,
  `["Brauerei Rittmayer Hallerndorf Brewery","Hefeweizen",5]`.)

- [ ] **Step 2: Тести сховища.** `src/storage/match_links.test.ts` — файл цілком:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { seedBeer } from './seed-beer.testing';
import { upsertMatch, getMatch, listUnreviewedBelow, tapBreweryKey } from './match_links';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const id = seedBeer(db, {
    name: 'X', brewery: 'B', style: null, abv: null, rating_global: null,
    normalized_name: 'x', normalized_brewery: 'b',
  });
  const other = seedBeer(db, {
    name: 'Y', brewery: 'C', style: null, abv: null, rating_global: null,
    normalized_name: 'y', normalized_brewery: 'c',
  });
  return { db, beerId: id, otherId: other };
}

test('upsertMatch upserts by the brewery + tap name pair', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'PINTA', 'Atak', beerId, 0.9);
  upsertMatch(db, 'PINTA', 'Atak', beerId, 1.0);
  expect(getMatch(db, 'PINTA', 'Atak')?.confidence).toBe(1.0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM match_links').get()).toEqual({ n: 1 });
});

test('#632 the same tap name of two breweries keeps two links, and one never clears the other\'s merge stamp', () => {
  const { db, beerId, otherId } = setup();
  upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', beerId, 1.0);
  upsertMatch(db, 'Brauerei Rittmayer Hallerndorf Brewery', 'Hefeweizen', otherId, 1.0);
  db.prepare(
    "UPDATE match_links SET merged_at = '2026-09-15T00:03:44Z' WHERE brewery_ref = 'Brauerei Rittmayer Hallerndorf Brewery'",
  ).run();

  // Матчер паба Friedenfelser переписує лише свою пару.
  upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', beerId, 1.0);

  expect(getMatch(db, 'Friedenfelser Brewery', 'Hefeweizen')?.untappd_beer_id).toBe(beerId);
  expect(getMatch(db, 'Brauerei Rittmayer Hallerndorf Brewery', 'Hefeweizen')).toMatchObject({
    untappd_beer_id: otherId, merged_at: '2026-09-15T00:03:44Z',
  });
});

test('#632 a tap without a brewery is its own pair: NULL and empty text are the same key', () => {
  const { db, beerId } = setup();
  expect(tapBreweryKey(null)).toBe('');
  upsertMatch(db, null, 'Hefeweizen', beerId, 1.0);
  expect(getMatch(db, '', 'Hefeweizen')?.untappd_beer_id).toBe(beerId);
  expect(getMatch(db, 'Friedenfelser Brewery', 'Hefeweizen')).toBeNull();
});

test('listUnreviewedBelow returns low-confidence, not yet reviewed', () => {
  const { db, beerId } = setup();
  upsertMatch(db, null, 'a', beerId, 0.7);
  upsertMatch(db, null, 'b', beerId, 0.95);
  expect(listUnreviewedBelow(db, 0.85).map((r) => r.ontap_ref)).toEqual(['a']);
});

test('upsertMatch clears a merge stamp — a matcher write is never merge-derived', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'PINTA', 'atak', beerId, 1.0);
  db.prepare("UPDATE match_links SET merged_at = '2026-07-30T00:00:00Z' WHERE ontap_ref = 'atak'").run();

  upsertMatch(db, 'PINTA', 'atak', beerId, 0.8);

  expect(getMatch(db, 'PINTA', 'atak')?.merged_at).toBeNull();
});
```

- [ ] **Step 3: Тест міграції.** `src/storage/schema.test.ts`:
  - імпорти: додати `import { upsertPub } from './pubs';` і `import { createSnapshot, insertTaps } from './snapshots';`;
  - у тесті `'rewrites legacy wontfix rows during the rebuild'` рядок коментаря
    `// 29 -> 30 by MCP wiring task 1, 30 -> 31 by #616, 31 -> 32 by #614: this rewind starts from v23` →
    `// 29 -> 30 by MCP wiring task 1, 30 -> 31 by #616, 31 -> 32 by #614, 32 -> 33 by #632: this rewind starts from v23`,
    а `.toBe(32);` → `.toBe(33);`;
  - останнім блоком усередині `describe('schema migrations')`, безпосередньо перед його закривальним `});`:

```ts
  describe('migration v33 — match_links keyed by the tap brewery + name pair (#632)', () => {
    it('splits links by the breweries seen in snapshots, keeps only proven pins and stamps, drops dead links', () => {
      const db = openDb(':memory:');
      migrate(db);
      // Відкат лише v33: стара форма таблиці (ключ — сама назва), дані — поверх неї, далі справжня міграція.
      db.exec(`
        DROP TABLE match_links;
        CREATE TABLE match_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ontap_ref TEXT NOT NULL UNIQUE,
          untappd_beer_id INTEGER REFERENCES beers(id),
          confidence REAL NOT NULL,
          reviewed_by_user INTEGER NOT NULL DEFAULT 0,
          merged_at TEXT
        );
      `);
      db.prepare('DELETE FROM schema_version WHERE version >= 33').run();
      for (const id of [1, 2, 3, 4]) seedBeer(db, id);

      const pubA = upsertPub(db, { slug: 'a', name: 'A', address: null, lat: null, lon: null, city: 'warszawa' });
      const pubB = upsertPub(db, { slug: 'b', name: 'B', address: null, lat: null, lon: null, city: 'warszawa' });
      const tap = (beer_ref: string, brewery_ref: string | null) =>
        ({ tap_number: 1, beer_ref, brewery_ref, abv: null, ibu: null, style: null, u_rating: null });
      insertTaps(db, createSnapshot(db, pubA, '2026-09-01T00:00:00Z'), [
        tap('Solo', 'Solo Brewery'), tap('Hefeweizen', 'Friedenfelser Brewery'), tap('No Brewery', null),
      ]);
      insertTaps(db, createSnapshot(db, pubB, '2026-09-02T00:00:00Z'), [
        tap('Hefeweizen', 'Brauerei Rittmayer Hallerndorf Brewery'), tap('Old Stamp', 'Old Brewery'),
      ]);
      db.prepare(
        `INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user, merged_at) VALUES
           ('Solo', 1, 1.0, 1, '2026-09-05T00:00:00Z'),
           ('Old Stamp', 2, 1.0, 0, '2026-08-01T00:00:00Z'),
           ('Hefeweizen', 3, 1.0, 1, '2026-09-05T00:00:00Z'),
           ('No Brewery', 4, 0.9, 0, NULL),
           ('Dead', 1, 1.0, 1, '2026-09-05T00:00:00Z')`,
      ).run();

      migrate(db);

      expect(db.prepare(
        `SELECT ontap_ref, brewery_ref, untappd_beer_id, confidence, reviewed_by_user, merged_at
           FROM match_links ORDER BY ontap_ref, brewery_ref`,
      ).all()).toEqual([
        // Кілька броварень: копія на кожну пару, без піна й штампа — інжест перерахує.
        { ontap_ref: 'Hefeweizen', brewery_ref: 'Brauerei Rittmayer Hallerndorf Brewery', untappd_beer_id: 3, confidence: 1, reviewed_by_user: 0, merged_at: null },
        { ontap_ref: 'Hefeweizen', brewery_ref: 'Friedenfelser Brewery', untappd_beer_id: 3, confidence: 1, reviewed_by_user: 0, merged_at: null },
        // Кран без броварні — пара з порожнім текстом.
        { ontap_ref: 'No Brewery', brewery_ref: '', untappd_beer_id: 4, confidence: 0.9, reviewed_by_user: 0, merged_at: null },
        // Штамп старший за перший знімок назви: броварня в момент злиття не доведена.
        { ontap_ref: 'Old Stamp', brewery_ref: 'Old Brewery', untappd_beer_id: 2, confidence: 1, reviewed_by_user: 0, merged_at: null },
        // Одна броварня: пін і доведений штамп лишаються. 'Dead' (жодного крана) видалено разом із піном.
        { ontap_ref: 'Solo', brewery_ref: 'Solo Brewery', untappd_beer_id: 1, confidence: 1, reviewed_by_user: 1, merged_at: '2026-09-05T00:00:00Z' },
      ]);

      // Ключ — пара: та сама пара вдруге падає, та сама назва іншої броварні — ні.
      const insert = db.prepare('INSERT INTO match_links (ontap_ref, brewery_ref, untappd_beer_id, confidence) VALUES (?, ?, 1, 1.0)');
      expect(() => insert.run('Solo', 'Solo Brewery')).toThrow(/UNIQUE/);
      expect(() => insert.run('Solo', 'Another Brewery')).not.toThrow();
    });
  });
```

  (`seedBeer(db, id)` — локальний хелпер `schema.test.ts`, не `seed-beer.testing`.)

- [ ] **Step 4: Прогнати — FAIL.** `npx vitest run src/storage/schema.test.ts src/storage/match_links.test.ts src/jobs/refresh-ontap.test.ts`
  — нові тести червоні (немає `brewery_ref`, стара сигнатура).

- [ ] **Step 5: Міграція.** `src/storage/schema.ts`, наприкінці масиву `MIGRATIONS` після `version: 32`:

```ts
  {
    version: 33,
    // #632: `ontap_ref` — лише текст назви крана. Один рядок лінку ділили крани різних броварень з однаковою назвою
    // («Hefeweizen» Friedenfelser і Rittmayer): паб, де матчер влучав, переписував лінк і стирав штамп злиття (#366),
    // а паб, де промахувався, щоцикла створював і зливав сироту заново; показ пабу брав пиво останнього паба циклу.
    // Ключ — пара точного тексту броварні крана (NULL → '') і назви крана. Наявні лінки розкладаються за броварнями
    // зі збережених знімків:
    // - одна броварня → пара; пін лишається; штамп — лише якщо не старший за перший знімок цієї назви (інакше в
    //   момент злиття могла бути інша броварня);
    // - кілька броварень → копія на кожну пару без піна й штампа: котрій броварні належить ціль, невідомо, тож
    //   показ до інжесту не змінюється, а інжест перераховує;
    // - жодної → видалення: ні показ, ні #486 такий лінк не читають.
    // Dry-run на байтовій копії прод-БД 2026-09-15: 5408 → 1680 лінків, 7 пінів, 22 штампи; показ 1692 кранів не змінився.
    // Перебудова, а не ALTER: SQLite не змінює UNIQUE на місці. Повторний прогін (тести відкату в schema.test.ts)
    // безпечний: SELECT читає лише ontap_ref, який є в обох формах таблиці.
    sql: `
      CREATE TABLE match_links_v33 (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ontap_ref        TEXT NOT NULL,
        brewery_ref      TEXT NOT NULL DEFAULT '',
        untappd_beer_id  INTEGER REFERENCES beers(id),
        confidence       REAL NOT NULL,
        reviewed_by_user INTEGER NOT NULL DEFAULT 0,
        merged_at        TEXT,
        UNIQUE (ontap_ref, brewery_ref)
      );
      INSERT INTO match_links_v33 (ontap_ref, brewery_ref, untappd_beer_id, confidence, reviewed_by_user, merged_at)
        WITH pairs AS (
               SELECT DISTINCT beer_ref, coalesce(brewery_ref, '') AS brewery_ref FROM taps
             ),
             counts AS (
               SELECT beer_ref, COUNT(*) AS n FROM pairs GROUP BY beer_ref
             ),
             first_seen AS (
               SELECT t.beer_ref, MIN(s.snapshot_at) AS at
                 FROM taps t JOIN tap_snapshots s ON s.id = t.snapshot_id
                GROUP BY t.beer_ref
             )
        SELECT ml.ontap_ref, p.brewery_ref, ml.untappd_beer_id, ml.confidence,
               CASE WHEN c.n = 1 THEN ml.reviewed_by_user ELSE 0 END,
               CASE WHEN c.n = 1 AND ml.merged_at >= f.at THEN ml.merged_at ELSE NULL END
          FROM match_links ml
          JOIN pairs p ON p.beer_ref = ml.ontap_ref
          JOIN counts c ON c.beer_ref = ml.ontap_ref
          JOIN first_seen f ON f.beer_ref = ml.ontap_ref;
      DROP TABLE match_links;
      ALTER TABLE match_links_v33 RENAME TO match_links;
    `,
  },
```

- [ ] **Step 6: Сховище.** `src/storage/match_links.ts` — замінити `MatchRow`, `upsertMatch`, `getMatch`:

```ts
export interface MatchRow {
  id: number;
  ontap_ref: string;
  brewery_ref: string;        // #632: точний текст броварні крана; '' коли в крана її немає
  untappd_beer_id: number | null;
  confidence: number;
  reviewed_by_user: number;
  merged_at: string | null;   // #366: non-null ⇒ this link was established by a merge
}

// #632: ключ лінку крана — пара точного тексту броварні крана й назви крана. Броварня крана буває NULL (у `taps`,
// ніколи не ''), і такий кран — окрема пара з порожнім текстом. Єдине місце, де NULL зводиться до ''.
export function tapBreweryKey(breweryRef: string | null | undefined): string {
  return breweryRef ?? '';
}

// #366: this is the matcher's write path (both call sites live in refresh-ontap), so it also
// clears merged_at. Invariant: a link written by the matcher is never merge-derived, which is
// what keeps the matcher authoritative over a remembered merge.
// #632: лише для своєї пари — кран іншої броварні з тією самою назвою цей запис не бачить.
export function upsertMatch(
  db: DB, breweryRef: string | null, ontapRef: string, beerId: number | null, confidence: number,
): void {
  db.prepare(
    `INSERT INTO match_links (ontap_ref, brewery_ref, untappd_beer_id, confidence, reviewed_by_user)
       VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(ontap_ref, brewery_ref) DO UPDATE SET
       untappd_beer_id = excluded.untappd_beer_id,
       confidence = excluded.confidence,
       merged_at = NULL`,
  ).run(ontapRef, tapBreweryKey(breweryRef), beerId, confidence);
}

export function getMatch(db: DB, breweryRef: string | null, ontapRef: string): MatchRow | null {
  return (db.prepare('SELECT * FROM match_links WHERE ontap_ref = ? AND brewery_ref = ?')
    .get(ontapRef, tapBreweryKey(breweryRef)) as MatchRow | undefined) ?? null;
}
```

- [ ] **Step 7: Інжест.** `src/jobs/refresh-ontap.ts`:
  - `const link = getMatch(db, t.beer_ref);` → `const link = getMatch(db, t.brewery_ref, t.beer_ref);` і над ним
    коментар `// #632: лінк — пара броварні й назви крана; кран іншої броварні з тією самою назвою його не переписує.`;
  - `upsertMatch(db, t.beer_ref, m.id, m.confidence);` → `upsertMatch(db, t.brewery_ref, t.beer_ref, m.id, m.confidence);`;
  - `upsertMatch(db, t.beer_ref, beerId, 1.0);` → `upsertMatch(db, t.brewery_ref, t.beer_ref, beerId, 1.0);`.

- [ ] **Step 8: Механічне оновлення викликів у тестах** (`npm run typecheck` перелічить усі). Правило: перший новий
  аргумент — `brewery_ref` крана, який той самий тест вставляє з цією назвою; `null`, коли тест крана не вставляє або
  вставляє з `brewery_ref: null`. Перелік на 2026-09-15:
  - `src/jobs/refresh-ontap.test.ts`: тест `'leaves a pinned tap link untouched…'` — `upsertMatch(db, 'Recraft', 'Urodzinowe', …)`,
    `getMatch(db, 'Recraft', 'Urodzinowe')`; три тести `#366` — `'Moon Lark Brewery'` у кожному `upsertMatch`/`getMatch`
    з `'Deep Sea Diver'`;
  - `src/bot/commands/beers-build.test.ts`: рядок 86 — `'PINTA'`; 120, 176, 198 — `'JBW Brewery'`; 220 — `null`;
  - `src/bot/commands/newbeers-build.test.ts`: 38 — `'PINTA'`; 39 і 137 — `'Stu Mostow'`; 64 — `'Mystery Brewery'`; 65 — `null`;
    173 — `'Co-op'`; 244 — `'Test'`;
  - `src/jobs/dedupe-brewery-aliases.test.ts`: усі 8 — `null`;
  - `src/jobs/enrich-orphans.test.ts`: 45 — `brewery` (змінна, яку тест кладе в `brewery_ref`);
  - `src/storage/stats.test.ts`: 187, 208 — `null`;
  - `src/storage/beers.test.ts`: 166 і 486 — `opts.brewery`; 423 — `'Weihenstephaner'`; 1261, 1269 — `'Br'`; 1277 — `null`;
  - `src/storage/snapshots.test.ts`: 62 — `'PINTA'`; 83 — `'Stu Mostow'`; 104 — `'New Brews'`; 135 —
    `'Brasserie La Malpolon Brewery'`; 156 — `'X'`;
  - `src/domain/pin-match.test.ts`: усі `upsertMatch`/`getMatch` — `null` першим аргументом (тести кранів не вставляють).

  Сирі `INSERT INTO match_links (ontap_ref, …)` у тестах (`lookup-outcome`, `beers`, `schema`, `untappd-enrich`,
  `cleanup-polluted-ontap`) не змінювати: `brewery_ref` бере `DEFAULT ''`.

- [ ] **Step 9: Зелене:** `npx vitest run src/storage/schema.test.ts src/storage/match_links.test.ts src/jobs/refresh-ontap.test.ts`

- [ ] **Step 10: Мутації** (кожна — червоний тест, потім повернути):
  - m1 `refresh-ontap.ts`: `getMatch(db, t.brewery_ref, t.beer_ref)` → `getMatch(db, null, t.beer_ref)` і обидва
    `upsertMatch(db, t.brewery_ref,` → `upsertMatch(db, null,` → падає тест петлі (другий цикл: `searches` 2);
  - m2 `match_links.ts`: `WHERE ontap_ref = ? AND brewery_ref = ?` → `WHERE ontap_ref = ? AND (brewery_ref = ? OR 1)` →
    падає `#632 the same tap name of two breweries keeps two links…` (або `…NULL and empty text…`);
  - m3 v33: `CASE WHEN c.n = 1 AND ml.merged_at >= f.at` → `CASE WHEN c.n = 1` → падає тест v33 (`Old Stamp` зберігає штамп);
  - m4 v33: `CASE WHEN c.n = 1 THEN ml.reviewed_by_user ELSE 0 END` → `ml.reviewed_by_user` → падає тест v33 (пін на `Hefeweizen`).

- [ ] **Step 11: Повний гейт і коміт**

```bash
npm test && npm run typecheck
git add src/storage/schema.ts src/storage/schema.test.ts src/storage/match_links.ts src/storage/match_links.test.ts \
  src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts src/bot/commands/beers-build.test.ts \
  src/bot/commands/newbeers-build.test.ts src/jobs/dedupe-brewery-aliases.test.ts src/jobs/enrich-orphans.test.ts \
  src/storage/stats.test.ts src/storage/beers.test.ts src/storage/snapshots.test.ts src/domain/pin-match.test.ts
git commit -m "fix(#632): a tap link is keyed by the tap's brewery and name, so another brewery never clears its merge stamp"
```

  **Відомий проміжний стан** (закриває Task 2): показ і #486 ще з'єднують за самою назвою, тож назва двох броварень
  дає два рядки в `tapsForSnapshotWithBeer`. Не деплоїться окремо.

---

### Task 2: показ крана і «на крані» (#486) за парою (інлайн)

**Files:**
- Modify: `src/storage/snapshots.ts` — `tapsForSnapshotWithBeer`
- Modify: `src/storage/beers.ts` — `onLatestTapPredicate`
- Test: `src/storage/snapshots.test.ts`, `src/storage/beers.test.ts`

**Interfaces:**
- Consumes: `upsertMatch(db, breweryRef, ontapRef, beerId, confidence)` (Task 1).

- [ ] **Step 1: Тест показу.** `src/storage/snapshots.test.ts`, наприкінці `describe('tapsForSnapshotWithBeer')`:

```ts
  test('#632 two pubs pouring the same tap name from different breweries each show their own beer', () => {
    const { db, pubId } = setup();
    const pubB = upsertPub(db, { slug: 'q', name: 'Q', address: null, lat: null, lon: null, city: 'warszawa' });
    const friedenfelser = seedBeer(db, {
      name: 'Hefeweizen', brewery: 'Friedenfelser Brewery', style: null, abv: 5.2, rating_global: null,
      normalized_name: 'hefeweizen', normalized_brewery: 'friedenfelser',
    });
    const rittmayer = seedBeer(db, {
      untappd_id: 129947, name: 'Hallerndorfer Hefeweizen', brewery: 'Brauerei Rittmayer Hallerndorf',
      style: null, abv: 5.0, rating_global: 3.8,
      normalized_name: 'hallerndorfer hefeweizen', normalized_brewery: 'rittmayer hallerndorf',
    });
    upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', friedenfelser, 1.0);
    upsertMatch(db, 'Brauerei Rittmayer Hallerndorf Brewery', 'Hefeweizen', rittmayer, 1.0);
    const snapA = createSnapshot(db, pubId, '2026-09-15T00:01:29Z');
    insertTaps(db, snapA, [
      { tap_number: 1, beer_ref: 'Hefeweizen', brewery_ref: 'Friedenfelser Brewery', abv: 5.2, ibu: null, style: null, u_rating: null },
    ]);
    const snapB = createSnapshot(db, pubB, '2026-09-15T00:03:44Z');
    insertTaps(db, snapB, [
      { tap_number: 1, beer_ref: 'Hefeweizen', brewery_ref: 'Brauerei Rittmayer Hallerndorf Brewery', abv: 5.0, ibu: null, style: null, u_rating: null },
    ]);

    // До #632 обидва паби показували рядок, записаний останнім (прод: паби 39 і 58 — Rittmayer замість Friedenfelser).
    expect(tapsForSnapshotWithBeer(db, snapA).map((r) => [r.beer_id, r.untappd_id])).toEqual([[friedenfelser, null]]);
    expect(tapsForSnapshotWithBeer(db, snapB).map((r) => [r.beer_id, r.untappd_id])).toEqual([[rittmayer, 129947]]);
  });

  test('#632 a tap without a brewery shows the link of the empty-brewery pair', () => {
    const { db, snapId } = setupWithBeer();
    const mine = seedBeer(db, {
      name: 'Mystery', brewery: 'Anon', style: null, abv: null, rating_global: null,
      normalized_name: 'mystery', normalized_brewery: 'anon',
    });
    const theirs = seedBeer(db, {
      name: 'Mystery', brewery: 'Someone', style: null, abv: null, rating_global: null,
      normalized_name: 'mystery', normalized_brewery: 'someone',
    });
    upsertMatch(db, null, 'Mystery', mine, 1.0);
    upsertMatch(db, 'Someone', 'Mystery', theirs, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Mystery', brewery_ref: null, abv: null, ibu: null, style: null, u_rating: null },
    ]);
    expect(tapsForSnapshotWithBeer(db, snapId).map((r) => r.beer_id)).toEqual([mine]);
  });
```

  Імпорт `upsertPub` додати: `import { upsertPub } from './pubs';` уже є на початку файлу — перевірити й не дублювати.

- [ ] **Step 2: Тест #486.** `src/storage/beers.test.ts`, у `describe('listLookupCandidates')` після тесту
  `'returns orphan beers currently on tap, omits beers with untappd_id'`:

```ts
  test('#632 an orphan whose brewery pair is off tap is not on tap because another brewery pours the same name', () => {
    const db = fresh();
    const offTap = seedBeer(db, {
      untappd_id: null, name: 'Hefeweizen', brewery: 'Friedenfelser Brewery', style: null, abv: null, rating_global: null,
      normalized_name: 'hefeweizen', normalized_brewery: 'friedenfelser',
    });
    const onTap = seedBeer(db, {
      untappd_id: null, name: 'Hefeweizen Rittmayer', brewery: 'Rittmayer', style: null, abv: null, rating_global: null,
      normalized_name: 'hefeweizen rittmayer', normalized_brewery: 'rittmayer',
    });
    upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', offTap, 1.0);
    upsertMatch(db, 'Rittmayer Brewery', 'Hefeweizen', onTap, 1.0);
    // Зараз назву «Hefeweizen» наливає лише Rittmayer.
    const pubId = upsertPub(db, { slug: 'pub-632', name: 'Pub 632', address: null, lat: null, lon: null, city: 'warszawa' });
    insertTaps(db, createSnapshot(db, pubId, '2026-05-26T12:00:00Z'), [{
      tap_number: 1, beer_ref: 'Hefeweizen', brewery_ref: 'Rittmayer Brewery',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    const ids = listLookupCandidates(db, 10, new Date('2026-05-26T12:00:00Z')).map((c) => c.id);
    expect(ids).toContain(onTap);
    expect(ids).not.toContain(offTap);
  });
```

- [ ] **Step 3: Прогнати — FAIL.** `npx vitest run src/storage/snapshots.test.ts src/storage/beers.test.ts` — перший тест
  показу (два рядки на кран), тест порожньої броварні (два рядки) і тест #486 (`offTap` у пулі) червоні.

- [ ] **Step 4: Реалізація.** `src/storage/snapshots.ts`, у `tapsForSnapshotWithBeer`: рядок
  `    LEFT JOIN match_links ml ON t.beer_ref = ml.ontap_ref` →
  `    LEFT JOIN match_links ml ON ml.ontap_ref = t.beer_ref AND ml.brewery_ref = coalesce(t.brewery_ref, '')`,
  а над `return db.prepare(` у цій функції коментар
  `// #632: лінк крана — пара броварні й назви; інакше всі паби з однією назвою показували б пиво останнього паба циклу.`

  `src/storage/beers.ts`, в `onLatestTapPredicate`: `           JOIN taps t ON t.beer_ref = ml.ontap_ref` →
  `           JOIN taps t ON t.beer_ref = ml.ontap_ref AND coalesce(t.brewery_ref, '') = ml.brewery_ref`,
  а в коментарі над константою після `a \`match_links\` row` дописати `(#632: keyed by the tap brewery + name pair)`.


- [ ] **Step 5: Зелене:** `npx vitest run src/storage/snapshots.test.ts src/storage/beers.test.ts`

- [ ] **Step 6: Мутації:** прибрати `AND ml.brewery_ref = coalesce(t.brewery_ref, '')` → падають обидва тести показу;
  прибрати `AND coalesce(t.brewery_ref, '') = ml.brewery_ref` → падає тест #486.

- [ ] **Step 7: Повний гейт і коміт**

```bash
npm test && npm run typecheck
git add src/storage/snapshots.ts src/storage/snapshots.test.ts src/storage/beers.ts src/storage/beers.test.ts
git commit -m "fix(#632): a pub shows and counts the link of its own tap brewery"
```

---

### Task 3: піни за парою, CLI (інлайн)

**Files:**
- Modify: `src/domain/pin-match.ts` — `PinRow`, `unpinByRef`, `listPins`
- Modify: `scripts/pin-match.ts` — `--unpin --ref [--brewery]`, `--list`, usage
- Test: `src/domain/pin-match.test.ts`

**Interfaces:**
- Consumes: `tapBreweryKey`, `upsertMatch(db, breweryRef, ontapRef, …)` (Task 1).
- Produces: `unpinByRef(db: DB, ontapRef: string, breweryRef?: string | null): number`;
  `PinRow { ontap_ref: string; brewery_ref: string; beer_id: number; brewery: string; name: string; untappd_id: number | null }`.

- [ ] **Step 1: Тести.** `src/domain/pin-match.test.ts`, у `describe('unpin & list')`:
  - у тесті `'listPins returns all pinned links with their beer + untappd_id'` очікуване →
    `{ ontap_ref: 'Pear taste', brewery_ref: '', beer_id: orphanId, brewery: 'CYDR Fizz', name: 'Pear taste', untappd_id: 1093012 }`;
  - наприкінці describe:

```ts
  test('#632 unpinByRef with a brewery unpins only that pair; without one, every pair of the tap name', () => {
    const db = newDb();
    const a = orphan(db, 'Friedenfelser', 'Hefeweizen');
    const b = orphan(db, 'Rittmayer', 'Hefeweizen Rittmayer');
    upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', a, 1.0);
    upsertMatch(db, 'Rittmayer Brewery', 'Hefeweizen', b, 1.0);
    db.prepare('UPDATE match_links SET reviewed_by_user = 1').run();

    expect(unpinByRef(db, 'Hefeweizen', 'Rittmayer Brewery')).toBe(1);
    expect(getMatch(db, 'Rittmayer Brewery', 'Hefeweizen')?.reviewed_by_user).toBe(0);
    expect(getMatch(db, 'Friedenfelser Brewery', 'Hefeweizen')?.reviewed_by_user).toBe(1);

    upsertMatch(db, 'Rittmayer Brewery', 'Hefeweizen', b, 1.0);
    db.prepare('UPDATE match_links SET reviewed_by_user = 1').run();
    expect(unpinByRef(db, 'Hefeweizen')).toBe(2);
  });

  test('#632 listPins shows the brewery of each pinned pair', () => {
    const db = newDb();
    const a = orphan(db, 'Friedenfelser', 'Hefeweizen');
    upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', a, 1.0);
    db.prepare('UPDATE match_links SET reviewed_by_user = 1').run();
    expect(listPins(db).map((p) => [p.brewery_ref, p.ontap_ref])).toEqual([['Friedenfelser Brewery', 'Hefeweizen']]);
  });
```

- [ ] **Step 2: Прогнати — FAIL:** `npx vitest run src/domain/pin-match.test.ts` (немає `brewery_ref` у `PinRow`,
  `unpinByRef` ігнорує броварню → 2 замість 1).

- [ ] **Step 3: Реалізація.** `src/domain/pin-match.ts`: імпорт `import { tapBreweryKey } from '../storage/match_links';`;

```ts
export interface PinRow {
  ontap_ref: string;
  brewery_ref: string;
  beer_id: number;
  brewery: string;
  name: string;
  untappd_id: number | null;
}

// Undo a pin by its tap (reliable for merged pins whose orphan row is gone).
// #366: also clears merged_at — unpinning means "recompute this tap", and a surviving merge
// stamp would make ingest reuse the very target the human just rejected.
// #632: лінк крана — пара броварні й назви. З броварнею знімається пін лише цієї пари; без неї — піни всіх пар цієї
// назви (людина, яка знає лише назву крана, не мусить вгадувати написання броварні).
export function unpinByRef(db: DB, ontapRef: string, breweryRef?: string | null): number {
  if (breweryRef === undefined) {
    return db
      .prepare('UPDATE match_links SET reviewed_by_user = 0, merged_at = NULL WHERE ontap_ref = ? AND reviewed_by_user = 1')
      .run(ontapRef).changes as number;
  }
  return db
    .prepare(
      `UPDATE match_links SET reviewed_by_user = 0, merged_at = NULL
        WHERE ontap_ref = ? AND brewery_ref = ? AND reviewed_by_user = 1`,
    )
    .run(ontapRef, tapBreweryKey(breweryRef)).changes as number;
}
```

  `listPins`: у SELECT додати `ml.brewery_ref AS brewery_ref,` після `ml.ontap_ref AS ontap_ref,`, `ORDER BY ml.ontap_ref`
  → `ORDER BY ml.ontap_ref, ml.brewery_ref`.

  `scripts/pin-match.ts`:
  - `--list`: `` console.log(`${p.ontap_ref}  →  #${p.beer_id} ${p.brewery} / ${p.name}  (untappd ${p.untappd_id})`); `` →
    `` console.log(`${p.brewery_ref || '(no brewery)'} | ${p.ontap_ref}  →  #${p.beer_id} ${p.brewery} / ${p.name}  (untappd ${p.untappd_id})`); ``
  - `--unpin`: після `const beer = argVal(argv, '--beer');` додати `const brewery = argVal(argv, '--brewery');`;
    `` console.log(`Unpinned ${unpinByRef(db, ref)} link(s) for ref "${ref}".`); `` →
    `` console.log(`Unpinned ${unpinByRef(db, ref, brewery)} link(s) for ref "${ref}"${brewery === undefined ? '' : ` of brewery "${brewery}"`}.`); ``;
    `'--unpin requires --ref <ontap_ref> or --beer <id>'` → `'--unpin requires --ref <ontap_ref> [--brewery <brewery_ref>] or --beer <id>'`;
  - usage: `--unpin (--ref <r> | --beer <id>)` → `--unpin (--ref <r> [--brewery <b>] | --beer <id>)`.

- [ ] **Step 4: Зелене:** `npx vitest run src/domain/pin-match.test.ts scripts/pin-match.test.ts`

- [ ] **Step 5: Мутації:** у `unpinByRef` гілку з броварнею замінити на запит без `AND brewery_ref = ?` (і `.run(ontapRef)`)
  → падає `#632 unpinByRef with a brewery…`; прибрати `ml.brewery_ref AS brewery_ref,` → падає `#632 listPins…`.

- [ ] **Step 6: Повний гейт і коміт**

```bash
npm test && npm run typecheck
git add src/domain/pin-match.ts src/domain/pin-match.test.ts scripts/pin-match.ts
git commit -m "feat(#632): pins are unpinned and listed by the tap brewery + name pair"
```

---

### Task 4: `spec.md` і dry-run справжньої міграції на копії прод-БД (інлайн)

**Files:**
- Modify: `spec.md`
- Scratchpad (не комітиться): `632-predeploy.db`, `632-display.sql`, `632-migrate.mts`

- [ ] **Step 1: `spec.md` §3.6 `match_links`.**
  - рядок таблиці `| \`ontap_ref\` | TEXT | NOT NULL UNIQUE | сире посилання з крана |` →
    `| \`ontap_ref\` | TEXT | NOT NULL | точний текст назви крана |`, а одразу після нього новий рядок
    `| \`brewery_ref\` | TEXT | NOT NULL DEFAULT \`''\` | точний текст броварні крана; \`''\`, коли в крана її немає. **Ключ лінку — \`UNIQUE (ontap_ref, brewery_ref)\`** (#632) |`;
  - після таблиці (перед `> ⚠️ **Gotcha:**`) новий абзац:
    `**Ключ — пара броварні й назви крана (#632).** До v33 лінк ключувався самою назвою, і крани різних броварень з однаковою назвою («Hefeweizen» Friedenfelser і Rittmayer) ділили один рядок: паб, де матчер влучав, переписував лінк і стирав штамп злиття, паб, де промахувався, щоцикла створював і зливав сироту, а показ пабу брав пиво останнього паба циклу. Ключ — точний текст без канонізації: з'єднання \`taps\` ↔ \`match_links\` іде в SQL (показ, #486), а \`ontap_ref\` і до того розрізняв регістр. Та сама броварня з іншим написанням (\`PINTA\` / \`PINTA Brewery\`) — окремі пари; матчер зводить їх до того самого пива.`;
  - `(\`--beer/--untappd\` для піна, \`--unpin --ref/--beer\`, \`--list\`)` → `(\`--beer/--untappd\` для піна, \`--unpin --ref [--brewery]/--beer\`, \`--list\`)`;
  - `Пін ключується на сирому рядку назви\nкрана (\`ontap_ref\`)` → `Пін ключується на парі точного тексту броварні й\nназви крана (\`brewery_ref\`, \`ontap_ref\`)`;
  - `Скасувати хибну пам'ять = \`UPDATE match_links SET merged_at = NULL WHERE ontap_ref = …\`;` →
    `Скасувати хибну пам'ять = \`UPDATE match_links SET merged_at = NULL WHERE ontap_ref = … AND brewery_ref = …\`;`.

- [ ] **Step 2: `spec.md` §3.19 і пули.**
  - після рядка `| 32 | \`beer_aliases\` (#614) …|` новий рядок:
    `| 33 | \`match_links\` перебудовано з ключем \`UNIQUE (ontap_ref, brewery_ref)\` (#632). Наявні лінки розкладено за броварнями зі збережених знімків: одна броварня — пара з піном і штампом, не старшим за перший знімок назви; кілька — копія на пару без піна й штампа; жодної — видалено. Dry-run на байтовій копії прод-БД: 5408 → 1680 лінків, показ 1692 кранів і множина «на крані» без змін |`;
  - в абзаці «**Два пули кандидатів, один бюджет (#368).**» `(\`match_links → taps → tap_snapshots\`)` →
    `(\`match_links → taps → tap_snapshots\`, лінк з'єднується з краном за парою броварні й назви, #632)`.

- [ ] **Step 3: `spec.md` §5.2.** Одразу після пункту, що починається з `(#366).** \`merged_at\` ставить лише \`mergeIntoCanonical\``
  (кінець цього пункту — перед наступним `- **`), новий пункт:
  `- **Лінк крана ключується парою точного тексту броварні й назви крана (#632).** Кран однієї броварні ніколи не переписує лінк і не скидає штамп злиття крана іншої броварні з тією самою назвою; показ крана й «на крані» (#486) з'єднують кран із лінком за цією парою.`

- [ ] **Step 4: Dry-run справжньої міграції.** Команди по одній (ізольована сесія відхиляє ланцюжки зі змінними):

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' ".backup /tmp/claude-1000/-home-ysi-warsaw-beer-bot/3cb31870-0d74-45c9-87cc-d40123be3a1e/scratchpad/632-predeploy.db"
```

  `scratchpad/632-display-before.sql`:

```sql
.output /tmp/claude-1000/-home-ysi-warsaw-beer-bot/3cb31870-0d74-45c9-87cc-d40123be3a1e/scratchpad/632-display-before.txt
SELECT s.pub_id, t.tap_number, t.beer_ref, coalesce(t.brewery_ref, ''), ml.untappd_beer_id
  FROM taps t JOIN tap_snapshots s ON s.id = t.snapshot_id
  LEFT JOIN match_links ml ON ml.ontap_ref = t.beer_ref
 WHERE t.snapshot_id IN (SELECT MAX(id) FROM tap_snapshots GROUP BY pub_id)
 ORDER BY 1, 2, 3, 4;
.output stdout
SELECT 'links before', COUNT(*) FROM match_links;
```

  `scratchpad/632-display-after.sql` — те саме, але `.output …/632-display-after.txt`, з'єднання
  `LEFT JOIN match_links ml ON ml.ontap_ref = t.beer_ref AND ml.brewery_ref = coalesce(t.brewery_ref, '')` і останні рядки
  `SELECT 'links after', COUNT(*) FROM match_links; SELECT 'pins', COUNT(*) FROM match_links WHERE reviewed_by_user = 1; SELECT 'stamps', COUNT(*) FROM match_links WHERE merged_at IS NOT NULL; SELECT MAX(version) FROM schema_version;`

  `scratchpad/632-migrate.mts`:

```ts
const W = '/home/ysi/warsaw-beer-bot/.claude/worktrees/632-ontap-pair-key/src';
const { openDb } = await import(`${W}/storage/db.ts`);
const { migrate } = await import(`${W}/storage/schema.ts`);
const db = openDb('/tmp/claude-1000/-home-ysi-warsaw-beer-bot/3cb31870-0d74-45c9-87cc-d40123be3a1e/scratchpad/632-predeploy.db');
const t0 = Date.now();
migrate(db);
console.log('migrated in', Date.now() - t0, 'ms');
db.close();
```

  Запуск: `sqlite3 <predeploy.db> < 632-display-before.sql`, потім `npx tsx <scratchpad>/632-migrate.mts`, потім
  `sqlite3 <predeploy.db> < 632-display-after.sql`, потім `cmp <before.txt> <after.txt>`.
  **Очікувано:** `cmp` без виводу (до міграції `ontap_ref` унікальний, тож дублікатів з'єднання немає; Python-модель
  2026-09-15 дала 0 різниць на 1692 кранах); `links after` ≈ 1680 (± крани, що з'явилися після 2026-09-15), версія 33.
  Будь-яка різниця в `cmp` — **стоп**, розбір перед PR.

- [ ] **Step 5: Повний гейт і коміт**

```bash
npm test && npm run typecheck
git add spec.md
git commit -m "docs(#632): spec.md — tap links, pins and merge memory are keyed by the tap brewery + name pair"
```

---

## Після задач

1. Наскрізне рев'ю гілки (Task 1–4), зокрема проміжний стан Task 1.
2. Рібейс на `origin/main`, повний гейт, `push --force-with-lease`, PR (закриває #632), цикл AI-рев'ю; мерджить користувач.
3. Після деплою — чекпойнт зі спеки.

## Самоперевірка плану проти спеки

| Розділ спеки | Де |
|---|---|
| Ключ пари, точний текст, NULL → `''` | Task 1 (`tapBreweryKey`, v33) |
| Міграція: три групи, правило штампа, мертві піни | Task 1 Step 3/5 |
| Рантайм 1–2 (`match_links.ts`, `refresh-ontap`) | Task 1 Step 6–7 |
| Рантайм 3–4 (показ, #486) | Task 2 |
| Рантайм 5 (піни, CLI) | Task 3 |
| Тест петлі через справжній `refreshOntap` | Task 1 Step 1 |
| Dry-run справжнім кодом перед PR | Task 4 Step 4 |
| `spec.md` §3.6, §3.19, пули, §5.2 | Task 4 |
