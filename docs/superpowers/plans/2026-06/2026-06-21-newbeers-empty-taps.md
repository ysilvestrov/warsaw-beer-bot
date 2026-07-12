# `/newbeers` Empty-Tap Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Ontap `N/A` empty slots from appearing as beers while preserving ordinary orphans in unfiltered `/newbeers`, excluding them under active filters, and excluding them from routes.

**Architecture:** Keep raw empty slots in snapshots for `/beers`, but classify the exact Ontap sentinel before catalog matching. Make real-Untappd-match eligibility an explicit domain filter option; `/route` always enables it, while `/newbeers` enables it only when a user style/rating/ABV filter is active and applies a separate unconditional empty-slot gate.

**Tech Stack:** Node.js 20, TypeScript, better-sqlite3, Telegraf, Vitest.

---

### Task 1: Add explicit orphan eligibility policy

**Files:**
- Modify: `src/domain/filters.ts:3-14,76-92`
- Test: `src/domain/filters.test.ts`

- [ ] **Step 1: Write failing domain tests for optional match enforcement**

Add `untappd_id` to the shared test rows and add this focused test:

```ts
test('filterInteresting optionally requires a real Untappd match', () => {
  const rows = [
    { beer_id: 10, untappd_id: null, style: 'IPA', abv: 6, u_rating: null },
    { beer_id: 11, untappd_id: 1011, style: 'IPA', abv: 6, u_rating: 4 },
  ];

  expect(filterInteresting(rows, new Set(), {}).map((r) => r.beer_id))
    .toEqual([10, 11]);
  expect(filterInteresting(rows, new Set(), { require_untappd_match: true }).map((r) => r.beer_id))
    .toEqual([11]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/domain/filters.test.ts`

Expected: FAIL because `require_untappd_match` is not part of `FilterOpts` and does not exclude the orphan.

- [ ] **Step 3: Implement the minimal domain option**

Update the contracts and gate:

```ts
export interface TapView {
  beer_id: number | null;
  untappd_id?: number | null;
  style: string | null;
  abv: number | null;
  u_rating: number | null;
}

export interface FilterOpts {
  styles?: string[];
  min_rating?: number | null;
  abv_min?: number | null;
  abv_max?: number | null;
  require_untappd_match?: boolean;
}
```

Immediately after the existing local-id guard in `filterInteresting`, add:

```ts
if (opts.require_untappd_match && t.untappd_id == null) return false;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/domain/filters.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain policy**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "fix(filters): make Untappd match eligibility explicit"
```

### Task 2: Classify empty Ontap slots before catalog matching

**Files:**
- Modify: `src/sources/ontap/pub.ts:24-45`
- Test: `src/sources/ontap/pub.test.ts`
- Modify: `src/jobs/refresh-ontap.ts:10-12,89-117`
- Test: `src/jobs/refresh-ontap.test.ts`
- Modify: `src/bot/commands/beers-build.ts:1-8,56-61`

- [ ] **Step 1: Write the failing sentinel-classification test**

Import `isOntapEmptyTapRef` in `src/sources/ontap/pub.test.ts` and add:

```ts
test('recognizes only the exact case-insensitive N/A empty-tap sentinel', () => {
  expect(isOntapEmptyTapRef(' N/A ')).toBe(true);
  expect(isOntapEmptyTapRef('n/a')).toBe(true);
  expect(isOntapEmptyTapRef('N/A Lager')).toBe(false);
  expect(isOntapEmptyTapRef('')).toBe(false);
});
```

- [ ] **Step 2: Write a failing refresh ingestion test**

Add a `refreshOntap` test whose pub HTML contains one real beer and
`${panel(2, '', 'N/A', '')}`. After refresh, assert:

```ts
expect(tapsForSnapshot(db, snap!.id).map((tap) => tap.beer_ref))
  .toEqual(['Real Beer', 'N/A']);
expect(db.prepare("SELECT COUNT(*) AS n FROM beers WHERE name = 'N/A'").get())
  .toEqual({ n: 0 });
expect(db.prepare("SELECT COUNT(*) AS n FROM match_links WHERE ontap_ref = 'N/A'").get())
  .toEqual({ n: 0 });
```

This proves the raw snapshot remains complete while catalog pollution stops.

- [ ] **Step 3: Run the source and refresh tests and verify RED**

Run: `npx vitest run src/sources/ontap/pub.test.ts src/jobs/refresh-ontap.test.ts`

Expected: FAIL because the helper and catalog-loop guard do not exist.

- [ ] **Step 4: Implement the exact sentinel helper**

Add to `src/sources/ontap/pub.ts`:

```ts
export function isOntapEmptyTapRef(beerRef: string): boolean {
  return beerRef.trim().toUpperCase() === 'N/A';
}
```

- [ ] **Step 5: Skip empty slots in the catalog loop**

Import the helper beside `parsePubPage`, then add this as the first statement in
the `for (const t of taps)` catalog loop:

```ts
if (isOntapEmptyTapRef(t.beer_ref)) continue;
```

Do not remove the row from `taps` before `insertTaps`; `/beers` must retain it.

- [ ] **Step 6: Reuse the helper in `/beers`**

Replace the inline `tap.beer_ref.trim().toUpperCase() === 'N/A'` condition with
`isOntapEmptyTapRef(tap.beer_ref)`. This is behavior-preserving and keeps the
sentinel definition consistent across all consumers.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `npx vitest run src/sources/ontap/pub.test.ts src/jobs/refresh-ontap.test.ts src/bot/commands/beers-build.test.ts`

Expected: all focused test files PASS.

- [ ] **Step 8: Commit the empty-slot classification**

```bash
git add src/sources/ontap/pub.ts src/sources/ontap/pub.test.ts src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts src/bot/commands/beers-build.ts
git commit -m "fix(ontap): keep empty taps out of catalog matching"
```

### Task 3: Apply consumer-specific `/newbeers` and route policies

**Files:**
- Modify: `src/bot/commands/newbeers-build.ts:45-86`
- Test: `src/bot/commands/newbeers-build.test.ts`
- Modify: `src/bot/commands/route.ts:45-65`
- Create: `src/bot/commands/route.test.ts`

- [ ] **Step 1: Write failing `/newbeers` tests for ordinary orphans and `N/A`**

Import `setFilters` from `../../storage/user_filters`. Add a fixture that creates one pub/snapshot, two orphan beer rows and match-links (`Mystery Beer` and `N/A`), and their taps. Add:

```ts
test('unfiltered results keep ordinary orphans but always hide N/A taps', () => {
  const db = fresh();
  seedOrphanAndEmptyTap(db);
  const t = createTranslator('uk');
  const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' });
  expect(out.kind).toBe('ok');
  if (out.kind !== 'ok') return;
  expect(out.html).toContain('Mystery Beer');
  expect(out.html).not.toContain('<b>N/A</b>');
});

test('active user filters hide ordinary orphans', () => {
  const db = fresh();
  seedOrphanAndEmptyTap(db);
  setFilters(db, 1, {
    styles: [], min_rating: null, abv_min: null, abv_max: 8, default_route_n: null,
  });
  const t = createTranslator('uk');
  expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' }))
    .toEqual({ kind: 'empty' });
});
```

The fixture must omit `untappd_id`, call `upsertMatch`, and give `Mystery Beer`
an ABV below 8 so the existing ABV predicate would retain it. This proves that
the active-filter match requirement—not missing metadata—excludes the orphan.

- [ ] **Step 2: Write a failing route-policy test**

Create `src/bot/commands/route.test.ts`:

```ts
import { filterRouteTaps } from './route';

test('route candidates always require a real Untappd match', () => {
  const taps = [
    { beer_id: 1, untappd_id: null, style: 'IPA', abv: 6, u_rating: null },
    { beer_id: 2, untappd_id: 2002, style: 'IPA', abv: 6, u_rating: 4 },
  ];
  expect(filterRouteTaps(taps, new Set(), {}).map((tap) => tap.beer_id)).toEqual([2]);
});
```

- [ ] **Step 3: Run both command tests and verify RED**

Run: `npx vitest run src/bot/commands/newbeers-build.test.ts src/bot/commands/route.test.ts`

Expected: FAIL because `N/A` is rendered, active-filter orphan policy is absent, and `filterRouteTaps` does not exist.

- [ ] **Step 4: Implement `/newbeers` policy**

Import `FilterOpts` and `isOntapEmptyTapRef`, then add:

```ts
const hasActiveBeerFilters = (filters: FilterOpts): boolean =>
  Boolean(filters.styles?.length) ||
  filters.min_rating != null ||
  filters.abv_min != null ||
  filters.abv_max != null;
```

Call the filter with the conditional option:

```ts
const good = filterInteresting(taps, tried, {
  ...filters,
  require_untappd_match: hasActiveBeerFilters(filters),
});
```

As the first statement in the candidate loop, add:

```ts
if (isOntapEmptyTapRef(tap.beer_ref)) continue;
```

- [ ] **Step 5: Implement and use the route policy boundary**

Import `TapView` and `FilterOpts`, export this wrapper, and use it instead of the direct `filterInteresting` call:

```ts
export function filterRouteTaps<T extends TapView>(
  taps: T[], tried: Set<number>, filters: FilterOpts,
): T[] {
  return filterInteresting(taps, tried, { ...filters, require_untappd_match: true });
}
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npx vitest run src/domain/filters.test.ts src/bot/commands/newbeers-build.test.ts src/bot/commands/route.test.ts`

Expected: all focused test files PASS.

- [ ] **Step 7: Commit the consumer policies**

```bash
git add src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts src/bot/commands/route.ts src/bot/commands/route.test.ts
git commit -m "fix(newbeers): apply context-aware orphan filtering"
```

### Task 4: Synchronize the canonical specification and verify

**Files:**
- Modify: `spec.md:450-466,775-784`

- [ ] **Step 1: Update `/newbeers` behavior in `spec.md`**

Replace the unconditional matched-only statement with text that states:

```md
Без активних style/rating/ABV-фільтрів `/newbeers` може показувати orphan-и без
`untappd_id` (із `⭐ —`), але завжди відкидає порожні ontap-слоти `N/A`. Якщо
активний хоча б один beer-фільтр, показуються лише пива з реальним
`untappd_id`. Маршрут завжди використовує лише пива з реальним `untappd_id`.
```

Update the business-invariant bullet at line 783 to the same conditional rule.

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck && npm run build && git diff --check`

Expected: all commands exit 0 with no TypeScript or whitespace errors.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: all test files and tests PASS, including the new regressions.

- [ ] **Step 4: Review the final diff against the approved design**

Run: `git diff 27c46ee --stat && git diff 27c46ee`

Confirm every changed line belongs to empty-slot classification, conditional
orphan eligibility, route eligibility, tests, or canonical documentation. Confirm
that no extension files changed, so no extension changelog update is required.

- [ ] **Step 5: Commit the specification synchronization**

```bash
git add spec.md
git commit -m "docs(spec): clarify conditional orphan visibility"
```

- [ ] **Step 6: Run final fresh verification after all commits**

Run: `npm run typecheck && npm run build && npm test && git diff --check && git status --short`

Expected: typecheck/build/test commands exit 0, the full suite passes, diff check
is clean, and `git status --short` has no output.
