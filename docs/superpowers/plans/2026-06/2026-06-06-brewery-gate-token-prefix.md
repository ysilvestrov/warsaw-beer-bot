# Brewery-gate Token-Prefix Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match beers when ontap.pl uses a bare brand + generic suffix ("Harpagan Brewery") while Untappd registers a longer official name ("Harpagan Contracts"), by replacing the exact-equality brewery hard-gate with a token-boundary prefix gate.

**Architecture:** A shared `breweryAliasesMatch` predicate (token-boundary prefix, either direction) replaces exact alias-set membership in both the local matcher and the online lookup. `normalize.ts` gains a `contracts` noise word and a `stripLegalForm` step. A one-time startup backfill recomputes the stored `normalized_brewery` idempotency key so it stays consistent with the new normalization rules.

**Tech Stack:** Node.js, TypeScript, Jest, better-sqlite3, fast-fuzzy.

---

## Design reference

Spec: `docs/superpowers/specs/2026-06-06-brewery-gate-token-prefix-design.md`

## Background facts the engineer needs

- `normalizeBrewery(s)` lowercases, strips diacritics/punctuation, drops `BREWERY_NOISE`
  words and pure-digit tokens, returns a space-joined token string.
- `breweryAliases(brewery)` returns a **string array** of normalized aliases (handles
  `/`, `x`, `&` collab separators and `(…)` paren aliases). For a plain brewery it
  returns a single-element array, e.g. `breweryAliases('Pinta') === ['pinta']`.
- The brewery check is a **hard gate**; whatever passes it is then filtered by a
  beer-name fuzzy match ≥ 0.85. That fuzzy gate is the false-positive backstop and
  stays unchanged.
- `idx_beers_norm(normalized_brewery, normalized_name)` is a **non-UNIQUE** index, so
  recomputing `normalized_brewery` cannot raise a UNIQUE constraint even when two rows
  collapse to the same key. The only UNIQUE column on `beers` is `untappd_id`.
- Run all commands from repo root `/home/ysi/warsaw-beer-bot`. Test runner: `npx jest`.

---

## Task 1: normalize.ts — `contracts` noise + legal-form stripping

**Files:**
- Modify: `src/domain/normalize.ts`
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/normalize.test.ts`:

```typescript
import { stripLegalForm } from './normalize';

describe('contracts noise word', () => {
  test('drops "contracts" so official-suffix collapses to the brand', () => {
    expect(normalizeBrewery('Harpagan Contracts')).toBe('harpagan');
  });
});

describe('stripLegalForm', () => {
  test('removes Sp. z o.o. and dotted/spacing variants', () => {
    expect(stripLegalForm('Browar X Sp. z o.o.')).toBe('Browar X');
    expect(stripLegalForm('Browar X Sp.z o.o.')).toBe('Browar X');
    expect(stripLegalForm('Browar X Sp. z o. o.')).toBe('Browar X');
  });

  test('removes S.A.', () => {
    expect(stripLegalForm('Żywiec S.A.')).toBe('Żywiec');
  });

  test('leaves non-legal text untouched', () => {
    expect(stripLegalForm('Harpagan Contracts')).toBe('Harpagan Contracts');
  });
});

describe('normalizeBrewery with legal forms', () => {
  test('strips legal form before tokenizing', () => {
    expect(normalizeBrewery('Browar X Sp. z o.o.')).toBe('x'); // "browar" is noise
  });

  test('does not clobber standalone z / o tokens', () => {
    expect(normalizeBrewery('Pinta z Warszawy')).toBe('pinta z warszawy');
    expect(normalizeBrewery('Browar O Beczki')).toBe('o beczki');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/domain/normalize.test.ts`
Expected: FAIL — `stripLegalForm` is not exported / `normalizeBrewery('Harpagan Contracts')` returns `'harpagan contracts'`.

- [ ] **Step 3: Implement**

In `src/domain/normalize.ts`, add `'contracts'` to the `BREWERY_NOISE` set (English/Polish line):

```typescript
const BREWERY_NOISE = new Set([
  // English / Polish
  'browar', 'browary', 'brewery', 'brewing', 'co', 'company', 'contracts',
  // Czech / Slovak, German, French, Italian, Dutch/Flemish,
  // Scandinavian (+ definite form), Spanish (post-diacritic-strip form)
  'pivovar', 'pivovary', 'brauerei', 'brasserie', 'birrificio',
  'brouwerij', 'bryggeri', 'bryggeriet', 'cerveceria',
]);
```

Add `stripLegalForm` after `baseNormalize` (it operates on the raw string, before
tokenization, so we never have to denylist the bare letters `z`/`o`/`a`):

```typescript
// Legal-entity suffixes carry no brand meaning. Stripped from the RAW brewery
// string before tokenization so we never denylist the bare letters they
// decompose into (z, o, a). Finite, conservative set; dots are required for the
// S.A. form to avoid eating a real "S A" token.
const LEGAL_FORM_RES = [
  /\bsp\.?\s*z\s*o\.?\s*o\.?/gi, // Sp. z o.o. + dotted/spacing variants
  /\bs\.\s*a\.?/gi,             // S.A.
];

export function stripLegalForm(s: string): string {
  let out = s;
  for (const re of LEGAL_FORM_RES) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}
```

Wire it into `normalizeBrewery` and `stripBreweryNoise` (NOT `normalizeName`):

```typescript
export function normalizeBrewery(s: string): string {
  const tokens = baseNormalize(stripLegalForm(s))
    .split(' ')
    .filter((t) => t && !BREWERY_NOISE.has(t) && !isNumericNoise(t));
  return tokens.join(' ');
}
```

```typescript
export function stripBreweryNoise(brewery: string): string {
  return stripLegalForm(brewery)
    .split(/\s+/)
    .filter((tok) => tok && !BREWERY_NOISE.has(tok.toLowerCase()))
    .join(' ')
    .trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/domain/normalize.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "feat(normalize): drop 'contracts' noise + strip legal-entity suffixes"
```

---

## Task 2: matcher.ts — token-boundary prefix predicate

**Files:**
- Modify: `src/domain/matcher.ts`
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/matcher.test.ts` (and add `breweryAliasesMatch` to the import on
line 1: `import { matchBeer, breweryAliases, breweryAliasesMatch, extractYear, type CatalogBeer } from './matcher';`):

```typescript
describe('breweryAliasesMatch (token-boundary prefix)', () => {
  test('shorter token list is a leading prefix of the longer', () => {
    expect(breweryAliasesMatch(['harpagan'], ['harpagan contracts'])).toBe(true);
    expect(breweryAliasesMatch(['harpagan'], ['harpagan craft beer'])).toBe(true);
    expect(breweryAliasesMatch(['harpagan contracts'], ['harpagan'])).toBe(true);
  });

  test('exact equality still matches', () => {
    expect(breweryAliasesMatch(['pinta'], ['pinta'])).toBe(true);
  });

  test('mid-token prefixes do NOT match (Harp vs Harpagan)', () => {
    expect(breweryAliasesMatch(['harp'], ['harpagan'])).toBe(false);
  });

  test('non-leading shared token does NOT match (Project vs Side Project)', () => {
    expect(breweryAliasesMatch(['project'], ['side project'])).toBe(false);
  });

  test('disjoint breweries do not match', () => {
    expect(breweryAliasesMatch(['pinta'], ['stu mostow'])).toBe(false);
  });
});

describe('matchBeer with official-suffix brewery', () => {
  test('matches ontap brand-only brewery to catalog official-suffix brewery', () => {
    const cat: CatalogBeer[] = [
      c({ id: 42, brewery: 'Harpagan Contracts', name: 'Buzdygan Rozkoszy', abv: 8.5 }),
    ];
    const result = matchBeer(
      { brewery: 'Harpagan Brewery', name: 'Buzdygan Rozkoszy', abv: 8.5 },
      cat,
    );
    expect(result).toEqual({ id: 42, confidence: 1, source: 'exact' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/domain/matcher.test.ts`
Expected: FAIL — `breweryAliasesMatch` is not exported; the `matchBeer` case returns `null`.

- [ ] **Step 3: Implement**

In `src/domain/matcher.ts`, replace the `brewerySetsOverlap` helper (lines 57-59) with:

```typescript
// Token-boundary prefix: true if `a`'s tokens are a leading prefix of `b`'s,
// or vice versa. Compares whole tokens, so "harp" never matches "harpagan".
function tokenPrefix(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((t, i) => t === long[i]);
}

// True if any alias from one side is a token-prefix of any alias from the other.
export function breweryAliasesMatch(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => tokenPrefix(x, y)));
}
```

In `matchBeer`, change `inputAliases` from a `Set` to the alias array and update the
three usages. Line 65:

```typescript
  const inputAliases = breweryAliases(input.brewery);
```

Exact filter (was line 73):

```typescript
        breweryAliasesMatch(breweryAliases(c.brewery), inputAliases) &&
```

Fuzzy pool filter (was lines 140-142):

```typescript
  const pool = catalog.filter((c) =>
    breweryAliasesMatch(breweryAliases(c.brewery), inputAliases),
  );
```

Seed brewery (was line 151 `Array.from(inputAliases)[0] ?? ''`):

```typescript
  const seedBrewery = inputAliases[0] ?? '';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/domain/matcher.test.ts`
Expected: PASS (including the pre-existing matcher tests — exact equality is the
equal-length case of the prefix predicate, so nothing regresses).

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): token-boundary prefix brewery gate"
```

---

## Task 3: untappd-lookup.ts — use the predicate in the Stage-1 gate

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Test: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('lookupBeer', …)` block in
`src/domain/untappd-lookup.test.ts`:

```typescript
  test('matched: token-prefix gate accepts official-suffix brewery', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 2388534, name: 'Buzdygan Rozkoszy', brewery: 'Harpagan Contracts' },
        { bid: 3240662, name: 'Buzdygan Rozkoszy Rum BA', brewery: 'Harpagan Contracts' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Harpagan Brewery',
      name: 'Buzdygan Rozkoszy',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(2388534);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/untappd-lookup.test.ts -t "official-suffix"`
Expected: FAIL — `out.kind` is `'not_found'` (exact-equality gate rejects
`harpagan` vs `harpagan contracts`).

- [ ] **Step 3: Implement**

In `src/domain/untappd-lookup.ts`, update the import (line 2) to pull in the predicate:

```typescript
import { breweryAliases, breweryAliasesMatch, COLLAB_SEP } from './matcher';
```

Change `inputBreweryAliases` from a `Set` to the alias array (was line 39):

```typescript
  const inputBreweryAliases = breweryAliases(brewery);
```

Replace the Stage-1 filter (was lines 60-63):

```typescript
    // Stage 1: brewery hard-gate — token-boundary prefix overlap.
    const breweryPassed = results.filter((r) =>
      breweryAliasesMatch(breweryAliases(r.brewery_name), inputBreweryAliases),
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/domain/untappd-lookup.test.ts`
Expected: PASS (new test plus the existing matched/not_found cases — "Some Other
Brewery" still has no shared leading token, so the not_found case holds).

- [ ] **Step 5: Commit**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "feat(lookup): token-prefix brewery gate in online enrichment"
```

---

## Task 4: Backfill stored `normalized_brewery`

**Files:**
- Create: `src/jobs/backfill-normalized-brewery.ts`
- Create: `src/jobs/backfill-normalized-brewery.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/jobs/backfill-normalized-brewery.test.ts`:

```typescript
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import pino from 'pino';
import { upsertBeer } from '../storage/beers';
import { backfillNormalizedBrewery } from './backfill-normalized-brewery';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const silentLog = pino({ level: 'silent' });

describe('backfillNormalizedBrewery', () => {
  test('recomputes stale normalized_brewery under new rules', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 2388534,
      name: 'Buzdygan Rozkoszy',
      brewery: 'Harpagan Contracts',
      style: null,
      abv: 8.5,
      rating_global: null,
      normalized_name: 'buzdygan rozkoszy',
      normalized_brewery: 'harpagan contracts', // stale: pre-"contracts"-noise value
    });

    const result = backfillNormalizedBrewery(db, silentLog);

    expect(result.updated).toBe(1);
    const row = db.prepare('SELECT normalized_brewery FROM beers WHERE id = ?').get(id) as {
      normalized_brewery: string;
    };
    expect(row.normalized_brewery).toBe('harpagan');
  });

  test('leaves already-correct rows untouched and is idempotent', () => {
    const db = fresh();
    upsertBeer(db, {
      untappd_id: 1,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: null,
      abv: 6.1,
      rating_global: null,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });

    expect(backfillNormalizedBrewery(db, silentLog).updated).toBe(0);
    expect(backfillNormalizedBrewery(db, silentLog).updated).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/backfill-normalized-brewery.test.ts`
Expected: FAIL — module `./backfill-normalized-brewery` does not exist.

- [ ] **Step 3: Implement**

Create `src/jobs/backfill-normalized-brewery.ts`:

```typescript
import type pino from 'pino';
import type { DB } from '../storage/db';
import { normalizeBrewery } from '../domain/normalize';

export interface BackfillResult {
  updated: number;
}

// One-time, idempotent recompute of the stored normalized_brewery idempotency
// key. Runtime matching recomputes normalizeBrewery live, but the
// (normalized_brewery, normalized_name) upsert key drifts when the normalize
// rules change. idx_beers_norm is non-UNIQUE, so collisions cannot throw.
export function backfillNormalizedBrewery(db: DB, log: pino.Logger): BackfillResult {
  const rows = db
    .prepare('SELECT id, brewery, normalized_brewery FROM beers')
    .all() as Array<{ id: number; brewery: string; normalized_brewery: string }>;
  const update = db.prepare('UPDATE beers SET normalized_brewery = ? WHERE id = ?');
  let updated = 0;

  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      const fresh = normalizeBrewery(r.brewery);
      if (fresh !== r.normalized_brewery) {
        update.run(fresh, r.id);
        updated++;
      }
    }
  });
  tx(rows);

  log.info({ updated }, 'backfill-normalized-brewery done');
  return { updated };
}
```

Wire it into `src/index.ts`. Add the import next to the other job imports (after the
`dedupeBreweryAliases` import on line 25):

```typescript
import { backfillNormalizedBrewery } from './jobs/backfill-normalized-brewery';
```

Call it in `main()` immediately after `migrate(db);` (before `dedupeBreweryAliases`,
so the stored key is fresh before any catalog work):

```typescript
  migrate(db);
  backfillNormalizedBrewery(db, log);
  dedupeBreweryAliases(db, log);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/jobs/backfill-normalized-brewery.test.ts`
Expected: PASS (both tests green).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/backfill-normalized-brewery.ts src/jobs/backfill-normalized-brewery.test.ts src/index.ts
git commit -m "feat(startup): backfill normalized_brewery after normalize-rule change"
```

---

## Task 5: Full suite + spec update

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Run the full test suite + type check**

Run: `npx jest && npx tsc --noEmit`
Expected: All tests PASS, no type errors. If anything fails, fix before continuing —
do not edit the spec on a red suite.

- [ ] **Step 2: Update spec.md**

Open `spec.md` and find the brewery-aliases note in §5 (around lines 577-584,
the bullets describing `Brewery-aliases:` and the noise-word list). Update it to
document (a) the token-boundary prefix gate and (b) the `contracts` noise word +
legal-form stripping. Replace the existing brewery-aliases bullets with:

```markdown
- Brewery-aliases: `"X / Y"` (білінгва + колаби, будь-який пробіл навколо `/`)
  розкладаються на повну форму + кожну половину; `"X (Y)"` paren-форма → зовнішня
  + внутрішня назва.
- Brewery hard-gate: **token-boundary prefix** (`matcher.ts breweryAliasesMatch`) —
  співпадіння, якщо токени одного аліаса є провідним префіксом токенів іншого
  (`[harpagan]` ⊑ `[harpagan, contracts]`), у будь-якому напрямку. Точна рівність —
  окремий випадок. Порівняння по цілих токенах: `harp` ≠ `harpagan`. Далі — name-fuzzy
  ≥ 0.85 як захист від хибних збігів. Застосовується і в `untappd-lookup.ts` (Stage 1).
- normalizeBrewery викидає шумові дескриптори (`brewery`, `browar`, `contracts`,
  `pivovar`, `brauerei`, …) і вирізає юридичні форми (`Sp. z o.o.`, `S.A.`) через
  `stripLegalForm` ДО токенізації — інакше brewery hard-gate валить валідний матч
  (ontap «Harpagan Brewery» → `harpagan` vs Untappd «Harpagan Contracts»).
- Збережений `normalized_brewery` — ключ ідемпотентності upsert; при зміні правил
  нормалізації перераховується на старті (`backfill-normalized-brewery.ts`).
  `idx_beers_norm` НЕ unique, тож перерахунок не кидає constraint.
```

(Adjust the surrounding lines to fit — preserve any bullets in that section that are
not about brewery aliases.)

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document token-prefix brewery gate (§5)"
```

---

## Self-review checklist (completed during planning)

- **Spec coverage:** §1 normalize (Task 1) · §2 predicate + both call sites (Tasks 2,3) ·
  §3 backfill (Task 4) · §4 orphan self-heal (no code, documented) · testing (every task) ·
  spec.md update (Task 5). All covered.
- **Type consistency:** `breweryAliasesMatch(a: string[], b: string[]): boolean` and
  `inputAliases`/`inputBreweryAliases` as `string[]` used consistently across Tasks 2-3.
  `BackfillResult { updated: number }` consistent in Task 4.
- **No placeholders:** every code/test step contains complete code and exact commands.
