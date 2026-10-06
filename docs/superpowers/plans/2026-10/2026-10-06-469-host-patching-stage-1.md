# #469 Stage 1 — the host patches itself — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One idempotent root installer that makes unattended-upgrades patch Node (nodesource 24.x) and cloudflared (Cloudflare's apt repo), refusing to run when needrestart would not restart the production units.

**Architecture:** `deploy/install-host-patching.sh` does all its checks first (needrestart guard, Cloudflare key fingerprint), then writes three files (apt conf, keyring, sources list) and runs `apt-get update` + `apt-get install cloudflared`. A test-only `WBB_HOST_ROOT` prefixes every path; tests put stub `id`/`curl`/`gpg`/`apt-get` first in `PATH`. Ubuntu Pro, Livepatch and the reboot are human host steps listed in the PR, not script logic.

**Tech Stack:** bash, Vitest (`spawnSync`), real `gpg` for one parsing test.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md` (Stage 1).

## Global Constraints

- The PR title starts with `[deploy:hold]` and carries the `deploy:hold` label: `deploy/install-*.sh` is a hold path (`isHoldPath` in `scripts/autodeploy/deploy-hold-check.ts`).
- Watched units, exactly: `warsaw-beer-bot`, `cloudflared`, `litestream`, `ssh`.
- apt conf path: `/etc/apt/apt.conf.d/52wbb-unattended-upgrades`. Patterns, exactly: `"site=deb.nodesource.com,n=nodistro";` and `"site=pkg.cloudflare.com,o=cloudflared";`.
- Cloudflare key URL `https://pkg.cloudflare.com/cloudflare-public-v2.gpg`, primary fingerprint `CC94B39C77AE7342A68B89628A682D308D4E5E73` (probed 2026-10-06: this key verifies `pkg.cloudflare.com/cloudflared/dists/any/InRelease`), keyring `/usr/share/keyrings/cloudflare-public-v2.gpg`, list `/etc/apt/sources.list.d/cloudflared.list` with the single line `deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main`.
- A refused run changes **nothing** on disk.
- Tests run via `npm test -- <args>`; full gate per task: `npm test && npm run typecheck`.
- Test rules from CLAUDE.md: exact asserts, no conditionals in tests, no expected values computed by re-implementing the script.

Fixtures already committed with this plan (`scripts/autodeploy/fixtures/host-patching/`):
`cloudflare-public-v2.gpg` (the real key, downloaded 2026-10-06), `needrestart.conf` (the host's stock config), `needrestart-90-code-server.conf` (the host's code-server override).

---

### Task 1: The installer and its tests

**Files:**
- Create: `deploy/install-host-patching.sh`
- Create: `scripts/autodeploy/install-host-patching.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the installer; Task 2 documents its name, what it writes and the human steps around it.

- [ ] **Step 1: Write the failing tests**

`scripts/autodeploy/install-host-patching.test.ts`:

```ts
import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** #469 stage 1 — spec 2026-10-06-469-host-patching-design.md. */
const SCRIPT = resolve(__dirname, '../../deploy/install-host-patching.sh');
const FIX = resolve(__dirname, 'fixtures/host-patching');
const KEY = join(FIX, 'cloudflare-public-v2.gpg');

const UU_CONF = 'etc/apt/apt.conf.d/52wbb-unattended-upgrades';
const KEYRING = 'usr/share/keyrings/cloudflare-public-v2.gpg';
const LIST = 'etc/apt/sources.list.d/cloudflared.list';

const PRIMARY = 'CC94B39C77AE7342A68B89628A682D308D4E5E73';

interface Host { root: string; bin: string; log: string }

/** A fake host root holding the real needrestart config, and a stub bin dir. */
function host(opts: { gpgOut?: string; uid?: string; realGpg?: boolean } = {}): Host {
  const dir = makeTempDirectory('wbb-hostpatch-');
  const root = join(dir, 'root');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(join(root, 'etc/needrestart/conf.d'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(FIX, 'needrestart.conf'), join(root, 'etc/needrestart/needrestart.conf'));
  copyFileSync(join(FIX, 'needrestart-90-code-server.conf'), join(root, 'etc/needrestart/conf.d/90-code-server.conf'));
  writeFileSync(log, '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('id', `echo ${opts.uid ?? '0'}`);
  // curl -fsSL <url> -o <file>: log the URL, serve the fixture key.
  stub('curl', `echo "curl $*" >> "${log}"; out=""; while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done; cp "${KEY}" "$out"`);
  stub('apt-get', `echo "apt-get DEBIAN_FRONTEND=$DEBIAN_FRONTEND $*" >> "${log}"`);
  if (!opts.realGpg) {
    stub('gpg', `cat <<'EOF'\n${opts.gpgOut ?? `pub:-:4096\nfpr:::::::::${PRIMARY}:\nuid:::::::::CloudFlare Software Packaging 2025:\nsub:-:4096\nfpr:::::::::06C89DB3B80A8F4349697C76029E1444B7D9F50F:`}\nEOF`);
  }
  return { root, bin, log };
}

/** hostRoot: false runs as on the real host (no WBB_HOST_ROOT) — only ever with a non-root `id` stub. */
function run(h: Host, opts: { hostRoot?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${h.bin}:${process.env.PATH}`, WBB_HOST_ROOT: h.root };
  if (opts.hostRoot === false) delete env.WBB_HOST_ROOT;
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const calls = (h: Host) => readFileSync(h.log, 'utf8').trim().split('\n').filter((l) => l !== '');
const at = (h: Host, p: string) => join(h.root, p);

const EXPECTED_UU_CONF = [
  '// Managed by warsaw-beer-bot deploy/install-host-patching.sh (#469). Do not edit by hand.',
  '// Origins-Pattern, not Allowed-Origins: nodesource publishes "Origin: . nodistro".',
  'Unattended-Upgrade::Origins-Pattern {',
  '  "site=deb.nodesource.com,n=nodistro";',
  '  "site=pkg.cloudflare.com,o=cloudflared";',
  '};',
  '',
].join('\n');

const EXPECTED_LIST =
  'deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main\n';

describe('install-host-patching — a clean host', () => {
  it('writes the unattended-upgrades origins, mode 0644', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, UU_CONF), 'utf8')).toBe(EXPECTED_UU_CONF);
    expect(statSync(at(h, UU_CONF)).mode & 0o777).toBe(0o644);
  });

  it('installs the verified Cloudflare key byte-for-byte and the source list', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, KEYRING))).toEqual(readFileSync(KEY));
    expect(statSync(at(h, KEYRING)).mode & 0o777).toBe(0o644);
    expect(readFileSync(at(h, LIST), 'utf8')).toBe(EXPECTED_LIST);
  });

  it('fetches the key, then updates and installs cloudflared non-interactively, in that order', () => {
    const h = host();
    run(h);
    expect(calls(h)).toEqual([
      'curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg -o ' + calls(h)[0].split(' -o ')[1],
      'apt-get DEBIAN_FRONTEND=noninteractive update',
      'apt-get DEBIAN_FRONTEND=noninteractive install -y cloudflared',
    ]);
  });

  it('is idempotent: a second run leaves the same bytes', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, UU_CONF), 'utf8')).toBe(EXPECTED_UU_CONF);
    expect(readFileSync(at(h, LIST), 'utf8')).toBe(EXPECTED_LIST);
  });

  it('parses the real key with the real gpg (the fixture is the 2026-10-06 download)', () => {
    const h = host({ realGpg: true });
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, KEYRING))).toEqual(readFileSync(KEY));
  });
});

/** Every refusal must leave the host untouched: none of the three files, no apt-get. */
function untouched(h: Host) {
  return {
    files: [UU_CONF, KEYRING, LIST].map((p) => existsSync(at(h, p))),
    apt: calls(h).filter((c) => c.startsWith('apt-get')),
  };
}
const NOTHING = { files: [false, false, false], apt: [] };

describe('install-host-patching — refusals change nothing', () => {
  it('refuses without root', () => {
    const h = host({ uid: '1000' });
    const r = run(h, { hostRoot: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain('run as root');
    expect(untouched(h)).toEqual(NOTHING);
    expect(calls(h)).toEqual([]);
  });

  it('refuses a key whose primary fingerprint is not Cloudflare\'s', () => {
    const h = host({ gpgOut: 'pub:-:4096\nfpr:::::::::0000000000000000000000000000000000000000:' });
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('0000000000000000000000000000000000000000');
    expect(untouched(h)).toEqual(NOTHING);
  });

  it('refuses a key file carrying a second primary key, even if the first is Cloudflare\'s', () => {
    const h = host({
      gpgOut: `pub:-:4096\nfpr:::::::::${PRIMARY}:\npub:-:4096\nfpr:::::::::1111111111111111111111111111111111111111:`,
    });
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('2 primary keys');
    expect(untouched(h)).toEqual(NOTHING);
  });

  it('refuses when a needrestart rule names a watched unit — and does not even fetch the key', () => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), '$nrconf{override_rc}{qr(^cloudflared)} = 0;\n');
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('names cloudflared');
    expect(untouched(h)).toEqual(NOTHING);
    expect(calls(h)).toEqual([]);
  });

  it('refuses when needrestart is set to list-only', () => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), "$nrconf{restart} = 'l';\n");
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('list-only');
    expect(untouched(h)).toEqual(NOTHING);
  });
});

describe('install-host-patching — the needrestart guard reads only live rules', () => {
  it('ignores a commented-out rule naming a watched unit', () => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), '# $nrconf{override_rc}{qr(^litestream)} = 0;\n');
    expect(run(h).code).toBe(0);
  });

  it('does not take ssh to mean sshd-keygen or a longer unit name', () => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), '$nrconf{override_rc}{qr(^sshd-keygen)} = 0;\n');
    expect(run(h).code).toBe(0);
  });

  it('accepts the stock needrestart.conf and the code-server override (the real host today)', () => {
    // host() already installs both fixtures; this pins that the real config is not a false refusal.
    const h = host();
    const r = run(h);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});
```

Note on the order test: the temp file path after `-o` is random; the assert takes it from the log and pins everything else. That is the only value read back from the run.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- scripts/autodeploy/install-host-patching.test.ts`
Expected: FAIL — `bash: …/deploy/install-host-patching.sh: No such file or directory` (exit 127 ≠ 0/1).

- [ ] **Step 3: Write the installer**

`deploy/install-host-patching.sh`:

```bash
#!/usr/bin/env bash
# #469 stage 1 — the host patches itself.
# Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md
#
# Run from the repo root:   sudo bash deploy/install-host-patching.sh
#
# Makes unattended-upgrades patch Node (nodesource node_24.x — never another
# major) and cloudflared (Cloudflare's own apt repo), and refuses to run when
# needrestart would not restart the production units after a library upgrade.
# Idempotent; safe to re-run.
#
# It does NOT attach Ubuntu Pro (that needs the operator's personal token) and
# it never reboots — both are human steps, see deploy/README.md "Host patching".
#
# Every check runs before anything is written: a refused run changes nothing.
#
# WBB_HOST_ROOT is for tests only: every path is taken under it.
set -euo pipefail

R="${WBB_HOST_ROOT:-}"
if [ "$(id -u)" != 0 ] && [ -z "$R" ]; then
  echo "ERROR: run as root: sudo bash deploy/install-host-patching.sh" >&2
  exit 1
fi

# needrestart must restart these by itself (spec C1; stage 2 watches the same set).
WATCHED_UNITS=(warsaw-beer-bot cloudflared litestream ssh)

CF_KEY_URL=https://pkg.cloudflare.com/cloudflare-public-v2.gpg
# Probed 2026-10-06: this primary key verifies pkg.cloudflare.com/cloudflared/dists/any/InRelease.
CF_KEY_FPR=CC94B39C77AE7342A68B89628A682D308D4E5E73
CF_KEYRING=/usr/share/keyrings/cloudflare-public-v2.gpg
CF_LIST=/etc/apt/sources.list.d/cloudflared.list
UU_CONF=/etc/apt/apt.conf.d/52wbb-unattended-upgrades

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- 1. needrestart guard -----------------------------------------------------
problems=()
for f in "$R/etc/needrestart/needrestart.conf" "$R"/etc/needrestart/conf.d/*.conf; do
  [ -f "$f" ] || continue
  live=$(sed -e 's/#.*$//' "$f")
  if grep -qE "\\\$nrconf\{restart\}[[:space:]]*=[[:space:]]*'l'" <<< "$live"; then
    problems+=("$f sets needrestart to list-only — services would never be restarted")
  fi
  for u in "${WATCHED_UNITS[@]}"; do
    # The unit name followed by anything that cannot continue a unit name:
    # qr(^ssh) and qr(^ssh\.service$) name ssh; qr(^sshd-keygen) does not.
    if grep -qE "qr\(\^?${u}([^A-Za-z0-9_@-]|$)" <<< "$live"; then
      problems+=("$f has a needrestart rule that names $u — it would not be restarted after a library upgrade")
    fi
  done
done
if [ "${#problems[@]}" -gt 0 ]; then
  printf 'ERROR: %s\n' "${problems[@]}" >&2
  echo "Nothing was changed." >&2
  exit 1
fi

# --- 2. fetch and verify the Cloudflare key ------------------------------------
curl -fsSL "$CF_KEY_URL" -o "$work/key.gpg"
keys=$(GNUPGHOME="$work/gnupg" gpg --show-keys --with-colons "$work/key.gpg" 2>/dev/null)
# The fingerprint of each primary key is the fpr record right after its pub record.
primaries=$(awk -F: '$1=="pub"{want=1; next} $1=="fpr" && want {print $10; want=0}' <<< "$keys")
count=$(grep -c . <<< "$primaries" || true)
if [ "$count" != 1 ]; then
  echo "ERROR: $CF_KEY_URL holds $count primary keys, expected exactly 1 — refusing to trust it. Nothing was changed." >&2
  exit 1
fi
if [ "$primaries" != "$CF_KEY_FPR" ]; then
  echo "ERROR: $CF_KEY_URL has fingerprint $primaries, expected $CF_KEY_FPR — refusing to trust it. Nothing was changed." >&2
  exit 1
fi

# --- 3. write ------------------------------------------------------------------
cat > "$work/uu.conf" <<'EOF'
// Managed by warsaw-beer-bot deploy/install-host-patching.sh (#469). Do not edit by hand.
// Origins-Pattern, not Allowed-Origins: nodesource publishes "Origin: . nodistro".
Unattended-Upgrade::Origins-Pattern {
  "site=deb.nodesource.com,n=nodistro";
  "site=pkg.cloudflare.com,o=cloudflared";
};
EOF
printf 'deb [signed-by=%s] https://pkg.cloudflare.com/cloudflared any main\n' "$CF_KEYRING" > "$work/cloudflared.list"

install -d "$R/etc/apt/apt.conf.d" "$R/usr/share/keyrings" "$R/etc/apt/sources.list.d"
install -m 0644 "$work/key.gpg"         "$R$CF_KEYRING"
install -m 0644 "$work/cloudflared.list" "$R$CF_LIST"
install -m 0644 "$work/uu.conf"          "$R$UU_CONF"

# --- 4. move cloudflared onto the repo -----------------------------------------
# Upgrades the orphaned .deb in place; the tunnel unit and credentials are untouched.
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y cloudflared

echo
echo "== installed =="
echo "  $UU_CONF"
echo "  $CF_KEYRING ($CF_KEY_FPR)"
echo "  $CF_LIST"
echo
echo "Next (deploy/README.md, Host patching): check with"
echo "  sudo unattended-upgrade --dry-run -d 2>&1 | grep -E 'Allowed origins|nodejs|cloudflared'"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- scripts/autodeploy/install-host-patching.test.ts`
Expected: PASS, 13 tests.

Mutation check (CLAUDE.md "delete the line, show the test fail") — do each, see the named test fail, revert:
- delete the `count != 1` block → "refuses a key file carrying a second primary key" fails;
- change `'l'` to `'x'` in the restart grep → "refuses when needrestart is set to list-only" fails;
- drop `([^A-Za-z0-9_@-]|$)` from the unit grep → "does not take ssh to mean sshd-keygen" fails;
- move section 3 above section 2 → "refuses a key whose primary fingerprint…" fails on `files`.

- [ ] **Step 5: Full gate and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add deploy/install-host-patching.sh scripts/autodeploy/install-host-patching.test.ts
git commit -m "feat(deploy): install-host-patching — unattended-upgrades patch Node and cloudflared (#469)"
```

---

### Task 2: Documentation (inline — complete text below)

**Files:**
- Modify: `deploy/README.md` — new section `## Host patching (#469)` before `## Backup: Litestream → Cloudflare R2`.
- Modify: `spec.md` §5.9 — runtime line and a new bullet.

**Interfaces:**
- Consumes: the installer's name and the three files it writes (Task 1).

- [ ] **Step 1: `deploy/README.md`**

Insert before `## Backup: Litestream → Cloudflare R2`:

```markdown
## Host patching (#469)

Spec: `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md`.

What patches what:

| Layer | Patched by | Restart |
|---|---|---|
| Ubuntu packages (`-security`, ESM via Ubuntu Pro) | unattended-upgrades | needrestart restarts services automatically |
| Kernel | unattended-upgrades to disk; Livepatch live | a **reboot** only for what Livepatch cannot cover |
| Node (`nodesource`, `node_24.x` only) | unattended-upgrades (`52wbb-unattended-upgrades`) | needrestart restarts the bot |
| cloudflared (`pkg.cloudflare.com`) | unattended-upgrades (`52wbb-unattended-upgrades`) | needrestart restarts the tunnel |
| litestream | **nobody** — upgraded by hand (it writes the backup) | — |

There is no automatic reboot: a reboot kills code-server and every session in
it (the same reason as `/etc/needrestart/conf.d/90-code-server.conf`).

### One-time setup (as root)

1. Attach Ubuntu Pro (free personal tier; token from ubuntu.com/pro — it never
   goes into the repo or `.env`), then enable Livepatch:
   `sudo pro attach <token>` and `sudo pro enable livepatch`.
2. `sudo bash deploy/install-host-patching.sh` — refuses, changing nothing, if a
   needrestart rule names `warsaw-beer-bot`, `cloudflared`, `litestream` or
   `ssh`, or if Cloudflare's key does not have the pinned fingerprint.
3. Check the origins: `sudo unattended-upgrade --dry-run -d 2>&1 | grep -E 'Allowed origins|nodejs|cloudflared'`
   must show the two patterns and treat `nodejs` as upgradable.
4. Reboot once (`sudo systemctl reboot`) so the host runs the newest installed
   kernel, then `canonical-livepatch status` must show it as supported.

Re-run step 2 after any merge that changes `deploy/install-host-patching.sh`.
```

- [ ] **Step 2: `spec.md` §5.9**

Replace `- Runtime: **Node ≥ 20** під systemd (`warsaw-beer-bot.service`).` with:

```markdown
- Runtime: **Node 24** (nodesource `node_24.x`) під systemd (`warsaw-beer-bot.service`).
- **Патчі хоста (#469, спека `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md`).**
  unattended-upgrades ставить безпекові оновлення Ubuntu (з Ubuntu Pro — і ESM), а також Node
  з nodesource (лише лінія 24.x) і cloudflared з репозиторію Cloudflare
  (`deploy/install-host-patching.sh`). needrestart сам перезапускає сервіси на старих
  бібліотеках; інсталятор відмовляється працювати, якщо правило needrestart виключає бот,
  cloudflared, litestream або ssh. Ядро тримає Canonical Livepatch; автоматичного
  перезавантаження немає — воно вбило б code-server і робочі сесії. litestream оновлюється
  лише вручну, бо пише бекап.
```

- [ ] **Step 3: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add deploy/README.md spec.md
git commit -m "docs: host patching — what patches what, one-time setup (#469)"
```

---

## After the PR is merged — host steps (human), then probes P1/P3

The PR body lists these as the `[deploy:hold]` steps:

1. `sudo pro attach <token>`, `sudo pro enable livepatch`.
2. `sudo bash deploy/install-host-patching.sh`.
3. **P3:** `sudo unattended-upgrade --dry-run -d` shows both patterns in "Allowed origins" and `nodejs` among packages to upgrade.
4. `sudo systemctl reboot`.
5. **P1:** `canonical-livepatch status --format json` — the kernel is supported; the JSON is saved as a stage-2 fixture.
6. `bash deploy/deploy.sh` to lift the hold.

P1 and P3 results go into the spec's claims table (C3, C4, C6) on the stage-2 branch, before its plan is written.
