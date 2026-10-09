"""Versioned deploy-controller state v2: one durable JSON file, phase and action intent (host).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §7 (versioned
state), §10a (Pending phase/substep, settled, previous settled), §10b (transaction id, boot_id,
phase and action-intent substep).
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2c.md, Task 1.

What a state file claims: the action named by `intent` was PLANNED; whether it ran is unknown
until the engine observes the world. It never claims an action is done. A missing file is the
first run (None); a file that is empty, not JSON, of another version or breaks the schema is a
StateError — never a blank slate, because a blank slate would forget a half-done activation.

`State` is immutable and validated on construction (and so on every `replace`), so an engine
cannot hold, let alone save, a state this module would refuse to load.
"""
import json
import math
import os
import re
import secrets
import sys
from dataclasses import dataclass, fields, replace as dc_replace
from types import MappingProxyType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish as pub  # noqa: E402
import tree_manifest as tm  # noqa: E402

FORMAT_VERSION = 2
STATE_NAME = 'deploy-state.json'
MAX_BYTES = 1 << 20
BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'

# Phase -> the intents it may carry (§10b; plan "Global Constraints"). None = no action pending.
INTENTS = {
    'settled': (None,),
    'activating': ('stop', 'switch', 'start'),
    'observing': (None,),
    'rolling-back': ('stop-writers', 'save-post', 'restore-pre', 'switch-previous', 'start-baseline'),
    'unverified': (None,),
    'recovery-failed': (None,),
}
# Phase -> fields that must be set. `settled` alone has no transaction; a first install may
# even have no settled baseline yet (the engine then refuses to begin, it does not guess one).
REQUIRED = {
    'settled': (),
    'activating': ('txn', 'candidate', 'previous', 'pre'),
    'observing': ('txn', 'candidate', 'previous', 'pre', 'observe'),
    'rolling-back': ('txn', 'candidate', 'previous', 'pre'),
    'unverified': ('txn', 'candidate', 'unverified'),
    'recovery-failed': ('txn', 'candidate'),
}
# A restore never starts without a complete post (§10b "restore pre": verify complete post).
REQUIRED_BY_INTENT = {'restore-pre': ('posts',)}

_SHA = re.compile(r'[0-9a-f]{40}')
_HEX64 = re.compile(r'[0-9a-f]{64}')
_TXN = re.compile(r'[0-9a-f]{32}')
_BOOT_ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


class StateError(Exception):
    pass


def _fail(where, why):
    raise StateError(f'{where}: {why}')


# A field kind validates a Python value, loads it from JSON and dumps it back.
class _Kind:
    def check(self, v, where):
        raise NotImplementedError

    def load(self, v, where):
        self.check(v, where)
        return v

    def dump(self, v):
        return v


class _Pattern(_Kind):
    def __init__(self, regex, what):
        self.regex, self.what = regex, what

    def check(self, v, where):
        if not isinstance(v, str) or not self.regex.fullmatch(v):
            _fail(where, f'not {self.what}: {v!r}')


def _finite(v):
    """math.isfinite, but an int too big for a float is not finite (2v review: it raised OverflowError)."""
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


class _Number(_Kind):
    """A time in seconds: a finite, non-negative int or float (never a bool)."""
    def check(self, v, where):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not _finite(v) or v < 0:
            _fail(where, f'not a finite non-negative number: {v!r}')


class _Count(_Kind):
    def check(self, v, where):
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            _fail(where, f'not a non-negative integer: {v!r}')


class _Text(_Kind):
    def check(self, v, where):
        if not isinstance(v, str) or not v:
            _fail(where, f'not a non-empty string: {v!r}')


class _AbsPath(_Kind):
    def check(self, v, where):
        if not isinstance(v, str) or not os.path.isabs(v) or '\0' in v:
            _fail(where, f'not an absolute path: {v!r}')


class _Opt(_Kind):
    def __init__(self, inner):
        self.inner = inner

    def check(self, v, where):
        if v is not None:
            self.inner.check(v, where)

    def load(self, v, where):
        return None if v is None else self.inner.load(v, where)

    def dump(self, v):
        return None if v is None else self.inner.dump(v)


class _Rec(_Kind):
    def __init__(self, cls):
        self.cls = cls

    def check(self, v, where):
        if not isinstance(v, self.cls):
            _fail(where, f'not a {self.cls.__name__}: {v!r}')

    def load(self, v, where):
        return self.cls.from_json(v, where)

    def dump(self, v):
        return v.to_json()


_SCALARS = (str, int, float, bool, type(None))


def _strings(v):
    """A detail that lists names (the rollback's posts, 2в e2e review Ф1): a list of non-empty strings."""
    return isinstance(v, (list, tuple)) and all(isinstance(x, str) and x for x in v)


def _event(e, where):
    """One evidence entry: at, what, result, plus scalar or list-of-strings details — frozen."""
    if not isinstance(e, (dict, MappingProxyType)):
        _fail(where, f'not an object: {e!r}')
    for key in ('at', 'what', 'result'):
        if key not in e:
            _fail(where, f'missing {key}')
    _Number().check(e['at'], f'{where}.at')
    _Text().check(e['what'], f'{where}.what')
    _Text().check(e['result'], f'{where}.result')
    frozen = {}
    for k, v in e.items():
        if not isinstance(k, str):
            _fail(where, f'detail {k!r} is not a string key')
        if _strings(v):
            v = tuple(v)
        elif not isinstance(v, _SCALARS) or (isinstance(v, float) and not math.isfinite(v)):
            _fail(where, f'detail {k!r} is not a finite JSON scalar or a list of strings: {v!r}')
        frozen[k] = v
    return MappingProxyType(frozen)


class _Frozen(tuple):
    """Private marker: events that _event already froze inside a State (see State.__post_init__)."""


class _Evidence(_Kind):
    def check(self, v, where):
        if not isinstance(v, tuple) or not all(isinstance(e, MappingProxyType) for e in v):
            _fail(where, 'not a tuple of frozen events')

    def load(self, v, where):
        if not isinstance(v, list):
            _fail(where, f'not a list: {v!r}')
        return tuple(_event(e, f'{where}[{i}]') for i, e in enumerate(v))

    def dump(self, v):
        return [{k: list(x) if isinstance(x, tuple) else x for k, x in e.items()} for e in v]


class _Paths(_Kind):
    """A tuple of absolute paths (JSON: a list)."""
    def check(self, v, where):
        if not isinstance(v, tuple):
            _fail(where, f'not a tuple of paths: {v!r}')
        for i, p in enumerate(v):
            _AbsPath().check(p, f'{where}[{i}]')

    def load(self, v, where):
        if not isinstance(v, list):
            _fail(where, f'not a list: {v!r}')
        v = tuple(v)
        self.check(v, where)
        return v

    def dump(self, v):
        return list(v)


def _exact_keys(obj, keys, where):
    if not isinstance(obj, dict):
        _fail(where, f'not an object: {obj!r}')
    missing, unknown = sorted(set(keys) - set(obj)), sorted(set(obj) - set(keys))
    if missing or unknown:
        _fail(where, f'missing {missing}, unknown {unknown}')


class _Record:
    """A frozen record whose `_SPEC` is ((attribute, JSON key, kind), ...)."""
    _SPEC = ()

    def __post_init__(self):
        for attr, key, kind in self._SPEC:
            kind.check(getattr(self, attr), f'{type(self).__name__}.{key}')

    def to_json(self):
        return {key: kind.dump(getattr(self, attr)) for attr, key, kind in self._SPEC}

    @classmethod
    def from_json(cls, obj, where):
        _exact_keys(obj, [key for _, key, _ in cls._SPEC], where)
        return cls(**{attr: kind.load(obj[key], f'{where}.{key}') for attr, key, kind in cls._SPEC})


@dataclass(frozen=True)
class Release(_Record):
    """A release by SHA and the tree digest its receipt accepted."""
    sha: str
    tree_sha256: str
    _SPEC = (('sha', 'sha', _Pattern(_SHA, 'a full lowercase SHA')),
             ('tree_sha256', 'treeSha256', _Pattern(_HEX64, 'a sha256 hex digest')))


@dataclass(frozen=True)
class Pre(_Record):
    """The pre-activation DB snapshot (db-snapshot.sh `snapshot`): file, its sha256, when taken."""
    path: str
    sha256: str
    taken_at: float
    _SPEC = (('path', 'path', _AbsPath()), ('sha256', 'sha256', _Pattern(_HEX64, 'a sha256 hex digest')),
             ('taken_at', 'takenAt', _Number()))


@dataclass(frozen=True)
class Observe(_Record):
    """The window: when it began and in which boot, NRestarts baseline (None until read), last sample,
    failures in a row, and when the candidate first answered healthy as itself (None: still starting)."""
    started_at: float
    boot_id: str
    nrestarts0: int | None
    last_sample_at: float | None
    fails: int
    healthy_at: float | None = None
    _SPEC = (('started_at', 'startedAt', _Number()), ('boot_id', 'bootId', _Pattern(_BOOT_ID, 'a boot id')),
             ('nrestarts0', 'nrestarts0', _Opt(_Count())), ('last_sample_at', 'lastSampleAt', _Opt(_Number())),
             ('fails', 'fails', _Count()), ('healthy_at', 'healthyAt', _Opt(_Number())))


@dataclass(frozen=True)
class Settled(_Record):
    """The last release that went through a full window: the rollback baseline."""
    sha: str
    tree_sha256: str
    settled_at: float
    _SPEC = (('sha', 'sha', _Pattern(_SHA, 'a full lowercase SHA')),
             ('tree_sha256', 'treeSha256', _Pattern(_HEX64, 'a sha256 hex digest')),
             ('settled_at', 'settledAt', _Number()))


@dataclass(frozen=True)
class Unverified(_Record):
    """A release left running whose window was not proven; it blocks unattended activation."""
    sha: str
    reason: str
    pre: Pre | None
    _SPEC = (('sha', 'sha', _Pattern(_SHA, 'a full lowercase SHA')), ('reason', 'reason', _Text()),
             ('pre', 'pre', _Opt(_Rec(Pre))))


@dataclass(frozen=True)
class State(_Record):
    phase: str
    boot_id: str
    intent: str | None = None
    txn: str | None = None
    candidate: Release | None = None
    previous: Release | None = None
    pre: Pre | None = None
    # Complete rollback posts, oldest first (2в e2e review Ф1): writers started again after a post was
    # taken (a reboot) mean a NEW post, never the old one returned; restore-pre uses the last.
    posts: tuple = ()
    observe: Observe | None = None
    settled: Settled | None = None
    last_failed_sha: str | None = None
    # The transaction that ended last (settled, rolled back or aborted; 2в e2e review Ф6): the periphery
    # reports an end once per txn, also when the tick that reached it died before its notification.
    last_txn: str | None = None
    unverified: Unverified | None = None
    evidence: tuple = ()
    _SPEC = (
        ('phase', 'phase', _Pattern(re.compile('|'.join(map(re.escape, INTENTS))), 'a known phase')),
        ('boot_id', 'bootId', _Pattern(_BOOT_ID, 'a boot id')),
        ('intent', 'intent', _Opt(_Text())),
        ('txn', 'txn', _Opt(_Pattern(_TXN, 'a 32-hex transaction id'))),
        ('candidate', 'candidate', _Opt(_Rec(Release))),
        ('previous', 'previous', _Opt(_Rec(Release))),
        ('pre', 'pre', _Opt(_Rec(Pre))),
        ('posts', 'posts', _Paths()),
        ('observe', 'observe', _Opt(_Rec(Observe))),
        ('settled', 'settled', _Opt(_Rec(Settled))),
        ('last_failed_sha', 'lastFailedSha', _Opt(_Pattern(_SHA, 'a full lowercase SHA'))),
        ('last_txn', 'lastTxn', _Opt(_Pattern(_TXN, 'a 32-hex transaction id'))),
        ('unverified', 'unverified', _Opt(_Rec(Unverified))),
        ('evidence', 'evidence', _Evidence()),
    )

    def __post_init__(self):
        if type(self.evidence) is _Frozen:
            # Events a State already froze (carried by replace/log): checked once, not on every change.
            object.__setattr__(self, 'evidence', tuple(self.evidence))
        elif isinstance(self.evidence, (list, tuple)):
            # Callers pass a list of dicts; the state keeps frozen copies so nothing can change it in place.
            object.__setattr__(self, 'evidence', tuple(_event(e, f'State.evidence[{i}]')
                                                       for i, e in enumerate(self.evidence)))
        super().__post_init__()
        if self.intent not in INTENTS[self.phase]:
            _fail('State.intent', f'{self.intent!r} is not an intent of phase {self.phase}')
        if self.phase == 'settled' and self.txn is not None:
            _fail('State.txn', 'a settled state has no open transaction')
        by_key = {attr: key for attr, key, _ in self._SPEC}
        for attrs, where in ((REQUIRED[self.phase], self.phase),
                             (REQUIRED_BY_INTENT.get(self.intent, ()), f'{self.phase}/{self.intent}')):
            for attr in attrs:
                if getattr(self, attr) in (None, ()):
                    _fail(f'State.{by_key[attr]}', f'required in {where}')

    def replace(self, **changes):
        """A new, validated State with these fields changed; this one is untouched."""
        changes.setdefault('evidence', _Frozen(self.evidence))
        return dc_replace(self, **changes)

    def log(self, at, what, result, **detail):
        """A new State with one more evidence event (scalar or list-of-strings details).

        Every event carries the transaction it belongs to (2в e2e review Ф6): the open `txn`, or, for
        the event that ends one (txn already cleared), `lastTxn` — so a notification is keyed by txn.
        """
        txn = self.txn if self.txn is not None else self.last_txn
        event = _event(dict(detail, at=at, what=what, result=result, txn=txn), f'State.evidence[{len(self.evidence)}]')
        return self.replace(evidence=_Frozen(self.evidence + (event,)))

    def to_json(self):
        return {'formatVersion': FORMAT_VERSION, **super().to_json()}

    def to_bytes(self):
        """Canonical JSON (sorted keys, no whitespace) — the exact bytes `save` writes."""
        return tm.canonical_bytes(self.to_json())

    @classmethod
    def from_json(cls, obj, where='state'):
        if not isinstance(obj, dict):
            _fail(where, f'not an object: {type(obj).__name__}')
        if type(obj.get('formatVersion')) is not int or obj['formatVersion'] != FORMAT_VERSION:
            _fail(where, f'formatVersion {obj.get("formatVersion")!r}, expected {FORMAT_VERSION}')
        return super().from_json({k: v for k, v in obj.items() if k != 'formatVersion'}, where)


assert [f.name for f in fields(State)] == [attr for attr, _, _ in State._SPEC]


def _no_duplicates(pairs):
    keys = [k for k, _ in pairs]
    dup = sorted({k for k in keys if keys.count(k) > 1})
    if dup:
        raise StateError(f'duplicate keys {dup}')
    return dict(pairs)


def load(path):
    """The state at path; None only if the file does not exist. Anything unreadable as v2 is a StateError."""
    try:
        with open(path, 'rb') as f:
            data = f.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return None
    if not data:
        raise StateError(f'{path}: empty')
    if len(data) > MAX_BYTES:
        raise StateError(f'{path}: over {MAX_BYTES} bytes')
    try:
        obj = json.loads(data, object_pairs_hook=_no_duplicates)
    except StateError as e:
        raise StateError(f'{path}: {e}') from None
    except ValueError as e:
        raise StateError(f'{path}: not JSON ({e})') from None
    try:
        return State.from_json(obj)
    except StateError as e:
        raise StateError(f'{path}: {e}') from None


def save(path, state):
    """Write state durably: temp in the same directory, fsync(file), rename, fsync(directory)."""
    if not isinstance(state, State):
        raise TypeError(f'not a State: {state!r}')
    pub.write_atomic(path, state.to_bytes(), '.deploy-state-')


def new_txn():
    return secrets.token_hex(16)


def read_boot_id(path=BOOT_ID_PATH):
    """This boot's id (a reboot changes it; the window must not span one)."""
    with open(path, encoding='ascii') as f:
        raw = f.read(128)
    boot = raw.rstrip('\n')
    if not _BOOT_ID.fullmatch(boot):
        raise StateError(f'{path}: not a boot id: {raw!r}')
    return boot
