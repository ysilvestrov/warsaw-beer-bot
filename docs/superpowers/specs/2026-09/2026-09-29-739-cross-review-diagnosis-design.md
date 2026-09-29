# #739 — cross-review failure diagnosis

Status: design approved in chat 2026-09-29 (truncate reasons to 200 chars). This amends
`2026-09-29-cross-review-design.md` (PR #738), and that spec's "Guards and errors" table is
updated in the same PR.

## Problems (from #739)

1. **A bad `--base` is recorded as a reviewer failure.** `git diff origin/mian...<sha>` throws,
   and the top-level catch maps every thrown error to exit 5 plus the marker
   `Cross-review: failed (…)`. The rule says exit 5 does not block the PR, so an agent opens it
   with a `failed` marker although no reviewer ever started. The same user mistake with
   `--reviewer gemini` exits 2.
2. **"No network" is inferred from text anywhere in the transcript.** A non-zero exit plus
   `EAI_AGAIN` / `Can't reach the API server` anywhere in stdout, stderr or the report yields
   `no network — Codex sandbox without the allow rule?`.
3. **Decision logic is left in the runner without tests.** This covers the marker text of a
   thrown error (`reason.split('\n')[0]`) and where the report comes from for each reviewer.

## Measured (probe, 2026-09-29)

Each reviewer CLI was run for real, with its network cut by `unshare -rn` or while the Codex
subscription was over its limit. stdout and stderr were captured separately.

| Reviewer, failure | exit | Where the error is | Last non-empty line of that stream |
|---|---|---|---|
| claude, no network | 1 | **stdout**; stderr is empty | `API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)` |
| codex, usage limit | 1 | stderr; stdout is empty and no `-o` report is written | `ERROR: You've hit your usage limit. Upgrade to Pro (https://…) … or try again at 11:20 AM.` |
| codex, no network | 1 | stderr | `ERROR: workspace routing discovery failed`; **no `EAI_AGAIN` anywhere** |

Also measured: codex's stderr carries its whole transcript, including the echoed prompt and the
output of commands it runs (seen in the P1/P3 logs of #738).

What follows:
- The current text search is wrong both ways. It misreads a diff that quotes `EAI_AGAIN` as a
  network failure, and it **never** recognises a codex network failure, because that failure has
  different text.
- The issue's suggested fix, "match only the tail of stderr", would break the claude case,
  because claude reports on stdout.

## Design

### 1. Errors before the reviewer starts are usage errors
Every `git` call in the preparation phase is a usage error: `rev-parse --show-toplevel`,
`rev-parse HEAD`, `rev-parse --abbrev-ref HEAD`, `diff <base>...<sha>` and `status --porcelain`.
Each one exits 2 with `cross-review: <first line of git's message>` and prints **no PR marker**,
because no review was attempted. That puts a mistyped `--base` in the same class as an unknown
`--reviewer`.

Exit 5 with a `failed` marker stays for anything that goes wrong **after** the run directory is
created: writing the diff, `worktree add`, the spawn, reading the report.

### 2. The reason comes from the reviewer's own error line
A per-reviewer rule names the stream and the prefix that the CLI uses for its own fatal error:

| Reviewer | Stream | Error line is the last non-empty line, if it starts with |
|---|---|---|
| claude | stdout | `API Error:` |
| codex | stderr | `ERROR:` |

`reviewerErrorLine(reviewer, stdout, stderr)` returns that line, or `null`.

Only the **last** non-empty line counts. A quoted diff or a command output in the middle of the
transcript cannot be the last line of a CLI that then exits with its own error.

On a non-zero exit, in this order:
- The error line is claude's and contains `EAI_AGAIN` or `Can't reach the API server`
  → `no network — Codex sandbox without the allow rule? see AGENTS.md (<line>)`.
  The hint applies to claude only, because only the codex→claude direction runs inside a
  sandbox.
- There is an error line → `<reviewer>: <line without its prefix>`, for example
  `codex: You've hit your usage limit. …`.
- There is no error line → `reviewer exited with code N`, as today.

The `NO_NETWORK` search over the whole transcript is deleted.

### 3. Decisions move into core
- `markerReason(text)`: the first non-empty line of `text`, whitespace-trimmed, cut to **200**
  characters with a trailing `…` when it was cut. Every `failed (…)` marker goes through it: the
  verdict reason and a thrown error after the run started.
- `reportText(reviewer, stdout, reportFile)`: returns stdout for claude and the `-o` file content
  for codex. A missing file is read as `''`, and the runner passes `null` for it.
- `classifyResult` takes `stdout` and `stderr` separately instead of the merged `log`. The
  reviewer log file still holds both.

## Claims → evidence

| Recorded fact | What it claims | Evidence |
|---|---|---|
| `failed (no network …)` | the claude reviewer could not reach its API | claude's own last stdout line is `API Error:` with `EAI_AGAIN` / `Can't reach the API server` (probe above). Text elsewhere in the output is ignored. |
| `failed (codex: …)` / `failed (claude: …)` | the reviewer CLI stopped with this error | the CLI's own error-prefixed last line on its error stream (probe above) |
| `failed (reviewer exited with code N)` | the reviewer failed, and we cannot say why | a non-zero exit with no recognised error line. It is honest "unknown", not a guess. |
| exit 2 on a bad `--base` | no review was attempted | the failure happened before the run directory existed, and no marker is printed |

Residual risk, accepted: if a failing codex's final stderr line were a command-output line that
begins with `ERROR:`, it would be shown as codex's reason. It would still be a failure (exit 5),
only with a misleading reason, and codex prints its own error lines after tool output.

## Scope

- `scripts/cross-review/core.ts`: `reviewerErrorLine`, `markerReason`, `reportText`;
  `classifyResult` takes `stdout`/`stderr`; `NO_NETWORK` removed.
- `scripts/cross-review/cli.ts`: the preparation phase maps git errors to exit 2 without a
  marker; everything after the run directory exists goes through `markerReason`.
- `scripts/cross-review/core.test.ts`: tests. The three probe lines above are verbatim
  fixtures, and there are boundary cases: an error text mid-transcript followed by other lines,
  a success that quotes an error line, a 200-character cut, a multi-line reason, empty streams.
- `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md`: "Guards and errors" rows
  updated.
- `AGENTS.md`: the `no network` sentence still holds and needs no change. Verify during the
  implementation.

No change to the reviewer invocation, the prompt, the snapshot, or the workflow rule.
