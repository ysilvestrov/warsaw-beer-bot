# Config robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a missing expected-in-prod optional env key visible at startup (loud `warn`), and give operators a safe additive `.env` editor so a manual edit can't silently drop a key.

**Architecture:** A single `EXPECTED_PROD_KEYS` list + `missingExpectedKeys()` helper in `src/config/env.ts` (source of truth), consumed by a startup `log.warn` loop in `src/index.ts`. A dependency-free bash `scripts/set-env.sh` does idempotent single-key upsert. A keys-only `.env.example` mirrors the schema.

**Tech Stack:** TypeScript (CommonJS), Zod, Vitest, Bash.

**Design spec:** `docs/superpowers/specs/2026-06-27-config-robustness-design.md`

---

## File Structure

- **Modify** `src/config/env.ts` — add `EXPECTED_PROD_KEYS` + `missingExpectedKeys(env)`.
- **Modify** `src/config/env.test.ts` — tests for `missingExpectedKeys`.
- **Modify** `src/index.ts` — startup `warn` loop for missing expected keys.
- **Create** `scripts/set-env.sh` — idempotent single-key upsert (bash).
- **Create** `scripts/set-env.test.ts` — exec-based tests for the script.
- **Create** `.env.example` — keys-only canonical reference.
- **Modify** `deploy/README.md` + `spec.md` §5.6 — document warn policy + safe editor.

Reference — current `src/config/env.ts` ends with:
```ts
export type Env = z.infer<typeof Schema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Schema.parse(source);
}
```
Optional keys in the schema: `UNTAPPD_SESSION_COOKIE`, `WEBSHARE_PROXY`, `ADMIN_TELEGRAM_ID`, `ADMIN_API_TOKEN`.

---

## Task 1: `EXPECTED_PROD_KEYS` + `missingExpectedKeys`

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/config/env.test.ts` (it already imports from `./env`; extend the import to include `missingExpectedKeys` and `EXPECTED_PROD_KEYS`, and add a `loadEnv`-based helper for a full valid base env). Append:

```ts
import { missingExpectedKeys, EXPECTED_PROD_KEYS, loadEnv } from './env';

describe('missingExpectedKeys', () => {
  // Minimal valid required env; optional keys added per-case.
  const base = {
    TELEGRAM_BOT_TOKEN: 'x'.repeat(10),
    DATABASE_PATH: '/tmp/bot.db',
    OSRM_BASE_URL: 'http://localhost:5000',
    NOMINATIM_USER_AGENT: 'test-agent',
  };

  test('reports all four expected keys when none set', () => {
    const env = loadEnv({ ...base });
    expect(missingExpectedKeys(env).map((m) => m.key).sort()).toEqual(
      ['ADMIN_API_TOKEN', 'ADMIN_TELEGRAM_ID', 'UNTAPPD_SESSION_COOKIE', 'WEBSHARE_PROXY'],
    );
  });

  test('empty array when all expected keys present', () => {
    const env = loadEnv({
      ...base,
      UNTAPPD_SESSION_COOKIE: 'c', WEBSHARE_PROXY: 'p',
      ADMIN_TELEGRAM_ID: '207079110', ADMIN_API_TOKEN: 't',
    });
    expect(missingExpectedKeys(env)).toEqual([]);
  });

  test('treats empty string as missing', () => {
    const env = loadEnv({ ...base, ADMIN_TELEGRAM_ID: '' });
    expect(missingExpectedKeys(env).map((m) => m.key)).toContain('ADMIN_TELEGRAM_ID');
  });

  test('each entry carries a non-empty disables description', () => {
    for (const e of EXPECTED_PROD_KEYS) expect(e.disables.length).toBeGreaterThan(0);
  });

  test('only optional keys are expected (no required key listed)', () => {
    const keys = EXPECTED_PROD_KEYS.map((e) => e.key);
    expect(keys).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(keys).not.toContain('DATABASE_PATH');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/env.test.ts -t "missingExpectedKeys"`
Expected: FAIL — `missingExpectedKeys` / `EXPECTED_PROD_KEYS` not exported.

- [ ] **Step 3: Implement in `src/config/env.ts`**

Insert before `export function loadEnv` (after the `export type Env = ...` line):

```ts
// Optional keys that are expected to be set in production. Missing ones do NOT
// fail startup (unlike the required schema keys) — they only warn — because each
// merely disables a feature. Single source of truth for the startup warning and
// docs. Keep in sync with .env.example.
export const EXPECTED_PROD_KEYS = [
  { key: 'UNTAPPD_SESSION_COOKIE', disables: 'Untappd profile scraping (had-list / ratings refresh)' },
  { key: 'WEBSHARE_PROXY', disables: 'proxied Untappd traffic (block protection)' },
  { key: 'ADMIN_TELEGRAM_ID', disables: 'daily status digest + admin alerts' },
  { key: 'ADMIN_API_TOKEN', disables: 'admin HTTP endpoints (enrich-failures review)' },
] as const satisfies ReadonlyArray<{ key: keyof Env; disables: string }>;

// Expected keys that are unset or empty-string in the parsed env.
export function missingExpectedKeys(env: Env): { key: string; disables: string }[] {
  return EXPECTED_PROD_KEYS
    .filter(({ key }) => env[key] === undefined || env[key] === '')
    .map(({ key, disables }) => ({ key, disables }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS (new + existing env tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(config): EXPECTED_PROD_KEYS + missingExpectedKeys helper"
```

---

## Task 2: Startup warn in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (import + warn loop after logger creation, near `const log = pino({ level: env.LOG_LEVEL });` at L45)

- [ ] **Step 1: Implement the warn loop**

In `src/index.ts`, extend the env import to include `missingExpectedKeys`. The current import is:
```ts
import { loadEnv } from './config/env';
```
Change to:
```ts
import { loadEnv, missingExpectedKeys } from './config/env';
```
Then immediately after `const log = pino({ level: env.LOG_LEVEL });` (L45), add:
```ts
  for (const { key, disables } of missingExpectedKeys(env)) {
    log.warn({ key }, `env ${key} unset — ${disables} disabled`);
  }
```

(No standalone unit test for this wiring — it is a trivial loop over the
Task-1-tested helper. Task 4's `npm run build` + Task 5 full suite cover compilation.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(config): warn at startup for missing expected env keys"
```

---

## Task 3: Safe-edit helper `scripts/set-env.sh`

**Files:**
- Create: `scripts/set-env.sh`
- Test: `scripts/set-env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/set-env.test.ts` (exec the script on temp files, mirroring `scripts/github-env-multiline.test.ts`):

```ts
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'set-env.sh');

function run(file: string, key: string, value: string) {
  execFileSync('bash', [SCRIPT, key, value, file], { stdio: 'pipe' });
}

function freshFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'setenv-'));
  const f = join(dir, '.env');
  writeFileSync(f, contents);
  return f;
}

describe('set-env.sh', () => {
  test('replaces an existing key in place, preserving other lines', () => {
    const f = freshFile('A=1\nADMIN_TELEGRAM_ID=old\nB=2\n');
    run(f, 'ADMIN_TELEGRAM_ID', '207079110');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nADMIN_TELEGRAM_ID=207079110\nB=2\n');
  });

  test('appends a new key when absent', () => {
    const f = freshFile('A=1\nB=2\n');
    run(f, 'WEBSHARE_PROXY', 'user:pass@host:1080');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=2\nWEBSHARE_PROXY=user:pass@host:1080\n');
  });

  test('appends a guaranteed newline when file lacks a trailing one', () => {
    const f = freshFile('A=1');
    run(f, 'B', '2');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=2\n');
  });

  test('writes a value with =, spaces and parens literally, round-trips via cut', () => {
    const f = freshFile('X=1\n');
    const val = 'warsaw-beer-bot (yuriy@silvestrov.com) a=b';
    run(f, 'NOMINATIM_USER_AGENT', val);
    const line = readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('NOMINATIM_USER_AGENT='))!;
    expect(line.slice('NOMINATIM_USER_AGENT='.length)).toBe(val);
  });

  test('creates a timestamped backup', () => {
    const f = freshFile('A=1\n');
    run(f, 'A', '2');
    const dir = join(f, '..');
    const baks = readdirSync(dir).filter((n) => n.startsWith('.env.bak.'));
    expect(baks.length).toBe(1);
  });

  test('rejects an invalid key name', () => {
    const f = freshFile('A=1\n');
    expect(() => run(f, 'bad-key', 'x')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/set-env.test.ts`
Expected: FAIL — `set-env.sh` does not exist.

- [ ] **Step 3: Write the script `scripts/set-env.sh`**

```bash
#!/usr/bin/env bash
# Idempotent single-key upsert for a dotenv file, preserving all other lines.
# Usage: set-env.sh <KEY> <VALUE> <FILE>
# - replaces an existing `^KEY=` line, else appends `KEY=VALUE`
# - backs up FILE to FILE.bak.<UTC timestamp> before writing
# - VALUE is written literally (safe for =, spaces, parens, slashes)
set -euo pipefail

KEY=${1:-}
VALUE=${2:-}
FILE=${3:-}

if [ -z "$KEY" ] || [ -z "$FILE" ] || [ "$#" -lt 3 ]; then
  echo "usage: set-env.sh <KEY> <VALUE> <FILE>" >&2
  exit 2
fi
if ! printf '%s' "$KEY" | grep -qE '^[A-Z_][A-Z0-9_]*$'; then
  echo "invalid key: $KEY (must match ^[A-Z_][A-Z0-9_]*$)" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "no such file: $FILE" >&2
  exit 2
fi

cp -a "$FILE" "${FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"

tmp=$(mktemp)
# Rewrite: replace the KEY line if present (exact key match via awk, value passed
# as a variable so no regex/delimiter issues), tracking whether we replaced it.
KEY="$KEY" VALUE="$VALUE" awk '
  BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
  {
    # match a line beginning with optional spaces, KEY, optional spaces, =
    if (!done && $0 ~ ("^[ \t]*" k "[ \t]*=")) { print k "=" v; done = 1 }
    else { print }
  }
  END { if (!done) print k "=" v }
' "$FILE" > "$tmp"

mv "$tmp" "$FILE"
```

Then make it executable:
```bash
chmod +x scripts/set-env.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/set-env.test.ts`
Expected: PASS (6 tests).

Note on the awk key match: `k` is a fixed uppercase identifier (validated by the
`^[A-Z_][A-Z0-9_]*$` check), so it contains no awk-regex metacharacters — the
`"^[ \t]*" k "[ \t]*="` pattern is safe.

- [ ] **Step 5: Commit**

```bash
git add scripts/set-env.sh scripts/set-env.test.ts
git commit -m "feat(scripts): set-env.sh idempotent dotenv upsert"
```

---

## Task 4: `.env.example`

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Create the file**

Create `.env.example` at repo root (keys only, no real secrets):

```bash
# Warsaw Beer Bot — environment keys. Copy to your env file and fill values.
# Required (bot refuses to start if any is missing):
TELEGRAM_BOT_TOKEN=
DATABASE_PATH=
OSRM_BASE_URL=
NOMINATIM_USER_AGENT=

# Tuning (have safe defaults; override only if needed):
LOG_LEVEL=info
DEFAULT_ROUTE_N=5
API_PORT=3000
SNAPSHOT_RETENTION_DAYS=14
UNTAPPD_LOOKUP_ENABLED=true
UNTAPPD_BLOCK_THRESHOLD=3

# Optional but expected in prod (missing → the bot WARNs at startup and the
# named feature is disabled). Edit additively via scripts/set-env.sh.
UNTAPPD_SESSION_COOKIE=   # Untappd profile scraping (had-list / ratings refresh)
WEBSHARE_PROXY=           # proxied Untappd traffic (block protection)
ADMIN_TELEGRAM_ID=        # daily status digest + admin alerts
ADMIN_API_TOKEN=          # admin HTTP endpoints (enrich-failures review)
```

- [ ] **Step 2: Verify it lists every schema key**

Run: `for k in TELEGRAM_BOT_TOKEN DATABASE_PATH OSRM_BASE_URL NOMINATIM_USER_AGENT LOG_LEVEL DEFAULT_ROUTE_N API_PORT SNAPSHOT_RETENTION_DAYS UNTAPPD_LOOKUP_ENABLED UNTAPPD_SESSION_COOKIE WEBSHARE_PROXY UNTAPPD_BLOCK_THRESHOLD ADMIN_TELEGRAM_ID ADMIN_API_TOKEN; do grep -q "^$k=" .env.example || echo "MISSING: $k"; done; echo done`
Expected: prints only `done` (no MISSING lines).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add .env.example key reference"
```

---

## Task 5: Docs — `deploy/README.md` + `spec.md`

**Files:**
- Modify: `deploy/README.md`
- Modify: `spec.md` (§5.6 Конфігурація і секрети)

- [ ] **Step 1: Append an env-editing note to `deploy/README.md`**

Add this section at the end of `deploy/README.md`:

```markdown
## Editing the prod `.env` safely

Edit `/etc/warsaw-beer-bot/.env` **additively** — never hand-rewrite the whole
file (that risks silently dropping a key, e.g. the 2026-06-27 `ADMIN_TELEGRAM_ID`
incident). Use the upsert helper, which backs up first and preserves every other
line:

```bash
sudo -n -u warsaw-beer-bot bash -lc \
  '/opt/warsaw-beer-bot/scripts/set-env.sh ADMIN_TELEGRAM_ID 207079110 /etc/warsaw-beer-bot/.env'
sudo -n systemctl restart warsaw-beer-bot
```

`.env.example` (repo root) lists every key. On startup the bot logs a `warn` for
any expected-but-unset optional key, so a dropped key is visible in
`journalctl -u warsaw-beer-bot`.
```

- [ ] **Step 2: Add a note to `spec.md` §5.6**

In `spec.md`, find the §5.6 "Конфігурація і секрети" section and append a bullet:

```markdown
- **Env-валідація.** Обовʼязкові ключі (`TELEGRAM_BOT_TOKEN`, `DATABASE_PATH`,
  `OSRM_BASE_URL`, `NOMINATIM_USER_AGENT`) валідуються zod-схемою і **валять старт**,
  якщо відсутні. Опційні-але-очікувані-в-проді ключі (`UNTAPPD_SESSION_COOKIE`,
  `WEBSHARE_PROXY`, `ADMIN_TELEGRAM_ID`, `ADMIN_API_TOKEN`) НЕ валять старт — бот
  лише пише `warn` на старті (`missingExpectedKeys`), бо кожен лише вимикає фічу.
  Прод-`.env` редагувати тільки через `scripts/set-env.sh` (additive upsert).
```

- [ ] **Step 3: Verify edits landed**

Run: `grep -n "set-env.sh" deploy/README.md && grep -n "missingExpectedKeys\|Env-валідація" spec.md`
Expected: matches in both files.

- [ ] **Step 4: Commit**

```bash
git add deploy/README.md spec.md
git commit -m "docs: document env warn policy + safe-edit helper"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all pass, including `env.test.ts` and `scripts/set-env.test.ts`.

- [ ] **Step 2: Typecheck + build (proves index.ts wiring compiles)**

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 3: Acceptance checklist**

- [ ] Missing expected key → startup `warn` (Task 2), via the Task-1 helper.
- [ ] Required keys still fail startup via zod (unchanged).
- [ ] `scripts/set-env.sh` upserts without dropping other keys + backs up (Task 3).
- [ ] `.env.example` lists every schema key (Task 4 Step 2).
- [ ] Docs updated (Task 5).

---

## Self-Review Notes

- **Spec coverage:** source-of-truth list + helper (T1), startup warn (T2), safe-edit bash helper (T3), `.env.example` (T4), docs incl. spec.md §5.6 (T5), verification (T6). All spec sections mapped.
- **Non-goals respected:** optional keys warn (not fail); required keys unchanged; no deploy.sh/sudoers change; tsx avoided in favor of bash for the prod-runnable helper.
- **Type consistency:** `EXPECTED_PROD_KEYS` (`{key: keyof Env; disables: string}` via `satisfies`) and `missingExpectedKeys(env: Env): {key:string; disables:string}[]` defined in T1, consumed identically in T2. `set-env.sh <KEY> <VALUE> <FILE>` arg order consistent between T3 script, its test, and the T5 docs.
