#!/usr/bin/env node
'use strict';
// Proof that an UNPACKED runtime payload works on its own (artifact deployment,
// spec §3 BUILD-001: "isolated unpacked-payload check"). verify_payload.py copies
// this file OUTSIDE the payload and runs it with an empty environment; every module
// is resolved from the payload root, so a dependency or asset that only the source
// checkout has fails here, before the artifact is published.
//
// Usage: WBB_PAYLOAD=<root> node payload-probe.cjs native|migrate|assets|ops [ops entrypoints...]
// Exit:  0 PROBE OK (one line), 1 PROBE FAILED (reason on the line), 64 usage.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = process.env.WBB_PAYLOAD;
const fromPayload = root ? createRequire(path.join(root, 'package.json')) : null;
const inPayload = (rel) => fromPayload(path.join(root, rel));

const probes = {
  native() {
    const Database = fromPayload('better-sqlite3');
    const db = new Database(':memory:');
    try {
      return `sqlite ${db.prepare('SELECT sqlite_version() AS v').get().v}`;
    } finally {
      db.close();
    }
  },

  // The same contract as deploy/trial-migrate.cjs, on a fresh database: the payload's
  // own openDb/migrate, twice, then SQLite's own soundness checks.
  migrate() {
    const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wbb-probe-'));
    const { openDb } = inPayload('dist/storage/db.js');
    const { migrate } = inPayload('dist/storage/schema.js');
    const db = openDb(path.join(scratch, 'probe.db'));
    try {
      const version = () => db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      migrate(db);
      const first = version();
      migrate(db);
      if (version() !== first) throw new Error(`a second migrate() moved the schema: ${first} -> ${version()}`);
      const fk = db.pragma('foreign_key_check');
      if (fk.length !== 0) throw new Error(`foreign_key_check: ${JSON.stringify(fk[0])}`);
      const ic = db.pragma('integrity_check');
      if (ic.length !== 1 || ic[0].integrity_check !== 'ok') throw new Error(`integrity_check: ${JSON.stringify(ic)}`);
      return `schema ${first}`;
    } finally {
      db.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },

  // The read-by-path assets, through the route that serves them in production.
  async assets() {
    const { Hono } = fromPayload('hono');
    const { festPrintRoute } = inPayload('dist/api/routes/fest-print.js');
    const app = new Hono();
    festPrintRoute(app, {});
    const served = [
      ['/fest-print', 'index.html'],
      ['/fest-print/niimbluelib.min.js', 'vendor/niimbluelib-0.47.0.min.js'],
    ];
    for (const [url, file] of served) {
      const res = await app.request(url);
      if (res.status !== 200) throw new Error(`GET ${url}: ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const want = fs.readFileSync(path.join(root, 'src/api/fest-print', file));
      if (!body.equals(want)) throw new Error(`GET ${url}: body differs from the payload's ${file}`);
    }
    return `${served.length} assets`;
  },

  // Every allowlisted TS operational command loads under the payload's own tsx.
  // require() leaves require.main alone, so the commands' main() does not run.
  ops(entrypoints) {
    if (entrypoints.length === 0) throw new Error('no ops entrypoints given');
    fromPayload('tsx/cjs');
    for (const rel of entrypoints) inPayload(rel);
    return `${entrypoints.length} ops commands`;
  },
};

async function main(argv) {
  const [name, ...rest] = argv;
  if (!root || !path.isAbsolute(root) || !Object.hasOwn(probes, name)) {
    console.error('usage: WBB_PAYLOAD=<root> payload-probe.cjs native|migrate|assets|ops [entrypoints...]');
    return 64;
  }
  try {
    console.log(`PROBE OK ${name}: ${await probes[name](rest)}`);
    return 0;
  } catch (e) {
    console.log(`PROBE FAILED ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
