# /status Sync-Completeness Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/status`'s misleading `complete`-based "deep sync in progress" line with a ✅ folded onto the `synced / profile_total` count line when the user has all their check-ins (closes #190).

**Architecture:** Display-only change in the pure `buildStatusMessage` builder: drop the separate sync-status line, append a language-neutral ` ✅` to the count line when `profileTotal != null && synced >= profileTotal`. Remove the now-unused `complete` field from `StatusView` and the orphaned i18n keys.

**Tech Stack:** TypeScript, Telegraf, Vitest.

---

## File Structure

**Modify:**
- `src/bot/commands/status-build.ts` — drop the `complete`/sync-status line; add ✅ suffix; remove `complete` from `StatusView`.
- `src/bot/commands/status-build.test.ts` — drop `complete` from the base fixture + the in-progress test; add ✅ caught-up / no-✅ behind / no-✅ when total unknown.
- `src/bot/commands/status.ts` — stop populating `complete`.
- `src/i18n/types.ts` — remove `status.sync_complete` / `status.sync_in_progress` declarations.
- `src/i18n/locales/{en,uk,pl}.ts` — remove those two key/value lines.
- `spec.md` §4 `/status` — update the sync block wording.

**Unchanged:** `checkin_sync_state.complete` column and `getSyncState().complete` stay (still tracked by the sync endpoint; just not displayed). No migration, no data change.

---

### Task 1: Fold completeness into the count line (builder + view + command)

**Files:**
- Modify: `src/bot/commands/status-build.ts`
- Modify: `src/bot/commands/status-build.test.ts`
- Modify: `src/bot/commands/status.ts`

- [ ] **Step 1: Update the tests first**

In `src/bot/commands/status-build.test.ts`:

(a) Remove `complete: true,` from the `base` fixture object (the `StatusView` no longer has that field).

(b) Delete this entire test block:

```ts
  it('shows deep-sync-in-progress when not complete', () => {
    const out = buildStatusMessage(t, { ...base, complete: false });
    expect(out).toContain(t('status.sync_in_progress'));
  });
```

(c) In the existing `'shows settings + full sync stats with profile total'` test (base has `synced: 11287`, `profileTotal: 11290` → behind), add an assertion that no checkmark shows:

```ts
    expect(out).not.toContain('✅');
```

(d) Add these new tests inside the `describe('buildStatusMessage', ...)` block:

```ts
  it('appends ✅ to the count line when synced >= profileTotal (caught up)', () => {
    const out = buildStatusMessage(t, { ...base, synced: 12428, profileTotal: 12428 });
    expect(out).toContain('12428 / 12428 ✅');
  });

  it('does not append ✅ when synced exceeds profileTotal is false (behind)', () => {
    const out = buildStatusMessage(t, { ...base, synced: 100, profileTotal: 12428 });
    expect(out).toContain('100 / 12428');
    expect(out).not.toContain('✅');
  });

  it('shows no ✅ and no separate sync line when profileTotal is unknown', () => {
    const out = buildStatusMessage(t, { ...base, profileTotal: null });
    expect(out).toContain('Check-ins synced: 11287');
    expect(out).not.toContain('✅');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/bot/commands/status-build.test.ts`
Expected: FAIL — the base fixture no longer type-checks against `StatusView` (still has `complete`) and/or the ✅ assertions fail. (If the runner reports a TS error on `complete`, that is the expected failing state for this step; proceed to implement.)

- [ ] **Step 3: Update `StatusView` and the builder**

In `src/bot/commands/status-build.ts`:

(a) Remove the `complete: boolean;` field from the `StatusView` interface.

(b) Replace the count-line + sync-status-line block. Find:

```ts
  lines.push(esc(t('status.username', { username: view.username ?? '' })));
  lines.push(
    esc(
      view.profileTotal != null
        ? t('status.checkins_of', { synced: view.synced, total: view.profileTotal })
        : t('status.checkins', { synced: view.synced }),
    ),
  );
  lines.push(esc(view.complete ? t('status.sync_complete') : t('status.sync_in_progress')));
  lines.push(esc(t('status.distinct_beers', { count: view.distinctBeers })));
```

Replace with:

```ts
  lines.push(esc(t('status.username', { username: view.username ?? '' })));
  const caughtUp = view.profileTotal != null && view.synced >= view.profileTotal;
  lines.push(
    esc(
      view.profileTotal != null
        ? t('status.checkins_of', { synced: view.synced, total: view.profileTotal }) +
            (caughtUp ? ' ✅' : '')
        : t('status.checkins', { synced: view.synced }),
    ),
  );
  lines.push(esc(t('status.distinct_beers', { count: view.distinctBeers })));
```

(The separate `status.sync_complete`/`status.sync_in_progress` line is gone; `✅` is a
plain character so escaping it is a no-op.)

- [ ] **Step 4: Stop populating `complete` in the command**

In `src/bot/commands/status.ts`, remove this line from the `StatusView` object literal:

```ts
    complete: sync.complete,
```

Leave `const sync = getSyncState(db, id);` and `profileTotal: sync.profile_total,` intact — `sync` is still needed for `profile_total`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/bot/commands/status-build.test.ts && npm run typecheck`
Expected: PASS (builder tests green; typecheck clean — `status.ts` no longer references the removed field).

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/status-build.ts src/bot/commands/status-build.test.ts src/bot/commands/status.ts
git commit -m "fix(status): show completeness as ✅ on count line, drop misleading sync state (#190)"
```

---

### Task 2: Remove orphaned i18n keys + update spec

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`
- Modify: `spec.md`

- [ ] **Step 1: Remove the key declarations**

In `src/i18n/types.ts`, delete these two lines (around lines 116-117):

```ts
  'status.sync_complete': string;
  'status.sync_in_progress': string;
```

- [ ] **Step 2: Remove the locale strings**

Delete the corresponding two lines from each locale file:

`src/i18n/locales/en.ts`:
```ts
  'status.sync_complete': 'Sync: complete ✅',
  'status.sync_in_progress': 'Sync: deep sync in progress ⏳',
```

`src/i18n/locales/uk.ts`:
```ts
  'status.sync_complete': 'Синхронізація: завершено ✅',
  'status.sync_in_progress': 'Синхронізація: триває глибока синхронізація ⏳',
```

`src/i18n/locales/pl.ts`:
```ts
  'status.sync_complete': 'Synchronizacja: zakończona ✅',
  'status.sync_in_progress': 'Synchronizacja: trwa głęboka synchronizacja ⏳',
```

- [ ] **Step 2b: Update spec.md §4 `/status`**

In `spec.md`, find the `/status` Untappd/sync description (the bullet describing
"стан синхронізації (завершено / триває глибока)"). Replace that clause so it reads
(matching the surrounding Ukrainian prose):

> username, `synced` чекінів (із `/ profile_total`, коли відомо; ✅ коли `synced ≥ profile_total`), к-сть унікального випитого пива, дата останнього чекіна (або підказка `/import` / розширення, якщо чекінів немає).

i.e. drop the "стан синхронізації (завершено / триває глибока)" item entirely and fold
the ✅ into the `synced / profile_total` clause.

- [ ] **Step 3: Verify nothing else references the removed keys**

Run: `grep -rn "sync_complete\|sync_in_progress" src/ ; npm run typecheck`
Expected: grep prints nothing; typecheck clean (all three locales satisfy `Messages` with the two keys removed).

- [ ] **Step 4: Full test + build**

Run: `npm test && npm run build`
Expected: PASS (all suites; build clean).

- [ ] **Step 5: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/en.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts spec.md
git commit -m "chore(i18n): drop orphaned status sync-state strings; update spec (#190)"
```

---

## Self-Review

**Spec coverage:**
- ✅ on count line when `synced >= profile_total` → Task 1 (Step 3 `caughtUp`). ✅
- Bare `synced / profile_total` when behind → Task 1 (no suffix). ✅
- `synced` only when `profile_total` unknown → Task 1 (unchanged `status.checkins` branch). ✅
- Drop separate sync-status line → Task 1 (Step 3 removes it). ✅
- Remove `complete` from `StatusView` + command → Task 1 (Steps 3a, 4). ✅
- Delete orphaned i18n keys → Task 2 (Steps 1-2). ✅
- spec.md §4 update → Task 2 (Step 2b). ✅
- `checkin_sync_state.complete` left intact → not touched by any task. ✅

**Placeholder scan:** No TBD / vague steps — all edits shown as concrete code. ✅

**Type consistency:** `StatusView` loses `complete` in Task 1; the only other reference (`status.ts`) is updated in the same task (Step 4), so the type stays consistent within Task 1. `caughtUp` derived once and used once. i18n key removal is consistent across `types.ts` + 3 locales (Task 2). ✅
