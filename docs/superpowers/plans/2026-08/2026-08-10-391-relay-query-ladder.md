# #391 Relay Query Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the extension's relay path the #382 two-rung query ladder — narrow rung first, widen only on zero hits — without changing behaviour for any published (0.13.0) client.

**Architecture:** `/enrich/candidates` keeps `algolia` as today's wide query and adds an optional `algoliaNarrow` (a full `AlgoliaQuery`) whenever `searchQueryLadder` yields two rungs. The extension runs the narrow rung first, falls back to the wide one only on a zero-hit response, spends a page budget counted in *searches* rather than beers, and reports the executed rung back in `/enrich/result` as `query`. The server validates that `query` is one of the rungs it would have offered and rewrites the failure row's `search_url` with it.

**Tech Stack:** Node.js + TypeScript, Hono + Zod (server), Vitest (both sides), Chrome MV3 extension (content script + service worker).

**Spec:** `docs/superpowers/specs/2026-08/2026-08-10-391-relay-query-ladder-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/api/routes/enrich.ts` | both relay endpoints | emit `algoliaNarrow`; accept + validate `query`; rewrite outcome search URLs |
| `src/api/routes/enrich.test.ts` | server contract tests | new cases for both endpoints |
| `extension/src/api/types.ts` | wire types | `EnrichCandidate.algoliaNarrow?` |
| `extension/src/api/client.ts` | HTTP client | `postEnrichResult` payload gains `query?` |
| `extension/src/background/index.ts` | service worker hop | `EnrichResultMessage.query?` forwarded to the client |
| `extension/src/background/handle-enrich.test.ts` | service-worker boundary tests | asserts `query` reaches the request body |
| `extension/src/content/enrich.ts` | the enrichment loop | ladder execution, search-counted budget, half-ladder refusal, `query` argument |
| `extension/src/content/enrich.test.ts` | loop tests | ordering, fallback, budget, refusal |
| `extension/src/content/main.ts` | page → service worker mapping | forwards `query` into the `enrich:result` message |
| `extension/src/content/main.test.ts` | mapping test | asserts the field is not dropped |
| `spec.md` | the contract of record | §"POST /enrich/candidates / POST /enrich/result" documents both new fields |

No new files. `src/domain/normalize.ts` (`searchQueryLadder`) and `src/domain/untappd-lookup.ts` are used as-is.

---

### Task 1: `/enrich/candidates` emits the narrow rung

**Files:**
- Modify: `src/api/routes/enrich.ts:147-155`
- Test: `src/api/routes/enrich.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('POST /enrich/candidates', …)` block in `src/api/routes/enrich.test.ts`:

```ts
  // #391: the relay half of the #382 ladder. `algolia` must keep carrying today's
  // (wide) query — a published 0.13.0 client executes that field and nothing else.
  it('carries the narrow rung as algoliaNarrow for a two-rung (Cyrillic) pair', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'CITADEL', name: 'Томатка' }],
    });
    const body = await res.json();
    expect(body.candidates[0].algolia.query).toBe('CITADEL');
    expect(body.candidates[0].algoliaNarrow).toMatchObject({
      appId: '9WBO4RQ3HO',
      searchKey: '1d347324d67ec472bb7132c66aead485',
      indexName: 'beer',
      query: 'CITADEL Томатка',
      hitsPerPage: 5,
    });
  });

  it('omits algoliaNarrow when both rungs agree (all-Latin pair)', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }],
    });
    const body = await res.json();
    expect(body.candidates[0].algolia.query).toBe('PINTA Atak Chmielu');
    expect(Object.keys(body.candidates[0])).not.toContain('algoliaNarrow');
  });

  it('keeps algolia byte-identical to cleanSearchQuery for a two-rung pair', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'Гонір', name: 'Квас / Kvass' }],
    });
    const body = await res.json();
    expect(body.candidates[0].algolia.query).toBe(cleanSearchQuery('Гонір', 'Квас / Kvass'));
  });
```

Extend the existing import of `../../domain/normalize` at the top of the file to include `cleanSearchQuery`:

```ts
import { normalizeName, normalizeBrewery, cleanSearchQuery } from '../../domain/normalize';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/api/routes/enrich.test.ts -t "algoliaNarrow"`
Expected: FAIL — `algoliaNarrow` is `undefined` in the first test.

- [ ] **Step 3: Emit the rungs**

In `src/api/routes/enrich.ts`, replace the single-query block inside the `beers.map` callback:

```ts
        const query = cleanSearchQuery(b.brewery, b.name);
        return {
          brewery: b.brewery,
          name: b.name,
          eligible,
          algolia: algoliaQuery(deps, query),
        };
```

with:

```ts
        // #391: the #382 ladder, narrowest first. The LAST rung is by construction
        // cleanSearchQuery(brewery, name) — the query this endpoint has always sent — so
        // `algolia` keeps its meaning and a published 0.13.0 client is untouched. The
        // narrow rung travels as an extra optional field the old client ignores, and is
        // absent whenever the rungs agree (every all-Latin pair).
        const rungs = searchQueryLadder(b.brewery, b.name);
        const narrow = rungs.length > 1 ? rungs[0] : null;
        return {
          brewery: b.brewery,
          name: b.name,
          eligible,
          algolia: algoliaQuery(deps, rungs[rungs.length - 1]),
          ...(narrow ? { algoliaNarrow: algoliaQuery(deps, narrow) } : {}),
        };
```

Change the module's normalize import (`src/api/routes/enrich.ts:19`) from

```ts
import { normalizeBrewery, normalizeName, cleanSearchQuery } from '../../domain/normalize';
```

to

```ts
import { normalizeBrewery, normalizeName, searchQueryLadder } from '../../domain/normalize';
```

(`cleanSearchQuery` has no other use in this file after the change — verify with
`grep -n cleanSearchQuery src/api/routes/enrich.ts`, which must print nothing.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: PASS, whole file green (the pre-existing `query: 'PINTA Atak Chmielu'` assertion at line ~79 must still pass).

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(#391): serve the #382 narrow rung as algoliaNarrow from /enrich/candidates"
```

---

### Task 2: `/enrich/result` records the rung that actually ran

**Files:**
- Modify: `src/api/routes/enrich.ts` (schema `ResultBody`, handler tail)
- Test: `src/api/routes/enrich.test.ts`

Background: on the relay path the injected search adapter returns the relayed payload for
*any* query, so the `searchUrls` `lookupBeer` accumulates describe searches nobody ran.
`applyLookupOutcome` writes `outcome.searchUrls[0]` into `enrich_failures.search_url`
(`src/domain/lookup-outcome.ts:55`), which is what the triage agent reads.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('POST /enrich/result', …)` block in `src/api/routes/enrich.test.ts`:

```ts
  // #391: the relayed payload is the answer to ONE query the client chose from the
  // ladder. Without this the failure row cites a search that never happened.
  it('records the client-reported rung as the failure search_url', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/result', {
      brewery: 'CITADEL',
      name: 'Томатка',
      query: 'CITADEL Томатка',
      algolia: { hits: [{ bid: 9000, beer_name: 'Totally Different', brewery_name: 'Other' }] },
    });
    expect((await res.json()).status).toBe('not_found');

    const row = findBeerByNormalized(db, normalizeBrewery('CITADEL'), normalizeName('Томатка'))!;
    const fail = db.prepare('SELECT search_url FROM enrich_failures WHERE beer_id = ?').get(row.id) as any;
    expect(fail.search_url).toBe(buildSearchUrl('CITADEL Томатка'));
  });

  it('ignores a query that is not one of the rungs it would have offered', async () => {
    const { db, app } = setup();
    await post(app, '/enrich/result', {
      brewery: 'CITADEL',
      name: 'Томатка',
      query: 'drop table beers',
      algolia: { hits: [{ bid: 9000, beer_name: 'Totally Different', brewery_name: 'Other' }] },
    });
    const row = findBeerByNormalized(db, normalizeBrewery('CITADEL'), normalizeName('Томатка'))!;
    const fail = db.prepare('SELECT search_url FROM enrich_failures WHERE beer_id = ?').get(row.id) as any;
    expect(fail.search_url).not.toContain('drop');
    expect(fail.search_url).toContain('untappd.com');
  });

  it('leaves the search_url alone when the client reports no query (old build)', async () => {
    const { db, app } = setup();
    await post(app, '/enrich/result', {
      brewery: 'CITADEL',
      name: 'Томатка',
      algolia: { hits: [{ bid: 9000, beer_name: 'Totally Different', brewery_name: 'Other' }] },
    });
    const row = findBeerByNormalized(db, normalizeBrewery('CITADEL'), normalizeName('Томатка'))!;
    const fail = db.prepare('SELECT search_url FROM enrich_failures WHERE beer_id = ?').get(row.id) as any;
    expect(fail.search_url).toContain('untappd.com');
  });
```

Add the import used by the first test to the top of `src/api/routes/enrich.test.ts`:

```ts
import { buildSearchUrl } from '../../sources/untappd/search';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/api/routes/enrich.test.ts -t "rung as the failure search_url"`
Expected: FAIL — `search_url` is the URL of `lookupBeer`'s own first rung, not the reported one.

- [ ] **Step 3: Accept and validate `query`**

In `src/api/routes/enrich.ts`, add the field to `ResultBody`, directly after the `algolia`
object (keep the `.refine(...)` clause where it is):

```ts
  // #391: the ladder rung the client actually executed. The relayed hits answer exactly
  // one query, and only the client knows which — without this the failure row cites a
  // search nobody ran. Optional: absent from every build below 0.14.
  query: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
```

Add the module-level helper next to `algoliaQuery` (above `ensureBeerRow`):

```ts
// #391: replace the search URLs `lookupBeer` invented with the rung the client reports
// having executed. Only a value that is genuinely one of the rungs /enrich/candidates
// would have offered is honoured — the check is a pure function, and it keeps a buggy or
// forged client from writing arbitrary text into the column triage reads (#381).
function withRelayQuery(
  outcome: LookupOutcome,
  brewery: string,
  name: string,
  query: string | undefined,
): LookupOutcome {
  if (query === undefined || !searchQueryLadder(brewery, name).includes(query)) return outcome;
  const url = buildSearchUrl(query);
  if (outcome.kind === 'not_found') return { ...outcome, searchUrls: [url] };
  if (outcome.kind === 'blocked') return { ...outcome, searchUrl: url };
  return outcome;
}
```

Extend the imports at the top of the file:

```ts
import { lookupBeer, type LookupOutcome } from '../../domain/untappd-lookup';
import { buildSearchUrl, htmlSearch } from '../../sources/untappd/search';
```

(These two lines replace the existing `import { htmlSearch } …` and
`import { lookupBeer } …` lines. `LookupOutcome` is already exported —
`src/domain/untappd-lookup.ts:21`.)

Destructure the new field in the handler — change

```ts
    const { brewery, name, abv, style, html, algolia, pageUrl, bid, bidSlug, brand } =
      c.req.valid('json');
```

to

```ts
    const { brewery, name, abv, style, html, algolia, pageUrl, bid, bidSlug, brand, query } =
      c.req.valid('json');
```

and wrap the outcome where it is handed to `applyLookupOutcome` — change

```ts
    const outcome = await lookupWithFallback(
      () => lookupBeer({ brewery, name, abv: row.abv, search }),
      row.id,
      deps.webFallback ?? null,
    );
```

to

```ts
    const outcome = withRelayQuery(
      await lookupWithFallback(
        () => lookupBeer({ brewery, name, abv: row.abv, search }),
        row.id,
        deps.webFallback ?? null,
      ),
      brewery,
      name,
      query,
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "feat(#391): record the client-executed ladder rung as the relay failure search_url"
```

---

### Task 3: Extension wire types and HTTP client

**Files:**
- Modify: `extension/src/api/types.ts` (`EnrichCandidate`)
- Modify: `extension/src/api/client.ts` (`postEnrichResult` payload type)

This task is types-only; its behaviour is proved by Task 4's body assertion (the service
worker is the only caller of `postEnrichResult`).

- [ ] **Step 1: Add the candidate field**

In `extension/src/api/types.ts`, replace:

```ts
export interface EnrichCandidate {
  brewery: string;
  name: string;
  eligible: boolean;
  algolia: AlgoliaQuery;
}
```

with:

```ts
export interface EnrichCandidate {
  brewery: string;
  name: string;
  eligible: boolean;
  /** The wide rung — what this field has always carried (#391). */
  algolia: AlgoliaQuery;
  /**
   * #391: the narrow rung of the #382 ladder, present only when it differs from `algolia`.
   * Executed FIRST; `algolia` is the fallback for a zero-hit narrow result.
   */
  algoliaNarrow?: AlgoliaQuery;
}
```

- [ ] **Step 2: Add the result field**

In `extension/src/api/client.ts`, inside the `postEnrichResult` payload parameter type, add
after `brand?: string;`:

```ts
    /** #391: the ladder rung whose response `algolia` holds — the server records it as the failure search_url. */
    query?: string;
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix extension run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add extension/src/api/types.ts extension/src/api/client.ts
git commit -m "feat(#391): wire types for algoliaNarrow and the executed-rung query"
```

---

### Task 4: Service worker forwards `query`

**Files:**
- Modify: `extension/src/background/index.ts:46` (`EnrichResultMessage`), `handleEnrichResult`
- Test: `extension/src/background/handle-enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('handleEnrichResult', …)` block in
`extension/src/background/handle-enrich.test.ts`:

```ts
  // #391: the service worker is the only hop between the page and the API — a query
  // dropped here is a search_url the server has to keep guessing.
  it('forwards the executed ladder rung as query', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: 'not_found' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await handleEnrichResult({
      type: 'enrich:result', brewery: 'CITADEL', name: 'Томатка',
      algolia: { hits: [] }, query: 'CITADEL Томатка',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.query).toBe('CITADEL Томатка');
  });

  it('omits query entirely when the caller reports none', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: 'not_found' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await handleEnrichResult({ type: 'enrich:result', brewery: 'B', name: 'N', algolia: { hits: [] } });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('query');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix extension test -- src/background/handle-enrich.test.ts -t "executed ladder rung"`
Expected: FAIL — TypeScript rejects `query` on the message, and `body.query` is `undefined`.

- [ ] **Step 3: Add the message field and forward it**

In `extension/src/background/index.ts`, extend `EnrichResultMessage` (line 46) with
`query?: string`:

```ts
export interface EnrichResultMessage { type: 'enrich:result'; brewery: string; name: string; algolia: AlgoliaResponse; abv?: number; style?: string; bid?: number; bidSlug?: string; brand?: string; query?: string; pageUrl?: string }
```

and in `handleEnrichResult`, add one spread line to the `postEnrichResult` payload, after
the `brand` line:

```ts
      ...(msg.query !== undefined ? { query: msg.query } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix extension test -- src/background/handle-enrich.test.ts`
Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/index.ts extension/src/background/handle-enrich.test.ts
git commit -m "feat(#391): forward the executed rung through the service worker"
```

---

### Task 5: The ladder in the enrichment loop

**Files:**
- Modify: `extension/src/content/enrich.ts` (`EnrichDeps.submitResult`, `runEnrichment`)
- Test: `extension/src/content/enrich.test.ts`

This is the behavioural core: rung order, the search-counted budget, and the refusal to
submit a half-run ladder.

- [ ] **Step 1: Write the failing tests**

In `extension/src/content/enrich.test.ts`, leave the shared `deps()` helper as it is (its
`getCandidates` returns single-rung candidates with `query: 'q:<name>'`, which stays a valid
fixture) and add these two helpers below the existing `beers` helper:

```ts
const rung = (query: string) =>
  ({ appId: 'APP', searchKey: 'KEY', indexName: 'beer' as const, query, hitsPerPage: 5 });

// Every beer carries a two-rung ladder: narrow `n:<name>`, wide `q:<name>`.
const ladderCandidates = () =>
  vi.fn(async (bs: { brewery: string; name: string }[]) =>
    bs.map((b) => ({
      brewery: b.brewery,
      name: b.name,
      eligible: true,
      algolia: rung(`q:${b.name}`),
      algoliaNarrow: rung(`n:${b.name}`),
    })),
  );

// The first beer is single-rung, every later beer two-rung. With an even budget this makes
// the budget run out INSIDE a ladder (1 + 2k searches), which is the only way to reach the
// half-run-ladder refusal.
const ladderCandidatesAfterFirst = () =>
  vi.fn(async (bs: { brewery: string; name: string }[]) =>
    bs.map((b, i) => ({
      brewery: b.brewery,
      name: b.name,
      eligible: true,
      algolia: rung(`q:${b.name}`),
      ...(i === 0 ? {} : { algoliaNarrow: rung(`n:${b.name}`) }),
    })),
  );

const zeroHits = () => vi.fn(async () => ({ hits: [] as { bid: number }[] }));
```

Then append a new describe block at the end of the file:

```ts
// #391: the relay half of the #382 ladder. The narrow rung runs first; the wide rung is a
// fallback for a ZERO-HIT narrow response and for nothing else.
describe('runEnrichment query ladder (#391)', () => {
  it('searches the narrow rung first and stops there when it returns hits', async () => {
    const fetchSearch = vi.fn(async (_q: { query: string }) => ({ hits: [{ bid: 7 }] }));
    const d = deps({ getCandidates: ladderCandidates(), fetchSearch });
    await runEnrichment(beers(1), d);
    expect(fetchSearch.mock.calls.map((c) => c[0].query)).toEqual(['n:N0']);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'n:N0');
  });

  it('widens to the wide rung only when the narrow rung returns zero hits', async () => {
    const fetchSearch = vi.fn(async (q: { query: string }) =>
      q.query.startsWith('n:') ? { hits: [] as { bid: number }[] } : { hits: [{ bid: 7 }] },
    );
    const d = deps({ getCandidates: ladderCandidates(), fetchSearch });
    await runEnrichment(beers(1), d);
    expect(fetchSearch.mock.calls.map((c) => c[0].query)).toEqual(['n:N0', 'q:N0']);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
  });

  it('does not widen after a non-empty narrow rung the server rejects', async () => {
    const fetchSearch = vi.fn(async (_q: { query: string }) => ({ hits: [{ bid: 7 }] }));
    const d = deps({
      getCandidates: ladderCandidates(),
      fetchSearch,
      submitResult: vi.fn(async (): Promise<EnrichResult> => ({ status: 'not_found' })),
    });
    await runEnrichment(beers(1), d);
    expect(fetchSearch).toHaveBeenCalledTimes(1);
    expect(d.setOrphan).toHaveBeenCalledWith('k0', 'B', 'N0');
  });

  it('reports the executed query for a single-rung beer too', async () => {
    const d = deps();
    await runEnrichment(beers(1), d);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
  });

  it('spends the page budget on searches, not beers', async () => {
    const fetchSearch = zeroHits();
    const d = deps({ getCandidates: ladderCandidates(), fetchSearch });
    await runEnrichment(beers(MAX_SEARCHES_PER_PAGE), d); // 20 beers × 2 rungs
    expect(fetchSearch).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE); // 20 searches, 10 beers
    expect(d.submitResult).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE / 2);
    expect(d.sleep).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE - 1); // throttle between searches
  });

  it('does not submit a beer whose ladder ran out of budget mid-way', async () => {
    // Beer 0 is single-rung (1 search), beers 1..9 are two-rung (18) → 19 searches spent.
    // Beer 10 runs its narrow rung (search 20, zero hits) and has no budget to widen.
    const fetchSearch = zeroHits();
    const d = deps({ getCandidates: ladderCandidatesAfterFirst(), fetchSearch });
    await runEnrichment(beers(MAX_SEARCHES_PER_PAGE), d);

    expect(fetchSearch).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE);
    // 10 completed ladders submit; beer 10 (`N10`) was searched but must NOT be submitted.
    expect(d.submitResult).toHaveBeenCalledTimes(10);
    expect(d.submitResult).not.toHaveBeenCalledWith('B', 'N10', expect.anything(), expect.anything(), expect.anything());
    // It was shown as ⏳, so it must be put back to ⚪ rather than left spinning.
    expect(d.setSearching).toHaveBeenCalledWith('k10');
    expect(d.setOrphan).toHaveBeenCalledWith('k10', 'B', 'N10');
    // Beer 11 was never searched at all.
    expect(d.setSearching).not.toHaveBeenCalledWith('k11');
  });
});
```

Also update the two pre-existing assertions that pin `submitResult`'s exact argument list
(`toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {})` in the main describe block and
the `#369` facts test): append the executed query as a fifth argument, e.g.

```ts
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
```

Run `grep -n "toHaveBeenCalledWith(" extension/src/content/enrich.test.ts` to find every such
assertion and fix each one; the query is always `q:<name>` for the default `deps()`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix extension test -- src/content/enrich.test.ts`
Expected: FAIL — the narrow rung is never fetched and `submitResult` receives four arguments.

- [ ] **Step 3: Implement the ladder**

In `extension/src/content/enrich.ts`, change the `submitResult` signature in `EnrichDeps`:

```ts
  submitResult: (
    brewery: string,
    name: string,
    algolia: AlgoliaResponse,
    facts: OrphanFacts | undefined,
    /** #391: the ladder rung that produced `algolia` — the server records it as search_url. */
    query: string,
  ) => Promise<EnrichResult>;
```

Then replace the body of the search loop in `runEnrichment` — from the `const eligible = …`
line through the end of the `for` loop — with:

```ts
  // #391: the budget counts SEARCHES, not beers. A two-rung ladder can cost two Algolia
  // calls, and what this cap protects is what the page draws from the user's session.
  // Beers past the cap are not lost: the orphan pool is shared with the next page load
  // and with the server cron.
  const eligible = candidates.filter((c) => c.eligible);

  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let searches = 0;
  for (const cand of eligible) {
    if (searches >= MAX_SEARCHES_PER_PAGE) break;
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (!beer) continue;

    // Narrowest first. `algoliaNarrow` is absent unless the two rungs differ (#382).
    const rungs = cand.algoliaNarrow ? [cand.algoliaNarrow, cand.algolia] : [cand.algolia];

    deps.setSearching(beer.key);
    try {
      let response: AlgoliaResponse | null = null;
      let query = rungs[0].query;
      // True only when a zero-hit rung left a wider rung unrun for want of budget.
      let abandoned = false;
      for (const r of rungs) {
        if (searches >= MAX_SEARCHES_PER_PAGE) { abandoned = true; break; }
        if (searches > 0) await sleep(delayMs);
        searches++;
        query = r.query;
        response = await deps.fetchSearch(r);
        // A rung that returned candidates is never widened on: the wide rung's result set
        // is a superset the matcher stages would only re-reject (#382 design §3.3).
        if (response === null || (response.hits?.length ?? 0) > 0) break;
      }

      // A half-run ladder is not a verdict. Submitting the empty narrow payload would make
      // the server record not_found and burn a backoff slot on a search we never finished.
      const res = !abandoned && response
        ? await deps.submitResult(cand.brewery, cand.name, response, orphanFacts(beer), query)
        : null;
      if (res && res.status === 'matched' && res.untappd_id != null) {
        deps.setEnriched(beer.key, res.untappd_id, res.rating_global ?? null);
      } else {
        deps.setOrphan(beer.key, cand.brewery, cand.name);
      }
    } catch {
      deps.setOrphan(beer.key, cand.brewery, cand.name);
    }
  }
```

Note what this deletes: the `.slice(0, MAX_SEARCHES_PER_PAGE)` on `eligible`, the trailing
`if (i < eligible.length - 1) await sleep(delayMs);` and the index-based `for` loop — the
throttle now sits before each search instead of between beers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix extension test -- src/content/enrich.test.ts`
Expected: PASS, whole file green (including the pre-existing budget and throttle tests).

- [ ] **Step 5: Typecheck (the caller in main.ts now mismatches)**

Run: `npm --prefix extension run typecheck`
Expected: exactly one error — `main.ts` passes four arguments to `submitResult`. Task 6 fixes it.

- [ ] **Step 6: Commit**

```bash
git add extension/src/content/enrich.ts extension/src/content/enrich.test.ts
git commit -m "feat(#391): run the narrow rung first and count the page budget in searches"
```

---

### Task 6: Page → service worker mapping carries `query`

**Files:**
- Modify: `extension/src/content/main.ts:53-64` (`submitResult` wiring)
- Test: `extension/src/content/main.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the mapping describe block in `extension/src/content/main.test.ts` (next to the
existing "mapping 2" test):

```ts
  // #391: the executed ladder rung must survive the content-script → service-worker hop.
  it('forwards the executed query into the enrich:result message', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N' }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));

    const result = sent.find((m) => m.type === 'enrich:result')!;
    expect(typeof result.query).toBe('string');
    expect(result.query).not.toBe('');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension test -- src/content/main.test.ts -t "forwards the executed query"`
Expected: FAIL — `result.query` is `undefined`.

- [ ] **Step 3: Pass the query through**

In `extension/src/content/main.ts`, change the `submitResult` wiring from

```ts
      submitResult: async (brewery, name, algolia, facts) =>
        (await sendBg<{ result: EnrichResult | null }>({
          type: 'enrich:result', brewery, name, algolia,
```

to

```ts
      submitResult: async (brewery, name, algolia, facts, query) =>
        (await sendBg<{ result: EnrichResult | null }>({
          type: 'enrich:result', brewery, name, algolia, query,
```

(the remaining spread lines for `abv`/`style`/`bid`/`bidSlug`/`brand`/`pageUrl` are unchanged).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix extension test -- src/content/main.test.ts`
Expected: PASS, whole file green.

- [ ] **Step 5: Typecheck and run the whole extension suite**

Run: `npm --prefix extension run typecheck && npm --prefix extension test`
Expected: no type errors; all extension tests pass.

- [ ] **Step 6: Commit**

```bash
git add extension/src/content/main.ts extension/src/content/main.test.ts
git commit -m "feat(#391): carry the executed rung across the content-script boundary"
```

---

### Task 7: Update `spec.md`

**Files:**
- Modify: `spec.md` §`POST /enrich/candidates` / `POST /enrich/result` (around lines 880-895)

`spec.md` currently states the contract this PR changes, in these words:

> `algolia` містить публічні параметри `{appId,searchKey,indexName:"beer",query,hitsPerPage}`; `query`
> будується через `cleanSearchQuery(brewery,name)` і лишається серверним контрактом.

- [ ] **Step 1: Rewrite the contract paragraph**

Replace the sentence above with:

```
`algolia` містить публічні параметри `{appId,searchKey,indexName:"beer",query,hitsPerPage}`;
його `query` будується через `cleanSearchQuery(brewery,name)` і лишається серверним
контрактом. Додатково (#391) відповідь несе опційний `algoliaNarrow` — той самий об'єкт із
**вузькою** сходинкою драбини `searchQueryLadder` (#382); поле присутнє лише коли сходинки
різні (тобто практично лише для нелатинських назв). Розширення виконує `algoliaNarrow`
**першим** і падає на `algolia` лише коли вузька сходинка повернула **нуль** хітів; після
непорожньої сходинки воно не розширюється ніколи, навіть якщо сервер відповів `not_found`.
Бюджет сторінки (`MAX_SEARCHES_PER_PAGE`) рахує **пошуки**, а не пиво; якщо вузька сходинка
дала нуль, а бюджету на широку вже немає, пиво не сабмітиться взагалі (недобігнута драбина
не є вердиктом). Старі збірки поля не знають і поводяться як раніше.
```

- [ ] **Step 2: Document the `query` field on `/enrich/result`**

In the same section, after the sentence describing what `/enrich/result` accepts
(`{brewery,name,algolia,pageUrl?}` …), add:

```
`/enrich/result` приймає ще й опційний `query` (#391) — сходинку, яку клієнт реально
виконав. Сервер перераховує `searchQueryLadder(brewery,name)` і приймає значення, лише якщо
воно збігається з однією зі сходинок; тоді воно замінює `searchUrls` у результаті
`lookupBeer` і потрапляє в `enrich_failures.search_url`. Будь-яке інше значення ігнорується.
Це прибирає давню неправду релейного шляху: інжектований `search` віддає той самий payload
на будь-який запит, тож URL, які будувала внутрішня драбина `lookupBeer`, описували пошуки,
яких ніхто не виконував.
```

- [ ] **Step 3: Verify the section reads coherently**

Run: `grep -n "algoliaNarrow" -B 3 -A 3 spec.md`
Expected: both new paragraphs appear inside the `/enrich/candidates` … `/enrich/result` section.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(#391): spec the algoliaNarrow rung and the executed-query field"
```

---

### Task 8: Full verification and PR

**Files:** none modified beyond what earlier tasks changed.

- [ ] **Step 1: Run the server suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Run the server typecheck**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 3: Run the extension suite and typecheck**

Run: `npm --prefix extension test && npm --prefix extension run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 4: Confirm the extension docs check**

Run: `git diff --stat origin/main -- extension/`
Expected: only `src/api/{types,client}.ts`, `src/background/index.ts`, `src/content/{enrich,main}.ts`
and their tests. No manifest, option, popup, badge or shop-adapter change ⇒ per CLAUDE.md
`docs/extension-install-uk.md` needs no edit; say so explicitly in the PR body.

- [ ] **Step 5: Confirm no version bump crept in**

Run: `git diff origin/main -- extension/manifest.json extension/package.json`
Expected: empty. 0.14.0 is cut after #386 (design §8).

- [ ] **Step 6: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(#391): carry the #382 query ladder into the relay path" --body "$(cat <<'EOF'
Closes #391.

Serves the #382 narrow rung to the extension as an optional `algoliaNarrow`, keeps
`algolia` as today's wide query so published 0.13.0 clients are untouched, runs the narrow
rung first in the enrichment loop, and lets the client report the rung it executed so
`enrich_failures.search_url` stops citing searches nobody ran.

Live replay (145 active flasker relay orphans): 35 carry a two-rung ladder, 3 verdicts
change — 2 correct matches (6213529, 1705602) and 1 the known #393 row, which is parked by
backoff on both paths. No row that matches today stops matching.

Design: `docs/superpowers/specs/2026-08/2026-08-10-391-relay-query-ladder-design.md`
Plan: `docs/superpowers/plans/2026-08/2026-08-10-391-relay-query-ladder.md`

Extension docs: no user-facing change (no new shop, option, button or badge) ⇒
`docs/extension-install-uk.md` unchanged, per the CLAUDE.md check.
Version: not bumped — 0.14.0 is cut after #386.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Kgthzkhf22sMhFN8wiNWxT
EOF
)"
```

- [ ] **Step 7: Wait for the AI review, read it critically, and address it**

Poll `gh pr view <n> --comments` until the AI review lands (project policy: never skip it).
Verify each finding against the live code path before acting: fix the valid ones, push back
in a reply on the wrong ones.

---

## Post-merge (not part of this plan's tasks)

1. Deploy the server half (`./deploy/deploy.sh` — it does not ship extension code).
2. Re-arm the two rows the replay proved recoverable once a 0.14.0 build is published:
   `29789` and `30845`. Until the store release exists, the relay half stays inert.
3. Leave `34221` parked — it is #393.
