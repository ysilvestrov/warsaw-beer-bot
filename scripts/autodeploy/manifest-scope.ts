/**
 * #435 — the manifest-scope check.
 *
 * Two rules: the pull request touches only the root manifest and lockfile, and
 * every dependency keeps the range OPERATOR it had. The caret policy comes from
 * the #411 design ("preserve the repository's existing caret-range policy"),
 * where it lived only as a sentence somebody had to remember.
 *
 * This is also the check one would reach for an LLM to eyeball, which is exactly
 * why it is code: it must fail the same way every time.
 */

/** The only paths an unattended deploy may carry. Not `extension/**` — the extension never ships to the server. */
export const ALLOWED_PATHS = ['package.json', 'package-lock.json'];

/** The leading non-digit run of a semver spec: `^`, `~`, `>=`, or `` for a pin. */
export function rangeOperator(spec: string): string {
  // `[^0-9]*` matches every string (the empty run included), so `exec` never
  // returns null — there is no false branch to handle.
  return /^[^0-9]*/.exec(spec)![0].trim();
}

export function manifestScope(params: {
  changedPaths: string[];
  /** Merged `dependencies` + `devDependencies` of the base `package.json`. */
  base: Record<string, string>;
  head: Record<string, string>;
}): { ok: boolean; violations: string[] } {
  const { changedPaths, base, head } = params;
  const violations: string[] = [];

  for (const p of changedPaths) {
    if (!ALLOWED_PATHS.includes(p)) violations.push(`path outside the allowlist: ${p}`);
  }

  for (const name of Object.keys(head)) {
    if (!(name in base)) violations.push(`dependency added: ${name}`);
  }
  for (const name of Object.keys(base)) {
    if (!(name in head)) violations.push(`dependency removed: ${name}`);
  }

  for (const [name, headSpec] of Object.entries(head)) {
    const baseSpec = base[name];
    if (baseSpec === undefined) continue;
    const a = rangeOperator(baseSpec);
    const b = rangeOperator(headSpec);
    if (a !== b) {
      violations.push(`range operator changed for ${name}: "${a || '(pinned)'}" → "${b || '(pinned)'}"`);
    }
  }

  return { ok: violations.length === 0, violations };
}
