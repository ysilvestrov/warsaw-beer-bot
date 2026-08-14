# Issue #411 Runtime Dependency Upgrades Design

## Objective

Clear every production vulnerability currently reported by
`npm audit --omit=dev` while keeping the dependency change as narrow and
compatible as possible.

The vulnerable direct dependencies and minimum patched versions are:

- `undici`: `7.28.0` → `7.29.0`
- `hono`: `4.12.26` → `4.12.34`
- `@hono/node-server`: `2.0.4` → `2.0.10`

## Decision

Upgrade each dependency to its minimum patched release and preserve the
repository's existing caret-range policy:

```json
{
  "@hono/node-server": "^2.0.10",
  "hono": "^4.12.34",
  "undici": "^7.29.0"
}
```

Install those versions explicitly so `package-lock.json` resolves to the chosen
minimums instead of opportunistically moving to newer compatible releases.
Reject both a latest-compatible update and an `overrides`-only workaround: the
former broadens compatibility risk, while the latter leaves the direct
dependency requirements misleading.

## Scope

The intended implementation changes only `package.json` and the corresponding
package records in `package-lock.json`. Lockfile churn must be limited to the
three selected packages and metadata npm must update for them.

Production source and tests remain unchanged unless the upgraded packages expose
a concrete compatibility failure. No extension files or extension changelog are
in scope because the browser extension is not being changed.

## Compatibility Surface

The Hono upgrade must preserve:

- construction of `Hono<ApiEnv>` and all registered middleware and routes;
- `GET /health`, wildcard CORS, authentication, and request body limits;
- `@hono/node-server` startup on loopback;
- access to the returned Node HTTP server so `keepAliveTimeout` and
  `headersTimeout` remain configurable;
- graceful server shutdown.

The Undici upgrade must preserve:

- `ProxyAgent` construction from the normalized Webshare URL;
- the `Dispatcher` interface used by the rotating proxy abstraction;
- best-effort agent closure during rotation and application shutdown;
- existing HTTP client behavior for external sources.

The selected releases stay within the current major versions and support the
project's Node.js 20 runtime. No API migration is expected.

## Verification

The dependency audit is the proof-first regression signal: before the change it
must fail with the advisories recorded in issue #411; after the change it must
report zero known production vulnerabilities.

Compatibility is verified with the existing focused tests for the API server,
payload middleware, Hono routes, proxy rotation, HTTP clients, and shutdown.
No synthetic regression test is added solely to assert package versions because
the manifest, lockfile, and audit already provide the direct contract.

The final verification set is:

1. `npm audit --omit=dev`
2. `npm test`
3. `npm run typecheck`
4. `npm run build`
5. Local API startup, `GET /health`, and clean shutdown smoke test
6. `git diff --check` and review of dependency-only lockfile scope

Production deployment and its systemd/health verification remain a separate,
explicitly authorized step after merge.

## Acceptance Criteria

- The manifest declares the three agreed minimum patched versions.
- The lockfile resolves those versions without unrelated dependency churn.
- `npm audit --omit=dev` reports zero production vulnerabilities.
- Tests, typecheck, build, and local API lifecycle smoke checks pass.
- No application behavior, architecture, or extension artifact changes unless a
  verified compatibility failure makes a focused adjustment necessary.
