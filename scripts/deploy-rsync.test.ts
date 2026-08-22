import { afterEach, describe, expect, test } from 'vitest';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '..');
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function executable(path: string, content: string): void {
  write(path, content);
  chmodSync(path, 0o755);
}

function filesBelow(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = join(relative, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [path];
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true });
});

describe('deploy rsync payload', () => {
  test('deploys only the allowlisted build and runtime files', () => {
    const source = temporaryDirectory('wbb-deploy-source-');
    const destination = temporaryDirectory('wbb-deploy-destination-');
    const fakeBin = temporaryDirectory('wbb-deploy-bin-');

    cpSync(join(REPO_ROOT, 'deploy'), join(source, 'deploy'), { recursive: true });
    for (const path of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'src/index.ts',
      'scripts/tool.ts',
      'tmp/current.db',
      '.claude/settings.json',
      '.superpowers/ledger.md',
      'extension/manifest.json',
      'docs/plan.md',
      'tests/fixture.ts',
    ]) {
      write(join(source, path));
    }
    write(join(destination, 'tmp/stale.db'));

    executable(
      join(fakeBin, 'sudo'),
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = rsync ]; then',
        '  shift',
        '  args=()',
        '  while [ "$#" -gt 1 ]; do args+=("$1"); shift; done',
        '  /usr/bin/rsync "${args[@]}" "$WBB_TEST_DESTINATION/"',
        'fi',
        '',
      ].join('\n'),
    );
    executable(join(fakeBin, 'git'), '#!/usr/bin/env bash\necho dirty\n');
    executable(join(fakeBin, 'journalctl'), '#!/usr/bin/env bash\nexit 0\n');
    executable(join(source, 'deploy/record-deployed.sh'), '#!/usr/bin/env bash\nexit 0\n');
    const result = spawnSync('bash', ['deploy/deploy.sh'], {
      cwd: source,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        WBB_TEST_DESTINATION: destination,
      },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(filesBelow(destination).sort()).toEqual([
      'deploy/README.md',
      'deploy/autodeploy-guard.sh',
      'deploy/autodeploy.sh',
      'deploy/deploy.sh',
      'deploy/install-autodeploy.sh',
      'deploy/installed-current.sh',
      'deploy/litestream.env.example',
      'deploy/litestream.service',
      'deploy/litestream.yml',
      'deploy/read-env.sh',
      'deploy/record-deployed.sh',
      'deploy/refresh-cookie.sh',
      'deploy/rsync-filter',
      'deploy/sudoers.d/warsaw-beer-bot',
      'deploy/warsaw-beer-bot.service',
      'deploy/wbb-autodeploy.service',
      'deploy/wbb-autodeploy.timer',
      'package-lock.json',
      'package.json',
      'scripts/tool.ts',
      'src/index.ts',
      'tsconfig.json',
    ]);
  });
});
