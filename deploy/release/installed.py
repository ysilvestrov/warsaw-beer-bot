"""Where the host keeps what the controller runs and compares: one module of constants (host).

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, "Рішення" п.1, Task 1.
The installer (stage В) and the adapters (host_adapter, helpers_adapter, notify_telegram) read the same names
here, so a path is never spelled twice.

installed_path(repo_path) is the map behind Helpers.installed_stale: for a file of the repo matching one of
gates.INSTALLED_COPIES it names the installed copy that must be byte-identical to it in main, or None when the
file has no installed copy (a test module, a template a human fills in with secrets).

digestable(path) is what the root helper's `digest` may hash for the operator (plan C-core "Рішення" п.3).
"""
import posixpath

# The controller's code (root:root, 0755 dirs / 0644 files) and its two entry points (stage В writes both).
LIB_DIR = '/usr/local/lib/wbb-release'
ROOT_HELPER = '/usr/local/libexec/wbb-release'  # runs wbb_release.py; only through `sudo -n` (audit: without)
TICK_BIN = '/usr/local/bin/wbb-tick'            # runs tick.py as the operator

# Merge-deploy's installed copies (deploy/install-autodeploy.sh), which the adapters call as they are.
SNAPSHOT_BIN = '/usr/local/bin/wbb-db-snapshot'
READ_ENV_BIN = '/usr/local/bin/wbb-read-env'

BOT_USER = 'warsaw-beer-bot'
BOT_UNIT = 'warsaw-beer-bot'
LITESTREAM_UNIT = 'litestream'
BOT_ENV_FILE = '/etc/warsaw-beer-bot/.env'
DB_PATH = '/var/lib/warsaw-beer-bot/bot.db'
BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id'
UNIT_DIR = '/etc/systemd/system'
SUDOERS_DIR = '/etc/sudoers.d'
LITESTREAM_CONFIG = '/etc/litestream.yml'
# The operator's own directories, as merge-deploy names them: ${XDG_DATA_HOME:-$HOME/.local/share}/<APP_DIR>
# (repo/ — the private clone, artifacts/ — downloaded ZIPs) and ${XDG_STATE_HOME:-$HOME/.local/state}/<APP_DIR>
# (lock, PAUSED, tick-state.json, deploy-state.json).
APP_DIR = 'wbb-autodeploy'

# One repo file -> one installed copy.
COPIES = {
    'deploy/autodeploy.sh': '/usr/local/bin/wbb-autodeploy',
    'deploy/ships.sh': '/usr/local/bin/wbb-ships',
    'deploy/read-env.sh': READ_ENV_BIN,
    'deploy/installed-current.sh': '/usr/local/bin/wbb-installed-current',
    'deploy/db-snapshot.sh': SNAPSHOT_BIN,
    'deploy/trial-migrate.cjs': '/usr/local/bin/wbb-trial-migrate',
    'deploy/litestream.yml': LITESTREAM_CONFIG,
    'scripts/ops/host_patch_collect.py': '/usr/local/libexec/wbb-host-patch-collect',
    'scripts/ops/reboot_request.py': '/usr/local/libexec/wbb-reboot-request',
    # The control plane's entry points and the tick's failure notice (plan C-core "Рішення" п.5, п.7).
    'deploy/wbb-release.sh': ROOT_HELPER,
    'deploy/wbb-tick.sh': TICK_BIN,
    'deploy/wbb-tick-failed.sh': '/usr/local/libexec/wbb-tick-failed',
}
# Matched by a pattern, never copied as it is: a human fills it in (secrets) at its own path.
NOT_COPIED = ('deploy/litestream.env.example',)
UNIT_SUFFIXES = ('.service', '.timer', '.path')
RELEASE_DIR = 'deploy/release/'
# Test-only modules of deploy/release: never installed next to the code root runs.
TEST_ONLY = ('test_', 'fake_')
TEST_ONLY_FILES = ('release_testkit.py',)


def _test_only(name):
    return name.startswith(TEST_ONLY) or name in TEST_ONLY_FILES


def installed_path(repo_path):
    """The installed copy of repo_path, or None when it has none."""
    if repo_path in COPIES:
        return COPIES[repo_path]
    if repo_path in NOT_COPIED or '__pycache__' in repo_path.split('/'):
        return None
    if repo_path.startswith(RELEASE_DIR):
        rest = repo_path[len(RELEASE_DIR):]
        return None if _test_only(posixpath.basename(rest)) else posixpath.join(LIB_DIR, rest)
    head, name = posixpath.split(repo_path)
    if head == 'deploy/sudoers.d':
        return posixpath.join(SUDOERS_DIR, name)
    if head == 'deploy' and name.endswith(UNIT_SUFFIXES):
        return posixpath.join(UNIT_DIR, name)
    return None


# The files of deploy/sudoers.d, by name (test_installed checks this is exactly that directory): the only names in
# SUDOERS_DIR root digests for the operator (e2e review N2 — not "any name sudo would read", which let the operator
# ask root about a foreign file such as another package's sudoers drop-in).
SUDOERS_FILES = ('warsaw-beer-bot', 'wbb-image', 'wbb-release')


def digestable(path):
    """True for an installed copy the operator cannot read and root may hash for them (`wbb-release digest`).

    The rule must admit only what installed_path yields for some repo file, but root runs it without the repo:
    SUDOERS_DIR/<name> for each name of SUDOERS_FILES, spelled exactly. The litestream config is the plan's one other path, named exactly: deploy/README installs it 0644, so the
    operator normally reads it themself, but a host that keeps it closed is assessed rather than "cannot assess".
    The comparison is on the string as given: no normalisation, so `/etc//sudoers.d/x` or `/etc/./…` is refused.
    """
    if not isinstance(path, str):
        return False
    if path == LITESTREAM_CONFIG:
        return True
    return path in {posixpath.join(SUDOERS_DIR, name) for name in SUDOERS_FILES}
