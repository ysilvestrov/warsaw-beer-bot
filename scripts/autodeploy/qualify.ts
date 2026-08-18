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

/**
 * The single measurement `qualify()` and `needsHoldCheck()` both act on —
 * extracted so the two can never quietly drift apart. Whether a PR's fix
 * needs the 48h age check depends on exactly these three facts: is the base
 * actually vulnerable, is the head clean, and is the highest base severity
 * `critical` (which skips the hold entirely). Computing that twice, by hand,
 * in two functions is how the two answers stop agreeing.
 */
type FixStatus =
  | { kind: 'clean' }
  | { kind: 'still-vulnerable'; names: string[] }
  | { kind: 'cleared'; critical: boolean; fixed: string[] };

function assessFix(base: AuditReport, head: AuditReport): FixStatus {
  const before = actionable(base);
  if (before.length === 0) {
    return { kind: 'clean' };
  }

  const after = actionable(head);
  if (after.length > 0) {
    return { kind: 'still-vulnerable', names: after.map((v) => v.name) };
  }

  // Severity comes from the base report — already in hand, one artifact, no
  // second source to disagree with. Highest wins.
  const critical = before.some((v) => v.severity === 'critical');
  return { kind: 'cleared', critical, fixed: before.map((v) => v.name) };
}

/**
 * True only when the verdict actually depends on the fix's age: the base has
 * an actionable (high/critical) advisory, the head has none, and the highest
 * base severity is NOT `critical` (a cleared critical skips the hold and
 * needs no publish time at all).
 *
 * This exists so a caller can skip computing a publish time it will never
 * use. Before this, `qualify-cli.ts` called `selectPublishedAt` — an npm
 * registry lookup per changed package — unconditionally, even for a PR
 * whose base audit is clean and can therefore only ever qualify as `manual`.
 * A 13-package non-security bump paid for 13 wasted registry requests every
 * hourly re-evaluation, forever, for a decision that never depended on any
 * of them — wasted traffic, and a needless flakiness surface (a registry
 * hiccup failing a run whose verdict never depended on the registry).
 */
export function needsHoldCheck(base: AuditReport, head: AuditReport): boolean {
  const status = assessFix(base, head);
  return status.kind === 'cleared' && !status.critical;
}

export function qualify(params: {
  base: AuditReport;
  head: AuditReport;
  /**
   * Publish time of the YOUNGEST fixing version in this PR, or `null` when
   * the caller determined (via `needsHoldCheck`) that no age check would be
   * needed. `qualify()` re-derives that same determination itself from
   * `base`/`head` — if it disagrees and reaches the age computation with
   * `null` anyway, that is a bug in the caller's `needsHoldCheck` call, and
   * this throws rather than silently treating `null` as "now" or "long ago".
   */
  publishedAt: Date | null;
  now: Date;
}): Verdict {
  const { base, head, publishedAt, now } = params;

  const status = assessFix(base, head);

  if (status.kind === 'clean') {
    return { verdict: 'manual', reason: 'base has no high or critical production advisory' };
  }

  if (status.kind === 'still-vulnerable') {
    const names = status.names.join(', ');
    return { verdict: 'manual', reason: `head is still vulnerable: ${names}` };
  }

  const { critical, fixed } = status;
  const fixedStr = fixed.join(', ');

  if (critical) {
    return { verdict: 'autodeploy', reason: `critical production advisory cleared: ${fixedStr}` };
  }

  if (publishedAt === null) {
    // needsHoldCheck(base, head) must have returned true for `qualify` to
    // reach here with a non-critical cleared advisory — if the caller
    // nonetheless passed `null`, needsHoldCheck and qualify have disagreed
    // about whether this verdict depends on the fix's age. That is a bug
    // worth a loud failure, not a silent "now" or "long ago".
    throw new Error(
      `qualify: reached the age computation with publishedAt=null for a cleared, non-critical ` +
        `advisory (${fixedStr}) — needsHoldCheck(base, head) and qualify(...) disagree about ` +
        `whether this verdict needs a hold check. base vulnerabilities: ` +
        `${JSON.stringify(Object.keys(base.vulnerabilities))}, head vulnerabilities: ` +
        `${JSON.stringify(Object.keys(head.vulnerabilities))}.`,
    );
  }

  const ageHours = (now.getTime() - publishedAt.getTime()) / 3600_000;
  // A non-finite age (e.g. an invalid `publishedAt`) must never fall through
  // to autodeploy — qualify() is the gate and cannot depend on its caller
  // for a NaN check.
  if (!Number.isFinite(ageHours)) {
    return {
      verdict: 'hold',
      reason: `high advisory cleared (${fixedStr}) but the fixing version's publish time is unknown; ${HOLD_HOURS}h hold, treated as just published`,
    };
  }
  if (ageHours < HOLD_HOURS) {
    const left = Math.ceil(HOLD_HOURS - ageHours);
    return {
      verdict: 'hold',
      reason: `high advisory cleared (${fixedStr}) but the fixing version is ${Math.floor(ageHours)}h old; ${HOLD_HOURS}h hold, ~${left}h left`,
    };
  }

  return { verdict: 'autodeploy', reason: `high production advisory cleared: ${fixedStr}` };
}
