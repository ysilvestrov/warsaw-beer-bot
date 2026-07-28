# Triage Evidence Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daily orphan-triage LLM from inventing causal hypotheses by giving it real search evidence, and by refusing to publish any cause that does not survive an automatic re-query.

**Architecture:** Three additions around the existing job, all behind the existing `BeerSearch` seam so they are unit-testable with a fake: (1) two deterministic probe searches per zero-candidate orphan, injected into the prompt; (2) bid/ABV/style added to candidate summaries plus the shop's own ABV/style in the payload; (3) two new optional verdict fields (`proposed_query`, `expected_target`) that the job re-runs before any GitHub write — unverified causes are downgraded to a plain classification. Every new path degrades to today's behaviour on error.

**Tech Stack:** TypeScript (CommonJS), Vitest, better-sqlite3, zod + Anthropic strict tool schema, Algolia-backed `BeerSearch`.

**Design doc:** `docs/superpowers/specs/2026-07/2026-07-28-triage-evidence-pipeline-design.md`

---

## File Structure

- Create `src/domain/candidate-format.ts` — single formatter for a `SearchResult` line and for a top-3 summary. Used by `lookup-outcome.ts` (failure rows) and by the probe collector, so both render evidence identically.
- Create `src/domain/candidate-format.test.ts`
- Create `src/domain/triage-probes.ts` — `collectTriageProbes()`: brewery-only and name-only searches for zero-candidate orphans, with a per-run cap and error swallowing.
- Create `src/domain/triage-probes.test.ts`
- Create `src/domain/triage-verify.ts` — `verifyCauses()`: re-runs each causal verdict's `proposed_query` and reports whether `expected_target` appeared.
- Create `src/domain/triage-verify.test.ts`
- Modify `src/domain/lookup-outcome.ts:15-19` — delegate `summarizeCandidates` to the new module.
- Modify `src/storage/enrich_failures.ts:139-165` — `UntriagedFailure` gains `abv`/`style`; the query joins `beers`.
- Modify `src/domain/triage-analysis.ts` — payload gains probes + abv/style; verdict schema gains the two fields; prompt explains both.
- Modify `src/jobs/orphan-triage.ts` — wire probes before `llm.analyze`, verification after it, `unverified` counter in the digest line.
- Modify `spec.md` §5.11 — document probes, enriched evidence, verification gate, and the new env var.
- Modify `.env.example` — `TRIAGE_PROBE_LIMIT`.

---

### Task 1: Shared candidate formatter with bid / ABV / style

**Files:**
- Create: `src/domain/candidate-format.ts`
- Create: `src/domain/candidate-format.test.ts`
- Modify: `src/domain/lookup-outcome.ts:15-19`

- [ ] **Step 1: Write the failing test**

Create `src/domain/candidate-format.test.ts`:

```typescript
import { test, expect } from 'vitest';
import { formatCandidate, summarizeCandidates } from './candidate-format';
import type { SearchResult } from '../sources/untappd/search';

const r = (over: Partial<SearchResult> = {}): SearchResult => ({
  bid: 1511478,
  beer_name: 'Cornelius Hazy APA',
  brewery_name: 'Browar Cornelius',
  style: 'IPA - American',
  abv: 5,
  global_rating: null,
  ...over,
});

test('formatCandidate renders brewery, name, bid, abv and style', () => {
  expect(formatCandidate(r())).toBe(
    'Browar Cornelius — Cornelius Hazy APA (bid 1511478, 5.0%, IPA - American)',
  );
});

test('formatCandidate omits missing abv and style without leaving gaps', () => {
  expect(formatCandidate(r({ abv: null, style: null }))).toBe(
    'Browar Cornelius — Cornelius Hazy APA (bid 1511478)',
  );
});

test('summarizeCandidates joins at most three candidates', () => {
  const many = [r({ bid: 1 }), r({ bid: 2 }), r({ bid: 3 }), r({ bid: 4 })];
  const out = summarizeCandidates(many);
  expect(out.split('; ')).toHaveLength(3);
  expect(out).toContain('bid 1');
  expect(out).not.toContain('bid 4');
});

test('summarizeCandidates renders an empty list as an empty string', () => {
  expect(summarizeCandidates([])).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/candidate-format.test.ts`
Expected: FAIL — `Failed to resolve import "./candidate-format"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/candidate-format.ts`:

```typescript
import type { SearchResult } from '../sources/untappd/search';

const MAX_SUMMARY_ITEMS = 3;

// One evidence line for a search hit. bid/ABV/style are what let a reader (the
// triage LLM, or a human debugging enrich_failures) tell sibling variants apart:
// ABV separates a 0.5% non-alcoholic twin from its 4.5% original, and the bid
// makes the claim checkable. Absent fields are omitted rather than rendered as
// "null" so the line stays readable.
export function formatCandidate(r: SearchResult): string {
  const facts = [`bid ${r.bid}`];
  if (r.abv != null) facts.push(`${r.abv.toFixed(1)}%`);
  if (r.style) facts.push(r.style);
  return `${r.brewery_name} — ${r.beer_name} (${facts.join(', ')})`;
}

// Compact, human-readable summary of what a search returned — top 3 lines.
// Empty string when the search returned nothing (a noisy query).
export function summarizeCandidates(candidates: SearchResult[]): string {
  return candidates.slice(0, MAX_SUMMARY_ITEMS).map(formatCandidate).join('; ');
}
```

- [ ] **Step 4: Point lookup-outcome at the shared formatter**

In `src/domain/lookup-outcome.ts`, delete the local `summarizeCandidates` function (lines 15-19, including its comment) and add to the imports at the top of the file:

```typescript
import { summarizeCandidates } from './candidate-format';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/domain/candidate-format.test.ts src/domain/lookup-outcome.test.ts`
Expected: PASS. If a `lookup-outcome` test asserts the old `"<brewery> — <name>"` summary text, update that expectation to the new format — the enriched format is the intended change.

- [ ] **Step 6: Commit**

```bash
git add src/domain/candidate-format.ts src/domain/candidate-format.test.ts src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts
git commit -m "feat(triage): render bid/ABV/style in candidate summaries"
```

---

### Task 2: Carry the shop's ABV and style into the triage batch

**Files:**
- Modify: `src/storage/enrich_failures.ts:139-165`
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/storage/enrich_failures.test.ts` (reuse whatever `makeDb()`/seed helper the file already defines; the assertion is what matters):

```typescript
test('listUntriagedFailures exposes the beer abv and style', () => {
  const db = makeDb();
  db.prepare("INSERT INTO beers (id, brewery, name, abv, style) VALUES (7, 'ReCraft Brewery', 'Hazy American Pale Ale', 4.2, 'Hazy APA')").run();
  recordEnrichFailure(db, {
    beer_id: 7, brewery: 'ReCraft Brewery', name: 'Hazy American Pale Ale',
    search_url: 'https://untappd.com/search?q=ReCraft', source_url: '',
    outcome: 'not_found', candidates_count: 0, candidates_summary: '',
    at: '2026-07-28T00:00:00.000Z',
  });

  const [row] = listUntriagedFailures(db, 10);
  expect(row.abv).toBe(4.2);
  expect(row.style).toBe('Hazy APA');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: FAIL — `expected undefined to be 4.2`.

- [ ] **Step 3: Widen the row type and the query**

In `src/storage/enrich_failures.ts`, add to the `UntriagedFailure` interface (after `last_at`):

```typescript
  abv: number | null;
  style: string | null;
```

and replace the SELECT in `listUntriagedFailures` with:

```typescript
      `SELECT ef.beer_id, ef.brewery, ef.name, ef.search_url, ef.source_url,
              ef.candidates_count, ef.candidates_summary, ef.fail_count, ef.last_at,
              b.abv AS abv, b.style AS style
         FROM enrich_failures ef
         JOIN beers b ON b.id = ef.beer_id
        WHERE ef.review_class IS NULL AND ef.outcome = 'not_found'
        ORDER BY ef.last_at DESC, ef.beer_id DESC
        LIMIT ?`,
```

The join is safe: `enrich_failures.beer_id` is a FK to `beers(id)` with `ON DELETE CASCADE`, so an orphaned failure row cannot exist.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(triage): expose beer abv/style to the triage batch"
```

---

### Task 3: Probe collector

**Files:**
- Create: `src/domain/triage-probes.ts`
- Create: `src/domain/triage-probes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/triage-probes.test.ts`:

```typescript
import { test, expect, vi } from 'vitest';
import { collectTriageProbes, PROBE_SEARCHES_PER_ORPHAN } from './triage-probes';
import type { UntriagedFailure } from '../storage/enrich_failures';
import type { SearchResult } from '../sources/untappd/search';

const orphan = (over: Partial<UntriagedFailure> = {}): UntriagedFailure => ({
  beer_id: 1, brewery: 'Artezan Brewery', name: 'Jasne Niepasteryzowane',
  search_url: 'https://untappd.com/search?q=Artezan', source_url: '',
  candidates_count: 0, candidates_summary: '', fail_count: 1,
  last_at: '2026-07-28T00:00:00.000Z', abv: 4.6, style: 'Lager',
  ...over,
});

const hit = (name: string): SearchResult => ({
  bid: 6666784, beer_name: name, brewery_name: 'Browar Artezan',
  style: 'Lager - Pale', abv: 5, global_rating: null,
});

test('probes brewery-only and name-only for a zero-candidate orphan', async () => {
  const search = { search: vi.fn().mockResolvedValue([hit('Jasne')]) };
  const probes = await collectTriageProbes({ orphans: [orphan()], search, limit: 10 });

  expect(search.search).toHaveBeenCalledTimes(PROBE_SEARCHES_PER_ORPHAN);
  expect(search.search).toHaveBeenCalledWith('Artezan');
  expect(search.search).toHaveBeenCalledWith('Jasne Niepasteryzowane');
  expect(probes.get(1)).toEqual({
    brewery: 'Browar Artezan — Jasne (bid 6666784, 5.0%, Lager - Pale)',
    name: 'Browar Artezan — Jasne (bid 6666784, 5.0%, Lager - Pale)',
  });
});

test('skips orphans that already have candidates', async () => {
  const search = { search: vi.fn().mockResolvedValue([]) };
  const probes = await collectTriageProbes({
    orphans: [orphan({ candidates_count: 2, candidates_summary: 'X — Y (bid 1)' })],
    search, limit: 10,
  });

  expect(search.search).not.toHaveBeenCalled();
  expect(probes.size).toBe(0);
});

test('stops probing once the per-run limit is exhausted', async () => {
  const search = { search: vi.fn().mockResolvedValue([]) };
  const orphans = [orphan({ beer_id: 1 }), orphan({ beer_id: 2 }), orphan({ beer_id: 3 })];
  await collectTriageProbes({ orphans, search, limit: PROBE_SEARCHES_PER_ORPHAN * 2 });

  expect(search.search).toHaveBeenCalledTimes(PROBE_SEARCHES_PER_ORPHAN * 2);
});

test('a failing probe is swallowed and leaves the other probe intact', async () => {
  const search = {
    search: vi.fn()
      .mockRejectedValueOnce(new Error('breaker open'))
      .mockResolvedValueOnce([hit('Jasne')]),
  };
  const probes = await collectTriageProbes({ orphans: [orphan()], search, limit: 10 });

  expect(probes.get(1)?.brewery).toBeUndefined();
  expect(probes.get(1)?.name).toContain('Browar Artezan');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/triage-probes.test.ts`
Expected: FAIL — `Failed to resolve import "./triage-probes"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/triage-probes.ts`:

```typescript
import type { UntriagedFailure } from '../storage/enrich_failures';
import type { BeerSearch } from '../sources/untappd/search';
import { cleanSearchQuery } from './normalize';
import { summarizeCandidates } from './candidate-format';

export const PROBE_SEARCHES_PER_ORPHAN = 2;

export interface TriageProbe {
  brewery?: string;   // top-3 for the brewery-only query
  name?: string;      // top-3 for the name-only query
}

export interface CollectProbesArgs {
  orphans: UntriagedFailure[];
  search: BeerSearch;
  limit: number;                 // hard cap on searches for the whole run
  onError?: (query: string, error: unknown) => void;
}

// Deterministic evidence for zero-candidate orphans: what does Untappd hold for
// this brewery, and for this beer name under ANY brewery? Without it the triage
// model is asked to explain a negative with nothing but the query string, which
// is where its wrong hypotheses come from (see the 2026-07-28 design doc).
// Rows that already have candidates need no probe — their evidence is the
// candidate list itself.
export async function collectTriageProbes(
  args: CollectProbesArgs,
): Promise<Map<number, TriageProbe>> {
  const out = new Map<number, TriageProbe>();
  let spent = 0;

  const run = async (query: string): Promise<string | undefined> => {
    if (!query || spent >= args.limit) return undefined;
    spent += 1;
    try {
      return summarizeCandidates(await args.search.search(query));
    } catch (error) {
      args.onError?.(query, error);
      return undefined;   // evidence is best-effort; never fail the run
    }
  };

  for (const orphan of args.orphans) {
    if (orphan.candidates_count > 0) continue;
    if (spent >= args.limit) break;
    const probe: TriageProbe = {};
    probe.brewery = await run(cleanSearchQuery(orphan.brewery, ''));
    probe.name = await run(cleanSearchQuery('', orphan.name));
    if (probe.brewery !== undefined || probe.name !== undefined) out.set(orphan.beer_id, probe);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/domain/triage-probes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-probes.ts src/domain/triage-probes.test.ts
git commit -m "feat(triage): collect brewery/name probe evidence for zero-candidate orphans"
```

---

### Task 4: Verdict schema gains the falsifiable fields

**Files:**
- Modify: `src/domain/triage-analysis.ts:6-14` (zod) and `:47-82` (tool schema)
- Test: `src/domain/triage-analysis.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/triage-analysis.test.ts`:

```typescript
test('VerdictSchema accepts a causal verdict with a proposed query', () => {
  const v = VerdictSchema.parse({
    beer_id: 1, review_class: 'matcher_bug', review_note: 'alias gap',
    issue_number: 347, new_issue_key: null,
    proposed_query: 'Petrus Kriek', expected_target: 'Brouwerij De Brabandere — Petrus Kriek',
  });
  expect(v.proposed_query).toBe('Petrus Kriek');
  expect(v.expected_target).toBe('Brouwerij De Brabandere — Petrus Kriek');
});

test('ANALYSIS_TOOL_SCHEMA requires the two verification fields (nullable)', () => {
  const props = ANALYSIS_TOOL_SCHEMA.properties.verdicts.items.properties as Record<string, unknown>;
  expect(props.proposed_query).toEqual({ type: ['string', 'null'] });
  expect(props.expected_target).toEqual({ type: ['string', 'null'] });
  expect(ANALYSIS_TOOL_SCHEMA.properties.verdicts.items.required)
    .toEqual(expect.arrayContaining(['proposed_query', 'expected_target']));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: FAIL — `expected undefined to be 'Petrus Kriek'`.

- [ ] **Step 3: Extend both schemas**

In `src/domain/triage-analysis.ts`, add to `VerdictSchema` (after `new_issue_key`):

```typescript
  // Falsifiable evidence for a causal verdict: the query the model believes finds
  // the beer, and the "<brewery> — <name>" it expects back. The job re-runs the
  // query before publishing anything to GitHub (see verifyCauses).
  proposed_query: z.string().nullable().default(null),
  expected_target: z.string().nullable().default(null),
```

and to `ANALYSIS_TOOL_SCHEMA.properties.verdicts.items`:

```typescript
          proposed_query: { type: ['string', 'null'] },
          expected_target: { type: ['string', 'null'] },
```

extending its `required` array to:

```typescript
          required: ['beer_id', 'review_class', 'review_note', 'issue_number', 'new_issue_key',
                     'proposed_query', 'expected_target'],
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: PASS, including the pre-existing `strict-compatible` and `drift guard` tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts
git commit -m "feat(triage): add proposed_query/expected_target to the verdict schema"
```

---

### Task 5: Prompt renders the new evidence and asks for the new fields

**Files:**
- Modify: `src/domain/triage-analysis.ts` (`TriageInput`, `boundOrphan`, `buildTriagePrompt`)
- Test: `src/domain/triage-analysis.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/triage-analysis.test.ts`:

```typescript
test('buildTriagePrompt renders probe evidence and the shop abv/style', () => {
  const o: UntriagedFailure = { ...orphan, candidates_count: 0, candidates_summary: '', abv: 4.6, style: 'Lager' };
  const p = buildTriagePrompt({
    orphans: [o], openIssues: [],
    probes: new Map([[o.beer_id, {
      brewery: 'Browar Artezan — Jasne (bid 6666784, 5.0%, Lager - Pale)',
      name: '',
    }]]),
  });
  expect(p).toContain('"probe_brewery": "Browar Artezan — Jasne (bid 6666784, 5.0%, Lager - Pale)"');
  expect(p).toContain('"probe_name": ""');
  expect(p).toContain('"abv": 4.6');
  expect(p).toContain('"style": "Lager"');
});

test('buildTriagePrompt instructs the falsifiable-cause contract', () => {
  const p = buildTriagePrompt({ orphans: [orphan], openIssues: [] });
  expect(p).toContain('proposed_query');
  expect(p).toContain('will be re-run');
  expect(p).toContain('probe_brewery');
});
```

Update the shared `orphan` fixture at the top of the file to include `abv: null, style: null` so it still satisfies `UntriagedFailure`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: FAIL — the probe keys are absent from the prompt.

- [ ] **Step 3: Thread probes into the payload**

In `src/domain/triage-analysis.ts`:

```typescript
import type { TriageProbe } from './triage-probes';

export interface TriageInput {
  orphans: UntriagedFailure[];
  openIssues: OpenIssue[];
  probes?: Map<number, TriageProbe>;
}
```

Change `boundOrphan` to take the probe and emit the two fields (probe text is Untappd-derived, so cap it like the other scraped fields):

```typescript
function boundOrphan(o: UntriagedFailure, probe?: TriageProbe) {
  return {
    ...o,
    brewery: o.brewery.slice(0, ORPHAN_FIELD_CAPS.name),
    name: o.name.slice(0, ORPHAN_FIELD_CAPS.name),
    search_url: o.search_url.slice(0, ORPHAN_FIELD_CAPS.url),
    source_url: o.source_url.slice(0, ORPHAN_FIELD_CAPS.url),
    candidates_summary: o.candidates_summary.slice(0, ORPHAN_FIELD_CAPS.summary),
    search_query: decodeSearchQuery(o.search_url).slice(0, ORPHAN_FIELD_CAPS.name),
    probe_brewery: (probe?.brewery ?? '').slice(0, ORPHAN_FIELD_CAPS.summary),
    probe_name: (probe?.name ?? '').slice(0, ORPHAN_FIELD_CAPS.summary),
  };
}
```

and render it: `JSON.stringify(input.orphans.map((o) => boundOrphan(o, input.probes?.get(o.beer_id))), null, 1)`.

- [ ] **Step 4: Explain the new fields in the prompt**

In `buildTriagePrompt`, insert after the `Already-handled guard:` paragraph:

```typescript
    'Evidence fields for zero-candidate rows: `probe_brewery` is what Untappd returns for the BREWERY',
    'alone, `probe_name` for the NAME alone (empty string = that probe returned nothing or was not run).',
    'Use them instead of guessing: a brewery whose catalogue is returned but holds no such beer is',
    'not_on_untappd, not an alias gap; a beer found under a DIFFERENT brewery is a brewery-label',
    'problem; both empty means the beer is likely absent entirely.',
    'Candidate lines carry `(bid, abv%, style)` — compare the ABV with the row\'s own `abv` before',
    'claiming a candidate is the same beer. A contradicting ABV (e.g. 0.5% vs 6.0%) means it is NOT',
    'the same beer, however similar the name.',
    '',
    'Falsifiable causes: whenever you attach a verdict to an issue (issue_number or new_issue_key),',
    'you MUST also give `proposed_query` — the exact query you believe finds the beer — and',
    '`expected_target` as "<brewery> — <name>" you expect it to return. The query WILL be re-run and',
    'checked; if the target does not come back, the cause is discarded and only the classification is',
    'kept. Do not attach an issue when you cannot name a query that would find the beer; use',
    'not_on_untappd/wontfix, or matcher_bug with issue_number: null.',
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts
git commit -m "feat(triage): render probe evidence and require falsifiable causes in the prompt"
```

---

### Task 6: Cause verification

**Files:**
- Create: `src/domain/triage-verify.ts`
- Create: `src/domain/triage-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/triage-verify.test.ts`:

```typescript
import { test, expect, vi } from 'vitest';
import { verifyCauses } from './triage-verify';
import type { Verdict } from './triage-analysis';
import type { SearchResult } from '../sources/untappd/search';

const causal = (over: Partial<Verdict> = {}): Verdict => ({
  beer_id: 1, review_class: 'matcher_bug', review_note: 'alias gap',
  issue_number: 347, new_issue_key: null,
  proposed_query: 'Petrus Kriek', expected_target: 'Brouwerij De Brabandere — Petrus Kriek',
  ...over,
});

const hit: SearchResult = {
  bid: 6682946, beer_name: 'Petrus Kriek', brewery_name: 'Brouwerij De Brabandere',
  style: 'Sour - Fruited', abv: 4, global_rating: null,
};

test('a verdict whose proposed query returns the expected target is verified', async () => {
  const search = { search: vi.fn().mockResolvedValue([hit]) };
  const res = await verifyCauses({ verdicts: [causal()], search, limit: 10 });
  expect(res.get(1)).toBe(true);
  expect(search.search).toHaveBeenCalledWith('Petrus Kriek');
});

test('a verdict whose target is absent from the results is unverified', async () => {
  const search = { search: vi.fn().mockResolvedValue([{ ...hit, beer_name: 'Petrus Aged Red' }]) };
  const res = await verifyCauses({ verdicts: [causal()], search, limit: 10 });
  expect(res.get(1)).toBe(false);
});

test('matching ignores case, diacritics and brewery/name punctuation', async () => {
  const search = { search: vi.fn().mockResolvedValue([hit]) };
  const res = await verifyCauses({
    verdicts: [causal({ expected_target: 'brouwerij de brabandere - PETRUS kriek' })],
    search, limit: 10,
  });
  expect(res.get(1)).toBe(true);
});

test('a causal verdict without a proposed query is unverified and costs no search', async () => {
  const search = { search: vi.fn() };
  const res = await verifyCauses({
    verdicts: [causal({ proposed_query: null })], search, limit: 10,
  });
  expect(res.get(1)).toBe(false);
  expect(search.search).not.toHaveBeenCalled();
});

test('non-causal verdicts are not verified at all', async () => {
  const search = { search: vi.fn() };
  const res = await verifyCauses({
    verdicts: [causal({ issue_number: null, new_issue_key: null })], search, limit: 10,
  });
  expect(res.size).toBe(0);
  expect(search.search).not.toHaveBeenCalled();
});

test('a throwing search leaves the verdict unverified without failing the run', async () => {
  const search = { search: vi.fn().mockRejectedValue(new Error('breaker open')) };
  const res = await verifyCauses({ verdicts: [causal()], search, limit: 10 });
  expect(res.get(1)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/triage-verify.test.ts`
Expected: FAIL — `Failed to resolve import "./triage-verify"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/triage-verify.ts`:

```typescript
import type { Verdict } from './triage-analysis';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';
import { normalizeName, normalizeBrewery } from './normalize';

export interface VerifyCausesArgs {
  verdicts: Verdict[];
  search: BeerSearch;
  limit: number;                 // hard cap on verification searches per run
  onError?: (query: string, error: unknown) => void;
}

// A verdict makes a causal claim when it routes the orphan to an issue.
export function isCausal(v: Verdict): boolean {
  return v.issue_number !== null || v.new_issue_key !== null;
}

// "<brewery> — <name>" comparison that tolerates the separator, case, diacritics
// and punctuation drift between what the model writes and what Untappd returns.
function targetKey(brewery: string, name: string): string {
  return `${normalizeBrewery(brewery)}|${normalizeName(name)}`;
}

function expectedKey(expected: string): string | null {
  const parts = expected.split(/\s+[—–-]\s+/);
  if (parts.length < 2) return null;
  return targetKey(parts[0], parts.slice(1).join(' - '));
}

function resultKeys(results: SearchResult[]): Set<string> {
  return new Set(results.map((r) => targetKey(r.brewery_name, r.beer_name)));
}

// Re-runs each causal verdict's proposed query and reports whether the expected
// target actually came back. Unverified is the safe default: a missing query, an
// unparseable target, an absent hit and a failing search all resolve to false, so
// an unprovable cause never reaches GitHub.
export async function verifyCauses(args: VerifyCausesArgs): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  let spent = 0;

  for (const verdict of args.verdicts) {
    if (!isCausal(verdict)) continue;
    const query = verdict.proposed_query?.trim();
    const expected = verdict.expected_target ? expectedKey(verdict.expected_target) : null;
    if (!query || !expected || spent >= args.limit) {
      out.set(verdict.beer_id, false);
      continue;
    }
    spent += 1;
    try {
      out.set(verdict.beer_id, resultKeys(await args.search.search(query)).has(expected));
    } catch (error) {
      args.onError?.(query, error);
      out.set(verdict.beer_id, false);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/domain/triage-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-verify.ts src/domain/triage-verify.test.ts
git commit -m "feat(triage): verify a proposed cause by re-running its query"
```

---

### Task 7: Wire probes + verification into the job

**Files:**
- Modify: `src/jobs/orphan-triage.ts`
- Test: `src/jobs/orphan-triage.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/orphan-triage.test.ts` (mirror the existing harness in that file for `db`/`llm`/`github` fakes; only the new expectations are spelled out here):

```typescript
test('an unverified cause is downgraded: no GitHub write, note prefixed', async () => {
  const db = seedOrphan({ beer_id: 1, brewery: 'ReCraft Brewery', name: 'Hazy American Pale Ale' });
  const llm = fakeLlm({
    verdicts: [{
      beer_id: 1, review_class: 'matcher_bug', review_note: 'brewery alias gap',
      issue_number: 347, new_issue_key: null,
      proposed_query: 'ReCraft Hazy American Pale Ale',
      expected_target: 'Browar Cornelius — Cornelius Hazy APA',
    }],
    new_issues: [],
  });
  const github = fakeGithub([{ number: 347, title: 'alias gap', body: '', labels: ['orphan-triage'] }]);
  // the proposed query returns something else entirely
  const search = { search: vi.fn().mockResolvedValue([]) };

  await orphanTriage({ db, log, llm, github, search, now: () => inWindow });

  expect(github.comment).not.toHaveBeenCalled();
  const row = db.prepare('SELECT review_class, review_note FROM enrich_failures WHERE beer_id = 1').get();
  expect(row.review_class).toBe('matcher_bug');
  expect(row.review_note).toMatch(/^unverified: /);
  expect(row.review_note).not.toContain('#347');
});

test('a verified cause is published as before', async () => {
  const db = seedOrphan({ beer_id: 2, brewery: 'Petrus Brewery', name: 'Kriek' });
  const llm = fakeLlm({
    verdicts: [{
      beer_id: 2, review_class: 'matcher_bug', review_note: 'brand of De Brabandere',
      issue_number: 347, new_issue_key: null,
      proposed_query: 'Petrus Kriek',
      expected_target: 'Brouwerij De Brabandere — Petrus Kriek',
    }],
    new_issues: [],
  });
  const github = fakeGithub([{ number: 347, title: 'alias gap', body: '', labels: ['orphan-triage'] }]);
  const search = { search: vi.fn().mockResolvedValue([{
    bid: 6682946, beer_name: 'Petrus Kriek', brewery_name: 'Brouwerij De Brabandere',
    style: null, abv: 4, global_rating: null,
  }]) };

  await orphanTriage({ db, log, llm, github, search, now: () => inWindow });

  expect(github.comment).toHaveBeenCalledTimes(1);
  const row = db.prepare('SELECT review_note FROM enrich_failures WHERE beer_id = 2').get();
  expect(row.review_note).toContain('#347');
  expect(row.review_note).not.toMatch(/^unverified: /);
});

test('the job runs unchanged when no search dep is provided', async () => {
  const db = seedOrphan({ beer_id: 3, brewery: 'X Brewery', name: 'Y' });
  const llm = fakeLlm({
    verdicts: [{ beer_id: 3, review_class: 'not_on_untappd', review_note: 'absent',
                 issue_number: null, new_issue_key: null,
                 proposed_query: null, expected_target: null }],
    new_issues: [],
  });
  await orphanTriage({ db, log, llm, github: fakeGithub([]), now: () => inWindow });

  const row = db.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = 3').get();
  expect(row.review_class).toBe('not_on_untappd');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: FAIL — the comment is posted for the unverified verdict and the note has no `unverified: ` prefix.

- [ ] **Step 3: Add the dependency and the probe call**

In `src/jobs/orphan-triage.ts`, extend the deps and imports:

```typescript
import type { BeerSearch } from '../sources/untappd/search';
import { collectTriageProbes } from '../domain/triage-probes';
import { verifyCauses, isCausal } from '../domain/triage-verify';

export const TRIAGE_PROBE_LIMIT_DEFAULT = 120;

export interface OrphanTriageDeps {
  db: DB;
  log: pino.Logger;
  llm: TriageLlm | null;
  github: GithubIssuesClient | null;
  archive?: TriageArchive | null;
  search?: BeerSearch | null;      // evidence probes + cause verification; optional
  probeLimit?: number;
  now?: () => Date;
}
```

and inside the `try` block, before `llm.analyze`:

```typescript
      const probeLimit = deps.probeLimit ?? TRIAGE_PROBE_LIMIT_DEFAULT;
      const probes = deps.search
        ? await collectTriageProbes({
            orphans, search: deps.search, limit: probeLimit,
            onError: (query, err) => log.warn({ err, query }, 'orphan-triage: probe failed'),
          })
        : new Map();
      const ex1 = await llm.analyze({ orphans, openIssues, probes });
```

Pass `probes` to the retry `llm.analyze` call as well.

- [ ] **Step 4: Gate causal verdicts on verification**

After `analysis = exchanges[exchanges.length - 1].analysis;` and before `planTriageActions`:

```typescript
      // A cause the model cannot prove must not reach GitHub: strip the issue
      // attachment and keep only the classification. Unprovable hypotheses were
      // the expensive failure mode (see the 2026-07-28 design doc).
      const verified = deps.search
        ? await verifyCauses({
            verdicts: analysis.verdicts, search: deps.search, limit: probeLimit,
            onError: (query, err) => log.warn({ err, query }, 'orphan-triage: verification failed'),
          })
        : new Map<number, boolean>();
      if (deps.search) {
        analysis = {
          ...analysis,
          verdicts: analysis.verdicts.map((v) => {
            if (!isCausal(v) || verified.get(v.beer_id)) return v;
            unverified += 1;
            return { ...v, issue_number: null, new_issue_key: null,
                     review_note: `unverified: ${v.review_note}` };
          }),
        };
      }
```

Declare `let unverified = 0;` next to `const exchanges` and change `let analysis: Analysis;` so it can be reassigned. Add `unverified` to `TriageOutcome`, to `empty`, and to the digest builder:

```typescript
  if (o.unverified > 0) parts.push(`${o.unverified} неперевірених`);
```

Set `outcome.unverified = unverified;` next to `outcome.skipped = plan.skipped;`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(triage): probe before analysis and gate causes on verification"
```

---

### Task 8: Wire the job in production and document it

**Files:**
- Modify: `src/index.ts` (the `orphanTriage` cron registration, near `cron.schedule('*/15 * * * *')`)
- Modify: `src/config/env.ts` (add `TRIAGE_PROBE_LIMIT`)
- Modify: `.env.example`
- Modify: `spec.md` §5.11

- [ ] **Step 1: Pass the existing Algolia search into the job**

In `src/index.ts`, find the `orphanTriage({ ... })` call inside the 15-minute cron and add the search dep, reusing the same instance the enrich cron uses:

```typescript
      orphanTriage({
        db, log, llm: triageLlm, github: githubIssues, archive: triageArchive,
        search: algoliaSearch,
        probeLimit: env.TRIAGE_PROBE_LIMIT,
      }).catch((e) => log.error({ err: e }, 'orphan-triage cron'));
```

- [ ] **Step 2: Add the env var**

In `src/config/env.ts`, next to the other numeric options, add a `TRIAGE_PROBE_LIMIT` entry defaulting to `120` (follow the file's existing coercion helper — do not hand-roll `parseInt`). Add to `.env.example`:

```
# Max Untappd searches the daily triage job may spend on evidence probes + cause
# verification (0 disables both; the job then behaves as before).
TRIAGE_PROBE_LIMIT=120
```

- [ ] **Step 3: Run the env tests**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS (add a case asserting the default if the file tests other defaults).

- [ ] **Step 4: Document in spec.md §5.11**

Add after the "Межа parser/matcher" bullet:

```markdown
- **Докази перед вердиктом.** Для кожного orphan з `candidates_count = 0` джоба спершу
  виконує два детерміновані пошуки — лише броварня і лише назва — і кладе їхні топ-3 у
  пейлоад (`probe_brewery` / `probe_name`). Рядки з кандидатами проб не отримують: доказ
  у них уже є. Зведення кандидатів містить `(bid, abv%, стиль)`, а сам orphan — власні
  `abv`/`style`, щоб модель могла порівняти ABV замість здогаду. Бюджет спільний з
  верифікацією: `TRIAGE_PROBE_LIMIT` (дефолт 120) пошуків на запуск; вичерпання ліміту,
  збій пошуку чи відкритий breaker лише прибирають докази, але не валять запуск.
- **Причина публікується лише перевіреною.** Вердикт, що прив'язує orphan до issue,
  зобов'язаний нести `proposed_query` + `expected_target`; джоба перевиконує цей запит і
  публікує причину в GitHub, тільки якщо очікувана ціль повернулась. Інакше рядок лишається
  класифікованим, прив'язка знімається, а нотатка отримує префікс `unverified:`. Кількість
  таких — у рядку дайджесту (`N неперевірених`). Підстава: рев'ю 2026-07-28 (з ~16
  причинних гіпотез підтвердились 4; дві реалізовані погіршили б матчинг).
```

- [ ] **Step 5: Full verification**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/config/env.ts .env.example spec.md
git commit -m "feat(triage): wire probes/verification in prod and document the contract"
```

---

## Self-Review

**Spec coverage:** probes → Task 3 + 7; enriched candidates → Task 1; shop abv/style → Task 2 + 5; falsifiable verdicts → Task 4 + 6 + 7; digest counter → Task 7; budget/degradation → Tasks 3, 6, 7, 8; docs → Task 8. No spec section is unimplemented.

**Placeholders:** none — every step carries the code or the exact command.

**Type consistency:** `TriageProbe` is defined in Task 3 and consumed in Task 5 (`probes?: Map<number, TriageProbe>`); `isCausal`/`verifyCauses` defined in Task 6 and consumed in Task 7; `UntriagedFailure` gains `abv`/`style` in Task 2 before the Task 3 and Task 5 fixtures rely on them; `summarizeCandidates` moves in Task 1 before Task 3 imports it.
