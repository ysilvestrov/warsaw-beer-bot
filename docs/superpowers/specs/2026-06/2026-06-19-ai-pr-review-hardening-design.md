# AI PR Review Hardening — Design

**Date:** 2026-06-19
**Issue:** [#143](https://github.com/ysilvestrov/warsaw-beer-bot/issues/143) — *ci: harden AI PR Review workflow against inline comment posting failures*
**Status:** Approved (brainstorm), pending implementation plan

## Problem

`.github/workflows/codex-review.yml` uses the third-party action
`anc95/ChatGPT-CodeReview@v1.0.23`, which posts **inline** review comments anchored
to diff lines. This has produced two distinct failure modes that turn an otherwise
healthy PR check red:

1. **Line-resolution flake (422).** When the action anchors a comment to a stale /
   non-diff / unresolvable line, GitHub rejects the *entire* review with
   `HttpError: Unprocessable Entity: "Line could not be resolved"`. Observed on
   PR #133 (run `27381383630`) and PR #142 (run `27478349548`); a rerun happened to
   pass both times.
2. **Opaque "no output" failure.** The action can finish without posting anything
   (e.g. OpenAI quota/token/model problem). The separate `Verify review was posted`
   step then fails with a generic message and a rerun does **not** recover it
   (PR #173, run `27832863790`).

The root issue is that the `Verify review was posted` step cannot distinguish three
outcomes:

- (a) the reviewer ran and legitimately had **no findings** (should pass),
- (b) a **line-resolution flake** (should not block),
- (c) a **real infra failure** — missing key, quota, outage (should fail loudly).

Today (a), (b) and (c) can all surface as the same red failure.

## Goals

- A clean / no-finding AI review does **not** fail the workflow.
- A `Line could not be resolved` failure is **structurally impossible** — never
  requires a manual rerun.
- Real reviewer infrastructure problems (missing token, missing OpenAI key,
  API outage / quota) **fail loudly** (red, blocks merge) with a clear reason.
- Existing scope filtering still works: PRs with no files in the include patterns are
  skipped with a notice, not failed.
- The reviewer stays **event-triggered** (GitHub fires it on PR events); no agent
  decides to run it.

## Non-goals

- Inline, line-anchored comment threads. We accept a single top-level summary instead
  (decision below).
- Switching model / provider. We keep standard OpenAI `gpt-4o-mini` with the existing
  `OPENAI_API_KEY` + `OPENAI_API_ENDPOINT` secrets.
- Graceful degradation on infra failure. Per the issue's acceptance criteria, infra
  failures fail loudly rather than passing with a warning.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Comment style | **One top-level PR review** (`event: COMMENT`, body only, no `comments[]`) | Removes the entire line-resolution failure class by construction, instead of defending against it. Findings remain actionable as `file:line — issue` prose. |
| Implementation | **Own TS script** (`scripts/ai-pr-review.ts`) run via `tsx` | The third-party action only does inline. Owning the script lets us control failure semantics and unit-test them (project Node/TS + vitest convention). |
| Infra-failure policy | **Fail loud** (red) | User decision. Real reviewer outages must be visible and block, not silently pass. |
| Verify step | **Removed** | The script owns its exit code, so there's no post-hoc guessing about why nothing was posted. |
| Comment lifecycle | **Update a single marker comment** (`<!-- ai-pr-review -->`) | Avoids stacking a fresh comment on every `synchronize` push. |

## Architecture

### Workflow (`.github/workflows/codex-review.yml`)

Unchanged: trigger (`pull_request: [opened, reopened, synchronize]`), `concurrency`
group (cancel-in-progress), permissions (`contents: read`, `pull-requests: write`),
and the full-history checkout + `git fetch` of the base ref needed for triple-dot diffs.

Changed: the `anc95/ChatGPT-CodeReview` step and the `Verify review was posted` step
are both **replaced by a single step** that runs `scripts/ai-pr-review.ts` via `tsx`,
passing `OPENAI_API_KEY`, `OPENAI_API_ENDPOINT`, `GITHUB_TOKEN`, and the PR context.

### Script (`scripts/ai-pr-review.ts`)

Happy path:

1. **Read env / context:** `OPENAI_API_KEY`, `OPENAI_API_ENDPOINT`, `GITHUB_TOKEN`,
   repository, PR number, base ref, head sha.
2. **Determine scope:** `git diff --name-only origin/<base>...HEAD`, filtered through the
   include / ignore globs (defined once in the script so scope cannot drift from the
   workflow). **No reviewable files → post nothing, exit 0** with a `::notice::`.
3. **Build prompt:** PR title + body, the actual unified diff (capped to a character
   budget; truncation is noted in the prompt), and the contents of
   `.github/ai-review/AGENTS.md`.
4. **Call OpenAI:** chat completions, `gpt-4o-mini`, `temperature: 0`. Transient errors
   (429 / 5xx / network) are retried a few times with backoff.
5. **Post one top-level review:** `POST /repos/{repo}/pulls/{n}/reviews` with
   `event: COMMENT` and a `body` only (no `comments[]`). The body carries the hidden
   `<!-- ai-pr-review -->` marker. If a prior bot review/comment with that marker exists,
   **update it** instead of posting a new one.

### Scope filtering (kept identical to today)

- Include: `src/**/*.ts`, `tests/**/*.ts`, `scripts/**/*.ts`, `extension/**/*.ts`,
  `.github/workflows/*.yml`.
- Ignore: `package-lock.json`, `*.md`, `docs/**`.

These live in one constant in the script and drive both the scope decision and the diff
sent to the model, so the previous workflow/verify-step divergence cannot recur.

## Failure classification (the fail-loud contract)

| Outcome | Exit | PR check |
|---|---|---|
| No reviewable files in scope | 0 | green (skip notice) |
| Model ran, summary posted (including an explicit "no findings") | 0 | green |
| Missing / empty `OPENAI_API_KEY` or other required config | 1 | **red** — clear "missing secret/config" message |
| OpenAI call fails after N retries (429 / 5xx / network / 401) | 1 | **red** — "AI review unavailable: \<reason\>" |
| GitHub post fails | 1 | **red** |

The decisive property: "model ran and had nothing to say" (exit 0, green) is now
structurally distinct from "model could not run" (exit 1, red). The old verify step
could not tell these apart.

## Error handling details

- **Retries:** OpenAI 429 / 5xx / network errors retry up to 3 attempts total with
  exponential backoff to absorb blips. If they persist, the script still exits 1
  (fail loud).
- **Config errors** (missing key/token) fail immediately without retry — they are repo
  setup bugs, not transient.
- **Diff budget:** the unified diff is capped to a character budget; when truncated, the
  prompt states so, so the model does not silently review a partial diff thinking it is
  whole.

## Testing (vitest)

Pure functions extracted and unit-tested; all network is mocked (no live OpenAI/GitHub):

- file filtering against the include/ignore globs (in-scope vs out-of-scope sets);
- diff truncation to the character budget (boundary + truncation-note behavior);
- prompt assembly (instructions + PR context + diff present and ordered);
- marker comment find-and-update logic (mocked `fetch`: create-when-absent,
  update-when-present);
- the error → exit-code classifier (config error, transient-then-exhausted, success).

## Spec impact

`spec.md` (OpenSpec product spec) is **not** affected — this changes CI/dev tooling,
not bot product behavior. No `docs/extension-install-uk.md` change either (no
`extension/**` user-facing change).

## Acceptance (from the issue)

- ✅ Clean / no-finding review does not fail the workflow.
- ✅ `Line could not be resolved` cannot occur (no inline comments).
- ✅ Real infra problems (missing token / key, outage / quota) fail loudly with a clear
  reason.
- ✅ Scope filtering preserved: PRs with no in-scope files are skipped with a notice.
