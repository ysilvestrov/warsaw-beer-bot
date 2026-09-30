#!/usr/bin/env node
'use strict';
// Merge-deploy step 5 — the trial migration.
// Spec: docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md
//
// Runs the NEW build's migrate() against a COPY of production twice, then asks
// SQLite whether the result is sound. What it cannot see — a migration that
// rewrites data wrongly but validly — is why such a PR carries [deploy:hold].
// Installed as /usr/local/bin/wbb-trial-migrate (no extension; CommonJS is
// node's default there).
//
// Usage: trial-migrate <clone_dir> <db_copy>
// Exit:  0 TRIAL OK, 1 TRIAL FAILED (reason on the first stdout line), 64 usage.
const path = require('node:path');

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: trial-migrate <clone_dir> <db_copy>');
    return 64;
  }
  const [clone, dbPath] = argv;
  let db;
  try {
    // Everything from the CLONE: the build under judgement opens the copy
    // exactly as production opens bot.db (its own openDb: WAL, busy_timeout,
    // foreign_keys), then migrates it. Inside the try, so a missing build is a
    // TRIAL FAILED, not a crash.
    const { openDb } = require(path.join(clone, 'dist', 'storage', 'db.js'));
    const { migrate } = require(path.join(clone, 'dist', 'storage', 'schema.js'));
    db = openDb(dbPath);
    const version = () => db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    const before = version();
    migrate(db);
    const after = version();
    migrate(db);
    const again = version();
    if (again !== after) throw new Error(`a second migrate() moved the schema: ${after} -> ${again}`);
    const fk = db.pragma('foreign_key_check');
    if (fk.length > 0) {
      throw new Error(`foreign_key_check: ${fk.length} violation(s), first ${JSON.stringify(fk[0])}`);
    }
    const ic = db.pragma('integrity_check');
    if (ic.length !== 1 || ic[0].integrity_check !== 'ok') {
      throw new Error(`integrity_check: ${JSON.stringify(ic)}`);
    }
    console.log(`TRIAL OK: schema ${before} -> ${after}`);
    return 0;
  } catch (e) {
    console.log(`TRIAL FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (db) db.close();
  }
}

process.exitCode = main(process.argv.slice(2));
