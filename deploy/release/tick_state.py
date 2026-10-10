"""The tick controller's own state: what it saw of `main`, what it decided, what it already said (host).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (quiet main, regression
fence, notifications), §7.
Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, "Рішення" п.2, Task 1.

`tick-state.json` lives next to the engine's `deploy-state.json` and never duplicates it: state v2 is
about an activation and its rollback, this file is about admission and notifications. What each field
claims, and its evidence (plan, "заявка → доказ"):

  mainSeen {sha, at}     main was `sha` from `at` on, by the tick's own clock at its first sighting
  noop {sha, settledSha} the payload of `sha` equals that of the settled release `settledSha` (manifests
                         compared in a tick); it says nothing once another release is settled (stage A
                         review B1)
  abort {sha, count, at, txn}  this SHA was aborted before it started `count` times in a row, last at
                         `at`, by transaction `txn` (an abort is counted once per txn, however often the
                         tick that reads it is repeated)
  blocked {txn, step, at, alerts}  the engine is blocked at `step` (phase/intent) with the bot down; the
                         first critical alert for this txn and step was SENT at `at`, `alerts` sent so far
  notifiedTxn            the end of this transaction was reported (written AFTER a successful notify)
  lastSeenSettled        the settled SHA the regression fence last observed (merge-deploy
                         LAST_SEEN_DEPLOYED_SHA)
  regression {from, to}  production went from `from` back (or sideways) to `to`; unattended deploys
                         are held until a settled release contains `from` again
  ackThrough             a human acknowledged the holds of the range up to this SHA: set by a manual run with
                         --ack-holds that settled or found a noop, and by every settled release the fence
                         observes; holds are read from the newest of settled and ackThrough that the target
                         contains (stage A review S1: a held range that was a noop otherwise held forever)
  notices {key: day}     the UTC day a standing condition was last reported under this key
  pendingVerdicts [{sha, text, recorded}]  verdict messages not delivered yet, oldest first (#827 AI review):
                         lastFailedSha stops a SHA from being prepared again, so each message waits here until
                         sent; `recorded` says lastFailedSha already landed in the engine's state

A missing file is a first tick (None). An empty, non-JSON, other-version or schema-breaking file is a
StateError, never a blank slate: a blank slate would forget a regression fence.
"""
import json
import os
import re
import sys
from datetime import date
from dataclasses import dataclass, replace as dc_replace
from types import MappingProxyType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy_state as ds  # noqa: E402
import publish as pub  # noqa: E402
import tree_manifest as tm  # noqa: E402
from deploy_state import StateError  # noqa: E402

FORMAT_VERSION = 1
STATE_NAME = 'tick-state.json'
MAX_BYTES = 1 << 20
# A notice key no tick asked about for this long is dropped, so per-SHA keys do not pile up forever.
NOTICE_KEEP_DAYS = 31

_SHA_KIND = ds._Pattern(re.compile(r'[0-9a-f]{40}'), 'a full lowercase SHA')
_TXN_KIND = ds._Pattern(re.compile(r'[0-9a-f]{32}'), 'a 32-hex transaction id')
_KEY = re.compile(r'[a-z][a-z0-9-]*(:[0-9a-f]{40})?')


class _Positive(ds._Kind):
    def check(self, v, where):
        if isinstance(v, bool) or not isinstance(v, int) or v < 1:
            ds._fail(where, f'not a positive integer: {v!r}')


def _is_day(v):
    if not isinstance(v, str) or len(v) != 10:
        return False
    try:
        return date.fromisoformat(v).isoformat() == v
    except ValueError:
        return False


class _Notices(ds._Kind):
    """{key: 'YYYY-MM-DD'}, frozen."""
    def check(self, v, where):
        if not isinstance(v, MappingProxyType):
            ds._fail(where, f'not a frozen mapping: {v!r}')
        for k, day in v.items():
            if not isinstance(k, str) or not _KEY.fullmatch(k):
                ds._fail(where, f'not a notice key: {k!r}')
            if not _is_day(day):
                ds._fail(f'{where}.{k}', f'not a YYYY-MM-DD day: {day!r}')

    def load(self, v, where):
        if not isinstance(v, dict):
            ds._fail(where, f'not an object: {v!r}')
        v = MappingProxyType(dict(v))
        self.check(v, where)
        return v

    def dump(self, v):
        return dict(v)


@dataclass(frozen=True)
class Seen(ds._Record):
    sha: str
    at: float
    _SPEC = (('sha', 'sha', _SHA_KIND), ('at', 'at', ds._Number()))


@dataclass(frozen=True)
class Abort(ds._Record):
    sha: str
    count: int
    at: float
    txn: str | None = None
    _SPEC = (('sha', 'sha', _SHA_KIND), ('count', 'count', _Positive()), ('at', 'at', ds._Number()),
             ('txn', 'txn', ds._Opt(_TXN_KIND)))


@dataclass(frozen=True)
class Blocked(ds._Record):
    """Ф3 (2в e2e review): a blocked step with the bot down — when it was first reported, how many alerts."""
    txn: str
    step: str
    at: float
    alerts: int
    _SPEC = (('txn', 'txn', _TXN_KIND), ('step', 'step', ds._Text()), ('at', 'at', ds._Number()),
             ('alerts', 'alerts', _Positive()))


@dataclass(frozen=True)
class Noop(ds._Record):
    """`sha` changes nothing against the settled release `settled_sha` it was compared with — and only against
    it: once settled moves, a target equal to `sha` is prepared again (stage A review B1)."""
    sha: str
    settled_sha: str
    _SPEC = (('sha', 'sha', _SHA_KIND), ('settled_sha', 'settledSha', _SHA_KIND))


class _Flag(ds._Kind):
    def check(self, v, where):
        if not isinstance(v, bool):
            ds._fail(where, f'not a boolean: {v!r}')


class _Records(ds._Kind):
    """A tuple of records of one class (JSON: a list), at most `limit` of them."""
    def __init__(self, cls, limit):
        self.cls, self.limit = cls, limit

    def check(self, v, where):
        if not isinstance(v, tuple) or len(v) > self.limit:
            ds._fail(where, f'not a tuple of at most {self.limit} {self.cls.__name__}: {v!r}')
        for i, r in enumerate(v):
            if not isinstance(r, self.cls):
                ds._fail(f'{where}[{i}]', f'not a {self.cls.__name__}: {r!r}')

    def load(self, v, where):
        if not isinstance(v, list):
            ds._fail(where, f'not a list: {v!r}')
        out = tuple(self.cls.from_json(r, f'{where}[{i}]') for i, r in enumerate(v))
        self.check(out, where)
        return out

    def dump(self, v):
        return [r.to_json() for r in v]


@dataclass(frozen=True)
class Verdict(ds._Record):
    """A verdict the tick wrote, with its message, until the message went out (#827 AI review).

    `recorded` is False from the moment the message is persisted until lastFailedSha is in the engine's
    state: the two live in different files, and a tick that died between them must finish the second
    write, not send a verdict the gates do not know.
    """
    sha: str
    text: str
    recorded: bool
    _SPEC = (('sha', 'sha', _SHA_KIND), ('text', 'text', ds._Text()), ('recorded', 'recorded', _Flag()))


# Undelivered verdict messages kept at once (each at most NOTIFY_LIMIT characters, so the file stays far
# under its 1 MiB limit). The queue is never truncated: at this many the tick prepares nothing new until
# they went out — every verdict needs a new main SHA that fails, so this means notify has been broken long.
MAX_PENDING_VERDICTS = 10


@dataclass(frozen=True)
class Regression(ds._Record):
    from_sha: str
    to_sha: str
    _SPEC = (('from_sha', 'from', _SHA_KIND), ('to_sha', 'to', _SHA_KIND))


@dataclass(frozen=True)
class TickState(ds._Record):
    main_seen: Seen | None = None
    noop: Noop | None = None
    abort: Abort | None = None
    notified_txn: str | None = None
    last_seen_settled: str | None = None
    regression: Regression | None = None
    notices: MappingProxyType = MappingProxyType({})
    blocked: Blocked | None = None
    ack_through: str | None = None
    pending_verdicts: tuple = ()
    _SPEC = (
        ('main_seen', 'mainSeen', ds._Opt(ds._Rec(Seen))),
        ('noop', 'noop', ds._Opt(ds._Rec(Noop))),
        ('abort', 'abort', ds._Opt(ds._Rec(Abort))),
        ('notified_txn', 'notifiedTxn', ds._Opt(_TXN_KIND)),
        ('last_seen_settled', 'lastSeenSettled', ds._Opt(_SHA_KIND)),
        ('regression', 'regression', ds._Opt(ds._Rec(Regression))),
        ('notices', 'notices', _Notices()),
        ('blocked', 'blocked', ds._Opt(ds._Rec(Blocked))),
        ('ack_through', 'ackThrough', ds._Opt(_SHA_KIND)),
        ('pending_verdicts', 'pendingVerdicts', _Records(Verdict, MAX_PENDING_VERDICTS)),
    )

    def __post_init__(self):
        if isinstance(self.notices, dict):
            object.__setattr__(self, 'notices', MappingProxyType(dict(self.notices)))
        super().__post_init__()

    def replace(self, **changes):
        return dc_replace(self, **changes)

    def to_json(self):
        return {'formatVersion': FORMAT_VERSION, **super().to_json()}

    def to_bytes(self):
        return tm.canonical_bytes(self.to_json())

    @classmethod
    def from_json(cls, obj, where='tick-state'):
        if not isinstance(obj, dict):
            ds._fail(where, f'not an object: {type(obj).__name__}')
        if type(obj.get('formatVersion')) is not int or obj['formatVersion'] != FORMAT_VERSION:
            ds._fail(where, f'formatVersion {obj.get("formatVersion")!r}, expected {FORMAT_VERSION}')
        return super().from_json({k: v for k, v in obj.items() if k != 'formatVersion'}, where)


def load(path):
    """The tick state at path; None only if the file does not exist. Anything else unreadable: StateError."""
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
        obj = json.loads(data, object_pairs_hook=ds._no_duplicates)
        return TickState.from_json(obj)
    except StateError as e:
        raise StateError(f'{path}: {e}') from None
    except ValueError as e:
        raise StateError(f'{path}: not JSON ({e})') from None


def save(path, state):
    """Write durably: temp in the same directory, fsync, rename, fsync(directory)."""
    if not isinstance(state, TickState):
        raise TypeError(f'not a TickState: {state!r}')
    pub.write_atomic(path, state.to_bytes(), '.tick-state-')


def seen_main(state, sha, now):
    """mainSeen for this head: kept while main stays `sha`, restarted at `now` when it moved."""
    if state.main_seen is not None and state.main_seen.sha == sha:
        return state
    return state.replace(main_seen=Seen(sha, now))


def aborted(state, sha, now, txn=None):
    """One more abort of sha: the count goes on for the same SHA and starts at 1 for another.

    An abort already counted for this txn is not counted again (the tick reads the engine's state on every
    run, and a failed notification makes it read the same ended transaction again).
    """
    if txn is not None and state.abort is not None and state.abort.txn == txn:
        return state
    count = state.abort.count + 1 if state.abort is not None and state.abort.sha == sha else 1
    return state.replace(abort=Abort(sha, count, now, txn))


def notice_due(state, key, day, repeat='daily'):
    """Whether a notice under key is owed on UTC `day`: daily — not yet today; once — never yet."""
    last = state.notices.get(key)
    if repeat == 'once':
        return last is None
    if repeat == 'daily':
        return last != day
    raise ValueError(f'unknown repeat {repeat!r}')


def noted(state, key, day):
    """The state after a notice under key was SENT on day; keys older than NOTICE_KEEP_DAYS are dropped."""
    today = date.fromisoformat(day)
    kept = {k: d for k, d in state.notices.items() if (today - date.fromisoformat(d)).days < NOTICE_KEEP_DAYS}
    kept[key] = day
    return state.replace(notices=MappingProxyType(kept))
