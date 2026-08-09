# Дренаж cron-недосяжних relay-orphan'ів (#368) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** дати enrich-крону бачити orphan'ів, у яких немає рядка в `match_links` (створених relay-шляхом розширення), добираючи ними **лише невикористані слоти** наявного `LIMIT 20`.

**Architecture:** новий сиблінг `listRelayLookupCandidates` у `src/storage/beers.ts` з інвертованим `match_links`-предикатом (пули диз'юнктні за побудовою); `enrichOrphans` спершу вичерпує on-tap пул, потім добирає relay-кандидатами залишок бюджету; два лічильники в результаті джоби та одна метрика в щоденному дайджесті роблять дренаж вимірюваним.

**Tech Stack:** Node.js + TypeScript (CommonJS), better-sqlite3, Vitest, pino.

**Design doc:** `docs/superpowers/specs/2026-08/2026-08-08-relay-orphan-drain-design.md`

---

## Файлова структура

| Файл | Відповідальність | Дія |
|---|---|---|
| `src/storage/beers.ts` | добір кандидатів на lookup — обидва пули живуть поруч із `listLookupCandidates`, бо це одна відповідальність | Modify |
| `src/storage/beers.test.ts` | тести обох пулів | Modify |
| `src/jobs/enrich-orphans.ts` | оркестрація запуску: бюджет, порядок пулів, лічильники | Modify |
| `src/jobs/enrich-orphans.test.ts` | тести бюджету й порядку | Modify |
| `src/storage/stats.ts` | метрика `orphansOffCron` | Modify |
| `src/storage/stats.test.ts` | тест метрики | Modify |
| `src/jobs/daily-status.ts` | рендер рядка «Каталог» | Modify |
| `src/jobs/daily-status.test.ts` | тест рендера | Modify |
| `spec.md` | джерело істини за OpenSpec | Modify |

Нових файлів немає: зміна лягає в наявні шви, і жоден із цих файлів не розрісся до потреби ділити.

**Порядок і залежності:** Task 1 → Task 2 (Task 2 імпортує функцію з Task 1). Task 3 незалежний від 1 і 2 — може йти паралельно. Task 4 (спека) — після 1–3.

**Гілка:** уся робота йде в worktree на гілці `worktree-368-relay-orphan-drain`. Перед КОЖНИМ комітом перевір, що ти в правильному дереві:

```bash
git rev-parse --show-toplevel && git branch --show-current
```

Очікується шлях worktree (НЕ `/home/ysi/warsaw-beer-bot`) і гілка `worktree-368-relay-orphan-drain`. Якщо бачиш `main` — зупинись і повідом, нічого не комітячи.

---

### Task 1: `listRelayLookupCandidates` — relay-пул

**Files:**
- Modify: `src/storage/beers.ts` (додати одразу після `listLookupCandidates`, тобто після рядка 271)
- Test: `src/storage/beers.test.ts` (новий `describe` одразу після `describe('listLookupCandidates', …)`, який закінчується на рядку ~371, перед коментарем `// PR-D3 helpers — rating-refresh`)

**Контекст, який треба знати:** `beers.test.ts` уже має локальний хелпер `fresh()` (створює `:memory:` БД + `migrate`), а імпорти `upsertBeer`, `recordEnrichFailure`, `setEnrichFailureReview`, `upsertPub`, `createSnapshot`, `insertTaps`, `upsertMatch` уже присутні у файлі вище (рядки 225–229). Додай `listRelayLookupCandidates` до наявного імпорту з `'./beers'` на рядку 229.

- [ ] **Step 1: Написати падаючі тести**

Додай у `src/storage/beers.test.ts` (імпорт на рядку 229 стає `import { listLookupCandidates, listRelayLookupCandidates } from './beers';`):

```ts
describe('listRelayLookupCandidates', () => {
  // Relay-orphan: рядок у `beers` БЕЗ жодного рядка в `match_links`. Саме такі
  // мінтить `/enrich/candidates` через ensureBeerRow для кожної картки крамниці.
  function seedRelayOrphan(
    db: ReturnType<typeof fresh>,
    opts: { brewery: string; name: string; untappdId?: number | null;
            lookupAt?: string | null; lookupCount?: number },
  ): number {
    const beerId = upsertBeer(db, {
      untappd_id: opts.untappdId ?? null,
      name: opts.name, brewery: opts.brewery,
      style: null, abv: null, rating_global: null,
      normalized_name: opts.name.toLowerCase(),
      normalized_brewery: opts.brewery.toLowerCase(),
    });
    if (opts.lookupAt !== undefined || opts.lookupCount !== undefined) {
      db.prepare(
        'UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = ? WHERE id = ?',
      ).run(opts.lookupAt ?? null, opts.lookupCount ?? 0, beerId);
    }
    return beerId;
  }

  // Той самий on-tap сид, що й у listLookupCandidates: beers + pub + snapshot +
  // match_links + taps. Потрібен, щоб довести диз'юнктність пулів.
  function seedBeerOnTapLocal(
    db: ReturnType<typeof fresh>,
    opts: { brewery: string; name: string },
  ): number {
    const beerId = upsertBeer(db, {
      untappd_id: null,
      name: opts.name, brewery: opts.brewery,
      style: null, abv: null, rating_global: null,
      normalized_name: opts.name.toLowerCase(),
      normalized_brewery: opts.brewery.toLowerCase(),
    });
    const pubId = upsertPub(db, {
      slug: `pub-${beerId}`, name: `Pub ${beerId}`,
      address: null, lat: null, lon: null, city: 'warszawa',
    });
    const snapId = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');
    const ref = `${opts.brewery} ${opts.name}`;
    upsertMatch(db, ref, beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: ref, brewery_ref: opts.brewery,
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    return beerId;
  }

  const NOW = new Date('2026-05-26T12:00:00Z');

  test('returns an orphan that has no match_links row at all', () => {
    const db = fresh();
    const id = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'All the Creamy Cows' });
    const out = listRelayLookupCandidates(db, 10, NOW);
    expect(out.map((c) => c.id)).toEqual([id]);
  });

  test('the two pools are disjoint: an on-tap linked orphan is NOT in the relay pool', () => {
    const db = fresh();
    const onTap = seedBeerOnTapLocal(db, { brewery: 'Magic Road', name: 'Clementine' });
    const relay = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'Toasted Delight' });

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([relay]);
    expect(listLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([onTap]);
  });

  test('omits beers already matched (untappd_id set)', () => {
    const db = fresh();
    seedRelayOrphan(db, { brewery: 'Pinta', name: 'Atak', untappdId: 12345 });
    expect(listRelayLookupCandidates(db, 10, NOW)).toEqual([]);
  });

  test('excludes orphans triaged as wontfix', () => {
    const db = fresh();
    const wontfix = seedRelayOrphan(db, { brewery: 'Stoelzle', name: 'Kelih Fino 545' });
    const live = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'Barrel Pie' });
    recordEnrichFailure(db, {
      beer_id: wontfix, brewery: 'Stoelzle', name: 'Kelih Fino 545',
      search_url: '', source_url: 'https://winetime.com.ua/x', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, wontfix, 'wontfix', null, '2026-05-26T11:30:00Z');

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([live]);
  });

  test('excludes retired orphans (retired_at set)', () => {
    const db = fresh();
    const retired = seedRelayOrphan(db, { brewery: 'VINO KARPATIA', name: 'Bialy bez' });
    const live = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'Barrel Pie' });
    recordEnrichFailure(db, {
      beer_id: retired, brewery: 'VINO KARPATIA', name: 'Bialy bez',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, retired, 'parser_bug', 'wine', '2026-05-26T11:30:00Z');
    db.prepare('UPDATE enrich_failures SET retired_at = ? WHERE beer_id = ?')
      .run('2026-05-26T11:45:00Z', retired);

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([live]);
  });

  test('keeps orphans triaged with a non-wontfix class (e.g. matcher_bug re-armed by rearm-*)', () => {
    const db = fresh();
    const matcherBug = seedRelayOrphan(db, { brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny' });
    recordEnrichFailure(db, {
      beer_id: matcherBug, brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny',
      search_url: '', source_url: 'https://onemorebeer.pl/x', outcome: 'not_found',
      candidates_count: 1, candidates_summary: 'x — y', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, matcherBug, 'matcher_bug', null, '2026-05-26T11:30:00Z');

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([matcherBug]);
  });

  test('respects backoff: not eligible when lookup_at + delay > now', () => {
    const db = fresh();
    seedRelayOrphan(db, {
      brewery: 'The Bruery', name: 'Barrel Pie',
      lookupAt: '2026-05-26T11:00:00Z', lookupCount: 1,
    });
    expect(listRelayLookupCandidates(db, 10, NOW)).toEqual([]);
  });

  test('backoff-eligible orphan IS returned', () => {
    const db = fresh();
    // count=1 → затримка 72 год; 73 год тому вже прострочено.
    const id = seedRelayOrphan(db, {
      brewery: 'The Bruery', name: 'Barrel Pie',
      lookupAt: '2026-05-23T11:00:00Z', lookupCount: 1,
    });
    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([id]);
  });

  test('orders never-searched (count=0) ahead of already-searched (count=1)', () => {
    const db = fresh();
    const searched = seedRelayOrphan(db, {
      brewery: 'Transient', name: 'Junie',
      lookupAt: '2026-05-23T11:00:00Z', lookupCount: 1,
    });
    const never = seedRelayOrphan(db, { brewery: 'Finback', name: 'Starry Eyed' });

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([never, searched]);
  });

  test('applies the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedRelayOrphan(db, { brewery: `Brew ${i}`, name: `Beer ${i}` });
    }
    expect(listRelayLookupCandidates(db, 2, NOW).length).toBe(2);
  });

  test('returned shape carries raw brewery and name plus backoff fields', () => {
    const db = fresh();
    seedRelayOrphan(db, { brewery: 'Magic Road', name: 'Clementine & Passionfruit' });
    const [c] = listRelayLookupCandidates(db, 10, NOW);
    expect(c.brewery).toBe('Magic Road');
    expect(c.name).toBe('Clementine & Passionfruit');
    expect(c.untappd_lookup_at).toBeNull();
    expect(c.untappd_lookup_count).toBe(0);
  });
});
```

- [ ] **Step 2: Запустити тести й переконатися, що падають**

```bash
npx vitest run src/storage/beers.test.ts
```

Очікується: провал збірки/типів із повідомленням на кшталт `"listRelayLookupCandidates" is not exported by "src/storage/beers.ts"`.

- [ ] **Step 3: Мінімальна імплементація**

У `src/storage/beers.ts`, одразу після закриття `listLookupCandidates` (рядок 271) і перед `export function recordRatingSuccess`:

```ts
// #368: relay-пул — orphan'и, яких on-tap пул не побачить НІКОЛИ. Рядки, намінчені
// `/enrich/candidates` (ensureBeerRow біжить по кожній картці сторінки крамниці), не
// отримують рядка в `match_links`, бо лінки пише лише on-tap ingest. Тому клауза
// EXISTS(match_links → taps → latest snapshot) у listLookupCandidates виключає їх
// структурно, а не тому, що вони зійшли з кранів. Виключення wontfix/retired, backoff
// і сортування — ті самі; інвертовано лише join, тож пули диз'юнктні за побудовою
// і дедуп їм не потрібен.
export function listRelayLookupCandidates(
  db: DB,
  limit: number,
  now: Date,
): LookupCandidate[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.brewery, b.name,
              b.untappd_lookup_at, b.untappd_lookup_count
       FROM beers b
       WHERE b.untappd_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND (ef.review_class = 'wontfix' OR ef.retired_at IS NOT NULL)
         )
         AND NOT EXISTS (
           SELECT 1 FROM match_links ml WHERE ml.untappd_beer_id = b.id
         )
       ORDER BY b.untappd_lookup_count ASC, b.id ASC`,
    )
    .all() as LookupCandidate[];

  // Той самий JS-фільтр backoff, що й у listLookupCandidates: відтворювати його
  // математику в julianday-арифметиці SQLite означало б дублювати розклад.
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count),
  );

  return eligible.slice(0, limit);
}
```

- [ ] **Step 4: Запустити тести й переконатися, що проходять**

```bash
npx vitest run src/storage/beers.test.ts
```

Очікується: PASS, усі 11 нових тестів зелені, наявні тести `listLookupCandidates` не зачеплені.

- [ ] **Step 5: Коміт**

```bash
git rev-parse --show-toplevel && git branch --show-current   # має бути worktree + 368-relay-orphan-drain
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#368): add listRelayLookupCandidates — the pool the on-tap join cannot see"
```

---

### Task 2: бюджет — relay добирає лише невикористані слоти

**Files:**
- Modify: `src/jobs/enrich-orphans.ts` (тип `EnrichOrphansResult` рядки 12–20, `ZERO_RESULT` рядки 37–39, добір кандидатів рядок 80)
- Test: `src/jobs/enrich-orphans.test.ts`

**Залежність:** потребує `listRelayLookupCandidates` із Task 1.

- [ ] **Step 1: Написати падаючі тести**

У `src/jobs/enrich-orphans.test.ts` додай сид для relay-orphan'а одразу після наявного `seedOrphanOnTap` (він закінчується на рядку 49):

```ts
// Relay-orphan: рядок у `beers` БЕЗ match_links — те, що мінтить /enrich/candidates.
function seedRelayOrphan(
  db: ReturnType<typeof fresh>,
  brewery: string,
  name: string,
): number {
  return upsertBeer(db, {
    name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase(),
  });
}
```

Далі додай новий `describe` у кінець файлу:

```ts
describe('enrichOrphans — relay pool budget (#368)', () => {
  const fixedNow = new Date('2026-05-26T12:00:00Z');

  function searchStub(onQuery?: (q: string) => void) {
    return {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        onQuery?.(q);
        return [];   // усе інше — not_found, нам важливий добір, а не матчинг
      },
    };
  }

  test('relay candidates fill the slots the on-tap pool left unused', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'Magic Road', 'Clementine');
    seedRelayOrphan(db, 'The Bruery', 'Barrel Pie');
    seedRelayOrphan(db, 'Finback', 'Starry Eyed');

    const result = await enrichOrphans({
      db, log: silentLog, search: searchStub(), sleepMs: 0, limit: 20,
      now: () => fixedNow,
    });

    expect(result.on_tap_selected).toBe(1);
    expect(result.relay_selected).toBe(2);
    expect(result.processed).toBe(3);
    expect(result.not_found).toBe(3);
  });

  test('a full on-tap pool leaves no room: relay is not consulted at all', async () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) seedOrphanOnTap(db, `Brew ${i}`, `Beer ${i}`);
    seedRelayOrphan(db, 'The Bruery', 'Barrel Pie');

    // limit=3 повністю з'їдається on-tap пулом.
    const result = await enrichOrphans({
      db, log: silentLog, search: searchStub(), sleepMs: 0, limit: 3,
      now: () => fixedNow,
    });

    expect(result.on_tap_selected).toBe(3);
    expect(result.relay_selected).toBe(0);
    expect(result.processed).toBe(3);
  });

  test('the total budget is the shared limit, never limit per pool', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'Magic Road', 'Clementine');
    for (let i = 0; i < 5; i++) seedRelayOrphan(db, `Brew ${i}`, `Beer ${i}`);

    const result = await enrichOrphans({
      db, log: silentLog, search: searchStub(), sleepMs: 0, limit: 3,
      now: () => fixedNow,
    });

    expect(result.on_tap_selected).toBe(1);
    expect(result.relay_selected).toBe(2);
    expect(result.processed).toBe(3);   // НЕ 1 + 3
  });

  test('on-tap candidates are processed before relay ones', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'OnTapBrewery', 'Tapped');
    seedRelayOrphan(db, 'RelayBrewery', 'Shopped');
    const queries: string[] = [];

    await enrichOrphans({
      db, log: silentLog, search: searchStub((q) => queries.push(q)),
      sleepMs: 0, limit: 20, now: () => fixedNow,
    });

    const first = queries.findIndex((q) => q.includes('OnTapBrewery'));
    const second = queries.findIndex((q) => q.includes('RelayBrewery'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
  });

  test('a relay orphan that matches is written back like any other candidate', async () => {
    const db = fresh();
    const relay = seedRelayOrphan(db, 'The Bruery', 'Barrel Pie');
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        return [{
          bid: 6430654, beer_name: 'Barrel Pie', brewery_name: 'The Bruery',
          style: null, abv: null, global_rating: null,
        }];
      },
    };

    const result = await enrichOrphans({
      db, log: silentLog, search, sleepMs: 0, limit: 20, now: () => fixedNow,
    });

    expect(result.relay_selected).toBe(1);
    expect(result.matched).toBe(1);
    expect(getBeer(db, relay)?.untappd_id).toBe(6430654);
  });
});
```

Плюс онови наявний тест на рядку 185 — у `ZERO_RESULT` з'явилися два поля:

```ts
    expect(result).toEqual({
      processed: 0, matched: 0, merged: 0, not_found: 0, transient: 0,
      skipped: 0, blocked: 0, on_tap_selected: 0, relay_selected: 0,
    });
```

- [ ] **Step 2: Запустити тести й переконатися, що падають**

```bash
npx vitest run src/jobs/enrich-orphans.test.ts
```

Очікується: провал — `on_tap_selected` не існує в типі `EnrichOrphansResult` (і `undefined` у рантаймі).

- [ ] **Step 3: Мінімальна імплементація**

У `src/jobs/enrich-orphans.ts`:

(a) імпорт на рядку 4 стає

```ts
import { listLookupCandidates, listRelayLookupCandidates } from '../storage/beers';
```

(b) інтерфейс `EnrichOrphansResult` (рядки 12–20) отримує два поля:

```ts
export interface EnrichOrphansResult {
  processed: number;
  matched: number;
  merged: number;
  not_found: number;
  transient: number;
  skipped: number;
  blocked: number;
  // #368: скільки кандидатів узято з кожного пулу. Без цього розкладу неможливо
  // побачити, чи дренаж узагалі біжить, — `processed` їх змішує.
  on_tap_selected: number;
  relay_selected: number;
}
```

(c) `ZERO_RESULT` (рядки 37–39):

```ts
const ZERO_RESULT: EnrichOrphansResult = {
  processed: 0, matched: 0, merged: 0, not_found: 0, transient: 0, skipped: 0, blocked: 0,
  on_tap_selected: 0, relay_selected: 0,
};
```

(d) добір кандидатів — рядок 80 (`const candidates = listLookupCandidates(deps.db, limit, now());`) замінюється на:

```ts
  // #368: `limit` — СУМАРНИЙ бюджет запуску, не бюджет пулу. On-tap вичерпується
  // першим, тож витіснити його неможливо за побудовою; relay добирає лише те, що
  // лишилося невикористаним (а простоює ~89% місткості). Стеля навантаження на
  // Untappd лишається незмінною.
  const onTap = listLookupCandidates(deps.db, limit, now());
  const relay = onTap.length < limit
    ? listRelayLookupCandidates(deps.db, limit - onTap.length, now())
    : [];
  const candidates = [...onTap, ...relay];
  const result: EnrichOrphansResult = {
    ...ZERO_RESULT,
    on_tap_selected: onTap.length,
    relay_selected: relay.length,
  };
```

(наявний рядок `const result: EnrichOrphansResult = { ...ZERO_RESULT };` одразу під ним видаляється — його заміщує щойно доданий)

- [ ] **Step 4: Запустити тести й переконатися, що проходять**

```bash
npx vitest run src/jobs/enrich-orphans.test.ts
```

Очікується: PASS — 5 нових тестів + усі наявні.

- [ ] **Step 5: Коміт**

```bash
git rev-parse --show-toplevel && git branch --show-current
git add src/jobs/enrich-orphans.ts src/jobs/enrich-orphans.test.ts
git commit -m "feat(#368): relay orphans fill the enrich slots the on-tap pool leaves unused"
```

---

### Task 3: метрика `orphansOffCron` у щоденному дайджесті

**Files:**
- Modify: `src/storage/stats.ts` (інтерфейс `StatusMetrics` рядки 9–28, `collectStatus` — одразу після `orphansPending`, рядки 64–71)
- Modify: `src/jobs/daily-status.ts` (рядок «Каталог» — рядок 22)
- Test: `src/storage/stats.test.ts`, `src/jobs/daily-status.test.ts`

**Незалежний від Task 1 і Task 2** — можна робити паралельно.

- [ ] **Step 1: Написати падаючі тести**

У `src/storage/stats.test.ts` додай `orphansOffCron` до наявного `expect(m).toEqual({…})` у тесті `'collectStatus computes all metrics'` (рядок 50, одразу після `orphansPending: 1,`):

```ts
    orphansPending: 1,
    orphansOffCron: 1,   // orphan 'C' із seed() не має рядка в match_links
```

**Значення саме `1`, не `0`:** `seed()` створює три пива — два зматчені (`untappd_id` 100/101) і один orphan `C`, і жодне з них не має рядка в `match_links` (сид кладе таби, але не викликає `upsertMatch`). Тож orphan `C` за визначенням «поза cron».

Тест `'collectStatus with empty DB: null scrape, zero counts'` правити НЕ треба — він перевіряє поля поштучно, без `toEqual`.

Потім новий тест у кінець файлу:

```ts
it('orphansOffCron counts orphans with no match_links row, minus wontfix/retired', () => {
  const db = fresh();
  // 1) relay-orphan без лінка → рахується
  const relay = upsertBeer(db, {
    name: 'Barrel Pie', brewery: 'The Bruery', style: null, abv: null, rating_global: null,
    normalized_name: 'barrel pie', normalized_brewery: 'the bruery',
  });
  // 2) relay-orphan, протриажений як wontfix → НЕ рахується
  const wontfix = upsertBeer(db, {
    name: 'Kelih Fino 545', brewery: 'Stoelzle', style: null, abv: null, rating_global: null,
    normalized_name: 'kelih fino 545', normalized_brewery: 'stoelzle',
  });
  recordEnrichFailure(db, {
    beer_id: wontfix, brewery: 'Stoelzle', name: 'Kelih Fino 545',
    search_url: '', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: '2026-06-04T11:00:00Z',
  });
  setEnrichFailureReview(db, wontfix, 'wontfix', null, '2026-06-04T11:30:00Z');
  // 3) orphan із лінком (on-tap шлях) → НЕ рахується, крон його й так бачить
  const linked = upsertBeer(db, {
    name: 'Clementine', brewery: 'Magic Road', style: null, abv: null, rating_global: null,
    normalized_name: 'clementine', normalized_brewery: 'magic road',
  });
  upsertMatch(db, 'Magic Road Clementine', linked, 1.0);

  const m = collectStatus(db, new Date('2026-06-04T12:00:00Z'));
  expect(m.orphansOffCron).toBe(1);
  expect(relay).toBeGreaterThan(0);
});
```

Переконайся, що `upsertMatch`, `recordEnrichFailure`, `setEnrichFailureReview` імпортовані у `stats.test.ts`; якщо ні — додай:

```ts
import { upsertMatch } from './match_links';
import { recordEnrichFailure, setEnrichFailureReview } from './enrich_failures';
```

У `src/jobs/daily-status.test.ts` додай `orphansOffCron: 751,` у константу `base` (рядок 19, після `orphansPending: 287,`) і онови очікуваний рядок «Каталог» у тесті `'buildStatusMessage: full message exact string'`:

```ts
      "• Каталог: 12 840 пив · 78% зматчено · 287 orphan'ів у черзі · 751 поза cron",
```

- [ ] **Step 2: Запустити тести й переконатися, що падають**

```bash
npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts
```

Очікується: провал типів (`orphansOffCron` немає в `StatusMetrics`) і розбіжність рядка.

- [ ] **Step 3: Мінімальна імплементація**

У `src/storage/stats.ts`, в інтерфейс `StatusMetrics` одразу після `orphansPending: number;`:

```ts
  // #368: orphan'и, яких enrich-крон не бачив би без relay-пулу (немає рядка в
  // `match_links`), за винятком wontfix/retired. Той самий предикат, що і в
  // listRelayLookupCandidates, мінус backoff — тобто розмір черги дренажу.
  orphansOffCron: number;
```

І в `collectStatus`, одразу після блоку `orphansPending` (рядки 64–71):

```ts
    orphansOffCron: count(
      `SELECT COUNT(*) AS c FROM beers b
        WHERE b.untappd_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM enrich_failures ef
            WHERE ef.beer_id = b.id
              AND (ef.review_class = 'wontfix' OR ef.retired_at IS NOT NULL)
          )
          AND NOT EXISTS (
            SELECT 1 FROM match_links ml WHERE ml.untappd_beer_id = b.id
          )`,
    ),
```

У `src/jobs/daily-status.ts` рядок 22 стає:

```ts
    `• Каталог: ${group(m.beersTotal)} пив · ${matchPct}% зматчено · ${group(m.orphansPending)} orphan'ів у черзі · ${group(m.orphansOffCron)} поза cron`,
```

- [ ] **Step 4: Запустити тести й переконатися, що проходять**

```bash
npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts
```

Очікується: PASS.

- [ ] **Step 5: Коміт**

```bash
git rev-parse --show-toplevel && git branch --show-current
git add src/storage/stats.ts src/storage/stats.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(#368): surface the off-cron orphan queue in the daily digest"
```

---

### Task 4: `spec.md` + повний прогін

**Files:**
- Modify: `spec.md` (5 місць, нижче)

`spec.md` — єдине джерело істини за OpenSpec; CLAUDE.md вимагає оновлювати його в тому ж PR. Розширення не змінюється, тож `docs/extension-install-uk.md` НЕ чіпаємо.

- [ ] **Step 1: Правка 1 — опис enrich-пулу**

Знайди в `spec.md` абзац, що описує добір кандидатів на lookup (пошук: `listLookupCandidates`). Додай туди опис двох пулів:

```markdown
**Два пули кандидатів, один бюджет (#368).** `enrichOrphans` добирає кандидатів із двох
диз'юнктних пулів. **On-tap пул** (`listLookupCandidates`) — orphan'и, чий `beer_id` є на
останньому снапшоті хоча б одного паба (`match_links → taps → tap_snapshots`). **Relay-пул**
(`listRelayLookupCandidates`) — orphan'и, у яких рядка в `match_links` немає взагалі: їх
намінтив `/enrich/candidates` (`ensureBeerRow` біжить по кожній картці сторінки крамниці),
а лінки пише лише on-tap ingest, тож on-tap join виключав їх **структурно**, а не через
зхід із кранів (на 2026-08-08 це 846 із 1427 orphan'ів, 532 з них не шукані жодного разу).
Предикати інвертні (`EXISTS` ⊕ `NOT EXISTS`), тож пули не перетинаються і дедупу не
потребують. `LIMIT 20` — **сумарний** бюджет запуску: on-tap вичерпується першим і не може
бути витіснений, relay добирає лише невикористані слоти (до зміни простоювало ~89%
місткості: 17 lookup/добу зі 160). Обидва пули однаково виключають
`review_class = 'wontfix'` і `retired_at IS NOT NULL` і однаково фільтруються backoff'ом.
```

- [ ] **Step 2: Правка 2 — retirement**

У абзаці `**Retirement (`retired_at`).**` фраза «Retired-рядки виключені з enrich-пулу
(`listLookupCandidates`, поряд із `wontfix`)» стає:

```markdown
Retired-рядки виключені з **обох** enrich-пулів (`listLookupCandidates` і
`listRelayLookupCandidates`, поряд із `wontfix`)
```

- [ ] **Step 3: Правка 3 — таблиця кронів**

Рядок `| \`enrichOrphans\` | \`30 */3 * * *\` | lookup orphan-beers у Untappd (LIMIT 20/запуск) |` стає:

```markdown
| `enrichOrphans` | `30 */3 * * *` | lookup orphan-beers у Untappd (LIMIT 20/запуск — **сумарно** на on-tap і relay пули, див. §пулів) |
```

- [ ] **Step 4: Правка 4 — rate-limits + примітка про `rearm-*`**

У пункті про Untappd-enrich («Untappd-enrich батчиться (LIMIT 20/запуск)…») додай наприкінці:

```markdown
  LIMIT 20 — сумарний бюджет запуску на обидва пули кандидатів (on-tap + relay, #368):
  relay добирає лише слоти, не використані on-tap пулом, тож стеля навантаження на
  Untappd лишається 160/добу.
```

У абзаці про `rearm-matcher-bug-orphans` додай примітку:

```markdown
  **Історична пастка (#368, виправлено).** `selectRearmTargets` не вимагає рядка в
  `match_links`, тож до появи relay-пулу ре-арм для cron-недосяжних рядків був no-op:
  `untappd_lookup_count` чесно скидався, але крон їх однаково не бачив (45 із 93
  ре-армлених `matcher_bug`-рядків станом на 2026-08-08). Тепер relay-пул їх підбирає.
```

- [ ] **Step 5: Правка 5 — дайджест**

У описі `dailyStatus` (таблиця кронів) додай до опису рядка «Каталог»:

```markdown
Рядок «Каталог» містить `orphansOffCron` («N поза cron») — orphan'и без рядка в
`match_links` за винятком `wontfix`/`retired`, тобто розмір черги relay-дренажу (#368).
```

- [ ] **Step 6: Повний прогін тестів і типів**

```bash
npm test && npm run typecheck
```

Очікується: усі тести зелені, `tsc` без помилок.

- [ ] **Step 7: Коміт**

```bash
git rev-parse --show-toplevel && git branch --show-current
git add spec.md
git commit -m "docs(#368): spec the two-pool enrich candidate selection and the shared budget"
```

---

## Після виконання плану

1. Створити PR (гілка `worktree-368-relay-orphan-drain` → `main`), у описі послатися на #368 і на design-док.
2. Дочекатися AI-рев'ю, вичитати коментарі критично (частина буває хибною — перевіряти живий шлях, а не сліпо правити).
3. **PR мерджить користувач, не агент.**
4. Після мерджу — деплой (`./deploy/deploy.sh` із `main`) і верифікація за §«Верифікація після деплою» design-доку: `processed` ~2→~20/запуск, `relay_selected` > 0, `orphansOffCron` 751 із падінням ~140/добу.
