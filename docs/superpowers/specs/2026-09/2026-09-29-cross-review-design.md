# Cross-review between agents before the PR

Status: design approved in brainstorming 2026-09-29 (approach B, one pass before the PR, PR
marker on). Probes P1–P3 ran 2026-09-29 and all passed. The results are recorded below and changed
the reviewer invocation.

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
- Before launch, the script writes the diff (`git diff <base>...HEAD`) to
  `tmp/cross-review-<branch>-<shortsha>.diff`. Both reviewers read that file, so the
  `claude` reviewer needs no shell at all (see P2).
- Output: the report goes to `tmp/cross-review-<branch>-<shortsha>.md`, and stdout gets a
  summary line plus that path.

## Reviewers

| `--reviewer` | Invocation | Read-only by |
|---|---|---|
| `codex` | `codex exec -s read-only --ephemeral -o <report> <prompt>` | Codex sandbox (`read-only`) |
| `claude` | `claude -p --restricted --strict-mcp-config --tools Read,Grep,Glob --add-dir <tmp> -- <prompt> < /dev/null` | the tool **set** itself: there is no Edit/Write/Bash, and `--restricted` ignores the user/project/local settings files (P2) |

**Snapshot (PR #738 review).** The reviewer does not run in the author's checkout. The runner
creates a detached worktree of the captured SHA under `tmp/cross-review-wt-<sha7>` and makes it
the reviewer's working directory, then removes it afterwards (a leftover from a killed run is
removed before the next one). A review can take up to 15 min, and during that time another terminal may commit, check out, or edit
and revert. A before/after HEAD comparison cannot see an edit that was made and reverted, and its
two `git` samples race each other. A snapshot makes "the review describes exactly `<sha>`" true
by construction instead.

Both get the same prompt, which is built from a template kept in the repo
(`scripts/cross-review/prompt.md`) plus the base, the HEAD SHA, and the branch name. The
reviewer reads the prepared diff file and may open any file in the repo: the branch's spec and plan,
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
| reviewer exceeds 15 min | kill, exit 5, `timeout` |
| reviewer output contains `EAI_AGAIN` / `Can't reach the API server` and the reviewer exited non-zero (a successful report that quotes this text is not a network failure) | exit 5, `no network — Codex sandbox without the allow rule? see AGENTS.md` |
| reviewer exits non-zero | exit 5, `reviewer exited with code N`; the log path is printed |
| reviewer could not be spawned / killed by a signal / output over buffer | exit 5, `reviewer did not run to completion: <code>` |
| any other runtime error (a `git` call, a file write) | exit 5, `PR marker: Cross-review: failed (<first line of the error>)` — no review happened, which is a failure, not a usage error |
| output empty, or the `CROSS-REVIEW-RESULT` line is not the last non-empty line | exit 5, **never** read as "no findings" |
| otherwise | exit 0, report written |

The script sets `CROSS_REVIEW_ACTIVE=1` in the child's environment.

For Codex, the repo's `.codex/rules/default.rules` gets
`prefix_rule(pattern = ["npm", "run", "cross-review"], decision = "allow")`, so that the call
escapes the sandbox without a manual approval, the same way `git push` and `gh pr` already do.
P1 proved this.

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
| Report file `tmp/cross-review-<branch>-<sha>.md` | a review of exactly `<base>...<sha>` happened | tree clean at launch + HEAD SHA captured once, the diff taken as `<base>...<sha>`, and the reviewer run with its cwd in a detached worktree of `<sha>` (so changes in the author's checkout during the run are invisible to it) + reviewer exit 0 |
| "0 findings" | the reviewer looked and found nothing | explicit `CROSS-REVIEW-RESULT: 0` as the **last non-empty line**; absence = error, not zero |
| Reviewer did not modify the tree | review is read-only | codex: sandbox `read-only` (P3: a write fails with `Read-only file system`). claude: no write tools in the set (P2) |
| Codex can call it unattended | no manual approval needed | P1 with a control run (below) |
| PR marker | a cross-review happened at `<sha>` with that tally | self-reported by the author, **verified by nobody**. It is a counting label for later analysis and gates nothing |

## Probes (run 2026-09-29, all passed)

- **P1: the Codex allow rule.** A stub `npm run cross-review` (`claude -p … 'reply PONG'`) was
  run through `codex exec` (`approval: never`, sandbox `workspace-write`):
  - **with** `prefix_rule(["npm","run","cross-review"], allow)` in the worktree's
    `.codex/rules/default.rules`, it printed `PONG` in 3.7 s;
  - **without** the rule (the control run), it exited 1 after 185 s with
    `API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)`.

  The rule is what grants network. Without the rule, the failure is an error message after about
  3 minutes rather than a silent hang, and the script recognizes that text.
- **P2: the `claude` reviewer is read-only.** The first attempt used `--allowedTools` limited to
  Read/Grep/Glob and `git diff/log/show`. It refused the write, but the evidence is **weak**:
  the reviewer chose not to try workarounds, and in `-p` mode the allow rules in
  `.claude/settings.local.json` (`git commit *`, `git push *`, `node *`) still apply. The second
  attempt used `--restricted --strict-mcp-config --tools Read,Grep,Glob`. The reviewer, told to
  try every tool, listed exactly Read/Grep/Glob, still read a diff file under `--add-dir`, and
  left the tree clean. That is the design's invocation.
- **P3: the `codex` reviewer is read-only.** `codex exec -s read-only` read the diff file, ran
  `git diff --stat origin/main...HEAD`, and its write attempt failed with
  `README.md: Read-only file system`. `-o <report>` is written by the CLI outside the sandbox.

## Measuring the effect

The GH review rounds per PR (the number of AI-review runs before merge) for PRs carrying the
marker are compared with the preceding PRs, once about 10 marked PRs exist. This is a
follow-up measurement, not part of this change.

## Scope

- `scripts/cross-review/core.ts`: pure logic (argument parsing, command building, result
  classification).
- `scripts/cross-review/cli.ts`: thin runner.
- `scripts/cross-review/core.test.ts`: Vitest.
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
