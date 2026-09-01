# #379 Release Announcements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a new extension version actually reaches users' browsers, the bot tells the four token holders once, in their own language, with a link to the changelog page — and never at night, never twice, never to someone who opted out.

**Architecture:** An hourly UTC cron tick calls `announceRelease`, which (a) leaves immediately outside the Warsaw `[09:00, 22:00)` send window without touching the network or the stored state, (b) reads the live published version from the same update-check endpoint Chrome itself queries, (c) compares it to a single `job_state` marker, and (d) only on a strict semver increase delivers to opted-in token holders sequentially, classifying every failure, and writes the marker **after** the loop.

**Tech Stack:** Node.js, TypeScript, Telegraf, better-sqlite3, node-cron, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-01-379-release-announcements-design.md`

## Global Constraints

Every task's requirements implicitly include this section. Values are verbatim — do not paraphrase, re-derive, or "improve" them.

- **Full gate per task.** Every task ends green on `npm test` **and** `npm run typecheck`, both from the repo root. Not a scoped subset — a scoped gate let a regression survive four clean reviews on #527.
- **Mutation-prove every test.** For each test you add, delete or invert the line it claims to guard and confirm it goes red, then restore. A test that cannot go red does not count. Report which line you broke for each test in your report file.
- **Exact constants**, defined once and imported, never re-typed:
  - `CWS_ITEM_ID = 'fdelmnhijeiojadcaihfdpecfcldbndg'`
  - `CHANGELOG_URL = 'https://ysilvestrov.github.io/warsaw-beer-bot/changelog/'`
  - `ANNOUNCED_VERSION_KEY = 'extension_announced_version'`
  - `SEND_WINDOW_START_HOUR = 9`, `SEND_WINDOW_END_HOUR = 22` (half-open `[9, 22)`)
  - cron expression `'40 * * * *'`
  - default inter-send gap `50` ms
- **State is written after the send loop, never before.** The marker `ANNOUNCED_VERSION_KEY` is set only once delivery has finished. Reversing this would lose an announcement permanently if the process died mid-loop.
- **`escapeHtml` runs inside the message builder**, on every localized string, exactly as `buildExtensionMessage` does it. Angle brackets in a locale string silently break Telegram's HTML parsing.
- **Never treat "could not read the version" as "unchanged".** A `null` from the parser or a thrown fetch means `outcome: 'unavailable'`: log at `warn`, leave the state alone, no admin alert.
- **Out of scope, do not add:** inline release notes, resurrecting `extractNotes` from `4343797^`, any write to `extension_releases`, any change under `extension/**`. Because `extension/**` is untouched, `docs/extension-install-uk.md` needs no update in this PR.
- **New `Messages` keys must be added to all three locales** (`uk`, `pl`, `en`). The `Messages` interface makes a missing one a compile error, so `npm run typecheck` is the check.
- **This is a server-side change**, so it ships: `deploy/rsync-filter` includes `/src/***`. A deploy is required after merge.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/sources/cws-version.ts` (new) | The item id, the update-check URL, the pure XML parser, the pure version comparator, and the one network call. |
| `src/storage/schema.ts` (modify) | Migration v26: `user_profiles.announce_opt_out`. |
| `src/storage/announce.ts` (new) | Who gets an announcement, and the opt-out read/write. |
| `src/storage/user_profiles.ts` (modify) | Export `toLocale` so locale validation lives in one place. |
| `src/storage/api_tokens.ts` (modify) | `hasApiToken` — so `/announce` can tell a user their setting is moot. |
| `src/i18n/types.ts`, `src/i18n/locales/{uk,pl,en}.ts` (modify) | The announcement and `/announce` strings. |
| `src/bot/commands/announce.ts` (new) | The `/announce` command: show state, `on`, `off`. |
| `src/bot/commands/catalog.ts` (modify) | `/announce` in the help text and the native menu. |
| `src/jobs/announce-release.ts` (new) | The window check, the message builder, the failure classifier, and the job. |
| `src/bot/commands/extension.ts`, `scripts/publish-store-release.ts` (modify) | Read `CWS_ITEM_ID` instead of holding their own copy. |
| `src/index.ts` (modify) | Mount the command, schedule the cron. |
| `spec.md` (modify) | Record the column, the migration, the command and the job. |

---

## Task 1: The published-version source

**Files:**
- Create: `src/sources/cws-version.ts`
- Test: `src/sources/cws-version.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const CWS_ITEM_ID: string`
  - `export function updateCheckUrl(itemId: string): string`
  - `export function parsePublishedVersion(xml: string): string | null`
  - `export function compareVersions(a: string, b: string): number`
  - `export function fetchPublishedVersion(deps?: { fetchImpl?: typeof fetch; itemId?: string; timeoutMs?: number }): Promise<string | null>`

**Context you need.** `clients2.google.com/service/update2/crx` is the endpoint Chrome itself queries to decide whether to update an extension. It needs no credentials. The two XML bodies in the tests below were captured live on 2026-09-01 — the first from our real item, the second from a garbage id. Note that `<app>` carries `status="ok"` **and** `<updatecheck>` carries its own `status="ok"`: the parser must key on the inner one, because the unknown-application response has an `<app status="error-unknownApplication"/>` with no `<updatecheck>` at all. Note also the real attribute order — `status` happens to precede `version` — which is exactly why the parser must extract the tag first and read attributes independently rather than matching them in one ordered regex.

- [ ] **Step 1: Write the failing tests**

Create `src/sources/cws-version.test.ts`:

```ts
import {
  CWS_ITEM_ID,
  compareVersions,
  fetchPublishedVersion,
  parsePublishedVersion,
  updateCheckUrl,
} from './cws-version';

// Captured live 2026-09-01 from the real item (truncated blobs, structure intact).
const REAL_XML =
  '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" ' +
  'protocol="2.0" server="prod"><daystart elapsed_days="7183" elapsed_seconds="32714"/>' +
  '<app appid="fdelmnhijeiojadcaihfdpecfcldbndg" cohort="1::" cohortname="" status="ok">' +
  '<updatecheck _esbAllowlist="false" codebase="https://clients2.googleusercontent.com/crx/blobs/Abe5cL7' +
  '/FDELMNHIJEIOJADCAIHFDPECFCLDBNDG_0_15_0_0.crx" fp="1.4e50" hash_sha256="4e50" protected="0" ' +
  'size="55919" status="ok" version="0.15.0"/></app></gupdate>';

// Captured live 2026-09-01 with a garbage app id — the control.
const UNKNOWN_APP_XML =
  '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" ' +
  'protocol="2.0" server="prod"><daystart elapsed_days="7183" elapsed_seconds="32723"/>' +
  '<app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" status="error-unknownApplication"/></gupdate>';

describe('parsePublishedVersion', () => {
  test('reads the version from a real ok response', () => {
    expect(parsePublishedVersion(REAL_XML)).toBe('0.15.0');
  });

  test('unknown application → null, not a version (the live control)', () => {
    expect(parsePublishedVersion(UNKNOWN_APP_XML)).toBeNull();
  });

  test('updatecheck present but not ok → null', () => {
    const xml = '<gupdate><app status="ok"><updatecheck status="noupdate" version="0.15.0"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBeNull();
  });

  test('updatecheck ok but no version attribute → null', () => {
    const xml = '<gupdate><app status="ok"><updatecheck status="ok" size="10"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBeNull();
  });

  test('a non-numeric version is rejected rather than passed through', () => {
    const xml = '<gupdate><app status="ok"><updatecheck status="ok" version="not-a-version"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBeNull();
  });

  test('empty body and garbage → null', () => {
    expect(parsePublishedVersion('')).toBeNull();
    expect(parsePublishedVersion('<html>404</html>')).toBeNull();
  });

  test('attribute order does not matter — version may precede status', () => {
    const xml = '<gupdate><app><updatecheck version="1.2.3" status="ok"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBe('1.2.3');
  });
});

describe('compareVersions', () => {
  test.each([
    ['0.15.0', '0.15.0', 0],
    ['0.16.0', '0.15.0', 1],
    ['0.15.0', '0.16.0', -1],
    ['0.16', '0.16.0', 0],       // missing segments are zeros
    ['0.16.1', '0.16', 1],
    ['0.10.0', '0.9.0', 1],      // numeric, not lexicographic
    ['0.9.0', '0.10.0', -1],
    ['1.0.0', '0.99.99', 1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(compareVersions(a as string, b as string)).toBe(expected);
  });
});

describe('updateCheckUrl', () => {
  test('encodes the id inside the x parameter the way the endpoint expects', () => {
    expect(updateCheckUrl('abc')).toContain('x=id%3Dabc%26uc');
    expect(updateCheckUrl('abc')).toContain('clients2.google.com/service/update2/crx');
  });
});

describe('fetchPublishedVersion', () => {
  test('parses the body of a 200 and defaults to our item id', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, text: async () => REAL_XML } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await fetchPublishedVersion({ fetchImpl })).toBe('0.15.0');
    expect(seen[0]).toContain(encodeURIComponent(`id=${CWS_ITEM_ID}&uc`));
  });

  test('a non-2xx response is null, not a throw', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, text: async () => '' } as unknown as Response)) as unknown as typeof fetch;
    expect(await fetchPublishedVersion({ fetchImpl })).toBeNull();
  });

  test('a network failure propagates so the caller can log it', async () => {
    const fetchImpl = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    await expect(fetchPublishedVersion({ fetchImpl })).rejects.toThrow('ENOTFOUND');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/sources/cws-version.test.ts`
Expected: FAIL — `Failed to resolve import "./cws-version"`.

- [ ] **Step 3: Write the implementation**

Create `src/sources/cws-version.ts`:

```ts
// The version users actually have, read from the endpoint Chrome itself queries when
// it decides whether to update an extension (#379). This is ground truth rather than a
// proxy: if it reports 0.16.0, browsers update to 0.16.0. It needs no credentials, so
// the CWS API keys stay on the release host and never reach production.
//
// `npm run release:store` is NOT this signal — it submits for review, and review can
// take days.

// Chrome Web Store item id. Single source of truth: the bot's store link, the release
// script's default item, and this poller all read it from here.
export const CWS_ITEM_ID = 'fdelmnhijeiojadcaihfdpecfcldbndg';

const UPDATE_ENDPOINT = 'https://clients2.google.com/service/update2/crx';

export function updateCheckUrl(itemId: string): string {
  const x = encodeURIComponent(`id=${itemId}&uc`);
  return `${UPDATE_ENDPOINT}?response=updatecheck&prodversion=140.0&acceptformat=crx3&x=${x}`;
}

/**
 * The published version, or null when the response does not carry one.
 *
 * Keys on the `<updatecheck>` element's own `status`, not the enclosing `<app>`'s: an
 * unknown item answers with `<app status="error-unknownApplication"/>` and no
 * `<updatecheck>` at all, which is what keeps "could not read" distinguishable from
 * "unchanged". Attributes are read individually rather than in one ordered pattern, so
 * a future reordering by Google cannot silently turn a real version into null.
 */
export function parsePublishedVersion(xml: string): string | null {
  const tag = /<updatecheck\b([^>]*)>/.exec(xml);
  if (!tag) return null;
  const attrs = tag[1];
  if (/\bstatus="([^"]*)"/.exec(attrs)?.[1] !== 'ok') return null;
  const version = /\bversion="([^"]*)"/.exec(attrs)?.[1];
  // Dotted numerics only — anything else is a shape we do not understand, and guessing
  // would feed compareVersions a NaN.
  return version && /^\d+(\.\d+)*$/.test(version) ? version : null;
}

/** -1 / 0 / 1, comparing dotted segments numerically; the shorter side is zero-padded. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface CwsVersionDeps {
  fetchImpl?: typeof fetch;
  itemId?: string;
  timeoutMs?: number;
}

/**
 * Null on a non-2xx or an unreadable body; throws on a network/timeout failure so the
 * caller logs it. Plain `fetch` rather than `createHttp`: that helper carries an
 * Untappd cookie, a proxy rotator and a block detector, none of which apply to 793
 * bytes of public XML.
 */
export async function fetchPublishedVersion(deps: CwsVersionDeps = {}): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(updateCheckUrl(deps.itemId ?? CWS_ITEM_ID), {
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  });
  if (!res.ok) return null;
  return parsePublishedVersion(await res.text());
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/sources/cws-version.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Mutation-prove the tests**

Break each line, confirm red, restore. Record the results in your report file.

| Break this | Test that must go red |
|---|---|
| `if (/\bstatus=…/ !== 'ok') return null;` → delete the line | `updatecheck present but not ok → null` |
| `/^\d+(\.\d+)*$/.test(version)` → `true` | `a non-numeric version is rejected` |
| `const x = pa[i] ?? 0` → `const x = pa[i]` | `'0.16' vs '0.16.0' → 0` |
| `.map(Number)` → `.map(String)` in `compareVersions` | `'0.10.0' vs '0.9.0' → 1` |
| `if (!res.ok) return null;` → delete | `a non-2xx response is null, not a throw` |
| `encodeURIComponent(...)` → `` `id=${itemId}&uc` `` | `encodes the id inside the x parameter` |

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/sources/cws-version.ts src/sources/cws-version.test.ts
git commit -m "feat(#379): read the live published extension version from Chrome's update endpoint"
```

---

## Task 2: The opt-out column and who receives an announcement

**Files:**
- Modify: `src/storage/schema.ts` (append a migration to `MIGRATIONS`, after the `version: 25` entry)
- Modify: `src/storage/user_profiles.ts` (export `toLocale`)
- Modify: `src/storage/api_tokens.ts` (add `hasApiToken`)
- Create: `src/storage/announce.ts`
- Test: `src/storage/announce.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export function toLocale(v: string | null | undefined): Locale | null` (from `src/storage/user_profiles.ts`)
  - `export function hasApiToken(db: DB, telegramId: number): boolean` (from `src/storage/api_tokens.ts`)
  - `export interface AnnounceRecipient { telegramId: number; language: Locale | null }`
  - `export function announceRecipients(db: DB): AnnounceRecipient[]`
  - `export function getAnnounceOptOut(db: DB, telegramId: number): boolean`
  - `export function setAnnounceOptOut(db: DB, telegramId: number, optOut: boolean): void`

**Context you need.** The current highest migration is `version: 25`; yours is 26. `user_profiles` already gained `language` and `city` by plain `ALTER TABLE ADD COLUMN`, so follow that. `api_tokens.telegram_id` has an FK to `user_profiles(telegram_id)`, so a token holder always has a profile row — but use a `LEFT JOIN` anyway so a hypothetical orphan token still receives an announcement rather than silently vanishing from the list. `user_profiles.ts` currently holds a private `KNOWN_LOCALES` set used by `getUserLanguage`; you are extracting the validation into `toLocale` and rewriting `getUserLanguage` to call it, so the rule lives in exactly one place.

- [ ] **Step 1: Write the failing tests**

Create `src/storage/announce.test.ts`:

```ts
import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile, setUserLanguage } from './user_profiles';
import { hashToken, rotateToken } from './api_tokens';
import { announceRecipients, getAnnounceOptOut, setAnnounceOptOut } from './announce';

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function withToken(db: DB, id: number): void {
  ensureProfile(db, id);
  rotateToken(db, id, hashToken(`raw-${id}`), '2026-09-01T00:00:00Z');
}

describe('migration 26', () => {
  test('user_profiles gains announce_opt_out defaulting to 0', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    const row = db.prepare('SELECT announce_opt_out FROM user_profiles WHERE telegram_id = 1')
      .get() as { announce_opt_out: number };
    expect(row.announce_opt_out).toBe(0);
  });
});

describe('announceRecipients', () => {
  test('token holders only — a profile without a token is not a recipient', () => {
    const db = freshDb();
    withToken(db, 1);
    ensureProfile(db, 2); // profile, no token
    expect(announceRecipients(db).map((r) => r.telegramId)).toEqual([1]);
  });

  test('carries each recipient language, and null for an unset or unknown one', () => {
    const db = freshDb();
    withToken(db, 1);
    setUserLanguage(db, 1, 'uk');
    withToken(db, 2); // language never set
    withToken(db, 3);
    db.prepare("UPDATE user_profiles SET language = 'kl' WHERE telegram_id = 3").run();
    expect(announceRecipients(db)).toEqual([
      { telegramId: 1, language: 'uk' },
      { telegramId: 2, language: null },
      { telegramId: 3, language: null },
    ]);
  });

  test('an opted-out token holder is excluded', () => {
    const db = freshDb();
    withToken(db, 1);
    withToken(db, 2);
    setAnnounceOptOut(db, 2, true);
    expect(announceRecipients(db).map((r) => r.telegramId)).toEqual([1]);
  });

  test('opting back in restores the recipient', () => {
    const db = freshDb();
    withToken(db, 1);
    setAnnounceOptOut(db, 1, true);
    expect(announceRecipients(db)).toEqual([]);
    setAnnounceOptOut(db, 1, false);
    expect(announceRecipients(db).map((r) => r.telegramId)).toEqual([1]);
  });
});

describe('getAnnounceOptOut', () => {
  test('false by default, true after opting out, false again after opting in', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
    setAnnounceOptOut(db, 1, true);
    expect(getAnnounceOptOut(db, 1)).toBe(true);
    setAnnounceOptOut(db, 1, false);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
  });

  test('false for a user with no profile row at all', () => {
    expect(getAnnounceOptOut(freshDb(), 999)).toBe(false);
  });
});
```

Add to `src/storage/api_tokens.test.ts`, inside its existing `describe('api_tokens storage', ...)`. That file already has a `fresh()` helper which creates profiles `111` and `222`, and it uses `it(` rather than `test(` — match both. Add `hasApiToken` to its existing import from `./api_tokens`:

```ts
  it('hasApiToken is true only while a token exists for that user', () => {
    const db = fresh();
    expect(hasApiToken(db, 111)).toBe(false);
    rotateToken(db, 111, hashToken('raw'), '2026-09-01T00:00:00Z');
    expect(hasApiToken(db, 111)).toBe(true);
    expect(hasApiToken(db, 222)).toBe(false);
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/storage/announce.test.ts src/storage/api_tokens.test.ts`
Expected: FAIL — `Failed to resolve import "./announce"`, and `hasApiToken is not a function`.

- [ ] **Step 3: Add the migration**

In `src/storage/schema.ts`, append to the `MIGRATIONS` array immediately after the `{ version: 25, … }` entry:

```ts
  {
    version: 26,
    // #379: opt-out for extension release announcements. Default 0 — existing token
    // holders receive announcements, and the message itself tells them how to stop.
    // Plain ADD COLUMN like `language` (v3) and `city` (v14) before it.
    sql: `
      ALTER TABLE user_profiles ADD COLUMN announce_opt_out INTEGER NOT NULL DEFAULT 0;
    `,
  },
```

- [ ] **Step 4: Extract `toLocale` in `src/storage/user_profiles.ts`**

Replace the `KNOWN_LOCALES` constant and `getUserLanguage` with:

```ts
const KNOWN_LOCALES = new Set<string>(['uk', 'pl', 'en']);

/** A stored language string narrowed to a Locale; null for unset or unrecognized. */
export function toLocale(v: string | null | undefined): Locale | null {
  return v != null && KNOWN_LOCALES.has(v) ? (v as Locale) : null;
}

export function getUserLanguage(db: DB, telegramId: number): Locale | null {
  const row = db
    .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { language: string | null } | undefined;
  return toLocale(row?.language);
}
```

- [ ] **Step 5: Add `hasApiToken` to `src/storage/api_tokens.ts`**

Append:

```ts
/** Whether this user currently holds an extension token (rotation is 1:1, so 0 or 1 row). */
export function hasApiToken(db: DB, telegramId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM api_tokens WHERE telegram_id = ? LIMIT 1')
    .get(telegramId) as { present: number } | undefined;
  return row !== undefined;
}
```

- [ ] **Step 6: Write `src/storage/announce.ts`**

```ts
import type { DB } from './db';
import type { Locale } from '../i18n/types';
import { toLocale } from './user_profiles';

export interface AnnounceRecipient {
  telegramId: number;
  language: Locale | null;
}

/**
 * Token holders who have not opted out (#379). Only token holders: a store install is
 * anonymous, so a user without a token does not exist as far as the bot is concerned.
 *
 * LEFT JOIN rather than INNER: the FK makes a token without a profile impossible today,
 * but if one ever existed, dropping it silently from the list would be worse than
 * sending in the default language.
 */
export function announceRecipients(db: DB): AnnounceRecipient[] {
  const rows = db
    .prepare(
      `SELECT t.telegram_id AS telegram_id, p.language AS language
         FROM api_tokens t
         LEFT JOIN user_profiles p ON p.telegram_id = t.telegram_id
        WHERE COALESCE(p.announce_opt_out, 0) = 0
        ORDER BY t.telegram_id`,
    )
    .all() as { telegram_id: number; language: string | null }[];
  return rows.map((r) => ({ telegramId: r.telegram_id, language: toLocale(r.language) }));
}

export function getAnnounceOptOut(db: DB, telegramId: number): boolean {
  const row = db
    .prepare('SELECT announce_opt_out FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { announce_opt_out: number } | undefined;
  return row?.announce_opt_out === 1;
}

export function setAnnounceOptOut(db: DB, telegramId: number, optOut: boolean): void {
  db.prepare('UPDATE user_profiles SET announce_opt_out = ? WHERE telegram_id = ?')
    .run(optOut ? 1 : 0, telegramId);
}
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx vitest run src/storage/`
Expected: PASS.

- [ ] **Step 8: Mutation-prove the tests**

| Break this | Test that must go red |
|---|---|
| Migration 26: `DEFAULT 0` → `DEFAULT 1` | `user_profiles gains announce_opt_out defaulting to 0` |
| `WHERE COALESCE(p.announce_opt_out, 0) = 0` → delete the WHERE clause | `an opted-out token holder is excluded` |
| `FROM api_tokens t LEFT JOIN user_profiles p` → `FROM user_profiles p LEFT JOIN api_tokens t` | `token holders only — a profile without a token is not a recipient` |
| `toLocale(r.language)` → `r.language as Locale` | `carries each recipient language, and null for an unset or unknown one` |
| `return row?.announce_opt_out === 1` → `return true` | `false by default, true after opting out, false again after opting in` |
| `return row?.announce_opt_out === 1` → `return row!.announce_opt_out === 1` | `false for a user with no profile row at all` |
| `hasApiToken`: `return row !== undefined` → `return true` | `hasApiToken is true only while a token exists for that user` |

- [ ] **Step 9: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 10: Commit**

```bash
git add src/storage/schema.ts src/storage/user_profiles.ts src/storage/api_tokens.ts src/storage/api_tokens.test.ts src/storage/announce.ts src/storage/announce.test.ts
git commit -m "feat(#379): add the announcement opt-out column and the recipient query"
```

---

## Task 3: The `/announce` command and its strings

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts`
- Create: `src/bot/commands/announce.ts`
- Modify: `src/bot/commands/catalog.ts`
- Test: `src/bot/commands/announce.test.ts`

**Interfaces:**
- Consumes: `getAnnounceOptOut`, `setAnnounceOptOut` from `src/storage/announce.ts`; `hasApiToken` from `src/storage/api_tokens.ts` (Task 2).
- Produces:
  - `export const announceCommand: Composer<BotContext>` — mounted by Task 5.
  - `Messages` keys `cmd.announce`, `announce.released`, `announce.changelog`, `announce.opt_out_hint`, `announce.status_on`, `announce.status_off`, `announce.turned_on`, `announce.turned_off`, `announce.no_token` — consumed by Task 4's message builder and by this command.

**Context you need.** `announce.released`, `announce.changelog` and `announce.opt_out_hint` are added here but used by Task 4's `buildAnnouncement`; defining all nine keys in one place keeps the three locale files edited once. Commands read arguments as `ctx.message.text.split(' ').slice(1).join(' ').trim()` — follow that idiom. `/announce` is **not** city-scoped: `cityGate` intercepts only the commands flagged `cityScoped` in `COMMAND_CATALOG`, so leaving the flag off is what lets an outside-Poland token holder use it. `catalog.test.ts` is written generically over `COMMAND_CATALOG`, so adding an entry needs no test edit — the existing tests will cover it automatically.

- [ ] **Step 1: Add the keys to `src/i18n/types.ts`**

In the `Messages` interface, add `'cmd.announce': string;` next to the other `cmd.*` keys, and append this block at the end of the interface (before the closing brace):

```ts
  // announce (#379 — extension release announcements)
  'announce.released': string;        // {version}
  'announce.changelog': string;       // {url}
  'announce.opt_out_hint': string;
  'announce.status_on': string;
  'announce.status_off': string;
  'announce.turned_on': string;
  'announce.turned_off': string;
  'announce.no_token': string;
```

- [ ] **Step 2: Add the strings to all three locales**

`src/i18n/locales/uk.ts` — add `'cmd.announce': 'анонси нових версій розширення',` beside the other `cmd.*` entries, and append before the closing brace:

```ts
  // announce (#379)
  'announce.released':
    '🍺 Розширення оновилось до версії {version} — Chrome підтягне його сам найближчим часом.',
  'announce.changelog': 'Що нового: {url}',
  'announce.opt_out_hint': 'Не хочеш таких повідомлень — надішли /announce off.',
  'announce.status_on': 'Анонси нових версій розширення: увімкнені. Вимкнути — /announce off',
  'announce.status_off': 'Анонси нових версій розширення: вимкнені. Увімкнути — /announce on',
  'announce.turned_on': 'Готово — розповідатиму про нові версії розширення.',
  'announce.turned_off': 'Готово — більше не турбуватиму. Повернути — /announce on',
  'announce.no_token':
    'Втім, анонси йдуть лише власникам токена розширення — отримати його можна через /extension.',
```

`src/i18n/locales/pl.ts` — add `'cmd.announce': 'ogłoszenia o nowych wersjach rozszerzenia',` and append:

```ts
  // announce (#379)
  'announce.released':
    '🍺 Rozszerzenie zaktualizowano do wersji {version} — Chrome pobierze je sam w najbliższym czasie.',
  'announce.changelog': 'Co nowego: {url}',
  'announce.opt_out_hint': 'Nie chcesz takich wiadomości — wyślij /announce off.',
  'announce.status_on': 'Ogłoszenia o nowych wersjach: włączone. Wyłącz — /announce off',
  'announce.status_off': 'Ogłoszenia o nowych wersjach: wyłączone. Włącz — /announce on',
  'announce.turned_on': 'Gotowe — będę informować o nowych wersjach rozszerzenia.',
  'announce.turned_off': 'Gotowe — nie będę więcej przeszkadzać. Przywróć — /announce on',
  'announce.no_token':
    'Ogłoszenia trafiają jednak tylko do posiadaczy tokenu rozszerzenia — po token: /extension.',
```

`src/i18n/locales/en.ts` — add `'cmd.announce': 'extension release announcements',` and append:

```ts
  // announce (#379)
  'announce.released':
    '🍺 The extension has been updated to version {version} — Chrome will pick it up on its own shortly.',
  'announce.changelog': "What's new: {url}",
  'announce.opt_out_hint': "Don't want these — send /announce off.",
  'announce.status_on': 'Release announcements: on. Turn off with /announce off',
  'announce.status_off': 'Release announcements: off. Turn on with /announce on',
  'announce.turned_on': "Done — I'll tell you about new extension versions.",
  'announce.turned_off': "Done — I won't bother you again. Turn back on with /announce on",
  'announce.no_token':
    'Announcements only go to extension token holders, though — get one with /extension.',
```

- [ ] **Step 3: Write the failing tests**

Create `src/bot/commands/announce.test.ts`:

```ts
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { getAnnounceOptOut, setAnnounceOptOut } from '../../storage/announce';
import { handleAnnounce } from './announce';
import { createTranslator } from '../../i18n';
import { COMMAND_CATALOG } from './catalog';

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const t = createTranslator('en');

function run(db: DB, telegramId: number, text: string): string[] {
  const replies: string[] = [];
  handleAnnounce({ db, telegramId, text, t, reply: (m) => { replies.push(m); } });
  return replies;
}

describe('handleAnnounce', () => {
  test('no argument, opted in, with a token → status only', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    rotateToken(db, 1, hashToken('raw'), '2026-09-01T00:00:00Z');
    expect(run(db, 1, '/announce')).toEqual([t('announce.status_on')]);
  });

  test('no argument without a token → status plus the honest caveat', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(run(db, 1, '/announce')).toEqual([
      `${t('announce.status_on')}\n${t('announce.no_token')}`,
    ]);
  });

  test('no argument while opted out reports off', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    rotateToken(db, 1, hashToken('raw'), '2026-09-01T00:00:00Z');
    setAnnounceOptOut(db, 1, true);
    expect(run(db, 1, '/announce')).toEqual([t('announce.status_off')]);
  });

  test('"off" persists the opt-out and confirms', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(run(db, 1, '/announce off')).toEqual([t('announce.turned_off')]);
    expect(getAnnounceOptOut(db, 1)).toBe(true);
  });

  test('"on" clears the opt-out and confirms', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    setAnnounceOptOut(db, 1, true);
    expect(run(db, 1, '/announce on')).toEqual([t('announce.turned_on')]);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
  });

  test('the argument is case-insensitive and tolerates extra spaces', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    run(db, 1, '/announce   OFF');
    expect(getAnnounceOptOut(db, 1)).toBe(true);
  });

  test('an unrecognized argument shows status rather than silently changing anything', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    rotateToken(db, 1, hashToken('raw'), '2026-09-01T00:00:00Z');
    expect(run(db, 1, '/announce maybe')).toEqual([t('announce.status_on')]);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
  });

  test('creates the profile row for a first-time user', () => {
    const db = freshDb();
    run(db, 7, '/announce off');
    expect(getAnnounceOptOut(db, 7)).toBe(true);
  });
});

describe('catalog', () => {
  test('/announce is listed and is not city-scoped (#399 must not gate it)', () => {
    const entry = COMMAND_CATALOG.find((e) => e.command === 'announce');
    expect(entry).toEqual({ command: 'announce', descKey: 'cmd.announce' });
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `npx vitest run src/bot/commands/announce.test.ts`
Expected: FAIL — `Failed to resolve import "./announce"`.

- [ ] **Step 5: Write `src/bot/commands/announce.ts`**

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import type { Translator } from '../../i18n/types';
import type { DB } from '../../storage/db';
import { ensureProfile } from '../../storage/user_profiles';
import { hasApiToken } from '../../storage/api_tokens';
import { getAnnounceOptOut, setAnnounceOptOut } from '../../storage/announce';

export interface AnnounceArgs {
  db: DB;
  telegramId: number;
  /** The raw command text, e.g. "/announce off". */
  text: string;
  t: Translator;
  reply: (message: string) => void;
}

/**
 * The whole decision, free of Telegraf so it can be tested directly (#379).
 *
 * An unrecognized argument falls through to the status view rather than guessing: a
 * user who typed something we did not understand should learn the current state, not
 * have it changed.
 */
export function handleAnnounce(args: AnnounceArgs): void {
  const { db, telegramId, t, reply } = args;
  ensureProfile(db, telegramId);
  const arg = args.text.split(' ').slice(1).join(' ').trim().toLowerCase();

  if (arg === 'off' || arg === 'on') {
    setAnnounceOptOut(db, telegramId, arg === 'off');
    reply(t(arg === 'off' ? 'announce.turned_off' : 'announce.turned_on'));
    return;
  }

  const lines = [t(getAnnounceOptOut(db, telegramId) ? 'announce.status_off' : 'announce.status_on')];
  // "Announcements: on" is true and misleading for someone who has no token and will
  // therefore never receive one. Say so rather than let the setting imply delivery.
  if (!hasApiToken(db, telegramId)) lines.push(t('announce.no_token'));
  reply(lines.join('\n'));
}

export const announceCommand = new Composer<BotContext>();

announceCommand.command('announce', async (ctx) => {
  const replies: string[] = [];
  handleAnnounce({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    text: ctx.message.text,
    t: ctx.t,
    reply: (m) => { replies.push(m); },
  });
  for (const m of replies) await ctx.reply(m);
});
```

- [ ] **Step 6: Add the catalog entry**

In `src/bot/commands/catalog.ts`, add to `COMMAND_CATALOG` immediately after the `extension` entry:

```ts
  { command: 'announce', descKey: 'cmd.announce' },
```

Deliberately **not** `cityScoped`: an outside-Poland token holder (#399) must still be able to turn announcements off.

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx vitest run src/bot/commands/announce.test.ts src/bot/commands/catalog.test.ts`
Expected: PASS.

- [ ] **Step 8: Mutation-prove the tests**

| Break this | Test that must go red |
|---|---|
| `.toLowerCase()` → remove | `the argument is case-insensitive and tolerates extra spaces` |
| `if (arg === 'off' \|\| arg === 'on')` → `if (arg !== '')` | `an unrecognized argument shows status rather than silently changing anything` |
| `if (!hasApiToken(...)) lines.push(...)` → delete the line | `no argument without a token → status plus the honest caveat` |
| `ensureProfile(db, telegramId)` → delete | `creates the profile row for a first-time user` |
| `arg === 'off'` in `setAnnounceOptOut` → `arg === 'on'` | `"off" persists the opt-out and confirms` |
| catalog entry → add `cityScoped: true` | `/announce is listed and is not city-scoped` |

- [ ] **Step 9: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 10: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts src/bot/commands/announce.ts src/bot/commands/announce.test.ts src/bot/commands/catalog.ts
git commit -m "feat(#379): add the /announce opt-out command and its localized strings"
```

---

## Task 4: The announce-release job

**Files:**
- Create: `src/jobs/announce-release.ts`
- Test: `src/jobs/announce-release.test.ts`

**Interfaces:**
- Consumes: `compareVersions` from `src/sources/cws-version.ts` (Task 1); `announceRecipients` from `src/storage/announce.ts` (Task 2); the `announce.*` `Messages` keys (Task 3); `getJobState` / `setJobState` from `src/storage/job_state.ts`; `warsawDateAndHour` from `src/domain/warsaw-time.ts`; `escapeHtml` from `src/bot/commands/html.ts`.
- Produces:
  - `export const ANNOUNCED_VERSION_KEY = 'extension_announced_version'`
  - `export const CHANGELOG_URL: string`
  - `export function inSendWindow(now: Date): boolean`
  - `export function buildAnnouncement(t: Translator, version: string, url: string): string`
  - `export type SendFailure = 'blocked' | 'rate_limited' | 'other'`
  - `export function classifySendFailure(err: unknown): { kind: SendFailure; retryAfterSec: number | null }`
  - `export interface AnnounceResult`, `export interface AnnounceDeps`
  - `export function announceRelease(deps: AnnounceDeps): Promise<AnnounceResult>` — scheduled by Task 5.

**Context you need.** `warsawDateAndHour(d)` returns `{ date, hour }` in `Europe/Warsaw`, DST handled by `Intl`. The window is half-open `[9, 22)`. The job mirrors `dailyStatus`: a frequent UTC tick plus an in-job window check, because node-cron's `{timezone}` pin silently skipped a run on this host on 2026-06-21.

Telegraf's error shape has never been read anywhere in this repo — the old `broadcastRelease` swallowed everything with a bare `catch {}` — so `classifySendFailure` reads **both** shapes it can take (`err.code` and `err.response.error_code`; `err.parameters.retry_after` and `err.response.parameters.retry_after`) and never relies on `instanceof`. An unrecognized shape is `'other'`, never a silent success.

The retry rule is narrow on purpose: exactly one retry, only for a 429 that told us how long to wait. A 429 without `retry_after` is counted as a failure rather than retried on a guessed delay.

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/announce-release.test.ts`:

```ts
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile, setUserLanguage } from '../storage/user_profiles';
import { hashToken, rotateToken } from '../storage/api_tokens';
import { setAnnounceOptOut } from '../storage/announce';
import { getJobState, setJobState } from '../storage/job_state';
import {
  ANNOUNCED_VERSION_KEY,
  CHANGELOG_URL,
  announceRelease,
  buildAnnouncement,
  classifySendFailure,
  inSendWindow,
} from './announce-release';
import { createTranslator } from '../i18n';

const silent = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as unknown as import('pino').Logger;

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function withToken(db: DB, id: number): void {
  ensureProfile(db, id);
  rotateToken(db, id, hashToken(`raw-${id}`), '2026-09-01T00:00:00Z');
}

// 2026-09-01 is CEST (UTC+2), so 07:00Z is 09:00 Warsaw.
const inWindowNow = new Date('2026-09-01T09:00:00Z');   // 11:00 Warsaw
const nightNow = new Date('2026-09-01T01:00:00Z');      // 03:00 Warsaw

interface Sent { id: number; html: string }

function deps(db: DB, over: Partial<Parameters<typeof announceRelease>[0]> = {}) {
  const sent: Sent[] = [];
  const base = {
    db,
    log: silent,
    now: () => inWindowNow,
    fetchVersion: async () => '0.16.0',
    send: async (id: number, html: string) => { sent.push({ id, html }); },
    sleep: async () => {},
    ...over,
  };
  return { deps: base as Parameters<typeof announceRelease>[0], sent };
}

describe('inSendWindow', () => {
  test.each([
    ['2026-09-01T06:59:00Z', false], // 08:59 Warsaw
    ['2026-09-01T07:00:00Z', true],  // 09:00 Warsaw — inclusive start
    ['2026-09-01T19:59:00Z', true],  // 21:59 Warsaw
    ['2026-09-01T20:00:00Z', false], // 22:00 Warsaw — exclusive end
    ['2026-09-01T01:00:00Z', false], // 03:00 Warsaw
  ])('%s → %s', (iso, expected) => {
    expect(inSendWindow(new Date(iso as string))).toBe(expected);
  });

  test('the window follows Warsaw across DST, not UTC', () => {
    // 2026-12-01 is CET (UTC+1): 08:30Z is 09:30 Warsaw and inside the window,
    // while the same 08:30Z in CEST-summer would be 10:30 — also inside, so use
    // the boundary that actually differs: 07:30Z is 08:30 Warsaw in winter (out)
    // and 09:30 in summer (in).
    expect(inSendWindow(new Date('2026-12-01T07:30:00Z'))).toBe(false);
    expect(inSendWindow(new Date('2026-07-01T07:30:00Z'))).toBe(true);
  });
});

describe('classifySendFailure', () => {
  test.each([
    [{ code: 403 }, 'blocked', null],
    [{ response: { error_code: 403 } }, 'blocked', null],
    [{ code: 429, parameters: { retry_after: 7 } }, 'rate_limited', 7],
    [{ response: { error_code: 429, parameters: { retry_after: 12 } } }, 'rate_limited', 12],
    [{ code: 429 }, 'rate_limited', null],
    [new Error('socket hang up'), 'other', null],
    ['a string', 'other', null],
    [undefined, 'other', null],
    [{ code: 400 }, 'other', null],
  ])('%o → %s / %s', (err, kind, retryAfterSec) => {
    expect(classifySendFailure(err)).toEqual({ kind, retryAfterSec });
  });
});

describe('buildAnnouncement', () => {
  test('carries the version and the changelog URL', () => {
    const html = buildAnnouncement(createTranslator('en'), '0.16.0', CHANGELOG_URL);
    expect(html).toContain('0.16.0');
    expect(html).toContain(CHANGELOG_URL);
    expect(html).toContain('/announce off');
  });

  test('escapes angle brackets coming from a locale string', () => {
    const t = ((key: string, params?: Record<string, string>) =>
      key === 'announce.released' ? `<b>${params!.version}</b>` : 'x') as never;
    const html = buildAnnouncement(t, '0.16.0', CHANGELOG_URL);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('announceRelease', () => {
  test('outside the window it returns early and never touches the network', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    let polled = false;
    const { deps: d, sent } = deps(db, {
      now: () => nightNow,
      fetchVersion: async () => { polled = true; return '0.16.0'; },
    });
    const r = await announceRelease(d);
    expect(r.outcome).toBe('outside_window');
    expect(polled).toBe(false);
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('an unreadable version is "unavailable" and leaves the state alone', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d, sent } = deps(db, { fetchVersion: async () => null });
    const r = await announceRelease(d);
    expect(r.outcome).toBe('unavailable');
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('a thrown fetch is "unavailable", not a crash', async () => {
    const db = freshDb();
    const { deps: d } = deps(db, { fetchVersion: async () => { throw new Error('ENOTFOUND'); } });
    await expect(announceRelease(d)).resolves.toMatchObject({ outcome: 'unavailable' });
  });

  test('first ever run seeds the marker and announces nothing', async () => {
    const db = freshDb();
    withToken(db, 1);
    const { deps: d, sent } = deps(db, { fetchVersion: async () => '0.15.0' });
    const r = await announceRelease(d);
    expect(r.outcome).toBe('seeded');
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('the same version announces nothing', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.16.0');
    const { deps: d, sent } = deps(db);
    expect((await announceRelease(d)).outcome).toBe('unchanged');
    expect(sent).toEqual([]);
  });

  test('a lower version records the rollback but announces nothing', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.16.0');
    const { deps: d, sent } = deps(db, { fetchVersion: async () => '0.15.0' });
    expect((await announceRelease(d)).outcome).toBe('rollback');
    expect(sent).toEqual([]);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('a higher version reaches every opted-in token holder, in their language', async () => {
    const db = freshDb();
    withToken(db, 1); setUserLanguage(db, 1, 'uk');
    withToken(db, 2); setUserLanguage(db, 2, 'en');
    withToken(db, 3); setAnnounceOptOut(db, 3, true);
    ensureProfile(db, 4); // no token
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');

    const { deps: d, sent } = deps(db);
    const r = await announceRelease(d);

    expect(r).toMatchObject({ outcome: 'announced', version: '0.16.0', sent: 2 });
    expect(sent.map((s) => s.id)).toEqual([1, 2]);
    expect(sent[0].html).toBe(buildAnnouncement(createTranslator('uk'), '0.16.0', CHANGELOG_URL));
    expect(sent[1].html).toBe(buildAnnouncement(createTranslator('en'), '0.16.0', CHANGELOG_URL));
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.16.0');
  });

  test('a recipient with no language falls back to English', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d, sent } = deps(db);
    await announceRelease(d);
    expect(sent[0].html).toBe(buildAnnouncement(createTranslator('en'), '0.16.0', CHANGELOG_URL));
  });

  test('failures are counted by reason and do not stop the rest of the run', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2); withToken(db, 3);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const { deps: d } = deps(db, {
      send: async (id: number) => {
        if (id === 1) throw { code: 403 };
        if (id === 2) throw new Error('socket hang up');
      },
    });
    const r = await announceRelease(d);
    expect(r).toMatchObject({
      outcome: 'announced',
      sent: 1,
      failed: { blocked: 1, rate_limited: 0, other: 1 },
    });
  });

  test('a 429 with retry_after is retried exactly once, then counted if it fails again', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const attempts: number[] = [];
    const slept: number[] = [];
    const { deps: d } = deps(db, {
      sleep: async (ms: number) => { slept.push(ms); },
      send: async (id: number) => {
        attempts.push(id);
        if (id === 1 && attempts.filter((a) => a === 1).length === 1) {
          throw { code: 429, parameters: { retry_after: 3 } };
        }
        if (id === 2) throw { code: 429, parameters: { retry_after: 1 } };
      },
    });
    const r = await announceRelease(d);
    // id 1: fails once, retried, succeeds. id 2: fails twice, counted once.
    expect(attempts).toEqual([1, 1, 2, 2]);
    expect(r).toMatchObject({ sent: 1, failed: { blocked: 0, rate_limited: 1, other: 0 } });
    expect(slept).toContain(3000);
  });

  test('a 429 without retry_after is not retried', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const attempts: number[] = [];
    const { deps: d } = deps(db, {
      send: async (id: number) => { attempts.push(id); throw { code: 429 }; },
    });
    const r = await announceRelease(d);
    expect(attempts).toEqual([1]);
    expect(r.failed.rate_limited).toBe(1);
  });

  test('the marker is written only after the last send', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const order: string[] = [];
    const { deps: d } = deps(db, {
      send: async (id: number) => {
        order.push(`send:${id} state=${getJobState(db, ANNOUNCED_VERSION_KEY)}`);
      },
    });
    await announceRelease(d);
    // Every send happened while the marker still held the OLD version.
    expect(order).toEqual(['send:1 state=0.15.0', 'send:2 state=0.15.0']);
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.16.0');
  });

  test('a failure reading recipients propagates and leaves the marker untouched', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    db.exec('DROP TABLE api_tokens');
    const { deps: d } = deps(db);
    await expect(announceRelease(d)).rejects.toThrow();
    expect(getJobState(db, ANNOUNCED_VERSION_KEY)).toBe('0.15.0');
  });

  test('the admin summary reports sent and failures by reason', async () => {
    const db = freshDb();
    withToken(db, 1); withToken(db, 2);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.15.0');
    const alerts: string[] = [];
    const { deps: d } = deps(db, {
      notifyAdmin: (m: string) => { alerts.push(m); },
      send: async (id: number) => { if (id === 2) throw { code: 403 }; },
    });
    await announceRelease(d);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('0.16.0');
    expect(alerts[0]).toContain('sent=1');
    expect(alerts[0]).toContain('blocked=1');
  });

  test('no admin summary when nothing was announced', async () => {
    const db = freshDb();
    withToken(db, 1);
    setJobState(db, ANNOUNCED_VERSION_KEY, '0.16.0');
    const alerts: string[] = [];
    const { deps: d } = deps(db, { notifyAdmin: (m: string) => { alerts.push(m); } });
    await announceRelease(d);
    expect(alerts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/jobs/announce-release.test.ts`
Expected: FAIL — `Failed to resolve import "./announce-release"`.

- [ ] **Step 3: Write `src/jobs/announce-release.ts`**

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Translator } from '../i18n/types';
import { createTranslator } from '../i18n';
import { getJobState, setJobState } from '../storage/job_state';
import { warsawDateAndHour } from '../domain/warsaw-time';
import { announceRecipients } from '../storage/announce';
import { compareVersions } from '../sources/cws-version';
import { escapeHtml } from '../bot/commands/html';

export const ANNOUNCED_VERSION_KEY = 'extension_announced_version';

// Rendered from extension/CHANGELOG.md by scripts/render-docs.ts. The bot links to it
// rather than quoting notes: the changelog file is not shipped to production at all
// (deploy/rsync-filter carries neither extension/** nor docs/**), so quoting would mean
// either a fragile HTML scraper or widening what "production" means (#542).
export const CHANGELOG_URL = 'https://ysilvestrov.github.io/warsaw-beer-bot/changelog/';

export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 22;

/**
 * Whether now falls in the Warsaw [09:00, 22:00) civil window. A store review finishes
 * when it finishes; without this an announcement could land at 03:00.
 */
export function inSendWindow(now: Date): boolean {
  const { hour } = warsawDateAndHour(now);
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

/** HTML body of one announcement. Every locale string is escaped here, in the builder. */
export function buildAnnouncement(t: Translator, version: string, url: string): string {
  return [
    escapeHtml(t('announce.released', { version })),
    escapeHtml(t('announce.changelog', { url })),
    escapeHtml(t('announce.opt_out_hint')),
  ].join('\n\n');
}

export type SendFailure = 'blocked' | 'rate_limited' | 'other';

interface TelegramErrorish {
  code?: unknown;
  parameters?: { retry_after?: unknown };
  response?: { error_code?: unknown; parameters?: { retry_after?: unknown } };
}

/**
 * Telegraf puts the API error code on either `err.code` or `err.response.error_code`,
 * and `retry_after` on either `err.parameters` or `err.response.parameters`. Nothing in
 * this repo had ever read that shape — the retired broadcast swallowed every error with
 * a bare catch — so both forms are read and `instanceof` is avoided entirely: we have
 * been burned before by an SDK whose error class was not what we expected while its
 * fields were exactly where documented. An unrecognized shape is 'other', never a
 * silent success.
 */
export function classifySendFailure(err: unknown): {
  kind: SendFailure;
  retryAfterSec: number | null;
} {
  const e = (err ?? {}) as TelegramErrorish;
  const code =
    typeof e.code === 'number' ? e.code
    : typeof e.response?.error_code === 'number' ? e.response.error_code
    : null;
  const retryAfter =
    typeof e.parameters?.retry_after === 'number' ? e.parameters.retry_after
    : typeof e.response?.parameters?.retry_after === 'number' ? e.response.parameters.retry_after
    : null;
  if (code === 403) return { kind: 'blocked', retryAfterSec: null };
  if (code === 429) return { kind: 'rate_limited', retryAfterSec: retryAfter };
  return { kind: 'other', retryAfterSec: null };
}

export interface AnnounceResult {
  outcome: 'outside_window' | 'unavailable' | 'seeded' | 'unchanged' | 'rollback' | 'announced';
  version: string | null;
  sent: number;
  failed: Record<SendFailure, number>;
}

export interface AnnounceDeps {
  db: DB;
  log: pino.Logger;
  now?: () => Date;
  /** Resolves to the live published version, or null when it cannot be read. */
  fetchVersion: () => Promise<string | null>;
  /** Delivers one message; throws on failure — the job classifies. */
  send: (telegramId: number, html: string) => Promise<void>;
  notifyAdmin?: (msg: string) => void;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const noFailures = (): Record<SendFailure, number> => ({ blocked: 0, rate_limited: 0, other: 0 });

/**
 * Announces a newly published extension version to opted-in token holders, at most once
 * per version (#379).
 *
 * Runs on a frequent UTC tick; the Warsaw window check and the job_state marker live
 * here rather than in the cron expression because node-cron's timezone pin silently
 * skipped a run on this host on 2026-06-21.
 */
export async function announceRelease(deps: AnnounceDeps): Promise<AnnounceResult> {
  const { db, log } = deps;
  const now = (deps.now ?? (() => new Date()))();

  if (!inSendWindow(now)) {
    log.debug('announce-release: outside the Warsaw send window');
    return { outcome: 'outside_window', version: null, sent: 0, failed: noFailures() };
  }

  let seen: string | null = null;
  try {
    seen = await deps.fetchVersion();
  } catch (e) {
    log.warn({ err: e }, 'announce-release: update check failed');
  }
  if (!seen) {
    // Deliberately NOT treated as "unchanged": a shape we cannot read must never be
    // mistaken for evidence that nothing was published.
    log.warn('announce-release: could not read the published version');
    return { outcome: 'unavailable', version: null, sent: 0, failed: noFailures() };
  }

  const stored = getJobState(db, ANNOUNCED_VERSION_KEY);
  if (stored === null) {
    setJobState(db, ANNOUNCED_VERSION_KEY, seen);
    log.info({ version: seen }, 'announce-release: seeded marker, nothing announced');
    return { outcome: 'seeded', version: seen, sent: 0, failed: noFailures() };
  }

  const cmp = compareVersions(seen, stored);
  if (cmp === 0) {
    return { outcome: 'unchanged', version: seen, sent: 0, failed: noFailures() };
  }
  if (cmp < 0) {
    setJobState(db, ANNOUNCED_VERSION_KEY, seen);
    log.warn({ seen, stored }, 'announce-release: published version went backwards');
    return { outcome: 'rollback', version: seen, sent: 0, failed: noFailures() };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = deps.gapMs ?? 50;
  const failed = noFailures();
  let sent = 0;

  for (const recipient of announceRecipients(db)) {
    const html = buildAnnouncement(createTranslator(recipient.language ?? 'en'), seen, CHANGELOG_URL);
    let delivered = false;
    // Two attempts at most, and the second only for a rate limit that told us how long
    // to wait. A 429 without retry_after gets no guessed delay.
    for (let attempt = 0; attempt < 2 && !delivered; attempt++) {
      try {
        await deps.send(recipient.telegramId, html);
        delivered = true;
      } catch (e) {
        const { kind, retryAfterSec } = classifySendFailure(e);
        if (attempt === 0 && kind === 'rate_limited' && retryAfterSec !== null) {
          await sleep(retryAfterSec * 1000);
          continue;
        }
        log.warn({ err: e, telegramId: recipient.telegramId, kind }, 'announce-release: delivery failed');
        failed[kind]++;
        // Give up on this recipient. Without the break, a 403 would be retried and
        // counted twice, because the loop's own guard only stops on success.
        break;
      }
    }
    if (delivered) sent++;
    await sleep(gapMs); // ~20 msg/s, the throttle #283 left as an obligation
  }

  // Only now. If the process dies mid-loop the marker still holds the old version and
  // the next tick retries; writing first would lose the announcement permanently.
  setJobState(db, ANNOUNCED_VERSION_KEY, seen);
  const total = failed.blocked + failed.rate_limited + failed.other;
  log.info({ version: seen, sent, failed }, 'announce-release sent');
  deps.notifyAdmin?.(
    `📣 Анонс ${seen}: sent=${sent} failed=${total} ` +
      `(blocked=${failed.blocked}, rate_limited=${failed.rate_limited}, other=${failed.other})`,
  );
  return { outcome: 'announced', version: seen, sent, failed };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/jobs/announce-release.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-prove the tests**

| Break this | Test that must go red |
|---|---|
| Move `setJobState(db, ANNOUNCED_VERSION_KEY, seen)` to just before the `for` loop | `the marker is written only after the last send` |
| `if (!inSendWindow(now))` → `if (false)` | `outside the window it returns early and never touches the network` |
| `if (!seen)` branch → `return { outcome: 'unchanged', … }` | `an unreadable version is "unavailable" and leaves the state alone` |
| `if (stored === null)` → seed **and** fall through to announcing | `first ever run seeds the marker and announces nothing` |
| `if (cmp < 0)` → delete the branch | `a lower version records the rollback but announces nothing` |
| `hour < SEND_WINDOW_END_HOUR` → `hour <= SEND_WINDOW_END_HOUR` | `'2026-09-01T20:00:00Z' → false` |
| `escapeHtml(...)` in `buildAnnouncement` → drop the wrapper | `escapes angle brackets coming from a locale string` |
| `recipient.language ?? 'en'` → `recipient.language!` | `a recipient with no language falls back to English` |
| `attempt === 0 && kind === 'rate_limited' && retryAfterSec !== null` → drop `retryAfterSec !== null` | `a 429 without retry_after is not retried` |
| `typeof e.response?.error_code === 'number'` branch → delete | `classifySendFailure` row `{ response: { error_code: 403 } } → blocked` |
| `failed[kind]++` → `failed.other++` | `failures are counted by reason and do not stop the rest of the run` |

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/announce-release.ts src/jobs/announce-release.test.ts
git commit -m "feat(#379): announce a newly published version once, in-window, with classified failures"
```

---

## Task 5: Wiring, the single item id, and the spec

**Files:**
- Modify: `src/index.ts`
- Modify: `src/bot/commands/extension.ts`
- Modify: `scripts/publish-store-release.ts`
- Modify: `spec.md`
- Create: `src/jobs/announce-release.wiring.test.ts`
- Test: `src/bot/commands/extension.test.ts` (extend), `scripts/publish-store-release.test.ts` (verify it still passes unchanged)

**Interfaces:**
- Consumes: `announceRelease` (Task 4), `fetchPublishedVersion` and `CWS_ITEM_ID` (Task 1), `announceCommand` (Task 3).
- Produces: nothing further.

**Context you need.** Nothing imports `src/index.ts`, so composition-root wiring is invisible to the whole suite — every other test here can be green while production never announces anything. This repo pins such invariants with a source-level guard after a reviewer once disabled the entire city gate with 1848 tests still passing; `src/jobs/unlock-fixed-orphans.wiring.test.ts` is the template. `adminAlert` is already defined in `src/index.ts` (a fire-and-forget `(msg: string) => void`) above the `cronJobs` array — reuse it, do not build another. Minute 40 is free: minute 0 is `refreshOntap`, 20 is `unlockFixedOrphans`, 30 is `enrichOrphans` and `refreshTapRatings`.

- [ ] **Step 1: Write the failing wiring test**

Create `src/jobs/announce-release.wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #379. Composition-root wiring is invisible to the rest of the suite: nothing imports
// src/index.ts, so every other test in this change can be green while production never
// announces a release. Same guard, same reason, as
// src/jobs/unlock-fixed-orphans.wiring.test.ts.
const src = (): string => readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

test('src/index.ts schedules announceRelease on a cron tick', () => {
  expect(src()).toMatch(/cron\.schedule\([^)]*\)[\s\S]{0,400}announceRelease\(\{/);
});

test('the announce cron runs hourly, not on a timezone-pinned schedule', () => {
  expect(src()).toMatch(/cron\.schedule\('40 \* \* \* \*'/);
});

test('src/index.ts mounts the /announce command composer', () => {
  expect(src()).toMatch(/bot\.use\([\s\S]{0,600}announceCommand,/);
});
```

Add to `src/bot/commands/extension.test.ts`:

```ts
test('STORE_URL is built from the single CWS item id (#379)', async () => {
  const { CWS_ITEM_ID } = await import('../../sources/cws-version');
  expect(STORE_URL).toContain(CWS_ITEM_ID);
  expect(STORE_URL).toBe(`https://chromewebstore.google.com/detail/${CWS_ITEM_ID}`);
});
```

Keep the existing `STORE_URL` import in that file; add `CWS_ITEM_ID` via the dynamic import shown, or add a static import at the top if the file's style prefers it.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/jobs/announce-release.wiring.test.ts src/bot/commands/extension.test.ts`
Expected: all three wiring tests FAIL, and the `STORE_URL` test fails only if the constant is still hand-typed (it will pass by luck since the literal matches — this is fine; its job is to keep them matching from now on).

- [ ] **Step 3: Point the two existing item-id copies at the constant**

In `src/bot/commands/extension.ts`, replace the `STORE_URL` definition:

```ts
import { CWS_ITEM_ID } from '../../sources/cws-version';

// Chrome Web Store listing (#267). The store build's ID is assigned by CWS, not by our
// key; it lives in src/sources/cws-version.ts so the listing link, the release script
// and the version poller can never drift apart (#379).
export const STORE_URL = `https://chromewebstore.google.com/detail/${CWS_ITEM_ID}`;
```

In `scripts/publish-store-release.ts`, replace the `DEFAULT_ITEM_ID` definition:

```ts
import { CWS_ITEM_ID } from '../src/sources/cws-version';

// Re-exported for the existing callers and tests; the id itself lives in src/ so the
// bot's listing link and the #379 version poller share exactly one copy.
export const DEFAULT_ITEM_ID = CWS_ITEM_ID;
```

Keep the existing `import` block ordering conventions of each file.

- [ ] **Step 4: Wire the command and the cron in `src/index.ts`**

Add to the imports, beside the other command imports:

```ts
import { announceCommand } from './bot/commands/announce';
```

and beside the other job imports:

```ts
import { announceRelease } from './jobs/announce-release';
import { fetchPublishedVersion } from './sources/cws-version';
```

In the `bot.use(...)` list, add `announceCommand,` immediately after `extensionCommand,`.

In the `cronJobs` array, add after the `unlockFixedOrphans` entry:

```ts
    // announce-release (#379): tell token holders when a new extension version is
    // actually live. Hourly UTC tick; the job checks the Warsaw [09:00,22:00) send
    // window and its own job_state version marker, so it sends at most once per
    // published version and never at night. Same UTC-tick pattern as daily-status —
    // node-cron's timezone pin is unreliable on this host. The signal is Chrome's own
    // update endpoint, not `npm run release:store`, which only submits for review.
    cron.schedule('40 * * * *', () => {
      announceRelease({
        db,
        log,
        fetchVersion: () => fetchPublishedVersion(),
        send: (telegramId, html) =>
          bot.telegram.sendMessage(telegramId, html, { parse_mode: 'HTML' }).then(() => {}),
        notifyAdmin: adminAlert,
      }).catch((e) => log.error({ err: e }, 'announce-release cron'));
    }),
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/jobs/announce-release.wiring.test.ts src/bot/commands/extension.test.ts scripts/publish-store-release.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `spec.md`**

Four edits, all in `spec.md`:

**(a)** In `### 3.8 user_profiles — профіль користувача`, append a row to the table after the `city` row:

```
| `announce_opt_out` | INTEGER | NOT NULL DEFAULT 0 (v26) | `1` — користувач відмовився від анонсів нових версій розширення (#379); шле лише власникам токена |
```

**(b)** In `### 3.18 Історія міграцій`, append after the `| 25 |` row:

```
| 26 | `user_profiles.announce_opt_out` (#379) — відмова від анонсів релізів розширення. Проста `ALTER TABLE ADD COLUMN` із `DEFAULT 0`: наявні власники токена анонси отримують, а спосіб відмовитись їм повідомляє саме повідомлення |
```

**(c)** In `## 4. User Flows / Commands`, add a section immediately after `### /extension — генерація API-токена для браузерного розширення`:

```markdown
### `/announce [on|off]` — анонси нових версій розширення
Без аргументу показує поточний стан; `off` вимикає, `on` вмикає. Якщо в
користувача нема токена розширення, до статусу додається рядок про те, що анонси
йдуть лише власникам токена — «увімкнено» без токена правдиве, але означало б
доставку, якої не буде. Нерозпізнаний аргумент показує статус і **нічого не
змінює**. Команда не є city-scoped (#399): відмовитись від розсилки має могти й
користувач поза Польщею.
```

**(d)** In `### Фонові джоби (node-cron, у процесі)`, append a row to the table:

```
| `announceRelease` | `40 * * * *` | анонс нової версії розширення власникам токена (#379). Сигнал — **ендпоінт оновлення Chrome** (`clients2.google.com/service/update2/crx`), тобто версія, яку браузери реально отримують; `npm run release:store` таким сигналом не є, бо лише подає на рев'ю. UTC-тік; джоба сама перевіряє варшавське вікно `[09:00, 22:00)` і маркер `job_state.extension_announced_version`. Перший прогін після деплою **засіває** маркер і не шле нічого; зниження версії записується, але теж не анонсується; нечитабельна відповідь — це `unavailable`, а не «без змін». Доставка послідовна з паузою 50 мс, збої класифікуються (`blocked`/`rate_limited`/`other`, один повтор лише на 429 із `retry_after`), підсумок іде адміну. Маркер пишеться **після** розсилки, щоб смерть процесу посеред неї не з'їла анонс. Зміст — лише версія і лінк на `https://ysilvestrov.github.io/warsaw-beer-bot/changelog/`: `extension/CHANGELOG.md` у прод не їде |
```

- [ ] **Step 7: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 8: Mutation-prove the wiring tests**

| Break this | Test that must go red |
|---|---|
| Delete the `announceRelease({` cron block from `src/index.ts` | `src/index.ts schedules announceRelease on a cron tick` |
| `cron.schedule('40 * * * *'` → `cron.schedule('0 9 * * *', { timezone: 'Europe/Warsaw' }` | `the announce cron runs hourly, not on a timezone-pinned schedule` |
| Remove `announceCommand,` from the `bot.use(...)` list | `src/index.ts mounts the /announce command composer` |
| `STORE_URL` → hard-code a different id | `STORE_URL is built from the single CWS item id` |

- [ ] **Step 9: Commit**

```bash
git add src/index.ts src/bot/commands/extension.ts src/bot/commands/extension.test.ts scripts/publish-store-release.ts src/jobs/announce-release.wiring.test.ts spec.md
git commit -m "feat(#379): wire the announce job and command, and give the item id one home"
```

---

## After the plan

Deployment is required (this change is under `src/***`, which `deploy/rsync-filter` ships). On the first tick after deploy the job will **seed** `extension_announced_version` with `0.15.0` and announce nothing — that is the designed behaviour, not a failure. Verify it with:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT value FROM job_state WHERE key = 'extension_announced_version';"
```

Expect `0.15.0` after the first in-window tick, and the first real announcement when 0.16.0 goes live in the store.
