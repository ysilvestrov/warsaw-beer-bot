# Role-aware `/refresh` Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/refresh` select Ontap pubs and Untappd profiles by caller role, active city, and optional pub query as specified in issue #144.

**Architecture:** A pure command-layer resolver returns one explicit run scope (`cities`, `pubSlugs`, `telegramIds`, `cooldown`, optional matched `pubIds`) or `pub_not_found`. Existing refresh jobs gain only the smallest filters they need: `refreshAllUntappd` filters profiles by Telegram ID, while `refreshOntap` reuses its existing city and slug filters. Query follow-up results receive the already-resolved pub IDs so admin searches can span cities without changing ordinary `/newbeers` city scoping.

**Tech Stack:** TypeScript (strict), Telegraf 4, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-10-refresh-role-scoping-design.md`

---

## File Structure

- `src/jobs/refresh-untappd.ts` — add optional per-Telegram-ID profile filtering while preserving the unfiltered cron path.
- `src/jobs/refresh-untappd.test.ts` — prove selected, empty, and absent filters.
- `src/bot/commands/newbeers-build.ts` — allow an explicit matched-pub ID set to override normal active-city/query resolution for refresh follow-up only.
- `src/bot/commands/newbeers-build.test.ts` — prove explicit slugs work across city boundaries and exclude unselected pubs.
- `src/bot/commands/refresh.ts` — resolve role-aware scopes, classify cooldown cost, pass explicit options, and run follow-up only for queries.
- `src/bot/commands/refresh.test.ts` — cover the complete five-row behavior matrix, `me`, address matching, city boundaries, not-found, and cooldown classification.
- `src/index.ts` — translate the resolved command scope into the existing Ontap and Untappd job calls.
- `spec.md` — make the live specification describe the new role-aware behavior.

---

### Task 1: Filter command-triggered Untappd refreshes by Telegram ID

**Files:**
- Modify: `src/jobs/refresh-untappd.ts:15-46`
- Test: `src/jobs/refresh-untappd.test.ts` inside `describe('refreshAllUntappd')`

- [ ] **Step 1: Write failing profile-filter tests**

Add tests that seed two linked profiles and exercise both a selected set and an empty set:

```ts
  test('telegramIds refreshes only selected linked profiles', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'bob');
    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        return '';
      },
    };

    await refreshAllUntappd({
      db, log: silentLog, http, telegramIds: new Set([2]),
    });

    expect(seenUrls).toEqual(['https://untappd.com/user/bob/beers']);
  });

  test('empty telegramIds refreshes no profiles', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    const http: Http = { get: vi.fn(async () => '') };

    const result = await refreshAllUntappd({
      db, log: silentLog, http, telegramIds: new Set(),
    });

    expect(http.get).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: 0, rotated: 0 });
  });
```

The existing `hits /beers (plural), not /beer (singular)` test remains the proof that an absent filter refreshes all linked profiles.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
npx vitest run src/jobs/refresh-untappd.test.ts -t "telegramIds"
```

Expected: TypeScript/Vitest failure because `telegramIds` is not a member of `Deps`.

- [ ] **Step 3: Add the minimal job filter**

Add the optional dependency and filter before the existing username filter:

```ts
interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  onProgress?: ProgressFn;
  notifyAdmin?: (msg: string) => Promise<void>;
  breaker?: CircuitBreaker;
  now?: () => Date;
  telegramIds?: ReadonlySet<number>;
}
```

```ts
  const profiles = allProfiles(db)
    .filter((p) => deps.telegramIds == null || deps.telegramIds.has(p.telegram_id))
    .filter((p) => p.untappd_username);
```

Do not rename `refreshAllUntappd`; cron callers keep using it without the optional filter.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run src/jobs/refresh-untappd.test.ts
```

Expected: all `refreshAllUntappd` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
git commit -m "feat(refresh): scope Untappd profiles by caller"
```

---

### Task 2: Support exact matched-pub follow-up across cities

**Files:**
- Modify: `src/bot/commands/newbeers-build.ts:33-79`
- Test: `src/bot/commands/newbeers-build.test.ts` inside `describe('buildNewbeersMessage')`

- [ ] **Step 1: Write a failing cross-city explicit-scope test**

Seed one pub in Warszawa and one in Kraków, each with a distinct matched tap. Call the builder with Warszawa as the active city but both IDs as the explicit scope:

```ts
  test('explicit pubIds can select matched pubs across city boundaries', () => {
    const db = fresh();
    const warsaw = upsertPub(db, {
      slug: 'warsaw-pub', name: 'Warsaw Pub', address: null,
      lat: null, lon: null, city: 'warszawa',
    });
    const krakow = upsertPub(db, {
      slug: 'krakow-pub', name: 'Krakow Pub', address: null,
      lat: null, lon: null, city: 'krakow',
    });
    const unselected = upsertPub(db, {
      slug: 'gdansk-pub', name: 'Unselected Pub', address: null,
      lat: null, lon: null, city: 'gdansk',
    });
    const beerRows = [
      { pubId: warsaw, ref: 'Warsaw Beer', beerId: 101 },
      { pubId: krakow, ref: 'Krakow Beer', beerId: 102 },
      { pubId: unselected, ref: 'Unselected Beer', beerId: 103 },
    ];
    for (const row of beerRows) {
      const snap = createSnapshot(db, row.pubId, '2026-08-10T12:00:00Z');
      const beerId = upsertBeer(db, {
        untappd_id: row.beerId, name: row.ref, brewery: 'Test', style: 'IPA',
        abv: 6, rating_global: 4, normalized_name: row.ref.toLowerCase(),
        normalized_brewery: 'test',
      });
      upsertMatch(db, row.ref, beerId, 1);
      insertTaps(db, snap, [{
        tap_number: 1, beer_ref: row.ref, brewery_ref: 'Test', abv: 6,
        ibu: null, style: 'IPA', u_rating: 4,
      }]);
    }
    const t = createTranslator('uk');

    const out = buildNewbeersMessage({
      db, telegramId: 1, locale: 'uk', t, city: 'warszawa',
      pubIds: new Set([warsaw, krakow]),
    });

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('Warsaw Pub');
    expect(out.html).toContain('Krakow Pub');
    expect(out.html).not.toContain('Unselected Pub');
  });
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run src/bot/commands/newbeers-build.test.ts -t "explicit pubIds"
```

Expected: failure because `pubIds` is not accepted and Kraków is excluded by the active-city pub map.

- [ ] **Step 3: Add explicit pub scope to `NewbeersDeps`**

```ts
export interface NewbeersDeps {
  db: DB;
  telegramId: number;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
  pubIds?: ReadonlySet<number>;
  city: string;
}
```

Build the pub map from all cities only when an explicit ID set is provided, filter it by those IDs, and skip query resolution in that case:

```ts
  const pubRows = listPubs(db, deps.pubIds == null ? deps.city : undefined)
    .filter((p) => deps.pubIds == null || deps.pubIds.has(p.id));
  const pubs = new Map(pubRows.map((p) => [p.id, p]));

  const q = deps.pubQuery?.trim().toLowerCase() ?? '';
  let matchedIds: Set<number> | null = null;
  if (q && deps.pubIds == null) {
    const filtered = filterPubsByQuery([...pubs.values()], q);
    if (filtered.length === 0) return { kind: 'pub_not_found', query: deps.pubQuery! };
    matchedIds = new Set(filtered.map((p) => p.id));
  }
```

Leave ordinary `/newbeers` calls unchanged: they provide no `pubIds`, so they remain active-city scoped. The third unselected pub in the test proves the explicit set is authoritative rather than a cross-city widening.

- [ ] **Step 4: Verify GREEN and existing query behavior**

Run:

```bash
npx vitest run src/bot/commands/newbeers-build.test.ts
```

Expected: all builder and `filterPubsByQuery` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts
git commit -m "feat(refresh): show cross-city matched pub results"
```

---

### Task 3: Resolve and execute role-aware command scopes

**Files:**
- Modify: `src/bot/commands/refresh.ts:80-176`
- Test: `src/bot/commands/refresh.test.ts` (`dbWithPubs`, `resolveRefreshScope`, `cooldownWindowFor`)

- [ ] **Step 1: Extend the fixture and write failing scope-matrix tests**

Add a Kraków pub and addresses that let tests prove city and address behavior:

```ts
  upsertPub(db, {
    slug: 'bracka', name: 'Bracka 4', address: 'Bracka 4',
    lat: null, lon: null, city: 'warszawa',
  });
  upsertPub(db, {
    slug: 'krakow-bracka', name: 'Kraków Tap', address: 'Bracka 8',
    lat: null, lon: null, city: 'krakow',
  });
  upsertPub(db, {
    slug: 'meta', name: 'Meta Pub', address: 'Marszałkowska 1',
    lat: null, lon: null, city: 'warszawa',
  });
```

Replace the old three-arm scope tests with tests calling this explicit resolver API:

```ts
const resolve = (
  db: ReturnType<typeof dbWithPubs>,
  opts: { telegramId: number; adminTelegramId?: string; city?: string; arg?: string },
) => resolveRefreshScope({
  db,
  telegramId: opts.telegramId,
  adminTelegramId: opts.adminTelegramId,
  city: opts.city ?? 'warszawa',
  arg: opts.arg ?? '',
});
```

Cover the five matrix rows with assertions on `cities?.map(c => c.slug)`, `pubSlugs`, `pubIds`, `telegramIds`, and `cooldown`:

```ts
  test('admin without argument refreshes every city and every profile', () => {
    const scope = resolve(dbWithPubs(), { telegramId: 1, adminTelegramId: '1' });
    expect(scope).toEqual({ kind: 'run', cooldown: 'all' });
  });

  test('admin me refreshes the active city and only the admin profile', () => {
    const scope = resolve(dbWithPubs(), {
      telegramId: 1, adminTelegramId: '1', city: 'krakow', arg: ' Me ',
    });
    expect(scope.kind).toBe('run');
    if (scope.kind !== 'run') return;
    expect(scope.cities?.map((c) => c.slug)).toEqual(['krakow']);
    expect(scope.telegramIds).toEqual(new Set([1]));
    expect(scope.pubSlugs).toBeUndefined();
    expect(scope.cooldown).toBe('all');
  });

  test('admin query matches names and addresses across all cities and all profiles', () => {
    const scope = resolve(dbWithPubs(), {
      telegramId: 1, adminTelegramId: '1', arg: 'bracka',
    });
    expect(scope.kind).toBe('run');
    if (scope.kind !== 'run') return;
    expect(scope.pubSlugs).toEqual(new Set(['bracka', 'krakow-bracka']));
    expect(scope.cities?.map((c) => c.slug)).toEqual(['warszawa', 'krakow']);
    expect(scope.pubIds?.size).toBe(2);
    expect(scope.telegramIds).toBeUndefined();
    expect(scope.cooldown).toBe('all');
  });

  test('non-admin without argument refreshes active city and current profile', () => {
    const scope = resolve(dbWithPubs(), { telegramId: 2, adminTelegramId: '1' });
    expect(scope.kind).toBe('run');
    if (scope.kind !== 'run') return;
    expect(scope.cities?.map((c) => c.slug)).toEqual(['warszawa']);
    expect(scope.telegramIds).toEqual(new Set([2]));
    expect(scope.pubSlugs).toBeUndefined();
    expect(scope.cooldown).toBe('all');
  });

  test('non-admin query matches only active-city pubs and current profile', () => {
    const scope = resolve(dbWithPubs(), {
      telegramId: 2, adminTelegramId: '1', arg: 'bracka',
    });
    expect(scope.kind).toBe('run');
    if (scope.kind !== 'run') return;
    expect(scope.cities?.map((c) => c.slug)).toEqual(['warszawa']);
    expect(scope.pubSlugs).toEqual(new Set(['bracka']));
    expect(scope.pubIds?.size).toBe(1);
    expect(scope.telegramIds).toEqual(new Set([2]));
    expect(scope.cooldown).toBe('scoped');
  });
```

Also add focused cases proving:

```ts
  test.each(['me', ' ME ', 'Me'])('admin %j uses the self scope', (arg) => {
    const scope = resolve(dbWithPubs(), {
      telegramId: 1, adminTelegramId: '1', city: 'krakow', arg,
    });
    expect(scope.kind).toBe('run');
    if (scope.kind !== 'run') return;
    expect(scope.cities?.map((candidate) => candidate.slug)).toEqual(['krakow']);
    expect(scope.telegramIds).toEqual(new Set([1]));
    expect(scope.pubIds).toBeUndefined();
  });

  test('non-admin me is an ordinary pub query', () => {
    const scope = resolve(dbWithPubs(), {
      telegramId: 2, adminTelegramId: '1', arg: 'me',
    });
    expect(scope.kind).toBe('run');
    if (scope.kind !== 'run') return;
    expect(scope.pubSlugs).toEqual(new Set(['meta']));
    expect(scope.telegramIds).toEqual(new Set([2]));
    expect(scope.cooldown).toBe('scoped');
  });

  test('query with no match returns pub_not_found', () => {
    const scope = resolve(dbWithPubs(), {
      telegramId: 2, adminTelegramId: '1', arg: 'nonexistent',
    });
    expect(scope).toEqual({ kind: 'pub_not_found', query: 'nonexistent' });
  });
```

- [ ] **Step 2: Run the resolver tests and verify RED**

Run:

```bash
npx vitest run src/bot/commands/refresh.test.ts -t "resolveRefreshScope"
```

Expected: failures because the resolver still accepts `(db, arg)` and returns only `all`/`scoped`.

- [ ] **Step 3: Implement the explicit run-scope types and resolver**

Import `CITIES` and `City`, then define:

```ts
export type RefreshCooldownKind = 'all' | 'scoped';

export interface RefreshRunScope {
  kind: 'run';
  cooldown: RefreshCooldownKind;
  cities?: readonly City[];
  pubSlugs?: Set<string>;
  pubIds?: Set<number>;
  telegramIds?: Set<number>;
}

export type RefreshScope =
  | RefreshRunScope
  | { kind: 'pub_not_found'; query: string };

export interface ResolveRefreshScopeArgs {
  db: DB;
  telegramId: number;
  adminTelegramId?: string;
  city: string;
  arg: string;
}
```

Implement the matrix directly:

```ts
export function resolveRefreshScope(args: ResolveRefreshScopeArgs): RefreshScope {
  const { db, telegramId, adminTelegramId, city } = args;
  const query = args.arg.trim();
  const isAdmin = adminTelegramId != null && String(telegramId) === adminTelegramId;
  const cities = CITIES.filter((candidate) => candidate.slug === city);

  if (!query) {
    return isAdmin
      ? { kind: 'run', cooldown: 'all' }
      : { kind: 'run', cooldown: 'all', cities, telegramIds: new Set([telegramId]) };
  }

  if (isAdmin && query.toLowerCase() === 'me') {
    return { kind: 'run', cooldown: 'all', cities, telegramIds: new Set([telegramId]) };
  }

  const matched = filterPubsByQuery(listPubs(db, isAdmin ? undefined : city), query);
  if (matched.length === 0) return { kind: 'pub_not_found', query };

  const matchedCities = new Set(matched.map((pub) => pub.city));

  return {
    kind: 'run',
    cooldown: isAdmin ? 'all' : 'scoped',
    cities: CITIES.filter((candidate) => matchedCities.has(candidate.slug)),
    pubSlugs: new Set(matched.map((pub) => pub.slug)),
    pubIds: new Set(matched.map((pub) => pub.id)),
    telegramIds: isAdmin ? undefined : new Set([telegramId]),
  };
}
```

Change `cooldownWindowFor` to accept `RefreshCooldownKind`; its constants and values remain unchanged.

- [ ] **Step 4: Verify resolver GREEN**

Run:

```bash
npx vitest run src/bot/commands/refresh.test.ts -t "resolveRefreshScope|cooldownWindowFor"
```

Expected: scope matrix and cooldown tests pass.

- [ ] **Step 5: Pass the resolved scope through the handler**

Add the options type and make the run callback explicit:

```ts
export interface RefreshRunOptions {
  cities?: readonly City[];
  pubSlugs?: Set<string>;
  telegramIds?: Set<number>;
}

export function createRefreshCommand(
  run: (notify: ProgressFn, opts: RefreshRunOptions) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => NewbeersResult,
) {
```

Resolve from the actual caller context:

```ts
    const telegramId = ctx.from.id;
    const city = getUserCity(ctx.deps.db, telegramId);
    const scope = resolveRefreshScope({
      db: ctx.deps.db,
      telegramId,
      adminTelegramId: ctx.deps.env.ADMIN_TELEGRAM_ID,
      city,
      arg,
    });
```

Select cooldown state from `scope.cooldown`. Capture `cities`, `pubSlugs`,
`telegramIds`, and `pubIds` from the runnable scope. `pubIds` is command-only and
is not included in `RefreshRunOptions`. Build `postRunClosure` only when
`postRun && pubIds`, and pass the exact ID set:

```ts
    const postRunClosure = postRun && pubIds
      ? async () => {
          const result = postRun({
            db, telegramId, locale, t, city, pubIds,
          });
          if (result.kind === 'ok') {
            await telegram.sendMessage(chatId, result.html, { parse_mode: 'HTML' });
          } else if (result.kind === 'empty') {
            await telegram.sendMessage(chatId, t('newbeers.empty'));
          }
        }
      : undefined;
```

Start the pipeline with the complete scope:

```ts
          run: (n) => run(n, { cities, pubSlugs, telegramIds }),
```

Keep fire-and-forget execution, progress tracking, error handling, and tracker release unchanged.

- [ ] **Step 6: Run all command tests and typecheck**

Run:

```bash
npx vitest run src/bot/commands/refresh.test.ts src/bot/commands/newbeers-build.test.ts
npm run typecheck
```

Expected: both test files pass and TypeScript reports no errors.

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/refresh.ts src/bot/commands/refresh.test.ts
git commit -m "feat(refresh): resolve role-aware command scopes"
```

---

### Task 4: Wire the scope into jobs and update the live specification

**Files:**
- Modify: `src/index.ts:167-187`
- Modify: `spec.md:569-575`

- [ ] **Step 1: Wire all resolved options in `src/index.ts`**

Pass both existing Ontap restrictions and the new Untappd restriction:

```ts
    createRefreshCommand(
      async (notify, opts) => {
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
          pubSlugs: opts.pubSlugs,
          cities: opts.cities,
          breaker: algoliaBreaker,
          search: lookupSearch,
        });
        if (untappdHttp) {
          await refreshAllUntappd({
            db, log, http: untappdHttp, onProgress: notify, notifyAdmin,
            breaker: profileHttpBreaker,
            telegramIds: opts.telegramIds,
          });
        }
      },
      buildNewbeersMessage,
    ),
```

The excerpt uses the current composition-root variables (`algoliaBreaker`, `algoliaSearch`, and `profileHttpBreaker`). Remove the obsolete assumption that any pub-scoped refresh must skip Untappd; admin query refreshes all profiles and non-admin query refreshes the caller.

- [ ] **Step 2: Update `spec.md`**

Replace the current `/refresh` section with the approved matrix and cost-based cooldown semantics:

```md
### `/refresh [частина назви паба | me]` — примусове оновлення

Scope залежить від ролі, активного міста й аргументу:

| Виклик | Ontap | Untappd |
|---|---|---|
| admin `/refresh` | усі паби всіх курованих міст | усі профілі |
| admin `/refresh me` | усі паби активного міста | лише admin |
| admin `/refresh <query>` | збіги назви/адреси в усіх містах | усі профілі |
| user `/refresh` | усі паби активного міста | лише цей user |
| user `/refresh <query>` | збіги назви/адреси в активному місті | лише цей user |

`me` — зарезервований exact case-insensitive аргумент лише для admin. Pub-query
використовує ту саму дизамбіґуацію назви й адреси, що `/newbeers`; кілька збігів
оновлюються всі, 0 збігів повертає `pub_not_found` без запуску jobs. Query-refresh
після завершення показує `/newbeers` для точного набору матчених пабів, включно з
cross-city admin-збігами. **Кулдаун:** 5 хв для будь-якого city-wide/global або
all-profile refresh; 30 с лише для non-admin query.
```

In the background-job description, add one sentence that command-triggered `refreshAllUntappd` may filter profiles by Telegram ID while cron remains unfiltered.

- [ ] **Step 3: Run focused and full verification**

Run:

```bash
npx vitest run src/jobs/refresh-untappd.test.ts src/bot/commands/newbeers-build.test.ts src/bot/commands/refresh.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: focused tests pass, typecheck passes, all repository tests pass, and `git diff --check` prints nothing.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts spec.md
git commit -m "feat(refresh): wire role-aware refresh pipeline"
```

---

## Final Review Checklist

- [ ] Compare the final diff against every row and edge case in the design spec.
- [ ] Confirm scheduled Ontap and Untappd jobs still call the jobs without filters.
- [ ] Confirm ordinary `/newbeers` remains active-city scoped.
- [ ] Confirm non-admin query does not search or refresh pubs outside the active city.
- [ ] Confirm admin query searches all stored pubs, refreshes all profiles, and uses the 5-minute cooldown.
- [ ] Run the final verification commands again after review fixes.
