# Make All Extension Badges Clickable (#167) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `✅` (had) and `⚪` (orphan) badges — and the no-bid `❓` — clickable: `✅`/`❓`/`⭐` open the matched beer's Untappd page (or an Untappd search if it has no bid yet), `⚪` opens an Untappd search prefilled with the shop's brewery+name.

**Architecture:** Extension-only. Generalize `makeBadge(text, untappdId)` → `makeBadge(text, href)`; add an `untappdSearchUrl(brewery, name)` helper; set each branch's click href in `badgeFor`; thread brewery/name through the enrichment-path `setOrphan`. No server / `MatchResult` change — the search URL is built from `result.raw.{brewery,name}`, already present.

**Tech Stack:** TypeScript MV3 extension (vanilla TS), vitest (`npm test` = `vitest run` from `extension/`), `npm run typecheck` = `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-17-all-badges-clickable-design.md`

---

## File Structure

All commands run from the `extension/` directory unless noted.

- Modify `extension/src/content/badge.ts` — `makeBadge` href refactor, `untappdUrl`/`untappdSearchUrl` helpers, `badgeFor` click targets, `setOrphan`/`setEnriched`/`setSearching` updated to the href API.
- Modify `extension/src/content/badge.test.ts` — click-target tests for `✅`/`⚪`/`❓`/`⭐`.
- Modify `extension/src/content/enrich.ts` — `Deps.setOrphan` signature gains `brewery,name`; both call sites pass `cand.brewery, cand.name`.
- Modify `extension/src/content/enrich.test.ts` — update the `setOrphan` call assertion.
- Modify `extension/src/content/main.ts` — `setOrphan` wiring passes brewery/name through.
- Modify `spec.md` + `docs/extension-install-uk.md` — badge legend (all clickable) + fix a stale "orphans → no badge" line.

> **Coupling note:** the `setOrphan` signature change spans `badge.ts` + `enrich.ts` + `main.ts`; the extension only typechecks once all three are updated. So Task 1 does the whole extension code change in one green commit.

---

## Task 1: Extension — clickable badges (code + tests)

**Files:**
- Modify: `extension/src/content/badge.ts`
- Modify: `extension/src/content/enrich.ts`
- Modify: `extension/src/content/main.ts`
- Test: `extension/src/content/badge.test.ts`, `extension/src/content/enrich.test.ts`

Context: `makeBadge(text, untappdId)` builds the badge and adds a click→`window.open(untappdUrl(id))` handler only when `untappdId` is non-null; `✅`/`⚪`/`⏳` currently pass `null` (inert). `badgeFor` precedence is `is_drunk`(✅) → `drunk_uncertain`(❓) → bid+global(⭐) → orphan(⚪) → null. The enrichment flow renders `⚪` via `setOrphan` (`enrich.ts` `else`/`catch` branches → `main.ts` key→el → `badge.ts setOrphan`).

- [ ] **Step 1: Read the test harness**

Run: `sed -n '1,100p' extension/src/content/badge.test.ts` and `sed -n '1,70p' extension/src/content/enrich.test.ts`.
Note: badge tests build `MatchResult` fixtures and assert clicks via
`const open = vi.spyOn(window, 'open').mockReturnValue(null)` then
`badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))` and
`expect(open).toHaveBeenCalledWith('<url>', '_blank', 'noopener')`. The enrich test fixture
defines orphan(s) keyed `k0`; find that orphan's `brewery`/`name` (for the updated assertion)
and the existing `expect(d.setOrphan).toHaveBeenCalledWith('k0')`.

- [ ] **Step 2: Write failing tests in `badge.test.ts`**

Add a `describe('badge click targets (#167)')` block (reuse the `el()` helper and the
`window.open` spy pattern). Use these fixtures/assertions (the existing `notDrunkRated` uses
`untappd_id: 222`; reuse the file's fixtures where they fit):

```ts
describe('badge click targets (#167)', () => {
  const openSpy = () => vi.spyOn(window, 'open').mockReturnValue(null);
  const clickBadge = (host: HTMLElement) => {
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return badge;
  };

  it('✅ with a bid opens the matched beer page', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'PINTA', name: 'Hazy Morning' },
      matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
      is_drunk: true, drunk_uncertain: false, user_rating: 4.0,
    });
    const badge = clickBadge(host);
    expect(badge.style.cursor).toBe('pointer');
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/111', '_blank', 'noopener');
  });

  it('✅ on a had orphan (no bid) opens an Untappd search', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'Mad Brew', name: 'Bendera ya Uhuru' },
      matched_beer: { id: 2, name: 'Bendera ya Uhuru', brewery: 'Mad Brew', rating_global: null, untappd_id: null },
      is_drunk: true, drunk_uncertain: false, user_rating: null,
    });
    clickBadge(host);
    expect(open).toHaveBeenCalledWith('https://untappd.com/search?q=Mad%20Brew%20Bendera%20ya%20Uhuru&type=beer', '_blank', 'noopener');
  });

  it('⚪ orphan opens an Untappd search prefilled with brewery+name', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'PINTA', name: 'Orphan' },
      matched_beer: { id: 3, name: 'Orphan', brewery: 'PINTA', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null,
    });
    const badge = clickBadge(host);
    expect(badge.style.cursor).toBe('pointer');
    expect(open).toHaveBeenCalledWith('https://untappd.com/search?q=PINTA%20Orphan&type=beer', '_blank', 'noopener');
  });

  it('❓ orphan (drunk_uncertain, no bid) opens an Untappd search', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'Rebrew', name: 'Fuzzy Orphan' },
      matched_beer: { id: 4, name: 'Fuzzy Orphan', brewery: 'Rebrew', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: true, user_rating: null,
    });
    clickBadge(host);
    expect(open).toHaveBeenCalledWith('https://untappd.com/search?q=Rebrew%20Fuzzy%20Orphan&type=beer', '_blank', 'noopener');
  });

  it('⭐ still opens the matched beer page', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'PINTA', name: 'New One' },
      matched_beer: { id: 5, name: 'New One', brewery: 'PINTA', rating_global: 3.9, untappd_id: 222 },
      is_drunk: false, drunk_uncertain: false, user_rating: null,
    });
    clickBadge(host);
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
  });
});
```

> `encodeURIComponent('Mad Brew Bendera ya Uhuru')` → `Mad%20Brew%20Bendera%20ya%20Uhuru`; `'PINTA Orphan'` → `PINTA%20Orphan`. If the file's `notDrunkOrphan`/`drunk` fixtures already match a case, reusing them is fine — just keep the asserted URL consistent with the fixture's `raw`.

- [ ] **Step 3: Run badge tests, confirm FAIL**

Run: `npm test -- src/content/badge.test.ts`
Expected: the new `✅`/`⚪`/`❓`-orphan cases fail (those badges are currently inert → `window.open` not called; `cursor` is `'default'`). `⭐` already passes.

- [ ] **Step 4: Refactor `makeBadge` + add the search-URL helper (`badge.ts`)**

Replace the `untappdUrl`/`makeBadge` region with:

```ts
const untappdUrl = (untappdId: number): string => `https://untappd.com/beer/${untappdId}`;

const untappdSearchUrl = (brewery: string, name: string): string =>
  `https://untappd.com/search?q=${encodeURIComponent(`${brewery} ${name}`.trim())}&type=beer`;

// Builds the styled badge element. Clickable (opens `href` in a new tab) when href is set.
function makeBadge(text: string, href: string | null): HTMLElement {
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
    pointerEvents: href != null ? 'auto' : 'none',
    cursor: href != null ? 'pointer' : 'default',
  } as Partial<CSSStyleDeclaration>);
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

- [ ] **Step 5: Set click targets in `badgeFor` (`badge.ts`)**

Replace `badgeFor` with (precedence unchanged):

```ts
// Guard order: drunk → ✅ (+ personal rating); truly unmatched (matched_beer null) → no
// badge; fuzzy-match-but-drunk → ❓ (+ global if present); not-drunk bid+global → ⭐;
// not-drunk matched orphan (no bid) → ⚪. All rendered badges are clickable: a bid → the
// Untappd beer page; no bid → an Untappd search prefilled with the tried brewery+name.
function badgeFor(result: MatchResult): HTMLElement | null {
  const { brewery, name } = result.raw;
  if (result.is_drunk) {
    const m = result.matched_beer;
    const href = m && m.untappd_id != null ? untappdUrl(m.untappd_id) : untappdSearchUrl(brewery, name);
    return makeBadge(result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅', href);
  }
  const m = result.matched_beer;
  if (!m) return null;
  if (result.drunk_uncertain) {
    const href = m.untappd_id != null ? untappdUrl(m.untappd_id) : untappdSearchUrl(brewery, name);
    return makeBadge(m.rating_global != null ? `❓ ${m.rating_global.toFixed(1)}` : '❓', href);
  }
  if (m.untappd_id != null && m.rating_global != null) {
    return makeBadge(`⭐ ${m.rating_global.toFixed(1)}`, untappdUrl(m.untappd_id));
  }
  if (m.untappd_id == null) return makeBadge('⚪', untappdSearchUrl(brewery, name));
  return null;
}
```

- [ ] **Step 6: Update `setOrphan`/`setEnriched`/`setSearching` to the href API (`badge.ts`)**

```ts
/** Show the ⚪ orphan badge (used by enrichment); clickable to an Untappd search. */
export function setOrphan(host: HTMLElement, brewery: string, name: string): void {
  attach(host, makeBadge('⚪', untappdSearchUrl(brewery, name)));
}

/** Replace the badge with a loading glyph while an Untappd search is in flight. */
export function setSearching(host: HTMLElement): void {
  attach(host, makeBadge('⏳', null));
}

/** Swap the badge to ⭐ + global rating once the beer is enriched. */
export function setEnriched(host: HTMLElement, untappdId: number, ratingGlobal: number | null): void {
  attach(host, makeBadge(ratingGlobal != null ? `⭐ ${ratingGlobal.toFixed(1)}` : '⭐', untappdUrl(untappdId)));
}
```

- [ ] **Step 7: Thread brewery/name through the enrichment callers**

In `extension/src/content/enrich.ts`:
- `Deps.setOrphan` becomes `setOrphan: (key: string, brewery: string, name: string) => void;`
- both call sites become `deps.setOrphan(beer.key, cand.brewery, cand.name);` (the `else` branch and the `catch` block — `cand` is the loop's candidate).

In `extension/src/content/main.ts`, update the wiring:
```ts
setOrphan: (key, brewery, name) => { const el = elByKey.get(key); if (el) setOrphan(el, brewery, name); },
```

- [ ] **Step 8: Update the enrich test assertion (`enrich.test.ts`)**

Change `expect(d.setOrphan).toHaveBeenCalledWith('k0')` to include the orphan's brewery+name
(the values you found in Step 1), e.g. `toHaveBeenCalledWith('k0', '<brewery>', '<name>')`.

- [ ] **Step 9: Run tests + typecheck, confirm GREEN**

Run: `npm test` then `npm run typecheck`.
Expected: all extension tests pass; `tsc --noEmit` exit 0. (If other call sites of `setOrphan`/`makeBadge` are flagged, update them to the new signatures.)

- [ ] **Step 10: Commit**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts \
        extension/src/content/enrich.ts extension/src/content/enrich.test.ts \
        extension/src/content/main.ts
git commit -m "feat(extension): make all badges clickable — ✅/❓/⭐ → beer page, ⚪/no-bid → Untappd search (#167)"
```
End the commit body with:
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

---

## Task 2: Docs — badge legend (spec.md + install guide)

**Files:**
- Modify: `spec.md`
- Modify: `docs/extension-install-uk.md`

- [ ] **Step 1: Update `spec.md` §6.1 «Бейджі» bullet**

Run: `grep -n "клікабельний\|untappd_id>\`) у новій вкладці\|без бейджа" spec.md` to locate the
bullet (~lines 975-978). Replace the sentence
*"Будь-який бейдж із `untappd_id` клікабельний: відкриває сторінку беври на Untappd
(`https://untappd.com/beer/<untappd_id>`) у новій вкладці. Орфани (без `untappd_id`/рейтингу)
і незматчені — без бейджа."* with (matching the surrounding Ukrainian style):

> Усі бейджі клікабельні: `✅`/`❓`/`⭐` ведуть на сторінку беври в Untappd
> (`https://untappd.com/beer/<untappd_id>`), а якщо `untappd_id` ще немає — на пошук Untappd
> із підставленою назвою (`brewery name`). Зматчені орфани (без `untappd_id`) показуються як
> `⚪` і ведуть на той самий пошук. Незматчені (`matched_beer` null) — без бейджа.

(This also corrects the stale claim that orphans get no badge — matched orphans render `⚪`.)

- [ ] **Step 2: Update `docs/extension-install-uk.md` badge legend**

Run: `grep -nE "✅|⚪|⭐|❓|клік|Untappd" docs/extension-install-uk.md` to find the legend rows.
- `✅` row: append that clicking opens the beer's Untappd page (or a search if it has no
  Untappd id yet) — для перевірки, що бот не помилився з beer.
- `⚪` row: state it's now clickable — opens an Untappd search prefilled with the tried name.
- Ensure the `❓` row (added in #170) notes the orphan case also clicks to search.
Match the file's existing row format/language.

- [ ] **Step 3: Commit**

```bash
git add spec.md docs/extension-install-uk.md
git commit -m "docs: all badges clickable — update spec + extension install legend (#167)"
```
End the commit body with:
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

---

## Task 3: Full verification

**Files:** none.

- [ ] **Step 1: Extension suite + typecheck**

Run (from `extension/`): `npm test && npm run typecheck`
Expected: all tests pass; typecheck exit 0.

- [ ] **Step 2: Root build sanity (no server change, but confirm nothing broke)**

Run (from repo root): `npm run build`
Expected: exit 0.

- [ ] **Step 3: Confirm every badge path has a click href**

Re-read `badgeFor`, `setOrphan`, `setEnriched` in `badge.ts`: every `makeBadge(...)` call
except `setSearching` (⏳) passes a non-null href. `setSearching` stays inert by design.

- [ ] **Step 4: Grep for stale "orphan → no badge" / inert assumptions**

Run (from repo root): `git grep -niE "без бейджа|клікабельний" -- spec.md docs/extension-install-uk.md`
Expected: the spec wording now reflects "all clickable" and only `matched_beer` null → no badge.

---

## Self-Review (completed by plan author)

- **Spec coverage:** `makeBadge` href refactor + `untappdSearchUrl` (Task 1 Step 4); `badgeFor`
  click targets for ✅/❓/⭐/⚪ incl. orphan search fallback (Step 5); `setOrphan` threading +
  `setEnriched`/`setSearching` (Steps 6-7); enrich/main wiring + test (Steps 7-8); docs incl.
  the stale-orphan-line fix (Task 2); verification (Task 3). ✅
- **Placeholder scan:** no TBD/TODO; all code shown in full; test bodies concrete; the only
  lookups are the enrich fixture's brewery/name (Step 1/8) — bounded and explicit. ✅
- **Type consistency:** `makeBadge(text: string, href: string | null)`; `untappdUrl(id)` and
  `untappdSearchUrl(brewery, name)` both return `string`; `setOrphan(host, brewery, name)`
  identical across `badge.ts` decl, `enrich.ts` Deps, and `main.ts` wiring; URLs asserted in
  tests match the helper output (`encodeURIComponent`, `&type=beer`). ✅
