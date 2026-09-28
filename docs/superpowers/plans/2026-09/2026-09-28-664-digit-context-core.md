# #664 Contextual Digit Identity Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This project's agent instructions require sequential work in the main thread; do not dispatch subagents.

**Goal:** Implement and verify the shared numerical-identity kernel for hop codes, brewery fragments, and the proven TAP/LAB/EL/53M forms, preserving ordinary series numbers and #725.

**Architecture:** Extend `src/domain/digit-identity.ts` in place. Its ordinary numerical reader remains the fallback; bounded recognizers consume proven source spans before that reader, and contextual comparisons re-read the full raw names supplied through the existing context. Keep optional metadata and context fields so current consumers compile; wiring their brewery/catalog context and numbered-series search is a separate plan after this core's review.

**Tech Stack:** Node.js `>=24`, TypeScript, Vitest; existing normalization helpers and dependencies.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-28-664-digit-context-design.md`

## Global Constraints

- Read `AGENTS.md`, `spec.md` § «Ідентичність цифр назви (#636)», and the entire design before execution. The core cannot ship before the periphery connects all consumers and synchronizes `spec.md`.
- No new dependencies, database migrations, production writes, historical-link repair, cache assertions, issue closure, row remapping, deployment, or Chrome Web Store release.
- Preserve `same > year-fallback > number-fallback > different`, caller-specific acceptance levels, ordinary numerical rules, and the contextual Czech-grade veto #725.
- Never infer a neutral number from ABV equality. `Duvel 6.66` retains its numerical identity.
- Match source spans, never globally subtract a brand's numerical values. Hops and typed codes never cover unrelated hard numbers merely because their values agree.
- Raw names/styles remain authoritative on contextual retries; reverse peers swap all side-specific context and retain the shared catalog.
- Unit tests use literal expected constants and deterministic `test.each` rows, with no conditional assertions or implementation-derived expectations. Do not pin registry counts or weaken old exact reader assertions.
- After each implementation task: focused tests, then `npm test && npm run typecheck`, then a named-file commit. Do not re-run a gate without a change or unresolved failure.
- Three implementation tasks, then a whole-branch review. Only after that review write the periphery plan; do not implement clients/search from this document.

## File map and execution state

| File | Responsibility |
|---|---|
| `src/domain/digit-identity.ts` | Existing reader, contextual classification, typed numerical comparison, peers |
| `src/domain/digit-identity.test.ts` | Exact parsing/verdict regressions and protection of the existing #636/#725 contract |
| This plan and its design | Scope, evidence, progress; mark task checkboxes after their gates |

Worktree: `/home/ysi/warsaw-beer-bot/.worktrees/664-digit-context-design`, branch
`docs/664-digit-context-design`, clean baseline at `2ca8cd5` (source base `a56143c`).
Baseline already verified: 3867 tests passed, one skipped. Fetch/rebase if execution
starts after `main` moves, preserve the design/plan commits, and verify the resulting baseline.
The worktree already has a symlink to the checkout's `node_modules`; do not install dependencies
or create another worktree merely to start this plan.

## Shared interfaces and reading order

Task 1 introduces these optional additions; Tasks 2 and 3 use exactly these names:

```ts
export interface DigitIdentityContext {
  input: { name: string; style?: string | null; brewery?: string | null };
  candidate: { name: string; style?: string | null; brewery?: string | null };
  knownBreweries?: readonly string[];
}

export interface NameDigits {
  numbers: string[];
  soft: string[];
  grades: string[];
  versions: string[];
  years: string[];
  hasLetters: boolean;
  hops?: string[];       // unique sorted IDs: HBC:1183, CF:317, PolishHops:3/20
  tapCodes?: string[];   // unique sorted IDs: TAP:4
  hardCodes?: string[];  // sorted multiset: LAB:29, EL:1762, 53M
}

// Public signatures stay unchanged except for the already optional, extended context:
export declare function readNameDigits(name: string): NameDigits;
export declare function digitIdentity(input: NameDigits, candidate: NameDigits,
  context?: DigitIdentityContext): DigitIdentity;
export declare function digitsCompatibleAsPeers(a: string, b: string,
  context?: DigitIdentityContext): boolean;
```

Keep helper functions private in the same module:

```ts
type Span = { start: number; end: number };
type CodeSpan = Span & { kind: 'hop' | 'tap' | 'hard'; id: string };
type Side = 'input' | 'candidate';
declare function readOrdinaryNameDigits(name: string): NameDigits;
declare function readProfile(name: string, context?: DigitIdentityContext, side?: Side): NameDigits;
declare function findHopSpans(name: string, context?: DigitIdentityContext, side?: Side): CodeSpan[];
declare function findNoiseSpans(name: string): Span[];
declare function maskSpans(name: string, spans: readonly Span[]): string;
declare function differentNonEmptySets(a: readonly string[], b: readonly string[]): boolean;
```

`readOrdinaryNameDigits` is the present `readNameDigits` body, renamed without algorithm changes.
`readProfile` performs brand masking (Task 2), proven code extraction (Tasks 1/3), then calls
the ordinary reader on the remaining text. Use whitespace masking to retain offsets and token
boundaries. Return code metadata only when nonempty so existing ordinary `.toEqual({...})`
assertions remain valid; optional metadata is read with `?? []`. Preserve `hasLetters` from
the ordinary reader of the original text: classification does not invent a new exact-name gate.
Do not mutate the passed profiles or context.

The critical shared operations are:

```ts
function maskSpans(name: string, spans: readonly Span[]): string {
  const chars = name.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end; i++) chars[i] = ' ';
  }
  return chars.join('');
}

function differentNonEmptySets(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length > 0 && right.length > 0 && left.join('|') !== right.join('|');
}
```

---

### Task 1 (U1): Proven hop codes and local fractional context

**Files:** Modify `src/domain/digit-identity.ts`; test `src/domain/digit-identity.test.ts`.

**Consumes:** Current ordinary reader, `canon`, `minus`, existing Czech-grade guard.
**Produces:** Shared interfaces above; `readProfile`/`findHopSpans`; global lexical hop recognition and contextual fractional recognition; original ordinal/ABV/year behavior.

- [ ] **Step 1: Freeze the read-only replay inputs before code changes.** Create the measurement script in the appendix at `/tmp/664-core-replay.cjs`. Run `REPO="$PWD" node --require tsx/cjs /tmp/664-core-replay.cjs capture`. Keep `/tmp/664-core-corpus.json` and the baseline revision with this session; this is operational evidence, not a committed runtime module. The script reads the available DB, never writes it, and does not access the network.
- [ ] **Step 2: Add exact tests.** Put these in a new `describe('#664 hop codes')`; all rows are explicit facts, not generated expected results:

```ts
test('the hop token is consumed once and does not hide the series number', () => {
  const read = readNameDigits('Temporalis #0056 HBC 1183 Citra Dynaboost');
  expect(read.numbers).toEqual(['56']);
  expect(read.hops).toEqual(['HBC:1183']);
});

test.each<[string, string, DigitIdentity]>([
  ['Temporalis #0056 HBC 1183', 'Temporalis #0056', 'same'],
  ['Temporalis #0056 HBC 1183', 'Temporalis #0057', 'different'],
  ['Single Hop HBC472', 'Single Hop HBC-472', 'same'],
  ['Single Hop HBC 472', 'Single Hop HBC 630', 'different'],
  ['Hop Heats CF317', 'Hop Heats CF338', 'different'],
  ['Hop Heats CF317', 'Hop Heats HBC317', 'different'],
  ['IPA BRU-1', 'IPA BRU1', 'same'],
  ['IPA NZH-107', 'IPA NZH 107', 'same'],
  ['IPA YCR 1320', 'IPA YCR1320', 'same'],
  ['IPA PŁ-167', 'IPA PŁ167', 'same'],
  ['IPA Idaho 7', 'IPA Idaho7', 'same'],
  ['IPA HBC472 HBC472', 'IPA HBC472', 'same'],
  ['IPA HBC472 BRU1', 'IPA BRU1 HBC472', 'same'],
  ['IPA HBC472 BRU1', 'IPA HBC472', 'different'],
  ['DUMB FRUIT 11', 'DUMB FRUIT', 'same'], // 11 remains an ordinary soft number
  ['DUMB FRUIT #11', 'DUMB FRUIT', 'different'],
  ['Duvel 6.66', 'Duvel', 'different'],
  ['Duvel 6.66%', 'Duvel', 'same'],
  ['Beer 0,5l', 'Beer', 'same'],
])('%s / %s → %s', (a, b, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b))).toBe(expected);
});

test.each<[string, string, string | null, DigitIdentity]>([
  ['IPA EXP 3/20', 'IPA', null, 'same'],
  ['IPA EXP3/20', 'IPA 3/20', 'PolishHops', 'same'],
  ['Polish Hops: 3/20', 'IPA', null, 'same'],
  ['IPA 2/20', 'IPA', 'ReCraft / PolishHops Brewery', 'same'],
  ['IPA 5/39', 'IPA', 'PolishHops', 'same'],
  ['IPA PŁ167 x 3/20 x 2/20', 'IPA PŁ-167 x EXP 3/20 x EXP 2/20', null, 'same'],
  ['IPA EXP 2/20', 'IPA EXP 3/20', null, 'different'],
  ['IPA EXP 2/20', 'IPA EXP 1/10', null, 'number-fallback'],
  ['IPA 3/20', 'IPA', 'ReCraft', 'different'],
  ['Polish Hops #3/20', 'IPA', null, 'different'],
  ['Polish Hops series 3/20', 'IPA', null, 'different'],
  ['Polish Hops (kegged 3/20)', 'IPA', null, 'different'],
  ['Polish Hops 3/20/2026', 'IPA', null, 'different'],
  ['Free IPA PŁ167 x 3/20 x 2/2', 'Free IPA PŁ167 x EXP 3/20', null, 'different'],
])('%s / %s, brewery %s → %s', (a, b, brewery, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), {
    input: { name: a, brewery }, candidate: { name: b, brewery },
  })).toBe(expected);
});

test('fraction codes are not reduced to an unproven numerical equivalent', () => {
  expect(readNameDigits('IPA EXP 2/20').hops).toEqual(['PolishHops:2/20']);
  const unknown = readNameDigits('IPA EXP 1/10');
  expect(unknown.hops ?? []).toEqual([]);
  expect(unknown.numbers).toEqual(['1']);
  expect(unknown.soft).toEqual(['10']);
});
```

Also pin `readNameDigits('DUMB FRUIT 11').soft` to `['11']` and `.hops ?? []` to `[]`:
the plain `same` verdict above must not be mistaken for hop recognition. Pin the ordinary
numbers of bare `IPA 3/20` to `['20', '3']`. Add boundary rows `NOTHBC472`, `HBC472suffix`,
`Idaho 8`, empty input, and a disconnected `PŁ167 (kegged 3/20)`; none consumes a false hop span.

- [ ] **Step 3: Run `npx vitest run src/domain/digit-identity.test.ts`.** Expect failures on HBC extraction and new hop comparisons; distinguish real assertion failures from syntax/import errors.
- [ ] **Step 4: Implement bounded recognition and wire the predicate.** Rename the old reader; make public `readNameDigits(name)` delegate to `readProfile(name)`; add the optional fields/context. Use Unicode token boundaries and these starting grammars:

```ts
const PREFIX_HOP = /(?<![\p{L}\p{N}])(HBC|BRU|NZH|YCR|PŁ|CF)[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const IDAHO_HOP = /(?<![\p{L}\p{N}])Idaho\s*7(?![\p{L}\p{N}])/giu;
const EXP_FRACTION = /(?<![\p{L}\p{N}])EXP\s*(\d+)\s*\/\s*(\d+)(?![\p{L}\p{N}])/giu;
const POLISH_FRACTIONS = new Set(['2/20', '3/20', '5/39']);
```

`findHopSpans` yields full-token spans and canonical IDs, retaining namespace (`PŁ:167`,
`PolishHops:3/20`); do not reduce fractions arithmetically. Reject partial integer-code matches
followed by a decimal/fraction continuation, and fractional matches that are part of a three-part
date. Deduplicate the same source span before masking and deduplicate hop IDs.
`findNoiseSpans` locates the existing `ABV`, `ABV_LABELLED`, and `GRADE` matches in the raw
text. Mask these spans only in the text scanned for code claims, leaving them in the ordinary
reader's input so grades are still extracted. A code recognizer must not consume the number
in `HBC 12°`, `HBC 7%`, or `HBC 7 ABV`. Pin the latter two to empty hop/number arrays and
`HBC 12°` to empty hops plus `grades = ['12']`; do not replace existing noise rules.

For unprefixed fractions, first identify their local text region (parentheses/brackets,
semicolon/comma, or a spaced dash separate regions; a colon in `Polish Hops:` does not).
An explicit `EXP` proves its own code. Otherwise the region needs a `Polish Hops` label,
the relevant side's explicit PolishHops brewery, or membership in the same connector component
(`x`, `&`, `+`) as a recognized hop-code span. Do not carry a label from outside into a bracketed
date. Reject fractions immediately marked as `#`/`no.`/`nr.`, `batch`, `series`, `kegged`,
`bottled`, `released`, or `date`, even with a PolishHops label. Unknown fractions remain ordinary
numbers. Recognition of a peer's unrelated brewery does not prove local fractional context.
Consequently an unknown fraction retains the existing directional fallback semantics; do not
force every known-hop/unknown-fraction pair to `different` just to make a test sound stricter.

At the start of `digitIdentity`, use raw context names when present, then apply the hop veto,
then retain the existing Czech-grade and numerical rules:

```ts
if (context) {
  input = readProfile(context.input.name, context, 'input');
  candidate = readProfile(context.candidate.name, context, 'candidate');
}
if (differentNonEmptySets(input.hops ?? [], candidate.hops ?? [])) return 'different';
if (czechGradesContradict(input, candidate, context)) return 'different';
```

`readProfile` returns the ordinary fields for masked text plus nonempty sorted metadata,
with `hasLetters` taken from the original ordinary profile. Context-free manually constructed
`NameDigits` continue to work. No raw source is added to the public reader's ordinary return shape.

- [ ] **Step 5: Verify and commit.** Run the focused test file, then `npm test && npm run typecheck`. Keep all pre-existing #636/#725 expected values. Commit only the two task files: `fix(domain): distinguish proven hop codes from series numbers (#664) (U1)`.

### Task 2 (U2): Mask only proven brewery-number occurrences

**Files:** Modify `src/domain/digit-identity.ts`; test `src/domain/digit-identity.test.ts`.

**Consumes:** U1 `readProfile`, `Span`, extended context, and `maskSpans`.
**Produces:** Private `brandTokens(raw: string): string[]`, `findBrandNumberSpans(name: string, context?: DigitIdentityContext): Span[]`; number-preserving brand tokenization and curated leading `101` handling. Peers retain the shared catalog when reversing.

- [ ] **Step 1: Add contextual regression tests.** Use literal profiles and exact verdicts:

```ts
test.each<[string, string, string, string, readonly string[], DigitIdentity]>([
  ['3 Fonteinen Oude Geuze', 'Oude Geuze', '3 Fonteinen', 'Brouwerij 3 Fonteinen', [], 'same'],
  ['3 Fonteinen Beer #3', 'Beer', '3 Fonteinen', '3 Fonteinen', [], 'different'],
  ['3 Fonteinen Beer #3', 'Beer #3', '3 Fonteinen', '3 Fonteinen', [], 'same'],
  ['3 Fonteinen 3 Fonteinen Beer #3', 'Beer #3', '3 Fonteinen', '3 Fonteinen', [], 'same'],
  ['Beer 450', 'Beer', 'Imprint', 'Imprint', ['450 North'], 'different'],
  ['Blurries / 450 North', 'Blurries', 'Imprint', 'Imprint', ['450 North'], 'same'],
  ['Blurries / 450 Northern', 'Blurries', 'Imprint', 'Imprint', ['450 North'], 'different'],
  ['Stuffed Schmoojee / Claim 52', 'Stuffed Schmoojee', 'Imprint', 'Imprint', ['Claim 52'], 'same'],
  ['Claim 52 Beer #52', 'Beer', 'Claim 52', 'Claim 52', [], 'different'],
  ['101 Mojito', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'same'],
  ['101 Ginger Mule', 'Ginger Mule Mocktail', 'Імпортне пиво', 'Sir James 101', [], 'same'],
  ['#101 Mojito', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'different'],
  ['Batch 101 Mojito', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'different'],
  ['Mojito 101', 'Mojito Mocktail', 'Sir.James', 'Sir James 101', [], 'different'],
  ['101 Unknown Product', 'Unknown Product', 'Sir.James', 'Sir James 101', [], 'different'],
  ['101 Mojito', 'Mojito', 'Other', '101 Cider House', [], 'different'],
  ['Duvel 6.66', 'Duvel', 'Duvel Moortgat', 'Duvel Moortgat', [], 'different'],
])('%s / %s → %s', (a, b, ab, bb, knownBreweries, expected) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), {
    input: { name: a, brewery: ab }, candidate: { name: b, brewery: bb }, knownBreweries,
  })).toBe(expected);
});

test('peer reversal retains the catalog and swaps brewery/style sides', () => {
  const a = 'Blurries / 450 North';
  const b = 'Blurries';
  const context: DigitIdentityContext = {
    input: { name: a, brewery: 'Imprint' },
    candidate: { name: b, brewery: 'Imprint', style: 'Sour' },
    knownBreweries: ['450 North'],
  };
  expect(digitsCompatibleAsPeers(a, b, context)).toBe(true);
  expect(digitsCompatibleAsPeers(b, a, {
    ...context, input: context.candidate, candidate: context.input,
  })).toBe(true);
});
```

Also add the absence-of-context negative for `Blurries / 450 North` / `Blurries` (`different`),
diacritics/legal-form brand variants, brand evidence only from the other side, and a guarded
`Beer #3 10°` / `Beer #3 12°` pair with Czech style (`different`) while brewery/catalog fields
are present. Reuse the existing #725 tests unchanged. Assert neither the passed profiles nor
the context arrays change after comparison using explicit before/after object equality.

- [ ] **Step 2: Run `npx vitest run src/domain/digit-identity.test.ts`.** Expect the new contextual brand positives and peer-catalog test to fail; ordinary hard-number negatives should already pass.
- [ ] **Step 3: Implement source-spanned brand masking before hop extraction.** Import only existing `baseNormalize`, `stripLegalForm`, `canonicalizeBreweryBrand`, `BREWERY_NOISE`, and `BREWERY_COLLAB_SEP` from `normalize.ts`; do not import `matcher.ts`, and do not use `normalizeBrewery`, which drops separate digits.

```ts
function brandTokens(raw: string): string[] {
  return baseNormalize(stripLegalForm(canonicalizeBreweryBrand(raw)))
    .split(' ').filter((token) => token && !BREWERY_NOISE.has(token));
}
```

Split explicit brewery labels with the existing collaboration separator. Candidate brand labels
come from both sides' `brewery` fields and `knownBreweries`; keep only token sequences containing
at least one letter token and one separate numeric token. A numeric-only label never proves a
brand. Tokenize the raw title into Unicode word/number tokens with original offsets, apply the
same case/diacritic/noise treatment without erasing digits, and find complete contiguous brand
runs. For each matched run, mask only its numeric token spans. Reject an explicitly marked
number (`#`, `no.`, `nr.`, `batch`, `vol.`) as a brand's numeric occurrence. Match every separate
occurrence, but do not mask another equal-valued number outside those runs.
Do not mask a numeric token overlapping a `findNoiseSpans` result: brewery-fragment
recognition must not erase an explicit degree grade before #725 can inspect it.

For leading `101`, require an explicit input/candidate Sir. James brand, not merely an entry in
the catalog. After `101`, require a confirmed product prefix: `mojito`, `ginger mule`, `spritz`,
`passionfruit martini`, or `pink g t` after base normalization (source: #664 historical probe).
Require `101` at the start apart from whitespace and followed by a token boundary; no marker.
Mask that occurrence only. Do not strip internal or marked `101`, unknown products, or `101`
because the other brand is `101 Cider House`.

In `readProfile`, call `findBrandNumberSpans` only when contextual data exists; mask those spans
before locating hop spans. Keep raw context for the original Czech-grade veto. Preserve shared
fields on peers' reversed context:

```ts
const reverse = context ? {
  ...context, input: context.candidate, candidate: context.input,
} : undefined;
```

No DB/network work in these functions; `knownBreweries` is supplied data. Their omission means
no guessed catalog. Name matching/exact identity is not rewritten by this task.

- [ ] **Step 4: Verify and commit.** Focused file, then `npm test && npm run typecheck`. Commit only the two task files: `fix(domain): preserve series numbers beside brewery fragments (#664) (U2)`.

### Task 3 (U3): Contextual TAP descriptors and hard LAB/EL/53M identifiers

**Files:** Modify `src/domain/digit-identity.ts`; test `src/domain/digit-identity.test.ts`.

**Consumes:** U1 profile metadata and masking, U2 number-preserving brand tokens/context.
**Produces:** Private `findSeriesCodeSpans(name: string, context?: DigitIdentityContext): CodeSpan[]`; typed code comparison in `digitIdentity`, with no changes to public return levels.

- [ ] **Step 1: Add exact, brewery-qualified tests.** Put these in their own describe block:

```ts
test.each<[string, string, string, DigitIdentity, DigitIdentity]>([
  ['TAP 4 Mein Festweisse', 'Festweisse (TAP04)', 'Schneider Weisse', 'same', 'same'],
  ['Original TAP07', 'Original TAP04', 'Schneider Weisse', 'different', 'different'],
  ['Aventinus TAP06', 'Aventinus', 'Schneider Weisse', 'same', 'same'],
  ['Beer TAP 4', 'Beer TAP 5', 'Other', 'different', 'different'],
  ['Beer TAP 4', 'Beer', 'Other', 'different', 'number-fallback'],
  ['LAB29', 'LAB30', 'Pracownia Piwa', 'different', 'different'],
  ['LAB29', 'LAB 029', 'Pracownia Piwa', 'same', 'same'],
  ['LAB9', 'LAB10', 'Pracownia Piwa', 'different', 'different'],
  ['LAB29 Porter', 'Porter', 'Pracownia Piwa', 'different', 'number-fallback'],
  ['EL-1762 Pineapple', 'EL-1622 Pineapple', 'Moersleutel Craft Brewery', 'different', 'different'],
  ['EL-1762 Pineapple', 'EL1762 Pineapple', 'Moersleutel Craft Brewery', 'same', 'same'],
  ['EL-1762 Pineapple', 'Pineapple', 'Moersleutel Craft Brewery', 'different', 'number-fallback'],
  ['53 M Horseshoe', '53M Horseshoe', 'Hop Brook Brewery', 'same', 'same'],
  ['53M Horseshoe', 'Horseshoe', 'Hop Brook Brewery', 'different', 'number-fallback'],
  ['53 M Horseshoe', '53 N Horseshoe', 'Hop Brook Brewery', 'different', 'different'],
  ['Beer LAB29', 'Beer EL29', 'Pracownia Piwa / Moersleutel', 'different', 'different'],
  ['Beer #29', 'Beer LAB29', 'Pracownia Piwa', 'different', 'different'],
  ['Beer 10', 'Beer LAB29', 'Pracownia Piwa', 'different', 'different'],
  ['Beer 9.0', 'Beer LAB29', 'Pracownia Piwa', 'different', 'different'],
  ['Beer 2024', 'Beer LAB29 2025', 'Pracownia Piwa', 'different', 'different'],
  ['Beer', 'Beer LAB29 2025', 'Pracownia Piwa', 'number-fallback', 'different'],
])('%s / %s, %s → %s / %s', (a, b, brewery, forward, reverse) => {
  expect(digitIdentity(readNameDigits(a), readNameDigits(b), {
    input: { name: a, brewery }, candidate: { name: b, brewery },
  })).toBe(forward);
  expect(digitIdentity(readNameDigits(b), readNameDigits(a), {
    input: { name: b, brewery }, candidate: { name: a, brewery },
  })).toBe(reverse);
});
```

Pin peers: `LAB29 Porter` / `Porter` in Pracownia Piwa context → `false` in both directions;
Schneider `Aventinus TAP06` / `Aventinus` → `true`; differing TAP codes → `false`.
Add `NOTLAB29`, `LAB29suffix`, compact identifiers without any known brewery context,
and decimal/fraction continuations; do not broaden unknown glued forms. Retain the existing
`WFP10` and `BA23.03` documented-limit tests. Pin explicitly that unrelated `#4` beside TAP04
and unrelated `#29` beside LAB29 remain hard numbers, not consumed twice or covered by code values.

- [ ] **Step 2: Run `npx vitest run src/domain/digit-identity.test.ts`.** Expect TAP-format and LAB-code failures; differing `EL-1762`/`EL-1622` must keep its existing rejection.
- [ ] **Step 3: Add context-qualified grammars to the shared profile.** Owner checks use full leading brand tokens from explicit pair breweries, including split collaboration parts: `schneider weisse`, `pracownia piwa`, `moersleutel`, `hop brook`. Catalog presence alone does not qualify an unrelated title as one of these series. Support existing Schneider labels with trailing words (`G. Schneider & Sohn`, `Brewery`) without substring matching other brands.

```ts
const TAP_CODE = /(?<![\p{L}\p{N}])TAP[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const LAB_CODE = /(?<![\p{L}\p{N}])LAB[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const EL_CODE = /(?<![\p{L}\p{N}])EL[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const HORSESHOE_CODE = /(?<![\p{L}\p{N}])53\s*M(?![\p{L}\p{N}])/giu;
```

Apply token/decimal/fraction boundary guards as in U1. `canon` removes redundant integer zeros
within an already recognized code, but its namespace survives. Extract `tapCodes` as a unique
sorted set and `hardCodes` as a sorted multiset. Mask only their recognized spans before ordinary
reading; unqualified/unknown forms retain the ordinary reader's exact behavior.

Veto differing nonempty TAP sets like hops. Hard codes require namespace-preserving multiset
coverage: an unmatched input hard code returns `different`; candidate-only hard codes join the
existing candidate-only-number condition. The concrete insertion points are:

```ts
if (differentNonEmptySets(input.tapCodes ?? [], candidate.tapCodes ?? [])) return 'different';
const inputCodeOnly = minus(input.hardCodes ?? [], candidate.hardCodes ?? []);
if (inputCodeOnly.length > 0) return 'different';
const candidateCodeOnly = minus(candidate.hardCodes ?? [], input.hardCodes ?? []);
// After the existing ordinary candidateOnly calculation:
const hasCandidateOnly = candidateOnly.length > 0 || candidateCodeOnly.length > 0;
```

Use `hasCandidateOnly` at BOTH current candidate-only guards: the own-unmatched-soft/version
veto and the final fallback/`hasLetters` guard. Preserve year-conflict and Czech-grade checks.
Do not cover hard codes with numbers/grades, or hard numbers with code values; LAB29 is not
the ordinary `#29`. Do not add a new fallback level.

- [ ] **Step 4: Verify and commit.** Focused file, then `npm test && npm run typecheck`. Commit only the two task files: `fix(domain): preserve identity of contextual beer codes (#664) (U3)`.

### Task 4: Whole-core review and replay before planning periphery

**Files:** Review the whole diff from `a56143c`; include all U1/U2/U3 inline work, tests, design, and plan. No new production module is required for this task.

**Consumes:** Three passing task gates, the frozen pre-change corpus, and the agreed design.
**Produces:** Review findings resolved or explicitly recorded; per-row replay transitions with their evidence; permission to write the separate periphery plan only when no core blocker remains.

- [ ] **Step 1: Review the entire branch with `compound-engineering:ce-code-review`, sequentially in the main thread per AGENTS.md.** Check correctness, actual spec coverage, optional-field/API compatibility, role reversal, no mutation of inputs, Unicode/source-span boundaries, false neutrality, and preservation of #725. A green unit test is not proof that every consumer already receives new brewery/catalog fields.
- [ ] **Step 2: Run the frozen replay:** `REPO="$PWD" node --require tsx/cjs /tmp/664-core-replay.cjs compare > /tmp/664-core-transitions.jsonl`. This step has no network or DB access. Inspect every changed pair and explain its exact consumed source span/family; report changes per corpus group and role direction. Distinct bids are a diagnostic pool, not proof of distinct beer identity; existing links are observations, not an infallible oracle. No aggregate count authorizes a rule or production write.
- [ ] **Step 3: Fix valid findings with focused regression tests.** Re-run the affected focused tests and full gate after each logical correction, commit named files, and re-review changed reasoning. An unknown code or required change to a name/brewery/ABV gate returns to design rather than expanding this core.
- [ ] **Step 4: Confirm the last code state has a passing full gate and no unresolved core findings.** Record the actual commit, test totals, transitions and review conclusions in the execution report. Do not repeat a just-passed full gate without intervening changes.
- [ ] **Step 5: Write a separate periphery plan against the reviewed code.** Its coverage must include context delivery to both matcher stages, lookup/retries, web fallback, enrich, storage resolution/peers, dedupe; the numbered-series search contract; synchronization of `spec.md`; integration tests and fresh live query/match measurements. These are deferred design requirements, not omitted requirements or permission to ship the core. Preserve all caller-specific acceptance levels and full original names. No PR or deployment from this core checkpoint.

## Appendix: frozen read-only numerical replay

This measurement is not a unit-test oracle and does not reproduce production algorithms to
derive expected answers. It freezes external rows and records before/after predicate outputs.
Create it with a file-writing tool; do not interpolate its contents into a shell string.
Run from the worktree, with Node's existing `tsx/cjs` hook and the exact `REPO` path.

```js
// /tmp/664-core-replay.cjs
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const repo = process.env.REPO;
const { readNameDigits, digitIdentity } = require(repo + '/src/domain/digit-identity.ts');
const corpusPath = '/tmp/664-core-corpus.json';
const mode = process.argv[2];
const judge = (a, b, knownBreweries) => digitIdentity(readNameDigits(a.name), readNameDigits(b.name), {
  input: a, candidate: b, knownBreweries,
});

if (mode === 'capture') {
  if (fs.existsSync(corpusPath)) throw new Error('Corpus already exists; preserve the baseline');
  const Database = require(repo + '/node_modules/better-sqlite3');
  const db = new Database('/var/lib/warsaw-beer-bot/bot.db', { readonly: true, fileMustExist: true });
  const knownBreweries = db.prepare('SELECT DISTINCT brewery FROM beers ORDER BY brewery')
    .all().map(row => row.brewery).filter(value => typeof value === 'string');
  const rows = db.prepare(`SELECT id, name, brewery, style, untappd_id,
    normalized_brewery nb, normalized_name nn FROM beers WHERE untappd_id IS NOT NULL
    AND (normalized_brewery, normalized_name) IN
    (SELECT normalized_brewery, normalized_name FROM beers WHERE untappd_id IS NOT NULL
     GROUP BY normalized_brewery, normalized_name HAVING COUNT(DISTINCT untappd_id) > 1)
    ORDER BY id`).all();
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.nb, row.nn]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const pairs = [];
  const side = row => ({ name: row.name, brewery: row.brewery, style: row.style });
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a.untappd_id === b.untappd_id) continue;
        pairs.push({ group: 'distinct-bid', ids: [a.id, b.id],
          bids: [a.untappd_id, b.untappd_id], a: side(a), b: side(b) });
      }
    }
  }
  for (const row of db.prepare(`SELECT ml.id link_id, ml.ontap_ref, ml.brewery_ref,
    ml.confidence, ml.reviewed_by_user reviewed, ml.merged_at merged,
    b.id beer_id, b.name, b.brewery, b.style, b.untappd_id
    FROM match_links ml JOIN beers b ON b.id = ml.untappd_beer_id ORDER BY ml.id`).all()) {
    const group = row.reviewed || row.merged ? 'pin-or-merge' : 'auto-link';
    if (group === 'auto-link' && row.confidence !== 1) continue;
    pairs.push({ group, linkId: row.link_id, beerId: row.beer_id, bid: row.untappd_id,
      a: { name: row.ontap_ref, brewery: row.brewery_ref, style: null }, b: side(row) });
  }
  db.close();
  for (const pair of pairs) {
    pair.forward = judge(pair.a, pair.b, knownBreweries);
    pair.reverse = judge(pair.b, pair.a, knownBreweries);
  }
  fs.writeFileSync(corpusPath, JSON.stringify({
    base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    capturedAt: new Date().toISOString(), knownBreweries, pairs,
  }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ corpusPath, pairs: pairs.length }));
} else if (mode === 'compare') {
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  let transitions = 0;
  for (const pair of corpus.pairs) {
    const forward = judge(pair.a, pair.b, corpus.knownBreweries);
    const reverse = judge(pair.b, pair.a, corpus.knownBreweries);
    if (forward !== pair.forward || reverse !== pair.reverse) {
      transitions++;
      console.log(JSON.stringify({ ...pair, afterForward: forward, afterReverse: reverse }));
    }
  }
  console.log(JSON.stringify({ baseline: corpus.base, pairs: corpus.pairs.length, transitions }));
} else {
  throw new Error('Expected capture or compare');
}
```

The corpus freezes the current available DB rather than pretending the historical #636 counts
still hold. The existing literal #636/#725 tests remain the deterministic contract; the #664
positive/negative rows in Tasks 1–3 provide independent expected outcomes. Keep the old
`~/warsaw-beer-probes/636/verify-module.ts` as historical context, not a pass/fail oracle:
its prototype predates subsequent asymmetry/year-marker changes and the new approved behavior.

## Planning self-review, 2026-09-28

- Design §§1–2 and the kernel/peers portion of §4 map to U1/U2/U3; the full-source,
  consumer wiring, search, and `spec.md` requirements map to the explicitly deferred
  periphery checkpoint in Task 4. The core is not a complete shipping fix.
- Test snippets were extracted and type-checked against the declared future interfaces
  with the installed TypeScript 7 compiler (`--ignoreConfig --noEmit --strict --skipLibCheck
  --target es2022 --module nodenext --moduleResolution nodenext`): no diagnostics.
- An isolated validation copy of the appendix script captured 4140 pairs from the available
  DB at source revision `2ca8cd5`, then compared the unchanged module: zero transitions.
  Validation used `/tmp/664-plan-validation-corpus.json`; U1 must still capture its own
  fresh execution baseline before source changes. These counts are observations, not assertions.
- Ordinary reader shape, context field names, role reversal, noise protection, and unknown
  fraction fallback were checked for consistency. No production implementation was executed.
