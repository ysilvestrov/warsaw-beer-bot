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

/** Every severity npm audit emits; an entry carrying anything else is not evidence. */
const SEVERITIES: readonly Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

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
  for (const [name, entry] of Object.entries(v)) {
    const e = entry as { severity?: unknown; via?: unknown } | null;
    const wellFormed =
      typeof e === 'object' && e !== null && !Array.isArray(e) &&
      SEVERITIES.includes(e.severity as Severity) &&
      (e.via === undefined || Array.isArray(e.via));
    if (!wellFormed) return { error: `has a malformed entry for "${name}" — not a well-formed audit report` };
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

/**
 * The contract deploy/autodeploy.sh and prod-audit.yml branch on: 0 clean, 10 advisory,
 * 2 could not run. 10, not 1: Node itself exits 1 on any uncaught load or transform error,
 * so 1 must never mean advisory.
 */
export function verdictExitCode(v: AuditVerdict): 0 | 10 | 2 {
  switch (v.kind) {
    case 'clean':
      return 0;
    case 'advisory':
      return 10;
    case 'unrunnable':
      return 2;
  }
}
