import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SHIPS = resolve(__dirname, '../../deploy/ships.sh');
const REPO_FILTER = resolve(__dirname, '../../deploy/rsync-filter');

/** The production filter's text, so the tests do not re-state it by hand. */
const REAL_FILTER = [
  '+ /package.json',
  '+ /package-lock.json',
  '+ /tsconfig.json',
  '+ /src/***',
  '+ /scripts/***',
  '+ /deploy/***',
  '- *',
  '',
].join('\n');

function filterFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-ships-filter-'));
  const p = join(dir, 'rsync-filter');
  writeFileSync(p, body);
  return p;
}

function ships(filter: string, paths: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('bash', [SHIPS, filter], {
      encoding: 'utf8',
      input: paths.join('\n') + (paths.length ? '\n' : ''),
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

/** The SHIP set, as a plain array, for set comparisons. */
function shipped(filter: string, paths: string[]): string[] {
  const r = ships(filter, paths);
  expect(r.code).toBe(0);
  return r.out.split('\n').filter((l) => l.startsWith('SHIP ')).map((l) => l.slice(5));
}

describe('ships.sh — what reaches production', () => {
  const filter = filterFile(REAL_FILTER);

  it('ships the root manifests, tsconfig, and the three shipped directories', () => {
    expect(shipped(filter, [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'src/index.ts',
      'src/deep/nested/file.ts',
      'scripts/tool.ts',
      'deploy/deploy.sh',
    ])).toEqual([
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'src/index.ts',
      'src/deep/nested/file.ts',
      'scripts/tool.ts',
      'deploy/deploy.sh',
    ]);
  });

  it('does not ship the paths that blocked autodeploy on 2026-08-28', () => {
    expect(shipped(filter, [
      '.gitignore',
      '.impeccable/critique/2026-08-28T17-11-20Z__extension-src-popup-popup-html.md',
      'docs/extension-install-en.md',
      'docs/extension-install-uk.md',
      'extension/src/popup/popup.css',
      'extension/src/popup/popup.html',
      'spec.md',
    ])).toEqual([]);
  });

  it('anchors directory rules at the root: vendor/src/x.ts does not ship', () => {
    // The exact mistake a prefix-matching parser makes. `+ /src/***` is
    // anchored at the transfer root; a nested directory of the same name is
    // not the same directory.
    expect(shipped(filter, ['vendor/src/x.ts', 'a/scripts/b.ts', 'x/deploy/y.sh'])).toEqual([]);
  });

  it('anchors file rules at the root: a nested manifest is a different file', () => {
    expect(shipped(filter, ['extension/package-lock.json', 'sub/package.json'])).toEqual([]);
  });

  it('emits one verdict per input line, in order, with SKIP for the rest', () => {
    const r = ships(filter, ['src/a.ts', 'docs/b.md', 'package.json']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('SHIP src/a.ts\nSKIP docs/b.md\nSHIP package.json\n');
  });

  it('accepts comments and blank lines in the filter', () => {
    const f = filterFile('# a comment\n\n  # indented comment\n+ /src/***\n- *\n');
    expect(shipped(f, ['src/a.ts', 'docs/b.md'])).toEqual(['src/a.ts']);
  });

  it('handles an empty path list without producing output', () => {
    const r = ships(filter, []);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });
});

describe('ships.sh — the grammar refuses what it does not implement', () => {
  it('refuses a filter with no terminal catch-all', () => {
    // Without `- *` rsync's default is "everything ships", which is the exact
    // opposite of what this predicate concludes from a non-match.
    const f = filterFile('+ /src/***\n');
    const r = ships(f, ['src/a.ts']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/terminal/i);
  });

  it('refuses a glob in a file rule', () => {
    const f = filterFile('+ /weird[abc]\n- *\n');
    const r = ships(f, ['weirda']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses a rule after the catch-all', () => {
    const f = filterFile('+ /src/***\n- *\n+ /late.txt\n');
    const r = ships(f, ['late.txt']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses an exclude rule that is not the catch-all', () => {
    const f = filterFile('- /secret\n+ /src/***\n- *\n');
    const r = ships(f, ['src/a.ts']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses a multi-segment directory rule rather than guessing', () => {
    const f = filterFile('+ /src/deep/***\n- *\n');
    const r = ships(f, ['src/deep/a.ts']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses an unreadable filter file', () => {
    const r = ships('/nonexistent/rsync-filter', ['package.json']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it("parses the repository's own deploy/rsync-filter", () => {
    // The check that makes an unsupported rule fail a merge instead of a
    // production guard a week later.
    const r = ships(REPO_FILTER, ['package.json']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('SHIP package.json\n');
  });
});

describe('ships.sh agrees with real rsync, path for path', () => {
  // The oracle. A hand-written predicate that re-derives rsync's matching can
  // be subtly wrong in ways no amount of reading catches — anchoring above
  // all. So the fixture tree is transferred by the real rsync with the real
  // filter, and whatever lands is the truth the predicate must reproduce.
  const FIXTURE_PATHS = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'src/index.ts',
    'src/nested/deep/mod.ts',
    'scripts/tool.ts',
    'deploy/deploy.sh',
    'deploy/rsync-filter',
    'extension/manifest.json',
    'extension/src/popup/popup.css',
    'extension/package-lock.json',
    'sub/package.json',
    'vendor/src/x.ts',
    'a/scripts/b.ts',
    'x/deploy/y.sh',
    'docs/plan.md',
    'spec.md',
    '.gitignore',
    '.impeccable/critique/note.md',
    'tests/fixture.ts',
    'tmp/current.db',
  ];

  function filesBelow(root: string, relative = ''): string[] {
    return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesBelow(root, path) : [path];
    });
  }

  it('classifies exactly the files real rsync transfers under the same filter', () => {
    const source = mkdtempSync(join(tmpdir(), 'wbb-ships-src-'));
    const destination = mkdtempSync(join(tmpdir(), 'wbb-ships-dst-'));

    for (const p of FIXTURE_PATHS) {
      const full = join(source, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '');
    }
    // `merge deploy/rsync-filter` resolves relative to rsync's working
    // directory, so the fixture tree carries its own copy of the real filter.
    writeFileSync(join(source, 'deploy/rsync-filter'), REAL_FILTER);

    execFileSync(
      'rsync',
      ['-a', '--delete', '--delete-excluded', '--filter=merge deploy/rsync-filter', './', `${destination}/`],
      { cwd: source },
    );

    // rsync transfers directories too; git diff --name-only never names one,
    // so the predicate is only ever asked about files. Compare file sets.
    const byRsync = filesBelow(destination).sort();
    const byPredicate = shipped(filterFile(REAL_FILTER), FIXTURE_PATHS).sort();

    expect(byPredicate).toEqual(byRsync);
    // Guards against a vacuous pass: an empty tree would equal an empty set.
    expect(byRsync.length).toBeGreaterThan(5);
  });
});
