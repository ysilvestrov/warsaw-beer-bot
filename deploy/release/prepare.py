"""From a trusted CI run to a candidate the engine may activate, or the reason it may not (host).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (host audit before the
first execution of candidate code; "nothing ships" by the runtime-artifact contract), §6 (pre snapshot and
trial on a copy), §10a (lastFailedSha).
Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, Task 2, "Рішення"
п.1 (noop by manifests) and п.3 (what is a verdict).

    download -> publish -> verify (candidate and settled) -> noop? -> audit -> probe -> snapshot pre -> trial

The audit runs before probe and trial, the first steps that execute candidate code. A `Verdict` — the only
result the tick may record as lastFailedSha — comes from exit 1 together with its verdict word: `AUDIT
ADVISORY`, `PROBE FAILED`, `TRIAL FAILED`. Every other answer (2 refused, 70 internal, 75 transient, an
UNRUNNABLE/TRANSIENT line, a code and a word that disagree, an exception of a helper) is `Transient`: the
next tick tries again. A pre snapshot that no activation will use (the trial did not pass) is discarded.

Noop: both trees verified in this call, both manifests are the bytes their verified tree digests name, and
their entries are equal except `release.json` (sourceSha, runId, runAttempt live only there). Equality proves
the runtime identical; a build that is not deterministic only loses the noop, never skips a real change.
"""
import hashlib
import os
import sys
from dataclasses import dataclass, replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_manifest as tm  # noqa: E402
from deploy_state import Pre, Release  # noqa: E402
from package_runtime import RELEASE_JSON  # noqa: E402

PUBLISHED = ('ACCEPTED', 'ALREADY-ACCEPTED')


@dataclass(frozen=True)
class Prepared:
    """Ready for activate.begin: the candidate as verified, and its pre snapshot."""
    candidate: Release
    pre: Pre


@dataclass(frozen=True)
class Noop:
    """The candidate's runtime payload is the settled one's; nothing to activate."""
    sha: str
    tree_sha256: str


@dataclass(frozen=True)
class Verdict:
    """The candidate is bad: step is audit, probe or trial; kind is ADVISORY or FAILED."""
    step: str
    kind: str
    text: str
    note: str = ''


@dataclass(frozen=True)
class Transient:
    """Could not judge now; never a verdict. note: what went wrong discarding the pre, if anything."""
    step: str
    reason: str
    note: str = ''


class _Stop(Exception):
    def __init__(self, result):
        super().__init__(result)
        self.result = result


def _short(sha):
    return sha[:7]


def _call(step, fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # a helper's failure is never a verdict
        raise _Stop(Transient(step, f'{type(e).__name__}: {e}')) from None


def _unjudged(step, run):
    why = f'exit {run.code}, {run.kind or "no verdict line"}'
    return Transient(step, f'{why}: {run.text}' if run.text else why)


def _expect(step, run, kinds):
    """run passed (exit 0 with one of kinds) or the step is Transient."""
    if run.code != 0 or run.kind not in kinds:
        raise _Stop(_unjudged(step, run))
    return run


def _judge(step, run, ok, bad):
    """None if run passed; a Verdict for exit 1 with the bad word; Transient for anything else."""
    if run.code == 0 and run.kind == ok:
        return None
    if run.code == 1 and run.kind == bad:
        return Verdict(step, bad, run.text)
    return _unjudged(step, run)


def _runtime_entries(sha, tree, data):
    """The manifest's entries without release.json, after proving the bytes are the verified tree."""
    if hashlib.sha256(data).hexdigest() != tree:
        raise _Stop(Transient('manifest', f'the manifest of {_short(sha)} is not its verified tree {tree}'))
    try:
        manifest = tm.parse_manifest(data)
    except tm.ManifestError as e:
        raise _Stop(Transient('manifest', f'the manifest of {_short(sha)}: {e}')) from None
    return [e for e in manifest['entries'] if e['path'] != RELEASE_JSON]


def _verified_tree(h, sha):
    run = _expect('verify', _call('verify', h.verify, sha), ('VERIFIED',))
    if run.tree is None:
        raise _Stop(Transient('verify', f'{_short(sha)} verified without a tree digest'))
    return run.tree


def _trial(h, sha, pre):
    """The trial's result; a pre no activation will use is discarded (a failed discard is the note)."""
    try:
        result = _judge('trial', h.trial(sha, os.path.basename(pre.path)), 'OK', 'FAILED')
    except Exception as e:
        result = Transient('trial', f'{type(e).__name__}: {e}')
    if result is None:
        return None
    try:
        h.discard_pre(pre)
        note = ''
    except Exception as e:
        note = f'could not discard {pre.path}: {type(e).__name__}: {e}'
    return replace(result, note=note)


def prepare(h, sha, trusted, settled):
    """Take sha (its trusted CI identity `trusted`) to Prepared, Noop, Verdict or Transient.

    settled is the state v2 Settled baseline whose payload a noop is compared with.
    """
    try:
        zip_path = _call('download', h.download, sha, trusted)
        _expect('publish', _call('publish', h.publish, sha, zip_path), PUBLISHED)
        tree = _verified_tree(h, sha)
        base_tree = _verified_tree(h, settled.sha)
        if base_tree != settled.tree_sha256:
            return Transient('verify', f'settled {_short(settled.sha)} verifies as tree {base_tree}, '
                                       f'recorded {settled.tree_sha256}')
        ours = _runtime_entries(sha, tree, _call('manifest', h.manifest, sha))
        base = _runtime_entries(settled.sha, base_tree, _call('manifest', h.manifest, settled.sha))
        if ours == base:
            return Noop(sha, tree)

        audit = _call('audit', h.audit, sha)
        if audit.kind in ('CLEAN', 'ADVISORY') and audit.tree != tree:
            return Transient('audit', f'the tree changed between steps: verified {tree}, audited {audit.tree}')
        result = _judge('audit', audit, 'CLEAN', 'ADVISORY')
        if result is not None:
            return result
        result = _judge('probe', _call('probe', h.probe, sha), 'OK', 'FAILED')
        if result is not None:
            return result

        pre = _call('snapshot', h.snapshot_pre, sha)
        result = _trial(h, sha, pre)
        if result is not None:
            return result
        return Prepared(Release(sha, tree), pre)
    except _Stop as stop:
        return stop.result
