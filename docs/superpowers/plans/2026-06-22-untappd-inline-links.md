# Inline Untappd Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make matched beer names in `/beers` and `/newbeers` tappable links that open the beer in the Untappd app.

**Architecture:** Wrap the display name of any beer with a real `beers.untappd_id` in `<a href="https://untappd.com/beer/{id}"><b>…</b></a>` (universal link → opens Untappd app on mobile). Reuse the existing `buildBeerPageUrl` helper. `/beers` already has `tap.untappd_id` on the row; `/newbeers` needs the id threaded through its grouping pipeline. Orphans (no id) stay plain.

**Tech Stack:** TypeScript, Telegraf (HTML parse mode), Vitest.

---

### Task 1: `/beers` — link matched beer names

**Files:**
- Modify: `src/bot/commands/beers-build.ts` (imports + per-tap render ~line 57-71)
- Test: `src/bot/commands/beers-build.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/bot/commands/beers-build.test.ts`, inside the existing top-level `describe` block (after the icon tests near line 183):

```typescript
test('matched beer name is a tappable Untappd link', () => {
  const db = fresh();
  upsertPub(db, { name: 'Kufel', address: null, city: 'warszawa', lat: null, lng: null });
  const pubId = (db.prepare('SELECT id FROM pubs').get() as { id: number }).id;
  const beerId = upsertBeer(db, {
    untappd_id: 6172039, name: 'Wocky Talky', brewery: 'JBW Browar', style: null,
    abv: 5, ibu: null, rating_global: 4.1,
  });
  upsertMatch(db, 'JBW Brewery Wocky Talky', beerId, 1.0);
  const snap = createSnapshot(db, pubId, new Date().toISOString());
  insertTaps(db, snap, [
    { tap_number: 1, beer_ref: 'Wocky Talky', brewery_ref: 'JBW Brewery', abv: 5, ibu: null, style: null, u_rating: null },
  ]);
  const out = base(db, 'Kufel');
  expect(out.kind).toBe('ok');
  if (out.kind !== 'ok') return;
  expect(out.html).toContain('<a href="https://untappd.com/beer/6172039"><b>JBW Brewery Wocky Talky</b></a>');
});

test('orphan beer name has no link', () => {
  const db = fresh();
  upsertPub(db, { name: 'Kufel', address: null, city: 'warszawa', lat: null, lng: null });
  const pubId = (db.prepare('SELECT id FROM pubs').get() as { id: number }).id;
  const snap = createSnapshot(db, pubId, new Date().toISOString());
  insertTaps(db, snap, [
    { tap_number: 1, beer_ref: 'Mystery Brew', brewery_ref: 'Nobody', abv: null, ibu: null, style: null, u_rating: null },
  ]);
  const out = base(db, 'Kufel');
  expect(out.kind).toBe('ok');
  if (out.kind !== 'ok') return;
  expect(out.html).not.toContain('<a href=');
});
```

> Note: check the exact `insertTaps` row shape against existing tests in this file (around lines 80-99) and match it; the fields above mirror that usage. Adjust if the helper signature differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/commands/beers-build.test.ts -t "tappable Untappd link"`
Expected: FAIL — output contains `<b>JBW Brewery Wocky Talky</b>` without the surrounding `<a>`.

- [ ] **Step 3: Write minimal implementation**

In `src/bot/commands/beers-build.ts`, add the import near the top (after line 7):

```typescript
import { buildBeerPageUrl } from '../../sources/untappd/beer-page';
```

Replace the matched-line render (currently lines 62-71) so the display is linked when an `untappd_id` exists:

```typescript
    const display = tap.brewery_ref
      ? `${tap.brewery_ref} ${tap.beer_ref}`.trim()
      : tap.beer_ref;
    const icon = tap.untappd_id != null ? '🟢' : '⚪';
    const name =
      tap.untappd_id != null
        ? `<a href="${buildBeerPageUrl(tap.untappd_id)}"><b>${escapeHtml(display)}</b></a>`
        : `<b>${escapeHtml(display)}</b>`;
    return (
      `${fmtTapNum(tap.tap_number)} • ${name}` +
      ` • ${fmtAbv(tap.abv)} • ${fmtRating(tap.u_rating)} • ${icon}`
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/bot/commands/beers-build.test.ts`
Expected: PASS (new tests + all existing — the `<b>No Numbers</b>` orphan assertion at line 121 still holds because orphans stay plain).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/beers-build.ts src/bot/commands/beers-build.test.ts
git commit -m "feat(beers): link matched beer names to Untappd (#185)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `/newbeers` — thread `untappd_id` and link grouped names

**Files:**
- Modify: `src/bot/commands/newbeers-format.ts` (`CandidateTap`, `BeerGroup`, `groupTaps`, `formatGroupedBeers`)
- Modify: `src/bot/commands/newbeers-build.ts` (populate `untappd_id` when building candidates, ~line 89)
- Test: `src/bot/commands/newbeers-format.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/bot/commands/newbeers-format.test.ts`, add `untappd_id: null` to the `tap(...)` factory default (around line 16, alongside `beer_id: null`). Then add a new describe block (e.g. after the `formatGroupedBeers` tests):

```typescript
describe('untappd links', () => {
  test('groupTaps carries untappd_id from the representative tap', () => {
    const r = groupTaps([
      tap({ beer_id: 1, untappd_id: 555, display: 'Salamander', rating: 3.9, pub_name: 'Cuda' }),
      tap({ beer_id: 1, untappd_id: 555, display: 'Salamander', rating: 3.8, pub_name: 'PiwPaw' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].untappd_id).toBe(555);
  });

  test('orphan group has null untappd_id', () => {
    const r = groupTaps([tap({ beer_id: null, untappd_id: null, display: 'X' })]);
    expect(r[0].untappd_id).toBeNull();
  });

  test('formatGroupedBeers links matched names and leaves orphans plain', () => {
    const groups: BeerGroup[] = [
      { display: 'Linked Beer', rating: 4, abv: 5, pubs: ['P'], untappd_id: 777 },
      { display: 'Orphan Beer', rating: 3, abv: 5, pubs: ['P'], untappd_id: null },
    ];
    const out = formatGroupedBeers(groups, 'uk', stubT);
    expect(out).toContain('<a href="https://untappd.com/beer/777"><b>Linked Beer</b></a>');
    expect(out).toContain('<b>Orphan Beer</b>');
    expect(out).not.toContain('<a href="https://untappd.com/beer/"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/commands/newbeers-format.test.ts -t "untappd links"`
Expected: FAIL — TypeScript error (`untappd_id` not on `CandidateTap`/`BeerGroup`) and/or missing link in output.

- [ ] **Step 3: Write minimal implementation**

In `src/bot/commands/newbeers-format.ts`:

Add the import near the top (after the existing imports):

```typescript
import { buildBeerPageUrl } from '../../sources/untappd/beer-page';
```

Add `untappd_id` to `CandidateTap` (after `beer_id`, ~line 5):

```typescript
  beer_id: number | null;
  untappd_id: number | null;
```

Add `untappd_id` to `BeerGroup` (after `display`, ~line 15):

```typescript
  display: string;
  untappd_id: number | null;
```

In `groupTaps`, store the id in the accumulator. Update the accumulator type and the first-insert branch, and emit it. Change the `Map` value type to include `untappd_id: number | null`; in the `if (!cur)` branch add `untappd_id: t.untappd_id,`; and in the final `.map(...)` add `untappd_id: g.untappd_id,`. The representative-tap stays the first seen (matched groups share one id, so no reassignment needed):

```typescript
  const acc = new Map<
    string,
    { display: string; untappd_id: number | null; bestRating: number | null; abv: number | null; pubs: Set<string> }
  >();
  for (const t of taps) {
    const k = groupKey(t);
    const cur = acc.get(k);
    if (!cur) {
      acc.set(k, {
        display: t.display,
        untappd_id: t.untappd_id,
        bestRating: t.rating,
        abv: t.abv,
        pubs: new Set([t.pub_name]),
      });
      continue;
    }
    // ...existing merge body unchanged...
  }
  return [...acc.values()].map((g) => ({
    display: g.display,
    untappd_id: g.untappd_id,
    rating: g.bestRating,
    abv: g.abv,
    pubs: [...g.pubs].sort((a, b) => a.localeCompare(b)),
  }));
```

In `formatGroupedBeers`, link the name when `untappd_id` is set. Replace the `head` construction (~line 94):

```typescript
    const name =
      g.untappd_id != null
        ? `<a href="${buildBeerPageUrl(g.untappd_id)}"><b>${escapeHtml(g.display)}</b></a>`
        : `<b>${escapeHtml(g.display)}</b>`;
    const head = `${i + 1}. ${name}  ${fmtRating(g.rating)}${fmtAbvLocale(locale, g.abv)}`;
```

In `src/bot/commands/newbeers-build.ts`, populate the id when building each candidate (~line 89-90, alongside `beer_id: tap.beer_id,`):

```typescript
        beer_id: tap.beer_id,
        untappd_id: tap.untappd_id,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/bot/commands/newbeers-format.test.ts src/bot/commands/newbeers-build.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/newbeers-format.ts src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-format.test.ts
git commit -m "feat(newbeers): link matched beer names to Untappd (#185)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Update `spec.md`

**Files:**
- Modify: `spec.md` (§463 newbeers step 5; §477-480 /beers format)

- [ ] **Step 1: Update the `/newbeers` formatting line (§463)**

Change the formatting bullet so it reads (Ukrainian, matching surrounding prose):

```
5. форматування HTML (`newbeers-format.ts`): жирна назва (для пива з реальним
   `untappd_id` — клікабельне посилання `https://untappd.com/beer/<id>`,
   відкриває застосунок Untappd) + ⭐ рейтинг + ABV-чіп, до 3 пабів + «+N інших».
```

- [ ] **Step 2: Update the `/beers` format line (§479)**

Append to the format description that matched beer names are tappable Untappd links:

```
Формат: `{№} • {Пивоварня Назва} • {ABV} • {рейтинг} • {🟢|⚪}`, де 🟢 =
`beers.untappd_id IS NOT NULL` (назва — клікабельне посилання
`https://untappd.com/beer/<id>`, відкриває застосунок Untappd), ⚪ = orphan.
```

> Edit in place, preserving the rest of each sentence (disambiguation clause, etc.). Keep line wrapping consistent with the file (~80 cols).

- [ ] **Step 3: Verify the full test suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): note tappable Untappd links in /beers and /newbeers (#185)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- `buildBeerPageUrl(bid)` lives in `src/sources/untappd/beer-page.ts` and returns `https://untappd.com/beer/${bid}`.
- **Use `tap.untappd_id` (the real Untappd id), NOT `tap.beer_id`.** `beer_id` is the *local* `beers.id` from `match_links` and is set even for orphans with no Untappd id — linking it would produce dead links.
- Telegram HTML mode allows `<a href>` and nested `<b>`. Display text must stay HTML-escaped (already done via `escapeHtml`); the numeric id needs no escaping.
- No locale-string metavar angle-brackets are involved here, so the known Telegraf HTML/i18n escaping pitfall does not apply.
