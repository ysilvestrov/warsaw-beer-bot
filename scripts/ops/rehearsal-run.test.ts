import { beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { makeTempDirectory } from '../test-temp';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Stage «в» harness, Task 2 (docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md,
 * "Рішення" п.1–4): scripts/ops/rehearsal/run.sh with every outside contact a stub that logs its call — sudo,
 * systemctl, podman, the registry (curl), df, the clock, the shim and the controller. The stub shim keeps the
 * kit unit's "what runs" in files (activate writes it, current reads it); the stub controller runs, per
 * invocation, a snippet the test wrote: it calls the kit's generated WBB_IMAGE_CMD and notifier, writes the
 * state, advances the clock and exits with the code a real run would. Expected texts are literals.
 */
const RUN = resolve(__dirname, 'rehearsal/run.sh');
const ROOT = resolve(__dirname, '../..');

const ID = 'a'.repeat(64);
const DS = `sha256:${'1'.repeat(64)}`;
const DD = `sha256:${'2'.repeat(64)}`;
const CS = 'c'.repeat(64);
const CD = 'd'.repeat(64);
const PROD_CURRENT = 'CURRENT quadlet=none container-image=none container-digest=none unit=foreign';
const PROD_SHOW = 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\n';

let FREE_PORT = 0;
beforeAll(async () => {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  FREE_PORT = (s.address() as { port: number }).port;
  await new Promise<void>((done) => s.close(() => done()));
});

function file(path: string, text: string, mode = 0o644): void {
  writeFileSync(path, text);
  chmodSync(path, mode);
}

const SUDO = `printf 'sudo %s\\n' "$*" >> "$STUB_DIR/log"
if [ "$*" = "-n true" ]; then exit "$(cat "$STUB_DIR/sudo-rc")"; fi
if [ "$*" = "-n -v" ]; then exit 0; fi
# run.sh calls nothing but sudo -n.
if [ "$1" != -n ]; then echo "stub sudo: not -n: $*" >&2; exit 99; fi
shift
if [ "$1" = -u ]; then exit 0; fi
if [ "$1" = python3 ] && [ "$3" = -c ]; then cat "$STUB_DIR/prod-current"; exit "$(cat "$STUB_DIR/prod-current-rc")"; fi
if [ -e "$STUB_DIR/lapsed" ]; then echo 'sudo: a password is required' >&2; exit 1; fi
while [[ \${1:-} == *=* ]]; do export "$1"; shift; done
if [ "$1" = install ]; then
  args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
  done
  exec "\${args[@]}"
fi
exec "$@"`;

// show <unit> -p A,B [--value] | show -p A --value <unit>: the unit's properties from a file, in the order asked.
const SYSTEMCTL = `printf 'systemctl %s\\n' "$*" >> "$STUB_DIR/log"
case "$1" in
  show)
    shift
    unit="" props="" value=0
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) props="$2"; shift 2 ;; --value) value=1; shift ;; *) unit="$1"; shift ;; esac
    done
    src="$STUB_DIR/props-$unit"
    if [ "$unit" = wbb-rehearsal.service ] && [ -e "$STUB_DIR/kit-active" ]; then src="$STUB_DIR/props-kit-active"; fi
    IFS=, read -r -a want <<< "$props"
    for p in "\${want[@]}"; do
      v=$(sed -n "s/^$p=//p" "$src")
      if [ "$value" = 1 ]; then echo "$v"; else echo "$p=$v"; fi
    done ;;
  stop) if [ -e "$STUB_DIR/stop-hangs" ]; then exec sleep 1000; fi
    if [ "$2" = wbb-rehearsal.service ]; then rm -f "$STUB_DIR/kit-active"; fi ;;
  is-active) cat "$STUB_DIR/active-$2" 2>/dev/null || echo inactive ;;
esac
exit 0`;

const PODMAN = `printf 'podman %s\\n' "$*" >> "$STUB_DIR/log"
if [ "$1 $2" = "container exists" ]; then exit "$(cat "$STUB_DIR/podman-exists-rc")"; fi
exit 0`;

// GHCR as the kit reads it: reg/<sha> holds "<digest> <content>"; the config blob of a digest is named after
// its content, and carries it as wbb.content.
const CURL = `url="\${*: -1}"
case "$url" in
  *'/token?'*) echo '{"token":"tok"}' ;;
  */manifests/sha256:*)
    d="\${url##*/manifests/}"
    c=$(cat "$STUB_DIR"/reg/* | awk -v d="$d" '$1 == d { print $2 }')
    echo "{\\"config\\": {\\"digest\\": \\"sha256:$c\\"}}" ;;
  */manifests/*)
    sha="\${url##*/}"
    if [ -f "$STUB_DIR/reg/$sha" ]; then
      printf 'HTTP/2 200\\r\\ndocker-content-digest: %s\\r\\n\\r\\n' "$(awk '{ print $1 }' "$STUB_DIR/reg/$sha")"
    else
      printf 'HTTP/2 404\\r\\n\\r\\n'
    fi ;;
  */blobs/sha256:*) echo "{\\"config\\": {\\"Labels\\": {\\"wbb.content\\": \\"\${url##*/blobs/sha256:}\\"}}}" ;;
  *) exit 22 ;;
esac`;

const DF = `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 1 1 %s 1%% /\\n' "$(cat "$STUB_DIR/df-avail")"`;

const SHIM = `import os, sys
st = os.environ['STUB_DIR']
def rd(name, default=''):
    p = os.path.join(st, name)
    return open(p).read().strip() if os.path.exists(p) else default
args = sys.argv[1:]
if args == ['--kit-root']:
    print(rd('kit-root')); sys.exit(0)
if args == ['--kit-port']:
    print(rd('kit-port')); sys.exit(0)
sick = os.environ.get('REHEARSAL_SICK_DIGEST', '')
with open(os.path.join(st, 'log'), 'a') as f:
    f.write('shim ' + ' '.join(args) + (' sick=' + sick if sick else '') + '\\n')
step = {'pull': 40, 'audit': 12, 'trial': 95}.get(args[0])
if step:
    t = int(rd('clock')) + step
    with open(os.path.join(st, 'clock'), 'w') as f:
        f.write(str(t))
if args[0] == 'current':
    q = rd('kit-quadlet', 'none')
    foreign = os.path.exists(os.path.join(os.environ['REHEARSAL_ETC'], 'systemd/system/wbb-rehearsal.service'))
    unit = 'foreign' if foreign else ('quadlet' if q != 'none' else 'absent')
    print(f'CURRENT quadlet={q} container-image={"${ID}" if q != "none" else "none"} container-digest={q} unit={unit}')
elif args[0] == 'activate':
    with open(os.path.join(st, 'kit-quadlet'), 'w') as f:
        f.write(args[2])
    open(os.path.join(st, 'kit-active'), 'w').close()
    print('ACTIVATED ' + args[2])
`;

const CONTROLLER = `STATE="$XDG_STATE_HOME/wbb-autodeploy/image-state.env"
if [ "$*" = --check-state ]; then
  if [ -e "$STUB_DIR/state-bad" ]; then echo "STATE CORRUPT — $STATE: x" >&2; exit 3; fi
  echo "STATE OK — $STATE"; exit 0
fi
n=$(( $(cat "$STUB_DIR/ctl-count") + 1 ))
echo "$n" > "$STUB_DIR/ctl-count"
printf 'controller %s\\n' "$*" >> "$STUB_DIR/log"
put() { printf '%s\\n' "$@" > "$STATE"; }
img() { "$WBB_IMAGE_CMD" "$@" > /dev/null; }
say() { "$WBB_NOTIFY_CMD" "$1"; }
adv() { echo $(( $(cat "$STUB_DIR/clock") + $1 )) > "$STUB_DIR/clock"; }
hang() { exec sleep 1000; }
stop_here() { echo "$$" > "$STUB_DIR/blocked"; exec sleep 1000; }
. "$STUB_DIR/ctl/$n.sh"`;

interface World {
  root: string; stub: string; kit: string; etc: string; tmp: string; git: string;
  base: string; S: string; D: string; env: Record<string, string>;
}

/** ci and image green in one check suite, as gh prints them for the controller's ci_verdict: PASS. */
const GREEN = 'ci\tcompleted\tsuccess\t7\nimage\tcompleted\tsuccess\t7\n';

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_AUTHOR_DATE: '2026-10-23T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-23T00:00:00Z',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A host where every precondition holds: main …→S→D, both published with different content, all free. */
function world(): World {
  const root = makeTempDirectory('wbb-rehearsal-run-');
  const stub = join(root, 'stub');
  const etc = join(root, 'etc');
  const tmp = join(root, 'tmp');
  const repo = join(root, 'git');
  for (const d of [stub, join(stub, 'ctl'), join(stub, 'reg'), join(etc, 'containers/systemd'), join(etc, 'systemd/system'), tmp, repo, join(root, 'kit')]) {
    mkdirSync(d, { recursive: true });
  }
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'S');
  const S = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'D');
  const D = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', D);

  const sh = (name: string, body: string) => file(join(stub, name), `#!/usr/bin/env bash\n${body}\n`, 0o755);
  sh('sudo', SUDO);
  sh('systemctl', SYSTEMCTL);
  sh('podman', PODMAN);
  sh('curl', CURL);
  sh('df', DF);
  sh('now', 'cat "$STUB_DIR/clock"');
  sh('controller', CONTROLLER);
  // The PRs of a commit, as gh prints them for the controller: prs/<sha> holds number<TAB>label,label.
  sh('labels', '[ -e "$STUB_DIR/labels-rc" ] && exit "$(cat "$STUB_DIR/labels-rc")"; cat "$STUB_DIR/prs/$1" 2>/dev/null; exit 0');
  mkdirSync(join(stub, 'prs'));
  // The check runs of a commit, as the controller's _checks_default prints them: ci/<sha>; each read logged
  // apart (the main log holds only what a refused run must not have written).
  sh('checks', 'echo "$1" >> "$STUB_DIR/checks-log"; [ -e "$STUB_DIR/checks-rc" ] && exit "$(cat "$STUB_DIR/checks-rc")"; cat "$STUB_DIR/ci/$1"');
  mkdirSync(join(stub, 'ci'));
  file(join(stub, 'shim.py'), SHIM);
  const kit = join(root, 'kit', 'wbb-rehearsal');
  const state: Record<string, string> = {
    'sudo-rc': '0', 'podman-exists-rc': '1', 'df-avail': String(5 * 1024 * 1024), clock: '1000', 'ctl-count': '0',
    'kit-root': kit, 'kit-port': String(FREE_PORT), 'prod-current': `${PROD_CURRENT}\n`,
    'props-wbb-rehearsal.service': 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\n',
    'props-kit-active': 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=77\nNRestarts=0\n',
    'props-warsaw-beer-bot.service': PROD_SHOW, log: '', 'prod-current-rc': '0',
  };
  for (const [k, v] of Object.entries(state)) file(join(stub, k), v);
  file(join(stub, 'reg', S), `${DS} ${CS}\n`);
  file(join(stub, 'reg', D), `${DD} ${CD}\n`);
  file(join(stub, 'ci', S), GREEN);
  file(join(stub, 'ci', D), GREEN);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: tmp, STUB_DIR: stub,
    REHEARSAL_SUDO: join(stub, 'sudo'), REHEARSAL_SYSTEMCTL: join(stub, 'systemctl'), REHEARSAL_PODMAN: join(stub, 'podman'),
    REHEARSAL_CURL: join(stub, 'curl'), REHEARSAL_DF: join(stub, 'df'), REHEARSAL_CLOCK: join(stub, 'now'),
    REHEARSAL_CONTROLLER: join(stub, 'controller'), REHEARSAL_SHIM: join(stub, 'shim.py'), REHEARSAL_GIT_DIR: repo,
    REHEARSAL_ETC: etc, REHEARSAL_PROD_DB: join(root, 'prod', 'bot.db'), REHEARSAL_CONTAINERS_ROOT: join(root, 'containers'),
    REHEARSAL_EUID: '1000', REHEARSAL_POLL_S: '0.05', REHEARSAL_KEEPALIVE_S: '3600', REHEARSAL_TERM_GRACE_S: '2',
    REHEARSAL_PR_LABELS_CMD: join(stub, 'labels'), REHEARSAL_CHECKS_CMD: join(stub, 'checks'), REHEARSAL_COMPAT_BASE: base,
  };
  return { root, stub, kit, etc, tmp, git: repo, base, S, D, env };
}

const settled = (w: World, sha: string, digest: string) => `put DEPLOYED_SHA=${sha} SETTLED_SHA=${sha} SETTLED_DIGEST=${digest}`;
const activating = (w: World, base: string) => `${base} WINDOW_PHASE=activating`;

/** The controller's runs when everything behaves as the plan expects, numbered as run.sh makes them. */
function expected(w: World): Record<number, string> {
  const s7 = w.S.slice(0, 7);
  const d7 = w.D.slice(0, 7);
  return {
    1: `img current; img pull --sha ${w.S} --digest ${DS}; img audit --digest ${DS}; img trial --digest ${DS} --previous ${DS} --snapshot p
img activate --digest ${DS}; ${settled(w, w.S, DS)}; say "✅ merge-deploy: the first image release ${s7} is live and settled"; exit 0`,
    2: `img activate --digest ${DD}; ${settled(w, w.D, DD)}; say "✅ merge-deploy ${d7} is live and settled."; exit 0`,
    3: `img activate --digest ${DS}; img activate --digest ${DD}; ${settled(w, w.D, DD)}
say "🔥 merge-deploy ROLLED BACK ${s7} → ${d7} (code only, DB untouched): x."; exit 2`,
    4: `${activating(w, settled(w, w.D, DD))}; img activate --digest ${DS}; exit 0`,
    5: `${settled(w, w.D, DD)}; exit 0`,
    6: `${activating(w, settled(w, w.D, DD))}; img activate --digest ${DS}; exit 0`,
    7: `adv 600; ${settled(w, w.S, DS)}; say "✅ merge-deploy ${s7} is live and settled."; exit 0`,
    8: `img activate --digest ${DD}; ${settled(w, w.S, DS)} WINDOW_PHASE=watching WINDOW_START=$(cat "$STUB_DIR/clock"); adv 180; hang`,
    9: `adv 300; ${settled(w, w.D, DD)}; say "✅ merge-deploy ${d7} is live and settled."; exit 0`,
    10: `${activating(w, settled(w, w.D, DD))}; img activate --digest ${DS}; exit 0`,
    11: `${settled(w, w.D, DD)} "INCIDENT=${w.S} ${DS} the unit is not our Quadlet (unit=foreign) in the activating window"; exit 3`,
  };
}
function script(w: World, runs: Record<number, string>): void {
  for (const [n, body] of Object.entries(runs)) file(join(w.stub, 'ctl', `${n}.sh`), `${body}\n`);
}

interface Result { code: number | null; signal: string | null; out: string; err: string }
function run(w: World, args: string[] = [w.S, w.D]): Result {
  const r = spawnSync('bash', [RUN, ...args], { encoding: 'utf8', env: w.env, timeout: 50_000 });
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr };
}

/** The stub log with its paths named: <R> the checkout, <T> the world, <W> run.sh's work dir, <K> the kit root. */
function log(w: World): string[] {
  return readFileSync(join(w.stub, 'log'), 'utf8').split('\n').filter((l) => l !== '')
    .map((l) => l.split(ROOT).join('<R>').split(w.kit).join('<K>').split(w.root).join('<T>').replace(/<T>\/tmp\/wbb-rehearsal\.[A-Za-z0-9]{6}/g, '<W>'));
}
const summary = (out: string) => out.slice(out.indexOf('=== rehearsal summary ==='));

const TITLES = [
  '(а) bootstrap S',
  '(б) deploy D',
  '(в) a sick candidate (S) is rolled back to D',
  '(г) killed before the activation: the next tick cancels the window',
  '(г) killed after the activation, before watching: the next tick watches a full window',
  '(г) killed while watching: the next tick goes on with the window',
  '(ґ) a unit that is not ours: the next tick opens an incident',
];
const P3 = ['P3 pull: 40s', 'P3 audit: 12s', 'P3 trial: 95s'];

const CLEANUP = [
  'sudo -n <T>/stub/systemctl stop wbb-rehearsal.service',
  'systemctl stop wbb-rehearsal.service',
  'sudo -n rm -f <T>/etc/containers/systemd/wbb-rehearsal.container <T>/etc/systemd/system/wbb-rehearsal.service',
  'sudo -n <T>/stub/systemctl daemon-reload',
  'systemctl daemon-reload',
  'sudo -n <T>/stub/systemctl reset-failed wbb-rehearsal.service',
  'systemctl reset-failed wbb-rehearsal.service',
  'sudo -n <T>/stub/podman rm -f --ignore wbb-rehearsal',
  'podman rm -f --ignore wbb-rehearsal',
  'sudo -n rm -rf <K>',
  'sudo -n <T>/stub/podman container exists wbb-rehearsal',
  'podman container exists wbb-rehearsal',
  'systemctl show wbb-rehearsal.service -p LoadState,ActiveState',
];
// The stray-process sweep (pkill/pgrep by the kit's paths) is checked on its own, below.
const fromCleanup = (lines: string[]) => lines.slice(lines.indexOf(CLEANUP[0])).filter((l) => !/^sudo -n p(kill|grep) /.test(l));
const PROD_READ = [
  `sudo -n python3 -I -c import sys; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv[1]); import wbb_image; sys.exit(wbb_image.main(["current"])) <R>/deploy/image/helper`,
  'systemctl show warsaw-beer-bot.service -p LoadState,ActiveState,SubState',
];

describe('run.sh: the scenarios as the plan expects them', () => {
  it('runs (а)–(ґ) in order, passes each, cleans up, and reports P3 from (а)', () => {
    const w = world();
    script(w, expected(w));
    const r = run(w);
    expect([r.code, summary(r.out)]).toEqual([0, [
      '=== rehearsal summary ===',
      `S=${w.S} D=${w.D}`,
      ...TITLES.map((t) => `PASS  ${t}`),
      'PASS  cleanup',
      'PASS  production unchanged',
      ...P3,
      'RESULT: PASS (9/9)',
      '',
    ].join('\n')]);
    const lines = log(w);
    expect(lines.filter((l) => l.startsWith('controller '))).toEqual([
      `controller --manual bootstrap --target ${w.S}`,
      `controller --manual deploy --target ${w.D}`,
      `controller --manual deploy --target ${w.S} --force`,
      `controller --manual deploy --target ${w.S} --force`,
      'controller ',
      `controller --manual deploy --target ${w.S} --force`,
      'controller ',
      `controller --manual deploy --target ${w.D}`,
      'controller ',
      `controller --manual deploy --target ${w.S} --force`,
      'controller ',
    ]);
    // The cleanup, the checks of what it left, and production read again are the last calls.
    expect(fromCleanup(lines)).toEqual([...CLEANUP, ...PROD_READ]);
    expect([existsSync(w.kit), readdirSync(w.tmp)]).toEqual([false, []]);
  });

  it('sends the sick digest to the shim only in (в), on the sudo command line', () => {
    const w = world();
    script(w, expected(w));
    run(w);
    expect(log(w).filter((l) => l.includes('REHEARSAL_SICK_DIGEST') || l.includes(' sick='))).toEqual([
      `sudo -n REHEARSAL_SICK_DIGEST=${DS} python3 -I <T>/stub/shim.py activate --digest ${DS}`,
      `shim activate --digest ${DS} sick=${DS}`,
      `sudo -n REHEARSAL_SICK_DIGEST=${DS} python3 -I <T>/stub/shim.py activate --digest ${DD}`,
      `shim activate --digest ${DD} sick=${DS}`,
    ]);
  });

  it('touches production only by reading it: every call that names it', () => {
    const w = world();
    script(w, expected(w));
    run(w);
    expect(log(w).filter((l) => l.includes('warsaw-beer-bot') || l.includes('sys.exit(wbb_image.main'))).toEqual([
      ...PROD_READ,
      'sudo -n install -d -m 0750 -o warsaw-beer-bot -g warsaw-beer-bot <K>/data <K>/data/deploy-snapshots',
      'sudo -n -u warsaw-beer-bot bash -lc "$0" "$@" <K>/bin/db-snapshot.sh snapshot <T>/prod/bot.db <K>/data/bot.db',
      ...PROD_READ,
    ]);
  });

  it('builds the kit as п.1 says: the directories, the snapshot script copy, the seeded state the controller checked', () => {
    const w = world();
    // (а) looks at the kit while it exists.
    script(w, { ...expected(w), 1: `cp "$XDG_STATE_HOME/wbb-autodeploy/image-state.env" "$STUB_DIR/seed"; ls -R "${w.kit}" > "$STUB_DIR/tree"
printf '%s\\n' "$WBB_INSTALLED_CHECK" "\${WBB_INSTALLED_CHECK+set}" "$WBB_DB_PATH" "$WBB_SNAPSHOT_DIR" "$WBB_SNAPSHOT_BIN" "$("$WBB_API_PORT_CMD")" > "$STUB_DIR/seams"
"$WBB_READ_ENV_CMD" TELEGRAM_BOT_TOKEN; echo "read-env $?" >> "$STUB_DIR/seams"
${expected(w)[1]}` });
    run(w);
    expect(readFileSync(join(w.stub, 'seed'), 'utf8')).toBe(`DEPLOYED_SHA=${w.S}\nLAST_SEEN_DEPLOYED_SHA=${w.S}\n`);
    expect(readFileSync(join(w.stub, 'tree'), 'utf8')).toBe(
      `${w.kit}:\nbin\ndata\nscratch\n\n${w.kit}/bin:\ndb-snapshot.sh\n\n${w.kit}/data:\ndeploy-snapshots\n\n${w.kit}/data/deploy-snapshots:\n\n${w.kit}/scratch:\n`);
    expect(readFileSync(join(w.stub, 'seams'), 'utf8')).toBe(
      ['', 'set', `${w.kit}/data/bot.db`, `${w.kit}/data/deploy-snapshots`, `${w.kit}/bin/db-snapshot.sh`, String(FREE_PORT), 'read-env 1', ''].join('\n'));
    expect(log(w).filter((l) => l.startsWith('sudo -n install'))).toEqual([
      'sudo -n install -d -m 0755 -o root -g root <K> <K>/bin',
      'sudo -n install -d -m 0700 -o root -g root <K>/scratch',
      'sudo -n install -d -m 0750 -o warsaw-beer-bot -g warsaw-beer-bot <K>/data <K>/data/deploy-snapshots',
      'sudo -n install -m 0755 -o root -g root <R>/deploy/db-snapshot.sh <K>/bin/db-snapshot.sh',
    ]);
  });

  it('P3: the durations between the start and the end of the first pull, audit and trial of (а)', () => {
    const w = world();
    script(w, { ...expected(w), 1: `img current; img pull --sha ${w.S} --digest ${DS}; adv 7; img audit --digest ${DS}; img trial --digest ${DS}; img trial --digest ${DS}
img activate --digest ${DS}; ${settled(w, w.S, DS)}; exit 0` });
    const r = run(w);
    expect(summary(r.out).split('\n').filter((l) => l.startsWith('P3 '))).toEqual(P3);
  });

  it('P3 of a (а) that never pulled: not measured', () => {
    const w = world();
    script(w, { ...expected(w), 1: `${settled(w, w.S, DS)}; exit 1` });
    const r = run(w);
    expect(summary(r.out).split('\n').filter((l) => l.startsWith('P3 '))).toEqual(
      ['P3 pull: not measured', 'P3 audit: not measured', 'P3 trial: not measured']);
  });
});

describe('run.sh: a scenario that ends otherwise', () => {
  it('(в) exits 1 instead of rolling back: FAIL with the reason, the rest not run, cleaned up, exit 1', () => {
    const w = world();
    script(w, { ...expected(w), 3: expected(w)[3].replace('exit 2', 'exit 1') });
    const r = run(w);
    expect([r.code, summary(r.out)]).toEqual([1, [
      '=== rehearsal summary ===',
      `S=${w.S} D=${w.D}`,
      `PASS  ${TITLES[0]}`,
      `PASS  ${TITLES[1]}`,
      `FAIL  ${TITLES[2]} — exit: expected 2, got 1`,
      ...TITLES.slice(3).map((t) => `SKIP  ${t} — not run`),
      'PASS  cleanup',
      'PASS  production unchanged',
      ...P3,
      'RESULT: FAIL (4/9)',
      '',
    ].join('\n')]);
    expect(fromCleanup(log(w))).toEqual([...CLEANUP, ...PROD_READ]);
  });

  it('(г) killed after the activation, but the tick finished a window it had not watched in full: FAIL', () => {
    const w = world();
    script(w, { ...expected(w), 7: expected(w)[7].replace('adv 600', 'adv 599') });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[6]]).toEqual([1,
      `FAIL  ${TITLES[4]} — a full window from now (the tick took >= 600s): expected yes, got no: 599s`]);
  });

  it('(г) killed while watching, but the tick took a full window: FAIL', () => {
    const w = world();
    script(w, { ...expected(w), 9: expected(w)[9].replace('adv 300', 'adv 600') });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[7]]).toEqual([1,
      `FAIL  ${TITLES[5]} — the window went on (the tick took < 600s): expected yes, got no: 600s`]);
  });

  it('(ґ) the tick does not open the incident: FAIL', () => {
    const w = world();
    script(w, { ...expected(w), 11: `${settled(w, w.D, DD)}; exit 0` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[8]]).toEqual([1,
      `FAIL  ${TITLES[6]} — the tick's exit: expected 3, got 0; INCIDENT: expected open, unit=foreign, got (empty)`]);
  });

  it('production changed meanwhile: FAIL, loud, with what it was and what it is', () => {
    const w = world();
    script(w, { ...expected(w), 2: `echo 'CURRENT quadlet=${DD} container-image=${ID} container-digest=${DD} unit=quadlet' > "$STUB_DIR/prod-current"
${expected(w)[2]}` });
    const r = run(w);
    expect([r.code, summary(r.out)]).toEqual([1, [
      '=== rehearsal summary ===',
      `S=${w.S} D=${w.D}`,
      ...TITLES.map((t) => `PASS  ${t}`),
      'PASS  cleanup',
      'FAIL  production unchanged — PRODUCTION CHANGED',
      '!!! PRODUCTION CHANGED DURING THE REHEARSAL — look at warsaw-beer-bot.service now !!!',
      'before:',
      `  ${PROD_CURRENT}`,
      '  LoadState=loaded', '  ActiveState=active', '  SubState=running',
      'after:',
      `  CURRENT quadlet=${DD} container-image=${ID} container-digest=${DD} unit=quadlet`,
      '  LoadState=loaded', '  ActiveState=active', '  SubState=running',
      ...P3,
      'RESULT: FAIL (8/9)',
      '',
    ].join('\n')]);
  });

  it('the flat bot restarted on its own meanwhile (a new MainPID, the same unit state): production unchanged', () => {
    const w = world();
    script(w, { ...expected(w), 2: `sed -i 's/^MainPID=4242$/MainPID=5151/' "$STUB_DIR/props-warsaw-beer-bot.service"
${expected(w)[2]}` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[10], readFileSync(join(w.stub, 'props-warsaw-beer-bot.service'), 'utf8')]).toEqual([0,
      'PASS  production unchanged', PROD_SHOW.replace('4242', '5151')]);
  });

  it('the flat bot stopped meanwhile (ActiveState differs): FAIL production unchanged', () => {
    const w = world();
    script(w, { ...expected(w), 2: `sed -i 's/^ActiveState=active$/ActiveState=inactive/' "$STUB_DIR/props-warsaw-beer-bot.service"
${expected(w)[2]}` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[10]]).toEqual([1, 'FAIL  production unchanged — PRODUCTION CHANGED']);
  });

  it('a cleanup that leaves the container: FAIL cleanup', () => {
    const w = world();
    script(w, { ...expected(w), 11: `echo 0 > "$STUB_DIR/podman-exists-rc"\n${expected(w)[11]}` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[9]]).toEqual([1,
      'FAIL  cleanup — the container wbb-rehearsal is still there (or podman could not say)']);
    expect(r.out.split('\n').filter((l) => l.startsWith('CLEANUP FAILED'))).toEqual([
      'CLEANUP FAILED: the container wbb-rehearsal is still there (or podman could not say) — sudo podman rm -f --ignore wbb-rehearsal',
      'CLEANUP FAILED — what the cleanup does, to run by hand:',
    ]);
  });

  // #911 AI review: the cleanup ignores INT/TERM/HUP, so a hung command must end on its own limit.
  it('a cleanup command that hangs: cut at its limit, CLEANUP FAILED with the recipe, the rest of the cleanup runs', () => {
    const w = world();
    script(w, { ...expected(w), 11: `touch "$STUB_DIR/stop-hangs"\n${expected(w)[11]}` });
    w.env.REHEARSAL_CLEANUP_STEP_S = '1';
    const r = run(w);
    expect([r.code, r.out.split('\n').filter((l) => l.startsWith('CLEANUP FAILED')), summary(r.out).split('\n')[9]]).toEqual([1, [
      'CLEANUP FAILED: systemctl stop wbb-rehearsal.service (exit 124) — sudo systemctl stop wbb-rehearsal.service',
      // The stop never ran, so the unit is still active: the check after says so too.
      'CLEANUP FAILED: systemd still knows wbb-rehearsal.service — sudo systemctl stop wbb-rehearsal.service; sudo systemctl daemon-reload; sudo systemctl reset-failed wbb-rehearsal.service',
      'CLEANUP FAILED — what the cleanup does, to run by hand:',
    ], 'FAIL  cleanup — systemctl stop wbb-rehearsal.service (exit 124); systemd still knows wbb-rehearsal.service']);
    expect(existsSync(w.kit)).toBe(false);
  });

  it('cleanup steps that fail (rm refused): CLEANUP FAILED with each recipe, the whole recipe, FAIL cleanup', () => {
    const w = world();
    // From (ґ) on, the rm the stub sudo runs refuses everything.
    script(w, { ...expected(w), 11: `printf '#!/usr/bin/env bash\\nexit 1\\n' > "$STUB_DIR/rm"; chmod +x "$STUB_DIR/rm"\n${expected(w)[11]}` });
    w.env.PATH = `${w.stub}:${w.env.PATH}`;
    const r = run(w);
    expect(r.out.split('\n').filter((l) => l.startsWith('CLEANUP FAILED') || l.startsWith('  sudo ') || l.startsWith('FAIL  cleanup'))
      .map((l) => l.split(w.root).join('<T>').replace(/<T>\/tmp\/wbb-rehearsal\.[A-Za-z0-9]+/g, '<W>'))).toEqual([
      'CLEANUP FAILED: rm -f <T>/etc/containers/systemd/wbb-rehearsal.container <T>/etc/systemd/system/wbb-rehearsal.service — sudo rm -f <T>/etc/containers/systemd/wbb-rehearsal.container <T>/etc/systemd/system/wbb-rehearsal.service',
      'CLEANUP FAILED: rm -rf <T>/kit/wbb-rehearsal — sudo rm -rf <T>/kit/wbb-rehearsal',
      'CLEANUP FAILED: rm -rf <W> — rm -rf <W>',
      // (ґ)'s own removal of the shadowing unit file failed too: it is left, and systemd still has it.
      'CLEANUP FAILED: <T>/etc/systemd/system/wbb-rehearsal.service is still there — sudo rm -rf <T>/etc/systemd/system/wbb-rehearsal.service',
      'CLEANUP FAILED: <T>/kit/wbb-rehearsal is still there — sudo rm -rf <T>/kit/wbb-rehearsal',
      'CLEANUP FAILED: systemd still knows wbb-rehearsal.service — sudo systemctl stop wbb-rehearsal.service; sudo systemctl daemon-reload; sudo systemctl reset-failed wbb-rehearsal.service',
      'CLEANUP FAILED — what the cleanup does, to run by hand:',
      '  sudo systemctl stop wbb-rehearsal.service',
      '  sudo rm -f <T>/etc/containers/systemd/wbb-rehearsal.container <T>/etc/systemd/system/wbb-rehearsal.service',
      '  sudo systemctl daemon-reload',
      '  sudo systemctl reset-failed wbb-rehearsal.service',
      '  sudo podman rm -f --ignore wbb-rehearsal',
      '  sudo rm -rf <T>/kit/wbb-rehearsal',
      // The kit's own rm -rf of its work directory meets the refusing rm too (it is looked up afresh under timeout).
      'FAIL  cleanup — rm -f <T>/etc/containers/systemd/wbb-rehearsal.container <T>/etc/systemd/system/wbb-rehearsal.service; '
        + 'rm -rf <T>/kit/wbb-rehearsal; rm -rf <W>; <T>/etc/systemd/system/wbb-rehearsal.service is still there; <T>/kit/wbb-rehearsal is still there; '
        + 'systemd still knows wbb-rehearsal.service',
    ]);
    expect(r.code).toBe(1);
  });

  it('production cannot be read after the rehearsal: FAIL, loud', () => {
    const w = world();
    script(w, { ...expected(w), 11: `echo 1 > "$STUB_DIR/prod-current-rc"\n${expected(w)[11]}` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n').slice(10, 17)]).toEqual([1, [
      'FAIL  production unchanged — could not read production after the rehearsal',
      '!!! COULD NOT READ PRODUCTION AFTER THE REHEARSAL — look at warsaw-beer-bot.service now !!!',
      'before:',
      `  ${PROD_CURRENT}`,
      '  LoadState=loaded', '  ActiveState=active', '  SubState=running',
    ]]);
  });

  it('the controller rejects the seeded state: FAIL setup, nothing run, cleaned up', () => {
    const w = world();
    script(w, expected(w));
    file(join(w.stub, 'state-bad'), '');
    const r = run(w);
    expect([r.code, summary(r.out)]).toEqual([1, [
      '=== rehearsal summary ===',
      `S=${w.S} D=${w.D}`,
      'FAIL  setup — the kit could not be set up (see above)',
      ...TITLES.map((t) => `SKIP  ${t} — not run`),
      'PASS  cleanup',
      'PASS  production unchanged',
      'P3 pull: not measured', 'P3 audit: not measured', 'P3 trial: not measured',
      'RESULT: FAIL (2/9)',
      '',
    ].join('\n')]);
    expect(log(w).filter((l) => l.startsWith('controller '))).toEqual([]);
    expect([fromCleanup(log(w)), existsSync(w.kit), readdirSync(w.tmp)]).toEqual([[...CLEANUP, ...PROD_READ], false, []]);
  });

  it('a check before the kill already failed: no tick is run on top of it', () => {
    const w = world();
    // (г1)'s run reaches activate without having written its window.
    script(w, { ...expected(w), 4: `${settled(w, w.D, DD)}; img activate --digest ${DS}; exit 0` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[5]]).toEqual([1,
      `FAIL  ${TITLES[3]} — WINDOW_PHASE at the kill: expected activating, got (empty)`]);
    expect(log(w).filter((l) => l.startsWith('controller ')).length).toBe(4);
  });

  it('(ґ) with no window at the kill: the unit file is never shadowed', () => {
    const w = world();
    script(w, { ...expected(w), 10: `${settled(w, w.D, DD)}; img activate --digest ${DS}; exit 0` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[8], log(w).filter((l) => l.includes(' tee '))]).toEqual([1,
      `FAIL  ${TITLES[6]} — WINDOW_PHASE at the kill: expected activating, got (empty)`, []]);
  });

  it('a lapsed sudo ticket: the scenario FAILs with that reason', () => {
    const w = world();
    script(w, { ...expected(w), 2: `: > "$STUB_DIR/lapsed"; img activate --digest ${DD}; rm -f "$STUB_DIR/lapsed"\n${settled(w, w.D, DD)}; exit 0` });
    const r = run(w);
    expect([r.code, summary(r.out).split('\n')[3]]).toEqual([1,
      `FAIL  ${TITLES[1]} — what runs: expected ${DD} ${DD} quadlet active/running, got ${DS} ${DS} quadlet active/running; `
      + 'the settled notice: expected 1, got 0; the sudo ticket lapsed (sudo -n refused a helper call) — run sudo -v and the rehearsal again']);
  });

  // #911 AI review: a pgrep that cannot answer (refused, cut at its limit) is not proof that nothing is left.
  it('a pgrep that fails (neither found nor not found): the sweep is not trusted, CLEANUP FAILED, FAIL cleanup', () => {
    const w = world();
    script(w, { ...expected(w), 11: `printf '#!/usr/bin/env bash\\nexit 3\\n' > "$STUB_DIR/pgrep"; chmod +x "$STUB_DIR/pgrep"\n${expected(w)[11]}` });
    w.env.PATH = `${w.stub}:${w.env.PATH}`;
    w.env.REHEARSAL_TERM_GRACE_S = '1';
    const r = run(w);
    // The work directory is mktemp's: <W>.
    const sub = (l: string) => l.split(w.root).join('<T>').replace(/<T>\/tmp\/wbb-rehearsal\.[A-Za-z0-9]+/g, '<W>');
    expect([r.code, r.out.split('\n').filter((l) => l.startsWith('CLEANUP FAILED: processes')).map(sub), sub(summary(r.out).split('\n')[9])]).toEqual([1,
      ['CLEANUP FAILED: processes naming <T>/kit/wbb-rehearsal or <W> survived the KILL — sudo pgrep -af <T>/kit/wbb-rehearsal; sudo pgrep -af <W>'],
      'FAIL  cleanup — processes naming <T>/kit/wbb-rehearsal or <W> survived the KILL']);
  });

  // #911 AI review: sudo -n refusing exits 1, as pgrep finding nothing does — a lapsed ticket is not "none left".
  it('a ticket that lapses before the sweep: pgrep is not taken at its word, CLEANUP FAILED, FAIL cleanup', () => {
    const w = world();
    // From the last controller run on, every sudo -n of a command refuses as a lapsed ticket does (exit 1, a reason on stderr).
    script(w, { ...expected(w), 11: `: > "$STUB_DIR/lapsed"\n${expected(w)[11]}` });
    w.env.REHEARSAL_TERM_GRACE_S = '1';
    const r = run(w);
    const sub = (l: string) => l.split(w.root).join('<T>').replace(/<T>\/tmp\/wbb-rehearsal\.[A-Za-z0-9]+/g, '<W>');
    expect([r.code, r.out.split('\n').filter((l) => l.startsWith('CLEANUP FAILED: processes')).map(sub)]).toEqual([1,
      ['CLEANUP FAILED: processes naming <T>/kit/wbb-rehearsal or <W> survived the KILL — sudo pgrep -af <T>/kit/wbb-rehearsal; sudo pgrep -af <W>']]);
  });

  it('a process the controller left in a group of its own (timeout …) and naming the kit is killed before the kit goes', () => {
    const w = world();
    // As the controller's `timeout … sudo -u warsaw-beer-bot … db-snapshot.sh` would leave it: timeout is a group leader.
    script(w, { ...expected(w), 1: `timeout 900 python3 -c 'import time; time.sleep(900)' "$WBB_SNAPSHOT_BIN" &
echo "$!" > "$STUB_DIR/stray"
${expected(w)[1]}` });
    let stray = 0;
    try {
      const r = run(w);
      stray = Number(readFileSync(join(w.stub, 'stray'), 'utf8'));
      const pattern = `[/]${w.kit.slice(1).replace(/[.]/g, '\\.')}`;
      expect([r.code, alive(stray), log(w).filter((l) => l.includes(pattern)).map((l) => l.split(pattern).join('<P>'))]).toEqual([0, false, [
        'sudo -n pkill -TERM -f -- <P>',
        'sudo -n pkill -CONT -f -- <P>',
        'sudo -n pgrep -f -- <P>',
      ]]);
    } finally {
      // timeout leads a process group of its own: the group goes, its sleeping python with it.
      if (stray) { try { process.kill(-stray, 'SIGKILL'); } catch { /* gone */ } }
    }
  });
});

// The first controller run of each scenario: there the stub blocks, and the test interrupts run.sh.
const FIRST_RUN: [string, number, number][] = [['а', 1, 0], ['б', 2, 1], ['в', 3, 2], ['г1', 4, 3], ['г2', 6, 4], ['г3', 8, 5], ['ґ', 10, 6]];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function interrupted(w: World, sig: NodeJS.Signals = 'SIGINT'): Promise<Result & { blocked: number }> {
  const p = spawn('bash', [RUN, w.S, w.D], { env: w.env });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const closed = new Promise<[number | null, string | null]>((done) => p.on('close', (c, s) => done([c, s])));
  const blockedFile = join(w.stub, 'blocked');
  for (let i = 0; i < 400 && !existsSync(blockedFile); i++) await new Promise((t) => setTimeout(t, 50));
  const blocked = Number(readFileSync(blockedFile, 'utf8'));
  p.kill(sig);
  // A run.sh that does not answer the signal is killed here, with its blocked controller: the test then fails.
  const guard = setTimeout(() => {
    p.kill('SIGKILL');
    try { process.kill(-blocked, 'SIGKILL'); } catch { /* gone */ }
  }, 15_000);
  const [code, signal] = await closed;
  clearTimeout(guard);
  for (let i = 0; i < 40 && alive(blocked); i++) await new Promise((t) => setTimeout(t, 50));
  return { code, signal, out, err, blocked };
}

describe('run.sh: interrupted (SIGINT) in the middle of each scenario', () => {
  it.each(FIRST_RUN)('(%s): the controller run is killed, the kit removed, the summary says so, exit 130', async (_name, n, at) => {
    const w = world();
    script(w, { ...expected(w), [n]: 'stop_here' });
    const r = await interrupted(w);
    expect([r.code, r.signal, alive(r.blocked)]).toEqual([130, null, false]);
    expect(summary(r.out)).toBe([
      '=== rehearsal summary ===',
      `S=${w.S} D=${w.D}`,
      ...TITLES.slice(0, at).map((t) => `PASS  ${t}`),
      `FAIL  ${TITLES[at]} — interrupted (SIGINT)`,
      ...TITLES.slice(at + 1).map((t) => `SKIP  ${t} — not run`),
      'PASS  cleanup',
      'PASS  production unchanged',
      ...(at === 0 ? ['P3 pull: not measured', 'P3 audit: not measured', 'P3 trial: not measured'] : P3),
      `RESULT: FAIL — interrupted by SIGINT (${at + 2}/9)`,
      '',
    ].join('\n'));
    expect(fromCleanup(log(w))).toEqual([...CLEANUP, ...PROD_READ]);
    expect([existsSync(w.kit), readdirSync(w.tmp)]).toEqual([false, []]);
  });
});

describe('run.sh: other signals, and a controller that does not go', () => {
  it.each([['SIGTERM', 143], ['SIGHUP', 129]] as [NodeJS.Signals, number][])('%s in (б): the full cleanup, exit %i', async (sig, code) => {
    const w = world();
    script(w, { ...expected(w), 2: 'stop_here' });
    const r = await interrupted(w, sig);
    expect([r.code, r.signal, alive(r.blocked)]).toEqual([code, null, false]);
    expect(summary(r.out).split('\n').filter((l) => l.startsWith('FAIL') || l.startsWith('RESULT'))).toEqual([
      `FAIL  ${TITLES[1]} — interrupted (${sig})`,
      `RESULT: FAIL — interrupted by ${sig} (3/9)`,
    ]);
    expect(fromCleanup(log(w))).toEqual([...CLEANUP, ...PROD_READ]);
    expect([existsSync(w.kit), readdirSync(w.tmp)]).toEqual([false, []]);
  });

  it('a controller that ignores TERM is KILLed after the grace', async () => {
    const w = world();
    script(w, { ...expected(w), 2: `trap '' TERM; echo "$$" > "$STUB_DIR/blocked"; while :; do sleep 0.1; done` });
    const r = await interrupted(w);
    expect([r.code, alive(r.blocked), existsSync(w.kit)]).toEqual([130, false, false]);
  });

  it('a stopped controller (SIGTTIN, SIGTSTP) is continued, so it takes its TERM', async () => {
    const w = world();
    script(w, { ...expected(w), 2: `trap 'echo took-term > "$STUB_DIR/term"; exit 0' TERM; echo "$$" > "$STUB_DIR/blocked"; kill -STOP "$$"` });
    const r = await interrupted(w);
    expect([r.code, alive(r.blocked), readFileSync(join(w.stub, 'term'), 'utf8')]).toEqual([130, false, 'took-term\n']);
  });
});

// --- the preconditions (п.4) -----------------------------------------------------------------------------------

/** Every call a refused run made that is not a read. */
const READS = [/^sudo -n true$/, /^sudo -n <T>\/stub\/podman container exists wbb-rehearsal$/, /^podman container exists wbb-rehearsal$/,
  /^systemctl show /, /^systemctl is-active /, /^sudo -n python3 -I -c /];
const writes = (w: World) => log(w).filter((l) => !READS.some((re) => re.test(l)));

const PRECONDITIONS: [string, (w: World) => void, (w: World) => string][] = [
  ['root', (w) => { w.env.REHEARSAL_EUID = '0'; },
    () => 'run as the operator, not as root (the controller runs as the operator; sudo is asked for each root step)'],
  ['no sudo ticket', (w) => file(join(w.stub, 'sudo-rc'), '1'), () => 'no sudo credentials are cached — run sudo -v first'],
  ['the kit root exists', (w) => mkdirSync(w.kit),
    (w) => `the kit root ${w.kit} exists — a previous rehearsal did not clean up. Look at it, then remove what it left:
  sudo systemctl stop wbb-rehearsal.service
  sudo rm -f ${w.etc}/containers/systemd/wbb-rehearsal.container ${w.etc}/systemd/system/wbb-rehearsal.service
  sudo systemctl daemon-reload
  sudo systemctl reset-failed wbb-rehearsal.service
  sudo podman rm -f --ignore wbb-rehearsal
  sudo rm -rf ${w.kit}`],
  ["production's Quadlet file exists", (w) => file(join(w.etc, 'containers/systemd/warsaw-beer-bot.container'), ''),
    (w) => `production's Quadlet file ${w.etc}/containers/systemd/warsaw-beer-bot.container exists — the rehearsal is run before the switchover, never after`],
  ["the kit's Quadlet file exists", (w) => file(join(w.etc, 'containers/systemd/wbb-rehearsal.container'), ''),
    (w) => `${w.etc}/containers/systemd/wbb-rehearsal.container exists — the rehearsal unit is not ours to replace`],
  ["the kit's unit file exists", (w) => file(join(w.etc, 'systemd/system/wbb-rehearsal.service'), ''),
    (w) => `${w.etc}/systemd/system/wbb-rehearsal.service exists — the rehearsal unit is not ours to replace`],
  ['systemd knows the unit', (w) => file(join(w.stub, 'props-wbb-rehearsal.service'), 'LoadState=loaded\nActiveState=failed\n'),
    () => 'systemd knows wbb-rehearsal.service (LoadState=loaded ActiveState=failed) — it must not exist before the rehearsal'],
  ['the container exists', (w) => file(join(w.stub, 'podman-exists-rc'), '0'), () => 'a container named wbb-rehearsal exists'],
  ['podman cannot say', (w) => file(join(w.stub, 'podman-exists-rc'), '125'), () => 'podman container exists wbb-rehearsal failed (exit 125)'],
  ['the deploy timer is active', (w) => file(join(w.stub, 'active-wbb-autodeploy.timer'), 'active\n'),
    () => 'wbb-autodeploy.timer is active — stop it first: sudo systemctl disable --now wbb-autodeploy.timer, and wait for wbb-autodeploy.service'],
  ['a deploy tick is running', (w) => file(join(w.stub, 'active-wbb-autodeploy.service'), 'activating\n'),
    () => 'wbb-autodeploy.service is activating — stop it first: sudo systemctl disable --now wbb-autodeploy.timer, and wait for wbb-autodeploy.service'],
  ['production cannot be read', (w) => file(join(w.stub, 'prod-current-rc'), '1'),
    () => "could not read what production runs (the helper's current, systemctl show warsaw-beer-bot.service)"],
  ['a contract PR in S..D', (w) => file(join(w.stub, 'prs', w.D), '411\tfeature\n412\tdeploy:hold,migration:contract\n'),
    (w) => `the range ${w.S.slice(0, 12)}..${w.D.slice(0, 12)} holds #412 migration:contract — the controller deploys it only with --ack-incompatible, in manual windows; pick S and D with no contract PR between them`],
  ['a rollback:unsafe PR in S..D', (w) => file(join(w.stub, 'prs', w.D), '413\trollback:unsafe\n'),
    (w) => `the range ${w.S.slice(0, 12)}..${w.D.slice(0, 12)} holds #413 rollback:unsafe — the controller deploys it only with --ack-incompatible, in manual windows; pick S and D with no contract PR between them`],
  ['the PR labels cannot be read', (w) => file(join(w.stub, 'labels-rc'), '1'),
    (w) => `could not read the PR labels of ${w.D.slice(0, 12)} (gh api)`],
  ...['/', '', 'relative/wbb-rehearsal', '/var/lib/../wbb-rehearsal', '/var/lib/rehearsal'].map((root): [string, (w: World) => void, () => string] =>
    [`kit root ${JSON.stringify(root)}`, (w) => file(join(w.stub, 'kit-root'), `${root}\n`),
      () => `the kit root from the shim is not an absolute path ending in /wbb-rehearsal: ${root}`]),
  ...['abc', '0', '65536', ''].map((port): [string, (w: World) => void, () => string] =>
    [`kit port ${JSON.stringify(port)}`, (w) => file(join(w.stub, 'kit-port'), `${port}\n`),
      () => `the kit port from the shim is not a port: ${port}`]),
  ['less than 5 GiB free', (w) => file(join(w.stub, 'df-avail'), String(5 * 1024 * 1024 - 1)),
    (w) => `5119 MiB free on ${w.root}/kit, the rehearsal needs 5 GiB`],
  ['S is not a commit', (w) => { w.S = 'f'.repeat(40); }, (w) => `${'f'.repeat(12)} is not a commit of ${w.git} (git fetch first)`],
  ['S and D are one commit', (w) => { w.S = w.D; }, () => 'S and D are the same commit'],
  ['S is not an ancestor of D', (w) => { [w.S, w.D] = [w.D, w.S]; },
    (w) => `S ${w.S.slice(0, 12)} is not an ancestor of D ${w.D.slice(0, 12)}`],
  ['the registry answers garbage', (w) => file(join(w.stub, 'reg', w.S), 'bad x\n'),
    (w) => `could not read the image of S ${w.S.slice(0, 12)} from ghcr.io (exit 1)`],
  ['S is not published', (w) => rmSync(join(w.stub, 'reg', w.S)),
    (w) => `S ${w.S.slice(0, 12)} has no published image (no tag ${w.S} in ghcr.io/ysilvestrov/warsaw-beer-bot)`],
  ['S and D have one content', (w) => file(join(w.stub, 'reg', w.D), `${DD} ${CS}\n`),
    () => `S and D have the same wbb.content (${CS}): deploying one over the other is a noop and proves nothing`],
  ['S older than the start-check --leave-running commit', (w) => { w.env.REHEARSAL_COMPAT_BASE = w.D; },
    (w) => `S ${w.S.slice(0, 12)} is older than ${w.D.slice(0, 12)}: its start-check predates --leave-running, and the helper refuses its image as a COMPAT target — pick S at or after ${w.D.slice(0, 12)}`],
  ['the start-check --leave-running commit is not in the checkout', (w) => { w.env.REHEARSAL_COMPAT_BASE = 'e'.repeat(40); },
    (w) => `${'e'.repeat(12)} (start-check --leave-running) is not a commit of ${w.git} (git fetch first)`],
  ['CI still running on D', (w) => file(join(w.stub, 'ci', w.D), 'ci\tcompleted\tsuccess\t7\nimage\tqueued\t\t7\n'),
    (w) => `CI has not concluded on D ${w.D.slice(0, 12)} — the required 'ci' and 'image' checks of one run are pending or absent; the controller would refuse to deploy it`],
  ["S's ci and image only in different check suites", (w) => file(join(w.stub, 'ci', w.S), 'ci\tcompleted\tsuccess\t7\nimage\tcompleted\tsuccess\t9\n'),
    (w) => `CI has not concluded on S ${w.S.slice(0, 12)} — the required 'ci' and 'image' checks of one run are pending or absent; the controller would refuse to deploy it`],
  ['CI failed on S', (w) => file(join(w.stub, 'ci', w.S), 'ci\tcompleted\tsuccess\t7\nimage\tcompleted\tfailure\t7\n'),
    (w) => `CI failed on S ${w.S.slice(0, 12)}: image=failure — the controller would refuse to deploy it; pick another S`],
  ['CI status cannot be read', (w) => file(join(w.stub, 'checks-rc'), '1'),
    (w) => `cannot read CI status for S ${w.S.slice(0, 12)} (gh api failed)`],
];

describe('run.sh: each precondition refuses, and nothing is created', () => {
  it.each(PRECONDITIONS)('%s', (_name, arrange, reason) => {
    const w = world();
    script(w, expected(w));
    arrange(w);
    const kitBefore = existsSync(w.kit);
    const r = run(w, [w.S, w.D]);
    expect([r.code, r.err, r.out]).toEqual([1, `REFUSED: ${reason(w)}\nNothing was created.\n`, '']);
    expect([writes(w), readdirSync(w.tmp), existsSync(w.kit)]).toEqual([[], [], kitBefore]);
  });

  it('S at the start-check --leave-running commit itself is accepted, and CI is read for S, then D', () => {
    const w = world();
    script(w, expected(w));
    w.env.REHEARSAL_COMPAT_BASE = w.S;
    const r = run(w);
    expect([r.code, readFileSync(join(w.stub, 'checks-log'), 'utf8')]).toEqual([0, `${w.S}\n${w.D}\n`]);
  });

  it('D on main but past origin/main as this checkout knows it: refused', () => {
    const w = world();
    script(w, expected(w));
    git(w.git, 'update-ref', 'refs/remotes/origin/main', w.S);
    const r = run(w);
    expect([r.code, r.err, writes(w)]).toEqual([1,
      `REFUSED: D ${w.D.slice(0, 12)} is not on origin/main (git fetch first)\nNothing was created.\n`, []]);
  });

  it('the kit port is in use: refused', async () => {
    const w = world();
    script(w, expected(w));
    const busy: Server = createServer();
    await new Promise<void>((done) => busy.listen(0, '127.0.0.1', done));
    const port = (busy.address() as { port: number }).port;
    file(join(w.stub, 'kit-port'), String(port));
    try {
      // Asynchronously: the event loop must stay free for the connection the check makes.
      const p = spawn('bash', [RUN, w.S, w.D], { env: w.env });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      const code = await new Promise<number | null>((done) => p.on('close', (c) => done(c)));
      expect([code, err, writes(w), readdirSync(w.tmp)]).toEqual([1, `REFUSED: the kit port ${port} is in use\nNothing was created.\n`, [], []]);
    } finally {
      busy.close();
    }
  });

  it.each([['one argument', ['x']], ['not 40 hex', ['A'.repeat(40), 'b'.repeat(40)]]])('usage: %s → 64, nothing run', (_name, args) => {
    const w = world();
    const r = run(w, args);
    expect([r.code, r.err, log(w)]).toEqual([64,
      'usage: bash scripts/ops/rehearsal/run.sh <S-sha> <D-sha>   (40 hex each; S an ancestor of D on main)\n', []]);
  });
});
