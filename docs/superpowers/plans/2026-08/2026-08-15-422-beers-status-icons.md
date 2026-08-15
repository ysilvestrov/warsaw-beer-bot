# `/beers` Personal Status Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/beers`' generic matched icon with caller-specific tried, untried, and orphan statuses while retaining global and personal ratings.

**Architecture:** Keep the command handler thin by passing the caller's Telegram ID into the existing pure-ish `buildBeersMessage` command builder. The builder will reuse `triedBeerIds` for the mandatory `checkins ∪ untappd_had` history and `latestRatingsByBeer` for the latest personal score, then select one status string per tap without filtering or reordering taps.

**Tech Stack:** Node.js 20+, TypeScript strict mode, Telegraf, better-sqlite3, Vitest.

---

### Task 1: Render caller-specific tap statuses

**Files:**
- Modify: `src/bot/commands/beers-build.test.ts`
- Modify: `src/bot/commands/beers-build.ts`
- Modify: `src/bot/commands/beers.ts`

- [ ] **Step 1: Write failing builder tests for the four status states**

In `src/bot/commands/beers-build.test.ts`, import the existing check-in helper and make the local builder helper accept a caller ID:

```ts
import { mergeCheckin } from '../../storage/checkins';

const base = (db: ReturnType<typeof fresh>, pubQuery?: string, telegramId = 1) =>
  buildBeersMessage({
    db,
    telegramId,
    locale: 'uk' as const,
    t,
    pubQuery,
    city: 'warszawa',
  });
```

Replace the current `shows every tap incl. orphan and already-tried, with 🟢/⚪ icons`
case with a test that keeps the same matched and unmatched taps, records a 4.2 check-in
for the matched beer, and proves both the global and personal scores are visible:

```ts
test('shows every tap and renders a tried beer with its latest personal rating', () => {
  const db = fresh();
  const pubId = upsertPub(db, {
    slug: 'p', name: 'Kufel', address: 'Foo 1', lat: null, lon: null, city: 'warszawa',
  });
  const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
  const beerId = upsertBeer(db, {
    untappd_id: 1, name: 'Atak Chmielu', brewery: 'Pinta', style: 'AIPA',
    abv: 6.1, rating_global: 3.85,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  upsertMatch(db, 'PINTA Atak Chmielu', beerId, 1.0);
  insertTaps(db, snap, [
    { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA',
      abv: 6.1, ibu: null, style: 'AIPA & <Ale>', u_rating: 3.9 },
    { tap_number: 2, beer_ref: 'Mystery Brew', brewery_ref: 'Unknown Co',
      abv: 5.0, ibu: null, style: null, u_rating: 4.2 },
  ]);
  mergeCheckin(db, {
    checkin_id: 'checkin-1', telegram_id: 1, beer_id: beerId,
    user_rating: 4.2, checkin_at: '2026-05-25T11:00:00Z', venue: null,
  });

  const out = base(db, 'kufel');
  expect(out.kind).toBe('ok');
  if (out.kind !== 'ok') return;
  expect(out.html).toContain('PINTA Atak Chmielu');
  expect(out.html).toContain('Mystery Brew');
  expect(out.html).toContain('Kufel');
  expect(out.html).toContain('Foo 1');
  expect(out.html).toContain('Кранів: 2');
  const matchedLine = out.html.split('\n').find((line) => line.startsWith('1 '))!;
  expect(matchedLine).toContain(
    '<a href="https://untappd.com/beer/1"><b>PINTA PINTA Atak Chmielu</b></a>' +
    ' • AIPA &amp; &lt;Ale&gt; • 6.1% • 3.9 • ✅ 4.2',
  );
  const orphanLine = out.html.split('\n').find((line) => line.startsWith('2 '))!;
  expect(orphanLine).toContain('⚪');
});
```

Change the existing real-catalog test to expect `⭐` for an untried beer:

```ts
test('tap matched to an untried real catalog beer shows ⭐', () => {
  const db = fresh();
  const pubId = upsertPub(db, {
    slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa',
  });
  const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
  const beerId = upsertBeer(db, {
    untappd_id: 6172039, name: 'Wocky Talky', brewery: 'JBW Browar', style: null,
    abv: 4.2, rating_global: 3.18,
    normalized_name: 'wocky talky', normalized_brewery: 'jbw',
  });
  upsertMatch(db, 'JBW Brewery Wocky Talky', beerId, 1.0);
  insertTaps(db, snap, [
    { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
      abv: 4.2, ibu: null, style: null, u_rating: null },
  ]);

  const out = base(db, 'kufel');
  expect(out.kind).toBe('ok');
  if (out.kind !== 'ok') return;
  const line = out.html.split('\n').find((l) => l.startsWith('1 '))!;
  expect(line).toContain('⭐');
  expect(line).not.toContain('✅');
});
```

Change the existing matched-orphan test into the `untappd_had`-only precedence case
with this complete test:

```ts
test('tried matched orphan shows bare ✅ from untappd_had', () => {
  const db = fresh();
  const pubId = upsertPub(db, {
    slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa',
  });
  const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
  const orphanId = upsertBeer(db, {
    untappd_id: null, name: 'Wocky Talky', brewery: 'JBW Brewery', style: null,
    abv: 4.2, rating_global: null,
    normalized_name: 'wocky talky', normalized_brewery: 'jbw',
  });
  upsertMatch(db, 'JBW Brewery Wocky Talky', orphanId, 1.0);
  insertTaps(db, snap, [
    { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
      abv: 4.2, ibu: null, style: null, u_rating: null },
  ]);
  db.prepare(
    'INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)',
  ).run(1, orphanId, '2026-05-25T11:00:00Z');

  const out = base(db, 'kufel');
  expect(out.kind).toBe('ok');
  if (out.kind !== 'ok') return;
  const line = out.html.split('\n').find((l) => l.startsWith('1 '))!;
  expect(line.endsWith(' • ✅')).toBe(true);
  expect(line).not.toContain('⚪');
});
```

Keep the unmatched-orphan assertion from the first test and the existing `N/A` test,
so all four states plus compact empty-tap rendering remain covered.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/bot/commands/beers-build.test.ts
```

Expected: FAIL because `BeersDeps` does not accept `telegramId`, matched taps still
render `🟢`, and no personal rating is rendered. If TypeScript transpilation does not
surface the extra property, the assertions must still fail on the old icons.

- [ ] **Step 3: Implement the minimal status selection in the builder**

In `src/bot/commands/beers-build.ts`, import the existing helpers:

```ts
import { triedBeerIds } from '../../storage/untappd_had';
import { latestRatingsByBeer } from '../../storage/checkins';
```

Add the caller ID to `BeersDeps`:

```ts
export interface BeersDeps {
  db: DB;
  telegramId: number;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
  city: string;
}
```

After the non-empty tap list is loaded, materialize the two existing personal-data
collections once per command:

```ts
const tried = triedBeerIds(db, deps.telegramId);
const personalRatings = latestRatingsByBeer(db, deps.telegramId);
```

Inside the non-empty-tap branch of `taps.map`, replace the generic icon calculation
with the precedence defined in the design:

```ts
const isTried = tap.beer_id != null && tried.has(tap.beer_id);
const personalRating = tap.beer_id != null
  ? personalRatings.get(tap.beer_id)
  : undefined;
const status = isTried
  ? personalRating != null
    ? `✅ ${personalRating.toFixed(1)}`
    : '✅'
  : tap.untappd_id != null
    ? '⭐'
    : '⚪';
```

Use `${status}` as the final field of the rendered line. Do not change tap filtering,
ordering, links, global rating formatting, or `N/A` handling.

In `src/bot/commands/beers.ts`, pass the caller identity alongside the existing city:

```ts
const result = buildBeersMessage({
  db: ctx.deps.db,
  telegramId: ctx.from.id,
  locale: ctx.locale,
  t: ctx.t,
  pubQuery: arg || undefined,
  city: getUserCity(ctx.deps.db, ctx.from.id),
});
```

- [ ] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
npx vitest run src/bot/commands/beers-build.test.ts
npm run typecheck
```

Expected: the focused test file passes with all status assertions, and TypeScript
reports no errors.

- [ ] **Step 5: Commit the behavioral change**

Stage only the three task files and commit:

```bash
git add src/bot/commands/beers-build.test.ts src/bot/commands/beers-build.ts src/bot/commands/beers.ts
git commit -m "feat(#422): personalize beer status icons"
```

### Task 2: Align the project specification and verify the feature

**Files:**
- Modify: `spec.md:553`

- [ ] **Step 1: Update the `/beers` contract in `spec.md`**

Replace the existing `/beers <паб>` paragraph with:

```md
### `/beers <паб>` — персональний стан кранів (аргумент обов'язковий)
Показує **всі** крани одного паба з останнього snapshot без beer-фільтрів і без
відсіву за had-списком. Had-список (`checkins ∪ untappd_had`) використовується лише
для персональної анотації. Формат:
`{№} • {Пивоварня Назва} [• {стиль, якщо відомий}] • {ABV} • {глобальний рейтинг} • {статус}`.
Статус: `✅ {особиста оцінка}` для випитого з останньою non-null оцінкою check-in,
`✅` для випитого без особистої оцінки, `⭐` для невипитого пива з реальним
`beers.untappd_id`, `⚪` для невипитого orphan-а. Глобальний рейтинг лишається
окремим полем і не замінюється особистим. Для пива з реальним `untappd_id` назва —
клікабельне посилання `https://untappd.com/beer/<id>`, що відкриває застосунок Untappd.
Порожній кран `N/A` лишається компактним рядком без рейтингів і статусу.
Дизамбіґуація паба: за назвою, потім за адресою; кілька кандидатів → перші 3,
без угадування.
```

Also update the business-invariant bullet that currently says `/beers` shows raw data
"без фільтрів і had-списку" so it states that `/beers` never filters by the had-list
but does use it for the caller-specific annotation.

- [ ] **Step 2: Verify documentation and the entire project**

Run:

```bash
git diff --check
npm run typecheck
npm test
```

Expected: no whitespace errors, no TypeScript errors, and all project test files pass.

- [ ] **Step 3: Commit the specification update**

Stage only `spec.md` and commit:

```bash
git add spec.md
git commit -m "docs(#422): specify personal beer statuses"
```

### Final review and delivery gates

- [ ] Dispatch a specification-compliance reviewer for the complete range from the
  pre-implementation plan commit through `HEAD`; fix and re-review every finding.
- [ ] Dispatch a code-quality reviewer only after specification compliance passes;
  fix all Critical and Important findings and re-review.
- [ ] Run fresh final verification with `git diff --check`, `npm run typecheck`, and
  `npm test`, then inspect `git status --short --branch`.
- [ ] Ask whether to push the branch and create a pull request. If confirmed, create
  the PR and wait for review comments and checks as required by `AGENTS.md`.
