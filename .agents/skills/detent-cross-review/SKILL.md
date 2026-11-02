---
name: detent-cross-review
description: Use when a design spec is committed and about to go to the owner, or when the gate is green, the branch is rebased and a PR is about to be opened. Runs `npx -y @ysilvestrov/detent cross-review` by a model of another family and covers the author flag, the background run, the marker, triage of findings and reviewer failures.
---

# Cross-review: the reviewer is not the author

A model of another family reviews the work before the owner sees it. The CLI picks the reviewer
and checks that its model family differs from yours; you tell it who you are.

## Who you are

<!-- detent:author begin -->
You are Codex or Antigravity: pass --author codex in Codex and --author agy in Antigravity on a Gemini model; if Antigravity runs you on a Claude model, pass --author claude, because the rule is about the model family that wrote the work.
<!-- detent:author end -->

## When

- **A spec**: it is committed and is about to go to the owner for approval.
- **A PR**: the gate is green, the branch is rebased on `baseBranch` from `detent.json`, the
  working tree is clean, and the PR is about to be opened.

Once per PR or spec. Not after fixes in an open PR, not after amendments to an approved spec.

A PR that changes only documentation is not reviewed: put `Cross-review: skipped (docs-only)` in
its description.

## Run

```
npx -y @ysilvestrov/detent cross-review --author <id>                # the branch against baseBranch
npx -y @ysilvestrov/detent cross-review --author <id> --spec <file>  # a committed spec
```

- Run it **in the background** and wait for it to finish. A review takes up to 15 minutes, and
  agents cut foreground commands off earlier (Claude Code at 10 minutes).
- Pass only `--author`. Never pass `--reviewer`: with it there is no fallback, and without it the
  CLI itself moves on to the next reviewer of another family when one fails.
- Progress, errors and the path of the reviewer's report (`Report: <path>`, inside `tmpDir`) go to
  stderr. The marker is the single stdout line: take the text after `PR marker: ` or
  `Spec marker: `.

## Triage

Read the report. Handle each finding as a review comment: fix it, or reject it with a reason.
Never apply a finding blindly.

Then fill in `<f> fixed, <r> rejected` in the marker and record the decisions in a table, written
in the `language` from `detent.json`:

- **PR**: the marker (`Cross-review: …`) and the decision table go into the PR description.
- **Spec**: the marker (`Spec-review: …`) goes into the spec's header, the decision table into its
  spec review section (format in the `detent-design-spec` skill, `spec-format.md`).

The report is not committed, so the table is the only trace of the review.

## Exit codes

- **0**: reviewed. Triage as above.
- **5**: every eligible reviewer failed, or one timed out (a timeout stops the chain). The marker
  `failed (…)` is still printed: put it in the PR description or the spec header as is. It does
  not block the PR or the spec; the ordinary review stays the gate. **Tell the human explicitly in
  your message** that the cross-review failed and why, not only in the marker: in a project
  without review on GitHub there will be no other pair of eyes.
- **2**: a usage or configuration error (dirty tree, empty diff, a spec not in `HEAD` or outside
  `specsDir`, no eligible reviewer in `reviewers`, unreadable `detent.json`, wrong flags). No
  review was attempted and no marker is printed. Fix the cause and run again; this is not a
  reviewer failure.
- **3**: a nested run: you are inside a review yourself (`CROSS_REVIEW_ACTIVE=1`). Do not run the
  review from there; this is not a reviewer failure either.
