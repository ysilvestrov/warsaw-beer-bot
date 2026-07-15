# Untappd Breaker Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single shared Untappd circuit breaker into two independent breakers — an Algolia-search breaker (enrich / ontap refresh) and an HTML-scrape breaker (profile had-list + tap ratings) — so a block on one path never gates the other.

**Architecture:** Pure wiring change in `src/index.ts`. The breaker module `src/domain/untappd-circuit.ts` is unchanged; we instantiate two `createPersistentCircuitBreaker` with distinct `job_state` keys and route each job to the correct one. The Algolia breaker keeps the legacy key `untappd_circuit_open_until` so `stats.untappdSearchHealthy` stays correct and live state survives deploys. The new HTML breaker uses `untappd_profile_http_open_until`.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (`job_state` key/value persistence).

**Spec:** `docs/superpowers/specs/2026-07/2026-07-15-untappd-breaker-split-design.md` · Issue #221

---

### Task 1: Breaker-isolation regression test

Guards the property the whole split relies on: two persistent breakers with distinct keys are independent. The breaker module is not being changed, so this test passes against the current code — it is a regression guard that must keep passing after the rewire (and would catch a future accidental key-collision).

**Files:**
- Test: `src/domain/untappd-circuit.test.ts` (append two tests)

- [ ] **Step 1: Add the isolation tests**

Append to the end of `src/domain/untappd-circuit.test.ts` (the file already imports `createPersistentCircuitBreaker`, `getJobState`, and defines `freshDb` and `at`):

```typescript
test('two persistent breakers with distinct keys are isolated (profile trip)', () => {
  const db = freshDb();
  const algolia = createPersistentCircuitBreaker({
    db, key: 'untappd_circuit_open_until', cooldownMs: 6 * 3600_000,
    blockThreshold: 1, onTrip: () => {}, onRecover: () => {},
  });
  const profile = createPersistentCircuitBreaker({
    db, key: 'untappd_profile_http_open_until', cooldownMs: 6 * 3600_000,
    blockThreshold: 1, onTrip: () => {}, onRecover: () => {},
  });

  // Trip only the profile-http breaker.
  expect(profile.canAttempt(at(0))).toBe(true);
  profile.onResult(true, at(0));
  expect(profile.canAttempt(at(1))).toBe(false); // open within cooldown

  // Algolia breaker is untouched, and only the profile key exists.
  expect(algolia.canAttempt(at(1))).toBe(true);
  expect(getJobState(db, 'untappd_profile_http_open_until')).not.toBeNull();
  expect(getJobState(db, 'untappd_circuit_open_until')).toBeNull();
});

test('two persistent breakers with distinct keys are isolated (algolia trip)', () => {
  const db = freshDb();
  const algolia = createPersistentCircuitBreaker({
    db, key: 'untappd_circuit_open_until', cooldownMs: 6 * 3600_000,
    blockThreshold: 1, onTrip: () => {}, onRecover: () => {},
  });
  const profile = createPersistentCircuitBreaker({
    db, key: 'untappd_profile_http_open_until', cooldownMs: 6 * 3600_000,
    blockThreshold: 1, onTrip: () => {}, onRecover: () => {},
  });

  algolia.onResult(true, at(0));
  expect(algolia.canAttempt(at(1))).toBe(false);
  expect(profile.canAttempt(at(1))).toBe(true);
  expect(getJobState(db, 'untappd_circuit_open_until')).not.toBeNull();
  expect(getJobState(db, 'untappd_profile_http_open_until')).toBeNull();
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run src/domain/untappd-circuit.test.ts`
Expected: PASS (all tests green, including the two new ones).

- [ ] **Step 3: Commit**

```bash
git add src/domain/untappd-circuit.test.ts
git commit -m "test(circuit): guard breaker isolation across distinct job_state keys (#221)"
```

---

### Task 2: Rewire index.ts to two breakers

**Files:**
- Modify: `src/index.ts` (breaker declaration ~137-149, then six `breaker:` consumer sites)

- [ ] **Step 1: Replace the single breaker declaration with two**

In `src/index.ts`, replace this block (the `adminAlert` line stays; the comment + `untappdBreaker` declaration is replaced):

```typescript
  // One shared breaker across all Untappd jobs: blockThreshold counts CONSECUTIVE
  // blocks across the whole Untappd circuit (any job), not per-job — a healthy
  // success in any job resets the count. With a rotating proxy each block is a
  // different exit IP, so N consecutive blocks signal a systemic problem.
  const untappdBreaker = createPersistentCircuitBreaker({
    db,
    key: 'untappd_circuit_open_until',
    cooldownMs: 6 * 60 * 60 * 1000,
    blockThreshold: env.UNTAPPD_BLOCK_THRESHOLD,
    onTrip: () => adminAlert('⚠️ Untappd: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd: доступ відновлено, енрич продовжено.'),
  });
```

with:

```typescript
  // Two independent Untappd breakers. The Algolia search path (enrich /
  // ontap refresh) and the HTML-scrape path (profile had-list + tap ratings)
  // fail for different reasons (see #298) and must not gate each other.
  // blockThreshold counts CONSECUTIVE blocks WITHIN each path; a healthy
  // success in that path resets its count.
  // The Algolia breaker keeps the legacy key 'untappd_circuit_open_until' so
  // stats.untappdSearchHealthy (which reads that key) stays correct and the
  // live open_until state survives deploys.
  const algoliaBreaker = createPersistentCircuitBreaker({
    db,
    key: 'untappd_circuit_open_until',
    cooldownMs: 6 * 60 * 60 * 1000,
    blockThreshold: env.UNTAPPD_BLOCK_THRESHOLD,
    onTrip: () => adminAlert('⚠️ Untappd Algolia: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd Algolia: доступ відновлено, енрич продовжено.'),
  });
  const profileHttpBreaker = createPersistentCircuitBreaker({
    db,
    key: 'untappd_profile_http_open_until',
    cooldownMs: 6 * 60 * 60 * 1000,
    blockThreshold: env.UNTAPPD_BLOCK_THRESHOLD,
    onTrip: () => adminAlert('⚠️ Untappd профіль-скрейп: 403/блок — скрейп профілів/рейтингів призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd профіль-скрейп: доступ відновлено.'),
  });
```

- [ ] **Step 2: Route the Algolia-path consumers to `algoliaBreaker`**

There are three Algolia-path sites, each currently `breaker: untappdBreaker,`. Identify each by the call it sits in and change it to `breaker: algoliaBreaker,`:

1. Inside the **manual** `refreshOntap({ … search: algoliaSearch })` call (the one right after `createRefreshCommand(` → `await refreshOntap({`).
2. Inside the **cron** `refreshOntap({ … search: algoliaSearch })` call (inside `cron.schedule('0 */12 * * *', …)`).
3. Inside the `enrichOrphans({ db, log, search: algoliaSearch, … })` call (inside `cron.schedule('30 */3 * * *', …)`).

Each edit: `breaker: untappdBreaker,` → `breaker: algoliaBreaker,` at that site.

- [ ] **Step 3: Route the HTML-scrape consumers to `profileHttpBreaker`**

There are three HTML-scrape sites, each currently `breaker: untappdBreaker,`. Change each to `breaker: profileHttpBreaker,`:

1. Inside the **manual** `refreshAllUntappd({ db, log, http: untappdHttp, onProgress: notify, notifyAdmin, … })` call (guarded by `if (!opts?.pubSlugs && untappdHttp)`).
2. Inside the `refreshTapRatings({ db, log, http: untappdSearchHttp, … })` call (inside `cron.schedule('30 1,4,7,10,13,16,19,22 * * *', …)`).
3. Inside the **cron** `refreshAllUntappd({ db, log, http: untappdHttp, notifyAdmin, … })` call (inside `if (untappdHttp) { cronJobs.push(cron.schedule('0 3 * * *', …)) }`).

Each edit: `breaker: untappdBreaker,` → `breaker: profileHttpBreaker,` at that site.

- [ ] **Step 4: Verify no reference to the old name remains**

Run: `grep -n "untappdBreaker" src/index.ts`
Expected: no output (all six consumers + the declaration renamed). If any line prints, fix that site per Step 2/3.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors (confirms both new identifiers resolve and all six sites reference a defined breaker).

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (all existing tests + the two isolation tests from Task 1). `stats.ts` is untouched, so `untappdSearchHealthy` tests remain green.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: exit 0 (tsc compiles `dist/`).

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat(circuit): split Untappd breaker into Algolia + profile-http paths (#221)"
```

---

## Self-Review

**Spec coverage:**
- Two breakers with own `*_open_until` keys → Task 2 Step 1. ✅
- `untappdSearchHealthy` stays correct (Algolia keeps legacy key, `stats.ts` untouched) → Task 2 Step 1 comment + Step 6. ✅
- Separate labelled alerts (variant b) → Task 2 Step 1 (both `onTrip`/`onRecover` strings). ✅
- No `job_state` migration (Algolia inherits key; new key created lazily) → design; nothing to implement. ✅
- Isolation test → Task 1. ✅
- Consumer mapping (3 Algolia + 3 HTML) → Task 2 Steps 2–3, all six sites enumerated. ✅

**Placeholder scan:** No TBD/TODO; all code shown in full; all commands have expected output.

**Type consistency:** `algoliaBreaker` / `profileHttpBreaker` are the only new identifiers; both are `CircuitBreaker` (return of `createPersistentCircuitBreaker`), the exact type `breaker:` already accepts. Keys `untappd_circuit_open_until` / `untappd_profile_http_open_until` match the spec and the Task 1 test verbatim.

## Out of scope

- Fixing the underlying 403 on HTML endpoints (residential egress / fingerprint / cookie refresh) — issue #298.
- Changing threshold/cooldown or per-breaker config — shared defaults kept.
