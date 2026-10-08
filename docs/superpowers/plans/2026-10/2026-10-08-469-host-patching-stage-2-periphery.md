# #469 Stage 2 periphery — upstream facts, wiring, host install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daily status's Інфраструктура row reports the host's patch state and the upstream facts it is judged against. The root collector from the core runs hourly on the host.

**Architecture:**
- **Upstream facts.** These are the newest Node 24 security release, the Node 24 end of life, and the latest litestream release. A daily bot job fetches them into `job_state`, so the synchronous morning report only reads them, as it already does with the search canary.
- **Upstream rules.** A pure function next to the core's `hostPatchFindings`.
- **Wiring.** `collectStatusInputs` reads the host summary and the stored upstream facts. `evaluateInfra` merges both, including when the disk summary is unreadable.
- **Host side.** A oneshot unit, an hourly timer and a root installer.

**Tech Stack:** TypeScript, zod, Vitest, bash, systemd.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md` — Stage 2, claims C7–C9 and C15–C20.

**Core (merged, PR #802):**
- `scripts/ops/host_patch_collect.py`;
- `src/jobs/host-patch.ts` (`readHostPatch`, `HostPatchRead`);
- `src/jobs/hardened-json.ts`;
- `src/domain/status/host-patch.ts` (`hostPatchFindings`, `HostFinding`, `WATCHED_UNITS`);
- `HostPatchFacts` in `src/domain/status/types.ts`.

## Global Constraints

- Upstream URLs, exactly:
  - `https://nodejs.org/dist/index.json`
  - `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`
  - `https://api.github.com/repos/benbjohnson/litestream/releases/latest`
- Plain global `fetch` with `AbortSignal.timeout`, like `src/sources/cws-version.ts`. No undici dispatcher.
- Upstream facts live in `job_state` under key `host_upstream`. A source is refreshed when its last success is ≥ 20 h old, and retried hourly on failure. The status treats a source older than 48 h as `нема даних`.
- Rules (spec):
  - Node security: the newest 24.x release with `security: true` is newer than the installed `nodejs` → 🔴 when that release is > 3 calendar days old.
  - Node 24 `end`: 🟡 < 180 days, 🔴 < 30 days. Computed even when the host summary is unreadable.
  - litestream: latest is newer than installed → 🟡 when it was published > 30 calendar days ago.
- Versions compare numerically on dotted segments (`compareVersions` from `src/sources/cws-version.ts`). Installed Debian versions are reduced to their upstream part: epoch and `-revision` are dropped, so `24.21.0-1nodesource1` → `24.21.0`. Upstream `v`-prefixed tags drop the `v`.
- Calendar days are UTC, counted from today, so the date itself is day 0. Use the core's helper (Task 2 exports it).
- The reader's result maps to report text: `stale` → `збирач патчів мовчить`, `unavailable` → `підсумок патчів хоста недоступний`.
- The unit and timer:
  - `wbb-host-patch.service`: `Type=oneshot`, `TimeoutStartSec=15min`. **No** `PrivateTmp`, `NoNewPrivileges` or `ProtectSystem`: the snap CLI and the bot's view of `/var/tmp` need neither.
  - `wbb-host-patch.timer`: `OnActiveSec=2min`, `OnUnitActiveSec=1h`, **no** `OnBootSec` and **no** `Persistent` (#798).
- The collector installs to `/usr/local/libexec/wbb-host-patch-collect`. The installer creates `/var/tmp/wbb-host-patch` as root `0755`, and refuses a pre-existing path that is a symlink, not a directory, or not root-owned. A refused run changes nothing.
- The PR is `[deploy:hold]` + label `deploy:hold`: `deploy/*.service|*.timer` and `deploy/install-*.sh` are hold paths. Host steps:
  1. run the installer;
  2. confirm the first summary has a non-null `livepatch`;
  3. only then `bash deploy/deploy.sh`.
- Tests run via `npm test -- <files>`; the full gate per task is `npm test && npm run typecheck`. CLAUDE.md test rules apply: exact asserts, no conditionals, no expected values recomputed by the code under test.

Fixtures, committed with this plan in `tests/fixtures/host-upstream/` (provenance in its `README.md`): `node-index.json`, `node-schedule.json`, `litestream-latest.json`. All are real captures from 2026-10-08, trimmed. They contain:
- the newest v24 security release, `24.18.1` of `2026-07-28`;
- v24 `end` = `2028-04-30`;
- litestream `v0.5.17`, published `2026-08-31T21:59:32Z`.

**Expected on first deploy:** the host has litestream `0.5.11`, so the report will carry 🟡 `litestream 0.5.11 < 0.5.17 (вийшов 2026-08-31)`. That is a real finding, not noise. It goes in the PR body.

---

### Task 1: Upstream sources and the daily job

**Files:**
- Modify: `src/domain/status/types.ts` (add `HostUpstream`)
- Create: `src/sources/host-upstream.ts`
- Create: `src/sources/host-upstream.test.ts`
- Create: `src/jobs/host-upstream.ts`
- Create: `src/jobs/host-upstream.test.ts`

**Interfaces:**
- Produces:
  - `HostUpstream` (types.ts);
  - `parseNodeSecurity(json: unknown): { version: string; date: string } | null`;
  - `parseNodeEnd(json: unknown): string`;
  - `parseLitestreamLatest(json: unknown): { version: string; publishedAt: string }`;
  - `hostUpstream(deps: HostUpstreamDeps): Promise<void>`;
  - `readHostUpstream(db: DB, now: Date): HostUpstream`;
  - `HOST_UPSTREAM_KEY = 'host_upstream'`.
- Task 3 wires `hostUpstream` into `src/index.ts` and `readHostUpstream` into `collectStatusInputs`.

- [ ] **Step 1: Add the type**

Append to `src/domain/status/types.ts`:

```ts
// Upstream facts the host is judged against (#469 stage 2), fetched daily by jobs/host-upstream.
// Each source is its own Avail: one failing fetch must not blank the others.
export interface HostUpstream {
  nodeSecurity: Avail<{ version: string; date: string } | null>; // null = the 24.x line has no security release
  nodeEnd: Avail<string>;                                       // YYYY-MM-DD
  litestream: Avail<{ version: string; publishedAt: string }>;  // publishedAt: ISO instant
}
```

- [ ] **Step 2: Write the failing parser tests**

`src/sources/host-upstream.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLitestreamLatest, parseNodeEnd, parseNodeSecurity } from './host-upstream';

/** #469 stage 2 — fixtures captured 2026-10-08 (tests/fixtures/host-upstream/README.md). */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures/host-upstream', name), 'utf8'));

describe('parseNodeSecurity', () => {
  it('picks the newest v24 security release, not v26 or v22', () => {
    expect(parseNodeSecurity(fixture('node-index.json'))).toEqual({ version: '24.18.1', date: '2026-07-28' });
  });
  it('orders by version, not by array position', () => {
    expect(parseNodeSecurity([
      { version: 'v24.17.0', date: '2026-06-17', security: true },
      { version: 'v24.18.1', date: '2026-07-28', security: true },
    ])).toEqual({ version: '24.18.1', date: '2026-07-28' });
  });
  it('is null when the 24.x line has no security release', () => {
    expect(parseNodeSecurity([{ version: 'v24.21.0', date: '2026-09-07', security: false }])).toBe(null);
  });
  it.each([
    ['not an array', {}],
    ['no 24.x release at all', [{ version: 'v26.11.1', date: '2026-10-01', security: true }]],
    ['a malformed security version', [{ version: 'v24.18', date: '2026-07-28', security: true }]],
    ['a malformed date', [{ version: 'v24.18.1', date: '28.07.2026', security: true }]],
  ])('throws on %s', (_what, json) => {
    expect(() => parseNodeSecurity(json)).toThrow();
  });
});

describe('parseNodeEnd', () => {
  it('reads v24.end', () => {
    expect(parseNodeEnd(fixture('node-schedule.json'))).toBe('2028-04-30');
  });
  it.each([
    ['no v24 key', { v26: { end: '2029-04-30' } }],
    ['a malformed end', { v24: { end: 'April 2028' } }],
    ['not an object', []],
  ])('throws on %s', (_what, json) => {
    expect(() => parseNodeEnd(json)).toThrow();
  });
});

describe('parseLitestreamLatest', () => {
  it('reads the tag without its v and the publish instant', () => {
    expect(parseLitestreamLatest(fixture('litestream-latest.json')))
      .toEqual({ version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' });
  });
  it.each([
    ['a prerelease', { tag_name: 'v0.6.0-rc1', published_at: '2026-09-01T00:00:00Z', prerelease: true, draft: false }],
    ['a draft', { tag_name: 'v0.6.0', published_at: '2026-09-01T00:00:00Z', prerelease: false, draft: true }],
    ['a non-semver tag', { tag_name: 'nightly', published_at: '2026-09-01T00:00:00Z', prerelease: false, draft: false }],
    ['a bad instant', { tag_name: 'v0.6.0', published_at: 'yesterday', prerelease: false, draft: false }],
  ])('throws on %s', (_what, json) => {
    expect(() => parseLitestreamLatest(json)).toThrow();
  });
});
```

Run: `npm test -- src/sources/host-upstream.test.ts`
Expected: FAIL, `Cannot find module './host-upstream'`.

- [ ] **Step 3: Implement the parsers and fetchers**

`src/sources/host-upstream.ts`:

```ts
// Upstream facts for the host-patch traffic light (#469 stage 2): what the Node 24 line and
// litestream have published. Public JSON, no credentials — plain fetch, like ./cws-version.
// Parsers throw on any shape they do not understand: a guessed value would read as healthy.
import { compareVersions } from './cws-version';
import { parseIsoInstant } from '../domain/status/helpers';

export const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
export const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
export const LITESTREAM_LATEST_URL = 'https://api.github.com/repos/benbjohnson/litestream/releases/latest';
const NODE_MAJOR = 24;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^v(\d+\.\d+\.\d+)$/;
type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Newest v24.* release flagged `security`, or null when the line has none. */
export function parseNodeSecurity(json: unknown): { version: string; date: string } | null {
  if (!Array.isArray(json)) throw new Error('node index: not an array');
  const line = json.filter((r): r is Rec => isRec(r) && typeof r.version === 'string'
    && r.version.startsWith(`v${NODE_MAJOR}.`));
  if (line.length === 0) throw new Error(`node index: no v${NODE_MAJOR}.x release`);
  let best: { version: string; date: string } | null = null;
  for (const r of line.filter((x) => x.security === true)) {
    const version = TAG.exec(String(r.version))?.[1];
    if (version === undefined || typeof r.date !== 'string' || !DAY.test(r.date)) {
      throw new Error(`node index: malformed security release ${String(r.version)}`);
    }
    if (best === null || compareVersions(version, best.version) > 0) best = { version, date: r.date };
  }
  return best;
}

/** `v24.end` of the release schedule, YYYY-MM-DD. */
export function parseNodeEnd(json: unknown): string {
  const line = isRec(json) ? json[`v${NODE_MAJOR}`] : undefined;
  const end = isRec(line) ? line.end : undefined;
  if (typeof end !== 'string' || !DAY.test(end)) throw new Error(`node schedule: no v${NODE_MAJOR}.end`);
  return end;
}

/** The latest litestream release: the tag without its `v`, and its publish instant. */
export function parseLitestreamLatest(json: unknown): { version: string; publishedAt: string } {
  if (!isRec(json) || json.draft !== false || json.prerelease !== false) {
    throw new Error('litestream latest: not a published release');
  }
  const version = typeof json.tag_name === 'string' ? TAG.exec(json.tag_name)?.[1] : undefined;
  const at = json.published_at;
  if (version === undefined || typeof at !== 'string' || !Number.isFinite(parseIsoInstant(at))) {
    throw new Error('litestream latest: malformed tag or published_at');
  }
  return { version, publishedAt: at };
}

export type FetchJson = (url: string) => Promise<unknown>;

/** GET a public JSON document; throws on a non-2xx, a timeout or a body that is not JSON. */
export function jsonFetcher(fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): FetchJson {
  return async (url) => {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // GitHub's API rejects requests without a User-Agent.
      headers: { 'User-Agent': 'warsaw-beer-bot', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
}
```

Run: `npm test -- src/sources/host-upstream.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 4: Write the failing job tests**

`src/jobs/host-upstream.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../storage/db';
import { getJobState, setJobState } from '../storage/job_state';
import { HOST_UPSTREAM_KEY, hostUpstream, readHostUpstream } from './host-upstream';
import { LITESTREAM_LATEST_URL, NODE_INDEX_URL, NODE_SCHEDULE_URL } from '../sources/host-upstream';

/** #469 stage 2 — fixtures captured 2026-10-08. */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures/host-upstream', name), 'utf8'));
const log = pino({ level: 'silent' });
const NOW = new Date('2026-10-08T06:50:00.000Z');
const HOUR = 3_600_000;

const ALL: Record<string, unknown> = {
  [NODE_INDEX_URL]: fixture('node-index.json'),
  [NODE_SCHEDULE_URL]: fixture('node-schedule.json'),
  [LITESTREAM_LATEST_URL]: fixture('litestream-latest.json'),
};
/** A fetcher serving `table`; a URL mapped to an Error throws it. It records each URL it was asked for. */
function fetcher(table: Record<string, unknown>, asked: string[] = []) {
  return async (url: string): Promise<unknown> => {
    asked.push(url);
    const out = table[url];
    if (out instanceof Error) throw out;
    return out;
  };
}

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const FRESH = {
  nodeSecurity: { ok: true, value: { version: '24.18.1', date: '2026-07-28' } },
  nodeEnd: { ok: true, value: '2028-04-30' },
  litestream: { ok: true, value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' } },
};

describe('hostUpstream + readHostUpstream', () => {
  it('stores all three sources and reads them back', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    expect(readHostUpstream(db, NOW)).toEqual(FRESH);
  });

  it('a failing source keeps its previous value and leaves the others fresh', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    const later = new Date(NOW.getTime() + 21 * HOUR);
    await hostUpstream({ db, log, now: () => later,
      fetchJson: fetcher({ ...ALL, [LITESTREAM_LATEST_URL]: new Error('HTTP 503') }) });
    expect(readHostUpstream(db, later)).toEqual(FRESH);
  });

  it('does not refetch a source refreshed less than 20 hours ago', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    const asked: string[] = [];
    await hostUpstream({ db, log, now: () => new Date(NOW.getTime() + 20 * HOUR - 1), fetchJson: fetcher(ALL, asked) });
    expect(asked).toEqual([]);
  });

  it('refetches a source at exactly 20 hours', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    const asked: string[] = [];
    await hostUpstream({ db, log, now: () => new Date(NOW.getTime() + 20 * HOUR), fetchJson: fetcher(ALL, asked) });
    expect(asked).toEqual([NODE_INDEX_URL, NODE_SCHEDULE_URL, LITESTREAM_LATEST_URL]);
  });

  it('a source never fetched is "ще не завантажено"', () => {
    expect(readHostUpstream(db, NOW)).toEqual({
      nodeSecurity: { ok: false, reason: 'безпекові релізи Node ще не завантажено' },
      nodeEnd: { ok: false, reason: 'графік підтримки Node ще не завантажено' },
      litestream: { ok: false, reason: 'релізи litestream ще не завантажено' },
    });
  });

  it('a value older than 48 hours is stale; exactly 48 hours is not', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    expect(readHostUpstream(db, new Date(NOW.getTime() + 48 * HOUR)).nodeEnd).toEqual({ ok: true, value: '2028-04-30' });
    expect(readHostUpstream(db, new Date(NOW.getTime() + 48 * HOUR + 1)).nodeEnd)
      .toEqual({ ok: false, reason: 'графік підтримки Node застарів (понад 48 год)' });
  });

  it('a stored value that does not parse is "пошкоджено", per source', () => {
    setJobState(db, HOST_UPSTREAM_KEY, JSON.stringify({
      nodeEnd: { value: 'April', at: NOW.toISOString() },
      litestream: { value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' }, at: NOW.toISOString() },
    }));
    expect(readHostUpstream(db, NOW)).toEqual({
      nodeSecurity: { ok: false, reason: 'безпекові релізи Node ще не завантажено' },
      nodeEnd: { ok: false, reason: 'графік підтримки Node: збережений стан пошкоджено' },
      litestream: FRESH.litestream,
    });
  });

  it('an unparsable job_state blanks every source but does not throw', () => {
    setJobState(db, HOST_UPSTREAM_KEY, '{');
    expect(readHostUpstream(db, NOW).nodeSecurity)
      .toEqual({ ok: false, reason: 'безпекові релізи Node: збережений стан пошкоджено' });
  });

  it('a timestamp from the future is "пошкоджено", never fresh', () => {
    setJobState(db, HOST_UPSTREAM_KEY, JSON.stringify({
      nodeEnd: { value: '2028-04-30', at: new Date(NOW.getTime() + 2 * 60_000).toISOString() },
    }));
    expect(readHostUpstream(db, NOW).nodeEnd)
      .toEqual({ ok: false, reason: 'графік підтримки Node: збережений стан пошкоджено' });
  });

  it('a "no security release" null survives the round trip', async () => {
    const noSecurity = [{ version: 'v24.21.0', date: '2026-09-07', security: false }];
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher({ ...ALL, [NODE_INDEX_URL]: noSecurity }) });
    expect(readHostUpstream(db, NOW).nodeSecurity).toEqual({ ok: true, value: null });
  });

  it('writes one job_state row', async () => {
    await hostUpstream({ db, log, now: () => NOW, fetchJson: fetcher(ALL) });
    expect(JSON.parse(getJobState(db, HOST_UPSTREAM_KEY)!)).toEqual({
      nodeSecurity: { value: { version: '24.18.1', date: '2026-07-28' }, at: NOW.toISOString() },
      nodeEnd: { value: '2028-04-30', at: NOW.toISOString() },
      litestream: { value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' }, at: NOW.toISOString() },
    });
  });
});
```

Before you run it, check the in-memory DB helper: `grep -rn "export function openDb" src/storage`. If the repo's tests open an in-memory DB some other way (look at `src/jobs/status-inputs.test.ts`), use that and report the deviation. The asserts stay as written.

Run: `npm test -- src/jobs/host-upstream.test.ts`
Expected: FAIL, `Cannot find module './host-upstream'`.

- [ ] **Step 5: Implement the job and its reader**

`src/jobs/host-upstream.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Avail, HostUpstream } from '../domain/status/types';
import { getJobState, setJobState } from '../storage/job_state';
import { parseIsoInstant } from '../domain/status/helpers';
import {
  LITESTREAM_LATEST_URL, NODE_INDEX_URL, NODE_SCHEDULE_URL, jsonFetcher,
  parseLitestreamLatest, parseNodeEnd, parseNodeSecurity, type FetchJson,
} from '../sources/host-upstream';

// #469 stage 2: the upstream facts the host-patch rules compare against. The morning report is
// synchronous, so it never fetches; this job keeps job_state fresh and the report only reads.
export const HOST_UPSTREAM_KEY = 'host_upstream';
const HOUR = 3_600_000;
const REFRESH_MS = 20 * HOUR;   // once a day, with slack for an hourly tick
const STALE_MS = 48 * HOUR;     // two missed days → "нема даних"
const FUTURE_SKEW_MS = 60_000;

type SourceKey = keyof HostUpstream;
// `stale` agrees with `what` in gender and number: «графік … застарів», «релізи … застаріли».
const SOURCES: { key: SourceKey; url: string; parse: (json: unknown) => unknown; what: string; stale: string }[] = [
  { key: 'nodeSecurity', url: NODE_INDEX_URL, parse: parseNodeSecurity, what: 'безпекові релізи Node', stale: 'застаріли' },
  { key: 'nodeEnd', url: NODE_SCHEDULE_URL, parse: parseNodeEnd, what: 'графік підтримки Node', stale: 'застарів' },
  { key: 'litestream', url: LITESTREAM_LATEST_URL, parse: parseLitestreamLatest, what: 'релізи litestream', stale: 'застаріли' },
];
type Stored = Partial<Record<SourceKey, { value: unknown; at: string }>>;

function readStored(db: DB): Stored | undefined {
  const raw = getJobState(db, HOST_UPSTREAM_KEY);
  if (raw === null) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Stored) : undefined;
  } catch {
    return undefined;
  }
}

export interface HostUpstreamDeps {
  db: DB;
  log: pino.Logger;
  now?: () => Date;
  fetchJson?: FetchJson;
}

// Hourly tick: each source is fetched when its last success is ≥ 20 h old; a failure keeps the
// previous value (its own `at` ages it into "нема даних") and is retried on the next tick.
export async function hostUpstream(deps: HostUpstreamDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const fetchJson = deps.fetchJson ?? jsonFetcher();
  const next: Stored = { ...(readStored(deps.db) ?? {}) };
  for (const s of SOURCES) {
    const at = next[s.key] ? parseIsoInstant(next[s.key]!.at) : Number.NaN;
    if (Number.isFinite(at) && now.getTime() - at < REFRESH_MS) continue;
    try {
      next[s.key] = { value: s.parse(await fetchJson(s.url)), at: now.toISOString() };
    } catch (e) {
      deps.log.warn({ err: e, url: s.url }, 'host-upstream: fetch failed, keeping the previous value');
    }
  }
  setJobState(deps.db, HOST_UPSTREAM_KEY, JSON.stringify(next));
}

// Each source is validated again on read by its own parser's output shape: a stored value is a
// claim, and a corrupted one must read as "нема даних", never as healthy.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VER = /^\d+\.\d+\.\d+$/;
const VALID: Record<SourceKey, (v: unknown) => boolean> = {
  nodeSecurity: (v) => v === null || (typeof v === 'object' && v !== null
    && VER.test(String((v as Record<string, unknown>).version)) && DAY.test(String((v as Record<string, unknown>).date))),
  nodeEnd: (v) => typeof v === 'string' && DAY.test(v),
  litestream: (v) => typeof v === 'object' && v !== null
    && VER.test(String((v as Record<string, unknown>).version))
    && Number.isFinite(parseIsoInstant(String((v as Record<string, unknown>).publishedAt))),
};

export function readHostUpstream(db: DB, now: Date): HostUpstream {
  const stored = readStored(db);
  const one = <K extends SourceKey>(key: K): HostUpstream[K] => {
    const { what, stale } = SOURCES.find((s) => s.key === key)!;
    if (stored === undefined) return { ok: false, reason: `${what}: збережений стан пошкоджено` } as HostUpstream[K];
    const entry = stored[key];
    if (entry === undefined) return { ok: false, reason: `${what} ще не завантажено` } as HostUpstream[K];
    const at = typeof entry === 'object' && entry !== null ? parseIsoInstant(String(entry.at)) : Number.NaN;
    if (!Number.isFinite(at) || at > now.getTime() + FUTURE_SKEW_MS || !VALID[key](entry.value)) {
      return { ok: false, reason: `${what}: збережений стан пошкоджено` } as HostUpstream[K];
    }
    if (now.getTime() - at > STALE_MS) return { ok: false, reason: `${what} ${stale} (понад 48 год)` } as HostUpstream[K];
    return { ok: true, value: entry.value } as Avail<never> as HostUpstream[K];
  };
  return {
    nodeSecurity: one('nodeSecurity'),
    nodeEnd: one('nodeEnd'),
    litestream: one('litestream'),
  };
}
```

Run: `npm test -- src/jobs/host-upstream.test.ts src/sources/host-upstream.test.ts`
Expected: PASS.

Mutation checks. For each, make the change, see the named test fail, then revert:
- `REFRESH_MS = 20 * HOUR + 1` → "refetches a source at exactly 20 hours";
- `now.getTime() - at > STALE_MS` → `>=` → "a value older than 48 hours is stale; exactly 48 hours is not";
- drop `at > now.getTime() + FUTURE_SKEW_MS ||` → "a timestamp from the future…";
- in `hostUpstream`, set `next = {}` instead of spreading the previous value → "a failing source keeps its previous value…".

- [ ] **Step 6: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/domain/status/types.ts src/sources/host-upstream.ts src/sources/host-upstream.test.ts src/jobs/host-upstream.ts src/jobs/host-upstream.test.ts
git commit -m "feat(status): daily upstream facts for host patching — Node 24 security/EOL, litestream releases (#469)"
```

---

### Task 2: Upstream rules

**Files:**
- Modify: `src/domain/status/host-patch.ts` (export the calendar-day helper)
- Modify: `src/domain/status/rules.ts` (two thresholds)
- Create: `src/domain/status/host-upstream.ts`
- Create: `src/domain/status/host-upstream.test.ts`

**Interfaces:**
- Consumes:
  - `HostUpstream` (Task 1);
  - `HostPatchFacts['packages']`, `HostFinding` (core);
  - `compareVersions` (`src/sources/cws-version.ts`).
- Produces:
  - `upstreamFindings(u: HostUpstream, packages: HostPatchFacts['packages'] | null, now: Date): HostFinding[]`;
  - `debianUpstreamVersion(v: string): string | null`.

- [ ] **Step 1: Export the calendar-day helper**

In `src/domain/status/host-patch.ts`, rename `function daysUntil` to `export function calendarDaysUntil` and update its two call sites. Behaviour is unchanged: run `npm test -- src/domain/status/host-patch.test.ts` and expect PASS with no test edits.

- [ ] **Step 2: Write the failing tests**

`src/domain/status/host-upstream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HostPatchFacts, HostUpstream } from './types';
import { debianUpstreamVersion, upstreamFindings } from './host-upstream';

/** #469 stage 2 — spec rules table, upstream rows. Today = 2026-10-08. */
const NOW = new Date('2026-10-08T07:00:00Z');
const PACKAGES: HostPatchFacts['packages'] = { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' };
const UP: HostUpstream = {
  nodeSecurity: { ok: true, value: { version: '24.18.1', date: '2026-07-28' } },
  nodeEnd: { ok: true, value: '2028-04-30' },
  litestream: { ok: true, value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' } },
};
const at = (patch: Partial<HostUpstream>, packages: HostPatchFacts['packages'] | null = PACKAGES, now = NOW) =>
  upstreamFindings({ ...UP, ...patch }, packages, now);

describe('debianUpstreamVersion', () => {
  it.each([
    ['24.21.0-1nodesource1', '24.21.0'],
    ['0.5.11', '0.5.11'],
    ['1:2.39-0ubuntu8.7', '2.39'],
    ['2026.10.0', '2026.10.0'],
  ])('%s → %s', (raw, expected) => {
    expect(debianUpstreamVersion(raw)).toBe(expected);
  });
  it.each(['', 'rc', '-1'])('%j is null', (raw) => {
    expect(debianUpstreamVersion(raw)).toBe(null);
  });
});

describe('upstreamFindings', () => {
  it('is silent on the real host of 2026-10-08 once litestream is current', () => {
    expect(at({})).toEqual([]);
  });

  describe('Node security release', () => {
    const security = (version: string, date: string) => ({ nodeSecurity: { ok: true as const, value: { version, date } } });
    it('a newer security release 4 days old is red', () => {
      expect(at(security('24.22.0', '2026-10-04'))).toEqual([
        { colour: 'red', reason: 'Node 24.21.0 < безпековий 24.22.0 (з 2026-10-04)' }]);
    });
    it('the same release 3 days old is silent (unattended-upgrades has time)', () => {
      expect(at(security('24.22.0', '2026-10-05'))).toEqual([]);
    });
    it('an installed version equal to the security release is silent', () => {
      expect(at(security('24.21.0', '2026-01-01'))).toEqual([]);
    });
    it('compares numerically: 24.9.0 is older than 24.10.0', () => {
      expect(at(security('24.10.0', '2026-01-01'), { ...PACKAGES, nodejs: '24.9.0-1nodesource1' })).toEqual([
        { colour: 'red', reason: 'Node 24.9.0 < безпековий 24.10.0 (з 2026-01-01)' }]);
    });
    it('no security release in the line is silent', () => {
      expect(at({ nodeSecurity: { ok: true, value: null } })).toEqual([]);
    });
    it('an unreadable source is "нема даних"', () => {
      expect(at({ nodeSecurity: { ok: false, reason: 'безпекові релізи Node ще не завантажено' } })).toEqual([
        { colour: 'yellow', reason: 'нема даних: безпекові релізи Node ще не завантажено' }]);
    });
    it('an installed version dpkg could not name is "нема даних"', () => {
      expect(at({}, { ...PACKAGES, nodejs: null })).toEqual([
        { colour: 'yellow', reason: 'нема даних: встановлена версія nodejs' }]);
    });
    it('without a host summary the package rules stay quiet (the host line already says why)', () => {
      expect(at(security('24.22.0', '2026-10-01'), null)).toEqual([]);
    });
  });

  describe('Node 24 end of life', () => {
    const end = (value: string) => ({ nodeEnd: { ok: true as const, value } });
    it('180 days away is silent', () => {
      expect(at(end('2027-04-06'))).toEqual([]);
    });
    it('179 days away is yellow', () => {
      expect(at(end('2027-04-05'))).toEqual([
        { colour: 'yellow', reason: 'Node 24: підтримка до 2027-04-05 — лишилось 179 днів' }]);
    });
    it('30 days away is yellow, 29 is red', () => {
      expect([at(end('2026-11-07'))[0].colour, at(end('2026-11-06'))]).toEqual(['yellow', [
        { colour: 'red', reason: 'Node 24: підтримка до 2026-11-06 — лишилось 29 днів' }]]);
    });
    it('after the end it is red and reported even without a host summary', () => {
      expect(at(end('2026-10-07'), null)).toEqual([
        { colour: 'red', reason: 'Node 24: підтримка до 2026-10-07 — уже минула' }]);
    });
    it('an unreadable schedule is "нема даних"', () => {
      expect(at({ nodeEnd: { ok: false, reason: 'графік підтримки Node застарів (понад 48 год)' } })).toEqual([
        { colour: 'yellow', reason: 'нема даних: графік підтримки Node застарів (понад 48 год)' }]);
    });
  });

  describe('litestream', () => {
    const latest = (version: string, publishedAt: string) =>
      ({ litestream: { ok: true as const, value: { version, publishedAt } } });
    it('the real host: 0.5.11 against 0.5.17 published 38 days ago is yellow', () => {
      expect(at({}, { ...PACKAGES, litestream: '0.5.11' })).toEqual([
        { colour: 'yellow', reason: 'litestream 0.5.11 < 0.5.17 (вийшов 2026-08-31)' }]);
    });
    it('a newer release 30 days old is silent; 31 days is yellow', () => {
      expect([at(latest('0.5.18', '2026-09-08T12:00:00Z')), at(latest('0.5.18', '2026-09-07T12:00:00Z'))]).toEqual([[], [
        { colour: 'yellow', reason: 'litestream 0.5.17 < 0.5.18 (вийшов 2026-09-07)' }]]);
    });
    it('an unreadable source is "нема даних"', () => {
      expect(at({ litestream: { ok: false, reason: 'релізи litestream ще не завантажено' } })).toEqual([
        { colour: 'yellow', reason: 'нема даних: релізи litestream ще не завантажено' }]);
    });
    it('an installed version dpkg could not name is "нема даних"', () => {
      expect(at({}, { ...PACKAGES, litestream: null })).toEqual([
        { colour: 'yellow', reason: 'нема даних: встановлена версія litestream' }]);
    });
  });
});
```

Date arithmetic is checked by hand. 2026-10-08 → 2027-04-06 is 180 days: 23 + 30 + 31 + 31 + 28 + 31 + 6. 2026-10-08 → 2026-11-07 is 30 days. 2026-09-08 → 2026-10-08 is 30 days.

Run: `npm test -- src/domain/status/host-upstream.test.ts`
Expected: FAIL, `Cannot find module './host-upstream'`.

- [ ] **Step 3: Implement**

Add to `STATUS_RULES` in `src/domain/status/rules.ts`, after `ubuntuStandardSupportEnd`:

```ts
  nodeSecurityRedDays: 3,          // a security release unattended-upgrades has not installed in 3 days
  litestreamYellowDays: 30,        // litestream is upgraded by hand (it writes the backup)
```

`src/domain/status/host-upstream.ts`:

```ts
import type { HostPatchFacts, HostUpstream } from './types';
import type { HostFinding } from './host-patch';
import { calendarDaysUntil } from './host-patch';
import { STATUS_RULES as R } from './rules';
import { ukDays } from './helpers';
import { compareVersions } from '../../sources/cws-version';

// Upstream rows of the host-patch rules (#469 stage 2). Node's end of life does not depend on the
// host summary and is reported even when it is unreadable; the version rules need `packages`.
const red = (reason: string): HostFinding => ({ colour: 'red', reason });
const yellow = (reason: string): HostFinding => ({ colour: 'yellow', reason });

// "24.21.0-1nodesource1" → "24.21.0", "1:2.39-0ubuntu8.7" → "2.39": the epoch and the Debian
// revision say nothing about which upstream release is installed.
export function debianUpstreamVersion(raw: string): string | null {
  const m = /^(?:\d+:)?(\d+(?:\.\d+)*)(?:[-+~].*)?$/.exec(raw);
  return m ? m[1] : null;
}

export function upstreamFindings(
  u: HostUpstream, packages: HostPatchFacts['packages'] | null, now: Date,
): HostFinding[] {
  const t = Math.floor(now.getTime() / 1000);
  const f: HostFinding[] = [];
  const ago = (date: string): number => -calendarDaysUntil(date, t)!;

  if (!u.nodeEnd.ok) f.push(yellow(`нема даних: ${u.nodeEnd.reason}`));
  else {
    const left = calendarDaysUntil(u.nodeEnd.value, t)!;
    const text = `Node 24: підтримка до ${u.nodeEnd.value} — ${left < 0 ? 'уже минула' : `лишилось ${ukDays(left)}`}`;
    if (left < R.eolRedDays) f.push(red(text));
    else if (left < R.eolYellowDays) f.push(yellow(text));
  }

  if (!u.nodeSecurity.ok) f.push(yellow(`нема даних: ${u.nodeSecurity.reason}`));
  else if (u.nodeSecurity.value !== null && packages !== null) {
    const installed = packages.nodejs === null ? null : debianUpstreamVersion(packages.nodejs);
    const sec = u.nodeSecurity.value;
    if (installed === null) f.push(yellow('нема даних: встановлена версія nodejs'));
    else if (compareVersions(installed, sec.version) < 0 && ago(sec.date) > R.nodeSecurityRedDays) {
      f.push(red(`Node ${installed} < безпековий ${sec.version} (з ${sec.date})`));
    }
  }

  if (!u.litestream.ok) f.push(yellow(`нема даних: ${u.litestream.reason}`));
  else if (packages !== null) {
    const installed = packages.litestream === null ? null : debianUpstreamVersion(packages.litestream);
    const latest = u.litestream.value;
    const day = latest.publishedAt.slice(0, 10);
    if (installed === null) f.push(yellow('нема даних: встановлена версія litestream'));
    else if (compareVersions(installed, latest.version) < 0 && ago(day) > R.litestreamYellowDays) {
      f.push(yellow(`litestream ${installed} < ${latest.version} (вийшов ${day})`));
    }
  }
  return f;
}
```

Run: `npm test -- src/domain/status/host-upstream.test.ts src/domain/status/host-patch.test.ts`
Expected: PASS.

Mutation checks. For each, make the change, see the named test fail, then revert:
- `ago(sec.date) > R.nodeSecurityRedDays` → `>=` → "the same release 3 days old is silent";
- replace `compareVersions(installed, sec.version) < 0` with `installed < sec.version` (string compare) → "compares numerically";
- move the Node-EOL block below an early `if (packages === null) return f;` → "after the end it is red and reported even without a host summary";
- `ago(day) > R.litestreamYellowDays` → `>=` → "a newer release 30 days old is silent; 31 days is yellow".

- [ ] **Step 4: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/domain/status/host-patch.ts src/domain/status/rules.ts src/domain/status/host-upstream.ts src/domain/status/host-upstream.test.ts
git commit -m "feat(status): upstream host-patch rules — Node security release, Node 24 EOL, litestream (#469)"
```

---

### Task 3: Wiring — the report reads the host and the upstream facts

**Files:**
- Modify: `src/domain/status/types.ts` (`StatusInputs.hostPatch`, `StatusInputs.upstream`)
- Modify: `src/domain/status/evaluate.ts` (`evaluateInfra`)
- Modify: `src/domain/status/evaluate.test.ts`
- Modify: `src/domain/status/test-inputs.ts` (green defaults)
- Modify: `src/jobs/status-inputs.ts` + `src/jobs/status-inputs.test.ts`
- Modify: `src/jobs/daily-status.ts` (+ its test, if it pins report text)
- Modify: `src/index.ts` (cron for `hostUpstream`)
- Modify: `scripts/ops/host_patch_collect.py` + `scripts/ops/test_host_patch_collect.py` (held packages)

**Interfaces:**
- Consumes: `readHostPatch` (core), `hostPatchFindings` (core), `readHostUpstream` + `hostUpstream` (Task 1), `upstreamFindings` (Task 2).
- Produces: the live report behaviour. `StatusInputOptions` and `DailyStatusDeps` gain `hostPatchPath?: string; hostPatchUid?: number`.

- [ ] **Step 1: Types and green defaults**

In `src/domain/status/types.ts`, add to `StatusInputs` (after `disk`):

```ts
  hostPatch: Avail<HostPatchFacts>; // #469 stage 2: the root collector's summary
  upstream: HostUpstream;           // #469 stage 2: Node/litestream releases, fetched daily
```

In `src/domain/status/test-inputs.ts`, add green values and wire them into `greenInputs`. Use `NOW` (2026-10-06T07:00Z), so every age sits inside every threshold:

```ts
const T = NOW.getTime() / 1000;
export const GREEN_HOST_PATCH: HostPatchFacts = {
  timestamp: T - 600,
  kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-142-generic' },
  rebootRequired: null,
  livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
  staleServices: [{ unit: 'code-server@ysi.service', since: T - 30 * 86_400 }],
  unattended: { lastRun: T - 3600, securityPending: 0 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' },
};
export const GREEN_UPSTREAM: HostUpstream = {
  nodeSecurity: { ok: true, value: { version: '24.18.1', date: '2026-07-28' } },
  nodeEnd: { ok: true, value: '2028-04-30' },
  litestream: { ok: true, value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' } },
};
```

Add these to the object `greenInputs` returns: `hostPatch: { ok: true, value: GREEN_HOST_PATCH }` and `upstream: GREEN_UPSTREAM`. Import `HostPatchFacts` and `HostUpstream` from `./types`.

- [ ] **Step 2: Write the failing evaluate tests**

Append to the `evaluateInfra` describe in `src/domain/status/evaluate.test.ts` (match that file's import style; it already imports `greenInputs`, `GIB_BYTES` etc.):

```ts
  // #469 stage 2: host-patch and upstream findings join the row and survive an unreadable disk summary.
  it('adds the host-patch findings to the disk findings', () => {
    const hostPatch = { ok: true as const, value: { ...GREEN_HOST_PATCH, rebootRequired: { since: NOW.getTime() / 1000 - 15 * 86_400, packages: ['libc6'] } } };
    expect(evaluateInfra(greenInputs({ hostPatch }))).toEqual({
      subsystem: 'infra', colour: 'red', reasons: ['ядро: перезавантаження чекає 15 днів (libc6)'],
    });
  });

  it('an unreadable disk summary no longer hides a red host line', () => {
    const hostPatch = { ok: true as const, value: { ...GREEN_HOST_PATCH, rebootRequired: { since: NOW.getTime() / 1000 - 15 * 86_400, packages: [] } } };
    expect(evaluateInfra(greenInputs({ hostPatch, disk: { ok: false, reason: 'дані монітора недоступні' } }))).toEqual({
      subsystem: 'infra', colour: 'red',
      reasons: ['нема даних: дані монітора недоступні', 'ядро: перезавантаження чекає 15 днів'],
    });
  });

  it('upstream findings join the row, using the host packages', () => {
    const hostPatch = { ok: true as const, value: { ...GREEN_HOST_PATCH, packages: { ...GREEN_HOST_PATCH.packages, litestream: '0.5.11' } } };
    expect(evaluateInfra(greenInputs({ hostPatch }))).toEqual({
      subsystem: 'infra', colour: 'yellow', reasons: ['litestream 0.5.11 < 0.5.17 (вийшов 2026-08-31)'],
    });
  });

  it('an unreadable host summary is one "нема даних" line, and the upstream package rules stay quiet', () => {
    expect(evaluateInfra(greenInputs({ hostPatch: { ok: false, reason: 'збирач патчів мовчить' } }))).toEqual({
      subsystem: 'infra', colour: 'yellow', reasons: ['нема даних: збирач патчів мовчить'],
    });
  });
```

Add `GREEN_HOST_PATCH` and `NOW` to the `./test-inputs` import if absent.

Run: `npm test -- src/domain/status/evaluate.test.ts`
Expected: FAIL. `evaluateInfra` ignores `hostPatch`/`upstream` (and typecheck complains until Step 3).

- [ ] **Step 3: Wire `evaluateInfra`**

In `src/domain/status/evaluate.ts`, import `hostPatchFindings` from `./host-patch` and `upstreamFindings` from `./host-upstream`. Then replace the head of `evaluateInfra`:

```ts
export function evaluateInfra(i: StatusInputs): Evaluation {
  if (!i.disk.ok) return evaluation('infra', [yellow(`нема даних: ${i.disk.reason}`)]);
  const d = i.disk.value;
  const f: Finding[] = [];
```

with:

```ts
// The host-patch and upstream findings are computed independently of the disk monitor (#469):
// an unreadable disk summary must not hide a red reboot line.
function hostFindings(i: StatusInputs): Finding[] {
  return [
    ...hostPatchFindings(i.hostPatch, i.now),
    ...upstreamFindings(i.upstream, i.hostPatch.ok ? i.hostPatch.value.packages : null, i.now),
  ];
}

export function evaluateInfra(i: StatusInputs): Evaluation {
  if (!i.disk.ok) return evaluation('infra', [yellow(`нема даних: ${i.disk.reason}`), ...hostFindings(i)]);
  const d = i.disk.value;
  const f: Finding[] = [];
```

At the end of `evaluateInfra`, change `return evaluation('infra', f);` to `return evaluation('infra', [...f, ...hostFindings(i)]);`.

Run: `npm test -- src/domain/status/evaluate.test.ts`
Expected: PASS, with every pre-existing infra test unchanged (green defaults add nothing).

- [ ] **Step 4: Collect the inputs**

In `src/jobs/status-inputs.ts`:
- Import `readHostPatch` from `./host-patch` and `readHostUpstream` from `./host-upstream`.
- Add `hostPatchPath?: string; hostPatchUid?: number;` to `StatusInputOptions`.
- Add to the object `collectStatusInputs` returns:

```ts
    hostPatch: readHostPatchInput(now, opts),
    upstream: readHostUpstream(db, now),
```

with, above `collectStatusInputs`:

```ts
// #469: the reader's kinds as report text; "stale" is the spec's wording for a silent collector.
function readHostPatchInput(now: Date, opts: StatusInputOptions): StatusInputs['hostPatch'] {
  const r = readHostPatch(now, opts.hostPatchPath, opts.hostPatchUid);
  if (r.kind === 'ok') return { ok: true, value: r.facts };
  return { ok: false, reason: r.kind === 'stale' ? 'збирач патчів мовчить' : 'підсумок патчів хоста недоступний' };
}
```

`readHostPatch`'s defaults (the real path, uid 0) apply when the options are undefined. Pass `undefined` through; do not substitute values.

In `src/jobs/daily-status.ts`, add `hostPatchPath?: string; hostPatchUid?: number;` to `DailyStatusDeps` and pass both into `buildDailyReport`'s options next to `testDiagnosticsPath`.

Add to `src/jobs/status-inputs.test.ts`. Match its DB setup; it already builds a DB and calls `collectStatusInputs`.

```ts
  it('#469: a missing host summary is "підсумок патчів хоста недоступний" and upstream is "ще не завантажено"', () => {
    const inputs = collectStatusInputs(db, NOW, DATE, { hostPatchPath: '/nonexistent/wbb-host-patch/summary.json' });
    expect([inputs.hostPatch, inputs.upstream.nodeEnd]).toEqual([
      { ok: false, reason: 'підсумок патчів хоста недоступний' },
      { ok: false, reason: 'графік підтримки Node ще не завантажено' },
    ]);
  });
```

Use whatever `NOW`/`DATE`/`db` names that test file already has; read it first.

**No test may read the real default path.** This dev host IS the production host. Once the installer runs, `/var/tmp/wbb-host-patch/summary.json` holds live, changing data, so a test that relies on the default would depend on the host's state. Every test that calls `collectStatusInputs`, `buildDailyReport` or `dailyStatus` must pass `hostPatchPath` pointing at a nonexistent file. Do it the way `daily-status.test.ts` already does with `missingMonitor` for `testDiagnosticsPath`: extend that object, or add a sibling, so both paths are always given.

`src/jobs/daily-status.test.ts` builds whole reports. Run it. If tests that pin the full report text now fail only because the Інфраструктура row gained `нема даних: підсумок патчів хоста недоступний` (no host summary exists in the test environment), update those expected strings to include it. Do NOT write a fake summary to make the row green. The new line is the truthful report for a host without the collector. Report which tests changed.

- [ ] **Step 5: Schedule the upstream job**

In `src/index.ts`, next to the `unlock-fixed-orphans` cron (hourly ticks), add:

```ts
    // #469 stage 2: upstream facts for the host-patch rules (Node 24 security releases and EOL,
    // litestream releases). Hourly UTC tick; each source refreshes once per ~20 h and a failed
    // fetch retries on the next tick. The morning report only reads job_state.
    cron.schedule('50 * * * *', () => {
      hostUpstream({ db, log }).catch((e) => log.error({ err: e }, 'host-upstream cron'));
    }),
```

Import `hostUpstream` from `./jobs/host-upstream`. Also add one startup call, next to the startup `dailyStatus(...)` call, so the first report after a deploy has data: `hostUpstream({ db, log }).catch((e) => log.error({ err: e }, 'host-upstream startup'));`.

- [ ] **Step 6: Held packages are installed (collector)**

`dpkg-query`'s `${db:Status-Abbrev}` is three characters: desired action, current status, error flag. `hi ` means held and installed. The core accepts only `ii`, so an `apt-mark hold` (the #458 trap) would read as null.

Append to `TestCollect` in `scripts/ops/test_host_patch_collect.py`. Use the runner's existing dpkg key form; read the file for the exact key, `DPKG(...)` or a literal tuple.

```python
    def test_a_held_package_still_reports_its_version(self):
        s = self.collect({DPKG('nodejs'): 'hi \t24.21.0-1nodesource1'})
        self.assertEqual(s['packages']['nodejs'], '24.21.0-1nodesource1')
```

Run: `python3 -B -m unittest discover -s scripts/ops -p 'test_host_patch_collect.py'`
Expected: FAIL (`None != '24.21.0-1nodesource1'`).

In `package_version`, replace the `status.startswith('ii')` test with `status[1:2] == 'i'` (the current-status character: installed). Re-run and expect PASS. The existing `rc` test must stay green: `rc` has status `c`.

- [ ] **Step 7: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/domain/status/types.ts src/domain/status/evaluate.ts src/domain/status/evaluate.test.ts src/domain/status/test-inputs.ts src/jobs/status-inputs.ts src/jobs/status-inputs.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts src/index.ts scripts/ops/host_patch_collect.py scripts/ops/test_host_patch_collect.py
git commit -m "feat(status): the Інфраструктура row reads the host-patch summary and upstream facts (#469)"
```

---

### Task 4: Host install and documents

**Files:**
- Create: `deploy/wbb-host-patch.service`, `deploy/wbb-host-patch.timer`
- Create: `deploy/install-host-patch-collector.sh`
- Create: `scripts/autodeploy/install-host-patch-collector.test.ts`
- Modify: `scripts/deploy-rsync.test.ts` (the shipped-files list, if the new deploy files ship)
- Modify: `deploy/README.md` ("Host patching (#469)"), `spec.md` (§5.9 and the `dailyStatus` row)

**Interfaces:**
- Consumes: `scripts/ops/host_patch_collect.py` (core + Task 3).
- Produces: the host-side install. The PR's `[deploy:hold]` steps name the installer.

- [ ] **Step 1: The units**

`deploy/wbb-host-patch.service`:

```ini
[Unit]
Description=#469 host-patch collector: local patch facts for the daily status
After=snapd.service

[Service]
Type=oneshot
# Root: needrestart -b and canonical-livepatch need it. Its own unit is also what lets the
# snap CLI start at all (spec C15). No PrivateTmp/ProtectSystem/NoNewPrivileges: the bot must
# see /var/tmp/wbb-host-patch, and snap confinement breaks under those.
ExecStart=/usr/bin/python3 -B /usr/local/libexec/wbb-host-patch-collect
TimeoutStartSec=15min
Nice=10
```

`deploy/wbb-host-patch.timer`:

```ini
[Unit]
Description=#469 host-patch collector, hourly

[Timer]
# OnActiveSec, not OnBootSec, and no Persistent (#798): a Persistent stamp plus an OnBootSec
# that passed during a slow boot left the autodeploy timer elapsed for good.
OnActiveSec=2min
OnUnitActiveSec=1h
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Write the failing installer and unit tests**

`scripts/autodeploy/install-host-patch-collector.test.ts`:

```ts
import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** #469 stage 2 periphery — spec 2026-10-06-469-host-patching-design.md. */
const REPO = resolve(__dirname, '../..');
const SCRIPT = join(REPO, 'deploy/install-host-patch-collector.sh');

interface Host { root: string; bin: string; log: string }

function host(opts: { uid?: string } = {}): Host {
  const dir = makeTempDirectory('wbb-hostpatch-collector-');
  const root = join(dir, 'root');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(join(root, 'var/tmp'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(log, '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('id', `echo ${opts.uid ?? '0'}`);
  stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  return { root, bin, log };
}

function run(h: Host, opts: { hostRoot?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${h.bin}:${process.env.PATH}`, WBB_HOST_ROOT: h.root };
  if (opts.hostRoot === false) delete env.WBB_HOST_ROOT;
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env, cwd: REPO });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const calls = (h: Host) => readFileSync(h.log, 'utf8').trim().split('\n').filter((l) => l !== '');
const at = (h: Host, p: string) => join(h.root, p);
const mode = (p: string) => statSync(p).mode & 0o7777;

const COLLECTOR = 'usr/local/libexec/wbb-host-patch-collect';
const SERVICE = 'etc/systemd/system/wbb-host-patch.service';
const TIMER = 'etc/systemd/system/wbb-host-patch.timer';
const OUT = 'var/tmp/wbb-host-patch';

describe('install-host-patch-collector — a clean host', () => {
  it('installs the collector 0755 and both units 0644, byte for byte', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, COLLECTOR))).toEqual(readFileSync(join(REPO, 'scripts/ops/host_patch_collect.py')));
    expect(readFileSync(at(h, SERVICE))).toEqual(readFileSync(join(REPO, 'deploy/wbb-host-patch.service')));
    expect(readFileSync(at(h, TIMER))).toEqual(readFileSync(join(REPO, 'deploy/wbb-host-patch.timer')));
    expect([mode(at(h, COLLECTOR)), mode(at(h, SERVICE)), mode(at(h, TIMER))]).toEqual([0o755, 0o644, 0o644]);
  });

  it('creates the summary directory 0755', () => {
    const h = host();
    run(h);
    expect([statSync(at(h, OUT)).isDirectory(), mode(at(h, OUT))]).toEqual([true, 0o755]);
  });

  it('reloads, enables the timer, then runs the collector once, in that order', () => {
    const h = host();
    run(h);
    expect(calls(h)).toEqual([
      'systemctl daemon-reload',
      'systemctl enable --now wbb-host-patch.timer',
      'systemctl start wbb-host-patch.service',
    ]);
  });

  it('is idempotent', () => {
    const h = host();
    expect([run(h).code, run(h).code]).toEqual([0, 0]);
    expect(mode(at(h, OUT))).toBe(0o755);
  });
});

describe('install-host-patch-collector — refusals change nothing', () => {
  it('refuses without root', () => {
    const h = host({ uid: '1000' });
    const r = run(h, { hostRoot: false });
    expect([r.code, r.err.includes('run as root'), existsSync(at(h, COLLECTOR)), calls(h)]).toEqual([1, true, false, []]);
  });

  it('refuses a squatted summary path that is a symlink', () => {
    const h = host();
    mkdirSync(at(h, 'elsewhere'));
    symlinkSync(at(h, 'elsewhere'), at(h, OUT));
    const r = run(h);
    expect([r.code, r.err.includes('/var/tmp/wbb-host-patch'), existsSync(at(h, COLLECTOR)), calls(h)]).toEqual([1, true, false, []]);
  });

  it('refuses a squatted summary path that is a plain file', () => {
    const h = host();
    writeFileSync(at(h, OUT), '');
    const r = run(h);
    expect([r.code, existsSync(at(h, COLLECTOR)), calls(h)]).toEqual([1, false, []]);
  });
});

/** The units' directives, comments and blank lines dropped, per section. */
function directives(path: string, section: string): string[] {
  return readFileSync(join(REPO, path), 'utf8').split(`[${section}]`)[1].split('\n[')[0]
    .split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

describe('the units', () => {
  it('the service is a 15-minute oneshot running the installed collector, unsandboxed', () => {
    expect(directives('deploy/wbb-host-patch.service', 'Service')).toEqual([
      'Type=oneshot',
      'ExecStart=/usr/bin/python3 -B /usr/local/libexec/wbb-host-patch-collect',
      'TimeoutStartSec=15min',
      'Nice=10',
    ]);
  });

  it('the timer fires from its own activation, hourly, with no boot clock and no stamp (#798)', () => {
    expect(directives('deploy/wbb-host-patch.timer', 'Timer')).toEqual([
      'OnActiveSec=2min',
      'OnUnitActiveSec=1h',
      'RandomizedDelaySec=5min',
    ]);
  });
});
```

The installer under test runs as a non-root user, so the root-ownership check has to compare against something that user owns. The installer compares the summary path's owner with the owner of `${WBB_HOST_ROOT:-/}`. On the real host that is `/`, owned by root; in a test it is the temp root, owned by the test user. Nothing in the test sets a uid.

Run: `npm test -- scripts/autodeploy/install-host-patch-collector.test.ts`
Expected: FAIL. The installer is missing, so exit 127. The units tests pass once Step 1 is in.

- [ ] **Step 3: Write the installer**

`deploy/install-host-patch-collector.sh`:

```bash
#!/usr/bin/env bash
# #469 stage 2 — install the hourly root host-patch collector.
# Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 2)
#
# Run from the repo root:   sudo bash deploy/install-host-patch-collector.sh
#
# Installs scripts/ops/host_patch_collect.py as /usr/local/libexec/wbb-host-patch-collect,
# wbb-host-patch.service + .timer, creates /var/tmp/wbb-host-patch (root, 0755), enables the
# timer and runs the collector once so the first summary exists before the bot reads it.
# Idempotent. A refused run changes nothing.
#
# WBB_HOST_ROOT is for tests only: every path is taken under it.
set -euo pipefail

R="${WBB_HOST_ROOT:-}"
if [ "$(id -u)" != 0 ] && [ -z "$R" ]; then
  echo "ERROR: run as root: sudo bash deploy/install-host-patch-collector.sh" >&2
  exit 1
fi

OUT=/var/tmp/wbb-host-patch
# /var/tmp is world-writable: anyone could pre-create the summary directory and make root write
# (and the bot trust) a file they control. Refuse anything but a directory owned like the root.
want_uid=$(stat -c %u "${R:-/}")
if [ -L "$R$OUT" ] || { [ -e "$R$OUT" ] && { [ ! -d "$R$OUT" ] || [ "$(stat -c %u "$R$OUT")" != "$want_uid" ]; }; }; then
  echo "ERROR: $OUT exists and is not a root-owned directory — remove it (sudo rm -rf $OUT) and re-run. Nothing was changed." >&2
  exit 1
fi

install -d "$R/usr/local/libexec" "$R/etc/systemd/system"
install -m 0755 scripts/ops/host_patch_collect.py "$R/usr/local/libexec/wbb-host-patch-collect"
install -m 0644 deploy/wbb-host-patch.service     "$R/etc/systemd/system/wbb-host-patch.service"
install -m 0644 deploy/wbb-host-patch.timer       "$R/etc/systemd/system/wbb-host-patch.timer"
install -d -m 0755 "$R$OUT"
chmod 0755 "$R$OUT"

systemctl daemon-reload
systemctl enable --now wbb-host-patch.timer
# Synchronous for a oneshot: the first summary exists when this returns.
systemctl start wbb-host-patch.service

echo
echo "== installed =="
echo "  /usr/local/libexec/wbb-host-patch-collect"
echo "  /etc/systemd/system/wbb-host-patch.{service,timer}"
echo "  $OUT"
echo
echo "Check the first summary before deploying the wiring (livepatch must not be null):"
echo "  python3 -m json.tool $OUT/summary.json"
```

Run: `npm test -- scripts/autodeploy/install-host-patch-collector.test.ts`
Expected: PASS.

Then run the full gate. If `scripts/deploy-rsync.test.ts` fails because the new `deploy/` files ship, add exactly the new paths to its expected list. The stage-1 precedent added `deploy/install-host-patching.sh` the same way.

Mutation checks. For each, make the change, see the named test fail, then revert:
- delete the `[ -L "$R$OUT" ] ||` clause → "refuses a squatted summary path that is a symlink";
- swap the `enable` and `start` lines → "reloads, enables the timer, then runs the collector once, in that order";
- add `Persistent=true` to the timer → "the timer fires from its own activation…".

- [ ] **Step 4: Documents**

In `deploy/README.md`, section `## Host patching (#469)`, after step 4 of "One-time setup", add:

```markdown
5. Stage 2 — the hourly collector (`[deploy:hold]` PR): `sudo bash deploy/install-host-patch-collector.sh`.
   It installs `wbb-host-patch.service`/`.timer`, creates `/var/tmp/wbb-host-patch` and runs the
   collector once. Check `python3 -m json.tool /var/tmp/wbb-host-patch/summary.json`: `livepatch`
   must not be `null` (if it is, the snap CLI did not start in the unit — see spec C15). Only then
   `bash deploy/deploy.sh`, which starts the bot reading it.

The Інфраструктура row of the daily status reads that summary (reboot pending, Livepatch,
stale watched units, security backlog) and the upstream facts the bot fetches daily (Node 24
security releases and end of life, litestream releases). Thresholds: `src/domain/status/rules.ts`.
Re-run the installer after any merge that changes `scripts/ops/host_patch_collect.py` or the units.
```

In `spec.md` §5.9, extend the host-patching bullet (it starts with `**Патчі хоста (#469`) with:

```markdown
  Щогодинний root-збирач (`wbb-host-patch.timer`, `deploy/install-host-patch-collector.sh`)
  пише `/var/tmp/wbb-host-patch/summary.json`; рядок «Інфраструктура» щоденного статусу читає
  його (очікування перезавантаження, Livepatch, не перезапущені після оновлення бот/cloudflared/
  litestream/ssh, безпекові оновлення при мовчазному unattended-upgrades) і апстрім-факти, які
  бот завантажує раз на добу (`host-upstream`: безпекові релізи Node 24, кінець підтримки Node 24,
  релізи litestream). Кінець підтримки Ubuntu 24.04 — константа. Підсумок старший за 3 год —
  `нема даних: збирач патчів мовчить`.
```

In `spec.md`'s scheduled-jobs table, add a row after the `dailyStatus` row:

```markdown
| `hostUpstream` | `50 * * * *` | #469: апстрім-факти для правил патчів хоста — найновіший безпековий реліз Node 24 (`nodejs.org/dist/index.json`), кінець підтримки Node 24 (`nodejs/Release` `schedule.json`), останній реліз litestream (GitHub API) — у `job_state.host_upstream`. Кожне джерело оновлюється, коли його останній успіх старший за 20 год; провал лишає попереднє значення й повторюється наступного тіку; старше 48 год звіт показує як `нема даних`. |
```

In that same table's `dailyStatus` row, change `Інфраструктура.` (in the subsystem list) to `Інфраструктура (диск, патчі хоста й апстрім-версії, #469).`

- [ ] **Step 5: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add deploy/wbb-host-patch.service deploy/wbb-host-patch.timer deploy/install-host-patch-collector.sh scripts/autodeploy/install-host-patch-collector.test.ts scripts/deploy-rsync.test.ts deploy/README.md spec.md
git commit -m "feat(deploy): hourly root host-patch collector — unit, timer, installer; docs (#469)"
```

---

## PR

Title: `[deploy:hold] feat(status): #469 stage 2 — host patches and upstream versions in the daily status`, with the label `deploy:hold`.

Host steps, in order:
1. `sudo bash deploy/install-host-patch-collector.sh`.
2. `python3 -m json.tool /var/tmp/wbb-host-patch/summary.json`. Check that `livepatch` is not `null` and `kernel` is not `null`.
3. `bash deploy/deploy.sh`.
4. The next morning's report shows the Інфраструктура row. Expect 🟡 `litestream 0.5.11 < 0.5.17 (вийшов 2026-08-31)`, a real finding.
