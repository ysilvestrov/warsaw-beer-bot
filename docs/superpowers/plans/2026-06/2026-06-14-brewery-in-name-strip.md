# Brewery-in-name stripping (#126 + #155) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the embedded brewery name from breaking enrich — both the Untappd search *query* (#126, deduped via a new `cleanSearchQuery`) and the name *match* (#155, via generalizing `stripLeadingBrewery` → `stripBreweryFromName`, which removes the brewery token-run anywhere in the name; applied globally in `nameKeys`/`fuzzyTargets` so `/match` benefits too).

**Architecture:** Two small functions sharing `BREWERY_NOISE` and a token-fold. `stripBreweryFromName` (matcher.ts) removes the exact brewery token-run anywhere in a normalized name + trims leftover edge `BREWERY_NOISE`, keeping ≥1 token; it replaces `stripLeadingBrewery` at its two call sites. `cleanSearchQuery` (normalize.ts) folds + denoises + dedups the combined `brewery + name` query string at the two query-build sites.

**Tech Stack:** TypeScript, Node, Jest (ts-jest, isolatedModules), fast-fuzzy, better-sqlite3 (bench only).

**Spec:** `docs/superpowers/specs/2026-06-14-brewery-in-name-strip-design.md`

**Verified values (real Untappd pages, 2026-06-14):** Trzech Kumpli → bid 6568809; Track clean query → bid 6645521; baseline `/match` bench = **166/166**. Chyliczki + Hoppy Hog are deferred partial-prefix cases.

---

## File structure

- **Modify** `src/domain/normalize.ts` — `export` the existing `BREWERY_NOISE` set; add `cleanSearchQuery(brewery, name)` + a private `foldToken`.
- **Modify** `src/domain/matcher.ts` — rename `stripLeadingBrewery` → `stripBreweryFromName` and generalize it (import `BREWERY_NOISE`); update its use in `nameKeys`.
- **Modify** `src/domain/untappd-lookup.ts` — update the `stripLeadingBrewery` import + its use in `fuzzyTargets`; swap the search-URL builder to `cleanSearchQuery`.
- **Modify** `src/api/routes/enrich.ts` — swap the preview `searchUrl` to `cleanSearchQuery`.
- **Modify** `src/domain/matcher.test.ts`, `src/domain/normalize.test.ts`, `src/domain/untappd-lookup.fixtures.test.ts` — tests.
- **Fixtures** `tests/fixtures/untappd-search/trzech.html`, `track-clean.html` — already committed with the spec (cherry-pick that commit into the worktree).
- **Modify** `spec.md` — §3.1 name-keys + enrich query note.

---

## Task 1: `stripBreweryFromName` (#155, global)

**Files:**
- Modify: `src/domain/normalize.ts` (export `BREWERY_NOISE`)
- Modify: `src/domain/matcher.ts` (rename + generalize `stripLeadingBrewery`; update `nameKeys`)
- Modify: `src/domain/untappd-lookup.ts` (import rename + `fuzzyTargets` use)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/matcher.test.ts`, add `stripBreweryFromName` to the existing import from `'./matcher'`, then add:

```ts
describe('stripBreweryFromName', () => {
  test('strips a leading run', () => {
    expect(stripBreweryFromName('primator weizen', 'primator')).toBe('weizen');
  });
  test('strips a trailing run (#155 Trzech Kumpli)', () => {
    expect(stripBreweryFromName('baltycki zytnio orkiszowy trzech kumpli', 'trzech kumpli')).toBe(
      'baltycki zytnio orkiszowy',
    );
  });
  test('strips a mid run', () => {
    expect(stripBreweryFromName('cydr chyliczki stary sad', 'chyliczki')).toBe('cydr stary sad');
  });
  test('trims a stranded trailing brewery-noise token after the run', () => {
    expect(stripBreweryFromName('porter trzech kumpli brewery', 'trzech kumpli')).toBe('porter');
  });
  test('never strips the name to empty (name == brewery)', () => {
    expect(stripBreweryFromName('trzech kumpli', 'trzech kumpli')).toBe('trzech kumpli');
  });
  test('passthrough when brewery is empty (keeps #138B brand path intact)', () => {
    expect(stripBreweryFromName('murphy s irish stout', '')).toBe('murphy s irish stout');
  });
  test('deferred partial case stays partial (Chyliczki keeps non-noise cydr)', () => {
    // brewery field is just "chyliczki" but the name carries the fuller "cydr chyliczki";
    // documented as deferred — cydr is not BREWERY_NOISE so it survives.
    expect(stripBreweryFromName('cydr chyliczki stary sad', 'chyliczki')).toContain('cydr');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/domain/matcher --no-cache -t stripBreweryFromName`
Expected: FAIL — `stripBreweryFromName is not a function`.

- [ ] **Step 3: Export `BREWERY_NOISE`**

In `src/domain/normalize.ts`, change the declaration `const BREWERY_NOISE = new Set([` to `export const BREWERY_NOISE = new Set([` (line ~7). Nothing else in that file changes in this task.

- [ ] **Step 4: Replace `stripLeadingBrewery` with `stripBreweryFromName`**

In `src/domain/matcher.ts`: add `BREWERY_NOISE` to the existing import from `'./normalize'`. Then replace the whole `stripLeadingBrewery` function:

```ts
// Strip leading brewery tokens duplicated into a normalized name (e.g. the product
// title "PRIMÁTOR Free Mother In Law" with brewery "Primátor"). Token-prefix only.
export function stripLeadingBrewery(nameNorm: string, breweryNorm: string): string {
  if (!breweryNorm) return nameNorm;
  const nt = nameNorm.split(' ').filter(Boolean);
  const bt = breweryNorm.split(' ').filter(Boolean);
  if (bt.length && bt.length < nt.length && bt.every((t, i) => nt[i] === t)) {
    return nt.slice(bt.length).join(' ');
  }
  return nameNorm;
}
```

with:

```ts
// Strip a brewery duplicated into a normalized name (e.g. title "PRIMÁTOR Free Mother
// In Law" with brewery "Primátor", or a trailing "… Trzech Kumpli"). Removes every
// non-overlapping contiguous run of the brewery tokens — at ANY position — but never
// strips the name to empty, then trims any leftover leading/trailing BREWERY_NOISE.
export function stripBreweryFromName(nameNorm: string, breweryNorm: string): string {
  if (!breweryNorm) return nameNorm;
  const bt = breweryNorm.split(' ').filter(Boolean);
  if (!bt.length) return nameNorm;
  const nt = nameNorm.split(' ').filter(Boolean);
  for (let i = 0; i + bt.length <= nt.length; ) {
    if (nt.length - bt.length >= 1 && bt.every((t, j) => nt[i + j] === t)) {
      nt.splice(i, bt.length);
    } else {
      i++;
    }
  }
  while (nt.length > 1 && BREWERY_NOISE.has(nt[0])) nt.shift();
  while (nt.length > 1 && BREWERY_NOISE.has(nt[nt.length - 1])) nt.pop();
  return nt.join(' ');
}
```

- [ ] **Step 5: Update the `nameKeys` call site**

In `src/domain/matcher.ts`, in `nameKeys`, change the line that calls `stripLeadingBrewery` (it reads `const toks = stripLeadingBrewery(normalizeName(side), bNorm).split(' ').filter(Boolean);`) to use `stripBreweryFromName`:

```ts
    const toks = stripBreweryFromName(normalizeName(side), bNorm).split(' ').filter(Boolean);
```

- [ ] **Step 6: Update the `untappd-lookup.ts` import + `fuzzyTargets`**

In `src/domain/untappd-lookup.ts` line 2, change `stripLeadingBrewery` to `stripBreweryFromName` in the import from `'./matcher'`. Then in `fuzzyTargets`, change the line `const value = stripLeadingBrewery(normalizeName(raw), breweryNorm);` to:

```ts
    const value = stripBreweryFromName(normalizeName(raw), breweryNorm);
```

- [ ] **Step 7: Run tests**

Run: `npx jest src/domain/matcher src/domain/untappd-lookup --no-cache`
Expected: PASS — the new `stripBreweryFromName` block plus all existing matcher/lookup tests (the rename is behavior-preserving for the leading case; trailing/mid is new capability). Then `npx tsc --noEmit` — clean (confirms no stale `stripLeadingBrewery` references remain).

- [ ] **Step 8: Commit**

```bash
git add src/domain/normalize.ts src/domain/matcher.ts src/domain/untappd-lookup.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): stripBreweryFromName removes embedded brewery anywhere in the name (#155)"
```

---

## Task 2: `cleanSearchQuery` (#126)

**Files:**
- Modify: `src/domain/normalize.ts` (add `cleanSearchQuery` + `foldToken`)
- Modify: `src/domain/untappd-lookup.ts` (search-URL builder)
- Modify: `src/api/routes/enrich.ts` (preview `searchUrl`)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/normalize.test.ts`, add `cleanSearchQuery` to the import from `'./normalize'`, then add:

```ts
describe('cleanSearchQuery', () => {
  test('dedups brewery repeated in the name and drops noise incl. "Co." (#126 Track)', () => {
    expect(cleanSearchQuery('TRACK BREWING CO.', 'Track Brewing Company Taking Shape')).toBe(
      'TRACK Taking Shape',
    );
  });
  test('dedups a trailing brewery duplication (#155 Trzech Kumpli)', () => {
    expect(
      cleanSearchQuery('TRZECH KUMPLI Brewery', 'Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli'),
    ).toBe('TRZECH KUMPLI Porter Bałtycki Żytnio-Orkiszowy');
  });
  test('non-duplicated beer is unchanged (no regression)', () => {
    expect(cleanSearchQuery('Pinta', 'Atak Chmielu')).toBe('Pinta Atak Chmielu');
  });
  test('preserves digits and original casing in surviving tokens', () => {
    expect(cleanSearchQuery('Pinta', 'Many Hops 2023')).toBe('Pinta Many Hops 2023');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/domain/normalize --no-cache -t cleanSearchQuery`
Expected: FAIL — `cleanSearchQuery is not a function`.

- [ ] **Step 3: Implement `cleanSearchQuery`**

In `src/domain/normalize.ts`, add (near `stripBreweryNoise`):

```ts
// Fold a token for noise/dedup comparison: lowercase, strip diacritics, drop non-alphanumerics
// (so "Co." -> "co", "Bałtycki" -> "baltycki").
function foldToken(tok: string): string {
  return tok
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Build an Untappd search query from a shop brewery+name without doubling the brewery.
// Cleans the COMBINED "brewery name" string: drop BREWERY_NOISE tokens and dedup repeated
// tokens (by fold), keeping survivors in their original raw form. Fixes #126: a name that
// repeats the brewery ("Track Brewing Company Taking Shape" + "Track Brewing Co.") otherwise
// AND-searches duplicated terms and returns nothing.
export function cleanSearchQuery(brewery: string, name: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of `${brewery} ${name}`.split(/\s+/)) {
    const f = foldToken(tok);
    if (!f || BREWERY_NOISE.has(f) || seen.has(f)) continue;
    seen.add(f);
    out.push(tok);
  }
  return out.join(' ');
}
```

- [ ] **Step 4: Swap the two query-build sites**

In `src/domain/untappd-lookup.ts`: add `cleanSearchQuery` to the import from `'./normalize'` (line 3). In the per-part loop, change the URL line `const url = buildSearchUrl(`${stripBreweryNoise(part)} ${name}`.trim());` to:

```ts
    const url = buildSearchUrl(cleanSearchQuery(part, name));
```

Then, if `stripBreweryNoise` is now unused in this file, remove it from the import (run `npx tsc --noEmit` to confirm).

In `src/api/routes/enrich.ts`: add `cleanSearchQuery` to the import from `'../../domain/normalize'` (line 10). Change line 58 `searchUrl: buildSearchUrl(`${stripBreweryNoise(b.brewery)} ${b.name}`.trim()),` to:

```ts
          searchUrl: buildSearchUrl(cleanSearchQuery(b.brewery, b.name)),
```

Then remove `stripBreweryNoise` from the enrich.ts import if now unused (confirm with `npx tsc --noEmit`).

- [ ] **Step 5: Run tests**

Run: `npx jest src/domain/normalize src/domain/untappd-lookup src/api --no-cache && npx tsc --noEmit`
Expected: PASS — new `cleanSearchQuery` tests + all existing normalize/lookup/api tests green (the enrich + lookup fixture tests mock `fetch`, so the query change doesn't alter their outcomes); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/domain/normalize.ts src/domain/untappd-lookup.ts src/api/routes/enrich.ts src/domain/normalize.test.ts
git commit -m "feat(enrich): cleanSearchQuery dedups embedded brewery so the search isn't doubled (#126)"
```

---

## Task 3: Real-page fixtures

**Files:**
- Test: `src/domain/untappd-lookup.fixtures.test.ts`
- Fixtures: `tests/fixtures/untappd-search/trzech.html`, `track-clean.html` (already committed with the spec — confirm present)

- [ ] **Step 1: Confirm the fixtures are present**

Run: `wc -c tests/fixtures/untappd-search/trzech.html tests/fixtures/untappd-search/track-clean.html`
Expected: ~66394 and ~66277 bytes. If missing, cherry-pick the spec/fixture commit into the worktree (do NOT re-fetch).

- [ ] **Step 2: Add the two cases**

In `src/domain/untappd-lookup.fixtures.test.ts`, append to the `cases` array (after the `murphys` line):

```ts
  { slug: 'trzech',       brewery: 'TRZECH KUMPLI Brewery',  name: 'Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli', bid: 6568809 }, // #155 trailing
  { slug: 'track-clean',  brewery: 'TRACK BREWING CO.',      name: 'Track Brewing Company Taking Shape',            bid: 6645521 }, // #126 (cleaned-query page)
```

- [ ] **Step 3: Run the fixtures test**

Run: `npx jest src/domain/untappd-lookup.fixtures --no-cache`
Expected: PASS — `trzech → bid 6568809` and `track-clean → bid 6645521` match; all other cases unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/domain/untappd-lookup.fixtures.test.ts
git commit -m "test(enrich): real-page fixtures for #155 (trzech) + #126 match (track)"
```

---

## Task 4: `/match` no-regression gate + spec.md

**Files:**
- Modify: `spec.md` (§3.1 name-keys + enrich query note)

- [ ] **Step 1: `/match` no-regression bench (scope-A blast-radius check)**

The bench needs the prod payload, which is not in the worktree. Copy it from the main checkout, then run:

```bash
mkdir -p tmp && cp /home/ysi/warsaw-beer-bot/tmp/beerrepublic.json tmp/ 2>/dev/null || true
npx tsx scripts/bench-match.ts /var/lib/warsaw-beer-bot/bot.db tmp/beerrepublic.json
```

Expected: `matched=166/166` (unchanged from the pre-change baseline). If the matched count dropped, STOP — the global `nameKeys` change regressed a `/match` match; report it before continuing. (If the payload file is unavailable, note it and rely on the full unit suite as the regression guard.)

- [ ] **Step 2: Update `spec.md` §3.1 (name-keys)**

Run `grep -n "stripLeadingBrewery\|nameKeys\|зрізає продубльовану" spec.md` to find the §3.1 name-keys description. Update the sentence that says the leading brewery is stripped to reflect the generalization (Ukrainian, match the surrounding style):

```markdown
Зрізання провідної пивоварні узагальнено: `stripBreweryFromName` прибирає **суцільний токен-ран пивоварні
будь-де** в назві (не лише провідний префікс) + обрізає залишкові крайові `BREWERY_NOISE`, але ніколи не
зводить назву до порожньої. Застосовується на вхідній і (без змін) кандидатній сторонах `nameKeys`; спільне
для `/match` та enrich. Частково-префіксні випадки (назва несе повнішу фразу пивоварні, ніж поле — `Cydr
Chyliczki`, `Hoppy Hog Family Brewery`) лишаються незматченими (deferred).
```

- [ ] **Step 3: Add the enrich query note to `spec.md`**

Near the `/enrich/candidates` description (run `grep -n "enrich/candidates\|searchUrl\|stripBreweryNoise" spec.md`), add:

```markdown
**Дедуп пошукового запиту (#126).** Запит Untappd-пошуку будується через `cleanSearchQuery(brewery, name)`:
зчищає об'єднаний рядок `brewery + name` — викидає `BREWERY_NOISE` і **дедуплікує** повторені токени (за
згорткою: lowercase + зняття діакритики + не-alphanumeric), лишаючи решту в оригінальній формі. Без цього
назва, що повторює пивоварню (`Track Brewing Company Taking Shape` + `Track Brewing Co.`), AND-шукала б
здубльовані терміни і не повертала кандидатів.
```

- [ ] **Step 4: Verify build + full suite**

Run: `npx tsc --noEmit && npx jest`
Expected: typecheck clean; ALL suites pass.

- [ ] **Step 5: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document stripBreweryFromName (§3.1) + cleanSearchQuery dedup (#126/#155)"
```

---

## Final verification (before opening the PR)

- [ ] `npx tsc --noEmit && npx jest` → all green.
- [ ] `/match` bench `matched=166/166` (Task 4 Step 1).
- [ ] Open PR per the PR-review loop; address AI-review findings.

## Self-review against the spec

- **Coverage:** #155 strip → Task 1 (`stripBreweryFromName`, global via `nameKeys`/`fuzzyTargets`); #126 query → Task 2 (`cleanSearchQuery`, both query sites); real-page proof → Task 3 (trzech 6568809, track-clean 6645521); `/match` blast-radius → Task 4 bench; spec doc → Task 4. Deferred Chyliczki/Hoppy Hog → asserted partial in Task 1 tests; not recovered (correct).
- **No placeholders:** every code/edit step has full content.
- **Type consistency:** `stripBreweryFromName(nameNorm, breweryNorm)` defined Task 1, used in `nameKeys` (matcher.ts) + `fuzzyTargets` (untappd-lookup.ts); `cleanSearchQuery(brewery, name)` + private `foldToken` defined Task 2, used in `lookupBeer` + `enrich.ts`; `BREWERY_NOISE` exported Task 1, consumed by both. No `stripLeadingBrewery` references remain after Task 1 (Step 7 tsc gate).
- **Verified values:** all assertions (6568809, 6645521, `TRACK Taking Shape`, 166/166) confirmed against real pages / the prod DB on 2026-06-14.
