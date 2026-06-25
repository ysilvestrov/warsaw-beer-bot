# Persistent Untappd circuit — design

> **Стандарт:** OpenSpec (spec-driven). **Статус:** `DESIGN`.
> **Дата:** 2026-06-25. **Мотивація:** PR #197 зробив VPS-wide Untappd circuit,
> але state лишився in-memory, тому deploy/restart скидає cooldown.
> **Звіряти з:** `spec.md` §3.15, §5.10; `docs/superpowers/specs/2026-06-25-vps-untappd-circuit-design.md`.

## 1. Problem

Після PR #197 усі VPS-originated Untappd-запити (`refreshOntap` inline enrich,
`enrichOrphans`, `refreshTapRatings`, `refreshAllUntappd`) гейтяться одним shared
in-memory breaker. Це закриває блоки в межах життя процесу, але restart/deploy
створює новий breaker у `closed` state і може одразу знову піти в Untappd, навіть якщо
до restart був активний 6h cooldown.

## 2. Goals / Non-goals

**Goals.**
- Persist Untappd cooldown across process restarts and deploys.
- Preserve existing 6h absolute cooldown semantics: block at 12:30 means skip until
  18:30, even if deploy happens at 15:30.
- Avoid a new schema migration by using existing `job_state(key,value)`.
- Keep browser/extension relay outside this circuit.
- Keep admin alerts transition-based, not repeated on every skipped cron tick after restart.

**Non-goals.**
- Do not make the circuit distributed across multiple hosts; there is one VPS process.
- Do not persist historical block diagnostics beyond the existing `enrich_failures` rows.
- Do not change cron cadence, lookup backoff, matcher behavior, or extension relay behavior.

## 3. Design

### 3.1 Storage

Use existing `job_state`:

| key | value |
|-----|-------|
| `untappd_circuit_open_until` | ISO timestamp, e.g. `2026-06-25T18:30:01.000Z` |

No new table or migration is needed. `job_state` already exists for small cross-restart
job state. Add a small `deleteJobState(db, key)` helper so recovery can clear the key.

### 3.2 Persistent circuit factory

Keep the pure `createCircuitBreaker` available for existing unit tests and callers. Add
a DB-backed factory, either in `src/domain/untappd-circuit.ts` or a focused adjacent module,
with the same `CircuitBreaker` interface:

```ts
createPersistentCircuitBreaker({
  db,
  key: 'untappd_circuit_open_until',
  cooldownMs,
  onTrip,
  onRecover,
}): CircuitBreaker
```

Behavior:

- `onResult(true, now)`:
  - set in-memory state to `open`;
  - write `open_until = now + cooldownMs` to `job_state`;
  - call `onTrip` only for `closed -> open`.
- `canAttempt(now)`:
  - read persisted `open_until`;
  - if it is a valid future timestamp, return `false`;
  - if it is expired, promote to `half_open`, clear the persisted key, and allow one probe;
  - if it is missing/invalid, fall back to in-memory state.
- `onResult(false, now)`:
  - if current state is not `closed`, call `onRecover`;
  - set state to `closed`;
  - clear `untappd_circuit_open_until`.

On process startup, the breaker does not need to eagerly read DB state. The first
`canAttempt(now)` call before any Untappd job is enough to reconstruct skip/half-open
behavior from `job_state`.

### 3.3 Alerts

Alerts stay transition-based:

- A new block in `closed` state sends the existing trip alert.
- Repeated skipped cron ticks while `open_until` is still in the future do not alert.
- After restart, observing a future `open_until` does not send a new trip alert; it only
  skips.
- A successful half-open probe sends the existing recovery alert.

### 3.4 Composition root

`src/index.ts` should create the shared Untappd breaker through the persistent factory,
passing the existing `db` and existing alert callbacks. All existing callsites continue
to receive the same `CircuitBreaker` interface.

### 3.5 Malformed persisted value

If `job_state.untappd_circuit_open_until` is malformed, treat it as expired/absent:
clear it and allow normal in-memory behavior. This prevents one bad value from blocking
Untappd forever.

## 4. Testing

- Storage: `deleteJobState` removes a key and is idempotent.
- Persistent circuit:
  - `blocked` writes a future `open_until`;
  - a new breaker instance with the same DB skips while `open_until` is future;
  - expired `open_until` allows a half-open probe and clears the key;
  - successful half-open `onResult(false)` clears the key and emits recovery once;
  - malformed `open_until` is cleared and does not block.
- Existing job tests for `refreshOntap`, `refreshAllUntappd`, `enrichOrphans`, and
  `refreshTapRatings` stay green because the public `CircuitBreaker` interface is unchanged.

## 5. Rollout / Verification

After deploy, the first new VPS Untappd block will persist `open_until`. Existing
pre-deploy in-memory blocks cannot be recovered retroactively because no persisted key
existed before this change.

Operational checks:

```sql
SELECT key, value FROM job_state WHERE key = 'untappd_circuit_open_until';
```

Expected:
- row exists while VPS Untappd cooldown is active;
- row disappears after a successful half-open probe or explicit recovery;
- restart during an active row does not trigger Untappd HTTP before `open_until`.
