# Test temporary cleanup migrations

**Spec:** ../../specs/2026-09/2026-09-29-test-temp-cleanup-design.md
**Core review:** helper registers each successful allocation before caller setup;
root afterAll covers collection, beforeAll and beforeEach failures and preserves
shared lifetime. Cleanup attempts all owned paths and reports aggregate failures.
Child tests prove successful and failed lifecycle cleanup with exact exit status,
specific failure markers and an empty resource directory. Framework transform-cache
files have a distinct scratch directory; they are not evidence of helper leakage.

Execution is inline per AGENTS.md. No production changes or deployment.

- [x] Replace leaky `mkdtempSync(join(tmpdir(), '<prefix>'))` with
  `makeTempDirectory('<prefix>')`, importing from ../test-temp for autodeploy and
  ai-review suites, ./test-temp for top-level script suites. Remove only unused
  mkdtemp/tmpdir imports. Preserve all test assertions and fixture contents.
- [x] Files: autodeploy/{autodeploy,guard,installed-current,qualify-cli,read-env,
  record-deployed,ships}.test.ts; ai-review/verify-corpus-run.test.ts;
  {set-env,ai-pr-review,cws-auth-bootstrap}.test.ts. Existing sound cleanup sites
  elsewhere are unchanged; allocation registry now covers setup failures here.
- [x] Replay migrated suites under private TMPDIR. Assert no wbb-, setenv-,
  ai-review-symlink- or cws-auth-bootstrap-test- roots remain. Keep framework cache
  distinguishable and remove only this explicitly owned probe tree in finally.
- [x] After operational inode relief: npm test && npm run typecheck, review diff,
  commit, fetch/rebase origin/main, repeat gate if rebased, push/open PR, wait for
  checks and AI review, resolve valid findings. Write final operational report.
