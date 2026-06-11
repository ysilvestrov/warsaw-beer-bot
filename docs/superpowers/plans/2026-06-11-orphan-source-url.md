# Orphan source URL (#1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the shop page URL on each orphan's `enrich_failures` row so an agent can open the exact page and decide parser-bug vs matcher-bug.

**Architecture:** Add a `source_url` column to `enrich_failures`. The page URL flows from the extension content script → background → `POST /enrich/result` body → `applyLookupOutcome` → `recordEnrichFailure`. The server cron path has no URL and passes `''`; the upsert never overwrites a known URL with an empty one.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Hono, Zod, Jest (server); Vitest (extension).

**Order:** This is PR #1 of the orphan-debug batch. Land it before PR #2 (review/admin API) — both edit `enrich_failures.ts` and `lookup-outcome.ts`.

**Worktree:** Create via `superpowers:using-git-worktrees`. Note: EnterWorktree branches from `origin/main`; cherry-pick the spec/plan doc commits into the branch if they aren't on `origin/main` yet (see `reference_worktree_docs_cherrypick` memory).

---

### Task 1: Migration — add `source_url` to `enrich_failures`

**Files:**
- Modify: `src/storage/schema.ts` (append migration version 11)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/storage/schema.test.ts`:

```typescript
test('enrich_failures has a source_url column defaulting to empty string', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare(`PRAGMA table_info(enrich_failures)`).all() as Array<{
    name: string;
    dflt_value: string | null;
    notnull: number;
  }>;
  const col = cols.find((c) => c.name === 'source_url');
  expect(col).toBeDefined();
  expect(col!.notnull).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/schema.test.ts -t source_url`
Expected: FAIL (`col` is undefined).

- [ ] **Step 3: Add the migration**

In `src/storage/schema.ts`, append a new entry to the `MIGRATIONS` array (after the `version: 10` object, before the closing `]`):

```typescript
  {
    version: 11,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/schema.test.ts -t source_url`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(enrich): add source_url column to enrich_failures (#1)"
```

---

### Task 2: `recordEnrichFailure` writes `source_url` (no empty overwrite)

**Files:**
- Modify: `src/storage/enrich_failures.ts`
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/storage/enrich_failures.test.ts`, update the `row` helper to include `source_url` and add two tests. Change the helper:

```typescript
const row = (over: Partial<EnrichFailureRow> & { beer_id: number }): EnrichFailureRow => ({
  brewery: 'Track', name: 'Taking Shape', search_url: 'https://untappd.com/search?q=Track+Taking+Shape&type=beer',
  source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: '2026-06-11T00:00:00Z', ...over,
});
```

Add inside the `describe('enrich_failures', ...)` block:

```typescript
test('record stores source_url', () => {
  const { db, id } = freshDbWithBeer();
  recordEnrichFailure(db, row({ beer_id: id, source_url: 'https://beerfreak.org/p/x' }));
  const got = db.prepare('SELECT source_url FROM enrich_failures WHERE beer_id = ?').get(id) as any;
  expect(got.source_url).toBe('https://beerfreak.org/p/x');
});

test('upsert does not overwrite a known source_url with an empty one', () => {
  const { db, id } = freshDbWithBeer();
  recordEnrichFailure(db, row({ beer_id: id, source_url: 'https://beerfreak.org/p/x' }));
  recordEnrichFailure(db, row({ beer_id: id, source_url: '' })); // cron re-fail, no URL
  const got = db.prepare('SELECT source_url FROM enrich_failures WHERE beer_id = ?').get(id) as any;
  expect(got.source_url).toBe('https://beerfreak.org/p/x');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/storage/enrich_failures.test.ts`
Expected: FAIL (TypeScript: `source_url` missing on `EnrichFailureRow`; runtime: column not written).

- [ ] **Step 3: Implement**

In `src/storage/enrich_failures.ts`, add `source_url` to the interface and the SQL:

```typescript
export interface EnrichFailureRow {
  beer_id: number;
  brewery: string;
  name: string;
  search_url: string;
  source_url: string;
  outcome: 'not_found' | 'blocked';
  candidates_count: number;
  candidates_summary: string;
  at: string; // ISO timestamp of this failure
}
```

Replace the `recordEnrichFailure` body's SQL and bindings:

```typescript
export function recordEnrichFailure(db: DB, r: EnrichFailureRow): void {
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, source_url, outcome, candidates_count, candidates_summary, fail_count, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(beer_id) DO UPDATE SET
       brewery            = excluded.brewery,
       name               = excluded.name,
       search_url         = excluded.search_url,
       source_url         = CASE WHEN excluded.source_url != '' THEN excluded.source_url
                                 ELSE enrich_failures.source_url END,
       outcome            = excluded.outcome,
       candidates_count   = excluded.candidates_count,
       candidates_summary = excluded.candidates_summary,
       fail_count         = enrich_failures.fail_count + 1,
       last_at            = excluded.last_at`,
  ).run(
    r.beer_id, r.brewery, r.name, r.search_url, r.source_url, r.outcome,
    r.candidates_count, r.candidates_summary, r.at,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/storage/enrich_failures.test.ts`
Expected: PASS (all tests, including the existing upsert/cascade ones).

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(enrich): record source_url, never overwrite known URL with empty (#1)"
```

---

### Task 3: `applyLookupOutcome` threads `sourceUrl`

**Files:**
- Modify: `src/domain/lookup-outcome.ts`
- Test: `src/domain/lookup-outcome.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/lookup-outcome.test.ts` inside the `describe` block:

```typescript
test('not_found persists the supplied sourceUrl', () => {
  const { db, id, log } = fresh();
  const outcome: LookupOutcome = { kind: 'not_found', searchUrls: ['u'], candidates: [] };
  applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z',
    { ...input, sourceUrl: 'https://beerfreak.org/p/x' });
  expect(failRow(db, id).source_url).toBe('https://beerfreak.org/p/x');
});

test('omitting sourceUrl stores empty string', () => {
  const { db, id, log } = fresh();
  const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'u' };
  applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
  expect(failRow(db, id).source_url).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/lookup-outcome.test.ts -t sourceUrl`
Expected: FAIL (TypeScript: `sourceUrl` not on input type; runtime: column empty).

- [ ] **Step 3: Implement**

In `src/domain/lookup-outcome.ts`, widen the `input` param and pass `source_url` in both failure branches.

Change the signature's `input` type:

```typescript
  input: { brewery: string; name: string; sourceUrl?: string },
```

In the `not_found` case, add `source_url` to the `recordEnrichFailure` object:

```typescript
      recordEnrichFailure(deps.db, {
        beer_id: beerId,
        brewery: input.brewery,
        name: input.name,
        search_url: outcome.searchUrls[0] ?? '',
        source_url: input.sourceUrl ?? '',
        outcome: 'not_found',
        candidates_count: outcome.candidates.length,
        candidates_summary: summarizeCandidates(outcome.candidates),
        at: nowIso,
      });
```

In the `blocked` case, likewise:

```typescript
      recordEnrichFailure(deps.db, {
        beer_id: beerId,
        brewery: input.brewery,
        name: input.name,
        search_url: outcome.searchUrl,
        source_url: input.sourceUrl ?? '',
        outcome: 'blocked',
        candidates_count: 0,
        candidates_summary: '',
        at: nowIso,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/domain/lookup-outcome.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts
git commit -m "feat(enrich): thread sourceUrl through applyLookupOutcome (#1)"
```

---

### Task 4: `POST /enrich/result` accepts `pageUrl`

**Files:**
- Modify: `src/api/routes/enrich.ts`
- Test: `src/api/routes/enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/api/routes/enrich.test.ts` inside `describe('POST /enrich/result', ...)`:

```typescript
it('stores the supplied pageUrl as the failure source_url', async () => {
  const { db, app } = setup();
  const html = searchHtml([{ bid: 9000, name: 'Totally Different', brewery: 'Other Brewery' }]);
  await post(app, '/enrich/result', {
    brewery: 'Magic Road Brewery',
    name: 'Fifty/Fifty Clementine & Passionfruit',
    html,
    pageUrl: 'https://beerfreak.org/p/abc',
  });
  const row = findBeerByNormalized(
    db, normalizeBrewery('Magic Road Brewery'), normalizeName('Fifty/Fifty Clementine & Passionfruit'),
  )!;
  const fail = db.prepare('SELECT source_url FROM enrich_failures WHERE beer_id = ?').get(row.id) as any;
  expect(fail.source_url).toBe('https://beerfreak.org/p/abc');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/api/routes/enrich.test.ts -t pageUrl`
Expected: FAIL (`pageUrl` ignored; `source_url` is `''`).

- [ ] **Step 3: Implement**

In `src/api/routes/enrich.ts`, add `pageUrl` to the `ResultBody` schema:

```typescript
const ResultBody = z.object({
  brewery: z.string(),
  name: z.string(),
  html: z.string(),
  pageUrl: z.string().optional(),
});
```

In the `/enrich/result` handler, destructure `pageUrl` and pass it into `applyLookupOutcome`'s input:

```typescript
  app.post('/enrich/result', zValidator('json', ResultBody), async (c) => {
    const { brewery, name, html, pageUrl } = c.req.valid('json');
    const row = ensureBeerRow(deps.db, brewery, name);
    if (row.untappd_id != null) {
      return c.json({ status: 'skipped' });
    }
    const outcome = await lookupBeer({ brewery, name, abv: row.abv, fetch: async () => html });
    const nowIso = new Date().toISOString();
    const kind = applyLookupOutcome({ db: deps.db, log: deps.log }, row.id, outcome, nowIso,
      { brewery, name, sourceUrl: pageUrl });
    if (kind === 'matched' && outcome.kind === 'matched') {
      return c.json({ status: 'matched', untappd_id: outcome.result.bid, rating_global: outcome.result.global_rating });
    }
    return c.json({ status: kind });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/api/routes/enrich.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(api): /enrich/result accepts pageUrl for orphan source tracking (#1)"
```

---

### Task 5: Extension sends `window.location.href` as `pageUrl`

**Files:**
- Modify: `extension/src/api/client.ts` (`postEnrichResult` payload type)
- Modify: `extension/src/background/index.ts` (`EnrichResultMessage` + `handleEnrichResult`)
- Modify: `extension/src/content/main.ts` (submitResult closure)
- Test: `extension/src/background/handle-enrich.test.ts`

- [ ] **Step 1: Write the failing test**

`handle-enrich.test.ts` stubs the global `fetch` (via `vi.stubGlobal`) rather than mocking `postEnrichResult`, so assert on the request body the handler sends. Add inside `describe('handleEnrichResult', ...)`:

```typescript
it('forwards pageUrl in the request body', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'not_found' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await handleEnrichResult({
    type: 'enrich:result', brewery: 'B', name: 'N', html: '<x>', pageUrl: 'https://beerfreak.org/p/x',
  });
  const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  expect(body.pageUrl).toBe('https://beerfreak.org/p/x');
});
```

(`handleEnrichResult` is already imported at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/background/handle-enrich.test.ts -t pageUrl`
Expected: FAIL (TypeScript: `pageUrl` not on `EnrichResultMessage`; at runtime `body.pageUrl` is `undefined`).

- [ ] **Step 3: Implement — client payload type**

In `extension/src/api/client.ts`, widen the `postEnrichResult` payload type:

```typescript
export async function postEnrichResult(
  baseUrl: string,
  token: string,
  payload: { brewery: string; name: string; html: string; pageUrl?: string },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnrichResult> {
```

(The body already does `JSON.stringify(payload)`, so `pageUrl` is sent automatically.)

- [ ] **Step 4: Implement — background message + handler**

In `extension/src/background/index.ts`, add `pageUrl` to the message interface:

```typescript
export interface EnrichResultMessage { type: 'enrich:result'; brewery: string; name: string; html: string; pageUrl?: string }
```

And forward it in `handleEnrichResult`:

```typescript
    const result = await postEnrichResult(baseUrl, token, {
      brewery: msg.brewery, name: msg.name, html: msg.html, pageUrl: msg.pageUrl,
    });
```

- [ ] **Step 5: Implement — content script supplies the URL**

In `extension/src/content/main.ts`, update the `submitResult` closure inside `enrichOrphans` to include the page URL in the background message:

```typescript
      submitResult: async (brewery, name, html) =>
        (await sendBg<{ result: EnrichResult | null }>({
          type: 'enrich:result', brewery, name, html, pageUrl: window.location.href,
        }))?.result ?? { status: 'transient' },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd extension && npx vitest run src/background/handle-enrich.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/src/api/client.ts extension/src/background/index.ts extension/src/content/main.ts extension/src/background/handle-enrich.test.ts
git commit -m "feat(extension): send page URL with enrich result for orphan source tracking (#1)"
```

---

### Task 6: Update the orphan-failure runbook + spec.md review

**Files:**
- Modify: the orphan-failure runbook in `docs/` (the doc referenced by the `reference_orphan_failure_log` memory — find it with `grep -rl enrich_failures docs/`)
- Modify (if needed): `spec.md`

- [ ] **Step 1: Document `source_url`**

In the runbook, add `source_url` to the documented `enrich_failures` columns and note: "populated only for client-relay (`/enrich/result`) failures; cron-only orphans have `''`. Use it to open the shop page and decide parser-bug vs matcher-bug." Add an example query, e.g.:

```sql
SELECT beer_id, brewery, name, source_url, candidates_count
FROM enrich_failures
WHERE outcome = 'not_found' AND source_url != ''
ORDER BY fail_count DESC;
```

- [ ] **Step 2: Review spec.md**

Open `spec.md`. If it documents the `enrich_failures` shape or the `/enrich/result` contract, add `source_url` / `pageUrl`. If it does not cover these, no change is needed — note that in the commit body.

- [ ] **Step 3: Run the full server + extension suites**

Run: `npx jest && cd extension && npx vitest run`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs spec.md
git commit -m "docs(enrich): document source_url in orphan runbook (#1)"
```

---

## Self-Review Checklist (run before opening the PR)

- [ ] `npx jest` green; `cd extension && npx vitest run` green.
- [ ] `npx tsc --noEmit` (root) and `cd extension && npx tsc --noEmit` clean.
- [ ] Migration is additive only; no backfill needed.
- [ ] Follow the PR review loop (`feedback_pr_review_loop` memory): open PR → wait for AI review → assess each comment.
