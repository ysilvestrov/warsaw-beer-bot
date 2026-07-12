# Shared Structural-Noise Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make match-name normalization share the structural-noise stripping used by search, and provide a safe operator command to re-arm existing candidate-present matcher failures.

**Architecture:** `normalizeName()` will call the existing `stripSearchNoise()` helper before its current decimal and token normalization, so every exact, key, and fuzzy caller inherits one symmetric policy. A separate dry-run-first CLI will select the issue's reviewed failure class from `beers` joined to `enrich_failures` and reuse the existing transactional `applyRearm()` helper.

**Tech Stack:** Node.js 20+, TypeScript strict mode, Vitest, better-sqlite3, tsx.

**Design:** `docs/superpowers/specs/2026-07-11-normalize-search-noise-design.md`

---

## File map

- Modify `src/domain/normalize.ts` — apply the shared structural strip inside `normalizeName()` and complete quote/trailing-punctuation stripping in `stripSearchNoise()`.
- Modify `src/domain/normalize.test.ts` — focused normalization regressions and preservation guards.
- Modify `src/domain/untappd-lookup.test.ts` — end-to-end candidate-present regressions, including 12082.
- Create `scripts/rearm-matcher-bug-orphans.ts` — select reviewed candidate-present matcher failures and expose a dry-run/apply CLI.
- Create `scripts/rearm-matcher-bug-orphans.test.ts` — selection, exclusion, reset, and idempotency coverage.
- Modify `package.json` — expose the operator command.
- Modify `spec.md` — document shared normalization and targeted re-arm behavior.

### Task 1: Share structural-noise stripping with match normalization

**Files:**
- Modify: `src/domain/normalize.test.ts`
- Modify: `src/domain/untappd-lookup.test.ts`
- Modify: `src/domain/normalize.ts`

- [ ] **Step 1: Add failing normalization tests**

Add this block to `src/domain/normalize.test.ts` after the existing basic `normalizeName` tests:

```ts
describe('normalizeName structural search noise (#269)', () => {
  test.each([
    ['Nonalco Matcha IPA (puszka)', 'nonalco matcha'],
    ['Free Pan Da (puszka)', 'free pan da'],
    ['Ole! (puszka)', 'ole'],
    ['Jubilance (Pure Bedlam Collab)', 'jubilance'],
    ['Wonders [passionfruit, banana]', 'wonders'],
    ['NoLo – Hemperor <0,5% alc <0,5%', 'nolo hemperor'],
    ['“Jubilance”.', 'jubilance'],
  ])('normalizes %s to the clean match key', (raw, expected) => {
    expect(normalizeName(raw)).toBe(expected);
  });

  test('applies the same normalization to noisy and clean names', () => {
    expect(normalizeName('Jubilance (Pure Bedlam Collab)'))
      .toBe(normalizeName('Jubilance'));
  });

  test('preserves an internal colon and decimal release identifier', () => {
    expect(normalizeName('Dynaboost: Mosaic 9.0')).toBe('dynaboost mosaic 9.0');
  });

  test('preserves a digit-bearing compact parenthetical identifier', () => {
    expect(stripSearchNoise('Festweisse (TAP04)')).toBe('Festweisse TAP04');
    expect(normalizeName('Festweisse (TAP04)')).toBe('festweisse tap04');
    expect(stripSearchNoise('Imperial Stout (BBA)')).toBe('Imperial Stout');
  });
});
```

Extend the existing `describe('stripSearchNoise', ...)` block with:

```ts
test('removes wrapping quote marks and trailing punctuation', () => {
  expect(stripSearchNoise('“Jubilance”.')).toBe('Jubilance');
  expect(stripSearchNoise('"Free Pan Da"!')).toBe('Free Pan Da');
});

test('preserves internal punctuation in an ordinary name', () => {
  expect(stripSearchNoise('Dynaboost: Mosaic')).toBe('Dynaboost: Mosaic');
});
```

- [ ] **Step 2: Run the focused normalization tests and verify RED**

Run:

```bash
npx vitest run src/domain/normalize.test.ts
```

Expected: FAIL because parenthetical/bracketed groups still survive `normalizeName()`, and `stripSearchNoise()` still leaves wrapping quotes/trailing punctuation.

- [ ] **Step 3: Add failing lookup regressions**

In `src/domain/untappd-lookup.test.ts`, add a new describe block using the file's existing `fakeSearch` helper:

```ts
describe('structural name noise (#269)', () => {
  test.each([
    ['NEPOMUCEN', 'Nonalco Matcha IPA (puszka)', 'Nonalco Matcha IPA', 30278],
    ['Browar Stu Mostów', 'Free Pan Da (puszka)', 'Free Pan Da', 30277],
    ['Browar Stu Mostów', 'Ole! (puszka)', 'Ole!', 30276],
    ['StarKraft', 'Jubilance (Pure Bedlam Collab)', 'Jubilance', 30294],
  ])('matches %s / %s to its clean candidate', async (brewery, inputName, candidateName, bid) => {
    const search = fakeSearch(() => [{
      bid,
      beer_name: candidateName,
      brewery_name: brewery,
      style: 'IPA',
      abv: 5,
      global_rating: 3.5,
    }]);
    const out = await lookupBeer({ brewery, name: inputName, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(bid);
  });

  test('12082 passes the existing bilingual brewery alias gate', async () => {
    const search = fakeSearch(() => [{
      bid: 12082,
      beer_name: 'NoLo – Hemperor',
      brewery_name: 'Piwne Podziemie / Beer Underground',
      style: 'Non-Alcoholic Beer - IPA',
      abv: 0.5,
      global_rating: 3.5,
    }]);
    const out = await lookupBeer({
      brewery: 'Piwne Podziemie Brewery',
      name: 'NoLo – Hemperor <0,5% alc <0,5%',
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(12082);
  });
});
```

- [ ] **Step 4: Run the focused lookup tests and verify RED**

Run:

```bash
npx vitest run src/domain/untappd-lookup.test.ts
```

Expected: the four parenthetical-noise rows FAIL as `not_found`; the 12082 regression already passes, confirming the brewery gate is not the blocker.

- [ ] **Step 5: Implement the minimal shared normalization**

In `src/domain/normalize.ts`, change `normalizeName()` to:

```ts
export function normalizeName(s: string): string {
  const tokens = baseNormalize(preserveDecimalIdentifiers(stripSearchNoise(s)))
    .split(' ')
    .filter((t) => t && !STYLE_WORDS.has(t) && !SPEC_LABEL_WORDS.has(t) && !isNumericNoise(t));
  return tokens.join(' ');
}
```

At the end of the existing replacement chain in `stripSearchNoise()`, before whitespace collapse, add only these two replacements:

```ts
    .replace(/["“”„]/g, ' ')                       // wrapping/display quote marks
    .replace(/[.!?,;:]+\s*$/g, ' ')                // trailing punctuation only
```

Do not strip apostrophes globally and do not strip internal punctuation.
Descriptive parenthetical structural groups (packaging, collaboration, and
batch prose) are removed, but preserve compact parenthetical identifiers with
no whitespace and at least one digit, such as `(TAP04)`, by unwrapping the
parentheses. Letter-only groups such as `(BBA)` are stripped. This keeps the
existing name-key identity behavior intact without preserving packaging labels.
When cleaned name, cleaned brewery, and deduplicated output are all empty, retain
the raw name solely as a last-resort non-empty search-query fallback.

- [ ] **Step 6: Run focused and matcher regression tests and verify GREEN**

Run:

```bash
npx vitest run src/domain/normalize.test.ts src/domain/untappd-lookup.test.ts src/domain/matcher.test.ts
```

Expected: all three test files pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(matcher): share structural noise normalization (#269)"
```

### Task 2: Add the targeted matcher-failure re-arm command

**Files:**
- Create: `scripts/rearm-matcher-bug-orphans.test.ts`
- Create: `scripts/rearm-matcher-bug-orphans.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing selection and reset tests**

Create `scripts/rearm-matcher-bug-orphans.test.ts` with an in-memory migrated database. Reuse the existing test conventions from `scripts/rearm-aliased-orphans.test.ts` and seed complete `beers` plus `enrich_failures` rows:

```ts
import { describe, it, expect } from 'vitest';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { normalizeName, normalizeBrewery } from '../src/domain/normalize';
import { selectRearmTargets, applyRearm } from './rearm-matcher-bug-orphans';

function fresh(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seed(
  db: DB,
  id: number,
  options: {
    untappdId?: number | null;
    lookupCount: number;
    reviewClass: 'matcher_bug' | 'parser_bug' | 'not_on_untappd' | 'wontfix';
    candidatesCount: number;
  },
): void {
  const name = `Beer ${id}`;
  const brewery = `Brewery ${id}`;
  db.prepare(`INSERT INTO beers
    (id, untappd_id, name, brewery, normalized_name, normalized_brewery,
     untappd_lookup_at, untappd_lookup_count)
    VALUES (?, ?, ?, ?, ?, ?, '2026-07-11T00:00:00.000Z', ?)`)
    .run(id, options.untappdId ?? null, name, brewery,
      normalizeName(name), normalizeBrewery(brewery), options.lookupCount);
  db.prepare(`INSERT INTO enrich_failures
    (beer_id, brewery, name, search_url, source_url, outcome,
     candidates_count, candidates_summary, fail_count, last_at, review_class)
    VALUES (?, ?, ?, 'https://example.test', '', 'not_found', ?, 'candidate', 1,
            '2026-07-11T00:00:00.000Z', ?)`)
    .run(id, brewery, name, options.candidatesCount, options.reviewClass);
}

describe('selectRearmTargets', () => {
  it('selects only attempted orphan matcher bugs with candidates', () => {
    const db = fresh();
    seed(db, 1, { lookupCount: 4, reviewClass: 'matcher_bug', candidatesCount: 1 });
    seed(db, 2, { lookupCount: 4, reviewClass: 'matcher_bug', candidatesCount: 0 });
    seed(db, 3, { lookupCount: 4, reviewClass: 'parser_bug', candidatesCount: 1 });
    seed(db, 4, { lookupCount: 0, reviewClass: 'matcher_bug', candidatesCount: 1 });
    seed(db, 5, { untappdId: 500, lookupCount: 4, reviewClass: 'matcher_bug', candidatesCount: 1 });
    expect(selectRearmTargets(db).map((row) => row.id)).toEqual([1]);
  });
});

describe('applyRearm', () => {
  it('resets lookup state transactionally and is idempotent', () => {
    const db = fresh();
    seed(db, 1, { lookupCount: 4, reviewClass: 'matcher_bug', candidatesCount: 1 });
    const targets = selectRearmTargets(db);
    expect(applyRearm(db, targets)).toBe(1);
    const row = db.prepare(
      'SELECT untappd_lookup_count AS count, untappd_lookup_at AS at FROM beers WHERE id = 1',
    ).get() as { count: number; at: string | null };
    expect(row).toEqual({ count: 0, at: null });
    expect(selectRearmTargets(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the script test and verify RED**

Run:

```bash
npx vitest run scripts/rearm-matcher-bug-orphans.test.ts
```

Expected: FAIL because `scripts/rearm-matcher-bug-orphans.ts` does not exist.

- [ ] **Step 3: Implement the focused script**

Create `scripts/rearm-matcher-bug-orphans.ts`:

```ts
import 'dotenv/config';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { loadEnv } from '../src/config/env';
import { applyRearm, type RearmTarget } from './rearm-aliased-orphans';

export { applyRearm } from './rearm-aliased-orphans';

export function selectRearmTargets(db: DB): RearmTarget[] {
  return db.prepare(
    `SELECT b.id, b.brewery, b.name, b.untappd_lookup_count
       FROM beers b
       JOIN enrich_failures ef ON ef.beer_id = b.id
      WHERE b.untappd_id IS NULL
        AND b.untappd_lookup_count > 0
        AND ef.review_class = 'matcher_bug'
        AND ef.candidates_count > 0
      ORDER BY b.id`,
  ).all() as RearmTarget[];
}

function main(argv: string[]): void {
  const apply = argv.includes('--apply');
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    const targets = selectRearmTargets(db);
    for (const target of targets) {
      console.log(`${target.brewery} / ${target.name} (count=${target.untappd_lookup_count})`);
    }
    if (apply) {
      console.log(`Re-armed ${applyRearm(db, targets)} matcher-bug orphan(s).`);
    } else {
      console.log(
        `${targets.length} matcher-bug orphan(s) would be re-armed ` +
        '(dry-run; pass --apply to write).',
      );
    }
  } finally {
    db.close();
  }
}

if (require.main === module) main(process.argv.slice(2));
```

- [ ] **Step 4: Add the npm command**

Add this entry to `package.json` scripts, preserving valid JSON and the existing command order:

```json
"rearm-matcher-bug-orphans": "tsx scripts/rearm-matcher-bug-orphans.ts"
```

- [ ] **Step 5: Run focused tests and typecheck and verify GREEN**

Run:

```bash
npx vitest run scripts/rearm-matcher-bug-orphans.test.ts scripts/rearm-aliased-orphans.test.ts
npm run typecheck
```

Expected: both script test files pass and TypeScript reports no errors.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/rearm-matcher-bug-orphans.ts scripts/rearm-matcher-bug-orphans.test.ts package.json
git commit -m "feat(ops): re-arm candidate-present matcher failures (#269)"
```

### Task 3: Update the primary specification and verify the complete change

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document the normalization invariant**

In the matcher/enrichment section of `spec.md` near the existing description of
`normalizeName`, `cleanSearchQuery`, and the fuzzy/name-key paths, add this exact
behavioral requirement in Ukrainian, matching the surrounding language:

```md
**Спільне очищення структурного шуму (#269).** `normalizeName()` перед базовою
нормалізацією застосовує той самий `stripSearchNoise()`, що й
`cleanSearchQuery()`: прибирає `[...]`, описові `(...)` з пакувальним,
collab- або batch-текстом, випадкові дужки, ABV/°/alc/abv/ibu,
обгорткові лапки та кінцеву пунктуацію. Правило симетрично застосовується до
вхідної й каталогової назви, тому кандидат, знайдений очищеним Algolia-запитом,
не відхиляється exact/name-key/fuzzy етапом лише через цей шум. Компактні
ідентифікатори без пробілів, що містять хоча б одну цифру, наприклад
`(TAP04)`, зберігаються без дужок; літерні групи на кшталт `(BBA)` видаляються.
Сира назва використовується лише як останній non-empty fallback, якщо структурна
очистка спорожнила назву і не лишила очищеної броварні.
```

- [ ] **Step 2: Document the operator re-arm command**

In the operational orphan-enrichment/backoff section, add:

```md
Після matcher-виправлення оператор запускає
`npm run rearm-matcher-bug-orphans` (dry-run), перевіряє список і повторює з
`-- --apply`. Команда скидає backoff лише для незматчених, уже випробуваних
`enrich_failures` з `review_class='matcher_bug'` і `candidates_count > 0`; вона не
робить Untappd-запитів, а лише повертає рядки у звичайну enrich-чергу.
```

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: 104 or more test files pass, 1,059 or more tests pass, typecheck is clean,
and `git diff --check` prints nothing.

- [ ] **Step 4: Commit Task 3**

```bash
git add spec.md
git commit -m "docs(spec): define shared matcher noise stripping (#269)"
```

### Task 4: Final branch review

**Files:**
- Review all files changed since `main`.

- [ ] **Step 1: Inspect the final diff and commit list**

Run:

```bash
git diff main...HEAD --stat
git log --oneline main..HEAD
```

Expected: only the design, plan, normalization/tests, targeted script/tests,
`package.json`, and `spec.md` are present.

- [ ] **Step 2: Run final verification from a clean status**

Run:

```bash
git status --short
npm test
npm run typecheck
```

Expected: clean worktree, all tests passing, and no type errors.

- [ ] **Step 3: Review against issue #269**

Confirm all of the following without making unrelated changes:

- search and match share `stripSearchNoise()` through `normalizeName()`;
- the four reported examples resolve to clean candidates;
- 12082 is covered as an already-working brewery-gate regression;
- re-arm targets exactly reviewed `matcher_bug` rows with candidates and prior attempts;
- the operator command is dry-run by default and `--apply` is transactional/idempotent;
- no extension changelog change is included.
