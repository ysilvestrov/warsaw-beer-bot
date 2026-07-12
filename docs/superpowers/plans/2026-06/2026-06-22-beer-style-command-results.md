# Beer Style in Command Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each known beer style inline in `/newbeers`, `/beers`, and `/route`, while omitting unknown styles without a placeholder.

**Architecture:** Reuse the nullable `style` already returned by `tapsForSnapshotWithBeer`. Carry it through the existing `/newbeers` grouping model, reuse one HTML-safe style formatter in all three command outputs, and leave filtering, ranking, storage, and route construction unchanged.

**Tech Stack:** TypeScript, Telegraf HTML messages, SQLite/better-sqlite3, Vitest

---

## File map

- Modify `src/bot/commands/newbeers-format.ts`: add style to candidate/group types, preserve it while grouping, and expose the shared inline formatter.
- Modify `src/bot/commands/newbeers-format.test.ts`: cover representative/fallback grouping, rendering, omission, and escaping.
- Modify `src/bot/commands/newbeers-build.ts`: copy `tap.style` into each candidate.
- Modify `src/bot/commands/newbeers-build.test.ts`: verify the command-level data path renders styles.
- Modify `src/bot/commands/beers-build.ts`: insert the shared style chip into non-empty tap lines.
- Modify `src/bot/commands/beers-build.test.ts`: verify known, unknown, escaped, and empty-tap behavior.
- Modify `src/bot/commands/route.ts`: pass styles into candidates and formatted route beer lines.
- Modify `src/bot/commands/route-format.ts`: add and render nullable route beer styles.
- Modify `src/bot/commands/route-format.test.ts`: verify inline style rendering, omission, and escaping.
- Modify `spec.md`: document the visible format for the three commands.

### Task 1: Carry and render style in `/newbeers`

**Files:**
- Modify: `src/bot/commands/newbeers-format.test.ts`
- Modify: `src/bot/commands/newbeers-build.test.ts`
- Modify: `src/bot/commands/newbeers-format.ts`
- Modify: `src/bot/commands/newbeers-build.ts`

- [ ] **Step 1: Write failing grouping and formatting tests**

Add `style: null` to the `tap()` default and the `g()` helper's returned `BeerGroup`. Add these focused cases:

```ts
test('group style comes from highest-rated representative, with non-null fallback', () => {
  const r = groupTaps([
    tap({ beer_id: 1, rating: 3.5, style: 'IPA', pub_name: 'A' }),
    tap({ beer_id: 1, rating: 3.9, style: 'Double IPA', pub_name: 'B' }),
  ]);
  expect(r[0].style).toBe('Double IPA');
});

test('group style falls back to a non-null value', () => {
  const r = groupTaps([
    tap({ beer_id: 1, rating: 3.9, style: null, pub_name: 'A' }),
    tap({ beer_id: 1, rating: 3.5, style: 'IPA', pub_name: 'B' }),
  ]);
  expect(r[0].style).toBe('IPA');
});

test('renders and HTML-escapes a known style inline', () => {
  const text = formatGroupedBeers(
    [{ display: 'X', style: 'IPA & <Ale>', rating: 4, abv: 6, pubs: ['A'] }],
    'uk', stubT,
  );
  expect(text).toContain('<b>X</b> • IPA &amp; &lt;Ale&gt;  ⭐ 4');
});

test('omits an unknown style and its separator', () => {
  const text = formatGroupedBeers(
    [{ display: 'X', style: null, rating: 4, abv: null, pubs: ['A'] }],
    'uk', stubT,
  );
  expect(text).toContain('<b>X</b>  ⭐ 4');
  expect(text).not.toContain('<b>X</b> •');
});
```

Update every existing `BeerGroup` literal in this test file with `style: null` so the fixtures match the intended type.

- [ ] **Step 2: Add a failing `/newbeers` integration assertion**

In the existing `returns kind=ok with HTML containing the beer when a matched tap exists` test, assert that both seeded styles traverse the builder:

```ts
expect(out.html).toContain('• AIPA');
expect(out.html).toContain('• Pils');
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/bot/commands/newbeers-format.test.ts src/bot/commands/newbeers-build.test.ts
```

Expected: FAIL because `CandidateTap`/`BeerGroup` do not expose `style`, and the output does not include the seeded style.

- [ ] **Step 4: Implement style propagation and shared formatting**

Add `style` to both public types:

```ts
export interface CandidateTap {
  beer_id: number | null;
  display: string;
  brewery_norm: string;
  name_norm: string;
  style: string | null;
  abv: number | null;
  rating: number | null;
  pub_name: string;
}

export interface BeerGroup {
  display: string;
  style: string | null;
  rating: number | null;
  abv: number | null;
  pubs: string[];
}
```

Add `style: string | null` to the internal accumulator, initialize it from `t.style`, update it alongside the highest-rated representative only when non-null, fall back when the accumulated value is null, and include it in the returned group:

```ts
if (t.rating !== null && (cur.bestRating === null || t.rating > cur.bestRating)) {
  cur.display = t.display;
  if (t.style !== null) cur.style = t.style;
  if (t.abv !== null) cur.abv = t.abv;
}
cur.bestRating = maxRating(cur.bestRating, t.rating);
if (cur.style === null && t.style !== null) cur.style = t.style;
if (cur.abv === null && t.abv !== null) cur.abv = t.abv;
```

After `escapeHtml`, add a reusable formatter:

```ts
export const fmtStyle = (style: string | null): string =>
  style === null ? '' : ` • ${escapeHtml(style)}`;
```

Render it without changing the unknown-style spacing:

```ts
const head = `${i + 1}. <b>${escapeHtml(g.display)}</b>${fmtStyle(g.style)}  ${fmtRating(g.rating)}${fmtAbvLocale(locale, g.abv)}`;
```

Finally, populate the candidate in `buildNewbeersMessage`:

```ts
style: tap.style,
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run src/bot/commands/newbeers-format.test.ts src/bot/commands/newbeers-build.test.ts
```

Expected: both files pass.

- [ ] **Step 6: Commit the `/newbeers` slice**

```bash
git add src/bot/commands/newbeers-format.ts src/bot/commands/newbeers-format.test.ts src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts
git commit -m "feat(newbeers): show beer styles"
```

### Task 2: Render style in `/beers`

**Files:**
- Modify: `src/bot/commands/beers-build.test.ts`
- Modify: `src/bot/commands/beers-build.ts`

- [ ] **Step 1: Write failing known-style and escaping assertions**

In `shows every tap incl. orphan and already-tried, with 🟢/⚪ icons`, change the first tap style to `AIPA & <Ale>` and add:

```ts
const matchedLine = out.html.split('\n').find((line) => line.startsWith('1 '))!;
expect(matchedLine).toContain('<b>PINTA PINTA Atak Chmielu</b> • AIPA &amp; &lt;Ale&gt; • 6.1%');
```

Keep the existing `null tap_number / abv / rating render as em dash` assertion unchanged; it is the regression check that a null style adds neither a placeholder nor a separator. Keep the exact `2 • N/A` test unchanged as the empty-tap regression check.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/bot/commands/beers-build.test.ts
```

Expected: FAIL because the known style is absent from the rendered line.

- [ ] **Step 3: Implement the inline style chip**

Import the shared formatter:

```ts
import { escapeHtml, fmtStyle } from './newbeers-format';
```

Insert it immediately after the bold display name:

```ts
return (
  `${fmtTapNum(tap.tap_number)} • <b>${escapeHtml(display)}</b>${fmtStyle(tap.style)}` +
  ` • ${fmtAbv(tap.abv)} • ${fmtRating(tap.u_rating)} • ${icon}`
);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run src/bot/commands/beers-build.test.ts
```

Expected: all `/beers` builder tests pass, including null-style and `N/A` output.

- [ ] **Step 5: Commit the `/beers` slice**

```bash
git add src/bot/commands/beers-build.ts src/bot/commands/beers-build.test.ts
git commit -m "feat(beers): show beer styles"
```

### Task 3: Carry and render style in `/route`

**Files:**
- Modify: `src/bot/commands/route-format.test.ts`
- Modify: `src/bot/commands/route-format.ts`
- Modify: `src/bot/commands/route.ts`

- [ ] **Step 1: Write failing route formatter tests**

Add nullable styles to the shared route fixtures:

```ts
{ display: 'Pinta Atak Chmielu', style: 'IPA', rating: 4.12, abv: 6.1 },
{ display: 'Browar Stu Mostów Salamander', style: null, rating: null, abv: 4.5 },
```

and:

```ts
{ display: 'AleBrowar IPA', style: 'Double IPA', rating: 3.9, abv: 6.0 },
```

Update the inline one-off route beer literals with `style: null`. Then change the per-pub rendering test to assert:

```ts
expect(out).toContain('<b>Pinta Atak Chmielu</b> • IPA  ⭐ 4.12');
expect(out).toContain('<b>Browar Stu Mostów Salamander</b>  ⭐ —');
```

Extend the HTML escaping test with a style:

```ts
beers: [{ display: 'A & B <c>', style: 'IPA & <Ale>', rating: null, abv: null }],
```

and assert:

```ts
expect(out).toContain('• IPA &amp; &lt;Ale&gt;');
```

- [ ] **Step 2: Run the focused formatter test and verify RED**

Run:

```bash
npx vitest run src/bot/commands/route-format.test.ts
```

Expected: FAIL because `RouteBeerLine` has no `style` and the formatter does not render it.

- [ ] **Step 3: Implement route style propagation and rendering**

Import `fmtStyle`, extend the route line type, and render it:

```ts
import { escapeHtml, fmtAbv, fmtRating, fmtStyle } from './newbeers-format';

export interface RouteBeerLine {
  display: string;
  style: string | null;
  rating: number | null;
  abv: number | null;
}
```

```ts
`     • <b>${escapeHtml(beer.display)}</b>${fmtStyle(beer.style)}  ${fmtRating(beer.rating)}${fmtAbv(locale, beer.abv)}`
```

In `route.ts`, populate `style` at both data-transfer boundaries:

```ts
style: t.style,
```

and:

```ts
beers: ranked.map((g) => ({
  display: g.display,
  style: g.style,
  rating: g.rating,
  abv: g.abv,
})),
```

- [ ] **Step 4: Run route tests and typecheck**

Run:

```bash
npx vitest run src/bot/commands/route-format.test.ts src/bot/commands/route.test.ts
npm run typecheck
```

Expected: both test files pass and TypeScript reports no errors, proving all `CandidateTap` and `RouteBeerLine` constructors provide `style`.

- [ ] **Step 5: Commit the `/route` slice**

```bash
git add src/bot/commands/route.ts src/bot/commands/route-format.ts src/bot/commands/route-format.test.ts
git commit -m "feat(route): show beer styles"
```

### Task 4: Synchronize the project specification and verify

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document the visible command formats**

In the `/newbeers` formatting step, replace the current format description with:

```md
5. форматування HTML (`newbeers-format.ts`): жирна назва + відомий стиль inline
   (невідомий пропускається) + ⭐ рейтинг + ABV-чіп, до 3 пабів + «+N інших».
```

Update `/beers` to state:

```md
Формат: `{№} • {Пивоварня Назва} [• {стиль, якщо відомий}] • {ABV} • {рейтинг} • {🟢|⚪}`,
```

After the `/route` routing details, add:

```md
У списку пив кожного паба відомий стиль показується inline після назви;
невідомий стиль пропускається без placeholder-а.
```

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm run typecheck
npm test
git diff --check
git diff --check main...HEAD
```

Expected: TypeScript exits 0, all test files pass, and both diff checks produce no output.

- [ ] **Step 3: Review scope**

Run:

```bash
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: only the design/plan, three command slices, their focused tests, and `spec.md` are changed; no schema, storage query, scraper, dependency, extension, or unrelated formatting changes appear.

- [ ] **Step 4: Commit the specification update**

```bash
git add spec.md
git commit -m "docs(spec): document beer styles in command results"
```

- [ ] **Step 5: Re-run final verification after the last commit**

Run:

```bash
npm run typecheck
npm test
git status --short
```

Expected: typecheck and all tests pass, and the worktree is clean.
