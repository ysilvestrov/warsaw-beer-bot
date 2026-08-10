# #386 — bounded descriptor-led brewery split (beerfreak) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop beerfreak's brandless descriptor-led titles from assigning every token but the last to the brewery, by bounding the brewery to `descriptor + qualifiers + one proper noun + trailing brewery descriptors`.

**Architecture:** One new pure helper `descriptorBreweryEnd(tokens)` in `extension/src/sites/beerfreak.ts`, replacing two contradictory hard-coded guesses in that same file (`splitBrandlessTitle` slices off all but the last token; `stripCollaboratorName` slices exactly two). No server change, no schema change, no other adapter.

**Tech Stack:** TypeScript, Vitest (`extension/` workspace, jsdom via `extension/tests/setup.ts`).

**Spec:** `docs/superpowers/specs/2026-08/2026-08-10-386-beerfreak-descriptor-split-design.md`

---

## Working agreement

**Run every command from `extension/`**, not the repo root. The extension is its own npm
workspace with its own `vitest.config.ts`.

Before your first commit, verify you are in the worktree and not the main checkout:

```bash
git rev-parse --show-toplevel   # must NOT be /home/ysi/warsaw-beer-bot
git branch --show-current       # must be the feature branch, not main
```

If either check fails, stop and report it — do not commit.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `extension/src/sites/beerfreak.ts` | beerfreak DOM adapter + title splitting | Modify: add `QUALIFIER_TOKENS`, add `'brouwers'` to `BREWERY_DESCRIPTORS`, add `descriptorBreweryEnd`, rewire two call sites |
| `extension/src/sites/beerfreak.test.ts` | its tests | Modify: add one `describe` block of split cases |

No new files. The helper is ~8 lines and belongs next to its only two callers; extracting it
to a module would separate it from the sets it reads.

---

## Task 1: Pin today's behaviour that must survive

The two behaviours the change must not break already have a home in the test file. Task 1
adds the issue's required negative test next to them, so it is red-free from the start and
acts as the canary in later tasks.

**Files:**
- Test: `extension/src/sites/beerfreak.test.ts`

- [ ] **Step 1: Add the negative test**

Append this `it` block inside the existing top-level `describe` in
`extension/src/sites/beerfreak.test.ts`, immediately after the existing test
`'extracts a brewery prefix from Beerfreak titles when metadata has no brand'`
(around line 180):

```ts
  it('keeps the three-token descriptor split unchanged (#386 negative test)', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 10480, brand_title: null, title: 'Browar Kormoran Orkiszowe' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'Browar Kormoran',
      name: 'Orkiszowe',
    }));
  });
```

- [ ] **Step 2: Run it and confirm it already passes**

```bash
cd extension && npx vitest run src/sites/beerfreak.test.ts
```

Expected: all tests PASS, including the new one. It documents behaviour that today's code
already has — a three-token descriptor title is the one length today's rule gets right.

If it fails, stop: the baseline is not what the plan assumes.

- [ ] **Step 3: Commit**

```bash
git add src/sites/beerfreak.test.ts
git commit -m "test(#386): pin the three-token descriptor split before changing the rule"
```

---

## Task 2: The failing tests for the bounded rule

**Files:**
- Test: `extension/src/sites/beerfreak.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this block inside the same top-level `describe`, after the test added in Task 1:

```ts
  it('bounds a descriptor-led brandless brewery instead of taking all but the last token', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 10481, brand_title: null, title: 'Brasserie du Bocq Blanche de Namur' },
      { id: 10482, brand_title: null, title: 'Birrificio Del Ducato Verdi Imperial Stout' },
      { id: 10483, brand_title: null, title: 'Brouwerij van Steenberge Gulden Draak 9000 Quadruple' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'Brasserie du Bocq',
      name: 'Blanche de Namur',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'Birrificio Del Ducato',
      name: 'Verdi Imperial Stout',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'Brouwerij van Steenberge',
      name: 'Gulden Draak 9000 Quadruple',
    }));
  });

  it('never leaves a descriptor-led brandless title without a beer name', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 10484, brand_title: null, title: 'Browar Kormoran' },
      { id: 10485, brand_title: null, title: 'Brasserie de la Senne' },
    ]));

    for (const beer of parsed) {
      expect(beer.name).not.toBe('');
      expect(beer.brewery).not.toBe('');
    }
  });
```

Why the second test: the rule clamps to `tokens.length - 1`, and the clamp is the thing that
makes an empty brewery impossible. `Brasserie de la Senne` is the interesting shape — four
tokens, of which three are descriptor+qualifiers, so the clamp is what stops the whole title
from becoming the brewery.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd extension && npx vitest run src/sites/beerfreak.test.ts
```

Expected: FAIL. `Brasserie du Bocq Blanche de Namur` currently yields
`brewery: 'Brasserie du Bocq Blanche de'`, `name: 'Namur'`.

Note the exact received values in the failure output — Task 3 must turn precisely these
into the expected ones.

- [ ] **Step 3: Commit the red tests**

```bash
git add src/sites/beerfreak.test.ts
git commit -m "test(#386): failing tests for the bounded descriptor-led brewery split"
```

---

## Task 3: Implement `descriptorBreweryEnd` and rewire `splitBrandlessTitle`

**Files:**
- Modify: `extension/src/sites/beerfreak.ts` (constants near :15-23, `splitBrandlessTitle` at :118-146)

- [ ] **Step 1: Add `'brouwers'` to `BREWERY_DESCRIPTORS`**

The existing set at `extension/src/sites/beerfreak.ts:19-22` becomes:

```ts
const BREWERY_DESCRIPTORS = new Set([
  'brewery', 'brewing', 'brewers', 'brouwers', 'browar', 'brasserie', 'brouwerij',
  'brauerei', 'pivovar', 'birrificio', 'company', 'co', 'co.', 'family',
]);
```

(`brewers` and `brouwers` are the two plural-noun forms; `brouwers` is the one attested in
the catalogue, by `Brouwerij De Dolle Brouwers`.)

- [ ] **Step 2: Add the qualifier set**

Insert immediately after `LEADING_BREWERY_DESCRIPTORS` (currently `beerfreak.ts:15`):

```ts
// Grammatical particles that bind a brewery descriptor to its proper noun
// ("Brasserie du Bocq", "Brouwerij De Dolle Brouwers", "Browar na Jurze").
// Taken from the shape of real brewery names in the catalogue, not invented.
const QUALIFIER_TOKENS = new Set([
  'de', 'du', 'des', 'del', 'della', 'dei', 'di', 'da', "d'",
  'la', 'le', 'les', 'lo', "l'", 'the',
  'van', 'von', 'der', 'den', 'het', "'t", 'en', 'y',
  'na', 'za', 'w',
]);
```

- [ ] **Step 3: Add the helper**

Insert immediately before `stripCollaboratorName` (currently `beerfreak.ts:89`):

```ts
// Index where a descriptor-led brewery ends: the descriptor, its run of
// grammatical qualifiers, one proper noun, then a trailing run of brewery
// descriptors. Clamped so the beer name always keeps at least one token.
// Callers must have established that tokens[0] is a leading descriptor.
function descriptorBreweryEnd(tokens: string[]): number {
  let i = 1;
  while (i < tokens.length && QUALIFIER_TOKENS.has(normalizedToken(tokens[i]))) i += 1;
  i += 1; // the proper noun
  while (i < tokens.length && BREWERY_DESCRIPTORS.has(normalizedToken(tokens[i]))) i += 1;
  return Math.min(i, tokens.length - 1);
}
```

- [ ] **Step 4: Rewire `splitBrandlessTitle`**

Replace the branch at `beerfreak.ts:131-136`:

```ts
  if (tokens.length >= 3 && first && LEADING_BREWERY_DESCRIPTORS.has(first)) {
    return {
      brewery: tokens.slice(0, -1).join(' '),
      name: tokens[tokens.length - 1],
    };
  }
```

with:

```ts
  if (tokens.length >= 3 && first && LEADING_BREWERY_DESCRIPTORS.has(first)) {
    const end = descriptorBreweryEnd(tokens);
    return {
      brewery: tokens.slice(0, end).join(' '),
      name: tokens.slice(end).join(' '),
    };
  }
```

- [ ] **Step 5: Run the tests**

```bash
cd extension && npx vitest run src/sites/beerfreak.test.ts
```

Expected: PASS, all of them — the Task 2 tests plus the pre-existing
`'extracts a brewery prefix from Beerfreak titles when metadata has no brand'`
(`Brouwerij De Dolle Brouwers Oerbier`), which is the canary for the trailing-descriptor
clause. If that one fails, the `'brouwers'` entry from Step 1 is missing or misspelled.

- [ ] **Step 6: Commit**

```bash
git add src/sites/beerfreak.ts
git commit -m "fix(#386): bound the beerfreak descriptor-led brandless brewery split"
```

---

## Task 4: Route `stripCollaboratorName` through the same helper

**Files:**
- Test: `extension/src/sites/beerfreak.test.ts`
- Modify: `extension/src/sites/beerfreak.ts` (`stripCollaboratorName` at :89-110)

- [ ] **Step 1: Write the failing test**

Append inside the same top-level `describe`:

```ts
  it('drops the whole descriptor-led brewery run from a collaborator segment, not two tokens', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 10486, brand_title: null, title: 'Popihn/Brasserie du Bocq Blanche de Namur' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'Popihn',
      name: 'Blanche de Namur',
    }));
  });
```

Today `stripCollaboratorName` drops exactly two tokens from the collaborator segment,
leaving `name: 'du Bocq Blanche de Namur'`.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd extension && npx vitest run src/sites/beerfreak.test.ts -t 'collaborator segment'
```

Expected: FAIL with received `name: 'du Bocq Blanche de Namur'`.

- [ ] **Step 3: Rewire the branch**

Replace `beerfreak.ts:93-96`:

```ts
  const first = normalizedToken(tokens[0]);
  if (LEADING_BREWERY_DESCRIPTORS.has(first) && tokens.length >= 3) {
    return tokens.slice(2).join(' ');
  }
```

with:

```ts
  const first = normalizedToken(tokens[0]);
  if (LEADING_BREWERY_DESCRIPTORS.has(first) && tokens.length >= 3) {
    return tokens.slice(descriptorBreweryEnd(tokens)).join(' ');
  }
```

- [ ] **Step 4: Run the whole beerfreak suite**

```bash
cd extension && npx vitest run src/sites/beerfreak.test.ts
```

Expected: PASS. Two pre-existing tests exercise this function and must stay green:
`'splits brandless BeerFreak titles into usable brewery and beer names'` (:100) and
`'strips leading slash collaborator segments after the branded brewery prefix'` (:115) —
neither is descriptor-led, so neither should move.

- [ ] **Step 5: Commit**

```bash
git add src/sites/beerfreak.ts src/sites/beerfreak.test.ts
git commit -m "fix(#386): use one descriptor-run rule for collaborator segments too"
```

---

## Task 5: Full verification

**Files:** none modified.

- [ ] **Step 1: Full extension suite**

```bash
cd extension && npx vitest run
```

Expected: PASS. Watch `src/sites/conformance.test.ts` and any fixture-driven beerfreak
assertion in particular — the fixture path (`tests/fixtures/beerfreak.html`) mostly has
`brand_title` set, so it should be untouched, but it is the one place a regression would
show up against real markup.

- [ ] **Step 2: Typecheck and lint**

```bash
cd extension && npx tsc --noEmit
```

Expected: no output (clean).

If the repo root defines a lint script covering `extension/`, run it too:

```bash
cd /home/ysi/warsaw-beer-bot && npm run lint --if-present
```

- [ ] **Step 3: Server suite unaffected**

The change is client-only, but run the root suite once to prove it:

```bash
cd /home/ysi/warsaw-beer-bot && npm test
```

Expected: PASS.

- [ ] **Step 4: Report, do not commit**

Report the three command outputs verbatim. Nothing to commit in this task.

---

## Task 6: Changelog entry for 0.14.0

**Files:**
- Modify: `extension/CHANGELOG.md`

- [ ] **Step 1: Add the entry**

The 0.14.0 section does not exist yet — this task creates it with only the #386 line. The
release task (separate, outside this plan) fills in the rest and bumps the version.

Insert directly under the `# Changelog` heading, above `## [0.13.0] - 2026-07-31`:

```markdown
## [Unreleased]

- Fixed BeerFreak brewery detection for products the shop publishes without a brand label: titles led by a brewery word ("Brasserie", "Browar", "Brouwerij", "Pivovar", "Birrificio", "Brauerei") no longer swallow the beer name into the brewery, so "Brasserie du Bocq Blanche de Namur" is now the beer "Blanche de Namur" by "Brasserie du Bocq" instead of a beer called "Namur".
```

Match the existing house style: user-facing outcome first, no issue numbers, no file names.

- [ ] **Step 2: Confirm the install guide needs no change**

Per `CLAUDE.md`, `docs/extension-install-uk.md` must change only for a new supported shop, a
new option/checkbox, a popup control, new badges or badge behaviour, or a change to the
install/update flow. This is a parsing fix behind existing behaviour and touches none of
those. Note this explicitly in the PR description.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(#386): changelog entry for the beerfreak descriptor split fix"
```

---

## Definition of done

- [ ] `cd extension && npx vitest run` passes
- [ ] `cd extension && npx tsc --noEmit` clean
- [ ] root `npm test` passes
- [ ] `Brouwerij De Dolle Brouwers Oerbier` (pre-existing test) still splits as before
- [ ] `Browar Kormoran Orkiszowe` still splits as before
- [ ] `Brasserie du Bocq Blanche de Namur` → `Brasserie du Bocq` + `Blanche de Namur`
- [ ] `Birrificio Del Ducato Verdi Imperial Stout` → `Birrificio Del Ducato` + `Verdi Imperial Stout`
- [ ] no empty brewery and no empty name from any descriptor-led branch
- [ ] one helper, two call sites — no duplicated rule left in the file
- [ ] changelog entry added; install guide deliberately untouched
