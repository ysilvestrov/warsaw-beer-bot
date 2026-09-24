# Inactive Closeout After an Unrescued Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow #677 and other orphan-triage issues to close when an exact active #695 decision follows a negative replay, without clearing the replay marker.

**Architecture:** Keep the existing `inspectOrphanIssue` decision order and exact-key checks. Remove only the `unrescued_at IS NULL` requirement from its active-disposition branch; a negative replay with no active decision remains blocked. The CLI continues to use the same report and repeated GitHub preflight.

**Tech Stack:** TypeScript, SQLite, Vitest, existing operator CLI.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-24-697-inactive-closeout-unrescued-design.md`; existing `spec.md` §§3.6.3, 5.

## Global Constraints

- Work in the isolated branch `fix/697-inactive-closeout`; preserve unrelated worktrees and production data.
- Do not change schema, #695 writes, `unrescued_at`, `review_class`, positive-proof checks, unlock behavior, or GitHub close semantics.
- A bare `unrescued_at` without a current positive proof or exact active disposition remains a blocker.
- The full gate is `npm test && npm run typecheck`; inspect the production cohort only after merge and deploy.

---

### Task 1: Classify the exact inactive decision despite a prior negative replay

**Files:**
- Modify: `src/jobs/orphan-closeout.test.ts`
- Modify: `scripts/close-orphan-issue.test.ts`
- Modify: `src/jobs/orphan-closeout.ts:30-36`

**Interfaces:**
- Consumes: `findActiveDispositionForBeer`, `hasCurrentRescueProof`, `runCloseOrphanIssue`.
- Produces: unchanged `inspectOrphanIssue(db, issueNumber): CloseoutReport` API.

- [ ] **Step 1: Write failing regression tests.** In `src/jobs/orphan-closeout.test.ts`, replace the final test that currently expects an active disposition plus `unrescued_at` to be blocked with these two tests. The production change that must make the first test green is removal of the negative-marker condition from the inactive branch; the second test protects the bare-marker blocker.

```ts
it('accepts an exact inactive decision after an unrescued replay without clearing the marker', () => {
  const { db, add } = fixture();
  const beerId = add('Unknown card');
  db.prepare('UPDATE enrich_failures SET unrescued_at = ? WHERE beer_id = ?')
    .run('2026-09-24T09:00:00Z', beerId);
  insertLegacyDisposition(db, {
    beerId, issueNumber: 697, cardBrewery: 'Mad Brew', cardName: 'Unknown card',
    cardAbv: null, breweryText: cardText('Mad Brew'), nameText: cardText('Unknown card'),
    abvKey: cardAbv(null), failureSourceUrl: '', reason: 'Identity unknown',
    evidenceUrl: 'https://example.com/evidence', operator: 'maintainer',
    inactiveAt: '2026-09-24T09:02:00Z',
  });
  expect(inspectOrphanIssue(db, 697)).toMatchObject({
    ready: true, rows: [{ beerId, state: 'inactive' }],
  });
  expect((db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = ?')
    .get(beerId) as { unrescued_at: string }).unrescued_at).toBe('2026-09-24T09:00:00Z');
});

it('keeps an unrescued replay without a disposition blocked', () => {
  const { db, add } = fixture();
  const beerId = add('Unknown card');
  db.prepare('UPDATE enrich_failures SET unrescued_at = ? WHERE beer_id = ?')
    .run('2026-09-24T09:00:00Z', beerId);
  expect(inspectOrphanIssue(db, 697)).toMatchObject({
    ready: false,
    rows: [{ beerId, state: 'blocked', reason: 'unrescued replay is not a closeout disposition' }],
  });
});
```

In `scripts/close-orphan-issue.test.ts`, import `insertLegacyDisposition` from `../src/storage/legacy-orphan-dispositions` and `cardAbv`, `cardText` from `../src/domain/card-text`, then add the CLI-boundary test:

```ts
it('closes only after an exact inactive decision resolves a prior negative replay', async () => {
  const f = fixture();
  f.db.prepare(`INSERT INTO beers (id, brewery, name, normalized_brewery, normalized_name)
    VALUES (1, 'Mad Brew', 'Unknown card', 'mad brew', 'unknown card')`).run();
  f.db.prepare(`INSERT INTO enrich_failures
    (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
     fail_count, last_at, review_class, issue_number, unrescued_at)
    VALUES (1, 'Mad Brew', 'Unknown card', '', 'not_found', 0, '', 1,
      '2026-09-24T09:00:00Z', 'parser_bug', 697, '2026-09-24T09:00:00Z')`).run();
  expect(await runCloseOrphanIssue(['--issue', '697', '--close'], f)).toBe(1);
  expect(f.closes()).toBe(0);
  insertLegacyDisposition(f.db, {
    beerId: 1, issueNumber: 697, cardBrewery: 'Mad Brew', cardName: 'Unknown card',
    cardAbv: null, breweryText: cardText('Mad Brew'), nameText: cardText('Unknown card'),
    abvKey: cardAbv(null), failureSourceUrl: '', reason: 'Identity unknown',
    evidenceUrl: 'https://example.com/evidence', operator: 'maintainer',
    inactiveAt: '2026-09-24T09:02:00Z',
  });
  expect(await runCloseOrphanIssue(['--issue', '697', '--close'], f)).toBe(0);
  expect(f.closes()).toBe(1);
  expect(JSON.parse(f.lines.at(-1)!)).toMatchObject({
    closed: true, ready: true, rows: [{ beerId: 1, state: 'inactive' }],
  });
});
```

- [ ] **Step 2: Verify the red phase.** Run `npx vitest run src/jobs/orphan-closeout.test.ts scripts/close-orphan-issue.test.ts`. Expect the two new active-decision assertions to fail because the report still classifies the row as `blocked`; the bare-marker test must pass.

- [ ] **Step 3: Make the minimal production change.** In `src/jobs/orphan-closeout.ts`, replace only the final condition of the active-disposition branch:

```ts
      && row.untappd_id === null && row.retired_at === null) {
```

Keep the following positive-proof and blocker branches unchanged.

- [ ] **Step 4: Verify focused and full green.** Run `npx vitest run src/jobs/orphan-closeout.test.ts scripts/close-orphan-issue.test.ts`, then `npm test && npm run typecheck`. Inspect failures rather than changing unrelated code.

- [ ] **Step 5: Review scope and commit.** Run `git diff --check`, inspect the diff against the spec, and commit only the three files above with `fix: honor inactive closeout after negative replay`. No production data changes in this task.

## Post-merge operator verification (not part of the code task)

After the PR is merged and deployed, run `npm run close-orphan-issue -- --issue 677` in production. It must show seven #696 repairs, row 29893 as `inactive`, and `ready: true`. Then run `npm run close-orphan-issue -- --issue 677 --close` and verify GitHub reports closed; the #695 episode remains active and 29893 retains `unrescued_at` with no `unlocked_at` or rearm. Remove only task-specific temporary files after verified deployment.
