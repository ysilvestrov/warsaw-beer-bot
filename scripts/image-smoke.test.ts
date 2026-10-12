import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTempDirectory } from './test-temp';

// scripts/image-smoke.sh against a fake docker client: what each container is asked
// to do, under which confinement, and how every outcome turns into the verdict. The
// real image runs it in CI (job `image`).
const SCRIPT = resolve(__dirname, 'image-smoke.sh');
const FIXTURES = resolve(__dirname, 'autodeploy/fixtures/npm-audit');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// One invocation per record (\x1e), arguments NUL-terminated; audit stdin likewise.
const FAKE = `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$FAKE_DIR/calls"; printf '\\x1e' >> "$FAKE_DIR/calls"
args=" $* "
case $args in
  *' touch /app/x '*) echo "\${FAKE_TOUCH_MSG-touch: cannot touch '/app/x': Read-only file system}"; exit "\${FAKE_TOUCH:-1}" ;;
  *' find /app ! -type l -perm /222 '*) printf '%s' "\${FAKE_AW_OUT-}"; exit "\${FAKE_AW_CODE:-0}" ;;
  *start-check.cjs*) echo "START OK \${FAKE_START_SHA}"; echo 'bot output'; exit 0 ;;
  *trial-migrate.cjs*) echo "\${FAKE_TRIAL:-TRIAL OK: schema 47 -> 47}"; exit "\${FAKE_TRIAL_CODE:-0}" ;;
  *' cat /app/package.json '*) cat "$FAKE_PACKAGE_JSON" ;;
  *payload-probe.cjs*)
    for ((i = 1; i <= $#; i++)); do [ "\${!i}" = /probe/payload-probe.cjs ] && { j=$((i + 1)); probe=\${!j}; }; done
    if [ "$probe" = "\${FAKE_PROBE_FAIL:-}" ]; then echo "PROBE FAILED $probe: broken"; exit 1; fi
    echo "PROBE OK $probe: fine" ;;
  *audit-verdict-cli.ts*)
    cat >> "$FAKE_DIR/stdin"; printf '\\x1e' >> "$FAKE_DIR/stdin"
    read -r code rest < "$FAKE_DIR/audit-codes"; echo "$rest" > "$FAKE_DIR/audit-codes"
    echo verdict; exit "$code" ;;
  *) echo "fake docker: unexpected $*" >&2; exit 99 ;;
esac
`;

type Run = { status: number | null; stdout: string; calls: string[][]; stdin: string[] };

function smoke(args: string[], env: Record<string, string> = {}): Run {
  const dir = makeTempDirectory('image-smoke-');
  const docker = join(dir, 'docker');
  writeFileSync(docker, FAKE, { mode: 0o755 });
  writeFileSync(join(dir, 'calls'), '');
  writeFileSync(join(dir, 'stdin'), '');
  writeFileSync(join(dir, 'audit-codes'), `${env.AUDIT_CODES ?? '0 10 2 2'}\n`);
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DOCKER: docker,
      FAKE_DIR: dir,
      FAKE_START_SHA: SHA,
      FAKE_PACKAGE_JSON: resolve(__dirname, '..', 'package.json'),
      ...env,
    },
  });
  const records = (f: string) => readFileSync(join(dir, f), 'utf8').split('\x1e').slice(0, -1);
  return {
    status: r.status,
    stdout: r.stdout,
    calls: records('calls').map((c) => c.split('\0').slice(0, -1)),
    stdin: records('stdin'),
  };
}

const CONFINED = ['run', '--rm', '--read-only', '--network=none', '--tmpfs', '/tmp', '--user', '999:999'];

describe('image-smoke.sh', () => {
  it('passes a sound image, step by step', () => {
    const r = smoke(['img:1', SHA]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe([
      `SMOKE OK start: START OK ${SHA}`,
      'SMOKE OK trial: TRIAL OK: schema 47 -> 47',
      'SMOKE OK probe: PROBE OK native: fine',
      'SMOKE OK probe: PROBE OK migrate: fine',
      'SMOKE OK probe: PROBE OK assets: fine',
      'SMOKE OK probe: PROBE OK ops: fine',
      'SMOKE OK audit: clean.json -> 0',
      'SMOKE OK audit: advisory.json -> 10',
      'SMOKE OK audit: enolock.json -> 2',
      'SMOKE OK audit: registry-down.json -> 2',
      'SMOKE OK readonly: read-only mount and a-w files',
      'SMOKE OK img:1',
      '',
    ].join('\n'));
  });

  it('runs every container read-only, offline, with a tmpfs /tmp and a non-root UID', () => {
    const r = smoke(['img:1', SHA]);
    // start, trial, package.json, four probes, four audits, touch, find.
    expect(r.calls.length).toBe(13);
    expect(r.calls.map((c) => c.slice(0, CONFINED.length))).toEqual(r.calls.map(() => CONFINED));
    expect(r.calls[12].slice(CONFINED.length)).toEqual(['img:1', 'find', '/app', '!', '-type', 'l', '-perm', '/222', '-print']);
  });

  it('starts the bot with the substitute environment of the compat check and no real .env', () => {
    const start = smoke(['img:1', SHA]).calls[0];
    expect(start.slice(CONFINED.length)).toEqual([
      '-e', 'TELEGRAM_BOT_TOKEN=123456:abcdefghij', '-e', 'OSRM_BASE_URL=http://x',
      '-e', 'NOMINATIM_USER_AGENT=x', '-e', 'DATABASE_PATH=/tmp/app.db', '-e', 'WBB_RELEASE_REQUIRED=true',
      '-e', 'API_PORT=3000', 'img:1', 'node', 'deploy/image/start-check.cjs',
    ]);
  });

  it('runs the probes on the image as the payload, with an empty dotenv and the probe mounted read-only', () => {
    const probes = smoke(['img:1', SHA]).calls.slice(3, 7);
    const mount = `${resolve(__dirname, '..', 'deploy/release/payload-probe.cjs')}:/probe/payload-probe.cjs:ro`;
    expect(probes.map((c) => c.slice(CONFINED.length, CONFINED.length + 12))).toEqual(probes.map((_, i) => [
      '-e', 'WBB_PAYLOAD=/app', '-e', 'DOTENV_CONFIG_PATH=/dev/null', '-v', mount, '-w', '/tmp',
      'img:1', 'node', '/probe/payload-probe.cjs',
    ].concat(['native', 'migrate', 'assets', 'ops'][i])));
  });

  it('feeds each npm-audit fixture to the verdict CLI in the image', () => {
    const r = smoke(['img:1', SHA]);
    const fixture = (f: string) => readFileSync(join(FIXTURES, f), 'utf8');
    expect(r.stdin).toEqual(['clean.json', 'advisory.json', 'enolock.json', 'registry-down.json'].map(fixture));
  });

  it('fails when the bot reports another release', () => {
    const r = smoke(['img:1', SHA], { FAKE_START_SHA: OTHER });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(0, 3)).toEqual([
      `SMOKE FAILED start: expected exit 0 and 'START OK ${SHA}', got exit 0 and 'START OK ${OTHER}'`,
      `START OK ${OTHER}`,
      'bot output',
    ]);
    expect(r.calls.length).toBe(1);
  });

  it('fails when the trial does not report TRIAL OK', () => {
    const r = smoke(['img:1', SHA], { FAKE_TRIAL: 'TRIAL FAILED: integrity_check', FAKE_TRIAL_CODE: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(1, 3)).toEqual([
      "SMOKE FAILED trial: expected exit 0 and 'TRIAL OK', got exit 1",
      'TRIAL FAILED: integrity_check',
    ]);
  });

  it('fails on a failed probe', () => {
    const r = smoke(['img:1', SHA], { FAKE_PROBE_FAIL: 'assets' });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(4, 6)).toEqual([
      "SMOKE FAILED probes: expected exit 0 and 'PROBE OK assets:', got exit 1",
      'PROBE FAILED assets: broken',
    ]);
  });

  it('fails when the verdict CLI misreads a fixture', () => {
    const r = smoke(['img:1', SHA], { AUDIT_CODES: '0 2 2 2' });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(7, 9)).toEqual(['SMOKE FAILED audit: advisory.json: expected exit 10, got 2', 'verdict']);
  });

  it('fails when the code is writable', () => {
    const r = smoke(['img:1', SHA], { FAKE_TOUCH: '0', FAKE_TOUCH_MSG: '' });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(-2)).toEqual(['SMOKE FAILED readonly: touch /app/x succeeded', '']);
  });

  // #842 AI review: a touch that failed for another reason proved nothing about the mount.
  it('fails when touch fails, but not as a read-only file system', () => {
    const r = smoke(['img:1', SHA], { FAKE_TOUCH_MSG: 'docker: Error response from daemon: OCI runtime create failed' });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(-3)).toEqual([
      'SMOKE FAILED readonly: touch /app/x failed, but not as a read-only file system',
      'docker: Error response from daemon: OCI runtime create failed', '']);
  });

  // #842 AI review: a-w is the mode of every file, not one touch by one UID.
  it('fails when a file under /app carries a write bit', () => {
    const r = smoke(['img:1', SHA], { FAKE_AW_OUT: '/app/dist/index.js' });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(-3)).toEqual(['SMOKE FAILED readonly: files under /app carry a write bit (not a-w)', '/app/dist/index.js', '']);
  });

  it('fails when the mode scan itself fails', () => {
    const r = smoke(['img:1', SHA], { FAKE_AW_CODE: '1', FAKE_AW_OUT: 'find: boom' });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').slice(-3)).toEqual(['SMOKE FAILED readonly: find /app ! -type l -perm /222 failed (exit 1)', 'find: boom', '']);
  });

  it.each([
    [['img:1']],
    [['img:1', 'abc']],
    [['img:1', SHA.toUpperCase()]],
    [['', SHA]],
    [['img:1', SHA, 'extra']],
  ])('refuses usage %j without running a container', (args) => {
    const r = smoke(args);
    expect(r.status).toBe(64);
    expect(r.calls).toEqual([]);
  });
});
