# Cross-review: the codex reviewer defaults to a Sol model

Amends `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md`, section "Interface".

## Problem

The 09-29 design decided that `--model` is a pure pass-through: "If it is omitted, the CLI's own
default is used, and the code carries no curated model list." The rule in `CLAUDE.md` runs
`npm run cross-review -- --reviewer codex` with no `--model`. So the model that reviews every
branch is whatever the Codex CLI defaults to on that day, and that default is not ours to
control: it moves with Codex updates. The user's verdict on 2026-10-01 is that the Astra class
(`gpt-6-astra`) "works no better and eats tokens like crazy". The review must run on the Sol
class, and a Codex update must not be able to silently switch it to Astra.

## Decision

`scripts/cross-review/core.ts` carries one constant, a per-reviewer default model:

- `codex` → `gpt-6.1-sol` (the current Sol);
- `claude` → none. The Claude CLI's own default stays, because no one has raised the question
  for that direction, and a default there would be a guess.

`buildReviewerCommand` uses `model ?? DEFAULT_MODEL[reviewer]`. An explicit `--model` still
wins. The codex command therefore **always** carries `-m <id>`, and the claude command carries
`--model` only when it is given explicitly, exactly as before.

This reverses the 09-29 line "the code carries no curated model list" on purpose, and only for
codex: a list of one entry, which exists to pin a cost decision rather than to curate quality.

Bumping to a newer Sol is a one-line change to the constant plus the one test that pins it.

### Failure mode

If OpenAI retires `gpt-6.1-sol`, Codex exits non-zero with an `ERROR:` line, and the existing
classification turns this into exit 5 and `Cross-review: failed (<reason>)`. The PR is not
blocked, and the reason names the model. The fix is to bump the constant. In the meantime
`--model` works around it. No fallback to the CLI default is built, because silently landing on
Astra is the exact thing this change prevents.

## Claim → evidence

| What the system asserts | What proves it |
|---|---|
| `gpt-6.1-sol` is accepted by `codex exec -m` under our ChatGPT-account login | Live probe 2026-10-01 15:14 UTC, codex-cli 0.158.0: `-m gpt-6.1-sol` → `model: gpt-6.1-sol`, `OK`. Note: the same call at ~15:11 returned HTTP 400 "not supported when using Codex with a ChatGPT account" while `models_cache.json` listed only `gpt-6-sol`; the model rolled out between the two calls. |
| The CLI default is not stable | The user's statement (the default "may change with a new update"); the cache refetch above changed the list within minutes. |

## Out of scope

- A default for the `claude` reviewer.
- `codex exec` used as an implementer, which is not this script. The `-m` flag stays a manual
  step there, and it is recorded in Claude's memory, not in code.
- Reasoning effort: unchanged (the CLI default, `none` for this config).

## Docs and rules

- `CLAUDE.md`, the cross-review bullet: the codex default is Sol (and why), and Astra is not
  used.
- `AGENTS.md`, the cross-review bullet: one clause saying the `codex` direction pins Sol, so
  that Codex, when it edits the script, keeps the pin.
- `spec.md`: no change. The cross-review tool is not described there.

## Testing

In `scripts/cross-review/core.test.ts`:

- codex without a model → args contain `-m gpt-6.1-sol` (the **only** test that pins the ID);
- codex with an explicit model → the explicit model, not the default (existing test, kept);
- claude without a model → no `--model` in args (existing test, kept, now a guard that the
  default map has no claude entry).
