# #636 Digit Identity — Periphery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the (asymmetric) digit-identity rule in every remaining place that reads the digit-free normalized key as identity — orphan reuse and resolution, the `/enrich/*` row choice, the Untappd lookup gate — and bring `spec.md` in line, so the core can ship.

**Architecture:** `digit-identity.ts` gains a peer predicate for two tap texts. `beers.ts` uses it in `ensureOrphan` and accepts only `same`/`year-fallback` when resolving an orphan by bid; `numericTokensCompatible`/`numericNameTokens` are deleted. `enrich.ts` picks the pair's row by tiers through a new `listBeersByNormalized`. `lookupBeer` filters Algolia hits before every stage. `spec.md` documents the rule once and points every section at it.

**Tech Stack:** TypeScript (CommonJS, Node 24), Vitest (globals), better-sqlite3 (in-memory in tests).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-16-636-digit-identity-design.md` — «Застосування → Обв'язка 3–5», «Асиметрія ролей», «Обмеження», «Спостереження після деплою». Core is done (plans `…-core.md`, `…-core-asymmetric.md`; HEAD `afd54b4` on `worktree-636-digit-identity`).

**How this plan was written:** every task diff below was produced by applying the change to a copy of the worktree at `afd54b4` and running the full suite there (3012 passed, typecheck clean), then rebuilt stage by stage from the clean worktree; the final stage equals the tested copy byte for byte. Each diff applies with `git apply` in order. **The repo beats this plan** — if a hunk does not apply or a test disagrees, stop and report.

## Global Constraints

- One PR, one deploy for core + periphery (spec «Порядок деплою»). Nothing is pushed or deployed by this plan without the user's explicit OK; the user merges PRs.
- `digitIdentity(input, candidate)` roles: input = tap/card/orphan text, candidate = catalog row / Untappd hit / bid name. Two tap texts compare as peers (`digitsCompatibleAsPeers`).
- `resolvableOrphan` accepts only `same` | `year-fallback`. `lookupBeer` drops `different`, and drops `number-fallback` when any `same`/`year-fallback` hit is present; the unfiltered list stays in `not_found.candidates`.
- `findBeerByNormalized` stays (tests use it); production `enrich.ts` switches to `listBeersByNormalized`.
- Full gate after every task: `npm test && npm run typecheck`. Vitest on explicit paths only.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and name the mechanism.
- Ledger/workspace for this plan: `.superpowers/sdd/2026-09-16-636-digit-identity-periphery/`.

Task sizing (CLAUDE.md): P1, P2, P4 carry complete code and touch ≤2 source files + tests with no new decision → inline. P3 touches `beers.ts`, `enrich.ts` and their tests (2 source files) → inline. P5 is documentation → inline. P6 is the dispatched final whole-branch review and must name P1–P5 as inline.

TDD pattern used by every code task: apply the **test** hunks first (`git apply --include='*.test.ts' <diff>`), run and record the failures, then apply the **source** hunks (`git apply --exclude='*.test.ts' <diff>`). Save each diff below to `.superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-Pn.diff` before applying.

---

### Task P1: `digitsCompatibleAsPeers` + the #617 table carried over

**Files:** Modify `src/domain/digit-identity.ts` (append), `src/domain/digit-identity.test.ts` (import + describe).

**Interfaces:** Produces `export function digitsCompatibleAsPeers(a: string, b: string): boolean` — true iff neither `digitIdentity(a,b)` nor `digitIdentity(b,a)` is `different`. Consumed by P2 (`ensureOrphan`).

- [ ] **Step 1: Save the diff** to `.superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P1.diff`:

```diff
--- a/src/domain/digit-identity.ts
+++ b/src/domain/digit-identity.ts
@@ -150,3 +150,15 @@
   if ((inputYears === '') !== (candidateYears === '')) return 'year-fallback';
   return 'same';
 }
+
+/**
+ * Two texts of the same kind — a tap name against an existing orphan's tap name (`ensureOrphan`, #617). Neither is
+ * Untappd's, so there are no roles: they are one orphan only if neither direction is `different`. A
+ * `number-fallback` one way is always `different` the other way (its candidate-only number is the reverse
+ * direction's uncovered input number), so no separate check is needed.
+ */
+export function digitsCompatibleAsPeers(a: string, b: string): boolean {
+  const digitsA = readNameDigits(a);
+  const digitsB = readNameDigits(b);
+  return digitIdentity(digitsA, digitsB) !== 'different' && digitIdentity(digitsB, digitsA) !== 'different';
+}
--- a/src/domain/digit-identity.test.ts
+++ b/src/domain/digit-identity.test.ts
@@ -1,4 +1,4 @@
-import { digitIdentity, readNameDigits, type DigitIdentity } from './digit-identity';
+import { digitIdentity, digitsCompatibleAsPeers, readNameDigits, type DigitIdentity } from './digit-identity';
 
 // #636. Every pair below is a real catalog or tap name from the prod probe (spec 2026-09-16), so a rule change
 // that "looks harmless" has to explain which measured beer it moves.
@@ -122,3 +122,37 @@
     expect(identity(candidate, input)).toBe(reverse);
   });
 });
+
+describe('digitsCompatibleAsPeers — ensureOrphan (the #617 numericTokensCompatible table, carried over)', () => {
+  test.each<[string, string, boolean]>([
+    // measured wrong pairs — must stay apart
+    ['Juicy Trap #19 18°', 'Juicy Trap #20', false],
+    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', false],
+    ['Grodziskie Piwobraniowe 2024', 'Piwobranie 2026: Suska sechlońska i cascara', false],
+    ['Trappistes Rochefort 10 (2015)', 'Trappistes Rochefort 10 (2017)', false],
+    ['Kronenbourg 1664', 'Kronenbourg', false],
+    ['Vintage 2015 2016', 'Vintage 2016', false],
+    ['Piwobranie 2024', 'Piwobranie 2025', false],
+    ['O Tiole Mio! 2026 15°', 'O tiole mio! 2025', false],
+    // the same beer — must stay together
+    ['Kronenbourg 1664 Blanc 12,5°', '1664 Blanc', true],
+    ['AMBROSIA 10.0 18°', 'Ambrosia 10.0', true],
+    ['Juicy Trap #20 18°', 'Juicy Trap #20', true],
+    ['Krzyż Południa 13°', 'Krzyż Południa (2026)', true],
+    ['ROTATION 12°', 'Rotation (2026)', true],
+    ['La Chouffe 16°', 'La Chouffe 0.4%', true],
+    ['Beer 12 x 3', 'Beer 3 x 12', true],
+    ['Vintage (2016) 2015', 'Vintage 2015 2016', true],
+    ['Anniversary 2000', 'Anniversary', true],
+    ['Łan', 'Łan 12°', true],
+    // #636 changes against #617, both from the spec: a bare 8–14 is soft (was apart) …
+    ['Svijanský Máz 11', 'Svijanský Máz', true],
+    // … and digits inside a non-compact bracket are read now (was a documented blind spot: together)
+    ['Imperial Stout (Batch 12)', 'Imperial Stout (Batch 13)', false],
+    // a number only one peer carries is another orphan, whichever side it is on
+    ['Cucumber Gose', '10th Anniversary #6: Cucumber Gose', false],
+  ])('%s  ↔  %s  →  %s', (a, b, expected) => {
+    expect(digitsCompatibleAsPeers(a, b)).toBe(expected);
+    expect(digitsCompatibleAsPeers(b, a)).toBe(expected);
+  });
+});
```

- [ ] **Step 2: Tests first** — `git apply --include='*.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P1.diff`; run `npx vitest run src/domain/digit-identity.test.ts`. Expected: the file fails to run — `digitsCompatibleAsPeers` is not exported.
- [ ] **Step 3: Source** — `git apply --exclude='*.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P1.diff`; rerun → PASS, 78 tests (57 before + 21 peer rows).
- [ ] **Step 4: Mutation** — delete `&& digitIdentity(digitsB, digitsA) !== 'different'` → rows `Cucumber Gose ↔ 10th Anniversary #6: Cucumber Gose` and `Kronenbourg 1664 ↔ Kronenbourg` go red; restore.
- [ ] **Step 5: Gate + commit** — `npm test && npm run typecheck`, then:

```bash
git add src/domain/digit-identity.ts src/domain/digit-identity.test.ts
git commit -m "feat(#636): two tap texts compare their digits as peers — neither direction may be different

ensureOrphan compares a tap name with an existing orphan's tap name; neither is Untappd's, so
the input/candidate roles do not apply. The #617 numericTokensCompatible table is carried over
with its two measured changes: a bare 8–14 is soft (Svijanský Máz 11), bracketed batch digits
are read (Batch 12 ≠ Batch 13).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task P2: orphans — `ensureOrphan` as peers, `resolvableOrphan` never adopts a number-fallback; old helpers deleted

**Files:** Modify `src/storage/beers.ts`, `src/storage/beers.test.ts`, `src/domain/normalize.ts` (delete `numericNameTokens`, `YEAR_TOKEN`, `numericTokensCompatible`), `src/domain/normalize.test.ts` (delete their describes and imports).

**Interfaces:** Consumes `digitIdentity`, `readNameDigits`, `digitsCompatibleAsPeers`. After this task nothing imports `numericTokensCompatible` (`grep -rn numericTokensCompatible src scripts` → only comments may remain).

- [ ] **Step 1: Save the diff** to `.superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P2.diff`:

```diff
--- a/src/storage/beers.ts
+++ b/src/storage/beers.ts
@@ -1,6 +1,6 @@
 import type { DB } from './db';
 import { bumpCatalogVersion } from './catalog-version';
-import { numericTokensCompatible } from '../domain/normalize';
+import { digitIdentity, digitsCompatibleAsPeers, readNameDigits } from '../domain/digit-identity';
 import { cardAbv, cardText } from '../domain/card-text';
 
 export type UntappdIdSource = 'search' | 'bid' | 'curated' | 'checkin';
@@ -70,8 +70,11 @@
 }
 
 // #617: сирота, яку можна резолвити цим bid — рівно одна з тією самою нормалізованою парою і
-// сумісними цифровими токенами назви. normalizeName викидає цифри, тож без другої умови чекін
+// сумісними цифрами назви. normalizeName викидає цифри, тож без другої умови чекін
 // «Rochefort 10» віддав би bid сироті «Rochefort 8». Двозначність не вирішується вгадуванням.
+// #636: сирота — вхід, назва bid (Untappd) — кандидат; сумісні лише `same` і `year-fallback`.
+// `number-fallback` тут — вгадування («Juicy Trap 18°» — це «#19», бо його чекін синкнувся першим), а
+// резолвлення пише bid у рядок, що зберігає текст крана (#618): наступний інжест прочитав би це як `same`.
 function resolvableOrphan(db: DB, b: BidBeerInput): { id: number; untappd_id_source: UntappdIdSource | null } | null {
   const orphans = db
     .prepare(
@@ -81,7 +84,11 @@
     .all(b.normalized_brewery, b.normalized_name) as {
       id: number; name: string; untappd_id_source: UntappdIdSource | null;
     }[];
-  const compatible = orphans.filter((o) => numericTokensCompatible(o.name, b.name));
+  const bidDigits = readNameDigits(b.name);
+  const compatible = orphans.filter((o) => {
+    const identity = digitIdentity(readNameDigits(o.name), bidDigits);
+    return identity === 'same' || identity === 'year-fallback';
+  });
   return compatible.length === 1 ? compatible[0] : null;
 }
 
@@ -164,7 +171,7 @@
 }
 
 // #617: рядок без bid — для гілки сироти refresh-ontap і рядків /import без bid. Шукає лише серед
-// сиріт із сумісними цифровими токенами назви; знайдену (найстарішу) повертає без перезапису.
+// сиріт із сумісними цифрами назви (#636: обидва тексти — вхідні, тож порівняння рівних, `digitsCompatibleAsPeers`); знайдену (найстарішу) повертає без перезапису.
 // Злінкованого рядка не торкається ніколи: сирота поряд зі злінкованим вінтажем тієї ж назви —
 // нормальний стан (UNIQUE лише на untappd_id). Фільтр цифр — з рев'ю гілки: у гілці сироти
 // refresh-ontap сирота з тією ж парою досяжна лише коли матчер відкинув її як інший рік, тож без
@@ -178,7 +185,7 @@
         ORDER BY id`,
     )
     .all(b.normalized_brewery, b.normalized_name) as { id: number; name: string }[];
-  const existing = orphans.find((o) => numericTokensCompatible(o.name, b.name));
+  const existing = orphans.find((o) => digitsCompatibleAsPeers(o.name, b.name));
   if (existing) return existing.id;
 
   const res = db.prepare(
--- a/src/storage/beers.test.ts
+++ b/src/storage/beers.test.ts
@@ -1613,6 +1613,24 @@
     expect(getBeer(db, got)!.untappd_id).toBe(6625206);
   });
 
+  // #636: резолвлення пише bid у рядок, що зберігає текст крана (#618). Номер лише в назві bid — вгадування,
+  // яке наступний інжест прочитав би як `same`, тож сирота його не приймає.
+  test('an orphan without the number the bid carries is not adopted (#636 number-fallback is a guess)', () => {
+    const db = fresh();
+    const orphan = insertOrphanRaw(db, 'Juicy Trap 18°', PP, 6.5);
+    const got = upsertBeerByBid(db, bidInput(6625100, 'Juicy Trap #19', PP));
+    expect(got).not.toBe(orphan);
+    expect(getBeer(db, orphan)!.untappd_id).toBeNull();
+  });
+
+  test('an orphan of another batch in brackets is not resolved (#636 reads bracketed digits)', () => {
+    const db = fresh();
+    const orphan = insertOrphanRaw(db, 'Imperial Stout (Batch 12)', PP, 10);
+    const got = upsertBeerByBid(db, bidInput(7000013, 'Imperial Stout (Batch 13)', PP));
+    expect(got).not.toBe(orphan);
+    expect(getBeer(db, orphan)!.untappd_id).toBeNull();
+  });
+
   test('bumps the catalog version on insert and on update', () => {
     const db = fresh();
     let v = catalogVersion();
@@ -1628,6 +1646,32 @@
 describe('ensureOrphan (#617)', () => {
   const MONSTERS = 'Monsters Brewery';
 
+  const orphanInput = (name: string, brewery: string) => ({
+    name, brewery, style: null, abv: null, rating_global: null,
+    normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
+  });
+
+  test('an orphan of another batch in brackets is not reused (#636)', () => {
+    const db = fresh();
+    const first = ensureOrphan(db, orphanInput('Imperial Stout (Batch 12)', 'Browar Testowy'));
+    const second = ensureOrphan(db, orphanInput('Imperial Stout (Batch 13)', 'Browar Testowy'));
+    expect(second).not.toBe(first);
+  });
+
+  test('a bare Czech grade is soft: the tap reuses the orphan written without it (#636)', () => {
+    const db = fresh();
+    const first = ensureOrphan(db, orphanInput('Svijanský Máz', 'Pivovar Svijany'));
+    const second = ensureOrphan(db, orphanInput('Svijanský Máz 11', 'Pivovar Svijany'));
+    expect(second).toBe(first);
+  });
+
+  test('a number only the existing orphan carries makes another orphan (#636 peers have no roles)', () => {
+    const db = fresh();
+    const numbered = ensureOrphan(db, orphanInput('Juicy Trap #20', 'Piwne Podziemie'));
+    const plain = ensureOrphan(db, orphanInput('Juicy Trap', 'Piwne Podziemie'));
+    expect(plain).not.toBe(numbered);
+  });
+
   // Рев'ю гілки #617: у гілці сироти refresh-ontap наявна сирота з тією ж нормалізованою парою
   // досяжна лише тоді, коли матчер відкинув її як інший рік, — повернути її означало б приліпити
   // кран «2025» до сироти «2024» (і шукати його на Untappd під назвою 2024).
--- a/src/domain/normalize.ts
+++ b/src/domain/normalize.ts
@@ -167,32 +167,6 @@
   return tokens.join(' ');
 }
 
-// #617: цифрові токени, які normalizeName відкидає як шум. Дві назви з рівною нормалізованою
-// формою можуть бути різними пивами (Rochefort 8 / 10, Juicy Trap #19 / #20) — і різняться
-// вони саме тут. Той самий конвеєр, що в normalizeName, тож специфікація (12,5°, 0,5%) уже
-// прибрана stripSearchNoise, а десятковий ідентифікатор (10.0) лишається одним нецифровим токеном.
-export function numericNameTokens(s: string): string[] {
-  return baseNormalize(preserveDecimalIdentifiers(stripSearchNoise(s)))
-    .split(' ')
-    .filter((t) => /^\d+$/.test(t));
-}
-
-const YEAR_TOKEN = /^(?:19|20)\d{2}$/;
-
-// #617: чи можуть дві назви з рівною нормалізованою формою бути одним пивом. Роки порівнюються
-// лише коли рік є в обох — те саме правило, що в матчері (кандидат без року сумісний з будь-яким
-// роком). Решта цифрових токенів мусить збігатися як мультимножина.
-export function numericTokensCompatible(a: string, b: string): boolean {
-  const ta = numericNameTokens(a);
-  const tb = numericNameTokens(b);
-  const years = (ts: string[]) => ts.filter((t) => YEAR_TOKEN.test(t)).sort().join(' ');
-  const rest = (ts: string[]) => ts.filter((t) => !YEAR_TOKEN.test(t)).sort().join(' ');
-  const ya = years(ta);
-  const yb = years(tb);
-  if (ya !== '' && yb !== '' && ya !== yb) return false;
-  return rest(ta) === rest(tb);
-}
-
 export function normalizeBrewery(s: string): string {
   const tokens = baseNormalize(
     stripLegalForm(canonicalizeBreweryBrand(s)).replace(SUPERSCRIPT_FOOTNOTE, ''),
--- a/src/domain/normalize.test.ts
+++ b/src/domain/normalize.test.ts
@@ -1,4 +1,4 @@
-import { normalizeName, normalizeBrewery, stripBreweryNoise, stripLegalForm, cleanSearchQuery, stripSearchNoise, stripQueryTokenNoise, repairHomoglyphs, searchQueryLadder, numericNameTokens, numericTokensCompatible, stripDescriptorAndPackaging } from './normalize';
+import { normalizeName, normalizeBrewery, stripBreweryNoise, stripLegalForm, cleanSearchQuery, stripSearchNoise, stripQueryTokenNoise, repairHomoglyphs, searchQueryLadder, stripDescriptorAndPackaging } from './normalize';
 
 test('lowercases and strips diacritics', () => {
   expect(normalizeName('Atak Chmielu — Imperial')).toBe('atak chmielu');
@@ -572,56 +572,6 @@
   });
 });
 
-describe('numericNameTokens (#617)', () => {
-  test('keeps pure-digit tokens that normalizeName drops as noise', () => {
-    expect(numericNameTokens('Juicy Trap #19 18°')).toEqual(['19']);
-    expect(numericNameTokens('Trappistes Rochefort 10 (2015)')).toEqual(['10', '2015']);
-  });
-
-  test('spec strings are not tokens: degrees and ABV are stripped first', () => {
-    expect(numericNameTokens('Kronenbourg 1664 Blanc 12,5°')).toEqual(['1664']);
-    expect(numericNameTokens('La Chouffe 0.4%')).toEqual([]);
-  });
-
-  test('a decimal identifier is one non-digit token, not two digit tokens', () => {
-    expect(numericNameTokens('Ambrosia 10.0 18°')).toEqual([]);
-  });
-});
-
-describe('numericTokensCompatible (#617)', () => {
-  test.each([
-    // виміряні хибні пари зі спеки — мусять розрізнятися
-    ['Juicy Trap #19 18°', 'Juicy Trap #20', false],
-    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', false],
-    ['Grodziskie Piwobraniowe 2024', 'Piwobranie 2026: Suska sechlońska i cascara', false],
-    ['Trappistes Rochefort 10 (2015)', 'Trappistes Rochefort 10 (2017)', false],
-    ['Svijanský Máz 11', 'Svijanský Máz', false],
-    // однакові пива — мусять збігатися
-    ['Kronenbourg 1664 Blanc 12,5°', '1664 Blanc', true],
-    ['AMBROSIA 10.0 18°', 'Ambrosia 10.0', true],
-    ['Juicy Trap #20 18°', 'Juicy Trap #20', true],
-    // рік лише в одній назві — сумісно, як у матчері (extractYear)
-    ['Krzyż Południa 13°', 'Krzyż Południa (2026)', true],
-    ['ROTATION 12°', 'Rotation (2026)', true],
-    // відоме обмеження зі спеки: різниця лише в ABV не видима, бо stripSearchNoise прибирає ABV
-    ['La Chouffe 16°', 'La Chouffe 0.4%', true],
-    // рев'ю ядра: чотирицифрове число поза 19xx/20xx — не рік
-    ['Kronenbourg 1664', 'Kronenbourg', false],
-    // рев'ю ядра: мультимножини, порядок токенів не важить
-    ['Beer 12 x 3', 'Beer 3 x 12', true],
-    ['Vintage (2016) 2015', 'Vintage 2015 2016', true],
-    // відоме обмеження: роки порівнюються набором, зайвий рік в одній назві розводить
-    ['Vintage 2015 2016', 'Vintage 2016', false],
-    // відоме обмеження: число, схоже на рік, — рік (той самий регекс, що в матчері)
-    ['Anniversary 2000', 'Anniversary', true],
-    // відоме обмеження: цифри в некомпактних дужках невидимі — stripSearchNoise прибирає групу
-    ['Imperial Stout (Batch 12)', 'Imperial Stout (Batch 13)', true],
-  ])('%s ↔ %s → %s', (a, b, expected) => {
-    expect(numericTokensCompatible(a, b)).toBe(expected);
-    expect(numericTokensCompatible(b, a)).toBe(expected);
-  });
-});
-
 describe('stripDescriptorAndPackaging (#353)', () => {
   test('strips trailing multi-word and single-word style descriptors (#590, #533, #559)', () => {
     expect(stripDescriptorAndPackaging('16° Rainbow of Death West Coast IPA')).toBe('Rainbow of Death');
```

- [ ] **Step 2: Tests first** — `git apply --include='src/storage/beers.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P2.diff`; `npx vitest run src/storage/beers.test.ts`. Expected (measured on `afd54b4`): 3 FAIL — `an orphan of another batch in brackets is not resolved`, `an orphan of another batch in brackets is not reused`, `a bare Czech grade is soft: the tap reuses the orphan written without it`. `an orphan without the number the bid carries is not adopted` and `a number only the existing orphan carries makes another orphan` PASS already (guards — proven in Step 4).
- [ ] **Step 3: Source + the normalize test deletions** — `git apply --exclude='src/storage/beers.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P2.diff`; `npx vitest run src/storage/beers.test.ts src/domain/normalize.test.ts src/jobs/refresh-ontap.test.ts src/jobs/refresh-untappd.test.ts src/storage/seed-beer-guard.test.ts` → PASS.
- [ ] **Step 4: Mutations**
  - in `resolvableOrphan`, add `|| identity === 'number-fallback'` → `an orphan without the number the bid carries is not adopted` red;
  - in `ensureOrphan`, replace `digitsCompatibleAsPeers(o.name, b.name)` with `digitIdentity(readNameDigits(b.name), readNameDigits(o.name)) !== 'different'` → `a number only the existing orphan carries makes another orphan` red;
  - restore both.
- [ ] **Step 5: Gate + commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(#636): orphans use the digit-identity rule — peers for reuse, no number-fallback when resolving by bid

numericTokensCompatible dropped bracketed digits and knew no roles. Resolving an orphan writes
the bid into a row that keeps the tap text (#618), so a number only the bid name carries would
become 'same' on the next ingest; only same/year-fallback resolve now. The old helpers are gone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task P3: `/enrich/*` picks the pair's row by the card's digits

**Files:** Modify `src/storage/beers.ts` (add `listBeersByNormalized`), `src/api/routes/enrich.ts` (`pickRowByDigits`, `ensureBeerRow`), `src/api/routes/enrich.test.ts` (new describe; the #614 web-fallback alias test re-staged).

**Interfaces:** Produces `export function listBeersByNormalized(db: DB, normBrewery: string, normName: string): BeerRow[]` (ORDER BY id). `ensureBeerRow` signature unchanged.

**Why the #614 test changes:** `#614 writes no alias when the web fallback searched with the text of an orphan another card created` built its scenario on the #636 defect itself (its comment: «ensureBeerRow цифр не бачить і віддає її запиту картки #7»). After #636 card `#7` gets its own orphan and the guard is unreachable that way. The guard stays reachable honestly with a card of the same digits and a different text: `Gwara #6 IPA` (style word — same normalized pair) against orphan `Gwara #6`; `cardText` only folds case/space/NFC, so `GWARA #6` would NOT work (measured: alias written).

- [ ] **Step 1: Save the diff** to `.superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P3.diff`:

```diff
--- a/src/storage/beers.ts
+++ b/src/storage/beers.ts
@@ -330,6 +330,14 @@
   return row ?? null;
 }
 
+// #636: усі рядки нормалізованої пари, найстаріший першим. Нормалізована назва не несе цифр, тож рядків пари може бути
+// кілька (різні номери й вінтажі) — вибір між ними робить викликач за цифрами назви (ensureBeerRow).
+export function listBeersByNormalized(db: DB, normBrewery: string, normName: string): BeerRow[] {
+  return db
+    .prepare('SELECT * FROM beers WHERE normalized_brewery = ? AND normalized_name = ? ORDER BY id')
+    .all(normBrewery, normName) as BeerRow[];
+}
+
 export function findBeerByNormalized(
   db: DB, normBrewery: string, normName: string,
 ): BeerRow | null {
--- a/src/api/routes/enrich.ts
+++ b/src/api/routes/enrich.ts
@@ -4,7 +4,7 @@
 import type { ApiDeps, ApiEnv } from '../types';
 import {
   findAliasTarget,
-  findBeerByNormalized,
+  listBeersByNormalized,
   getBeer,
   ensureOrphan,
   fillOrphanFacts,
@@ -17,6 +17,7 @@
 } from '../../storage/beers';
 import { isNotABeer, reviewClassOf } from '../../storage/enrich_failures';
 import { normalizeBrewery, normalizeName, searchQueryLadder } from '../../domain/normalize';
+import { digitIdentity, readNameDigits } from '../../domain/digit-identity';
 import { isEligible, RECURRING_CLASSES } from '../../domain/lookup-backoff';
 import { buildSearchUrl, htmlSearch } from '../../sources/untappd/search';
 import {
@@ -130,6 +131,21 @@
 // текстом, і /match віддавав її exact без ✅. Без нього перед парою картка отримувала рядок близнюка тієї самої пари
 // (інше написання чи ABV-близнюк), і її суперечливий bid перелінковував рядок близнюка — пінг-понг (рев'ю 11, R3).
 // viaAlias каже викликачеві, що рядок — канонічний, а не рядок цієї картки.
+// #636: рядок пари, яким може бути картка. Картка — вхід, рядок — кандидат: `different` відкидається, далі
+// `same` > `year-fallback` > `number-fallback`, у межах рівня — найстаріший рядок (детермінізм замість порядку
+// `.get()`, який віддавав картці «Rochefort 10» рядок «Rochefort 6»).
+const ROW_TIERS = ['same', 'year-fallback', 'number-fallback'] as const;
+
+function pickRowByDigits(cardName: string, rows: BeerRow[]): BeerRow | null {
+  const card = readNameDigits(cardName);
+  const judged = rows.map((row) => ({ row, identity: digitIdentity(card, readNameDigits(row.name)) }));
+  for (const tier of ROW_TIERS) {
+    const hit = judged.find((j) => j.identity === tier);
+    if (hit) return hit.row;
+  }
+  return null;
+}
+
 function ensureBeerRow(
   db: ApiDeps['db'], brewery: string, name: string, facts: OrphanFacts = {},
 ): BeerRow & { viaAlias: boolean } {
@@ -137,13 +153,15 @@
   if (aliased) return { ...aliased, viaAlias: true };
   const normalized_brewery = normalizeBrewery(brewery);
   const normalized_name = normalizeName(name);
-  const existing = findBeerByNormalized(db, normalized_brewery, normalized_name);
+  const existing = pickRowByDigits(name, listBeersByNormalized(db, normalized_brewery, normalized_name));
   if (existing) {
     const { abvGained, changed } = fillOrphanFacts(db, existing.id, facts);
     if (abvGained) rearmLookup(db, existing.id);
     return { ...(abvGained || changed ? getBeer(db, existing.id)! : existing), viaAlias: false };
   }
   // #617: сюди доходимо, лише коли рядка з цією нормалізованою парою немає зовсім — вставка сироти.
+  // #636: або коли всі рядки пари мають інші цифри; ensureOrphan тоді не знайде й сумісної сироти (порівняння рівних
+  // суворіше за вибір вище), тож вставить нову.
   const id = ensureOrphan(db, {
     name, brewery,
     style: facts.style ?? null, abv: sanitizeAbv(facts.abv) ?? null,
--- a/src/api/routes/enrich.test.ts
+++ b/src/api/routes/enrich.test.ts
@@ -639,21 +639,22 @@
     const { db, app } = setup({ webFallback });
     seed(106, 'Gwara #6');
     seed(107, 'Gwara #7');
-    // Сирота картки «#6»; ensureBeerRow цифр не бачить і віддає її запиту картки «#7».
+    // Сирота картки «Gwara #6». Картка «Gwara #6 IPA» (інший текст картки, та сама нормалізована пара й ті самі цифри) отримує від ensureBeerRow цю сироту:
+    // #636 розводить лише інші цифри (картка «#7» отримала б власну сироту, і сценарій був би недосяжний).
     const orphan = seedBeer(db, {
       name: 'Gwara #6', brewery: 'PINTA', style: null, abv: 6, rating_global: null,
       normalized_name: normalizeName('Gwara #6'), normalized_brewery: normalizeBrewery('PINTA'),
     });
-    expect(normalizeName('Gwara #7')).toBe(normalizeName('Gwara #6'));
+    expect(normalizeName('Gwara #6 IPA')).toBe(normalizeName('Gwara #6'));
 
     const res = await post(app, '/enrich/result', {
-      brewery: 'PINTA', name: 'Gwara #7', abv: 6, algolia: { hits: [], nbHits: 0 },
+      brewery: 'PINTA', name: 'Gwara #6 IPA', abv: 6, algolia: { hits: [], nbHits: 0 },
     });
 
     expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 106 });
     expect(webFallback).toHaveBeenCalledWith(orphan);
     expect(getBeer(db, orphan)).toBeNull();
-    // Аліас «PINTA / Gwara #7» → #6 дав би картці #7 точний збіг і ✅ на пиво, яке пив лише #6.
+    // Фолбек шукав текстом сироти іншої картки, а не «PINTA / Gwara #6 IPA» — доказу для аліасу цієї картки він не дає.
     expect(db.prepare('SELECT beer_id FROM beer_aliases').all()).toEqual([]);
   });
 
@@ -1279,3 +1280,48 @@
     expect(res.status).toBe(200);
   });
 });
+
+describe('#636 ensureBeerRow picks the row of the pair by the digits of the card', () => {
+  const ROCHEFORT = 'Abbaye Notre-Dame de Saint-Rémy';
+  const PP = 'Piwne Podziemie';
+  const linked = (db: ReturnType<typeof setup>['db'], untappd_id: number, name: string, brewery: string) =>
+    seedBeer(db, {
+      untappd_id, untappd_id_source: 'checkin', name, brewery, style: null, abv: null, rating_global: 3.9,
+      normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
+    });
+
+  it('a card of one number gets its own row, not the older row of another number', async () => {
+    // Before #636: findBeerByNormalized(...).get() returned the older row — untappd_id 10722.
+    const { db, app } = setup();
+    linked(db, 10722, 'Trappistes Rochefort 6', ROCHEFORT);
+    linked(db, 2002, 'Trappistes Rochefort 10', ROCHEFORT);
+    const res = await post(app, '/enrich/result', { brewery: ROCHEFORT, name: 'Trappistes Rochefort 10', algolia: { hits: [], nbHits: 0 } });
+    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 2002 });
+  });
+
+  it('a card whose number has no row gets a new orphan and is searched', async () => {
+    // Before #636: the card took the linked Rochefort 6 row and was not eligible.
+    const { db, app } = setup();
+    linked(db, 10722, 'Trappistes Rochefort 6', ROCHEFORT);
+    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: ROCHEFORT, name: 'Trappistes Rochefort 10' }] });
+    expect((await res.json()).candidates[0].eligible).toBe(true);
+    expect(beerCount(db)).toBe(2);
+  });
+
+  it('an unnumbered card prefers the unnumbered row over an older numbered one', async () => {
+    // Before #636: the older #20 row — untappd_id 6625206.
+    const { db, app } = setup();
+    linked(db, 6625206, 'Juicy Trap #20', PP);
+    linked(db, 999, 'Juicy Trap', PP);
+    const res = await post(app, '/enrich/result', { brewery: PP, name: 'Juicy Trap', algolia: { hits: [], nbHits: 0 } });
+    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 999 });
+  });
+
+  it('an unnumbered card still takes the only numbered row (number-fallback)', async () => {
+    const { db, app } = setup();
+    linked(db, 6625206, 'Juicy Trap #20', PP);
+    const res = await post(app, '/enrich/result', { brewery: PP, name: 'Juicy Trap', algolia: { hits: [], nbHits: 0 } });
+    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6625206 });
+    expect(beerCount(db)).toBe(1);
+  });
+});
```

- [ ] **Step 2: Tests first** — `git apply --include='*.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P3.diff`; `npx vitest run src/api/routes/enrich.test.ts`. Expected (measured on `afd54b4`): 1 FAIL — `a card whose number has no row gets a new orphan and is searched`. The other three new tests and the re-staged #614 test PASS already: in the in-memory DB `.get()` happened to return the right row — they are proven by mutation in Step 4.
- [ ] **Step 3: Source** — `git apply --exclude='*.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P3.diff`; `npx vitest run src/api/routes/enrich.test.ts src/api/routes/merge-alias-loop.test.ts src/storage/beers.test.ts` → PASS.
- [ ] **Step 4: Mutations**
  - `pickRowByDigits` body → `return rows[0] ?? null;` → `a card of one number gets its own row…` and `a card whose number has no row…` red;
  - `ROW_TIERS` without `'number-fallback'` → `an unnumbered card still takes the only numbered row` red;
  - `ROW_TIERS` order `['number-fallback', 'same', 'year-fallback']` → `an unnumbered card prefers the unnumbered row…` red;
  - in `mergeIntoCanonical` (`src/storage/beers.ts`), drop the text comparison from `sameCard` — `const sameCard = source !== undefined && orphan !== undefined;` → the re-staged `#614 writes no alias when the web fallback searched with the text of an orphan another card created` red (an alias row appears);
  - restore all.
- [ ] **Step 5: Gate + commit**

```bash
git add src/storage/beers.ts src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "fix(#636): /enrich picks the row of the pair by the card's digits instead of the first row

findBeerByNormalized(...).get() gave the card 'Trappistes Rochefort 10' the linked row
'Rochefort 6' (468 such pairs on prod), so the card was never searched and a published bid
would repair the wrong row. Rows are now tiered same > year-fallback > number-fallback.
The #614 alias-guard test is re-staged: its scenario depended on this defect.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task P4: `lookupBeer` filters hits by digits before every stage

**Files:** Modify `src/domain/untappd-lookup.ts` (import; `inputDigits`; `matchAgainst` filter), `src/domain/untappd-lookup.test.ts` (new describe; six #613 tests get digit-neutral competitors).

**Why the #613 tests change (measured, see spec):** their `not_found` rested only on a sibling of **another year** creating ambiguity — on `afd54b4` each of the six matches when Algolia returns the right-year candidate alone. The digit filter drops that sibling, so each test now uses a competitor the filter keeps, chosen so that disabling exactly the guard it names turns it red (`~/warsaw-beer-probes/636/mut613-guards.ts`). Live replay of the 183 current `not_found` rows with ≥2 candidates through old and new `lookupBeer` over identical Algolia results: **0 decisions changed** (`lookup-loosening.out`).

- [ ] **Step 1: Save the diff** to `.superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P4.diff`:

```diff
--- a/src/domain/untappd-lookup.ts
+++ b/src/domain/untappd-lookup.ts
@@ -21,6 +21,7 @@
 import { isBlockStatus } from '../sources/untappd/block';
 import { dominantCandidate } from './rating-dominance';
 import { nameIdentity, candidateIdentity, identityAllowsApprox, type NameIdentity } from './name-identity';
+import { digitIdentity, readNameDigits } from './digit-identity';
 
 const NAME_FUZZY_THRESHOLD = 0.85;
 const NEAR_TOKEN_SIM = 0.75;
@@ -471,6 +472,7 @@
     }),
   );
   const targetNames = fuzzyTargets(name, brewery);
+  const inputDigits = readNameDigits(name);
   const parts = brewerySearchParts(brewery);
   const triedUrls: string[] = [];
   const seenCandidates: SearchResult[] = [];
@@ -485,7 +487,19 @@
   // yields nothing. Extracted from the search loop so the query ladder (#382) can iterate
   // rungs without duplicating 130 lines of staging — and so "no match" is a return value
   // rather than a `continue` whose meaning depends on how many loops happen to enclose it.
-  function matchAgainst(results: SearchResult[]): LookupOutcome | null {
+  function matchAgainst(unfiltered: SearchResult[]): LookupOutcome | null {
+    // #636: every stage below reads a normalized name with no digits, so a candidate of another number or
+    // vintage (`Dr.Hazy #7` → `Dr. Hazy #4`, proved live) would pass them all. One filter here, before any pool:
+    // `different` never; `number-fallback` (a number only Untappd writes) only when no better tier is present —
+    // otherwise the search could pick `Juicy Trap #20` where the matcher takes `Juicy Trap`, and merge memory
+    // would keep the search's choice. The unfiltered list stays in seenCandidates as triage evidence.
+    const judged = unfiltered.map((result) => ({
+      result, identity: digitIdentity(inputDigits, readNameDigits(result.beer_name)),
+    }));
+    const betterTier = judged.some((j) => j.identity === 'same' || j.identity === 'year-fallback');
+    const results = judged
+      .filter((j) => j.identity !== 'different' && !(betterTier && j.identity === 'number-fallback'))
+      .map((j) => j.result);
     const identityHits = results.filter((result) =>
       (result.alias_alt ?? []).some((alias) => inputIdentityAliases.has(baseNormalize(alias))),
     );
--- a/src/domain/untappd-lookup.test.ts
+++ b/src/domain/untappd-lookup.test.ts
@@ -1403,39 +1403,48 @@
       expect(out.kind).toBe('not_found');
     });
 
+    // #636: a competitor of ANOTHER year no longer competes — the digit filter drops it before any stage, and the
+    // right-year candidate alone was always accepted (a lone candidate matches on main too). Each guard below is
+    // therefore tested against a competitor the digit filter keeps, chosen so that disabling exactly that guard turns
+    // the test green-to-red (mutation-checked when #636 was written).
+    const sameYearRival = { ...candidates[1], bid: 6852099, abv: 10, global_rating: 3.9, rating_count: 40 };
+    const undatedRival = { ...sameYearRival, beer_name: 'Birthday Cookie: Multi Qlti', abv: 13 };
+
     test.each([
       {
         label: 'missing input year',
         inputName: 'Birthday Cookie MultiQlti 36°',
         candidateName: 'Birthday Cookie: Multi Qlti 2026',
+        competitor: candidates[0],
       },
       {
         label: 'missing candidate year',
         inputName: 'Birthday Cookie MultiQlti 2026 36°',
         candidateName: 'Birthday Cookie: Multi Qlti',
+        competitor: { ...undatedRival, abv: 10 },
       },
-    ])('refuses $label', async ({ inputName, candidateName }) => {
+    ])('refuses $label', async ({ inputName, candidateName, competitor }) => {
       const target = { ...candidates[1], beer_name: candidateName };
       const out = await lookupBeer({
         brewery: 'Funky Fluid X MultiQlti Brewery',
         name: inputName,
         abv: 13,
-        search: fakeSearch(() => [target, candidates[0]]),
+        search: fakeSearch(() => [target, competitor]),
       });
       expect(out.kind).toBe('not_found');
     });
 
     test.each([
-      { label: 'missing input ABV', inputAbv: null, candidateAbv: 13 },
-      { label: 'missing candidate ABV', inputAbv: 13, candidateAbv: null },
-      { label: 'contradictory ABV', inputAbv: 13, candidateAbv: 12.5 },
-    ])('refuses $label', async ({ inputAbv, candidateAbv }) => {
+      { label: 'missing input ABV', inputAbv: null, candidateAbv: 13, competitor: undatedRival },
+      { label: 'missing candidate ABV', inputAbv: 13, candidateAbv: null, competitor: sameYearRival },
+      { label: 'contradictory ABV', inputAbv: 13, candidateAbv: 12.5, competitor: undatedRival },
+    ])('refuses $label', async ({ inputAbv, candidateAbv, competitor }) => {
       const target = { ...candidates[1], abv: candidateAbv };
       const out = await lookupBeer({
         brewery: 'Funky Fluid X MultiQlti Brewery',
         name: 'Birthday Cookie MultiQlti 2026 36°',
         abv: inputAbv,
-        search: fakeSearch(() => [target, candidates[0]]),
+        search: fakeSearch(() => [target, competitor]),
       });
       expect(out.kind).toBe('not_found');
     });
@@ -1445,7 +1454,7 @@
         brewery: 'Funky Fluid',
         name: 'Birthday Cookie MultiQlti 2026 36°',
         abv: 13,
-        search: fakeSearch(() => [candidates[1], candidates[0]]),
+        search: fakeSearch(() => [candidates[1], sameYearRival]),
       });
       expect(out.kind).toBe('not_found');
     });
@@ -1456,7 +1465,7 @@
         brewery: 'Funky Fluid X MultiQlti Brewery',
         name: 'A Birthday Cookie MultiQlti 2026 36°',
         abv: 13,
-        search: fakeSearch(() => [target, candidates[0]]),
+        search: fakeSearch(() => [target, { ...sameYearRival, beer_name: 'B Birthday Cookie: Multi Qlti 2026' }]),
       });
       expect(out.kind).toBe('not_found');
     });
@@ -1863,4 +1872,63 @@
   });
 });
 
+describe('#636 lookupBeer drops candidates of another number or vintage before any stage', () => {
+  const PP = 'Piwne Podziemie / Beer Underground';
+  const hit = (bid: number, beer_name: string, abv: number | null = 6): SearchResult =>
+    ({ bid, beer_name, brewery_name: PP, style: 'IPA - New England / Hazy', abv, global_rating: 3.8 });
+
+  test('another number is refused even when it is the only candidate (live replay: #7 → #4)', async () => {
+    const out = await lookupBeer({
+      brewery: 'Piwne Podziemie Brewery', name: 'Dr.Hazy #7',
+      search: fakeSearch(() => [hit(5899401, 'Dr. Hazy #4')]),
+    });
+    expect(out.kind).toBe('not_found');
+    if (out.kind !== 'not_found') return;
+    // the refused candidate is still triage evidence
+    expect(out.candidates.map((c) => c.bid)).toEqual([5899401]);
+  });
 
+  test('control: the same number still matches', async () => {
+    const out = await lookupBeer({
+      brewery: 'Piwne Podziemie Brewery', name: 'Dr.Hazy #4',
+      search: fakeSearch(() => [hit(5899401, 'Dr. Hazy #4')]),
+    });
+    expect(out.kind).toBe('matched');
+    if (out.kind !== 'matched') return;
+    expect(out.result.bid).toBe(5899401);
+  });
+
+  test('a number only Untappd writes is dropped when an unnumbered candidate exists', async () => {
+    const out = await lookupBeer({
+      brewery: 'Piwne Podziemie Brewery', name: 'Juicy Trap',
+      search: fakeSearch(() => [hit(6625206, 'Juicy Trap #20'), hit(5000001, 'Juicy Trap')]),
+    });
+    expect(out.kind).toBe('matched');
+    if (out.kind !== 'matched') return;
+    expect(out.result.bid).toBe(5000001);
+  });
+
+  test('a number only Untappd writes is accepted when nothing better exists (Few More Beer)', async () => {
+    const out = await lookupBeer({
+      brewery: 'Tankbusters Brewery', name: 'Few More Beers 19°', abv: 8.4,
+      search: fakeSearch(() => [{
+        bid: 6819481, beer_name: 'Few More Beer 004/108', brewery_name: 'TankBusters.Co',
+        style: 'IPA - Imperial / Double New England / Hazy', abv: 8.4, global_rating: 3.9,
+      }]),
+    });
+    expect(out.kind).toBe('matched');
+    if (out.kind !== 'matched') return;
+    expect(out.result.bid).toBe(6819481);
+  });
+
+  test('another vintage is refused', async () => {
+    const out = await lookupBeer({
+      brewery: 'Ziemia Obiecana', name: 'Stan Umysłu 2027',
+      search: fakeSearch(() => [{
+        bid: 6425121, beer_name: 'Stan Umysłu 2025 (Owsianego Rodzaju)', brewery_name: 'Ziemia Obiecana',
+        style: 'Stout - Imperial / Double Oatmeal', abv: 6, global_rating: 3.9,
+      }]),
+    });
+    expect(out.kind).toBe('not_found');
+  });
+});
```

- [ ] **Step 2: Tests first** — `git apply --include='*.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P4.diff`; `npx vitest run src/domain/untappd-lookup.test.ts`. Expected (measured): 3 FAIL — `another number is refused even when it is the only candidate`, `a number only Untappd writes is dropped when an unnumbered candidate exists`, `another vintage is refused`; the #613 tests with new competitors PASS on old code too.
- [ ] **Step 3: Source** — `git apply --exclude='*.test.ts' .superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P4.diff`; `npx vitest run src/domain/untappd-lookup.test.ts src/domain/untappd-lookup.fixtures.test.ts src/domain/untappd-lookup.flagship.test.ts src/domain/untappd-lookup.brewery-typo.test.ts` → PASS (189).
- [ ] **Step 4: Mutations**
  - filter keeps `different` (`j.identity !== 'different' &&` removed) → `another number is refused…` red;
  - `betterTier` forced `false` → `a number only Untappd writes is dropped…` red;
  - `DIR=$PWD/src/domain npx tsx ~/warsaw-beer-probes/636/mut613-guards.ts` → `all guards proven` (it creates and removes its own mutant files; confirm `git status --short` shows only this task's files).
- [ ] **Step 5: Live replay (read-only)** — `OLD=<checkout at afd54b4> NEW=$PWD npx tsx ~/warsaw-beer-probes/636/lookup-loosening.ts 183` (the controller may point OLD at a `git worktree add` of `afd54b4` in the scratchpad). Expected: `not_found->not_found` and `matched->matched` only, no changed line (counts may shift as prod data moves).
- [ ] **Step 6: Gate + commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(#636): the Untappd lookup drops hits of another number or vintage before any stage

Every stage reads a digit-free name, so 'Dr.Hazy #7' matched 'Dr. Hazy #4' live (and '#97'
did too). Hits that are 'different' go; a number only Untappd writes goes when a better tier
is present. The six #613 rescue tests now use competitors the filter keeps — their not_found
rested on another-year siblings; 0 of 183 live not_found replays changed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task P5: `spec.md`, the design doc sentence, the stale comment

**Files:** Modify `spec.md`, `docs/superpowers/specs/2026-09/2026-09-16-636-digit-identity-design.md`, `src/domain/name-identity.test.ts` (comment only).

- [ ] **Step 1: Save and apply** `.superpowers/sdd/2026-09-16-636-digit-identity-periphery/task-P5.diff`:

```diff
--- a/src/domain/name-identity.test.ts
+++ b/src/domain/name-identity.test.ts
@@ -100,8 +100,9 @@
 describe('the vintage partition still sees what it always saw (#505 / #504)', () => {
   test('normalizeName still strips the year, and extractYear still reads the raw name', () => {
     // This test fails the moment someone "simplifies" the identity floor into
-    // normalizeName itself — which would re-poison queries (#295) and move the
-    // input extractYear partitions on (matcher.ts).
+    // normalizeName itself — which would re-poison queries (#295). The matcher no longer
+    // partitions on extractYear (#636 reads years through digit-identity); the collab
+    // rescue in untappd-lookup.ts still does.
     expect(normalizeName('Funky Fluid Tribute To Billie 2024')).toBe('funky fluid tribute to billie');
     expect(extractYear('Funky Fluid Tribute To Billie 2024')).toBe(2024);
   });
--- a/spec.md
+++ b/spec.md
@@ -1050,7 +1050,8 @@
 більше сусідніх токенів кандидата; решта токенів назв збігаються дослівно. Rescue додатково
 вимагає однаковий явний чотиризначний рік, відомий ABV з обох боків у межах
 `ABV_TOLERANCE` і рівно один distinct `bid`. Без будь-якого доказу або за неоднозначності
-результат лишається `not_found`. Rescue уточнює лише наявну термінальну відмову near-name стадії,
+результат лишається `not_found`. Фільтр цифр (#636) стоїть до всіх стадій, тож кандидат іншого року вже не конкурент і не
+робить правильний рік неоднозначним. Rescue уточнює лише наявну термінальну відмову near-name стадії,
 тож не змінює жоден збіг, який уже прийняла чинна стадія, і не змінює `normalizeName`,
 `nameKeys`, fuzzy-пороги чи popularity-resolver.
 Пошуковий запит enrich'у будується щаблями `searchQueryLadder` (#382, детальніше нижче) над
@@ -1083,8 +1084,34 @@
 збіг). Гейт сильніший за звичайний (повна пивоварня присутня + рівність назви), тож тут безпечно
 приймати **однотокенні** назви (`schwarzbrot`), які звичайний `nameKeys` відкидає. Спрацьовує
 лише на промах — exact-кейси, що працюють зараз, не змінюються; заголовки без токенів пивоварні
-взагалі (bare-name крамниці) лишаються fuzzy (окремо, #108). Анкорені рядки проходять ту саму
-ABV/vintage-дизамбіґуацію й повертають `source: 'exact'`.
+взагалі (bare-name крамниці) лишаються fuzzy (окремо, #108). Анкорені рядки проходять той самий
+вибір за цифрами назви й ABV (нижче, #636) і повертають `source: 'exact'`.
+
+**Ідентичність цифр назви (#636).** `normalizeName` викидає цифри, а `stripSearchNoise` — дужки з роками й
+градуси з числом, тож рядки однієї серії (`Juicy Trap #19`/`#20`, `Trappistes Rochefort 6`/`10`,
+`Stary Sad 2023`/`2025`) мають рівний нормалізований ключ. Цифри порівнює одна функція
+`digitIdentity(input, candidate)` (`src/domain/digit-identity.ts`) над `readNameDigits` сирої назви:
+- **читання:** ABV у будь-якому записі (`4'8%`, `5.3 abv`) і обʼєм, приклеєний до одиниці (`0,5l`), не дають
+  чисел; градус `N°`/`N*` — окремо (`grades`); рік `19xx/20xx` скрізь, зокрема в дужках і діапазонах, `'26`/`26'`
+  → `2026`; `N.0` — версія; ціле 8–14 без маркера (`#`, `no.`, `vol.`, `batch`, провідний нуль, `v`) — м'яке;
+  решта — жорсткі числа (`#7`, `vol.4`, `002` = `2`, `10th` = `10`); цифри, приклеєні до слова (`WFP10`), не
+  читаються;
+- **правило:** жорстке число входу, не покрите числом, градусом чи м'яким числом кандидата → `different`
+  (`Funky Monkey #2` → `Funky Monkey`); жорстке число **лише кандидата** → `number-fallback` (Untappd дописує партію,
+  ювілей, варіант колаборації: `Cucumber Gose` → `10th Anniversary #6: Cucumber Gose`), але `different`, якщо вхід
+  має власне непокрите м'яке число чи версію (`Trappistes Rochefort 10` → `6`); градуси й м'які числа самі не
+  розводять, крім випадків, де вони — єдиний носій номера (`KONRAD 12°` → `Konrad Svetlé Výčepní 10`); версії —
+  лише з обох боків; роки — рівні множини з обох боків, з одного боку → `year-fallback`;
+- **рівні:** `same` > `year-fallback` > `number-fallback` > `different`.
+
+Застосування: **точна стадія** відкидає `different`; вхід без року бере серед `same` ∪ `year-fallback` ABV, інакше
+найновіший `id` (як для вінтажів), вхід з роком — `same`, інакше `year-fallback`; `number-fallback` — лише коли обидві
+групи порожні; усі `different` → `null` без fuzzy. **Fuzzy-стадія** відкидає найкращий результат `different`.
+**`lookupBeer`** прибирає кандидатів `different` до будь-якої стадії, а `number-fallback` — коли є кращий рівень
+(нерозфільтрований список лишається доказом у `not_found.candidates`). **`/enrich/*`** обирає рядок пари за тими
+самими рівнями (найстаріший у рівні). **Сироти:** `ensureOrphan` порівнює рівних (тексти крана) — сумісні, якщо
+жоден бік не `different`; резолвлення сироти за bid (`upsertBeerByBid`) приймає лише `same`/`year-fallback` — рядок
+зберігає текст крана (#618), тож `number-fallback` став би ідентичністю назавжди.
 
 **Гейтинг сильних заяв.** Fuzzy-кандидат відхиляється, якщо нормалізована назва
 розходиться з інпутом по контентних токенах (різні смакові варіанти одного базового
@@ -1436,7 +1463,8 @@
 контракт розширення незмінний.
 
 **Картка з аліасом (#614).** `/enrich/candidates` і `/enrich/result` шукають рядок так: аліас картки (той самий
-ключ, що в `/match`) → нормалізована пара → нова сирота. Аліас першим, бо рядок пари може бути близнюком (інше
+ключ, що в `/match`) → рядок нормалізованої пари, обраний за цифрами назви картки (§ «Ідентичність цифр назви», #636)
+→ нова сирота. Аліас першим, бо рядок пари може бути близнюком (інше
 написання чи ABV), і суперечливий bid картки перелінковував би його. Влучання в аліас повертає канонічний рядок і
 **не** створює сироти: сирота з текстом картки підмінила б аліас у `/match`. Такий рядок злінкований, тож без
 bid він не `eligible`. Суперечливий опублікований bid на ньому стосується лише аліасу: `eligible` незалежно від
@@ -1479,7 +1507,7 @@
 пробілом, бо Algolia обнуляє `V S O J`, зате знаходить `VSOJ`, а «склеєний» запис Untappd
 (`Vol.30`) матчиться лише коли запит скидає крапку; (2) зрізає «голий» рік-вінтаж (`19xx/20xx`),
 бо Algolia AND-ить терміни, а Untappd тримає вінтажі в дужках — сам матчер уже трактує рік як
-не-ідентичність (`isNumericNoise`/`extractYear`). Обидва правила **не** в `stripSearchNoise`
+не-ідентичність (рік з одного боку — `year-fallback`, #636). Обидва правила **не** в `stripSearchNoise`
 навмисно: інакше каталоговий `Vol.30` нормалізувався б у `vol30` замість `vol` і впав би нижче
 fuzzy-порогу.
 
@@ -1657,7 +1685,7 @@
 (курсор не чіпає); валідує курсор — не `/^\d+$/` (нечисловий, з пробілами, `0x…`, `5e2`) →
 `400 { error: "bad_cursor" }`; парсить `parseCheckinFeedPage(html)`; на кожен чекін `upsertBeerByBid`
 за **bid** (канонічний `untappd_id`; не знайдено — резолвить **єдину** сироту з тією самою нормалізованою
-парою й сумісними цифровими токенами назви, інакше новий рядок; факти не стираються, назва не змінюється,
+парою й цифрами назви `same`/`year-fallback` щодо назви bid (#636), інакше новий рядок; факти не стираються, назва не змінюється,
 провенанс лише посилюється, #617) → локальний
 `beers.id`, далі `mergeCheckin` (ідемпотентно за `UNIQUE(telegram_id, checkin_id)`); зливає
 доведений діапазон сторінки в `checkin_coverage` (§3.15) і оновлює `checkin_sync_state.profile_total`
@@ -1827,8 +1855,8 @@
 той самий чанк-білд (одноразовий, без інкрементального add).
 
 **Сирота при промаху матчера (#617).** Промах іде в `ensureOrphan`: вона шукає за нормалізованою парою
-**лише серед сиріт із сумісними цифровими токенами назви** (те саме правило, що для резолвлення сироти
-за bid) і злінкованого рядка не торкається ніколи — кран іншого вінтажу, якого матчер свідомо не
+**лише серед сиріт із сумісними цифрами назви** — порівняння рівних, жоден бік не `different` (#636,
+`digitsCompatibleAsPeers`) — і злінкованого рядка не торкається ніколи — кран іншого вінтажу, якого матчер свідомо не
 зматчив, дає нову сироту, а не перейменування злінкованого рядка чи приліплення до сироти іншого року.
 Факти наявної сироти не переписуються. Відоме обмеження: сироти з однаковою нормалізованою назвою й
 сумісними цифрами злипаються (напр. різниця лише в ABV).
@@ -1909,7 +1937,13 @@
   мітка одразу після spec-блоку, якщо вона є (`Oxymel 14°·4,5% — Sour Ale` → `Oxymel 14°`,
   так само, як робив старий парсер). Пошук працює в обидві сторони:
   `cleanSearchQuery`/`normalizeName` градус прибирають, а стадія czech-grade (#321) читає
-  його з сирої назви через `extractGrade`.
+  його з сирої назви через `extractGrade`. Для ідентичності (#636) градус **м'який**: сам пиво не розводить
+  (`Pils 12°` ↔ `Pils`, `Białe IPA 16°` ↔ `14°`), лише покриває число з іншого боку (`Otakar 11°` ↔ `Otakar 11`).
+- **Одна ідентичність цифр назви (#636).** Будь-яке місце, що читає нормалізований ключ як ідентичність пива
+  (матчер, `/enrich/*`, сироти, `lookupBeer`), питає `digitIdentity(input, candidate)`, а не порівнює цифри саме:
+  жорстке число входу без пари в кандидата — інше пиво; число лише кандидата — запасний рівень; тексти двох кранів
+  порівнюються як рівні. Латка цифр в окремому місці — порушення (так правило вже опинялось лише в одному з п'яти,
+  #617).
 - **Ідентичність, здобута merge-ом, переживає повторний інжест, але поступається матчеру
   (#366).** `merged_at` ставить лише `mergeIntoCanonical`; будь-який запис матчера
   (`upsertMatch`) його скидає. Довіряти штампу лише поки ціль існує і має `beers.untappd_id` —
--- a/docs/superpowers/specs/2026-09/2026-09-16-636-digit-identity-design.md
+++ b/docs/superpowers/specs/2026-09/2026-09-16-636-digit-identity-design.md
@@ -163,8 +163,9 @@
 3. **`ensureBeerRow`.** Після аліаса (#614, без змін) — усі рядки пари `(normalized_brewery, normalized_name)`,
    картка — `input`, рядок — `candidate`; відкинути `different`, далі `same` > `year-fallback` > `number-fallback`,
    далі найменший `id` (детермінізм замість
-   порядку `.get()`). Немає сумісного — `ensureOrphan`. `findBeerByNormalized` (єдиний виклик — `enrich.ts`)
-   замінюється на `listBeersByNormalized`, що повертає всі рядки пари; вибір робить `ensureBeerRow`.
+   порядку `.get()`). Немає сумісного — `ensureOrphan`. У `enrich.ts` `findBeerByNormalized` замінюється
+   на `listBeersByNormalized`, що повертає всі рядки пари; вибір робить `ensureBeerRow`. Сама `findBeerByNormalized`
+   лишається — її як помічника читають тести (`enrich.test.ts`, `beers.test.ts`), у продакшн-коді викликів немає.
 4. **`ensureOrphan` / `resolvableOrphan`.** Замість `numericTokensCompatible`:
    - `ensureOrphan` порівнює **рівних** — новий текст крана з текстом наявної сироти (обидва — вхідний текст, жоден не
      з Untappd), тож ролей немає: сумісні, лише якщо `digitIdentity` **в обидва боки** не `different` (номер з
```

- [ ] **Step 2: Check** `grep -n "numericTokens\|сумісними цифровими токенами\|vintage-дизамбіґуацію" spec.md` → no hits. Read the new «Ідентичність цифр назви (#636)» paragraph against `digit-identity.ts` once more; any mismatch is fixed in the spec text, not the code.
- [ ] **Step 3: Extension docs** — the change touches no `extension/**` file: `git diff --stat origin/main...HEAD -- extension docs/extension-install-uk.md` must be empty.
- [ ] **Step 4: Gate + commit**

```bash
git add spec.md docs/superpowers/specs/2026-09/2026-09-16-636-digit-identity-design.md src/domain/name-identity.test.ts
git commit -m "docs(#636): spec.md documents the digit identity once and points every section at it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task P6: final whole-branch verification and review (dispatched)

- [ ] **Step 1: Prod verification, read-only**
  - `SYM=<scratch symmetric module dir> ASYM=$PWD npx tsx ~/warsaw-beer-probes/636/verify-asym.ts` → tallies unchanged from the asymmetric core plan (P1–P4 do not touch `digitIdentity`);
  - ingest replay main vs branch (`replay-ingest-links.ts`, back to back) → same diff as `…-core-asymmetric/replay-diff-asym.txt` (P1–P4 change no matcher code).
- [ ] **Step 2: Final review** — package `review-package <this plan> 4494ed7 HEAD` (whole branch); dispatch on the most capable model with the spec, all three plans, the three ledgers' parked/deferred lines, the replay and verification outputs, stating: *every task in all three plans was executed inline by the controller; per-task reviews happened only at the core and asymmetric-core stages.* Ask for: role mistakes at call sites; a place that still reads the normalized key as identity without the rule (`grep -rn "normalized_name = ?" src`); vacuous tests; spec.md vs code.
- [ ] **Step 3: One fix wave** for findings (inline or dispatched per size), one scoped re-review, rulings for residuals.
- [ ] **Step 4: Pre-PR (CLAUDE.md):** `git fetch origin main` (on the #583 rate-limit error use the documented `http.extraHeader` form); `git rebase origin/main` if it moved; full gate again.
- [ ] **Step 5: Stop and report** to the user: branch summary, rulings list, the deploy checklist (spec «Спостереження після деплою»: snapshot of auto links before deploy; checkpoint after the first ingest). Push, PR and deploy only on the user's OK.
