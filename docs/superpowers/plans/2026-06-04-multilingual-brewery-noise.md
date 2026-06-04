# Multilingual Brewery-Descriptor Stop-Words Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Untappd enrichment brewery hard-gate from dropping valid matches when the tap label and Untappd brewery use different-language words for "brewery" (e.g. Czech `Pivovar Černá Hora` vs `Cerna Hora Brewery`).

**Architecture:** Extend the single `BREWERY_NOISE` set in `src/domain/normalize.ts`. Both consumers — `normalizeBrewery` (matching gate) and `stripBreweryNoise` (search-query builder) — read this set, so no other logic changes. Cover with unit tests at the normalize layer and a gate-level regression test at the matcher layer.

**Tech Stack:** TypeScript, Jest 30 + ts-jest.

**Design spec:** `docs/superpowers/specs/2026-06-04-multilingual-brewery-noise-design.md`

---

### Task 1: Extend `BREWERY_NOISE` with multilingual descriptors

**Files:**
- Modify: `src/domain/normalize.ts:7`
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/normalize.test.ts` (after the existing `stripBreweryNoise` describe block, at end of file):

```typescript
describe('multilingual brewery descriptors', () => {
  test('normalizeBrewery strips foreign brewery words', () => {
    expect(normalizeBrewery('Pivovar Černá Hora')).toBe('cerna hora');
    expect(normalizeBrewery('Měšťanský Pivovary Polička')).toBe('mestansky policka');
    expect(normalizeBrewery('Brauerei Aying')).toBe('aying');
    expect(normalizeBrewery('Brasserie Dupont')).toBe('dupont');
    expect(normalizeBrewery('Birrificio Italiano')).toBe('italiano');
    expect(normalizeBrewery('Brouwerij Bosteels')).toBe('bosteels');
    expect(normalizeBrewery('Stigbergets Bryggeri')).toBe('stigbergets');
    expect(normalizeBrewery('Nya Carnegie Bryggeriet')).toBe('nya carnegie');
    expect(normalizeBrewery('Cervecería Maier')).toBe('maier');
    expect(normalizeBrewery('Browary Regionalne')).toBe('regionalne');
  });

  test('stripBreweryNoise drops Pivovar in any position (case-insensitive)', () => {
    expect(stripBreweryNoise('Pivovar Polička')).toBe('Polička');
    expect(stripBreweryNoise('Cerna Hora Pivovar')).toBe('Cerna Hora');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/domain/normalize.test.ts -t "multilingual brewery descriptors"`
Expected: FAIL — e.g. `normalizeBrewery('Pivovar Černá Hora')` returns `'pivovar cerna hora'`, not `'cerna hora'`.

- [ ] **Step 3: Extend the `BREWERY_NOISE` set**

In `src/domain/normalize.ts`, replace line 7:

```typescript
const BREWERY_NOISE = new Set(['browar', 'brewery', 'brewing', 'co', 'company']);
```

with:

```typescript
const BREWERY_NOISE = new Set([
  // English / Polish
  'browar', 'browary', 'brewery', 'brewing', 'co', 'company',
  // Czech / Slovak, German, French, Italian, Dutch/Flemish,
  // Scandinavian (+ definite form), Spanish (post-diacritic-strip form)
  'pivovar', 'pivovary', 'brauerei', 'brasserie', 'birrificio',
  'brouwerij', 'bryggeri', 'bryggeriet', 'cerveceria',
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/domain/normalize.test.ts`
Expected: PASS (the new block plus all pre-existing normalize tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): strip multilingual brewery descriptors (pivovar, brauerei, …)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Gate-level regression test for the Černá Hora pair

**Files:**
- Test: `src/domain/matcher.test.ts`

This locks in the actual bug at the layer that failed (`breweryAliases` overlap),
so a future edit to `BREWERY_NOISE` that drops `pivovar` is caught here, not only
in the normalize unit test.

- [ ] **Step 1: Write the regression test**

Append to `src/domain/matcher.test.ts` (at end of file). If the file does not
already import `breweryAliases`, add it to the existing import from `./matcher`.

```typescript
test('brewery hard-gate: Czech Pivovar prefix overlaps tap label', () => {
  const tap = new Set(breweryAliases('Cerna Hora Brewery'));
  const untappd = breweryAliases('Pivovar Černá Hora');
  expect(untappd.some((a) => tap.has(a))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx jest src/domain/matcher.test.ts -t "Czech Pivovar prefix"`
Expected: PASS (Task 1 already made the alias sets overlap on `cerna hora`).

Note: this test passes immediately because the production change landed in Task 1.
It is a regression guard, not a red-green driver. If it FAILS, Task 1's set edit
is wrong — fix that before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/domain/matcher.test.ts
git commit -m "test(matcher): regression guard for Czech Pivovar brewery gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Update spec.md and run the full suite

**Files:**
- Modify: `spec.md` (brewery-aliases gotcha note + normalize stop-words description)

- [ ] **Step 1: Update the normalize stop-words description**

In `spec.md`, find the line describing `normalize.ts`:

```
│   ├── normalize.ts        # нормалізація назв (діакритика, стоп-слова, цифри)
```

Replace with:

```
│   ├── normalize.ts        # нормалізація назв (діакритика, стоп-слова, цифри; BREWERY_NOISE — мультимовні дескриптори пивоварень)
```

- [ ] **Step 2: Extend the brewery-aliases gotcha note**

In `spec.md`, find the brewery-aliases bullet in the Appendix:

```
- Brewery-aliases: `"X / Y"` (білінгва + колаби, будь-який пробіл навколо `/`)
  і паренформа `"X (Y)"` — обидві сторони рахуються як валідна пивоварня;
  `dedupeBreweryAliases` зливає дублі на старті.
```

Append a line after it:

```
- Brewery-aliases: `"X / Y"` (білінгва + колаби, будь-який пробіл навколо `/`)
  і паренформа `"X (Y)"` — обидві сторони рахуються як валідна пивоварня;
  `dedupeBreweryAliases` зливає дублі на старті.
- `BREWERY_NOISE` стрипить дескриптори пивоварні багатьма мовами (`browar`,
  `brewery`, `pivovar`, `brauerei`, `brasserie`, `birrificio`, `brouwerij`,
  `bryggeri`, `cerveceria`, …) — інакше brewery hard-gate валить валідний матч
  (напр. `Pivovar Černá Hora` ↔ `Cerna Hora Brewery`). Зміна списку міняє
  `normalized_brewery` → `dedupeBreweryAliases` може злити нові дублі на старті.
```

- [ ] **Step 3: Run the full test suite**

Run: `npx jest`
Expected: PASS — entire suite green, no regressions.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): note multilingual BREWERY_NOISE descriptors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- Diacritics are handled by `baseNormalize` (NFD strip) **before** the
  `BREWERY_NOISE` lookup in `normalizeBrewery`, which is why the gate expectations
  use ASCII (`cerna hora`). `stripBreweryNoise` does *not* strip diacritics, so its
  expectations keep the original diacritics on non-noise tokens (`Polička`).
- Do not add `cerveza`, `bier`, or `piwo` — they mean "beer", not "brewery", and
  can be legitimate name tokens.
- The `dedupeBreweryAliases` merge-on-startup is an accepted, expected side effect
  (see design spec) — no code change is needed to handle it.
