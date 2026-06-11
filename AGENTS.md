AGENTS.md

Purpose

This repository uses Codex primarily for:

- bug fixing
- debugging
- implementing small requested features
- writing tests
- making narrowly scoped improvements

Codex is not expected to redesign the system, rewrite major components, or introduce new architectural patterns unless explicitly requested.

---

Project Specification

Before making changes, always read:

- "spec.md"

Documented solutions live under `docs/solutions/` with YAML frontmatter (`module`, `tags`, `problem_type`) and capture past bugs, workflow issues, and implementation patterns. `CONCEPTS.md` defines shared project vocabulary. These are relevant when implementing or debugging in documented areas.

The project specification is maintained in OpenSpec format and is the primary source of truth for expected behavior.

If implementation details and assumptions conflict with "spec.md", follow "spec.md".

Do not introduce behavior that contradicts the specification.

---

Change Scope

Keep changes strictly limited to the user's request.

When fixing a bug:

- identify the root cause
- implement the smallest safe fix
- avoid unrelated refactoring
- avoid opportunistic cleanup
- avoid changing public behavior unless required by the bug

When implementing a feature:

- implement only the requested functionality
- avoid extending scope beyond the request
- avoid adding speculative future abstractions

When changing the browser extension:

- update the extension changelog as part of the same change

---

Architecture

Preserve the existing architecture.

Prefer consistency with the current codebase over introducing:

- new frameworks
- new architectural layers
- new dependency injection systems
- new design patterns
- new abstractions

Do not rewrite working code simply because another approach appears cleaner.

Follow existing conventions already used in the repository.

---

Superpowers Workflow

Follow the project's Superpowers workflow.

Always set up an isolated worktree when developing a change.

When making changes:

1. Understand the request.
2. Read relevant sections of "spec.md".
3. Inspect existing implementation.
4. Make the smallest change that solves the problem.
5. Verify behavior through tests or reasoning.
6. Avoid unrelated modifications.

---

Coding Style

Match the style already present in the affected files.

Prefer:

- existing naming conventions
- existing project structure
- existing error handling patterns
- existing logging patterns
- existing testing approach

Consistency is more important than personal preference.

---

Refactoring Policy

Do not perform large refactors unless explicitly requested.

Examples of changes that should NOT be done automatically:

- moving files between modules
- introducing new architectural layers
- replacing libraries
- rewriting working subsystems
- converting entire files to different patterns
- broad formatting-only changes

If a larger refactor appears beneficial, document it separately instead of including it in the implementation.

---

Dependencies

Do not introduce new dependencies unless they are necessary for the requested task.

Prefer existing project dependencies whenever possible.

---

Testing

When modifying behavior:

- update affected tests if needed
- add focused tests for bug fixes when practical
- avoid rewriting unrelated tests

Tests should verify the requested behavior and remain narrowly scoped.

---

Pull Requests

Changes should be:

- minimal
- reviewable
- easy to reason about
- directly connected to the request

Prefer small, targeted pull requests over broad changes.

If uncertain, choose the more conservative implementation.

For every code change:

- ask whether to create a pull request
- if pull request creation is confirmed, create the PR
- after creating the PR, wait for review comments/checks to complete before reporting final status
- evaluate review comments technically before changing code
- address review findings that are valid and worth addressing
