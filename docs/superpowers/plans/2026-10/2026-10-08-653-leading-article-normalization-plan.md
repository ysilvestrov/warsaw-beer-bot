# #653 Leading Article Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize leading grammatical article `The` in beer names when the remaining name retains $\ge 2$ tokens, rescuing orphan row 37244 (*The Stonewall Inn IPA*) and reconciling article divergence across shop and Untappd variants.

**Architecture:** Extend `normalizeName()` in `src/domain/normalize.ts` to drop leading `the` when `tokens.length >= 3`, ensuring short 2-token names (*The Alchemist*) and mid-title phrases (*Eye of the Tiger*) are preserved. Add corresponding guard in `stripBreweryFromName()` in `src/domain/style-identity.ts` for names with prepended brewery brands. Document behavior in `spec.md` under §3.1 and verify adjudication on row 37244.

**Tech Stack:** TypeScript, Node.js, Vitest, SQLite.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-653-leading-article-normalization-design.md`

## Global Constraints

- Never drop `the` from 2-token names (`The Alchemist`, `The End`) — they must retain both tokens to avoid collapsing into weak single-token keys.
- Never drop `the` when it would leave an empty string (e.g. style-only tail `The IPA`).
- Never drop `the` occurring in the middle of a title (`Eye of the Tiger`, `Son Of The Son`).
- Do not modify `ABV_TOLERANCE` (0.3%).
- Adjudicate row 37244 via live Algolia probe before marking issue resolved.

## Review Focus

1. **Short 2-token name preservation:** `normalizeName('The Alchemist')` must produce `'the alchemist'`, not `'alchemist'`.
2. **Style-filtered single-token preservation:** `normalizeName('The IPA')` must produce `'the'`, not `''`.
3. **Mid-title phrase preservation:** `normalizeName('Eye of the Tiger')` must produce `'eye of the tiger'`.
4. **Prepended brewery brand handling:** `stripBreweryFromName('brooklyn the stonewall inn', 'brooklyn')` must produce `'stonewall inn'`.
5. **Exact Stage 2a resolution:** Input `Brooklyn Brewery / Brooklyn Stonewall Inn IPA 10,6°` @ 4.6% ABV must match candidate `The Stonewall Inn IPA Session IPA` @ 4.6% ABV or `The Stonewall Inn IPA` @ 4.0% ABV without contradiction veto.

---

### Task 1: Leading Article Normalization in `normalizeName` and `stripBreweryFromName`

**Files:**
- Modify: `src/domain/normalize.ts:174-179`
- Modify: `src/domain/style-identity.ts:21-24`
- Test: `src/domain/normalize.test.ts`
- Test: `src/domain/style-identity.test.ts`

- [ ] **Step 1: Write failing unit tests in `src/domain/normalize.test.ts`**

Add tests under a dedicated `describe('#653 leading article normalization', ...)` block:
```ts
describe('#653 leading article normalization', () => {
  test('strips leading "the" when remaining tokens >= 2', () => {
    expect(normalizeName('The Stonewall Inn IPA')).toBe('stonewall inn');
    expect(normalizeName('The Good Cider Pear')).toBe('good cider pear');
    expect(normalizeName('The Real Hr. Frederiksen')).toBe('real hr frederiksen');
  });

  test('preserves leading "the" when remaining tokens < 2', () => {
    expect(normalizeName('The Alchemist')).toBe('the alchemist');
    expect(normalizeName('The End')).toBe('the end');
    expect(normalizeName('The Abyss')).toBe('the abyss');
    expect(normalizeName('The IPA')).toBe('the');
  });

  test('preserves "the" in the middle of phrases', () => {
    expect(normalizeName('Eye of the Tiger')).toBe('eye of the tiger');
    expect(normalizeName('Son Of The Son')).toBe('son of the son');
    expect(normalizeName('Two on the road')).toBe('two on the road');
  });
});
```

- [ ] **Step 2: Run Vitest to verify the tests fail**

Run `npm test -- src/domain/normalize.test.ts` and confirm failure on `The Stonewall Inn IPA`.

- [ ] **Step 3: Implement leading `the` stripping in `src/domain/normalize.ts`**

In `src/domain/normalize.ts`:
```ts
export function normalizeName(s: string): string {
  const tokens = baseNormalize(preserveDecimalIdentifiers(stripSearchNoise(s)))
    .split(' ')
    .filter((t) => t && !STYLE_WORDS.has(t) && !SPEC_LABEL_WORDS.has(t) && !isNumericNoise(t));
  if (tokens.length >= 3 && tokens[0] === 'the') {
    tokens.shift();
  }
  return tokens.join(' ');
}
```

- [ ] **Step 4: Update `stripBreweryFromName` in `src/domain/style-identity.ts` and add tests**

In `src/domain/style-identity.ts`:
```ts
  while (nt.length > 1 && BREWERY_NOISE.has(nt[0])) nt.shift();
  while (nt.length > 1 && BREWERY_NOISE.has(nt[nt.length - 1])) nt.pop();
  if (nt.length >= 3 && nt[0] === 'the') nt.shift();
  return nt.join(' ');
```

In `src/domain/style-identity.test.ts`, add:
```ts
  it('strips leading "the" after brewery brand stripping when remainder >= 2 tokens (#653)', () => {
    expect(stripBreweryFromName('brooklyn the stonewall inn', 'brooklyn')).toBe('stonewall inn');
    expect(stripBreweryFromName('brooklyn the end', 'brooklyn')).toBe('the end');
  });
```

- [ ] **Step 5: Run tests and verify they pass**

Run `npm test -- src/domain/normalize.test.ts src/domain/style-identity.test.ts` to confirm green assertions.

- [ ] **Step 6: Commit changes**

Commit with message: `fix(normalize): strip leading "the" from beer names when remainder has >= 2 tokens (#653)`

---

### Task 2: Lookup Integration Tests, Spec Update, and Adjudication

**Files:**
- Modify: `src/domain/untappd-lookup.test.ts`
- Modify: `spec.md`
- Run: `npm run adjudicate -- --issue 653`

- [ ] **Step 1: Write integration tests in `src/domain/untappd-lookup.test.ts`**

Add tests under `#653 leading article resolution`:
```ts
  describe('#653 leading article resolution', () => {
    test('matches input without "the" to candidate with leading "the"', async () => {
      const search: BeerSearch = {
        search: async () => [{
          bid: 2885563,
          beer_name: 'The Stonewall Inn IPA',
          brewery_name: 'Brooklyn Brewery',
          style: 'IPA - Session',
          abv: 4.0,
          global_rating: 3.46,
        }],
      };

      const out = await lookupBeer({
        brewery: 'Brooklyn Brewery',
        name: 'Brooklyn Stonewall Inn IPA 10,6°',
        abv: 4.0,
        search,
      });

      expect(out.kind).toBe('matched');
      assert(out.kind === 'matched');
      expect(out.result.bid).toBe(2885563);
    });

    test('prefers exact ABV candidate when multiple leading "the" variants exist', async () => {
      const search: BeerSearch = {
        search: async () => [
          {
            bid: 2885563,
            beer_name: 'The Stonewall Inn IPA',
            brewery_name: 'Brooklyn Brewery',
            style: 'IPA - Session',
            abv: 4.0,
            global_rating: 3.46,
          },
          {
            bid: 6992173,
            beer_name: 'The Stonewall Inn IPA Session IPA',
            brewery_name: 'Brooklyn Brewery',
            style: 'IPA - Session',
            abv: 4.6,
            global_rating: null,
          },
        ],
      };

      const out = await lookupBeer({
        brewery: 'Brooklyn Brewery',
        name: 'Brooklyn Stonewall Inn IPA 10,6°',
        abv: 4.6,
        search,
      });

      expect(out.kind).toBe('matched');
      assert(out.kind === 'matched');
      expect(out.result.bid).toBe(6992173);
    });
  });
```

- [ ] **Step 2: Update `spec.md` under §3.1**

Document the rule:
"**Нормалізація провідного артикля (#653).** `normalizeName()` відкидає провідний артикль `the` (`^the\\s+`), якщо після фільтрації стильових слів і шуму в назві залишається $\\ge 2$ значущих токенів. Це забезпечує точний збіг у `nameKeys` (Stage 2a) для назв, де крамниця або Untappd опускає чи додає початковий артикль (*Stonewall Inn IPA* $\\leftrightarrow$ *The Stonewall Inn IPA*). Короткі двотокенні назви (*The Alchemist*, *The End*) та назви з артиклем усередині фрази (*Eye of the Tiger*) зберігають `the` незмінним."

- [ ] **Step 3: Run full gate in worktree**

Run `npm test && npm run typecheck` to verify zero regressions.

- [ ] **Step 4: Live adjudication probe of issue #653**

Run:
`DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db node --env-file=.env node_modules/.bin/tsx scripts/adjudicate-runner.ts --issue 653`
Verify row 37244 evaluates as `rescued`.

- [ ] **Step 5: Commit changes**

Commit with message: `feat(lookup): reconcile leading article differences in same-brewery beer names (#653)`
