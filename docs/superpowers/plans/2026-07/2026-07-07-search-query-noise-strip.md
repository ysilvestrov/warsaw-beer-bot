# Safe Search-Query Noise Stripping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Untappd/Algolia enrich queries from over-constraining to zero hits by stripping bracketed adjunct lists, collab parentheticals, and ABV/spec strings out of the search query (#236).

**Architecture:** Single-function change. Add a pure `stripSearchNoise(raw)` helper in `src/domain/normalize.ts` and apply it to the combined `brewery + name` string inside `cleanSearchQuery`, before the existing tokenize/dedup loop. Algolia ANDs every term, so these groups (which never carry the core beer name) are dropped wholesale; the raw name with adjuncts is still used separately by the downstream fuzzy matcher for disambiguation. No other module changes.

**Tech Stack:** TypeScript, Vitest.

**Reference spec:** `docs/superpowers/specs/2026-07-07-search-query-noise-strip-design.md`

---

## File Structure

- **Modify:** `src/domain/normalize.ts` — add `stripSearchNoise`; wire it into `cleanSearchQuery`.
- **Modify (test):** `src/domain/normalize.test.ts` — new `cleanSearchQuery` cases + a `stripSearchNoise` describe block.
- **Modify (docs):** `spec.md` — extend §734 (cleanSearchQuery) with the noise-stripping behavior.
- **Operator-only, post-merge (NOT the implementer's job):** prod DB reclassify + re-arm, issue #236 edit. See Task 3.

---

## Task 1: `stripSearchNoise` + integrate into `cleanSearchQuery`

**Files:**
- Modify: `src/domain/normalize.ts` (the `cleanSearchQuery` function, currently the last export ~lines 115-135)
- Test: `src/domain/normalize.test.ts` (the `describe('cleanSearchQuery', …)` block, ~lines 149-175)

- [ ] **Step 1: Write the failing tests**

Add these to `src/domain/normalize.test.ts`. Put the four new `cleanSearchQuery` cases inside the existing `describe('cleanSearchQuery', …)` block, and add a new sibling `describe('stripSearchNoise', …)` block. `stripSearchNoise` must be added to the import on line 1.

```ts
// line 1 import — add stripSearchNoise:
// import { normalizeName, normalizeBrewery, stripBreweryNoise, stripLegalForm, cleanSearchQuery, stripSearchNoise } from './normalize';

// inside describe('cleanSearchQuery', …):
  test('strips a bracketed adjunct list from the query (#236 Magic Road 30888)', () => {
    expect(
      cleanSearchQuery('Magic Road Brewery', 'Wonders [passionfruit,banana, coconut cream]'),
    ).toBe('Magic Road Wonders');
  });
  test('drops a collab parenthetical (#236 Funky Fluid 31266/31267)', () => {
    expect(
      cleanSearchQuery('Funky Fluid', 'Dynaboost: Mosaic (collab Yakima Chief)'),
    ).toBe('Funky Fluid Dynaboost: Mosaic');
  });
  test('strips ABV/spec strings (#236 Piwne Podziemie 12082)', () => {
    expect(
      cleanSearchQuery('Piwne Podziemie Brewery', 'NoLo – Hemperor <0,5% alc <0,5%'),
    ).toBe('Piwne Podziemie NoLo Hemperor');
  });
  test('cleans a dangling/unbalanced paren without leaking the bracket char', () => {
    const q = cleanSearchQuery('Funky Fluid', 'Mosaic (collab Yakima Chief');
    expect(q).toBe('Funky Fluid Mosaic Yakima Chief');
    expect(q).not.toContain('(');
  });
  test('all-noise input never yields an empty query (fallback)', () => {
    expect(cleanSearchQuery('Brewing Co', '[only adjuncts]')).toBe('Brewing Co');
  });
```

```ts
// new sibling describe block:
describe('stripSearchNoise', () => {
  test('removes balanced [..] and (..) groups', () => {
    expect(stripSearchNoise('Wonders [a, b] (collab X)')).toBe('Wonders');
  });
  test('removes stray/unbalanced brackets', () => {
    expect(stripSearchNoise('Mosaic (collab X')).toBe('Mosaic collab X');
  });
  test('removes ABV/spec strings and labels', () => {
    expect(stripSearchNoise('Hemperor <0,5% alc 4.5% abv 24°')).toBe('Hemperor');
  });
  test('leaves an ordinary name untouched', () => {
    expect(stripSearchNoise('Dynaboost: Mosaic')).toBe('Dynaboost: Mosaic');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: FAIL — `stripSearchNoise` is not exported (import error / `stripSearchNoise is not a function`), and the new `cleanSearchQuery` cases fail on the un-stripped output.

- [ ] **Step 3: Implement `stripSearchNoise` and wire it into `cleanSearchQuery`**

In `src/domain/normalize.ts`, add the helper immediately above `cleanSearchQuery`:

```ts
// Strip structural search noise from a raw brewery/name string before it becomes an
// Untappd (Algolia) query. Algolia ANDs every term, so bracketed adjunct lists, collab
// parentheticals, and ABV/spec strings over-constrain the search to zero hits (#236).
// These groups never carry the core beer name, so they are dropped wholesale — the raw
// name (with adjuncts) is still used separately for downstream fuzzy disambiguation.
export function stripSearchNoise(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, ' ')                     // [adjunct, lists]
    .replace(/\([^)]*\)/g, ' ')                      // (collab …), (batch/2023)
    .replace(/[[\](){}]/g, ' ')                      // stray/unbalanced brackets
    .replace(/[<>]?\s*\d+(?:[.,]\d+)?\s*%/g, ' ')    // <0,5%  4.5%  0,5 %
    .replace(/\d+(?:[.,]\d+)?\s*°/g, ' ')            // 24°
    .replace(/\b(?:alc|abv|ibu)\b/gi, ' ')           // spec labels
    .replace(/\s+/g, ' ')
    .trim();
}
```

Then change `cleanSearchQuery` to strip noise from each side before combining, and fall back to the *cleaned* strings (never the raw name) so brackets/spec are never re-injected:

```ts
export function cleanSearchQuery(brewery: string, name: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const cleanBrewery = stripSearchNoise(stripLegalForm(brewery));
  const cleanName = stripSearchNoise(name);
  // Collapse COLLAB_SEP ("/", " x ", " & ") first so a bare collab connector ("x")
  // never leaks into the query (as stripBreweryNoise did before tokenizing).
  const combined = `${cleanBrewery} ${cleanName}`.split(COLLAB_SEP).join(' ');
  for (const tok of combined.split(/\s+/)) {
    const f = foldToken(tok);
    if (!f || BREWERY_NOISE.has(f) || seen.has(f)) continue;
    seen.add(f);
    out.push(tok);
  }
  return out.length ? out.join(' ') : (cleanName || cleanBrewery || name.trim());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: PASS — all new cases plus the 7 pre-existing `cleanSearchQuery` cases green.

- [ ] **Step 5: Run the full domain suite for regressions**

Run: `npx vitest run src/domain/`
Expected: PASS — no regressions in matcher / untappd-lookup / normalize.

- [ ] **Step 6: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): strip bracketed adjuncts, collab parens, ABV/spec from enrich query (#236)"
```

---

## Task 2: Update spec.md

**Files:**
- Modify: `spec.md` (the "Дедуп пошукового запиту (#126)" paragraph, ~§734)

- [ ] **Step 1: Extend the cleanSearchQuery spec paragraph**

Find the paragraph beginning `**Дедуп пошукового запиту (#126).**` (~line 734). Append the following sentence to the end of that paragraph (before the next `####` heading):

```markdown
Крім дедупу, `cleanSearchQuery` спершу пропускає об'єднаний рядок через `stripSearchNoise`
(#236): викидає збалансовані групи `[...]`/`(...)` (adjunct-списки, `(collab …)`, batch/vintage),
поодинокі «звисаючі» дужки, та ABV/spec-рядки (`<0,5%`, `4.5%`, `24°`, мітки `alc/abv/ibu`).
Причина — серверний пошук іде в Algolia, який AND-ить усі терміни: будь-який шумовий термін,
відсутній у записі пива, обнуляє видачу. Описовий хвіст ВИКИДАЄТЬСЯ (не чиститься від пунктуації),
бо його терміни текстово не збігаються з каталогом; розрізнення варіантів лишається за
downstream-fuzzy (який окремо використовує сиру назву з ад'юнктами). Якщо очистка спорожнила
запит — фолбек на очищену назву/броварню, ніколи не на сиру (щоб не реін'єктити дужки).
```

- [ ] **Step 2: Sanity-check the change**

Run: `git diff spec.md`
Expected: one paragraph appended under §734; no other hunks.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document stripSearchNoise in cleanSearchQuery (#236)"
```

---

## After implementation (PR flow — done in the main session, not by a task subagent)

1. Push the branch, open a PR referencing #236.
2. Wait for the AI PR review; read it critically, verify each comment, fix valid ones, push back on wrong ones. Do not merge on green tests alone.
3. Merge once review is addressed.

---

## Task 3: Operational tail (OPERATOR-ONLY, POST-MERGE — requires prod sudo; do NOT run inside an implementer subagent or the sandbox)

> All prod DB writes go through `sudo -u warsaw-beer-bot sqlite3 /var/lib/warsaw-beer-bot/bot.db …`
> and require a sandbox-disabled shell. Stage each command in `./tmp/` per CLAUDE.md before running.
> Prod DB path from `.env`: `DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db`.

- [ ] **Step 1: Reclassify 30875 as not_on_untappd (before deploy is fine; independent of code)**

Stage `./tmp/reclassify-30875.sh`:

```bash
#!/bin/bash
set -euo pipefail
DB=/var/lib/warsaw-beer-bot/bot.db
sudo -u warsaw-beer-bot sqlite3 "$DB" \
  "UPDATE enrich_failures
      SET review_class='not_on_untappd',
          review_note='No \"Red Sour\" from Nowy Browar Gdański on Untappd; brewery found fine (29 hits). Not a query bug (#236).',
          reviewed_at=datetime('now')
    WHERE beer_id=30875;"
sudo -u warsaw-beer-bot sqlite3 "$DB" \
  "SELECT beer_id, review_class, review_note FROM enrich_failures WHERE beer_id=30875;"
```

Run it; expected output shows `30875|not_on_untappd|…`.

- [ ] **Step 2: Deploy the merged fix**

Run: `./deploy/deploy.sh` (needs sudo / sandbox disabled). Confirm the service restarts cleanly:
`journalctl -u warsaw-beer-bot -n 30 --no-pager` — no crash, build succeeded.

- [ ] **Step 3: Re-arm the four affected orphans (reset backoff so enrich retries them)**

`rearm-aliased-orphans` targets *curated-alias* orphans only, which these are not — so re-arm by explicit id. Stage `./tmp/rearm-236.sh`:

```bash
#!/bin/bash
set -euo pipefail
DB=/var/lib/warsaw-beer-bot/bot.db
sudo -u warsaw-beer-bot sqlite3 "$DB" \
  "UPDATE beers
      SET untappd_lookup_count = 0, untappd_lookup_at = NULL
    WHERE id IN (30888, 31266, 31267, 12082) AND untappd_id IS NULL;"
sudo -u warsaw-beer-bot sqlite3 "$DB" \
  "SELECT id, untappd_lookup_count, untappd_lookup_at FROM beers WHERE id IN (30888,31266,31267,12082);"
```

Run it; expected: each row shows `count=0`, `at=` (NULL).

- [ ] **Step 4: Verify the fix landed (after the next enrich cron cycle, or trigger enrich)**

Read-only (no sudo needed — DB is world-readable):

```bash
sqlite3 /var/lib/warsaw-beer-bot/bot.db \
  "SELECT beer_id, name, outcome, candidates_count FROM enrich_failures WHERE beer_id IN (30888,31266,31267,12082);"
```

Expected: 30888/31266/31267/12082 either gone from `enrich_failures` (matched → self-cleared) or now showing `candidates_count > 0`. If any still shows 0 with the new lean query, capture its row for a follow-up. (30875 stays, correctly labelled `not_on_untappd`.)

- [ ] **Step 5: Correct issue #236**

Post a comment and edit the body to:
- Remove the «browar»/"stripped meaningful token" framing (verified false: `NOWY GDAŃSKI` returns 29 hits).
- Drop 30875 from the examples, noting it was reclassified `not_on_untappd` (no such beer on Untappd).
- Record that the PR fixes 30888 / 31266 / 31267 / 12082 (bracket + collab-paren + ABV/spec).
- Note the deferred follow-up: **31170** — bare comma / `#N` adjunct tail without brackets is out of scope (risk of truncating legitimate names); left tracked here.

Keep #236 open until Step 4 confirms the four beers clear; close it (or leave open for the 31170 deferral) per the outcome.

---

## Self-review notes

- **Spec coverage:** design §"Change" → Task 1; §"Testing" → Task 1 Step 1; §"Operational tail" items 1–4 → Task 3; spec.md doc requirement → Task 2. All covered.
- **Out-of-scope items** (31170 deferred, 30875 reclassify) are handled in Task 3 Steps 1 & 5, not in code.
- **No prod ops inside subagents/sandbox** — Task 3 is explicitly operator-only.
