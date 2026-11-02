---
name: detent-dev-cycle
description: Only when invoked explicitly.
---

# The development cycle without Superpowers

This skill runs only when invoked explicitly: by name (`/detent-dev-cycle`), or through the
constitution line "Without Superpowers, start any behaviour change with `detent-dev-cycle`",
which `npx -y @ysilvestrov/detent install` adds only to projects where it found no Superpowers.

Write every artifact (spec, plan, messages to the owner) in the `language` from `detent.json`.

## Sequence

1. **Check for Superpowers, then retell the task.** If `superpowers:brainstorming` is among your
   available skills, say that Superpowers is installed and hand over to
   `superpowers:brainstorming`; stop following this skill. The detent skills then switch on by
   themselves at their own points (spec, plan, before the PR). Otherwise retell the task in your
   own words and ask the owner for their size estimate: the estimate game from
   `detent-design-spec`, without naming yours.
2. **Probe.** Reproduce the problem, measure, check the premises against the real system before
   relying on them.
3. **Classify** per the constitution, after the probe and never before it: `spike` (commits
   nothing), the light path (all four conditions hold), or the full cycle.
4. **Full cycle:**
   spec (`detent-design-spec`) → `cross-review --spec` (`detent-cross-review`) → the owner's
   approval → plan (`detent-pr-slicing`) → implementation task by task, each with the gate →
   end-to-end review of the core → plan for the harness → rebase, gate → `cross-review`
   (`detent-cross-review`) → PR.
5. **Light path:** fix → gate → `cross-review` (`detent-cross-review`) → PR. The ratchet holds at
   every step: the moment a light-path condition fails, stop, record what you have as input, and
   start over through the full cycle.
