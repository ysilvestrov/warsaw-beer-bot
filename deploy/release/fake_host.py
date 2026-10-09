"""A model of the host for the activation engine's tests (not a test module).

Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2c.md, Tasks 3-4.

`World` is what is true on the host: the bot and Litestream units, WHICH release the running
bot process actually serves (fixed when it starts: switching `current` does not change a
running process — plan 2v premise probe on realpath), the `current` pointer (only accepted
releases), the database files in a temporary directory (post and restore are the real dbsnap
on real files), NRestarts, the boot, a clock. It also records what the engine must never do
(`violations`): switch under a running bot, touch the DB with writers running, rewrite a
complete post, restore without one (no post.json — dbsnap.restore checks the rest).

`FakeHost` is the engine's Host over a World; `MemoryStore` keeps the state as the bytes
deploy_state would write. Both go through `Faults`, which numbers every host call and every
save, before and after the action, and raises `Crash` at a chosen number.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbsnap  # noqa: E402
from activate import Health  # noqa: E402
from deploy_state import State  # noqa: E402
from safe_tar import Refused  # noqa: E402

T0 = 1_760_000_000
BOOT_A = '0f0e0d0c-0b0a-4908-8706-050403020100'
BOOT_B = '11111111-2222-4333-8444-555555555555'
PRE_DB = b'SQLite pre: the database before the activation'
# The treeSha256 each release's receipt accepted (what verify/switch report back).
OLD_TREE = '2' * 64
CAND_TREE = '1' * 64


class Crash(BaseException):
    """The controller process dies here (not an Exception: nothing in the engine may catch it)."""


class Faults:
    def __init__(self, crash_at=None):
        self.crash_at = crash_at
        self.points = []

    def _point(self, name, when):
        index = len(self.points)
        self.points.append(f'{name} {when}')
        if index == self.crash_at:
            raise Crash(index, name, when)

    def around(self, name, action):
        self._point(name, 'before')
        result = action()
        self._point(name, 'after')
        return result


class MemoryStore:
    """The state as deploy_state would write it, in memory.

    `save` keeps the State itself (it is immutable); its canonical bytes are what `data` returns,
    and what `reopened()` — a new process after a crash — parses back through State.from_json.
    """
    def __init__(self, faults=None, state=None, data=None):
        self.faults = faults or Faults()
        self._state = state
        self._data = data
        self.saves = 0

    @property
    def data(self):
        return self._state.to_bytes() if self._state is not None else self._data

    def reopened(self, faults=None):
        """The same bytes as a new process would open them."""
        return MemoryStore(faults, data=self.data)

    def load(self):
        if self._state is None and self._data is not None:
            self._state = State.from_json(json.loads(self._data))
        return self._state

    def save(self, state):
        def write():
            self._state = state
            self.saves += 1
        self.faults.around(f'save {state.phase}/{state.intent}', write)


def _read(path):
    with open(path, 'rb') as f:
        return f.read()


def _write(path, data):
    with open(path, 'wb') as f:
        f.write(data)


class World:
    """The host. `old` is running and settled; `cand` is the release being activated.

    healthy(sha, age) and restarts(sha, age) script the bot by the release a process serves and
    the seconds since it started; restarts returning None models an unreadable NRestarts.
    """
    def __init__(self, base, old, cand, accepted=None, trees=None):
        self.base, self.old, self.cand = base, old, cand
        self.db = os.path.join(base, 'bot.db')
        self.pre = os.path.join(base, '20261009T080000Z-ccccccc-pre.db')
        self.now = T0
        self.boot = BOOT_A
        self.accepted = {old, cand} if accepted is None else set(accepted)
        self.trees = {old: OLD_TREE, cand: CAND_TREE} if trees is None else dict(trees)
        # Releases whose tree changed after `begin` verified it: the switch's own re-verification refuses.
        self.tampered = set()
        self.current = old
        self.bot = 'active'
        self.running = old
        self.started_at = T0 - 86400
        self.litestream = 'active'
        self.stop_works = True
        self.port_owner = None
        self.healthy = lambda sha, age: True
        self.restarts = lambda sha, age: 0
        self.starts = []
        self.health_calls = []
        self.violations = []
        self.posts = []
        self.restores = []
        # The DB files as the candidate's process left them after each of its starts, in order.
        self.cand_writes = []
        # Host method name -> the exception it raises instead of acting (sudo broken, systemctl down).
        self.errors = {}
        _write(self.db, PRE_DB)
        _write(self.pre, PRE_DB)
        _write(self.pre + '.sha256', (hashlib.sha256(PRE_DB).hexdigest() + '\n').encode())

    def candidate_writes(self, n=1):
        """What the candidate's n-th start writes when it finds exactly the pre DB: bot.db and a live WAL.

        Every start writes rows of its own (2в e2e review Ф1), so a test sees which start's writes a
        post holds and which ones a restore would lose.
        """
        return PRE_DB + self._row(n), self._wal(n)

    def _row(self, n):
        return f' | migrated by {self.cand}, start {n}'.encode()

    def _wal(self, n):
        return f'WAL of {self.cand}, start {n}'.encode()

    def writers_running(self):
        return self.bot == 'active' or self.litestream == 'active'

    def stop_bot(self):
        if self.stop_works:
            self.bot, self.running = 'inactive', None

    def start_bot(self):
        if self.bot == 'active':
            return
        self.bot, self.running, self.started_at = 'active', self.current, self.now
        self.starts.append((self.current, self.now))
        if self.current == self.cand:
            n = len(self.cand_writes) + 1
            found = self.db_files()
            # SQLite applies the WAL it finds; then the candidate writes its own rows and a new WAL.
            _write(self.db, found.get('', b'') + found.get('-wal', b'') + self._row(n))
            _write(self.db + '-wal', self._wal(n))
            self.cand_writes.append(self.db_files())

    def switch(self, sha):
        if self.bot == 'active':
            self.violations.append(f'switch to {sha[:7]} under a running bot')
        if sha in self.tampered:
            raise Refused(f'{sha}: release tree changed:\ndist/index.js: differs from manifest (sha256)')
        tree = self.verify(sha)
        self.current = sha
        return tree

    def verify(self, sha):
        """publish.verify_release: the receipt's treeSha256, or Refused."""
        if sha not in self.accepted:
            raise Refused(f'{sha}: no receipt — not an accepted release')
        return self.trees[sha]

    def health(self):
        self.health_calls.append((self.now, self.running))
        if self.port_owner is not None:
            return Health(True, self.port_owner)
        if self.bot != 'active':
            return Health(False, None)
        return Health(self.healthy(self.running, self.now - self.started_at), self.running)

    def nrestarts(self):
        if self.running is None:
            return 0
        return self.restarts(self.running, self.now - self.started_at)

    def post(self, out):
        if self.writers_running():
            self.violations.append('post with writers running')
        manifest = os.path.join(out, dbsnap.POST_MANIFEST)
        before = os.stat(manifest) if os.path.exists(manifest) else None
        result = dbsnap.post(self.db, out)
        after = os.stat(manifest)
        if before is not None and (before.st_ino, before.st_mtime_ns) != (after.st_ino, after.st_mtime_ns):
            self.violations.append(f'complete post {out} rewritten')
        self.posts.append(out)
        return result

    def restore(self, pre, post_dir):
        if self.writers_running():
            self.violations.append('restore with writers running')
        if not os.path.exists(os.path.join(post_dir, dbsnap.POST_MANIFEST)):
            # dbsnap.restore refuses it too; recorded here so a test sees the attempt itself.
            self.violations.append('restore without a complete post')
        self.restores.append((pre, post_dir))
        return dbsnap.restore(pre, self.db, post_dir)

    def reboot(self, seconds=5):
        """A new boot: units come back up by themselves, the bot from whatever `current` is now."""
        self.now += seconds
        self.boot = BOOT_B if self.boot == BOOT_A else BOOT_A
        self.bot, self.running, self.litestream = 'inactive', None, 'active'
        self.start_bot()

    def db_files(self):
        """bot.db and its side files as they are now: {suffix: bytes}."""
        return {s: _read(self.db + s) for s in ('', '-wal', '-shm') if os.path.exists(self.db + s)}


class FakeHost:
    def __init__(self, world, faults=None):
        self.world = world
        self.faults = faults or Faults()

    def _do(self, name, action):
        def act():
            if name in self.world.errors:
                raise self.world.errors[name]
            return action()
        return self.faults.around(name, act)

    def bot_state(self):
        return self._do('bot_state', lambda: self.world.bot)

    def stop_bot(self):
        return self._do('stop_bot', self.world.stop_bot)

    def start_bot(self):
        return self._do('start_bot', self.world.start_bot)

    def litestream_state(self):
        return self._do('litestream_state', lambda: self.world.litestream)

    def stop_litestream(self):
        return self._do('stop_litestream', lambda: setattr(self.world, 'litestream', 'inactive'))

    def start_litestream(self):
        return self._do('start_litestream', lambda: setattr(self.world, 'litestream', 'active'))

    def current(self):
        return self._do('current', lambda: self.world.current)

    def switch(self, sha):
        return self._do('switch', lambda: self.world.switch(sha))

    def verify(self, sha):
        return self._do('verify', lambda: self.world.verify(sha))

    def health(self):
        return self._do('health', self.world.health)

    def nrestarts(self):
        return self._do('nrestarts', self.world.nrestarts)

    def boot_id(self):
        return self._do('boot_id', lambda: self.world.boot)

    def post(self, out):
        return self._do('post', lambda: self.world.post(out))

    def restore(self, pre, post_dir):
        return self._do('restore', lambda: self.world.restore(pre, post_dir))

    def now(self):
        return self._do('now', lambda: self.world.now)

    def sleep(self, seconds):
        def advance():
            self.world.now += seconds
        return self._do('sleep', advance)
