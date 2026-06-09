# Extension ⭐ Global-Rating Badge + Untappd Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Badge un-drunk catalog beers with `⭐ <global rating>` and make every badge (drunk `✅` or not) clickable to open the beer's Untappd page in a new tab.

**Architecture:** Thread the existing `beers.untappd_id` (numeric Untappd bid) through the match chain (`loadCatalog → matchBeerList → /match`) into the badge, then rewrite the badge renderer to a three-state machine with a click handler. No new matching logic, no new endpoint, no new permissions.

**Tech Stack:** TypeScript, better-sqlite3, Hono (`/match` route), ts-jest (bot), vitest + jsdom (extension).

**Spec:** `docs/superpowers/specs/2026-06-09-extension-global-rating-untappd-link-design.md`

---

## File structure

| File | Change |
| --- | --- |
| `src/storage/beers.ts` | `CatalogRow` + `loadCatalog` SELECT gain `untappd_id` |
| `src/domain/match-list.ts` | `CatalogBeerWithRating` (optional) + `MatchedBeer` (required) gain `untappd_id`; build passes it through |
| `src/api/routes/match.ts` | **no change** — propagates automatically once storage + domain carry the field |
| `extension/src/api/types.ts` | `MatchedBeer` gains `untappd_id: number \| null` |
| `extension/src/content/badge.ts` | three-state render + click-to-Untappd |
| `extension/src/cache/store.ts` | bump `PREFIX` to invalidate pre-`untappd_id` cache |
| `spec.md`, `extension/CHANGELOG.md` | doc updates |

---

## Task 1: Thread `untappd_id` through the server match chain

**Files:**
- Modify: `src/storage/beers.ts`, `src/domain/match-list.ts`
- Test: `src/storage/beers.test.ts`, `src/domain/match-list.test.ts`, `src/api/routes/match.test.ts`

- [ ] **Step 1: Update the `loadCatalog` test to expect `untappd_id`**

In `src/storage/beers.test.ts`, the `loadCatalog` test (near the end of the file) currently asserts:

```ts
    expect(cat).toContainEqual({
      id, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85,
    });
```

Replace that assertion with (the fixture already sets `untappd_id: 9001`):

```ts
    expect(cat).toContainEqual({
      id, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85,
      untappd_id: 9001,
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/storage/beers.test.ts -t loadCatalog`
Expected: FAIL — `loadCatalog` does not yet return `untappd_id` (`toContainEqual` sees no matching object).

- [ ] **Step 3: Add `untappd_id` to `CatalogRow` + `loadCatalog`**

In `src/storage/beers.ts`, change the `CatalogRow` interface:

```ts
export interface CatalogRow {
  id: number;
  brewery: string;
  name: string;
  abv: number | null;
  rating_global: number | null;
  untappd_id: number | null;
}
```

and the `loadCatalog` query:

```ts
export function loadCatalog(db: DB): CatalogRow[] {
  return db
    .prepare('SELECT id, brewery, name, abv, rating_global, untappd_id FROM beers')
    .all() as CatalogRow[];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/storage/beers.test.ts -t loadCatalog`
Expected: PASS.

- [ ] **Step 5: Update + add `match-list` tests for `untappd_id`**

In `src/domain/match-list.test.ts`, the first test (`marks a matched, drunk beer with its personal rating`) asserts the full `matched_beer`. Add `untappd_id: null` to it (the fixture catalog beer has no bid):

```ts
        matched_beer: { id: 105, name: 'Pan IPAni', brewery: 'Trzech Kumpli', rating_global: 3.85, untappd_id: null },
```

Then add a new test (place it inside the first `describe('matchBeerList', ...)` block):

```ts
  it('passes untappd_id through to matched_beer', async () => {
    const cat: CatalogBeerWithRating[] = [
      { id: 300, brewery: 'PINTA', name: 'Viva la Wit', abv: 4.8, rating_global: 3.6, untappd_id: 555 },
    ];
    const res = await matchBeerList(cat, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Viva la Wit' },
    ]);
    expect(res[0].matched_beer).toEqual({
      id: 300, name: 'Viva la Wit', brewery: 'PINTA', rating_global: 3.6, untappd_id: 555,
    });
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx jest src/domain/match-list.test.ts`
Expected: FAIL — `matched_beer` has no `untappd_id` field yet (the updated `toEqual` and the new test both mismatch).

- [ ] **Step 7: Add `untappd_id` to the domain types + build**

In `src/domain/match-list.ts`, extend `CatalogBeerWithRating` (input, optional — existing fixtures and callers omit it):

```ts
export interface CatalogBeerWithRating extends CatalogBeer {
  rating_global: number | null;
  untappd_id?: number | null;
}
```

extend `MatchedBeer` (output, required):

```ts
export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
  untappd_id: number | null;
}
```

and add the field where `matched_beer` is built (in the `else` branch of the `for (const item of items)` loop):

```ts
        matched_beer: {
          id: beer.id,
          name: beer.name,
          brewery: beer.brewery,
          rating_global: beer.rating_global,
          untappd_id: beer.untappd_id ?? null,
        },
```

- [ ] **Step 8: Run them to verify they pass**

Run: `npx jest src/domain/match-list.test.ts`
Expected: PASS (all tests, including the unchanged equivalence/yield ones).

- [ ] **Step 9: Add a route test asserting `untappd_id` propagates**

In `src/api/routes/match.test.ts`, add this test inside `describe('POST /match', ...)`:

```ts
  it('includes the matched beer untappd_id in the response', async () => {
    const { appAs } = setup();
    const res = await post(appAs(1), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    const body = await res.json();
    expect(body.results[0].matched_beer.untappd_id).toBe(9001);
  });
```

- [ ] **Step 10: Run it to verify it passes**

Run: `npx jest src/api/routes/match.test.ts`
Expected: PASS — `match.ts` is unchanged; the field propagates automatically through `loadCatalog → matchBeerList`.

- [ ] **Step 11: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/domain/match-list.ts src/domain/match-list.test.ts src/api/routes/match.test.ts
git commit -m "feat(match): thread beers.untappd_id through loadCatalog → matchBeerList → /match"
```

---

## Task 2: Badge ⭐ + click-to-Untappd in the extension

**Files:**
- Modify: `extension/src/api/types.ts`, `extension/src/content/badge.ts`, `extension/src/cache/store.ts`
- Test: `extension/src/content/badge.test.ts`

- [ ] **Step 1: Rewrite the badge test for the new behaviour**

Replace the whole contents of `extension/src/content/badge.test.ts` with:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderBadge, BADGE_MARKER, markSeen, isSeen, SEEN_MARKER } from './badge';
import type { MatchResult } from '../api/types';

function el(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

const drunk = (userRating: number | null): MatchResult => ({
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
  is_drunk: true,
  user_rating: userRating,
});

const notDrunkRated: MatchResult = {
  raw: { brewery: 'PINTA', name: 'New One' },
  matched_beer: { id: 2, name: 'New One', brewery: 'PINTA', rating_global: 3.9, untappd_id: 222 },
  is_drunk: false,
  user_rating: null,
};

const notDrunkOrphan: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Orphan' },
  matched_beer: { id: 3, name: 'Orphan', brewery: 'PINTA', rating_global: null, untappd_id: null },
  is_drunk: false,
  user_rating: null,
};

const unmatched: MatchResult = {
  raw: { brewery: 'Nowhere', name: 'Ghost' },
  matched_beer: null,
  is_drunk: false,
  user_rating: null,
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('renderBadge', () => {
  it('adds a ✅ + personal rating badge for a drunk beer', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('✅');
    expect(badge!.textContent).toContain('4.0');
  });

  it('shows just ✅ when drunk with no personal rating', () => {
    const host = el();
    renderBadge(host, drunk(null));
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('✅');
  });

  it('adds a ⭐ + global rating badge for a not-drunk catalog beer with a bid', () => {
    const host = el();
    renderBadge(host, notDrunkRated);
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge!.textContent).toContain('⭐');
    expect(badge!.textContent).toContain('3.9');
  });

  it('renders nothing for a not-drunk orphan (no bid / no global rating)', () => {
    const host = el();
    renderBadge(host, notDrunkOrphan);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('renders nothing for an unmatched beer', () => {
    const host = el();
    renderBadge(host, unmatched);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('opens the Untappd beer page on click and suppresses card navigation', () => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderBadge(host, notDrunkRated);
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    const notPrevented = badge.dispatchEvent(evt);
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
    expect(notPrevented).toBe(false); // preventDefault() was called
  });

  it('is idempotent — does not double-render', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    renderBadge(host, drunk(4.0));
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`).length).toBe(1);
  });
});

describe('seen marker', () => {
  it('marks and detects a processed element', () => {
    const host = document.createElement('div');
    expect(isSeen(host)).toBe(false);
    markSeen(host);
    expect(host.hasAttribute(SEEN_MARKER)).toBe(true);
    expect(isSeen(host)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && npx vitest run src/content/badge.test.ts`
Expected: FAIL — the fixtures use `matched_beer.untappd_id` (not in the type yet) and the `⭐`/click behaviour isn't implemented.

- [ ] **Step 3: Add `untappd_id` to the extension `MatchedBeer` type**

In `extension/src/api/types.ts`, extend `MatchedBeer`:

```ts
export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
  untappd_id: number | null;
}
```

- [ ] **Step 4: Rewrite `extension/src/content/badge.ts`**

Replace the whole file with:

```ts
import type { MatchResult } from '../api/types';

export const BADGE_MARKER = 'data-beerbadge';
export const SEEN_MARKER = 'data-beerseen';

/** Mark a card element as processed by the overlay (badged or not). */
export function markSeen(el: HTMLElement): void {
  el.setAttribute(SEEN_MARKER, '');
}

/** True if the overlay has already processed this card element. */
export function isSeen(el: HTMLElement): boolean {
  return el.hasAttribute(SEEN_MARKER);
}

function untappdUrl(untappdId: number): string {
  return `https://untappd.com/beer/${untappdId}`;
}

// The badge label, or null when this result should not be badged.
// drunk → ✅ (+ personal rating); in-catalog & not drunk with a bid + global
// rating → ⭐ (global rating); everything else (orphan / unmatched) → no badge.
function badgeText(result: MatchResult): string | null {
  const m = result.matched_beer;
  if (!m) return null;
  if (result.is_drunk) {
    return result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅';
  }
  if (m.untappd_id != null && m.rating_global != null) {
    return `⭐ ${m.rating_global.toFixed(1)}`;
  }
  return null;
}

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  const text = badgeText(result);
  if (text == null) return;
  if (host.querySelector(`[${BADGE_MARKER}]`)) return;

  const untappdId = result.matched_beer?.untappd_id ?? null;

  const badge = document.createElement('div');
  badge.setAttribute(BADGE_MARKER, '');
  badge.textContent = text;
  Object.assign(badge.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    zIndex: '2147483647',
    background: 'rgba(20,20,20,0.82)',
    color: '#fff',
    font: '600 12px/1 system-ui, sans-serif',
    padding: '3px 6px',
    borderRadius: '6px',
    pointerEvents: untappdId != null ? 'auto' : 'none',
    cursor: untappdId != null ? 'pointer' : 'default',
  } as Partial<CSSStyleDeclaration>);

  if (untappdId != null) {
    badge.addEventListener('click', (e) => {
      // The badge sits on top of the product card, which is usually itself a
      // link — suppress the card's navigation before opening Untappd.
      e.preventDefault();
      e.stopPropagation();
      window.open(untappdUrl(untappdId), '_blank', 'noopener');
    });
  }

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}
```

- [ ] **Step 5: Bump the cache prefix to invalidate pre-`untappd_id` entries**

In `extension/src/cache/store.ts`, change:

```ts
const PREFIX = 'mc:';
```

to:

```ts
const PREFIX = 'mc2:';
```

- [ ] **Step 6: Run the badge test + extension suite + typecheck**

Run: `cd extension && npx vitest run src/content/badge.test.ts`
Expected: PASS (7 `renderBadge` cases + seen-marker).

Run: `cd extension && npm test && npm run typecheck`
Expected: all vitest suites green; `tsc --noEmit` exits 0.

- [ ] **Step 7: Commit**

```bash
git add extension/src/api/types.ts extension/src/content/badge.ts extension/src/content/badge.test.ts extension/src/cache/store.ts
git commit -m "feat(extension): ⭐ global-rating badge for un-drunk beers + click-to-Untappd"
```

---

## Task 3: Spec + CHANGELOG

**Files:**
- Modify: `spec.md`, `extension/CHANGELOG.md`

- [ ] **Step 1: Update `spec.md` §6**

In `spec.md`, find the bullet beginning `- **Збірка — єдине джерело метаданих.**` in the Browser Extension Client section (§6). Immediately **before** it, add a new bullet describing the badge behaviour:

```markdown
- **Бейджі.** Питі беври — `✅` + особиста оцінка. Каталожні беври, які користувач ще
  не пив, але які мають `untappd_id` і глобальний рейтинг — `⭐` + глобальна оцінка
  Untappd. Будь-який бейдж із `untappd_id` клікабельний: відкриває сторінку беври на
  Untappd (`https://untappd.com/beer/<untappd_id>`) у новій вкладці. Орфани (без
  `untappd_id`/рейтингу) і незматчені — без бейджа.
```

- [ ] **Step 2: Add a CHANGELOG entry**

In `extension/CHANGELOG.md`, under the `## [Unreleased]` heading, add:

```markdown
- Show ⭐ global Untappd rating for catalog beers you haven't drunk yet.
- Click any rating badge to open that beer on Untappd in a new tab.
```

- [ ] **Step 3: Commit**

```bash
git add spec.md extension/CHANGELOG.md
git commit -m "docs: spec + changelog for ⭐ global-rating badge + Untappd link"
```

---

## Task 4: Full verification

- [ ] **Step 1: Bot suite**

Run: `npm test`
Expected: all bot/jest suites green, including the updated `beers`/`match-list`/`match` tests.

- [ ] **Step 2: Extension suite + typecheck**

Run: `cd extension && npm test && npm run typecheck`
Expected: all vitest suites green (incl. `src/content/badge.test.ts`); `tsc --noEmit` exits 0.

---

## Self-review notes

- **Spec coverage:** ⭐ badge for un-drunk catalog beers (Task 2), `✅` unchanged (Task 2), click-to-Untappd both badges (Task 2), `untappd_id` data flow storage→domain→api (Task 1) + extension type (Task 2), cache invalidation (Task 2 Step 5), orphan/unmatched → no badge (Task 2 tests), spec §6 + CHANGELOG (Task 3). All spec sections map to a task. Out-of-scope items (background tab, side-by-side window, no-rating badge) untouched.
- **Type consistency:** `untappd_id: number | null` is the output shape on both `MatchedBeer` types (domain + extension); `CatalogBeerWithRating.untappd_id?` is optional input; `CatalogRow.untappd_id` required (from SELECT). Badge reads `matched_beer.untappd_id`. Names match across tasks.
- **No placeholders:** every code/command step is complete and runnable.
- **Execution note:** implement in a worktree (branches from `origin/main`); cherry-pick the spec commit (`93f60ac`) and this plan's commit into the worktree branch, per project convention.
```
