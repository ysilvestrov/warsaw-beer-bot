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

Design documents and implementation plans live under `docs/superpowers/specs/<YYYY-MM>/` and `docs/superpowers/plans/<YYYY-MM>/`, organized into monthly subfolders (e.g. `specs/2026-07/2026-07-12-<topic>-design.md`). Place new documents in the current month's subfolder; the newest document is the latest file in the newest month folder. The top level of `specs/`/`plans/` holds only month folders.

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

- update the extension changelog as part of the same change, following the
  Extension Changelog rules below
- update `docs/extension-install-uk.md` in the same change if a user would see
  the difference (a new supported shop, an option, a popup button, new badge
  behaviour, a change to the install or update flow)

---

Extension Changelog

`extension/CHANGELOG.md` is user-facing copy, not engineering notes. It is
rendered to the public changelog page, and it is the entire content of the
release announcement the bot sends to extension users when a new version reaches
the Chrome Web Store (#379). Someone who does not read code reads every line you
put there.

Write each entry for the person using the extension:

- Lead with the symptom they would have noticed — a badge that did not appear, a
  button that did nothing, a beer filed under the wrong brewery — then say what
  it does now.
- Name things as the interface names them ("Sync my check-ins", the white-circle
  badge, the options page), not as the code names them. Selectors, adapters,
  observers, service workers, parse stages and cache entries are our vocabulary,
  not theirs.
- If a change has no effect a user could notice — test infrastructure, a
  dependency bump, a refactor — it does not belong in the changelog at all.
  Delete the line; do not reword it. The git history already records it.
- One entry per user-visible change, under `## [Unreleased]`, newest section on
  top.

A single entry must not pair a real fix with an invisible one. This line shipped
in 0.16.0 and is the example to avoid:

> Made Piwne Mosty card discovery independent of selector scoping when its
> catalog grid is replaced, and upgraded the extension test environment to jsdom
> 30 with state-based re-badge assertions.

It went out in a release announcement. The first half describes a real fix in
code vocabulary; the second half describes nothing a user can perceive. Rewritten
and trimmed to one sentence:

> Fixed badges not appearing on Piwne Mosty listings after the shop redraws its
> catalog — for example when you filter it or move between pages.

The same rules are in the header comment of `extension/CHANGELOG.md` and in
`CLAUDE.md`. They are repeated because a changelog line is written by one change
and reread only at the release cut, which is how the line above survived review.

---

Releasing the Extension

Publishing to the Chrome Web Store is a maintainer action; do not run it unless
asked. If you do, the ordering in `docs/extension-release.md` is load-bearing:
**merge the release PR into `main` before running `npm run release:store`.**
Google can publish a submitted version in under an hour, and once it is live the
next announcement tick sends users a link to the changelog page — which is built
from `main`. Submitting before the merge sends a link to a page that does not yet
list the version being announced. (The store package is byte-identical either
way; the announcement is not.)

---

Orphan-Triage Issues

Issues labelled `orphan-triage` are not ordinary tickets: each one owns a set of rows in the
production database. `enrich_failures.issue_number` links every triaged orphan to the issue whose fix
would rescue it, and closing that issue is read by the bot as "the fix shipped" — it re-arms those
rows for one free retry (design: `docs/superpowers/specs/2026-08/2026-08-15-421-fix-keyed-lock-design.md`).

So when you split an `orphan-triage` issue into sub-issues, or supersede it with a narrower one,
remap its rows in the same change:

```
sudo -u warsaw-beer-bot bash -lc "sqlite3 /var/lib/warsaw-beer-bot/bot.db \
  \"UPDATE enrich_failures SET issue_number = <sub> WHERE beer_id IN (<ids>)\""
```

Move only the rows the sub-issue actually covers, one row at a time in judgement — never a blanket
`WHERE issue_number = <parent>` sweep onto a single child. A row whose sub-issue you cannot name
stays on the parent and takes its retry; a wrong link is worse than no link, because it will unlock
against an unrelated issue's close.

Leave `review_class` alone while remapping. The class says what kind of defect this is; the issue
number says who fixes it. Changing both at once is how a verdict loses its evidence.

---

Adjudicating an issue's rows

Before closing a `parser_bug` or `matcher_bug` issue, every row that names it must leave the
fix in a known state. The replay you already have to run is the evidence; record it instead
of letting it die with the session.

Run it in two steps. `npm run adjudicate -- --issue <n>` does the live probing: it checks a
canary search before and after the run, touches nothing in the database, and prints a
verdict file. Then `npm run adjudicate -- --apply <file>` does the writing: it never touches
the network, re-checks each verdict against the row's current state, and writes markers in
a single transaction.

If the canary fails on either side of the probe, the whole run is discarded rather than kept
in part — the tool refuses to write anything for that run, so a partial set of markers can
never exist.

Each row ends in exactly one of four verdicts:

- the probe found the beer (`rescued`) — leave the row alone, the enrich cron will link it;
- the probe found nothing (`unrescued`) — the row is marked `unrescued_at`, so closing the issue
  no longer hands it a free backoff reset for lookups that cannot succeed;
- the probe was transient or blocked (`inconclusive`) — write nothing. A network failure is not
  a verdict;
- the row already carried the marker before this probe (`already_marked`) — not probed again,
  since only an explicit re-arm can change its fate.

`--apply` re-checks each `unrescued` verdict against the row's *current* state before writing,
and skips (rather than writing) a row that moved since the probe. Two of those skips need a
human decision, not a shrug: `input_changed` (the row's brewery/name were edited) means re-probe
it — the verdict is about a beer that no longer exists in the database under that name;
`issue_moved` (it was re-triaged onto another issue) means leave it alone — it belongs to its
new issue's adjudication now, not this one's.

Do this per row. Never bulk-update by `WHERE issue_number = …`: a row whose fate you cannot
name individually keeps its current state.

The marker is not a seal. The row stays in its pool with its existing backoff, and any
explicit re-arm clears the marker — it asserts only "as of today, a free retry buys nothing".

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

Classifying a Fix: the Light Path

Not every bug is architectural. A fix may skip the spec and plan documents when
all four of these hold:

- it **restores** behaviour `spec.md` already describes, and needs no new
  sentence in `spec.md`;
- the mechanism of the defect was **proven by a live probe or replay before**
  the classification — never classify at intake, because an issue's text
  describes the symptom while the path is decided by the cause;
- the change stays within two files plus their tests and introduces no new
  concept;
- it does not change a rule that acts on all data.

The last condition separates things that look identical from the outside.
Adding a pair to the curated `ALIAS_PAIRS` list is the light path: the list is
finite and each entry is proven against the orphan's `candidates_summary`.
Adding a word to `BREWERY_NOISE`, or changing the normalizer that feeds that
list, is the full cycle: it changes matching for **every** brewery. The #318
spec did both under one heading.

The record the light path leaves in place of a spec is the issue plus a commit
message that **names the mechanism** — not "fix typo". For orphan issues the
`adjudicate` verdict file is part of that record too.

Nothing about the gate is lighter: the full test gate and the AI PR review are
identical on both paths.

Operational work — re-arming rows, an `UPDATE` against the production database,
running an existing script — is outside this rule entirely, because it commits
no code.

---

The Ratchet Turns One Way

The moment any of the four conditions fails — a third file is needed, a new
concept appears, a sentence wants to go into `spec.md` — the work **stops
completely**.

Everything already obtained (the diagnosis, the probe output, a draft fix,
measurements) is written down as input, and the change restarts on the
architectural path **from the beginning**: brainstorming, spec, plan, worktree.
Not "we will add a spec for what is already built": a spec written after the
fact, around a finished fix, proves exactly one thing — that the fix exists.

Never reclassify downward.

Why the trigger sits after the probe rather than at intake: #587 arrived as
"the refresh gets stuck on the last step" and looked like a trivial client bug.
The diagnosis showed a scalar cursor asserting coverage nobody had established,
and the fix added a new promise to `spec.md`. With this ratchet, a
misclassification costs half an hour of probing rather than a branch built
without a spec.

---

Claims and Their Evidence

A design document must carry a table of every place the system **records
something as fact** — a state row, a cursor, a coverage range, a verdict, a
cache others later read as truth — with what it claims beside what proves it.

A row whose evidence is a count, an assumption about an external file, or "it
has always been so" is a weak row. Probe it live before writing the plan, or
do not record the claim at all.

Measured on #587: two such rows — a migration seed justified by count equality,
and an import coverage range justified by assuming an export is complete — went
through spec, plan, implementation, tests, documentation and a dry run against a
copy of the production database, then were deleted outright at PR review. That
is 285 lines written and self-deleted, a quarter of the branch. A third premise
in the same change — whether the bottom of the feed can be told apart from a
dead session — was checked with one thirty-second browser probe and removed an
entire concept from the design before a line of code existed. The difference was
not difficulty; it was that two of them looked like internal logic rather than a
claim about data.

---

Staging a Large Change

A change whose plan runs past roughly four tasks, or whose later tasks build on
a mechanism that does not exist yet, is not planned in one piece.

The spec stays whole. The plan splits: first the **core** — the mechanism the
change exists for — then its whole-branch review, and only after that review a
separate plan for the periphery (clients, migrations, adjacent paths, docs).

Why, from #587: a seven-task plan written against code that did not exist yet
contained three defects of its own — a mutation step naming a test that could
not catch it, an accumulation scope that broke when the logic moved into a
module, and a test assuming a file the repo does not have. Each cost a round
trip. Worse, the premise task 4 rested on died at the very end, after task 4 had
already been built on it.

---

Sizing a Task Before Dispatching

**This overrides the subagent-driven-development skill's rule that the
controller never implements.**

Before dispatching a task, size it. A task is small when all three hold:

- its text already contains the complete code to write,
- it touches at most two files plus their tests,
- it requires no new decision.

Then the controller implements it directly: change, **full gate**, commit. If
any of the three fails, dispatch as usual.

Fresh eyes are not lost: work done inline MUST be included in the next task's
review package and named in the whole-branch review dispatch.

Measured on #587: a five-line popup change got its own implementer (76k tokens)
and its own reviewer (57k), and so did a twenty-line one — about four wasted
dispatches out of twenty-five, each with its own full gate.

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
- **before creating the PR, fetch `main` and rebase onto it if it has moved** — `git fetch origin main`, then `git rebase origin/main`. Otherwise the rebase has to happen at merge time, and every check (CI, both builds, the AI review) runs a second time while the merge waits on them. A worktree branches from `origin/main`, so the branch starts current; the drift accumulates while the work is under way, which is why this belongs immediately before the PR rather than at the start.
- after a rebase, **re-run the full gate** (`npm test && npm run typecheck`) before pushing — a rebase breaks a branch even when both sides were green on their own — then `git push --force-with-lease`
- if `git fetch` fails with `GitHub is temporarily limiting some unauthenticated downloads`, that is #583, not the network: the repo is public, so GitHub never returns a 401 and git therefore never offers credentials. The working form is `git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$(gh auth token)" | base64 -w0)" fetch origin main`. `git push` is unaffected — a push always authenticates.
- if pull request creation is confirmed, create the PR
- after creating the PR, wait for review comments/checks to complete before reporting final status
- evaluate review comments technically before changing code
- address review findings that are valid and worth addressing

When automating GitHub PR operations:

- avoid GitHub GraphQL for PR edits or metadata updates; prefer `gh pr` commands, and if those fail due GitHub GraphQL/deprecation issues, use REST via `gh api repos/<owner>/<repo>/pulls/<number>` instead
