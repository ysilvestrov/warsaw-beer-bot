# #854 backdated check-in page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A feed page that carries a backdated check-in (id above the cursor) is accepted instead of being refused forever.

**Architecture:** One guard in `POST /checkins/sync` is replaced: "newest id above the cursor" becomes "the page contains the cursor check-in itself". The loop guard that follows becomes unreachable and is removed.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-12-854-backdated-checkin-page-design.md`

## Global Constraints

- Full gate: `npm test && npm run typecheck`. Tests only through `npm test -- <args>`.
- Test quality: exact asserts, no conditionals, literal expected values.
- The coverage range written for an accepted page stays `[oldest, cursor]`.
- `spec.md` is updated in the same PR. The extension is not touched.

---

### Task 1: replace the guard

**Files:**
- Modify: `src/api/routes/checkins.ts`
- Test: `src/api/routes/checkins.test.ts`
- Modify: `spec.md`

- [ ] **Step 1: failing tests**

```ts
it('accepts a page that carries a backdated checkin whose id is above the cursor', async () => {
  const { app, db } = setup();
  const res = await post(app, '/checkins/sync', { html: pageOf([700, 580, 570]), maxId: '590' }, RAW_TOKEN);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ merged: 3, alreadyKnown: 0, pageSize: 3, nextCursor: '570' });
  expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 570, to_id: 590 }]);
  expect(checkinExists(db, TELEGRAM_ID, '700')).toBe(true);
});
```

plus: a page containing the cursor at the bottom, in the middle and as its only item → `400 bad_cursor`; the journal reason `page_contains_cursor`; no journal line for the accepted page; a strictly lower `nextCursor` when the page merges into an existing range.

- [ ] **Step 2: run** `npm test -- src/api/routes/checkins.test.ts` — the acceptance test fails with `400`.

- [ ] **Step 3: implement**

```ts
if (cursor !== null && oldest > cursor) return badCursor('oldest_above_cursor');
if (cursor !== null && ids.includes(cursor)) return badCursor('page_contains_cursor');
```

Remove the `nextCursor >= cursor → null` block; `nextCursor` becomes `const`.

- [ ] **Step 4: mutation** — comment out the new guard, confirm the cursor tests fail, restore.

- [ ] **Step 5: `spec.md`**, full gate, commit.
