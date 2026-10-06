# #795 — one audit verdict, read from the JSON report

## Problem

Three places run `npm audit --omit=dev` and decide what it means. Two of them decide
by the **exit code**, on the premise *"exit 1 = advisories at/above the level; any other
non-zero = it could not run"*:

| Caller | Decides by | Today |
|---|---|---|
| `.github/workflows/dependabot-qualify.yml` → `qualify-cli.ts` `auditReport()` | the JSON: `error` key or no `vulnerabilities` → error | correct |
| `deploy/autodeploy.sh` (merge-deploy, step 3 of `2026-09-30-merge-deploy-design.md`) | exit 1 → `refuse`; other non-zero → "could not run, retrying next tick" | **wrong** |
| `.github/workflows/prod-audit.yml` (#435, fixed to survive in #794) | exit 1 → `state=vulnerable`; other → `unknown` | **wrong** |

The premise is false. npm 12.0.2, probed 2026-10-06:

| Case | Exit | stdout with `--json` |
|---|---|---|
| clean (`main` after #788) | 0 | `{"auditReportVersion":2,"vulnerabilities":{},"metadata":{…"high":0,"critical":0…}}` |
| real advisory (lockfile at `46acac2`, proxy-addr 2.0.7) | 1 | `vulnerabilities["proxy-addr"]` with `severity:"critical"`, `via:[{title,url,severity,…}]` |
| no lockfile | **1** | `{"error":{"code":"ENOLOCK","summary":…,"detail":…}}` |
| registry unreachable (`--registry=http://127.0.0.1:9`) | **1** | `{"message":"request to … failed …","error":{"summary":"","detail":""}}` |

The "other non-zero" branch is effectively unreachable. Consequences:

- **merge-deploy:** a registry blip during a tick goes to `refuse`, which notifies
  "⛔ refused …: reports a high or critical advisory" (false) **and sets
  `LAST_FAILED_SHA`**, so that merge is never retried. Deploys stall until the next
  commit lands on `main`. The designed "could not run, retrying" path never fires.
- **prod-audit:** an outage opens the advisory issue with the "vulnerable" headline
  instead of the "could not run" one.

## Design

### The verdict module

`scripts/autodeploy/audit-verdict.ts`, pure, no I/O:

```ts
export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
export interface AuditReport { vulnerabilities: Record<string, { severity: Severity }> }
export type AuditVerdict =
  | { kind: 'clean' }
  | { kind: 'advisory'; findings: Finding[] }   // ≥ 1 high/critical package
  | { kind: 'unrunnable'; reason: string };     // npm did not produce an audit
export function parseAuditReport(stdout: string): AuditReport | { error: string };
export function auditVerdict(stdout: string): AuditVerdict;
export function renderVerdict(v: AuditVerdict): string;
```

- **Parse** (moved from `qualify-cli.ts` `auditReport()`, same rules): empty stdout,
  unparseable JSON, an `error` key, or a missing `vulnerabilities` object → not an audit.
  The reason names which, plus npm's `error.code`/`error.summary`/`message` when present.
- **Classify**: a package entry whose `severity` is `high` or `critical` is a finding.
  This is the same set as `qualify.ts` `ACTIONABLE`, and `--audit-level=high` uses the
  same threshold. `Severity`, `AuditReport` and the actionable filter **move** here, and
  `qualify.ts` imports them, so the two can no longer drift.
- **The exit code is not an input.** With `--json` and no `--audit-level`, npm exits 1
  for any advisory at all, including `low`. The JSON is the only thing that tells
  advisory and failure apart.
- **Finding** = `{ name, severity, advisories: { title, url }[], via: string[] }`. The
  advisories are the object entries of `via`. A package vulnerable through another one
  lists that package's name in the separate `via` list (the string entries). Render shows
  both: `cr critical — T U; via x`.
- **Render** gives one line per finding, `proxy-addr critical — <title> <url>`, or the
  unrunnable reason. This replaces npm's raw text in the Telegram notice and in the
  prod-audit issue body.

### The CLI contract

`scripts/autodeploy/audit-verdict-cli.ts` reads npm's stdout on stdin, prints
`renderVerdict`, and exits **0 clean / 10 advisory / 2 unrunnable**. Advisory is 10, not 1, because Node
itself exits 1 on any uncaught load or transform error (a failed import, a broken tsx),
so 1 must never mean advisory. Callers treat anything other than 0 and 10 as could not
run. The merge-deploy tick keeps its own contract (0 / 1 refuse / other retry) by mapping
the CLI code back in `_audit_default`; prod-audit branches on the CLI code directly.

### Callers

- **merge-deploy** (`deploy/autodeploy.sh`):
  ```bash
  _audit_default() {
    local report rc=0
    report=$(npm audit --omit=dev --json 2>/dev/null) || true
    printf '%s' "$report" | ./node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts || rc=$?
    case "$rc" in
      0) return 0 ;;
      10) return 1 ;;
      *) return 2 ;;
    esac
  }
  ```
  `printf` feeds the pipe so `pipefail` sees only the CLI's status; 10 is advisory
  because Node exits 1 on its own crashes, which must read as could not run.
  It runs in the clone after `BUILD_CMD` (`npm ci`), so `tsx` is installed. The CLI
  comes from the commit being deployed, which merge-deploy already trusts with
  everything else ("a merge is permission"). The
  comment at `:77` is rewritten. **This is a hold path:** the PR carries
  `[deploy:hold]`, and the human step is `sudo bash deploy/install-autodeploy.sh`,
  then `bash deploy/deploy.sh`.
- **prod-audit** (`.github/workflows/prod-audit.yml`): `npm ci --ignore-scripts`
  first, for `tsx`. No install script runs, so the step stays as inert as today's
  install-free one. The install step is `continue-on-error`, so an install outage reaches the
  verdict step as a missing tsx (127), which is `unknown` and opens the issue. Then the same pipe, and a `case` on 0 / 10 / `*`. The issue
  body shows the rendered findings or the reason.
- **dependabot-qualify** (`qualify-cli.ts`): `auditReport(dir)` calls
  `parseAuditReport` and keeps throwing on a non-audit. No change in what passes or fails;
  error text changes (ENOLOCK reads `ENOLOCK — <summary>`, non-JSON reads 'is not JSON'
  instead of a SyntaxError, a null/array `vulnerabilities` is rejected up front).

### Spec corrections

- `2026-09-30-merge-deploy-design.md` step 3: the parenthesis "exit 1 = refuse, any
  other non-zero = refuse with 'could not verify'" becomes "the JSON verdict
  (#795): advisory → refuse; unrunnable → 'could not run', retried next tick, no
  `LAST_FAILED_SHA`". This matches what the code always did for its non-1 branch.
- `spec.md` §5.9 says only "збірка й `npm audit` у клоні". One sentence is added there:
  the verdict is read from the JSON, and a failure to audit is retried rather than
  refused.

## Claims and evidence

| Claim written as fact | Evidence |
|---|---|
| An `error` key means npm produced no audit | Probe: `ENOLOCK` and the dead registry both carry `error`; the clean and advisory reports do not |
| A report with a `vulnerabilities` object and no `error` is authoritative | Probe: clean → `{}`, advisory → the proxy-addr entry; matches `metadata.vulnerabilities` counts |
| A package's `severity` is the highest of its advisories | npm's documented report v2 field; the probe entry `critical` = its only advisory's `critical`. The rule only compares against `high`, so the max is all it needs |
| High/critical in the JSON = what `--audit-level=high` fails on | npm's definition of `--audit-level` (fail at or above the level). Tests pin the boundary on our side: a `moderate`-only report is `clean`, a `high` one is `advisory` |
| The exit code adds nothing once the JSON is read | Probe: exit 1 occurs in all three non-clean cases, so it separates nothing |

Fixtures are the four probe outputs, saved verbatim under `scripts/autodeploy/fixtures/npm-audit/`
(`clean.json`, `advisory.json`, `enolock.json`, `registry-down.json`; the registry URL in the
dead-registry message stays as captured).

## Testing

- `audit-verdict.test.ts`: each fixture gives its verdict. An advisory fixture edited to
  `moderate` only gives `clean`. Empty stdout, non-JSON, and JSON with no
  `vulnerabilities` give `unrunnable` with the matching reason. A string-only `via`
  entry renders its upstream names. `renderVerdict` output is asserted exactly.
- CLI: stdin → exit code and stdout, for each fixture.
- `autodeploy.test.ts`: the existing refuse and could-not-run tests stay. A new test
  runs the real `_audit_default`, extracted with `sed` as the `path_is_held` test
  does, with an `npm` stub printing each fixture. Advisory gives `refuse`. The
  dead-registry fixture gives the could-not-run notice **and no `LAST_FAILED_SHA`**:
  that is the regression this issue is about.
- `prod-audit-workflow.test.ts`: the `npm` stub prints fixtures, the step runs under
  `bash -e`, and `GITHUB_OUTPUT` is `vulnerable` / `unknown` / `clean`. The
  dead-registry fixture must give `unknown`.
- `qualify-cli` tests stay green unchanged. They pin that the move kept behaviour.

## Out of scope

- The `/report` bug-report prompt and the severity doc: not audit consumers.
- Retrying a failed audit inside one tick. The next tick already retries.
