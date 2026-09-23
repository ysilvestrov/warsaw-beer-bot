# #695 inactive legacy orphans: write-boundary guardrails

Date: 2026-09-23
Origin: whole-branch review of the runtime integration plan

The active episode is an operator-only state. Read-side pool exclusion is not sufficient when a lookup was already in flight at application time, or when a different manual repair command targets the row without reopening it first. No production row has been disposed.

## Task 1 — Manual repair requires reopen

In `src/domain/pin-match.ts` and `src/domain/repair-legacy-card.ts`, reject an active episode for the targeted beer before any mutation. Check inside the transaction for `pinMatch`; preview and apply of legacy repair already re-read under a transaction, so the preview guard binds both. Focused tests prove refusal leaves the episode, orphan, failure, and links intact, and that an explicit reopen restores the existing manual path. No new public status.

## Task 2 — In-flight lookup cannot write after application

In `src/jobs/untappd-enrich.ts`, skip a newly inactive row at its second eligibility gate. In `src/domain/lookup-outcome.ts`, recheck the active episode under a short immediate write transaction before changing any beer, failure, backoff, or alias. Return the existing internal `skipped` kind. In `/enrich/result`, map that internal kind to the existing public `not_found` status, including the published-bid path. Tests pause an async lookup, apply a disposition, resume it, and assert no row/failure mutation; a direct writer test covers all outcome kinds. Do not change the disposition or automatically reopen it.

## Gate

Run focused tests, `npm test && npm run typecheck`, `git diff --check`, inspect branch diff from `902e52b`, commit guardrails separately. PR/deployment and any #677 production disposition remain gated by the original rollout plan.
