# Config robustness: loud missing-key warnings + safe env editing

**Date:** 2026-06-27
**Motivation:** 2026-06-27 incident — `ADMIN_TELEGRAM_ID` was dropped from prod
`/etc/warsaw-beer-bot/.env` during a manual `WEBSHARE_PROXY` edit. With it unset,
`notifyAdmin` was `undefined`, so the daily status digest (and admin alerts)
silently no-op'd for two days with no log line at `LOG_LEVEL=info`. See memory
`reference_env_config_ops`.

## Problem

`src/config/env.ts` splits env into:
- **Required** (`TELEGRAM_BOT_TOKEN`, `DATABASE_PATH`, `OSRM_BASE_URL`,
  `NOMINATIM_USER_AGENT`): already fail loud via `Schema.parse()` at startup.
- **Optional** (`UNTAPPD_SESSION_COOKIE`, `WEBSHARE_PROXY`, `ADMIN_TELEGRAM_ID`,
  `ADMIN_API_TOKEN`): missing → a feature silently disables, no signal.

The failure class: an **expected-in-prod optional key silently goes missing**,
typically via a manual full-file rewrite of `.env` that drops a line. Two gaps:
1. nothing makes the silent disable visible;
2. nothing structurally prevents the lossy manual rewrite.

## Goals / non-goals

- **Goal:** make a missing expected-optional key visible at startup (catch).
- **Goal:** give operators a safe, additive way to edit `.env` (prevent).
- **Goal:** a single checked-in source of truth for the key list.
- **Non-goal:** making optional keys required / failing startup on their absence —
  a missing admin id must not take the bot down. Required keys keep failing via zod.
- **Non-goal:** deploy-time preflight (startup-warn already catches; avoids
  deploy.sh/sudoers coupling).

## Design

### 1. Expected-keys source of truth — `src/config/env.ts`

Add an exported, typed list of optional-but-expected-in-prod keys with the feature
each gates, and a pure helper:

```ts
export const EXPECTED_PROD_KEYS = [
  { key: 'UNTAPPD_SESSION_COOKIE', disables: 'Untappd profile scraping (had-list / ratings refresh)' },
  { key: 'WEBSHARE_PROXY',          disables: 'proxied Untappd traffic (block protection)' },
  { key: 'ADMIN_TELEGRAM_ID',       disables: 'daily status digest + admin alerts' },
  { key: 'ADMIN_API_TOKEN',         disables: 'admin HTTP endpoints (enrich-failures review)' },
] as const satisfies ReadonlyArray<{ key: keyof Env; disables: string }>;

// Expected keys that are unset or empty-string in the parsed env.
export function missingExpectedKeys(env: Env): { key: string; disables: string }[] {
  return EXPECTED_PROD_KEYS
    .filter(({ key }) => env[key] === undefined || env[key] === '')
    .map(({ key, disables }) => ({ key, disables }));
}
```

Empty string counts as missing (a `KEY=` line with no value). Required keys are not
in this list — their absence still throws in `Schema.parse()` as today.

### 2. Startup warn — `src/index.ts`

Immediately after the logger is constructed (so the warning is itself logged),
emit one `warn` per missing expected key:

```ts
for (const { key, disables } of missingExpectedKeys(env)) {
  log.warn({ key }, `env ${key} unset — ${disables} disabled`);
}
```

Visible at the default `LOG_LEVEL=info`. This is the "defence-in-depth" follow-up;
it would have surfaced the 2026-06-27 incident on the first restart.

### 3. Safe-edit helper — `scripts/set-env.sh`

A dependency-free **bash** script (NOT tsx — `npm prune --omit=dev` removes tsx
from `/opt`, so a tsx tool can't run in prod). Idempotent single-key upsert that
preserves every other line:

- Usage: `scripts/set-env.sh <KEY> <VALUE> <FILE>` (FILE explicit — no implicit
  prod path, to avoid accidents).
- Validates `KEY` matches `^[A-Z_][A-Z0-9_]*$`; errors on missing args.
- Backs up `FILE` to `FILE.bak.<UTC-timestamp>` before writing.
- If a `^KEY=` line exists, replace exactly that line; else append `KEY=VALUE`
  with a guaranteed preceding newline. All other lines preserved byte-for-byte.
- Value is written literally (handles `=`, spaces, parens, `/`); implemented by
  rewriting via a temp file with awk using an exact key match (not `sed` with a
  value-derived pattern), then `mv` over the original.

Run in prod as the bot user: `sudo -n -u warsaw-beer-bot bash -lc
'/opt/warsaw-beer-bot/scripts/set-env.sh KEY VALUE /etc/warsaw-beer-bot/.env'`.

### 4. `.env.example` (repo root)

Keys-only, no secret values, grouped **required** vs **optional**, with a comment
per optional key naming what it disables. Canonical reference to diff a live `.env`
against. Mirrors the schema; the `EXPECTED_PROD_KEYS` list is the machine-checked
half, `.env.example` the human half.

### 5. Docs

- `deploy/README.md`: edit prod `.env` only via `scripts/set-env.sh` (additive
  upsert) — never hand-rewrite; the bot warns on startup for missing expected keys;
  `.env.example` is the key list.
- `spec.md` §5.6 (Конфігурація і секрети): note required-keys-fail /
  expected-optional-keys-warn, and the safe-edit helper.

## Testing

- `src/config/env.test.ts`: `missingExpectedKeys` returns the full set when all
  four are absent; empty set when all present; treats `''` as missing; required
  keys never appear.
- `scripts/set-env.test.ts` (exec the bash script on a temp file, like
  `scripts/github-env-multiline.test.ts`): upsert replaces an existing key in place;
  append adds a new key; all other lines preserved; a `.bak.*` backup is created;
  a value containing `=`, spaces and parens round-trips exactly (and is still
  parseable by reading back `^KEY=` via cut).

## Out of scope

- No deploy-time preflight, no change to `deploy.sh`/sudoers.
- No change to which keys are required vs optional.
- The prod `.env` already had `ADMIN_TELEGRAM_ID` restored manually (this session);
  this work prevents recurrence, it is not the incident hotfix.
