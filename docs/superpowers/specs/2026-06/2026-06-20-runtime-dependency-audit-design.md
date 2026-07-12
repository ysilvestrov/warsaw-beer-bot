# Runtime Dependency Audit Fix Design

## Goal

Clear the two production dependency findings reported by `npm audit --omit=dev` without changing application behavior or addressing dev-only advisories.

## Scope

- Update `hono` from the vulnerable `<4.12.25` resolution to a safe compatible release.
- Update the transitive `undici` dependency pulled through `cheerio` from the vulnerable `<7.28.0` resolution to a safe compatible release.
- Keep root and extension dev-only findings out of scope; they will be handled separately.
- Do not change application code, APIs, deployment configuration, or architecture.

## Approach

Use npm's normal dependency resolver to refresh only the affected lockfile entries within existing semver-compatible dependency ranges. Prefer a lockfile-only update. Add `package.json` overrides only if npm cannot resolve safe versions naturally; do not run a broad audit fix that changes unrelated packages.

## Verification

The existing failing `npm audit --omit=dev` result is the regression check. Completion requires:

1. `npm audit --omit=dev` reports zero vulnerabilities.
2. `npm test` passes the full bot/API suite.
3. `npm run build` succeeds.
4. The dependency diff contains only changes needed for `hono` and `undici` resolution.

## Delivery

Implement in the isolated `fix/runtime-dependency-audit` worktree. After verification, create a focused pull request. Deployment occurs only after merge and an explicit deployment request or confirmation.
