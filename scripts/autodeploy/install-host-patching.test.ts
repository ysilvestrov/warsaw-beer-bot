import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
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
function host(opts: { gpgOut?: string; uid?: string; realGpg?: boolean; gpgFails?: boolean } = {}): Host {
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
  if (opts.gpgFails) {
    stub('gpg', 'echo "gpg: simulated failure" >&2; exit 2');
  } else if (!opts.realGpg) {
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
    expect(calls(h)[0]).toMatch(/^curl -fsSL https:\/\/pkg\.cloudflare\.com\/cloudflare-public-v2\.gpg -o \/.+\/key\.gpg$/);
    expect(calls(h).slice(1)).toEqual([
      'apt-get DEBIAN_FRONTEND=noninteractive update',
      'apt-get DEBIAN_FRONTEND=noninteractive install -y cloudflared',
    ]);
    expect(calls(h).length).toBe(3);
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

  it.each(['warsaw-beer-bot', 'cloudflared', 'litestream', 'ssh'])(
    'refuses when a needrestart rule names %s — and does not even fetch the key',
    (unit) => {
      const h = host();
      writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), `$nrconf{override_rc}{qr(^${unit})} = 0;\n`);
      const r = run(h);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`names ${unit}`);
      expect(untouched(h)).toEqual(NOTHING);
      expect(calls(h)).toEqual([]);
    },
  );

  it('refuses a rule written with the \\.service$ anchor', () => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), '$nrconf{override_rc}{qr(^ssh\\.service$)} = 0;\n');
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('names ssh');
    expect(untouched(h)).toEqual(NOTHING);
  });

  it.each([
    ["'l'", "$nrconf{restart} = 'l';\n"],
    ['"l"', '$nrconf{restart} = "l";\n'],
    ["'i'", "$nrconf{restart} = 'i';\n"],
  ])('refuses needrestart restart mode %s as list-only under unattended-upgrades', (_mode, line) => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), line);
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('list-only');
    expect(untouched(h)).toEqual(NOTHING);
    expect(calls(h)).toEqual([]);
  });

  it('refuses a configured needrestart UI — it disables the automatic APT-hook default', () => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), "$nrconf{ui} = 'NeedRestart::UI::stdio';\n");
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('list-only');
    expect(untouched(h)).toEqual(NOTHING);
    expect(calls(h)).toEqual([]);
  });

  it('accepts restart mode a set explicitly', () => {
    const h = host();
    writeFileSync(at(h, 'etc/needrestart/conf.d/99-local.conf'), "$nrconf{restart} = 'a';\n");
    expect(run(h).code).toBe(0);
  });

  it('refuses when needrestart is not installed', () => {
    const h = host();
    rmSync(at(h, 'etc/needrestart/needrestart.conf'));
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('needrestart is not installed');
    expect(untouched(h)).toEqual(NOTHING);
    expect(calls(h)).toEqual([]);
  });

  it('refuses with a named error when gpg cannot read the key', () => {
    const h = host({ gpgFails: true });
    const r = run(h);
    expect(r.code).toBe(1);
    expect(r.err).toContain('gpg could not read the key from https://pkg.cloudflare.com/cloudflare-public-v2.gpg. Nothing was changed.');
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
