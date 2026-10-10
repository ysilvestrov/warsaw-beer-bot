"""The tick's interface to everything outside it except the engine's Host: git, GitHub, the root helper (host).

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, Global Constraints
("Інтерфейси"), Tasks 2-3. The real adapter (sudo `wbb_release.py`, `dbsnap.py` as the bot user, `git`, `gh`)
is stage Б; tests use fake_helpers.FakeHelpers.

Rules every implementation keeps:
- A failure of the helper itself (sudo, network, a missing binary, a timeout) raises — HelperError, or any
  exception; the caller treats it as "could not judge now", never as a verdict on a candidate.
- The `wbb_release.py` calls return a `Run`: the exit code and the verdict word of its first stdout line,
  both as they came. Only the caller decides what they mean (prepare.py: a verdict needs exit 1 AND the
  verdict word together, wbb_release.py "Exit").
"""
from dataclasses import dataclass
from typing import Protocol


class HelperError(Exception):
    """A helper could not do its job (not a verdict on anything)."""


@dataclass(frozen=True)
class Run:
    """One `wbb_release.py` call.

    code — its exit code; kind — the verdict word of its first stdout line (`VERIFIED`, `ACCEPTED`,
    `ALREADY-ACCEPTED`, `CLEAN`/`ADVISORY`/`UNRUNNABLE` of `AUDIT <KIND>`, `OK`/`FAILED`/`TRANSIENT` of
    `PROBE|TRIAL <KIND>`), None when there was no such line; tree — the `tree <hex>` of a `VERIFIED` or
    `AUDIT` line, else None; text — stdout and stderr, for the operator.
    """
    code: int
    kind: str | None
    text: str = ''
    tree: str | None = None


class Helpers(Protocol):
    # git (the controller's private clone) and GitHub
    def fetch_main(self) -> str:
        """Fetch origin and return the full SHA of origin/main."""

    def is_ancestor(self, a: str, b: str) -> bool:
        """git merge-base --is-ancestor a b (reflexive)."""

    def changed_paths(self, a: str, b: str) -> tuple:
        """Paths of diff(a, b), --no-renames (a move is both its paths)."""

    def commits(self, a: str, b: str) -> tuple:
        """rev-list a..b."""

    def pr_labels(self, sha: str) -> tuple:
        """gates.Pr for every PR that contains the commit."""

    def trusted(self, sha: str):
        """github_trust.fetch_trusted for sha: a Trusted, or github_trust.Untrusted."""

    def download(self, sha: str, trusted) -> str:
        """The artifact ZIP of trusted, downloaded into an operator-private file; returns its path."""

    # wbb_release.py (root through sudo, except audit)
    def publish(self, sha: str, zip_path: str) -> Run:
        """wbb_release.py publish --sha sha --archive zip_path."""

    def verify(self, sha: str) -> Run:
        """wbb_release.py verify --sha sha."""

    def audit(self, sha: str) -> Run:
        """wbb_release.py audit --sha sha (as the operator, never root)."""

    def probe(self, sha: str) -> Run:
        """wbb_release.py probe --sha sha."""

    def trial(self, sha: str, pre_name: str) -> Run:
        """wbb_release.py trial --sha sha --snapshot pre_name (a <name>-pre.db, never a path)."""

    def manifest(self, sha: str) -> bytes:
        """The bytes of releases/<sha>/tree-manifest.json."""

    # the database, as the bot user
    def snapshot_pre(self, sha: str):
        """A pre snapshot of the live DB for activating sha (deploy_state.Pre)."""

    def discard_pre(self, pre) -> None:
        """Drop a pre that no activation will use (it must not count as a settled snapshot)."""

    # installed copies
    def installed_stale(self, patterns: tuple) -> str | None:
        """None if the installed copy of every repo file matching `patterns` (gates.INSTALLED_COPIES, the same
        list that holds a range) is the one in main; otherwise the report of what differs or is missing."""
