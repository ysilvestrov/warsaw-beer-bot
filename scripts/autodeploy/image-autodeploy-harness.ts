/**
 * Test harness of the image controller deploy/image/autodeploy.sh (plan
 * docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md, Global Constraints).
 *
 * The tick is real bash and real git (a throwaway bare "origin" per world, as in autodeploy.test.ts).
 * Every other contact is a WBB_* seam pointing at a fake here, and the fakes share ONE simulated host:
 * a directory of plain files —
 *
 *   quadlet       the digest the Quadlet file names (absent: none)
 *   container     the digest of the running container (absent: none)
 *   unit          quadlet | foreign | absent (default quadlet)
 *   running_sha   what /health answers as releaseSha
 *   nrestarts     systemd's NRestarts (default 0); a successful `activate` resets it to 0 (V14)
 *   boot_id       the kernel's boot id
 *   unhealthy     present: /health fails
 *   unit_state    present: what `systemctl show -p ActiveState,SubState,MainPID` prints
 *   registry/<D>  an image in GHCR: "<id> <revision sha> <wbb.content>"
 *   tags/<sha>    the tag <sha> → its digest
 *   local/<D>     the image is in local storage
 *   sick/<D>      `activate` of D fails (systemd cannot start it)
 *   activated_at  the clock at the latest `activate`
 *   fault.<name>[.<D>]  lines "FROM TO": seconds after activated_at (while D runs, for the .<D> form)
 *                 in which the fault is on — health (no answer), health-sha (another releaseSha),
 *                 restarts (unreadable), restarts-plus / restarts-minus (NRestarts ±1), unit (the
 *                 unit not running), current (TEMPFAIL), foreign-image (another container image),
 *                 unit-foreign (unit=foreign), kill (the tick is killed by its health probe, once)
 *   clock-back    "AT DELTA": the first health probe at AT s or later moves the clock back DELTA s
 *   swap          "AT D": the first health probe at AT s or later finds D running (someone else's activate)
 *   state-at-activate.<n>  image-state.env as it was at the n-th `activate` call
 *
 * The fake helper (`wbb-image`) implements pull / local / audit / trial / activate / current / prune
 * against those files, so `current`, health and NRestarts always describe the same host. A test
 * overrides one answer with `reply(w, <action>, <digest | sha | '-'>, …)`: a queue of replies, one per
 * call — 'pass' (the host's own answer), an exact {code, stdout, stderr} (a golden output of the real
 * helper, `golden(name)`), or 'kill-before' / 'kill-after-write' / 'kill-after', which kill the tick
 * itself before the action, after its first host write, or after the whole action. Every call of every seam is one line in the events log.
 *
 * The clock is a file: the clock stub reads it and the sleep stub advances it, so ten minutes of quiet
 * cost no wall time. The setup never computes what the controller should decide: expected values are
 * literals of the test (an image's digest, id and content are names given here, nothing more).
 */
import { makeTempDirectory } from '../test-temp';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCRIPT = resolve(__dirname, '../../deploy/image/autodeploy.sh');
export const DB_SNAPSHOT = resolve(__dirname, '../../deploy/db-snapshot.sh');
export const GOLDEN_DIR = resolve(__dirname, 'fixtures/wbb-image');
export const QUIET_S = 600;
/** The simulated clock starts at 100000 s: this UTC day. */
export const DAY1 = '1970-01-02';
export const DAY2 = '1970-01-03';
export const BOOT_ID = '0b0f6c6e-1d2a-4f5e-9a8b-7c6d5e4f3a21';

export const short = (sha: string): string => sha.slice(0, 7);

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commitIn(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** Writes an executable script; `body` is its bash body. */
export function stub(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** An image as the registry knows it. */
export interface Image { sha: string; digest: string; id: string; content: string }

export interface ImageWorld {
  home: string;
  dataDir: string;
  stateHome: string;
  /** $XDG_STATE_HOME/wbb-autodeploy: the state, the lock, PAUSED. */
  stateDir: string;
  statePath: string;
  repo: string;
  bin: string;
  /** Prepended to PATH: fakes of commands the controller runs by name (sync). */
  pathBin: string;
  host: string;
  /** The pre snapshots (WBB_SNAPSHOT_DIR). */
  snapshots: string;
  remote: string;
  seed: string;
  base: string;
  /** The image of `base`: deployed, settled and running when the world is made. */
  settled: Image;
  clock: string;
  /** Monotonic seconds since boot (WBB_UPTIME_CMD): moves with sleeps, never back. */
  uptime: string;
  eventsLog: string;
  notesLog: string;
  syncLog: string;
}

const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

/** The image CI would publish for `sha`; its names are labels, not anything the controller computes. */
export function imageOf(sha: string, content?: string): Image {
  return { sha, digest: `sha256:${hex(`digest ${sha}`)}`, id: hex(`id ${sha}`), content: content ?? hex(`content ${sha}`) };
}

// --- the fakes -------------------------------------------------------------------------------------------
// Shared by every fake: the host, the events log, the reply queue and killing the tick.
const FAKE_LIB = String.raw`
H="$WBB_FAKE_HOST"
EV="$WBB_FAKE_EVENTS"
# The next reply queued for <action> <key>: '' when none (the fake then does what the host would).
next_reply() {
  local f="$H/reply.$1.$2"
  if [ -f "$f.always" ]; then cat "$f.always"; return 0; fi
  [ -s "$f" ] || return 0
  head -n 1 "$f"
  sed -i 1d "$f"
}
# Kills the tick: the OUTERMOST ancestor whose argv[1] is the controller (a $(…) subshell of the
# tick has the same command line, and killing only it would let the tick carry on).
kill_tick() {
  local pid=$PPID tick=""
  while [ "$pid" -gt 1 ]; do
    if [ "$(tr '\0' '\n' < "/proc/$pid/cmdline" | sed -n 2p)" = "$WBB_FAKE_TICK_SCRIPT" ]; then tick=$pid; fi
    pid=$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status")
  done
  if [ -z "$tick" ]; then echo "kill_tick: no tick among the ancestors" >&2; exit 99; fi
  kill -9 "$tick"
}
# raw:<dir> replays dir/{code,stdout,stderr} exactly; kill-before kills now; kill-after-write is the
# caller's (it sets KILL_AFTER_WRITE).
KILL_AFTER_WRITE=0
KILL_AFTER=0
apply_reply() {
  case "$1" in
    ''|pass) return 0 ;;
    kill-before) kill_tick; exit 0 ;;
    kill-after-write) KILL_AFTER_WRITE=1; return 0 ;;
    kill-after) KILL_AFTER=1; return 0 ;;
    raw:*) cat "\${1#raw:}/stdout"; cat "\${1#raw:}/stderr" >&2; exit "$(<"\${1#raw:}/code")" ;;
    *) echo "fake: unknown reply '$1'" >&2; exit 99 ;;
  esac
}
wrote() { if [ "$KILL_AFTER_WRITE" = 1 ]; then kill_tick; exit 0; fi; }
entry() { cat "$H/registry/$1"; }
# Is fault <name> on now? Its lines are "FROM TO" in seconds since the latest activation; the
# .<digest> form applies only while that digest runs.
faulty() {
  local f t from to c
  [ -f "$H/activated_at" ] || return 1
  [ -f "$H/fault.$1" ] || compgen -G "$H/fault.$1.*" > /dev/null || return 1
  t=$(( $(<"$WBB_FAKE_CLOCK") - $(<"$H/activated_at") ))
  c=none
  if [ -f "$H/container" ]; then c=$(<"$H/container"); fi
  for f in "$H/fault.$1" "$H/fault.$1.$c"; do
    [ -f "$f" ] || continue
    while read -r from to; do
      if [ -n "$from" ] && [ "$t" -ge "$from" ] && [ "$t" -lt "$to" ]; then return 0; fi
    done < "$f"
  done
  return 1
}
`.replace(/\\\$/g, '$');

// The root helper wbb-image, against the simulated host. argv exactly as the real one takes it.
const FAKE_HELPER = String.raw`
. "$WBB_FAKE_LIB"
echo "image $*" >> "$EV"
action="$1"; shift
sha=""; digest=""; previous=""; snapshot=""; keeps=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) sha="$2" ;;
    --digest) digest="$2" ;;
    --previous) previous="$2" ;;
    --snapshot) snapshot="$2" ;;
    --keep) keeps+=("$2") ;;
    *) echo "fake wbb-image: unexpected argument $1" >&2; exit 64 ;;
  esac
  shift 2
done
apply_reply "$(next_reply "$action" "\${digest:--}")"
refused() { echo "REFUSED: $*" >&2; exit 2; }
ours() { [ -f "$H/registry/$1" ] && [ -f "$H/local/$1" ] || refused "$1 is not a local image of ghcr.io/ysilvestrov/warsaw-beer-bot"; }
case "$action" in
  pull)
    if [ ! -f "$H/registry/$digest" ]; then
      echo "TEMPFAIL: podman pull ghcr.io/ysilvestrov/warsaw-beer-bot@$digest exited 125: manifest unknown" >&2; exit 75
    fi
    read -r id rev content < "$H/registry/$digest"
    [ "$rev" = "$sha" ] || refused "ghcr.io/ysilvestrov/warsaw-beer-bot@$digest: label org.opencontainers.image.revision is $rev, expected $sha"
    mkdir -p "$H/local"; touch "$H/local/$digest"; wrote
    echo "PULLED $digest $id content=$content revision=$rev" ;;
  local)
    if [ ! -f "$H/local/$digest" ]; then echo "NOT LOCAL $digest"; exit 3; fi
    read -r id rev content < "$H/registry/$digest"
    echo "LOCAL $digest $id content=$content revision=$rev" ;;
  audit)
    ours "$digest"
    echo "AUDIT CLEAN $digest" ;;
  trial)
    ours "$digest"; ours "$previous"
    read -r id rev content < "$H/registry/$digest"
    echo "TRIAL OK: schema 46 -> 47"
    echo "START OK $rev"
    echo "COMPAT OK $previous" ;;
  activate)
    ours "$digest"
    n=$(( $(ls "$H" | grep -c '^state-at-activate\.') + 1 ))
    cp "$XDG_STATE_HOME/wbb-autodeploy/image-state.env" "$H/state-at-activate.$n"
    cat "$WBB_FAKE_CLOCK" > "$H/activated_at"
    echo "$digest" > "$H/quadlet"; wrote
    if [ -f "$H/sick/$digest" ]; then
      rm -f "$H/container" "$H/running_sha"
      echo "ACTIVATE FAILED: restart exited 1: Job for warsaw-beer-bot.service failed because the control process exited with error code."
      exit 1
    fi
    read -r id rev content < "$H/registry/$digest"
    echo "$digest" > "$H/container"
    echo "$rev" > "$H/running_sha"
    # The restart resets systemd's counter (spec V14); daemon-reload alone would not.
    echo 0 > "$H/nrestarts"
    echo "ACTIVATED $digest" ;;
  current)
    q=$(cat "$H/quadlet" 2>/dev/null || echo none)
    c=$(cat "$H/container" 2>/dev/null || echo none)
    i=none
    if [ "$c" != none ]; then read -r i _ _ < "$H/registry/$c"; fi
    if faulty current; then echo "TEMPFAIL: podman inspect warsaw-beer-bot timed out after 60s" >&2; exit 75; fi
    if faulty foreign-image; then i=$(printf 'f%.0s' $(seq 1 64)); fi
    unit=$(cat "$H/unit" 2>/dev/null || echo quadlet)
    if faulty unit-foreign; then unit=foreign; fi
    echo "CURRENT quadlet=$q container-image=$i container-digest=$c unit=$unit" ;;
  prune)
    q=$(cat "$H/quadlet" 2>/dev/null || echo none)
    removed=0
    for f in "$H"/local/*; do
      [ -e "$f" ] || continue
      d=$(basename "$f")
      case " \${keeps[*]} $q " in *" $d "*) continue ;; esac
      rm -f "$f"; removed=$((removed + 1))
    done
    echo "PRUNED $removed skipped 0 kept $(printf '%s\n' "\${keeps[@]}" | sort -u | tr '\n' ' ' | sed 's/ $//')" ;;
  *) echo "fake wbb-image: unknown action $action" >&2; exit 64 ;;
esac
# kill-after: the action is done; the tick dies before it reads the answer.
if [ "$KILL_AFTER" = 1 ]; then kill_tick; fi
`.replace(/\\\$/g, '$');

const FAKE_RESOLVE = String.raw`
. "$WBB_FAKE_LIB"
echo "resolve $1" >> "$EV"
apply_reply "$(next_reply resolve "$1")"
[ -f "$H/tags/$1" ] || exit 3
cat "$H/tags/$1"
`;

// gh attestation verify: D must be in the registry as a build of exactly $2.
const FAKE_ATTEST = String.raw`
. "$WBB_FAKE_LIB"
echo "attest $1 $2" >> "$EV"
apply_reply "$(next_reply attest "$1")"
[ -f "$H/registry/$1" ] || { echo "Error: no attestations found for oci://ghcr.io/ysilvestrov/warsaw-beer-bot@$1"; exit 1; }
read -r _ rev _ < "$H/registry/$1"
[ "$rev" = "$2" ] || { echo "Error: verifying with issuer \"sigstore.dev\": expected SourceRepositoryDigest to be $2, got $rev"; exit 1; }
echo "Loaded 1 attestation from GitHub API"
`;

const FAKE_HEALTH = String.raw`
. "$WBB_FAKE_LIB"
if faulty kill && [ ! -f "$H/killed" ]; then touch "$H/killed"; kill_tick; exit 1; fi
if [ -f "$H/clock-back" ] && [ -f "$H/activated_at" ]; then
  read -r at delta < "$H/clock-back"
  if [ $(( $(<"$WBB_FAKE_CLOCK") - $(<"$H/activated_at") )) -ge "$at" ]; then
    echo $(( $(<"$WBB_FAKE_CLOCK") - delta )) > "$WBB_FAKE_CLOCK"; rm -f "$H/clock-back"
  fi
fi
# swap: "AT DIGEST" — at AT s after the latest activation someone else makes DIGEST run.
if [ -f "$H/swap" ] && [ -f "$H/activated_at" ]; then
  read -r at sd < "$H/swap"
  if [ $(( $(<"$WBB_FAKE_CLOCK") - $(<"$H/activated_at") )) -ge "$at" ]; then
    echo "$sd" > "$H/quadlet"; echo "$sd" > "$H/container"; read -r _ rev _ < "$H/registry/$sd"; echo "$rev" > "$H/running_sha"
    rm -f "$H/swap"
  fi
fi
[ -f "$H/container" ] && [ ! -f "$H/unhealthy" ] && [ -s "$H/running_sha" ] || exit 1
faulty health && exit 1
if faulty health-sha; then echo ffffffffffffffffffffffffffffffffffffffff; exit 0; fi
cat "$H/running_sha"
`;

const FAKE_RESTARTS = String.raw`
. "$WBB_FAKE_LIB"
faulty restarts && exit 1
n=$(cat "$H/nrestarts" 2>/dev/null || echo 0)
if faulty restarts-plus; then n=$(( n + 1 )); fi
if faulty restarts-minus; then n=$(( n - 1 )); fi
echo "$n"
`;

const FAKE_UNIT_STATE = String.raw`
. "$WBB_FAKE_LIB"
if [ -f "$H/unit_state" ]; then cat "$H/unit_state"
elif faulty unit; then printf 'ActiveState=failed\nSubState=failed\nMainPID=0\n'
elif [ -f "$H/container" ]; then printf 'ActiveState=active\nSubState=running\nMainPID=4242\n'
else printf 'ActiveState=inactive\nSubState=dead\nMainPID=0\n'
fi
`;

// coreutils sync, by name on PATH: what it was asked to sync, and what the state looked like then.
const FAKE_SYNC = String.raw`
dir="$XDG_STATE_HOME/wbb-autodeploy"
if [ -f "$dir/image-state.env.tmp" ]; then tmp=$(tr '\n' ';' < "$dir/image-state.env.tmp"); else tmp=absent; fi
echo "sync $* | tmp=$tmp" >> "$WBB_FAKE_SYNC_LOG"
`;

/** The default checks: `ci` and `image` succeeded in one check suite. */
export const CHECKS_OK = ['ci\tcompleted\tsuccess\t101', 'image\tcompleted\tsuccess\t101'];

/** A CHECKS_CMD that logs `checks <sha>` and prints `lines`. */
export function checksStub(w: ImageWorld, name: string, lines: string[]): string {
  writeFileSync(join(w.bin, `${name}.out`), lines.map((l) => `${l}\n`).join(''));
  return stub(w.bin, name, `echo "checks $1" >> "${w.eventsLog}"; cat "${join(w.bin, `${name}.out`)}"`);
}

function writeFakes(w: ImageWorld): Record<string, string> {
  const b = w.bin;
  const lib = join(b, 'fake-lib.sh');
  writeFileSync(lib, FAKE_LIB);
  stub(w.pathBin, 'sync', FAKE_SYNC);
  return {
    WBB_FAKE_LIB: lib,
    WBB_FAKE_HOST: w.host,
    WBB_FAKE_EVENTS: w.eventsLog,
    WBB_FAKE_SYNC_LOG: w.syncLog,
    WBB_CLOCK_CMD: stub(b, 'clock-cmd', `printf '%s\\n' "$(<"${w.clock}")"`),
    // A sleep advances the wall clock and the monotonic uptime alike.
    WBB_SLEEP_CMD: stub(b, 'sleep-cmd', `echo $(( $(<"${w.clock}") + $1 )) > "${w.clock}"; echo $(( $(<"${w.uptime}") + $1 )) > "${w.uptime}"`),
    WBB_UPTIME_CMD: stub(b, 'uptime-cmd', `printf '%s\\n' "$(<"${w.uptime}")"`),
    WBB_NOTIFY_CMD: stub(b, 'notify', `printf '%s\\n<<END>>\\n' "$1" >> "${w.notesLog}"`),
    WBB_API_PORT_CMD: stub(b, 'port', 'echo 3000'),
    WBB_READ_ENV_CMD: stub(b, 'read-env', 'echo "read-env $1" >&2; exit 1'),
    WBB_IMAGE_CMD: stub(b, 'wbb-image', FAKE_HELPER),
    WBB_RESOLVE_CMD: stub(b, 'resolve', FAKE_RESOLVE),
    WBB_ATTEST_CMD: stub(b, 'attest', FAKE_ATTEST),
    WBB_HEALTH_CMD: stub(b, 'health', FAKE_HEALTH),
    WBB_RESTARTS_CMD: stub(b, 'restarts', FAKE_RESTARTS),
    WBB_UNIT_STATE_CMD: stub(b, 'unit-state', FAKE_UNIT_STATE),
    WBB_BOOT_ID_CMD: stub(b, 'boot-id', `cat "${w.host}/boot_id"`),
    WBB_CHECKS_CMD: checksStub(w, 'checks', CHECKS_OK),
    WBB_PR_LABELS_CMD: stub(b, 'labels', `printf '7\\t\\n'`),
    // A pre snapshot as db-snapshot.sh leaves it (the file and its .sha256); marking, discarding
    // and pruning are the REAL deploy/db-snapshot.sh on the world's snapshot directory.
    WBB_SNAPSHOT_CMD: stub(b, 'snapshot', [
      `echo "snapshot $(basename "$1")" >> "${w.eventsLog}"`,
      'mkdir -p "$(dirname "$1")"; echo "pre $(basename "$1")" > "$1"',
      'sha256sum < "$1" | cut -d" " -f1 > "$1.sha256"',
    ].join('\n')),
    WBB_PRUNE_CMD: stub(b, 'prune', `echo prune >> "${w.eventsLog}"; exec bash "${DB_SNAPSHOT}" prune "${w.snapshots}" 3`),
    WBB_MARK_CMD: stub(b, 'mark', `echo "mark $(basename "$1")" >> "${w.eventsLog}"; exec bash "${DB_SNAPSHOT}" mark-rollback "$1"`),
    WBB_DISCARD_CMD: stub(b, 'discard', `echo "discard $(basename "$1")" >> "${w.eventsLog}"; exec bash "${DB_SNAPSHOT}" discard "$1"`),
    WBB_SNAPSHOT_DIR: w.snapshots,
    WBB_FAKE_CLOCK: w.clock,
    WBB_FAKE_TICK_SCRIPT: SCRIPT,
    WBB_INSTALLED_CHECK: stub(b, 'installed', 'echo "CURRENT: stub"; exit 0'),
  };
}

// --- the host ----------------------------------------------------------------------------------------------
/** Sets (or, with null, removes) one file of the simulated host. */
export function hostSet(w: ImageWorld, name: string, value: string | null): void {
  const p = join(w.host, name);
  if (value === null) {
    rmSync(p, { force: true });
    return;
  }
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `${value}\n`);
}

export function hostRead(w: ImageWorld, name: string): string | null {
  const p = join(w.host, name);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

/** CI published `img`: it is in the registry and its tag names it. Not pulled. */
export function publish(w: ImageWorld, img: Image): Image {
  hostSet(w, `registry/${img.digest}`, `${img.id} ${img.sha} ${img.content}`);
  hostSet(w, `tags/${img.sha}`, img.digest);
  return img;
}

/** `img` is local and production runs it from the Quadlet file. */
export function runImage(w: ImageWorld, img: Image): void {
  hostSet(w, `local/${img.digest}`, '');
  hostSet(w, 'quadlet', img.digest);
  hostSet(w, 'container', img.digest);
  hostSet(w, 'running_sha', img.sha);
}

/** Turns fault `name` on from `from` to `to` s after the latest activation (of `digest` only, if given). */
export function fault(w: ImageWorld, name: string, from: number, to: number, digest?: string): void {
  const f = join(w.host, digest === undefined ? `fault.${name}` : `fault.${name}.${digest}`);
  const before = existsSync(f) ? readFileSync(f, 'utf8') : '';
  writeFileSync(f, `${before}${from} ${to}\n`);
}

/** image-state.env as the n-th (1-based) `activate` call found it. */
export function stateAtActivate(w: ImageWorld, n: number): Record<string, string> {
  return parseState(readFileSync(join(w.host, `state-at-activate.${n}`), 'utf8'));
}

export type Reply = 'pass' | 'kill-before' | 'kill-after-write' | 'kill-after' | { code: number; stdout?: string; stderr?: string };
let replySeq = 0;

function replyLine(w: ImageWorld, r: Reply): string {
  if (typeof r === 'string') return r;
  replySeq += 1;
  const dir = join(w.host, 'replies', String(replySeq));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'code'), String(r.code));
  writeFileSync(join(dir, 'stdout'), r.stdout ?? '');
  writeFileSync(join(dir, 'stderr'), r.stderr ?? '');
  return `raw:${dir}`;
}

/**
 * Queues answers of the fake `action` for `key` (the --digest it is called with; the SHA for resolve;
 * '-' for current and prune): one per call, then the host's own behaviour again.
 */
export function reply(w: ImageWorld, action: string, key: string, ...replies: Reply[]): void {
  const f = join(w.host, `reply.${action}.${key}`);
  const before = existsSync(f) ? readFileSync(f, 'utf8') : '';
  writeFileSync(f, before + replies.map((r) => `${replyLine(w, r)}\n`).join(''));
}

/** The same answer on every call. */
export function replyAlways(w: ImageWorld, action: string, key: string, r: Reply): void {
  writeFileSync(join(w.host, `reply.${action}.${key}.always`), `${replyLine(w, r)}\n`);
}

/** A golden output of the real helper (scripts/autodeploy/fixtures/wbb-image/<name>.txt). */
export function golden(name: string): { code: number; stdout: string; stderr: string } {
  const text = readFileSync(join(GOLDEN_DIR, `${name}.txt`), 'utf8');
  const m = /^exit=(\d+)\n--- stdout\n([\s\S]*)--- stderr\n([\s\S]*)$/.exec(text);
  if (m === null) throw new Error(`${name}.txt is not a golden output`);
  return { code: Number(m[1]), stdout: m[2], stderr: m[3] };
}

// --- the world ---------------------------------------------------------------------------------------------
/** The state of a settled production at `img`: deployed and settled are the same image. */
export function settledState(img: Image): Record<string, string> {
  return {
    DEPLOYED_SHA: img.sha,
    DEPLOYED_DIGEST: img.digest,
    DEPLOYED_ID: img.id,
    DEPLOYED_CONTENT: img.content,
    SETTLED_SHA: img.sha,
    SETTLED_DIGEST: img.digest,
    SETTLED_ID: img.id,
    SETTLED_CONTENT: img.content,
  };
}

/** A bare origin with one base commit, a clone of it, and production settled at base's image. */
export function imageWorld(): ImageWorld {
  const remote = makeTempDirectory('wbb-img-remote-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = makeTempDirectory('wbb-img-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', remote);
  const base = commitIn(seed, { 'package.json': '{"name":"x","version":"1.0.0"}', 'src/a.ts': 'export const a = 1;\n' }, 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  const home = makeTempDirectory('wbb-img-home-');
  const dataDir = join(home, 'data');
  const stateHome = join(home, 'state');
  const stateDir = join(stateHome, 'wbb-autodeploy');
  const repo = join(dataDir, 'wbb-autodeploy', 'repo');
  mkdirSync(join(dataDir, 'wbb-autodeploy'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['clone', '-q', remote, repo]);
  const bin = makeTempDirectory('wbb-img-bin-');
  const pathBin = join(bin, 'path');
  const host = join(bin, 'host');
  mkdirSync(pathBin);
  mkdirSync(host);
  const clock = join(bin, 'clock');
  writeFileSync(clock, '100000');
  writeFileSync(join(bin, 'uptime'), '5000');
  const settled = imageOf(base);
  const w: ImageWorld = {
    home, dataDir, stateHome, stateDir, statePath: join(stateDir, 'image-state.env'), repo, bin, pathBin, host,
    snapshots: join(home, 'snapshots'),
    remote, seed, base, settled, clock, uptime: join(bin, 'uptime'),
    eventsLog: join(bin, 'events.log'),
    notesLog: join(bin, 'notify.log'),
    syncLog: join(bin, 'sync.log'),
  };
  publish(w, settled);
  runImage(w, settled);
  hostSet(w, 'unit', 'quadlet');
  hostSet(w, 'nrestarts', '0');
  hostSet(w, 'boot_id', BOOT_ID);
  seedState(w, settledState(settled));
  return w;
}

export function push(w: ImageWorld, files: Record<string, string>, message: string): string {
  const sha = commitIn(w.seed, files, message);
  git(w.seed, 'push', '-q', 'origin', 'main');
  return sha;
}

/** Commits on the seed's current branch and pushes it as `branch` (a side branch of the origin). */
export function commitTo(w: ImageWorld, files: Record<string, string>, message: string, branch: string): string {
  const sha = commitIn(w.seed, files, message);
  git(w.seed, 'push', '-q', 'origin', branch);
  return sha;
}

/** What origin/main is in the tick's private clone: it moves only when the tick fetches. */
export function clonedMain(w: ImageWorld): string {
  return git(w.repo, 'rev-parse', 'origin/main');
}

/** Writes image-state.env exactly: one KEY=value line per entry, in the order given. */
export function seedState(w: ImageWorld, kv: Record<string, string>): void {
  writeStateText(w, Object.entries(kv).map(([k, v]) => `${k}=${v}\n`).join(''));
}

export function writeStateText(w: ImageWorld, text: string): void {
  writeFileSync(w.statePath, text);
}

export function stateText(w: ImageWorld): string | null {
  return existsSync(w.statePath) ? readFileSync(w.statePath, 'utf8') : null;
}

/** image-state.env as a map; a line that is not KEY=value fails the test. */
export function readState(w: ImageWorld): Record<string, string> {
  return parseState(readFileSync(w.statePath, 'utf8'));
}

function parseState(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').filter((l) => l !== '')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m === null) throw new Error(`not KEY=value in the state: ${line}`);
    out[m[1]] = m[2];
  }
  return out;
}

/** Sets keys of the current state (a manual deploy recording what it did), keeping the others. */
export function patchState(w: ImageWorld, kv: Record<string, string>): void {
  seedState(w, { ...readState(w), ...kv });
}

export function advance(w: ImageWorld, s: number): void {
  writeFileSync(w.clock, String(Number(readFileSync(w.clock, 'utf8')) + s));
}

const lines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l !== '') : []);

/** Every recorded side effect, in order. */
export function events(w: ImageWorld): string[] {
  return lines(w.eventsLog);
}

/** Every `sync` the controller ran, with the temporary state file as it was at that moment. */
export function syncs(w: ImageWorld): string[] {
  return lines(w.syncLog);
}

/** Every state write, in order: the temporary file's content at its fsync, as a map. */
export function writes(w: ImageWorld): Array<Record<string, string>> {
  return syncs(w)
    .filter((l) => l.startsWith(`sync -- ${w.statePath}.tmp | tmp=`))
    .map((l) => parseState(l.slice(l.indexOf('| tmp=') + '| tmp='.length).split(';').join('\n')));
}

/** A MARK_CMD that marks with the real db-snapshot.sh, then kills the tick before it can record the new name. */
export function markThenKill(w: ImageWorld): string {
  return stub(w.bin, 'mark-then-kill', [
    `echo "mark $(basename "$1")" >> "${w.eventsLog}"`,
    `bash "${DB_SNAPSHOT}" mark-rollback "$1"`,
    '. "$WBB_FAKE_LIB"; kill_tick',
  ].join('\n'));
}

/** One entry per notify call, full text. */
export function notes(w: ImageWorld): string[] {
  return existsSync(w.notesLog)
    ? readFileSync(w.notesLog, 'utf8').split('\n<<END>>\n').filter((m) => m !== '')
    : [];
}

export function tickEnv(w: ImageWorld, over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: w.home,
    XDG_DATA_HOME: w.dataDir,
    XDG_STATE_HOME: w.stateHome,
    PATH: `${w.pathBin}:${process.env.PATH ?? ''}`,
    ...writeFakes(w),
    ...over,
  };
}

/** One tick of the controller. `code` is null when the tick was killed. */
export function tick(w: ImageWorld, over: Record<string, string> = {}, args: string[] = []): { code: number | null; out: string } {
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: tickEnv(w, over) }) };
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/**
 * One manual run (plan 2026-10-21 b2-core, Task 2): the same controller, the same fakes, with
 * `--manual` and `args` after it. Killed by the same `kill` faults: argv[1] is the controller.
 */
export function manual(w: ImageWorld, args: string[], over: Record<string, string> = {}): { code: number | null; out: string } {
  return tick(w, over, ['--manual', ...args]);
}

/** The tick that first sees the head, then QUIET_S of quiet: the next tick decides. */
export function ready(w: ImageWorld, over: Record<string, string> = {}): void {
  tick(w, over);
  advance(w, QUIET_S);
}
