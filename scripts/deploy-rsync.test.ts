import { afterEach, describe, expect, test } from 'vitest';
import {
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

function filesBelow(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = join(relative, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [path];
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true });
});

// The flat tree's payload, as deploy/rsync-filter defines it. The flat deploy.sh that ran this rsync
// was replaced by the image wrapper in stage «в»; the filter stays until stage В2 (ships.sh reads it),
// so it is driven here with the flags that deploy.sh used.
describe('deploy rsync payload', () => {
  test('deploys only the allowlisted build and runtime files', () => {
    const source = temporaryDirectory('wbb-deploy-source-');
    const destination = temporaryDirectory('wbb-deploy-destination-');

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

    const result = spawnSync('rsync', [
      '-a', '--delete', '--delete-excluded', '--filter=merge deploy/rsync-filter', './', `${destination}/`,
    ], { cwd: source, encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(filesBelow(destination).sort()).toEqual([
      'deploy/README.md',
      'deploy/autodeploy.sh',
      'deploy/db-snapshot.sh',
      'deploy/deploy.sh',
      'deploy/image/Dockerfile',
      'deploy/image/helper/bounded.py',
      'deploy/image/helper/test_bounded.py',
      'deploy/image/helper/test_wbb_image.py',
      'deploy/image/helper/wbb-image.sh',
      'deploy/image/helper/wbb_image.py',
      'deploy/image/offline-telegram.cjs',
      'deploy/image/start-check.cjs',
      'deploy/image/warsaw-beer-bot.container',
      'deploy/install-autodeploy.sh',
      'deploy/install-host-patch-collector.sh',
      'deploy/install-host-patching.sh',
      'deploy/install-image.sh',
      'deploy/install-reboot-request.sh',
      'deploy/install-release.sh',
      'deploy/install-resource-monitor.sh',
      'deploy/installed-current.sh',
      'deploy/litestream.env.example',
      'deploy/litestream.service',
      'deploy/litestream.yml',
      'deploy/read-env.sh',
      'deploy/record-deployed.sh',
      'deploy/refresh-cookie.sh',
      'deploy/release/activate.py',
      'deploy/release/audit_verdict.py',
      'deploy/release/bounded.py',
      'deploy/release/dbsnap.py',
      'deploy/release/deploy_state.py',
      'deploy/release/fake_helpers.py',
      'deploy/release/fake_host.py',
      'deploy/release/fake_run.py',
      'deploy/release/gates.py',
      'deploy/release/github_trust.py',
      'deploy/release/helpers.py',
      'deploy/release/helpers_adapter.py',
      'deploy/release/host_adapter.py',
      'deploy/release/host_audit.py',
      'deploy/release/installed.py',
      'deploy/release/installer.py',
      'deploy/release/notify_telegram.py',
      'deploy/release/package_runtime.py',
      'deploy/release/payload-probe.cjs',
      'deploy/release/prepare.py',
      'deploy/release/publish.py',
      'deploy/release/release_testkit.py',
      'deploy/release/safe_tar.py',
      'deploy/release/sandbox.py',
      'deploy/release/test_activate.py',
      'deploy/release/test_audit_verdict.py',
      'deploy/release/test_bounded.py',
      'deploy/release/test_crash_matrix.py',
      'deploy/release/test_dbsnap.py',
      'deploy/release/test_deploy_state.py',
      'deploy/release/test_gates.py',
      'deploy/release/test_github_trust.py',
      'deploy/release/test_helpers_adapter.py',
      'deploy/release/test_host_adapter.py',
      'deploy/release/test_host_audit.py',
      'deploy/release/test_host_units.py',
      'deploy/release/test_installed.py',
      'deploy/release/test_installer.py',
      'deploy/release/test_notify_telegram.py',
      'deploy/release/test_package_runtime.py',
      'deploy/release/test_prepare.py',
      'deploy/release/test_publish.py',
      'deploy/release/test_sandbox.py',
      'deploy/release/test_tick.py',
      'deploy/release/test_tick_failed.py',
      'deploy/release/test_tick_state.py',
      'deploy/release/test_tree_manifest.py',
      'deploy/release/test_trial.py',
      'deploy/release/test_verify_payload.py',
      'deploy/release/test_wbb_release.py',
      'deploy/release/test_wrappers.py',
      'deploy/release/test_zip_admission.py',
      'deploy/release/tick.py',
      'deploy/release/tick_state.py',
      'deploy/release/tree_manifest.py',
      'deploy/release/trial.py',
      'deploy/release/verify_payload.py',
      'deploy/release/wbb_release.py',
      'deploy/release/zip_admission.py',
      'deploy/rsync-filter',
      'deploy/ships.sh',
      'deploy/sudoers.d/warsaw-beer-bot',
      'deploy/sudoers.d/wbb-image',
      'deploy/sudoers.d/wbb-release',
      'deploy/trial-migrate.cjs',
      'deploy/warsaw-beer-bot.service',
      'deploy/wbb-autodeploy.service',
      'deploy/wbb-autodeploy.timer',
      'deploy/wbb-host-patch.service',
      'deploy/wbb-host-patch.timer',
      'deploy/wbb-reboot-request.path',
      'deploy/wbb-reboot-request.service',
      'deploy/wbb-release.sh',
      'deploy/wbb-tick-failed.service',
      'deploy/wbb-tick-failed.sh',
      'deploy/wbb-tick.service',
      'deploy/wbb-tick.sh',
      'deploy/wbb-tick.timer',
      'package-lock.json',
      'package.json',
      'scripts/tool.ts',
      'src/index.ts',
      'tsconfig.json',
    ]);
  });
});
