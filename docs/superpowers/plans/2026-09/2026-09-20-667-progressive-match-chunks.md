# Progressive `/match` Chunks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a large shop catalog render each completed 200-card `/match` result without waiting for later cards.

**Architecture:** `runOverlay` owns the 200-card partition because it owns cards, DOM rendering, cache writes, and enrichment. It sends each partition through the existing one-request/one-reply `SendMatch` transport and finalizes that partition before asking for the next. The service worker therefore receives no more than 200 cards and performs one API request; it no longer aggregates chunks itself.

**Tech Stack:** TypeScript, Vitest, Chrome runtime messaging and storage.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-20-667-progressive-match-chunks-design.md`

## Global Constraints

- Keep the `match` → `match:ok|match:err` Chrome runtime message contract unchanged.
- Process at most 200 uncached cards per `SendMatch` request, sequentially in original card order.
- A failed or short response affects only its own partition; later partitions continue.
- Submit each successful partition as exactly one existing `cache:set-many` operation before enriching that partition.
- Preserve #648 working/failure states, #666 cache ordering, and existing server-owned enrichment eligibility.
- Add one user-facing `Unreleased` entry and update `docs/extension-install-uk.md` for the visible behavior.

---

### Task 1: Prove progressive rendering and per-partition failures

**Files:**
- Modify: `extension/src/content/index.test.ts`

**Interfaces:**
- Consumes: `runOverlay(doc, adapter, sendMatch, enrich?, cacheSetMany?)`.
- Produces: regressions that require `sendMatch` calls of at most 200 `RawBeer` items and allow later partitions after an earlier rejection.

- [ ] **Step 1: Add a deferred second-partition test**

  Create 201 cards with distinct brewery/name pairs. Make `sendMatch` return a first result array immediately for the first 200 calls and a deferred Promise for the last card. Start `runOverlay` without awaiting it, wait until `sendMatch` has been called twice, then assert card 0 has a final badge while card 200 still has `data-icon="working"`. Resolve the deferred Promise and await the overlay.

  ```ts
  const deferred = Promise.withResolvers<MatchResult[]>();
  const sendMatch = vi.fn((cards: RawBeer[]) =>
    cards.length === 200
      ? Promise.resolve(cards.map((card) => drunkResult(card.brewery, card.name)))
      : deferred.promise,
  );
  const run = runOverlay(document, adapterFor(cards), sendMatch);
  await vi.waitFor(() => expect(sendMatch).toHaveBeenCalledTimes(2));
  expect(cards[0].el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon')).toBe('check');
  expect(cards[200].el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon')).toBe('working');
  deferred.resolve([drunkResult('B', '200')]);
  await run;
  ```

- [ ] **Step 2: Add a first-partition rejection regression**

  Use 201 cards. Make the first `sendMatch` call reject and the second return its one result. Await `runOverlay`, then assert the first card has `data-icon="failed"`, the final card has `data-icon="check"`, and `sendMatch` was called twice.

  ```ts
  const sendMatch = vi.fn()
    .mockRejectedValueOnce(new Error('temporary network failure'))
    .mockResolvedValueOnce([drunkResult('B', '200')]);
  await runOverlay(document, adapterFor(cards), sendMatch);
  expect(sendMatch).toHaveBeenCalledTimes(2);
  expect(cards[0].el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon')).toBe('failed');
  expect(cards[200].el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon')).toBe('check');
  ```

- [ ] **Step 3: Run the focused test to establish RED**

  Run: `npm --prefix extension test -- src/content/index.test.ts`

  Expected: the first regression fails because current `runOverlay` calls `sendMatch` once with 201 cards; the failure-isolation regression fails because current catch returns before calling the second partition.

- [ ] **Step 4: Commit the regression tests**

  ```bash
  git add extension/src/content/index.test.ts
  git commit -m "test(extension): cover progressive match chunks"
  ```

### Task 2: Finalize each match partition in the content script

**Files:**
- Modify: `extension/src/content/index.ts:139-290`
- Modify: `extension/src/background/index.ts:17-55`
- Test: `extension/src/content/index.test.ts`
- Test: `extension/src/background/index.test.ts`

**Interfaces:**
- Consumes: `SendMatch = (cards: RawBeer[]) => Promise<MatchResult[]>`, `CacheMatchResults`, `EnrichOrphans`, `stateFromMatch`, and `canEnrich`.
- Produces: `runOverlay` sends sequential maximum-200 partitions; `handleMatch` executes one `postMatch` for one received message.

- [ ] **Step 1: Add the background contract regression**

  In `extension/src/background/index.test.ts`, mock `postMatch`, call `handleMatch` with exactly 200 `RawBeer` records, and assert one `postMatch(baseUrl, token, cards)` call plus `match:ok` with that response. This preserves the per-message behavior after deleting the service-worker partition loop.

  ```ts
  vi.spyOn(client, 'postMatch').mockResolvedValue([orphan]);
  const cards = Array.from({ length: 200 }, (_, i) => ({ brewery: 'B', name: String(i) }));
  await handleMatch({ type: 'match', cards });
  expect(client.postMatch).toHaveBeenCalledTimes(1);
  expect(client.postMatch).toHaveBeenCalledWith('https://api.test', 'tok', cards);
  ```

- [ ] **Step 2: Run focused RED tests**

  Run: `npm --prefix extension test -- src/content/index.test.ts src/background/index.test.ts`

  Expected: Task 1 tests still fail; the background test passes under the current implementation and guards its replacement.

- [ ] **Step 3: Extract the per-partition finalization from `runOverlay`**

  Add a local helper that accepts one aligned `rawMisses` partition and its `MatchResult[]`. It must:

  ```ts
  async function finalizeMatchPart(
    misses: RawMiss[], results: MatchResult[], enrich: EnrichOrphans | undefined,
    cacheSetMany: CacheMatchResults,
  ): Promise<void> {
    // compute orphanMisses with canEnrich(result, miss.card)
    // render and mark only aligned results
    // await one cacheSetMany(cacheEntries), swallowing only cache failure
    // render server failure for misses.slice(results.length)
    // call enrich only with this partition's fresh orphan payloads
  }
  ```

  Keep the existing cached-orphan payload construction outside the loop and send it once. Do not re-enrich cached orphans once per fresh partition.

- [ ] **Step 4: Partition and continue after a rejected request**

  Add `const MATCH_CHUNK_SIZE = 200` beside the overlay helpers. Replace the single `await sendMatch(rawMisses.map(...))` block with a sequential loop:

  ```ts
  for (let i = 0; i < rawMisses.length; i += MATCH_CHUNK_SIZE) {
    const part = rawMisses.slice(i, i + MATCH_CHUNK_SIZE);
    try {
      await finalizeMatchPart(part, await sendMatch(part.map((m) => m.raw)), enrich, cacheSetMany);
    } catch {
      for (const miss of part) {
        renderState(miss.el, { kind: 'failed', reason: 'network' });
        markSeen(miss.el);
      }
    }
  }
  ```

  Extract the repeated fresh-orphan object mapping into a helper so each partition preserves every existing `bid`, `bidSlug`, `brand`, `abv`, and `style` field.

- [ ] **Step 5: Simplify `handleMatch` to one request**

  Delete `MAX_PER_REQUEST`, `chunk`, and result accumulation from `extension/src/background/index.ts`. Retain its settings lookup and existing `ApiError` → `MatchReply` error mapping:

  ```ts
  export async function handleMatch(msg: MatchMessage): Promise<MatchReply> {
    const { token, baseUrl } = await getSettings();
    try {
      return { type: 'match:ok', results: await postMatch(baseUrl, token, msg.cards) };
    } catch (e) {
      // retain the existing unauthorized/network/server mapping verbatim
    }
  }
  ```

- [ ] **Step 6: Run focused tests and typecheck**

  Run: `npm --prefix extension test -- src/content/index.test.ts src/background/index.test.ts && npm --prefix extension run typecheck`

  Expected: all focused tests pass; the first 200 cards finalize before the deferred 201st response, and a failed first partition does not suppress the second.

- [ ] **Step 7: Commit implementation**

  ```bash
  git add extension/src/content/index.ts extension/src/content/index.test.ts extension/src/background/index.ts extension/src/background/index.test.ts
  git commit -m "fix(extension): render match chunks progressively"
  ```

### Task 3: Describe the visible behavior and run the full gate

**Files:**
- Modify: `extension/CHANGELOG.md:24-31`
- Modify: `docs/extension-install-uk.md`

**Interfaces:**
- Consumes: the completed progressive rendering behavior from Task 2.
- Produces: user-facing release copy without transport, cache, or implementation terminology.

- [ ] **Step 1: Add the Unreleased changelog entry**

  Place one entry at the top of `## [Unreleased]`:

  ```markdown
  - Large shop pages now start showing finished beer badges while the rest of the catalog is still being checked, instead of waiting for every product before filling in at once.
  ```

- [ ] **Step 2: Update the Ukrainian installation guide**

  Locate the guide text that explains waiting/refreshing a shop page. State that on a large listing, completed cards receive their usual badge while later cards may still show the checking state; do not introduce a new button or workflow.

- [ ] **Step 3: Run all required verification**

  Run:

  ```bash
  npm --prefix extension test
  npm --prefix extension run typecheck
  npm test
  npm run typecheck
  git diff --check
  ```

  Expected: extension suite, root suite, and both TypeScript checks exit 0; `git diff --check` has no whitespace errors.

- [ ] **Step 4: Commit the user-facing documentation**

  ```bash
  git add extension/CHANGELOG.md docs/extension-install-uk.md
  git commit -m "docs(extension): explain progressive catalog badges"
  ```

## Plan Self-Review

- Spec coverage: Task 1 proves progressive visibility and isolated failure; Task 2 preserves sequential ordering, per-partition cache atomicity, enrichment eligibility, and the unchanged message contract; Task 3 covers user-visible copy and the full gate.
- Placeholder scan: no incomplete or unspecified implementation steps remain.
- Type consistency: `SendMatch`, `CacheMatchResults`, `EnrichOrphans`, `MatchResult`, `RawBeer`, and `runOverlay` use their current exported names; the only new internal constant is `MATCH_CHUNK_SIZE`.
