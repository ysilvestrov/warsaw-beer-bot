---
name: detent-design-spec
description: Use when writing an architectural design spec for a change, from retelling the task to handing the spec to the owner for approval. Covers the owner section, the estimate game, probes, the claim → evidence table and the spec review.
---

# Writing a design spec

The format is in `spec-format.md` next to this file. Read it before writing.

Write the spec in the `language` from `detent.json`, section names, field names, status values
and premise tags included (`spec-format.md` → "Language"). Save it under
`<specsDir>/<YYYY-MM>/`.

## Order of work

1. **Estimate game, first half.** Retell the task in your own words and ask the owner for their
   size estimate (XS–XL, scale in `spec-format.md`). Do not name yours or hint at it. With
   Superpowers, this question ends your first message.
2. **Probes.** Before writing a premise as fact, check it: reproduce, measure, run the tool.
   Each premise gets a tag: owner requirement, probe (pointing at the probe in the body), or
   inference.
3. **Estimate game, second half.** Once the approach is chosen and before writing, give your
   estimate with a breakdown and the cheaper option, if there is one, with what it loses. A
   divergence of ≥ 2 sizes from the owner's: stop and analyse it with the owner; record the
   outcome under "Estimate".
4. **Write the spec**: header, owner section, body, per `spec-format.md`.
5. **Claim → evidence table.** One row per place the system records something as fact. A row
   whose evidence is a counter, an assumption about external data or "it has always been so"
   is weak: probe it now, or drop the claim.
6. **Builder check** (with Superpowers): run its builder check on the written spec. Settle what
   is already answered or minor yourself; put what only the owner can answer into "Questions for
   the owner". More than three such questions means the spec is not ready: ask the owner before
   the cross-review, in one message.
7. **Commit, then cross-review.** Run `npx -y @ysilvestrov/detent cross-review --spec <file>`
   per the `detent-cross-review` skill. Fix or reject each finding with a reason. Put the printed
   `Spec-review:` line in the header (fill in fixed / rejected) and the decision table in the
   last section. Set the status to "awaiting approval", commit, and hand the spec to the owner.
   If the review failed, say so to the owner in your message.
8. **Amendments** after approval follow `spec-format.md` → "Amendments"; they do not rerun the
   review.
9. **After the last PR of the change is merged**, add "Actual: <size>, <n> PRs, <m> tasks" to
   the estimate.
