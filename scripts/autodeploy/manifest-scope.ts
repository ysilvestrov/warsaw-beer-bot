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

/** `dependencies` and `devDependencies` of a `package.json`, kept apart. */
export interface DepSections {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export function manifestScope(params: {
  changedPaths: string[];
  base: DepSections;
  head: DepSections;
}): { ok: boolean; violations: string[] } {
  const { changedPaths, base, head } = params;
  const violations: string[] = [];

  for (const p of changedPaths) {
    if (!ALLOWED_PATHS.includes(p)) violations.push(`path outside the allowlist: ${p}`);
  }

  // Merged view, for name-level presence/absence and range-operator checks —
  // those don't care which section a package lives in.
  const baseAll = { ...base.dependencies, ...base.devDependencies };
  const headAll = { ...head.dependencies, ...head.devDependencies };

  for (const name of Object.keys(headAll)) {
    if (!(name in baseAll)) violations.push(`dependency added: ${name}`);
  }
  for (const name of Object.keys(baseAll)) {
    if (!(name in headAll)) violations.push(`dependency removed: ${name}`);
  }

  for (const [name, headSpec] of Object.entries(headAll)) {
    const baseSpec = baseAll[name];
    if (baseSpec === undefined) continue;
    const a = rangeOperator(baseSpec);
    const b = rangeOperator(headSpec);
    if (a !== b) {
      violations.push(`range operator changed for ${name}: "${a || '(pinned)'}" → "${b || '(pinned)'}"`);
    }
  }

  // A package that moves between `dependencies` and `devDependencies` is
  // invisible to the merged view above, yet it changes what `npm audit
  // --omit=dev` sees: moving a base-vulnerable package into devDependencies
  // makes the head audit read clean because the package left production, not
  // because it was fixed — base-vulnerable + head-clean is exactly the
  // pattern that reads as "qualify()'s job done, autodeploy". Catch the move
  // itself, independent of the range-operator check above.
  for (const name of Object.keys(baseAll)) {
    if (!(name in headAll)) continue; // already reported as removed
    const wasProd = name in base.dependencies;
    const wasDev = name in base.devDependencies;
    const isProd = name in head.dependencies;
    const isDev = name in head.devDependencies;
    if (wasProd && isDev && !isProd) {
      violations.push(`dependency moved from dependencies to devDependencies: ${name}`);
    } else if (wasDev && isProd && !isDev) {
      violations.push(`dependency moved from devDependencies to dependencies: ${name}`);
    }
  }

  return { ok: violations.length === 0, violations };
}
