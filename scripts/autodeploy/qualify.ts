/**
 * #435 — the qualification verdict for a Dependabot pull request.
 *
 * Everything here is measured from two `npm audit --omit=dev --json` reports,
 * never from Dependabot metadata: `dependency-type` cannot tell production from
 * development for TRANSITIVE packages, and both advisories open when this was
 * written were transitive. A metadata rule would have been wrong on 100% of the
 * available evidence.
 *
 * Pure by design — the workflow does the fetching, so every branch is testable.
 */

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

/** The shape we consume from `npm audit --json` (`.vulnerabilities`). */
export interface AuditReport {
  vulnerabilities: Record<string, { severity: Severity }>;
}

export type Verdict =
  | { verdict: 'autodeploy'; reason: string }
  | { verdict: 'hold'; reason: string }
  | { verdict: 'manual'; reason: string };

/** How long a `high` fix must have been published before it may deploy unattended. */
export const HOLD_HOURS = 48;

const ACTIONABLE: Severity[] = ['high', 'critical'];

function actionable(r: AuditReport): { name: string; severity: Severity }[] {
  return Object.entries(r.vulnerabilities)
    .filter(([, v]) => ACTIONABLE.includes(v.severity))
    .map(([name, v]) => ({ name, severity: v.severity }));
}

export function qualify(params: {
  base: AuditReport;
  head: AuditReport;
  /** Publish time of the YOUNGEST fixing version in this PR. */
  publishedAt: Date;
  now: Date;
}): Verdict {
  const { base, head, publishedAt, now } = params;

  const before = actionable(base);
  if (before.length === 0) {
    return { verdict: 'manual', reason: 'base has no high or critical production advisory' };
  }

  const after = actionable(head);
  if (after.length > 0) {
    const names = after.map((v) => v.name).join(', ');
    return { verdict: 'manual', reason: `head is still vulnerable: ${names}` };
  }

  // Severity comes from the base report — already in hand, one artifact, no
  // second source to disagree with. Highest wins.
  const critical = before.some((v) => v.severity === 'critical');
  const fixed = before.map((v) => v.name).join(', ');

  if (critical) {
    return { verdict: 'autodeploy', reason: `critical production advisory cleared: ${fixed}` };
  }

  const ageHours = (now.getTime() - publishedAt.getTime()) / 3600_000;
  if (ageHours < HOLD_HOURS) {
    const left = Math.ceil(HOLD_HOURS - ageHours);
    return {
      verdict: 'hold',
      reason: `high advisory cleared (${fixed}) but the fixing version is ${Math.floor(ageHours)}h old; ${HOLD_HOURS}h hold, ~${left}h left`,
    };
  }

  return { verdict: 'autodeploy', reason: `high production advisory cleared: ${fixed}` };
}
