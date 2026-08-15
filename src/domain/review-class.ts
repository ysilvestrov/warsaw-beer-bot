// Leaf module, deliberately dependency-free. Both triage-analysis.ts and
// triage-scope.ts need REVIEW_CLASSES; having either module export it to the other
// created a real two-file circular value dependency (#408 — fatal at load time under
// this project's test runner, which fully evaluates a module's static imports before
// running its own top-level code). Giving REVIEW_CLASSES its own leaf module breaks
// the cycle at its root instead of working around it.
export const REVIEW_CLASSES = [
  'parser_bug', 'matcher_bug', 'not_on_untappd', 'unidentifiable', 'not_a_beer',
] as const;
