# #611 deployment preflight and rollback

This is preparation, not deployment authorization. Local implementation and full gates are complete; external review has no independent receipt. Read [whole-branch review](2026-09-28-611-periphery.md) and [deployment procedures](../../deploy/README.md) before an authorized rollout.

## Read-only preflight recorded 2026-09-28

- Live schema: 40. Fetched upstream `a56143c`: migration 40, so 41 is free. Recheck immediately before rebasing/merging.
- Rows: 46,577 check-ins; 3,677 scraped observations; two coverage ranges; four sync rows.
- Six owners across all four tables: four with check-ins and two with only observations. Population and current username/revision bindings exactly match the core copy; all are currently linked.
- Operator confirmation covers all six owners: the user explicitly extended the original four-owner confirmation to both had-only owners during final preflight. Do not use zero revisions as proof that historical account changes never happened.
- A fresh SQLite backup made from a `mode=ro` connection was migrated only locally. Every historical column was compared, adding only the specified normalized key. Baseline, foreign keys, allocation sequence and a repeated migration call all passed.

No production writes, service stops or deployment occurred. The private local copies `/tmp/issue-611-production-copy.db` and `/tmp/issue-611-preflight-copy.db` and their replay files are not committed. They are test artifacts, not the eventual rollback backup.

## Repeat after shipping is authorized

1. Fetch/rebase onto current `origin/main`, resolve any migration-version collision by appending after upstream’s head, and rerun both complete gates. Wait for CI and AI review; address valid findings.
2. Read a single production snapshot. Enumerate owners using the union of **all four** tables, then compare current bindings with the confirmed population. Newly ambiguous ownership is resolved individually before deployment.
3. Apply the autodeploy brake documented in `deploy/README.md` so no unattended deployment interleaves the migration. Preserve the deployed binary/commit and runtime configuration. Record their paths outside the rsync-managed application directory.
4. Stop the bot during the final backup and code/schema transition. Make a fresh backup with SQLite’s backup API, not a raw copy of a live WAL main file. Keep it private and outside the deploy rsync allowlist. Retain the matching old binary and a checksum of the backup.
5. Repeat the actual migration on a copy of that backup before deploying. Compare every row’s original columns and normalized owner, exact legacy baselines, `PRAGMA foreign_key_check`, `sqlite_sequence` and a second `migrate` call. No guessed historical account keys or count-based coverage seeds are permitted.
6. Deploy the complete guarded backend via `deploy/deploy.sh`; never deploy the storage core alone. Old extensions may still sync unchanged bindings; after an account switch they must update to the revision-aware extension. Store publishing is a separate maintainer action: merge any release PR before `npm run release:store`.
7. Verify runtime health: systemd active, startup/migration logs clean, authenticated sync-state correct for the operator, and `/match` plus bot `/status` personal results coherent. A stale supplied revision must reject before mutation. Observe the next scrape/import activity without creating a production test account switch.
8. Release the deployment brake only after health is verified. After the PR is confirmed merged and deployment healthy, clean only its clean worktree/local branch; preserve unrelated dirty work and monitoring artifacts.

Read-only ownership/scope query for the pre-migration schema:

```sql
WITH owners AS (
  SELECT telegram_id FROM checkins
  UNION SELECT telegram_id FROM untappd_had
  UNION SELECT telegram_id FROM checkin_coverage
  UNION SELECT telegram_id FROM checkin_sync_state
)
SELECT p.telegram_id, p.untappd_username, p.untappd_link_revision,
  (SELECT COUNT(*) FROM checkins c WHERE c.telegram_id = p.telegram_id) AS checkins,
  (SELECT COUNT(*) FROM untappd_had h WHERE h.telegram_id = p.telegram_id) AS observations
FROM owners o LEFT JOIN user_profiles p ON p.telegram_id = o.telegram_id
ORDER BY o.telegram_id;
```

Any missing profile in that left join is ambiguous and requires an individual decision. Run all scope/provenance reads under one read transaction. On a copy, expected keys are `lower(current username)` for confirmed linked owners, `''` for unlinked ones; row counts alone do not verify preservation.

## Rollback

Keep the bot stopped while restoring **both** the pre-migration DB backup and its matching binary. Never start the old binary against schema 41: its unscoped readers and old conflict targets are incompatible. Restore through the established SQLite/Litestream procedure in `deploy/README.md`, ensuring no stale WAL accompanies the restored DB. Reassert service-user ownership, verify the restored schema/data and then restart the old service. Health verification is required before releasing the deployment brake. Rolling back discards post-backup history writes, so capture those separately before replacement if any occurred.
