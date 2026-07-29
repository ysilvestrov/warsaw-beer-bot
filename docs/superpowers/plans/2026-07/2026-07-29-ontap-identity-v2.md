# Ontap identity normalization v2 (#306) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the ontap ingest from silently discarding ~148 real tap rows per 3 days, clean the ABV/°Plato spec residue out of stored beer names while preserving the °Plato grade, and forbid fuzzy matching for a bare brand name.

**Architecture:** Tap exclusion (non-beer + Polish out-of-stock placeholders) stays in `src/sources/ontap/non-beer.ts`, which runs before the snapshot is written. Identity cleanup moves out of `src/sources/ontap/pub.ts` into a new pure module `src/sources/ontap/identity.ts` built from four individually tested rules; `pub.ts` keeps DOM parsing only. `refresh-ontap.ts` counts every discarded tap by cause. A separate guard in `src/domain/matcher.ts` blocks the fuzzy fallback when the beer name is just the brewery brand.

**Tech Stack:** TypeScript (CommonJS), Vitest, cheerio, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-29-ontap-identity-v2-design.md`

**Background the engineer needs:**
- A tap row on ontap.pl has two fields: `.brewery` (`brewery_ref`) and an `<h4>` title (`beer_ref`), where the title usually repeats the brewery: `"PINTA Brewery Atak Chmielu 12°·6%"`.
- A trailing `12°` in Czech/Polish listings is the **°Plato grade** and part of the beer identity (`Konrad 10°` ≠ `Konrad 12°`). It must be preserved in the stored name. The matcher already searches both ways: `cleanSearchQuery`/`normalizeName` strip the grade, while stage 3 of `src/domain/untappd-lookup.ts` reads it from the raw name via `extractGrade`. **Do not** add grade handling to the matcher — it is already there.
- Dropping a tap is invisible (no catalog row, no orphan, nothing to triage). Leaving a bad row in is visible (it becomes an orphan). When in doubt, keep the row.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/sources/ontap/identity.ts` (create) | Pure identity cleanup: `stripTrailingSpec`, `sanitizeBrewery`, `dedupeBreweryPrefix`, `extractBeerName`, `resolveTapIdentity` |
| `src/sources/ontap/identity.test.ts` (create) | Table-driven tests per rule, from production data |
| `src/sources/ontap/non-beer.ts` (modify) | Adds `ontapTapExclusion` returning `'non-beer' \| 'placeholder' \| null` |
| `src/sources/ontap/pub.ts` (modify) | DOM parsing only; `extractBeerName`/`normalizeOntapTapIdentity` removed |
| `src/jobs/refresh-ontap.ts` (modify) | Uses `ontapTapExclusion` + `resolveTapIdentity`, counts discards by cause |
| `src/jobs/cleanup-polluted-ontap.ts` (modify) | Imports `extractBeerName` from the new module |
| `src/domain/matcher.ts` (modify) | Bare-brand guard before the fuzzy fallback |
| `spec.md` (modify) | §5.2 invariants: placeholder substring rule + identity policy; §2 file tree |

---

## Task 1: `stripTrailingSpec`

**Files:**
- Create: `src/sources/ontap/identity.ts`
- Create: `src/sources/ontap/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sources/ontap/identity.test.ts`. Every input below is real production data.

```ts
import { stripTrailingSpec } from './identity';

describe('stripTrailingSpec', () => {
  test.each([
    // [input, expected]
    ['Konrad 12° · 5,2%', 'Konrad 12°'],                                    // grade kept, ABV stripped
    ['Bajlando za mango 16°·5,8%%', 'Bajlando za mango 16°'],               // doubled %%
    ['Fizzy 7,7°·2,8%%', 'Fizzy 7,7°'],
    ['Lajtowe 4,5°·0,0%%', 'Lajtowe 4,5°'],
    ['Pszeniczne 12°°·5%', 'Pszeniczne 12°'],                               // doubled °°
    ['CIESZYN PILSNER 11,8%°·4,8%%', 'CIESZYN PILSNER 11,8°'],              // mangled %°
    ['Cookie Monster Ice Destilated N/D°·13%', 'Cookie Monster Ice Destilated'], // N/D is not a grade
    ['Free <0.5°·<0,5%', 'Free'],                                           // "<" ⇒ not a grade
    ['Green IQ <0,5%', 'Green IQ'],
    ['NoLo - Hoptimista <0.5%', 'NoLo - Hoptimista'],
    ['Pilsiwko 0%', 'Pilsiwko'],
    ['Plum Plum Plum 12,5°·4', 'Plum Plum Plum 12,5°'],                     // truncated tail
    ['This ls light 8°·3;5%', 'This ls light 8°'],                          // ";" decimal typo
    ['PAN IPANI BEZALKOHOLOWE 8°·<0.5%', 'PAN IPANI BEZALKOHOLOWE 8°'],
    ['ZGRYFUS | Pastry Sour Ale Blackcurrant & Cherry 5%%',
     'ZGRYFUS | Pastry Sour Ale Blackcurrant & Cherry'],
    ['Buzdygan Rozkoszy 24°·8,5%', 'Buzdygan Rozkoszy 24°'],
    ['Salamander 6%', 'Salamander'],
    // must NOT be touched
    ['La 150° Bionda 8,5%', 'La 150° Bionda'],                              // interior degree
    ['Litovel Pomelo 0% 12°·<0,5%', 'Litovel Pomelo 0% 12°'],               // interior 0% kept
    ['300% Normy', '300% Normy'],                                           // spec is not trailing
    ['11%', '11%'],                                                         // would empty the name
    ['12 12°·4', '12 12°'],
    ['Aperitivo Spritz', 'Aperitivo Spritz'],                               // no spec at all
  ])('%s → %s', (input, expected) => {
    expect(stripTrailingSpec(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sources/ontap/identity.test.ts`
Expected: FAIL — `Failed to resolve import "./identity"`.

- [ ] **Step 3: Write the implementation**

Create `src/sources/ontap/identity.ts` with exactly this content (this regex set is validated against all 23 cases above — do not "simplify" it):

```ts
// A spec atom is one strength/grade token: "12°", "5,8%%", "<0,5%", "N/D°", "3;5%".
// Shops emit doubled unit characters ("%%", "°°", "%°") and ";" for a decimal comma.
const SPEC_ATOM = String.raw`[<>]?\s*(?:\d+(?:[.,;]\d+)?|N\/D)\s*[°%]{1,2}`;
// A truncated tail, i.e. an atom whose unit was cut off by the shop: "…12,5°·4".
const SPEC_TRUNCATED = String.raw`[<>]?\s*\d+(?:[.,;]\d+)?`;
// Atoms are joined by a mid-dot ONLY. Space-joined atoms are NOT chained, so an
// interior spec that is part of the name ("Litovel Pomelo 0% 12°·<0,5%") survives.
const SPEC_SEPARATOR = String.raw`\s*[·•∙]\s*`;
// Anchored to the end of the string: an interior degree ("La 150° Bionda") is never touched.
const TRAILING_SPEC = new RegExp(
  String.raw`\s+(${SPEC_ATOM})(?:${SPEC_SEPARATOR}(?:${SPEC_ATOM}|${SPEC_TRUNCATED}))*\s*$`,
  'iu',
);
// A °Plato grade: numeric, no "<"/">" bound, and its LAST unit character is a degree sign.
// This accepts the mangled shop forms "12°°" and "11,8%°" and normalizes both to "12°"/"11,8°".
const GRADE_ATOM = /^(\d+(?:[.,]\d+)?)\s*[°%]*°$/u;

// Remove a trailing strength/spec block from a tap name, preserving a °Plato grade.
// #306: the grade is part of the identity ("Konrad 10°" ≠ "Konrad 12°"), so it stays in
// the name; the search layer strips it on its own (`stripSearchNoise`) while the czech-grade
// stage (#321) reads it back from the raw name. Never returns an empty string.
export function stripTrailingSpec(raw: string): string {
  const s = raw.trim();
  const match = s.match(TRAILING_SPEC);
  if (!match) return s;
  const grade = match[1].trim().match(GRADE_ATOM);
  const cleaned = `${s.slice(0, match.index)}${grade ? ` ${grade[1]}°` : ''}`.trim();
  return cleaned || s;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sources/ontap/identity.test.ts`
Expected: PASS, 23 assertions.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/identity.ts src/sources/ontap/identity.test.ts
git commit -m "feat(#306): tolerant trailing-spec parser that preserves the °Plato grade"
```

---

## Task 2: `sanitizeBrewery`

Moves the polluted-brewery sentinels and the curated cider mappings out of `pub.ts`. The behaviour change: a sentinel now clears the brewery instead of discarding the whole tap.

**Files:**
- Modify: `src/sources/ontap/identity.ts`
- Modify: `src/sources/ontap/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/sources/ontap/identity.test.ts`:

```ts
import { sanitizeBrewery, stripTrailingSpec } from './identity';

describe('sanitizeBrewery', () => {
  test('clears a known polluted brewery instead of discarding the beer', () => {
    expect(sanitizeBrewery('W Brzesku Brewery', 'Žatecký Nealko'))
      .toEqual({ brewery: '', name: 'Žatecký Nealko' });
    expect(sanitizeBrewery('vaisiu sultys', 'Obuolių'))
      .toEqual({ brewery: '', name: 'Obuolių' });
  });

  test('clears a punctuation-only brewery', () => {
    expect(sanitizeBrewery('- Brewery', 'Pilsner Urquell'))
      .toEqual({ brewery: '', name: 'Pilsner Urquell' });
  });

  test('maps the generic Cydr Dzik listing to the real cidery', () => {
    expect(sanitizeBrewery('CYDR DZIK', 'polski cydr'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik' });
    expect(sanitizeBrewery('CYDR DZIK Brewery', 'Cydr Jabłko'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik Jabłko' });
    expect(sanitizeBrewery('CYDR DZIK Brewery', 'Jabłko'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik Jabłko' });
  });

  test('does not invent a Cydr Dzik product name from a bare cider label', () => {
    expect(sanitizeBrewery('CYDR DZIK Brewery', 'Cydr'))
      .toEqual({ brewery: 'CYDR DZIK Brewery', name: 'Cydr' });
  });

  test('maps Cydr Flirt Tradycynis rows to Kauno Alus product names', () => {
    expect(sanitizeBrewery('Cydr Flirt Tradycynis', 'Cydr malina i skórka pomarańczowa'))
      .toEqual({ brewery: 'Kauno Alus', name: 'Tradycynis Cydr Flirt malina i skórka pomarańczowa' });
    expect(sanitizeBrewery('Cydr Flirt Tradycynis', ''))
      .toEqual({ brewery: 'Kauno Alus', name: 'Tradycynis Cydr Flirt' });
  });

  test('strips a duplicated cider prefix that repeats the brewery', () => {
    expect(sanitizeBrewery('Chyliczki', 'Cydr Chyliczki - Japoński Sad'))
      .toEqual({ brewery: 'Chyliczki', name: 'Japoński Sad' });
  });

  test('passes an ordinary brewery through untouched', () => {
    expect(sanitizeBrewery('Pinta Brewery', 'Atak Chmielu'))
      .toEqual({ brewery: 'Pinta Brewery', name: 'Atak Chmielu' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sources/ontap/identity.test.ts -t sanitizeBrewery`
Expected: FAIL — `sanitizeBrewery is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/sources/ontap/identity.ts` (the helpers are copied verbatim from `pub.ts`, which loses them in Task 6):

```ts
function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compact(raw: string): string {
  return raw.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function normalized(raw: string): string {
  return compact(raw).toLowerCase();
}

// Brewery label without its trailing legal/kind word, e.g. "Pinta Brewery" → "Pinta".
export function breweryCore(raw: string): string {
  return compact(raw)
    .replace(/\s+(?:brewery|browar|brasserie|brouwerij|brauerei|pivovar|birrificio)$/iu, '')
    .trim();
}

function stripLeadingCider(raw: string): string {
  return compact(raw).replace(/^(?:cydr|cider)(?:\s+|$)/iu, '').trim();
}

// Brewery values that are not breweries: a shop location, an ingredient list, or pure
// punctuation. #306: these clear the brewery FIELD; the beer itself is kept, because the
// matcher supports an empty input brewery (relaxed pool, exact-name-only — #149).
const POLLUTED_BREWERIES = new Set([
  'w brzesku brewery',
  'w brzesku',
  'vaisiu sultys',
]);

function isPunctuationOnly(raw: string): boolean {
  const core = breweryCore(raw);
  return core !== '' && !/[\p{L}\p{N}]/u.test(core);
}

export interface TapFields {
  brewery: string;
  name: string;
}

// Normalize the brewery field and any brewery-derived noise inside the name.
export function sanitizeBrewery(breweryRef: string | null, beerRef: string): TapFields {
  const brewery = compact(breweryRef ?? '');
  const name = compact(beerRef);
  const breweryNorm = normalized(brewery);

  if (POLLUTED_BREWERIES.has(breweryNorm) || isPunctuationOnly(brewery)) {
    return { brewery: '', name };
  }

  if (breweryNorm === 'cydr dzik' || breweryNorm === 'cydr dzik brewery') {
    if (normalized(name) === 'polski cydr') return { brewery: 'Cydrownia', name: 'Dzik' };
    const ciderName = stripLeadingCider(name);
    if (!ciderName) return { brewery, name };
    return { brewery: 'Cydrownia', name: `Dzik ${ciderName}` };
  }

  if (breweryNorm === 'cydr flirt tradycynis') {
    const ciderName = stripLeadingCider(name);
    return {
      brewery: 'Kauno Alus',
      name: ciderName ? `Tradycynis Cydr Flirt ${ciderName}` : 'Tradycynis Cydr Flirt',
    };
  }

  const core = breweryCore(brewery);
  if (core) {
    const ciderPrefix = new RegExp(`^(?:cydr|cider)\\s+${escapeRegExp(core)}\\s*[-–—:]\\s*`, 'iu');
    const stripped = name.replace(ciderPrefix, '').trim();
    if (stripped) return { brewery, name: stripped };
  }

  return { brewery, name };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sources/ontap/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/identity.ts src/sources/ontap/identity.test.ts
git commit -m "feat(#306): sanitize the polluted brewery field instead of dropping the tap"
```

---

## Task 3: `dedupeBreweryPrefix` and `extractBeerName`

`extractBeerName` turns the `<h4>` title into a beer name. It moves here and gains the rule that it must never empty the name.

**Files:**
- Modify: `src/sources/ontap/identity.ts`
- Modify: `src/sources/ontap/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/sources/ontap/identity.test.ts`:

```ts
import { extractBeerName } from './identity';

describe('extractBeerName', () => {
  test('strips the brewery prefix and the trailing spec', () => {
    expect(extractBeerName('Harpagan Brewery Buzdygan Rozkoszy 24°·8,5%', 'Harpagan Brewery'))
      .toBe('Buzdygan Rozkoszy 24°');
    expect(extractBeerName('Stu Mostów WRCLW Salamander 6%', 'Stu Mostów'))
      .toBe('WRCLW Salamander');
  });

  test('strips the brewery core when the title omits the kind word', () => {
    expect(extractBeerName('PINTA Atak Chmielu 6%', 'PINTA Brewery')).toBe('Atak Chmielu');
  });

  test('is case-insensitive on the brewery prefix', () => {
    expect(extractBeerName('PINTA Atak Chmielu 6%', 'Pinta')).toBe('Atak Chmielu');
  });

  test('keeps the name when it is exactly the brand (#306: never empty it)', () => {
    expect(extractBeerName('Guinness Brewery Guinness', 'Guinness Brewery')).toBe('Guinness');
    expect(extractBeerName('Pinta', 'Pinta')).toBe('Pinta');
    expect(extractBeerName('Cydr Dzik', 'Cydr Dzik')).toBe('Cydr Dzik');
  });

  test('keeps an interior degree mark that is part of the name', () => {
    expect(extractBeerName('Birra Menabrea Brewery La 150° Bionda 4,8%', 'Birra Menabrea Brewery'))
      .toBe('La 150° Bionda');
  });

  test('returns the full text when there is no brewery and no spec', () => {
    expect(extractBeerName('Aperitivo Spritz', null)).toBe('Aperitivo Spritz');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sources/ontap/identity.test.ts -t extractBeerName`
Expected: FAIL — `extractBeerName is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/sources/ontap/identity.ts`:

```ts
// Drop a leading brewery prefix from a tap title. Both the full label ("PINTA Brewery ")
// and its core ("PINTA ") are tried, longest first. #306: when the title IS the brand
// ("Guinness Brewery" / "Guinness"), the name is kept as-is — emptying it here is what
// used to make single-brand taps disappear at ingest.
export function dedupeBreweryPrefix(name: string, breweryRef: string | null): string {
  const brewery = compact(breweryRef ?? '');
  if (!brewery) return name;
  const prefixes = [brewery, breweryCore(brewery)]
    .filter((p) => p !== '')
    .sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (name.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      const remainder = name.slice(prefix.length + 1).trim();
      if (remainder) return remainder;
    }
  }
  return name;
}

// Turn an <h4> tap title into a beer name: "Harpagan Brewery Buzdygan 24°·8,5%" → "Buzdygan 24°".
export function extractBeerName(h4Text: string, breweryRef: string | null): string {
  return dedupeBreweryPrefix(stripTrailingSpec(compact(h4Text)), breweryRef);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sources/ontap/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/identity.ts src/sources/ontap/identity.test.ts
git commit -m "feat(#306): brewery-prefix dedupe that never empties the beer name"
```

---

## Task 4: `resolveTapIdentity`

**Files:**
- Modify: `src/sources/ontap/identity.ts`
- Modify: `src/sources/ontap/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/sources/ontap/identity.test.ts`:

```ts
import { resolveTapIdentity } from './identity';

describe('resolveTapIdentity', () => {
  test.each([
    ['Guinness Brewery', 'Guinness', 'Guinness Brewery', 'Guinness'],
    ['Pilsner Urquell Brewery', 'Pilsner Urquell', 'Pilsner Urquell Brewery', 'Pilsner Urquell'],
    ['Holba Brewery', 'Holba', 'Holba Brewery', 'Holba'],
    ['Cydr Dobroński', 'Cydr Dobroński', 'Cydr Dobroński', 'Cydr Dobroński'],
    ['Frankies Brewery', 'Frankies', 'Frankies Brewery', 'Frankies'],
    ['Konrad Brewery', 'Konrad 12° · 5,2%', 'Konrad Brewery', 'Konrad 12°'],
  ])('keeps %s | %s', (breweryRef, beerRef, brewery, name) => {
    expect(resolveTapIdentity(breweryRef, beerRef)).toEqual({ kind: 'keep', brewery, name });
  });

  test('keeps the beer when the brewery field is polluted', () => {
    expect(resolveTapIdentity('W Brzesku Brewery', 'Žatecký Nealko'))
      .toEqual({ kind: 'keep', brewery: '', name: 'Žatecký Nealko' });
  });

  test('drops only an empty name', () => {
    expect(resolveTapIdentity('Some Brewery', '')).toEqual({ kind: 'drop', reason: 'empty-name' });
    expect(resolveTapIdentity('Some Brewery', '   ')).toEqual({ kind: 'drop', reason: 'empty-name' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sources/ontap/identity.test.ts -t resolveTapIdentity`
Expected: FAIL — `resolveTapIdentity is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/sources/ontap/identity.ts`:

```ts
export type TapIdentity =
  | { kind: 'keep'; brewery: string; name: string }
  | { kind: 'drop'; reason: 'empty-name' };

// #306: the ONLY reason this layer may discard a tap is an empty name. Anything else —
// a name equal to the brand, an unknown brewery, junk — flows through and becomes a
// visible orphan. A dropped tap produces no catalog row, no match link and no orphan,
// i.e. it is unobservable; an orphan is triaged daily and can be pinned (#343/#361).
export function resolveTapIdentity(breweryRef: string | null, beerRef: string): TapIdentity {
  const sanitized = sanitizeBrewery(breweryRef, beerRef);
  const name = dedupeBreweryPrefix(stripTrailingSpec(sanitized.name), sanitized.brewery);
  if (!name) return { kind: 'drop', reason: 'empty-name' };
  return { kind: 'keep', brewery: sanitized.brewery, name };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sources/ontap/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/identity.ts src/sources/ontap/identity.test.ts
git commit -m "feat(#306): resolveTapIdentity — drop only on an empty name"
```

---

## Task 5: Placeholder exclusion in `non-beer.ts`

Polish out-of-stock markers are scraped as brewery + beer (`- Brewery / Guinness Chwilowy brak:(`). They are not taps and must not be snapshotted, exactly like the existing `kran w serwisie` sentinel.

**Files:**
- Modify: `src/sources/ontap/non-beer.ts`
- Modify: `src/sources/ontap/non-beer.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/sources/ontap/non-beer.test.ts`:

```ts
import { ontapTapExclusion } from './non-beer';

describe('ontapTapExclusion', () => {
  test.each([
    ['out-of-stock beer_ref', { style: null, brewery_ref: '- Brewery', beer_ref: 'Guinness Chwilowy brak:(' }],
    ['bare out-of-stock', { style: null, brewery_ref: '- Brewery', beer_ref: 'Chwilowy Brak:(' }],
    ['drunk-up placeholder', { style: null, brewery_ref: 'Chwilowy Brak:( Brewery', beer_ref: 'Wypite' }],
    ['tap out of service', { style: null, brewery_ref: 'Kran czeka na lepsze czasy Brewery', beer_ref: 'KRAN W SERWISIE' }],
  ])('classifies %s as a placeholder', (_label, tap) => {
    expect(ontapTapExclusion(tap)).toBe('placeholder');
  });

  test('classifies wine as non-beer', () => {
    expect(ontapTapExclusion({ style: 'PROSECCO', brewery_ref: 'Cantine Vitevis' })).toBe('non-beer');
  });

  test('returns null for a real beer', () => {
    expect(ontapTapExclusion({ style: 'IPA', brewery_ref: 'Pinta Brewery', beer_ref: 'Atak Chmielu' }))
      .toBeNull();
  });

  test('keeps a real beer whose name merely contains a brand called Wypite-like word', () => {
    expect(ontapTapExclusion({ style: 'Lager', brewery_ref: 'Browar Kormoran', beer_ref: 'Kormoran Miodne' }))
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts -t ontapTapExclusion`
Expected: FAIL — `ontapTapExclusion is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/sources/ontap/non-beer.ts`, delete the `EXACT_BEER_SENTINELS` constant and its use inside `isOntapNonBeerTap`, then add:

```ts
// Shop-UI placeholders scraped as a tap: "temporarily out", "drunk up", "tap out of service".
// Substring match on BOTH fields — "Guinness Chwilowy brak:(" means the Guinness ran out, it
// is not a beer with that name. Curated phrases only, never a regex heuristic: this is a finite
// set of shop strings, and a false drop is invisible while a missed placeholder stays a visible
// orphan (#306).
const PLACEHOLDER_PHRASES = [
  'chwilowy brak',
  'wypite',
  'kran w serwisie',
  'czeka na lepsze czasy',
];

function isPlaceholder(value: string): boolean {
  const v = norm(value);
  return v !== '' && PLACEHOLDER_PHRASES.some((phrase) => v.includes(phrase));
}

export type TapExclusion = 'non-beer' | 'placeholder';

// Why a tap must not become a snapshot row, or null when it is a normal beer.
export function ontapTapExclusion(tap: OntapNonBeerInput): TapExclusion | null {
  if (isPlaceholder(tap.beer_ref ?? '') || isPlaceholder(tap.brewery_ref ?? '')) {
    return 'placeholder';
  }
  return isOntapNonBeerTap(tap) ? 'non-beer' : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts`
Expected: PASS. The pre-existing `kran w serwisie` case now passes through `isPlaceholder`; if an old test asserted `isOntapNonBeerTap({beer_ref: 'KRAN W SERWISIE', …}) === true`, change that assertion to `ontapTapExclusion(...) === 'placeholder'`.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/non-beer.ts src/sources/ontap/non-beer.test.ts
git commit -m "feat(#306): classify Polish out-of-stock placeholders as tap exclusions"
```

---

## Task 6: Rewire `pub.ts`, `refresh-ontap.ts`, `cleanup-polluted-ontap.ts`

**Files:**
- Modify: `src/sources/ontap/pub.ts` (delete `extractBeerName`, `normalizeOntapTapIdentity` and their helpers; import from `identity.ts`)
- Modify: `src/sources/ontap/pub.test.ts` (move identity tests out; keep DOM tests)
- Modify: `src/jobs/refresh-ontap.ts:76-108`
- Modify: `src/jobs/cleanup-polluted-ontap.ts:3`
- Modify: `src/jobs/refresh-ontap.test.ts`

- [ ] **Step 1: Rewrite the test that asserts the old dropping behaviour**

`src/jobs/refresh-ontap.test.ts:208` currently asserts exactly what #306 reverses ("drops ontap
parser-polluted brewery-only and location rows before catalog writes" — it expects only the PINTA
row to survive). Replace that whole test with the version below. It reuses the file's existing
`panel(tap, brewery, h4, style)` helper (defined at the bottom of the file) and the same
`refreshOntap({...})` call shape as its neighbours:

```ts
  test('#306: keeps brand-name and polluted-brewery rows, drops only placeholders', async () => {
    const db = openDb(':memory:');
    migrate(db);

    const indexHtml = `
      <div onclick="location.assign('https://polluted.ontap.pl/')">
        <div class="panel-body">Polluted Pub 6 taps</div>
      </div>
    `;
    const pubHtml = `
      <html><head><meta property="og:title" content="Polluted Pub / ontap.pl"></head>
      <body>
        ${panel(1, 'Przetwórnia Chmielu Brewery', 'Przetwórnia Chmielu Brewery 5%', 'Pszeniczne')}
        ${panel(2, 'Frankies Brewery', 'Frankies Brewery 4,5%', 'Svetlý Ležák')}
        ${panel(3, 'W Brzesku Brewery', 'Žatecký Nealko 0%', 'Pilzner bezalkoholowy')}
        ${panel(4, 'PINTA Brewery', 'PINTA Atak Chmielu 6%', 'West Coast IPA')}
        ${panel(5, '- Brewery', 'Guinness Chwilowy brak:(', 'Stout')}
        ${panel(6, 'Konrad Brewery', 'Konrad 12°·5,2%', 'Světlý ležák')}
      </body></html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://polluted.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder: async () => null,
      lookupEnabled: false, cities: CITIES.filter((c) => c.slug === 'warszawa'),
    });

    const beers = db.prepare('SELECT brewery, name FROM beers ORDER BY id').all();
    expect(beers).toEqual([
      // brewery-only row: kept, because "name == brand" is not evidence of garbage
      { brewery: 'Przetwórnia Chmielu Brewery', name: 'Przetwórnia Chmielu' },
      { brewery: 'Frankies Brewery', name: 'Frankies' },
      // polluted brewery cleared, the beer survives
      { brewery: '', name: 'Žatecký Nealko' },
      { brewery: 'PINTA Brewery', name: 'Atak Chmielu' },
      // the °Plato grade stays in the name, only the ABV tail is stripped
      { brewery: 'Konrad Brewery', name: 'Konrad 12°' },
    ]);
    // the placeholder tap is excluded before the snapshot is written
    const taps = tapsForSnapshot(db, latestSnapshot(db, listPubs(db)[0].id)!.id);
    expect(taps.map((t) => t.beer_ref)).not.toContain('Guinness Chwilowy brak:(');
  });
```

Note the two behaviour changes encoded here that the old test contradicted: `PINTA Atak Chmielu`
becomes `Atak Chmielu` (the brewery core is now stripped from the title, Task 3), and the polluted
`W Brzesku` row survives with an empty brewery.

- [ ] **Step 1b: Add the discard-counter test**

```ts
  test('#306: counts discarded taps by cause', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const records: Array<Record<string, unknown>> = [];
    const log = { ...silentLog, info: (obj: unknown, msg?: string) => { records.push({ ...(obj as object), msg }); } } as typeof silentLog;

    const indexHtml = `
      <div onclick="location.assign('https://counted.ontap.pl/')">
        <div class="panel-body">Counted Pub 3 taps</div>
      </div>
    `;
    const pubHtml = `
      <html><head><meta property="og:title" content="Counted Pub / ontap.pl"></head>
      <body>
        ${panel(1, 'PINTA Brewery', 'PINTA Atak Chmielu 6%', 'West Coast IPA')}
        ${panel(2, '- Brewery', 'Chwilowy Brak:(', 'Stout')}
        ${panel(3, 'Cantine Vitevis', 'Cantine Vitevis Prosecco', 'PROSECCO')}
      </body></html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://counted.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db, log, http, search: { search: async () => [] }, geocoder: async () => null,
      lookupEnabled: false, cities: CITIES.filter((c) => c.slug === 'warszawa'),
    });

    expect(records).toContainEqual(
      expect.objectContaining({ msg: 'ontap taps discarded', placeholder: 1, 'non-beer': 1, 'empty-name': 0 }),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: FAIL — the `Guinness` row is missing from `beers` (it is dropped today).

- [ ] **Step 3: Write the implementation**

In `src/sources/ontap/pub.ts`: delete `escapeRegExp`, `compact`, `normalized`, `breweryCore`, `stripLeadingCider`, `breweryPrefixes`, `extractBeerName`, `POLLUTED_BREWERIES` and `normalizeOntapTapIdentity`. Keep `isOntapEmptyTapRef`, the interfaces and `parsePubPage`. Add at the top:

```ts
import { extractBeerName } from './identity';
```

`parsePubPage` keeps calling `extractBeerName(h4Text, brewery_ref)` exactly as before, so its body does not change.

In `src/jobs/cleanup-polluted-ontap.ts`, change line 3 to:

```ts
import { extractBeerName } from '../sources/ontap/identity';
```

In `src/jobs/refresh-ontap.ts`, replace the import of `normalizeOntapTapIdentity`:

```ts
import { isOntapEmptyTapRef, parsePubPage } from '../sources/ontap/pub';
import { resolveTapIdentity } from '../sources/ontap/identity';
import { ontapTapExclusion } from '../sources/ontap/non-beer';
```

Replace the non-beer filter (currently `refresh-ontap.ts:76-81`) with a counting version:

```ts
        const discarded = { 'non-beer': 0, placeholder: 0, 'empty-name': 0 };
        const taps = parsedTaps.filter((t) => {
          const exclusion = ontapTapExclusion(t);
          if (!exclusion) return true;
          discarded[exclusion]++;
          return false;
        });
```

Replace the identity call (currently `refresh-ontap.ts:107-109`) with:

```ts
          const identity = resolveTapIdentity(t.brewery_ref, t.beer_ref);
          if (identity.kind === 'drop') {
            discarded[identity.reason]++;
            continue;
          }
          const { brewery, name } = identity;
```

Immediately after the tap loop ends (before the pub's `catch`), replace the old `droppedNonBeer` log with:

```ts
        if (discarded['non-beer'] + discarded.placeholder + discarded['empty-name'] > 0) {
          log.info({ slug: ip.slug, ...discarded }, 'ontap taps discarded');
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts src/sources/ontap`
Expected: PASS. Delete the now-obsolete `extractBeerName` / `normalizeOntapTapIdentity` describes from `src/sources/ontap/pub.test.ts` (they live in `identity.test.ts` now) and keep only `parsePubPage` / `tap_number` / `isOntapEmptyTapRef` coverage.

- [ ] **Step 5: Run the whole suite and the type checker**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sources/ontap src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts src/jobs/cleanup-polluted-ontap.ts
git commit -m "feat(#306): route ontap ingest through the identity module and count discards"
```

---

## Task 7: Bare-brand guard in the matcher

Measured on the production catalog: with the taps flowing again, `Holba / Holba` fuzzy-matches `Holba Šerák` (untappd 99098) and `Litovel / Litovel` matches `Litovel Dark` (717906). A wrong match shows a stranger's rating and marks the beer drunk; an orphan does not.

**Files:**
- Modify: `src/domain/matcher.ts` (the fuzzy fallback, currently `matcher.ts:432-455`)
- Modify: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/matcher.test.ts`. The file already imports `prepareCatalog` and `matchPrepared`
(line 1) and builds catalogs as plain `CatalogBeer[]` arrays — follow that style, and note
`prepareCatalog` is **synchronous** (there is also an async `prepareCatalogChunked` in
`./catalog-cache`; do not use it here):

```ts
describe('#306 bare-brand guard', () => {
  const cat: CatalogBeer[] = [
    { id: 1, brewery: 'Holba', name: 'Holba Šerák', abv: 4.7 },
    { id: 2, brewery: 'Litovel', name: 'Litovel Dark', abv: 4.5 },
    { id: 3, brewery: 'Umorušany Janíček Brewery', name: 'Umorušany Janíček', abv: 4.5 },
  ];

  test('a name that is only the brand never fuzzy-matches a specific product', () => {
    const prepared = prepareCatalog(cat);
    expect(matchPrepared({ brewery: 'Holba Brewery', name: 'Holba', abv: null }, prepared)).toBeNull();
    expect(matchPrepared({ brewery: 'Litovel Brewery', name: 'Litovel', abv: null }, prepared)).toBeNull();
  });

  test('an exact match on the same input still wins', () => {
    const m = matchPrepared(
      { brewery: 'Umorušany Janíček Brewery', name: 'Umorušany Janíček', abv: null },
      prepareCatalog(cat),
    );
    expect(m).toMatchObject({ id: 3, source: 'exact' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/matcher.test.ts -t "bare-brand"`
Expected: FAIL — `Holba` returns `{ id: 1, source: 'fuzzy' }` instead of `null`.

- [ ] **Step 3: Write the implementation**

In `src/domain/matcher.ts`, immediately before the fuzzy fallback block (the line `const pool = breweryMatches;`), insert:

```ts
  // #306 bare-brand guard: when the beer name carries nothing beyond the brewery brand
  // ("Holba Brewery / Holba"), a fuzzy hit would attach an arbitrary product of that
  // brewery ("Holba Šerák") and inherit its rating and drunk state. Exact stages have
  // already run and missed, so the honest outcome is an orphan. Mirrors the relaxed-pool
  // rule in untappd-lookup.ts ("exact only, never approximate fuzzy").
  if (nn !== '' && nn === normalizeBrewery(input.brewery)) return null;
```

Confirm `normalizeBrewery` is imported in `matcher.ts`; if not, add it to the existing `./normalize` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "fix(#306): a bare brand name may match exactly, never fuzzily"
```

---

## Task 8: Update `spec.md`

`spec.md` is the project's single source of truth (see `CLAUDE.md`) and its §5.2 invariant currently **forbids** what Task 5 implements ("`beer_ref`/назва використовується лише для нормалізованого точного sentinel `kran w serwisie` … без substring/fuzzy-фільтрації").

**Files:**
- Modify: `spec.md` (§2 file tree near line 88; §5.2 invariants near line 1109)

- [ ] **Step 1: Update the file tree**

In the `src/sources/ontap/` block (around `spec.md:86-88`), replace the `pub.ts` line with:

```
│   ├── ontap/
│   │   ├── index.ts        # парсер індексу /warszawa (список пабів)
│   │   ├── identity.ts     # очистка tap-ідентичності (spec/градус/броварня) — #306
│   │   ├── non-beer.ts     # gate: не-пиво + плейсхолдери «нема в наливі»
│   │   └── pub.ts          # парсер сторінки паба (лише DOM)
```

- [ ] **Step 2: Rewrite the "Ontap non-beer gate" invariant**

Replace the whole `- **Ontap non-beer gate.**` bullet (around `spec.md:1109-1118`) with:

```markdown
- **Ontap tap-exclusion gate.** `refreshOntap` ПОВИНЕН відкидати **до** створення
  snapshot/tap рядків: (а) очевидні не-пивні крани
  (wine/prosecco/frizzante/spritz/cocktails/nalewka/szprycer/kombucha, brewery_ref-сміття
  парсера — schedule/nav рядки на кшталт `-> … od 18.00`) і (б) крамничні плейсхолдери
  «нема в наливі» (`chwilowy brak`, `wypite`, `kran w serwisie`, `czeka na lepsze czasy`).
  Сигнали (а) — `taps.style` і `taps.brewery_ref`; сигнал (б) — **підрядок** у `beer_ref`
  АБО `brewery_ref` із курованого списку фраз (`Guinness Chwilowy brak:(` — це «Guinness
  закінчився», а не пиво). Курований список фраз — єдиний дозволений substring-фільтр;
  регексп-евристик і fuzzy тут немає, щоб не провокувати широкі Untappd-запити на кшталт
  `wino`/`merlot`. Cider, kvass/`Kwas chlebowy`/`квас` і mead/melomel лишаються eligible.
- **Ontap identity policy (#306).** Шар ontap-ідентичності (`sources/ontap/identity.ts`)
  НЕ МАЄ права викидати кран за формою рядка: єдина причина дропу — **порожня назва**
  після очистки. Назва, що дорівнює бренду броварні (`Guinness / Guinness`), проходить
  далі; сміттєве значення `brewery_ref` (локація, список інгредієнтів, лише пунктуація)
  **обнуляє поле броварні**, а не викидає пиво. Причина: дроп невидимий (нема ані рядка
  каталогу, ані orphan-а), orphan — видимий і пінований (#343/#361). Кожен відкинутий кран
  ПОВИНЕН потрапляти в лічильник за причиною (`ontap taps discarded`).
- **°Plato-градус — частина назви.** Трейлінг `12°` у CZ/PL-лістингах зберігається у
  `beers.name` (`Konrad 10°` ≠ `Konrad 12°`); ріжеться лише ABV-хвіст. Пошук працює в
  обидві сторони: `cleanSearchQuery`/`normalizeName` градус прибирають, а стадія
  czech-grade (#321) читає його з сирої назви через `extractGrade`.
- **Голий бренд — тільки exact.** Якщо `normalizeName(name)` дорівнює нормалізованому
  бренду броварні, `matchPrepared` НЕ МАЄ права падати у fuzzy-fallback: краще orphan,
  ніж довільний продукт цієї броварні з чужим рейтингом і статусом «випите».
```

- [ ] **Step 3: Verify no other section contradicts**

Run: `grep -n "kran w serwisie\|non-beer gate\|extractBeerName" spec.md`
Expected: only the lines you just wrote plus the file-tree entry; fix any leftover reference to `pub.ts + extractBeerName`.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(#306): spec — tap-exclusion gate, identity policy, grade and bare-brand rules"
```

---

## Task 9: Verification against production data

**Files:**
- Create: `tmp/replay-ontap-identity.ts` (scratch, not committed — `./tmp/` is gitignored)

- [ ] **Step 1: Write the replay script**

```ts
import Database from 'better-sqlite3';
import { resolveTapIdentity } from '../src/sources/ontap/identity';
import { ontapTapExclusion } from '../src/sources/ontap/non-beer';

const db = new Database('/var/lib/warsaw-beer-bot/bot.db', { readonly: true });
const rows = db.prepare(`
  SELECT t.brewery_ref, t.beer_ref, t.style, COUNT(*) AS n
    FROM taps t JOIN tap_snapshots s ON s.id = t.snapshot_id
   WHERE s.snapshot_at >= date('now','-3 day')
   GROUP BY 1, 2, 3
`).all() as Array<{ brewery_ref: string | null; beer_ref: string; style: string | null; n: number }>;

const buckets: Record<string, Array<string>> = { 'non-beer': [], placeholder: [], 'empty-name': [], 'spec-residue': [] };
for (const r of rows) {
  const exclusion = ontapTapExclusion(r);
  if (exclusion) { buckets[exclusion].push(`${r.n}\t${r.brewery_ref} | ${r.beer_ref}`); continue; }
  const id = resolveTapIdentity(r.brewery_ref, r.beer_ref);
  if (id.kind === 'drop') { buckets[id.reason].push(`${r.n}\t${r.brewery_ref} | ${r.beer_ref}`); continue; }
  // A kept name may legitimately contain "%" or "°" INSIDE it ("300% Normy", "La 150° Bionda",
  // "Litovel Pomelo 0% 12°"). What must never survive is a trailing "%" or a mid-dot spec join.
  if (/%\s*$/u.test(id.name) || /[·•∙]/u.test(id.name)) {
    buckets['spec-residue'].push(`${r.n}\t${id.brewery} | ${id.name}`);
  }
}
for (const [k, v] of Object.entries(buckets)) console.log(`\n=== ${k} (${v.length}) ===\n${v.join('\n')}`);
```

- [ ] **Step 2: Run it**

Run: `npx tsx tmp/replay-ontap-identity.ts`
Expected: the `empty-name` bucket is empty or contains only genuinely nameless rows; `placeholder` contains the `Chwilowy Brak:(` rows; `non-beer` contains wine/Kofola/Mojito rows; `spec-residue` is empty. **No real beer (Guinness, Pilsner Urquell, Holba, Litovel, Herrnbrau, Blanche de Namur, Umorušany Janíček, Cydr Dzik, Cydr Dobroński, Žatecký …) may appear in any drop bucket.** If one does, the rule that put it there is wrong — fix it before opening the PR.

- [ ] **Step 3: Dry-run the catalog cleanup job**

`cleanupPollutedOntap` runs at process start (`src/index.ts:66`) and rewrites/merges polluted catalog names using `extractBeerName`, so its behaviour changes with this PR. Copy the production DB and inspect the plan before it ever runs for real:

```bash
cp /var/lib/warsaw-beer-bot/bot.db tmp/prod-copy.db
```

Then write `tmp/dry-cleanup.ts` that opens `tmp/prod-copy.db`, calls `cleanupPollutedOntap(db, log)` and prints the resulting `{ rewritten, merged }` plus a before/after listing of every changed row:

```ts
import Database from 'better-sqlite3';
import pino from 'pino';
import { cleanupPollutedOntap } from '../src/jobs/cleanup-polluted-ontap';

const db = new Database('tmp/prod-copy.db');
const before = db.prepare("SELECT id, brewery, name FROM beers WHERE name LIKE '%°%' OR name LIKE '%\\%%' ESCAPE '\\'").all() as Array<{ id: number; brewery: string; name: string }>;
cleanupPollutedOntap(db as never, pino({ level: 'info' })).then(() => {
  for (const b of before) {
    const after = db.prepare('SELECT name FROM beers WHERE id = ?').get(b.id) as { name: string } | undefined;
    if (!after) console.log(`MERGED/GONE  #${b.id} ${b.brewery} — ${b.name}`);
    else if (after.name !== b.name) console.log(`REWRITTEN    #${b.id} "${b.name}" → "${after.name}"`);
  }
});
```

Run: `npx tsx tmp/dry-cleanup.ts`
Expected: every rewrite is an improvement (spec residue removed, °Plato grade kept). Report the list in the PR description. If a rewrite looks wrong (e.g. a merge at confidence ≥ 0.9 onto the wrong beer), stop and raise it — do not deploy.

- [ ] **Step 4: Clean the scratch directory**

```bash
rm -f tmp/prod-copy.db tmp/replay-ontap-identity.ts tmp/dry-cleanup.ts
```

---

## Task 10: Open the PR

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm test`
Expected: PASS, no skipped suites.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin <branch>
gh pr create --title "fix(#306): ontap identity normalization v2 — stop dropping real taps" --body "$(cat <<'EOF'
Closes #306.

## What
- `src/sources/ontap/identity.ts`: tolerant trailing-spec parser (`%%`, `°°`, `%°`, `<`/`>`,
  `N/D°`, `;` decimals, truncated tails) that **preserves the trailing °Plato grade**;
  brewery sanitation that clears a polluted brewery field instead of discarding the beer;
  brewery-prefix dedupe that never empties the name.
- Ontap ingest may now discard a tap only on a positive non-beer/placeholder signal or an
  empty name; every discard is counted by cause (`ontap taps discarded`).
- Polish out-of-stock placeholders (`chwilowy brak`, `wypite`, `kran w serwisie`,
  `czeka na lepsze czasy`) are excluded before the snapshot is written.
- `matchPrepared`: a bare brand name may match exactly, never fuzzily.
- `spec.md` §5.2 invariants updated (the old wording forbade the placeholder substring rule).

## Why
A 3-day production replay showed `#238`'s guards silently discarding 14 identities / 148 tap
rows — Guinness, Pilsner Urquell, Holba, Litovel, Herrnbrau, Blanche de Namur, Umorušany
Janíček, both ciders, and `Žatecký Nealko` (killed together with its bad brewery field).
A dropped tap produces no catalog row, no match link and no orphan, so the regression was
invisible to triage.

## Verification
- Replay of the last 3 days of production taps: drop buckets contain only non-beer and
  placeholder rows; no spec residue survives in a kept name.
- `cleanupPollutedOntap` dry-run against a copy of the production DB (plan reviewed).
- `npm run typecheck && npm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01CoKXfbwgs7ygxUCTnUZTpb
EOF
)"
```

- [ ] **Step 3: Wait for the AI review, then read it critically**

Poll the PR for the AI review by head SHA, verify each comment against the code, push back on wrong ones and fix valid ones. The task is not done at green tests.

---

## Post-merge rollout (not part of the PR)

1. Deploy: `bash deploy/deploy.sh`.
2. After the next ontap cron, check the logs for `ontap taps discarded` and confirm the counts match the replay.
3. Re-arm affected orphans: `npm run rearm-matcher-bug-orphans` (or `-- --ids <list>` for targeted rows). Without a count reset, backed-off rows are never re-queried.
4. Retire fossils that do not resurrect (e.g. `12289`) via #286.
5. Measure: new catalog entries created, how many matched immediately, how many became orphans, and whether daily triage volume stays in single digits.
