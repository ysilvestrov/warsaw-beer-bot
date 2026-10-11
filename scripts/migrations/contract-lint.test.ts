import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baseMaxVersion, contractKeywords, lintMigrations, stripSqlComments } from './contract-lint';

const CLI = resolve(__dirname, 'contract-lint.ts');

const EXPAND = `
  CREATE TABLE IF NOT EXISTS t (
    id         INTEGER PRIMARY KEY,
    beer_id    INTEGER REFERENCES beers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    updated_at TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE beers ADD COLUMN abv REAL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS t_beer ON t(beer_id);
`;

const lint = (sql: string, title: string, labels: string[], baseMax = 46) =>
  lintMigrations({ migrations: [{ version: 47, sql }], baseMax, title, labels });

describe('stripSqlComments', () => {
  it('drops line and block comments, keeps the statements', () => {
    expect(stripSqlComments('CREATE TABLE a (x); -- UPDATE a\n/* DROP\n a */CREATE INDEX i ON a(x);'))
      .toBe('CREATE TABLE a (x);  \n CREATE INDEX i ON a(x);');
  });

  it('keeps a comment opener inside a string literal, so a keyword after it stays visible', () => {
    expect(stripSqlComments("INSERT INTO a VALUES ('--'); DROP TABLE b;"))
      .toBe("INSERT INTO a VALUES ('--'); DROP TABLE b;");
  });

  it('an unterminated block comment hides the rest', () => {
    expect(stripSqlComments('CREATE TABLE a (x); /* DROP TABLE a;')).toBe('CREATE TABLE a (x);  ');
  });
});

describe('contractKeywords', () => {
  it('an expand migration (CREATE TABLE, ADD COLUMN … DEFAULT, CREATE INDEX, FK actions, updated_at) names nothing', () => {
    expect(contractKeywords(EXPAND)).toEqual([]);
  });

  it('names each contract keyword once, case-insensitively, in a fixed order', () => {
    expect(contractKeywords(`
      drop table a; Update b SET x = 1; delete FROM c;
      ALTER TABLE d RENAME TO e; INSERT OR IGNORE INTO f (x) SELECT x FROM g; DROP INDEX h;
    `)).toEqual(['DROP', 'RENAME', 'UPDATE', 'DELETE', 'INSERT … SELECT']);
  });

  it('a keyword in a comment is not a statement', () => {
    expect(contractKeywords('-- UPDATE beers SET x = 1\nCREATE TABLE a (x); /* DELETE FROM a */')).toEqual([]);
  });

  it('INSERT … VALUES followed by a separate SELECT statement is not a rebuild', () => {
    expect(contractKeywords('INSERT INTO a (x) VALUES (1); SELECT 1;')).toEqual([]);
  });

  it('a keyword inside a string literal or a quoted identifier is data, not a statement', () => {
    expect(contractKeywords(`INSERT INTO a (x, "update") VALUES ('drop; select; it''s delete');`)).toEqual([]);
  });

  it('a trigger whose body updates rows is flagged — only FK actions (ON DELETE / ON UPDATE) are exempt', () => {
    expect(contractKeywords('CREATE TRIGGER tr AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; END;')).toEqual(['UPDATE']);
  });
});

describe('lintMigrations', () => {
  it('an expand migration passes without any label', () => {
    expect(lint(EXPAND, 'feat: x', [])).toEqual({ ok: true, contract: [], problems: [] });
  });

  it('DROP TABLE without migration:contract is a problem', () => {
    expect(lint('DROP TABLE a;', 'feat: x', [])).toEqual({
      ok: false,
      contract: [{ version: 47, keywords: ['DROP'] }],
      problems: [
        'migration v47 runs DROP — contract SQL (spec 2026-10-11 §6.2): label the PR migration:contract, prefix the title with [deploy:hold] and add the deploy:hold label',
      ],
    });
  });

  it('migration:contract without the [deploy:hold] title is a problem', () => {
    expect(lint('DROP TABLE a;', 'feat: x', ['migration:contract', 'deploy:hold']).problems).toEqual([
      'migration:contract needs the [deploy:hold] title marker and the deploy:hold label — such a change is deployed by a human (spec 2026-10-11 §6.4)',
    ]);
  });

  it('migration:contract with the marker but without the deploy:hold label is a problem', () => {
    expect(lint('DROP TABLE a;', '[deploy:hold] feat: x', ['migration:contract']).ok).toBe(false);
  });

  it('migration:contract with the marker and the label passes', () => {
    expect(lint('DROP TABLE a;', '[deploy:hold] feat: x', ['migration:contract', 'deploy:hold'])).toEqual({
      ok: true, contract: [{ version: 47, keywords: ['DROP'] }], problems: [],
    });
  });

  it('UPDATE only in a comment passes', () => {
    expect(lint('-- UPDATE beers SET x = 1\nCREATE TABLE a (x);', 'feat: x', []).ok).toBe(true);
  });

  it('an updated_at column passes', () => {
    expect(lint('ALTER TABLE a ADD COLUMN updated_at TEXT;', 'feat: x', []).ok).toBe(true);
  });

  it('rollback:unsafe without the hold is a problem even with no migration at all', () => {
    expect(lintMigrations({ migrations: [], baseMax: 46, title: 'feat: x', labels: ['rollback:unsafe'] }).problems)
      .toEqual(['rollback:unsafe needs the [deploy:hold] title marker and the deploy:hold label — such a change is deployed by a human (spec 2026-10-11 §6.4)']);
  });

  it('rollback:unsafe with the hold passes', () => {
    expect(lintMigrations({ migrations: [], baseMax: 46, title: '[deploy:hold] x', labels: ['rollback:unsafe', 'deploy:hold'] }).ok)
      .toBe(true);
  });

  it('migrations at or below the base max are not checked', () => {
    const r = lintMigrations({
      migrations: [{ version: 45, sql: 'DROP TABLE a;' }, { version: 46, sql: 'DELETE FROM b;' }, { version: 47, sql: EXPAND }],
      baseMax: 46, title: 'feat: x', labels: [],
    });
    expect(r).toEqual({ ok: true, contract: [], problems: [] });
  });

  it('the first migration above the base max is checked', () => {
    const r = lintMigrations({
      migrations: [{ version: 46, sql: EXPAND }, { version: 47, sql: 'UPDATE a SET x = 1;' }],
      baseMax: 46, title: 'feat: x', labels: [],
    });
    expect(r.contract).toEqual([{ version: 47, keywords: ['UPDATE'] }]);
  });
});

describe('baseMaxVersion', () => {
  it('takes the largest version: key of the MIGRATIONS entries', () => {
    const src = `
      // see version: 99 in the notes
      const MIGRATIONS = [
        {
          version: 1,
          sql: \`CREATE TABLE a (version INTEGER NOT NULL);\`,
        },
        { version: 12, sql: V12 },
        {
          version: 3,
          sql: '',
        },
      ];
    `;
    expect(baseMaxVersion(src)).toBe(12);
  });

  it('throws when the source names no version — an empty base must not read as "everything is new" or "nothing is"', () => {
    expect(() => baseMaxVersion('export const x = 1;')).toThrow('no `version:` entries in the base schema.ts');
  });
});

describe('contract-lint CLI', () => {
  // The CLI reads MIGRATIONS from the current tree; v24 is a table rebuild (DROP, RENAME,
  // INSERT … SELECT) and history is never rewritten, so a base of 23 always sees it.
  function cli(base: string, title: string, labels: string[]) {
    const r = spawnSync('npx', ['tsx', CLI], {
      input: base, encoding: 'utf8',
      env: { ...process.env, PR_TITLE: title, PR_LABELS: JSON.stringify(labels) },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it('exits 1 on an unlabelled contract migration and says the lint is a review signal', () => {
    const r = cli('{ version: 23, sql: X }', 'feat: x', []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ migration v24 runs DROP, RENAME, INSERT … SELECT — contract SQL');
    expect(r.out).toContain('This lint is a review signal, not a proof of rollback safety');
  });

  it('exits 0 when the contract migrations are labelled and held', () => {
    const r = cli('{ version: 23, sql: X }', '[deploy:hold] x', ['migration:contract', 'deploy:hold']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK: contract SQL in v24 (DROP, RENAME, INSERT … SELECT), v');
    expect(r.out).toContain('labelled migration:contract and held. This lint is a review signal, not a proof of rollback safety');
  });

  it('exits 2 when the base schema on stdin names no version', () => {
    const r = cli('', 'feat: x', []);
    expect(r.code).toBe(2);
    expect(r.out).toContain('no `version:` entries in the base schema.ts');
  });

  it('exits 2 when PR_LABELS is not a JSON array of strings', () => {
    const r = spawnSync('npx', ['tsx', CLI], { input: '{ version: 23 }', encoding: 'utf8', env: { ...process.env, PR_TITLE: 'x', PR_LABELS: 'nope' } });
    expect(r.status).toBe(2);
  });
});

describe('deploy-hold workflow', () => {
  it('feeds the lint the schema of the base the PR merges onto', () => {
    const wf = readFileSync(resolve(__dirname, '../../.github/workflows/deploy-hold.yml'), 'utf8');
    expect(wf).toContain('run: git show HEAD^1:src/storage/schema.ts | npx tsx scripts/migrations/contract-lint.ts');
  });
});
