# Triage churn + classification accuracy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daily orphan-triage agent from re-surfacing unchanged, already-classified beers, and stop it from proposing already-implemented query-noise fixes.

**Architecture:** Two independent changes. (A) `recordEnrichFailure`'s `ON CONFLICT` clause preserves the triage classification on a re-fail unless `candidates_count` crosses the `0 ↔ >0` boundary. (B) `buildTriagePrompt` gains a decoded `search_query` field plus a `candidates_count` pivot and an "already-handled" guard so the LLM classifies on the real query, not the raw name.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite UPSERT), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-triage-churn-and-classification-design.md`

**Branch:** `triage-churn-classification` (already holds the spec commit).

---

## File Structure

- `src/storage/enrich_failures.ts` — Task 1: conditional reset in `recordEnrichFailure` (SQL only).
- `src/storage/enrich_failures.test.ts` — Task 1 tests.
- `src/domain/triage-analysis.ts` — Task 2: `decodeSearchQuery` helper, `boundOrphan` gains `search_query`, prompt-text additions.
- `src/domain/triage-analysis.test.ts` — Task 2 tests.
- `spec.md` — Task 3: update §3.13 reset paragraph.

Tasks 1, 2, 3 touch disjoint files and can be implemented independently.

**SQLite UPSERT semantics (relied on in Task 1):** inside `ON CONFLICT … DO UPDATE SET`, a bare column reference (`enrich_failures.candidates_count`) is the **existing/old** row value and `excluded.candidates_count` is the **new** proposed value. All RHS expressions read the original row regardless of assignment order, so the CASE below reads the OLD count even though the same statement also assigns the new count. Tests verify this.

---

### Task 1: Conditional review reset on candidates_count boundary

**Files:**
- Modify: `src/storage/enrich_failures.ts:23-36` (the `ON CONFLICT` clause)
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Replace the old same-signal test and add boundary tests (write failing tests)**

In `src/storage/enrich_failures.test.ts`, **replace** the existing test `'a recurring failure clears a prior review'` (it asserts the old unconditional reset) with the four tests below:

```ts
  test('same-signal re-fail (0→0) PRESERVES a prior review (no churn)', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0 }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0, at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBe('matcher_bug');
    expect(got.review_note).toBe('note');
    expect(got.reviewed_at).toBe('2026-06-11T02:00:00Z');
    expect(got.fail_count).toBe(2);
    expect(got.last_at).toBe('2026-06-11T03:00:00Z');
  });

  test('same-signal re-fail (N→N) PRESERVES a prior review', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 2, candidates_summary: 'X — Y' }));
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 5, candidates_summary: 'X — Y', at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBe('not_on_untappd');
    expect(got.candidates_count).toBe(5);
  });

  test('boundary crossing 0→N re-opens triage (clears review)', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0 }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 3, candidates_summary: 'X — Y', at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBeNull();
    expect(got.review_note).toBeNull();
    expect(got.reviewed_at).toBeNull();
    expect(got.fail_count).toBe(2);
    expect(got.candidates_count).toBe(3);
  });

  test('boundary crossing N→0 re-opens triage (clears review)', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 2, candidates_summary: 'X — Y' }));
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0, candidates_summary: '', at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: the two "PRESERVES" tests FAIL (current code nulls `review_class` unconditionally, so `got.review_class` is `null` instead of the expected class). The two boundary tests PASS already (crossing still nulls under old code).

- [ ] **Step 3: Implement the conditional reset**

In `src/storage/enrich_failures.ts`, replace the three unconditional lines in the `ON CONFLICT` clause:

```ts
       fail_count         = enrich_failures.fail_count + 1,
       last_at            = excluded.last_at,
       review_class       = NULL,
       review_note        = NULL,
       reviewed_at        = NULL`,
```

with the boundary-conditional version:

```ts
       fail_count         = enrich_failures.fail_count + 1,
       last_at            = excluded.last_at,
       review_class       = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
         THEN NULL ELSE enrich_failures.review_class END,
       review_note        = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
         THEN NULL ELSE enrich_failures.review_note END,
       reviewed_at        = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
         THEN NULL ELSE enrich_failures.reviewed_at END`,
```

Also update the function's doc comment (lines 15-17) to note the conditional reset, and the `setEnrichFailureReview` comment (lines 62-64) which currently says "A later recurring failure resets these fields" — change to "A later recurring failure resets these fields only when candidates_count crosses the 0↔>0 boundary".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: all tests PASS (including the untouched `record upserts`, `source_url`, cascade, and `listUntriagedFailures` tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "fix(triage): preserve review_class on re-fail unless candidates cross 0↔>0

Kills daily re-triage churn: an unchanged re-failure keeps its
classification; only a materially-changed search result (candidates
appear/disappear) re-opens the row for triage.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Prompt — decoded search_query + candidates_count pivot + already-handled guard

**Files:**
- Modify: `src/domain/triage-analysis.ts` (`boundOrphan` ~92-101, `buildTriagePrompt` ~103-162, new helper)
- Test: `src/domain/triage-analysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/domain/triage-analysis.test.ts`:

```ts
test('buildTriagePrompt: emits decoded search_query from search_url q=', () => {
  const o: UntriagedFailure = {
    ...orphan,
    search_url: 'https://untappd.com/search?q=StarKraft%20Jubilance&type=beer',
  };
  const p = buildTriagePrompt({ orphans: [o], openIssues: [] });
  expect(p).toContain('"search_query": "StarKraft Jubilance"');
});

test('buildTriagePrompt: search_query is empty when q= is absent/unparseable', () => {
  const o: UntriagedFailure = { ...orphan, search_url: 'not a url' };
  const p = buildTriagePrompt({ orphans: [o], openIssues: [] });
  expect(p).toContain('"search_query": ""');
});

test('buildTriagePrompt: instructs the candidates_count pivot and already-handled guard', () => {
  const p = buildTriagePrompt({ orphans: [orphan], openIssues: [] });
  expect(p).toContain('search_query');
  expect(p).toContain('Pivot on candidates_count');
  expect(p).toContain('already stripped');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: the three new tests FAIL (`search_query` not emitted; pivot/guard phrases absent).

- [ ] **Step 3: Implement the helper, field, and prompt text**

In `src/domain/triage-analysis.ts`, add the helper above `boundOrphan`:

```ts
// The q= param of search_url is the actual cleaned query that was run
// (cleanSearchQuery output). Decode it so the triage model sees the real
// post-normalisation query rather than URL-encoding or the raw noisy name.
function decodeSearchQuery(searchUrl: string): string {
  try {
    return new URL(searchUrl).searchParams.get('q') ?? '';
  } catch {
    return '';
  }
}
```

Change `boundOrphan` to derive and cap `search_query` (from the full raw `o.search_url`, before it is sliced):

```ts
function boundOrphan(o: UntriagedFailure): UntriagedFailure & { search_query: string } {
  return {
    ...o,
    brewery: o.brewery.slice(0, ORPHAN_FIELD_CAPS.name),
    name: o.name.slice(0, ORPHAN_FIELD_CAPS.name),
    search_url: o.search_url.slice(0, ORPHAN_FIELD_CAPS.url),
    source_url: o.source_url.slice(0, ORPHAN_FIELD_CAPS.url),
    candidates_summary: o.candidates_summary.slice(0, ORPHAN_FIELD_CAPS.summary),
    search_query: decodeSearchQuery(o.search_url).slice(0, ORPHAN_FIELD_CAPS.name),
  };
}
```

In `buildTriagePrompt`, extend the data-field explanation. Replace the line:

```ts
    '`fail_count` is how many attempts have failed.',
```

with:

```ts
    '`fail_count` is how many attempts have failed.',
    '`search_query` is the ACTUAL query we sent (the normalised `q=` from search_url); the raw',
    '`name` may still contain noise that is already stripped in `search_query`.',
```

Then, immediately after the `'Classify EVERY orphan with exactly one review_class:'` block and before the `'Cluster actionable orphans'` line, insert the pivot + guard paragraph (each phrase kept on a single array line, because the array is `join('\n')`):

```ts
    'Pivot on candidates_count before you blame query noise:',
    '- candidates_count > 0: the search WORKS and returned candidates, so the miss is on the',
    '  MATCH side (fuzzy threshold, brewery alias, name divergence) — do NOT diagnose query',
    '  noise; route it to the match-side issue.',
    '- candidates_count = 0: the search found nothing — a query-noise or brewery-alias problem.',
    'Already-handled guard: `search_query` IS the query after normalisation. If a noise token',
    'visible in `name` (brackets, parentheticals, %/°/alc/abv/ibu) is already ABSENT from',
    '`search_query`, it is already stripped — do NOT propose stripping it again (it is already stripped).',
    '',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: all tests PASS, including the pre-existing prompt tests (`contains orphans, issues and class definitions`, `bounds scraped orphan fields`, the schema drift guards — `search_query` is prompt-only and not part of `AnalysisSchema`/`VerdictSchema`, so no drift).

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts
git commit -m "feat(triage): pivot on candidates_count + decoded search_query in prompt

Give the model the real post-normalisation query (decoded search_url q=)
and tell it: candidates_count>0 = match-side miss (don't blame query
noise); a noise token absent from search_query is already stripped.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Update spec.md §3.13

**Files:**
- Modify: `spec.md:361-362`

- [ ] **Step 1: Edit the reset paragraph**

In `spec.md`, replace the current paragraph (lines 361-362):

```
**Важливо:** повторний провал того самого пива (`recordEnrichFailure`) скидає
`review_class`/`review_note`/`reviewed_at` до `NULL` — рядок знову з'являється в тріажі.
```

with:

```
**Важливо:** повторний провал того самого пива (`recordEnrichFailure`) скидає
`review_class`/`review_note`/`reviewed_at` до `NULL` **лише коли `candidates_count`
перетинає межу `0 ↔ >0`** (результат пошуку суттєво змінився — варто перетріажити); за
незмінного боку класифікація зберігається і рядок НЕ повертається в тріаж (щоб прибрати
щоденний шум повторних однакових провалів).
```

- [ ] **Step 2: Verify no other stale reference**

Run: `grep -n "скидає\|review_class" spec.md`
Expected: only the §3.13 paragraph (now updated) describes the reset. No other spot claims an unconditional reset.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): §3.13 conditional review_class reset on candidates boundary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite: `npm test`
  Expected: all pass.
- [ ] Typecheck/lint per repo norms (e.g. `npm run lint` if present).
- [ ] Confirm the three commits are on branch `triage-churn-classification` (`git log --oneline -4`).

## Self-review notes

- **Spec coverage:** Lever A → Task 1; Lever B (search_query + pivot + guard) → Task 2; spec.md §3.13 impact → Task 3. Testing section → tests in Tasks 1 & 2. Out-of-scope items (matcher fixes, stale-row re-arm) are correctly untouched.
- **Type consistency:** `boundOrphan` return type widened to `UntriagedFailure & { search_query: string }`; `UntriagedFailure`, `VerdictSchema`, `AnalysisSchema`, and `ANALYSIS_TOOL_SCHEMA` are unchanged, so the strict-schema drift-guard test stays green. Helper name `decodeSearchQuery` used consistently.
- **Behaviour flip:** the old test `'a recurring failure clears a prior review'` is replaced (not left dangling) to match the new semantics.
