"""Admission of a forward deploy: may the tick prepare and activate this SHA now, and if not, why (host).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 GATE-001 (table
"Гейти за шляхом"), §7 (PAUSED, --force, --ack-holds).
Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, Task 1 (steps 5-11
and 13 of the tick's order; "Рішення" п.4 — the held paths).

`admission(inputs)` is a pure function: every fact it weighs was read by the tick before the call, and
nothing here reads a file, the clock or the network. The facts that cost a git or GitHub call — ancestry,
the installed copies, the range's paths and PR labels, CI — start as UNREAD; when a gate reaches one, the
decision is `need` with the field's name, the tick reads it and calls again. So a timer that is still
waiting for quiet asks GitHub nothing, as merge-deploy did, and the gates keep one order whoever calls.

Decision kinds:
  idle   — nothing to do, say nothing (up to date, payload unchanged, paused timer, the failed SHA)
  wait   — a condition that clears by itself (fetch failed, main moved, quiet, backoff, CI pending)
  hold   — a human step is needed first (no baseline, regression fence, ancestry, installed copies,
           held paths/labels without the matching --ack-holds)
  refuse — this SHA will not go now (CI failed, the last failed SHA by hand, a target not in main)
  admit  — every gate passed; the tick prepares the candidate
  need   — read the input named by `reason`, then call again
An idle timer still reads the installed copies and names them stale once a day (merge-deploy kept that
reminder while up to date). `notice_key` names the standing notice for the tick (None: say nothing); `repeat` is 'daily' (once per UTC
day per key) or 'once' (once per key). Only the timer gets notices: a manual run prints its decision to the
operator who is waiting for it.

Modes (spec §5 table): timer forward, manual (`deploy.sh`), force (`deploy.sh --force`). Manual and force
skip PAUSED, quiet and the abort backoff, and pass holds only with `ack_holds` equal to the shown keys;
force also skips ancestry. Nothing skips the regression fence except a target that contains its `from`
(recovery forward), and `admission` never clears it — `observe` does, from what is settled.
"""
import fnmatch
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tick_state import Abort, Noop, Regression, Seen  # noqa: E402

MODES = ('timer', 'manual', 'force')
QUIET_S = 600
# CI pending this long after main was first seen: say so (merge-deploy CI_STUCK_S).
CI_STUCK_S = 3600
BACKOFF_BASE_S = 3600
BACKOFF_MAX_S = 86400
HOLD_LABEL = 'deploy:hold'
CI_KINDS = ('pass', 'pending', 'failed', 'unreadable')


class _Unread:
    def __repr__(self):
        return 'UNREAD'


UNREAD = _Unread()


@dataclass(frozen=True)
class Pr:
    number: int
    labels: tuple = ()


@dataclass(frozen=True)
class CommitPrs:
    """The PRs that contain one commit of the range; prs None: they could not be read."""
    commit: str
    prs: tuple | None


@dataclass(frozen=True)
class Ci:
    """CI of the target: pass (a trusted run, `trusted` is github_trust.Trusted), pending (no run listed yet),
    failed (CI's own verdict, github_trust.RunFailed: `detail` says how), unreadable (anything else: GitHub did
    not answer, no token, a partial listing … — stage A review S2)."""
    kind: str
    detail: str = ''
    trusted: object = None

    def __post_init__(self):
        if self.kind not in CI_KINDS:
            raise ValueError(f'unknown CI kind {self.kind!r}')


@dataclass(frozen=True)
class Inputs:
    mode: str
    now: float
    main: str | None                 # fresh origin/main; None: the fetch failed
    target: str | None               # the SHA to deploy: main for the timer, the checkout's HEAD by hand
    paused: bool
    settled_sha: str | None          # state v2 settled baseline; None: no first install yet
    noop: Noop | None                # tick-state: a payload found equal to a settled release's
    last_failed_sha: str | None      # state v2
    abort: Abort | None = None       # tick-state
    main_seen: Seen | None = None    # tick-state, already updated for this main by the tick
    regression: Regression | None = None  # tick-state, after `observe`
    ack_holds: frozenset = frozenset()
    # Read on demand (see `need`):
    from_in_target: object = UNREAD     # regression.from is an ancestor of target
    settled_in_target: object = UNREAD  # settled is an ancestor of target
    target_in_main: object = UNREAD     # target is an ancestor of (reachable from) main
    installed_stale: object = UNREAD    # None: installed copies current; str: the report
    changed_paths: object = UNREAD      # tuple of paths of diff(settled, target); None: could not list
    commit_prs: object = UNREAD         # tuple of CommitPrs for settled..target; None: could not list
    ci: object = UNREAD                 # Ci

    def __post_init__(self):
        if self.mode not in MODES:
            raise ValueError(f'unknown mode {self.mode!r}')
        object.__setattr__(self, 'ack_holds', frozenset(self.ack_holds))


@dataclass(frozen=True)
class Decision:
    kind: str
    reason: str
    notice_key: str | None = None
    repeat: str = 'daily'
    holds: tuple = field(default=())


@dataclass(frozen=True)
class Hold:
    key: str      # what --ack-holds names: path:<path> or pr:<number>
    reason: str


# Every file of the repo that has an INSTALLED COPY on the host (plan "Рішення" п.4: every installed copy,
# one list). The same tuple is what the tick hands to Helpers.installed_stale, so a file is checked for being
# current exactly when its change holds the range: a new installed file is added here once, never in two
# places. Patterns: `*` matches within one path segment; a trailing `/**` matches everything under a directory.
INSTALLED_COPIES = (
    'deploy/release/**',                    # the controller and its root helpers (stage В installs them)
    'deploy/sudoers.d/**',
    'deploy/*.service', 'deploy/*.timer', 'deploy/*.path',
    'deploy/litestream.*',
    # merge-deploy's installed copies (install-autodeploy.sh), while they are installed
    'deploy/autodeploy.sh', 'deploy/ships.sh', 'deploy/read-env.sh', 'deploy/installed-current.sh',
    'deploy/db-snapshot.sh', 'deploy/trial-migrate.cjs',
    # root runs the installed copy (#469): install-host-patch-collector.sh, install-reboot-request.sh
    'scripts/ops/host_patch_collect.py', 'scripts/ops/reboot_request.py',
)
# Held although nothing is copied: a human runs them (installers), or they change what the host trusts.
HUMAN_STEPS = (
    'deploy/install-*.sh',
    '.github/workflows/ci.yml',             # which run and artifact stand for a SHA
)


def matches(path, pattern):
    """`path` matches `pattern` (see INSTALLED_COPIES): segment by segment, `*` never crosses a `/`."""
    if pattern.endswith('/**'):
        return path.startswith(pattern[:-2])
    parts, want = path.split('/'), pattern.split('/')
    return len(parts) == len(want) and all(fnmatch.fnmatchcase(p, w) for p, w in zip(parts, want))


def path_is_held(path):
    """A control-plane file the payload does not carry and a human must install or run (plan "Рішення" п.4)."""
    return any(matches(path, p) for p in INSTALLED_COPIES + HUMAN_STEPS)


def range_holds(changed_paths, commit_prs):
    """(holds, unreadable): the hold reasons of a range, in order, without repeats; and what could not be read.

    A failure to look is never a pass: the caller treats any `unreadable` entry as blocking.
    """
    holds, keys, unreadable = [], set(), []

    def add(key, reason):
        if key not in keys:
            keys.add(key)
            holds.append(Hold(key, reason))

    if changed_paths is None:
        unreadable.append('could not list the changed paths')
    else:
        for p in changed_paths:
            if path_is_held(p):
                add(f'path:{p}', f'path {p} needs a human step')
    if commit_prs is None:
        unreadable.append('could not list the commits')
    else:
        for c in commit_prs:
            if c.prs is None:
                unreadable.append(f'could not read PR labels for {c.commit[:7]}')
                continue
            for pr in c.prs:
                if HOLD_LABEL in pr.labels:
                    add(f'pr:{pr.number}', f'PR #{pr.number} carries {HOLD_LABEL}')
    return tuple(holds), tuple(unreadable)


def backoff_s(count):
    """How long after the count-th abort in a row the same SHA may be tried again: 1 h doubling, at most 24 h."""
    # (#827 AI review) the exponent is capped before it is computed: a huge persisted count must not
    # build a huge integer on its way to the 24 h cap (2**5 h already exceeds it).
    return min(BACKOFF_BASE_S * 2 ** (min(count, 6) - 1), BACKOFF_MAX_S)


def _short(sha):
    return sha[:7] if sha else str(sha)


def admission(i):
    """The decision for these inputs; see the module docstring."""
    timer = i.mode == 'timer'

    def say(kind, reason, key=None, repeat='daily', holds=()):
        return Decision(kind, reason, key if timer else None, repeat, holds)

    def need(name):
        return Decision('need', name)

    def idle(reason):
        # Adjustment (b) to the plan: with nothing to deploy, the timer still says once a day that the
        # installed deployer is stale (merge-deploy report_stale_once) — a merged fix is not live until then.
        if not timer:
            return Decision('idle', reason)
        if i.installed_stale is UNREAD:
            return need('installed_stale')
        if i.installed_stale is None:
            return Decision('idle', reason)
        return Decision('idle', f'{reason}; the installed deployer is out of date:\n{i.installed_stale}',
                        'installed-stale')

    if i.paused and timer:
        return Decision('idle', 'paused')
    if i.settled_sha is None:
        return say('hold', 'no settled baseline: the first installation is an operator step', 'no-baseline')
    if i.main is None:
        return say('wait', 'could not fetch main', 'fetch-failed')
    if timer and i.target != i.main:
        return Decision('wait', f'main moved to {_short(i.main)}')
    if i.target == i.settled_sha:
        return idle(f'up to date at {_short(i.target)}')
    # (stage A review B1) a noop is a comparison with ONE settled release: after settled moved, the same
    # target may differ from the new one (deploy --force back to it after a later release settled).
    if i.noop is not None and (i.target, i.settled_sha) == (i.noop.sha, i.noop.settled_sha):
        return idle(f'{_short(i.target)} changes nothing in the runtime payload')

    if i.regression is not None:
        r = i.regression
        if timer:
            recovers = False
        elif i.from_in_target is UNREAD:
            return need('from_in_target')
        else:
            recovers = i.from_in_target
        if not recovers:
            return say('hold', f'production regression {_short(r.from_sha)} → {_short(r.to_sha)}: '
                               f'{_short(i.target)} does not contain {_short(r.from_sha)}', 'regression')
    if i.mode != 'force':
        if not timer:
            if i.target_in_main is UNREAD:
                return need('target_in_main')
            if not i.target_in_main:
                return Decision('refuse', f'{_short(i.target)} is not reachable from main {_short(i.main)}')
        if i.settled_in_target is UNREAD:
            return need('settled_in_target')
        if not i.settled_in_target:
            return say('hold', f'settled {_short(i.settled_sha)} is not an ancestor of {_short(i.target)}: '
                               'refusing what could be a downgrade', 'ancestry')

    if i.target == i.last_failed_sha:
        if timer:
            return idle(f'{_short(i.target)} is the last failed SHA; waiting for the next merge')
        return Decision('refuse', f'{_short(i.target)} is the last failed SHA; it needs an explicit rearm')
    if timer and i.abort is not None and i.abort.sha == i.target:
        left = i.abort.at + backoff_s(i.abort.count) - i.now
        if left > 0:
            return Decision('wait', f'{_short(i.target)} aborted {i.abort.count} time(s); next try in {int(left)} s')
    if timer:
        if i.main_seen is None or i.main_seen.sha != i.target:
            return Decision('wait', f'new main head {_short(i.target)}; waiting {QUIET_S} s of quiet')
        if i.now - i.main_seen.at < QUIET_S:
            return Decision('wait', f'main moved {int(i.now - i.main_seen.at)} s ago; waiting')

    if i.installed_stale is UNREAD:
        return need('installed_stale')
    if i.installed_stale is not None:
        return say('hold', f'the installed deployer is out of date:\n{i.installed_stale}', 'installed-stale')

    if i.changed_paths is UNREAD:
        return need('changed_paths')
    if i.commit_prs is UNREAD:
        return need('commit_prs')
    holds, unreadable = range_holds(i.changed_paths, i.commit_prs)
    if unreadable:
        return say('wait', 'cannot tell whether the range is held: ' + '; '.join(unreadable), 'holds-unreadable')
    keys = tuple(h.key for h in holds)
    if holds and (timer or i.ack_holds != frozenset(keys)):
        return say('hold', 'held:\n' + '\n'.join(f'• {h.reason}' for h in holds), 'hold', holds=keys)
    if not timer and i.ack_holds != frozenset(keys):
        # An acknowledgement of something not shown: the operator is looking at another range.
        return Decision('refuse', f'--ack-holds names {", ".join(sorted(i.ack_holds))}, but nothing of it is held')

    if i.ci is UNREAD:
        return need('ci')
    if i.ci.kind == 'unreadable':
        return say('wait', f'cannot read CI for {_short(i.target)}: {i.ci.detail}', 'ci-unreadable')
    if i.ci.kind == 'failed':
        return say('refuse', f'CI failed on {_short(i.target)}: {i.ci.detail}', f'ci-failed:{i.target}', 'once')
    if i.ci.kind == 'pending':
        stuck = (i.main_seen is not None and i.main_seen.sha == i.target
                 and i.now - i.main_seen.at >= CI_STUCK_S)
        return say('wait', f'CI has not concluded on {_short(i.target)}', 'ci-stuck' if stuck else None)
    return Decision('admit', f'{_short(i.target)} admitted')


@dataclass(frozen=True)
class Observation:
    """What `observe` saw: the new lastSeenSettled and regression, and the event to report (or None)."""
    last_seen: str | None
    regression: Regression | None
    event: str | None   # 'went-backwards' | 'diverged' | 'cleared' | None
    previous: str | None = None


def observe(last_seen, regression, settled_sha, is_ancestor):
    """The regression fence (merge-deploy observe_deployment) over the settled SHA.

    A settled release that is not a descendant of the last one seen is a regression: unattended deploys
    are held from then on, with `from` kept from an earlier, still open regression. The fence clears only
    when what is settled contains `from` again — never because someone deployed by hand.
    `is_ancestor(a, b)` is git's merge-base --is-ancestor (reflexive), False for a commit the clone does not
    have (helpers.Helpers.is_ancestor) — so the tick fetches before it observes (stage A review S6), and an
    unknown settled commit reads as diverged: held, the safe direction. It raises only when git cannot answer,
    and the tick then reports it cannot assess and keeps the previous observation (merge-deploy).
    The tick persists `regression` BEFORE it reports went-backwards/diverged and `last_seen` only after the
    report was sent, so a failed send is retried by the next tick.
    """
    if settled_sha is None:
        return Observation(last_seen, regression, None)
    if last_seen is None:
        return Observation(settled_sha, regression, None)
    event = None
    if settled_sha != last_seen and not is_ancestor(last_seen, settled_sha):
        event = 'went-backwards' if is_ancestor(settled_sha, last_seen) else 'diverged'
        regression = Regression(regression.from_sha if regression is not None else last_seen, settled_sha)
    if regression is not None and is_ancestor(regression.from_sha, settled_sha):
        regression = None
        event = event or 'cleared'
    return Observation(settled_sha, regression, event, last_seen)
