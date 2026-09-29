# Cross-review between agents before the PR

Status: design approved in brainstorming 2026-09-29 (approach B, one pass before the PR, PR
marker on). Probes P1–P3 below must pass before the plan is written.

## Why

Every push to a PR runs the GitHub AI reviewer, and it bills by the token (`find` + `verify`,
see `docs/ai-review-model-evaluation.md`). A branch that needs three or four
"push → comment → fix" rounds pays for three or four reviews. Both local agents, Claude Code
and Codex, run on flat subscriptions, so a review done locally before the PR costs only
wall-clock time and quota.

Goal: **fewer GH review rounds per PR**. A higher-quality first push with the same number
of rounds is also an acceptable outcome. Out of scope: any change to the GH reviewer itself
(its model, prompt, triggers, or skipping it for cross-reviewed PRs).

## Measured premises (brainstorming probe, 2026-09-29)

- **The caller cannot be detected from the environment.** A `codex exec` launched from Claude Code
  inherited every `CLAUDE*` variable (`CLAUDECODE` included) and added its own `CODEX_*`
  (`CODEX_THREAD_ID`, `CODEX_SANDBOX_NETWORK_DISABLED`, …). The reverse nesting mixes the same
  two sets. So the reviewer is passed **explicitly**, not guessed.
- **`claude -p` does not work inside the Codex sandbox by default.** Codex ran the command,
  and `claude -p 'reply PONG'` printed nothing until a 60 s timeout, because
  `CODEX_SANDBOX_NETWORK_DISABLED` was set. The user confirms Codex can run it once they
  approve the escalation by hand. So a hang is a real failure mode, and it needs a hard timeout
  and a named error.

## Interface

```
npm run cross-review -- --reviewer codex|claude [--base origin/main] [--model <id>]
```

- `--reviewer` is required, and nothing defaults it. `CLAUDE.md` tells Claude to pass
  `codex`, and `AGENTS.md` tells Codex to pass `claude`.
- `--base` defaults to `origin/main`. The review covers `<base>...HEAD`, meaning the
  committed branch.
- `--model` is passed through to the reviewer CLI. If it is omitted, the CLI's own default is
  used, and the code carries no curated model list.
- The script **refuses a dirty working tree**, because the marker names a SHA and an
  uncommitted change would be reviewed without being part of that SHA. It also refuses an
  empty diff against the base.
- Output: the report goes to `tmp/cross-review-<branch>-<shortsha>.md`, and stdout gets a
  summary line plus that path.

## Reviewers

| `--reviewer` | Invocation | Read-only by |
|---|---|---|
| `codex` | `codex exec -s read-only --ephemeral -o <report> <prompt>` | Codex sandbox (`read-only`) |
| `claude` | `claude -p <prompt>` with `--allowedTools` limited to Read/Grep/Glob and read-only `git` (`diff`, `log`, `show`) | the tool allowlist (probe P2) |

Both get the same prompt, which is built from a template kept in the repo
(`scripts/cross-review/prompt.md`) plus the base, the HEAD SHA, and the branch name. The
reviewer runs `git diff` itself and may open any file in the repo: the branch's spec and plan,
`spec.md`, and neighbouring code.

The prompt asks for:
- correctness defects, each with `file:line` and a concrete failure scenario
  (inputs/state → wrong output/crash);
- divergence from the branch's spec/plan and from `spec.md`;
- violations of the project's test-quality rules (a)–(ґ);
- claim→evidence gaps: a place that records something as fact that the code does not prove;
- **no** style nits.

It must end with exactly one line `CROSS-REVIEW-RESULT: <n> finding(s)`.

## Guards and errors

| Condition | Result |
|---|---|
| `CROSS_REVIEW_ACTIVE=1` already in env (a reviewer calling a reviewer) | exit 3, no launch |
| dirty tree / empty diff / unknown `--reviewer` | exit 2, usage message |
| reviewer exceeds 15 min | kill, exit 5, `timeout (sandbox without network? see AGENTS.md)` |
| reviewer exits non-zero | exit 5, stderr tail |
| output empty or missing the `CROSS-REVIEW-RESULT` line | exit 5, **never** read as "no findings" |
| otherwise | exit 0, report written |

The script sets `CROSS_REVIEW_ACTIVE=1` in the child's environment.

For Codex, the repo's `.codex/rules/default.rules` gets
`prefix_rule(pattern = ["npm", "run", "cross-review"], decision = "allow")`, so that the call
escapes the sandbox without a manual approval, the same way `git push` and `gh pr` already do
(probe P1).

## Workflow rule (both agent files)

When the solution is ready and **the PR is about to open**, the order is:

1. Run the full gate (`npm test && npm run typecheck`).
2. `git fetch` + `rebase` (existing rule), then run the gate again if the rebase moved anything.
3. `npm run cross-review -- --reviewer <other agent>`.
4. Verify **each** finding like a GH review comment. Fix it, or reject it with a reason. Never
   apply findings blindly. Fixes are committed, and the gate is re-run.
5. Push and open the PR (by default, see the PR-by-default rule). The PR body carries the
   marker:
   `Cross-review: <reviewer> @ <reviewed sha> — <n> findings: <f> fixed, <r> rejected`.

Cross-review runs once per PR, not once per commit and not after the fixes. Later pushes of
review fixes into an open PR do not re-run it. The requirement covers PRs that change code
(`src/`, `scripts/`, `extension/`, `tests/`). A docs-only PR skips it and says so in the
marker line (`Cross-review: skipped (docs-only)`).

A reviewer failure (exit 5) does not block the PR. The marker records
`Cross-review: failed (<reason>)`, and the work continues, because the GH review remains the
gate.

## Claims and evidence

| Recorded fact | What it claims | Evidence |
|---|---|---|
| Report file `tmp/cross-review-<branch>-<sha>.md` | a review of exactly `<base>...<sha>` happened | tree clean at launch + HEAD SHA captured before launch + reviewer exit 0 |
| "0 findings" | the reviewer looked and found nothing | explicit `CROSS-REVIEW-RESULT: 0` line; absence = error, not zero |
| Reviewer did not modify the tree | review is read-only | codex: sandbox `read-only` (enforced). claude: tool allowlist — **probe P2** |
| Codex can call it unattended | no manual approval needed | **probe P1**; until it passes, AGENTS.md says an approval prompt is expected |
| PR marker | a cross-review happened at `<sha>` with that tally | self-reported by the author, **verified by nobody**. It is a counting label for later analysis and gates nothing |

## Probes before the plan

- **P1:** from Codex, after the `prefix_rule` is added, `npm run cross-review -- --reviewer claude`
  on a small branch reaches Claude (the report is written) with no approval prompt.
- **P2:** `claude -p` with the planned `--allowedTools`, told to edit a file, cannot edit it
  (the tree stays clean) and can still run `git diff`.
- **P3:** `codex exec -s read-only` can run `git diff origin/main...HEAD` and read files in
  the repo.

If P1 fails, the design keeps the manual approval and documents it. P2 failing means `claude`
needs a stronger read-only mechanism before the plan.

## Measuring the effect

The GH review rounds per PR (the number of AI-review runs before merge) for PRs carrying the
marker are compared with the preceding PRs, once about 10 marked PRs exist. This is a
follow-up measurement, not part of this change.

## Scope

- `scripts/cross-review.ts`: pure logic (argument parsing, command building, result
  classification) plus a thin runner.
- `scripts/cross-review.test.ts`: Vitest.
- `scripts/cross-review/prompt.md`.
- `package.json`: the script entry.
- `.codex/rules/default.rules`: the allow rule.
- `CLAUDE.md` + `AGENTS.md`: the workflow rule.

No `spec.md` change, because `spec.md` describes the bot, not the development tooling. No
change to the GH reviewer.

Tests cover argument parsing (missing/unknown reviewer, default base, model pass-through), the
command built for each reviewer, the recursion guard, the dirty-tree and empty-diff refusals,
and result classification (missing result line, empty output, non-zero exit, timeout, the
`0 findings` line). Live CLI calls are covered by the probes, not by tests.
