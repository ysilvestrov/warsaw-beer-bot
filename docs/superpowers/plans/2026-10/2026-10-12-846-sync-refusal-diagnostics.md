# #846 sync refusal diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A refused check-in sync names what refused it — in the popup for the person, in the journal for us.

**Architecture:** The server logs one `warn` line per refusal of `POST /checkins/sync`. The extension gains two terminal sync states (`feed_unavailable`, `page_rejected`) decided by a pure function and by one new mapping in the API client.

**Tech Stack:** TypeScript, Hono, pino, Vitest, browser extension (MV3).

**Spec:** `docs/superpowers/specs/2026-10/2026-10-12-846-sync-refusal-diagnostics-design.md`

## Global Constraints

- Full gate per task: `npm test && npm run typecheck` in the root and in `extension/`. Tests only through `npm test -- <args>`.
- Test quality: exact asserts, no conditionals in tests, literal expected values.
- The journal line carries no Telegram id, no account name, no HTML, no check-in ids and no cursor value.
- Response statuses and bodies of `/checkins/sync` do not change.
- `spec.md`, both install guides and `extension/CHANGELOG.md` are updated in the same PR.

---

### Task 1: the server logs every refusal

**Files:**
- Modify: `src/api/routes/checkins.ts`
- Test: `src/api/routes/checkins.test.ts`

**Interfaces:**
- Produces: `log.warn(facts, 'checkins sync refused')` where `facts` is `{ code }` plus, where known, `reason`, `pageSize`, `hasCursor`.

- [ ] **Step 1: failing tests** — one per row of the spec's refusal table, each asserting `warn.mock.calls` equals the exact list, e.g.

```ts
expect(warn.mock.calls).toEqual([[{ code: 'bad_cursor', reason: 'newest_above_cursor', pageSize: 2, hasCursor: true }, 'checkins sync refused']]);
```

and one asserting an accepted page leaves `warn.mock.calls` equal to `[]`.

- [ ] **Step 2: run** `npm test -- src/api/routes/checkins.test.ts` — the new tests fail with `[]` received.

- [ ] **Step 3: implement** a local helper inside the `POST` handler

```ts
const refuse = <S extends 400 | 409 | 422 | 502>(status: S, code: string, facts: Record<string, unknown> = {}) => {
  deps.log.warn({ code, ...facts }, 'checkins sync refused');
  return c.json({ error: code }, status);
};
```

and route every refusal through it with the facts from the spec's table.

- [ ] **Step 4: full gate, commit.**

### Task 2: the extension names the two refusals

**Files:**
- Modify: `extension/src/api/client.ts`, `extension/src/background/handle-checkin-sync.ts`, `extension/src/background/index.ts`, `extension/src/popup/popup.ts`
- Test: `extension/src/api/client.test.ts`, `extension/src/background/handle-checkin-sync.test.ts`, `extension/src/popup/popup.test.ts`
- Modify: `spec.md`, `docs/extension-install-uk.md`, `docs/extension-install-en.md`, `extension/CHANGELOG.md`

**Interfaces:**
- Produces: `ApiErrorCode` gains `'feed_unavailable' | 'page_rejected'`; `SyncStatus` gains the same two;
  `feedFailure(isMoreFeed: boolean, res: { ok: boolean; status: number; redirected: boolean }): 'blocked' | 'feed_unavailable' | null`.

- [ ] **Step 1: failing tests** — the cases listed in the spec's «Тести» for `feedFailure`, `runCheckinSync`, `postCheckinSyncPage`, `formatSyncStatus`.

- [ ] **Step 2: implement**

```ts
export function feedFailure(isMoreFeed: boolean, res: { ok: boolean; status: number; redirected: boolean }): 'blocked' | 'feed_unavailable' | null {
  if (res.status === 403 || res.status === 429) return 'blocked';
  if ((isMoreFeed && res.redirected) || !res.ok) return 'feed_unavailable';
  return null;
}
```

`fetchFeed` in `index.ts` calls it, `console.warn`s status and `redirected` on `feed_unavailable`, and throws `ApiError(code)`. `runCheckinSync` maps the two codes to the two states. `postCheckinSyncPage` maps `400` + `bad_cursor` to `page_rejected`. `formatSyncStatus` gets the two texts from the spec.

- [ ] **Step 3: documents** — `spec.md`, both install guides, changelog line.

- [ ] **Step 4: full gate in root and `extension/`, commit.**
