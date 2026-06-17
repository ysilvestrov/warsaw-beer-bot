# Design: make all extension badges clickable (#167)

**Date:** 2026-06-17
**Status:** approved (brainstorm)
**Issue:** #167
**Related:** #170 (the `❓` uncertain-drunk badge — its orphan sub-case was left non-clickable "until #167")

## Problem

The extension overlays per-beer badges on craft-shop grids. Today only the `⭐` (rated,
not had) and `❓`-with-bid badges are clickable (they open the Untappd beer page). The
`✅` (had) and `⚪` (orphan) badges, and the orphan `❓`, are inert — `makeBadge` is passed
`null` for those, so `pointerEvents: 'none'`.

Per #167:
- `✅` (had) should be clickable so the user can confirm the beer wasn't **mis-identified**.
- `⚪` (orphan) should be clickable to an **Untappd search prefilled with the term we tried**
  ("even if some words need adding/deleting, it's easier to find when part is prefilled").

## Goal

Every badge that names or guesses a beer is clickable to a relevant Untappd page:
had/uncertain/rated → the matched beer's page (when a bid exists); orphan and the
no-bid fallbacks → an Untappd search prefilled with the shop's brewery+name.

## Non-goals

- No server or `MatchResult` shape change — the extension builds the search URL itself
  from `result.raw.{brewery,name}` (already present).
- No change to badge glyphs, colours, or the matching logic.
- Not reusing the server's `cleanSearchQuery` cleaning — a simple `brewery name` query is
  sufficient (the issue accepts an imperfect, prefilled query).

## Design

All changes are in `extension/`.

### 1. Generalize the click target — `extension/src/content/badge.ts`

Change `makeBadge` to take a click URL instead of an Untappd id:

```ts
const untappdUrl = (untappdId: number): string => `https://untappd.com/beer/${untappdId}`;

const untappdSearchUrl = (brewery: string, name: string): string =>
  `https://untappd.com/search?q=${encodeURIComponent(`${brewery} ${name}`.trim())}&type=beer`;

// Clickable (opens `href` in a new tab) when href is non-null.
function makeBadge(text: string, href: string | null): HTMLElement {
  // ...style unchanged...
  // pointerEvents/cursor keyed on (href != null) instead of (untappdId != null)
  if (href != null) {
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(href, '_blank', 'noopener');
    });
  }
  return badge;
}
```

`&type=beer` matches the server's existing convention (`src/sources/untappd/search.ts`).

### 2. `badgeFor` click targets — `extension/src/content/badge.ts`

`badgeFor(result)` has `result.raw.{brewery,name}` and `result.matched_beer`. A small local
helper keeps each branch readable:

```ts
const beerOrSearch = (m: MatchedBeer, raw: { brewery: string; name: string }): string =>
  m.untappd_id != null ? untappdUrl(m.untappd_id) : untappdSearchUrl(raw.brewery, raw.name);
```

Branch-by-branch (precedence unchanged: ✅ → ❓ → ⭐ → ⚪ → none):

| Badge | Condition | Text | Click href |
|---|---|---|---|
| `✅` | `is_drunk` | `✅` (+ personal rating) | `result.matched_beer` present → `beerOrSearch(matched_beer, raw)`; if `matched_beer` is null (defensive) → `untappdSearchUrl(raw...)` |
| `❓` | `drunk_uncertain` | `❓` (+ global if present) | `beerOrSearch(m, raw)` (bid → beer page; orphan → search) |
| `⭐` | bid + global rating | `⭐ {global}` | `untappdUrl(m.untappd_id)` (unchanged) |
| `⚪` | `m.untappd_id == null` | `⚪` | `untappdSearchUrl(raw.brewery, raw.name)` |

Notes:
- `is_drunk` requires an exact catalog match, so `matched_beer` is non-null in practice; the
  null-fallback to search is purely defensive.
- The `✅` branch currently runs before `const m = result.matched_beer`. It will reference
  `result.matched_beer` directly (it does not need the `!m` guard since it falls back to
  search). The `const m` / `if (!m) return null` guard stays for the ❓/⭐/⚪ branches.

### 3. Enrichment-path orphan — `setOrphan`

The enrichment flow also renders `⚪` via `setOrphan`, which must become clickable too.
Thread the term:

```ts
// badge.ts
export function setOrphan(host: HTMLElement, brewery: string, name: string): void {
  attach(host, makeBadge('⚪', untappdSearchUrl(brewery, name)));
}
```

Callers:
- `extension/src/content/enrich.ts`: the `setOrphan` dep becomes
  `(key: string, brewery: string, name: string) => void`; both call sites (the
  `else` branch and the `catch`) pass the loop's `cand.brewery, cand.name`
  (the candidate in scope; `beer.brewery/name` hold the same values).
- `extension/src/content/main.ts`: the wiring becomes
  `setOrphan: (key, brewery, name) => { const el = elByKey.get(key); if (el) setOrphan(el, brewery, name); }`.

`setSearching` (⏳) stays inert (`makeBadge('⏳', null)`). `setEnriched` passes
`untappdUrl(untappdId)` instead of the raw id.

### Data flow

```
shop card → /match → MatchResult{ raw:{brewery,name}, matched_beer, is_drunk, drunk_uncertain, ... }
  → renderBadge → badgeFor → makeBadge(text, href)         // ✅/❓/⭐/⚪ all get an href
enrichment → enrich() → setSearching(⏳) → setEnriched(⭐, beerUrl) | setOrphan(⚪, searchUrl)
```

### Backward compatibility

Extension-only and self-contained. Old cached `MatchResult`s already carry `raw`, so the
search fallback works for cache hits too. No server coordination needed.

## Testing

- `extension/src/content/badge.test.ts`:
  - `✅` + bid → badge opens `https://untappd.com/beer/<id>` (clickable).
  - `✅` with `matched_beer.untappd_id == null` → opens
    `https://untappd.com/search?q=<brewery%20name>&type=beer`.
  - `⚪` (orphan) → opens the search URL built from `raw.brewery`+`raw.name`.
  - `❓` orphan (drunk_uncertain, no bid) → opens the search URL (was inert before).
  - `⭐` and `❓`-with-bid → still open the beer page (regression guard).
  - Assert the URL via a `window.open` spy (mirror the existing `⭐` click test), and
    `cursor: 'pointer'` for the now-clickable cases.
- `extension/src/content/main.test.ts` / `enrich.test.ts` (whichever exercises `setOrphan`):
  update for the new `setOrphan(el, brewery, name)` signature and assert the resulting `⚪`
  badge is clickable to the search URL.

## Docs (mandatory per CLAUDE.md)

- `docs/extension-install-uk.md`: update the badge legend so `✅` and `⚪` (and the orphan
  `❓`) are described as clickable — `✅`/`❓`/`⭐` open the beer's Untappd page (or a search
  if it has no Untappd id yet), `⚪` opens an Untappd search prefilled with the tried name.
- `spec.md` (§6.1 «Бейджі» bullet, ~lines 975-978): the current text reads
  *"Будь-який бейдж із `untappd_id` клікабельний: відкриває сторінку беври на Untappd
  (`https://untappd.com/beer/<untappd_id>`) у новій вкладці. Орфани (без
  `untappd_id`/рейтингу) і незматчені — без бейджа."* Replace it with wording that (a) makes
  all badges clickable and (b) corrects the stale "orphans → no badge" claim (matched
  orphans DO render `⚪`). New text, roughly: *"Усі бейджі клікабельні: `✅`/`❓`/`⭐` ведуть
  на сторінку беври в Untappd (`https://untappd.com/beer/<untappd_id>`), а якщо `untappd_id`
  ще немає — на пошук Untappd із підставленою назвою (`brewery name`). Зматчені орфани (без
  `untappd_id`) показуються як `⚪` і ведуть на той самий пошук. Незматчені (`matched_beer`
  null) — без бейджа."* Match the surrounding Ukrainian style.

## Out of scope

- The Flasker adapter brewery mis-split (#169).
- Any server-side search-URL exposure on `/match` (we compose client-side).
