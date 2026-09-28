# #611 match-cache review corrections

1. Reproduce delayed cache writes with a new nonempty token, backend A/B/ABA switches with unchanged credentials, ordinary sync start during match, and failed deletion followed by reading retained personal entries.
2. Add binding metadata to worker results and validate it on single/batch/conditional cache writes and batched reads. Compare fresh server binding before/after matching; preserve anonymous/global-only matching. Reject legacy unscoped cache entries.
3. Wire production overlay and enrichment reads through worker validation, using one batch per overlay scan. Preserve store primitives and inject the reader for focused UI tests. Update user docs for changed cache behavior.
4. Run focused regressions, full backend/extension gates, commit/push corrections, reply to review and await CI plus independent PR review. No deployment or merge.
