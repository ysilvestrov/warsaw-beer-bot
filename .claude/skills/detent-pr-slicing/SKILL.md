---
name: detent-pr-slicing
description: Use when writing an implementation plan or deciding how to cut a change into PRs and tasks, and before dispatching each task of a plan. Covers the core plan and the harness plan, splitting a refactor from a behaviour change, and when a task is done inline.
---

# Slicing a change into PRs and tasks

One spec covers the whole change, however many plans and PRs it takes. Write plans in the
`language` from `detent.json` and save them under `<plansDir>/<YYYY-MM>/`.

With Superpowers installed, these rules apply inside `superpowers:writing-plans` (how the plan
is cut) and `superpowers:subagent-driven-development` (which tasks are dispatched); see the
constitution's Superpowers overrides.

## Core first, harness later

A plan larger than about four tasks, or one whose late tasks build on a mechanism that does not
exist yet, is not written in one go:

1. Write the plan for the **core**: the mechanism the rest stands on.
2. Implement it.
3. Run an **end-to-end review** of the core: read it as a whole, not task by task, and record
   the findings. With Superpowers, the final whole-branch review of the core plan is this review.
4. Only then write a separate plan for the **harness**: everything built on the core. It starts
   from the core as it really is and from the review's findings.

## Refactoring goes in its own PR

A refactor that accompanies a behaviour change ships as **two PRs**:

1. Like-for-like: the behaviour stays the same, the tests stay the same and pass without edits.
2. The behaviour change, on top of the merged refactor.

The sign of a violation: a PR in which both the structure and the tests' expectations change.

## Inline or dispatch

Size each task before dispatching it. A task is small when all three hold:

- (a) the plan's text for the task contains the complete code;
- (b) it touches at most two files plus their tests;
- (c) it needs no new decision.

A small task is done inline, with the full gate and its own commit, and it **must** go into the
review package of the next task. Record the base commit before the inline task, so that the next
task's review package starts from it. Every other task is dispatched.

With `superpowers:executing-plans` every task is done inline; the dispatch rule applies only to
`superpowers:subagent-driven-development`.
