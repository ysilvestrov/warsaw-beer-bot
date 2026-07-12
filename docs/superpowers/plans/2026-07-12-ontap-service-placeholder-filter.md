# Ontap Service Placeholder Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent explicit ontap tap-out-of-service placeholders from creating snapshots, catalog beers, match links, or enrich failures.

**Architecture:** Extend the existing pure `isOntapNonBeerTap` gate with one normalized exact beer-name sentinel. Keep parsing and downstream matching unchanged, and reject the row at the existing pre-ingest filter in `refreshOntap`.

**Tech Stack:** TypeScript, Vitest, existing ontap source/filter modules.

---

### Task 1: Reject the service placeholder

**Files:**
- Modify: `src/sources/ontap/non-beer.ts`
- Test: `src/sources/ontap/non-beer.test.ts`

- [ ] **Step 1: Write the failing unit test**

Extend `OntapNonBeerInput` fixtures in `src/sources/ontap/non-beer.test.ts` with the raw beer name and add this positive case to the existing rejection table:

```ts
['tap service placeholder', {
  style: null,
  brewery_ref: 'Kran czeka na lepsze czasy Brewery',
  beer_ref: 'KRAN W SERWISIE',
}],
```

Add this negative case to the existing eligible table so matching stays exact:

```ts
['ordinary beer name containing a similar word', {
  style: 'IPA',
  brewery_ref: 'Example Brewery',
  beer_ref: 'Serwis Chmielowy',
}],
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/sources/ontap/non-beer.test.ts
```

Expected: the `tap service placeholder` case fails because `isOntapNonBeerTap` returns `false`.

- [ ] **Step 3: Implement the minimal exact sentinel**

In `src/sources/ontap/non-beer.ts`, extend the input type and add the exact normalized name set:

```ts
export interface OntapNonBeerInput {
  style: string | null;
  brewery_ref: string | null;
  beer_ref?: string;
}

const EXACT_BEER_SENTINELS = new Set([
  'kran w serwisie',
]);
```

At the start of `isOntapNonBeerTap`, after normalization is available, reject only exact matches:

```ts
const beer = norm(tap.beer_ref ?? null);
if (EXACT_BEER_SENTINELS.has(beer)) return true;
```

Keep `beer_ref` optional so existing callers and tests that only supply style/brewery metadata remain source-compatible.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run src/sources/ontap/non-beer.test.ts
```

Expected: the full test file passes, including the exact placeholder and similar-name negative case.

- [ ] **Step 5: Run broader verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, and the diff check is clean.

- [ ] **Step 6: Review and commit the implementation**

Confirm the diff changes only the ontap gate and focused tests, then run:

```bash
git add src/sources/ontap/non-beer.ts src/sources/ontap/non-beer.test.ts
git commit -m "fix(ontap): reject service placeholders"
```

Expected: one focused implementation commit after the design-spec commit.
