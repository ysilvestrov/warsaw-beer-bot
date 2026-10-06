# #795 Audit verdict from the JSON report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** merge-deploy and prod-audit tell an advisory apart from a failure to audit by reading `npm audit --json`, not npm's exit code.

**Architecture:** A pure module `scripts/autodeploy/audit-verdict.ts` parses the JSON report into `clean | advisory | unrunnable`. Its CLI exits 0/1/2, which is the contract both shell callers already branch on. `qualify.ts` and `qualify-cli.ts` reuse its types, filter and parser, so the three audit readers cannot drift.

**Tech Stack:** TypeScript (tsx), bash, GitHub Actions YAML, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-06-795-audit-verdict-design.md`

## Global Constraints

- Tests run only through `npm test -- <file>` (bare `npx vitest` is refused). Every task runs the **full gate** before its commit: `npm test && npm run typecheck`.
- Test rules (CLAUDE.md):
  - Exact asserts (`toBe`/`toEqual`), never `toBeTruthy`, `toBeDefined` or `>=`.
  - No `if`/`else` and no early returns in tests.
  - No tautologies, and expected values are never computed by re-running production logic.
  - Cover boundaries and errors.
- Test temp dirs come from `makeTempDirectory(prefix)` in `scripts/test-temp.ts`. Never `mkdtempSync`/`os.tmpdir()` in new code.
- The exit-code contract of the CLI is exactly **0 clean / 1 advisory / 2 could not run**. Any crash of the CLI must exit 2, never 1. A 1 makes merge-deploy refuse the commit and set `LAST_FAILED_SHA`.
- The exit code of `npm audit` is **never** an input to the verdict.
- Fixtures live in `scripts/autodeploy/fixtures/npm-audit/` and are committed verbatim from the 2026-10-06 probe. **Do not edit them.**
  - `clean.json`: exit 0, `vulnerabilities: {}`.
  - `advisory.json`: exit 1, proxy-addr `critical`, GHSA-jqcg-44mw-7w3h.
  - `enolock.json`: exit 1, `{"error":{"code":"ENOLOCK",…}}`.
  - `registry-down.json`: exit 1, `{"message":"request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9","error":{"summary":"","detail":""}}`.
- `deploy/autodeploy.sh` is a `[deploy:hold]` path. The PR title starts with `[deploy:hold]` and carries the `deploy:hold` label.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Task | Responsibility |
|---|---|---|
| `scripts/autodeploy/audit-verdict.ts` (new) | 1 | types, `actionable`, `parseAuditReport`, `auditVerdict`, `renderVerdict`, `verdictExitCode` |
| `scripts/autodeploy/audit-verdict-cli.ts` (new) | 1 | stdin → stdout + exit 0/1/2 |
| `scripts/autodeploy/audit-verdict.test.ts` (new) | 1 | module + CLI tests on the fixtures |
| `scripts/autodeploy/qualify.ts` | 1 | imports types and `actionable` instead of defining them |
| `scripts/autodeploy/qualify-cli.ts` | 1 | `auditReport()` delegates parsing |
| `deploy/autodeploy.sh` | 2 | `_audit_default` pipes the JSON through the CLI |
| `scripts/autodeploy/autodeploy.test.ts` | 2 | the real `_audit_default` through a tick |
| `.github/workflows/prod-audit.yml` | 3 | install without scripts; verdict CLI; wording |
| `scripts/autodeploy/prod-audit-workflow.test.ts` | 3 | the step on the fixtures |
| `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md`, `spec.md` | 4 | correct the exit-code premise |

---

### Task 1: The verdict module, its CLI, and qualify's reuse of it

**Files:**
- Create: `scripts/autodeploy/audit-verdict.ts`
- Create: `scripts/autodeploy/audit-verdict-cli.ts`
- Create: `scripts/autodeploy/audit-verdict.test.ts`
- Modify: `scripts/autodeploy/qualify.ts:13-34` (the `Severity`, `AuditReport`, `ACTIONABLE`, `actionable` block)
- Modify: `scripts/autodeploy/qualify-cli.ts:14` (import) and `:21-43` (`auditReport`)

**Interfaces:**
- Produces:
  - `export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical'`
  - `export interface AuditReport { vulnerabilities: Record<string, { severity: Severity; via?: unknown[] }> }`
  - `export function actionable(r: AuditReport): { name: string; severity: Severity }[]`
  - `export interface Finding { name: string; severity: Severity; advisories: { title: string; url: string }[]; via: string[] }`
  - `export type AuditVerdict = { kind: 'clean' } | { kind: 'advisory'; findings: Finding[] } | { kind: 'unrunnable'; reason: string }`
  - `export function parseAuditReport(stdout: string): AuditReport | { error: string }`
  - `export function auditVerdict(stdout: string): AuditVerdict`
  - `export function renderVerdict(v: AuditVerdict): string`
  - `export function verdictExitCode(v: AuditVerdict): 0 | 1 | 2`
  - CLI: `tsx scripts/autodeploy/audit-verdict-cli.ts` reads stdin, prints `renderVerdict(...)` plus `\n`, and exits `verdictExitCode(...)`. Any throw prints `audit-verdict: <message>` to stderr and exits 2.

- [ ] **Step 1: Write the failing tests** — `scripts/autodeploy/audit-verdict.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditVerdict,
  parseAuditReport,
  renderVerdict,
  verdictExitCode,
} from './audit-verdict';

/**
 * #795 — npm 12 exits 1 for an advisory, a missing lockfile and an unreachable
 * registry alike. The fixtures are those three cases plus a clean audit, captured
 * verbatim on 2026-10-06; the verdict must come from their JSON alone.
 */
const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, 'fixtures/npm-audit', name), 'utf8');

const ADVISORY_LINE =
  'proxy-addr critical — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet https://github.com/advisories/GHSA-jqcg-44mw-7w3h';
const REGISTRY_REASON =
  'reports an error, not an audit: request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9';

const report = (vulnerabilities: Record<string, unknown>): string =>
  JSON.stringify({ auditReportVersion: 2, vulnerabilities });

describe('auditVerdict — the four probed cases', () => {
  it('a clean audit is clean', () => {
    expect(auditVerdict(fixture('clean.json'))).toEqual({ kind: 'clean' });
  });

  it('the proxy-addr advisory is an advisory with its GHSA', () => {
    expect(auditVerdict(fixture('advisory.json'))).toEqual({
      kind: 'advisory',
      findings: [{
        name: 'proxy-addr',
        severity: 'critical',
        advisories: [{
          title: 'proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet',
          url: 'https://github.com/advisories/GHSA-jqcg-44mw-7w3h',
        }],
        via: [],
      }],
    });
  });

  it('ENOLOCK is unrunnable, named by code and summary', () => {
    expect(auditVerdict(fixture('enolock.json'))).toEqual({
      kind: 'unrunnable',
      reason: 'reports an error, not an audit: ENOLOCK — This command requires an existing lockfile.',
    });
  });

  // The regression #795 is about: this exact output used to read as an advisory.
  it('an unreachable registry is unrunnable, named by npm\'s message', () => {
    expect(auditVerdict(fixture('registry-down.json'))).toEqual({ kind: 'unrunnable', reason: REGISTRY_REASON });
  });
});

describe('auditVerdict — the severity boundary', () => {
  it('a moderate-only report is clean', () => {
    expect(auditVerdict(report({ a: { severity: 'moderate', via: [] } }))).toEqual({ kind: 'clean' });
  });

  it('a high report is an advisory', () => {
    expect(auditVerdict(report({ a: { severity: 'high', via: [] } }))).toEqual({
      kind: 'advisory',
      findings: [{ name: 'a', severity: 'high', advisories: [], via: [] }],
    });
  });

  it('keeps only the high and critical packages of a mixed report', () => {
    const v = auditVerdict(report({
      lo: { severity: 'low', via: [] },
      hi: { severity: 'high', via: ['lo'] },
      cr: { severity: 'critical', via: [] },
    }));
    expect(v).toEqual({
      kind: 'advisory',
      findings: [
        { name: 'hi', severity: 'high', advisories: [], via: ['lo'] },
        { name: 'cr', severity: 'critical', advisories: [], via: [] },
      ],
    });
  });
});

describe('parseAuditReport — anything that is not an audit is an error', () => {
  it('empty stdout', () => {
    expect(parseAuditReport('  \n')).toEqual({ error: 'is empty — npm audit did not produce a report' });
  });

  it('not JSON', () => {
    expect(parseAuditReport('npm error code E500')).toEqual({ error: 'is not JSON — npm audit did not produce a report' });
  });

  it('JSON that is not an object', () => {
    expect(parseAuditReport('[]')).toEqual({ error: 'is not a JSON object — npm audit did not produce a report' });
  });

  it('an object with no vulnerabilities field', () => {
    expect(parseAuditReport('{"auditReportVersion":2}')).toEqual({
      error: 'has no "vulnerabilities" field — not a well-formed audit report',
    });
  });

  it('an error with no code, summary or message falls back to the raw error', () => {
    expect(parseAuditReport('{"error":{"detail":"x"}}')).toEqual({
      error: 'reports an error, not an audit: {"detail":"x"}',
    });
  });

  it('an error key wins even when vulnerabilities is present', () => {
    expect(parseAuditReport('{"error":{"code":"E1"},"vulnerabilities":{}}')).toEqual({
      error: 'reports an error, not an audit: E1',
    });
  });
});

describe('renderVerdict', () => {
  it('renders the advisory as one line per package', () => {
    expect(renderVerdict(auditVerdict(fixture('advisory.json')))).toBe(ADVISORY_LINE);
  });

  it('renders upstream-only findings by the packages they come through', () => {
    expect(renderVerdict({
      kind: 'advisory',
      findings: [
        { name: 'hi', severity: 'high', advisories: [], via: ['lo', 'mid'] },
        { name: 'cr', severity: 'critical', advisories: [{ title: 'T', url: 'U' }], via: ['x'] },
        { name: 'bare', severity: 'high', advisories: [], via: [] },
      ],
    })).toBe('hi high — via lo, mid\ncr critical — T U; via x\nbare high');
  });

  it('renders clean', () => {
    expect(renderVerdict({ kind: 'clean' })).toBe('npm audit: no high or critical advisory in production dependencies');
  });

  it('renders unrunnable with its reason', () => {
    expect(renderVerdict(auditVerdict(fixture('registry-down.json'))))
      .toBe(`npm audit could not run: the output ${REGISTRY_REASON}`);
  });
});

describe('verdictExitCode', () => {
  it('maps clean / advisory / unrunnable to 0 / 1 / 2', () => {
    expect([
      verdictExitCode({ kind: 'clean' }),
      verdictExitCode({ kind: 'advisory', findings: [] }),
      verdictExitCode({ kind: 'unrunnable', reason: 'r' }),
    ]).toEqual([0, 1, 2]);
  });
});

describe('audit-verdict-cli', () => {
  const CLI = resolve(__dirname, 'audit-verdict-cli.ts');
  const run = (input: string) => {
    const r = spawnSync('npx', ['tsx', CLI], { input, encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  };

  it('clean → exit 0', () => {
    expect(run(fixture('clean.json'))).toEqual({
      code: 0, out: 'npm audit: no high or critical advisory in production dependencies\n',
    });
  });

  it('advisory → exit 1', () => {
    expect(run(fixture('advisory.json'))).toEqual({ code: 1, out: `${ADVISORY_LINE}\n` });
  });

  it('unreachable registry → exit 2', () => {
    expect(run(fixture('registry-down.json'))).toEqual({
      code: 2, out: `npm audit could not run: the output ${REGISTRY_REASON}\n`,
    });
  });

  it('no input at all → exit 2', () => {
    expect(run('')).toEqual({
      code: 2, out: 'npm audit could not run: the output is empty — npm audit did not produce a report\n',
    });
  });
});
```

- [ ] **Step 2: Run them, expect failure**

Run: `npm test -- scripts/autodeploy/audit-verdict.test.ts`
Expected: FAIL. The module `./audit-verdict` cannot be resolved.

- [ ] **Step 3: Write `scripts/autodeploy/audit-verdict.ts`**

```ts
/**
 * #795 — what one `npm audit --omit=dev --json` run says about production.
 *
 * Read from the JSON, never from the exit code: npm 12 exits 1 for an advisory,
 * for a missing lockfile (ENOLOCK) and for an unreachable registry alike
 * (probed 2026-10-06; spec docs/superpowers/specs/2026-10/2026-10-06-795-audit-verdict-design.md).
 * merge-deploy, prod-audit and the Dependabot qualifier all read audits through
 * this module, so the three can no longer disagree about what a report means.
 */

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

/** The shape we consume from `npm audit --json` (`.vulnerabilities`). */
export interface AuditReport {
  vulnerabilities: Record<string, { severity: Severity; via?: unknown[] }>;
}

/** The severities `--audit-level=high` fails on. */
const ACTIONABLE: readonly Severity[] = ['high', 'critical'];

export function actionable(r: AuditReport): { name: string; severity: Severity }[] {
  return Object.entries(r.vulnerabilities)
    .filter(([, v]) => ACTIONABLE.includes(v.severity))
    .map(([name, v]) => ({ name, severity: v.severity }));
}

export interface Finding {
  name: string;
  severity: Severity;
  /** The advisory objects in `via`. */
  advisories: { title: string; url: string }[];
  /** The string entries in `via`: packages this one is vulnerable through. */
  via: string[];
}

export type AuditVerdict =
  | { kind: 'clean' }
  | { kind: 'advisory'; findings: Finding[] }
  | { kind: 'unrunnable'; reason: string };

const NO_REPORT = 'npm audit did not produce a report';

function describeNpmError(error: unknown, message: unknown): string {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; summary?: unknown };
  const parts = [e.code, e.summary, message].filter((p): p is string => typeof p === 'string' && p !== '');
  return parts.length > 0 ? parts.join(' — ') : JSON.stringify(error);
}

/**
 * An absent or malformed report is an ERROR, never a pass. The reason reads as a
 * predicate of "the output" / "audit.json in <dir>", which is how both callers word it.
 */
export function parseAuditReport(stdout: string): AuditReport | { error: string } {
  const raw = stdout.trim();
  if (raw === '') return { error: `is empty — ${NO_REPORT}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `is not JSON — ${NO_REPORT}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `is not a JSON object — ${NO_REPORT}` };
  }
  const obj = parsed as { error?: unknown; message?: unknown; vulnerabilities?: unknown };
  if ('error' in obj) {
    return { error: `reports an error, not an audit: ${describeNpmError(obj.error, obj.message)}` };
  }
  const v = obj.vulnerabilities;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { error: 'has no "vulnerabilities" field — not a well-formed audit report' };
  }
  return { vulnerabilities: v as AuditReport['vulnerabilities'] };
}

function finding(name: string, severity: Severity, via: unknown[]): Finding {
  const advisories: Finding['advisories'] = [];
  const upstream: string[] = [];
  for (const entry of via) {
    if (typeof entry === 'string') {
      upstream.push(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const a = entry as { title?: unknown; url?: unknown };
      if (typeof a.title === 'string' && typeof a.url === 'string') advisories.push({ title: a.title, url: a.url });
    }
  }
  return { name, severity, advisories, via: upstream };
}

export function auditVerdict(stdout: string): AuditVerdict {
  const report = parseAuditReport(stdout);
  if ('error' in report) return { kind: 'unrunnable', reason: report.error };
  const findings = actionable(report).map(({ name, severity }) =>
    finding(name, severity, report.vulnerabilities[name].via ?? []));
  return findings.length === 0 ? { kind: 'clean' } : { kind: 'advisory', findings };
}

function renderFinding(f: Finding): string {
  const parts = [
    ...f.advisories.map((a) => `${a.title} ${a.url}`),
    ...(f.via.length > 0 ? [`via ${f.via.join(', ')}`] : []),
  ];
  const head = `${f.name} ${f.severity}`;
  return parts.length > 0 ? `${head} — ${parts.join('; ')}` : head;
}

export function renderVerdict(v: AuditVerdict): string {
  switch (v.kind) {
    case 'clean':
      return 'npm audit: no high or critical advisory in production dependencies';
    case 'unrunnable':
      return `npm audit could not run: the output ${v.reason}`;
    case 'advisory':
      return v.findings.map(renderFinding).join('\n');
  }
}

/** The contract deploy/autodeploy.sh and prod-audit.yml branch on. */
export function verdictExitCode(v: AuditVerdict): 0 | 1 | 2 {
  switch (v.kind) {
    case 'clean':
      return 0;
    case 'advisory':
      return 1;
    case 'unrunnable':
      return 2;
  }
}
```

- [ ] **Step 4: Write `scripts/autodeploy/audit-verdict-cli.ts`**

```ts
/**
 * #795 — reads `npm audit --omit=dev --json` on stdin, prints the verdict, and
 * exits 0 clean / 1 advisory / 2 could not run.
 *
 * Usage: npm audit --omit=dev --json | tsx scripts/autodeploy/audit-verdict-cli.ts
 *
 * A crash here must exit 2, never 1: merge-deploy reads 1 as "this commit carries
 * an advisory" and never retries it.
 */
import { readFileSync } from 'node:fs';
import { auditVerdict, renderVerdict, verdictExitCode } from './audit-verdict';

try {
  const verdict = auditVerdict(readFileSync(0, 'utf8'));
  process.stdout.write(`${renderVerdict(verdict)}\n`);
  process.exitCode = verdictExitCode(verdict);
} catch (e) {
  process.stderr.write(`audit-verdict: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
```

- [ ] **Step 5: Run the new tests, expect pass**

Run: `npm test -- scripts/autodeploy/audit-verdict.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Make `qualify.ts` import instead of define**

In `scripts/autodeploy/qualify.ts`, delete the block from `export type Severity = …` (line 13) through the end of `function actionable(…) { … }` (line ~34). Keep the `Verdict` type and `HOLD_HOURS`, which sit between them, in place. Add near the top, after the header comment:

```ts
import { actionable, type AuditReport, type Severity } from './audit-verdict';

export type { AuditReport, Severity };
```

The re-export keeps `qualify-cli.ts` and `qualify.test.ts`/`qualify-cli.test.ts` imports from `./qualify` valid.

- [ ] **Step 7: Make `qualify-cli.ts` `auditReport()` delegate**

Change the import line `import { qualify, needsHoldCheck, type AuditReport } from './qualify';` to:

```ts
import { qualify, needsHoldCheck, type AuditReport } from './qualify';
import { parseAuditReport } from './audit-verdict';
```

Replace the body of `auditReport` (keep its doc comment) with:

```ts
export function auditReport(dir: string): AuditReport {
  const parsed = parseAuditReport(readFileSync(join(dir, 'audit.json'), 'utf8'));
  if ('error' in parsed) throw new Error(`audit.json in ${dir} ${parsed.error}`);
  return parsed;
}
```

The existing `qualify-cli.test.ts` cases (`/reports an error/`, `/well-formed/`, `/did not produce a report/`) must pass unchanged. They pin that the move kept behaviour.

- [ ] **Step 8: Full gate**

Run: `npm test && npm run typecheck`
Expected: all green. `tsconfig.scripts.json` already includes `scripts/autodeploy/**/*`.

- [ ] **Step 9: Mutation check (do not commit it)**

Temporarily change `ACTIONABLE` to `['critical']` and run `npm test -- scripts/autodeploy/audit-verdict.test.ts`. Expected: the "a high report is an advisory" and "mixed report" tests FAIL. Undo the edit by hand (the file is not committed yet, so `git checkout` would delete it). Then temporarily change the CLI's `process.exitCode = 2` in `catch` to `1`. It is not reachable from the fixtures, so record in the report that this line is guarded by its comment, not by a test. Revert.

- [ ] **Step 10: Commit**

```bash
git add scripts/autodeploy/audit-verdict.ts scripts/autodeploy/audit-verdict-cli.ts scripts/autodeploy/audit-verdict.test.ts scripts/autodeploy/qualify.ts scripts/autodeploy/qualify-cli.ts
git commit -m "feat(autodeploy): audit verdict read from the npm audit JSON, shared with qualify (#795)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: merge-deploy reads the verdict

**Files:**
- Modify: `deploy/autodeploy.sh:77-80` (`_audit_default` and its comment)
- Test: `scripts/autodeploy/autodeploy.test.ts` (new `describe` after the existing `'does NOT blame the commit when the audit cannot run'` test's `describe`)

**Interfaces:**
- Consumes: `scripts/autodeploy/audit-verdict-cli.ts` (Task 1), stdin JSON → exit 0/1/2.
- The tick's branches at `deploy/autodeploy.sh:683-690` are **unchanged**: 1 → `refuse` (sets `LAST_FAILED_SHA`); other non-zero → `once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: npm audit could not run (exit N) …"`, then `exit 1`.

- [ ] **Step 1: Write the failing tests** — append to `scripts/autodeploy/autodeploy.test.ts`

Add `symlinkSync` to the existing `node:fs` import. Then append:

```ts
/**
 * #795 — the REAL `_audit_default`, not a stub, driven through a tick. npm is a
 * stub printing a probed fixture with npm's real exit code; the verdict CLI and
 * tsx are the repository's own (symlinked into a scratch cwd).
 */
describe('merge-deploy: the audit verdict comes from the JSON (#795)', () => {
  const ROOT = resolve(__dirname, '../..');
  const FIXTURES = resolve(__dirname, 'fixtures/npm-audit');
  const AUDIT_FN = execFileSync('sed', ['-n', '/^_audit_default() {/,/^}/p', SCRIPT], { encoding: 'utf8' });

  /** An AUDIT_CMD that runs the real function against `npm` printing `json` and exiting `npmExit`. */
  function realAudit(w: World, json: string, npmExit: number): string {
    const cwd = makeTempDirectory('wbb-md-audit-');
    symlinkSync(join(ROOT, 'node_modules'), join(cwd, 'node_modules'));
    symlinkSync(join(ROOT, 'scripts'), join(cwd, 'scripts'));
    mkdirSync(join(cwd, 'bin'));
    writeFileSync(join(cwd, 'report.json'), json);
    stub(join(cwd, 'bin'), 'npm', `cat "${join(cwd, 'report.json')}"; exit ${npmExit}`);
    return stub(w.bin, 'audit-real', [
      'set -euo pipefail',
      AUDIT_FN,
      `cd "${cwd}"`,
      `PATH="${join(cwd, 'bin')}:$PATH" _audit_default`,
    ].join('\n'));
  }

  const fx = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

  it('refuses the proxy-addr advisory and names it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = realAudit(w, fx('advisory.json'), 1);
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(notes(w)).toEqual([
      `⛔ merge-deploy refused ${short(x)}: npm audit --omit=dev reports a high or critical advisory.\n`
      + 'proxy-addr critical — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet https://github.com/advisories/GHSA-jqcg-44mw-7w3h',
    ]);
  });

  // The regression: npm exits 1 here too, and this used to refuse the commit for good.
  it('an unreachable registry is "could not run": no LAST_FAILED_SHA, retried', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = realAudit(w, fx('registry-down.json'), 1);
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: npm audit could not run (exit 2) for ${short(x)} — NOT a finding, just no verification. Retrying next tick.\n`
      + 'npm audit could not run: the output reports an error, not an audit: request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9',
    ]);
  });

  it('ENOLOCK is "could not run" too', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = realAudit(w, fx('enolock.json'), 1);
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
  });

  it('a clean audit deploys', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = realAudit(w, fx('clean.json'), 0);
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(0);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  // pipefail: npm exits 1 for ANY advisory under --json; a low-only report must not refuse.
  it('a low-only report deploys although npm exits 1', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const low = JSON.stringify({ auditReportVersion: 2, vulnerabilities: { a: { severity: 'low', via: [] } } });
    const audit = realAudit(w, low, 1);
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(0);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });
});
```

Before relying on the clean/low cases, read the existing happy-path test (`'deploys the head of main once it has been quiet …'`) and confirm that `ready` + `tick` with the default stubs deploys, and that the deploy event is literally `deploy <sha>`. **The code beats this brief:** if the default stubs need more than the `WBB_AUDIT_CMD` override to reach a deploy, mirror what the happy-path test does.

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- scripts/autodeploy/autodeploy.test.ts`
Expected: the advisory test fails (the old `_audit_default` prints npm's raw JSON, not the rendered line). The registry and ENOLOCK tests fail with `LAST_FAILED_SHA` set: that is the bug. The low-only test fails with a refusal.

- [ ] **Step 3: Replace `_audit_default` in `deploy/autodeploy.sh`**

Replace lines 77-79:

```bash
# npm audit's exit 1 = advisories at/above the level; any other non-zero = it
# could not run (I3). Callers keep the two apart.
_audit_default() { npm audit --omit=dev --audit-level=high; }
```

with:

```bash
# npm's exit code cannot tell an advisory from a failure to audit: npm 12 exits 1
# for an advisory, ENOLOCK and an unreachable registry alike (#795). The JSON
# tells them apart; the verdict CLI turns it back into the contract the tick
# branches on — 0 clean, 1 advisory (refuse), 2 could not run (retry). printf,
# not npm, feeds the pipe, so pipefail sees the CLI's status alone. Runs in the
# clone after BUILD_CMD's `npm ci`, so tsx is installed; a missing tsx is 127,
# which reads as "could not run", never as an advisory.
_audit_default() {
  local report
  report=$(npm audit --omit=dev --json 2>/dev/null) || true
  printf '%s' "$report" | ./node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- scripts/autodeploy/autodeploy.test.ts`
Expected: PASS, the new five tests and all existing ones.

- [ ] **Step 5: Mutation check (do not commit it)**

Change the function's body to `npm audit --omit=dev --json 2>/dev/null | ./node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts` (npm feeding the pipe directly). Expected: "a low-only report deploys although npm exits 1" FAILS. Revert.

- [ ] **Step 6: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts
git commit -m "fix(autodeploy): merge-deploy reads the audit verdict from JSON — an outage no longer refuses a commit for good (#795)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: prod-audit reads the verdict

**Files:**
- Modify: `.github/workflows/prod-audit.yml` (new install step; the `Audit production dependencies` step; the headline in `Open or update the issue`; the close comment)
- Modify: `scripts/autodeploy/prod-audit-workflow.test.ts` (rewrite)

**Interfaces:**
- Consumes: `scripts/autodeploy/audit-verdict-cli.ts` (Task 1).
- Step outputs are unchanged: `state` ∈ `clean | vulnerable | unknown`, plus `exit_code`. `audit.txt` now holds the rendered verdict.

- [ ] **Step 1: Rewrite the test** — `scripts/autodeploy/prod-audit-workflow.test.ts`

```ts
import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/prod-audit.yml'), 'utf8');
const fx = (name: string) => readFileSync(resolve(__dirname, 'fixtures/npm-audit', name), 'utf8');

// The audit step's script, de-indented exactly as the runner writes it to a file.
function auditStepScript(): string {
  const m = WORKFLOW.match(/id: audit\n\s+run: \|\n((?: {10}.*\n|\n)+)/);
  if (m === null) throw new Error('audit step not found in prod-audit.yml');
  return m[1].split('\n').map((l) => l.slice(10)).join('\n');
}

// Runs the step under `bash -e`, the shell GitHub uses for `run:` (#789), in a cwd that has
// the repository's node_modules and scripts (the install step's result), with an `npm` stub
// that prints `json` and exits `npmExit` (#795: the real npm exits 1 for all three non-clean cases).
function runAuditStep(json: string, npmExit: number): { status: number | null; output: string; report: string } {
  const dir = makeTempDirectory('prod-audit-');
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'report.json'), json);
  writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\ncat "${join(dir, 'report.json')}"\nexit ${npmExit}\n`);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  writeFileSync(join(dir, 'step.sh'), auditStepScript());
  writeFileSync(join(dir, 'out'), '');
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, 'out') },
  });
  return {
    status: r.status,
    output: readFileSync(join(dir, 'out'), 'utf8'),
    report: readFileSync(join(dir, 'audit.txt'), 'utf8'),
  };
}

describe('prod-audit workflow, audit step under bash -e', () => {
  it('a clean audit is clean', () => {
    expect(runAuditStep(fx('clean.json'), 0)).toEqual({
      status: 0,
      output: 'state=clean\nexit_code=0\n',
      report: 'npm audit: no high or critical advisory in production dependencies\n',
    });
  });

  it('the proxy-addr advisory is vulnerable, and the report names it', () => {
    expect(runAuditStep(fx('advisory.json'), 1)).toEqual({
      status: 0,
      output: 'state=vulnerable\nexit_code=1\n',
      report: 'proxy-addr critical — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet https://github.com/advisories/GHSA-jqcg-44mw-7w3h\n',
    });
  });

  // #795: npm exits 1 here as well; this used to open the issue as "vulnerable".
  it('an unreachable registry is unknown', () => {
    expect(runAuditStep(fx('registry-down.json'), 1)).toEqual({
      status: 0,
      output: 'state=unknown\nexit_code=2\n',
      report: 'npm audit could not run: the output reports an error, not an audit: request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9\n',
    });
  });

  it('ENOLOCK is unknown', () => {
    expect(runAuditStep(fx('enolock.json'), 1).output).toBe('state=unknown\nexit_code=2\n');
  });

  it('a low-only report is clean although npm exits 1', () => {
    const low = JSON.stringify({ auditReportVersion: 2, vulnerabilities: { a: { severity: 'low', via: [] } } });
    expect(runAuditStep(low, 1).output).toBe('state=clean\nexit_code=0\n');
  });
});

describe('prod-audit workflow, structure', () => {
  // tsx for the verdict CLI, without running any package's install script.
  it('installs dependencies with install scripts disabled', () => {
    expect(WORKFLOW).toContain('        run: npm ci --ignore-scripts --no-audit --no-fund\n');
  });

  // The step survives a finding, so the run would go green; the last step keeps it red.
  it('ends with a step that fails the run unless production is clean', () => {
    expect(WORKFLOW.trimEnd().endsWith([
      '      - name: Fail the run when production is not clean',
      "        if: steps.audit.outputs.state != 'clean'",
      '        run: exit 1',
    ].join('\n'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- scripts/autodeploy/prod-audit-workflow.test.ts`
Expected: FAIL. The registry case gives `state=vulnerable`, the reports are npm's raw JSON, and there is no install step.

- [ ] **Step 3: Edit `.github/workflows/prod-audit.yml`**

(a) Between the `actions/setup-node@v7` step and `- name: Audit production dependencies`, insert:

```yaml
      # tsx for the verdict CLI (#795). --ignore-scripts: no package's install
      # script runs, so this job stays as inert as when it installed nothing.
      - name: Install dependencies (no install scripts)
        run: npm ci --ignore-scripts --no-audit --no-fund

```

(b) Replace the audit step's `run: |` body, from `set -uo pipefail` through the line `npm audit --omit=dev --audit-level=high > audit.txt 2>&1 || code=$?`, with:

```yaml
          set -uo pipefail
          # npm's exit code cannot tell an advisory from a failure to audit: npm 12
          # exits 1 for both (#795). The verdict CLI reads the JSON and exits
          # 0 clean / 1 advisory / 2 could not run. printf, not npm, feeds the pipe,
          # so pipefail sees the CLI's status alone. GitHub runs this as `bash -e`:
          # the `||` keeps a non-zero code from killing the step before `state` is
          # written (#789).
          report=$(npm audit --omit=dev --json 2>/dev/null) || true
          code=0
          printf '%s' "$report" | ./node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts > audit.txt 2>&1 || code=$?
```

Keep `cat audit.txt`, the `case` and the `exit_code` line as they are. In the `case`, change the comment above `*)` to:

```yaml
            # The audit did not produce a report (registry outage, ENOLOCK, a CLI
            # crash): we do NOT know whether production is exposed. Silence here
            # is exactly the failure this workflow exists to prevent, so it is
            # reported — but as what it is.
```

(c) In `Open or update the issue`, change the vulnerable headline to:

```
            headline='`npm audit --omit=dev` reports a high or critical advisory in a **production** dependency on `main`.'
```

Change the unknown headline to:

```
            headline="**The audit could not run** (verdict exit ${EXIT_CODE}). This is not a finding about production — it means we currently do not know whether production is exposed."
```

(d) In `Close the issue when production is clean`, change the comment text to ``'`npm audit --omit=dev` is clean again.'``.

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- scripts/autodeploy/prod-audit-workflow.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (do not commit it)**

In the step, replace `case "$code"`'s `1)` arm with `1|2)`. Expected: the registry and ENOLOCK tests FAIL. Revert.

- [ ] **Step 6: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add .github/workflows/prod-audit.yml scripts/autodeploy/prod-audit-workflow.test.ts
git commit -m "fix(ci): prod-audit reads the audit verdict from JSON — an outage is unknown, not vulnerable (#795)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Correct the premise in the specs

**Files:**
- Modify: `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md` (step 3, lines ~87-90)
- Modify: `spec.md` §5.9 (the merge-deploy bullet, line ~2745)

- [ ] **Step 1: merge-deploy design, step 3**

Replace:

```
   `npm audit --omit=dev --audit-level=high` (moved here from the tag path; exit 1 = refuse, any other
   non-zero = refuse with "could not verify", as I3 today). A failure leaves production untouched →
   ⛔ + `LAST_FAILED_SHA=X`.
```

with:

```
   `npm audit --omit=dev --json`, judged by the verdict CLI (#795, which corrected this step: npm exits
   1 for an advisory, ENOLOCK and an unreachable registry alike, so the exit code was never evidence).
   A high/critical advisory → refuse: ⛔ + `LAST_FAILED_SHA=X`. No report at all → "could not run",
   no `LAST_FAILED_SHA`, retried next tick. A failed build leaves production untouched →
   ⛔ + `LAST_FAILED_SHA=X`.
```

- [ ] **Step 2: `spec.md` §5.9**

Replace:

```
  Мердж — це дозвіл: право писати в `main` означає прод. Перед деплоєм: збірка й `npm audit` у
  клоні, знімок БД
```

with:

```
  Мердж — це дозвіл: право писати в `main` означає прод. Перед деплоєм: збірка й `npm audit` у
  клоні (вердикт — з JSON-звіту, не з коду виходу: high/critical → відмова, звіту нема → повтор
  на наступному тіку, #795), знімок БД
```

Check that the edited lines still wrap like their neighbours. Fix the wrapping if not.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md spec.md
git commit -m "docs: the audit verdict comes from JSON, not npm's exit code (#795)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks (controller)

- Whole-branch review; rebase on `origin/main`; full gate; codex cross-review in the background.
- PR title: `[deploy:hold] fix: audit verdict from the JSON report (#795)`, label `deploy:hold`. The description lists the human steps:
  1. on the host, `sudo bash deploy/install-autodeploy.sh` (installs the new `wbb-autodeploy` copy);
  2. `bash deploy/deploy.sh`.
- After the merge: `gh workflow run prod-audit.yml` must be green, with the install step passing.

## Execution note (whole-branch review)

The final review found that the CLI's "a crash never exits 1" guarantee was false: Node exits 1
on any uncaught load or transform error before the CLI's `try` runs, which merge-deploy would
read as an advisory. The CLI contract shipped as **0 clean / 10 advisory / anything else could
not run**, and both shell callers map it back (`_audit_default` returns 0/1/2 so the tick's
branches are unchanged; the workflow's `case` is 0/10/*). The prod-audit install step also got
`continue-on-error: true`. The spec describes the shipped contract; the task texts above keep
the original 0/1/2 wording as written.
