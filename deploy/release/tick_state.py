"""The tick controller's own state: what it saw of `main`, what it decided, what it already said (host).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (quiet main, regression
fence, notifications), §7.
Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, "Рішення" п.2, Task 1.

`tick-state.json` lives next to the engine's `deploy-state.json` and never duplicates it: state v2 is
about an activation and its rollback, this file is about admission and notifications. What each field
claims, and its evidence (plan, "заявка → доказ"):

  mainSeen {sha, at}     main was `sha` from `at` on, by the tick's own clock at its first sighting
  noopSha                the payload of this SHA equals the settled one (manifests compared in a tick)
  abort {sha, count, at} this SHA was aborted before it started `count` times in a row, last at `at`
  notifiedTxn            the end of this transaction was reported (written AFTER a successful notify)
  lastSeenSettled        the settled SHA the regression fence last observed (merge-deploy
                         LAST_SEEN_DEPLOYED_SHA)
  regression {from, to}  production went from `from` back (or sideways) to `to`; unattended deploys
                         are held until a settled release contains `from` again
  notices {key: day}     the UTC day a standing condition was last reported under this key

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
    _SPEC = (('sha', 'sha', _SHA_KIND), ('count', 'count', _Positive()), ('at', 'at', ds._Number()))


@dataclass(frozen=True)
class Regression(ds._Record):
    from_sha: str
    to_sha: str
    _SPEC = (('from_sha', 'from', _SHA_KIND), ('to_sha', 'to', _SHA_KIND))


@dataclass(frozen=True)
class TickState(ds._Record):
    main_seen: Seen | None = None
    noop_sha: str | None = None
    abort: Abort | None = None
    notified_txn: str | None = None
    last_seen_settled: str | None = None
    regression: Regression | None = None
    notices: MappingProxyType = MappingProxyType({})
    _SPEC = (
        ('main_seen', 'mainSeen', ds._Opt(ds._Rec(Seen))),
        ('noop_sha', 'noopSha', ds._Opt(_SHA_KIND)),
        ('abort', 'abort', ds._Opt(ds._Rec(Abort))),
        ('notified_txn', 'notifiedTxn', ds._Opt(_TXN_KIND)),
        ('last_seen_settled', 'lastSeenSettled', ds._Opt(_SHA_KIND)),
        ('regression', 'regression', ds._Opt(ds._Rec(Regression))),
        ('notices', 'notices', _Notices()),
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


def aborted(state, sha, now):
    """One more abort of sha: the count goes on for the same SHA and starts at 1 for another."""
    count = state.abort.count + 1 if state.abort is not None and state.abort.sha == sha else 1
    return state.replace(abort=Abort(sha, count, now))


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
