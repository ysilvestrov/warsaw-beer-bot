import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTempDirectory } from '../test-temp';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Stage «в» harness, Task 4 (docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md, "Рішення"
 * п.6): scripts/ops/switchover-preflight.sh on a world where every outside contact is a stub — sudo, systemctl,
 * df, podman, install-image.sh --check, the rehearsal shim, and gh and curl on PATH (the controller's own resolve
 * and attestation functions call them by name). Git is real: a bare origin and a clone. Expected texts are literals.
 */
const PREFLIGHT = resolve(__dirname, 'switchover-preflight.sh');
const DIGEST = `sha256:${'1'.repeat(64)}`;
const GIB = 1024 * 1024;

function file(path: string, text: string, mode = 0o644): void {
  writeFileSync(path, text);
  chmodSync(path, mode);
}

const SUDO = `line="$*"
printf 'sudo %s\\n' "\${line//$'\\n'/ }" >> "$STUB_DIR/log"
if [ -e "$STUB_DIR/no-ticket" ]; then echo 'sudo: a password is required' >&2; exit 1; fi
if [ "$1" != -n ]; then echo "stub sudo: not -n: $*" >&2; exit 99; fi
shift
exec "$@"`;

// is-enabled / is-active <unit>: a file per unit, or the stopped answer; show of the kit unit: a file.
const SYSTEMCTL = `printf 'systemctl %s\\n' "$*" >> "$STUB_DIR/log"
case "$1" in
  is-enabled) cat "$STUB_DIR/enabled-$2" 2>/dev/null || echo disabled ;;
  is-active) cat "$STUB_DIR/active-$2" 2>/dev/null || echo inactive ;;
  show) cat "$STUB_DIR/show-$2" ;;
esac`;

const PODMAN = `printf 'podman %s\\n' "$*" >> "$STUB_DIR/log"
exit "$(cat "$STUB_DIR/podman-exists-rc")"`;

const DF = `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 1 1 %s 1%% /\\n' "$(cat "$STUB_DIR/df-avail")"`;

const INSTALL_IMAGE = `printf 'install-image %s\\n' "$*" >> "$STUB_DIR/log"
cat "$STUB_DIR/helper-out"
exit "$(cat "$STUB_DIR/helper-rc")"`;

const SHIM = `import os, sys
assert sys.argv[1:] == ['--kit-root'], sys.argv
print(open(os.path.join(os.environ['STUB_DIR'], 'kit-root')).read().strip())`;

// gh: the help text from a file; a verify is logged and exits as told.
const GH = `if [ "$*" = "attestation verify --help" ]; then cat "$STUB_DIR/gh-help"; exit 0; fi
printf 'gh %s\\n' "$*" >> "$STUB_DIR/log"
echo 'verification output'
exit "$(cat "$STUB_DIR/attest-rc")"`;

// GHCR's tag → digest as the controller reads it: reg/<sha> holds the digest; no file is a 404.
const CURL = `url="\${*: -1}"
printf 'curl %s\\n' "$url" >> "$STUB_DIR/log"
case "$url" in
  *'/token?'*) echo '{"token":"tok"}' ;;
  */manifests/*)
    sha="\${url##*/}"
    if [ -f "$STUB_DIR/reg/$sha" ]; then
      printf 'HTTP/2 200\\r\\ndocker-content-digest: %s\\r\\n\\r\\n' "$(cat "$STUB_DIR/reg/$sha")"
    else
      printf 'HTTP/2 404\\r\\n\\r\\n'
    fi ;;
  *) exit 22 ;;
esac`;

const GUARDED = `#!/usr/bin/env bash
STATE="$LOCK_DIR/state.env"
if [ -e "$STATE" ]; then
  if [ ! -f "$STATE" ]; then exit 1; fi
fi
sudo rsync -a ./ /opt/warsaw-beer-bot/
`;
const UNGUARDED = `#!/usr/bin/env bash
sudo rsync -a ./ /opt/warsaw-beer-bot/
`;
const WRAPPER = `#!/usr/bin/env bash
exec /usr/local/bin/wbb-autodeploy --manual deploy
`;

interface World {
  root: string; stub: string; git: string; origin: string; state: string; etc: string; kit: string;
  homes: string; containers: string; deployed: string; head: string; env: Record<string, string>;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: '2026-10-23T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-23T00:00:00Z',
};
function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A host where every check passes: timer off, flat state on main, HEAD = main with an attested image, nothing left. */
function world(): World {
  const root = makeTempDirectory('wbb-switchover-preflight-');
  const stub = join(root, 'stub');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'checkout');
  const state = join(root, 'state', 'wbb-autodeploy');
  const etc = join(root, 'etc');
  const homes = join(root, 'homes');
  const containers = join(root, 'containers');
  const kit = join(root, 'var', 'wbb-rehearsal');
  for (const d of [stub, join(stub, 'reg'), state, join(etc, 'containers/systemd'), join(etc, 'systemd/system'), containers,
    join(root, 'var'), join(homes, 'guarded/deploy'), join(homes, 'new/deploy'), join(homes, 'tool/node_modules/x/deploy')]) {
    mkdirSync(d, { recursive: true });
  }
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', repo);
  file(join(repo, 'README'), 'x\n');
  git(repo, 'add', 'README');
  git(repo, 'commit', '-q', '-m', 'deployed');
  const deployed = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  const sh = (name: string, body: string) => file(join(stub, name), `#!/usr/bin/env bash\n${body}\n`, 0o755);
  sh('sudo', SUDO);
  sh('systemctl', SYSTEMCTL);
  sh('podman', PODMAN);
  sh('df', DF);
  sh('install-image', INSTALL_IMAGE);
  sh('gh', GH);
  sh('curl', CURL);
  file(join(stub, 'shim.py'), SHIM);
  const stubs: Record<string, string> = {
    log: '', 'kit-root': kit, 'podman-exists-rc': '1', 'df-avail': String(6 * GIB), 'attest-rc': '0',
    'helper-out': 'wbb-image: every installed copy matches HEAD abc1234\n', 'helper-rc': '0',
    'gh-help': 'Flags:\n      --deny-self-hosted-runners   Fail\n      --source-digest string   Enforce\n',
    'show-wbb-rehearsal.service': 'LoadState=not-found\nActiveState=inactive\n',
  };
  for (const [k, v] of Object.entries(stubs)) file(join(stub, k), v);
  file(join(stub, 'reg', head), `${DIGEST}\n`);

  file(join(state, 'state.env'), `DEPLOYED_SHA=${deployed}\nPREVIOUS_SHA=\nLAST_SEEN_DEPLOYED_SHA=${deployed}\nMAIN_SEEN_S=1761177600\nLAST_HOLD_NOTICE=2026-10-22\n`);
  file(join(state, 'lock'), '');
  file(join(homes, 'guarded/deploy/deploy.sh'), GUARDED);
  file(join(homes, 'new/deploy/deploy.sh'), WRAPPER);
  // node_modules is not searched: an unguarded copy there is no finding.
  file(join(homes, 'tool/node_modules/x/deploy/deploy.sh'), UNGUARDED);

  const env: Record<string, string> = {
    PATH: `${stub}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: root, STUB_DIR: stub, XDG_STATE_HOME: join(root, 'state'),
    PREFLIGHT_SUDO: join(stub, 'sudo'), PREFLIGHT_SYSTEMCTL: join(stub, 'systemctl'), PREFLIGHT_DF: join(stub, 'df'),
    PREFLIGHT_PODMAN: join(stub, 'podman'), PREFLIGHT_EUID: '1000', PREFLIGHT_GIT_DIR: repo, PREFLIGHT_ETC: etc,
    PREFLIGHT_CONTAINERS_ROOT: containers, PREFLIGHT_INSTALL_IMAGE: join(stub, 'install-image'),
    PREFLIGHT_SHIM: join(stub, 'shim.py'), PREFLIGHT_CHECKOUT_ROOTS: homes,
  };
  return { root, stub, git: repo, origin, state, etc, kit, homes, containers, deployed, head, env };
}

interface Result { code: number | null; out: string; err: string }
function run(w: World, args: string[] = []): Result {
  const r = spawnSync('bash', [PREFLIGHT, ...args], { encoding: 'utf8', env: w.env, timeout: 50_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const put = (w: World, name: string, text: string) => file(join(w.stub, name), text);
const s12 = (sha: string) => sha.slice(0, 12);

/** Every line of a run where all passes, keyed by its check. */
function passLines(w: World): Record<string, string> {
  return {
    timer: 'PASS      timer — wbb-autodeploy.timer is disabled and inactive',
    service: 'PASS      service — wbb-autodeploy.service is inactive',
    lock: `PASS      lock — ${w.state}/lock is free`,
    state: `PASS      state — ${w.state}/state.env is a regular file the migration accepts, with no flat window or rollback`,
    deployed: `PASS      deployed — DEPLOYED_SHA ${s12(w.deployed)} is an ancestor of origin/main ${s12(w.head)}`,
    'image-state': `PASS      image-state — no ${w.state}/image-state.env`,
    helper: 'PASS      helper — wbb-image: every installed copy matches HEAD abc1234',
    gh: 'PASS      gh — gh attestation verify knows --source-digest and --deny-self-hosted-runners',
    checkout: `PASS      checkout — clean, HEAD = origin/main ${s12(w.head)}`,
    image: `PASS      image — HEAD ${s12(w.head)} → ${DIGEST}, attested (the controller's gh attestation verify)`,
    quadlet: `PASS      quadlet — no ${w.etc}/containers/systemd/warsaw-beer-bot.container`,
    space: `PASS      space — ${w.containers}: 6 GiB, ${w.root}/var: 6 GiB`,
    'old-checkouts': `PASS      old-checkouts — none unprotected in ${w.homes} (with the guard: ${w.homes}/guarded)`,
    rehearsal: 'PASS      rehearsal — nothing of wbb-rehearsal is left (kit root, Quadlet file, unit, container)',
  };
}
function output(w: World, replace: Record<string, string[]>, result: string): string {
  const lines = Object.entries(passLines(w)).flatMap(([k, l]) => replace[k] ?? [l]);
  return [`=== switchover preflight: ${w.git} ===`, ...lines, result, ''].join('\n');
}

/** Everything under a directory: path, kind, mode, mtime and content — what "writes nothing" compares. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) {
        out.push(`${p}/ ${s.mode} ${s.mtimeMs}`);
        walk(p);
      } else {
        out.push(`${p} ${s.mode} ${s.mtimeMs} ${readFileSync(p, 'utf8')}`);
      }
    }
  };
  walk(dir);
  return out;
}

describe('switchover-preflight.sh: all PASS', () => {
  it('prints PASS for each check and RESULT: PASS, exit 0', () => {
    const w = world();
    const r = run(w);
    expect([r.code, r.out, r.err]).toEqual([0, output(w, {}, 'RESULT: PASS (14 PASS, 0 EXPECTED, 0 FAIL)'), '']);
  });

  it("asks the image through the controller's own calls: the tag of HEAD, then gh attestation verify of its digest", () => {
    const w = world();
    run(w);
    const lines = readFileSync(join(w.stub, 'log'), 'utf8').split('\n');
    expect(lines.filter((l) => l.startsWith('curl ') || l.startsWith('gh '))).toEqual([
      'curl https://ghcr.io/token?scope=repository:ysilvestrov/warsaw-beer-bot:pull',
      `curl https://ghcr.io/v2/ysilvestrov/warsaw-beer-bot/manifests/${w.head}`,
      `gh attestation verify oci://ghcr.io/ysilvestrov/warsaw-beer-bot@${DIGEST} --repo ysilvestrov/warsaw-beer-bot `
        + '--signer-workflow ysilvestrov/warsaw-beer-bot/.github/workflows/ci.yml --source-ref refs/heads/main '
        + `--source-digest ${w.head} --deny-self-hosted-runners`,
    ]);
  });

  it('reads root-only things only through sudo -n: install-image --check, the old-checkout search, podman', () => {
    const w = world();
    run(w);
    const sudo = readFileSync(join(w.stub, 'log'), 'utf8').split('\n').filter((l) => l.startsWith('sudo '))
      .map((l) => l.replace(/ -c for r in .* _ /, ' -c <search> _ '));
    expect(sudo).toEqual([
      'sudo -n true',
      `sudo -n bash ${w.stub}/install-image --check`,
      `sudo -n bash -c <search> _ ${w.homes}`,
      `sudo -n ${w.stub}/podman container exists wbb-rehearsal`,
    ]);
  });

  it('writes nothing: the state directory, /etc, the kit parent, the homes and the checkout are identical after', () => {
    const w = world();
    // A lock file and a held-up state too: the failing paths read only as well.
    file(join(w.state, 'state.env'), `DEPLOYED_SHA=${w.deployed}\nWINDOW_SHA=${w.head}\n`);
    const dirs = [join(w.root, 'state'), w.etc, join(w.root, 'var'), w.homes, w.git, w.origin];
    const before = dirs.map(tree);
    const r = run(w);
    expect(r.code).toBe(1);
    expect(dirs.map(tree)).toEqual(before);
  });
});

describe('switchover-preflight.sh: the one EXPECTED state', () => {
  it('the installed wbb_image.py only predates the checkout → EXPECTED, still exit 0', () => {
    const w = world();
    put(w, 'helper-out', 'DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (content)\n1 difference(s): sudo bash deploy/install-image.sh\n');
    put(w, 'helper-rc', '1');
    const r = run(w);
    expect([r.code, r.out]).toEqual([0, output(w, {
      helper: ["EXPECTED  helper — the installed wbb_image.py predates this checkout's; step 7 reinstalls it (sudo bash deploy/install-image.sh)"],
    }, 'RESULT: PASS (13 PASS, 1 EXPECTED, 0 FAIL)')]);
  });
});

interface Case { name: string; setup: (w: World) => void; lines: (w: World) => Record<string, string[]>; fails: number }
const CASES: Case[] = [
  {
    name: 'timer enabled', fails: 1,
    setup: (w) => put(w, 'enabled-wbb-autodeploy.timer', 'enabled\n'),
    lines: () => ({ timer: ['FAIL      timer — wbb-autodeploy.timer is enabled and inactive — sudo systemctl disable --now wbb-autodeploy.timer'] }),
  },
  {
    name: 'timer active', fails: 1,
    setup: (w) => put(w, 'active-wbb-autodeploy.timer', 'active\n'),
    lines: () => ({ timer: ['FAIL      timer — wbb-autodeploy.timer is disabled and active — sudo systemctl disable --now wbb-autodeploy.timer'] }),
  },
  {
    name: 'service running', fails: 1,
    setup: (w) => put(w, 'active-wbb-autodeploy.service', 'activating\n'),
    lines: () => ({ service: ['FAIL      service — wbb-autodeploy.service is activating — a tick is running; wait until it ends (systemctl status wbb-autodeploy.service)'] }),
  },
  {
    name: 'state.env with an unfinished flat window', fails: 2,
    setup: (w) => file(join(w.state, 'state.env'), `DEPLOYED_SHA=${w.deployed}\nWINDOW_SHA=${w.head}\n`),
    lines: (w) => ({
      state: [`FAIL      state — ${w.state}/state.env line 2: WINDOW_SHA — a flat deploy window or rollback is unfinished; let the flat deployer finish it first (sudo systemctl enable --now wbb-autodeploy.timer until the window is gone, then step 2 again) — the migration (step 6) would refuse`],
      deployed: ['FAIL      deployed — no DEPLOYED_SHA read: the state check failed'],
    }),
  },
  {
    name: 'state.env with ROLLBACK_STARTED', fails: 2,
    setup: (w) => file(join(w.state, 'state.env'), `ROLLBACK_STARTED=1\nDEPLOYED_SHA=${w.deployed}\n`),
    lines: (w) => ({
      state: [`FAIL      state — ${w.state}/state.env line 1: ROLLBACK_STARTED — a flat deploy window or rollback is unfinished; let the flat deployer finish it first (sudo systemctl enable --now wbb-autodeploy.timer until the window is gone, then step 2 again) — the migration (step 6) would refuse`],
      deployed: ['FAIL      deployed — no DEPLOYED_SHA read: the state check failed'],
    }),
  },
  {
    name: 'state.env with a key the migration does not know', fails: 2,
    setup: (w) => file(join(w.state, 'state.env'), `DEPLOYED_SHA=${w.deployed}\nSOMETHING=x\n`),
    lines: (w) => ({
      state: [`FAIL      state — ${w.state}/state.env line 2: unknown key SOMETHING — the migration (step 6) would refuse`],
      deployed: ['FAIL      deployed — no DEPLOYED_SHA read: the state check failed'],
    }),
  },
  {
    name: 'state.env already a directory (migrated)', fails: 2,
    setup: (w) => { rmSync(join(w.state, 'state.env')); mkdirSync(join(w.state, 'state.env')); },
    lines: (w) => ({
      state: [`FAIL      state — ${w.state}/state.env is not a regular file (a directory there means the migration ran already) — the migration (step 6) would refuse`],
      deployed: ['FAIL      deployed — no DEPLOYED_SHA read: the state check failed'],
    }),
  },
  {
    name: 'DEPLOYED_SHA empty', fails: 1,
    setup: (w) => file(join(w.state, 'state.env'), 'DEPLOYED_SHA=\n'),
    lines: (w) => ({
      deployed: [`FAIL      deployed — ${w.state}/state.env records no DEPLOYED_SHA — the first image release starts from the commit the flat tree runs`],
    }),
  },
  {
    name: 'DEPLOYED_SHA not on main', fails: 1,
    setup: (w) => {
      git(w.git, 'checkout', '-q', '-b', 'side', w.deployed);
      git(w.git, 'commit', '-q', '--allow-empty', '-m', 'off main');
      const off = git(w.git, 'rev-parse', 'HEAD');
      git(w.git, 'checkout', '-q', '-');
      git(w.git, 'checkout', '-q', '--detach', w.head);
      file(join(w.state, 'state.env'), `DEPLOYED_SHA=${off}\n`);
      put(w, 'off', off);
    },
    lines: (w) => ({
      deployed: [`FAIL      deployed — DEPLOYED_SHA ${s12(readFileSync(join(w.stub, 'off'), 'utf8'))} is not an ancestor of origin/main ${s12(w.head)} (or not in this checkout)`],
    }),
  },
  {
    name: 'image-state.env exists', fails: 1,
    setup: (w) => file(join(w.state, 'image-state.env'), `DEPLOYED_SHA=${w.deployed}\n`),
    lines: (w) => ({
      'image-state': [`FAIL      image-state — ${w.state}/image-state.env exists — the migration refuses a different one; find out who wrote it (deploy/README.md → Migrating the flat deployer's state)`],
    }),
  },
  {
    name: 'helper not installed', fails: 1,
    setup: (w) => {
      put(w, 'helper-out', 'DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (not installed)\n1 difference(s): sudo bash deploy/install-image.sh\n');
      put(w, 'helper-rc', '1');
    },
    lines: () => ({
      helper: ['FAIL      helper — sudo bash deploy/install-image.sh --check (exit 1): DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (not installed); 1 difference(s): sudo bash deploy/install-image.sh'],
    }),
  },
  {
    name: 'helper stale and another difference', fails: 1,
    setup: (w) => {
      put(w, 'helper-out', 'DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (content)\nDIFFERS: /etc/sudoers.d/wbb-image (mode 644, want 440)\n2 difference(s): sudo bash deploy/install-image.sh\n');
      put(w, 'helper-rc', '1');
    },
    lines: () => ({
      helper: ['FAIL      helper — sudo bash deploy/install-image.sh --check (exit 1): DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (content); DIFFERS: /etc/sudoers.d/wbb-image (mode 644, want 440); 2 difference(s): sudo bash deploy/install-image.sh'],
    }),
  },
  {
    name: 'helper: the content of another file differs', fails: 1,
    setup: (w) => {
      put(w, 'helper-out', 'DIFFERS: /usr/local/lib/wbb-image/bounded.py (content)\n1 difference(s): sudo bash deploy/install-image.sh\n');
      put(w, 'helper-rc', '1');
    },
    lines: () => ({
      helper: ['FAIL      helper — sudo bash deploy/install-image.sh --check (exit 1): DIFFERS: /usr/local/lib/wbb-image/bounded.py (content); 1 difference(s): sudo bash deploy/install-image.sh'],
    }),
  },
  {
    name: 'gh without --deny-self-hosted-runners', fails: 1,
    setup: (w) => put(w, 'gh-help', 'Flags:\n      --source-digest string   Enforce\n'),
    lines: () => ({ gh: ['FAIL      gh — gh attestation verify --help has no --deny-self-hosted-runners — upgrade gh'] }),
  },
  {
    name: 'checkout dirty', fails: 1,
    setup: (w) => file(join(w.git, 'README'), 'changed\n'),
    lines: (w) => ({ checkout: [`FAIL      checkout — ${w.git} is not clean (git status --porcelain:  M README ) — install-image.sh refuses it`] }),
  },
  {
    name: 'HEAD behind origin/main', fails: 1,
    setup: (w) => {
      git(w.git, 'commit', '-q', '--allow-empty', '-m', 'newer');
      git(w.git, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
      put(w, 'newer', git(w.git, 'rev-parse', 'HEAD'));
      git(w.git, 'checkout', '-q', '--detach', w.head);
    },
    lines: (w) => {
      const newer = readFileSync(join(w.stub, 'newer'), 'utf8');
      return {
        deployed: [`PASS      deployed — DEPLOYED_SHA ${s12(w.deployed)} is an ancestor of origin/main ${s12(newer)}`],
        checkout: [`FAIL      checkout — HEAD ${s12(w.head)} is not origin/main ${s12(newer)} — git switch main && git pull`],
      };
    },
  },
  {
    name: 'no image published for HEAD', fails: 1,
    setup: (w) => rmSync(join(w.stub, 'reg', w.head)),
    lines: (w) => ({
      image: [`FAIL      image — no image is published for HEAD ${s12(w.head)} (no tag ${w.head} in ghcr.io/ysilvestrov/warsaw-beer-bot) — wait for CI's image job`],
    }),
  },
  {
    name: 'the attestation does not pass', fails: 1,
    setup: (w) => put(w, 'attest-rc', '1'),
    lines: (w) => ({
      image: [`FAIL      image — the image of HEAD ${s12(w.head)} (${DIGEST}) does not pass the controller's attestation (exit 1): verification output `],
    }),
  },
  {
    name: "production's Quadlet file exists", fails: 1,
    setup: (w) => file(join(w.etc, 'containers/systemd/warsaw-beer-bot.container'), '[Container]\n'),
    lines: (w) => ({
      quadlet: [`FAIL      quadlet — ${w.etc}/containers/systemd/warsaw-beer-bot.container exists — the bootstrap requires that it does not (deploy/README.md → The first image release)`],
    }),
  },
  {
    name: 'one KiB under 5 GiB free', fails: 1,
    setup: (w) => put(w, 'df-avail', String(5 * GIB - 1)),
    lines: (w) => ({
      space: [`FAIL      space — ${w.containers}: 5119 MiB, need 5 GiB, ${w.root}/var: 5119 MiB, need 5 GiB`],
    }),
  },
  {
    name: 'an old checkout without the guard', fails: 1,
    setup: (w) => { mkdirSync(join(w.homes, 'old/deploy'), { recursive: true }); file(join(w.homes, 'old/deploy/deploy.sh'), UNGUARDED); },
    lines: (w) => ({
      'old-checkouts': [`FAIL      old-checkouts — a flat deploy.sh without the state.env guard in: ${w.homes}/old — update (git pull) or remove each before the bootstrap`],
    }),
  },
  {
    name: 'the rehearsal kit root left over', fails: 1,
    setup: (w) => mkdirSync(w.kit),
    lines: (w) => ({
      rehearsal: [`FAIL      rehearsal — left over: ${w.kit} — remove it as the rehearsal's cleanup does (deploy/README.md → Switchover session, step 5)`],
    }),
  },
  {
    name: 'the rehearsal Quadlet file and unit file left over', fails: 1,
    setup: (w) => {
      file(join(w.etc, 'containers/systemd/wbb-rehearsal.container'), '');
      file(join(w.etc, 'systemd/system/wbb-rehearsal.service'), '');
    },
    lines: (w) => ({
      rehearsal: [`FAIL      rehearsal — left over: ${w.etc}/containers/systemd/wbb-rehearsal.container; ${w.etc}/systemd/system/wbb-rehearsal.service — remove it as the rehearsal's cleanup does (deploy/README.md → Switchover session, step 5)`],
    }),
  },
  {
    name: 'the rehearsal unit still known and its container there', fails: 1,
    setup: (w) => {
      put(w, 'show-wbb-rehearsal.service', 'LoadState=loaded\nActiveState=failed\n');
      put(w, 'podman-exists-rc', '0');
    },
    lines: () => ({
      rehearsal: ["FAIL      rehearsal — left over: the unit wbb-rehearsal.service (LoadState=loaded ActiveState=failed); the container wbb-rehearsal — remove it as the rehearsal's cleanup does (deploy/README.md → Switchover session, step 5)"],
    }),
  },
];

describe('switchover-preflight.sh: each check FAILs on its own fact', () => {
  it.each(CASES)('$name', ({ setup, lines, fails }) => {
    const w = world();
    setup(w);
    const r = run(w);
    const passes = 14 - fails;
    expect([r.code, r.out]).toEqual([1, output(w, lines(w), `RESULT: FAIL (${passes} PASS, 0 EXPECTED, ${fails} FAIL)`)]);
  });

  it('the deploy lock held by another process → FAIL lock', async () => {
    const w = world();
    const holder = spawn('flock', [join(w.state, 'lock'), 'bash', '-c', 'echo held; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((done) => holder.stdout.once('data', () => done()));
    const r = await new Promise<Result>((done) => {
      const p = spawn('bash', [PREFLIGHT], { env: w.env });
      let out = '';
      p.stdout.on('data', (b) => { out += b; });
      p.on('close', (code) => done({ code, out, err: '' }));
    });
    holder.kill('SIGKILL');
    expect([r.code, r.out]).toEqual([1, output(w, {
      lock: [`FAIL      lock — ${w.state}/lock is held (a tick or a deploy.sh) — fuser -v ${w.state}/lock; wait until it is free`],
    }, 'RESULT: FAIL (13 PASS, 0 EXPECTED, 1 FAIL)')]);
  });

  it('no lock file at all is a free lock, and it is not created', () => {
    const w = world();
    rmSync(join(w.state, 'lock'));
    const r = run(w);
    expect([r.code, r.out.split('\n')[3], readdirSync(w.state)]).toEqual([0, `PASS      lock — no lock file at ${w.state}/lock`, ['state.env']]);
  });
});

describe('switchover-preflight.sh: refusals before any check', () => {
  it('as root → REFUSED, no check, exit 1', () => {
    const w = world();
    w.env.PREFLIGHT_EUID = '0';
    const r = run(w);
    expect([r.code, r.out, r.err]).toEqual([1, '',
      'REFUSED: run as the operator, not as root: the deploy state is the operator\'s (~/.local/state/wbb-autodeploy)\nNo check was run.\n']);
  });

  it('no sudo ticket → REFUSED, no check, exit 1', () => {
    const w = world();
    put(w, 'no-ticket', '');
    const r = run(w);
    expect([r.code, r.out, r.err, readFileSync(join(w.stub, 'log'), 'utf8')]).toEqual([1, '',
      'REFUSED: no sudo credentials are cached — run sudo -v first (the checks read root-only files through sudo -n)\nNo check was run.\n',
      'sudo -n true\n']);
  });

  it('an argument → usage, exit 64', () => {
    const w = world();
    const r = run(w, ['--fix']);
    expect([r.code, r.out, r.err]).toEqual([64, '', 'usage: sudo -v && bash scripts/ops/switchover-preflight.sh   (no arguments)\n']);
  });
});
