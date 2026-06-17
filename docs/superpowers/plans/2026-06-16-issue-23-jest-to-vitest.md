# Plan: issue #23 — migrate jest+ts-jest → vitest to drop deprecated transitive deps

## Goal
`npm ci` deprecation warnings reduced from 5 → 2. Removing jest+ts-jest eliminates
`inflight@1.0.6`, `glob@7.2.3`, and `glob@10.5.0` (all jest coverage/internals).
The remaining `whatwg-encoding` (cheerio, runtime) and `prebuild-install`
(better-sqlite3, install-time) are runtime deps locked to upstream — out of scope.

Acceptance (from issue): `npm ci` with fewer deprecation warnings, all tests green,
no prod-deploy regression.

## Context / facts established
- Root project only (extension already uses vitest@2 with `globals: true`).
- 73 test files under `src/**` + `scripts/**`. They use ONLY global `describe/it/expect`
  plus `jest.fn` (8 files) and the `jest.Mock` type (1 file: `src/bot/commands/lang.test.ts`).
- NO usage of: `jest.mock`, `jest.spyOn`, fake timers, `@jest/globals`, `jest.setTimeout`,
  `jest.mocked`, `jest.requireActual`. Confirmed by grep.
- `jest.config.js`: ts-jest preset, node env, roots `src`/`tests`/`scripts`,
  testMatch `**/*.test.ts`, `isolatedModules: true` (transpile-only).
- `tsconfig.json` has `"types": ["node", "jest"]`.
- `package.json`: `"test": "jest"`, devDeps include `jest`, `ts-jest`, `@types/jest`.
- No GitHub Actions workflow runs the test suite (`.github/workflows/` has only codex-review).
- `deploy.sh` runs `npm prune --omit=dev`; vitest is a devDep → no prod runtime impact.
- `better-sqlite3` is a native addon used in storage tests → vitest must use a fork-based
  pool (vitest 2.x default `pool: 'forks'` is fine; verify storage tests pass).
- spec.md references jest at line ~63 (tech table) and ~752 (testing section); line ~897
  is the extension (already vitest, leave it). CLAUDE.md "Testing" line says "(Jest)".

## Task 1 — Vitest tooling + test-source migration (single cohesive task)
The migration is tightly coupled (tests can't run until vitest is fully wired), so it is
one task with two-stage review.

Steps:
1. `package.json`: remove `jest`, `ts-jest`, `@types/jest` from devDependencies; add
   `vitest` (^2, match extension) to devDependencies. Change `"test": "jest"` →
   `"test": "vitest run"`. Keep `typecheck`/`build` (tsc) unchanged — type safety still
   comes from `tsc`, exactly as the old transpile-only jest setup intended.
2. Add `vitest.config.ts` at repo root:
   - `test.environment: 'node'`
   - `test.globals: true`
   - `test.include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']`
   - `test.pool: 'forks'` (explicit, for better-sqlite3 native-addon safety)
3. Delete `jest.config.js`.
4. `tsconfig.json`: change `"types": ["node", "jest"]` → `["node", "vitest/globals"]`.
5. Replace `jest.fn` → `vi.fn` in the 8 files. With `globals: true`, `vi` is a global;
   if TS can't resolve `vi` as a global, import `{ vi }` from `'vitest'` in those files.
   In `src/bot/commands/lang.test.ts` replace the `jest.Mock` type with vitest's `Mock`
   (`import type { Mock } from 'vitest'`) or `ReturnType<typeof vi.fn>`.
6. Run `npm install` to refresh the lockfile, then `npm test` — ALL 73 files must pass.
7. Run `npm run build` (tsc) — must compile clean (proves no type regression).
8. Run `npm ci` fresh and confirm only `whatwg-encoding` + `prebuild-install` deprecation
   warnings remain (the 3 jest-chain warnings are gone).

## Task 2 — Docs/spec sync (CLAUDE.md mandates spec.md + project-doc updates)
1. `spec.md`: tech-stack table row → `| Тести | **Vitest** | unit + контрактні тести |`;
   testing section "базовими Jest-тестами" → "базовими Vitest-тестами". Leave the
   extension line (~897) untouched.
2. `CLAUDE.md`: "Testing" line `(Jest)` → `(Vitest)`.
3. No `docs/extension-install-uk.md` change (no extension/user-facing change).

## Verification (must show evidence, not assertion)
- `npm test` output: 73 files / all tests passed.
- `npm run build` exits 0.
- `npm ci 2>&1 | grep deprecated` shows exactly 2 lines (whatwg-encoding, prebuild-install).
- `git grep -n "jest" -- ':!*.md' ':!package-lock.json'` returns nothing meaningful
  (no leftover jest references in code/config).
